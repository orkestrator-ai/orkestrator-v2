/**
 * Cursor's change-evidence adapter (see `docs/architecture/change-tracking.md`,
 * "Writing a provider adapter").
 *
 * Decodes the SDK's native tool payloads into canonical evidence frames and
 * spools them for the backend to pull (`GET /change-evidence`). It never counts
 * lines: a native count is passed on with the meaning Cursor gave it, a patch
 * is passed on as a body, and the backend decides what either measures.
 *
 * Identities the backend joins on:
 * - `conversationId` is the bridge session id (`SessionState.id`), the id the
 *   backend addresses in `/session/:id` and stores as its provider session id.
 * - `callId` is the SDK's tool call id, which is also the `toolUseId` of the
 *   transcript tool part that renders the call.
 * - `turnId` is the backend's dispatch request id when the prompt carried one.
 *
 * Only the live stream (and the tail of a run re-adopted after a restart)
 * produces tool frames. History rebuilt from the SDK's stored conversation has
 * no call ids, so nothing here is ever matched to an operation by command
 * text, timestamp or position; and a re-adopted run is never measured from the
 * workspace as it stands now.
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ExecutionOccurrence,
  ProviderChangeCapabilities,
  ToolKind,
  ToolPhase,
} from "@orkestrator/protocol/change-evidence";
import {
  ChangeEvidenceRecorder,
  type EvidenceInput,
} from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import { parseUnifiedPatch } from "@orkestrator/protocol/node/change-tracking/unified-patch";
import type { ProbeObservation } from "@orkestrator/protocol/node/workspace-change-probe";
import { PROVIDER, stateDirectoryPath, workingDirectory } from "./config.js";
import { isObject, nonBlank, type JsonObject } from "./state.js";

export type CaptureExecutor = "host-worker" | "container-worker" | "unknown";

/** The state directory Orkestrator's container launcher hands this bridge. */
export const CONTAINER_STATE_DIRECTORY = "/tmp/orkestrator-cursor-sdk-state";
/** The per-environment root the host launcher puts this bridge's state under. */
export const HOST_STATE_ROOT = "cursor-bridge-state";

/**
 * Where the probe beside this bridge runs, from the launcher's own contract.
 *
 * The bridge is told nothing else about where it runs: the container launcher
 * (`commands-registry-servers.ts`) sets {@link CONTAINER_STATE_DIRECTORY}, the
 * host launcher (`commands-servers.ts`) sets `<dataDir>/cursor-bridge-state/<env>`.
 * Anything else — a hand-started bridge, a stateless one — is `unknown`, and
 * then no observation is reported rather than one labelled with a guess.
 */
export function resolveCaptureExecutor(
  stateDirectory: string | null = stateDirectoryPath(),
): CaptureExecutor {
  if (!stateDirectory) return "unknown";
  if (stateDirectory === CONTAINER_STATE_DIRECTORY) return "container-worker";
  if (basename(dirname(stateDirectory)) === HOST_STATE_ROOT) return "host-worker";
  return "unknown";
}

/**
 * What a Cursor binding can establish, and why:
 * - turns: the bridge itself dispatches (`controlled-dispatch`) and follows the
 *   run to `wait()`'s terminal result (`terminal-observed`);
 * - tools: Cursor has no pre-execution hook, so a call is seen once it is
 *   running (`observed-after-start`) and its completion arrives on the stream;
 * - history: the bridge's persisted transcript keeps native call ids, the
 *   SDK-rebuilt one does not (`partial`);
 * - files: edit reports counts and a diff string, write reports the whole
 *   resulting file, delete reports the path; no cumulative turn patch exists;
 * - background sub-agents are only observable through their parent run, so
 *   their completion after it ends is unknown (`launch-only`).
 */
export function cursorChangeCapabilities(
  executor: CaptureExecutor,
): Omit<ProviderChangeCapabilities, "capabilityRevision"> {
  return {
    resolution: executor === "unknown" ? "partial" : "resolved",
    beforeTurn: "controlled-dispatch",
    afterTurn: "terminal-observed",
    beforeTool: "observed-after-start",
    afterTool: "observed",
    historicalCallIdentity: "partial",
    fileEvidence: { resolution: "confirmed", kinds: ["patch", "reported-counts", "whole-file"] },
    turnDiff: "absent",
    captureExecutor: executor,
    captureAvailability: executor === "unknown" ? "unknown" : "ready",
    backgroundCompletion: "launch-only",
  };
}

interface EvidenceRuntime {
  spool: ChangeEvidenceSpool;
  recorder: ChangeEvidenceRecorder;
  executor: CaptureExecutor;
}

function createRuntime(spool: ChangeEvidenceSpool, executor: CaptureExecutor): EvidenceRuntime {
  const recorder = new ChangeEvidenceRecorder({
    spool,
    provider: PROVIDER,
    capabilities: cursorChangeCapabilities(executor),
    ...(executor === "unknown" ? {} : { executor }),
  });
  return { spool, recorder, executor };
}

/**
 * One spool and recorder per bridge process, created on first use.
 *
 * Persisted beside the bridge's state when it has a state directory, so frames
 * the backend has not acknowledged survive a restart. Memory-only under
 * `bun test`: suites point the state directory at temporary roots they delete.
 */
let runtime: EvidenceRuntime | undefined;

function currentRuntime(): EvidenceRuntime {
  if (!runtime) {
    const directory = process.env.NODE_ENV === "test" ? null : stateDirectoryPath();
    const spool = new ChangeEvidenceSpool(
      directory ? { directory: join(directory, "change-evidence") } : {},
    );
    runtime = createRuntime(spool, resolveCaptureExecutor());
  }
  return runtime;
}

export function changeEvidenceSpool(): ChangeEvidenceSpool {
  return currentRuntime().spool;
}

export function useChangeEvidenceForTests(
  spool: ChangeEvidenceSpool,
  executor: CaptureExecutor = "host-worker",
): () => void {
  const previous = runtime;
  runtime = createRuntime(spool, executor);
  return () => {
    runtime = previous;
  };
}

// ---------------------------------------------------------------------------
// Native payload decoding
// ---------------------------------------------------------------------------

const TOOL_KINDS_BY_NAME: Readonly<Record<string, ToolKind>> = {
  shell: "shell",
  edit: "file-edit",
  write: "file-write",
  delete: "file-delete",
};

export interface DecodedToolSettlement {
  phase: ToolPhase;
  executionOccurrence: ExecutionOccurrence;
  evidence: EvidenceInput[];
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * A worktree-relative path for a file inside the workspace, the path as the
 * SDK gave it otherwise. Never resolved against anything but the workspace.
 */
export function evidencePath(value: unknown): string | undefined {
  if (!nonBlank(value)) return undefined;
  const raw = value.trim();
  const absolute = isAbsolute(raw) ? raw : resolve(workingDirectory, raw);
  const inside = relative(workingDirectory, absolute);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return raw;
  return inside.split(sep).join("/");
}

/**
 * Whether Cursor's `diffString` is a real unified patch.
 *
 * It is not, as shipped: the SDK's own diff builder writes hunks of `+ line` /
 * `- line` rows joined by `...`, with neither file headers nor `@@` ranges, and
 * the edit result passes the server's string through untouched. Only text the
 * shared parser accepts as one complete, headed file patch is labelled
 * `git_unified`; everything else is `opaque`.
 */
export function cursorPatchFormat(text: string): "git_unified" | "opaque" {
  if (!text.startsWith("diff --git ") && !text.startsWith("--- ")) return "opaque";
  const parsed = parseUnifiedPatch(text);
  if (parsed.kind !== "parsed" || !parsed.complete || parsed.issues.length > 0) return "opaque";
  if (parsed.files.length !== 1) return "opaque";
  const file = parsed.files[0]!;
  return file.oldPath !== null || file.newPath !== null ? "git_unified" : "opaque";
}

function editEvidence(path: string | undefined, value: JsonObject): EvidenceInput[] {
  const evidence: EvidenceInput[] = [];
  const additions = readCount(value.linesAdded);
  const deletions = readCount(value.linesRemoved);
  // Counts and the diff string are independent facts: neither is derived from
  // the other here, and either may be present alone.
  if (additions !== null || deletions !== null) {
    evidence.push({
      kind: "reported-counts",
      key: "counts",
      ...(path ? { path } : {}),
      additions,
      deletions,
      scope: "file",
      claim: "provider-reported",
    });
  }
  const diff = readText(value.diffString);
  if (diff) {
    evidence.push({
      kind: "patch",
      key: "patch",
      text: diff,
      ...(path ? { path } : {}),
      format: cursorPatchFormat(diff),
      claim: "provider-reported",
    });
  }
  return evidence;
}

function writeEvidence(
  path: string | undefined,
  args: JsonObject,
  value: JsonObject,
): EvidenceInput[] {
  const evidence: EvidenceInput[] = [];
  const contentLines = readCount(value.linesCreated);
  if (contentLines !== null) {
    // "Lines created" is the size of the new content. Over an existing file it
    // says nothing about what was removed, so it is never additions.
    evidence.push({
      kind: "reported-counts",
      key: "counts",
      ...(path ? { path } : {}),
      additions: null,
      deletions: null,
      contentLines,
      scope: "file",
      claim: "provider-reported",
    });
  }
  if (path) {
    const result =
      typeof value.fileContentAfterWrite === "string" ? value.fileContentAfterWrite : undefined;
    const input = typeof args.fileText === "string" ? args.fileText : undefined;
    const after = result ?? input;
    if (after !== undefined) {
      evidence.push({
        kind: "replacement",
        key: "whole-file",
        path,
        // The prior file was never read: unknown, never an empty file.
        before: undefined,
        after,
        unknownReason: "write-prior-content-not-reported",
        extent: "whole-file",
        origin: result !== undefined ? "result" : "input",
        claim: "provider-reported",
      });
    }
  }
  return evidence;
}

/** Decode a completed native tool call into its terminal phase and evidence. */
export function decodeToolSettlement(
  toolKind: ToolKind,
  toolCall: JsonObject,
  startObserved: boolean,
): DecodedToolSettlement {
  const ran: ExecutionOccurrence = startObserved ? "started" : "unknown";
  const result = isObject(toolCall.result) ? toolCall.result : undefined;
  if (result?.status === "error")
    return { phase: "failed", executionOccurrence: ran, evidence: [] };
  if (result?.status !== "success")
    return { phase: "unknown", executionOccurrence: ran, evidence: [] };
  const value = isObject(result.value) ? result.value : {};
  const args = isObject(toolCall.args) ? toolCall.args : {};
  const path = evidencePath(args.path) ?? evidencePath(value.path);
  switch (toolKind) {
    case "shell": {
      const exitCode = value.exitCode;
      const failed = typeof exitCode === "number" && exitCode !== 0;
      return {
        phase: failed ? "failed" : "succeeded",
        executionOccurrence: "started",
        evidence: [],
      };
    }
    case "file-edit":
      return {
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: editEvidence(path, value),
      };
    case "file-write":
      return {
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: writeEvidence(path, args, value),
      };
    case "file-delete":
      return {
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: path
          ? [
              {
                kind: "path-operation",
                key: "path",
                path,
                operation: "delete",
                claim: "provider-reported",
              },
            ]
          : [],
      };
    default:
      return { phase: "succeeded", executionOccurrence: "started", evidence: [] };
  }
}

// ---------------------------------------------------------------------------
// One turn's evidence
// ---------------------------------------------------------------------------

export interface TurnEvidenceOutcome {
  phase: "succeeded" | "failed" | "cancelled" | "unknown";
  /** The SDK reported a terminal result, so the run itself has stopped. */
  terminal: boolean;
}

export interface TurnEvidence {
  /** Record the turn as dispatched. */
  start(): void;
  /** Feed one interaction update. Synchronous and total over any payload. */
  observe(update: unknown): void;
  /** Report what a probe window around one call established. */
  observation(callId: string, observation: ProbeObservation): void;
  /** Settle the turn and every call it left open. Idempotent. */
  end(outcome: TurnEvidenceOutcome): void;
}

interface OpenCall {
  toolKind: ToolKind;
  parentCallId?: string;
}

/** Calls a turn can hold open at once; more are recorded without settlement. */
const MAX_OPEN_CALLS = 4_096;
const MAX_BACKGROUND_TASKS = 512;

/**
 * Follow one turn's tool lifecycle as canonical frames.
 *
 * `mode: "reconciliation"` is the tail of a run re-adopted after a restart:
 * its tool frames carry the provider's own reports, but it has no turn id of
 * ours and is never given workspace observations.
 */
export function trackTurnEvidence(
  conversationId: string,
  options: { turnId?: string; mode: "live" | "reconciliation" },
): TurnEvidence {
  const { recorder, executor } = currentRuntime();
  const { turnId, mode } = options;
  const open = new Map<string, OpenCall>();
  const backgroundTasks = new Map<string, string>();
  let ended = false;

  const source = (callId: string, parentCallId?: string) => ({
    conversationId,
    callId,
    mode,
    ...(turnId ? { turnId } : {}),
    ...(parentCallId ? { parentCallId } : {}),
  });

  const noteTask = (callId: string, toolCall: JsonObject, parentCallId?: string) => {
    const result = isObject(toolCall.result) ? toolCall.result : undefined;
    if (result?.status !== "success" || !isObject(result.value)) return;
    if (result.value.isBackground !== true) return;
    const taskId = nonBlank(result.value.agentId) ? result.value.agentId : callId;
    if (backgroundTasks.has(taskId) || backgroundTasks.size >= MAX_BACKGROUND_TASKS) return;
    backgroundTasks.set(taskId, callId);
    recorder.backgroundTask(source(callId, parentCallId), {
      taskId,
      parentCallId: callId,
      phase: "running",
      executionOccurrence: "started",
      writerLiveness: "may-write",
    });
  };

  const visit = (update: unknown, parentCallId: string | undefined, depth: number): void => {
    if (depth > 8 || !isObject(update) || !nonBlank(update.type)) return;
    if (update.type === "tool-call-delta") {
      // A sub-agent's calls, addressed by the launch call that owns them.
      visit(update.taskUpdate, nonBlank(update.callId) ? update.callId : parentCallId, depth + 1);
      return;
    }
    // `partial-tool-call` is still streaming its arguments; nothing has run.
    if (update.type !== "tool-call-started" && update.type !== "tool-call-completed") return;
    const callId = nonBlank(update.callId) ? update.callId : undefined;
    const toolCall = isObject(update.toolCall) ? update.toolCall : undefined;
    if (!callId || !toolCall || !nonBlank(toolCall.type)) return;
    if (toolCall.type === "task") {
      if (update.type === "tool-call-completed") noteTask(callId, toolCall, parentCallId);
      return;
    }
    const toolKind = TOOL_KINDS_BY_NAME[toolCall.type];
    if (!toolKind) return;

    if (update.type === "tool-call-started") {
      if (!open.has(callId) && open.size < MAX_OPEN_CALLS) {
        open.set(callId, { toolKind, ...(parentCallId ? { parentCallId } : {}) });
      }
      recorder.tool(source(callId, parentCallId), {
        toolKind,
        phase: "running",
        executionOccurrence: "started",
      });
      return;
    }
    const startObserved = open.delete(callId);
    recorder.tool(source(callId, parentCallId), {
      toolKind,
      ...decodeToolSettlement(toolKind, toolCall, startObserved),
    });
  };

  return {
    start() {
      if (!turnId) return;
      try {
        recorder.turn({ conversationId, turnId, mode }, "running", "may-write");
      } catch {
        // Evidence is never allowed to fail a dispatch.
      }
    },
    observe(update) {
      if (ended) return;
      try {
        visit(update, undefined, 0);
      } catch {
        // Runs on the SDK's own callback: a malformed payload costs evidence,
        // never the turn.
      }
    },
    observation(callId, observation) {
      // A re-adopted run is never measured from the workspace as it is now,
      // and an observation labelled with a guessed executor is worse than none.
      if (mode !== "live" || executor === "unknown") return;
      try {
        recorder.observation(source(callId), {
          boundary: observation.boundary,
          overlap: observation.overlap,
          ...(observation.change ? { change: observation.change } : {}),
          omittedReasons: observation.omittedReasons,
          ...(observation.unavailableReason
            ? { unavailableReason: observation.unavailableReason }
            : {}),
        });
      } catch {
        // See `observe`.
      }
    },
    end(outcome) {
      if (ended) return;
      ended = true;
      try {
        // A call whose completion never arrived. Cancellation is the only
        // outcome that says what became of it; anything else is unknown.
        for (const [callId, call] of open) {
          recorder.tool(source(callId, call.parentCallId), {
            toolKind: call.toolKind,
            phase: outcome.phase === "cancelled" ? "cancelled" : "unknown",
            executionOccurrence: "started",
          });
        }
        open.clear();
        // The parent run was the only channel a background child reported on.
        for (const [taskId, callId] of backgroundTasks) {
          recorder.backgroundTask(source(callId), {
            taskId,
            parentCallId: callId,
            phase: "unknown",
            executionOccurrence: "started",
            writerLiveness: "unknown",
          });
        }
        if (turnId) {
          const quiescent = outcome.terminal && backgroundTasks.size === 0;
          recorder.turn(
            { conversationId, turnId, mode },
            outcome.phase,
            quiescent ? "quiescent" : "unknown",
          );
        }
      } catch {
        // See `observe`.
      }
    },
  };
}
