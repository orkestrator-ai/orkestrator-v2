import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PARENT_PID_ENV,
  parseParentPid,
  startParentWatchdog,
} from "@orkestrator/protocol/parent-watchdog";
import type {
  NativeAgentComposerState,
  NativeAgentRuntimeSummary,
} from "@orkestrator/protocol/native-agent";
import {
  acpContextUsage,
  parseAcpTurnUsage,
  type AcpTurnUsage,
} from "./usage.js";
import {
  applyConfigOptionUpdate,
  applyCurrentModeUpdate,
  applyGrokCatalogUpdate,
  applyGrokModelChange,
  emptyComposerState,
  mergeComposerCatalog,
  normalizeAcpSessionConfig,
  parsePersistedAcpSessionConfig,
  parsePersistedComposerState,
  planComposerApply,
  type AcpComposerPatch,
  type AcpNormalizedSessionConfig,
} from "./session-config.js";
import {
  parsePromptAttachments,
  PromptAttachmentError,
  readPromptImages,
  type AcpPromptImage,
} from "./prompt-attachments.js";

type Provider = "cursor" | "grok";
type JsonObject = Record<string, unknown>;
type SessionStatus = "idle" | "running" | "error";

interface BridgeMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: BridgeMessagePart[];
  createdAt: string;
  /** Model selected when this assistant response began. */
  modelId?: string;
}

interface BridgeTextPart {
  type: "text" | "thinking";
  content: string;
  sourcePartId: string;
  sourceMessageId: string;
}

/**
 * A prompt attachment as the transcript records it. The bytes are sent to the
 * agent but never kept here: the renderer resolves `fileUrl` for its own
 * preview, and inlining a data URL would spend the whole 8MiB transcript budget
 * on one screenshot.
 */
interface BridgeFilePart {
  type: "file";
  content: string;
  fileUrl?: string;
  sourcePartId: string;
  sourceMessageId: string;
}

interface BridgeToolDiff {
  filePath?: string;
  additions?: number;
  deletions?: number;
  before?: string;
  after?: string;
  diff?: string;
}

interface BridgeToolPart {
  type: "tool-invocation";
  content: string;
  sourcePartId: string;
  sourceMessageId: string;
  toolUseId: string;
  toolName?: string;
  toolArgs?: JsonObject;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: BridgeToolDiff;
}

interface AcpToolSourceState {
  title?: string;
  explicitName?: string;
  inputName?: string;
  kind?: string;
  toolArgs?: JsonObject;
  toolState?: BridgeToolPart["toolState"];
  contentOutput?: string;
  rawOutput?: string;
  contentDiffs: BridgeToolDiff[];
  locationPath?: string;
  /**
   * Serialized size of the rendered part the last time it was charged against
   * `uncheckedTranscriptBytes`. Tool parts are patched in place, so charging the
   * whole part on every update would re-bill a 1MiB diff per streaming frame and
   * force a full transcript re-serialization each time. Only the delta is new.
   */
  chargedBytes?: number;
}

type BridgeMessagePart = BridgeTextPart | BridgeFilePart | BridgeToolPart;

interface PromptJournalEntry {
  requestId: string;
  state: "accepted" | "completed" | "failed" | "ambiguous";
  acceptedAt: number;
}

interface SessionState {
  id: string;
  clientSessionKey?: string;
  acpSessionId: string;
  status: SessionStatus;
  error?: string;
  messages: BridgeMessage[];
  child: AcpProcess | null;
  revision: number;
  structured: Map<string, unknown>;
  promptJournal: Map<string, PromptJournalEntry>;
  approvals: Map<string, ApprovalState>;
  outputTruncated: boolean;
  uncheckedTranscriptBytes: number;
  currentTurnOutput: string | null;
  /** Messages evicted from the front, so absolute indices stay stable. */
  droppedMessages: number;
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
   * Token accounting for the most recently completed turn, or undefined while
   * the agent has never reported any. Persisted so the agent info panel still
   * has something authoritative to show after a bridge restart.
   */
  usage?: PersistedUsage;
  /** Usage carriers collected for the in-flight turn. Never persisted. */
  currentTurnUsage?: AcpTurnUsage;
  /** Wall clock of the in-flight turn, used for the elapsed metric. */
  turnStartedAt?: number;
  /** `available_commands_update` size; both agents advertise their commands. */
  commandCount?: number;
}

interface PersistedUsage {
  turn: AcpTurnUsage;
  modelId?: string;
  durationMs?: number;
  updatedAt: string;
}

interface ApprovalState {
  id: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
  requestedAt: number;
  expiresAt: number;
  respond(optionId?: string): void;
  timer: ReturnType<typeof setTimeout>;
}

interface PersistedSession {
  id: string;
  clientSessionKey?: string;
  acpSessionId: string;
  status: SessionStatus;
  error?: string;
  messages: BridgeMessage[];
  revision: number;
  structured: Array<[string, unknown]>;
  promptJournal: PromptJournalEntry[];
  composer?: NativeAgentComposerState;
  sessionConfig?: AcpNormalizedSessionConfig;
  usage?: PersistedUsage;
  commandCount?: number;
}

interface PersistedState {
  version: 3;
  provider: Provider;
  sessions: PersistedSession[];
}

const provider = parseProvider(process.env.ACP_PROVIDER);
const port = parsePort(process.env.PORT);
const hostname = process.env.HOSTNAME?.trim() || "127.0.0.1";
const workingDirectory = resolve(process.env.CWD?.trim() || process.cwd());
const authToken = process.env.ACP_BRIDGE_TOKEN?.trim() || randomBytes(32).toString("base64url");
// `cursor` is the desktop editor's shell command on user machines. Cursor's
// ACP-capable CLI is `cursor-agent`; never let a missing configuration launch
// the GUI as an accidental fallback.
const executable = process.env.ACP_AGENT_PATH?.trim() || (provider === "cursor" ? "cursor-agent" : "grok");
const approveProjectMcps = process.env.ACP_APPROVE_PROJECT_MCPS === "1";
const stateDirectory = process.env.ACP_STATE_DIR?.trim();
const stateFile = stateDirectory ? resolve(stateDirectory, "state.json") : null;
const sessions = new Map<string, SessionState>();
const acpToolSourceStates = new WeakMap<BridgeToolPart, AcpToolSourceState>();
const clientSessionKeys = new Map<string, string>();
const sessionCreations = new Map<string, Promise<SessionState>>();
let anonymousSessionCreations = 0;
let persistenceTail = Promise.resolve();
let persistenceScheduled = false;
let shuttingDown = false;
let catalogCache: NativeAgentComposerState | null = null;
let catalogProbe: Promise<NativeAgentComposerState> | null = null;
/**
 * Runtime facts that describe the agent binary rather than one session: every
 * child of this bridge is the same executable with the same configuration, so
 * whichever handshake observed them speaks for all of them.
 */
const agentRuntime: { version?: string; mcpServers?: number } = {};

interface AcpSpawnOptions {
  model?: string;
  effort?: string;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES = 500;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PARTS_PER_MESSAGE = 512;
const MAX_TOOL_ARGUMENT_BYTES = 512 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 512 * 1024;
const MAX_TOOL_INLINE_FILE_BYTES = 256 * 1024;
const MAX_TOOL_DIFF_BYTES = 1024 * 1024;
const MAX_TOOL_ID_BYTES = 512;
// Matches the bound `session-config.ts` applies to a persisted `selectedModelId`,
// so a model id cannot mean one length live and another in the transcript.
const MAX_MODEL_ID_BYTES = 1_024;
const MAX_TOOL_NAME_BYTES = 256;
const MAX_TOOL_TITLE_BYTES = 4 * 1024;
const MAX_TOOL_PATH_BYTES = 16 * 1024;
/** Bounds both the time and the retained memory of `diffFileLines`. */
const MAX_DIFF_EDIT_DISTANCE = 512;
/**
 * Unchanged lines kept either side of a change. Rendering every line instead
 * billed the *whole file* per edit: a one-line change to a 200KiB source file
 * produced a 4,993-line "diff" of which 4,989 lines were untouched context, and
 * 58 such edits exhausted the 8MiB transcript budget in a single turn.
 */
const DIFF_CONTEXT_LINES = 3;
const MAX_SESSIONS = parseBoundedInteger(process.env.ACP_MAX_SESSIONS, 256, 1, 256);
const MAX_APPROVALS_PER_SESSION = 64;
const MAX_STRUCTURED_RESULTS = 4;
const MAX_STRUCTURED_RESULT_BYTES = 1024 * 1024;
const TRANSCRIPT_CHECK_INTERVAL_BYTES = 64 * 1024;
const MAX_PROMPT_JOURNAL = 512;
const MAX_STATE_FILE_BYTES = 16 * 1024 * 1024;
const RPC_TIMEOUT_MS = parseDuration(process.env.ACP_RPC_TIMEOUT_MS, 30_000);
const PROMPT_TIMEOUT_MS = parseDuration(process.env.ACP_PROMPT_TIMEOUT_MS, 30 * 60_000);
const PARENT_WATCHDOG_INTERVAL_MS = parseDuration(
  process.env.ACP_PARENT_WATCHDOG_INTERVAL_MS,
  15_000,
);
const ACP_TOKEN_HEADER = "x-orkestrator-acp-token";

class AcpProcess {
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

function activeSessionReservations(): number {
  return sessions.size + sessionCreations.size + anonymousSessionCreations;
}

async function createSession(
  clientSessionKey?: string,
  signal?: AbortSignal,
  spawnOptions: AcpSpawnOptions & AcpComposerPatch = {},
): Promise<SessionState> {
  if (clientSessionKey) {
    const existingId = clientSessionKeys.get(clientSessionKey);
    if (existingId) {
      const existing = sessions.get(existingId);
      if (existing) return existing;
    }
    const pending = sessionCreations.get(clientSessionKey);
    if (pending) return pending;
  }
  if (activeSessionReservations() >= MAX_SESSIONS) throw new HttpError(429, "ACP session limit reached");

  const operation = createSessionReserved(clientSessionKey, signal, spawnOptions);
  if (clientSessionKey) sessionCreations.set(clientSessionKey, operation);
  else anonymousSessionCreations += 1;
  try {
    return await operation;
  } finally {
    if (clientSessionKey) {
      if (sessionCreations.get(clientSessionKey) === operation) sessionCreations.delete(clientSessionKey);
    } else {
      anonymousSessionCreations -= 1;
    }
  }
}

async function createSessionReserved(
  clientSessionKey?: string,
  signal?: AbortSignal,
  spawnOptions: AcpSpawnOptions & AcpComposerPatch = {},
): Promise<SessionState> {
  const child = new AcpProcess({ model: spawnOptions.model, effort: spawnOptions.effort ?? spawnOptions.reasoningId });
  try {
    await child.initialize(signal);
    const created = await child.request(
      "session/new",
      { cwd: workingDirectory, additionalDirectories: [], mcpServers: [] },
      RPC_TIMEOUT_MS,
      signal,
    );
    if (!isObject(created) || typeof created.sessionId !== "string") {
      throw new Error(`${provider} returned an invalid ACP session`);
    }
    const id = randomBytes(16).toString("hex");
    const sessionConfig = normalizeAcpSessionConfig(provider, created);
    rememberCatalog(sessionConfig.composer);
    const state: SessionState = {
      id,
      ...(clientSessionKey ? { clientSessionKey } : {}),
      acpSessionId: created.sessionId,
      status: "idle",
      messages: [],
      child,
      revision: 0,
      structured: new Map(),
      promptJournal: new Map(),
      approvals: new Map(),
      outputTruncated: false,
      uncheckedTranscriptBytes: 0,
      currentTurnOutput: null,
      droppedMessages: 0,
      sessionConfig,
      // The session is reachable from `sessions` before its initial
      // configuration finishes, so hold the same claim the config and prompt
      // routes take rather than leaving a window where both see it idle.
      dispatching: true,
    };
    attachChild(state, child);
    sessions.set(id, state);
    if (clientSessionKey) clientSessionKeys.set(clientSessionKey, id);
    try {
      const patch = composerPatchFromSpawn(spawnOptions);
      if (patch) await applyComposerPatch(state, patch, signal);
      await persistState();
      state.dispatching = false;
      return state;
    } catch (error) {
      state.dispatching = false;
      if (sessions.get(id) === state) sessions.delete(id);
      if (clientSessionKey && clientSessionKeys.get(clientSessionKey) === id) {
        clientSessionKeys.delete(clientSessionKey);
      }
      clearApprovals(state);
      throw error;
    }
  } catch (error) {
    await child.close();
    throw error;
  }
}

function attachChild(state: SessionState, child: AcpProcess): void {
  state.child = child;
  child.onUpdate = (params) => applySessionUpdate(state, params);
  child.onVendor = (method, params) => {
    // Same generation rule as `onClose` below: a superseded child can emit long
    // after a replacement attached, and letting it rewrite `sessionConfig`
    // would point the live session — and the process-wide catalogue — at a
    // catalogue the attached agent never advertised.
    if (state.child !== child || sessions.get(state.id) !== state) return;
    applyVendorUpdate(state, method, params);
  };
  child.onPermission = (requestId, params) => parkPermission(state, requestId, params);
  child.onClose = (error) => {
    // Only the currently attached child owns this session's approvals. A
    // superseded child can exit long after a replacement attached (close()
    // gives up waiting after three seconds), and clearing here would drop the
    // live child's parked approvals along with the timers that would have
    // denied them — leaving the agent waiting on a permission forever.
    if (state.child !== child || sessions.get(state.id) !== state || shuttingDown) return;
    clearApprovals(state);
    state.child = null;
    state.status = "error";
    state.error = error.message;
    // The agent is gone, so nothing will ever complete the tools it had open.
    reconcileStaleToolParts(state);
    state.revision += 1;
    schedulePersist();
  };
}

async function ensureSessionProcess(state: SessionState, signal?: AbortSignal): Promise<AcpProcess> {
  if (state.child) return state.child;
  const child = new AcpProcess();
  try {
    const initialized = await child.initialize(signal);
    const capabilities = isObject(initialized.agentCapabilities)
      ? initialized.agentCapabilities
      : undefined;
    if (capabilities?.loadSession !== true) {
      throw new HttpError(410, `${provider} cannot reload persisted ACP sessions`);
    }
    attachChild(state, child);
    const loaded = await child.request("session/load", {
      cwd: workingDirectory,
      additionalDirectories: [],
      mcpServers: [],
      sessionId: state.acpSessionId,
    }, RPC_TIMEOUT_MS, signal);
    if (isObject(loaded)) {
      const sessionConfig = normalizeAcpSessionConfig(provider, {
        ...loaded,
        sessionId: state.acpSessionId,
      });
      if (sessionConfig.composer.models.length > 0 || sessionConfig.composer.modes.length > 0) {
        state.sessionConfig = sessionConfig;
        rememberCatalog(sessionConfig.composer);
      }
    }
    state.status = "idle";
    state.error = undefined;
    state.revision += 1;
    await persistState();
    return child;
  } catch (error) {
    if (state.child === child) state.child = null;
    await child.close();
    throw error;
  }
}

function clearApprovals(state: SessionState): void {
  for (const approval of state.approvals.values()) clearTimeout(approval.timer);
  state.approvals.clear();
}

function parkPermission(state: SessionState, requestId: number, params: JsonObject): void {
  const child = state.child;
  if (!child || params.sessionId !== state.acpSessionId || state.approvals.size >= MAX_APPROVALS_PER_SESSION) {
    child?.respond(requestId, { outcome: { outcome: "cancelled" } });
    return;
  }
  const options = Array.isArray(params.options)
    ? params.options.flatMap((candidate) => {
        if (!isObject(candidate) || typeof candidate.optionId !== "string") return [];
        return [{
          optionId: candidate.optionId.slice(0, 256),
          name: (typeof candidate.name === "string" ? candidate.name : candidate.optionId).slice(0, 256),
          ...(typeof candidate.kind === "string" ? { kind: candidate.kind.slice(0, 64) } : {}),
        }];
      }).slice(0, 20)
    : [];
  const id = randomBytes(12).toString("hex");
  const requestedAt = Date.now();
  const expiresAt = requestedAt + 5 * 60_000;
  const finish = (optionId?: string) => {
    const approval = state.approvals.get(id);
    if (!approval) return;
    clearTimeout(approval.timer);
    state.approvals.delete(id);
    if (optionId && approval.options.some((option) => option.optionId === optionId)) {
      child.respond(requestId, { outcome: { outcome: "selected", optionId } });
    } else {
      child.respond(requestId, { outcome: { outcome: "cancelled" } });
    }
    state.revision += 1;
    schedulePersist();
  };
  const timer = setTimeout(() => finish(), expiresAt - requestedAt);
  timer.unref();
  state.approvals.set(id, {
    id,
    title: permissionTitle(params),
    options,
    requestedAt,
    expiresAt,
    respond: finish,
    timer,
  });
  state.revision += 1;
  schedulePersist();
}

function permissionTitle(params: JsonObject): string {
  const toolCall = isObject(params.toolCall) ? params.toolCall : undefined;
  const title = typeof params.title === "string"
    ? params.title
    : typeof toolCall?.title === "string"
      ? toolCall.title
      : "Permission requested";
  return title.slice(0, 500);
}

function applySessionUpdate(state: SessionState, params: JsonObject): void {
  if (params.sessionId !== state.acpSessionId || !isObject(params.update)) return;
  const update = params.update;
  const kind = typeof update.sessionUpdate === "string"
    ? update.sessionUpdate
    : typeof update.type === "string"
      ? update.type
      : "";
  if (kind === "config_option_update") {
    state.sessionConfig = applyConfigOptionUpdate(provider, state.sessionConfig, update);
    rememberCatalog(state.sessionConfig.composer);
    state.revision += 1;
    schedulePersist();
    return;
  }
  if (kind === "available_commands_update") {
    if (Array.isArray(update.availableCommands)) {
      state.commandCount = update.availableCommands.length;
      state.revision += 1;
      schedulePersist();
    }
    return;
  }
  if (kind === "current_mode_update") {
    const modeId = typeof update.currentModeId === "string"
      ? update.currentModeId
      : typeof update.modeId === "string"
        ? update.modeId
        : "";
    if (modeId) {
      state.sessionConfig = applyCurrentModeUpdate(state.sessionConfig, modeId);
      state.revision += 1;
      schedulePersist();
    }
    return;
  }
  if (state.outputTruncated) return;
  if (kind === "tool_call" || kind === "tool_call_update") {
    applyToolCallUpdate(state, update, kind === "tool_call");
    return;
  }
  if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") return;
  const text = contentText(update.content);
  if (!text) return;
  const message = currentAssistantMessage(state);
  const partType = kind === "agent_thought_chunk" ? "thinking" : "text";
  const lastPart = message.parts.at(-1);
  // The trim notice is a marker, not a stream. Appending a chunk to it would
  // rewrite the notice into agent output and lose the announcement.
  const previous = isTrimNotice(message, lastPart) ? undefined : lastPart;
  if (previous?.type !== partType && message.parts.length >= MAX_PARTS_PER_MESSAGE) {
    if (turnRequiresCompleteOutput(state)) {
      failTranscriptLimit(state);
      return;
    }
    trimPartsTo(message, MAX_PARTS_PER_MESSAGE - 1);
  }
  const currentPartText = previous?.type === partType ? previous.content : "";
  const nextPartText = appendBounded(currentPartText, text, MAX_MESSAGE_TEXT_BYTES);
  if (previous?.type === partType) previous.content = nextPartText.value;
  else message.parts.push({
    type: partType,
    content: nextPartText.value,
    sourcePartId: `${message.id}:${message.parts.length}`,
    sourceMessageId: message.id,
  });
  const nextContent = partType === "text"
    ? appendBounded(message.content, text, MAX_MESSAGE_TEXT_BYTES)
    : { value: message.content, truncated: false };
  message.content = nextContent.value;
  if (partType === "text" && state.currentTurnOutput !== null) {
    const captured = appendBounded(state.currentTurnOutput, text, MAX_MESSAGE_TEXT_BYTES);
    state.currentTurnOutput = captured.value;
    if (captured.truncated) state.outputTruncated = true;
  }
  state.revision += 1;
  state.uncheckedTranscriptBytes += Buffer.byteLength(text) * (partType === "text" ? 2 : 1);
  const transcriptTruncated = state.messages.length > MAX_MESSAGES
    || state.uncheckedTranscriptBytes >= TRANSCRIPT_CHECK_INTERVAL_BYTES
    ? boundTranscript(state)
    : false;
  if (
    (nextPartText.truncated || nextContent.truncated || transcriptTruncated)
    && turnRequiresCompleteOutput(state)
  ) {
    failTranscriptLimit(state);
    return;
  }
  schedulePersist();
}

function applyToolCallUpdate(
  state: SessionState,
  update: JsonObject,
  isInitial: boolean,
): void {
  if (typeof update.toolCallId !== "string") return;
  const toolCallId = truncateUtf8(update.toolCallId, MAX_TOOL_ID_BYTES);
  if (!toolCallId) return;

  // Incremental transcript reads intentionally re-fetch only the trailing
  // message. Tool updates therefore upsert there as well; mutating an older
  // message would be authoritative in the bridge but invisible to a mounted tab.
  let owner = state.messages.at(-1);
  let part = owner?.role === "assistant"
    ? owner.parts.find(
      (messagePart): messagePart is BridgeToolPart =>
        messagePart.type === "tool-invocation" && messagePart.toolUseId === toolCallId,
    )
    : undefined;

  if (!part) {
    owner = currentAssistantMessage(state);
    if (owner.parts.length >= MAX_PARTS_PER_MESSAGE) {
      if (turnRequiresCompleteOutput(state)) {
        failTranscriptLimit(state);
        return;
      }
      trimPartsTo(owner, MAX_PARTS_PER_MESSAGE - 1);
    }
    part = {
      type: "tool-invocation",
      content: "Tool call",
      sourcePartId: `tool:${toolCallId}`,
      sourceMessageId: owner.id,
      toolUseId: toolCallId,
      toolState: "pending",
    };
    owner.parts.push(part);
  }

  let source = acpToolSourceStates.get(part);
  if (!source) {
    source = {
      title: part.toolTitle,
      explicitName: part.toolName,
      toolArgs: part.toolArgs,
      toolState: part.toolState ?? (isInitial ? "pending" : undefined),
      rawOutput: part.toolOutput,
      contentDiffs: part.toolDiff ? [part.toolDiff] : [],
    };
    acpToolSourceStates.set(part, source);
  }
  applyAcpToolSourcePatch(source, update);
  renderAcpToolSource(part, source);

  state.revision += 1;
  const serializedBytes = Buffer.byteLength(JSON.stringify(part));
  state.uncheckedTranscriptBytes += Math.max(0, serializedBytes - (source.chargedBytes ?? 0));
  source.chargedBytes = serializedBytes;
  const transcriptTruncated = state.messages.length > MAX_MESSAGES
    || state.uncheckedTranscriptBytes >= TRANSCRIPT_CHECK_INTERVAL_BYTES
    ? boundTranscript(state)
    : false;
  if (transcriptTruncated && turnRequiresCompleteOutput(state)) {
    failTranscriptLimit(state);
    return;
  }
  schedulePersist();
}

function applyAcpToolSourcePatch(source: AcpToolSourceState, update: JsonObject): void {
  if ("title" in update) {
    source.title = boundedNullableString(update.title, MAX_TOOL_TITLE_BYTES);
  }
  if ("name" in update) {
    source.explicitName = boundedNullableString(update.name, MAX_TOOL_NAME_BYTES);
  }
  if ("kind" in update) {
    source.kind = boundedNullableString(update.kind, MAX_TOOL_NAME_BYTES);
  }
  if ("rawInput" in update) {
    if (isObject(update.rawInput)) {
      source.inputName = boundedString(update.rawInput._toolName, MAX_TOOL_NAME_BYTES);
      source.toolArgs = boundedToolArguments(update.rawInput);
    } else {
      source.inputName = undefined;
      source.toolArgs = undefined;
    }
  }
  if ("status" in update) {
    // `null` is ACP's explicit "clear this field". An unrecognised status — a
    // value a future protocol revision adds — is not: dropping the state there
    // would leave a part that renders no state at all and that
    // `reconcileStaleToolParts` can never settle. Keep what we already knew.
    const mapped = mapAcpToolState(update.status);
    if (mapped !== undefined) source.toolState = mapped;
    else if (update.status === null) source.toolState = undefined;
  }
  if ("content" in update) {
    source.contentOutput = toolCallContentText(update.content);
    source.contentDiffs = toolCallContentDiffs(update.content);
  }
  if ("locations" in update) {
    source.locationPath = toolCallLocationPath(update.locations);
  }
  if ("rawOutput" in update) {
    source.rawOutput = update.rawOutput === null
      ? undefined
      : stringifyToolPayload(update.rawOutput);
  }
}

function renderAcpToolSource(part: BridgeToolPart, source: AcpToolSourceState): void {
  const toolName = source.explicitName ?? source.inputName ?? source.kind;
  setOptionalPartField(part, "toolTitle", source.title);
  setOptionalPartField(part, "toolName", toolName);
  setOptionalPartField(part, "toolArgs", source.toolArgs);
  setOptionalPartField(part, "toolState", source.toolState);
  part.content = source.title ?? toolName ?? "Tool call";

  const output = source.contentOutput ?? source.rawOutput;
  setOptionalPartField(part, "toolOutput", output);
  setOptionalPartField(
    part,
    "toolError",
    source.toolState === "failure" ? output ?? "Tool call failed" : undefined,
  );

  const diff = aggregateAcpToolDiffs(
    source.contentDiffs,
    source.locationPath ?? toolArgumentPath(source.toolArgs),
  );
  setOptionalPartField(part, "toolDiff", diff);
}

function setOptionalPartField<TKey extends keyof BridgeToolPart>(
  part: BridgeToolPart,
  key: TKey,
  value: BridgeToolPart[TKey] | undefined,
): void {
  if (value === undefined) delete part[key];
  else part[key] = value;
}

function currentAssistantMessage(state: SessionState): BridgeMessage {
  let message = state.messages.at(-1);
  if (!message || message.role !== "assistant" || state.status !== "running") {
    const modelId = boundedModelId(state.sessionConfig.composer.selectedModelId);
    message = {
      id: randomBytes(12).toString("hex"),
      role: "assistant",
      content: "",
      parts: [],
      createdAt: new Date().toISOString(),
      ...(modelId ? { modelId } : {}),
    };
    state.messages.push(message);
  }
  return message;
}

/**
 * A model id is an identifier, not display text, so an oversized or non-string
 * value is dropped rather than truncated — exactly as `session-config.ts`
 * rejects an over-long `selectedModelId` instead of shortening it. A truncated
 * id would match no catalogue entry and would render as a plausible-looking
 * model the agent never actually ran; absent renders as "no model recorded".
 */
function boundedModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed) > MAX_MODEL_ID_BYTES) return undefined;
  return trimmed;
}

/**
 * Whether losing transcript content has to fail the turn.
 *
 * A structured turn is worth exactly its complete output, so any loss must
 * fail: the caller would otherwise parse a truncated answer as a whole one. An
 * interactive turn is a conversation, and trimming its oldest steps to stay
 * inside the display budget is routine housekeeping. Failing the session there
 * strands the *entire* conversation behind a "Connection Failed" screen —
 * `HttpBridgeProvider.status()` turns any bridge error status into a thrown
 * command — and the failure is persisted, so Retry only reads it back.
 */
function turnRequiresCompleteOutput(state: SessionState): boolean {
  return state.currentTurnOutput !== null;
}

function failTranscriptLimit(state: SessionState): void {
  state.outputTruncated = true;
  state.status = "error";
  state.error = `${provider} output exceeded the transcript limit`;
  state.child?.notify("session/cancel", { sessionId: state.acpSessionId });
  state.revision += 1;
  schedulePersist();
}

const TRANSCRIPT_TRIM_NOTICE =
  "[Earlier steps in this response were dropped: it reached the transcript display limit.]";

function trimNoticePartId(message: BridgeMessage): string {
  return `${message.id}:transcript-trimmed`;
}

function isTrimNotice(
  message: BridgeMessage,
  part: BridgeMessagePart | undefined,
): boolean {
  return part !== undefined && part.sourcePartId === trimNoticePartId(message);
}

/**
 * Drop the oldest parts of `message` until it holds at most `targetLength`,
 * leaving one notice in their place. Always drops at least one, so callers can
 * loop on it, and counts the notice against the target so trimming for room
 * cannot itself push the message back over a cap.
 *
 * The announcement matters more here than for the rest of the transcript: the
 * parts most likely to be dropped are the tool calls that did the work, and a
 * silent cut reads as a response that simply never took those steps. The notice
 * is keyed by `sourcePartId`, so repeated trims replace it rather than stack.
 */
function trimPartsTo(message: BridgeMessage, targetLength: number): void {
  if (isTrimNotice(message, message.parts[0])) message.parts.shift();
  const keep = Math.max(0, targetLength - 1);
  message.parts.splice(0, Math.max(1, message.parts.length - keep));
  message.parts.unshift({
    type: "text",
    content: TRANSCRIPT_TRIM_NOTICE,
    sourcePartId: trimNoticePartId(message),
    sourceMessageId: message.id,
  });
}

function boundedString(value: unknown, maximumBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return truncateUtf8(value, maximumBytes);
}

function boundedNullableString(value: unknown, maximumBytes: number): string | undefined {
  return value === null ? undefined : boundedString(value, maximumBytes);
}

function boundedToolArguments(value: JsonObject): JsonObject {
  const { _toolName: _ignoredToolName, ...argumentsWithoutHint } = value;
  if (Buffer.byteLength(JSON.stringify(argumentsWithoutHint)) <= MAX_TOOL_ARGUMENT_BYTES) {
    return argumentsWithoutHint;
  }
  return { _orkestrator: "Tool input omitted because it exceeded the 512 KiB display limit" };
}

function mapAcpToolState(status: unknown): BridgeToolPart["toolState"] | undefined {
  if (status === "completed") return "success";
  if (status === "failed") return "failure";
  if (status === "pending" || status === "in_progress") return "pending";
  return undefined;
}

function stringifyToolPayload(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let serialized: string;
  if (typeof value === "string") serialized = value;
  else {
    try {
      serialized = JSON.stringify(value, null, 2);
    } catch {
      serialized = String(value);
    }
  }
  return truncateDisplayText(serialized, MAX_TOOL_OUTPUT_BYTES, "\n… tool output truncated");
}

function toolCallContentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const pieces = value.flatMap((item) => {
    if (!isObject(item) || item.type === "diff") return [];
    if (item.type === "content") {
      const text = contentText(item.content);
      return text ? [text] : [];
    }
    if (item.type === "terminal") {
      const terminalId = boundedString(item.terminalId, MAX_TOOL_ID_BYTES);
      return [terminalId ? `[Terminal ${terminalId}]` : "[Terminal]"];
    }
    return [];
  });
  if (pieces.length === 0) return undefined;
  return truncateDisplayText(pieces.join("\n"), MAX_TOOL_OUTPUT_BYTES, "\n… tool output truncated");
}

function toolCallContentDiffs(value: unknown): BridgeToolDiff[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isObject(item) || item.type !== "diff") return [];
    const normalized = normalizeAcpContentDiff(item);
    return normalized ? [normalized] : [];
  });
}

function normalizeAcpContentDiff(value: JsonObject): BridgeToolDiff | undefined {
  const filePath = boundedString(value.path, MAX_TOOL_PATH_BYTES);
  const rawBefore = typeof value.oldText === "string" ? value.oldText : undefined;
  const rawAfter = typeof value.newText === "string" ? value.newText : undefined;
  const keepInline = Buffer.byteLength(rawBefore ?? "") <= MAX_TOOL_INLINE_FILE_BYTES
    && Buffer.byteLength(rawAfter ?? "") <= MAX_TOOL_INLINE_FILE_BYTES;
  // An empty `diff` string carries no information, so it must not suppress the
  // oldText/newText rendering the way a real one does — hence the truthy check
  // rather than a `typeof` guard alone. Truncation is announced, like every
  // other bounded display field; a silent cut reads as a complete diff.
  const rawSuppliedDiff = typeof value.diff === "string" && value.diff ? value.diff : undefined;
  const suppliedDiff = rawSuppliedDiff === undefined
    ? undefined
    : truncateDisplayText(rawSuppliedDiff, MAX_TOOL_DIFF_BYTES, "\n… file diff truncated");
  // Only generated when it will actually be used: `createDisplayDiff` is
  // whole-file work, and computing it just to drop it in favour of a supplied
  // diff was the most expensive no-op on the read loop.
  const generated = suppliedDiff === undefined && keepInline && rawAfter !== undefined
    ? createDisplayDiff(filePath, rawBefore, rawAfter)
    : undefined;
  const diff = suppliedDiff ?? generated?.diff ?? (filePath
    ? `--- ${safeDiffPath(filePath)}\n+++ ${safeDiffPath(filePath)}\n@@ diff omitted: file state exceeded display limit @@`
    : undefined);
  const stats = rawSuppliedDiff !== undefined
    ? countUnifiedDiffLines(rawSuppliedDiff)
    : generated;
  if (!filePath && rawBefore === undefined && rawAfter === undefined && diff === undefined) {
    return undefined;
  }
  // The file states are only ever rendered as the fallback for a part that has
  // no diff at all: the renderer treats `diff` as authoritative the moment it
  // exists. Keeping them alongside one stored two more whole copies of the file
  // per edit — 5.3MiB of one 8MiB transcript — that nothing would ever read.
  const keepFileStates = keepInline && diff === undefined;
  return {
    ...(filePath ? { filePath } : {}),
    ...(stats ? { additions: stats.additions, deletions: stats.deletions } : {}),
    ...(keepFileStates && rawBefore !== undefined ? { before: rawBefore } : {}),
    ...(keepFileStates && rawAfter !== undefined ? { after: rawAfter } : {}),
    ...(diff !== undefined ? { diff } : {}),
  };
}

function aggregateAcpToolDiffs(
  diffs: BridgeToolDiff[],
  fallbackPath: string | undefined,
): BridgeToolDiff | undefined {
  if (diffs.length === 0) return fallbackPath ? { filePath: fallbackPath } : undefined;
  if (diffs.length === 1) {
    const [diff] = diffs;
    return diff?.filePath || !fallbackPath ? diff : { ...diff, filePath: fallbackPath };
  }
  const rendered = diffs.flatMap((diff) => diff.diff ? [diff.diff] : []);
  const hasCompleteStats = diffs.every(
    (diff) => diff.additions !== undefined && diff.deletions !== undefined,
  );
  return {
    ...(hasCompleteStats ? {
      additions: diffs.reduce((total, diff) => total + (diff.additions ?? 0), 0),
      deletions: diffs.reduce((total, diff) => total + (diff.deletions ?? 0), 0),
    } : {}),
    ...(rendered.length > 0 ? {
      diff: truncateDisplayText(
        rendered.join("\n"),
        MAX_TOOL_DIFF_BYTES,
        "\n… additional file diffs truncated",
      ),
    } : {}),
  };
}

function toolCallLocationPath(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value.find((location): location is JsonObject => isObject(location));
  return boundedString(first?.path, MAX_TOOL_PATH_BYTES);
}

function toolArgumentPath(toolArgs: JsonObject | undefined): string | undefined {
  return boundedString(toolArgs?.path, MAX_TOOL_PATH_BYTES)
    ?? boundedString(toolArgs?.filePath, MAX_TOOL_PATH_BYTES)
    ?? boundedString(toolArgs?.file_path, MAX_TOOL_PATH_BYTES);
}

interface DisplayDiffLine {
  type: "context" | "add" | "remove";
  content: string;
}

function createDisplayDiff(
  filePath: string | undefined,
  before: string | undefined,
  after: string,
): { diff: string; additions: number; deletions: number } {
  const lines = diffFileLines(fileLines(before ?? ""), fileLines(after));
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === "add") additions += 1;
    if (line.type === "remove") deletions += 1;
  }
  const path = safeDiffPath(filePath ?? "unknown-file");
  return {
    diff: truncateDisplayText(
      [
        `--- ${before === undefined ? "/dev/null" : path}`,
        `+++ ${path}`,
        ...renderDiffHunks(lines),
      ].join("\n"),
      MAX_TOOL_DIFF_BYTES,
      "\n… file diff truncated",
    ),
    additions,
    deletions,
  };
}

/**
 * Render the changed regions as unified hunks rather than the whole file.
 *
 * Runs of unchanged lines longer than twice the context are elided, and each
 * surviving region gets a `@@` header carrying its line numbers so the reader
 * can still place it in the file. A file with no changes at all renders as a
 * single empty `@@` header, which is what it is: nothing to show.
 */
function renderDiffHunks(lines: DisplayDiffLine[]): string[] {
  const changed = lines.reduce<number[]>((indexes, line, index) => {
    if (line.type !== "context") indexes.push(index);
    return indexes;
  }, []);
  if (changed.length === 0) return ["@@"];

  const rendered: string[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  let cursor = 0;
  let nextChange = 0;

  while (nextChange < changed.length) {
    const start = Math.max(cursor, changed[nextChange]! - DIFF_CONTEXT_LINES);
    // Extend the hunk while the next change is close enough that the gap
    // between them is cheaper to print than a second header.
    let end = Math.min(lines.length - 1, changed[nextChange]! + DIFF_CONTEXT_LINES);
    while (
      nextChange + 1 < changed.length
      && changed[nextChange + 1]! - DIFF_CONTEXT_LINES <= end + 1
    ) {
      nextChange += 1;
      end = Math.min(lines.length - 1, changed[nextChange]! + DIFF_CONTEXT_LINES);
    }
    nextChange += 1;

    // Advance the line counters across everything elided before this hunk.
    for (let index = cursor; index < start; index += 1) {
      const type = lines[index]!.type;
      if (type !== "add") beforeLine += 1;
      if (type !== "remove") afterLine += 1;
    }

    let beforeCount = 0;
    let afterCount = 0;
    const body: string[] = [];
    for (let index = start; index <= end; index += 1) {
      const line = lines[index]!;
      if (line.type !== "add") beforeCount += 1;
      if (line.type !== "remove") afterCount += 1;
      body.push(
        `${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.content}`,
      );
    }
    rendered.push(
      `@@ -${beforeLine},${beforeCount} +${afterLine},${afterCount} @@`,
      ...body,
    );
    beforeLine += beforeCount;
    afterLine += afterCount;
    cursor = end + 1;
  }
  return rendered;
}

function fileLines(value: string): string[] {
  return value.length === 0 ? [] : value.split("\n");
}

function diffFileLines(before: string[], after: string[]): DisplayDiffLine[] {
  // `trace` retains one frontier per edit distance, each holding O(distance)
  // entries, so this search costs O(distance²) in *memory* as well as time. The
  // work counter alone bounded only the latter: a full rewrite of a 256KiB file
  // reached ~4M retained Map entries (~340MB, ~150ms of blocked read loop)
  // before it fired, and then discarded all of it for the fallback anyway.
  // Capping the distance bounds both — 512 keeps an optimal diff for edits up to
  // 512 changed lines at ~24MB and <10ms, and anything larger renders as one
  // replaced block, which is what a rewrite that size looks like regardless.
  const maximumSteps = Math.min(before.length + after.length, MAX_DIFF_EDIT_DISTANCE);
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  let work = 0;

  for (let distance = 0; distance <= maximumSteps; distance += 1) {
    trace.push(new Map(frontier));
    const next = new Map(frontier);
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      let x = diagonal === -distance || (diagonal !== distance && right < down)
        ? Math.max(0, down)
        : Math.max(0, right + 1);
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
        work += 1;
      }
      next.set(diagonal, x);
      work += 1;
      if (x >= before.length && y >= after.length) {
        return backtrackFileDiff(trace, before, after);
      }
      if (work > 2_000_000) return boundedFallbackDiff(before, after);
    }
    frontier = next;
  }
  return boundedFallbackDiff(before, after);
}

function backtrackFileDiff(
  trace: Array<Map<number, number>>,
  before: string[],
  after: string[],
): DisplayDiffLine[] {
  let x = before.length;
  let y = after.length;
  const result: DisplayDiffLine[] = [];
  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const frontier = trace[distance]!;
    const diagonal = x - y;
    const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal = diagonal === -distance || (diagonal !== distance && right < down)
      ? diagonal + 1
      : diagonal - 1;
    const previousX = Math.max(0, frontier.get(previousDiagonal) ?? 0);
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      result.push({ type: "context", content: before[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (distance === 0) break;
    if (x === previousX) {
      result.push({ type: "add", content: after[y - 1]! });
      y -= 1;
    } else {
      result.push({ type: "remove", content: before[x - 1]! });
      x -= 1;
    }
  }
  return result.reverse();
}

function boundedFallbackDiff(before: string[], after: string[]): DisplayDiffLine[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) {
    suffix += 1;
  }
  return [
    ...before.slice(0, prefix).map((content) => ({ type: "context" as const, content })),
    ...before.slice(prefix, before.length - suffix).map((content) => ({ type: "remove" as const, content })),
    ...after.slice(prefix, after.length - suffix).map((content) => ({ type: "add" as const, content })),
    ...before.slice(before.length - suffix).map((content) => ({ type: "context" as const, content })),
  ];
}

function countUnifiedDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function safeDiffPath(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

function truncateDisplayText(value: string, maximumBytes: number, notice: string): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  const noticeBytes = Buffer.byteLength(notice);
  return truncateUtf8(value, Math.max(0, maximumBytes - noticeBytes)) + notice;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isObject(value)) return "";
  return typeof value.text === "string" ? value.text : "";
}

function appendBounded(current: string, addition: string, maximumBytes: number): {
  value: string;
  truncated: boolean;
} {
  const currentBytes = Buffer.byteLength(current);
  const remaining = Math.max(0, maximumBytes - currentBytes);
  if (Buffer.byteLength(addition) <= remaining) return { value: current + addition, truncated: false };
  const marker = "\n[output truncated by Orkestrator]";
  const markerBytes = Buffer.byteLength(marker);
  // Truncation is no longer fatal for an interactive turn, so the marker is
  // part of the correctness contract rather than optional decoration. A prior
  // stream chunk can leave fewer free bytes than the marker needs; reserve its
  // space from the already-buffered prefix in that case instead of silently
  // dropping this chunk and presenting the shortened response as complete.
  const contentLimit = Math.max(0, maximumBytes - markerBytes);
  const prefix = truncateUtf8(current, contentLimit);
  const usable = Math.max(0, contentLimit - Buffer.byteLength(prefix));
  return {
    value: prefix + truncateUtf8(addition, usable) + truncateUtf8(marker, maximumBytes),
    truncated: true,
  };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const encoded = Buffer.from(value);
  if (encoded.length <= maximumBytes) return value;
  // Back up over continuation bytes so decoding cannot replace a partial code
  // point with U+FFFD (three bytes) and accidentally exceed the byte cap.
  let end = maximumBytes;
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

function boundTranscript(state: SessionState): boolean {
  state.uncheckedTranscriptBytes = 0;
  let truncatedCurrentMessage = false;
  while (state.messages.length > MAX_MESSAGES) {
    state.messages.shift();
    state.droppedMessages += 1;
  }
  let bytes = Buffer.byteLength(JSON.stringify(state.messages));
  while (bytes > MAX_TRANSCRIPT_BYTES && state.messages.length > 1) {
    state.messages.shift();
    state.droppedMessages += 1;
    bytes = Buffer.byteLength(JSON.stringify(state.messages));
  }
  const onlyMessage = state.messages[0];
  while (bytes > MAX_TRANSCRIPT_BYTES && onlyMessage && onlyMessage.parts.length > 1) {
    // Strictly shorter every pass, so the loop still terminates once only the
    // notice is left.
    trimPartsTo(onlyMessage, onlyMessage.parts.length - 1);
    truncatedCurrentMessage = true;
    bytes = Buffer.byteLength(JSON.stringify(state.messages));
  }
  if (bytes > MAX_TRANSCRIPT_BYTES) {
    // One part alone is over the whole-transcript budget, so nothing left to
    // drop can bring it back under and the bound is genuinely unenforceable.
    // Every part is individually capped well below 8MiB, so this is a backstop
    // against a future cap being raised, not a state the agents can reach.
    state.outputTruncated = true;
    state.status = "error";
    state.error = `${provider} output exceeded the transcript limit`;
    truncatedCurrentMessage = true;
  }
  return truncatedCurrentMessage;
}

function publicSession(state: SessionState): JsonObject {
  const contextUsage = publicContextUsage(state);
  return {
    id: state.id,
    provider,
    status: state.status,
    error: state.error,
    messages: state.messages,
    // Absolute index of `messages[0]`. Clients anchor their incremental reads
    // to this so evictions from the front of the transcript cannot silently
    // shift the window they are appending to.
    baseIndex: state.droppedMessages,
    revision: state.revision,
    sessionId: state.id,
    composer: state.sessionConfig.composer,
    ...(contextUsage ? { contextUsage } : {}),
    runtime: publicRuntime(state),
  };
}

/**
 * The neutral usage snapshot, or nothing at all. Cursor reports no token counts
 * whatsoever, and an empty meter reading "0 tokens" would claim a measurement
 * the agent never made; the panel's own "no snapshot yet" copy is the truth.
 */
function publicContextUsage(state: SessionState) {
  return state.usage
    ? acpContextUsage(state.usage.turn, {
        ...(state.usage.modelId ? { modelId: state.usage.modelId } : {}),
        ...(state.usage.durationMs === undefined ? {} : { durationMs: state.usage.durationMs }),
        updatedAt: state.usage.updatedAt,
      })
    : null;
}

/**
 * Incremental transcript read. Only the last message mutates (its parts grow as
 * chunks arrive), so a client re-requests from its own last index and receives
 * that message plus anything newer — never the whole transcript, which is
 * bounded at 8 MiB and would otherwise be re-sent on every poll.
 */
function messageWindow(state: SessionState, fromIndex: number | null): JsonObject {
  const start = fromIndex === null
    ? 0
    : Math.min(Math.max(fromIndex - state.droppedMessages, 0), state.messages.length);
  return {
    messages: state.messages.slice(start),
    baseIndex: state.droppedMessages + start,
    totalMessages: state.droppedMessages + state.messages.length,
    revision: state.revision,
    status: state.status,
    error: state.error,
    composer: state.sessionConfig.composer,
  };
}

function parseFromIndex(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function publicApprovals(state: SessionState): unknown[] {
  return [...state.approvals.values()].map(({ id, title, options, requestedAt, expiresAt }) => ({
    id,
    title,
    options,
    approvalId: id,
    kind: "permissions",
    permissions: { fileSystem: true },
    actionable: true,
    requestedAt,
    expiresAt,
  }));
}

function setStructuredResult(state: SessionState, requestId: string, value: unknown): void {
  if (!state.structured.has(requestId) && state.structured.size >= MAX_STRUCTURED_RESULTS) {
    const oldest = state.structured.keys().next().value;
    if (typeof oldest === "string") state.structured.delete(oldest);
  }
  state.structured.set(requestId, value);
}

function setPromptJournal(state: SessionState, entry: PromptJournalEntry): void {
  if (!state.promptJournal.has(entry.requestId) && state.promptJournal.size >= MAX_PROMPT_JOURNAL) {
    const oldest = state.promptJournal.keys().next().value;
    if (typeof oldest === "string") state.promptJournal.delete(oldest);
  }
  state.promptJournal.set(entry.requestId, entry);
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  clientSignal: AbortSignal,
): Promise<void> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/global/health" && request.method === "GET") {
    return json(response, 200, { ok: true, provider, version: "1.0.0" });
  }
  if (!authenticated(request)) return json(response, 401, { error: "Unauthorized" });
  if (url.pathname === "/global/auth-check" && request.method === "GET") {
    return json(response, 200, { ok: true });
  }
  if (url.pathname === "/global/models" && request.method === "GET") {
    const models = await listNormalizedModels(clientSignal);
    return json(response, 200, { models });
  }
  if (url.pathname === "/session/create" && request.method === "POST") {
    const body = await readJson(request);
    const rawClientSessionKey = typeof body.clientSessionKey === "string" ? body.clientSessionKey.trim() : "";
    if (Buffer.byteLength(rawClientSessionKey) > 512) {
      return json(response, 400, { error: "clientSessionKey is too long" });
    }
    const clientSessionKey = rawClientSessionKey || undefined;
    const spawnOptions = parseComposerPatch(body) ?? {};
    const state = await createSession(clientSessionKey, clientSignal, {
      ...spawnOptions,
      model: spawnOptions.modelId,
      effort: spawnOptions.reasoningId,
    });
    return json(response, 201, publicSession(state));
  }
  const match = /^\/session\/([^/]+)(?:\/(messages|status|activity|prompt|cancel|abort|structured-output|interactions|config|approvals(?:\/[^/]+)?))?$/.exec(url.pathname);
  if (!match) return json(response, 404, { error: "Not found" });
  const state = sessions.get(match[1]!);
  if (!state) {
    if (match[2] === "activity") return json(response, 200, { activity: "missing" });
    return json(response, 404, { error: "Session not found" });
  }
  const action = match[2];
  if (!action && request.method === "GET") return json(response, 200, publicSession(state));
  if (action === "messages" && request.method === "GET") {
    return json(response, 200, messageWindow(state, parseFromIndex(url.searchParams.get("fromIndex"))));
  }
  if (action === "status" && request.method === "GET") {
    return json(response, 200, {
      status: state.status,
      error: state.error,
      revision: state.revision,
      composer: state.sessionConfig.composer,
    });
  }
  if (action === "config" && request.method === "GET") {
    return json(response, 200, state.sessionConfig.composer);
  }
  if (action === "config" && request.method === "POST") {
    const body = await readJson(request);
    // Claim before the first await, exactly as the prompt route does.
    // `applyComposerPatch` yields on `ensureSessionProcess` and again on every
    // RPC, so a bare check would let a second config POST — or a prompt —
    // through and both would plan against the same stale `sessionConfig`.
    if (state.status === "running" || state.dispatching) {
      return json(response, 409, { error: "Session is already running" });
    }
    const patch = parseComposerPatch(body);
    if (!patch) return json(response, 200, state.sessionConfig.composer);
    state.dispatching = true;
    try {
      await applyComposerPatch(state, patch, clientSignal);
    } finally {
      state.dispatching = false;
    }
    return json(response, 200, state.sessionConfig.composer);
  }
  if (action === "activity" && request.method === "GET") return json(response, 200, { activity: state.status === "running" ? "working" : "idle" });
  if (action === "approvals" && request.method === "GET") return json(response, 200, { approvals: publicApprovals(state), revision: state.revision });
  if (action === "interactions" && request.method === "GET") return json(response, 200, { interactions: [], revision: state.revision });
  if (action?.startsWith("approvals/") && request.method === "POST") {
    const approval = state.approvals.get(decodeURIComponent(action.slice("approvals/".length)));
    if (!approval) return json(response, 404, { error: "Approval not found" });
    const body = await readJson(request);
    const explicitOption = typeof body.optionId === "string" ? body.optionId : undefined;
    const selectedByDecision = body.decision === "approve"
      ? approval.options.find((option) => option.kind === "allow_once")?.optionId
        ?? approval.options.find((option) => option.kind?.startsWith("allow"))?.optionId
      : body.decision === "deny"
        ? approval.options.find((option) => option.kind === "reject_once")?.optionId
          ?? approval.options.find((option) => option.kind?.startsWith("reject"))?.optionId
        : undefined;
    approval.respond(explicitOption ?? selectedByDecision);
    return json(response, 200, { resolved: true });
  }
  if (action === "structured-output" && request.method === "GET") {
    const requestId = url.searchParams.get("requestId") || "";
    return json(response, 200, { structuredOutput: state.structured.get(requestId) ?? null });
  }
  if (action === "prompt" && request.method === "POST") {
    const body = await readJson(request);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    const schema = isObject(body.outputSchema) ? body.outputSchema : undefined;
    // Shape validation happens before the turn is claimed: a malformed
    // attachment list is a caller error, not a turn that half-started.
    let attachments;
    try {
      attachments = parsePromptAttachments(body.attachments);
    } catch (error) {
      if (!(error instanceof PromptAttachmentError)) throw error;
      return json(response, 400, { error: error.message });
    }
    if (!prompt && attachments.length === 0) {
      return json(response, 400, { error: "prompt or image attachment is required" });
    }
    if (Buffer.byteLength(requestId) > 512) return json(response, 400, { error: "requestId is too long" });
    if (requestId && state.promptJournal.has(requestId)) {
      const journaled = state.promptJournal.get(requestId)!;
      // A persisted "ambiguous" entry means an earlier bridge process accepted
      // this requestId and died before its outcome was known. Never re-dispatch
      // at-most-once work: refuse plainly so the caller resubmits under a fresh
      // requestId instead of treating an accepted-looking 202 as a running turn
      // that this process will never execute.
      if (journaled.state === "ambiguous") {
        return json(response, 410, {
          error: `${provider} prompt outcome is unknown after a bridge restart; resubmit with a new requestId`,
        });
      }
      return json(response, 202, { accepted: true, duplicate: true });
    }
    if (state.status === "running" || state.dispatching) {
      return json(response, 409, { error: "Session is already running" });
    }
    // Claim the turn synchronously. `ensureSessionProcess` yields even on its
    // attached fast path, so a second request would otherwise pass both the
    // duplicate check and the busy check and dispatch the same prompt twice.
    // `dispatching` is separate from `status` because reattaching a detached
    // thread legitimately sets `status` back to "idle" while we hold the claim.
    state.dispatching = true;
    if (requestId) setPromptJournal(state, {
      requestId,
      state: "accepted",
      acceptedAt: Date.now(),
    });
    let child: AcpProcess;
    let images: AcpPromptImage[];
    try {
      // Read the attachments first: an unreadable image must fail before a
      // detached thread is reattached, and it is far cheaper than a spawn.
      images = await readPromptImages(attachments, workingDirectory);
      child = await ensureSessionProcess(state, clientSignal);
      const promptPatch = parseComposerPatch(body);
      if (promptPatch) await applyComposerPatch(state, promptPatch, clientSignal);
    } catch (error) {
      // The turn definitely did not run, so release the claim and let the
      // caller retry with the same requestId.
      state.dispatching = false;
      if (requestId) state.promptJournal.delete(requestId);
      if (error instanceof PromptAttachmentError) {
        return json(response, 400, { error: error.message });
      }
      throw error;
    }
    const userMessageId = randomBytes(12).toString("hex");
    state.messages.push({
      id: userMessageId, role: "user", content: prompt,
      parts: [
        ...(prompt ? [{
          type: "text" as const,
          content: prompt,
          sourcePartId: `${userMessageId}:0`,
          sourceMessageId: userMessageId,
        }] : []),
        ...images.map((image, index): BridgeFilePart => ({
          type: "file",
          content: image.filename || image.path,
          fileUrl: pathToFileURL(image.absolutePath).href,
          sourcePartId: `${userMessageId}:${index + 1}`,
          sourceMessageId: userMessageId,
        })),
      ], createdAt: new Date().toISOString(),
    });
    state.status = "running";
    state.error = undefined;
    state.outputTruncated = false;
    state.turnStartedAt = Date.now();
    state.currentTurnUsage = {};
    state.currentTurnOutput = schema ? "" : null;
    state.revision += 1;
    boundTranscript(state);
    await persistState();
    const acpPrompt = schema
      ? `${prompt}\n\nReturn only one JSON value matching this JSON Schema. Do not use a Markdown fence or add commentary.\n\n${JSON.stringify(schema)}`
      : prompt;
    // The turn is now dispatched and `status` is "running", so the busy check
    // is authoritative again and the claim can be released.
    state.dispatching = false;
    void child.request("session/prompt", {
      sessionId: state.acpSessionId,
      prompt: [
        ...(acpPrompt ? [{ type: "text", text: acpPrompt }] : []),
        // Inline base64 is the only image form both agents read. Cursor
        // advertises it; Grok understates its own capability but accepts the
        // same block, and neither supports ACP embedded resources.
        ...images.map((image) => ({
          type: "image",
          mimeType: image.mimeType,
          data: image.data,
        })),
      ],
    }, PROMPT_TIMEOUT_MS).then((result) => {
      if (!state.outputTruncated) state.status = "idle";
      // The result `_meta` is the last and most complete usage carrier, so it is
      // read before `turnStartedAt` is cleared and the elapsed time is lost.
      recordTurnUsage(state, isObject(result) ? result._meta : undefined);
      state.turnStartedAt = undefined;
      state.currentTurnUsage = undefined;
      if (schema && requestId) {
        const output = state.currentTurnOutput?.trim() ?? "";
        if (Buffer.byteLength(output) > MAX_STRUCTURED_RESULT_BYTES) {
          setStructuredResult(state, requestId, {
            ok: false,
            provider,
            requestId,
            error: { code: "output_too_large", message: `${provider} returned too much structured output`, provider, retryable: true },
          });
        } else try {
          setStructuredResult(state, requestId, { ok: true, value: JSON.parse(output), provider, requestId });
        } catch {
          setStructuredResult(state, requestId, {
            ok: false,
            provider,
            requestId,
            error: { code: "malformed_output", message: `${provider} returned malformed JSON`, provider, retryable: true },
          });
        }
      }
      if (requestId) setPromptJournal(state, {
        requestId,
        state: state.outputTruncated ? "failed" : "completed",
        acceptedAt: state.promptJournal.get(requestId)?.acceptedAt ?? Date.now(),
      });
      // The turn is over. A tool still in flight here was cancelled or abandoned
      // by the agent — ACP has no status for that, so settle it explicitly.
      reconcileStaleToolParts(state);
      state.currentTurnOutput = null;
      state.revision += 1;
      schedulePersist();
    }, (error: unknown) => {
      state.status = "error";
      state.error = error instanceof Error ? error.message : String(error);
      state.turnStartedAt = undefined;
      state.currentTurnUsage = undefined;
      reconcileStaleToolParts(state);
      if (requestId) setPromptJournal(state, {
        requestId,
        state: "failed",
        acceptedAt: state.promptJournal.get(requestId)?.acceptedAt ?? Date.now(),
      });
      state.currentTurnOutput = null;
      state.revision += 1;
      schedulePersist();
    });
    return json(response, 202, { accepted: true });
  }
  if ((action === "cancel" || action === "abort") && request.method === "POST") {
    for (const approval of [...state.approvals.values()]) approval.respond();
    state.child?.notify("session/cancel", { sessionId: state.acpSessionId });
    return json(response, 202, { accepted: true });
  }
  if (!action && request.method === "DELETE") {
    for (const approval of [...state.approvals.values()]) approval.respond();
    await state.child?.close();
    sessions.delete(state.id);
    if (state.clientSessionKey) clientSessionKeys.delete(state.clientSessionKey);
    await persistState();
    return json(response, 200, { deleted: true });
  }
  return json(response, 405, { error: "Method not allowed" });
}

function authenticated(request: IncomingMessage): boolean {
  const dedicated = request.headers[ACP_TOKEN_HEADER];
  const candidates = [
    Array.isArray(dedicated) ? dedicated[0] : dedicated,
    request.headers.authorization?.replace(/^Bearer\s+/i, ""),
  ];
  const right = Buffer.from(authToken);
  return candidates.some((candidate) => {
    const left = Buffer.from(candidate?.trim() || "");
    return left.length === right.length && timingSafeEqual(left, right);
  });
}

function isTrustedBridgeOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  // Electron's packaged renderer has an opaque origin. The bridge token is
  // still mandatory on every data route, so accepting that origin does not
  // make the loopback API ambiently accessible.
  if (origin === "null" || origin === "file://") return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:")
      && (parsed.hostname === "127.0.0.1"
        || parsed.hostname === "localhost"
        || parsed.hostname === "::1"
        || parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function requestPathname(request: IncomingMessage): string {
  try {
    return new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`,
    ).pathname;
  } catch {
    return "";
  }
}

function applyOriginPolicy(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const origin = request.headers.origin;
  if (!isTrustedBridgeOrigin(origin)) {
    json(response, 403, { error: "Origin is not allowed" });
    return false;
  }
  // `/global/health` answers before the token check so the backend can probe a
  // bridge whose credential it does not hold, and its only client is that
  // non-browser prober. Granting it CORS — and with it a Private Network
  // Access opt-in — would let any page that can produce an accepted origin
  // read it. `null` is an accepted origin, and every public site can mint one
  // through a sandboxed iframe, so the loopback probing PNA exists to prevent
  // would be reachable from the open web. Withhold both headers there; the
  // route stays reachable, its body just stays unreadable to a browser.
  const unauthenticatedRoute = requestPathname(request) === "/global/health";
  if (origin) response.setHeader("Vary", "Origin");
  if (origin && !unauthenticatedRoute) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }
  if (request.method !== "OPTIONS") return true;
  response.writeHead(204, unauthenticatedRoute ? {} : {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": `Content-Type, Authorization, ${ACP_TOKEN_HEADER}`,
    "Access-Control-Allow-Private-Network": "true",
  });
  response.end();
  return false;
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (!isObject(parsed)) throw new HttpError(400, "Expected a JSON object");
  return parsed;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseProvider(value: string | undefined): Provider {
  if (value === "cursor" || value === "grok") return value;
  throw new Error("ACP_PROVIDER must be cursor or grok");
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value || "4099");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("PORT is invalid");
  return parsed;
}

function parseDuration(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 10 ? parsed : fallback;
}

function parseBoundedInteger(
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

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function isVendorModelUpdate(method: string, params: JsonObject): boolean {
  if (method === "x.ai/models/update" || method === "_x.ai/models/update" || method === "cursor/models/update") {
    return true;
  }
  if (method !== "x.ai/session/update" && method !== "_x.ai/session/update" && method !== "cursor/session/update") {
    return false;
  }
  const update = isObject(params.update) ? params.update : params;
  return update.sessionUpdate === "model_changed" || update.sessionUpdate === "models_update";
}

function rememberCatalog(composer: NativeAgentComposerState): void {
  if (composer.models.length === 0 && composer.modes.length === 0) return;
  catalogCache = composer;
}

function composerPatchFromSpawn(options: AcpSpawnOptions & AcpComposerPatch): AcpComposerPatch | undefined {
  const patch: AcpComposerPatch = {};
  if (options.modelId || options.model) patch.modelId = options.modelId ?? options.model;
  if (options.reasoningId || options.effort) patch.reasoningId = options.reasoningId ?? options.effort;
  if (options.fastMode !== undefined) patch.fastMode = options.fastMode;
  if (options.mode) patch.mode = options.mode;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function parseComposerPatch(body: JsonObject): AcpComposerPatch | undefined {
  const mode = body.mode === "plan" || body.mode === "build" ? body.mode : undefined;
  const modelId = typeof body.modelId === "string"
    ? body.modelId.trim()
    : typeof body.model === "string"
      ? body.model.trim()
      : "";
  const reasoningId = typeof body.reasoningId === "string"
    ? body.reasoningId.trim()
    : typeof body.reasoningEffort === "string"
      ? body.reasoningEffort.trim()
      : "";
  const patch: AcpComposerPatch = {
    ...(modelId ? { modelId } : {}),
    ...(reasoningId ? { reasoningId } : {}),
    ...(typeof body.fastMode === "boolean" ? { fastMode: body.fastMode } : {}),
    ...(mode ? { mode } : {}),
  };
  return Object.keys(patch).length > 0 ? patch : undefined;
}

async function applyComposerPatch(
  state: SessionState,
  patch: AcpComposerPatch,
  signal?: AbortSignal,
): Promise<void> {
  if (!patch.modelId && !patch.reasoningId && patch.fastMode === undefined && !patch.mode) return;
  const child = await ensureSessionProcess(state, signal);
  const calls = planComposerApply(state.acpSessionId, state.sessionConfig, patch);
  for (const call of calls) {
    const result = await child.request(call.method, call.params, RPC_TIMEOUT_MS, signal);
    if (call.method === "session/set_config_option") {
      state.sessionConfig = applyConfigOptionUpdate(
        provider,
        state.sessionConfig,
        isObject(result) ? result : {},
      );
    } else if (call.method === "session/set_mode") {
      state.sessionConfig = applyCurrentModeUpdate(state.sessionConfig, call.params.modeId);
    } else if (call.method === "session/set_model") {
      const meta = isObject(result) && isObject(result._meta) ? result._meta : {};
      const model = isObject(meta.model) ? meta.model : {};
      state.sessionConfig = applyGrokModelChange(provider, state.sessionConfig, {
        model_id: typeof model.Ok === "string" ? model.Ok : call.params.modelId,
        reasoning_effort: call.params._meta?.reasoningEffort,
      });
    }
  }
  rememberCatalog(state.sessionConfig.composer);
  state.revision += 1;
  await persistState();
}

function applyVendorUpdate(state: SessionState, method: string, params: JsonObject): void {
  const update = isObject(params.update) ? params.update : params;
  const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
  if (method.endsWith("/models/update") || kind === "models_update") {
    state.sessionConfig = applyGrokCatalogUpdate(provider, state.sessionConfig, update);
    rememberCatalog(state.sessionConfig.composer);
    state.revision += 1;
    schedulePersist();
    return;
  }
  if (kind === "model_changed") {
    state.sessionConfig = applyGrokModelChange(provider, state.sessionConfig, update);
    rememberCatalog(state.sessionConfig.composer);
    state.revision += 1;
    schedulePersist();
    return;
  }
  if (kind !== "turn_completed" && kind !== "response_completed") return;
  // Unlike a model update, this is scoped to one conversation, so a superseded
  // or unrelated child must not write another session's token counts.
  if (params.sessionId !== undefined && params.sessionId !== state.acpSessionId) return;
  recordTurnUsage(state, update);
}

/**
 * Latch the usage an agent reports for the turn that just ended.
 *
 * Grok announces the same numbers up to three times (`response_completed`,
 * `turn_completed`, and the prompt result), each with a different subset of the
 * fields, so later reports merge into earlier ones instead of replacing them —
 * otherwise the panel would lose the reasoning or cache breakdown the moment a
 * sparser carrier arrived for the same turn.
 */
function recordTurnUsage(state: SessionState, payload: unknown): void {
  const turn = parseAcpTurnUsage(payload);
  if (!turn) return;
  const accumulatedTurn = state.turnStartedAt === undefined
    ? { ...(state.usage?.turn ?? {}), ...turn }
    : { ...(state.currentTurnUsage ?? {}), ...turn };
  if (state.turnStartedAt !== undefined) state.currentTurnUsage = accumulatedTurn;
  const durationMs = state.turnStartedAt === undefined
    ? state.usage?.durationMs
    : Math.max(0, Date.now() - state.turnStartedAt);
  const modelId = state.sessionConfig.composer.selectedModelId;
  state.usage = {
    turn: accumulatedTurn,
    ...(modelId ? { modelId } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    updatedAt: new Date().toISOString(),
  };
  state.revision += 1;
  schedulePersist();
}

/**
 * Record what the ACP handshake says about the agent binary. ACP standardizes
 * `agentInfo`; Grok predates that and answers with `_meta.agentVersion`, so both
 * are read and neither is required.
 *
 * The handshake's `_meta.mcpServers` is deliberately ignored: it reflects the
 * servers configured at that instant, which is none, and the agent announces
 * the real inventory moments later. Reporting the handshake value would state
 * that an agent has no MCP servers when it is about to load several.
 */
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

/** Vendor notifications that describe the agent process rather than a session. */
function rememberVendorRuntime(method: string, params: JsonObject): void {
  // The count only. These entries carry launch commands and arguments, which is
  // where an MCP server's API key lives.
  if (!method.endsWith("/mcp/servers_updated") || !Array.isArray(params.mcpServers)) return;
  if (agentRuntime.mcpServers === params.mcpServers.length) return;
  agentRuntime.mcpServers = params.mcpServers.length;
  // Every session reports this count, so every session's snapshot just changed.
  // Without the bump a mounted tab would keep serving the previous inventory
  // until something else happened to move its revision.
  for (const state of sessions.values()) state.revision += 1;
}

function publicRuntime(state: SessionState): NativeAgentRuntimeSummary {
  return {
    ...(agentRuntime.mcpServers === undefined ? {} : { mcpServers: agentRuntime.mcpServers }),
    ...(state.commandCount === undefined ? {} : { commands: state.commandCount }),
    ...(agentRuntime.version ? { version: agentRuntime.version } : {}),
    state: state.status,
  };
}

async function listNormalizedModels(signal?: AbortSignal): Promise<NativeAgentComposerState["models"]> {
  const live = mergeComposerCatalog(provider, [
    ...(catalogCache ? [catalogCache] : []),
    ...[...sessions.values()].map((state) => state.sessionConfig.composer),
  ]);
  if (live.length > 0) return live;
  try {
    const probed = await probeCatalog(signal);
    return probed.models;
  } catch {
    return [];
  }
}

async function probeCatalog(signal?: AbortSignal): Promise<NativeAgentComposerState> {
  if (catalogCache && catalogCache.models.length > 0) return catalogCache;
  if (catalogProbe) return catalogProbe;
  catalogProbe = (async () => {
    const child = new AcpProcess();
    try {
      await child.initialize(signal);
      const created = await child.request(
        "session/new",
        { cwd: workingDirectory, additionalDirectories: [], mcpServers: [] },
        RPC_TIMEOUT_MS,
        signal,
      );
      const sessionConfig = normalizeAcpSessionConfig(provider, created);
      rememberCatalog(sessionConfig.composer);
      if (isObject(created) && typeof created.sessionId === "string") {
        child.notify("session/cancel", { sessionId: created.sessionId });
      }
      return sessionConfig.composer;
    } finally {
      await child.close();
      catalogProbe = null;
    }
  })();
  return catalogProbe;
}

/**
 * Composer configuration is a cache in front of the agent's own catalogue: the
 * next `session/load` re-normalizes it. Malformed configuration therefore
 * resets *that* session's composer and nothing else. Throwing here would take
 * out the whole state file — every other session's transcript and, worse, its
 * prompt journal, which is what keeps a resubmitted requestId from dispatching
 * twice.
 */
function restoreSessionConfig(candidate: JsonObject): AcpNormalizedSessionConfig {
  if (candidate.sessionConfig !== undefined) {
    const restored = parsePersistedAcpSessionConfig(provider, candidate.sessionConfig);
    if (restored) return restored;
    console.warn("[acp-bridge] Resetting a malformed persisted session config");
    return emptySessionConfig();
  }
  if (candidate.composer !== undefined) {
    const composer = parsePersistedComposerState(provider, candidate.composer);
    if (composer) return { ...emptySessionConfig(), composer };
    console.warn("[acp-bridge] Resetting a malformed persisted composer state");
  }
  return emptySessionConfig();
}

/**
 * Re-validate persisted usage through the same parser that accepted it live, so
 * a hand-edited or truncated state file cannot put arbitrary numbers into the
 * panel. Anything unrecognised restores as "no usage reported yet".
 */
function restorePersistedUsage(value: unknown): PersistedUsage | null {
  if (!isObject(value)) return null;
  const turn = parseAcpTurnUsage(value.turn);
  if (!turn || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    return null;
  }
  return {
    turn,
    ...(typeof value.modelId === "string" ? { modelId: value.modelId.slice(0, 1_024) } : {}),
    ...(Number.isSafeInteger(value.durationMs) && Number(value.durationMs) >= 0
      ? { durationMs: Number(value.durationMs) }
      : {}),
    updatedAt: value.updatedAt,
  };
}

function emptySessionConfig(): AcpNormalizedSessionConfig {
  // `emptyComposerState()` rather than a spread of the shared constant: a
  // shallow copy would alias its `models` and `modes` arrays across sessions.
  return {
    composer: emptyComposerState(),
    wire: { configOptions: [], availableModeIds: {}, usesSetModel: false },
  };
}

function persistedSnapshot(): PersistedState {
  return {
    version: 3,
    provider,
    sessions: [...sessions.values()].map((state) => ({
      id: state.id,
      ...(state.clientSessionKey ? { clientSessionKey: state.clientSessionKey } : {}),
      acpSessionId: state.acpSessionId,
      status: state.status === "running" ? "error" : state.status,
      ...(state.status === "running"
        ? { error: `${provider} prompt outcome is unknown after bridge restart` }
        : state.error ? { error: state.error } : {}),
      messages: state.messages,
      revision: state.revision,
      structured: [...state.structured.entries()],
      promptJournal: [...state.promptJournal.values()].map((entry) =>
        entry.state === "accepted" ? { ...entry, state: "ambiguous" as const } : entry
      ),
      sessionConfig: state.sessionConfig,
      composer: state.sessionConfig.composer,
      ...(state.usage ? { usage: state.usage } : {}),
      ...(state.commandCount === undefined ? {} : { commandCount: state.commandCount }),
    })),
  };
}

function schedulePersist(): void {
  if (!stateFile || persistenceScheduled) return;
  persistenceScheduled = true;
  const operation = persistenceTail.then(async () => {
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 25);
      timer.unref();
    });
    persistenceScheduled = false;
    await writePersistedState();
  }, async () => {
    persistenceScheduled = false;
    await writePersistedState();
  });
  persistenceTail = operation.catch(() => undefined);
}

function persistState(): Promise<void> {
  const operation = persistenceTail.then(writePersistedState, writePersistedState);
  persistenceTail = operation.catch(() => undefined);
  return operation;
}

async function writePersistedState(): Promise<void> {
  if (!stateFile) return;
  const payload = `${JSON.stringify(persistedSnapshot())}\n`;
  if (Buffer.byteLength(payload) > MAX_STATE_FILE_BYTES) {
    throw new Error("ACP persisted state exceeds its byte limit");
  }
  await fs.mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, payload, { mode: 0o600 });
  await fs.rename(temporary, stateFile);
}

/**
 * Persisted state is a cache of transcripts, not a source of truth. Refusing to
 * start on a damaged file would be unrecoverable: only a running bridge ever
 * rewrites it, so the environment's bridge would fail on every subsequent start
 * until a human deleted the file. Quarantine it and start clean instead.
 */
async function restorePersistedState(): Promise<void> {
  try {
    await loadPersistedState();
  } catch (error) {
    sessions.clear();
    clientSessionKeys.clear();
    console.warn(
      `[acp-bridge] Discarding unusable persisted state: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (!stateFile) return;
    await fs.rename(stateFile, `${stateFile}.corrupt-${process.pid}`).catch(() =>
      fs.rm(stateFile, { force: true }).catch(() => undefined)
    );
  }
}

async function loadPersistedState(): Promise<void> {
  if (!stateFile) return;
  let bytes: Buffer;
  try {
    const stat = await fs.stat(stateFile);
    if (stat.size > MAX_STATE_FILE_BYTES) throw new Error("ACP persisted state is too large");
    bytes = await fs.readFile(stateFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("ACP persisted state is malformed");
  }
  if (!isObject(parsed)
    || (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3)
    || parsed.provider !== provider
    || !Array.isArray(parsed.sessions)) {
    throw new Error("ACP persisted state is incompatible");
  }
  for (const candidate of parsed.sessions.slice(0, MAX_SESSIONS)) {
    if (!isObject(candidate)
      || typeof candidate.id !== "string"
      || typeof candidate.acpSessionId !== "string"
      || !Array.isArray(candidate.messages)) continue;
    const messages = candidate.messages
      .flatMap((message) => {
        const normalized = normalizeBridgeMessage(message);
        return normalized ? [normalized] : [];
      })
      .slice(-MAX_MESSAGES);
    const usage = restorePersistedUsage(candidate.usage);
    // A session persisted by an older build's fatal transcript trim is healed
    // rather than restored. Trimming an interactive turn is no longer a
    // failure, `boundTranscript` below re-applies the bound to whatever was
    // persisted, and the status is otherwise unclearable: the tab renders it as
    // a connection failure whose only control reads the same state back.
    const healed = candidate.status === "error"
      && typeof candidate.error === "string"
      && candidate.error.endsWith("output exceeded the transcript limit");
    const state: SessionState = {
      id: candidate.id.slice(0, 128),
      ...(typeof candidate.clientSessionKey === "string"
        ? { clientSessionKey: candidate.clientSessionKey.slice(0, 512) }
        : {}),
      acpSessionId: candidate.acpSessionId.slice(0, 512),
      status: healed || candidate.status === "idle" ? "idle" : "error",
      ...(!healed && typeof candidate.error === "string"
        ? { error: candidate.error.slice(0, 4_000) }
        : {}),
      messages,
      child: null,
      revision: Number.isSafeInteger(candidate.revision) ? Number(candidate.revision) : 0,
      structured: new Map(Array.isArray(candidate.structured)
        ? candidate.structured.filter((entry): entry is [string, unknown] =>
            isStringTuple(entry)
            && Buffer.byteLength(JSON.stringify(entry[1])) <= MAX_STRUCTURED_RESULT_BYTES
          ).slice(-MAX_STRUCTURED_RESULTS)
        : []),
      promptJournal: new Map(),
      approvals: new Map(),
      outputTruncated: false,
      uncheckedTranscriptBytes: 0,
      currentTurnOutput: null,
      droppedMessages: 0,
      sessionConfig: restoreSessionConfig(candidate),
      dispatching: false,
      ...(usage ? { usage } : {}),
      ...(Number.isSafeInteger(candidate.commandCount) && Number(candidate.commandCount) >= 0
        ? { commandCount: Number(candidate.commandCount) }
        : {}),
    };
    if (Array.isArray(candidate.promptJournal)) {
      for (const rawEntry of candidate.promptJournal.slice(-MAX_PROMPT_JOURNAL)) {
        if (!isObject(rawEntry) || typeof rawEntry.requestId !== "string") continue;
        const journalState = rawEntry.state;
        if (journalState !== "accepted" && journalState !== "completed" && journalState !== "failed" && journalState !== "ambiguous") continue;
        const entry: PromptJournalEntry = {
          requestId: rawEntry.requestId.slice(0, 512),
          state: journalState === "accepted" ? "ambiguous" : journalState,
          acceptedAt: Number.isSafeInteger(rawEntry.acceptedAt) ? Number(rawEntry.acceptedAt) : 0,
        };
        state.promptJournal.set(entry.requestId, entry);
      }
    }
    boundTranscript(state);
    reconcileStaleToolParts(state);
    rememberCatalog(state.sessionConfig.composer);
    sessions.set(state.id, state);
    if (state.clientSessionKey) clientSessionKeys.set(state.clientSessionKey, state.id);
  }
}

/**
 * Settles every tool part a finished turn left in flight.
 *
 * ACP has no cancelled tool status, so an interrupted turn, a failed prompt and
 * a crashed agent all just stop sending updates. Without this the part keeps the
 * state it had and the tab renders a spinner for the rest of the session. Any
 * state that is not terminal is settled, not only `pending`, so a part left
 * stateless by an unrecognised status is caught too.
 *
 * Every live caller bumps the revision for its own status change already, so
 * this reports nothing back.
 */
function reconcileStaleToolParts(state: SessionState): void {
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-invocation") continue;
      if (part.toolState === "success" || part.toolState === "failure") continue;
      part.toolState = "failure";
      part.toolError = part.toolError ?? "Tool call ended without a result";
      // Keep the render source in step. A late update carrying no status of its
      // own would otherwise re-render this part straight back to `pending`.
      const source = acpToolSourceStates.get(part);
      if (source) source.toolState = "failure";
    }
  }
}

function normalizeBridgeMessage(value: unknown): BridgeMessage | null {
  if (!(isObject(value)
    && typeof value.id === "string"
    && (value.role === "user" || value.role === "assistant")
    && typeof value.content === "string"
    && Array.isArray(value.parts)
    && typeof value.createdAt === "string")) return null;
  const messageId = value.id.slice(0, 256);
  const modelId = boundedModelId(value.modelId);
  return {
    id: messageId,
    role: value.role,
    content: truncateUtf8(value.content, MAX_MESSAGE_TEXT_BYTES),
    parts: value.parts
      .slice(-MAX_PARTS_PER_MESSAGE)
      .flatMap((part, index) => {
        const normalized = normalizeBridgePart(part, index, messageId);
        return normalized ? [normalized] : [];
      }),
    createdAt: value.createdAt.slice(0, 64),
    ...(modelId ? { modelId } : {}),
  };
}

function normalizeBridgePart(
  value: unknown,
  index: number,
  messageId: string,
): BridgeMessagePart | null {
  if (!isObject(value)) return null;
  const sourcePartId = typeof value.sourcePartId === "string"
    ? value.sourcePartId.slice(0, 1024)
    : `${messageId}:${index}`;
  const sourceMessageId = typeof value.sourceMessageId === "string"
    ? value.sourceMessageId.slice(0, 256)
    : messageId;

  if (value.type === "text" || value.type === "reasoning" || value.type === "thinking") {
    const content = typeof value.content === "string"
      ? value.content
      : typeof value.text === "string"
        ? value.text
        : undefined;
    if (content === undefined) return null;
    return {
      type: value.type === "reasoning" ? "thinking" : value.type,
      content: truncateUtf8(content, MAX_MESSAGE_TEXT_BYTES),
      sourcePartId,
      sourceMessageId,
    };
  }

  if (value.type === "file") {
    const content = boundedString(value.content, MAX_TOOL_PATH_BYTES);
    if (!content) return null;
    const fileUrl = boundedString(value.fileUrl, MAX_TOOL_PATH_BYTES);
    return {
      type: "file",
      content,
      ...(fileUrl ? { fileUrl } : {}),
      sourcePartId,
      sourceMessageId,
    };
  }

  if (value.type !== "tool-invocation" || typeof value.toolUseId !== "string") return null;
  const toolUseId = truncateUtf8(value.toolUseId, MAX_TOOL_ID_BYTES);
  if (!toolUseId) return null;
  const toolState = value.toolState === "success"
    || value.toolState === "failure"
    || value.toolState === "pending"
    ? value.toolState
    : undefined;
  const toolOutput = boundedString(value.toolOutput, MAX_TOOL_OUTPUT_BYTES);
  const toolError = boundedString(value.toolError, MAX_TOOL_OUTPUT_BYTES);
  const toolDiff = normalizeBridgeToolDiff(value.toolDiff);
  const toolName = boundedString(value.toolName, MAX_TOOL_NAME_BYTES);
  const toolTitle = boundedString(value.toolTitle, MAX_TOOL_TITLE_BYTES);
  return {
    type: "tool-invocation",
    content: boundedString(value.content, MAX_TOOL_TITLE_BYTES) ?? "Tool call",
    sourcePartId,
    sourceMessageId,
    toolUseId,
    ...(toolName ? { toolName } : {}),
    ...(isObject(value.toolArgs) ? { toolArgs: boundedToolArguments(value.toolArgs) } : {}),
    ...(toolState ? { toolState } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(toolOutput !== undefined ? { toolOutput } : {}),
    ...(toolError !== undefined ? { toolError } : {}),
    ...(toolDiff ? { toolDiff } : {}),
  };
}

function normalizeBridgeToolDiff(value: unknown): BridgeToolDiff | undefined {
  if (!isObject(value)) return undefined;
  const filePath = boundedString(value.filePath, MAX_TOOL_PATH_BYTES);
  const rawBefore = typeof value.before === "string" ? value.before : undefined;
  const rawAfter = typeof value.after === "string" ? value.after : undefined;
  const keepInline = Buffer.byteLength(rawBefore ?? "") <= MAX_TOOL_INLINE_FILE_BYTES
    && Buffer.byteLength(rawAfter ?? "") <= MAX_TOOL_INLINE_FILE_BYTES;
  const before = keepInline ? rawBefore : undefined;
  const after = keepInline ? rawAfter : undefined;
  const additions = Number.isSafeInteger(value.additions) && Number(value.additions) >= 0
    ? Number(value.additions)
    : undefined;
  const deletions = Number.isSafeInteger(value.deletions) && Number(value.deletions) >= 0
    ? Number(value.deletions)
    : undefined;
  const diff = boundedString(value.diff, MAX_TOOL_DIFF_BYTES);
  if (!filePath && additions === undefined && deletions === undefined
    && before === undefined && after === undefined && diff === undefined) return undefined;
  return {
    ...(filePath ? { filePath } : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    ...(keepInline && before !== undefined ? { before } : {}),
    ...(keepInline && after !== undefined ? { after } : {}),
    ...(diff !== undefined ? { diff } : {}),
  };
}

function isStringTuple(value: unknown): value is [string, unknown] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
}

await restorePersistedState();

const server = createServer((request, response) => {
  if (!applyOriginPolicy(request, response)) return;
  const controller = new AbortController();
  const abortDisconnectedClient = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", abortDisconnectedClient);
  request.socket.once("end", abortDisconnectedClient);
  request.socket.once("close", abortDisconnectedClient);
  response.once("close", abortDisconnectedClient);
  const disconnectPoll = setInterval(() => {
    if (request.socket.destroyed || !request.socket.writable) abortDisconnectedClient();
  }, 50);
  disconnectPoll.unref();
  void route(request, response, controller.signal)
    .catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      json(response, status, { error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      clearInterval(disconnectPoll);
      request.off("aborted", abortDisconnectedClient);
      request.socket.off("end", abortDisconnectedClient);
      request.socket.off("close", abortDisconnectedClient);
      response.off("close", abortDisconnectedClient);
    });
});

server.listen(port, hostname, () => console.log(`ACP bridge (${provider}) listening on ${hostname}:${port}`));

let shutdownPromise: Promise<void> | null = null;
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    for (const state of sessions.values()) {
      for (const approval of [...state.approvals.values()]) approval.respond();
    }
    await Promise.allSettled([...sessions.values()].map((state) => state.child?.close()));
    await persistenceTail.catch(() => undefined);
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  })();
  return shutdownPromise;
}

const parentPid = parseParentPid(process.env[PARENT_PID_ENV]);
if (parentPid !== null) {
  startParentWatchdog({
    parentPid,
    pollIntervalMs: PARENT_WATCHDOG_INTERVAL_MS,
    onParentExit: () => {
      void shutdown().finally(() => process.exit(0));
    },
  });
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown().then(() => process.exit(0), () => process.exit(1));
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
