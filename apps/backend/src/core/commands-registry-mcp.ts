import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";

import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { runCommandBuffer } from "./commands-dependencies.js";
import type { ApplyEnvironment, ApplySession, RuntimeProbe } from "./mcp-management/apply.js";
import type { ContainerFileReader } from "./mcp-management/types.js";
import { McpManagementService } from "./mcp-management/service.js";
import type { Environment } from "./models.js";

const PORT_FIELD: Record<AgentPlatform, keyof Environment> = {
  claude: "localClaudePort",
  codex: "localCodexPort",
  cursor: "localCursorPort",
  grok: "localGrokPort",
  opencode: "localOpencodePort",
  pi: "localPiPort",
};

/**
 * Runtime facts the apply scheduler needs, read from existing backend state.
 * Reads are no-touch: persisted records and the activity sweep's last
 * observation, never a tab-facing bridge route.
 */
export function createMcpRuntimeProbe(context: CommandContext): RuntimeProbe {
  return {
    async environments(): Promise<ApplyEnvironment[]> {
      const environments = await context.storage.loadEnvironments();
      return environments
        .filter((environment) => !environment.deletionRequestedAt)
        .map((environment) => ({
          id: environment.id,
          name: environment.name,
          status: environment.status,
          environmentType: environment.environmentType,
          providerRunning: (provider) =>
            environment.environmentType === "containerized"
              ? environment.status === "running"
              : typeof environment[PORT_FIELD[provider]] === "number",
        }));
    },
    async sessions(): Promise<ApplySession[]> {
      const sessions = await context.storage.listNativeAgentSessions();
      return sessions
        .filter((session) => isAgentPlatform(session.agent))
        .map((session) => ({
          environmentId: session.environmentId,
          agent: session.agent as AgentPlatform,
          logicalSessionKey: session.logicalSessionKey,
          pendingDispatch: !!session.pendingDispatch,
          coordinator: session.executionPolicy === "coordinator-read-only",
          projectResources: session.policy?.projectResources,
        }));
    },
    activity(environmentId, agent, logicalSessionKey) {
      const service = context.nativeAgents;
      if (!service) return "unknown";
      return service.sessionTurnActivitySnapshot(environmentId, agent as never, logicalSessionKey);
    },
    async reloadCodex(environmentId, logicalSessionKey) {
      const service = context.nativeAgents;
      if (!service) throw new Error("Native agents are unavailable.");
      // Codex's reconnect is `config/mcpServer/reload`, which is process-wide
      // and ignores the server name; `orkestrator` is always present.
      await service.performProjectionMcpAction({
        environmentId,
        agent: "codex",
        logicalSessionKey,
        serverId: "orkestrator",
        action: "reconnect",
      });
    },
  };
}

/**
 * Bounded, read-only file read inside a container as the `node` user. The path
 * is an argument to a fixed script, never interpolated into shell text, and
 * exit code 3 distinguishes a missing file from an unreachable container.
 */
export const readContainerMcpFile: ContainerFileReader = async (
  containerId,
  filePath,
  maxBytes,
) => {
  try {
    const { stdout } = await runCommandBuffer(
      "docker",
      [
        "exec",
        "--user",
        "node",
        containerId,
        "sh",
        "-c",
        'test -f "$1" || exit 3; head -c "$2" "$1"',
        "sh",
        filePath,
        String(maxBytes + 1),
      ],
      { timeoutMs: 10_000 },
    );
    return stdout.byteLength > maxBytes
      ? { state: "oversized" }
      : { state: "ok", bytes: new Uint8Array(stdout) };
  } catch (error) {
    const exitCode = (error as { exitCode?: unknown }).exitCode;
    return exitCode === 3 ? { state: "absent" } : { state: "offline" };
  }
};

const services = new WeakMap<object, McpManagementService>();

/** The context's service, or one created for this storage (tests, alternate hosts). */
export function mcpManagement(context: CommandContext): McpManagementService {
  if (context.mcpManagement) return context.mcpManagement;
  let service = services.get(context.storage);
  if (!service) {
    service = new McpManagementService({
      dataDir: context.storage.getDataDir(),
      storage: context.storage,
      emit: (event, payload) => context.emit(event, payload),
      probe: createMcpRuntimeProbe(context),
      readContainerFile: readContainerMcpFile,
    });
    services.set(context.storage, service);
  }
  return service;
}

/**
 * MCP configuration management. Administrative UI commands only: they are not
 * exposed as Control MCP tools, and none of them accepts a filesystem path.
 */
export function registerMcpManagementCommands(register: CommandRegistrar): void {
  register("list_mcp_management_targets", (args, context) =>
    mcpManagement(context).listTargets(args),
  );
  register("get_mcp_management_snapshot", (args, context) => mcpManagement(context).snapshot(args));
  register("get_mcp_definition", (args, context) => mcpManagement(context).getDefinition(args));
  register("validate_mcp_mutation", (args, context) => mcpManagement(context).validate(args));
  register("mutate_mcp_definition", (args, context) => mcpManagement(context).mutate(args));
  register("apply_mcp_configuration", (args, context) => mcpManagement(context).apply(args));
  register("get_mcp_operation", (args, context) => mcpManagement(context).getOperation(args));
  register("cancel_mcp_apply", (args, context) => mcpManagement(context).cancelApply(args));
}
