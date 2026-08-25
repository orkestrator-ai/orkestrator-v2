import {
  existsSync,
  path,
  createHash,
  randomBytes,
  APP_VERSION,
  CLAUDE_BRIDGE_PORT,
  CODEX_BRIDGE_PORT,
  CURSOR_ACP_BRIDGE_PORT,
  CODEX_MAX_CONCURRENT_THREADS_ENV,
  GROK_ACP_BRIDGE_PORT,
  PI_BRIDGE_PORT,
  OPENCODE_SERVER_PORT,
  resolveCodexMaxConcurrentThreads,
  ORKESTRATOR_AGENT_MCP_SERVER_NAME,
  ORKESTRATOR_AGENT_MCP_TOKEN_ENV,
  ORKESTRATOR_AGENT_MCP_URL_ENV,
  runCommand,
  cleanupEnvironmentTmux,
  shutdownClaudeStatePolling,
  AGENT_PLATFORM_LABELS,
} from "./commands-dependencies.js";
import {
  enqueueLocalServerEnvironmentOperation,
  localServerFields,
  releaseLocalServerOwnership,
  terminateLocalServerChild,
  cancelOpenCodeAgentToolsConfiguration,
  aggregateRejectedResults,
  stopLocalServerUnlocked,
  stopLocalServersForEnvironmentUnlocked,
} from "./commands-local-server-lifecycle.js";
import {
  checkHttpHealth,
  waitForLocalServerHealth,
  openCodeHealthHeaders,
  bearerBridgeHeaders,
  agentToolConnectionFingerprint,
} from "./commands-server-health.js";
import type {
  ChildProcessWithoutNullStreams,
  Environment,
  AgentToolConnection,
  AgentModel,
  AgentReasoningOption,
} from "./commands-dependencies.js";
import {
  AGENT_TEST_CURSOR_CREDENTIAL_STORE_ENV,
  AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV,
  localServerProcesses,
  localCodexBridgeTokens,
  localClaudeBridgeTokens,
  localOpenCodeServerPasswords,
  localCursorBridgeTokens,
  localGrokBridgeTokens,
  localPiBridgeTokens,
  localCursorCredentialFingerprints,
  openCodeAgentToolsConfigurations,
  configuredOpenCodeAgentTools,
  BRIDGE_TOKEN_PATTERN,
  localServerEnvironmentOperations,
  containerBridgeOperations,
  deletingLocalServerEnvironments,
  mergingEnvironments,
  mergeCleanupRecoveryTasks,
  retryableBridgeStartupError,
  LOCAL_SERVER_KINDS,
  isLocalServerShutdownRequested,
  requestLocalServerShutdown,
  getLocalServerShutdownPromise,
  setLocalServerShutdownPromise,
  spawnLocalServerCommandImpl,
  gitFetchScheduler,
  diffStatsService,
  invalidatePendingDiffStatsSync,
} from "./commands-runtime-state.js";
import {
  prMonitorService,
  invalidatePendingPrMonitorSync,
  setMergeCleanupScheduler,
} from "./commands-pr-monitor.js";
import { resolveCursorApiKey, cursorApiKeyFingerprint } from "./commands-validation.js";
import {
  resolveCodexBinary,
  resolveOpenCodeBinary,
  resolveClaudeBinary,
  resolveManagedAcpBinary,
  resolveBunBinary,
} from "./commands-agent-support.js";
import { cleanupTerminalSessionsForEnvironment } from "./commands-terminal.js";
import {
  assertDockerContainerOwned,
  cleanupEnvironmentSetupState,
  enqueueEnvironmentLifecycleOperation,
  invalidateEnvironmentStartDedupe,
  removeLocalWorktree,
  deleteMergedEnvironmentRemoteBranch,
} from "./commands-environment.js";
import { getHostPort } from "./commands-container-exec.js";
import { dockerExec } from "./commands-container-exec.js";
import { conciseError, cleanupErrorMessage } from "./commands-error-text.js";
import {
  getClaudeOAuthAccessToken,
  getHostClaudeCredentials,
  getHostCursorCredentials,
  syncAgentTestCursorCredentials,
} from "./commands-files.js";
import { cursorSdkBridgeEnabled, cursorSdkCredentialPath } from "./cursor-sdk-bridge.js";
import type { OpenCodeAgentToolsOutcome, LocalServerKind } from "./commands-runtime-state.js";
import type { CommandContext } from "./commands-context.js";

export async function waitForLocalServerStartup(
  child: ChildProcessWithoutNullStreams,
  port: number,
  kind: LocalServerKind,
  headers?: Record<string, string>,
): Promise<void> {
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const complete = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => complete(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      complete(
        new Error(
          `${kind} server exited before becoming healthy (code ${code ?? "null"}, signal ${signal ?? "null"})`,
        ),
      );
    };

    child.once("error", onError);
    child.once("exit", onExit);
    waitForLocalServerHealth(port, kind, headers).then(
      () => complete(),
      (error: unknown) => {
        complete(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function getBridgePath(
  context: CommandContext,
  bridgeName: "claude-bridge" | "codex-bridge" | "acp-bridge" | "pi-bridge" | "cursor-bridge",
): string {
  const devPath = path.join(context.appRoot, "bridges", bridgeName);
  if (process.env.NODE_ENV !== "production" && existsSync(devPath)) return devPath;
  return path.join(context.resourceRoot, bridgeName);
}

export function enqueueContainerBridgeOperation<T>(
  agent: LocalServerKind,
  containerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${agent}:${containerId}`;
  const previous = containerBridgeOperations.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  containerBridgeOperations.set(key, tail);
  void tail.finally(() => {
    if (containerBridgeOperations.get(key) === tail) {
      containerBridgeOperations.delete(key);
    }
  });
  return result;
}

export function assertLocalServerStartAllowed(environmentId: string): void {
  if (isLocalServerShutdownRequested()) {
    throw new Error("Backend is shutting down; local servers cannot be started");
  }
  if (deletingLocalServerEnvironments.has(environmentId)) {
    throw new Error(`Environment is being deleted: ${environmentId}`);
  }
}

/** Per-process renderer credentials for the given native server kind. */
export function localBridgeTokens(kind: LocalServerKind): Map<string, string> {
  if (kind === "codex") return localCodexBridgeTokens;
  if (kind === "claude") return localClaudeBridgeTokens;
  if (kind === "cursor") return localCursorBridgeTokens;
  if (kind === "grok") return localGrokBridgeTokens;
  if (kind === "pi") return localPiBridgeTokens;
  return localOpenCodeServerPasswords;
}

export function localServerPort(
  environment: Environment | null | undefined,
  kind: LocalServerKind,
): number | undefined {
  if (kind === "opencode") return environment?.localOpencodePort;
  if (kind === "claude") return environment?.localClaudePort;
  if (kind === "codex") return environment?.localCodexPort;
  if (kind === "cursor") return environment?.localCursorPort;
  if (kind === "pi") return environment?.localPiPort;
  return environment?.localGrokPort;
}

export function asLocalServerKind(value: unknown, field: string): LocalServerKind {
  if (!LOCAL_SERVER_KINDS.includes(value as LocalServerKind)) {
    throw new Error(`${field} must be one of: ${LOCAL_SERVER_KINDS.join(", ")}`);
  }
  return value as LocalServerKind;
}

/** Where each container bridge publishes its port and its renderer credential. */
export const CONTAINER_BRIDGE_PEEK: Record<
  LocalServerKind,
  { containerPort: number; tokenFile: string }
> = {
  claude: { containerPort: CLAUDE_BRIDGE_PORT, tokenFile: "/tmp/claude-bridge-token" },
  codex: { containerPort: CODEX_BRIDGE_PORT, tokenFile: "/tmp/codex-bridge-token" },
  cursor: { containerPort: CURSOR_ACP_BRIDGE_PORT, tokenFile: "/tmp/cursor-acp-bridge-token" },
  grok: { containerPort: GROK_ACP_BRIDGE_PORT, tokenFile: "/tmp/grok-acp-bridge-token" },
  pi: { containerPort: PI_BRIDGE_PORT, tokenFile: "/tmp/pi-bridge-token" },
  opencode: {
    containerPort: OPENCODE_SERVER_PORT,
    tokenFile: "/tmp/opencode-server-password",
  },
};

/**
 * Report a live local bridge without starting one.
 *
 * The read-only twin of `startLocalServer`, for background observers such as
 * the activity sweep. `start_local_*_server_cmd` spawns a process when none is
 * running, so polling through it would make the backend launch a bridge for
 * every environment that has ever held a session — and then keep them all warm
 * forever. An environment with no bridge simply has nothing running, which is
 * an answer the caller can use.
 */
export async function peekLocalAgentBridge(
  environmentId: string,
  context: CommandContext,
  kind: LocalServerKind,
): Promise<{ port: number; authToken: string } | null> {
  const child = localServerProcesses.get(`${kind}:${environmentId}`);
  if (!child || child.killed || !child.pid) return null;
  const authToken = localBridgeTokens(kind).get(environmentId);
  if (!authToken) return null;
  const environment = await context.storage.getEnvironment(environmentId);
  const port = localServerPort(environment, kind);
  if (!port) return null;
  const healthy = await checkHttpHealth(
    port,
    "/global/health",
    kind === "opencode"
      ? openCodeHealthHeaders(authToken)
      : kind === "cursor" || kind === "grok" || kind === "pi"
        ? bearerBridgeHeaders(authToken)
        : undefined,
  );
  return healthy ? { port, authToken } : null;
}

/**
 * Report a live container bridge without starting one.
 *
 * Deliberately does not reconcile agent-tool wiring at all. `get_*_server_status`
 * schedules background MCP reconciliation and mints an agent-tools credential
 * via `agentTools.connection`; neither side effect belongs to a pure observer.
 */
export async function peekContainerAgentBridge(
  containerId: string,
  kind: LocalServerKind,
): Promise<{ hostPort: number; authToken: string } | null> {
  const { containerPort, tokenFile } = CONTAINER_BRIDGE_PEEK[kind];
  const hostPort = await getHostPort(containerId, containerPort);
  if (!hostPort) return null;
  const authToken = (await dockerExec(containerId, `cat ${tokenFile} 2>/dev/null || true`)).trim();
  if (!BRIDGE_TOKEN_PATTERN.test(authToken)) return null;
  const healthy = await checkHttpHealth(
    hostPort,
    "/global/health",
    kind === "opencode"
      ? openCodeHealthHeaders(authToken)
      : kind === "cursor" || kind === "grok" || kind === "pi"
        ? bearerBridgeHeaders(authToken)
        : undefined,
  );
  return healthy ? { hostPort, authToken } : null;
}

/**
 * Read one bridge's live model catalogue for the durable cache.
 *
 * Named for the ACP bridges it was written against, and kept for Pi too: the
 * three serve `/global/models` identically behind a bearer token, so a second
 * copy of this would be the same function with one string changed.
 */
export async function fetchAcpNormalizedModels(
  environment: Environment,
  context: CommandContext,
  kind: "cursor" | "grok" | "pi",
  timeoutMs?: number,
): Promise<AgentModel[]> {
  const bridge =
    environment.environmentType === "local"
      ? await peekLocalAgentBridge(environment.id, context, kind)
      : environment.containerId
        ? await peekContainerAgentBridge(environment.containerId, kind)
        : null;
  if (!bridge) return [];
  const port = "port" in bridge ? bridge.port : bridge.hostPort;
  return fetchAcpNormalizedModelsAt(port, bridge.authToken, kind, timeoutMs);
}

/**
 * How long a `/global/models` read may take before it is abandoned.
 *
 * Pi may spend up to 30 seconds refreshing a dynamic provider on its first
 * catalogue read. The generic ACP bridges answer from local state, so they
 * retain their tighter bound while Pi's own bounded refresh is allowed to
 * finish instead of being aborted just before it can seed the cache.
 */
export function acpModelFetchTimeoutMs(kind: "cursor" | "grok" | "pi"): number {
  return kind === "pi" ? 35_000 : 8_000;
}

/** Read the normalized model rows from a known bridge endpoint. */
export async function fetchAcpNormalizedModelsAt(
  port: number,
  authToken: string,
  kind: "cursor" | "grok" | "pi",
  timeoutMs?: number,
): Promise<AgentModel[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/global/models`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        "X-Orkestrator-Acp-Token": authToken,
      },
      // A caller working to an overall deadline may narrow this, never widen it.
      signal: AbortSignal.timeout(
        Math.min(
          acpModelFetchTimeoutMs(kind),
          Math.max(1_000, timeoutMs ?? Number.MAX_SAFE_INTEGER),
        ),
      ),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { models?: unknown };
    if (!Array.isArray(body.models)) return [];
    return body.models.flatMap((candidate): AgentModel[] => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const model = candidate as Record<string, unknown>;
      if (typeof model.id !== "string" || model.id.length === 0) return [];
      const reasoning = Array.isArray(model.reasoning)
        ? model.reasoning.flatMap((option): AgentReasoningOption[] => {
            if (
              !option ||
              typeof option !== "object" ||
              typeof (option as { id?: unknown }).id !== "string"
            ) {
              return [];
            }
            const entry = option as { id: string; label?: unknown };
            return [
              {
                id: entry.id,
                label: typeof entry.label === "string" ? entry.label : entry.id,
              },
            ];
          })
        : undefined;
      return [
        {
          platform: kind,
          id: model.id,
          label: typeof model.label === "string" ? model.label : model.id,
          ...(typeof model.providerLabel === "string"
            ? { providerLabel: model.providerLabel }
            : { providerLabel: AGENT_PLATFORM_LABELS[kind] }),
          ...(typeof model.description === "string" ? { description: model.description } : {}),
          ...(reasoning && reasoning.length > 0 ? { reasoning } : {}),
          ...(typeof model.defaultReasoningId === "string"
            ? { defaultReasoningId: model.defaultReasoningId }
            : {}),
          supportsSpeed: model.supportsSpeed === true,
          supportsMode: model.supportsMode === true,
          // Carried through because the shared usage meter reads it, and a
          // platform that publishes a per-model context window has no other way
          // to reach the cache the launch dialogs read before a bridge exists.
          ...(typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
            ? { contextWindow: model.contextWindow }
            : {}),
          ...(typeof model.supportsImageInput === "boolean"
            ? { supportsImageInput: model.supportsImageInput }
            : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

export async function configureOpenCodeAgentTools(
  port: number,
  password: string,
  connection: AgentToolConnection,
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  url.searchParams.set("directory", directory);
  const headers = openCodeHealthHeaders(password);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: ORKESTRATOR_AGENT_MCP_SERVER_NAME,
      config: {
        type: "remote",
        url: connection.url,
        enabled: true,
        oauth: false,
        // Orkestrator's endpoint is on the same host. Do not inherit
        // OpenCode's 30-second connect/catalog default for this optional tool.
        timeout: 3_000,
        headers: {
          Authorization: `Bearer ${connection.token}`,
        },
      },
    }),
    signal: openCodeAgentToolsAbortSignal(5_000, signal),
  });
  if (!response.ok) {
    // Never include the response body: OpenCode may echo the submitted MCP
    // config, which contains the project-scoped bearer credential.
    throw new Error(
      `OpenCode rejected the Orkestrator agent tools configuration (${response.status})`,
    );
  }

  const payload = await readBoundedOpenCodeResponse(response);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("OpenCode returned an invalid MCP status response");
  }
  const status = readOpenCodeAgentToolsStatus(payload);
  if (status === null) {
    throw new Error("OpenCode omitted the Orkestrator MCP status");
  }
  if (status !== "connected") {
    // Treat transitional states as unsuccessful too: startup must not advertise
    // a server whose ticket tools are not usable yet. Do not include the remote
    // error field because it may echo connection configuration or credentials.
    const safeStatus =
      typeof status === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(status) ? status : "invalid";
    throw new Error(`OpenCode did not connect the Orkestrator agent tools (${safeStatus})`);
  }
}

export function openCodeAgentToolsAbortSignal(
  timeoutMs: number,
  signal?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function readOpenCodeAgentToolsStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const entry = (payload as Record<string, unknown>)[ORKESTRATOR_AGENT_MCP_SERVER_NAME];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const status = (entry as Record<string, unknown>).status;
  return typeof status === "string" ? status : null;
}

export const MAX_OPENCODE_MCP_STATUS_BYTES = 64 * 1024;

export async function readBoundedOpenCodeResponse(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new Error("OpenCode returned an empty MCP status response");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OPENCODE_MCP_STATUS_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("OpenCode MCP status response is too large");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_OPENCODE_MCP_STATUS_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("OpenCode MCP status response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  ).toString("utf8");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("OpenCode returned an invalid MCP status response");
  }
}

export const OPENCODE_AGENT_TOOLS_RETRY_DELAYS_MS: readonly number[] = [
  250, 500, 1_000, 2_000, 4_000,
];
export let openCodeAgentToolsRetryDelaysMs = OPENCODE_AGENT_TOOLS_RETRY_DELAYS_MS;

/**
 * How long a recorded outcome suppresses another POST.
 *
 * A `connected` memo must expire: OpenCode can drop, disable or fail the entry
 * while the server keeps running on the same port and password, so the
 * fingerprint alone can never notice. Re-POSTing periodically is the only
 * re-verification left now that a status GET is known to be unable to identify
 * the configured URL or credential. An `unavailable` outcome gets a shorter
 * cooldown so a repeated status read cannot restart the retry cycle back to
 * back.
 */
export const OPENCODE_AGENT_TOOLS_CONNECTED_TTL_MS = 5 * 60_000;
export const OPENCODE_AGENT_TOOLS_UNAVAILABLE_COOLDOWN_MS = 30_000;
export let openCodeAgentToolsConnectedTtlMs = OPENCODE_AGENT_TOOLS_CONNECTED_TTL_MS;
export let openCodeAgentToolsUnavailableCooldownMs = OPENCODE_AGENT_TOOLS_UNAVAILABLE_COOLDOWN_MS;

export function openCodeAgentToolsMemoWindowMs(state: OpenCodeAgentToolsOutcome["state"]): number {
  return state === "connected"
    ? openCodeAgentToolsConnectedTtlMs
    : openCodeAgentToolsUnavailableCooldownMs;
}

/** Reported by the local and container OpenCode status commands. */
export type OpenCodeAgentToolsState = "pending" | "connected" | "unavailable";

/**
 * What the backend last observed about a generation's ticket tools.
 *
 * An in-flight generation reads `pending` rather than the previous cycle's
 * failure, but a live `connected` memo keeps reading `connected` while a TTL
 * re-verification runs — a periodic re-POST must not flap the indicator.
 */
export function openCodeAgentToolsState(key: string): OpenCodeAgentToolsState {
  const recorded = configuredOpenCodeAgentTools.get(key);
  if (recorded?.state === "connected") return "connected";
  if (openCodeAgentToolsConfigurations.has(key)) return "pending";
  return recorded ? "unavailable" : "pending";
}

export function openCodeAgentToolsFingerprint(
  port: number,
  password: string,
  connection: AgentToolConnection,
  directory: string,
): string {
  return createHash("sha256")
    .update(String(port))
    .update("\0")
    .update(password)
    .update("\0")
    .update(directory)
    .update("\0")
    .update(agentToolConnectionFingerprint(connection))
    .digest("hex");
}

export function waitForOpenCodeAgentToolsRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

/**
 * Reconcile the optional Orkestrator MCP entry without extending native chat
 * startup. One task per server generation retries transient connect/catalog
 * failures; the terminal outcome is recorded so ordinary status reads do no I/O
 * and can report degraded ticket tools. Recorded outcomes expire, so a
 * long-lived server that later drops the entry is re-reconciled.
 */
export function scheduleOpenCodeAgentToolsConfiguration(
  key: string,
  port: number,
  password: string,
  connection: AgentToolConnection,
  directory: string,
): void {
  const fingerprint = openCodeAgentToolsFingerprint(port, password, connection, directory);
  const recorded = configuredOpenCodeAgentTools.get(key);
  if (recorded?.fingerprint === fingerprint) {
    if (Date.now() - recorded.at < openCodeAgentToolsMemoWindowMs(recorded.state)) {
      return;
    }
  } else if (recorded) {
    // The outcome map always describes the current generation, so a status read
    // never reports the previous port/credential's verdict.
    configuredOpenCodeAgentTools.delete(key);
  }

  const current = openCodeAgentToolsConfigurations.get(key);
  if (current?.fingerprint === fingerprint) return;
  current?.controller.abort();

  const controller = new AbortController();
  const delays = openCodeAgentToolsRetryDelaysMs;
  const task = (async () => {
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        await configureOpenCodeAgentTools(port, password, connection, directory, controller.signal);
        if (!controller.signal.aborted) {
          configuredOpenCodeAgentTools.set(key, {
            fingerprint,
            state: "connected",
            at: Date.now(),
          });
        }
        return;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (attempt === delays.length) {
          // Record the failure rather than only logging it: the status commands
          // report this so a session does not silently run without the ticket
          // tools it was told it would have.
          configuredOpenCodeAgentTools.set(key, {
            fingerprint,
            state: "unavailable",
            at: Date.now(),
          });
          console.warn(
            `[backend] OpenCode agent tools remain unavailable for ${key}:`,
            conciseError(error),
          );
          return;
        }
        await waitForOpenCodeAgentToolsRetry(delays[attempt]!, controller.signal);
        // An abort during the backoff resolves rather than throwing, so the
        // cancellation has to be observed here instead of via the next fetch.
        if (controller.signal.aborted) return;
      }
    }
  })();
  const configuration = { fingerprint, controller, task };
  openCodeAgentToolsConfigurations.set(key, configuration);
  void task.finally(() => {
    if (openCodeAgentToolsConfigurations.get(key) === configuration) {
      openCodeAgentToolsConfigurations.delete(key);
    }
  });
}

export function resetOpenCodeAgentToolsTuning(): void {
  openCodeAgentToolsRetryDelaysMs = OPENCODE_AGENT_TOOLS_RETRY_DELAYS_MS;
  openCodeAgentToolsConnectedTtlMs = OPENCODE_AGENT_TOOLS_CONNECTED_TTL_MS;
  openCodeAgentToolsUnavailableCooldownMs = OPENCODE_AGENT_TOOLS_UNAVAILABLE_COOLDOWN_MS;
}

export function setOpenCodeAgentToolsRetryDelays(delays: readonly number[]): void {
  openCodeAgentToolsRetryDelaysMs = delays;
}

export function setOpenCodeAgentToolsMemoWindows(
  connectedTtlMs: number,
  unavailableCooldownMs: number,
): void {
  openCodeAgentToolsConnectedTtlMs = connectedTtlMs;
  openCodeAgentToolsUnavailableCooldownMs = unavailableCooldownMs;
}

export function cancelAllOpenCodeAgentToolsConfigurations(): void {
  for (const configuration of openCodeAgentToolsConfigurations.values()) {
    configuration.controller.abort();
  }
  openCodeAgentToolsConfigurations.clear();
  configuredOpenCodeAgentTools.clear();
}

export async function startLocalServerUnlocked(
  environmentId: string,
  context: CommandContext,
  kind: LocalServerKind,
): Promise<{ port: number; pid: number; wasRunning: boolean; authToken?: string }> {
  const key = `${kind}:${environmentId}`;
  const allowCursorCredentials =
    context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("cursor");
  const cursorApiKey =
    kind === "cursor" && allowCursorCredentials
      ? resolveCursorApiKey((await context.storage.loadConfig()).global).apiKey
      : undefined;
  const agentTestHostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim();
  const hostCursorCredentials =
    kind === "cursor" &&
    context.runtimeFlavor === "agent-test" &&
    allowCursorCredentials &&
    !cursorApiKey &&
    agentTestHostHome
      ? await getHostCursorCredentials(process.platform, agentTestHostHome)
      : undefined;
  const cursorCredentialFingerprint =
    kind === "cursor"
      ? createHash("sha256")
          .update(allowCursorCredentials ? "allowed" : "denied")
          .update("\0")
          .update(cursorApiKeyFingerprint(cursorApiKey))
          .update("\0")
          .update(hostCursorCredentials?.accessToken ?? "")
          .update("\0")
          .update(hostCursorCredentials?.refreshToken ?? "")
          .update("\0")
          .update(hostCursorCredentials?.apiKey ?? "")
          .digest("hex")
      : undefined;
  const existing = localServerProcesses.get(key);
  if (existing && !existing.killed && existing.pid) {
    const env = await context.storage.getEnvironment(environmentId);
    const port = localServerPort(env, kind);
    const tokens = localBridgeTokens(kind);
    const authToken = tokens?.get(environmentId);
    const healthHeaders = authToken
      ? kind === "opencode"
        ? openCodeHealthHeaders(authToken)
        : kind === "cursor" || kind === "grok" || kind === "pi"
          ? bearerBridgeHeaders(authToken)
          : undefined
      : undefined;
    const credentialMatches =
      kind !== "cursor" ||
      localCursorCredentialFingerprints.get(environmentId) === cursorCredentialFingerprint;
    if (
      credentialMatches &&
      port &&
      authToken &&
      (await checkHttpHealth(port, "/global/health", healthHeaders))
    ) {
      if (kind === "opencode" && env?.worktreePath && context.agentTools) {
        scheduleOpenCodeAgentToolsConfiguration(
          `local:${environmentId}`,
          port,
          authToken,
          context.agentTools.connection(env.id, env.projectId, "host"),
          env.worktreePath,
        );
      }
      return {
        port,
        pid: existing.pid,
        wasRunning: true,
        authToken,
      };
    }
    await terminateLocalServerChild(key, existing);
  }

  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment?.worktreePath) {
    throw retryableBridgeStartupError("Local environment worktree is not available");
  }
  const agentToolConnection = context.agentTools?.connection(
    environment.id,
    environment.projectId,
    "host",
  );

  const port = await allocateLocalPort();
  let command = "";
  let cwd = environment.worktreePath;
  /**
   * Whether this Cursor session is being served by the SDK bridge.
   *
   * Recorded when the branch below selects it, because the token variable and
   * everything else downstream depend on which *bridge* is running rather than
   * on the platform: a Cursor session can be served by either.
   */
  let useCursorSdkBridge = false;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    CWD: environment.worktreePath,
    // Bridges are spawned detached, so they outlive a backend that dies
    // without running its shutdown path. Advertising our PID lets each bridge
    // watch for that and drain itself instead of orphaning its children.
    ORKESTRATOR_PARENT_PID: String(process.pid),
    ...(agentToolConnection
      ? {
          [ORKESTRATOR_AGENT_MCP_URL_ENV]: agentToolConnection.url,
          [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: agentToolConnection.token,
        }
      : {}),
  };

  if (kind === "opencode") {
    command = resolveOpenCodeBinary(context);
  } else if (kind === "claude") {
    command = resolveBunBinary(context);
    cwd = getBridgePath(context, "claude-bridge");
    env.CLAUDE_CLI_PATH = resolveClaudeBinary(context);
    if (context.runtimeFlavor === "agent-test" && context.credentialSources?.has("claude")) {
      const hostConfigDir = process.env[AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV]?.trim();
      if (hostConfigDir) env.CLAUDE_CONFIG_DIR = hostConfigDir;
      if (!env.ANTHROPIC_API_KEY && agentTestHostHome) {
        const credentials = await getHostClaudeCredentials(
          process.platform,
          agentTestHostHome,
          hostConfigDir,
        );
        const accessToken = getClaudeOAuthAccessToken(credentials);
        if (accessToken) env.ANTHROPIC_AUTH_TOKEN = accessToken;
      }
    }
  } else if (kind === "codex") {
    command = resolveBunBinary(context);
    cwd = getBridgePath(context, "codex-bridge");
    const config = await context.storage.loadConfig();
    // Point app-server supervision at our shipped Codex binary so it does not
    // depend on a system install / PATH lookup in the packaged app.
    env.CODEX_PATH = resolveCodexBinary(context);
    env[CODEX_MAX_CONCURRENT_THREADS_ENV] = String(
      resolveCodexMaxConcurrentThreads(config.global.codexMaxConcurrentThreads),
    );
    // Forwarded to app-server as clientInfo.version.
    env.ORKESTRATOR_VERSION = APP_VERSION;
  } else if (kind === "pi") {
    command = resolveBunBinary(context);
    cwd = getBridgePath(context, "pi-bridge");
    // Pi's own configuration directory holds `auth.json`, which is the user's
    // provider credentials. A local worktree runs as the user, so the default
    // `~/.pi/agent` is exactly the one they signed in with — leaving it unset
    // is what makes `pi` in a terminal tab and a Pi native tab share an
    // account. Containers are handed an explicit path instead.
    delete env.PI_AGENT_DIR;
    env.PI_SESSION_DIR = path.join(
      context.storage.getDataDir(),
      "pi-bridge-sessions",
      createHash("sha256").update(environmentId).digest("hex").slice(0, 32),
    );
    env.PI_BRIDGE_STATE_DIR = path.join(
      context.storage.getDataDir(),
      "pi-bridge-state",
      createHash("sha256").update(environmentId).digest("hex").slice(0, 32),
    );
    // A local worktree is the user's own checkout, and `.pi/` in it holds
    // extensions that are arbitrary TypeScript the bridge process would run.
    // Pinned explicitly after inheriting process.env so an ambient variable
    // cannot bypass the local trust boundary; the container launcher is the
    // only caller that opts in.
    env.PI_BRIDGE_PROJECT_RESOURCES = "0";
  } else if (kind === "cursor" && (await cursorSdkBridgeEnabled(context))) {
    useCursorSdkBridge = true;
    command = resolveBunBinary(context);
    // Every bridge is spawned from its own package directory, and this one is
    // no exception. `bun` bootstraps from its working directory — it reads
    // `bunfig.toml` (including `preload`) and `.env` before the entrypoint
    // runs — so starting it in the worktree would let a cloned repository
    // execute code in a host process holding the Cursor credential path, the
    // bridge token and the agent MCP token. That is the boundary
    // `CURSOR_BRIDGE_PROJECT_SETTINGS=0` below exists to hold.
    //
    // The SDK's Shell tool still defaults to `process.cwd()` when the model
    // omits `workingDirectory`, so the bridge enters `CWD` itself once bun has
    // bootstrapped: see `applyWorkingDirectory` in the bridge's `config.ts`.
    cwd = getBridgePath(context, "cursor-bridge");
    // The SDK bridge keeps its own session store, deliberately separate from
    // the ACP bridge's: the two engines produce different agent ids and a
    // shared directory would have each read the other's sessions as its own.
    env.CURSOR_BRIDGE_STATE_DIR = path.join(
      context.storage.getDataDir(),
      "cursor-bridge-state",
      createHash("sha256").update(environmentId).digest("hex").slice(0, 32),
    );
    env.CURSOR_BRIDGE_AUTH_FILE = cursorSdkCredentialPath(context);
    // A local worktree can contain repository-controlled Cursor settings and
    // MCP commands. Cloning a repository must not be enough to run its code,
    // so the project settings layer stays off on the host — the same boundary
    // `ACP_APPROVE_PROJECT_MCPS` draws for the ACP path. Pinned after
    // inheriting process.env so an ambient value cannot bypass it.
    env.CURSOR_BRIDGE_PROJECT_SETTINGS = "0";
    if (cursorApiKey) env.CURSOR_API_KEY = cursorApiKey;
    else delete env.CURSOR_API_KEY;
  } else {
    command = resolveBunBinary(context);
    cwd = getBridgePath(context, "acp-bridge");
    env.ACP_PROVIDER = kind;
    // Local worktrees can contain repository-controlled Cursor MCP commands.
    // Pin this explicitly after inheriting process.env so an ambient variable
    // cannot bypass the local trust boundary.
    env.ACP_APPROVE_PROJECT_MCPS = "0";
    env.ACP_STATE_DIR = path.join(
      context.storage.getDataDir(),
      "acp-bridge-state",
      createHash("sha256").update(environmentId).digest("hex").slice(0, 32),
      kind,
    );
    // Toolchains are downloaded once at app startup from the stored platform
    // selection, so a platform enabled mid-session has no managed binary yet.
    // Say that plainly instead of failing with a bare spawn ENOENT. Startup
    // aborts unless every selected platform activated, so this is reachable
    // only for a platform enabled after this backend generation started, which
    // is exactly what the message tells the user to fix.
    const managedAcpBinary = resolveManagedAcpBinary(context, kind);
    if (!managedAcpBinary) {
      throw new Error(
        `${AGENT_PLATFORM_LABELS[kind]} is enabled but not installed yet.` +
          " Restart Orkestrator to finish downloading it.",
      );
    }
    env.ACP_AGENT_PATH = managedAcpBinary;
    if (kind === "cursor") {
      if (cursorApiKey) env.CURSOR_API_KEY = cursorApiKey;
      else delete env.CURSOR_API_KEY;
      if (context.runtimeFlavor === "agent-test") {
        const cursorHome = path.join(
          context.storage.getDataDir(),
          "agent-credentials",
          "provider-homes",
          "cursor",
        );
        env.HOME = cursorHome;
        env[AGENT_TEST_CURSOR_CREDENTIAL_STORE_ENV] = "file";
        await syncAgentTestCursorCredentials(
          cursorHome,
          cursorApiKey ? undefined : hostCursorCredentials,
        );
      }
    }
  }

  const bridgeEntrypoint = path.join(cwd, "dist", "index.js");
  if (kind !== "opencode") {
    if (!existsSync(cwd)) throw new Error(`${kind} bridge directory not found: ${cwd}`);
    if (!existsSync(bridgeEntrypoint))
      throw new Error(`${kind} bridge entrypoint not found: ${bridgeEntrypoint}`);
  }

  // Shutdown may have started while this already-admitted operation awaited
  // storage, port allocation, or packaged-path discovery. Recheck at the last
  // synchronous boundary before credentials are allocated and the child is
  // registered, so a bounded shutdown drain cannot snapshot an empty map and
  // then have this operation spawn behind it.
  assertLocalServerStartAllowed(environmentId);
  const tokens = localBridgeTokens(kind);
  if (tokens) {
    const authToken = randomBytes(32).toString("base64url");
    env[
      kind === "codex"
        ? "CODEX_BRIDGE_TOKEN"
        : kind === "claude"
          ? "CLAUDE_BRIDGE_TOKEN"
          : kind === "opencode"
            ? "OPENCODE_SERVER_PASSWORD"
            : kind === "pi"
              ? "PI_BRIDGE_TOKEN"
              : useCursorSdkBridge
                ? "CURSOR_BRIDGE_TOKEN"
                : "ACP_BRIDGE_TOKEN"
    ] = authToken;
    if (kind === "opencode") env.OPENCODE_SERVER_USERNAME = "opencode";
    tokens.set(environmentId, authToken);
  }

  const args =
    kind === "opencode"
      ? ["serve", "--port", String(port), "--hostname", "127.0.0.1"]
      : [bridgeEntrypoint];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnLocalServerCommandImpl(command, args, {
      cwd,
      env,
      // A dedicated group lets shutdown reach ordinary descendants immediately.
      // Explicit descendant signalling also covers children that create new groups.
      detached: process.platform !== "win32",
    });
  } catch (error) {
    tokens?.delete(environmentId);
    if (kind === "cursor") {
      localCursorCredentialFingerprints.delete(environmentId);
    }
    throw error;
  }
  if (kind === "cursor" && cursorCredentialFingerprint) {
    localCursorCredentialFingerprints.set(environmentId, cursorCredentialFingerprint);
  }
  localServerProcesses.set(key, child);
  child.stdout.on("data", (data) => console.debug(`[${kind}:${environmentId}] ${data.toString()}`));
  child.stderr.on("data", (data) => console.error(`[${kind}:${environmentId}] ${data.toString()}`));
  child.once("exit", () => {
    // An unhealthy child may exit after its replacement has already claimed the
    // key. Only the process that still owns the entry may remove it.
    releaseLocalServerOwnership(key, child);
  });

  const { port: field, pid: pidField } = localServerFields(kind);
  try {
    const authToken = tokens?.get(environmentId);
    await waitForLocalServerStartup(
      child,
      port,
      kind,
      authToken
        ? kind === "opencode"
          ? openCodeHealthHeaders(authToken)
          : kind === "cursor" || kind === "grok" || kind === "pi"
            ? bearerBridgeHeaders(authToken)
            : undefined
        : undefined,
    );
    if (kind === "opencode" && authToken && agentToolConnection) {
      scheduleOpenCodeAgentToolsConfiguration(
        `local:${environmentId}`,
        port,
        authToken,
        agentToolConnection,
        environment.worktreePath,
      );
    }
    await context.storage.updateEnvironment(environmentId, {
      [field]: port,
      [pidField]: child.pid,
    });
  } catch (error) {
    let terminationError: unknown;
    try {
      await terminateLocalServerChild(key, child);
    } catch (caught) {
      terminationError = caught;
    }
    await context.storage
      .updateEnvironment(environmentId, { [field]: null, [pidField]: null })
      .catch(() => undefined);
    if (terminationError) {
      throw new AggregateError(
        [error, terminationError],
        `Failed to start and clean up local server: ${key}`,
      );
    }
    throw error;
  }
  const authToken = tokens?.get(environmentId);
  return {
    port,
    pid: child.pid ?? 0,
    wasRunning: false,
    ...(authToken ? { authToken } : {}),
  };
}

export function startLocalServer(
  environmentId: string,
  context: CommandContext,
  kind: LocalServerKind,
): Promise<{ port: number; pid: number; wasRunning: boolean; authToken?: string }> {
  assertLocalServerStartAllowed(environmentId);
  return enqueueLocalServerEnvironmentOperation(environmentId, async () => {
    // Shutdown may have begun while this start was queued behind an earlier
    // lifecycle operation.
    if (isLocalServerShutdownRequested()) {
      throw new Error("Backend is shutting down; local servers cannot be started");
    }
    return startLocalServerUnlocked(environmentId, context, kind);
  });
}

export function stopLocalServer(
  environmentId: string,
  context: CommandContext,
  kind: LocalServerKind,
): Promise<void> {
  return enqueueLocalServerEnvironmentOperation(environmentId, () =>
    stopLocalServerUnlocked(environmentId, context, kind),
  );
}

export async function deleteEnvironment(
  environmentId: string,
  context: CommandContext,
  options: { allowWhileMerging?: boolean } = {},
): Promise<void> {
  if (isLocalServerShutdownRequested()) {
    throw new Error("Backend is shutting down; environments cannot be deleted");
  }
  if (mergingEnvironments.has(environmentId) && !options.allowWhileMerging) {
    throw new Error(`Environment is currently being merged: ${environmentId}`);
  }
  try {
    await enqueueLocalServerEnvironmentOperation(environmentId, async () => {
      const { storage } = context;
      const environment = await storage.getEnvironment(environmentId);
      if (environment?.containerId) {
        await assertDockerContainerOwned(environment.containerId, context);
      }
      // Persist the deletion intent before any durable child-state cleanup.
      // Queue/pipeline saves consult this marker while holding their own locks:
      // a write that began earlier is swept by cleanup, and a later write is
      // rejected even if cleanup pauses or fails.
      await storage.updateEnvironment(environmentId, {
        deletionRequestedAt: new Date().toISOString(),
        cleanupAfterMergeError: null,
        lifecycleOperation: "deleting",
        lifecycleOperationStartedAt: new Date().toISOString(),
      });
      cleanupTerminalSessionsForEnvironment(environmentId);
      if (environment)
        await deleteMergedEnvironmentRemoteBranch(environment).catch(() => undefined);
      // Before the container is removed and before the worktree is deleted:
      // killing the tmux sessions needs the container alive, and restoring the
      // user's `.claude/settings.local.json` from the tmux-mode backup needs
      // the worktree still on disk. Best-effort — a tmux server that has
      // already gone must not strand the rest of the deletion.
      await cleanupEnvironmentTmux(environmentId, context).catch((error: unknown) => {
        console.warn("[backend] claude-tmux cleanup failed during environment deletion:", error);
      });
      if (environment?.containerId) {
        // Retire state polling before removing the container, or the next tick
        // execs into something that no longer exists.
        shutdownClaudeStatePolling(environment.containerId);
        cancelOpenCodeAgentToolsConfiguration(`container:${environment.containerId}`);
        await runCommand("docker", ["rm", "-f", environment.containerId], {
          timeoutMs: 60_000,
        }).catch(() => undefined);
      }
      await stopLocalServersForEnvironmentUnlocked(environmentId, context);
      if (environment?.worktreePath) {
        await removeLocalWorktree(environment.worktreePath).catch(() => undefined);
      }
      await storage.removeSessionsByEnvironment(environmentId).catch(() => undefined);
      await storage.deleteLoopedReviewWorkflowsByEnvironment(environmentId);
      await storage.deleteMultiReviewWorkflowsByEnvironment(environmentId);
      // A pipeline whose environment is gone can never advance again; leaving it
      // behind would resurrect a dead build on the next client that hydrates.
      await storage.deleteBuildPipelinesByEnvironment(environmentId, environment?.buildPipelineId);
      // Queued prompts for a deleted environment can never be dispatched.
      await storage.deletePromptQueuesByEnvironment(environmentId);
      // Best-effort, like its siblings: leaving a stale session mapping behind
      // is recoverable, but aborting here would strand the environment record
      // itself because `removeEnvironment` below would never run.
      //
      // Logged rather than swallowed. This call queues behind an in-flight
      // prompt dispatch, which legitimately holds the native-agent lock across
      // provider I/O, so a failure here is the one way a deleted environment
      // keeps its session record and its pending prompt on disk. The lock's
      // acquire timeout is sized to outlast that holder, so if this still fires
      // it is evidence of something else and must not be invisible.
      await storage
        .deleteNativeAgentSessionsByEnvironment(environmentId)
        .catch((error: unknown) => {
          console.warn(
            `[backend] native agent session cleanup failed for ${environmentId}:`,
            error instanceof Error ? error.message : error,
          );
        });
      await storage.deleteComposeDraftsByEnvironment(environmentId);
      await storage.deleteFileDraftsByEnvironment(environmentId);
      await storage.deleteAgentHandoffsByEnvironment(environmentId);
      context.agentTools?.revokeEnvironment(environmentId);
      await storage.removeEnvironment(environmentId);
      await storage.deletePaneLayout(environmentId).catch(() => undefined);
      // A terminal start that began before the tombstone may have been awaiting
      // storage or filesystem I/O during the first sweep. Close anything that
      // became visible before deletion completed.
      cleanupTerminalSessionsForEnvironment(environmentId);
      cleanupEnvironmentSetupState(environmentId);
      // Releases the watcher and discards the counts. This is the one case where
      // discarding is right: the worktree they described is gone.
      invalidatePendingDiffStatsSync();
      diffStatsService.untrack(environmentId);
      // The PR belonged to a branch whose environment is gone; polling it would
      // resurrect state for an id no client can display.
      invalidatePendingPrMonitorSync();
      prMonitorService.untrack(environmentId);
      if (environment?.worktreePath) gitFetchScheduler.forget(environment.worktreePath);
    });
  } catch (error) {
    const environment = await context.storage.getEnvironment(environmentId).catch(() => null);
    if (environment?.cleanupAfterMergeRequestedAt) {
      await context.storage
        .updateEnvironment(environmentId, {
          cleanupAfterMergeError: cleanupErrorMessage(error),
        })
        .catch(() => undefined);
    }
    throw error;
  }
}

export function deleteEnvironmentTask(
  environmentId: string,
  context: CommandContext,
  options: { allowWhileMerging?: boolean } = {},
): Promise<void> {
  // Every reason to refuse the delete is evaluated before the tombstone is
  // reserved. Reserving first would block local-server starts and merges for
  // the whole queue wait on behalf of a delete that was never going to run.
  if (isLocalServerShutdownRequested()) {
    return Promise.reject(new Error("Backend is shutting down; environments cannot be deleted"));
  }
  if (mergingEnvironments.has(environmentId) && !options.allowWhileMerging) {
    return Promise.reject(new Error(`Environment is currently being merged: ${environmentId}`));
  }
  if (deletingLocalServerEnvironments.has(environmentId)) {
    return Promise.reject(new Error(`Environment is already being deleted: ${environmentId}`));
  }
  // Reserve deletion before queueing. Local server starts consult this guard,
  // so work admitted after delete cannot recreate a process behind cleanup.
  deletingLocalServerEnvironments.add(environmentId);
  invalidateEnvironmentStartDedupe(environmentId);
  try {
    return enqueueEnvironmentLifecycleOperation(environmentId, context, () =>
      deleteEnvironment(environmentId, context, options),
    ).finally(() => {
      deletingLocalServerEnvironments.delete(environmentId);
    });
  } catch (error) {
    deletingLocalServerEnvironments.delete(environmentId);
    throw error;
  }
}

/**
 * Resumes only the unambiguous follow-up half of a persisted merge-and-cleanup
 * workflow. A backend restart must never resubmit an ambiguous GitHub merge;
 * exact-URL PR monitoring first establishes `prState: "merged"`, then this
 * continuation can safely retry deletion.
 */
// Registered at module scope: the PR monitor observes merges and hands them
// back here, without importing this module.
setMergeCleanupScheduler((environmentId, context) =>
  scheduleMergeCleanupRecovery(environmentId, context),
);

export function scheduleMergeCleanupRecovery(environmentId: string, context: CommandContext): void {
  if (mergeCleanupRecoveryTasks.has(environmentId)) return;

  const task = (async () => {
    const environment = await context.storage.getEnvironment(environmentId);
    if (
      !environment?.cleanupAfterMergeRequestedAt ||
      environment.cleanupAfterMergeError ||
      (environment.prState !== "merged" && !environment.deletionRequestedAt)
    ) {
      return;
    }
    await deleteEnvironmentTask(environmentId, context);
  })()
    .catch((error) => {
      console.warn(
        `[backend] Failed to resume merge cleanup for ${environmentId}:`,
        conciseError(error),
      );
    })
    .finally(() => {
      if (mergeCleanupRecoveryTasks.get(environmentId) === task) {
        mergeCleanupRecoveryTasks.delete(environmentId);
      }
    });

  mergeCleanupRecoveryTasks.set(environmentId, task);
}

export async function waitForLocalServerEnvironmentOperations(
  timeoutMs?: number,
): Promise<boolean> {
  const drain = async () => {
    while (localServerEnvironmentOperations.size > 0) {
      await Promise.allSettled(new Set(localServerEnvironmentOperations.values()));
    }
  };

  if (timeoutMs === undefined) {
    await drain();
    return true;
  }
  if (timeoutMs <= 0) {
    return localServerEnvironmentOperations.size === 0;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([drain().then(() => true as const), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Closes admission for everything that would start new owned processes, without
 * waiting for any of it to drain.
 *
 * Shutdown drains lifecycle work first, and that drain can run for minutes on
 * queued Docker operations. Leaving local-server and delete admission open for
 * that whole window would let work start that the subsequent drain then has to
 * clean up — or that a SIGKILL leaves orphaned.
 */
export function closeLocalServerAdmission(): void {
  requestLocalServerShutdown();
  cancelAllOpenCodeAgentToolsConfigurations();
}

/**
 * Drains every local agent server still owned by this backend process.
 *
 * `operationDrainTimeoutMs` bounds only the queue drain. Once it expires,
 * shutdown still snapshots and terminates every child already owned by this
 * process. Admission was closed before the wait, and queued starts re-check that
 * gate when they run, so skipping a stuck tail cannot admit a new child later.
 */
export async function shutdownLocalServers(
  options: { operationDrainTimeoutMs?: number } = {},
): Promise<void> {
  const existingShutdown = getLocalServerShutdownPromise();
  if (existingShutdown) return existingShutdown;
  requestLocalServerShutdown();

  const attempt = (async () => {
    await waitForLocalServerEnvironmentOperations(options.operationDrainTimeoutMs);
    const owned = [...localServerProcesses.entries()];
    const results = await Promise.allSettled(
      owned.map(([key, child]) => terminateLocalServerChild(key, child)),
    );
    aggregateRejectedResults(results, "Failed to shut down all local servers");
  })();
  setLocalServerShutdownPromise(attempt);

  try {
    await attempt;
  } catch (error) {
    // A retained process can be targeted by an explicit retry.
    if (getLocalServerShutdownPromise() === attempt) setLocalServerShutdownPromise(null);
    throw error;
  }
}

export async function readLocalServerStatus(
  environmentId: string,
  context: CommandContext,
  kind: LocalServerKind,
): Promise<{
  running: boolean;
  port: number | null;
  pid: number | null;
  authToken?: string;
  agentTools?: OpenCodeAgentToolsState;
}> {
  const key = `${kind}:${environmentId}`;
  const env = await context.storage.getEnvironment(environmentId);
  // The owned child can exit while storage is being read. Re-read ownership
  // after the await so an exit handler that released the process cannot leave
  // this snapshot claiming that a dead child is still running.
  const child = localServerProcesses.get(key);
  const port = localServerPort(env, kind);
  const { pid: pidField } = localServerFields(kind);
  const persistedPid = env?.[pidField];
  const pid = typeof persistedPid === "number" ? persistedPid : undefined;
  const authToken = localBridgeTokens(kind)?.get(environmentId);
  if (
    kind === "opencode" &&
    child &&
    !child.killed &&
    port &&
    authToken &&
    env?.worktreePath &&
    context.agentTools
  ) {
    scheduleOpenCodeAgentToolsConfiguration(
      `local:${environmentId}`,
      port,
      authToken,
      context.agentTools.connection(env.id, env.projectId, "host"),
      env.worktreePath,
    );
  }
  const running = !!child && !child.killed;
  return {
    running,
    port: port ?? null,
    pid: child?.pid ?? pid ?? null,
    ...(authToken ? { authToken } : {}),
    // Only meaningful for a live server: a stopped one has no MCP state to
    // report, and a crashed one's last verdict describes a process that is gone.
    ...(running && kind === "opencode" && context.agentTools
      ? { agentTools: openCodeAgentToolsState(`local:${environmentId}`) }
      : {}),
  };
}

export function getLocalServerStatus(
  environmentId: string,
  context: CommandContext,
  kind: LocalServerKind,
): Promise<{
  running: boolean;
  port: number | null;
  pid: number | null;
  authToken?: string;
  agentTools?: OpenCodeAgentToolsState;
}> {
  // Status is a readiness snapshot, not merely a process-exists snapshot.
  // Serialize it behind any in-flight start/stop so callers never observe the
  // child and credential before the healthy port has been persisted (or a
  // replacement child paired with the previous child's stale port).
  return enqueueLocalServerEnvironmentOperation(environmentId, () =>
    readLocalServerStatus(environmentId, context, kind),
  );
}

export async function allocateLocalPort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to allocate port")));
      }
    });
    server.once("error", reject);
  });
}
