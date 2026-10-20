/**
 * ProviderEvidenceIngress and ToolEvidenceReducer.
 *
 * Canonical frames pulled from a bridge spool (or produced by the backend's
 * own OpenCode adapter) are validated, deduplicated and reduced into ledger
 * records. Every accepted frame is durable before it is acknowledged; a
 * stream gap is durably recorded as a coverage loss and acknowledged as
 * `gap-recorded`, never as accepted evidence.
 *
 * Reduction rules:
 * - one operation per native call identity (plus native attempt id); a new
 *   runtime epoch replaying an old call is the same operation;
 * - terminal phases never regress; contradictory terminal reports keep the
 *   first and record a reconciliation note;
 * - a replace update becomes the selected revision only when the adapter
 *   declared it supersedes the selected one, or a verified source sequence in
 *   the same scope and epoch orders it later — never by receipt time;
 * - append chunks are idempotent by chunk id; gaps and conflicts leave the
 *   body incomplete instead of fabricating a complete one.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  compareUnsignedDecimal,
  isProviderEvidenceFrame,
  TERMINAL_TOOL_PHASES,
  workspaceObservationReportIssues,
  type ChangeEvidenceEntry,
  type EvidenceBodyRef,
  type ExecutionOccurrence,
  type ProviderChangeCapabilities,
  type ProviderEvidence,
  type ProviderEvidenceAck,
  type ProviderEvidenceFrame,
  type ProviderEvidenceUpdate,
  type ToolPhase,
  type WorkspaceObservationReport,
} from "@orkestrator/protocol/change-evidence";
import type { ChangeLedger, OperationRow } from "./change-ledger.js";
import { bodyIdFor, type EvidenceBodyStore } from "./evidence-body-store.js";
import { evidenceIdFor, operationIdFor, providerTurnIdFor } from "./identities.js";

export interface IngestionContext {
  /** Physical producer: one bridge connection (or the backend OpenCode adapter). */
  sourceKey: string;
  environmentId: string;
  provider: string;
  worktreeId: string | null;
}

export interface IngestResult {
  acks: ProviderEvidenceAck[];
  retainedBodyIds: string[];
  unavailableBodyIds: string[];
  dirtyOperations: Set<string>;
  dirtyProviderTurns: Set<string>;
  observationOperations: Set<string>;
  conflicts: number;
}

const PHASE_ORDER: Record<ToolPhase, number> = {
  unknown: 0,
  proposed: 1,
  "awaiting-approval": 2,
  running: 3,
  succeeded: 4,
  failed: 4,
  denied: 4,
  cancelled: 4,
};

/** Monotonic lifecycle merge; exported for tests. */
export function mergeLifecycle(
  existing: { phase: ToolPhase; occurrence: ExecutionOccurrence } | null,
  incoming: { phase: ToolPhase; occurrence: ExecutionOccurrence },
): { phase: ToolPhase; occurrence: ExecutionOccurrence; conflict: string | null } {
  if (!existing) return { ...incoming, conflict: null };
  let conflict: string | null = null;
  let phase = existing.phase;
  const existingTerminal = TERMINAL_TOOL_PHASES.has(existing.phase);
  const incomingTerminal = TERMINAL_TOOL_PHASES.has(incoming.phase);
  if (existingTerminal) {
    if (incomingTerminal && incoming.phase !== existing.phase) conflict = "contradictory-terminal";
  } else if (
    PHASE_ORDER[incoming.phase] >= PHASE_ORDER[existing.phase] &&
    incoming.phase !== "unknown"
  ) {
    phase = incoming.phase;
  }
  let occurrence = existing.occurrence;
  if (incoming.occurrence !== "unknown" && incoming.occurrence !== existing.occurrence) {
    if (existing.occurrence === "unknown" || existing.occurrence === "not-started") {
      occurrence = incoming.occurrence;
    } else if (existing.occurrence === "did-not-run" && incoming.occurrence === "started") {
      // Evidence that it ran is stronger than a report that it did not.
      occurrence = "started";
      conflict ??= "contradictory-occurrence";
    } else if (existing.occurrence === "started" && incoming.occurrence === "did-not-run") {
      conflict ??= "contradictory-occurrence";
    }
  }
  return { phase, occurrence, conflict };
}

function contentHash(frame: ProviderEvidenceFrame): string {
  const { runtimeEpoch: _epoch, ...rest } = frame;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

function bodyRefs(evidence: ProviderEvidence): EvidenceBodyRef[] {
  switch (evidence.kind) {
    case "patch":
      return [evidence.body];
    case "replacement":
      return [
        ...(evidence.before.state === "present" ? [evidence.before.body] : []),
        ...(evidence.after.state === "present" ? [evidence.after.body] : []),
      ];
    default:
      return [];
  }
}

function updatesOf(frame: ProviderEvidenceFrame): ProviderEvidenceUpdate[] {
  const event = frame.event;
  if (event.kind === "tool" || event.kind === "background-task" || event.kind === "turn-diff") {
    return event.evidence;
  }
  return [];
}

/** Rewrite body refs whose retention failed to explicit unavailability. */
function withBodyStates(
  evidence: ProviderEvidence,
  unavailable: ReadonlySet<string>,
): ProviderEvidence {
  const fix = (ref: EvidenceBodyRef): EvidenceBodyRef =>
    ref.state === "available" && unavailable.has(ref.id)
      ? { ...ref, state: "unavailable", unavailableReason: "body-fetch-failed" }
      : ref;
  switch (evidence.kind) {
    case "patch":
      return { ...evidence, body: fix(evidence.body) };
    case "replacement":
      return {
        ...evidence,
        before:
          evidence.before.state === "present"
            ? { state: "present", body: fix(evidence.before.body) }
            : evidence.before,
        after:
          evidence.after.state === "present"
            ? { state: "present", body: fix(evidence.after.body) }
            : evidence.after,
      };
    default:
      return evidence;
  }
}

export class ProviderEvidenceIngress {
  constructor(
    private readonly ledger: ChangeLedger,
    private readonly bodies: EvidenceBodyStore,
  ) {}

  /**
   * Ingest entries from one producer. Bodies are fetched and made durable
   * before the ledger rows that reference them commit.
   */
  async ingest(
    context: IngestionContext,
    entries: readonly ChangeEvidenceEntry[],
    capabilities: readonly ProviderChangeCapabilities[],
    fetchBody: (id: string) => Promise<Uint8Array | null>,
  ): Promise<IngestResult> {
    const result: IngestResult = {
      acks: [],
      retainedBodyIds: [],
      unavailableBodyIds: [],
      dirtyOperations: new Set(),
      dirtyProviderTurns: new Set(),
      observationOperations: new Set(),
      conflicts: 0,
    };
    for (const capability of capabilities) {
      this.ledger.transaction(() =>
        this.ledger.recordCapabilities(capability.capabilityRevision, JSON.stringify(capability)),
      );
    }
    for (const entry of entries) {
      if (entry.type === "frame") await this.ingestFrame(context, entry.frame, fetchBody, result);
      else this.ingestObservation(context, entry.report, result);
    }
    return result;
  }

  private async retainBodies(
    frame: ProviderEvidenceFrame,
    fetchBody: (id: string) => Promise<Uint8Array | null>,
    result: IngestResult,
  ): Promise<Set<string>> {
    const unavailable = new Set<string>();
    const refs: EvidenceBodyRef[] = [];
    if (frame.raw) refs.push(frame.raw);
    for (const update of updatesOf(frame)) {
      if (update.kind === "append") refs.push(update.chunk);
      else refs.push(...bodyRefs(update.evidence));
    }
    for (const ref of refs) {
      if (ref.state !== "available") continue;
      const known = this.ledger.body(ref.id);
      if (known?.state === "available") {
        result.retainedBodyIds.push(ref.id);
        continue;
      }
      const bytes = await fetchBody(ref.id).catch(() => null);
      const stored =
        bytes && bodyIdFor(bytes) === ref.id ? await this.bodies.put(ref.id, bytes) : false;
      this.ledger.transaction(() =>
        this.ledger.recordBody({
          bodyId: ref.id,
          state: stored ? "available" : "unavailable",
          bytes: bytes?.length ?? 0,
          complete: ref.complete,
          originalBytes: ref.originalBytes ?? null,
          reason: stored ? null : "body-fetch-failed",
        }),
      );
      if (stored) result.retainedBodyIds.push(ref.id);
      else {
        unavailable.add(ref.id);
        result.unavailableBodyIds.push(ref.id);
      }
    }
    return unavailable;
  }

  private async ingestFrame(
    context: IngestionContext,
    frame: ProviderEvidenceFrame,
    fetchBody: (id: string) => Promise<Uint8Array | null>,
    result: IngestResult,
  ): Promise<void> {
    if (!isProviderEvidenceFrame(frame)) {
      // Malformed metadata is retained as an explicit gap, not dropped.
      const gapId = `invalid:${randomUUID()}`;
      this.ledger.transaction(() =>
        this.ledger.recordGap({
          gapId,
          bindingId: context.sourceKey,
          coverageJson: JSON.stringify({
            kind: "unknown-range",
            bindingId: context.sourceKey,
            runtimeEpoch: "unknown",
          }),
          reason: "invalid-frame",
        }),
      );
      result.acks.push({
        kind: "gap-recorded",
        gapId,
        coverage: { kind: "unknown-range", bindingId: context.sourceKey, runtimeEpoch: "unknown" },
        reason: "invalid-frame",
      });
      return;
    }
    const unavailable = await this.retainBodies(frame, fetchBody, result);
    const ledger = this.ledger;
    const hash = contentHash(frame);
    ledger.transaction(() => {
      const bindingId = ledger.resolveBinding({
        sourceKey: `${context.environmentId}\0${context.provider}\0${frame.bindingId}`,
        environmentId: context.environmentId,
        provider: context.provider,
        conversationId: frame.source.conversationId,
        worktreeId: context.worktreeId,
      });
      const frameKey = `${bindingId}\0${frame.frameId}`;
      const existing = ledger.frame(frameKey);
      if (existing) {
        if (existing.content_hash !== hash) result.conflicts++;
        result.acks.push({
          kind: "accepted",
          frameId: frame.frameId,
          receiptId: existing.receipt_id,
          retainedBodyIds: [],
        });
        return;
      }
      const seq = ledger.nextSequence();
      const receiptId = `rcpt_${randomUUID()}`;
      const event = frame.event;
      if (event.kind === "stream-gap") {
        ledger.recordGap({
          gapId: event.gapId,
          bindingId,
          coverageJson: JSON.stringify(event.coverage),
          reason: event.reason,
        });
        ledger.insertFrame({
          frameKey,
          bindingId,
          runtimeEpoch: frame.runtimeEpoch,
          receiptId,
          contentHash: hash,
          seq,
        });
        result.acks.push({
          kind: "gap-recorded",
          gapId: event.gapId,
          coverage: event.coverage,
          reason: event.reason,
        });
        return;
      }
      const conversationId = frame.source.conversationId;
      if (event.kind === "tool" || event.kind === "background-task" || event.kind === "turn") {
        const nativeId =
          event.kind === "tool"
            ? (frame.source.callId ?? frame.source.itemId!)
            : event.kind === "background-task"
              ? `task:${event.taskId}`
              : `turn:${frame.source.turnId}`;
        const operationId = operationIdFor({
          environmentId: context.environmentId,
          provider: context.provider,
          conversationId,
          callId: nativeId,
          attemptId: frame.source.attemptId ?? null,
        });
        const previous = ledger.operation(operationId);
        const incoming =
          event.kind === "tool"
            ? { phase: event.phase, occurrence: event.executionOccurrence }
            : event.kind === "background-task"
              ? { phase: event.phase as ToolPhase, occurrence: event.executionOccurrence }
              : // Turn frames store their writer liveness as the occurrence column.
                {
                  phase: event.phase as ToolPhase,
                  occurrence: event.writerLiveness as ExecutionOccurrence,
                };
        const merged =
          event.kind === "turn"
            ? { ...incoming, conflict: null }
            : mergeLifecycle(
                previous
                  ? {
                      phase: previous.phase as ToolPhase,
                      occurrence: previous.execution_occurrence as ExecutionOccurrence,
                    }
                  : null,
                incoming,
              );
        const notes = previous?.reconciliation_json
          ? (JSON.parse(previous.reconciliation_json) as string[])
          : [];
        if (merged.conflict && !notes.includes(merged.conflict)) notes.push(merged.conflict);
        if (merged.conflict) result.conflicts++;
        const row: OperationRow = {
          operation_id: operationId,
          binding_id: bindingId,
          environment_id: context.environmentId,
          conversation_id: conversationId,
          turn_id: frame.source.turnId ?? previous?.turn_id ?? null,
          call_id: frame.source.callId ?? frame.source.itemId ?? null,
          parent_call_id:
            frame.source.parentCallId ??
            (event.kind === "background-task" ? (event.parentCallId ?? null) : null),
          attempt_id: frame.source.attemptId ?? previous?.attempt_id ?? "attempt-1",
          tool_kind:
            event.kind === "tool"
              ? event.toolKind
              : event.kind === "turn"
                ? "turn"
                : "background-task",
          phase: merged.phase,
          execution_occurrence: merged.occurrence,
          background_task_id:
            event.kind === "tool"
              ? (event.backgroundTaskId ?? null)
              : event.kind === "background-task"
                ? event.taskId
                : null,
          capability_revision: frame.capabilityRevision,
          history_mode: previous?.history_mode === "live" ? "live" : frame.source.mode,
          presentation_revision: (previous?.presentation_revision ?? 0) + 1,
          reconciliation_json: notes.length > 0 ? JSON.stringify(notes.slice(0, 16)) : null,
          first_seen_seq: previous?.first_seen_seq ?? seq,
          updated_seq: seq,
        };
        ledger.upsertOperation(row);
        if (event.kind !== "turn") {
          this.applyUpdates(
            frame,
            "operation",
            operationId,
            updatesOf(frame),
            unavailable,
            frameKey,
            seq,
            result,
          );
        }
        result.dirtyOperations.add(operationId);
      } else if (event.kind === "turn-diff") {
        const providerTurnId = providerTurnIdFor({
          environmentId: context.environmentId,
          provider: context.provider,
          conversationId,
          turnId: frame.source.turnId!,
        });
        this.applyUpdates(
          frame,
          "provider-turn",
          providerTurnId,
          event.evidence,
          unavailable,
          frameKey,
          seq,
          result,
        );
        result.dirtyProviderTurns.add(providerTurnId);
      }
      ledger.insertFrame({
        frameKey,
        bindingId,
        runtimeEpoch: frame.runtimeEpoch,
        receiptId,
        contentHash: hash,
        seq,
      });
      result.acks.push({
        kind: "accepted",
        frameId: frame.frameId,
        receiptId,
        retainedBodyIds: [...new Set(result.retainedBodyIds)],
      });
    });
  }

  /** Apply replace/append updates inside the caller's transaction. */
  private applyUpdates(
    frame: ProviderEvidenceFrame,
    ownerKind: string,
    ownerId: string,
    updates: readonly ProviderEvidenceUpdate[],
    unavailable: ReadonlySet<string>,
    frameKey: string,
    seq: number,
    result: IngestResult,
  ): void {
    const ledger = this.ledger;
    for (const update of updates) {
      const evidenceId = evidenceIdFor(ownerKind, ownerId, update.evidenceKey);
      const revisions = ledger.evidenceRevisions(evidenceId);
      if (update.kind === "replace") {
        if (revisions.some((row) => row.revision_key === update.revisionKey)) continue;
        const selected = revisions.find((row) => row.selected === 1);
        const evidence = withBodyStates(update.evidence, unavailable);
        let select = !selected;
        if (selected && update.replacesRevisionKey === selected.revision_key) select = true;
        if (selected && !select && frame.sourceSequence) {
          const previous = JSON.parse(selected.evidence_json) as {
            sourceSequence?: ProviderEvidenceFrame["sourceSequence"];
          };
          const before = previous.sourceSequence;
          if (
            before &&
            before.scopeId === frame.sourceSequence.scopeId &&
            before.epoch === frame.sourceSequence.epoch &&
            compareUnsignedDecimal(frame.sourceSequence.value, before.value) > 0
          ) {
            select = true;
          }
        }
        const revision = (revisions.at(-1)?.revision ?? 0) + 1;
        ledger.insertEvidence({
          evidence_id: evidenceId,
          revision,
          owner_kind: ownerKind,
          owner_id: ownerId,
          evidence_key: update.evidenceKey,
          revision_key: update.revisionKey,
          replaces_revision_key: update.replacesRevisionKey ?? null,
          kind: evidence.kind,
          claim: evidence.effectClaim,
          evidence_json: JSON.stringify({
            evidence,
            sourceSequence: frame.sourceSequence ?? null,
            mode: frame.source.mode,
          }),
          selected: 0,
          frame_key: frameKey,
          ingested_seq: seq,
        });
        if (select) ledger.selectEvidenceRevision(evidenceId, revision);
        continue;
      }
      // Append: only onto an explicitly seeded replace revision.
      const target = revisions.find((row) => row.revision_key === update.revisionKey);
      if (!target) {
        result.conflicts++;
        continue;
      }
      const outcome = ledger.insertChunk({
        evidenceId,
        revisionKey: update.revisionKey,
        targetBodyId: update.targetBodyId,
        chunkIndex: update.chunkIndex,
        chunkId: update.chunkId,
        offsetBytes: update.offsetBytes,
        bodyId: update.chunk.id,
        final: update.final,
      });
      if (outcome === "conflict") result.conflicts++;
      if (outcome !== "inserted") continue;
      // Assembly happens in measurement (it needs body bytes); record a new
      // revision so earlier measurements stay immutable.
      const revision = (revisions.at(-1)?.revision ?? 0) + 1;
      const base = JSON.parse(target.evidence_json) as { evidence: ProviderEvidence };
      ledger.insertEvidence({
        evidence_id: evidenceId,
        revision,
        owner_kind: ownerKind,
        owner_id: ownerId,
        evidence_key: update.evidenceKey,
        revision_key: `${update.revisionKey}+${update.chunkIndex}`,
        replaces_revision_key: target.revision_key,
        kind: target.kind,
        claim: target.claim,
        evidence_json: JSON.stringify({
          evidence: base.evidence,
          appendOf: { revisionKey: update.revisionKey, targetBodyId: update.targetBodyId },
          sourceSequence: frame.sourceSequence ?? null,
          mode: frame.source.mode,
        }),
        selected: 0,
        frame_key: frameKey,
        ingested_seq: seq,
      });
      if (
        target.selected === 1 ||
        revisions.find((row) => row.selected === 1)?.replaces_revision_key === update.revisionKey
      ) {
        ledger.selectEvidenceRevision(evidenceId, revision);
      }
    }
  }

  /** Persist a capture-executor report as evidence of its operation. */
  private ingestObservation(
    context: IngestionContext,
    report: WorkspaceObservationReport,
    result: IngestResult,
  ): void {
    if (workspaceObservationReportIssues(report).length > 0) return;
    const ledger = this.ledger;
    ledger.transaction(() => {
      const bindingId = ledger.resolveBinding({
        sourceKey: `${context.environmentId}\0${context.provider}\0${report.bindingId}`,
        environmentId: context.environmentId,
        provider: context.provider,
        conversationId: report.source.conversationId,
        worktreeId: context.worktreeId,
      });
      const frameKey = `${bindingId}\0${report.reportId}`;
      if (ledger.frame(frameKey)) return;
      const seq = ledger.nextSequence();
      const callId = report.source.callId ?? report.reportId;
      const operationId = operationIdFor({
        environmentId: context.environmentId,
        provider: context.provider,
        conversationId: report.source.conversationId,
        callId,
        attemptId: report.source.attemptId,
      });
      const previous = ledger.operation(operationId);
      if (!previous) {
        ledger.upsertOperation({
          operation_id: operationId,
          binding_id: bindingId,
          environment_id: context.environmentId,
          conversation_id: report.source.conversationId,
          turn_id: report.source.turnId ?? null,
          call_id: callId,
          parent_call_id: null,
          attempt_id: report.source.attemptId ?? "attempt-1",
          tool_kind: "shell",
          phase: "unknown",
          execution_occurrence: "unknown",
          background_task_id: null,
          capability_revision: report.capabilityRevision,
          history_mode: "live",
          presentation_revision: 1,
          reconciliation_json: null,
          first_seen_seq: seq,
          updated_seq: seq,
        });
      }
      const evidenceId = evidenceIdFor("observation", operationId, report.reportId);
      ledger.insertEvidence({
        evidence_id: evidenceId,
        revision: 1,
        owner_kind: "observation",
        owner_id: operationId,
        evidence_key: report.reportId,
        revision_key: report.reportId,
        replaces_revision_key: null,
        kind: "workspace-observation",
        claim: "workspace-observed",
        evidence_json: JSON.stringify({ report }),
        selected: 1,
        frame_key: frameKey,
        ingested_seq: seq,
      });
      ledger.insertFrame({
        frameKey,
        bindingId,
        runtimeEpoch: report.runtimeEpoch,
        receiptId: `rcpt_${randomUUID()}`,
        contentHash: createHash("sha256").update(JSON.stringify(report)).digest("hex"),
        seq,
      });
      result.observationOperations.add(operationId);
      result.dirtyOperations.add(operationId);
    });
  }
}
