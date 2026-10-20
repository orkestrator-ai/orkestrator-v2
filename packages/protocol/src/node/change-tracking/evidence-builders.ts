/**
 * Adapter-side helpers that turn decoded provider facts into canonical
 * frames and append them to the bridge's {@link ChangeEvidenceSpool}.
 *
 * Adapters decide what their native payloads mean (which tool kind, whether a
 * side is known, whether a patch is a proposal or an applied result). These
 * helpers only encode that decision: they retain bodies by reference, assign
 * stable evidence keys, revision keys and frame ids, and never count lines.
 *
 * Identities are content-derived, so a replayed event produces the same frame
 * id and revision key and the backend deduplicates it, while a changed
 * cumulative patch gets a new revision that replaces — never adds to — the
 * previous one.
 */

import {
  PROVIDER_EVIDENCE_SCHEMA_VERSION,
  type EvidenceBodyRef,
  type ExecutionOccurrence,
  type FileSide,
  type ProviderChangeCapabilities,
  type ProviderEffectClaim,
  type ProviderEvidence,
  type ProviderEvidenceFrame,
  type ProviderEvidenceSource,
  type ProviderEvidenceUpdate,
  type ToolKind,
  type ToolPhase,
  type WorkspaceObservationFile,
  type WorkspaceObservationReport,
  type WriterLiveness,
} from "../../change-evidence.js";
import type { MeasuredWorkspaceChange } from "../../tool-diff.js";
import { stableEvidenceId, type ChangeEvidenceSpool } from "./evidence-spool.js";

/**
 * One decoded evidence block. For replacement sides: a string is present
 * content (empty string is a present empty file), `null` is established
 * absence, and `undefined` is unknown.
 */
export type EvidenceInput =
  | {
      kind: "patch";
      key?: string;
      text: string;
      path?: string;
      previousPath?: string;
      format?: "git_unified" | "opaque";
      claim: ProviderEffectClaim;
    }
  | {
      kind: "replacement";
      key?: string;
      path: string;
      before: string | null | undefined;
      after: string | null | undefined;
      /** Why a side is unknown, when it is. */
      unknownReason?: string;
      extent: "fragment" | "whole-file" | "notebook-cell" | "unknown";
      origin: "input" | "result";
      claim: ProviderEffectClaim;
    }
  | {
      kind: "reported-counts";
      key?: string;
      path?: string;
      additions: number | null;
      deletions: number | null;
      contentLines?: number | null;
      scope: "file" | "tool" | "turn";
      claim: ProviderEffectClaim;
    }
  | {
      kind: "path-operation";
      key?: string;
      path: string;
      previousPath?: string;
      operation: "add" | "modify" | "delete" | "rename" | "unknown";
      claim: ProviderEffectClaim;
    };

export interface EvidenceSourceInput {
  conversationId: string;
  turnId?: string;
  callId?: string;
  parentCallId?: string;
  parentConversationId?: string;
  subagentId?: string;
  itemId?: string;
  attemptId?: string;
  nativeRevision?: string;
  mode?: ProviderEvidenceSource["mode"];
}

export interface ChangeEvidenceRecorderOptions {
  spool: ChangeEvidenceSpool;
  /** Provider family; namespaces binding ids only. */
  provider: string;
  capabilities: Omit<ProviderChangeCapabilities, "capabilityRevision">;
  executor?: "host-worker" | "container-worker";
}

const MAX_KEY = 200;

function clampId(value: string): string {
  return value.length <= MAX_KEY ? value : `${value.slice(0, 120)}~${stableEvidenceId(value)}`;
}

const MAX_TRACKED_REVISIONS = 4_096;

export class ChangeEvidenceRecorder {
  readonly capabilityRevision: string;
  /** Last revision emitted per (binding, call, evidence key), to declare supersession. */
  private readonly lastRevisions = new Map<string, { content: string; revision: string }>();
  readonly capabilities: ProviderChangeCapabilities;
  private readonly spool: ChangeEvidenceSpool;
  private readonly provider: string;
  private readonly executor: "host-worker" | "container-worker";

  constructor(options: ChangeEvidenceRecorderOptions) {
    this.spool = options.spool;
    this.provider = options.provider;
    this.executor = options.executor ?? "host-worker";
    this.capabilityRevision = `cap:${stableEvidenceId(options.provider, JSON.stringify(options.capabilities))}`;
    this.capabilities = { ...options.capabilities, capabilityRevision: this.capabilityRevision };
    this.spool.declareCapabilities(this.capabilities);
  }

  bindingFor(conversationId: string): string {
    return clampId(`${this.provider}:${conversationId}`);
  }

  private source(input: EvidenceSourceInput): ProviderEvidenceSource {
    const source: ProviderEvidenceSource = {
      conversationId: clampId(input.conversationId),
      mode: input.mode ?? "live",
    };
    for (const key of [
      "turnId",
      "callId",
      "parentCallId",
      "parentConversationId",
      "subagentId",
      "itemId",
      "attemptId",
      "nativeRevision",
    ] as const) {
      const value = input[key];
      if (value) source[key] = clampId(value);
    }
    return source;
  }

  private side(value: string | null | undefined, reason: string): FileSide {
    if (value === null) return { state: "absent" };
    if (value === undefined) return { state: "unknown", reason };
    return { state: "present", body: this.spool.retainBody(value) };
  }

  /** Encode decoded inputs as replace updates with stable keys and revisions. */
  updates(inputs: readonly EvidenceInput[]): ProviderEvidenceUpdate[] {
    const counters = new Map<string, number>();
    return inputs.map((input) => {
      const ordinal = counters.get(input.kind) ?? 0;
      counters.set(input.kind, ordinal + 1);
      const evidenceKey = clampId(input.key ?? `${input.kind}:${ordinal}`);
      const evidence = this.evidence(input);
      return {
        kind: "replace" as const,
        evidenceKey,
        revisionKey: `rev:${stableEvidenceId(evidenceKey, canonicalEvidence(evidence))}`,
        evidence,
      };
    });
  }

  private evidence(input: EvidenceInput): ProviderEvidence {
    switch (input.kind) {
      case "patch":
        return {
          kind: "patch",
          ...(input.path ? { path: input.path } : {}),
          ...(input.previousPath ? { previousPath: input.previousPath } : {}),
          body: this.spool.retainBody(input.text),
          format: input.format ?? "git_unified",
          effectClaim: input.claim,
        };
      case "replacement":
        return {
          kind: "replacement",
          path: input.path,
          before: this.side(input.before, input.unknownReason ?? "before-not-supplied"),
          after: this.side(input.after, input.unknownReason ?? "after-not-supplied"),
          extent: input.extent,
          origin: input.origin,
          effectClaim: input.claim,
        };
      case "reported-counts":
        return {
          kind: "reported-counts",
          ...(input.path ? { path: input.path } : {}),
          additions: input.additions,
          deletions: input.deletions,
          ...(input.contentLines !== undefined ? { contentLines: input.contentLines } : {}),
          scope: input.scope,
          effectClaim: input.claim,
        };
      case "path-operation":
        return {
          kind: "path-operation",
          path: input.path,
          ...(input.previousPath ? { previousPath: input.previousPath } : {}),
          operation: input.operation,
          effectClaim: input.claim,
        };
    }
  }

  private frame(
    source: EvidenceSourceInput,
    event: ProviderEvidenceFrame["event"],
    identity: string,
  ): ProviderEvidenceFrame {
    const bindingId = this.bindingFor(source.conversationId);
    return {
      schemaVersion: PROVIDER_EVIDENCE_SCHEMA_VERSION,
      bindingId,
      runtimeEpoch: this.spool.runtimeEpoch,
      capabilityRevision: this.capabilityRevision,
      frameId: `frame:${stableEvidenceId(bindingId, identity)}`,
      source: this.source(source),
      event,
    };
  }

  /** Record a tool lifecycle/evidence update. Returns false when spooling failed. */
  tool(
    source: EvidenceSourceInput & { callId: string },
    event: {
      toolKind: ToolKind;
      phase: ToolPhase;
      executionOccurrence: ExecutionOccurrence;
      evidence?: readonly EvidenceInput[];
      backgroundTaskId?: string;
    },
  ): boolean {
    const updates = this.supersede(
      `${this.bindingFor(source.conversationId)}\0${source.callId}\0${source.attemptId ?? ""}`,
      this.updates(event.evidence ?? []),
    );
    const identity = [
      "tool",
      source.callId,
      source.attemptId,
      event.toolKind,
      event.phase,
      event.executionOccurrence,
      event.backgroundTaskId,
      ...updates.map((u) => u.revisionKey),
    ].join("\0");
    return this.spool.appendFrame(
      this.frame(
        source,
        {
          kind: "tool",
          toolKind: event.toolKind,
          phase: event.phase,
          executionOccurrence: event.executionOccurrence,
          evidence: updates,
          ...(event.backgroundTaskId ? { backgroundTaskId: clampId(event.backgroundTaskId) } : {}),
        },
        identity,
      ),
    );
  }

  /**
   * Declare that each update replaces the revision this recorder last emitted
   * for the same block. Only the adapter knows this ordering; the backend
   * never infers it from receipt time.
   */
  private supersede(scope: string, updates: ProviderEvidenceUpdate[]): ProviderEvidenceUpdate[] {
    return updates.map((update) => {
      if (update.kind !== "replace") return update;
      const key = `${scope}\0${update.evidenceKey}`;
      const previous = this.lastRevisions.get(key);
      const content = update.revisionKey;
      // A repeated adjacent delivery is a replay; returning to an older body
      // after another revision is a new ordered transition.
      const revisionKey =
        previous?.content === content
          ? previous.revision
          : previous
            ? `rev:${stableEvidenceId(scope, content, previous.revision)}`
            : content;
      this.lastRevisions.delete(key);
      this.lastRevisions.set(key, { content, revision: revisionKey });
      if (this.lastRevisions.size > MAX_TRACKED_REVISIONS) {
        const oldest = this.lastRevisions.keys().next().value;
        if (oldest !== undefined) this.lastRevisions.delete(oldest);
      }
      return {
        ...update,
        revisionKey,
        ...(previous && previous.revision !== revisionKey
          ? { replacesRevisionKey: previous.revision }
          : {}),
      };
    });
  }

  turn(
    source: EvidenceSourceInput & { turnId: string },
    phase: "proposed" | "running" | "succeeded" | "failed" | "cancelled" | "unknown",
    writerLiveness: WriterLiveness = "unknown",
  ): boolean {
    return this.spool.appendFrame(
      this.frame(
        source,
        { kind: "turn", phase, writerLiveness },
        ["turn", source.turnId, phase, writerLiveness].join("\0"),
      ),
    );
  }

  /** A provider-reported cumulative turn patch; each version replaces the last. */
  turnDiff(source: EvidenceSourceInput & { turnId: string }, patch: string): boolean {
    const updates = this.supersede(
      `${this.bindingFor(source.conversationId)}\0turn\0${source.turnId}`,
      this.updates([{ kind: "patch", key: "turn-diff", text: patch, claim: "provider-reported" }]),
    );
    return this.spool.appendFrame(
      this.frame(
        source,
        { kind: "turn-diff", evidence: updates, endpointMeaning: "provider-reported" },
        ["turn-diff", source.turnId, updates[0]!.revisionKey].join("\0"),
      ),
    );
  }

  backgroundTask(
    source: EvidenceSourceInput,
    task: {
      taskId: string;
      parentCallId?: string;
      phase: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
      executionOccurrence: ExecutionOccurrence;
      writerLiveness: WriterLiveness;
    },
  ): boolean {
    return this.spool.appendFrame(
      this.frame(
        source,
        {
          kind: "background-task",
          taskId: clampId(task.taskId),
          ...(task.parentCallId ? { parentCallId: clampId(task.parentCallId) } : {}),
          phase: task.phase,
          executionOccurrence: task.executionOccurrence,
          writerLiveness: task.writerLiveness,
          evidence: [],
        },
        ["task", task.taskId, task.phase, task.writerLiveness].join("\0"),
      ),
    );
  }

  /** Report a capture-executor observation (see {@link WorkspaceObservationReport}). */
  observation(
    source: EvidenceSourceInput & { callId: string },
    observation: ProbeObservationInput,
  ): boolean {
    const bindingId = this.bindingFor(source.conversationId);
    const report: WorkspaceObservationReport = {
      schemaVersion: PROVIDER_EVIDENCE_SCHEMA_VERSION,
      reportId: `obs:${stableEvidenceId(bindingId, source.callId, source.attemptId, observation.windowId)}`,
      bindingId,
      runtimeEpoch: this.spool.runtimeEpoch,
      capabilityRevision: this.capabilityRevision,
      source: {
        conversationId: clampId(source.conversationId),
        ...(source.turnId ? { turnId: clampId(source.turnId) } : {}),
        callId: clampId(source.callId),
        ...(source.attemptId ? { attemptId: clampId(source.attemptId) } : {}),
      },
      executor: this.executor,
      boundary: observation.boundary,
      overlap: observation.overlap,
      consistency: observation.consistency ?? "unknown",
      outcome: observation.change
        ? measuredOutcome(observation.change, observation.omittedReasons ?? [])
        : { kind: "unavailable", reason: observation.unavailableReason ?? "capture-unavailable" },
      observedAt: new Date().toISOString(),
    };
    return this.spool.appendObservation(report);
  }
}

/** What a probe window reports, independent of the provider. */
export interface ProbeObservationInput {
  /** Distinguishes repeated windows for one call (retries). */
  windowId?: string;
  boundary: WorkspaceObservationReport["boundary"];
  overlap: WorkspaceObservationReport["overlap"];
  consistency?: WorkspaceObservationReport["consistency"];
  change?: MeasuredWorkspaceChange;
  omittedReasons?: string[];
  unavailableReason?: string;
}

function measuredOutcome(
  change: MeasuredWorkspaceChange,
  omittedReasons: string[],
): WorkspaceObservationReport["outcome"] {
  const files: WorkspaceObservationFile[] = change.files.slice(0, 200).map((file) => ({
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
    status: file.status ?? "unknown",
    additions: file.binary ? null : file.additions,
    deletions: file.binary ? null : file.deletions,
    binary: file.binary === true,
  }));
  return {
    kind: "measured",
    files,
    additions: change.additions,
    deletions: change.deletions,
    changedFiles: change.filesTruncated
      ? Math.max(files.length, change.files.length)
      : files.length,
    filesTruncated: change.filesTruncated === true,
    omittedReasons,
  };
}

function bodyKey(ref: EvidenceBodyRef): string {
  return `${ref.id}:${ref.state}:${ref.complete}`;
}

/** Canonical content string for revision identity (body bytes by id). */
function canonicalEvidence(evidence: ProviderEvidence): string {
  switch (evidence.kind) {
    case "patch":
      return [
        "patch",
        evidence.path,
        evidence.previousPath,
        evidence.format,
        evidence.effectClaim,
        bodyKey(evidence.body),
      ].join("\0");
    case "replacement": {
      const side = (value: FileSide) =>
        value.state === "present"
          ? `p:${bodyKey(value.body)}`
          : value.state === "absent"
            ? "a"
            : `u:${value.reason}`;
      return [
        "replacement",
        evidence.path,
        side(evidence.before),
        side(evidence.after),
        evidence.extent,
        evidence.origin,
        evidence.effectClaim,
      ].join("\0");
    }
    case "reported-counts":
      return [
        "counts",
        evidence.path,
        evidence.additions,
        evidence.deletions,
        evidence.contentLines,
        evidence.scope,
        evidence.effectClaim,
      ].join("\0");
    case "path-operation":
      return [
        "path",
        evidence.path,
        evidence.previousPath,
        evidence.operation,
        evidence.effectClaim,
      ].join("\0");
  }
}
