import {
  COORDINATOR_RESEARCH_MCP_ENV,
  COORDINATOR_WEB_RESEARCH_ENV,
  coordinatorResearchMcpServersFromEnv,
  coordinatorWebResearchEnv,
  coordinatorWebResearchSetting,
  normalizeCoordinatorResearchMcpServers,
} from "@orkestrator/protocol/coordinator-web-research";
import {
  formatContainerLifecycleError,
  parseContainerLifecycle,
} from "@orkestrator/protocol/container-lifecycle";
import {
  CLAUDE_BASH_MAX_TIMEOUT_ENV,
  claudeBashMaxTimeoutEnvValue,
} from "@orkestrator/protocol/claude-background-commands";
import { stopEnvironmentReviewValidation } from "./review-validation-service.js";
import { removeOpenCodeCommandChangeJournals } from "./opencode-command-changes.js";
import {
  OPENCODE_STARTUP_STDERR_TAIL_BYTES,
  isOpenCodeDatabaseLockedError,
  openCodeDatabaseLockedError,
  openCodeStderrReportsLockedDatabase,
} from "./opencode-host-start.js";
import {
  CLAUDE_PINNED_RUNTIME_ENV,
  OPENCODE_PINNED_RUNTIME_ENV,
} from "@orkestrator/protocol/terminal-agent-launch";
import { stopEnvironmentExecWorkers } from "./public-api/exec-control.js";
import { existsSync, promises as seedFs } from "node:fs";
import { seedFilesDir } from "./nodes/node-files.js";
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
import { cleanupEnvironmentTmux, shutdownClaudeStatePolling } from "./tmux.js";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import {
  coordinatorBridgeEnvironmentFields,
  localServerFields,
  stopLocalServerUnlocked,
  stopLocalServersForEnvironmentUnlocked,
} from "./commands-local-server-lifecycle.js";
import {
  checkHttpHealth,
  confirmRunningServerHealth,
  waitForLocalServerHealth,
  openCodeHealthHeaders,
  bearerBridgeHeaders,
} from "./commands-server-health.js";
import type { OpenCodeAgentToolsState } from "./opencode-agent-tools.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Environment } from "./models.js";
import type { AgentToolConnection } from "./agent-tools.js";
import type { AgentModel, AgentReasoningOption } from "@orkestrator/protocol/native-agent";
import {
  BRIDGE_TOKEN_PATTERN,
  retryableBridgeStartupError,
  LOCAL_SERVER_KINDS,
} from "./local-server-runtime.js";
import {
  resolveCodexBinary,
  resolveOpenCodeBinary,
  resolveClaudeBinary,
  resolveManagedAcpBinary,
  resolveBunBinary,
} from "./commands-agent-support.js";
import { environmentStateDirectory } from "./environment-state-paths.js";
import { environmentCleanupLedger } from "./environment-cleanup-ledger.js";
import { buildEnvironmentCleanupEntry, runEnvironmentCleanupStep } from "./environment-cleanup.js";
import { scheduleEnvironmentCleanupReconcile } from "./environment-cleanup-reconciler.js";
import {
  assertDockerContainerOwned,
  cleanupEnvironmentSetupState,
  enqueueEnvironmentLifecycleOperation,
  deleteMergedEnvironmentRemoteBranch,
} from "./commands-environment.js";
import { getHostPort } from "./commands-container-exec.js";
import { dockerExec } from "./commands-container-exec.js";
import { conciseError, cleanupErrorMessage } from "./commands-error-text.js";
import {
  applyClaudeHostCredentialEnvironment,
  applyPiHostCredentialEnvironment,
  resolveCursorHostCredentialMaterial,
} from "./host-agent-credentials.js";
import { cursorSdkCredentialPath } from "./cursor-sdk-bridge.js";
import { createBridgeOutputForwarder } from "./bridge-output-redaction.js";
import type { LocalServerKind } from "./local-server-runtime.js";
import type { CommandContext } from "./commands-context.js";
import {
  COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV,
  COORDINATOR_CODEX_USER_SKILLS_DIR_ENV,
  COORDINATOR_COMMAND_SANDBOX_ENV,
  COORDINATOR_EXECUTION_POLICY,
  coordinatorIdFromRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { defaultCoordinatorHostCapabilities } from "./coordinator-providers.js";
import { configureOpenCodeCoordinatorResearch } from "./opencode-coordinator-research.js";

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
import { sanitizeCoordinatorError } from "./coordinator-service.js";
import {
  coordinatorRuntimeUnavailableMessage,
  resolveCoordinatorRuntime,
} from "./coordinator-runtime.js";
import { drainContainerProcesses } from "./container-readiness.js";
import { coordinatorRoleCapabilities } from "./control-mcp-tools.js";
import { setLocalClaudeConfigDirectoryProvider } from "./tmux-session-manager.js";
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

/** Deletion drains briefly: the container is removed right after. */
const DELETION_DRAIN_GRACE_SECONDS = 5;

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
  const login = await readCoordinatorCodexLogin({ accountId: "default", home: source });
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

async function localRuntimeEnvironment(
  environmentId: string,
  context: CommandContext,
): Promise<Environment | null> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (environment) return environment;
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
): Promise<void> {
  let settled = false;
  // Only OpenCode's is read: its servers share one database on the host, and
  // the one failure worth retrying names itself only on stderr.
  let stderrTail = "";
  const onStderr = (data: Buffer | string) => {
    stderrTail = (stderrTail + data.toString()).slice(-OPENCODE_STARTUP_STDERR_TAIL_BYTES);
  };

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
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
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const message = `${kind} server exited before becoming healthy (code ${code ?? "null"}, signal ${signal ?? "null"})`;
      complete(
        kind === "opencode" && openCodeStderrReportsLockedDatabase(stderrTail)
          ? openCodeDatabaseLockedError(
              `${message}: another OpenCode process held its database (database is locked)`,
            )
          : new Error(message),
      );
    };

    child.once("error", onError);
    child.once("exit", onExit);
    if (kind === "opencode") child.stderr.on("data", onStderr);
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

/** Where each container bridge publishes its port and its renderer credential. */
export const CONTAINER_BRIDGE_PEEK: Record<
  LocalServerKind,
  { containerPort: number; tokenFile: string }
> = {
  claude: { containerPort: CLAUDE_BRIDGE_PORT, tokenFile: "/tmp/claude-bridge-token" },
  codex: { containerPort: CODEX_BRIDGE_PORT, tokenFile: "/tmp/codex-bridge-token" },
  cursor: { containerPort: CURSOR_BRIDGE_PORT, tokenFile: "/tmp/cursor-bridge-token" },
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
  if (coordinatorIdFromRuntimeId(environmentId)) return undefined;
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
      return await startLocalServerAttempt(environmentId, context, kind);
    } catch (error) {
      // A failed attempt has already stopped its server and cleared its
      // fields, so the next one starts clean.
      const delayMs = isOpenCodeDatabaseLockedError(error)
        ? context.runtime.localServers.openCodeHostStart.lockedStartRetryDelayMs(attempt)
        : undefined;
      if (delayMs === undefined || context.runtime.localServers.isShuttingDown()) throw error;
      console.warn(
        `[local-server] opencode:${environmentId} lost the shared OpenCode database at startup; retrying in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
      const health = await confirmRunningServerHealth(port, healthHeaders, isAlive);
      if (health.healthy) {
        localServers.clearUnresponsive(key);
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
          console.warn(
            `[local-server] ${key} (pid ${existing.pid}) is not answering health checks ` +
              `(${Math.round(unresponsiveForMs / 1000)}s) but has work in progress; not restarting it yet`,
          );
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
  const environment = await localRuntimeEnvironment(environmentId, context);
  if (!environment?.worktreePath) {
    throw retryableBridgeStartupError("Local environment worktree is not available");
  }
  const selectedConversation = coordinator?.status === "ready" ? coordinator.conversation : null;
  const coordinatorConversationId =
    coordinator?.status === "ready" ? coordinator.conversationId : null;
  let agentToolConnection: AgentToolConnection | undefined;
  if (!coordinatorId) {
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
    ORKESTRATOR_BRIDGE_DEBUG: bridgeConfig.global.debugLogging === true ? "1" : "0",
    ...(agentToolConnection
      ? {
          [ORKESTRATOR_AGENT_MCP_URL_ENV]: agentToolConnection.url,
          [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: agentToolConnection.token,
        }
      : {}),
  };
  // A widened attachment boundary is inherited, not requested: a backend
  // started with this variable in its own environment would otherwise hand it
  // to every worker bridge. Only the branch below may name a root.
  delete env[ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT_ENV];
  delete env.CODEX_BRIDGE_STATE_DIR;
  // The same for coordinator research: read-only review turns in a worker
  // bridge consult these too, so only the coordinator branch may set them.
  delete env[COORDINATOR_WEB_RESEARCH_ENV];
  delete env[COORDINATOR_RESEARCH_MCP_ENV];
  delete env[COORDINATOR_COMMAND_SANDBOX_ENV];
  delete env[COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV];
  delete env[COORDINATOR_CODEX_USER_SKILLS_DIR_ENV];
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
  }

  if (kind === "opencode") {
    command = resolveOpenCodeBinary(context);
    // `serve` does not check for updates in 1.19, but this is the pinned
    // binary every native session depends on; never let it offer to replace
    // itself with OpenCode 2.
    Object.assign(env, OPENCODE_PINNED_RUNTIME_ENV);
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
      const login = await prepareCoordinatorCodexHome(coordinatorCodexHome, account.home);
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
    cwd = getBridgePath(context, "pi-bridge");
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
    cwd = getBridgePath(context, "cursor-bridge");
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

  const bridgeToken = randomBytes(32).toString("base64url");
  env[
    kind === "codex"
      ? "CODEX_BRIDGE_TOKEN"
      : kind === "claude"
        ? "CLAUDE_BRIDGE_TOKEN"
        : kind === "opencode"
          ? "OPENCODE_SERVER_PASSWORD"
          : kind === "pi"
            ? "PI_BRIDGE_TOKEN"
            : kind === "cursor"
              ? "CURSOR_BRIDGE_TOKEN"
              : "ACP_BRIDGE_TOKEN"
  ] = bridgeToken;
  if (kind === "opencode") env.OPENCODE_SERVER_USERNAME = "opencode";
  localServers.recordBridgeToken(kind, environmentId, bridgeToken);

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
  forwardBridgeOutput(child, `[${kind}:${environmentId}]`);
  child.once("exit", () => {
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
        await configureOpenCodeCoordinatorResearch({
          serverKey: `local:${environmentId}`,
          port,
          password: authToken,
          directory: environment.worktreePath,
          servers: coordinatorResearchMcpServersFromEnv(env),
          signal: AbortSignal.timeout(15_000),
        }).catch((error: unknown) => {
          console.warn(
            `[backend] OpenCode coordinator research servers are unavailable for ${environmentId}:`,
            conciseError(error),
          );
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
                    ? { ...conversation, bridgePort: port, bridgePid: child.pid }
                    : conversation,
                ),
                lifecycleState: "ready",
                lastStartupError: undefined,
                updatedAt: new Date().toISOString(),
              }
            : workspace,
      );
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
      await context.storage.coordinators
        .mutateCoordinatorWorkspace(environment.projectId, (workspace) =>
          workspace && workspace.id === coordinatorId
            ? {
                ...workspace,
                conversations: workspace.conversations.map((conversation) =>
                  conversation.id === coordinatorConversationId
                    ? { ...conversation, bridgePort: undefined, bridgePid: undefined }
                    : conversation,
                ),
                lifecycleState: "error",
                lastStartupError: sanitizeCoordinatorError(error),
                updatedAt: new Date().toISOString(),
              }
            : workspace,
        )
        .catch(() => undefined);
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

export async function deleteEnvironment(
  environmentId: string,
  context: CommandContext,
  options: { allowWhileMerging?: boolean } = {},
): Promise<void> {
  if (context.runtime.localServers.isShuttingDown()) {
    throw new Error("Backend is shutting down; environments cannot be deleted");
  }
  if (context.runtime.environments.isMerging(environmentId) && !options.allowWhileMerging) {
    throw new Error(`Environment is currently being merged: ${environmentId}`);
  }
  try {
    await context.runtime.localServers.enqueueEnvironmentOperation(environmentId, async () => {
      const { storage } = context;
      const environment = await storage.getEnvironment(environmentId);
      // A lifecycle record written by a newer version may reference storage
      // this version cannot recognise; deleting around it could orphan data.
      if (environment && !parseContainerLifecycle(environment.containerLifecycle).supported) {
        throw new Error(
          formatContainerLifecycleError(
            "unsupported-format",
            "This environment was changed by a newer version of Orkestrator. Update Orkestrator before deleting it.",
          ),
        );
      }
      // Deleting removes the container, its volumes and its network, so it
      // needs the registry writer like every other container mutation. A
      // backend opened over a newer writer's data directory is read-only.
      if (environment?.environmentType === "containerized") {
        context.registryWriterLease?.assertHeld();
      }
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
      // Record what the host still owes before anything is removed. The
      // best-effort steps below may fail after the environment record is gone;
      // the ledger is what lets the reconciler finish them later.
      const project = environment
        ? await storage.getProject(environment.projectId).catch(() => null)
        : null;
      const cleanup = environment
        ? buildEnvironmentCleanupEntry(environment, project, storage.getDataDir())
        : null;
      if (cleanup) await environmentCleanupLedger(storage.getDataDir()).record(cleanup);
      // Agents lose tool access first: nothing an agent calls back into may act
      // on an environment that is being taken apart.
      context.agentTools?.revokeEnvironment(environmentId);
      await stopEnvironmentReviewValidation(environmentId, context);
      await stopEnvironmentExecWorkers(environmentId, context);
      // The user's `!` commands run in the worktree too.
      await context.userCommands?.terminateForEnvironment(environmentId);
      context.humanPrompts?.clearEnvironment(environmentId);
      // Waits for every terminal tree, including setup's build descendants, so
      // nothing re-creates files in the worktree after it is removed below.
      const survivingTerminals =
        await context.runtime.terminals.terminateSessionsForEnvironment(environmentId);
      if (survivingTerminals.length > 0) {
        console.warn(
          `[backend] ${survivingTerminals.length} terminal process tree(s) outlived termination for ${environmentId}`,
        );
        throw new Error(
          "Terminal process trees are still running; environment deletion can be retried",
        );
      }
      await context.runtime.terminals.history.deleteHistories({
        dataDir: storage.getDataDir(),
        environmentId,
      });
      if (environment)
        await deleteMergedEnvironmentRemoteBranch(environment).catch(() => undefined);
      if (environment?.worktreePath)
        context.runtime.diffStats.gitFetchScheduler.forget(environment.worktreePath);
      // Before the container is removed and before the worktree is deleted:
      // killing the tmux sessions needs the container alive, and restoring the
      // user's `.claude/settings.local.json` from the tmux-mode backup needs
      // the worktree still on disk. Best-effort — a tmux server that has
      // already gone must not strand the rest of the deletion.
      await cleanupEnvironmentTmux(environmentId, context).catch((error: unknown) => {
        console.warn("[backend] claude-tmux cleanup failed during environment deletion:", error);
      });
      context.previews?.registry.beforeEnvironmentTargetChange(environmentId);
      if (environment?.containerId) {
        // Retire state polling before removing the container, or the next tick
        // execs into something that no longer exists.
        shutdownClaudeStatePolling(environment.containerId);
        context.runtime.localServers.openCodeAgentTools.cancel(
          `container:${environment.containerId}`,
        );
        // Bridges and agents get the drain's SIGTERM, so they settle their
        // journals and deny parked approvals before the forced removal. A
        // stopped container has nothing to drain and is not exec'd into.
        if (environment.status === "running") {
          await drainContainerProcesses(
            environment.containerId,
            DELETION_DRAIN_GRACE_SECONDS,
          ).catch(() => null);
        }
        // Ownership was asserted before the tombstone, above.
        if (cleanup) {
          await runEnvironmentCleanupStep(cleanup, "container", context, {
            containerOwnershipVerified: true,
          });
        }
      }
      // Recovery copies are owed even when no current runtime exists.
      if (!environment?.containerId && cleanup?.pending.includes("container")) {
        await runEnvironmentCleanupStep(cleanup, "container", context);
      }
      // Persistent storage and the environment's network go after its
      // containers; a failure stays pending in the ledger and is retried by
      // the reconciler.
      if (cleanup?.pending.includes("volumes")) {
        await runEnvironmentCleanupStep(cleanup, "volumes", context);
      }
      if (cleanup?.pending.includes("network")) {
        await runEnvironmentCleanupStep(cleanup, "network", context);
      }
      await stopLocalServersForEnvironmentUnlocked(environmentId, context);
      if (cleanup?.worktreePath) {
        const worktreeRemoved = await runEnvironmentCleanupStep(cleanup, "worktree", context);
        // A branch still checked out in a surviving worktree cannot be judged or
        // deleted; the reconciler retries it after the worktree step succeeds.
        if (worktreeRemoved && cleanup.branch) {
          await runEnvironmentCleanupStep(cleanup, "branch", context);
        }
      }
      await storage.removeSessionsByEnvironment(environmentId).catch(() => undefined);
      await storage.deleteLoopedReviewWorkflowsByEnvironment(environmentId);
      await storage.deleteMultiReviewWorkflowsByEnvironment(environmentId);
      // A pipeline whose environment is gone can never advance again; leaving it
      // behind would resurrect a dead build on the next client that hydrates.
      await storage.deleteBuildPipelinesByEnvironment(environmentId, environment?.buildPipelineId);
      // Queued prompts for a deleted environment can never be dispatched.
      await storage.deletePromptQueuesByEnvironment(environmentId);
      // StorageService owns this in production. Keep the deletion seam tolerant
      // of legacy/embedded command adapters that intentionally implement only
      // the older lifecycle subset; their absence cannot justify stranding an
      // otherwise deletable environment.
      if (typeof storage.deleteAgentMailByEnvironment === "function") {
        await storage.deleteAgentMailByEnvironment(environmentId);
      }
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
      // Measured shell-change badges of the environment's OpenCode sessions.
      // Never rejects; a leftover journal only costs disk.
      if (typeof storage.getDataDir === "function") {
        await removeOpenCodeCommandChangeJournals(storage.getDataDir(), environmentId);
      }
      context.nativeAgents?.forgetEnvironmentCommandCatalogues?.(environmentId);
      await storage.deleteComposeDraftsByEnvironment(environmentId);
      await storage.deleteFileDraftsByEnvironment(environmentId);
      await storage.deleteAgentHandoffsByEnvironment(environmentId);
      // The environment's workflows were deleted above; their open result
      // slots would otherwise count against the active-entry limit forever.
      await context.deleteWorkflowResultsByEnvironment?.(environmentId);
      await context.design?.deleteEnvironment(environmentId);
      // Stops annotation writes for this environment, then removes its store.
      await context.webAnnotations?.deleteEnvironment(environmentId).catch((error: unknown) => {
        console.warn(
          `[backend] web annotation cleanup failed for ${environmentId}:`,
          error instanceof Error ? error.name : "unknown",
        );
      });
      // Fences and removes the environment's artifact records, bytes and grants.
      await context.transcriptArtifacts
        ?.deleteEnvironment(environmentId)
        .catch((error: unknown) => {
          console.warn(
            `[backend] transcript artifact cleanup failed for ${environmentId}:`,
            error instanceof Error ? error.name : "unknown",
          );
        });
      // Schedules its agents own go with it; others' schedules aimed at it pause.
      try {
        context.scheduledJobs?.environmentDeleted(environmentId);
      } catch (error) {
        console.warn(
          `[backend] scheduled job cleanup failed for ${environmentId}:`,
          error instanceof Error ? error.name : "unknown",
        );
      }
      // Its environment-scoped permission rules and their application record
      // go with it; project rules stay (todo 0723).
      try {
        if (typeof storage.permissionRuleStore === "function") {
          storage.permissionRuleStore().environmentDeleted(environmentId);
        }
      } catch (error) {
        console.warn(
          `[backend] permission rule cleanup failed for ${environmentId}:`,
          error instanceof Error ? error.name : "unknown",
        );
      }
      context.agentTools?.revokeEnvironment(environmentId);
      await seedFs.rm(seedFilesDir(storage.getDataDir(), environmentId), {
        recursive: true,
        force: true,
      });
      await storage.removeEnvironment(environmentId);
      // Bridges were stopped above, so nothing is writing bridge state now.
      if (cleanup) await runEnvironmentCleanupStep(cleanup, "state-dirs", context);
      await storage.deletePaneLayout(environmentId).catch(() => undefined);
      // A terminal start that began before the tombstone may have been awaiting
      // storage or filesystem I/O during the first sweep. Close anything that
      // became visible before deletion completed.
      context.runtime.terminals.cleanupSessionsForEnvironment(environmentId);
      await context.runtime.terminals.history.deleteHistories({
        dataDir: storage.getDataDir(),
        environmentId,
      });
      cleanupEnvironmentSetupState(context, environmentId);
      // Releases the watcher and discards the counts. This is the one case where
      // discarding is right: the worktree they described is gone.
      context.runtime.diffStats.invalidatePendingSync();
      context.runtime.diffStats.service.untrack(environmentId);
      // The PR belonged to a branch whose environment is gone; polling it would
      // resurrect state for an id no client can display.
      context.runtime.prMonitor.invalidatePendingSync();
      context.runtime.prMonitor.service.untrack(environmentId);
      if (environment?.worktreePath)
        context.runtime.diffStats.gitFetchScheduler.forget(environment.worktreePath);
      // Its clone is gone; a fetch still running for it can no longer stamp.
      if (environment?.containerId)
        context.runtime.diffStats.containerGitFetchPolicy.forgetContainer(environment.containerId);
    });
    // Other deletions may have left steps pending; a successful one is a cheap
    // moment to retry them without waiting for the next startup.
    scheduleEnvironmentCleanupReconcile(context);
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
  const environments = context.runtime.environments;
  if (context.runtime.localServers.isShuttingDown()) {
    return Promise.reject(new Error("Backend is shutting down; environments cannot be deleted"));
  }
  if (environments.isMerging(environmentId) && !options.allowWhileMerging) {
    return Promise.reject(new Error(`Environment is currently being merged: ${environmentId}`));
  }
  // Reserve deletion before queueing. Local server starts consult this guard,
  // so work admitted after delete cannot recreate a process behind cleanup.
  if (!environments.beginDelete(environmentId)) {
    return Promise.reject(new Error(`Environment is already being deleted: ${environmentId}`));
  }
  environments.invalidateStartDedupe(environmentId);
  try {
    return enqueueEnvironmentLifecycleOperation(environmentId, context, () =>
      deleteEnvironment(environmentId, context, options),
    ).finally(() => {
      environments.endDelete(environmentId);
    });
  } catch (error) {
    environments.endDelete(environmentId);
    throw error;
  }
}

// tmux cannot import the account modules without a cycle; the owner registers.
setLocalClaudeConfigDirectoryProvider(
  async (context) => (await activeAgentAccountShellEnvironment(context)).CLAUDE_CONFIG_DIR,
);

/**
 * Resumes only the unambiguous follow-up half of a persisted merge-and-cleanup
 * workflow. A backend restart must never resubmit an ambiguous GitHub merge;
 * exact-URL PR monitoring first establishes `prState: "merged"`, then this
 * continuation can safely retry deletion.
 *
 * The PR monitor observes merges but cannot import this module (it would be a
 * cycle), so the backend passes this function to `BackendRuntime` as
 * `prMonitor.scheduleMergeCleanup` (`index.ts`, `tests/command-fixtures.ts`).
 */
export function scheduleMergeCleanupRecovery(environmentId: string, context: CommandContext): void {
  context.runtime.environments.scheduleMergeCleanupRecovery(environmentId, () =>
    (async () => {
      const environment = await context.storage.getEnvironment(environmentId);
      if (
        !environment?.cleanupAfterMergeRequestedAt ||
        environment.cleanupAfterMergeError ||
        (environment.prState !== "merged" && !environment.deletionRequestedAt)
      ) {
        return;
      }
      await deleteEnvironmentTask(environmentId, context);
    })().catch((error) => {
      console.warn(
        `[backend] Failed to resume merge cleanup for ${environmentId}:`,
        conciseError(error),
      );
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
 * Forward a local bridge's output to the console, which Debug logging writes
 * to disk, scrubbed of credential-shaped text and reassembled into whole lines.
 */
export function forwardBridgeOutput(
  child: Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr">,
  prefix: string,
): void {
  const stdout = createBridgeOutputForwarder((text) => console.debug(`${prefix} ${text}`));
  const stderr = createBridgeOutputForwarder((text) => console.error(`${prefix} ${text}`));
  child.stdout.on("data", stdout.push);
  child.stderr.on("data", stderr.push);
  child.stdout.once("end", stdout.flush);
  child.stderr.once("end", stderr.flush);
}
