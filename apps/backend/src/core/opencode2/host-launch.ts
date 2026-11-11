/**
 * The host OpenCode server's launch, for the local-server supervisor
 * (`startLocalServerAttempt` in `commands-servers.ts`, kind `opencode`).
 *
 * The supervisor owns the process (spawn, ownership, health, the recorded
 * port and pid, the coordinator's Control MCP credential and its revocation
 * on exit). This module adds what is OpenCode's own:
 *
 * - **The launch** ({@link prepareOpenCodeHostLaunch}): the managed binary,
 *   its own `OPENCODE_DB` and configuration directory under Orkestrator's
 *   data directory (never the user's `~/.local/share/opencode/opencode.db`),
 *   the credential plugin that keeps the password from the agent's tools,
 *   autoupdate and file watchers off and explicit feature flags
 *   (`server.ts`). Backend variables the server and every shell it runs must
 *   not inherit are removed: the Orkestrator MCP credential is attached per
 *   session instead (`mcp.ts`).
 * - **A coordinator runtime's authority**: the read-only policy, the data
 *   directory to protect, the research setting, project configuration off,
 *   and a configuration directory holding the coordinator guard plugin
 *   (`coordinator.ts`).
 * - **The record** ({@link recordOpenCodeHostServer}): password, directory
 *   and coordinator authority beside the process, in memory only
 *   (`host-server-state.ts`). The host database is where sign-ins live
 *   (`credentials.ts`); a start hands containers any OAuth login it has
 *   refreshed.
 */
import { mkdir } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
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
import { ProviderUnavailableError } from "../agent-provider-contract.js";
import { ORKESTRATOR_AGENT_MCP_TOKEN_ENV, ORKESTRATOR_AGENT_MCP_URL_ENV } from "../agent-tools.js";
import { pushedLoginHostFile } from "../agent-accounts-containers.js";
import { resolveOpenCode2Binary } from "../commands-agent-support.js";
import type { CommandContext } from "../commands-context.js";
import { loadCoordinatorResearch } from "../coordinator-research-context.js";
import { OpenCode2Client } from "./client.js";
import {
  openCode2CoordinatorLaunchEnv,
  openCode2CoordinatorPolicy,
  openCode2CoordinatorSignature,
  writeOpenCode2CoordinatorConfig,
} from "./coordinator.js";
import { exportOpenCode2Refreshes } from "./credentials.js";
import type { OpenCode2HostServerRecord } from "./host-server-state.js";
import type { OpenCode2McpConnection } from "./mcp.js";
import {
  openCode2HostLaunch,
  writeOpenCode2HostConfig,
  type OpenCode2HostLaunch,
} from "./server.js";

/** Process-authority names the supervisor sets for bridges; OpenCode takes its own. */
const BRIDGE_AUTHORITY_ENV = [
  "ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT",
  "ORKESTRATOR_BRIDGE_EXECUTION_POLICY",
] as const;

/** Backend variables the server (and every shell it runs) must not inherit. */
const WITHHELD_ENV = [
  BRIDGE_LOG_RELAY_ENV,
  ORKESTRATOR_AGENT_MCP_URL_ENV,
  ORKESTRATOR_AGENT_MCP_TOKEN_ENV,
  ...BRIDGE_AUTHORITY_ENV,
  COORDINATOR_WEB_RESEARCH_ENV,
  COORDINATOR_RESEARCH_MCP_ENV,
  COORDINATOR_COMMAND_SANDBOX_ENV,
  COORDINATOR_PROTECTED_DATA_DIR_ENV,
  COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV,
  COORDINATOR_CODEX_USER_SKILLS_DIR_ENV,
] as const;

export type OpenCodeHostCoordinator = NonNullable<OpenCode2HostServerRecord["coordinator"]>;

export interface PreparedOpenCodeHostLaunch extends OpenCode2HostLaunch {
  /** A coordinator runtime's authority, without its control credential yet. */
  coordinator?: Omit<OpenCodeHostCoordinator, "control">;
}

/** The research setting a coordinator's server is launched with now. */
async function coordinatorResearch(context: CommandContext) {
  const research = await loadCoordinatorResearch(context.storage);
  return { mode: research.mode, servers: research.servers };
}

/**
 * The command, arguments and environment of a host OpenCode server on
 * `port`. `supervisorEnv` is the supervisor's common child environment;
 * it is not modified.
 */
export async function prepareOpenCodeHostLaunch(input: {
  context: CommandContext;
  environmentId: string;
  port: number;
  password: string;
  supervisorEnv: NodeJS.ProcessEnv;
}): Promise<PreparedOpenCodeHostLaunch> {
  const { context, environmentId } = input;
  const dataDir = context.storage.getDataDir();
  const baseEnv: NodeJS.ProcessEnv = { ...input.supervisorEnv };
  for (const name of WITHHELD_ENV) delete baseEnv[name];
  const coordinator = await coordinatorLaunch(context, environmentId, dataDir, baseEnv);
  // Both mirror the user's global OpenCode configuration as this environment locates it.
  const configDir = coordinator?.configDir ?? (await writeOpenCode2HostConfig(dataDir, baseEnv));
  // Only a coordinator's launch names these; never one inherited from the backend.
  Object.assign(baseEnv, coordinator?.env ?? {});
  const launch = openCode2HostLaunch({
    cliPath: resolveOpenCode2Binary(context),
    dataDir,
    configDir,
    port: input.port,
    password: input.password,
    baseEnv,
  });
  return { ...launch, ...(coordinator ? { coordinator: coordinator.authority } : {}) };
}

/**
 * Record a healthy host server, after any OAuth login its database refreshed
 * is exported to the copy containers are handed.
 */
export async function recordOpenCodeHostServer(
  context: CommandContext,
  environmentId: string,
  server: {
    child: ChildProcessWithoutNullStreams;
    port: number;
    password: string;
    directory: string;
    coordinator?: Omit<OpenCodeHostCoordinator, "control">;
    control?: OpenCode2McpConnection;
  },
): Promise<void> {
  const client = new OpenCode2Client({
    baseUrl: `http://127.0.0.1:${server.port}`,
    password: server.password,
    directory: server.directory,
  });
  const authFile = pushedLoginHostFile(context, "opencode");
  // Best-effort: the container login watcher repeats it every pass.
  if (authFile) await exportOpenCode2Refreshes(client, authFile).catch(() => undefined);
  context.runtime.localServers.openCode2.record(environmentId, {
    child: server.child,
    port: server.port,
    password: server.password,
    directory: server.directory,
    ...(server.coordinator
      ? {
          coordinator: {
            ...server.coordinator,
            ...(server.control ? { control: server.control } : {}),
          },
        }
      : {}),
  });
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
      authority: Omit<OpenCodeHostCoordinator, "control">;
    }
  | undefined
> {
  const coordinatorId = coordinatorIdFromRuntimeId(environmentId);
  if (!coordinatorId) return undefined;
  const conversationId = coordinatorConversationIdFromRuntimeId(environmentId);
  if (!conversationId) throw new ProviderUnavailableError("The coordinator runtime is malformed");
  const research = await coordinatorResearch(context);
  // Created here: a root that does not exist yet cannot be resolved, and
  // would read as not allowed.
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
