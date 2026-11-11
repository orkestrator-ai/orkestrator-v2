import { applyAgentTestAnthropicOrigin } from "./agent-test-fixtures.js";
import { bridgeDebugEnvValue } from "@orkestrator/protocol/log-policy";
import { BRIDGE_LOG_RELAY_ENV } from "@orkestrator/protocol/node/logger-environment";
import {
  COORDINATOR_RESEARCH_MCP_ENV,
  COORDINATOR_WEB_RESEARCH_ENV,
  coordinatorResearchMcpServersFromEnv,
  coordinatorWebResearchEnv,
  coordinatorWebResearchSetting,
  normalizeCoordinatorResearchMcpServers,
} from "@orkestrator/protocol/coordinator-web-research";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  CLAUDE_BASH_MAX_TIMEOUT_ENV,
  claudeBashMaxTimeoutEnvValue,
} from "@orkestrator/protocol/claude-background-commands";
import {
  OPENCODE_STARTUP_STDERR_TAIL_BYTES,
  OPENCODE_STARTUP_STDIO_CLOSE_BOUND_MS,
  isOpenCodeDatabaseLockedError,
  openCodeDatabaseLockedError,
  openCodeStderrReportsLockedDatabase,
} from "./opencode-host-start.js";
import {
  CLAUDE_PINNED_RUNTIME_ENV,
  OPENCODE_PINNED_RUNTIME_ENV,
} from "@orkestrator/protocol/terminal-agent-launch";
import { existsSync } from "node:fs";
import { deleteEnvironmentTask } from "./environment-delete.js";
import { abortableSleep } from "./abortable-timing.js";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  APP_VERSION,
  CLAUDE_BRIDGE_PORT,
  CODEX_BRIDGE_PORT,
  CURSOR_BRIDGE_PORT,
  CODEX_MAX_CONCURRENT_THREADS_ENV,
  GROK_ACP_BRIDGE_PORT,
  PI_BRIDGE_PORT,
  OPENCODE_SERVER_PORT,
  resolveCodexMaxConcurrentThreads,
} from "./constants.js";
import { ORKESTRATOR_AGENT_MCP_TOKEN_ENV, ORKESTRATOR_AGENT_MCP_URL_ENV } from "./agent-tools.js";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import {
  coordinatorBridgeEnvironmentFields,
  localServerFields,
  stopLocalServerUnlocked,
} from "./commands-local-server-lifecycle.js";
import {
  checkHttpHealth,
  confirmRunningServerHealth,
  waitForLocalServerHealth,
  openCodeHealthHeaders,
  bearerBridgeHeaders,
} from "./commands-server-health.js";
import type { OpenCodeAgentToolsState } from "./opencode-agent-tools.js";
import type { AgentAccountsRuntime } from "./agent-accounts-runtime.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Environment } from "./models.js";
import type { AgentToolConnection } from "./agent-tools.js";
import type { AgentModel, AgentReasoningOption } from "@orkestrator/protocol/native-agent";
import { retryableBridgeStartupError, LOCAL_SERVER_KINDS } from "./local-server-runtime.js";
import {
  resolveCodexBinary,
  resolveOpenCodeBinary,
  resolveClaudeBinary,
  resolveManagedAcpBinary,
  resolveBunBinary,
} from "./commands-agent-support.js";
import { environmentStateDirectory } from "./environment-state-paths.js";
import { ensureBridgeRuntime, onDemandBridgeRuntime } from "./bridge-runtime-install.js";
import { getHostPort } from "./commands-container-exec.js";
import {
  bridgeTokenVerifier,
  bridgeTokenVerifierEnv,
  mintBridgeToken,
} from "@orkestrator/protocol/node/bridge-credential";
import {
  bridgeAuthorityKeyEnv,
  mintBridgeAuthorityKeyPair,
} from "@orkestrator/protocol/node/bridge-authority";
import { readContainerBridgeToken } from "./container-bridge-credential.js";
import { rememberBridgeAuthorityKey } from "./bridge-authority-keys.js";
import {
  applyClaudeHostCredentialEnvironment,
  applyPiHostCredentialEnvironment,
  resolveCursorHostCredentialMaterial,
} from "./host-agent-credentials.js";
import { cursorSdkCredentialPath } from "./cursor-sdk-bridge.js";
import { createBridgeOutputForwarder, relayBridgeOutput } from "./bridge-output-redaction.js";
import { dropInheritedVendorDebug } from "./bridge-vendor-debug-env.js";
import type { LocalServerKind } from "./local-server-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { bugReportIdFromRuntimeId } from "@orkestrator/protocol/bug-report";
import {
  bugReportRuntimeEnvironment,
  bugReportRuntimeUnavailableMessage,
  resolveBugReportRuntime,
} from "./bug-report-runtime.js";
import {
  COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV,
  COORDINATOR_CODEX_USER_SKILLS_DIR_ENV,
  COORDINATOR_COMMAND_SANDBOX_ENV,
  COORDINATOR_PROTECTED_DATA_DIR_ENV,
  COORDINATOR_EXECUTION_POLICY,
  coordinatorIdFromRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { defaultCoordinatorHostCapabilities } from "./coordinator-providers.js";

const environmentLog = createLogger("environment");
const nativeAgentOpencodeLog = createLogger("native-agent.opencode");

/** Provider-neutral process authority every coordinator bridge honours. */
export const ORKESTRATOR_BRIDGE_EXECUTION_POLICY_ENV = "ORKESTRATOR_BRIDGE_EXECUTION_POLICY";
/**
 * The one directory outside the workspace a bridge may read attachments from.
 *
 * Every bridge confines an attachment path to its session's workspace, because
 * the path arrives over HTTP. A coordinator's attachments cannot live there:
 * the workspace is the user's own checkout and a read-only coordinator must not
 * write to it, so they are staged under application data instead. Naming that
 * directory in the process environment keeps the boundary process
 * configuration — a request body still cannot widen it.
 */
export const ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT_ENV = "ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT";
import { realpath } from "node:fs/promises";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { installHostOpenCodePlugins } from "./opencode-host-credential.js";
import { hostOpenCodeDatabaseEnvironment } from "./opencode-host-database.js";
import { sanitizeCoordinatorError } from "./coordinator-service.js";
import {
  coordinatorRuntimeUnavailableMessage,
  resolveCoordinatorRuntime,
} from "./coordinator-runtime.js";
import { coordinatorRoleCapabilities } from "./control-mcp-tools.js";
import {
  activeAgentAccountShellEnvironment,
  applyActiveAgentAccountEnvironment,
  applyCoordinatorClaudeAccount,
  readCoordinatorCodexLogin,
  coordinatorHostCodexHome,
  localBridgeIsOnActiveAccount,
  resolveActiveAgentAccount,
  stripInheritedAgentCredentials,
  type CoordinatorAgentAccount,
} from "./agent-accounts-active.js";

/**
 * How long an unresponsive bridge with a turn or background work in progress is
 * left alone before it is replaced anyway. Replacing it kills that work, so a
 * stall this long is treated as a hang rather than load.
 */
export const LOCAL_SERVER_BUSY_UNRESPONSIVE_GRACE_MS = 2 * 60_000;
/** A gap this long starts a new run of failed health checks. */
export const LOCAL_SERVER_UNRESPONSIVE_FAILURE_GAP_MS = 30_000;

const log = createLogger("local-server");

/**
 * A coordinator's private Claude configuration directory, empty of anything
 * the user authored.
 *
 * Claude's own config directory holds `settings.json` (which can declare
 * hooks), `plugins/` and MCP server definitions; copying any of them would let
 * a user's own configuration run code inside a session whose whole purpose is
 * not to change the checkout. No login is copied either: the active account's
 * access token is handed over instead (`applyCoordinatorClaudeAccount`).
 */
export async function prepareCoordinatorClaudeHome(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700);
}

/**
 * A coordinator's private Codex home, holding only an access-only copy of the
 * active login (`coordinatorCodexLogin`): never the refresh token, which Codex
 * rotates and would retire from the account's own login on a coordinator's
 * refresh. Returns the handed-over token's expiry, or `loginless` when there
 * was no usable login to hand over.
 */
export async function prepareCoordinatorCodexHome(
  destination: string,
  source = coordinatorHostCodexHome(),
  accounts?: Pick<AgentAccountsRuntime, "refreshLocalCodexLogin">,
): Promise<Omit<CoordinatorAgentAccount, "accountId">> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700);
  const destinationAuth = path.join(destination, "auth.json");
  // The directory outlives a launch: drop an earlier login before anything
  // below can fail, so no stale or earlier account's login stays behind.
  await rm(destinationAuth, { force: true });
  const sourceAuth = path.join(source, "auth.json");
  const sourceStat = await lstat(sourceAuth).catch(() => null);
  if (!sourceStat) return { loginless: true };
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("Codex authentication file must be a regular file, not a symbolic link");
  }
  const login = await readCoordinatorCodexLogin({ accountId: "default", home: source }, accounts);
  if (!login.text) return { loginless: true };
  const temporary = `${destinationAuth}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, login.text, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, destinationAuth);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return login.tokenExpiresAt ? { tokenExpiresAt: login.tokenExpiresAt } : {};
}

async function coordinatorCodexRuntime(executable: string): Promise<{
  executable: string;
  root: string;
}> {
  const candidates =
    path.isAbsolute(executable) || executable.includes(path.sep)
      ? [path.resolve(executable)]
      : (process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((directory) => path.join(directory, executable));
  for (const candidate of candidates) {
    const canonical = await realpath(candidate).catch(() => null);
    if (canonical) return { executable: canonical, root: path.dirname(canonical) };
  }
  throw retryableBridgeStartupError("Codex executable is unavailable");
}

/**
 * Record (or clear) a bug report's bridge. A clear from an exiting process
 * applies only while the record still names that process, so a replacement's
 * identity is never erased by its predecessor's exit.
 */
async function recordBugReportBridge(
  context: CommandContext,
  reportId: string,
  child: ChildProcessWithoutNullStreams,
  bridge: { port: number; pid: number } | null,
): Promise<void> {
  await context.storage.bugReports
    .mutateBugReport(reportId, (current) => {
      if (bridge) return { ...current, bridgePort: bridge.port, bridgePid: bridge.pid };
      if (current.bridgePid !== undefined && current.bridgePid !== child.pid) return current;
      const { bridgePort: _port, bridgePid: _pid, ...rest } = current;
      return rest;
    })
    .catch(() => undefined);
}

export async function localRuntimeEnvironment(
  environmentId: string,
  context: CommandContext,
): Promise<Environment | null> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (environment) return environment;
  const bugReport = await resolveBugReportRuntime(context.storage, environmentId);
  if (bugReport.status === "ready") {
    const scratchDir = await realpath(bugReport.record.scratchDir).catch(() => null);
    if (!scratchDir) return null;
    return bugReportRuntimeEnvironment(environmentId, { ...bugReport.record, scratchDir });
  }
  if (bugReport.status === "unavailable") return null;
  const coordinator = await resolveCoordinatorRuntime(context.storage, environmentId);
  if (coordinator.status !== "ready") return null;
  const projectPath = await realpath(coordinator.project.localPath!).catch(() => null);
  if (!projectPath) return null;
  return {
    id: environmentId,
    projectId: coordinator.workspace.projectId,
    name: "Coordinator",
    branch: coordinator.workspace.repositoryStatus?.branch ?? "",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: coordinator.workspace.createdAt,
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: projectPath,
    // A coordinator conversation stores one bridge identity, not one per
    // platform. Project it into whichever Environment field pair its own agent
    // uses, so every lifecycle helper that reads those fields keeps working
    // without learning what a coordinator is.
    ...coordinatorBridgeEnvironmentFields(coordinator.conversation),
    setupPhase: "ready",
    setupScriptsComplete: true,
  } as Environment;
}

export async function waitForLocalServerStartup(
  child: ChildProcessWithoutNullStreams,
  port: number,
  kind: LocalServerKind,
  headers?: Record<string, string>,
  options: {
    health?: Parameters<typeof waitForLocalServerHealth>[3];
    stdioCloseBoundMs?: number;
  } = {},
): Promise<void> {
  let settled = false;
  // Only OpenCode's is read: its servers share one database on the host, and
  // the one failure worth retrying names itself only on stderr.
  let stderrTail = "";
  const onStderr = (data: Buffer | string) => {
    stderrTail = (stderrTail + data.toString()).slice(-OPENCODE_STARTUP_STDERR_TAIL_BYTES);
  };
  let exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let closeBound: ReturnType<typeof setTimeout> | undefined;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
      if (closeBound) clearTimeout(closeBound);
      if (kind === "opencode") child.stderr.off("data", onStderr);
    };
    const complete = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => complete(error);
    const exitedError = (code: number | null, signal: NodeJS.Signals | null) => {
      const message = `${kind} server exited before becoming healthy (code ${code ?? "null"}, signal ${signal ?? "null"})`;
      return kind === "opencode" && openCodeStderrReportsLockedDatabase(stderrTail)
        ? openCodeDatabaseLockedError(
            `${message}: another OpenCode process held its database (database is locked)`,
          )
        : new Error(message);
    };
    // OpenCode's failure is decided once its stdio has closed, so stderr that
    // is still in flight at `exit` is read first; the bound stops a pipe held
    // open by a grandchild from delaying the failure past it.
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      const status = exitStatus ?? { code, signal };
      complete(exitedError(status.code, status.signal));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (kind !== "opencode") {
        complete(exitedError(code, signal));
        return;
      }
      exitStatus = { code, signal };
      closeBound = setTimeout(
        () => complete(exitedError(code, signal)),
        options.stdioCloseBoundMs ?? OPENCODE_STARTUP_STDIO_CLOSE_BOUND_MS,
      );
    };

    child.once("error", onError);
    child.once("exit", onExit);
    if (kind === "opencode") {
      child.once("close", onClose);
      child.stderr.on("data", onStderr);
    }
    waitForLocalServerHealth(port, kind, headers, options.health).then(
      () => {
        // A server that has already exited is not healthy, whatever answers.
        if (!exitStatus) complete();
      },
      (error: unknown) => {
        if (!exitStatus) complete(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export type BridgeName =
  "claude-bridge" | "codex-bridge" | "acp-bridge" | "pi-bridge" | "cursor-bridge";

function onDemandRuntime(context: CommandContext, bridgeName: BridgeName) {
  return onDemandBridgeRuntime(
    context.resourceRoot,
    () => context.storage.getDataDir(),
    bridgeName,
  );
}

/**
 * The directory a bridge starts from. The standalone package installs some
 * bridges' SDKs on first use, so this may name a directory that does not exist
 * yet; anything about to start a bridge uses `prepareBridgePath` instead.
 */
export function getBridgePath(context: CommandContext, bridgeName: BridgeName): string {
  const devPath = path.join(context.appRoot, "bridges", bridgeName);
  if (process.env.NODE_ENV !== "production" && existsSync(devPath)) return devPath;
  return (
    onDemandRuntime(context, bridgeName)?.installDir ?? path.join(context.resourceRoot, bridgeName)
  );
}

/**
 * `getBridgePath`, after installing the bridge's runtime if the standalone
 * package ships it on demand (`bridge-runtime-install.ts`). The first start
 * waits for the install; every later one finds it in place.
 */
export async function prepareBridgePath(
  context: CommandContext,
  bridgeName: BridgeName,
): Promise<string> {
  const devPath = path.join(context.appRoot, "bridges", bridgeName);
  if (process.env.NODE_ENV !== "production" && existsSync(devPath)) return devPath;
  const runtime = onDemandRuntime(context, bridgeName);
  if (!runtime) return path.join(context.resourceRoot, bridgeName);
  return ensureBridgeRuntime(runtime, { bun: resolveBunBinary(context) });
}

export { enqueueContainerBridgeOperation } from "./container-bridge-operations.js";

export function assertLocalServerStartAllowed(
  context: CommandContext,
  environmentId: string,
): void {
  if (context.runtime.localServers.isShuttingDown()) {
    throw new Error("Backend is shutting down; local servers cannot be started");
  }
  context.runtime.environments.assertNotDeleting(environmentId);
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

/** Where each container bridge publishes its port. */
export const CONTAINER_BRIDGE_PORTS: Record<LocalServerKind, number> = {
  claude: CLAUDE_BRIDGE_PORT,
  codex: CODEX_BRIDGE_PORT,
  cursor: CURSOR_BRIDGE_PORT,
  grok: GROK_ACP_BRIDGE_PORT,
  pi: PI_BRIDGE_PORT,
  opencode: OPENCODE_SERVER_PORT,
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
  const state = await peekLocalAgentBridgeState(environmentId, context, kind);
  return state.status === "running" ? { port: state.port, authToken: state.authToken } : null;
}

/**
 * {@link peekLocalAgentBridge}, keeping "not running" apart from "running but
 * not answering". The activity sweep records an absent bridge's sessions as
 * idle; a bridge stalled by host load still has its turns in flight, so it must
 * read as a failed observation rather than as no bridge.
 */
export async function peekLocalAgentBridgeState(
  environmentId: string,
  context: CommandContext,
  kind: LocalServerKind,
): Promise<
  | { status: "running"; port: number; authToken: string }
  | { status: "absent" }
  | { status: "unresponsive" }
> {
  const localServers = context.runtime.localServers;
  const child = localServers.process(`${kind}:${environmentId}`);
  if (!child || child.killed || !child.pid) return { status: "absent" };
  const authToken = localServers.bridgeToken(kind, environmentId);
  if (!authToken) return { status: "absent" };
  const environment = await localRuntimeEnvironment(environmentId, context);
  const port = localServerPort(environment, kind);
  if (!port) return { status: "absent" };
  const healthy = await checkHttpHealth(
    port,
    "/global/health",
    kind === "opencode"
      ? openCodeHealthHeaders(authToken)
      : kind === "cursor" || kind === "grok" || kind === "pi"
        ? bearerBridgeHeaders(authToken)
        : undefined,
  );
  if (healthy) {
    const key = `${kind}:${environmentId}`;
    localServers.clearUnresponsive(key, child);
    log.recovered("bridge.not-answering", key);
    return { status: "running", port, authToken };
  }
  return child.exitCode === null && child.signalCode === null
    ? { status: "unresponsive" }
    : { status: "absent" };
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
  const hostPort = await getHostPort(containerId, CONTAINER_BRIDGE_PORTS[kind]);
  if (!hostPort) return null;
  const authToken = await readContainerBridgeToken(containerId, kind);
  if (!authToken) return null;
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
  return (await fetchAcpNormalizedModelsResult(environment, context, kind, timeoutMs)).models;
}

export type AcpNormalizedModelsResult = {
  status: "ok" | "unavailable" | "failed";
  models: AgentModel[];
};

/** Preserve failure information for first-use callers that can retry. */
export async function fetchAcpNormalizedModelsResult(
  environment: Environment,
  context: CommandContext,
  kind: "cursor" | "grok" | "pi",
  timeoutMs?: number,
): Promise<AcpNormalizedModelsResult> {
  const bridge =
    environment.environmentType === "local"
      ? await peekLocalAgentBridge(environment.id, context, kind)
      : environment.containerId
        ? await peekContainerAgentBridge(environment.containerId, kind)
        : null;
  if (!bridge) return { status: "unavailable", models: [] };
  const port = "port" in bridge ? bridge.port : bridge.hostPort;
  return fetchAcpNormalizedModelsAtResult(port, bridge.authToken, kind, timeoutMs);
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

/** Host discovery starts cold and must cover each bridge's bounded 30s provider operation. */
export const HOST_ACP_MODEL_FETCH_TIMEOUT_MS = 35_000;

/** Read the normalized model rows from a known bridge endpoint. */
export async function fetchAcpNormalizedModelsAt(
  port: number,
  authToken: string,
  kind: "cursor" | "grok" | "pi",
  timeoutMs?: number,
  maximumTimeoutMs = acpModelFetchTimeoutMs(kind),
): Promise<AgentModel[]> {
  return (
    await fetchAcpNormalizedModelsAtResult(port, authToken, kind, timeoutMs, maximumTimeoutMs)
  ).models;
}

/** Read models while distinguishing a valid empty catalogue from transport failure. */
export async function fetchAcpNormalizedModelsAtResult(
  port: number,
  authToken: string,
  kind: "cursor" | "grok" | "pi",
  timeoutMs?: number,
  maximumTimeoutMs = acpModelFetchTimeoutMs(kind),
): Promise<AcpNormalizedModelsResult> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/global/models`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        "X-Orkestrator-Acp-Token": authToken,
      },
      // The default is the interactive cap. Explicit discovery callers may
      // supply a larger maximum that matches their provider-operation budget.
      signal: AbortSignal.timeout(
        Math.min(maximumTimeoutMs, Math.max(1_000, timeoutMs ?? Number.MAX_SAFE_INTEGER)),
      ),
    });
    if (!response.ok) return { status: "failed", models: [] };
    const body = (await response.json()) as { models?: unknown };
    if (!Array.isArray(body.models)) return { status: "failed", models: [] };
    const models = body.models.flatMap((candidate): AgentModel[] => {
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
          // Where a tab with no model starts (Pi's saved default), which the
          // launch defaults prefer over the first entry.
          ...(model.sessionDefault === true ? { sessionDefault: true } : {}),
        },
      ];
    });
    return { status: "ok", models };
  } catch {
    return { status: "failed", models: [] };
  }
}

/**
 * The connection a live local OpenCode server's Orkestrator MCP entry is kept
 * on: the one it was launched with. Only an ordinary environment launched
 * before that was recorded falls back to its Agent Tools connection. A
 * coordinator runtime never does: its entry is the scoped Control MCP
 * credential, and swapping in a tab credential would leave it with mail and
 * ticket tools but none of its delegation tools.
 */
function openCodeReconcileConnection(
  environmentId: string,
  env: Pick<Environment, "id" | "projectId">,
  context: CommandContext,
): AgentToolConnection | undefined {
  const launched = context.runtime.localServers.openCodeAgentTools.launchConnection(
    `local:${environmentId}`,
  );
  if (launched) return launched;
  if (coordinatorIdFromRuntimeId(environmentId) || bugReportIdFromRuntimeId(environmentId)) {
    return undefined;
  }
  return context.agentTools?.connection(env.id, env.projectId, "host");
}

// Child-scoped launch authority; weak keys release exited process records.
const coordinatorResearchLaunches = new WeakMap<ChildProcessWithoutNullStreams, string>();

export async function startLocalServerUnlocked(
  environmentId: string,
  context: CommandContext,
  kind: LocalServerKind,
): Promise<{ port: number; pid: number; wasRunning: boolean; authToken?: string }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const started = await startLocalServerAttempt(environmentId, context, kind);
      if (kind !== "opencode" && started.authToken) {
        context.runtime.logPolicy?.bridgeStarted({
          agent: kind,
          baseUrl: `http://127.0.0.1:${started.port}`,
          authToken: started.authToken,
        });
      }
      return started;
    } catch (error) {
      // A failed attempt has already stopped its server and cleared its
      // fields, so the next one starts clean.
      const delayMs = isOpenCodeDatabaseLockedError(error)
        ? context.runtime.localServers.openCodeHostStart.lockedStartRetryDelayMs(attempt)
        : undefined;
      const localServers = context.runtime.localServers;
      if (delayMs === undefined || localServers.isShuttingDown()) throw error;
      log.warn("opencode.database-lost-retrying", { environmentId, delayMs });
      // Shutdown ends the wait early; the next attempt then refuses to start.
      await abortableSleep(delayMs, localServers.shutdownSignal);
    }
  }
}

async function startLocalServerAttempt(
  environmentId: string,
  context: CommandContext,
  kind: LocalServerKind,
): Promise<{ port: number; pid: number; wasRunning: boolean; authToken?: string }> {
  context.runtime.environments.fence.assertNotMoving(environmentId);
  const key = `${kind}:${environmentId}`;
  const coordinatorId = coordinatorIdFromRuntimeId(environmentId);
  const researchConfig = coordinatorId ? (await context.storage.loadConfig()).global : undefined;
  const researchEnv = researchConfig
    ? coordinatorWebResearchEnv(
        coordinatorWebResearchSetting(researchConfig.coordinatorWebResearch),
        normalizeCoordinatorResearchMcpServers(researchConfig.coordinatorResearchMcpServers),
      )
    : undefined;
  const researchSignature = JSON.stringify(researchEnv);
  const cursorCredentials =
    kind === "cursor" ? await resolveCursorHostCredentialMaterial(context) : undefined;
  const cursorApiKey = cursorCredentials?.apiKey;
  const cursorCredentialFingerprint = cursorCredentials?.fingerprint;
  const localServers = context.runtime.localServers;
  const existing = localServers.process(key);
  if (existing && !existing.killed && existing.pid) {
    const env = await localRuntimeEnvironment(environmentId, context);
    const port = localServerPort(env, kind);
    const authToken = localServers.bridgeToken(kind, environmentId);
    const healthHeaders = authToken
      ? kind === "opencode"
        ? openCodeHealthHeaders(authToken)
        : kind === "cursor" || kind === "grok" || kind === "pi"
          ? bearerBridgeHeaders(authToken)
          : undefined
      : undefined;
    // A changed Cursor key restarts the bridge, which would end a running turn
    // and its background work. A busy bridge keeps the key it started with,
    // as a busy Claude or Codex bridge keeps its account; the first start
    // after it goes idle applies the new one (the container path does the
    // same in `start_cursor_server`).
    const credentialMatches =
      kind !== "cursor" ||
      localServers.cursorCredentialFingerprint(environmentId) === cursorCredentialFingerprint ||
      (await context.nativeAgents?.hasObservedLiveWork(environmentId, kind)) === true;
    const workingDirectoryMatches =
      Boolean(env?.worktreePath) && localServers.workingDirectory(key) === env?.worktreePath;
    const accountMatches = await localBridgeIsOnActiveAccount(key, kind, environmentId, context);
    let replaceReason: string;
    if (coordinatorId && coordinatorResearchLaunches.get(existing) !== researchSignature) {
      // Launch authority cannot change on a running agent. Keep its work alive
      // and refuse a new turn until an idle replacement can apply the setting.
      if (await context.nativeAgents?.hasObservedLiveWork(environmentId, kind)) {
        throw retryableBridgeStartupError(
          "Coordinator research settings will apply when its current work finishes.",
          2_000,
        );
      }
      replaceReason = "coordinator research settings changed";
    } else if (!credentialMatches) {
      replaceReason = "Cursor credentials changed";
    } else if (!accountMatches) {
      replaceReason =
        kind === "opencode" ? "a provider login changed" : "the active agent account changed";
    } else if (!workingDirectoryMatches) {
      replaceReason = "worktree path changed";
    } else if (!port) {
      replaceReason = "bridge port is unknown";
    } else if (!authToken) {
      replaceReason = "this backend does not hold the bridge's auth token";
    } else {
      const isAlive = () =>
        localServers.process(key) === existing &&
        existing.exitCode === null &&
        existing.signalCode === null;
      // A reused answer is not renewed: only a real probe restarts the window.
      const reused = isAlive() && localServers.recentlyHealthy(key, existing, port, authToken);
      const health = reused
        ? { healthy: true, failedProbes: 0 }
        : await confirmRunningServerHealth(port, healthHeaders, isAlive);
      if (health.healthy) {
        if (!reused) {
          localServers.recordHealthy(key, { child: existing, port, authToken, at: Date.now() });
        }
        localServers.clearUnresponsive(key);
        log.recovered("bridge.not-answering", key);
        const reconcileConnection =
          kind === "opencode" && env?.worktreePath
            ? openCodeReconcileConnection(environmentId, env, context)
            : undefined;
        if (reconcileConnection && env?.worktreePath) {
          void localServers.openCodeAgentTools.schedule(
            `local:${environmentId}`,
            port,
            authToken,
            reconcileConnection,
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
      if (!isAlive()) {
        replaceReason = "bridge process exited";
      } else {
        replaceReason = `health check failed ${health.failedProbes} consecutive times`;
        const marker = localServers.unresponsiveMarker(key);
        const now = Date.now();
        const since =
          marker?.child === existing &&
          now - marker.lastFailureAt <= LOCAL_SERVER_UNRESPONSIVE_FAILURE_GAP_MS
            ? marker.since
            : now;
        localServers.markUnresponsive(key, { child: existing, since, lastFailureAt: now });
        const unresponsiveForMs = now - since;
        if (
          unresponsiveForMs < LOCAL_SERVER_BUSY_UNRESPONSIVE_GRACE_MS &&
          (await context.nativeAgents?.hasObservedLiveWork(environmentId, kind))
        ) {
          // Replacing the bridge would kill a running turn or its background
          // work (a test suite, a dev server). A loaded host stalls a healthy
          // bridge far more often than a bridge wedges, so wait it out.
          log.throttled("warn", "bridge.not-answering", {
            scope: key,
            kind: "work-in-progress",
            fields: () => ({
              pid: existing.pid,
              unresponsiveSeconds: Math.round(unresponsiveForMs / 1000),
            }),
          });
          throw retryableBridgeStartupError(
            "The agent bridge is busy and not responding yet. Retrying shortly.",
            2_000,
          );
        }
        if (unresponsiveForMs > 0) {
          replaceReason += `; unresponsive for ${Math.round(unresponsiveForMs / 1000)}s`;
        }
      }
    }
    await localServers.terminate(key, existing, `replacing bridge: ${replaceReason}`);
  }

  // Resolved before the worktree check so an unassigned or unqualified
  // conversation reports what is actually wrong. `localRuntimeEnvironment`
  // synthesizes its Environment from a *ready* runtime, so those cases would
  // otherwise surface as a retryable missing worktree and be retried forever.
  const coordinator = coordinatorId
    ? await resolveCoordinatorRuntime(context.storage, environmentId)
    : null;
  if (coordinator?.status === "unavailable") {
    throw new Error(coordinatorRuntimeUnavailableMessage(coordinator));
  }
  // The conversation's own provider is the authority. A request to start some
  // other bridge against a coordinator runtime id would hand that platform the
  // conversation's scoped credential and its private runtime directory.
  if (coordinator?.status === "ready" && coordinator.conversation.agent !== kind) {
    throw new Error("This coordinator conversation belongs to a different agent platform");
  }
  // A bug report holds one bridge identity for its own agent, like a
  // coordinator conversation.
  const bugReportId = bugReportIdFromRuntimeId(environmentId);
  if (bugReportId) {
    const bugReport = await resolveBugReportRuntime(context.storage, environmentId);
    if (bugReport.status === "unavailable") {
      throw new Error(bugReportRuntimeUnavailableMessage(bugReport));
    }
    if (bugReport.status === "ready" && bugReport.record.agent !== kind) {
      throw new Error("This bug report belongs to a different agent platform");
    }
  }
  const environment = await localRuntimeEnvironment(environmentId, context);
  if (!environment?.worktreePath) {
    throw retryableBridgeStartupError("Local environment worktree is not available");
  }
  const selectedConversation = coordinator?.status === "ready" ? coordinator.conversation : null;
  const coordinatorConversationId =
    coordinator?.status === "ready" ? coordinator.conversationId : null;
  let agentToolConnection: AgentToolConnection | undefined;
  // A bug report gets no project tools: it belongs to no project, and its
  // agent has no business with tickets or mail.
  if (!coordinatorId && !bugReportId) {
    agentToolConnection = context.agentTools?.connection(
      environment.id,
      environment.projectId,
      "host",
    );
  }

  const bridgeConfig = await context.storage.loadConfig();
  const port = await allocateLocalPort();
  let command = "";
  let cwd = environment.worktreePath;
  let launchedAccountId: string | undefined;
  let launchedTokenExpiresAt: number | undefined;
  let launchedLoginless = false;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    CWD: environment.worktreePath,
    // Bridges are spawned detached, so they outlive a backend that dies
    // without running its shutdown path. Advertising our PID lets each bridge
    // watch for that and drain itself instead of orphaning its children.
    ORKESTRATOR_PARENT_PID: String(process.pid),
    ORKESTRATOR_BRIDGE_DEBUG: bridgeDebugEnvValue(bridgeConfig.global),
    // forwardBridgeOutput below reads this process's stdio and carries each level.
    [BRIDGE_LOG_RELAY_ENV]: "1",
    ...(agentToolConnection
      ? {
          [ORKESTRATOR_AGENT_MCP_URL_ENV]: agentToolConnection.url,
          [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: agentToolConnection.token,
        }
      : {}),
  };
  // Only our bridges consume this launch flag. OpenCode can pass its environment
  // to agent commands, so it must not inherit a relay request from the backend.
  if (kind === "opencode") delete env[BRIDGE_LOG_RELAY_ENV];
  else env[BRIDGE_LOG_RELAY_ENV] = "1";
  // A widened attachment boundary is inherited, not requested: a backend
  // started with this variable in its own environment would otherwise hand it
  // to every worker bridge. Only the branch below may name a root.
  delete env[ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT_ENV];
  delete env.CODEX_BRIDGE_STATE_DIR;
  // Vendor debug printing bypasses every log level, and can quote prompts.
  dropInheritedVendorDebug(env);
  // The same for coordinator research: read-only review turns in a worker
  // bridge consult these too, so only the coordinator branch may set them.
  delete env[COORDINATOR_WEB_RESEARCH_ENV];
  delete env[COORDINATOR_RESEARCH_MCP_ENV];
  delete env[COORDINATOR_COMMAND_SANDBOX_ENV];
  delete env[COORDINATOR_PROTECTED_DATA_DIR_ENV];
  delete env[COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV];
  delete env[COORDINATOR_CODEX_USER_SKILLS_DIR_ENV];
  if (bugReportId) {
    // No project tools, and none inherited from this backend's own environment.
    delete env[ORKESTRATOR_AGENT_MCP_URL_ENV];
    delete env[ORKESTRATOR_AGENT_MCP_TOKEN_ENV];
  }
  if (coordinatorId) {
    // Coordinator authority is always freshly issued for this exact
    // conversation. Never inherit a token from the backend's own environment
    // when Control MCP is disabled or unavailable.
    delete env[ORKESTRATOR_AGENT_MCP_URL_ENV];
    delete env[ORKESTRATOR_AGENT_MCP_TOKEN_ENV];
    // Provider-neutral process authority. A bridge launched with this refuses
    // to run any session under a weaker policy, whatever a request body or a
    // persisted record says, so a permissive record cannot survive a restart.
    env[ORKESTRATOR_BRIDGE_EXECUTION_POLICY_ENV] = COORDINATOR_EXECUTION_POLICY;
    // Created here rather than on first paste: a bridge canonicalizes this root
    // before it reads through it, and a directory that does not exist yet is
    // indistinguishable from one that is not allowed.
    const attachmentRoot = context.storage.coordinators.coordinatorAttachmentDirectory(
      coordinatorId,
      coordinatorConversationId!,
    );
    await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
    env[ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT_ENV] = attachmentRoot;
    // Process authority like the execution policy: read once at launch, so a
    // changed setting replaces an idle bridge before the next turn.
    Object.assign(env, researchEnv);
    // The same probe the qualification table used, so a bridge requires the
    // OS sandbox exactly where the platform was offered on the strength of it.
    env[COORDINATOR_COMMAND_SANDBOX_ENV] = defaultCoordinatorHostCapabilities().claudeSandbox
      ? "required"
      : "unavailable";
    // What its turns may not read; the Claude bridge carves its own runtime back out.
    env[COORDINATOR_PROTECTED_DATA_DIR_ENV] = context.storage.getDataDir();
  }

  if (kind === "opencode") {
    command = resolveOpenCodeBinary(context);
    // `serve` does not check for updates in 1.19, but this is the pinned
    // binary every native session depends on; never let it offer to replace
    // itself with OpenCode 2.
    Object.assign(env, OPENCODE_PINNED_RUNTIME_ENV);
    // Keeps the password from this server's tools and, for a coordinator,
    // its reads out of the data directory. A directory the user named stays
    // theirs: the plugins are then added through OPENCODE_CONFIG_CONTENT, and
    // a coordinator's server is refused when even that cannot be done.
    const plugins = await installHostOpenCodePlugins(env, context.storage.getDataDir(), {
      coordinator: Boolean(coordinatorId),
    });
    if (plugins.mode === "skipped") {
      nativeAgentOpencodeLog.warn("credential-plugin.skipped", { reason: plugins.reason });
    }
  } else if (kind === "claude") {
    command = resolveBunBinary(context);
    cwd = getBridgePath(context, "claude-bridge");
    env.CLAUDE_CLI_PATH = resolveClaudeBinary(context);
    // The managed binary stays on its pin; see CLAUDE_PINNED_RUNTIME_ENV.
    if (env.CLAUDE_CLI_PATH !== "claude") Object.assign(env, CLAUDE_PINNED_RUNTIME_ENV);
    // Read by the Claude CLI the bridge spawns; unset keeps its 2-hour ceiling.
    const bashMaxTimeout = claudeBashMaxTimeoutEnvValue(
      bridgeConfig.global.claudeBackgroundCommandLimitHours,
    );
    if (bashMaxTimeout) env[CLAUDE_BASH_MAX_TIMEOUT_ENV] = bashMaxTimeout;
    await applyClaudeHostCredentialEnvironment(context, env);
    if (coordinatorId) {
      // The same isolation Codex gets: credentials, and nothing else. The
      // user's own `~/.claude` carries settings, hooks, plugins and MCP
      // servers, every one of which is a program this boundary exists to keep
      // out of a session pointed at their real checkout.
      const coordinatorClaudeHome = path.join(
        context.storage.getDataDir(),
        "coordinator-runtime",
        coordinatorId,
        "conversations",
        coordinatorConversationId!,
        "claude-home",
      );
      const account = await applyCoordinatorClaudeAccount(
        context,
        coordinatorClaudeHome,
        env,
        prepareCoordinatorClaudeHome,
      );
      launchedAccountId = account.accountId;
      launchedTokenExpiresAt = account.tokenExpiresAt;
      launchedLoginless = account.loginless === true;
    } else {
      launchedAccountId = await applyActiveAgentAccountEnvironment(context, "claude", env);
    }
    // An isolated agent-test profile's scripted model, for coordinators too.
    applyAgentTestAnthropicOrigin(env, {
      runtimeFlavor: context.runtimeFlavor,
      dataDir: () => context.storage.getDataDir(),
    });
  } else if (kind === "codex") {
    command = resolveBunBinary(context);
    cwd = getBridgePath(context, "codex-bridge");
    const config = await context.storage.loadConfig();
    // Point app-server supervision at our shipped Codex binary so it does not
    // depend on a system install / PATH lookup in the packaged app.
    const codexPath = resolveCodexBinary(context);
    env.CODEX_PATH = codexPath;
    env[CODEX_MAX_CONCURRENT_THREADS_ENV] = String(
      resolveCodexMaxConcurrentThreads(config.global.codexMaxConcurrentThreads),
    );
    // Forwarded to app-server as clientInfo.version.
    env.ORKESTRATOR_VERSION = APP_VERSION;
    if (coordinatorId) {
      // Codex uses argv[0] to re-exec itself as the filesystem sandbox helper.
      // The managed bin directory contains symlinks, while the coordinator's
      // deny-by-default profile grants access only to the immutable runtime
      // directory. Launch the canonical executable so the helper re-execs a
      // path covered by the same permission profile.
      const coordinatorRuntime = await coordinatorCodexRuntime(codexPath);
      env.CODEX_PATH = coordinatorRuntime.executable;
      env.CODEX_BRIDGE_EXECUTION_POLICY = "coordinator-read-only";
      env.CODEX_BRIDGE_PERMISSION_PROFILE = `coordinator-${coordinatorConversationId!}`;
      env.CODEX_BRIDGE_READABLE_RUNTIME_ROOT = coordinatorRuntime.root;
      const coordinatorCodexHome = path.join(
        context.storage.getDataDir(),
        "coordinator-runtime",
        coordinatorId,
        "conversations",
        coordinatorConversationId!,
        "codex-home",
      );
      // Only the login is copied, access-only: from the active account's
      // directory, or the host's when no account was added.
      const account = await resolveActiveAgentAccount(context, "codex");
      if (account.home) stripInheritedAgentCredentials(env);
      const login = await prepareCoordinatorCodexHome(
        coordinatorCodexHome,
        account.home,
        context.runtime.accounts,
      );
      // The skills a worker on this account reads. The bridge lists them
      // through app-server and grants the permission profile read access.
      env[COORDINATOR_CODEX_USER_SKILLS_DIR_ENV] = path.join(
        account.home ?? coordinatorHostCodexHome(),
        "skills",
      );
      env.CODEX_HOME = coordinatorCodexHome;
      launchedAccountId = account.accountId;
      launchedTokenExpiresAt = login.tokenExpiresAt;
      // An inherited API key still serves turns without a login file.
      launchedLoginless =
        login.loginless === true && !env.CODEX_API_KEY?.trim() && !env.OPENAI_API_KEY?.trim();
    } else {
      launchedAccountId = await applyActiveAgentAccountEnvironment(context, "codex", env);
    }
  } else if (kind === "pi") {
    command = resolveBunBinary(context);
    cwd = await prepareBridgePath(context, "pi-bridge");
    // Pi's own configuration directory holds `auth.json`, which is the user's
    // provider credentials. A local worktree runs as the user, so the default
    // `~/.pi/agent` is exactly the one they signed in with — leaving it unset
    // is what makes `pi` in a terminal tab and a Pi native tab share an
    // account. Containers are handed an explicit path instead, and an
    // agent-test profile the host's `auth.json` alone when Pi is authorized.
    await applyPiHostCredentialEnvironment(context, env);
    env.PI_SESSION_DIR = environmentStateDirectory(
      context.storage.getDataDir(),
      "pi-bridge-sessions",
      environmentId,
    );
    env.PI_BRIDGE_STATE_DIR = environmentStateDirectory(
      context.storage.getDataDir(),
      "pi-bridge-state",
      environmentId,
    );
  } else if (kind === "cursor") {
    command = resolveBunBinary(context);
    // Every bridge is spawned from its own package directory, and this one is
    // no exception. `bun` bootstraps from its working directory — it reads
    // `bunfig.toml` (including `preload`) and `.env` before the entrypoint
    // runs — so starting it in the worktree would let a cloned repository
    // execute code in a host process holding the Cursor credential path, the
    // bridge token and the agent MCP token.
    //
    // The SDK's Shell tool still defaults to `process.cwd()` when the model
    // omits `workingDirectory`, so the bridge enters `CWD` itself once bun has
    // bootstrapped: see `applyWorkingDirectory` in the bridge's `config.ts`.
    cwd = await prepareBridgePath(context, "cursor-bridge");
    env.CURSOR_BRIDGE_STATE_DIR = environmentStateDirectory(
      context.storage.getDataDir(),
      "cursor-bridge-state",
      environmentId,
    );
    env.CURSOR_BRIDGE_AUTH_FILE = cursorSdkCredentialPath(context);
    if (cursorApiKey) env.CURSOR_API_KEY = cursorApiKey;
    else delete env.CURSOR_API_KEY;
  } else {
    command = resolveBunBinary(context);
    cwd = getBridgePath(context, "acp-bridge");
    env.ACP_PROVIDER = kind;
    env.ACP_STATE_DIR = path.join(
      environmentStateDirectory(context.storage.getDataDir(), "acp-bridge-state", environmentId),
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
    env.ACP_PROVIDER_CONFIG = JSON.stringify({
      id: kind,
      name: AGENT_PLATFORM_LABELS[kind],
      executable: managedAcpBinary,
      argv: ["--always-approve", "agent", "{{model}}", "{{effort}}", "stdio"],
      env: {},
      requiresAuthenticate: true,
      authMethodEnv: "GROK_AUTH_METHOD_ID",
      modeMap: {
        agent: "build",
        code: "build",
        build: "build",
        agentic: "build",
        plan: "plan",
        architect: "plan",
        ask: "plan",
      },
      extensionPrefixes: ["x.ai/", "_x.ai/"],
      acknowledgedExtensionMethods: [],
      modelUpdateMethods: ["x.ai/models/update", "_x.ai/models/update"],
      sessionUpdateMethods: ["x.ai/session/update", "_x.ai/session/update"],
    });
  }

  const bridgeEntrypoint = path.join(cwd, "dist", "index.js");
  if (kind !== "opencode") {
    if (!existsSync(cwd)) throw new Error(`${kind} bridge directory not found: ${cwd}`);
    if (!existsSync(bridgeEntrypoint))
      throw new Error(`${kind} bridge entrypoint not found: ${bridgeEntrypoint}`);
  }

  // Shutdown may have started while this already-admitted operation awaited
  // storage, port allocation, or packaged-path discovery. Recheck before any
  // scoped credential or bridge token is allocated so a rejected start cannot
  // leave valid, unused authority behind.
  assertLocalServerStartAllowed(context, environmentId);

  if (coordinatorId && selectedConversation && context.controlMcp?.getSettings().running) {
    context.controlMcp.revokeCoordinatorCredentials(coordinatorId, selectedConversation.id);
    agentToolConnection = context.controlMcp.issueCoordinatorCredential({
      role: "coordinator",
      projectId: environment.projectId,
      coordinatorId,
      conversationId: selectedConversation.id,
      mailboxIncarnationId: selectedConversation.mailboxIncarnationId,
      capabilities: coordinatorRoleCapabilities(
        selectedConversation.role === "side" ? "side" : "main",
      ),
    });
    env[ORKESTRATOR_AGENT_MCP_URL_ENV] = agentToolConnection.url;
    env[ORKESTRATOR_AGENT_MCP_TOKEN_ENV] = agentToolConnection.token;
  }

  const bridgeToken = mintBridgeToken();
  if (kind === "opencode") {
    env.OPENCODE_SERVER_PASSWORD = bridgeToken;
    env.OPENCODE_SERVER_USERNAME = "opencode";
  } else {
    // A local bridge is this backend's own child and build, so it always takes
    // a verifier and an authority key; the token and the key's private half
    // stay in this process.
    const tokenEnv =
      kind === "codex"
        ? "CODEX_BRIDGE_TOKEN"
        : kind === "claude"
          ? "CLAUDE_BRIDGE_TOKEN"
          : kind === "pi"
            ? "PI_BRIDGE_TOKEN"
            : kind === "cursor"
              ? "CURSOR_BRIDGE_TOKEN"
              : "ACP_BRIDGE_TOKEN";
    const authority = mintBridgeAuthorityKeyPair();
    env[bridgeTokenVerifierEnv(tokenEnv)] = bridgeTokenVerifier(bridgeToken);
    env[bridgeAuthorityKeyEnv(tokenEnv)] = authority.publicKey;
    rememberBridgeAuthorityKey(bridgeToken, authority.privateKey);
  }
  localServers.recordBridgeToken(kind, environmentId, bridgeToken);

  // Decided from the finished environment, so an account's XDG directories
  // count; see `opencode-host-database.ts`.
  if (kind === "opencode") Object.assign(env, hostOpenCodeDatabaseEnvironment(env));
  const args =
    kind === "opencode"
      ? ["serve", "--port", String(port), "--hostname", "127.0.0.1"]
      : [bridgeEntrypoint];
  // Held from spawn until healthy or failed; see `opencode-host-start.ts`.
  const releaseOpenCodeHostStart =
    kind === "opencode" ? await localServers.openCodeHostStart.acquire() : () => undefined;
  let child: ChildProcessWithoutNullStreams;
  try {
    // Shutdown may have begun while this start waited for the host's turn.
    assertLocalServerStartAllowed(context, environmentId);
    child = localServers.spawn(command, args, {
      cwd,
      env,
      // A dedicated group lets shutdown reach ordinary descendants immediately.
      // Explicit descendant signalling also covers children that create new groups.
      detached: process.platform !== "win32",
    });
  } catch (error) {
    releaseOpenCodeHostStart();
    localServers.forgetBridgeToken(kind, environmentId);
    if (coordinatorId && selectedConversation) {
      context.controlMcp?.revokeCoordinatorCredentials(coordinatorId, selectedConversation.id);
    }
    if (kind === "cursor") {
      localServers.recordCursorCredentialFingerprint(environmentId, undefined);
    }
    throw error;
  }
  if (kind === "cursor" && cursorCredentialFingerprint) {
    localServers.recordCursorCredentialFingerprint(environmentId, cursorCredentialFingerprint);
  }
  localServers.adoptProcess(key, child, {
    workingDirectory: environment.worktreePath,
    accountId: launchedAccountId,
    tokenExpiresAt: launchedTokenExpiresAt,
    loginless: launchedLoginless,
  });
  if (coordinatorId) coordinatorResearchLaunches.set(child, researchSignature);
  localServers.reportBridgeStart(key, child);
  forwardBridgeOutput(child, `${kind}:${environmentId}`);
  child.once("exit", (code, signal) => {
    localServers.reportBridgeExit(key, child, code, signal);
    void localServers.reapAfterUnrequestedExit(key, child);
    // An unhealthy child may exit after its replacement has already claimed the
    // key. Only the process that still owns the entry may remove it.
    if (!localServers.releaseOwnership(key, child)) return;
    if (coordinatorId && selectedConversation) {
      context.controlMcp?.revokeCoordinatorCredentials(coordinatorId, selectedConversation.id);
      void context.storage.coordinators
        .mutateCoordinatorWorkspace(environment.projectId, (workspace) =>
          workspace && workspace.id === coordinatorId
            ? {
                ...workspace,
                conversations: workspace.conversations.map((conversation) =>
                  conversation.id === coordinatorConversationId
                    ? { ...conversation, bridgePort: undefined, bridgePid: undefined }
                    : conversation,
                ),
                updatedAt: new Date().toISOString(),
              }
            : workspace,
        )
        .catch(() => undefined);
    }
    if (bugReportId) void recordBugReportBridge(context, bugReportId, child, null);
  });

  const { port: field, pid: pidField } = localServerFields(kind);
  try {
    const authToken = localServers.bridgeToken(kind, environmentId);
    try {
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
    } finally {
      releaseOpenCodeHostStart();
    }
    log.recovered("bridge.not-answering", key);
    if (kind === "opencode" && authToken && agentToolConnection) {
      localServers.openCodeAgentTools.recordLaunchConnection(
        `local:${environmentId}`,
        agentToolConnection,
      );
      const configured = localServers.openCodeAgentTools.schedule(
        `local:${environmentId}`,
        port,
        authToken,
        agentToolConnection,
        environment.worktreePath,
      );
      // Ticket tools are optional for an ordinary chat, which must not wait on
      // them. Every coordinator action is a Control MCP tool, so its server is
      // not ready until they are connected; a first turn sent sooner told the
      // user its delegation tools did not exist.
      if (coordinatorId && (await configured) !== "connected") {
        throw retryableBridgeStartupError(
          "The OpenCode coordinator could not connect its Orkestrator tools",
        );
      }
      // Research servers before the first turn too, so the permission rules
      // a new session is created with already allow their tools. Optional:
      // a server that does not connect leaves the coordinator without it.
      if (coordinatorId) {
        await context.runtime.localServers.openCodeAgentTools.research
          .configure({
            serverKey: `local:${environmentId}`,
            port,
            password: authToken,
            directory: environment.worktreePath,
            servers: coordinatorResearchMcpServersFromEnv(env),
            signal: AbortSignal.timeout(15_000),
          })
          .catch((error: unknown) => {
            nativeAgentOpencodeLog.warn("coordinator-servers.unavailable", {
              environmentId,
              error: formatLogError(error),
            });
          });
      }
    }
    if (coordinatorId) {
      await context.storage.coordinators.mutateCoordinatorWorkspace(
        environment.projectId,
        (workspace) =>
          workspace && workspace.id === coordinatorId
            ? {
                ...workspace,
                conversations: workspace.conversations.map((conversation) =>
                  conversation.id === coordinatorConversationId
                    ? {
                        ...conversation,
                        bridgePort: port,
                        bridgePid: child.pid,
                        startupError: undefined,
                      }
                    : conversation,
                ),
                updatedAt: new Date().toISOString(),
              }
            : workspace,
      );
    } else if (bugReportId) {
      await recordBugReportBridge(context, bugReportId, child, { port, pid: child.pid! });
    } else {
      await context.storage.updateEnvironment(environmentId, {
        [field]: port,
        [pidField]: child.pid,
      });
    }
  } catch (error) {
    let terminationError: unknown;
    try {
      await localServers.terminate(
        key,
        child,
        `startup did not complete: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } catch (caught) {
      terminationError = caught;
    }
    if (coordinatorId) {
      if (selectedConversation) {
        context.controlMcp?.revokeCoordinatorCredentials(coordinatorId, selectedConversation.id);
      }
      // A start that shutdown cut short says nothing about the conversation, and
      // the record would refuse it after the next launch. Only this conversation
      // is marked: the workspace, and every other conversation, stay as they are.
      const startupError = localServers.isShuttingDown()
        ? undefined
        : sanitizeCoordinatorError(error);
      await context.storage.coordinators
        .mutateCoordinatorWorkspace(environment.projectId, (workspace) =>
          workspace && workspace.id === coordinatorId
            ? {
                ...workspace,
                conversations: workspace.conversations.map((conversation) =>
                  conversation.id === coordinatorConversationId
                    ? { ...conversation, bridgePort: undefined, bridgePid: undefined, startupError }
                    : conversation,
                ),
                updatedAt: new Date().toISOString(),
              }
            : workspace,
        )
        .catch(() => undefined);
    } else if (bugReportId) {
      await recordBugReportBridge(context, bugReportId, child, null).catch(() => undefined);
    } else {
      await context.storage
        .updateEnvironment(environmentId, { [field]: null, [pidField]: null })
        .catch(() => undefined);
    }
    if (terminationError) {
      // Clients show only `message`, so the causes have to be in it: without
      // them a missing executable is indistinguishable from a stuck process.
      const reason = (value: unknown) => (value instanceof Error ? value.message : String(value));
      throw new AggregateError(
        [error, terminationError],
        `Failed to start and clean up local server: ${key} ` +
          `(startup: ${reason(error)}; cleanup: ${reason(terminationError)})`,
      );
    }
    throw error;
  }
  const authToken = localServers.bridgeToken(kind, environmentId);
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
  assertLocalServerStartAllowed(context, environmentId);
  return context.runtime.localServers.enqueueEnvironmentOperation(environmentId, async () => {
    // Shutdown may have begun while this start was queued behind an earlier
    // lifecycle operation.
    if (context.runtime.localServers.isShuttingDown()) {
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
  return context.runtime.localServers.enqueueEnvironmentOperation(environmentId, () =>
    stopLocalServerUnlocked(environmentId, context, kind),
  );
}

export { deleteEnvironment, deleteEnvironmentTask } from "./environment-delete.js";

/**
 * The Claude configuration directory a local tmux launch exports: the active
 * account's. tmux cannot import the account modules without a cycle, so the
 * backend passes this to `BackendRuntime` as `tmux.localClaudeConfigDirectory`
 * (`index.ts`, `tests/command-fixtures.ts`).
 *
 * An agent-test profile with no added account exports its own isolated
 * directory, the backend's `CLAUDE_CONFIG_DIR`. Its sessions run on the host's
 * shared tmux server, whose environment is whoever started it first, so
 * without the export the CLI would read the host's `~/.claude` while the
 * backend looks for the transcript in the profile's directory
 * (`localClaudeHome`).
 * Profiles explicitly granted host Claude credentials keep the host tmux
 * environment: changing their config directory would also change the CLI's
 * Keychain namespace without supplying the bridge's host-token injection.
 */
export async function tmuxLocalClaudeConfigDirectory(
  context: CommandContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const active = (await activeAgentAccountShellEnvironment(context)).CLAUDE_CONFIG_DIR;
  if (active || context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("claude"))
    return active;
  return env.CLAUDE_CONFIG_DIR?.trim() || undefined;
}

/**
 * Resumes only the unambiguous follow-up half of a persisted merge-and-cleanup
 * workflow. A backend restart must never resubmit an ambiguous GitHub merge;
 * exact-URL PR monitoring first establishes `prState: "merged"`, then this
 * continuation can safely retry deletion.
 *
 * The PR monitor observes merges but cannot import this module (it would be a
 * cycle), so the backend passes this function to `BackendRuntime` as
 * `prMonitor.scheduleMergeCleanup` (`index.ts`, `tests/command-fixtures.ts`).
 *
 * Recovery is for work no one is doing. A merge or delete running in this
 * process owns the outcome and records any failure itself, so this stands aside
 * rather than failing against its guard. Those guards live in memory, so after a
 * restart they are clear and the delete resumes.
 */
export function scheduleMergeCleanupRecovery(environmentId: string, context: CommandContext): void {
  const environments = context.runtime.environments;
  const owned = () =>
    environments.isMerging(environmentId) || environments.isDeleting(environmentId);
  if (owned()) return;
  environments.scheduleMergeCleanupRecovery(environmentId, () =>
    (async () => {
      const environment = await context.storage.getEnvironment(environmentId);
      // Either may have started while storage was read.
      if (owned()) return;
      if (
        !environment?.cleanupAfterMergeRequestedAt ||
        environment.cleanupAfterMergeError ||
        (environment.prState !== "merged" && !environment.deletionRequestedAt)
      ) {
        return;
      }
      await deleteEnvironmentTask(environmentId, context);
    })().catch((error) => {
      environmentLog.warn("merge-cleanup.resume-failed", {
        environmentId,
        error: formatLogError(error),
      });
    }),
  );
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
  const env = await localRuntimeEnvironment(environmentId, context);
  // The owned child can exit while storage is being read. Re-read ownership
  // after the await so an exit handler that released the process cannot leave
  // this snapshot claiming that a dead child is still running.
  const localServers = context.runtime.localServers;
  const child = localServers.process(key);
  const port = localServerPort(env, kind);
  const { pid: pidField } = localServerFields(kind);
  const persistedPid = env?.[pidField];
  const pid = typeof persistedPid === "number" ? persistedPid : undefined;
  const authToken = localServers.bridgeToken(kind, environmentId);
  const reconcileConnection =
    kind === "opencode" && child && !child.killed && port && authToken && env?.worktreePath
      ? openCodeReconcileConnection(environmentId, env, context)
      : undefined;
  if (reconcileConnection && port && authToken && env?.worktreePath) {
    void localServers.openCodeAgentTools.schedule(
      `local:${environmentId}`,
      port,
      authToken,
      reconcileConnection,
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
      ? { agentTools: localServers.openCodeAgentTools.state(`local:${environmentId}`) }
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
  return context.runtime.localServers.enqueueEnvironmentOperation(environmentId, () =>
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

/**
 * Forward a local bridge's output to this process's log, which Debug logging
 * writes to disk, scrubbed of credential-shaped text and reassembled into whole
 * lines. A logger record is re-emitted at its own level, naming the bridge in
 * `source`; anything else (a crash, a runtime panic) stays captured as output.
 */
export function forwardBridgeOutput(
  child: Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr">,
  source: string,
): void {
  const stdout = createBridgeOutputForwarder((text) => relayBridgeOutput("stdout", source, text));
  const stderr = createBridgeOutputForwarder((text) => relayBridgeOutput("stderr", source, text));
  child.stdout.on("data", stdout.push);
  child.stderr.on("data", stderr.push);
  child.stdout.once("end", stdout.flush);
  child.stderr.once("end", stderr.flush);
}
