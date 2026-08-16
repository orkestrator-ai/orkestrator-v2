import { execFile as execFileCallback } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { isJsonSchema } from "@orkestrator/protocol/structured-output";
import {
  boundTranscriptResponse,
  type TranscriptWindowMetadata,
} from "@orkestrator/protocol/transcript-window";
import { streamSSE } from "hono/streaming";
import { readCachedTranscript } from "./transcript-cache.js";
import {
  applyCodexCollabStateToSubagentParts,
  CODEX_TIMELINE_ITEM_PREFIX,
  CODEX_TIMELINE_SUBAGENT_PREFIX,
  getCodexSpawnedAgentIdsInOrder,
  normalizeCodexCollabToolCallItem,
  reconcileCodexSubagentTimeline,
  type CodexCollabToolCallItem,
} from "./codex-collaboration.js";
import {
  buildFallbackSessionTitle,
  generateSessionTitleWithCodexExec,
  persistSessionTitle,
  readPersistedSessionTitleEntries,
  shutdownSessionTitleGeneration,
  type PersistedSessionTitleSource,
} from "./session-titles.js";
import { AppServerRuntime } from "./app-server-runtime.js";
import {
  AppServerEngine,
  type AppServerEngineOptions,
} from "./engine/app-server-engine.js";
import { codexAppServerConfigOverrides } from "./codex-config.js";
import { APPROVAL_DECISIONS, isApprovalDecision } from "./app-server/approvals.js";
import {
  parseInteractionAnswer,
  type InteractionAnswer,
} from "./app-server/interactions.js";
import { EventRing, parseEventCursor } from "./event-ring.js";
import {
  BUILTIN_SLASH_COMMANDS,
  buildPromptInput,
  expandPromptTemplate,
  getAvailableSlashCommandDefinitions,
  isCodexCliNativeSlashCommand,
  parseSlashCommandPrompt,
  resolveConversationMode,
  runInlinePromptCommand,
  serializeSlashCommand,
  wrapPromptForConversationMode,
  type BridgeSlashCommand,
  type BuiltinSlashCommand,
  type ConversationMode,
  type PromptSlashCommand,
  type SlashCommandDefinition,
} from "./prompts/slash-commands.js";
import {
  PARENT_PID_ENV,
  parseParentPid,
  startParentWatchdog,
} from "@orkestrator/protocol/parent-watchdog";
import {
  buildTranscriptCatalog,
  createSharedTranscriptMetaLoader,
  extractPersistedMessageText,
  getCodexHomeDir,
  getPersistedSessionMeta,
  getWorkingDirectory,
  hydrateMessagesFromPersistedSession,
  listPersistedSessionsForCwd,
  mergePersistedSessionMeta,
  type PersistedSessionMeta,
} from "./history/rollout.js";
import {
  itemToParts as renderItemToParts,
  readTextFileIfPresent,
  stringifyUnknown as stringifyUnknownValue,
} from "./messages/normalization.js";
import type {
  FileChangeDiffContext,
  MessageRole,
  NormalizedMessage,
  NormalizedPart,
  ToolDiffMetadata,
} from "./messages/types.js";
import {
  DEFAULT_REASONING_EFFORT,
  MODEL_REASONING_EFFORTS,
  ModelCatalogCache,
  REASONING_DESCRIPTIONS,
  REASONING_LABELS,
  normalizeReasoningOptions,
  parseModelCatalog,
  type BridgeModel,
  type BridgeReasoningEffort,
} from "./models-cache.js";
import {
  applyRuntimeEnvironmentOutput,
  refreshRuntimeEnvironment,
} from "./runtime-env.js";

// The normalized message model and the item renderer live in ./messages so both
// engines share one implementation. Re-exported here because existing importers
// (and item-to-parts.test.ts) resolve them from this module.
export { itemToParts, stringifyUnknown } from "./messages/normalization.js";
export type {
  FileChangeDiffContext,
  MessageRole,
  NormalizedMessage,
  NormalizedPart,
  ToolDiffMetadata,
  ToolState,
} from "./messages/types.js";

interface SseEvent {
  type:
    | "session.updated"
    | "session.idle"
    | "session.error"
    | "session.warning"
    | "session.title-updated"
    | "session.structured-output"
    | "message.updated"
    | "message.patched"
    | "session.approval-requested"
    | "session.approval-resolved"
    | "session.interaction-requested"
    | "session.interaction-resolved"
    /** Emitted when a reconnecting client's cursor has aged out of the ring. */
    | "session.reconcile-required";
  sessionId?: string;
  data?: Record<string, unknown>;
}

interface PromptAttachmentInput {
  type: "image";
  path: string;
  dataUrl?: string;
  filename?: string;
}


export const app = new Hono();
export const MAX_CODEX_TRANSCRIPT_RESPONSE_BYTES = 16 * 1024 * 1024;

export function boundCodexTranscriptResponse(messages: NormalizedMessage[]): {
  messages: NormalizedMessage[];
  messageWindow: TranscriptWindowMetadata;
} {
  const { messages: bounded, messageWindow } = boundTranscriptResponse(
    messages,
    MAX_CODEX_TRANSCRIPT_RESPONSE_BYTES,
  );
  return { messages: bounded, messageWindow };
}
const BRIDGE_TOKEN_ENV = "CODEX_BRIDGE_TOKEN";
const BRIDGE_ALLOWED_ORIGINS_ENV = "CODEX_BRIDGE_ALLOWED_ORIGINS";
let bridgeAuthToken =
  process.env[BRIDGE_TOKEN_ENV]?.trim() || randomBytes(32).toString("base64url");
let bridgeAuthEnabledOverrideForTesting: boolean | null = null;
/** Overridden in tests so title generation does not spawn a real `codex exec`. */
type SessionTitleGenerator = (prompt: string) => Promise<string>;
let sessionTitleGeneratorForTesting: SessionTitleGenerator | null = null;
interface SseRouteTestHooks {
  afterSubscriberRegistered?: () => Promise<void> | void;
  beforeBufferedDrain?: () => Promise<void> | void;
  beforeBufferedWrite?: (revision: number) => Promise<void> | void;
  afterKeepaliveStarted?: () => Promise<void> | void;
  maxBufferedReplayEvents?: number;
}
let sseRouteTestHooks: SseRouteTestHooks | null = null;
function setSessionTitleGeneratorForTesting(generator: SessionTitleGenerator | null): void {
  sessionTitleGeneratorForTesting = generator;
}
const codexPathOverride = process.env.CODEX_PATH || "codex";
/**
 * The bridge's own version, reported through /global/health. Held at 1.0.0 so the
 * health payload stays a purely additive change for existing clients.
 */
const BRIDGE_VERSION = "1.0.0";
const execFile = promisify(execFileCallback);
type SseSubscriber = (
  event: SseEvent,
  revision: number,
  serializedData: string,
) => Promise<void> | void;
const subscribers = new Set<SseSubscriber>();
export const MAX_REPLAY_SSE_BYTES = 4 * 1024 * 1024;
export const REPLAY_IDLE_RETENTION_MS = 60_000;
/** Flat cost charged to a collapsed frame, which carries no payload. */
const SUPERSEDED_FRAME_BYTES = 64;
interface RetainedSseEvent {
  type: SseEvent["type"];
  sessionId?: string;
  /** Present for `message.updated`, so a newer snapshot can collapse this one. */
  messageId?: string;
  /** Set once a newer full snapshot for the same message replaced this payload. */
  superseded?: boolean;
  /**
   * Produces the wire payload on demand.
   *
   * Lazy for a frame nobody was listening for: with no tab attached, a background
   * turn's ~10 coalesced snapshots a second would otherwise each be encoded in
   * full — megabytes at a time — purely to be retained and then evicted.
   */
  serialize: () => string;
  bytes: number;
}

/**
 * Collapses an older `message.updated` frame once a newer one is retained.
 *
 * `message.updated` carries a **full** snapshot, so the older frame holds nothing
 * the newer one does not. The entry is kept — with its revision — and only its
 * payload is dropped, which preserves revision continuity and therefore
 * `since()`'s completeness check while collapsing the dominant event type to a
 * few hundred bytes. A retained tombstone is always followed by the newer full
 * frame, because eviction is oldest-first: the successor cannot be dropped while
 * its predecessor survives.
 */
function supersedeRetainedSseEvent(
  incoming: RetainedSseEvent,
  retained: RetainedSseEvent,
): RetainedSseEvent | null {
  if (incoming.type !== "message.updated" || retained.type !== "message.updated") return null;
  if (!incoming.messageId || incoming.messageId !== retained.messageId) return null;
  if (incoming.sessionId !== retained.sessionId) return null;
  // Already collapsed: returned rather than skipped so the ring's newest-first
  // scan stops here instead of walking back over frames it has already handled.
  if (retained.superseded) return retained;
  return {
    type: retained.type,
    sessionId: retained.sessionId,
    messageId: retained.messageId,
    superseded: true,
    serialize: () => "{}",
    bytes: SUPERSEDED_FRAME_BYTES,
  };
}

/**
 * Retains immutable wire payloads rather than mutable message objects.
 *
 * The byte limit matters more than the frame count for growing message snapshots:
 * 512 cumulative multi-megabyte strings would otherwise consume gigabytes.
 */
function createReplayEventRing(): EventRing<RetainedSseEvent> {
  return new EventRing<RetainedSseEvent>(undefined, {
    maxBytes: MAX_REPLAY_SSE_BYTES,
    measureBytes: (event) => event.bytes,
    supersede: supersedeRetainedSseEvent,
  });
}
// `let` only so a test can swap in an isolated ring; nothing in the bridge
// replaces it at runtime.
let eventRing = createReplayEventRing();
let replayRetentionEnabled = true;
let replayRetentionSubscribers = 0;
let replayRetentionTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleReplayRetentionDrop(): void {
  if (replayRetentionTimer) return;
  replayRetentionTimer = setTimeout(() => {
    replayRetentionTimer = undefined;
    if (replayRetentionSubscribers > 0) return;
    replayRetentionEnabled = false;
    eventRing.clear();
  }, REPLAY_IDLE_RETENTION_MS);
  replayRetentionTimer.unref?.();
}

function acquireReplayRetention(): () => void {
  replayRetentionSubscribers += 1;
  replayRetentionEnabled = true;
  if (replayRetentionTimer) {
    clearTimeout(replayRetentionTimer);
    replayRetentionTimer = undefined;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    replayRetentionSubscribers -= 1;
    if (replayRetentionSubscribers === 0) scheduleReplayRetentionDrop();
  };
}

// A bridge that never receives a browser connection should eventually have the
// same zero-retention background cost as the pre-replay implementation.
scheduleReplayRetentionDrop();
/** Interval for the idle-thread sweep. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const codexRawLogDir = normalizeOptionalEnvPath("ORKESTRATOR_CODEX_RAW_LOG_DIR");
const RECOVERY_TRANSCRIPT_CHAR_LIMIT = 40_000;

function normalizeOptionalEnvPath(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function isBridgeAuthEnabled(): boolean {
  if (bridgeAuthEnabledOverrideForTesting !== null) {
    return bridgeAuthEnabledOverrideForTesting;
  }
  // Route tests explicitly opt out because they exercise route mapping rather
  // than process authentication. This escape hatch is inert for a real server.
  return !(
    process.env.CODEX_BRIDGE_NO_SERVER === "1"
    && process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING === "1"
  );
}

function tokenMatches(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(bridgeAuthToken);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function isTrustedBridgeOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  // Electron's packaged file renderer can be represented as a null origin.
  // Authentication is still mandatory, so allowing it does not grant access.
  if (origin === "null" || origin === "file://") return true;
  const configured = (process.env[BRIDGE_ALLOWED_ORIGINS_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (configured.includes(origin.replace(/\/$/, ""))) return true;
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

function isPublicHealthRequest(method: string, path: string): boolean {
  return method === "GET" && path === "/global/health";
}

function sanitizeLogFileComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeLogPayload(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return stringifyUnknownValue(value);
  }
}

async function writeCodexRawLog(
  sessionId: string,
  entry: Record<string, unknown>,
  logDir: string | null = codexRawLogDir,
): Promise<void> {
  if (!logDir) {
    return;
  }

  try {
    await mkdir(logDir, { recursive: true });
    const filename = `${sanitizeLogFileComponent(sessionId)}.jsonl`;
    await appendFile(
      join(logDir, filename),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId,
        ...entry,
      })}\n`,
      "utf8",
    );
  } catch (error) {
    console.error("[codex-bridge] Failed to write raw Codex log:", error);
  }
}

function createShutdownHandler(
  timer: ReturnType<typeof setInterval>,
  clearTimer: (timer: ReturnType<typeof setInterval>) => void = clearInterval,
  exit: (code: number) => void = (code) => process.exit(code),
  shutdownTitles: () => Promise<void> = shutdownSessionTitleGeneration,
  /**
   * Drains the persistent app-server child. Without this a `docker stop` or a
   * backend-issued SIGTERM would leave an orphan holding the same CODEX_HOME —
   * and, because the child owns a process group, its background terminals too.
   */
  stopEngine: () => Promise<void> = () => stopSelectedEngine(),
): () => void {
  let shuttingDown = false;
  return () => {
    // A second signal during a slow drain must not race the first.
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimer(timer);
    void Promise.allSettled([
      shutdownTitles().catch((error) => {
        console.warn("[codex-bridge] Failed to stop session-title generation:", error);
      }),
      stopEngine().catch((error) => {
        console.warn("[codex-bridge] Failed to stop the Codex engine:", error);
      }),
    ]).finally(() => exit(0));
  };
}

const FALLBACK_MODELS: BridgeModel[] = [
  {
    id: "gpt-5.4",
    name: "gpt-5.4",
    description: "Latest frontier agentic coding model.",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    reasoningOptions: [
      {
        effort: "low",
        label: REASONING_LABELS.low,
        description: REASONING_DESCRIPTIONS.low,
      },
      {
        effort: "medium",
        label: REASONING_LABELS.medium,
        description: REASONING_DESCRIPTIONS.medium,
      },
      {
        effort: "high",
        label: REASONING_LABELS.high,
        description: REASONING_DESCRIPTIONS.high,
      },
      {
        effort: "xhigh",
        label: REASONING_LABELS.xhigh,
        description: REASONING_DESCRIPTIONS.xhigh,
      },
    ],
    defaultReasoningEffort: "high",
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4-Mini",
    description: "Smaller frontier agentic coding model.",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    reasoningOptions: [
      {
        effort: "low",
        label: REASONING_LABELS.low,
        description: REASONING_DESCRIPTIONS.low,
      },
      {
        effort: "medium",
        label: REASONING_LABELS.medium,
        description: REASONING_DESCRIPTIONS.medium,
      },
      {
        effort: "high",
        label: REASONING_LABELS.high,
        description: REASONING_DESCRIPTIONS.high,
      },
      {
        effort: "xhigh",
        label: REASONING_LABELS.xhigh,
        description: REASONING_DESCRIPTIONS.xhigh,
      },
    ],
    defaultReasoningEffort: "high",
  },
];

/**
 * Publishes an event to every live subscriber and retains it for replay.
 *
 * The revision is assigned *before* fan-out so a subscriber added mid-flight can
 * tell what it has already seen. Fan-out stays fire-and-forget: a slow browser
 * must never back-pressure the reducer that called this.
 */
function serializeSseEventData(
  event: Pick<SseEvent, "sessionId"> & { data?: Record<string, unknown> },
): string {
  try {
    return JSON.stringify({
      sessionId: event.sessionId,
      ...(event.data ?? {}),
    });
  } catch (error) {
    // A payload that cannot be encoded (a cycle, a throwing getter, a BigInt)
    // must not propagate back into the reducer — and through it the app-server
    // read loop — that emitted it, and must not break the revision sequence every
    // client's cursor depends on. Emit a placeholder and keep going.
    // The thrown value can originate from a payload getter. Never copy it into
    // logs, which must not contain prompts, file contents, or attachment data.
    console.error("[codex-bridge] Failed to serialize an SSE payload");
    return JSON.stringify({
      sessionId: event.sessionId,
      error: "payload could not be serialized",
    });
  }
}

/**
 * Cheap immutable snapshot of an event's payload, taken synchronously.
 *
 * The retained frame must not change when the canonical message object is
 * mutated afterwards — that is why the previous implementation encoded eagerly.
 * Copying is enough to keep that property here: `publishAssistantMessage` mutates
 * a message purely by **assignment** (`message.parts = …`, `message.content = …`),
 * and every `NormalizedPart` is built fresh per render and replaced rather than
 * edited in place (`reconcileCodexSubagentTimeline` re-`set`s each part; the
 * completed-item cache stores arrays it never revisits). So copying the data
 * object, the message object and its parts array pins everything reachable that
 * can change.
 *
 * The copy is O(parts) pointer writes. The encoding it defers is O(payload
 * bytes) — megabytes, ~10 times a second, for a tab that may not be attached.
 */
function snapshotSseEventPayload(event: SseEvent): Record<string, unknown> {
  if (!event.data) return {};
  const snapshot: Record<string, unknown> = { ...event.data };
  const message = snapshot.message;
  if (message && typeof message === "object") {
    const copy = { ...(message as Record<string, unknown>) };
    if (Array.isArray(copy.parts)) copy.parts = [...copy.parts];
    snapshot.message = copy;
  }
  return snapshot;
}

/** Depth beyond which a payload is charged a flat cost rather than walked. */
const SSE_ESTIMATE_MAX_DEPTH = 8;
const SSE_ESTIMATE_NODE_BYTES = 16;

/**
 * Approximates a payload's encoded size without encoding it.
 *
 * Reading `String#length` is free; `JSON.stringify` allocates the whole payload
 * a second time. The result is deliberately approximate — it counts UTF-16 units
 * rather than UTF-8 bytes and ignores escaping — which is the right trade for a
 * memory *budget*: the ring's frame-count cap is the hard bound, and the byte cap
 * only has to be in the right order of magnitude.
 */
function estimateSsePayloadBytes(value: unknown, depth = 0): number {
  if (typeof value === "string") return value.length + 2;
  if (value === null || typeof value !== "object") return SSE_ESTIMATE_NODE_BYTES;
  if (depth >= SSE_ESTIMATE_MAX_DEPTH) return SSE_ESTIMATE_NODE_BYTES;
  let total = SSE_ESTIMATE_NODE_BYTES;
  if (Array.isArray(value)) {
    for (const entry of value) total += estimateSsePayloadBytes(entry, depth + 1);
    return total;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    total += key.length + 3 + estimateSsePayloadBytes(entry, depth + 1);
  }
  return total;
}

/** The message a `message.updated` frame carries, if it is identifiable. */
function retainedMessageId(
  type: SseEvent["type"],
  payload: Record<string, unknown>,
): string | undefined {
  if (type !== "message.updated") return undefined;
  const message = payload.message;
  if (!message || typeof message !== "object") return undefined;
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function emit(event: SseEvent): void {
  if (!replayRetentionEnabled) {
    // Preserve the cursor gap without snapshotting, estimating, stringifying or
    // retaining a payload nobody can replay. A returning client sees the
    // advanced revision and is sent through authoritative reconciliation.
    eventRing.advance();
    return;
  }
  const sessionId = event.sessionId;
  let payload: Record<string, unknown>;
  let eager: string | null;
  let messageId: string | undefined;
  let bytes: number;
  try {
    payload = snapshotSseEventPayload(event);
    // Encoded up front only when a live subscriber needs the string anyway; that
    // string is then reused by replay, so an attached client pays nothing extra.
    // With nobody attached the encoding is deferred to a replay that will usually
    // never happen, because the next snapshot for this message collapses this one.
    eager =
      subscribers.size > 0 ? serializeSseEventData({ sessionId, data: payload }) : null;
    messageId = retainedMessageId(event.type, payload);
    bytes =
      eager === null
        ? estimateSsePayloadBytes(payload)
        : Buffer.byteLength(eager, "utf8");
  } catch {
    // Snapshotting and size estimation also walk untrusted payloads. Accessors
    // can throw before JSON.stringify gets its chance to contain them, so retain
    // the same placeholder and still advance the bridge-wide cursor.
    // As above, the thrown value is payload-controlled and must not reach logs.
    console.error("[codex-bridge] Failed to snapshot an SSE payload");
    payload = { error: "payload could not be serialized" };
    eager =
      subscribers.size > 0 ? serializeSseEventData({ sessionId, data: payload }) : null;
    messageId = undefined;
    bytes =
      eager === null
        ? estimateSsePayloadBytes(payload)
        : Buffer.byteLength(eager, "utf8");
  }
  const revision = eventRing.append({
    type: event.type,
    sessionId,
    messageId,
    // Deliberately not memoized on the lazy path: caching the string here would
    // retain bytes the ring's budget never accounted for.
    serialize: () => eager ?? serializeSseEventData({ sessionId, data: payload }),
    bytes,
  });
  for (const subscriber of subscribers) {
    try {
      void Promise.resolve(subscriber(event, revision, eager ?? "{}")).catch((error) => {
        console.error("[codex-bridge] Failed to notify SSE subscriber:", error);
      });
    } catch (error) {
      console.error("[codex-bridge] Failed to notify SSE subscriber:", error);
    }
  }
}

function createSessionId(): string {
  return `session-${crypto.randomUUID()}`;
}

function createMessageId(): string {
  return `msg-${crypto.randomUUID()}`;
}

function bridgeCacheDir(): string {
  return join(getCodexHomeDir(), "orkestrator-bridge");
}

function bridgeCachePath(): string {
  return join(bridgeCacheDir(), "models-cache.json");
}

const BRIDGE_MODEL_CACHE_VERSION = 2;

async function readPersistedBridgeCache(): Promise<BridgeModel[] | null> {
  try {
    const raw = await readFile(bridgeCachePath(), "utf8");
    const parsed = JSON.parse(raw) as { version?: number; models?: BridgeModel[] };
    // Version 1 catalogs were normalized with a ladder that ended at xhigh,
    // so force one fresh read from the CLI cache after upgrading.
    if (parsed.version !== BRIDGE_MODEL_CACHE_VERSION) return null;
    return Array.isArray(parsed.models) && parsed.models.length > 0 ? parsed.models : null;
  } catch {
    return null;
  }
}

async function writePersistedBridgeCache(models: BridgeModel[]): Promise<void> {
  try {
    await mkdir(bridgeCacheDir(), { recursive: true });
    await writeFile(
      bridgeCachePath(),
      JSON.stringify({ version: BRIDGE_MODEL_CACHE_VERSION, at: Date.now(), models }, null, 2),
    );
  } catch (error) {
    console.warn(
      "[codex-bridge] Failed to persist model cache:",
      error instanceof Error ? error.message : error,
    );
  }
}

async function readCodexCliModelCache(): Promise<BridgeModel[] | null> {
  try {
    const raw = await readFile(join(getCodexHomeDir(), "models_cache.json"), "utf8");
    const models = parseModelCatalog(raw);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

async function fetchLiveModelsFromCli(
  run: typeof execFile = execFile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BridgeModel[] | null> {
  const codexPath = env.CODEX_PATH || "codex";
  try {
    // Background-only path — the generous timeout is safe because this never
    // blocks a response to the client (see ModelCatalogCache).
    const { stdout } = await run(codexPath, ["debug", "models"], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    const models = parseModelCatalog(stdout);
    return models.length > 0 ? models : null;
  } catch (error) {
    console.warn(
      "[codex-bridge] `codex debug models` failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

const modelCatalogCache = new ModelCatalogCache({
  fetchFromCli: fetchLiveModelsFromCli,
  readPersistedCache: readPersistedBridgeCache,
  writePersistedCache: writePersistedBridgeCache,
  readCodexCliCache: readCodexCliModelCache,
  fallback: FALLBACK_MODELS,
});

/**
 * Composition root.
 *
 * There is one Codex engine: a persistent `codex app-server --stdio` child per
 * environment, supervised by this bridge. The per-turn `codex exec` path
 * was removed once app-server reached parity — see
 * docs/technical-architecture/agent-engines.md.
 */
type AppServerEngineFactory = (options: AppServerEngineOptions) => AppServerEngine;

function createCodexEngine(
  env: NodeJS.ProcessEnv = process.env,
  createEngine: AppServerEngineFactory = (options) => new AppServerEngine(options),
): AppServerEngine {
  return createEngine({
    codexPath: env.CODEX_PATH || "codex",
    cwd: getWorkingDirectory(),
    codexHome: getCodexHomeDir(),
    clientInfo: {
      name: "orkestrator",
      title: "Orkestrator",
      version: env.ORKESTRATOR_VERSION || "0.0.0",
    },
    configOverrides: codexAppServerConfigOverrides(env),
  });
}

const codexEngine = createCodexEngine();

const appServerRuntime = new AppServerRuntime({
  engine: codexEngine,
  codexHome: getCodexHomeDir(),
  cwd: getWorkingDirectory(),
  emit,
  loadCachedModels: () => modelCatalogCache.get(),
  persistModels: writePersistedBridgeCache,
  generateTitle: (prompt) =>
    sessionTitleGeneratorForTesting
      ? sessionTitleGeneratorForTesting(prompt)
      : generateSessionTitleWithCodexExec(codexPathOverride, prompt),
  // This module owns the sweep timer so shutdown can clear it alongside the rest.
  sweepIntervalMs: 0,
});

/**
 * Frees idle threads: unsubscribes them from app-server and drops their cached
 * transcript and diff state. Without it a long-lived bridge accumulates every
 * transcript it has ever rendered.
 */
async function sweepIdleThreads(
  runtime: Pick<AppServerRuntime, "sweepIdle"> = appServerRuntime,
): Promise<void> {
  try {
    await runtime.sweepIdle();
  } catch (error) {
    console.warn("[codex-bridge] Idle sweep failed:", error);
  }
}

const cleanupTimer = setInterval(() => {
  void sweepIdleThreads();
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

async function stopSelectedEngine(): Promise<void> {
  await appServerRuntime.stop();
}

/**
 * Starts the app-server child.
 *
 * Skipped when `CODEX_BRIDGE_NO_ENGINE=1`, so a test (or any consumer) can import
 * this module for its helpers without spawning a Codex process. That matters
 * beyond convenience: the supervisor refreshes PATH into `process.env` on start,
 * which would race anything else the importing process is doing.
 */
async function startSelectedEngine(
  env: NodeJS.ProcessEnv = process.env,
  runtime: Pick<AppServerRuntime, "start" | "getHealth"> = appServerRuntime,
): Promise<void> {
  if (env.CODEX_BRIDGE_NO_ENGINE === "1") {
    return;
  }
  try {
    await runtime.start();
    console.error(
      `[codex-bridge] app-server engine ready (codex ${runtime.getHealth().codexVersion ?? "unknown"})`,
    );
  } catch (error) {
    // Reported through /global/health rather than crashing: the backend polls
    // health, and a dead process gives it nothing to read.
    console.error(
      "[codex-bridge] Failed to start the app-server engine:",
      error instanceof Error ? error.message : error,
    );
  }
}


/**
 * Test seams for engine-neutral helpers that live in this module.
 *
 * Everything specific to a turn now lives in `AppServerRuntime` and is tested
 * directly in `app-server-runtime-*.test.ts`; this is only the surrounding shell
 * (SSE fan-out, raw logging, model cache, shutdown, rollout reads).
 */
export const __testing = {
  applyRuntimeEnvironmentOutput,
  BRIDGE_MODEL_CACHE_VERSION,
  createOpenSseWriterForTesting: createOpenSseWriter,
  createSerializedSseWriterForTesting: createSerializedSseWriter,
  createCodexEngineForTesting: createCodexEngine,
  createSharedTranscriptMetaLoaderForTesting: createSharedTranscriptMetaLoader,
  createShutdownHandlerForTesting: createShutdownHandler,
  emitForTesting: emit,
  eventRingForTesting: () => eventRing,
  /**
   * Swaps in a fresh ring and returns a restore function.
   *
   * A test that fills the byte budget would otherwise permanently evict every
   * revision emitted by the tests before it, so the shared ring's contents
   * become order-dependent for the rest of the file.
   */
  withIsolatedEventRingForTesting: (): (() => void) => {
    const previous = eventRing;
    eventRing = createReplayEventRing();
    return () => {
      eventRing = previous;
    };
  },
  suspendReplayRetentionForTesting: (): (() => void) => {
    const previous = replayRetentionEnabled;
    replayRetentionEnabled = false;
    eventRing.clear();
    return () => {
      replayRetentionEnabled = previous;
    };
  },
  extractPersistedMessageTextForTesting: extractPersistedMessageText,
  FALLBACK_MODELS,
  fetchLiveModelsFromCliForTesting: fetchLiveModelsFromCli,
  getPersistedSessionMetaForTesting: getPersistedSessionMeta,
  getSubscriberCountForTesting: () => subscribers.size,
  hydrateMessagesFromPersistedSessionForTesting: hydrateMessagesFromPersistedSession,
  listPersistedSessionsForCwdForTesting: listPersistedSessionsForCwd,
  mergePersistedSessionMetaForTesting: mergePersistedSessionMeta,
  normalizeLogPayloadForTesting: normalizeLogPayload,
  readPersistedBridgeCache,
  readCodexCliModelCache,
  readTextFileIfPresentForTesting: readTextFileIfPresent,
  refreshRuntimeEnvironment,
  runInlinePromptCommand,
  runtimeForTesting: () => appServerRuntime,
  setBridgeAuthForTesting: (token?: string) => {
    if (token === undefined) {
      bridgeAuthEnabledOverrideForTesting = null;
      return;
    }
    bridgeAuthToken = token;
    bridgeAuthEnabledOverrideForTesting = true;
  },
  isTrustedBridgeOriginForTesting: isTrustedBridgeOrigin,
  sanitizeLogFileComponentForTesting: sanitizeLogFileComponent,
  serializeSseEventDataForTesting: serializeSseEventData,
  setSessionTitleGeneratorForTesting,
  setSseRouteTestHooksForTesting: (hooks: SseRouteTestHooks | null) => {
    sseRouteTestHooks = hooks;
  },
  startBridgeServerForTesting: startBridgeServer,
  startSelectedEngineForTesting: startSelectedEngine,
  startSseKeepaliveForTesting: startSseKeepalive,
  sweepIdleThreadsForTesting: sweepIdleThreads,
  subscribeForTesting: (subscriber: SseSubscriber) => {
    const releaseReplayRetention = acquireReplayRetention();
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
      releaseReplayRetention();
    };
  },
  writeCodexRawLogForTesting: writeCodexRawLog,
  writePersistedBridgeCache,
};

function startSseKeepalive(
  writeSSE: (event: { event: string; data: string; id?: string }) => Promise<void>,
  intervalMs = 5_000,
  shouldSendAtActiveCadence: () => boolean = () => true,
  idleIntervalMs = 30_000,
): ReturnType<typeof setInterval> {
  let lastSentAt = Date.now();
  return setInterval(() => {
    const now = Date.now();
    if (
      !shouldSendAtActiveCadence()
      && now - lastSentAt < idleIntervalMs
    ) return;
    lastSentAt = now;
    void writeSSE({
      event: "keepalive",
      // Echo the latest issued revision so an EventSource reconnect exposes a
      // missed-frame gap through the same cursor path as ordinary events.
      id: String(eventRing.latestRevision),
      data: "{}",
    }).catch((error) => {
      console.error("[codex-bridge] Failed to write SSE keepalive:", error);
    });
  }, intervalMs);
}

function createOpenSseWriter<T>(
  isOpen: () => boolean,
  write: (event: T) => Promise<void>,
): (event: T) => Promise<void> {
  return async (event) => {
    if (!isOpen()) return;
    await write(event);
  };
}

/**
 * A subscriber that cannot drain this backlog is closed instead of queued
 * further. Every queued entry holds a fully serialized frame — for
 * `message.updated` that is the entire transcript message — so an unbounded
 * chain against a stalled consumer (backgrounded tab, dead TCP, slow tunnel)
 * retains multi-MB strings indefinitely. Closing is safe: the client
 * reconnects with its cursor and the event ring replays what it missed.
 */
const MAX_PENDING_SSE_FRAMES = 1_000;
const MAX_PENDING_SSE_BYTES = 16 * 1024 * 1024;
/** Cap for events buffered while a reconnect replay is being written. */
const MAX_BUFFERED_REPLAY_EVENTS = 10_000;

/**
 * Appends writes to a per-connection promise chain.
 *
 * `emit()` deliberately does not await subscribers, so without this queue two
 * live events can call Hono's stream writer concurrently and complete out of
 * revision order.
 *
 * The chain is bounded. Once `onOverflow` fires the writer permanently drops
 * frames — the connection is being torn down at that point, and continuing to
 * queue against a consumer that has already proven too slow would recreate the
 * unbounded retention the bound exists to stop. The first frame is always
 * accepted so a single oversized frame cannot deadlock an idle connection.
 */
function createSerializedSseWriter<T extends { data?: string }>(
  write: (event: T) => Promise<void>,
  options: {
    onOverflow?: () => void;
    maxPendingFrames?: number;
    maxPendingBytes?: number;
  } = {},
): (event: T) => Promise<void> {
  const maxPendingFrames = options.maxPendingFrames ?? MAX_PENDING_SSE_FRAMES;
  const maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_SSE_BYTES;
  let tail: Promise<void> = Promise.resolve();
  let pendingFrames = 0;
  let pendingBytes = 0;
  let overflowed = false;
  return (event) => {
    if (overflowed) return Promise.resolve();
    const frameBytes = event.data?.length ?? 0;
    if (
      pendingFrames > 0 &&
      (pendingFrames >= maxPendingFrames || pendingBytes + frameBytes > maxPendingBytes)
    ) {
      overflowed = true;
      options.onOverflow?.();
      return Promise.resolve();
    }
    pendingFrames += 1;
    pendingBytes += frameBytes;
    const release = () => {
      pendingFrames -= 1;
      pendingBytes -= frameBytes;
    };
    const attempt = tail.then(() => write(event));
    attempt.then(release, release);
    // Keep later frames flowing after a failed write; the returned attempt still
    // rejects so the endpoint or emit() can report the original failure.
    tail = attempt.catch(() => undefined);
    return attempt;
  };
}

app.use("*", async (c, next) => {
  const origin = c.req.raw.headers.get("origin") ?? undefined;
  if (!isTrustedBridgeOrigin(origin)) {
    return c.json({ error: "Origin is not allowed" }, 403);
  }
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
  if (c.req.method === "OPTIONS") {
    c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    c.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Orkestrator-Codex-Token",
    );
    c.header("Access-Control-Allow-Private-Network", "true");
    return c.body(null, 204);
  }
  if (
    isBridgeAuthEnabled()
    && !isPublicHealthRequest(c.req.method, c.req.path)
  ) {
    const dedicatedHeaderToken =
      c.req.raw.headers.get("x-orkestrator-codex-token")?.trim();
    const headerToken = bearerToken(
      c.req.raw.headers.get("authorization") ?? undefined,
    );
    const eventToken =
      c.req.path === "/event/subscribe" ? c.req.query("token")?.trim() : undefined;
    if (
      !tokenMatches(dedicatedHeaderToken)
      && !tokenMatches(headerToken)
      && !tokenMatches(eventToken)
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }
  await next();
});

// Transcript bodies dominate bridge bandwidth. Keep SSE uncompressed here —
// its own flush-sensitive writer has different backpressure semantics.
app.use("/session/:id/messages", async (c, next) => {
  await next();
  c.res.headers.append("Vary", "Accept-Encoding");
});
app.use("/session/:id/messages", compress({ encoding: "gzip" }));

app.get("/global/health", (c) => {
  const health = appServerRuntime.getHealth();
  // A terminally failed engine must not read as healthy: the backend waits on
  // this before reporting the Codex server started. A restartable state stays 200
  // with an explicit engine state so a transient blip does not flap the UI.
  const terminal = health.state === "failed" || health.circuitOpen;
  return c.json(
    {
      status: terminal ? "error" : "ok",
      version: BRIDGE_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      engine: "app-server",
      appServer: {
        state: health.state,
        generation: health.generation,
        codexVersion: health.codexVersion,
        restartCount: health.restartCount,
        circuitOpen: health.circuitOpen,
      },
      activeThreads: health.activeThreads,
      activeTurns: health.activeTurns,
      bridgeSessions: health.bridgeSessions,
      // Memory budget: detached/re-attached counts plus the bounded caches.
      storage: health.storage,
      queues: {
        notificationDepth: health.notificationQueueDepth,
        notificationHighWaterMark: health.notificationQueueHighWaterMark,
      },
      // A rising `dropped` with clients still reconnecting means the ring is too
      // small for this workload and reconnects are falling back to full resyncs.
      events: { ...eventRing.getStats(), subscribers: subscribers.size },
    },
    terminal ? 503 : 200,
  );
});

/**
 * Lightweight authenticated probe used to reject a cached client after token
 * rotation. Mirrors `/global/health`'s engine-state semantics: the web client's
 * health gate calls this route, so an unconditional 200 would let a terminally
 * failed engine pass every renderer health check.
 */
app.get("/global/auth-check", (c) => {
  const health = appServerRuntime.getHealth();
  const terminal = health.state === "failed" || health.circuitOpen;
  return c.json({ status: terminal ? "error" : "ok" }, terminal ? 503 : 200);
});

app.get("/global/models", async (c) => {
  const { models, source } = await appServerRuntime.listModels();
  return c.json({ models, source });
});

app.get("/global/slash-commands", async (c) => {
  const cwd = getWorkingDirectory();
  const commands = await getAvailableSlashCommandDefinitions(cwd);
  return c.json({ commands: commands.map(serializeSlashCommand), cwd });
});

app.get("/session/list", async (c) => {
  return c.json(await appServerRuntime.listSessions());
});

app.post("/session/create", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(appServerRuntime.createSession(body), 201);
});

app.post("/session/resume", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const resumed = await appServerRuntime.resumeSession(body);
  if (!resumed) return c.json({ error: "threadId is required" }, 400);
  return c.json(resumed, 201);
});

app.post("/session/:id/config", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const outcome = await appServerRuntime.updateConfig(sessionId, body);
  if (outcome === "not-found") return c.json({ error: "Session not found" }, 404);
  if (outcome === "running") {
    return c.json({ error: "Cannot update settings while session is running" }, 409);
  }
  if (outcome === "unavailable") {
    // The engine could not be reached to apply the change, so nothing was
    // updated anywhere. Reporting success here would leave the UI showing a
    // mode the next turn would not actually run under.
    return c.json({ error: "Codex is temporarily unavailable" }, 503);
  }
  if (outcome === "memory-only") {
    // The engine accepted the change, so this turn is correct — only the
    // durable record failed. Say so rather than claiming a clean write: the
    // setting silently reverts on the next bridge restart.
    return c.json({ status: "updated", durable: false });
  }
  return c.json({ status: "updated", durable: true });
});

app.get("/session/:id/config", async (c) => {
  const config = await appServerRuntime.getConfig(c.req.param("id"));
  if (!config) return c.json({ error: "Session not found" }, 404);
  return c.json(config);
});

app.get("/session/:id/messages", async (c) => {
  const messages = await appServerRuntime.getMessages(c.req.param("id"));
  if (!messages) return c.json({ error: "Session not found" }, 404);
  return c.json(boundCodexTranscriptResponse(messages));
});

app.get("/session/:id/status", (c) => {
  const status = appServerRuntime.getStatus(c.req.param("id"));
  if (!status) return c.json({ error: "Session not found" }, 404);
  return c.json(status);
});

/**
 * Side-effect-free activity poll for the backend's session sweep.
 *
 * Always 200, including for a session this bridge has never heard of. The
 * backend reads a 404 from this path as "the bridge predates this route" and
 * fails the whole environment, so a 404 for an unknown session would be
 * indistinguishable from an old bridge — and could have the backend drop the
 * mapping for a session that is merely detached. `"missing"` in the body is the
 * in-band signal for that one session instead.
 *
 * Unlike `/status` this must never touch the session: see `getActivity`.
 */
app.get("/session/:id/activity", (c) => {
  return c.json({ activity: appServerRuntime.getActivity(c.req.param("id")) });
});

/**
 * Did this bridge ever take this request id?
 *
 * The backend asks after a prompt request whose acknowledgement was lost, so it
 * can settle the dispatch from the journal instead of parking it for the user.
 * Read-only: no thread is attached, resumed or touched, which also keeps it
 * usable from the reconciler that must not act as a liveness touch.
 *
 * `dispatched` is only ever an explicit positive. `prepared` means the journal
 * recorded intent and never learned the outcome — that is exactly the question
 * being asked, so it answers `unknown`, as does a request id this process has
 * no record of at all.
 */
app.get("/session/:id/dispatch", (c) => {
  const requestId = c.req.query("requestId")?.trim();
  if (!requestId) return c.json({ dispatch: "unknown" });
  const record = appServerRuntime.getJournal().get(requestId);
  // Unlike the other two bridges this journal is process-global, so the record
  // has to be checked against the session that is asking. Answering across
  // sessions would let one session's history settle another's parked dispatch.
  const dispatched = record?.bridgeSessionId === c.req.param("id")
    && (record.state === "accepted" || record.state === "terminal");
  return c.json({ dispatch: dispatched ? "dispatched" : "unknown" });
});

app.get("/session/:id/structured-output", (c) => {
  const result = appServerRuntime.getStructuredOutput(
    c.req.param("id"),
    c.req.query("requestId")?.trim(),
  );
  if (!result) return c.json({ error: "Session not found" }, 404);
  return c.json(result);
});

app.post("/session/:id/prompt", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const outputSchema = body.outputSchema;
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (rawAttachments.some((entry: unknown) =>
    typeof (entry as PromptAttachmentInput | null)?.path !== "string"
    || (entry as PromptAttachmentInput).type !== "image"
  )) {
    return c.json({ error: "Codex supports image attachments only" }, 400);
  }
  // Every surviving entry is already a well-formed image: the guard above
  // refuses the request outright rather than dropping what it cannot send.
  const attachments = rawAttachments.map((entry: unknown) => {
    const input = entry as PromptAttachmentInput;
    return {
      type: "image" as const,
      path: input.path,
      dataUrl: typeof input.dataUrl === "string" ? input.dataUrl : undefined,
      filename: typeof input.filename === "string" ? input.filename : undefined,
    };
  });

  if (!prompt && attachments.length === 0) {
    return c.json({ error: "Prompt or image attachment is required" }, 400);
  }
  if (!requestId || requestId.length > 200) {
    return c.json(
      { error: "requestId must be a non-empty string of at most 200 characters" },
      400,
    );
  }
  if (outputSchema !== undefined && !isJsonSchema(outputSchema)) {
    return c.json({ error: "outputSchema must be a JSON Schema object" }, 400);
  }

  const outcome = await appServerRuntime.prompt(sessionId, {
    prompt,
    requestId,
    attachments,
    outputSchema,
  });
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json(outcome.result, 202);
});

/**
 * Approvals still awaiting a decision.
 *
 * The rehydration path: a chat tab that was unmounted while Codex asked for
 * approval has missed the SSE frame entirely, so it must be able to ask. Returns
 * `[]` rather than 404 for an unknown session — a stale tab polling a closed
 * session should see "nothing pending", not an error.
 */
app.get("/session/:id/approvals", (c) => {
  return c.json({ approvals: appServerRuntime.listApprovals(c.req.param("id")) });
});

app.post("/session/:id/approvals/:approvalId", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!isApprovalDecision(body.decision)) {
    return c.json(
      { error: `decision must be one of: ${APPROVAL_DECISIONS.join(", ")}` },
      400,
    );
  }

  const outcome = appServerRuntime.respondToApproval(
    c.req.param("id"),
    c.req.param("approvalId"),
    body.decision,
  );
  if (outcome === "wrong-session") {
    return c.json({ error: "Approval does not belong to this session" }, 403);
  }
  if (outcome === "not-actionable") {
    // The bridge could not recover what would be approved, so there is nothing a
    // user could have consented to. Deny and cancel remain available.
    return c.json(
      { error: "Approval lacks the detail required to approve it" },
      422,
    );
  }
  if (outcome === "unknown") {
    // 409, not 404: the approval existed but the window closed (answered,
    // expired, or the child restarted). The UI should drop the card, not retry.
    return c.json({ error: "Approval is no longer pending", status: "stale" }, 409);
  }
  return c.json({ status: "applied", decision: body.decision });
});

app.get("/session/:id/interactions", (c) => {
  return c.json({
    interactions: appServerRuntime.listInteractions(c.req.param("id")),
  });
});

app.post("/session/:id/interactions/:interactionId", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (
    body.action !== "accept"
    && body.action !== "decline"
    && body.action !== "cancel"
  ) {
    return c.json({ error: "action must be accept, decline, or cancel" }, 400);
  }
  /**
   * Shape-checked here so the runtime only ever receives a typed answer.
   * `typeof body.answers === "object"` was not enough: `{"q":"TypeScript"}` is an
   * object, and the per-question validation downstream calls `.some()` on each
   * value, so a string there threw a `TypeError` and Hono answered 500 while the
   * interaction stayed parked until its auto-cancel.
   */
  const answer: InteractionAnswer | null = parseInteractionAnswer(body);
  if (!answer) {
    return c.json(
      { error: "answers must map each question id to a non-empty array of non-empty strings" },
      400,
    );
  }
  const outcome = appServerRuntime.respondToInteraction(
    c.req.param("id"),
    c.req.param("interactionId"),
    answer,
  );
  if (outcome === "wrong-session") {
    return c.json({ error: "Interaction does not belong to this session" }, 403);
  }
  if (outcome === "invalid") {
    return c.json({ error: "Interaction answer is malformed" }, 400);
  }
  if (outcome === "unknown") {
    return c.json({ error: "Interaction is no longer pending", status: "stale" }, 409);
  }
  return c.json({ status: "applied", action: answer.action });
});

app.post("/session/:id/fork", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await appServerRuntime.forkSession(
    c.req.param("id"),
    typeof body.lastMessageId === "string" ? body.lastMessageId : undefined,
  );
  // Each failure has its own cause. Reporting them all as "running or before its
  // first turn" sent users looking for a running turn that was not there.
  switch (result.outcome) {
    case "created": {
      const { outcome: _outcome, ...payload } = result;
      return c.json(payload, 201);
    }
    case "not-found":
      return c.json({ error: "Session not found" }, 404);
    case "running":
      return c.json({ error: "Session cannot be forked while it is running" }, 409);
    case "unknown-message":
      return c.json({ error: "lastMessageId is not a message in this session" }, 404);
    case "no-fork-point":
      return c.json(
        { error: "That message is not a usable fork point: it belongs to no Codex turn" },
        422,
      );
    default:
      return c.json({ error: "Codex did not return a forked thread" }, 503);
  }
});

app.post("/session/:id/compact", async (c) => {
  const outcome = await appServerRuntime.compactSession(c.req.param("id"));
  if (outcome === "not-found") return c.json({ error: "Session not found" }, 404);
  if (outcome === "running") return c.json({ error: "Session is running" }, 409);
  if (outcome === "unavailable") return c.json({ error: "Compaction could not be started" }, 503);
  // 202: `thread/compact/start` returns before the rewrite has happened. The
  // session stays busy until the bridge sees `thread/compacted`.
  return c.json({ status: "accepted" }, 202);
});

app.post("/session/:id/steer", async (c) => {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await c.req.json();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (typeof body.input !== "string" || !body.input.trim()) {
    return c.json({ error: "input is required" }, 400);
  }
  if (typeof body.requestId !== "string" || !body.requestId.trim()) {
    return c.json({ error: "requestId is required" }, 400);
  }
  if (typeof body.expectedTurnId !== "string" || !body.expectedTurnId.trim()) {
    return c.json({ error: "expectedTurnId is required" }, 400);
  }
  const requestId = body.requestId.trim();
  const outcome = await appServerRuntime.steerSession(
    c.req.param("id"),
    body.input.trim(),
    body.expectedTurnId.trim(),
    requestId,
  );
  if (outcome === "not-found") return c.json({ error: "Session not found" }, 404);
  if (outcome === "idle") {
    return c.json({ error: "There is no active turn", outcome: "idle" }, 409);
  }
  if (outcome === "mismatch") {
    return c.json(
      { error: "The active turn changed; the text was not sent", outcome: "mismatch" },
      409,
    );
  }
  if (outcome === "unknown") {
    return c.json(
      {
        error: "Could not confirm whether Codex received the steering text",
        outcome: "unknown",
        requestId,
      },
      503,
    );
  }
  return c.json({ status: "accepted" }, 202);
});

app.post("/session/:id/review", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  /**
   * A named target with a missing or blank field is a client bug, not a request
   * to review the working tree. Silently degrading it to `uncommittedChanges`
   * started a *different* review from the one asked for — spending a turn and
   * tokens — and answered 202 as if it had succeeded.
   */
  const trimmed = (value: unknown): string =>
    typeof value === "string" ? value.trim() : "";
  let target:
    | { type: "uncommittedChanges" }
    | { type: "baseBranch"; branch: string }
    | { type: "commit"; sha: string; title: string | null }
    | { type: "custom"; instructions: string };

  switch (body.type) {
    case "baseBranch": {
      const branch = trimmed(body.branch);
      if (!branch) return c.json({ error: "branch is required for a baseBranch review" }, 400);
      target = { type: "baseBranch", branch };
      break;
    }
    case "commit": {
      const sha = trimmed(body.sha);
      if (!sha) return c.json({ error: "sha is required for a commit review" }, 400);
      target = {
        type: "commit",
        sha,
        title: typeof body.title === "string" ? body.title : null,
      };
      break;
    }
    case "custom": {
      const instructions = trimmed(body.instructions);
      if (!instructions) {
        return c.json({ error: "instructions are required for a custom review" }, 400);
      }
      target = { type: "custom", instructions };
      break;
    }
    case undefined:
    case null:
    case "uncommittedChanges":
      // Only an *absent* type defaults; this is the documented default target.
      target = { type: "uncommittedChanges" };
      break;
    default:
      return c.json(
        { error: "type must be uncommittedChanges, baseBranch, commit, or custom" },
        400,
      );
  }

  const result = await appServerRuntime.startNativeReview(c.req.param("id"), target);
  if (result.outcome === "not-found") return c.json({ error: "Session not found" }, 404);
  if (result.outcome === "running") return c.json({ error: "Session is running" }, 409);
  if (result.outcome === "unavailable") return c.json({ error: "Native review failed" }, 503);
  return c.json({ status: "processing", turnId: result.turnId }, 202);
});

/** Authenticated, allowlisted runtime inventory for one known bridge session. */
app.get("/session/:id/runtime-health", async (c) => {
  const health = await appServerRuntime.getRuntimeHealth(c.req.param("id"));
  return health
    ? c.json(health)
    : c.json({ error: "Session not found" }, 404);
});

app.post("/session/:id/abort", async (c) => {
  const outcome = await appServerRuntime.abort(c.req.param("id"));
  if (!outcome) return c.json({ error: "Session not found" }, 404);
  // 202: turn/interrupt is asynchronous, so the turn is not over yet. Reporting
  // "aborted" here would let a new prompt overlap a turn still executing.
  return c.json({ status: outcome.status, phase: outcome.phase }, 202);
});

app.delete("/session/:id", async (c) => {
  // Closes the bridge session and, on the last reference, unsubscribes the
  // thread. Never thread/delete: that would destroy the user's rollout.
  const deleted = await appServerRuntime.deleteSession(c.req.param("id"));
  return deleted ? c.json({ status: "deleted" }) : c.json({ error: "Session not found" }, 404);
});

app.get("/event/subscribe", (c) => {
  // `?since=` is what our own client sends; `Last-Event-ID` is what a native
  // EventSource sends when the browser reconnects on its own. Accept both.
  const cursor =
    parseEventCursor(c.req.query("since")) ?? parseEventCursor(c.req.header("last-event-id"));
  const sessionFilter = c.req.query("sessionId")?.trim() || null;

  return streamSSE(c, async (stream) => {
    let open = true;
    let resolveConnectionClosed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => {
      resolveConnectionClosed = resolve;
    });
    // Closing is the recovery path for a consumer that cannot keep up: its
    // EventSource reconnects with the last id it saw and the ring replays the
    // gap, instead of this connection retaining an ever-growing frame backlog.
    const failSlowSubscriber = (reason: string) => {
      if (!open) return;
      open = false;
      console.error(
        `[codex-bridge] Closing SSE subscriber (${reason}); the client will reconnect and replay from its cursor`,
      );
      resolveConnectionClosed();
    };
    const writeWhileOpen = createSerializedSseWriter(
      createOpenSseWriter(
        () => open,
        (event: { event: string; data: string; id?: string }) => stream.writeSSE(event),
      ),
      { onOverflow: () => failSlowSubscriber("write backlog exceeded its cap") },
    );

    const frameFor = (
      event: Pick<SseEvent, "type" | "sessionId">,
      revision: number,
      // Deferred, not a string: a replayed frame for another session must not be
      // encoded at all, which is the whole point of the filter below.
      serializeData: () => string,
    ) => {
      // A tab only renders its own session. Preserve the bridge-wide cursor for
      // unrelated events, but do not serialize and transmit their potentially
      // megabyte-sized message snapshots to every other tab.
      if (sessionFilter && event.sessionId !== sessionFilter) {
        return {
          event: "bridge.cursor",
          id: String(revision),
          data: "{}",
        };
      }
      return {
        event: event.type,
        // The `id:` is what makes replay possible at all — it is the cursor the
        // client echoes back on its next connection.
        id: String(revision),
        data: serializeData(),
      };
    };

    /**
     * Registered *before* the replay is computed, buffering into an array.
     *
     * Ordering matters: if we replayed first and subscribed second, an event
     * emitted in between would be lost by both paths — the exact gap this endpoint
     * exists to close. So we subscribe first, replay, then flush anything that
     * arrived during the replay, skipping revisions the replay already covered.
     */
    // Snapshot the fresh-client anchor before subscribing. These statements are
    // synchronous, so no event can land between the snapshot and registration.
    const releaseReplayRetention = acquireReplayRetention();
    const anchorRevision = cursor ?? eventRing.latestRevision;
    let buffered: Array<{
      event: Pick<SseEvent, "type" | "sessionId">;
      revision: number;
      serializedData: string;
    }> | null = [];
    let highestSent = anchorRevision;

    const listener: SseSubscriber = async (event, revision, serializedData) => {
      if (buffered) {
        if (
          buffered.length
          >= (sseRouteTestHooks?.maxBufferedReplayEvents ?? MAX_BUFFERED_REPLAY_EVENTS)
        ) {
          failSlowSubscriber("replay buffer overflowed");
          return;
        }
        buffered.push({
          event: { type: event.type, sessionId: event.sessionId },
          revision,
          serializedData,
        });
        return;
      }
      if (revision <= highestSent) return;
      highestSent = revision;
      await writeWhileOpen(frameFor(event, revision, () => serializedData));
    };
    subscribers.add(listener);

    let keepalive: ReturnType<typeof setInterval> | undefined;

    try {
      if (sseRouteTestHooks?.afterSubscriberRegistered) {
        await sseRouteTestHooks.afterSubscriberRegistered();
      }
      const replay = cursor === null ? null : eventRing.since(cursor);

      await writeWhileOpen({
        event: "connected",
        /**
         * The client's *own* position, not the latest revision.
         *
         * A browser EventSource adopts the id of every frame it sees, including
         * this one. If it took the latest revision here and the connection then
         * died before the replay frames were read, it would reconnect asking for
         * everything after the newest event — permanently skipping the very frames
         * it had just asked to be replayed. Echoing its cursor back makes the
         * handshake idempotent.
         */
        id: String(anchorRevision),
        data: JSON.stringify({
          status: "connected",
          timestamp: new Date().toISOString(),
          revision: replay?.latestRevision ?? anchorRevision,
          // Tells the client whether the frames that follow are a replay or a
          // fresh start, so it knows if it still owes itself a reconcile.
          replayed: replay?.complete === true ? replay.events.length : 0,
        }),
      });

      if (replay && !replay.complete) {
        // The gap is longer than we retained. Say so explicitly rather than
        // sending a partial history that would look whole.
        await writeWhileOpen({
          event: "session.reconcile-required",
          id: String(replay.latestRevision),
          data: JSON.stringify({
            reason: "cursor-expired",
            requestedRevision: cursor,
            oldestAvailableRevision: eventRing.oldestRevision,
            latestRevision: replay.latestRevision,
          }),
        });
        highestSent = replay.latestRevision;
      } else if (replay) {
        for (const entry of replay.events) {
          highestSent = Math.max(highestSent, entry.revision);
          if (entry.event.superseded) {
            // A newer full snapshot for this message appears later in the same
            // replay, so this revision only has to keep the client's cursor dense.
            await writeWhileOpen({
              event: "bridge.cursor",
              id: String(entry.revision),
              data: "{}",
            });
            continue;
          }
          await writeWhileOpen(
            frameFor(entry.event, entry.revision, () => entry.event.serialize()),
          );
        }
      }

      if (sseRouteTestHooks?.beforeBufferedDrain) {
        await sseRouteTestHooks.beforeBufferedDrain();
      }

      // Drain while remaining in buffered mode. Any event that lands during an
      // awaited write is appended to the same array and consumed by this loop,
      // so a later live revision cannot leapfrog an earlier buffered one.
      let pendingIndex = 0;
      while (buffered && pendingIndex < buffered.length) {
        const entry = buffered[pendingIndex]!;
        pendingIndex += 1;
        if (entry.revision <= highestSent) continue;
        highestSent = entry.revision;
        if (sseRouteTestHooks?.beforeBufferedWrite) {
          await sseRouteTestHooks.beforeBufferedWrite(entry.revision);
        }
        await writeWhileOpen(
          frameFor(entry.event, entry.revision, () => entry.serializedData),
        );
      }
      buffered = null;
      // Start only after replay and its buffered tail are flushed. A heartbeat
      // carries the latest id, so sending one during replay would jump the
      // EventSource cursor past frames it had not received yet.
      keepalive = startSseKeepalive(
        writeWhileOpen,
        5_000,
        () => {
          if (!sessionFilter) return true;
          const activity = appServerRuntime.getActivity(sessionFilter);
          return activity === "working" || activity === "waiting";
        },
        30_000,
      );
      if (sseRouteTestHooks?.afterKeepaliveStarted) {
        await sseRouteTestHooks.afterKeepaliveStarted();
      }

      await Promise.race([
        connectionClosed,
        new Promise<void>((resolve) => {
          c.req.raw.signal.addEventListener("abort", () => resolve());
        }),
      ]);
    } finally {
      open = false;
      if (keepalive) clearInterval(keepalive);
      subscribers.delete(listener);
      releaseReplayRetention();
    }
  });
});

type BridgeServerOptions = Parameters<typeof serve>[0];

function startBridgeServer(
  env: NodeJS.ProcessEnv = process.env,
  start: (options: BridgeServerOptions) => unknown = serve,
): unknown {
  if (env.CODEX_BRIDGE_NO_SERVER === "1") {
    return undefined;
  }

  return start({
    fetch: app.fetch,
    port: parseInt(env.PORT || "4098", 10),
    hostname: env.HOSTNAME || "0.0.0.0",
  });
}

const shutdownHandler = createShutdownHandler(cleanupTimer);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, shutdownHandler);
}

// A dead backend can no longer signal us, so watch for it and run the same
// graceful drain a SIGTERM would have triggered.
const parentPid = parseParentPid(process.env[PARENT_PID_ENV]);
if (parentPid !== null) {
  startParentWatchdog({
    parentPid,
    onParentExit: () => {
      console.error(
        `[codex-bridge] Backend process ${parentPid} is gone; shutting down`,
      );
      shutdownHandler();
    },
  });
}

startBridgeServer();
void startSelectedEngine();
