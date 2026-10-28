/**
 * The Claude adapter for backend-owned change tracking.
 *
 * Translates what this bridge sees of a Claude call — the `tool_use` block,
 * the permission decision, the PreToolUse/PostToolUse hooks and the
 * `tool_result` — into canonical evidence frames on one per-process spool
 * that the backend pulls (`GET /change-evidence`). It never counts lines:
 * an Edit's input is recorded as a proposal, and the probe window around a
 * Bash call is reported as an observation for the backend to judge. See
 * `docs/architecture/change-tracking.md` ("Writing a provider adapter").
 *
 * Identity: `conversationId` is the bridge session id the backend addresses
 * in `/session/:id` (its provider session id), `callId` is the `tool_use` id,
 * and `turnId` is the prompt's dispatch request id (or the bridge-minted
 * prompt uuid for a turn dispatched without one).
 *
 * Only live calls produce frames. A transcript rebuilt from disk emits
 * nothing: replayed rows carry no lifecycle this process observed, and a
 * historical call is never re-measured against today's worktree.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  TERMINAL_TOOL_PHASES,
  type ExecutionOccurrence,
  type ProviderChangeCapabilities,
  type ToolKind,
  type ToolPhase,
  type WriterLiveness,
} from "@orkestrator/protocol/change-evidence";
import {
  ChangeEvidenceRecorder,
  type EvidenceInput,
} from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type { ProbeObservation } from "@orkestrator/protocol/node/workspace-change-probe";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { claudeChangeEvidenceDir } from "./claude-home.js";
import {
  currentProcessIdentity,
  parseIdentityFields,
  type RecordedOwner,
  recordedOwnerState,
} from "./process-identity.js";

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
export function claudeChangeCapabilities(
  executor: CaptureExecutor,
): Omit<ProviderChangeCapabilities, "capabilityRevision"> {
  return {
    resolution: "resolved",
    // The backend captures the turn start before it dispatches the prompt.
    beforeTurn: "controlled-dispatch",
    // The bridge sees the turn's result; it cannot prove every writer stopped.
    afterTurn: "terminal-observed",
    // PreToolUse holds a foreground Bash call until its "before" snapshot.
    beforeTool: "awaited",
    // PostToolUse/PostToolUseFailure take the "after" snapshot before the
    // next call is released.
    afterTool: "awaited",
    // `tool_use` ids are persisted in the rollout and survive a reload.
    historicalCallIdentity: "stable",
    // Edit/MultiEdit/Write/NotebookEdit inputs are replacements; Claude
    // reports no patch, no per-call counts and no turn diff.
    fileEvidence: { resolution: "confirmed", kinds: ["replacement"] },
    turnDiff: "absent",
    captureExecutor: executor,
    captureAvailability: "ready",
    // A background Bash call measures only its launch.
    backgroundCompletion: "launch-only",
  };
}

// ---------------------------------------------------------------------------
// Native → canonical decoding
// ---------------------------------------------------------------------------

export function claudeToolKind(toolName: string | undefined): ToolKind {
  switch (toolName) {
    case "Bash":
      return "shell";
    case "Edit":
    case "MultiEdit":
      return "file-edit";
    case "Write":
      return "file-write";
    case "NotebookEdit":
      return "notebook-edit";
    case "Read":
    case "Grep":
    case "Glob":
      return "read";
    default:
      return "other";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function path(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The proposal a Claude file tool's input states. Sides are what the input
 * says and nothing more: a Write never names the file's prior contents, so
 * its before side is unknown rather than empty.
 */
export function claudeProposalEvidence(toolName: string, input: unknown): EvidenceInput[] {
  const fields = record(input);
  switch (toolName) {
    case "Edit": {
      const filePath = path(fields.file_path);
      if (!filePath) return [];
      return [
        {
          kind: "replacement",
          key: "edit:0",
          path: filePath,
          before: text(fields.old_string),
          after: text(fields.new_string),
          unknownReason: "not-in-input",
          extent: "fragment",
          origin: "input",
          claim: "proposal",
        },
      ];
    }
    case "MultiEdit": {
      const filePath = path(fields.file_path);
      if (!filePath || !Array.isArray(fields.edits)) return [];
      return fields.edits.map((edit, index): EvidenceInput => {
        const entry = record(edit);
        return {
          kind: "replacement",
          key: `edit:${index}`,
          path: filePath,
          before: text(entry.old_string),
          after: text(entry.new_string),
          unknownReason: "not-in-input",
          extent: "fragment",
          origin: "input",
          claim: "proposal",
        };
      });
    }
    case "Write": {
      const filePath = path(fields.file_path);
      if (!filePath) return [];
      return [
        {
          kind: "replacement",
          key: "write",
          path: filePath,
          before: undefined,
          after: text(fields.content),
          unknownReason: "before-not-captured",
          extent: "whole-file",
          origin: "input",
          claim: "proposal",
        },
      ];
    }
    case "NotebookEdit": {
      const filePath = path(fields.notebook_path);
      if (!filePath) return [];
      // A delete-mode edit establishes the cell's absence; otherwise the new
      // source is the cell's after side. The old cell source is never input.
      const deleting = fields.edit_mode === "delete";
      return [
        {
          kind: "replacement",
          key: "cell",
          path: filePath,
          before: undefined,
          after: deleting ? null : text(fields.new_source),
          unknownReason: "before-not-captured",
          extent: "notebook-cell",
          origin: "input",
          claim: "proposal",
        },
      ];
    }
    default:
      return [];
  }
}

/** `tool_result` blocks of an SDK user message, with whether each is an error. */
export function claudeToolResultOutcomes(message: unknown): { callId: string; isError: boolean }[] {
  const content = record(record(message).message).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const entry = record(block);
    return entry.type === "tool_result" &&
      typeof entry.tool_use_id === "string" &&
      entry.tool_use_id
      ? [{ callId: entry.tool_use_id, isError: entry.is_error === true }]
      : [];
  });
}

/** `tool_use` blocks of an SDK assistant message. */
export function claudeToolUses(
  message: unknown,
): { callId: string; toolName: string; input: unknown }[] {
  const content = record(record(message).message).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const entry = record(block);
    return entry.type === "tool_use" &&
      typeof entry.id === "string" &&
      entry.id &&
      typeof entry.name === "string"
      ? [{ callId: entry.id, toolName: entry.name, input: entry.input }]
      : [];
  });
}

/**
 * The legacy `commandChanges` value for an observation, exactly as the
 * probe's `end()` derives it: approximate when another window overlapped,
 * the "before" was taken late, or a file could not be measured.
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
// Process state
// ---------------------------------------------------------------------------

interface CallRecord {
  conversationId: string;
  turnId?: string;
  parentCallId?: string;
  toolKind: ToolKind;
  evidence: EvidenceInput[];
  phase: ToolPhase;
}

interface ExecutedCall {
  backgroundTaskId?: string;
}

const MAX_TRACKED_CALLS = 4_096;

export interface ClaudeChangeEvidence {
  readonly spool: ChangeEvidenceSpool;
  readonly recorder: ChangeEvidenceRecorder;
  readonly executor: CaptureExecutor;
  /** Calls this process saw start, by `tool_use` id. */
  readonly calls: Map<string, CallRecord>;
  /** Calls a PostToolUse/PostToolUseFailure hook proved ran. */
  readonly executed: Map<string, ExecutedCall>;
  /** The turn currently owning each conversation, for calls seen only by hooks. */
  readonly activeTurns: Map<string, string>;
}

export interface ClaudeChangeEvidenceOptions {
  /** Persist unacknowledged entries here; memory-only when absent. */
  directory?: string;
  executor?: CaptureExecutor;
}

function createChangeEvidence(options: ClaudeChangeEvidenceOptions): ClaudeChangeEvidence {
  const executor = options.executor ?? detectCaptureExecutor();
  const spool = new ChangeEvidenceSpool(options.directory ? { directory: options.directory } : {});
  const recorder = new ChangeEvidenceRecorder({
    spool,
    provider: "claude",
    capabilities: claudeChangeCapabilities(executor),
    executor,
  });
  return {
    spool,
    recorder,
    executor,
    calls: new Map(),
    executed: new Map(),
    activeTurns: new Map(),
  };
}

/**
 * The spool directory this bridge instance owns, or undefined when another
 * live bridge already holds it. Host bridges are one per environment and all
 * share `~/.claude`, so each keys its spool by its worktree and claims it with
 * a pid file: two processes compacting one entries file would drop each
 * other's unacknowledged evidence.
 */
export function claimSpoolDirectory(
  root = claudeChangeEvidenceDir(),
  scope = process.env.CWD || process.cwd(),
): string | undefined {
  const directory = join(root, createHash("sha256").update(scope).digest("hex").slice(0, 32));
  const owner = join(directory, "owner.pid");
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(owner, "wx", 0o600);
        writeSync(fd, ownerFileContents());
        closeSync(fd);
        return directory;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
        const holder = parseOwnerFile(readFileSync(owner, "utf8"));
        if (holder) {
          // Runs once per process, so it may ask `ps` where `/proc` is missing.
          const state = recordedOwnerState(holder, { slowPath: true });
          if (state === "current") return directory;
          if (state !== "dead") return undefined;
        }
        rmSync(owner, { force: true });
      }
    }
  } catch {
    // An unusable directory leaves the spool memory-only.
  }
  return undefined;
}

/**
 * The pid on the first line, which is all an older bridge reads (it parses
 * the leading integer), and this process's identity as JSON on the second.
 */
function ownerFileContents(): string {
  const { pid, ...identity } = currentProcessIdentity();
  return `${pid}\n${JSON.stringify(identity)}\n`;
}

function parseOwnerFile(raw: string): RecordedOwner | undefined {
  const [first = "", second] = raw.split("\n");
  const pid = Number.parseInt(first, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (!second) return { pid };
  try {
    const parsed = JSON.parse(second) as Record<string, unknown> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.instance !== "string" ||
      parsed.instance.length === 0 ||
      parsed.instance.length > 64
    ) {
      return { pid };
    }
    return { pid, instance: parsed.instance, ...parseIdentityFields(parsed) };
  } catch {
    return { pid };
  }
}

let current: ClaudeChangeEvidence | undefined;

/**
 * This process's spool and recorder, created on first use. Persisted under
 * the bridge's `~/.claude/orkestrator` directory, except under `bun test`,
 * where nothing may touch the developer's home.
 */
export function claudeChangeEvidence(): ClaudeChangeEvidence {
  current ??= createChangeEvidence({
    directory: process.env.NODE_ENV === "test" ? undefined : claimSpoolDirectory(),
  });
  return current;
}

/** Replace the process state with a fresh memory-only spool. */
export function resetClaudeChangeEvidenceForTesting(
  options: ClaudeChangeEvidenceOptions = {},
): ClaudeChangeEvidence {
  current = createChangeEvidence(options);
  return current;
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_CALLS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function emit(
  state: ClaudeChangeEvidence,
  callId: string,
  call: CallRecord,
  phase: ToolPhase,
  executionOccurrence: ExecutionOccurrence,
): void {
  call.phase = phase;
  const backgroundTaskId = state.executed.get(callId)?.backgroundTaskId;
  state.recorder.tool(
    {
      conversationId: call.conversationId,
      callId,
      ...(call.turnId ? { turnId: call.turnId } : {}),
      ...(call.parentCallId ? { parentCallId: call.parentCallId } : {}),
    },
    {
      toolKind: call.toolKind,
      phase,
      executionOccurrence,
      evidence: call.evidence,
      ...(backgroundTaskId && phase !== "running" ? { backgroundTaskId } : {}),
    },
  );
}

function ensureCall(
  state: ClaudeChangeEvidence,
  conversationId: string,
  callId: string,
  native: { toolName?: string; input?: unknown; turnId?: string; parentCallId?: string },
): CallRecord {
  const existing = state.calls.get(callId);
  if (existing) {
    // A decision can reach the bridge before the `tool_use` block that names
    // the call; the block fills in what the decision lacked.
    if (existing.evidence.length === 0 && native.toolName && native.input !== undefined) {
      existing.evidence = claudeProposalEvidence(native.toolName, native.input);
    }
    if (existing.toolKind === "other" && native.toolName) {
      existing.toolKind = claudeToolKind(native.toolName);
    }
    existing.turnId ??= native.turnId;
    existing.parentCallId ??= native.parentCallId;
    return existing;
  }
  const turnId = native.turnId ?? state.activeTurns.get(conversationId);
  const call: CallRecord = {
    conversationId,
    toolKind: claudeToolKind(native.toolName),
    evidence:
      native.toolName && native.input !== undefined
        ? claudeProposalEvidence(native.toolName, native.input)
        : [],
    phase: "unknown",
    ...(turnId ? { turnId } : {}),
    ...(native.parentCallId ? { parentCallId: native.parentCallId } : {}),
  };
  remember(state.calls, callId, call);
  return call;
}

// ---------------------------------------------------------------------------
// Lifecycle entry points (all synchronous; none awaits the backend)
// ---------------------------------------------------------------------------

/** A turn started or ended. Background work still running means it may write. */
export function recordClaudeTurn(
  conversationId: string,
  turnId: string,
  phase: "running" | "succeeded" | "failed" | "cancelled" | "unknown",
  writerLiveness: WriterLiveness = "unknown",
): void {
  const state = claudeChangeEvidence();
  if (phase === "running") remember(state.activeTurns, conversationId, turnId);
  state.recorder.turn({ conversationId, turnId }, phase, writerLiveness);
}

/** A `tool_use` block in an assistant message (root or subagent). */
export function recordClaudeToolUse(
  conversationId: string,
  use: { callId: string; toolName: string; input: unknown; turnId?: string; parentCallId?: string },
): void {
  const state = claudeChangeEvidence();
  const call = ensureCall(state, conversationId, use.callId, use);
  // Known later than its outcome: restate the outcome with the proposal.
  if (call.phase === "denied") emit(state, use.callId, call, "denied", "did-not-run");
  else if (call.phase === "unknown") emit(state, use.callId, call, "running", "unknown");
}

/** `canUseTool` parked the call on an approval card. */
export function recordClaudeToolAwaitingApproval(
  conversationId: string,
  callId: string | undefined,
  toolName: string,
  input: unknown,
): void {
  if (!callId) return;
  const state = claudeChangeEvidence();
  const call = ensureCall(state, conversationId, callId, { toolName, input });
  if (TERMINAL_TOOL_PHASES.has(call.phase)) return;
  emit(state, callId, call, "awaiting-approval", "not-started");
}

/** A permission decision returned to the CLI. Only a denial is a lifecycle fact. */
export function recordClaudePermissionDecision(
  conversationId: string,
  callId: string | undefined,
  toolName: string,
  input: unknown,
  behavior: "allow" | "deny",
): void {
  if (!callId) return;
  const state = claudeChangeEvidence();
  if (behavior === "deny") {
    recordClaudeToolDenied(conversationId, callId, { toolName, input });
    return;
  }
  const call = state.calls.get(callId);
  if (call?.phase === "awaiting-approval") emit(state, callId, call, "running", "unknown");
}

/**
 * The call was refused before it ran: a `permission_denied` frame, a
 * `canUseTool` denial or a PreToolUse hook denial. Keeps the proposal; it is
 * never an applied effect.
 */
export function recordClaudeToolDenied(
  conversationId: string,
  callId: string,
  native: { toolName?: string; input?: unknown } = {},
): void {
  const state = claudeChangeEvidence();
  const call = ensureCall(state, conversationId, callId, native);
  if (TERMINAL_TOOL_PHASES.has(call.phase) && call.phase !== "denied") return;
  emit(state, callId, call, "denied", "did-not-run");
}

/** A PostToolUse/PostToolUseFailure hook fired: the call ran. */
export function recordClaudeToolExecuted(callId: string, backgroundTaskId?: string): void {
  remember(claudeChangeEvidence().executed, callId, backgroundTaskId ? { backgroundTaskId } : {});
}

/**
 * A `tool_result`. A call this process never saw start is left alone: its
 * tool kind and proposal are unknown here, and guessing either would
 * overwrite what the backend already holds.
 */
export function recordClaudeToolResult(callId: string, isError: boolean): void {
  const state = claudeChangeEvidence();
  const call = state.calls.get(callId);
  if (!call || call.phase === "denied") return;
  const ran = state.executed.has(callId);
  // A successful result proves the call ran. An error result alone does not:
  // input validation and refusals answer with one too, so only a post-tool
  // hook proves a failed call started.
  emit(
    state,
    callId,
    call,
    isError ? "failed" : "succeeded",
    !isError || ran ? "started" : "unknown",
  );
}

/** The probe window around a measured (foreground Bash) call. */
export function recordClaudeObservation(
  conversationId: string,
  callId: string,
  observation: ProbeObservation,
): void {
  const state = claudeChangeEvidence();
  const call = state.calls.get(callId);
  const turnId = call?.turnId ?? state.activeTurns.get(conversationId);
  state.recorder.observation(
    {
      conversationId: call?.conversationId ?? conversationId,
      callId,
      ...(turnId ? { turnId } : {}),
    },
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

/** The evidence turn id of a prompt: its dispatch request id, else the prompt uuid. */
export function claudeEvidenceTurnId(turn: {
  readonly dispatchRequestId: string | undefined;
  readonly promptUuid: string;
}): string {
  return turn.dispatchRequestId || turn.promptUuid;
}
