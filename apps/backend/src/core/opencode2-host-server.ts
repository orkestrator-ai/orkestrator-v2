/**
 * The host OpenCode 2.x server of one local environment
 * (docs/todo/agent-engines/0008-opencode-v2.md, build plan phase 3).
 *
 * A second process beside the environment's 1.x `opencode serve`, started
 * only when an OpenCode 2.x session needs it:
 *
 * - launched from the managed `opencode2` binary through
 *   {@link openCode2HostLaunch}, so it has its own `OPENCODE_DB` and config
 *   directory under Orkestrator's data directory (never the user's
 *   `~/.local/share/opencode/opencode.db`), the credential plugin that keeps
 *   its password from the agent's tools, autoupdate off and explicit flags;
 * - on an ephemeral loopback port, with a password minted per server and kept
 *   in process memory only ({@link OpenCode2HostServerState});
 * - in the worktree, ready once `/api/info` answers as 2.x
 *   ({@link waitForOpenCode2Ready}; `/global/health` is a 1.x route);
 * - reused while its process lives in the same worktree;
 * - owned under `opencode2:<environmentId>`, so it is stopped with the 1.x
 *   server (`stopLocalServerUnlocked` for `opencode`), by backend shutdown,
 *   and its group is reaped if it dies on its own. Only this child is ever
 *   signalled, through the handle recorded at spawn.
 *
 * A container environment is refused here: its 2.x server runs inside the
 * container (`opencode2-container-server.ts`, which routes between the two).
 *
 * A coordinator runtime gets its own 2.x server in the project checkout,
 * launched with the coordinator's process authority
 * (`opencode2/coordinator.ts`): the read-only policy, the data directory to
 * protect, the research setting, project configuration off, and a
 * configuration directory holding the coordinator guard plugin. A changed
 * research setting replaces it once it is idle.
 *
 * The Orkestrator agent-tools MCP server is not attached yet (phase 5): the
 * 1.x server gets it through its `/mcp` API after start, which 2.x serves
 * only under `/api/experimental`. The backend's own MCP credential is
 * removed from this server's environment rather than inherited.
 */
import { BRIDGE_LOG_RELAY_ENV } from "@orkestrator/protocol/node/logger-environment";
import {
  COORDINATOR_RESEARCH_MCP_ENV,
  COORDINATOR_WEB_RESEARCH_ENV,
} from "@orkestrator/protocol/coordinator-web-research";
import {
  COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV,
  COORDINATOR_CODEX_USER_SKILLS_DIR_ENV,
  COORDINATOR_COMMAND_SANDBOX_ENV,
  COORDINATOR_PROTECTED_DATA_DIR_ENV,
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { bugReportIdFromRuntimeId } from "@orkestrator/protocol/bug-report";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { mintBridgeToken } from "@orkestrator/protocol/node/bridge-credential";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import { ORKESTRATOR_AGENT_MCP_TOKEN_ENV, ORKESTRATOR_AGENT_MCP_URL_ENV } from "./agent-tools.js";
import { dropInheritedVendorDebug } from "./bridge-vendor-debug-env.js";
import { resolveOpenCode2Binary } from "./commands-agent-support.js";
import type { CommandContext } from "./commands-context.js";
import {
  ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT_ENV,
  ORKESTRATOR_BRIDGE_EXECUTION_POLICY_ENV,
  allocateLocalPort,
  assertLocalServerStartAllowed,
  forwardBridgeOutput,
  localRuntimeEnvironment,
} from "./commands-servers.js";
import { mkdir } from "node:fs/promises";
import { loadCoordinatorResearch } from "./coordinator-research-context.js";
import {
  openCode2CoordinatorLaunchEnv,
  openCode2CoordinatorPolicy,
  openCode2CoordinatorSignature,
  writeOpenCode2CoordinatorConfig,
} from "./opencode2/coordinator.js";
import { pushedLoginHostFile } from "./agent-accounts-containers.js";
import { reconcileOpenCode2Credentials } from "./opencode2/credentials.js";
import { OpenCode2Client } from "./opencode2/client.js";
import {
  openCode2ServerKey,
  type OpenCode2HostServerRecord,
} from "./opencode2/host-server-state.js";
import type { OpenCode2RouteConnection } from "./opencode2/routing-provider.js";
import {
  openCode2HostLaunch,
  waitForOpenCode2Ready,
  writeOpenCode2HostConfig,
} from "./opencode2/server.js";

const log = createLogger("native-agent.opencode2");

/** The first start imports the user's credentials and migrates an empty database. */
export const OPENCODE2_HOST_READY_TIMEOUT_MS = 60_000;

/** Backend variables the 2.x server (and every shell it runs) must not inherit. */
const WITHHELD_ENV = [
  BRIDGE_LOG_RELAY_ENV,
  ORKESTRATOR_AGENT_MCP_URL_ENV,
  ORKESTRATOR_AGENT_MCP_TOKEN_ENV,
  ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT_ENV,
  ORKESTRATOR_BRIDGE_EXECUTION_POLICY_ENV,
  COORDINATOR_WEB_RESEARCH_ENV,
  COORDINATOR_RESEARCH_MCP_ENV,
  COORDINATOR_COMMAND_SANDBOX_ENV,
  COORDINATOR_PROTECTED_DATA_DIR_ENV,
  COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV,
  COORDINATOR_CODEX_USER_SKILLS_DIR_ENV,
] as const;

function routeConnection(
  context: CommandContext,
  environmentId: string,
  record: OpenCode2HostServerRecord,
): OpenCode2RouteConnection {
  const coordinator = record.coordinator;
  const tools = context.runtime.localServers.openCodeAgentTools;
  return {
    baseUrl: `http://127.0.0.1:${record.port}`,
    password: record.password,
    directory: record.directory,
    generation: `${record.child.pid ?? "?"}:${record.port}`,
    ...(coordinator
      ? {
          coordinator: {
            ...coordinator,
            // The credential the conversation's 1.x server was launched with:
            // that launch issues it and revokes it, so this follows its rotation.
            controlConnection: () => tools.launchConnection(`local:${environmentId}`),
          },
        }
      : {}),
  };
}

/** The research setting a coordinator's server is launched with now. */
async function coordinatorResearch(context: CommandContext) {
  const research = await loadCoordinatorResearch(context.storage);
  return { mode: research.mode, servers: research.servers };
}

/** The running 2.x server's connection, never starting one. */
export function peekOpenCode2HostServer(
  context: CommandContext,
  environmentId: string,
): OpenCode2RouteConnection | undefined {
  const localServers = context.runtime.localServers;
  const record = localServers.openCode2.get(environmentId);
  if (!record || localServers.process(openCode2ServerKey(environmentId)) !== record.child) {
    return undefined;
  }
  return routeConnection(context, environmentId, record);
}

/**
 * Whether a running server still serves what a start now would launch. A
 * coordinator's server launched with another research setting is replaced,
 * but only once it is idle: replacing it would end a running turn.
 */
async function runningServes(
  context: CommandContext,
  environmentId: string,
  running: OpenCode2RouteConnection | undefined,
  worktreePath: string,
): Promise<boolean> {
  if (!running || running.directory !== worktreePath) return false;
  if (!coordinatorIdFromRuntimeId(environmentId)) return true;
  if (!running.coordinator) return false;
  const signature = openCode2CoordinatorSignature(await coordinatorResearch(context));
  if (running.coordinator.signature === signature) return true;
  return (await context.nativeAgents?.hasObservedLiveWork(environmentId, "opencode")) === true;
}

/** The environment's 2.x server, started when none is running. */
export async function ensureOpenCode2HostServer(
  context: CommandContext,
  environmentId: string,
): Promise<OpenCode2RouteConnection> {
  assertLocalServerStartAllowed(context, environmentId);
  const worktreePath = await localWorktree(context, environmentId);
  const running = peekOpenCode2HostServer(context, environmentId);
  if (running && (await runningServes(context, environmentId, running, worktreePath))) {
    return running;
  }
  return context.runtime.localServers.enqueueEnvironmentOperation(environmentId, async () => {
    if (context.runtime.localServers.isShuttingDown()) {
      throw new ProviderUnavailableError("Backend is shutting down; OpenCode 2 cannot start");
    }
    const current = peekOpenCode2HostServer(context, environmentId);
    if (current && (await runningServes(context, environmentId, current, worktreePath))) {
      return current;
    }
    return startOpenCode2HostServerUnlocked(context, environmentId);
  });
}

async function localWorktree(context: CommandContext, environmentId: string): Promise<string> {
  if (bugReportIdFromRuntimeId(environmentId)) {
    throw new ProviderUnavailableError("OpenCode 2 does not run bug reports");
  }
  if (coordinatorIdFromRuntimeId(environmentId)) {
    // The project checkout, resolved as the coordinator's 1.x server resolves it.
    const runtime = await localRuntimeEnvironment(environmentId, context);
    if (!runtime?.worktreePath) {
      throw new ProviderUnavailableError("The coordinator's project checkout is not available");
    }
    return runtime.worktreePath;
  }
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new ProviderUnavailableError("The environment no longer exists");
  if (environment.environmentType !== "local") {
    throw new ProviderUnavailableError(
      "A container environment's OpenCode 2 server runs in its container, not on the host",
    );
  }
  if (!environment.worktreePath) {
    throw new ProviderUnavailableError("Local environment worktree is not available");
  }
  return environment.worktreePath;
}

async function startOpenCode2HostServerUnlocked(
  context: CommandContext,
  environmentId: string,
): Promise<OpenCode2RouteConnection> {
  context.runtime.environments.fence.assertNotMoving(environmentId);
  const localServers = context.runtime.localServers;
  const key = openCode2ServerKey(environmentId);
  const directory = await localWorktree(context, environmentId);
  const stale = localServers.process(key);
  if (stale) {
    // Exited, serving an old worktree path, or (a coordinator's) an old research setting.
    await localServers.terminate(
      key,
      stale,
      coordinatorIdFromRuntimeId(environmentId)
        ? "replacing OpenCode 2 server: worktree or research setting changed"
        : "replacing OpenCode 2 server: worktree changed",
    );
    localServers.openCode2.forget(environmentId, stale);
  }

  const cliPath = resolveOpenCode2Binary(context);
  const dataDir = context.storage.getDataDir();
  const port = await allocateLocalPort();
  const password = mintBridgeToken();
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // The 2.x server is spawned detached; this lets nothing mistake it for orphaned.
    ORKESTRATOR_PARENT_PID: String(process.pid),
  };
  for (const name of WITHHELD_ENV) delete baseEnv[name];
  dropInheritedVendorDebug(baseEnv);
  // Both mirror the user's global OpenCode configuration as this environment locates it.
  const coordinator = await coordinatorLaunch(context, environmentId, dataDir, baseEnv);
  const configDir = coordinator?.configDir ?? (await writeOpenCode2HostConfig(dataDir, baseEnv));
  // Only a coordinator's launch names these; never one inherited from the backend.
  Object.assign(baseEnv, coordinator?.env ?? {});
  const launch = openCode2HostLaunch({ cliPath, dataDir, configDir, port, password, baseEnv });

  // Shutdown or deletion may have begun while this start awaited the disk.
  assertLocalServerStartAllowed(context, environmentId);
  const release = await localServers.openCode2.startGate.acquire();
  let child;
  try {
    assertLocalServerStartAllowed(context, environmentId);
    child = localServers.spawn(launch.command, launch.args, {
      cwd: directory,
      env: launch.env,
      // Its own group, so stopping it reaches the shells its tools started.
      detached: process.platform !== "win32",
    });
  } catch (error) {
    release();
    throw error;
  }
  localServers.adoptProcess(key, child, { workingDirectory: directory });
  const record: OpenCode2HostServerRecord = {
    child,
    port,
    password,
    directory,
    ...(coordinator ? { coordinator: coordinator.authority } : {}),
  };
  localServers.reportBridgeStart(key, child);
  forwardBridgeOutput(child, key);
  child.once("exit", (code, signal) => {
    localServers.reportBridgeExit(key, child, code, signal);
    void localServers.reapAfterUnrequestedExit(key, child);
    localServers.openCode2.forget(environmentId, child);
    localServers.releaseOwnership(key, child);
  });

  try {
    const client = new OpenCode2Client({
      baseUrl: `http://127.0.0.1:${port}`,
      password,
      directory,
    });
    await waitForOpenCode2Ready(client, {
      timeoutMs: OPENCODE2_HOST_READY_TIMEOUT_MS,
      isAlive: () =>
        localServers.process(key) === child && child.exitCode === null && child.signalCode === null,
    });
    const authFile = pushedLoginHostFile(context, "opencode");
    if (authFile) await reconcileOpenCode2Credentials(client, authFile);
  } catch (error) {
    release();
    await localServers
      .terminate(key, child, "OpenCode 2 server did not become ready")
      .catch((terminateError: unknown) => {
        log.warn("host-server.terminate-failed", {
          environmentId,
          error: formatLogError(terminateError, { message: false }),
        });
      });
    throw error;
  }
  release();
  localServers.openCode2.record(environmentId, record);
  log.info("host-server.ready", {
    environmentId,
    pid: child.pid ?? null,
    coordinator: coordinator !== undefined,
  });
  return routeConnection(context, environmentId, record);
}

/**
 * A coordinator runtime's launch: its configuration directory (credential
 * plugin and coordinator guard), process-authority variables and the
 * authority the backend keeps beside the process. Undefined for any other
 * environment.
 */
async function coordinatorLaunch(
  context: CommandContext,
  environmentId: string,
  dataDir: string,
  env: NodeJS.ProcessEnv,
): Promise<
  | {
      configDir: string;
      env: Record<string, string>;
      authority: NonNullable<OpenCode2HostServerRecord["coordinator"]>;
    }
  | undefined
> {
  const coordinatorId = coordinatorIdFromRuntimeId(environmentId);
  if (!coordinatorId) return undefined;
  const conversationId = coordinatorConversationIdFromRuntimeId(environmentId);
  if (!conversationId) throw new ProviderUnavailableError("The coordinator runtime is malformed");
  const research = await coordinatorResearch(context);
  // Created here, as for the 1.x server: a root that does not exist yet
  // cannot be resolved, and would read as not allowed.
  const attachmentRoot = context.storage.coordinators.coordinatorAttachmentDirectory(
    coordinatorId,
    conversationId,
  );
  await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
  return {
    configDir: await writeOpenCode2CoordinatorConfig(dataDir, env),
    env: openCode2CoordinatorLaunchEnv({ dataDir, attachmentRoot, research }),
    authority: {
      policy: openCode2CoordinatorPolicy(research.mode),
      research,
      signature: openCode2CoordinatorSignature(research),
    },
  };
}
