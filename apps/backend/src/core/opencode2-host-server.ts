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
 * Containers are a follow-up: a container environment is refused here, and
 * the backend never creates a 2.x session in one.
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
} from "./commands-servers.js";
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

function routeConnection(record: OpenCode2HostServerRecord): OpenCode2RouteConnection {
  return {
    baseUrl: `http://127.0.0.1:${record.port}`,
    password: record.password,
    directory: record.directory,
    generation: `${record.child.pid ?? "?"}:${record.port}`,
  };
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
  return routeConnection(record);
}

/** The environment's 2.x server, started when none is running. */
export async function ensureOpenCode2HostServer(
  context: CommandContext,
  environmentId: string,
): Promise<OpenCode2RouteConnection> {
  assertLocalServerStartAllowed(context, environmentId);
  const worktreePath = await localWorktree(context, environmentId);
  const running = peekOpenCode2HostServer(context, environmentId);
  if (running && running.directory === worktreePath) return running;
  return context.runtime.localServers.enqueueEnvironmentOperation(environmentId, async () => {
    if (context.runtime.localServers.isShuttingDown()) {
      throw new ProviderUnavailableError("Backend is shutting down; OpenCode 2 cannot start");
    }
    const current = peekOpenCode2HostServer(context, environmentId);
    if (current && current.directory === worktreePath) return current;
    return startOpenCode2HostServerUnlocked(context, environmentId);
  });
}

async function localWorktree(context: CommandContext, environmentId: string): Promise<string> {
  if (coordinatorIdFromRuntimeId(environmentId) || bugReportIdFromRuntimeId(environmentId)) {
    throw new ProviderUnavailableError("OpenCode 2 runs only in ordinary local environments");
  }
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new ProviderUnavailableError("The environment no longer exists");
  if (environment.environmentType !== "local") {
    throw new ProviderUnavailableError(
      "OpenCode 2 is not available in container environments yet; this session needs a local environment",
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
    // Exited, or serving an old worktree path.
    await localServers.terminate(key, stale, "replacing OpenCode 2 server: worktree changed");
    localServers.openCode2.forget(environmentId, stale);
  }

  const cliPath = resolveOpenCode2Binary(context);
  const dataDir = context.storage.getDataDir();
  const configDir = await writeOpenCode2HostConfig(dataDir);
  const port = await allocateLocalPort();
  const password = mintBridgeToken();
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // The 2.x server is spawned detached; this lets nothing mistake it for orphaned.
    ORKESTRATOR_PARENT_PID: String(process.pid),
  };
  for (const name of WITHHELD_ENV) delete baseEnv[name];
  dropInheritedVendorDebug(baseEnv);
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
  const record: OpenCode2HostServerRecord = { child, port, password, directory };
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
  log.info("host-server.ready", { environmentId, pid: child.pid ?? null });
  return routeConnection(record);
}
