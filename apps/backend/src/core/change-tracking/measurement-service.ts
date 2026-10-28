/**
 * ChangeMeasurementService: turns retained evidence and captured endpoints
 * into immutable {@link ChangeMeasurement}s and advances selection pointers.
 *
 * Measurement ids are derived from everything that determines the result
 * (scope, owner, endpoints, evidence revisions, policies, lifecycle and
 * attribution facts), so recomputing from unchanged inputs is idempotent and
 * a changed input produces a new measurement that supersedes — never edits —
 * the previous one. Publication commits the measurement, its file rows, its
 * diff identity, a compare-and-swap of the live selection and an outbox row
 * in one short transaction.
 */

import { createHash } from "node:crypto";
import {
  TERMINAL_TOOL_PHASES,
  type ExecutionOccurrence,
  type ProviderEvidence,
  type ToolPhase,
  type WorkspaceObservationReport,
} from "@orkestrator/protocol/change-evidence";
import {
  addLineCounts,
  CHANGE_MEASUREMENT_SCHEMA_VERSION,
  exactCount,
  measurementIssues,
  notApplicableCount,
  partialCount,
  unknownCount,
  type ChangeMeasurement,
  type EffectClaim,
  type LineCount,
  type MeasurementExecution,
  type MeasurementExecutionOccurrence,
  type MeasurementScope,
} from "@orkestrator/protocol/change-measurements";
import type { DiffIdentity } from "@orkestrator/protocol/change-resources";
import {
  GIT_REPRESENTATION_ID,
  HUNK_RENDERER_POLICY_ID,
  LEGACY_ALGORITHM_ID,
  LEGACY_REPRESENTATION_ID,
  RAW_BYTES_REPRESENTATION_ID,
  RAW_LINES_ALGORITHM_ID,
} from "@orkestrator/protocol/node/change-tracking/count-policy";
import {
  combineEvidenceMeasurements,
  measureEvidence,
  type EvidenceMeasurement,
} from "@orkestrator/protocol/node/change-tracking/evidence-measure";
import {
  findCountDiscrepancies,
  selectToolEvidence,
  type EvidenceCandidate,
} from "@orkestrator/protocol/node/change-tracking/evidence-selection";
import { encodePath, readManifest } from "./capture.js";
import type {
  ChangeLedger,
  EvidenceRow,
  MeasurementFileRecord,
  OperationRow,
  SnapshotRow,
} from "./change-ledger.js";
import type { EvidenceBodyStore } from "./evidence-body-store.js";
import { operationVolumeResourceKey, toolResourceKeys, turnResourceKeys } from "./identities.js";
import type { ObjectStore } from "./object-store.js";
import { compareManifests } from "./snapshot-diff.js";

export interface PublishInput {
  measurement: ChangeMeasurement;
  owner: { kind: string; id: string };
  files: MeasurementFileRecord[];
  identity: DiffIdentity | null;
  resourceKey: string;
  selector?: "live" | "final" | "pinned";
  observationEpoch?: number;
  ownerFence?: { assert: () => void; value: number } | null;
}

export interface PublishOutcome {
  measurementId: string;
  revision: number | null;
  created: boolean;
}

/**
 * Measurements kept per owner and scope however many supersede them: the
 * newest, and the one before it for a reader still paging it as it is
 * superseded. Older ones go as new ones are published (see
 * {@link ChangeLedger.pruneSupersededMeasurements}).
 */
export const MEASUREMENTS_KEPT_PER_OWNER = 2;
/** Superseded measurements pruned per publication: more than one, so a backlog shrinks. */
const MEASUREMENTS_PRUNED_PER_PUBLISH = 2;

function digest(...parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40);
}

function nowIso(): string {
  return new Date().toISOString();
}

function executionOf(phase: string): MeasurementExecution {
  return (
    [
      "proposed",
      "awaiting-approval",
      "running",
      "succeeded",
      "failed",
      "denied",
      "cancelled",
      "unknown",
    ] as const
  ).includes(phase as never)
    ? (phase as MeasurementExecution)
    : "unknown";
}

function occurrenceOf(value: string): MeasurementExecutionOccurrence {
  return (["not-started", "started", "did-not-run", "unknown"] as const).includes(value as never)
    ? (value as MeasurementExecutionOccurrence)
    : "unknown";
}

function finalityOf(phase: string): ChangeMeasurement["finality"] {
  return TERMINAL_TOOL_PHASES.has(phase as ToolPhase) ? "final" : "provisional";
}

function fileRecord(
  input: Partial<MeasurementFileRecord> & { pathId: string; status: string },
): MeasurementFileRecord {
  return {
    oldPath: null,
    newPath: null,
    oldBlob: null,
    newBlob: null,
    oldMode: null,
    newMode: null,
    fileKind: "unknown",
    additions: null,
    additionsQuality: "unknown",
    deletions: null,
    deletionsQuality: "unknown",
    bodyState: "not-retained",
    reason: null,
    ...input,
  };
}

export class ChangeMeasurementService {
  constructor(
    private readonly ledger: ChangeLedger,
    private readonly bodies: EvidenceBodyStore,
    private readonly store: ObjectStore,
  ) {}

  // -------------------------------------------------------------------------
  // Publication
  // -------------------------------------------------------------------------

  /** Commit a measurement and advance its live selection; idempotent by id. */
  publish(input: PublishInput): PublishOutcome {
    const issues = measurementIssues(input.measurement);
    if (issues.length > 0) {
      throw new Error(
        `Invalid change measurement: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
      );
    }
    const ledger = this.ledger;
    return ledger.transaction(() => {
      input.ownerFence?.assert();
      const existing = ledger.measurement(input.measurement.measurementId);
      let created = false;
      if (!existing) {
        ledger.insertMeasurement(
          input.measurement,
          input.owner,
          input.files,
          ledger.nextSequence(),
        );
        if (input.identity) ledger.insertDiffIdentity(input.identity);
        created = true;
      }
      const selection = ledger.selection(input.resourceKey);
      if (selection?.measurement_id === input.measurement.measurementId) {
        return {
          measurementId: input.measurement.measurementId,
          revision: selection.revision,
          created,
        };
      }
      const revision = ledger.swapSelection({
        key: input.resourceKey,
        selector: input.selector ?? "live",
        expectedRevision: selection?.revision ?? 0,
        baselineVersion: input.measurement.baselineVersion,
        measurementId: input.measurement.measurementId,
        observationEpoch: input.observationEpoch ?? selection?.selected_observation_epoch ?? 0,
        worktreeIncarnation: input.measurement.worktreeIncarnation,
        ownerFence: input.ownerFence?.value ?? 0,
      });
      if (revision !== null) {
        ledger.appendOutbox({
          resourceKey: input.resourceKey,
          revision,
          measurementId: input.measurement.measurementId,
          eventKind: "projection",
        });
      }
      if (created) {
        ledger.pruneSupersededMeasurements({
          owner: { ...input.owner, scope: input.measurement.scope },
          keepLatest: MEASUREMENTS_KEPT_PER_OWNER,
          nowIso: nowIso(),
          maxMeasurements: MEASUREMENTS_PRUNED_PER_PUBLISH,
          maxFileRows: 256,
        });
      }
      return { measurementId: input.measurement.measurementId, revision, created };
    });
  }

  /** Commit an immutable measurement with no live selection (pinned detail). */
  publishDetached(
    measurement: ChangeMeasurement,
    owner: { kind: string; id: string },
    identity: DiffIdentity | null,
  ): void {
    const issues = measurementIssues(measurement);
    if (issues.length > 0)
      throw new Error(`Invalid change measurement: ${issues[0]!.path} ${issues[0]!.message}`);
    this.ledger.transaction(() => {
      if (!this.ledger.measurement(measurement.measurementId)) {
        this.ledger.insertMeasurement(measurement, owner, [], this.ledger.nextSequence());
      }
      if (identity) this.ledger.insertDiffIdentity(identity);
    });
  }

  base(input: {
    scope: MeasurementScope;
    owner: ChangeMeasurement["logicalOwner"];
    worktreeId: string;
    worktreeIncarnation: string;
  }): Omit<ChangeMeasurement, "measurementId"> {
    return {
      schemaVersion: CHANGE_MEASUREMENT_SCHEMA_VERSION,
      worktreeId: input.worktreeId,
      worktreeIncarnation: input.worktreeIncarnation,
      scope: input.scope,
      logicalOwner: input.owner,
      baselineVersion: null,
      beforeSnapshotId: null,
      afterSnapshotId: null,
      evidenceRefs: [],
      capabilityRevision: null,
      origin: "provider-counts",
      algorithmPolicyId: RAW_LINES_ALGORITHM_ID,
      representationPolicyId: RAW_BYTES_REPRESENTATION_ID,
      execution: "not-applicable",
      executionOccurrence: "not-applicable",
      effectClaim: "not-applicable",
      finality: "unknown",
      consistency: "unknown",
      boundary: { before: "not-applicable", after: "not-applicable" },
      attribution: { basis: "unknown", writerIsolation: "unknown", overlap: "unknown" },
      completeness: { files: "unknown", reasons: [], omittedFileCount: null },
      totals: { additions: unknownCount(), deletions: unknownCount(), changedFiles: null },
      diffIdentityId: null,
      createdAt: nowIso(),
      supersedesMeasurementId: null,
    };
  }

  /** Finish a measurement: deterministic id (createdAt excluded) and supersession link. */
  seal(
    draft: Omit<ChangeMeasurement, "measurementId">,
    owner: { kind: string; id: string },
    withIdentity: "payload" | "comparison" | null,
    identityExtra?: Record<string, unknown>,
    files: readonly MeasurementFileRecord[] = [],
  ): { measurement: ChangeMeasurement; identity: DiffIdentity | null } {
    const {
      createdAt: _createdAt,
      supersedesMeasurementId: _s,
      diffIdentityId: _d,
      ...stable
    } = draft;
    const measurementId = `m_${digest(
      owner,
      stable,
      [...files].sort((a, b) => a.pathId.localeCompare(b.pathId)),
    )}`;
    const previous = this.ledger.latestMeasurement(owner.kind, owner.id, draft.scope);
    const supersedes =
      previous && previous.measurementId !== measurementId ? previous.measurementId : null;
    let identity: DiffIdentity | null = null;
    if (withIdentity === "comparison" && draft.beforeSnapshotId && draft.afterSnapshotId) {
      identity = {
        id: `diff_${digest(measurementId, "comparison")}`,
        worktreeId: draft.worktreeId,
        worktreeIncarnation: draft.worktreeIncarnation,
        scope: draft.scope,
        measurementId,
        algorithmPolicyId: draft.algorithmPolicyId,
        representationPolicyId: draft.representationPolicyId,
        rendererPolicyId: HUNK_RENDERER_POLICY_ID,
        whitespacePolicy: "preserve",
        kind: "comparison",
        beforeSnapshotId: draft.beforeSnapshotId,
        afterSnapshotId: draft.afterSnapshotId,
      };
    } else if (withIdentity === "payload" && draft.evidenceRefs.length > 0) {
      const first = draft.evidenceRefs[0]!;
      identity = {
        id: `diff_${digest(measurementId, "payload")}`,
        worktreeId: draft.worktreeId,
        worktreeIncarnation: draft.worktreeIncarnation,
        scope: draft.scope,
        measurementId,
        algorithmPolicyId: draft.algorithmPolicyId,
        representationPolicyId: draft.representationPolicyId,
        rendererPolicyId: HUNK_RENDERER_POLICY_ID,
        whitespacePolicy: "preserve",
        kind: "payload",
        evidenceId: first.evidenceId,
        evidenceRevision: first.evidenceRevision,
        pathDisplays:
          (identityExtra?.pathDisplays as { before: string | null; after: string | null }[]) ?? [],
      };
    }
    return {
      measurement: {
        ...draft,
        measurementId,
        supersedesMeasurementId: supersedes,
        diffIdentityId: identity?.id ?? null,
      },
      identity,
    };
  }

  // -------------------------------------------------------------------------
  // Tool operations
  // -------------------------------------------------------------------------

  /** Load bodies for evidence candidates, assembling appended chunks. */
  private async loadBodies(rows: readonly EvidenceRow[]): Promise<{
    candidates: EvidenceCandidate[];
    read: (id: string) => Uint8Array | null;
  }> {
    const bytes = new Map<string, Uint8Array>();
    const candidates: EvidenceCandidate[] = [];
    for (const row of rows) {
      const stored = JSON.parse(row.evidence_json) as {
        evidence: ProviderEvidence;
        appendOf?: { revisionKey: string; targetBodyId: string };
      };
      let evidence = stored.evidence;
      for (const ref of evidenceBodyRefs(evidence)) {
        if (ref.state === "available" && !bytes.has(ref.id)) {
          const body = await this.bodies.get(ref.id);
          if (body) bytes.set(ref.id, body);
        }
      }
      if (stored.appendOf && evidence.kind === "patch") {
        const assembled = await this.assemble(row, stored.appendOf, bytes);
        evidence = { ...evidence, body: assembled.ref };
        bytes.set(assembled.ref.id, assembled.bytes);
      }
      candidates.push({
        evidenceId: row.evidence_id,
        evidenceRevision: row.revision,
        evidenceKey: row.evidence_key,
        evidence,
      });
    }
    return { candidates, read: (id) => bytes.get(id) ?? null };
  }

  private async assemble(
    row: EvidenceRow,
    appendOf: { revisionKey: string; targetBodyId: string },
    bytes: Map<string, Uint8Array>,
  ) {
    const seed =
      bytes.get(appendOf.targetBodyId) ??
      (await this.bodies.get(appendOf.targetBodyId)) ??
      new Uint8Array();
    const parts: Uint8Array[] = [seed];
    let offset = seed.length;
    let complete = true;
    let final = false;
    for (const chunk of this.ledger.chunks(row.evidence_id, appendOf.revisionKey)) {
      if (chunk.offset_bytes !== offset) {
        complete = false;
        break;
      }
      const body = await this.bodies.get(chunk.body_id);
      if (!body) {
        complete = false;
        break;
      }
      parts.push(body);
      offset += body.length;
      if (chunk.final) final = true;
    }
    const assembled = new Uint8Array(offset);
    let cursor = 0;
    for (const part of parts) {
      assembled.set(part, cursor);
      cursor += part.length;
    }
    return {
      bytes: assembled,
      ref: {
        id: `assembled:${row.evidence_id}:${row.revision}`,
        state: "available" as const,
        retainedBytes: assembled.length,
        complete: complete && final,
      },
    };
  }

  /**
   * Recompute the payload, effect and observation resources of one operation.
   * Returns the resource keys whose selection advanced.
   */
  async recomputeOperation(
    operationId: string,
    worktree: { worktreeId: string; incarnation: string } | null,
    window: { overlap: string; beforeQuality: string; afterQuality: string } | null = null,
  ): Promise<string[]> {
    const op = this.ledger.operation(operationId);
    if (!op || op.tool_kind === "turn") return [];
    const target = worktree ?? {
      worktreeId: `unresolved:${op.environment_id}`,
      incarnation: "unknown",
    };
    const keys = toolResourceKeys(operationId);
    const advanced: string[] = [];
    const lifecycle = {
      phase: op.phase as ToolPhase,
      executionOccurrence: op.execution_occurrence as ExecutionOccurrence,
    };
    const { candidates, read } = await this.loadBodies(
      this.ledger.selectedEvidence("operation", operationId),
    );
    const selection = selectToolEvidence(candidates, lifecycle, read);
    const owner = {
      environmentId: op.environment_id,
      threadId: op.conversation_id,
      ...(op.turn_id ? { turnId: op.turn_id } : {}),
      operationId,
      attemptId: op.attempt_id,
    };

    const publishEvidence = (role: "payload" | "effect", chosen: EvidenceCandidate[]) => {
      const measured = combineEvidenceMeasurements(
        chosen.map((candidate) =>
          measureEvidence(candidate.evidence, read, { selectedPaths: candidate.selectedPaths }),
        ),
      );
      const discrepancies = findCountDiscrepancies(
        { role, kind: chosen[0]!.evidence.kind, candidates: chosen },
        measured,
        candidates,
      );
      const scope: MeasurementScope = role === "payload" ? "tool-payload" : "tool-effect";
      const claim: EffectClaim =
        role === "effect"
          ? "provider-reported"
          : chosen.every((c) => c.evidence.effectClaim === "proposal")
            ? "proposal"
            : "unknown";
      const reasons = [...measured.reasons, ...discrepancies.map(() => "provider-counts-disagree")];
      if (op.history_mode !== "live") reasons.push("history-replay");
      const draft = {
        ...this.base({
          scope,
          owner,
          worktreeId: target.worktreeId,
          worktreeIncarnation: target.incarnation,
        }),
        evidenceRefs: chosen.map((c) => ({
          evidenceId: c.evidenceId,
          evidenceRevision: c.evidenceRevision,
          ...(c.selectedPaths ? { selectedPaths: c.selectedPaths } : {}),
        })),
        capabilityRevision: op.capability_revision,
        origin: measured.origin,
        algorithmPolicyId: measured.algorithmPolicyId,
        representationPolicyId: measured.representationPolicyId,
        execution: executionOf(op.phase),
        executionOccurrence: occurrenceOf(op.execution_occurrence),
        effectClaim: claim,
        finality: finalityOf(op.phase),
        boundary:
          role === "effect"
            ? { before: "provider-declared" as const, after: "provider-declared" as const }
            : { before: "not-applicable" as const, after: "not-applicable" as const },
        attribution: {
          basis: role === "effect" ? ("provider-reported" as const) : ("proposal" as const),
          writerIsolation: "unknown" as const,
          overlap: "unknown" as const,
        },
        completeness: {
          files: measured.fileCompleteness,
          reasons: [...new Set(reasons)].slice(0, 32),
          omittedFileCount: measured.fileCompleteness === "complete" ? 0 : null,
        },
        totals: {
          additions: measured.additions,
          deletions: measured.deletions,
          changedFiles: measured.changedFiles,
          ...(measured.contentLines !== null ? { contentLines: measured.contentLines } : {}),
        },
      };
      const { measurement, identity } = this.seal(
        draft,
        { kind: "operation", id: operationId },
        "payload",
        {
          pathDisplays: measured.files.map((file) => ({
            before: file.previousPath ?? file.path,
            after: file.path,
          })),
        },
      );
      const files = payloadFiles(measured, measurement.evidenceRefs.length > 0);
      const outcome = this.publish({
        measurement,
        owner: { kind: "operation", id: operationId },
        files,
        identity,
        resourceKey: role === "payload" ? keys.payload : keys.effect,
      });
      if (outcome.revision !== null) advanced.push(role === "payload" ? keys.payload : keys.effect);
    };

    if (selection.payload) publishEvidence("payload", selection.payload.candidates);
    // A captured workspace effect outranks a provider-reported one.
    const observation = this.latestObservation(operationId);
    const freshObservation =
      observation &&
      observation.boundary.before === "fresh-before" &&
      (observation.boundary.after === "after-terminal" ||
        observation.boundary.after === "running-observation");
    if (observation) {
      const key = freshObservation ? keys.effect : keys.observation;
      if (
        this.publishObservation(
          op,
          observation,
          target,
          key,
          window,
          freshObservation ? "tool-effect" : "observation-window",
        )
      ) {
        advanced.push(key);
      }
    }
    if (selection.effect && !freshObservation)
      publishEvidence("effect", selection.effect.candidates);
    return advanced;
  }

  private latestObservation(operationId: string): WorkspaceObservationReport | null {
    const rows = this.ledger.selectedEvidence("observation", operationId);
    const last = rows.sort((a, b) => a.ingested_seq - b.ingested_seq).at(-1);
    return last
      ? (JSON.parse(last.evidence_json) as { report: WorkspaceObservationReport }).report
      : null;
  }

  private publishObservation(
    op: OperationRow,
    report: WorkspaceObservationReport,
    target: { worktreeId: string; incarnation: string },
    resourceKey: string,
    window: { overlap: string } | null,
    scope: "tool-effect" | "observation-window",
  ): boolean {
    const evidenceRow = this.ledger
      .selectedEvidence("observation", op.operation_id)
      .find((row) => row.evidence_key === report.reportId);
    const overlap =
      report.overlap === "known-overlap" || window?.overlap === "known-overlap"
        ? ("known-overlap" as const)
        : report.overlap === "none-observed" && (!window || window.overlap === "none-observed")
          ? ("none-observed" as const)
          : ("unknown" as const);
    const reasons: string[] = [];
    let additions: LineCount = unknownCount();
    let deletions: LineCount = unknownCount();
    let changedFiles: number | null = null;
    let files: MeasurementFileRecord[] = [];
    let completeness: "complete" | "partial" | "unknown" = "unknown";
    if (report.outcome.kind === "measured") {
      const outcome = report.outcome;
      const partial = outcome.omittedReasons.length > 0;
      reasons.push(...outcome.omittedReasons);
      if (outcome.filesTruncated) reasons.push("file-list-truncated");
      const make = partial ? (value: number) => partialCount(value) : exactCount;
      const textual = outcome.files.some((file) => !file.binary) || outcome.files.length === 0;
      additions = textual ? make(outcome.additions) : notApplicableCount();
      deletions = textual ? make(outcome.deletions) : notApplicableCount();
      changedFiles = outcome.changedFiles;
      completeness = partial ? "partial" : "complete";
      files = outcome.files.map((file) =>
        fileRecord({
          pathId: encodePath(new TextEncoder().encode(file.path)),
          oldPath: file.previousPath ?? (file.status === "A" ? null : file.path),
          newPath: file.status === "D" ? null : file.path,
          status: {
            A: "added",
            D: "deleted",
            M: "modified",
            R: "renamed",
            T: "type-changed",
            unknown: "unknown",
          }[file.status],
          fileKind: file.binary ? "binary" : "text",
          additions: file.additions,
          additionsQuality: file.binary
            ? "not-applicable"
            : file.additions === null
              ? "unknown"
              : partial
                ? "partial"
                : "complete",
          deletions: file.deletions,
          deletionsQuality: file.binary
            ? "not-applicable"
            : file.deletions === null
              ? "unknown"
              : partial
                ? "partial"
                : "complete",
          bodyState: "not-retained",
          reason: "executor-private-endpoints",
        }),
      );
    } else {
      reasons.push(report.outcome.reason);
    }
    if (op.history_mode !== "live") reasons.push("history-replay");
    const draft = {
      ...this.base({
        scope,
        owner: {
          environmentId: op.environment_id,
          threadId: op.conversation_id,
          ...(op.turn_id ? { turnId: op.turn_id } : {}),
          operationId: op.operation_id,
          attemptId: op.attempt_id,
        },
        worktreeId: target.worktreeId,
        worktreeIncarnation: target.incarnation,
      }),
      evidenceRefs: evidenceRow
        ? [{ evidenceId: evidenceRow.evidence_id, evidenceRevision: evidenceRow.revision }]
        : [],
      capabilityRevision: report.capabilityRevision,
      origin: "git-observation" as const,
      algorithmPolicyId: `executor-numstat-v1/${report.executor}`,
      representationPolicyId: GIT_REPRESENTATION_ID,
      execution: executionOf(op.phase),
      executionOccurrence: occurrenceOf(op.execution_occurrence),
      effectClaim: "workspace-observed" as const,
      finality:
        report.boundary.after === "after-terminal" ? ("final" as const) : ("provisional" as const),
      consistency: report.consistency,
      boundary: { before: report.boundary.before, after: report.boundary.after },
      attribution: {
        basis: "workspace-observation" as const,
        writerIsolation: "shared" as const,
        overlap,
      },
      completeness: {
        files: completeness,
        reasons: [...new Set(reasons)].slice(0, 32),
        omittedFileCount: completeness === "complete" ? 0 : null,
      },
      totals: { additions, deletions, changedFiles },
    };
    const { measurement } = this.seal(draft, { kind: "operation", id: op.operation_id }, null);
    return (
      this.publish({
        measurement,
        owner: { kind: "operation", id: op.operation_id },
        files,
        identity: null,
        resourceKey,
      }).revision !== null
    );
  }

  // -------------------------------------------------------------------------
  // Operation volume (recorded edit activity)
  // -------------------------------------------------------------------------

  /**
   * structured-edit-volume-v1: one selected contribution per canonical
   * attempt — its tool effect when one exists, else the payload of an edit
   * that succeeded. Denied or unexecuted proposals contribute nothing. Shell
   * observations stay out: overlapping command windows cannot be added into
   * an exact volume. Unknown contributions keep the total partial; nothing
   * here is a net diff.
   */
  publishOperationVolume(
    owner: { kind: "turn" | "segment"; id: string },
    operations: readonly OperationRow[],
    worktree: { worktreeId: string; incarnation: string },
    environmentId: string,
  ): string | null {
    const STRUCTURED = new Set([
      "file-edit",
      "file-write",
      "file-delete",
      "file-move",
      "notebook-edit",
    ]);
    let additions: LineCount = exactCount(0);
    let deletions: LineCount = exactCount(0);
    const touched = new Set<string>();
    const evidenceRefs: Array<{ evidenceId: string; evidenceRevision: number }> = [];
    const origins = new Set<ChangeMeasurement["origin"]>();
    const reasons = new Set<string>();
    let unknownTouched = false;
    for (const op of operations) {
      if (!STRUCTURED.has(op.tool_kind)) {
        if (op.tool_kind === "shell") reasons.add("command-activity-excluded");
        continue;
      }
      const keys = toolResourceKeys(op.operation_id);
      const effectId = this.ledger.selection(keys.effect)?.measurement_id ?? null;
      const payloadId =
        op.phase === "succeeded"
          ? (this.ledger.selection(keys.payload)?.measurement_id ?? null)
          : null;
      const contribution = effectId
        ? this.ledger.measurement(effectId)
        : payloadId
          ? this.ledger.measurement(payloadId)
          : null;
      if (!contribution) {
        if (op.phase === "succeeded" || op.phase === "failed") reasons.add("contribution-unknown");
        continue;
      }
      additions = addLineCounts(additions, contribution.totals.additions);
      deletions = addLineCounts(deletions, contribution.totals.deletions);
      origins.add(contribution.origin);
      evidenceRefs.push(...contribution.evidenceRefs);
      const rows = this.ledger.measurementFiles(contribution.measurementId, 0, 500);
      if (rows.length === 0) unknownTouched = true;
      for (const row of rows) touched.add(row.new_path ?? row.old_path ?? row.path_id);
    }
    if (reasons.has("contribution-unknown")) {
      if (additions.value !== null) additions = partialCount(additions.value);
      if (deletions.value !== null) deletions = partialCount(deletions.value);
    }
    if (origins.size > 1) reasons.add("mixed-origins");
    const draft = {
      ...this.base({
        scope: "operation-volume",
        owner:
          owner.kind === "turn"
            ? { environmentId, turnId: owner.id }
            : { environmentId, threadSegmentId: owner.id },
        worktreeId: worktree.worktreeId,
        worktreeIncarnation: worktree.incarnation,
      }),
      evidenceRefs: evidenceRefs.slice(0, 200),
      origin: (origins.size === 1
        ? [...origins][0]!
        : "provider-counts") as ChangeMeasurement["origin"],
      algorithmPolicyId: "structured-edit-volume-v1",
      representationPolicyId: "operation-contributions-v1",
      effectClaim: "unknown" as const,
      finality: "provisional" as const,
      attribution: {
        basis: "provider-reported" as const,
        writerIsolation: "unknown" as const,
        overlap: "unknown" as const,
      },
      completeness: {
        files:
          reasons.has("contribution-unknown") || unknownTouched
            ? ("partial" as const)
            : ("complete" as const),
        reasons: [...reasons].sort(),
        omittedFileCount: null,
      },
      totals: {
        additions,
        deletions,
        changedFiles: null,
        touchedFiles: unknownTouched ? null : touched.size,
      },
    };
    const ledgerOwner = { kind: `${owner.kind}-volume`, id: owner.id };
    const { measurement } = this.seal(draft, ledgerOwner, null);
    const key = operationVolumeResourceKey(owner.id, owner.kind);
    return this.publish({
      measurement,
      owner: ledgerOwner,
      files: [],
      identity: null,
      resourceKey: key,
    }).revision !== null
      ? key
      : null;
  }

  // -------------------------------------------------------------------------
  // Provider-reported turn diffs
  // -------------------------------------------------------------------------

  async recomputeProviderTurn(
    providerTurnId: string,
    context: {
      environmentId: string;
      conversationId: string;
      turnId: string;
      worktreeId: string;
      incarnation: string;
    },
  ): Promise<string | null> {
    const rows = this.ledger.selectedEvidence("provider-turn", providerTurnId);
    if (rows.length === 0) return null;
    const { candidates, read } = await this.loadBodies(rows);
    const measured = combineEvidenceMeasurements(
      candidates.map((c) => measureEvidence(c.evidence, read)),
    );
    const draft = {
      ...this.base({
        scope: "provider-turn-diff",
        owner: {
          environmentId: context.environmentId,
          threadId: context.conversationId,
          turnId: context.turnId,
        },
        worktreeId: context.worktreeId,
        worktreeIncarnation: context.incarnation,
      }),
      evidenceRefs: candidates.map((c) => ({
        evidenceId: c.evidenceId,
        evidenceRevision: c.evidenceRevision,
      })),
      origin: measured.origin,
      algorithmPolicyId: measured.algorithmPolicyId,
      representationPolicyId: measured.representationPolicyId,
      effectClaim: "provider-reported" as const,
      finality: "provisional" as const,
      boundary: { before: "provider-declared" as const, after: "provider-declared" as const },
      attribution: {
        basis: "provider-reported" as const,
        writerIsolation: "unknown" as const,
        overlap: "unknown" as const,
      },
      completeness: {
        files: measured.fileCompleteness,
        reasons: measured.reasons.slice(0, 32),
        omittedFileCount: null,
      },
      totals: {
        additions: measured.additions,
        deletions: measured.deletions,
        changedFiles: measured.changedFiles,
      },
    };
    const owner = { kind: "provider-turn", id: providerTurnId };
    const { measurement, identity } = this.seal(draft, owner, "payload", {
      pathDisplays: measured.files.map((file) => ({
        before: file.previousPath ?? file.path,
        after: file.path,
      })),
    });
    const key = turnResourceKeys(context.turnId, providerTurnId).providerTurnDiff!;
    const outcome = this.publish({
      measurement,
      owner,
      files: payloadFiles(measured, true),
      identity,
      resourceKey: key,
    });
    return outcome.revision !== null ? key : null;
  }

  // -------------------------------------------------------------------------
  // Snapshot pairs (turn-net, thread-net, captured tool effects)
  // -------------------------------------------------------------------------

  async measureSnapshots(input: {
    scope: "turn-net" | "thread-net" | "tool-effect" | "observation-window";
    owner: { kind: string; id: string };
    logicalOwner: ChangeMeasurement["logicalOwner"];
    worktreeId: string;
    incarnation: string;
    before: SnapshotRow | null;
    after: SnapshotRow | null;
    baselineVersion: string | null;
    boundary: ChangeMeasurement["boundary"];
    execution?: MeasurementExecution;
    executionOccurrence?: MeasurementExecutionOccurrence;
    finality: ChangeMeasurement["finality"];
    overlap: ChangeMeasurement["attribution"]["overlap"];
    writerIsolation?: ChangeMeasurement["attribution"]["writerIsolation"];
    reasons?: string[];
    resourceKey: string;
    observationEpoch?: number;
    ownerFence?: { assert: () => void; value: number } | null;
  }): Promise<PublishOutcome> {
    const reasons = [...(input.reasons ?? [])];
    let draft = {
      ...this.base({
        scope: input.scope,
        owner: input.logicalOwner,
        worktreeId: input.worktreeId,
        worktreeIncarnation: input.incarnation,
      }),
      baselineVersion: input.baselineVersion,
      beforeSnapshotId: input.before?.id ?? null,
      afterSnapshotId: input.after?.id ?? null,
      origin: "captured-endpoints" as ChangeMeasurement["origin"],
      execution: input.execution ?? "not-applicable",
      executionOccurrence: input.executionOccurrence ?? "not-applicable",
      effectClaim: "workspace-observed" as EffectClaim,
      finality: input.finality,
      boundary: input.boundary,
      attribution: {
        basis: "workspace-observation" as const,
        writerIsolation: input.writerIsolation ?? ("shared" as const),
        overlap: input.overlap,
      },
    };
    let files: MeasurementFileRecord[] = [];
    let withIdentity: "comparison" | null = null;
    const beforeManifest = input.before
      ? await readManifest(this.store, input.before.tree_oid)
      : null;
    const afterManifest = input.after ? await readManifest(this.store, input.after.tree_oid) : null;
    if (!input.before || !input.after || !beforeManifest || !afterManifest) {
      if (!input.before) reasons.push("start-unavailable");
      if (!input.after) reasons.push("end-unavailable");
      if ((input.before && !beforeManifest) || (input.after && !afterManifest))
        reasons.push("snapshot-expired");
      if (input.scope === "thread-net" && !input.baselineVersion)
        reasons.push("baseline-unavailable");
      draft = {
        ...draft,
        origin: "captured-endpoints",
        beforeSnapshotId: null,
        afterSnapshotId: null,
        completeness: { files: "unknown", reasons: [...new Set(reasons)], omittedFileCount: null },
      } as typeof draft;
    } else {
      const comparison = await compareManifests(this.store, beforeManifest, afterManifest);
      const truncated = [input.before, input.after].some(
        (row) => JSON.parse(row.coverage_json).inventoryTruncated === true,
      );
      if (truncated) {
        comparison.completeness = "partial";
        comparison.reasons.push("inventory-limit");
        if (comparison.additions.value !== null)
          comparison.additions = partialCount(comparison.additions.value);
        if (comparison.deletions.value !== null)
          comparison.deletions = partialCount(comparison.deletions.value);
      }
      const beforeConsistency = JSON.parse(input.before.consistency_json).state as string;
      const afterConsistency = JSON.parse(input.after.consistency_json).state as string;
      const changed =
        beforeConsistency === "changed-during-capture" ||
        afterConsistency === "changed-during-capture";
      reasons.push(...comparison.reasons);
      withIdentity = "comparison";
      draft = {
        ...draft,
        consistency: changed
          ? "changed-during-capture"
          : input.overlap === "none-observed"
            ? "stable-observation"
            : "coordinated-interval",
        completeness: {
          files: comparison.completeness,
          reasons: [...new Set(reasons)].slice(0, 32),
          omittedFileCount: truncated ? null : comparison.omittedFileCount,
        },
        totals: {
          additions: comparison.additions,
          deletions: comparison.deletions,
          changedFiles: comparison.changedFiles,
        },
      } as typeof draft;
      files = comparison.files.map((file) =>
        fileRecord({
          pathId: file.pathId,
          oldPath: file.oldPathId,
          newPath: file.newPathId,
          oldBlob: file.oldEntry?.o ?? null,
          newBlob: file.newEntry?.o ?? null,
          oldMode: file.oldEntry?.m ?? null,
          newMode: file.newEntry?.m ?? null,
          status: file.status,
          fileKind: file.fileKind,
          additions: file.additions.value,
          additionsQuality: file.additions.quality,
          deletions: file.deletions.value,
          deletionsQuality: file.deletions.quality,
          bodyState: file.status === "unknown" ? "not-retained" : "available",
          reason: file.reason,
        }),
      );
    }
    const { measurement, identity } = this.seal(draft, input.owner, withIdentity, undefined, files);
    return this.publish({
      measurement,
      owner: input.owner,
      files,
      identity,
      resourceKey: input.resourceKey,
      observationEpoch: input.observationEpoch,
      ownerFence: input.ownerFence ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // Legacy journal import
  // -------------------------------------------------------------------------

  /**
   * Import a surviving command-journal record as legacy-summary-only
   * evidence. Its counts keep their original truncation; no snapshot or body
   * is invented, and nothing is read from today's disk.
   */
  importLegacySummary(input: {
    operationId: string;
    environmentId: string;
    conversationId: string;
    worktreeId: string;
    change: {
      additions: number;
      deletions: number;
      files: {
        path: string;
        additions: number;
        deletions: number;
        status?: string;
        binary?: true;
        previousPath?: string;
      }[];
      filesTruncated?: true;
      approximate?: true;
    };
  }): PublishOutcome {
    const reasons = ["legacy-summary-only"];
    if (input.change.approximate) reasons.push("legacy-approximate");
    if (input.change.filesTruncated) reasons.push("file-list-truncated");
    const make = input.change.approximate ? (value: number) => partialCount(value) : exactCount;
    const draft = {
      ...this.base({
        scope: "observation-window",
        owner: {
          environmentId: input.environmentId,
          threadId: input.conversationId,
          operationId: input.operationId,
        },
        worktreeId: input.worktreeId,
        worktreeIncarnation: "legacy",
      }),
      origin: "legacy-import" as const,
      algorithmPolicyId: LEGACY_ALGORITHM_ID,
      representationPolicyId: LEGACY_REPRESENTATION_ID,
      effectClaim: "workspace-observed" as const,
      finality: "final" as const,
      boundary: { before: "unknown" as const, after: "unknown" as const },
      attribution: {
        basis: "workspace-observation" as const,
        writerIsolation: "unknown" as const,
        overlap: input.change.approximate ? ("known-overlap" as const) : ("unknown" as const),
      },
      completeness: {
        files: input.change.filesTruncated ? ("partial" as const) : ("complete" as const),
        reasons,
        omittedFileCount: null,
      },
      totals: {
        additions: make(input.change.additions),
        deletions: make(input.change.deletions),
        changedFiles: input.change.filesTruncated ? null : input.change.files.length,
      },
    };
    const owner = { kind: "operation", id: input.operationId };
    const { measurement } = this.seal(draft, owner, null);
    const files = input.change.files.map((file) =>
      fileRecord({
        pathId: encodePath(new TextEncoder().encode(file.path)),
        oldPath: file.previousPath ?? file.path,
        newPath: file.path,
        status:
          { A: "added", D: "deleted", M: "modified", R: "renamed" }[file.status ?? "M"] ??
          "modified",
        fileKind: file.binary ? "binary" : "text",
        additions: file.binary ? null : file.additions,
        additionsQuality: file.binary ? "not-applicable" : "complete",
        deletions: file.binary ? null : file.deletions,
        deletionsQuality: file.binary ? "not-applicable" : "complete",
        bodyState: "not-retained",
        reason: "legacy-summary-only",
      }),
    );
    return this.publish({
      measurement,
      owner,
      files,
      identity: null,
      resourceKey: toolResourceKeys(input.operationId).observation,
    });
  }
}

function evidenceBodyRefs(evidence: ProviderEvidence) {
  if (evidence.kind === "patch") return [evidence.body];
  if (evidence.kind === "replacement") {
    return [
      ...(evidence.before.state === "present" ? [evidence.before.body] : []),
      ...(evidence.after.state === "present" ? [evidence.after.body] : []),
    ];
  }
  return [];
}

function payloadFiles(measured: EvidenceMeasurement, retained: boolean): MeasurementFileRecord[] {
  return measured.files.map((file) =>
    fileRecord({
      pathId: encodePath(new TextEncoder().encode(file.path ?? "")),
      oldPath: file.previousPath ?? (file.status === "added" ? null : file.path),
      newPath: file.status === "deleted" ? null : file.path,
      status: file.status,
      fileKind: file.fileKind,
      additions: file.additions.value,
      additionsQuality: file.additions.quality,
      deletions: file.deletions.value,
      deletionsQuality: file.deletions.quality,
      bodyState: retained ? "available" : "not-retained",
      reason: file.reasons[0] ?? null,
    }),
  );
}

/** Sum of independent line counts, for aggregate labels. */
export function sumCounts(values: readonly LineCount[]): LineCount {
  return values.reduce((total, value) => addLineCounts(total, value), exactCount(0));
}
