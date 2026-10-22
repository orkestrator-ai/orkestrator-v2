/**
 * Pi's change-evidence adapter: translates Pi's tool and turn lifecycle into
 * canonical provider evidence frames (`@orkestrator/protocol/change-evidence`)
 * and spools them for the backend to pull (`GET /change-evidence`).
 *
 * It never counts lines. It reports what Pi established — which call ran,
 * what patch Pi's `edit` produced, what content a `write` was given — and the
 * probe windows the command-change hooks measured around a call. The backend
 * decides scope, selection and counts.
 *
 * Identities: `conversationId` is the bridge session id (`state.id`), the one
 * the backend addresses in `/session/:id` routes, and `callId` is Pi's
 * `toolCallId`, the same id the transcript tool part carries as `toolUseId`.
 * Pi's own session-file id (`state.piSessionId`) is not used: a resume or fork
 * attaches the same file under a new bridge session id.
 *
 * Only live hooks record. Replaying history (resume, fork, branch navigation)
 * emits nothing: a fork's inherited calls already belong to the parent
 * conversation, and they must never be recorded again as new edits.
 *
 * Everything here is synchronous and bounded; it runs inside Pi's tool hooks.
 */
import { existsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { ProviderChangeCapabilities, ToolKind } from "@orkestrator/protocol/change-evidence";
import {
  ChangeEvidenceRecorder,
  type EvidenceInput,
  type EvidenceSourceInput,
} from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type { ProbeObservation } from "@orkestrator/protocol/node/workspace-change-probe";
import { changeEvidenceDirectory, workingDirectory } from "./config.js";
import type { SessionState } from "./state.js";

/**
 * What this bridge can establish, and why:
 *
 * - `beforeTool: awaited` — Pi awaits every `tool_call` handler before running
 *   the tool; the measuring hook is registered after the approval gate, so the
 *   "before" is taken after any human decision and before execution.
 * - `afterTool: awaited` — Pi awaits `tool_result` handlers after execution
 *   (including a thrown execution) and before `tool_execution_end`.
 * - `beforeTurn: controlled-dispatch` — the backend dispatches every prompt
 *   through this bridge's prompt route and captures the turn start before it.
 * - `afterTurn: terminal-observed` — the bridge observes Pi's run settling, but
 *   a detached process a shell command left behind is not tracked.
 * - `historicalCallIdentity: partial` — Pi's session file keeps every tool
 *   call id, but the ids come from the model provider and some providers
 *   number them per response, so one id can repeat within a conversation.
 * - `fileEvidence` — `edit` reports a unified patch (`details.patch`, else the
 *   display diff); `write` carries the whole file in its input.
 * - `turnDiff: absent` — Pi reports no cumulative turn patch.
 * - `captureExecutor: unknown` — the bridge is launched the same way on a host
 *   and in a container and receives no explicit signal saying which.
 * - `backgroundCompletion: unknown` — Pi's built-in tools have no background
 *   mode, but a shell command can still leave detached writers.
 */
export const PI_CHANGE_CAPABILITIES: Omit<ProviderChangeCapabilities, "capabilityRevision"> = {
  resolution: "partial",
  beforeTurn: "controlled-dispatch",
  afterTurn: "terminal-observed",
  beforeTool: "awaited",
  afterTool: "awaited",
  historicalCallIdentity: "partial",
  fileEvidence: { resolution: "confirmed", kinds: ["patch", "whole-file"] },
  turnDiff: "absent",
  captureExecutor: "unknown",
  captureAvailability: "ready",
  backgroundCompletion: "unknown",
};

export interface ChangeEvidenceRuntime {
  spool: ChangeEvidenceSpool;
  recorder: ChangeEvidenceRecorder;
}

let runtime: ChangeEvidenceRuntime | undefined;

/**
 * The label an observation report must carry. Reports require one, so this is
 * a best-effort label (Docker creates `/.dockerenv` in every container); the
 * declared capability stays `unknown` because it is not a contract.
 */
function reportExecutor(): "host-worker" | "container-worker" {
  try {
    return existsSync("/.dockerenv") ? "container-worker" : "host-worker";
  } catch {
    return "host-worker";
  }
}

function createRuntime(options: { directory?: string } = {}): ChangeEvidenceRuntime {
  const spool = new ChangeEvidenceSpool(options.directory ? { directory: options.directory } : {});
  const recorder = new ChangeEvidenceRecorder({
    spool,
    provider: "pi",
    capabilities: PI_CHANGE_CAPABILITIES,
    executor: reportExecutor(),
  });
  return { spool, recorder };
}

/** One spool and one recorder per bridge process, created on first use. */
export function changeEvidence(): ChangeEvidenceRuntime {
  runtime ??= createRuntime({ directory: changeEvidenceDirectory() });
  return runtime;
}

/** Replace (or, with no argument, forget) the process runtime. Tests only. */
export function setChangeEvidenceForTests(options: { directory?: string }): ChangeEvidenceRuntime;
export function setChangeEvidenceForTests(options: undefined): undefined;
export function setChangeEvidenceForTests(options?: {
  directory?: string;
}): ChangeEvidenceRuntime | undefined {
  runtime = options ? createRuntime(options) : undefined;
  openCalls.clear();
  return runtime;
}

// ---------------------------------------------------------------------------
// Tool kinds and identities
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/**
 * Pi's built-in tools by kind. A custom or MCP tool is `other`: this bridge
 * cannot know whether it writes, so its lifecycle is still reported.
 */
export function piToolKind(toolName: string | undefined): ToolKind {
  switch (toolName) {
    case "bash":
    case "powershell":
      return "shell";
    case "edit":
      return "file-edit";
    case "write":
      return "file-write";
    default:
      return toolName && READ_ONLY_TOOLS.has(toolName) ? "read" : "other";
  }
}

interface OpenToolCall {
  source: EvidenceSourceInput & { callId: string };
  toolKind: ToolKind;
}

/** Calls reported running whose terminal frame is still owed. */
const MAX_OPEN_CALLS = 1_024;
const openCalls = new Map<string, OpenToolCall>();
/** The turn each session is running, so tool frames name it. */
const currentTurns = new WeakMap<SessionState, string>();

function callKey(state: SessionState, toolCallId: string): string {
  return `${state.id}\0${toolCallId}`;
}

function toolSource(
  state: SessionState,
  toolCallId: string,
  parentToolCallId: unknown,
): EvidenceSourceInput & { callId: string } {
  const turnId = currentTurns.get(state);
  return {
    conversationId: state.id,
    callId: toolCallId,
    attemptId:
      state.toolCallRows?.get(toolCallId) ??
      state.currentAssistantMessageId ??
      turnId ??
      "unscoped",
    ...(turnId ? { turnId } : {}),
    ...(typeof parentToolCallId === "string" && parentToolCallId && parentToolCallId !== toolCallId
      ? { parentCallId: parentToolCallId }
      : {}),
    mode: "live",
  };
}

function record(fn: () => void): void {
  // Evidence is never allowed to break the hook that reports it.
  try {
    fn();
  } catch {
    // A lost frame is a coverage gap, not a failed tool call.
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

/** The workspace-relative path when the input names one inside it. */
function evidencePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (!isAbsolute(path)) return path;
  const inside = relative(workingDirectory, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

/** `write`'s input: the whole new file, its prior content never captured. */
function writeReplacement(
  input: unknown,
  claim: "proposal" | "provider-reported",
): EvidenceInput[] {
  const path = evidencePath(stringField(input, "path"));
  const content = stringField(input, "content");
  if (!path || content === undefined) return [];
  return [
    {
      kind: "replacement",
      key: claim === "proposal" ? "write-proposal" : "write-applied",
      path,
      before: undefined,
      after: content,
      unknownReason: "prior-content-not-captured",
      extent: "whole-file",
      origin: "input",
      claim,
    },
  ];
}

/**
 * `edit`'s applied result. `details.patch` is a unified patch (`--- path` /
 * `+++ path` / hunks) over the LF-normalized file; `details.diff` is Pi's
 * line-numbered display format, kept as opaque when it is all there is.
 */
function editPatch(input: unknown, details: unknown): EvidenceInput[] {
  const path = evidencePath(stringField(input, "path"));
  const patch = stringField(details, "patch");
  const diff = stringField(details, "diff");
  const text = patch || diff;
  if (!text) return [];
  return [
    {
      kind: "patch",
      key: "edit-result",
      text,
      ...(path ? { path } : {}),
      format: patch ? "git_unified" : "opaque",
      claim: "provider-reported",
    },
  ];
}

// ---------------------------------------------------------------------------
// Tool lifecycle
// ---------------------------------------------------------------------------

export interface PiToolCallEvent {
  toolCallId?: unknown;
  toolName?: unknown;
  input?: unknown;
  parentToolCallId?: unknown;
}

export interface PiToolResultEvent extends PiToolCallEvent {
  details?: unknown;
  isError?: unknown;
}

/**
 * A call passed every gate registered before the measuring hook and is about
 * to run: report it running, with a `write`'s content as a proposal.
 */
export function recordToolCallStarted(state: SessionState, event: PiToolCallEvent): void {
  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
  const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
  const toolKind = piToolKind(toolName);
  if (!toolCallId || toolKind === "read") return;
  record(() => {
    const source = toolSource(state, toolCallId, event.parentToolCallId);
    changeEvidence().recorder.tool(source, {
      toolKind,
      phase: "running",
      executionOccurrence: "started",
      evidence: toolKind === "file-write" ? writeReplacement(event.input, "proposal") : [],
    });
    const key = callKey(state, toolCallId);
    openCalls.delete(key);
    openCalls.set(key, { source, toolKind });
    if (openCalls.size > MAX_OPEN_CALLS) {
      const oldest = openCalls.keys().next();
      if (!oldest.done) openCalls.delete(oldest.value);
    }
  });
}

/** Report a probe window the command-change hook closed for this call. */
export function recordToolObservation(
  state: SessionState,
  toolCallId: string,
  windowId: string,
  observation: ProbeObservation,
): void {
  if (!toolCallId) return;
  record(() => {
    const source =
      openCalls.get(callKey(state, toolCallId))?.source ?? toolSource(state, toolCallId, undefined);
    changeEvidence().recorder.observation(source, {
      windowId,
      boundary: observation.boundary,
      overlap: observation.overlap,
      ...(observation.change ? { change: observation.change } : {}),
      omittedReasons: observation.omittedReasons,
      ...(observation.unavailableReason
        ? { unavailableReason: observation.unavailableReason }
        : {}),
    });
  });
}

/**
 * The call ran (Pi's `tool_result` hook runs only after execution, a thrown
 * one included): report its outcome and what Pi reported it changed.
 */
export function recordToolResult(state: SessionState, event: PiToolResultEvent): void {
  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
  if (!toolCallId) return;
  const key = callKey(state, toolCallId);
  const open = openCalls.get(key);
  const toolKind =
    open?.toolKind ?? piToolKind(typeof event.toolName === "string" ? event.toolName : undefined);
  if (toolKind === "read") return;
  openCalls.delete(key);
  const failed = event.isError === true;
  const evidence = failed
    ? []
    : toolKind === "file-edit"
      ? editPatch(event.input, event.details)
      : toolKind === "file-write"
        ? writeReplacement(event.input, "provider-reported")
        : [];
  record(() => {
    changeEvidence().recorder.tool(
      open?.source ?? toolSource(state, toolCallId, event.parentToolCallId),
      {
        toolKind,
        phase: failed ? "failed" : "succeeded",
        executionOccurrence: "started",
        evidence,
      },
    );
  });
}

function isAbortResult(result: unknown): boolean {
  const content =
    result && typeof result === "object" ? (result as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return false;
  return content.some((block) => stringField(block, "text") === "Operation aborted");
}

/**
 * A call reported running that never reached `tool_result`: a `tool_call`
 * handler registered after the measuring hook blocked it, or the run aborted
 * before it executed. A no-op for every call that ran.
 */
export function recordToolNotRun(state: SessionState, toolCallId: string, result: unknown): void {
  if (!toolCallId) return;
  const key = callKey(state, toolCallId);
  const open = openCalls.get(key);
  if (!open) return;
  openCalls.delete(key);
  record(() => {
    changeEvidence().recorder.tool(open.source, {
      toolKind: open.toolKind,
      phase: isAbortResult(result) ? "cancelled" : "denied",
      executionOccurrence: "did-not-run",
    });
  });
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

/** Name the turn about to be handed to Pi, so its tool frames carry it. */
export function beginEvidenceTurn(state: SessionState, turnId: string): void {
  currentTurns.set(state, turnId);
}

/** Pi accepted the prompt: the turn is running and may write. */
export function recordTurnRunning(state: SessionState, turnId: string): void {
  record(() => {
    changeEvidence().recorder.turn({ conversationId: state.id, turnId }, "running", "may-write");
  });
}

/** The run settled. Writers a shell command detached are not observed. */
export function recordTurnEnded(
  state: SessionState,
  turnId: string,
  phase: "succeeded" | "failed" | "cancelled",
): void {
  if (currentTurns.get(state) === turnId) currentTurns.delete(state);
  record(() => {
    changeEvidence().recorder.turn({ conversationId: state.id, turnId }, phase, "unknown");
  });
}

/** Pi refused the prompt; nothing ran, so nothing is reported. */
export function forgetEvidenceTurn(state: SessionState, turnId: string): void {
  if (currentTurns.get(state) === turnId) currentTurns.delete(state);
}
