/**
 * The host OpenCode server of one local environment or coordinator runtime,
 * as the OpenCode provider reaches it.
 *
 * The server is the environment's `opencode` local server: the supervisor
 * (`startLocalServer` in `commands-servers.ts`) owns the process under
 * `opencode:<environmentId>`, so it is stopped with the environment, by
 * backend shutdown and on a worktree move, reaped if a previous backend left
 * it orphaned, and replaced when a coordinator's research setting changes
 * once it is idle (until then a busy coordinator keeps its current server). Its launch is `opencode2/host-launch.ts`:
 *
 * - the managed `opencode2` binary, with its own `OPENCODE_DB` and config
 *   directory under Orkestrator's data directory (never the user's
 *   `~/.local/share/opencode/opencode.db`), the credential plugin that keeps
 *   its password from the agent's tools, autoupdate and file watchers off and
 *   explicit flags (`opencode2/server.ts`);
 * - on an ephemeral loopback port, with a password minted per server and kept
 *   in process memory only ({@link OpenCode2HostServerState});
 * - in the worktree, ready once `/api/info` answers.
 *
 * A container environment is refused here: its server runs inside the
 * container (`opencode2-container-server.ts`, which picks between the two).
 *
 * A coordinator runtime's server runs in the project checkout with the
 * coordinator's process authority (`opencode2/coordinator.ts`): the read-only
 * policy, the data directory to protect, the research setting, project
 * configuration off, and a configuration directory holding the coordinator
 * guard plugin. Its Control MCP credential is the one the supervisor issued
 * for the launch, held beside the process and attached per session.
 */
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import { loadCoordinatorResearch } from "./coordinator-research-context.js";
import {
  openCode2CoordinatorSignature,
  writeOpenCode2CoordinatorConfig,
} from "./opencode2/coordinator.js";
import { writeOpenCode2HostConfig } from "./opencode2/server.js";
import type { CommandContext } from "./commands-context.js";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import { assertLocalServerStartAllowed, startLocalServer } from "./commands-servers.js";
import {
  openCode2ServerKey,
  type OpenCode2HostServerRecord,
} from "./opencode2/host-server-state.js";
import type { OpenCode2ServerConnection } from "./opencode2/environment-provider.js";

/** The first start imports the user's credentials and migrates an empty database. */
export const OPENCODE2_HOST_READY_TIMEOUT_MS = 60_000;

function serverConnection(
  context: CommandContext,
  record: OpenCode2HostServerRecord,
): OpenCode2ServerConnection {
  const coordinator = record.coordinator;
  const dataDir = context.storage.getDataDir();
  return {
    baseUrl: `http://127.0.0.1:${record.port}`,
    password: record.password,
    directory: record.directory,
    generation: `${record.child.pid ?? "?"}:${record.port}`,
    // The launch wrote these from the backend's environment; so does a reload.
    refreshConfiguration: async () => {
      if (coordinator) await writeOpenCode2CoordinatorConfig(dataDir, process.env);
      else await writeOpenCode2HostConfig(dataDir, process.env);
    },
    ...(coordinator
      ? {
          coordinator: {
            policy: coordinator.policy,
            research: coordinator.research,
            signature: coordinator.signature,
            controlConnection: () => coordinator.control,
          },
        }
      : {}),
  };
}

/** The running server's connection, never starting one. */
export function peekOpenCode2HostServer(
  context: CommandContext,
  environmentId: string,
): OpenCode2ServerConnection | undefined {
  const localServers = context.runtime.localServers;
  const record = localServers.openCode2.get(environmentId);
  if (!record || localServers.process(openCode2ServerKey(environmentId)) !== record.child) {
    return undefined;
  }
  return serverConnection(context, record);
}

/**
 * Whether the running server still serves what a start now would launch, so
 * a provider call can use it without the supervisor's health probes: the
 * same worktree and, for a coordinator, the same research setting. Anything
 * else goes through the supervisor, which replaces what no longer matches.
 *
 * A coordinator launched under another research setting is kept while it has
 * observed live work: launch authority cannot change on a running agent, and
 * the supervisor refuses to replace it until it is idle. Reads of the current
 * run (snapshots, status, interactive state) and the turn's own follow-up
 * calls stay on the server it started on; the first call after it settles
 * goes through the supervisor, which replaces it under the new setting.
 */
async function runningServes(
  context: CommandContext,
  environmentId: string,
  running: OpenCode2ServerConnection,
  worktreePath: string | undefined,
): Promise<boolean> {
  if (coordinatorIdFromRuntimeId(environmentId)) {
    if (!running.coordinator) return false;
    const research = await loadCoordinatorResearch(context.storage);
    const signature = openCode2CoordinatorSignature({
      mode: research.mode,
      servers: research.servers,
    });
    if (running.coordinator.signature === signature) return true;
    return (await context.nativeAgents?.hasObservedLiveWork(environmentId, "opencode")) === true;
  }
  return worktreePath !== undefined && running.directory === worktreePath;
}

/** The environment's server, started (or replaced) by the supervisor when needed. */
export async function ensureOpenCode2HostServer(
  context: CommandContext,
  environmentId: string,
): Promise<OpenCode2ServerConnection> {
  assertLocalServerStartAllowed(context, environmentId);
  let worktreePath: string | undefined;
  if (!coordinatorIdFromRuntimeId(environmentId)) {
    const environment = await context.storage.getEnvironment(environmentId);
    if (environment && environment.environmentType !== "local") {
      throw new ProviderUnavailableError(
        "A container environment's OpenCode server runs in its container, not on the host",
      );
    }
    worktreePath = environment?.worktreePath ?? undefined;
  }
  const running = peekOpenCode2HostServer(context, environmentId);
  if (running && (await runningServes(context, environmentId, running, worktreePath))) {
    return running;
  }
  await startLocalServer(environmentId, context, "opencode");
  const connection = peekOpenCode2HostServer(context, environmentId);
  if (!connection) throw new ProviderUnavailableError("The OpenCode server is not running");
  return connection;
}
