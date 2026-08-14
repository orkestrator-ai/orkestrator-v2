import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import {
  PARENT_PID_ENV,
  parseParentPid,
  startParentWatchdog,
} from "@orkestrator/protocol/parent-watchdog";
import type { NativeAgentComposerState } from "@orkestrator/protocol/native-agent";
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

type Provider = "cursor" | "grok";
type JsonObject = Record<string, unknown>;
type SessionStatus = "idle" | "running" | "error";

interface BridgeMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: Array<{
    type: "text" | "thinking";
    content: string;
    sourcePartId: string;
    sourceMessageId: string;
  }>;
  createdAt: string;
}

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
}

interface PersistedState {
  version: 2;
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
const stateDirectory = process.env.ACP_STATE_DIR?.trim();
const stateFile = stateDirectory ? resolve(stateDirectory, "state.json") : null;
const sessions = new Map<string, SessionState>();
const clientSessionKeys = new Map<string, string>();
const sessionCreations = new Map<string, Promise<SessionState>>();
let anonymousSessionCreations = 0;
let persistenceTail = Promise.resolve();
let persistenceScheduled = false;
let shuttingDown = false;
let catalogCache: NativeAgentComposerState | null = null;
let catalogProbe: Promise<NativeAgentComposerState> | null = null;

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
    const args = provider === "cursor"
      ? [...(spawnOptions.model ? ["--model", spawnOptions.model] : []), "acp"]
      : [
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
    return isObject(result) ? result : {};
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
      if (isVendorModelUpdate(message.method, params)) this.onVendor(message.method, params);
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
  if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") return;
  const text = contentText(update.content);
  if (!text) return;
  let message = state.messages.at(-1);
  if (!message || message.role !== "assistant" || state.status !== "running") {
    message = {
      id: randomBytes(12).toString("hex"),
      role: "assistant",
      content: "",
      parts: [],
      createdAt: new Date().toISOString(),
    };
    state.messages.push(message);
  }
  const partType = kind === "agent_thought_chunk" ? "thinking" : "text";
  const previous = message.parts.at(-1);
  if (previous?.type !== partType && message.parts.length >= MAX_PARTS_PER_MESSAGE) {
    state.outputTruncated = true;
    state.status = "error";
    state.error = `${provider} output exceeded the transcript limit`;
    state.child?.notify("session/cancel", { sessionId: state.acpSessionId });
    state.revision += 1;
    schedulePersist();
    return;
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
  if (nextPartText.truncated || nextContent.truncated || transcriptTruncated) {
    state.outputTruncated = true;
    state.status = "error";
    state.error = `${provider} output exceeded the transcript limit`;
    state.child?.notify("session/cancel", { sessionId: state.acpSessionId });
  }
  schedulePersist();
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
  const usable = Math.max(0, remaining - markerBytes);
  return {
    value: current + truncateUtf8(addition, usable) + (remaining >= markerBytes ? marker : ""),
    truncated: true,
  };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const encoded = Buffer.from(value);
  if (encoded.length <= maximumBytes) return value;
  return new TextDecoder("utf-8", { fatal: false }).decode(encoded.subarray(0, maximumBytes));
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
    onlyMessage.parts.shift();
    truncatedCurrentMessage = true;
    bytes = Buffer.byteLength(JSON.stringify(state.messages));
  }
  if (bytes > MAX_TRANSCRIPT_BYTES) {
    state.outputTruncated = true;
    state.status = "error";
    state.error = `${provider} output exceeded the transcript limit`;
    truncatedCurrentMessage = true;
  }
  return truncatedCurrentMessage;
}

function publicSession(state: SessionState): JsonObject {
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
  };
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
    if (!prompt) return json(response, 400, { error: "prompt is required" });
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
    try {
      child = await ensureSessionProcess(state, clientSignal);
      const promptPatch = parseComposerPatch(body);
      if (promptPatch) await applyComposerPatch(state, promptPatch, clientSignal);
    } catch (error) {
      // The turn definitely did not run, so release the claim and let the
      // caller retry with the same requestId.
      state.dispatching = false;
      if (requestId) state.promptJournal.delete(requestId);
      throw error;
    }
    const userMessageId = randomBytes(12).toString("hex");
    state.messages.push({
      id: userMessageId, role: "user", content: prompt,
      parts: [{
        type: "text",
        content: prompt,
        sourcePartId: `${userMessageId}:0`,
        sourceMessageId: userMessageId,
      }], createdAt: new Date().toISOString(),
    });
    state.status = "running";
    state.error = undefined;
    state.outputTruncated = false;
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
      prompt: [{ type: "text", text: acpPrompt }],
    }, PROMPT_TIMEOUT_MS).then(() => {
      if (!state.outputTruncated) state.status = "idle";
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
      state.currentTurnOutput = null;
      state.revision += 1;
      schedulePersist();
    }, (error: unknown) => {
      state.status = "error";
      state.error = error instanceof Error ? error.message : String(error);
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
  } else if (kind === "model_changed") {
    state.sessionConfig = applyGrokModelChange(provider, state.sessionConfig, update);
    rememberCatalog(state.sessionConfig.composer);
    state.revision += 1;
    schedulePersist();
  }
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
    version: 2,
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
  if (!isObject(parsed) || (parsed.version !== 1 && parsed.version !== 2) || parsed.provider !== provider || !Array.isArray(parsed.sessions)) {
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
    const state: SessionState = {
      id: candidate.id.slice(0, 128),
      ...(typeof candidate.clientSessionKey === "string"
        ? { clientSessionKey: candidate.clientSessionKey.slice(0, 512) }
        : {}),
      acpSessionId: candidate.acpSessionId.slice(0, 512),
      status: candidate.status === "idle" || candidate.status === "error" ? candidate.status : "error",
      ...(typeof candidate.error === "string" ? { error: candidate.error.slice(0, 4_000) } : {}),
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
    rememberCatalog(state.sessionConfig.composer);
    sessions.set(state.id, state);
    if (state.clientSessionKey) clientSessionKeys.set(state.clientSessionKey, state.id);
  }
}

function normalizeBridgeMessage(value: unknown): BridgeMessage | null {
  if (!(isObject(value)
    && typeof value.id === "string"
    && (value.role === "user" || value.role === "assistant")
    && typeof value.content === "string"
    && Array.isArray(value.parts)
    && value.parts.every((part) => isObject(part)
      && (part.type === "text" || part.type === "reasoning" || part.type === "thinking")
      && (typeof part.text === "string" || typeof part.content === "string"))
    && typeof value.createdAt === "string")) return null;
  return {
    id: value.id.slice(0, 256),
    role: value.role,
    content: truncateUtf8(value.content, MAX_MESSAGE_TEXT_BYTES),
    parts: value.parts.slice(-MAX_PARTS_PER_MESSAGE).map((part, index) => ({
      type: part.type === "reasoning" ? "thinking" as const : part.type as "text" | "thinking",
      content: truncateUtf8(
        typeof part.content === "string" ? part.content : part.text as string,
        MAX_MESSAGE_TEXT_BYTES,
      ),
      sourcePartId: typeof part.sourcePartId === "string" ? part.sourcePartId : `${value.id}:${index}`,
      sourceMessageId: typeof part.sourceMessageId === "string" ? part.sourceMessageId : value.id,
    })),
    createdAt: value.createdAt.slice(0, 64),
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
