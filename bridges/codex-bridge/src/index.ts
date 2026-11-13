// First, before any module reads the environment: what the bridge launcher
// recorded for the agents this bridge spawns (bridge-launch-environment.ts).
import "@orkestrator/protocol/node/bridge-launch-environment";
import { PolicyWideningRefusedError } from "@orkestrator/protocol/execution-policy-narrowing";
import { BRIDGE_LOG_POLICY_ROUTE } from "@orkestrator/protocol/log-policy";
import {
  bridgeCredentialFromToken,
  loadBridgeCredential,
} from "@orkestrator/protocol/node/bridge-credential";
import { admitFetchBridgeRequest } from "@orkestrator/protocol/node/bridge-authority";
import {
  applyBridgeLogPolicy,
  readBridgeLogPolicyBody,
} from "@orkestrator/protocol/node/bridge-log-policy";
import {
  createBridgeDiagnostics,
  type BridgeRunDiagnostics,
} from "@orkestrator/protocol/node/bridge-diagnostics";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Hono, type Context, type Next } from "hono";
import { compress } from "hono/compress";
import { isJsonSchema } from "@orkestrator/protocol/structured-output";
import { normalizePendingSignIn } from "@orkestrator/protocol/native-agent";
import { WorkspaceChangeProbe } from "@orkestrator/protocol/node/workspace-change-probe";
import {
  WORKFLOW_RESULT_KINDS,
  parseWorkflowResultTurn,
  type WorkflowResultTurn,
  workflowResultToolName,
  workflowResultTurnToolPort,
} from "@orkestrator/protocol/workflow-results";
import {
  boundTranscriptResponse,
  parseTranscriptTailLimit,
  type TranscriptWindowMetadata,
} from "@orkestrator/protocol/node/transcript-window";
import { streamSSE } from "hono/streaming";
import { registerMcpReloadRoute } from "./mcp-reload-route.js";
import { registerSessionCloseRoute } from "./session-close-route.js";
import { registerSessionActivityBatchRoute } from "./session-activity-batch-route.js";
import {
  registerCodexChangeEvidenceRoutes,
  registerCodexTranscriptRoutes,
} from "./transcript-routes.js";
import { createCodexChangeEvidence } from "./change-evidence.js";
import { isCodexApprovalMode } from "./codex-approval-mode.js";
import { normalizeExplicitSessionTitle } from "./session-title-index.js";
import { AppServerRuntime, SESSION_CLOSING_ERROR } from "./app-server-runtime.js";
import { AppServerEngine, type AppServerEngineOptions } from "./engine/app-server-engine.js";
import { codexAppServerConfigOverrides, codexCoordinatorSkillExtraRoots } from "./codex-config.js";
import { APPROVAL_DECISIONS, isApprovalDecision } from "./app-server/approvals.js";
import { redactSecrets } from "@orkestrator/protocol/secret-redaction";
import { parseInteractionAnswer, type InteractionAnswer } from "./app-server/interactions.js";
import type { ParkedHoldResponse } from "./app-server-runtime-approvals.js";
import type { AgentInteractionHold } from "@orkestrator/protocol/agent-interactions";
import {
  commandUnavailableResponse,
  readBridgePromptCommandFields,
} from "@orkestrator/protocol/agent-command-catalogue";
import {
  PARENT_PID_ENV,
  parseParentPid,
  startParentWatchdog,
} from "@orkestrator/protocol/parent-watchdog";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { logUnhandledRejection } from "@orkestrator/protocol/node/process-failure-log";
import {
  createSharedTranscriptMetaLoader,
  extractPersistedMessageText,
  getCodexHomeDir,
  getPersistedSessionMeta,
  getWorkingDirectory,
  hydrateMessagesFromPersistedSession,
  listPersistedSessionsForCwd,
  mergePersistedSessionMeta,
} from "./history/rollout.js";
import { readTextFileIfPresent } from "./messages/normalization.js";
import type { NormalizedMessage } from "./messages/types.js";

import { CODEX_FALLBACK_MODEL_CATALOG } from "@orkestrator/protocol/codex-model-catalog";
import {
  ModelCatalogCache,
  REASONING_DESCRIPTIONS,
  REASONING_LABELS,
  parseModelCatalog,
  type BridgeModel,
} from "./models-cache.js";
import { applyRuntimeEnvironmentOutput, refreshRuntimeEnvironment } from "./runtime-env.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { configureBridgeLogger } from "@orkestrator/protocol/node/logger-environment";

const log = createLogger("bridge.codex");

configureBridgeLogger();

const WORKFLOW_RESULT_TOOL_NAMES = new Set(WORKFLOW_RESULT_KINDS.map(workflowResultToolName));

/** A kind's result tool, or a graph output port's own `submit_<port>`. */
function isWorkflowResultTool(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (WORKFLOW_RESULT_TOOL_NAMES.has(value) || workflowResultTurnToolPort(value) !== null)
  );
}

/**
 * The prompt's workflow-result attempt. An older backend names only the tool;
 * a newer one adds its key and, for a graph activation, every result slot and
 * the extra tools its credential lists, all read by the shared parser.
 */
function readWorkflowResultTurn(
  body: Record<string, unknown>,
): { ok: true; turn?: WorkflowResultTurn } | { ok: false; error: string } {
  const tool = body.workflowResultTool;
  if (
    body.workflowResultKey === undefined &&
    body.workflowResultSlots === undefined &&
    body.workflowResultExtraTools === undefined
  ) {
    return tool === undefined || isWorkflowResultTool(tool)
      ? { ok: true }
      : { ok: false, error: "workflowResultTool must name a workflow result tool" };
  }
  return parseWorkflowResultTurn(
    tool,
    body.workflowResultKey,
    body.workflowResultSlots,
    body.workflowResultExtraTools,
  );
}

function isScopedAgentMcp(value: unknown): value is { url: string; token: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.url !== "string" ||
    typeof candidate.token !== "string" ||
    candidate.token.length === 0 ||
    candidate.token.length > 1_024
  ) {
    return false;
  }
  try {
    const url = new URL(candidate.url);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname) &&
      url.pathname === "/mcp" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

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

/**
 * Hono's default handler prints the whole error, and an `AppServerRpcError`
 * carries app-server's `data` verbatim. Log only the redacted stack string,
 * preserving diagnostic frames without inspecting attached error data.
 */
app.onError((error, c) => {
  if (error instanceof PolicyWideningRefusedError) {
    log.warn("session.policy-widening-refused", { widened: error.widened.join(",") });
    return c.json(error.refusal(), 403);
  }
  if ("getResponse" in error) {
    const response = (error as { getResponse(): Response }).getResponse();
    return c.newResponse(response.body, response);
  }
  log.error("http.request-failed", {
    method: c.req.method,
    path: c.req.path,
    error: formatLogError(error),
  });
  return c.text("Internal Server Error", 500);
});
export const MAX_CODEX_TRANSCRIPT_RESPONSE_BYTES = 16 * 1024 * 1024;

export function boundCodexTranscriptResponse(
  messages: NormalizedMessage[],
  tailMessages?: number,
): {
  messages: NormalizedMessage[];
  messageWindow: TranscriptWindowMetadata;
} {
  const { messages: bounded, messageWindow } = boundTranscriptResponse(
    messages,
    MAX_CODEX_TRANSCRIPT_RESPONSE_BYTES,
    tailMessages === undefined ? {} : { tailMessages },
  );
  return { messages: bounded, messageWindow };
}
const BRIDGE_TOKEN_ENV = "CODEX_BRIDGE_TOKEN";
// The credential authenticates callers of this bridge; nothing this process
// spawns needs it. Captured once and removed so the app-server child, and every
// shell the agent runs through it, cannot inherit it (H4).
let bridgeCredential = loadBridgeCredential(BRIDGE_TOKEN_ENV);
let bridgeAuthEnabledOverrideForTesting: boolean | null = null;
interface SseRouteTestHooks {
  afterSubscriberRegistered?: () => Promise<void> | void;
  beforeBufferedDrain?: () => Promise<void> | void;
  beforeBufferedWrite?: (revision: number) => Promise<void> | void;
  afterKeepaliveStarted?: () => Promise<void> | void;
  maxBufferedHandshakeEvents?: number;
}
let sseRouteTestHooks: SseRouteTestHooks | null = null;
/**
 * The bridge's own version, reported through /global/health. Held at 1.0.0 so the
 * health payload stays a purely additive change for existing clients.
 */
const BRIDGE_VERSION = "1.0.0";
const execFile = promisify(execFileCallback);
type SseSubscriber = (event: SseEvent, revision: number) => Promise<void> | void;
/**
 * Subscribers of `/event/subscribe?observe=1`, the only stream the bridge
 * serves: the backend's activity observer, which only needs to know *that* a
 * session changed. Frames carry no payload and nothing is retained for replay.
 */
const subscribers = new Set<SseSubscriber>();
/**
 * The bridge-wide event cursor. Every emitted event takes the next revision,
 * so a reconnecting client whose cursor is not this one has missed something.
 */
let latestRevision = 0;

/** An observation frame's data: the session it names, never the payload. */
function observationFrameData(sessionId: string | undefined): string {
  return JSON.stringify(sessionId === undefined ? {} : { sessionId });
}

/**
 * Parses a client-supplied cursor from `?since=` or the `Last-Event-ID` header.
 *
 * Returns null for anything not a non-negative integer, which the route treats
 * as "no cursor" — a fresh subscription — rather than as an error: a garbled
 * cursor must not leave the client with no stream at all.
 */
function parseEventCursor(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}
/** Interval for the idle-thread sweep. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function isBridgeAuthEnabled(): boolean {
  if (bridgeAuthEnabledOverrideForTesting !== null) {
    return bridgeAuthEnabledOverrideForTesting;
  }
  // Route tests explicitly opt out because they exercise route mapping rather
  // than process authentication. This escape hatch is inert for a real server.
  return !(
    process.env.CODEX_BRIDGE_NO_SERVER === "1" &&
    process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING === "1"
  );
}

function tokenMatches(candidate: string | undefined): boolean {
  return bridgeCredential.matches(candidate);
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * Only the backend calls this bridge, and it sends no `Origin`. A request that
 * carries one came from a browser page; refuse it unless the page is on this
 * machine's loopback, before authentication. No browser client remains, so the
 * bridge answers no CORS preflight and echoes no origin.
 */
function isTrustedBridgeOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1" ||
        parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function isPublicHealthRequest(method: string, path: string): boolean {
  return method === "GET" && path === "/global/health";
}

function createShutdownHandler(
  timer: ReturnType<typeof setInterval>,
  clearTimer: (timer: ReturnType<typeof setInterval>) => void = clearInterval,
  exit: (code: number) => void = (code) => process.exit(code),
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
    void stopEngine()
      .catch((error) => {
        log.warn("engine.stop-failed", { error: formatLogError(error) });
      })
      .finally(() => exit(0));
  };
}

function createParentExitHandler(
  interrupt: (budgetMs: number) => Promise<number>,
  shutdown: () => void,
  report: (turns: number, elapsedMs: number) => void = (turns, ms) => {
    log.info("turns.stopped", { turns, elapsedMs: ms });
  },
): () => Promise<void> {
  return async () => {
    const detectedAt = performance.now();
    try {
      const turns = await interrupt(PARENT_EXIT_INTERRUPT_BUDGET_MS).catch(() => 0);
      report(turns, Math.round(performance.now() - detectedAt));
    } finally {
      shutdown();
    }
  };
}

/** The shared shipped catalogue (`@orkestrator/protocol/codex-model-catalog`). */
const FALLBACK_MODELS: BridgeModel[] = CODEX_FALLBACK_MODEL_CATALOG.map((model) => ({
  id: model.id,
  name: model.name,
  description: model.description,
  reasoningEfforts: [...model.reasoningEfforts],
  reasoningOptions: model.reasoningEfforts.map((effort) => ({
    effort,
    label: REASONING_LABELS[effort],
    description: REASONING_DESCRIPTIONS[effort],
  })),
  defaultReasoningEffort: model.defaultReasoningEffort,
}));

/**
 * Publishes an event to every live subscriber.
 *
 * The revision is assigned *before* fan-out so a subscriber added mid-flight can
 * tell what it has already seen. Fan-out stays fire-and-forget: a slow client
 * must never back-pressure the reducer that called this. Only the session id is
 * read; the payload is never walked, copied or encoded.
 */
function emit(event: SseEvent): void {
  latestRevision += 1;
  const revision = latestRevision;
  for (const subscriber of subscribers) {
    try {
      void Promise.resolve(subscriber(event, revision)).catch((error) => {
        log.warn("sse.subscriber-failed", { error: formatLogError(error) });
      });
    } catch (error) {
      log.warn("sse.subscriber-failed", { error: formatLogError(error) });
    }
  }
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
    log.warn("models.cache-persist-failed", { error: formatLogError(error, { stack: false }) });
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
    log.warn("models.debug-read-failed", { error: formatLogError(error, { stack: false }) });
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
 * docs/architecture/agent-engines.md.
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
    skillExtraRoots: codexCoordinatorSkillExtraRoots(env, getWorkingDirectory()),
  });
}

const codexEngine = createCodexEngine();

/**
 * One change-evidence spool per process, persisted beside the bridge's other
 * sidecar state so unacknowledged evidence survives a restart.
 */
const codexChangeEvidence = createCodexChangeEvidence({
  codexHome: getCodexHomeDir(),
  cwd: getWorkingDirectory(),
});

const appServerRuntime = new AppServerRuntime({
  engine: codexEngine,
  codexHome: getCodexHomeDir(),
  cwd: getWorkingDirectory(),
  emit,
  loadCachedModels: () => modelCatalogCache.get(),
  persistModels: writePersistedBridgeCache,
  // This module owns the sweep timer so shutdown can clear it alongside the rest.
  sweepIntervalMs: 0,
  // One probe per process: it serializes snapshots per repository across every
  // thread working in it.
  commandChangeProbe: new WorkspaceChangeProbe(),
  changeEvidence: codexChangeEvidence,
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
    log.warn("idle-sweep.failed", { error: formatLogError(error) });
  }
}

function createCodexProcessDiagnostics(
  runtime: Pick<AppServerRuntime, "getHealth"> = appServerRuntime,
): BridgeRunDiagnostics | undefined {
  const diagnostics = createBridgeDiagnostics("codex", { id: "app-server" }, () => {
    const health = runtime.getHealth();
    return {
      ...health.rpc,
      state: health.state,
      generation: health.generation,
      restartCount: health.restartCount,
      circuitOpen: health.circuitOpen,
      notificationQueueDepth: health.notificationQueueDepth,
      notificationQueueHighWaterMark: health.notificationQueueHighWaterMark,
      unknownNotifications: health.unknownNotifications,
      unknownServerRequests: health.unknownServerRequests,
    };
  });
  diagnostics?.checkpoint("attached");
  return diagnostics;
}

const debugDiagnostics = createCodexProcessDiagnostics();

const cleanupTimer = setInterval(() => {
  void sweepIdleThreads();
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

async function stopSelectedEngine(
  runtime: Pick<AppServerRuntime, "stop"> = appServerRuntime,
  diagnostics: BridgeRunDiagnostics | undefined = debugDiagnostics,
): Promise<void> {
  diagnostics?.close();
  await runtime.stop();
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
    log.info("engine.ready", { codexVersion: runtime.getHealth().codexVersion ?? "unknown" });
  } catch (error) {
    // Reported through /global/health rather than crashing: the backend polls
    // health, and a dead process gives it nothing to read.
    log.error("engine.start-failed", { error: formatLogError(error, { stack: false }) });
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
  createCodexProcessDiagnosticsForTesting: createCodexProcessDiagnostics,
  createSharedTranscriptMetaLoaderForTesting: createSharedTranscriptMetaLoader,
  createShutdownHandlerForTesting: createShutdownHandler,
  createParentExitHandlerForTesting: createParentExitHandler,
  emitForTesting: emit,
  latestRevisionForTesting: () => latestRevision,
  parseEventCursorForTesting: parseEventCursor,
  extractPersistedMessageTextForTesting: extractPersistedMessageText,
  FALLBACK_MODELS,
  fetchLiveModelsFromCliForTesting: fetchLiveModelsFromCli,
  getPersistedSessionMetaForTesting: getPersistedSessionMeta,
  getSubscriberCountForTesting: () => subscribers.size,
  hydrateMessagesFromPersistedSessionForTesting: hydrateMessagesFromPersistedSession,
  listPersistedSessionsForCwdForTesting: listPersistedSessionsForCwd,
  mergePersistedSessionMetaForTesting: mergePersistedSessionMeta,
  readPersistedBridgeCache,
  readCodexCliModelCache,
  readTextFileIfPresentForTesting: readTextFileIfPresent,
  refreshRuntimeEnvironment,
  runtimeForTesting: () => appServerRuntime,
  setBridgeAuthForTesting: (token?: string) => {
    if (token === undefined) {
      bridgeAuthEnabledOverrideForTesting = null;
      return;
    }
    bridgeCredential = bridgeCredentialFromToken(token);
    bridgeAuthEnabledOverrideForTesting = true;
  },
  isTrustedBridgeOriginForTesting: isTrustedBridgeOrigin,
  setSseRouteTestHooksForTesting: (hooks: SseRouteTestHooks | null) => {
    sseRouteTestHooks = hooks;
  },
  startBridgeServerForTesting: startBridgeServer,
  startBridgeForTesting: startBridge,
  startSelectedEngineForTesting: startSelectedEngine,
  stopSelectedEngineForTesting: stopSelectedEngine,
  startSseKeepaliveForTesting: startSseKeepalive,
  sweepIdleThreadsForTesting: sweepIdleThreads,
  subscribeForTesting: (subscriber: SseSubscriber) => {
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  },
  writePersistedBridgeCache,
};

/**
 * Proof the connection is alive for a subscriber that only wants wakeups; the
 * backend tears a stream down after 75 s of silence.
 */
function startSseKeepalive(
  writeSSE: (event: { event: string; data: string; id?: string }) => Promise<void>,
  intervalMs = 30_000,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void writeSSE({
      event: "keepalive",
      // Echo the latest issued revision so a reconnect exposes a missed-frame
      // gap through the same cursor path as ordinary events.
      id: String(latestRevision),
      data: "{}",
    }).catch((error) => {
      log.warn("sse.keepalive-failed", { error: formatLogError(error, { stack: false }) });
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
 * further, and reconnects with its cursor: an unbounded chain against a
 * stalled consumer (dead TCP, slow tunnel) would grow forever. Frames are
 * content-free, so the frame count is the bound that binds in practice.
 */
const MAX_PENDING_SSE_FRAMES = 1_000;
const MAX_PENDING_SSE_BYTES = 16 * 1024 * 1024;
/** Cap for events buffered while the handshake is being written. */
const MAX_BUFFERED_HANDSHAKE_EVENTS = 10_000;

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
  // The token is accepted only in a header: one in a URL ends up in logs.
  if (isBridgeAuthEnabled() && !isPublicHealthRequest(c.req.method, c.req.path)) {
    const dedicatedHeaderToken = c.req.raw.headers.get("x-orkestrator-codex-token")?.trim();
    const headerToken = bearerToken(c.req.raw.headers.get("authorization") ?? undefined);
    if (!tokenMatches(dedicatedHeaderToken) && !tokenMatches(headerToken)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    // What changes an agent's authority also needs the backend's signature,
    // which a token caught in flight does not carry (bridge-authority.ts).
    const admission = await admitFetchBridgeRequest(bridgeCredential.authority, c.req.raw);
    if ("refusal" in admission) {
      return c.json(admission.refusal.body, admission.refusal.status);
    }
    if (admission.request) c.req.raw = admission.request;
  }
  await next();
});

/**
 * Session routes answer only once the persisted registry is restored. Until
 * then an unknown session may be one still on disk, and the backend acts on
 * `missing` and on a 404 by deleting the session's mapping and dispatch history
 * (seen right after an account switch replaced the bridge under load). The
 * restore is a disk read; past the bound the answer is 503, which the backend
 * treats as unavailable and retries.
 */
const SESSION_RESTORE_WAIT_MS = 10_000;
const awaitRestoredSessions = async (c: Context, next: Next) => {
  if (!(await appServerRuntime.whenSessionsRestored(SESSION_RESTORE_WAIT_MS))) {
    return c.json({ error: "The Codex bridge is still restoring its sessions" }, 503);
  }
  await next();
};
app.use("/session/*", awaitRestoredSessions);
app.use("/sessions/*", awaitRestoredSessions);

// Transcript bodies dominate bridge bandwidth. Keep SSE uncompressed here —
// its own flush-sensitive writer has different backpressure semantics.
app.use("/session/:id/messages", async (c, next) => {
  await next();
  c.res.headers.append("Vary", "Accept-Encoding");
});
app.use("/session/:id/messages", compress({ encoding: "gzip" }));
app.use("/session/:id/transcript", async (c, next) => {
  await next();
  c.res.headers.append("Vary", "Accept-Encoding");
});
app.use("/session/:id/transcript", compress({ encoding: "gzip" }));

// The live logging settings. Metadata only; see `applyBridgeLogPolicy`.
app.post(BRIDGE_LOG_POLICY_ROUTE, async (c) => {
  const answer = applyBridgeLogPolicy(await readBridgeLogPolicyBody(c.req.raw));
  return c.json(answer.body, answer.status);
});

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
        // How the previous child died, so an unexplained restart can be told
        // apart after the fact (SIGKILL from outside vs. Codex exiting itself).
        lastExitCode: health.lastExitCode ?? null,
        lastExitSignal: health.lastExitSignal ?? null,
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
      events: { latestRevision, subscribers: subscribers.size },
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

app.get("/global/auth", async (c) => {
  const raw = (await appServerRuntime.readAuthStatus()) as {
    account?: { type?: string; email?: string | null; planType?: string } | null;
    requiresOpenaiAuth?: boolean;
    pendingSignIn?: unknown;
  };
  const account = raw.account;
  const pendingSignIn = normalizePendingSignIn(raw.pendingSignIn);
  if (!account) {
    return c.json({
      state: raw.requiresOpenaiAuth ? "needs-auth" : "signed-out",
      signIn: { kind: "browser-url" },
      signOut: false,
      pendingSignIn: pendingSignIn ?? null,
    });
  }
  const label = account.type === "chatgpt" ? account.email || "ChatGPT" : account.type || "Codex";
  return c.json({
    state: "signed-in",
    pendingSignIn: pendingSignIn ?? null,
    account: { label, ...(account.planType ? { plan: account.planType } : {}) },
    signIn: { kind: "browser-url" },
    signOut: true,
  });
});

app.post("/global/auth/login", async (c) => {
  // `{ method: "device-code" }` asks for the flow without a loopback callback.
  const body = (await c.req.json().catch(() => ({}))) as { method?: unknown };
  const method = body?.method === "device-code" ? "device-code" : "browser";
  const raw = (await appServerRuntime.beginAuthLogin(method)) as {
    authUrl?: string;
    verificationUrl?: string;
    userCode?: string;
  };
  return c.json({
    ...(raw.authUrl || raw.verificationUrl ? { url: raw.authUrl ?? raw.verificationUrl } : {}),
    ...(raw.userCode ? { code: raw.userCode } : {}),
  });
});

/**
 * Abandon the in-tab sign-in this bridge started (`account/login/cancel`).
 * Answers only whether one was open; the login id never leaves the bridge.
 */
app.post("/global/auth/login/cancel", async (c) => {
  const status = await appServerRuntime.cancelAuthLogin();
  return c.json({ cancelled: status === "canceled" });
});

app.post("/global/auth/logout", async (c) => {
  await appServerRuntime.logoutAuth();
  return c.json({ ok: true });
});

app.get("/global/models", async (c) => {
  return c.json(await appServerRuntime.listModels());
});

/**
 * The enhanced (version 1) catalogue for one session. Metadata only: it does
 * not touch liveness, hydrate a transcript or re-attach an idle thread. An
 * unknown session is answered in band as `missing`, never 404 — a 404 here
 * means "this bridge predates the route".
 */
app.get("/session/:id/commands", async (c) => {
  return c.json(await appServerRuntime.getCommandCatalogue(c.req.param("id")));
});

/** Explicit refresh: rescans skills from disk (`reloaded`) and rereads templates. */
app.post("/session/:id/commands/refresh", async (c) => {
  return c.json(await appServerRuntime.refreshCommandCatalogue(c.req.param("id")));
});

app.get("/session/list", async (c) => {
  return c.json(
    await appServerRuntime.listSessions({
      includeArchived: c.req.query("includeArchived") === "1",
    }),
  );
});

/**
 * Removes a conversation from the resume list (`thread/archive`) or restores
 * it. The id is a resume-list id (a Codex thread id), never a bridge session.
 * Archive keeps the rollout; nothing here deletes a thread.
 */
for (const action of ["archive", "unarchive"] as const) {
  app.post(`/session/list/:threadId/${action}`, async (c) => {
    const threadId = c.req.param("threadId").trim();
    if (!threadId || threadId.length > 256) return c.json({ error: "threadId is invalid" }, 400);
    const outcome = await appServerRuntime.setResumableArchived(threadId, action === "archive");
    if (outcome === "in-use") {
      return c.json({ error: "This conversation is open in a tab" }, 409);
    }
    if (outcome === "failed") {
      return c.json({ error: `Codex could not ${action} this conversation` }, 502);
    }
    return c.json({ archived: outcome === "archived" });
  });
}

app.post("/session/create", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(appServerRuntime.createSession(body), 201);
});

app.post("/session/resume", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const resumed = await appServerRuntime.resumeSession(body);
  if (!resumed) return c.json({ error: "threadId is required" }, 400);
  return c.json(
    {
      sessionId: resumed.sessionId,
      ...(resumed.title ? { title: resumed.title } : {}),
      threadId: resumed.threadId,
    },
    201,
  );
});

app.post("/session/:id/config", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const outcome = await appServerRuntime.updateConfig(sessionId, body);
  if (outcome === "not-found") return c.json({ error: "Session not found" }, 404);
  if (outcome === "invalid-policy") return c.json({ error: "Invalid execution policy" }, 400);
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
  const sessionId = c.req.param("id");
  const messages = await appServerRuntime.getMessages(sessionId);
  if (!messages) return c.json({ error: "Session not found" }, 404);
  // `?limit=` asks for the newest messages only; unusable values send the
  // whole window, as before the parameter existed.
  const limit = parseTranscriptTailLimit(c.req.query("limit") ?? null);
  const bounded = boundCodexTranscriptResponse(messages, limit ?? undefined);
  // This is the exact recovery surface, so it must not present a transcript the
  // local ring buffer already evicted from as the whole conversation.
  if (appServerRuntime.transcriptComplete(sessionId)) return c.json(bounded);
  return c.json({
    ...bounded,
    messageWindow: { ...bounded.messageWindow, truncated: true },
  });
});

// `GET /session/:id/transcript` and its detail and page reads.
registerCodexTranscriptRoutes(app, appServerRuntime);
registerCodexChangeEvidenceRoutes(app, codexChangeEvidence.spool);

app.get("/session/:id/status", (c) => {
  const status = appServerRuntime.getStatus(c.req.param("id"));
  if (!status) return c.json({ error: "Session not found" }, 404);
  return c.json(status);
});

/** Exact account usage is fetched on demand; status polling stays cache-only. */
app.get("/session/:id/usage", async (c) => {
  try {
    const contextUsage = await appServerRuntime.getUsage(c.req.param("id"));
    if (contextUsage === null) return c.json({ error: "Session not found" }, 404);
    return c.json({ contextUsage });
  } catch (error) {
    log.warn("account.usage-read-failed", { error: formatLogError(error, { stack: false }) });
    return c.json({ error: "Account usage is temporarily unavailable" }, 503);
  }
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
app.get("/session/:id/human-prompts", (c) => {
  return c.json(appServerRuntime.humanPromptOutput(c.req.param("id")));
});

app.get("/session/:id/activity", (c) => {
  return c.json(appServerRuntime.getActivitySnapshot(c.req.param("id")));
});
// The batched form of the route above, answered from the same no-touch read.
registerSessionActivityBatchRoute(app, appServerRuntime);

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
 * being asked, so it answers `unknown`, as does any record under another
 * session. `absent` is an assertion too, never a default: with no record at
 * all, it is answered only where `promptDispatchAbsent` proves the id never
 * reached Codex (a tracked journal, a session this bridge created fresh, no
 * trace of the id, no prompt for it in flight). Everything else is `unknown`.
 * Never `lost`: this bridge refuses no id for good.
 */
app.get("/session/:id/dispatch", (c) => {
  const requestId = c.req.query("requestId")?.trim();
  if (!requestId) return c.json({ dispatch: "unknown" });
  const sessionId = c.req.param("id");
  const record = appServerRuntime.getJournal().get(requestId);
  if (!record) {
    return c.json({
      dispatch: appServerRuntime.promptDispatchAbsent(sessionId, requestId) ? "absent" : "unknown",
    });
  }
  // Unlike the other two bridges this journal is process-global, so the record
  // has to be checked against the session that is asking. Answering across
  // sessions would let one session's history settle another's parked dispatch.
  const dispatched =
    record.bridgeSessionId === sessionId &&
    (record.state === "accepted" || record.state === "terminal");
  return c.json({
    dispatch: dispatched ? "dispatched" : "unknown",
    ...(dispatched ? { pending: record.state === "accepted" } : {}),
  });
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
  appServerRuntime.assertPromptPolicyNotWidened(sessionId, body.policy);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const outputSchema = body.outputSchema;
  const readOnly = body.readOnly;
  const agentMcp = body.agentMcp;
  const workflowResultTool = body.workflowResultTool;
  const approvalMode = body.approvalMode;
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (
    rawAttachments.some(
      (entry: unknown) =>
        typeof (entry as PromptAttachmentInput | null)?.path !== "string" ||
        (entry as PromptAttachmentInput).type !== "image",
    )
  ) {
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
    return c.json({ error: "requestId must be a non-empty string of at most 200 characters" }, 400);
  }
  if (outputSchema !== undefined && !isJsonSchema(outputSchema)) {
    return c.json({ error: "outputSchema must be a JSON Schema object" }, 400);
  }
  if (readOnly !== undefined && typeof readOnly !== "boolean") {
    return c.json({ error: "readOnly must be a boolean" }, 400);
  }
  const workflowResult = readWorkflowResultTurn(
    body && typeof body === "object" && !Array.isArray(body) ? body : {},
  );
  if (!workflowResult.ok) return c.json({ error: workflowResult.error }, 400);
  if (workflowResultTool !== undefined && !isScopedAgentMcp(agentMcp)) {
    return c.json({ error: "workflowResultTool requires agentMcp" }, 400);
  }
  if (approvalMode !== undefined && !isCodexApprovalMode(approvalMode)) {
    return c.json({ error: "approvalMode is not a Codex approval mode" }, 400);
  }
  const commandFields = readBridgePromptCommandFields(
    body && typeof body === "object" && !Array.isArray(body) ? body : {},
  );
  if (!commandFields.ok) return c.json({ error: commandFields.error }, 400);

  const outcome = await appServerRuntime.prompt(sessionId, {
    prompt,
    requestId,
    attachments,
    outputSchema,
    ...(typeof readOnly === "boolean" ? { readOnly } : {}),
    ...(isScopedAgentMcp(agentMcp) ? { agentMcp } : {}),
    ...(typeof workflowResultTool === "string" ? { workflowResultTool } : {}),
    ...(workflowResult.turn ? { workflowResultTurn: workflowResult.turn } : {}),
    ...(isCodexApprovalMode(approvalMode) ? { approvalMode } : {}),
    ...(commandFields.allowProviderCommands ? {} : { allowProviderCommands: false }),
    ...(commandFields.command ? { command: commandFields.command } : {}),
  });
  if (!outcome.ok) {
    // Nothing was journaled or sent: the backend treats this as a rejection
    // and keeps the draft, never as an ambiguous dispatch.
    if (outcome.status === 422) return c.json(commandUnavailableResponse(outcome.error), 422);
    return c.json({ error: outcome.error }, outcome.status);
  }
  return c.json(outcome.result, 202);
});

/** `{ "held": boolean }`, or null for anything else. */
function parseHoldBody(body: unknown): boolean | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const held = (body as { held?: unknown }).held;
  return typeof held === "boolean" ? held : null;
}

/** Maps a pause/resume outcome onto the hold routes' status codes and bodies. */
function holdRouteResponse(
  outcome: ParkedHoldResponse,
  subject: "Approval" | "Interaction",
):
  | {
      status: 200;
      body: { status: "applied" | "unchanged"; expiresAt: number; hold: AgentInteractionHold };
    }
  | { status: 403 | 409 | 422; body: { error: string; status?: string } } {
  switch (outcome.status) {
    case "wrong-session":
      return { status: 403, body: { error: `${subject} does not belong to this session` } };
    case "unknown":
      // 409, as for an answer: the window closed, so the card is stale.
      return { status: 409, body: { error: `${subject} is no longer pending`, status: "stale" } };
    case "unavailable":
      return {
        status: 422,
        body: { error: "This request's deadline cannot be extended", status: "unavailable" },
      };
    default:
      return {
        status: 200,
        body: { status: outcome.status, expiresAt: outcome.expiresAt, hold: outcome.hold },
      };
  }
}

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
    return c.json({ error: `decision must be one of: ${APPROVAL_DECISIONS.join(", ")}` }, 400);
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
    return c.json({ error: "Approval lacks the detail required to approve it" }, 422);
  }
  if (outcome === "unknown") {
    // 409, not 404: the approval existed but the window closed (answered,
    // expired, or the child restarted). The UI should drop the card, not retry.
    return c.json({ error: "Approval is no longer pending", status: "stale" }, 409);
  }
  return c.json({ status: "applied", decision: body.decision });
});

/**
 * Pauses (`held: true`) or resumes a parked approval's countdown.
 *
 * Never answers the approval: a pause only moves the deny-at-expiry deadline
 * to the hold ceiling, and a resume restarts a fresh window. Like the answer
 * route it does not touch liveness. The backend reads the moved `expiresAt`
 * back from `GET /session/:id/approvals`.
 */
app.post("/session/:id/approvals/:approvalId/hold", async (c) => {
  const held = parseHoldBody(await c.req.json().catch(() => null));
  if (held === null) return c.json({ error: "held must be a boolean" }, 400);
  const response = holdRouteResponse(
    appServerRuntime.holdApproval(c.req.param("id"), c.req.param("approvalId"), held),
    "Approval",
  );
  return c.json(response.body, response.status);
});

app.get("/session/:id/interactions", (c) => {
  return c.json({
    interactions: appServerRuntime.listInteractions(c.req.param("id")),
  });
});

app.post("/session/:id/interactions/:interactionId", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.action !== "accept" && body.action !== "decline" && body.action !== "cancel") {
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

/** The interaction counterpart of the approval hold route; same contract. */
app.post("/session/:id/interactions/:interactionId/hold", async (c) => {
  const held = parseHoldBody(await c.req.json().catch(() => null));
  if (held === null) return c.json({ error: "held must be a boolean" }, 400);
  const response = holdRouteResponse(
    appServerRuntime.holdInteraction(c.req.param("id"), c.req.param("interactionId"), held),
    "Interaction",
  );
  return c.json(response.body, response.status);
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
      return c.json(
        {
          sessionId: result.sessionId,
          ...(result.title ? { title: result.title } : {}),
          threadId: result.threadId,
        },
        201,
      );
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
  if (outcome === "closing") return c.json({ error: SESSION_CLOSING_ERROR }, 409);
  if (outcome === "unavailable") return c.json({ error: "Compaction could not be started" }, 503);
  // 202: `thread/compact/start` returns before the rewrite has happened. The
  // session stays busy until the bridge sees `thread/compacted`.
  return c.json({ status: "accepted" }, 202);
});

app.post("/session/:id/steer", async (c) => {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await c.req.json();
    body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
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
  // No `outcome` field: the backend reads this as a definite refusal, not "idle".
  if (outcome === "closing") return c.json({ error: SESSION_CLOSING_ERROR }, 409);
  // Nothing was sent: the dispatch journal could not record the id first. Like
  // `closing`, a 409 with no `outcome` is a definite refusal.
  if (outcome === "unavailable") {
    return c.json({ error: "Dispatch journal is unavailable; the text was not sent" }, 409);
  }
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

app.get("/session/:id/steer/dispatch", async (c) => {
  const requestId = c.req.query("requestId")?.trim();
  if (!requestId) return c.json({ dispatch: "unknown" });
  // Route qualification must remain O(1): it proves this bridge version owns
  // the no-touch surface without paying a thread/read for a deliberately
  // nonexistent request id.
  if (requestId === "orkestrator-steer-qualification") {
    return c.json({ dispatch: "unknown" });
  }
  return c.json({
    dispatch: await appServerRuntime.steerDispatchStatus(c.req.param("id"), requestId),
  });
});

app.post("/session/:id/review", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  /**
   * A named target with a missing or blank field is a client bug, not a request
   * to review the working tree. Silently degrading it to `uncommittedChanges`
   * started a *different* review from the one asked for — spending a turn and
   * tokens — and answered 202 as if it had succeeded.
   */
  const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
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
  if (result.outcome === "closing") return c.json({ error: SESSION_CLOSING_ERROR }, 409);
  if (result.outcome === "unavailable") return c.json({ error: "Native review failed" }, 503);
  return c.json({ status: "processing", turnId: result.turnId }, 202);
});

/** Authenticated, allowlisted runtime inventory for one known bridge session. */
app.get("/session/:id/runtime-health", async (c) => {
  const health = await appServerRuntime.getRuntimeHealth(c.req.param("id"));
  return health ? c.json(health) : c.json({ error: "Session not found" }, 404);
});

app.get("/session/:id/mcp", async (c) => {
  const raw = (await appServerRuntime.listMcpServers(c.req.param("id"))) as {
    data?: unknown[];
  } | null;
  if (!raw) return c.json({ error: "Session not found" }, 404);
  const servers = (raw.data ?? []).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const server = candidate as {
      name?: unknown;
      runtimeStatus?: unknown;
      authStatus?: unknown;
      pluginId?: unknown;
      tools?: unknown;
      error?: unknown;
      toolsError?: unknown;
    };
    if (typeof server.name !== "string") return [];
    const status =
      server.authStatus === "notLoggedIn" || server.runtimeStatus === "authenticationRequired"
        ? "needs-auth"
        : server.runtimeStatus === "connected"
          ? "connected"
          : server.runtimeStatus === "starting"
            ? "connecting"
            : server.runtimeStatus === "disabled"
              ? "disabled"
              : server.runtimeStatus === "failed" || server.runtimeStatus === "cancelled"
                ? "failed"
                : "unknown";
    // app-server's `tools` is a map whose key order changes from one read to
    // the next. Sorted before the cut, so an unchanged server reads the same
    // every time and the backend's 30 s discovery renewal of an idle view
    // does not announce a reordering as a change (#2062).
    const tools =
      server.tools && typeof server.tools === "object"
        ? Object.keys(server.tools).sort().slice(0, 256)
        : [];
    return [
      {
        id: server.name,
        name: server.name,
        status,
        ...(typeof server.pluginId === "string" ? { scope: "plugin" as const } : {}),
        toolCount: tools.length,
        tools,
        // Redacted before the cut, so a bound never leaves part of a token.
        ...(typeof server.error === "string"
          ? { error: redactSecrets(server.error).slice(0, 1_000) }
          : typeof server.toolsError === "string"
            ? { error: redactSecrets(server.toolsError).slice(0, 1_000) }
            : {}),
        actions: status === "needs-auth" ? ["sign-in" as const] : ["reconnect" as const],
      },
    ];
  });
  return c.json({ servers });
});

registerMcpReloadRoute(app, appServerRuntime);
registerSessionCloseRoute(app, appServerRuntime);

app.post("/session/:id/mcp/:name/:action", async (c) => {
  const action = c.req.param("action");
  if (action !== "reconnect" && action !== "sign-in") {
    return c.json({ error: "Unsupported MCP action" }, 400);
  }
  const outcome = await appServerRuntime.performMcpAction(
    c.req.param("id"),
    c.req.param("name"),
    action,
  );
  if (!outcome) return c.json({ error: "Session not found" }, 404);
  return c.json(outcome.authorizationUrl ? { url: outcome.authorizationUrl } : {});
});

app.post("/session/:id/rewind-messages", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
  if (!messageId) return c.json({ error: "messageId is required" }, 400);
  const outcome = await appServerRuntime.rewindMessages(c.req.param("id"), messageId);
  if (outcome === "not-found") return c.json({ error: "Session not found" }, 404);
  if (outcome === "running") return c.json({ error: "Session is running" }, 409);
  if (outcome === "unavailable") return c.json({ error: "Message cannot be rewound" }, 409);
  return c.json({ rewound: true });
});

app.post("/session/:id/title", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = typeof body.title === "string" ? normalizeExplicitSessionTitle(body.title) : "";
  if (!title) return c.json({ error: "title is required" }, 400);
  return (await appServerRuntime.setSessionTitle(c.req.param("id"), body.title))
    ? c.json({ title })
    : c.json({ error: "Session not found" }, 404);
});

app.post("/session/:id/abort", async (c) => {
  const outcome = await appServerRuntime.abort(c.req.param("id"));
  if (!outcome) return c.json({ error: "Session not found" }, 404);
  // 202: turn/interrupt is asynchronous, so the turn is not over yet. Reporting
  // "aborted" here would let a new prompt overlap a turn still executing.
  return c.json({ status: outcome.status, phase: outcome.phase }, 202);
});

app.get("/event/subscribe", (c) => {
  // The full-payload stream is gone; every backend that subscribes sends
  // `observe=1`. Refusing anything else fails a consumer that expects payloads
  // loudly, rather than handing it content-free frames it would misread as
  // empty updates.
  if (c.req.query("observe") !== "1") {
    return c.json(
      { error: "observe=1 is required: this bridge serves only the observation stream" },
      400,
    );
  }
  // `?since=` is what the backend sends; `Last-Event-ID` is what a native
  // EventSource sends when it reconnects on its own. Accept both.
  const cursor =
    parseEventCursor(c.req.query("since")) ?? parseEventCursor(c.req.header("last-event-id"));

  return streamSSE(c, async (stream) => {
    let open = true;
    let resolveConnectionClosed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => {
      resolveConnectionClosed = resolve;
    });
    // Closing is the recovery path for a consumer that cannot keep up: it
    // reconnects with the last id it saw and learns of the gap, instead of this
    // connection retaining an ever-growing frame backlog.
    const failSlowSubscriber = (reason: string) => {
      if (!open) return;
      open = false;
      log.info("sse.closed", { reason });
      resolveConnectionClosed();
    };
    const writeWhileOpen = createSerializedSseWriter(
      createOpenSseWriter(
        () => open,
        (event: { event: string; data: string; id?: string }) => stream.writeSSE(event),
      ),
      { onOverflow: () => failSlowSubscriber("write backlog exceeded its cap") },
    );

    // The `id:` is the cursor the client echoes back on its next connection.
    const frameFor = (event: Pick<SseEvent, "type" | "sessionId">, revision: number) => ({
      event: event.type,
      id: String(revision),
      data: observationFrameData(event.sessionId),
    });

    /**
     * Registered *before* the cursor is checked, buffering into an array.
     *
     * Ordering matters: if we read the revision first and subscribed second, an
     * event emitted in between would be neither reported as a gap nor
     * delivered. So we subscribe and read the revision in one synchronous step,
     * write the handshake, then flush anything that arrived meanwhile.
     */
    const subscribedAt = latestRevision;
    const anchorRevision = cursor ?? subscribedAt;
    let buffered: Array<{
      event: Pick<SseEvent, "type" | "sessionId">;
      revision: number;
    }> | null = [];
    let highestSent = anchorRevision;

    const listener: SseSubscriber = async (event, revision) => {
      if (buffered) {
        if (
          buffered.length >=
          (sseRouteTestHooks?.maxBufferedHandshakeEvents ?? MAX_BUFFERED_HANDSHAKE_EVENTS)
        ) {
          failSlowSubscriber("handshake buffer overflowed");
          return;
        }
        buffered.push({ event: { type: event.type, sessionId: event.sessionId }, revision });
        return;
      }
      if (revision <= highestSent) return;
      highestSent = revision;
      await writeWhileOpen(frameFor(event, revision));
    };
    subscribers.add(listener);

    let keepalive: ReturnType<typeof setInterval> | undefined;

    try {
      if (sseRouteTestHooks?.afterSubscriberRegistered) {
        await sseRouteTestHooks.afterSubscriberRegistered();
      }
      // Nothing is retained for replay, so a cursor is either current or a
      // gap: an older revision, or a future one from before a bridge restart.
      const gap = cursor !== null && cursor !== subscribedAt;

      await writeWhileOpen({
        event: "connected",
        /**
         * The client's *own* position, not the latest revision.
         *
         * A client adopts the id of every frame it sees, including this one. If
         * it took the latest revision here and the connection then died before
         * the gap frame was read, it would reconnect looking caught up and never
         * learn that it had missed events. Echoing its cursor back makes the
         * handshake idempotent.
         */
        id: String(anchorRevision),
        data: JSON.stringify({
          status: "connected",
          timestamp: new Date().toISOString(),
          revision: subscribedAt,
          // Confirms observation mode; a backend refuses a bridge that does not.
          observe: true,
        }),
      });

      if (gap) {
        // Say so explicitly rather than letting the client think it is caught up.
        await writeWhileOpen({
          event: "session.reconcile-required",
          id: String(subscribedAt),
          data: JSON.stringify({
            reason: "cursor-expired",
            requestedRevision: cursor,
            latestRevision: subscribedAt,
          }),
        });
        highestSent = subscribedAt;
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
        await writeWhileOpen(frameFor(entry.event, entry.revision));
      }
      buffered = null;
      // Start only after the handshake and its buffered tail are flushed. A
      // keepalive carries the latest id, so sending one earlier would jump the
      // client's cursor past frames it had not received yet.
      keepalive = startSseKeepalive(writeWhileOpen);
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

function startBridge(
  env: NodeJS.ProcessEnv = process.env,
  listen: (options: BridgeServerOptions) => unknown = serve,
  runtime: Pick<AppServerRuntime, "start" | "getHealth"> = appServerRuntime,
): unknown {
  // Mark restoration synchronously before a listener can receive requests.
  void startSelectedEngine(env, runtime);
  return startBridgeServer(env, listen);
}

const shutdownHandler = createShutdownHandler(cleanupTimer);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, shutdownHandler);
}

// A dead backend can no longer signal us, so watch for it and run the same
// graceful drain a SIGTERM would have triggered.
// A dropped promise must not take this bridge — and every session it is
// serving — down with it.
installFatalRejectionGuard({ label: "[codex-bridge]", onRejection: logUnhandledRejection });

/**
 * How long a dead backend's running turns get to stop before the drain ends
 * app-server anyway. The next backend reaps an orphaned bridge about 5 s after
 * it starts, so detection (`PARENT_WATCH_INTERVAL_MS`) plus this stays inside it.
 */
const PARENT_EXIT_INTERRUPT_BUDGET_MS = 2_000;

const parentPid = parseParentPid(process.env[PARENT_PID_ENV]);
if (parentPid !== null) {
  startParentWatchdog({
    parentPid,
    onParentExit: () => {
      log.warn("parent.gone", { parentPid });
      // Nothing supervises a turn once its backend is gone: stop it now rather
      // than letting the agent keep editing until the drain kills app-server.
      void createParentExitHandler(
        (budgetMs) => appServerRuntime.interruptForParentExit(budgetMs),
        shutdownHandler,
      )();
    },
  });
}

startBridge();
