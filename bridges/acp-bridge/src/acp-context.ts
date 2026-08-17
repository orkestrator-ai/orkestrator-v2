import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import type {
  NativeAgentComposerState,
  NativeAgentRuntimeSummary,
} from "@orkestrator/protocol/native-agent";
import type { AcpTurnUsage } from "./usage.js";
import type { AcpNormalizedSessionConfig } from "./session-config.js";


export type Provider = "cursor" | "grok";
export type JsonObject = Record<string, unknown>;
export type SessionStatus = "idle" | "running" | "error";

/** Display status of a Cursor ACP todo. Matches `cursor/update_todos`. */
export const CURSOR_TODO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type CursorTodoStatus = (typeof CURSOR_TODO_STATUSES)[number];

export interface CursorTodoItem {
  id: string;
  content: string;
  status: CursorTodoStatus;
}

export interface BridgeMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: BridgeMessagePart[];
  createdAt: string;
  /** Model selected when this assistant response began. */
  modelId?: string;
}

export interface BridgeTextPart {
  type: "text" | "thinking";
  content: string;
  sourcePartId: string;
  sourceMessageId: string;
  createdAt?: string;
  /** Launch tool this nested text belongs to, when hydrated from a child transcript. */
  parentTaskUseId?: string;
}

/**
 * A prompt attachment as the transcript records it. The bytes are sent to the
 * agent but never kept here: the renderer resolves `fileUrl` for its own
 * preview, and inlining a data URL could spend half the 16 MiB transcript
 * budget on one screenshot.
 */
export interface BridgeFilePart {
  type: "file";
  content: string;
  fileUrl?: string;
  sourcePartId: string;
  sourceMessageId: string;
  createdAt?: string;
}

export interface BridgeToolDiff {
  filePath?: string;
  additions?: number;
  deletions?: number;
  before?: string;
  after?: string;
  diff?: string;
}

export interface BridgeToolPart {
  type: "tool-invocation";
  content: string;
  sourcePartId: string;
  sourceMessageId: string;
  toolUseId: string;
  createdAt?: string;
  toolName?: string;
  toolArgs?: JsonObject;
  toolState?: "success" | "failure" | "pending";
  /**
   * Lifecycle of a sub-agent launched by this tool.
   *
   * Cursor and Grok can complete the launch tool as soon as the child starts.
   * Keep that lifecycle separate from `toolState`, just as the shared renderer
   * does for Codex collaboration items.
   */
  agentState?: "active" | "finished" | "failed";
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: BridgeToolDiff;
  /** Launch tool this nested call belongs to, when the provider names a parent. */
  parentTaskUseId?: string;
}

export interface AcpToolSourceState {
  title?: string;
  explicitName?: string;
  inputName?: string;
  metadataName?: string;
  metadataKind?: string;
  kind?: string;
  toolArgs?: JsonObject;
  toolState?: BridgeToolPart["toolState"];
  agentState?: BridgeToolPart["agentState"];
  contentOutput?: string;
  rawOutput?: string;
  contentDiffs: BridgeToolDiff[];
  locationPath?: string;
  /**
   * Cursor's `cursor/task` extension names the sub-agent. Keep it off the live
   * `rawInput` patch so a later generic Task update cannot wipe the prompt.
   */
  cursorTask?: {
    description?: string;
    prompt?: string;
    subagentType?: string;
    durationMs?: number;
    model?: string;
    agentId?: string;
  };
  /**
   * Serialized size of the rendered part the last time it was charged against
   * `uncheckedTranscriptBytes`. Tool parts are patched in place, so charging the
   * whole part on every update would re-bill a 1MiB diff per streaming frame and
   * force a full transcript re-serialization each time. Only the delta is new.
   */
  chargedBytes?: number;
}

export interface AcpReplayToolMetadata {
  id: string;
  title?: string;
  toolName?: string;
  toolArgs?: JsonObject;
  contentOutputHash?: string;
  rawOutputHash?: string;
  retainedBytes: number;
}

export interface AcpToolReplayCollector {
  capacity: number;
  maximumBytes: number;
  retainedBytes: number;
  byId: Map<string, AcpReplayToolMetadata>;
}

export type BridgeMessagePart = BridgeTextPart | BridgeFilePart | BridgeToolPart;

export interface PromptJournalEntry {
  requestId: string;
  state: "prepared" | "accepted" | "completed" | "failed" | "ambiguous";
  acceptedAt: number;
}

export interface ActiveSubagentDescriptor {
  /** Bounded launch metadata used to correlate Grok's child-id notification. */
  description?: string;
  subagentType?: string;
  /** Distinguishes a completed background launch from an abandoned pending one. */
  toolState?: BridgeToolPart["toolState"];
  /**
   * Cursor Task `agentId`. Used only by the Cursor background-continuation
   * waiter to find the child's transcript; Grok correlates through
   * `subagent_id` instead.
   */
  agentId?: string;
  /**
   * True when `agentId` was inferred from a transcript directory rather than
   * reported by `cursor/task`. Good enough to project the child's activity into
   * its card, deliberately *not* good enough to hold a parent turn open: a
   * mis-inferred id would block `session/prompt` for the whole wait budget.
   */
  agentIdDiscovered?: boolean;
}

export interface SessionState {
  id: string;
  clientSessionKey?: string;
  acpSessionId: string;
  status: SessionStatus;
  error?: string;
  messages: BridgeMessage[];
  /** Active background children, maintained incrementally for the hot activity route. */
  activeSubagentToolIds: Set<string>;
  /**
   * Authoritative, bounded correlation metadata for active children. This is
   * intentionally independent of rendered parts: transcript retention is a
   * display concern and must not decide whether background work still exists.
   */
  activeSubagentDescriptors: Map<string, ActiveSubagentDescriptor>;
  /** Fatal latch: once the bound trips, later provider frames cannot reopen work. */
  subagentLimitExceeded: boolean;
  /** Grok's terminal sub-agent notifications identify the child, not its tool call. */
  subagentToolIds: Map<string, string>;
  /**
   * Session todo/plan list (Cursor `updateTodos`, Grok `todo_write`, ACP `plan`).
   * Each matching tool part already carries the list as of that call; this is the
   * merge source for the next one. Restore rebuilds it from the newest stamped
   * part rather than persisting a second copy.
   */
  cursorTodos: CursorTodoItem[];
  /** Provider message IDs seen during the current process, bounded with the transcript. */
  historyMessageIds: Map<string, string>;
  child: AcpProcess | null;
  revision: number;
  structured: Map<string, unknown>;
  promptJournal: Map<string, PromptJournalEntry>;
  approvals: Map<string, ApprovalState>;
  outputTruncated: boolean;
  uncheckedTranscriptBytes: number;
  currentTurnOutput: string | null;
  /**
   * Monotonic count of turns dispatched to the agent in this process. Cursor's
   * tool replay is detached from the turn lifecycle, so it needs a way to tell
   * that the session has moved on since it captured its targets. Deliberately
   * in-memory: a restart kills every outstanding replay, so a persisted value
   * would only invite comparing sequences across two different processes.
   */
  promptSequence: number;
  /** Coalesces best-effort Cursor metadata replays within one live session. */
  cursorToolReplayTimer?: ReturnType<typeof setTimeout>;
  cursorToolReplayRunning?: boolean;
  /**
   * The pass this session still owes. `live` runs mid-turn and may only touch
   * settled calls; `final` runs once the turn is over and supersedes a pending
   * `live` request, because it can enrich calls the live pass had to skip.
   */
  cursorToolReplayPending?: "live" | "final";
  /** `promptSequence` the run counter below belongs to. */
  cursorToolReplayTurn?: number;
  /** Replays actually started for `cursorToolReplayTurn`, capping live passes. */
  cursorToolReplayRuns?: number;
  /** Messages evicted from the front, so absolute indices stay stable. */
  droppedMessages: number;
  /** Parts evicted from retained messages over the lifetime of this window. */
  droppedParts: number;
  /** Durable signal for content/parts trimmed without dropping a whole message. */
  transcriptTruncated: boolean;
  /**
   * Vendor ACP wire (configOptions, Grok models._meta, Cursor modes) lives on
   * `sessionConfig.wire` only. Public HTTP snapshots expose `composer`.
   */
  sessionConfig: AcpNormalizedSessionConfig;
  /**
   * A turn that has been accepted but not yet handed to the agent. Transient
   * and deliberately not persisted: a bridge restart resolves the same question
   * through the prompt journal, which records an unfinished turn as ambiguous.
   */
  dispatching: boolean;
  /**
   * The in-flight `ensureSessionProcess` call, shared by every caller that
   * wants this session attached.
   *
   * Without it the attach is a check-then-act race: `ensureSessionProcess`
   * reads `state.child` and then awaits a spawn, so two concurrent callers each
   * see null and each start an agent process. The prompt route's `dispatching`
   * claim only covers prompts, and attach is reachable from the config route
   * and the explicit attach route as well. Never persisted — a promise from a
   * dead process means nothing to its successor.
   */
  attaching?: Promise<AcpProcess>;
  /**
   * Token accounting for the most recently completed turn, or undefined while
   * the agent has never reported any. Persisted so the agent info panel still
   * has something authoritative to show after a bridge restart.
   */
  usage?: PersistedUsage;
  /** Usage carriers collected for the in-flight turn. Never persisted. */
  currentTurnUsage?: AcpTurnUsage;
  /** Wall clock of the in-flight turn, used for the elapsed metric. */
  turnStartedAt?: number;
  /** A user cancellation suppresses any resource-exhaustion retry still in backoff. */
  retryCancelledPromptSequence?: number;
  /** `available_commands_update` size; both agents advertise their commands. */
  commandCount?: number;
  /** Whether session/load is replaying transcript updates into this state. */
  historyReplay: false | "hydrate" | "ignore";
}

export interface PersistedUsage {
  turn: AcpTurnUsage;
  modelId?: string;
  durationMs?: number;
  updatedAt: string;
}

export interface ApprovalState {
  id: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
  requestedAt: number;
  expiresAt: number;
  respond(optionId?: string): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PersistedSession {
  id: string;
  clientSessionKey?: string;
  acpSessionId: string;
  status: SessionStatus;
  error?: string;
  messages: BridgeMessage[];
  droppedMessages?: number;
  droppedParts?: number;
  transcriptTruncated?: boolean;
  revision: number;
  structured: Array<[string, unknown]>;
  promptJournal: PromptJournalEntry[];
  composer?: NativeAgentComposerState;
  sessionConfig?: AcpNormalizedSessionConfig;
  usage?: PersistedUsage;
  commandCount?: number;
  subagentLimitExceeded?: boolean;
}

export interface PersistedState {
  version: 3;
  provider: Provider;
  sessions: PersistedSession[];
}

export const provider = parseProvider(process.env.ACP_PROVIDER);
export const port = parsePort(process.env.PORT);
export const hostname = process.env.HOSTNAME?.trim() || "127.0.0.1";
export const workingDirectory = resolve(process.env.CWD?.trim() || process.cwd());
export const authToken = process.env.ACP_BRIDGE_TOKEN?.trim() || randomBytes(32).toString("base64url");
// `cursor` is the desktop editor's shell command on user machines. Cursor's
// ACP-capable CLI is `cursor-agent`; never let a missing configuration launch
// the GUI as an accidental fallback.
export const executable = process.env.ACP_AGENT_PATH?.trim() || (provider === "cursor" ? "cursor-agent" : "grok");
export const approveProjectMcps = process.env.ACP_APPROVE_PROJECT_MCPS === "1";
export const stateDirectory = process.env.ACP_STATE_DIR?.trim();
export const stateFile = stateDirectory ? resolve(stateDirectory, "state.json") : null;
export const sessions = new Map<string, SessionState>();
export const acpToolSourceStates = new WeakMap<BridgeToolPart, AcpToolSourceState>();
/**
 * Parts and messages whose text already sits at its byte cap, marker included.
 *
 * Overflow used to end the turn, so the cap was only ever reached once. An
 * interactive turn now survives it, which means the agent keeps streaming into
 * a buffer that can no longer grow — and `appendBounded` would re-encode and
 * re-copy the whole 2MiB buffer for every remaining chunk, on the JSON-RPC read
 * loop, only to hand back exactly what it was given. Saturation is recorded
 * once and the append is skipped from then on.
 *
 * Weakly held, so a trimmed part or an evicted message takes its entry with it.
 * A restart repopulates it from the first post-restore chunk.
 */
export const saturatedText = new WeakSet<BridgeMessage | BridgeMessagePart>();
/**
 * Tool call ids whose parts a trim removed, per message.
 *
 * `applyToolCallUpdate` only searches the message's live parts, so a late update
 * for a trimmed call would otherwise rebuild it from that one patch: an empty
 * `Tool call` part, appended *after* the notice that says those steps were
 * dropped, with none of the title or arguments the original carried.
 */
export const trimmedToolCalls = new WeakMap<BridgeMessage, Set<string>>();
export const clientSessionKeys = new Map<string, string>();
export const sessionCreations = new Map<string, Promise<SessionState>>();
export const sessionResumes = new Map<string, Promise<SessionState>>();
export let anonymousSessionCreations = 0;
export let activeCursorToolReplays = 0;
export const cursorToolReplayProcesses = new Set<AcpProcess>();
export let sessionListProbe: Promise<JsonObject[]> | null = null;
export let persistenceTail = Promise.resolve();
export let persistenceScheduled = false;
export let shuttingDown = false;
export let catalogCache: NativeAgentComposerState | null = null;
export let catalogProbe: Promise<NativeAgentComposerState> | null = null;
/**
 * Runtime facts that describe the agent binary rather than one session: every
 * child of this bridge is the same executable with the same configuration, so
 * whichever handshake observed them speaks for all of them.
 */
export const agentRuntime: { version?: string; mcpServers?: number } = {};

export interface AcpSpawnOptions {
  model?: string;
  effort?: string;
}

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_MESSAGES = 500;
export const MAX_HISTORY_MESSAGE_IDS = 1_024;
/**
 * The rendered-transcript display budget. Overridable only *downwards*, and
 * only inside a bounded range, so a test can reach the aggregate-trim floor
 * without pushing sixteen megabytes through a fixture. Nothing can raise it past
 * the reviewed cap.
 */
export const MAX_TRANSCRIPT_BYTES = parseBoundedInteger(
  process.env.ACP_MAX_TRANSCRIPT_BYTES,
  (16 * 1024 * 1024) - (128 * 1024),
  1024 * 1024,
  (16 * 1024 * 1024) - (128 * 1024),
);
export const MAX_MESSAGE_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_PARTS_PER_MESSAGE = 512;
/**
 * A provider that attempts to exceed this bound is cancelled and every known
 * child is failed explicitly. Dropping one active child silently could make
 * `/activity` report idle while that child still writes to the workspace.
 */
export const MAX_ACTIVE_SUBAGENTS_PER_SESSION = 512;
export const MAX_TOOL_ARGUMENT_BYTES = 512 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 512 * 1024;
export const MAX_TOOL_INLINE_FILE_BYTES = 256 * 1024;
export const MAX_TOOL_DIFF_BYTES = 1024 * 1024;
export const MAX_TOOL_ID_BYTES = 512;
// Matches the bound `session-config.ts` applies to a persisted `selectedModelId`,
// so a model id cannot mean one length live and another in the transcript.
export const MAX_MODEL_ID_BYTES = 1_024;
export const MAX_TOOL_NAME_BYTES = 256;
export const MAX_TOOL_TITLE_BYTES = 4 * 1024;
export const MAX_TOOL_PATH_BYTES = 16 * 1024;
export const MAX_REPLAY_RECONCILE_TOOLS = 4_096;
export const MAX_CURSOR_TOOL_REPLAY_PROCESSES = 8;
/**
 * Debounce for a live pass. Long enough to coalesce a burst of tools that
 * settle together into one replay, short enough that a title still lands while
 * the user is watching the turn.
 */
export const CURSOR_TOOL_REPLAY_DELAY_MS = 500;
/**
 * Each replay spawns a child and streams the *whole* session back, so one pass
 * per settled tool would make a long turn quadratic in its tool count. Live
 * passes are capped per turn; the final pass is never capped, so a turn that
 * exhausts its budget still ends fully enriched. `0` disables live passes and
 * leaves only that final pass.
 */
export const MAX_LIVE_CURSOR_TOOL_REPLAYS_PER_TURN = parseBoundedInteger(
  process.env.ACP_MAX_LIVE_CURSOR_TOOL_REPLAYS,
  8,
  0,
  64,
);
/** Bounds both the time and the retained memory of `diffFileLines`. */
export const MAX_DIFF_EDIT_DISTANCE = 512;
/**
 * Unchanged lines kept either side of a change. Rendering every line instead
 * billed the *whole file* per edit: a one-line change to a 200KiB source file
 * produced a 4,993-line "diff" of which 4,989 lines were untouched context, and
 * 58 such edits exhausted the former 8 MiB transcript budget in a single turn.
 */
export const DIFF_CONTEXT_LINES = 3;
export const MAX_SESSIONS = parseBoundedInteger(process.env.ACP_MAX_SESSIONS, 256, 1, 256);
export const MAX_APPROVALS_PER_SESSION = 64;
export const MAX_STRUCTURED_RESULTS = 4;
export const MAX_STRUCTURED_RESULT_BYTES = 1024 * 1024;
export const TRANSCRIPT_CHECK_INTERVAL_BYTES = 64 * 1024;
export const MAX_PROMPT_JOURNAL = 512;
export const MAX_STATE_FILE_BYTES = parseBoundedInteger(
  process.env.ACP_MAX_STATE_FILE_BYTES,
  16 * 1024 * 1024,
  512 * 1024,
  16 * 1024 * 1024,
);
/** Structured results share one persisted file, so their budget must be global. */
export const MAX_PERSISTED_STRUCTURED_BYTES = Math.min(
  4 * 1024 * 1024,
  Math.floor(MAX_STATE_FILE_BYTES / 4),
);
/** At-most-once journals are retained newest-first within one global file budget. */
export const MAX_PERSISTED_PROMPT_JOURNAL_BYTES = Math.min(
  2 * 1024 * 1024,
  Math.floor(MAX_STATE_FILE_BYTES / 8),
);
/** Composer catalogues are reloadable caches and cannot crowd out transcripts. */
export const MAX_PERSISTED_SESSION_CONFIG_BYTES = Math.min(
  2 * 1024 * 1024,
  Math.floor(MAX_STATE_FILE_BYTES / 8),
);
/** Room for omission counters added while transcript arrays are windowed. */
export const PERSISTED_WINDOW_METADATA_RESERVE_BYTES = Math.min(
  128 * 1024,
  Math.floor(MAX_STATE_FILE_BYTES / 16),
);
export const MAX_RESUMABLE_SESSIONS = 512;
export const MAX_SESSION_LIST_PAGES = 64;
export const RPC_TIMEOUT_MS = parseDuration(process.env.ACP_RPC_TIMEOUT_MS, 30_000);
export const PROMPT_TIMEOUT_MS = parseDuration(process.env.ACP_PROMPT_TIMEOUT_MS, 30 * 60_000);
/**
 * How long a Cursor parent generation may wait for live background children
 * before continuing without them. Grok never reads this: it settles through
 * `subagent_finished` and does not hold `session/prompt`.
 */
export const CURSOR_BACKGROUND_WAIT_MS = parseDuration(
  process.env.ACP_CURSOR_BACKGROUND_WAIT_MS,
  30 * 60_000,
);
export const MAX_CURSOR_BACKGROUND_CONTINUATIONS = 4;
export const MAX_CURSOR_CHILD_RESULT_BYTES = 64 * 1024;
/** Recent child JSONL activity projected into the parent Task card. */
export const MAX_CURSOR_CHILD_PARTS = 64;
export const MAX_CURSOR_TRANSCRIPT_HYDRATE_CHILDREN = 8;
export const CURSOR_JSONL_SOURCE_PREFIX = "cursor-jsonl:";
/**
 * Cap on the transcript-root entries one discovery scan will stat. The scan is
 * gated on the root's mtime, so it runs when a child appears rather than per
 * poll, but a project with more children than this stops yielding new
 * candidates rather than growing an unbounded syscall pass.
 */
export const MAX_CURSOR_DISCOVERY_ENTRIES = 4_096;
/**
 * How far *before* a Task tool call a transcript directory may have been
 * created and still be considered that call's child. Cursor writes the
 * directory seconds after the call, so this only absorbs filesystem timestamp
 * granularity — it is not a matching window.
 */
export const CURSOR_CHILD_DISCOVERY_SKEW_MS = 5_000;
/** Prompt recovered from a child's own transcript when Cursor reported none. */
export const MAX_CURSOR_CHILD_PROMPT_BYTES = 4 * 1024;
/** Leading records of a child transcript scanned for that prompt. */
export const MAX_CURSOR_CHILD_PROMPT_RECORDS = 8;
export const CURSOR_BACKGROUND_CONTINUATION_PREFIX = "Background subagent finished.";
export const RESOURCE_EXHAUSTED_MAX_RETRIES = 3;
export const RESOURCE_EXHAUSTED_RETRY_BASE_MS = parseDuration(
  process.env.ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS,
  1_000,
);
export const PARENT_WATCHDOG_INTERVAL_MS = parseDuration(
  process.env.ACP_PARENT_WATCHDOG_INTERVAL_MS,
  15_000,
);
export const ACP_TOKEN_HEADER = "x-orkestrator-acp-token";

export class AcpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    cleanupAbort?: () => void;
  }>();
  #closed = false;
  #stdoutBuffer = Buffer.alloc(0);
  onUpdate: (params: JsonObject) => void = () => undefined;
  onVendor: (method: string, params: JsonObject) => void = () => undefined;
  onPermission: (id: number, params: JsonObject) => void = (id) => {
    this.respond(id, { outcome: { outcome: "cancelled" } });
  };
  onClose: (error: Error) => void = () => undefined;

  constructor(spawnOptions: AcpSpawnOptions = {}) {
    // Both agents expose their permissive command setting as a global flag, so
    // keep it before the ACP subcommand.
    //
    // Auto-approving *commands* is deliberate and unconditional, including on
    // local worktrees: an Orkestrator ACP tab is an interactive agent session,
    // and this matches the Claude bridge's local `bypassPermissions` default.
    // Explicit deny rules still win, and any permission request an agent emits
    // despite these defaults continues through the bridge's fail-closed
    // approval flow below.
    //
    // Cursor's separate MCP approval flag is deliberately *not* unconditional.
    // It is opt-in through ACP_APPROVE_PROJECT_MCPS, which the backend sets
    // only for container environments. The distinction is who chooses the
    // command: a permissive session still runs what the model decided to run,
    // whereas `.cursor/mcp.json` is repository-controlled and would execute on
    // the host the moment a tab opened, with no model or user involvement at
    // all. Cloning a repository must not be enough to run its code.
    //
    // The check is `=== "1"`, so every other state — unset, empty, "true", or
    // a stray ambient value — fails closed. Only the container launcher opts
    // in; `startLocalServerUnlocked` pins it to "0" after inheriting the
    // parent environment for exactly that reason.
    const args = provider === "cursor"
      ? [
          "--force",
          ...(approveProjectMcps ? ["--approve-mcps"] : []),
          ...(spawnOptions.model ? ["--model", spawnOptions.model] : []),
          "acp",
        ]
      : [
          "--always-approve",
          "agent",
          ...(spawnOptions.model ? ["--model", spawnOptions.model] : []),
          ...(spawnOptions.effort ? ["--reasoning-effort", spawnOptions.effort] : []),
          "stdio",
        ];
    this.child = spawn(executable, args, {
      cwd: workingDirectory,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer | string) => {
      this.#acceptChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    // Agent stderr may contain prompts or file contents. Drain but never log it.
    this.child.stderr.resume();
    // Bun currently drops writes to a dead child's stdin silently, but an
    // unhandled stream "error" event is an uncaught exception under Node
    // semantics — it would take the whole bridge, and every session on it,
    // down. Own the failure instead of depending on the runtime: any stream
    // error means this child is gone, so pending requests reject and the
    // session recovers on its next reattach.
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream.on("error", (error: Error) => this.#close(error));
    }
    this.child.once("error", (error) => this.#close(error));
    this.child.once("exit", (code, signal) => {
      this.#close(new Error(`${provider} ACP process exited (code ${code ?? "null"}, signal ${signal ?? "null"})`));
    });
  }

  async initialize(signal?: AbortSignal): Promise<JsonObject> {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        session: { configOptions: { boolean: {} } },
        _meta: { parameterizedModelPicker: true },
      },
      clientInfo: { name: "orkestrator", title: "Orkestrator", version: "1.0.0" },
    }, RPC_TIMEOUT_MS, signal);
    const initialized = isObject(result) ? result : {};
    rememberAgentRuntime(initialized);
    return initialized;
  }

  request(
    method: string,
    params: JsonObject,
    timeoutMs = RPC_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error(`${provider} ACP process is not running`));
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      const fail = (error: Error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.cleanupAbort?.();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error(`${provider} ACP ${method} timed out`));
        void this.close();
      }, timeoutMs);
      timer.unref();
      let cleanupAbort: (() => void) | undefined;
      if (signal) {
        const onAbort = () => {
          fail(new Error(`${provider} ACP ${method} was cancelled`));
          void this.close();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.#pending.set(id, { resolve: resolvePromise, reject, timer, cleanupAbort });
      if (signal?.aborted) {
        fail(new Error(`${provider} ACP ${method} was cancelled`));
        return;
      }
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: JsonObject): void {
    if (!this.#closed) this.#write({ jsonrpc: "2.0", method, params });
  }

  respond(id: number, result: unknown): void {
    if (!this.#closed) this.#write({ jsonrpc: "2.0", id, result });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolvePromise) => this.child.once("exit", () => resolvePromise()));
    this.child.kill("SIGTERM");
    const forced = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    }, 2_000);
    forced.unref();
    await Promise.race([exited, new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 3_000))]);
    clearTimeout(forced);
  }

  #write(value: JsonObject): void {
    // Writing to a destroyed stdin throws synchronously; writing to one whose
    // peer has already gone emits EPIPE asynchronously. Both mean this child is
    // gone, so neither may escape into the HTTP handler that triggered it.
    try {
      if (!this.child.stdin.write(`${JSON.stringify(value)}\n`)) {
        // Node bounds writable buffering; a drain listener is unnecessary because
        // callers never await stdout consumption and request count is bounded.
      }
    } catch (error) {
      this.#close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #acceptChunk(chunk: Buffer): void {
    if (this.#closed) return;
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    while (true) {
      const newline = this.#stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > MAX_LINE_BYTES) {
        this.#close(new Error(`${provider} ACP emitted an oversized JSONL frame`));
        void this.close();
        return;
      }
      const line = this.#stdoutBuffer.subarray(0, newline).toString("utf8");
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      this.#acceptLine(line);
    }
    if (this.#stdoutBuffer.length > MAX_LINE_BYTES) {
      this.#close(new Error(`${provider} ACP emitted an unterminated oversized JSONL frame`));
      void this.close();
    }
  }

  #acceptLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.#close(new Error(`${provider} ACP emitted malformed JSON`));
      void this.close();
      return;
    }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.cleanupAbort?.();
      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonObject;
        pending.reject(new Error(typeof error.message === "string" ? error.message : "ACP request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.id === "number" && typeof message.method === "string") {
      const params = isObject(message.params) ? message.params : {};
      if (message.method === "session/request_permission") {
        this.onPermission(message.id, params);
      } else if (isVendorModelUpdate(message.method, params)) {
        // A model update carries state this bridge does support, so answer it
        // even when the vendor chose the request form over a notification.
        // Everything else is genuinely unimplemented and must say so rather
        // than acknowledge a capability we do not have.
        this.onVendor(message.method, params);
        this.respond(message.id, {});
      } else if (isCursorAcknowledgedExtensionMethod(message.method)) {
        // `cursor/task` and `cursor/update_todos` are documented as
        // notifications, but Cursor's `extMethod` helper sends them as
        // requests. Refusing either with -32601 leaves the matching tool row
        // empty (Active for a child, no list for todos). Answered with `{}`:
        // Cursor discards the result, and inventing a payload would claim a
        // response schema the live agent does not validate. The notification
        // form is handled below.
        this.onVendor(message.method, params);
        this.respond(message.id, {});
      } else {
        this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Unsupported ACP client method: ${message.method}` },
        });
      }
      return;
    }
    if (message.method === "session/update" && isObject(message.params)) {
      this.onUpdate(message.params);
      return;
    }
    if (typeof message.method === "string") {
      const params = isObject(message.params) ? message.params : {};
      // Process-scoped facts are recorded here rather than in the session
      // handler because an agent announces them during `session/new`, before
      // this child is attached to a session at all.
      rememberVendorRuntime(message.method, params);
      // Every vendor *notification* is then offered to the session handler,
      // which ignores the ones it does not model. Notifications expect no reply,
      // so forwarding one this bridge cannot act on costs nothing — unlike a
      // vendor request, which must still be refused above rather than silently
      // acknowledged.
      this.onVendor(message.method, params);
    }
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanupAbort?.();
      pending.reject(error);
    }
    this.#pending.clear();
    this.onClose(error);
  }
}

export function activeSessionReservations(): number {
  return sessions.size + sessionCreations.size + sessionResumes.size + anonymousSessionCreations;
}

export const EXTERNAL_SESSION_PREFIX = "acp-session:";

export function externalSessionToken(acpSessionId: string): string {
  const encoded = Buffer.from(acpSessionId).toString("base64url");
  const signature = createHmac("sha256", authToken).update(encoded).digest("base64url");
  return `${EXTERNAL_SESSION_PREFIX}${encoded}.${signature}`;
}

export function parseExternalSessionToken(value: string): string | null {
  if (!value.startsWith(EXTERNAL_SESSION_PREFIX)) return null;
  const token = value.slice(EXTERNAL_SESSION_PREFIX.length);
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!encoded || encoded.length > 1_024 || !signature) return null;
  const expected = createHmac("sha256", authToken).update(encoded).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, "base64url");
  } catch {
    return null;
  }
  const sessionId = decoded.toString("utf8");
  if (!sessionId.trim() || Buffer.byteLength(sessionId) > 512) return null;
  return decoded.toString("base64url") === encoded ? sessionId : null;
}

export function supportsSessionCapability(initialized: JsonObject, capability: string): boolean {
  const agentCapabilities = isObject(initialized.agentCapabilities)
    ? initialized.agentCapabilities
    : undefined;
  const sessionCapabilities = isObject(agentCapabilities?.sessionCapabilities)
    ? agentCapabilities.sessionCapabilities
    : undefined;
  return sessionCapabilities?.[capability] === true
    || isObject(sessionCapabilities?.[capability]);
}


export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseProvider(value: string | undefined): Provider {
  if (value === "cursor" || value === "grok") return value;
  throw new Error("ACP_PROVIDER must be cursor or grok");
}

export function parsePort(value: string | undefined): number {
  const parsed = Number(value || "4099");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("PORT is invalid");
  return parsed;
}

export function parseDuration(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 10 ? parsed : fallback;
}

export function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function isCursorTaskMethod(method: string): boolean {
  return method === "cursor/task";
}

export function isCursorUpdateTodosMethod(method: string): boolean {
  return method === "cursor/update_todos";
}

/**
 * Cursor extension methods that arrive as JSON-RPC requests even though the
 * published docs call them notifications. Refusing them with -32601 leaves the
 * matching tool row empty; acknowledging with `{}` matches `cursor/task`.
 */
export function isCursorAcknowledgedExtensionMethod(method: string): boolean {
  return isCursorTaskMethod(method) || isCursorUpdateTodosMethod(method);
}

export function isVendorModelUpdate(method: string, params: JsonObject): boolean {
  if (method === "x.ai/models/update" || method === "_x.ai/models/update" || method === "cursor/models/update") {
    return true;
  }
  if (method !== "x.ai/session/update" && method !== "_x.ai/session/update" && method !== "cursor/session/update") {
    return false;
  }
  const update = isObject(params.update) ? params.update : params;
  return update.sessionUpdate === "model_changed" || update.sessionUpdate === "models_update";
}

export function rememberCatalog(composer: NativeAgentComposerState): void {
  if (composer.models.length === 0 && composer.modes.length === 0) return;
  catalogCache = composer;
}

function rememberAgentRuntime(initialized: JsonObject): void {
  const meta = isObject(initialized._meta) ? initialized._meta : {};
  const agentInfo = isObject(initialized.agentInfo) ? initialized.agentInfo : {};
  const version = typeof agentInfo.version === "string"
    ? agentInfo.version
    : typeof meta.agentVersion === "string"
      ? meta.agentVersion
      : undefined;
  if (version) agentRuntime.version = version.slice(0, 64);
}

function rememberVendorRuntime(method: string, params: JsonObject): void {
  if (!method.endsWith("/mcp/servers_updated") || !Array.isArray(params.mcpServers)) return;
  if (agentRuntime.mcpServers === params.mcpServers.length) return;
  agentRuntime.mcpServers = params.mcpServers.length;
  for (const state of sessions.values()) state.revision += 1;
}

export function publicRuntime(state: SessionState): NativeAgentRuntimeSummary {
  return {
    ...(agentRuntime.mcpServers === undefined ? {} : { mcpServers: agentRuntime.mcpServers }),
    ...(state.commandCount === undefined ? {} : { commands: state.commandCount }),
    ...(agentRuntime.version ? { version: agentRuntime.version } : {}),
    state: state.status,
  };
}

export function setSessionListProbe(value: Promise<JsonObject[]> | null): void {
  sessionListProbe = value;
}

export function adjustAnonymousSessionCreations(delta: number): void {
  anonymousSessionCreations += delta;
}

export function adjustActiveCursorToolReplays(delta: number): void {
  activeCursorToolReplays += delta;
}

export function setPersistenceScheduled(value: boolean): void {
  persistenceScheduled = value;
}

export function setPersistenceTail(value: Promise<void>): void {
  persistenceTail = value;
}

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

export function setCatalogProbe(value: Promise<NativeAgentComposerState> | null): void {
  catalogProbe = value;
}
