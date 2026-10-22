/**
 * The Codex adapter for backend-owned change tracking.
 *
 * Translates the app-server item lifecycle into canonical evidence frames on
 * one per-process spool the backend pulls (`GET /change-evidence`). It never
 * counts lines: a `fileChange` item's per-file payload is recorded as a patch
 * (a proposal while the patch is in progress, provider-reported once
 * app-server completes it), `turn/diff/updated` as the provider's cumulative
 * turn patch, and a shell command's probe window as an observation for the
 * backend to judge. See `docs/architecture/change-tracking.md`
 * ("Writing a provider adapter").
 *
 * Identity: `conversationId` is the bridge session id the backend addresses
 * in `/session/:id` (its provider session id). That is not the Codex thread
 * id — several tabs (sessions) can share one thread — so a thread's frames
 * are recorded once per session bound to it. `callId` is the app-server item
 * id, which is the `toolUseId` on the item's transcript rows and the
 * rollout's `call_id`; `turnId` is the Codex turn id.
 *
 * Every method is synchronous and bounded: it runs on the app-server
 * notification path, which must never await (see `AGENTS.md`). Only live
 * events produce frames; a transcript rebuilt from a rollout emits nothing.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ExecutionOccurrence,
  ProviderChangeCapabilities,
  ToolKind,
  ToolPhase,
  WriterLiveness,
} from "@orkestrator/protocol/change-evidence";
import {
  ChangeEvidenceRecorder,
  type EvidenceInput,
} from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type { ProbeObservation } from "@orkestrator/protocol/node/workspace-change-probe";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import type { FileUpdateChange, PatchApplyStatus } from "./codex-item-types.js";
import type { EngineItem, EngineTurnStatus } from "./engine/types.js";
import { parseRawApplyPatchChanges } from "./messages/apply-patch.js";
import { suppliedFileChange } from "./messages/file-change-diff.js";
import { commandDidNotRun } from "./sessions/command-changes.js";

export type CaptureExecutor = "container-worker" | "host-worker";

/**
 * Where this bridge (and so its workspace probe) runs. Orkestrator runs
 * containers under Docker, which always creates `/.dockerenv`; Podman's
 * equivalent is `/run/.containerenv`. Without either marker the bridge is the
 * host process the backend spawned for a local environment.
 */
export function detectCaptureExecutor(
  exists: (path: string) => boolean = existsSync,
): CaptureExecutor {
  return exists("/.dockerenv") || exists("/run/.containerenv") ? "container-worker" : "host-worker";
}

/** What this bridge establishes, and nothing it does not. */
export function codexChangeCapabilities(
  executor: CaptureExecutor,
): Omit<ProviderChangeCapabilities, "capabilityRevision"> {
  return {
    // Background completion is not established, so the record is partial.
    resolution: "partial",
    // The runtime primes the probe baseline and journals the dispatch before
    // `turn/start`; the backend captures the turn start before dispatching.
    beforeTurn: "controlled-dispatch",
    // `turn/completed` is observed; a unified-exec process may outlive it.
    afterTurn: "terminal-observed",
    // app-server reports a command only once it runs; nothing holds it, so a
    // window opens on the latest primed snapshot.
    beforeTool: "observed-after-start",
    // The "after" snapshot is taken when `item/completed` is observed.
    afterTool: "observed",
    // The app-server item id is the rollout's `call_id` and the row's
    // `toolUseId`, so a reload keeps the identity.
    historicalCallIdentity: "stable",
    // `fileChange` items carry one patch payload per file.
    fileEvidence: { resolution: "confirmed", kinds: ["patch"] },
    turnDiff: "reported",
    captureExecutor: executor,
    captureAvailability: "ready",
    // A command still running at turn end is discarded (`discardOutlivingCommandWindows`)
    // and app-server's process exit is not tied back to its call.
    backgroundCompletion: "unknown",
  };
}

// ---------------------------------------------------------------------------
// Native → canonical decoding (pure)
// ---------------------------------------------------------------------------

/** One file's operation as a tool kind; a multi-file patch is an edit. */
export function codexFileToolKind(
  changes: readonly { kind: "add" | "delete" | "update" | "move"; moved?: boolean }[],
): ToolKind {
  if (changes.length !== 1) return "file-edit";
  const [change] = changes;
  if (change!.kind === "add") return "file-write";
  if (change!.kind === "delete") return "file-delete";
  if (change!.kind === "move" || change!.moved) return "file-move";
  return "file-edit";
}

function pathOperation(kind: FileUpdateChange["kind"], moved: boolean) {
  return kind === "add" ? "add" : kind === "delete" ? "delete" : moved ? "rename" : "modify";
}

/**
 * The evidence one `fileChange` item states: per file, the supplied patch
 * (key `file:<index>`) and, when that patch does not itself say what happened
 * to the path (no payload, or an add/delete whose payload is whole content),
 * a path operation (key `path:<index>`). Proposals are kept under their own
 * keys, so a proposal and an applied result are never one block.
 */
export function codexFileChangeEvidence(
  changes: readonly FileUpdateChange[],
  claim: "proposal" | "provider-reported",
): EvidenceInput[] {
  const suffix = claim === "proposal" ? ":proposal" : "";
  const evidence: EvidenceInput[] = [];
  changes.forEach((change, index) => {
    const supplied = suppliedFileChange(change);
    const movePath = supplied?.kind === "update" ? supplied.movePath : change.move_path;
    const path = movePath ?? change.path;
    const previousPath = movePath && movePath !== change.path ? change.path : undefined;
    const patchShowsOperation = supplied?.kind === "update" && supplied.unified;
    if (supplied) {
      evidence.push({
        kind: "patch",
        key: `file:${index}${suffix}`,
        text: supplied.kind === "update" ? supplied.hunks : supplied.content,
        path,
        ...(previousPath ? { previousPath } : {}),
        // An update's hunks are unified diff text; an add/delete payload is
        // the file's whole content, which no patch parser may read as hunks.
        format: patchShowsOperation ? "git_unified" : "opaque",
        claim,
      });
    }
    if (!patchShowsOperation || previousPath) {
      evidence.push({
        kind: "path-operation",
        key: `path:${index}${suffix}`,
        path,
        ...(previousPath ? { previousPath } : {}),
        operation: pathOperation(change.kind, previousPath !== undefined),
        claim,
      });
    }
  });
  return evidence;
}

/** A file change's phase and occurrence from app-server's real status. */
export function codexFileChangePhase(
  status: PatchApplyStatus,
  lifecycle: "started" | "updated" | "completed" | "awaiting-approval",
): { phase: ToolPhase; executionOccurrence: ExecutionOccurrence } {
  switch (status) {
    case "completed":
      return { phase: "succeeded", executionOccurrence: "started" };
    case "declined":
      return { phase: "denied", executionOccurrence: "did-not-run" };
    case "failed":
      // app-server does not say whether a failed patch touched anything.
      return { phase: "failed", executionOccurrence: "unknown" };
    case "in_progress":
      if (lifecycle === "awaiting-approval") {
        return { phase: "awaiting-approval", executionOccurrence: "not-started" };
      }
      // `patchUpdated`: the model is still writing the patch.
      if (lifecycle === "updated") return { phase: "proposed", executionOccurrence: "not-started" };
      // `item/completed` with no terminal status says nothing settled.
      if (lifecycle === "completed") return { phase: "unknown", executionOccurrence: "unknown" };
      // Started, but possibly still waiting on an approval.
      return { phase: "running", executionOccurrence: "unknown" };
  }
}

/** A shell command's phase and occurrence. */
export function codexCommandPhase(
  item: Extract<EngineItem, { type: "command_execution" }>,
  lifecycle: "started" | "updated" | "completed" | "awaiting-approval",
): { phase: ToolPhase; executionOccurrence: ExecutionOccurrence } {
  if (lifecycle === "awaiting-approval" && item.status === "in_progress") {
    return { phase: "awaiting-approval", executionOccurrence: "not-started" };
  }
  if (commandDidNotRun(item)) return { phase: "failed", executionOccurrence: "did-not-run" };
  switch (item.status) {
    case "completed":
      return { phase: "succeeded", executionOccurrence: "started" };
    case "failed":
      return { phase: "failed", executionOccurrence: "started" };
    default:
      return lifecycle === "completed"
        ? { phase: "unknown", executionOccurrence: "unknown" }
        : { phase: "running", executionOccurrence: "started" };
  }
}

function turnPhase(status: EngineTurnStatus): "succeeded" | "failed" | "cancelled" {
  return status === "completed" ? "succeeded" : status === "interrupted" ? "cancelled" : "failed";
}

/**
 * The value the transcript's legacy `commandChanges` badge has always shown
 * for a window: what `WorkspaceChangeProbe.end` returns for the same
 * observation (approximate when overlapped, late or partially omitted).
 */
export function legacyCommandChange(
  observation: ProbeObservation | undefined,
): MeasuredWorkspaceChange | undefined {
  const change = observation?.change;
  if (!change) return undefined;
  if (
    observation.overlap === "known-overlap" ||
    observation.boundary.before === "late-start" ||
    observation.omittedReasons.length > 0
  ) {
    change.approximate = true;
  }
  return change;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface CodexEvidenceSource {
  /** Bridge sessions bound to the thread (the backend's provider session ids). */
  sessionIds: readonly string[];
  turnId: string;
}

/** Streaming patch previews are recorded at most this often per call. */
export const PATCH_PREVIEW_INTERVAL_MS = 2_000;
const MAX_TRACKED_PREVIEWS = 1_024;
/** A thread is shared by tabs; past this many sessions the rest are skipped. */
const MAX_SESSIONS_PER_FRAME = 16;

export interface CodexChangeEvidenceOptions {
  spool: ChangeEvidenceSpool;
  executor: CaptureExecutor;
  now?: () => number;
}

export class CodexChangeEvidence {
  readonly spool: ChangeEvidenceSpool;
  readonly recorder: ChangeEvidenceRecorder;
  private readonly now: () => number;
  /** Last streamed-preview time per call, bounded. */
  private readonly previewAt = new Map<string, number>();

  constructor(options: CodexChangeEvidenceOptions) {
    this.spool = options.spool;
    this.now = options.now ?? Date.now;
    this.recorder = new ChangeEvidenceRecorder({
      spool: options.spool,
      provider: "codex",
      capabilities: codexChangeCapabilities(options.executor),
      executor: options.executor,
    });
  }

  private sessions(source: CodexEvidenceSource): readonly string[] {
    return source.sessionIds.slice(0, MAX_SESSIONS_PER_FRAME);
  }

  /**
   * One item lifecycle step. `updated` is app-server's streamed patch preview
   * (`item/fileChange/patchUpdated`) and is rate limited per call: every
   * terminal frame carries the final payload, so a skipped preview loses
   * nothing the backend selects.
   */
  item(
    source: CodexEvidenceSource,
    lifecycle: "started" | "updated" | "completed" | "awaiting-approval",
    item: EngineItem,
  ): void {
    if (item.type === "file_change") {
      if (lifecycle === "updated" && !this.admitPreview(item.id)) return;
      if (lifecycle === "completed") this.previewAt.delete(item.id);
      const { phase, executionOccurrence } = codexFileChangePhase(item.status, lifecycle);
      const claim = item.status === "completed" ? "provider-reported" : "proposal";
      const evidence = codexFileChangeEvidence(item.changes, claim);
      const toolKind = codexFileToolKind(
        item.changes.map((change) => ({
          kind: change.kind,
          moved: suppliedMovePath(change) !== undefined,
        })),
      );
      this.tool(source, item.id, { toolKind, phase, executionOccurrence, evidence });
      return;
    }
    if (item.type === "command_execution") {
      if (lifecycle === "updated") return;
      const { phase, executionOccurrence } = codexCommandPhase(item, lifecycle);
      this.tool(source, item.id, { toolKind: "shell", phase, executionOccurrence });
    }
  }

  /**
   * A raw `apply_patch` call (`custom_tool_call`), before or without a
   * structured `fileChange`. Its input is Codex's patch grammar, not unified
   * diff, so each file's section is an opaque proposal; `outcome` is the
   * call's own result once `custom_tool_call_output` arrived. Its blocks have
   * their own keys (`raw-patch:<i>`), so they never supersede the structured
   * item's proposal for the same call.
   */
  rawApplyPatch(
    source: CodexEvidenceSource,
    callId: string,
    input: unknown,
    outcome?: "succeeded" | "failed",
  ): void {
    const changes = parseRawApplyPatchChanges(input);
    if (changes.length === 0) return;
    const evidence: EvidenceInput[] = [];
    changes.forEach((change, index) => {
      const moved = change.targetPath !== change.path;
      evidence.push({
        kind: "patch",
        key: `raw-patch:${index}`,
        text: change.diff,
        path: change.targetPath,
        ...(moved ? { previousPath: change.path } : {}),
        format: "opaque",
        claim: "proposal",
      });
      evidence.push({
        kind: "path-operation",
        key: `raw-path:${index}`,
        path: change.targetPath,
        ...(moved ? { previousPath: change.path } : {}),
        operation:
          change.kind === "add"
            ? "add"
            : change.kind === "delete"
              ? "delete"
              : moved
                ? "rename"
                : "modify",
        claim: "proposal",
      });
    });
    const toolKind = codexFileToolKind(changes.map((change) => ({ kind: change.kind })));
    const phase: ToolPhase = outcome ?? "proposed";
    const executionOccurrence: ExecutionOccurrence =
      outcome === "succeeded" ? "started" : outcome === "failed" ? "unknown" : "not-started";
    this.tool(source, callId, { toolKind, phase, executionOccurrence, evidence });
  }

  /** `turn/started` and `turn/completed`. */
  turn(source: CodexEvidenceSource, status: "running" | EngineTurnStatus): void {
    const phase = status === "running" ? "running" : turnPhase(status);
    // A unified-exec process can outlive its turn, so a settled turn does
    // not establish that every writer stopped.
    const liveness: WriterLiveness = status === "running" ? "may-write" : "unknown";
    for (const conversationId of this.sessions(source)) {
      this.recorder.turn({ conversationId, turnId: source.turnId }, phase, liveness);
    }
  }

  /** `turn/diff/updated`: the turn's cumulative patch, replacing the last one. */
  turnDiff(source: CodexEvidenceSource, diff: string): void {
    for (const conversationId of this.sessions(source)) {
      this.recorder.turnDiff({ conversationId, turnId: source.turnId }, diff);
    }
  }

  /** A measured command window, from `WorkspaceChangeProbe.endObservation`. */
  observation(source: CodexEvidenceSource, callId: string, observation: ProbeObservation): void {
    for (const conversationId of this.sessions(source)) {
      this.recorder.observation(
        { conversationId, turnId: source.turnId, callId },
        {
          boundary: observation.boundary,
          overlap: observation.overlap,
          ...(observation.change ? { change: observation.change } : {}),
          omittedReasons: observation.omittedReasons,
          ...(observation.unavailableReason
            ? { unavailableReason: observation.unavailableReason }
            : {}),
        },
      );
    }
  }

  private tool(
    source: CodexEvidenceSource,
    callId: string,
    event: {
      toolKind: ToolKind;
      phase: ToolPhase;
      executionOccurrence: ExecutionOccurrence;
      evidence?: EvidenceInput[];
    },
  ): void {
    for (const conversationId of this.sessions(source)) {
      this.recorder.tool({ conversationId, turnId: source.turnId, callId }, event);
    }
  }

  private admitPreview(callId: string): boolean {
    const now = this.now();
    const last = this.previewAt.get(callId);
    if (last !== undefined && now - last < PATCH_PREVIEW_INTERVAL_MS) return false;
    this.previewAt.delete(callId);
    this.previewAt.set(callId, now);
    if (this.previewAt.size > MAX_TRACKED_PREVIEWS) {
      const oldest = this.previewAt.keys().next().value;
      if (oldest !== undefined) this.previewAt.delete(oldest);
    }
    return true;
  }
}

function suppliedMovePath(change: FileUpdateChange): string | undefined {
  const supplied = suppliedFileChange(change);
  return supplied?.kind === "update" ? supplied.movePath : change.move_path;
}

/**
 * The spool's directory: beside the bridge's other sidecar state, one per
 * workspace, since several local bridges can share a Codex home.
 */
export function codexChangeEvidenceDir(codexHome: string, cwd: string): string {
  const cwdHash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(codexHome, "orkestrator-bridge", "change-evidence", cwdHash);
}

/** The process's spool and adapter, persisted under the bridge state dir. */
export function createCodexChangeEvidence(options: {
  codexHome: string;
  cwd: string;
  executor?: CaptureExecutor;
}): CodexChangeEvidence {
  return new CodexChangeEvidence({
    spool: new ChangeEvidenceSpool({
      directory: codexChangeEvidenceDir(options.codexHome, options.cwd),
    }),
    executor: options.executor ?? detectCaptureExecutor(),
  });
}
