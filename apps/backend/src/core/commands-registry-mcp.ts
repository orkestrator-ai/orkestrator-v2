import { randomBytes } from "node:crypto";

import {
  AGENT_PLATFORMS,
  isAgentPlatform,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import {
  McpManagementFailure,
  mcpFailure,
  mcpManagementErrorFromUnknown,
  normalizeMcpManagementRolloutSettings,
  type McpManagementRolloutSettings,
} from "@orkestrator/protocol/mcp-management";

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

const PID_FIELD: Record<AgentPlatform, keyof Environment> = {
  claude: "claudeBridgePid",
  codex: "codexBridgePid",
  cursor: "cursorBridgePid",
  grok: "grokBridgePid",
  opencode: "opencodePid",
  pi: "piBridgePid",
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
          bridgePid: (provider) => {
            const pid = environment[PID_FIELD[provider]];
            return environment.environmentType === "local" &&
              typeof pid === "number" &&
              Number.isSafeInteger(pid) &&
              pid > 0
              ? pid
              : undefined;
          },
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
    async reloadCodex(environmentId) {
      const service = context.nativeAgents;
      // No native agent service means no bridge is running in this backend.
      if (!service) return "not-running";
      // Environment-level and no-spawn: never resolves a session (which a
      // restarted bridge may not have) and never cold-starts app-server.
      return service.reloadMcpConfigurationIfRunning(environmentId, "codex");
    },
    async mcpConfigEvidence(environmentId, agent, logicalSessionKey) {
      const service = context.nativeAgents;
      if (!service) return { state: "not-running" };
      // Observation only: resolves an already-running bridge and reads the
      // no-touch runtime-health route, so it never starts a bridge, refreshes
      // a session's liveness or re-attaches an idle one.
      const read = await service.mcpConfigEvidenceIfRunning(
        environmentId,
        agent as never,
        logicalSessionKey,
      );
      return read.state === "evidence"
        ? {
            state: "evidence",
            evidence: {
              sources: read.evidence.sources,
              observedAt: read.evidence.observedAt,
              scope: read.evidence.scope,
            },
          }
        : read;
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
      loadRollout: mcpRolloutLoader(context),
    });
    services.set(context.storage, service);
  }
  return service;
}

/** Reads the stored rollout gate from the global config. */
export function mcpRolloutLoader(context: Pick<CommandContext, "storage">): () => Promise<unknown> {
  return async () => (await context.storage.loadConfig()).global.mcpManagement;
}

function newCorrelationId(): string {
  return `mcpe-${randomBytes(9).toString("base64url")}`;
}

/**
 * Give every structured failure a correlation id and log it with the code
 * only — never a value, path or provider text — so an operator can match the
 * reference a user reports to exactly one log line.
 */
export async function withMcpCorrelation<T>(command: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const known = mcpManagementErrorFromUnknown(error);
    const detail = known ?? mcpFailure("internal").detail;
    const correlationId = detail.correlationId ?? newCorrelationId();
    console.warn(
      `[mcp-management] ${command} failed: code=${detail.code} ref=${correlationId}${
        known ? "" : ` cause=${error instanceof Error ? error.name : typeof error}`
      }`,
    );
    throw new McpManagementFailure({ ...detail, correlationId });
  }
}

function parseProviders(value: unknown, field: string): AgentPlatform[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => !isAgentPlatform(entry)))
    throw mcpFailure("invalid-request", { message: `${field} must list known providers.` });
  return AGENT_PLATFORMS.filter((provider) => value.includes(provider));
}

/**
 * MCP configuration management. Administrative UI commands only: they are not
 * exposed as Control MCP tools, and none of them accepts a filesystem path.
 */
export function registerMcpManagementCommands(register: CommandRegistrar): void {
  const route = (
    name: string,
    run: (args: Record<string, unknown>, context: CommandContext) => Promise<unknown>,
  ) => register(name, (args, context) => withMcpCorrelation(name, () => run(args, context)));
  route("list_mcp_management_targets", (args, context) => mcpManagement(context).listTargets(args));
  route("get_mcp_management_snapshot", (args, context) => mcpManagement(context).snapshot(args));
  route("get_mcp_definition", (args, context) => mcpManagement(context).getDefinition(args));
  route("validate_mcp_mutation", (args, context) => mcpManagement(context).validate(args));
  route("mutate_mcp_definition", (args, context) => mcpManagement(context).mutate(args));
  route("apply_mcp_configuration", (args, context) => mcpManagement(context).apply(args));
  route("get_mcp_operation", (args, context) => mcpManagement(context).getOperation(args));
  route("cancel_mcp_apply", (args, context) => mcpManagement(context).cancelApply(args));

  // Backend-owned rollout gate / kill switch (`global.mcpManagement`). An
  // operator surface, not a user preference; see McpManagementRolloutSettings.
  route("get_mcp_management_rollout", async (_args, context) =>
    normalizeMcpManagementRolloutSettings(
      (await context.storage.loadConfig()).global.mcpManagement,
    ),
  );
  route("set_mcp_management_rollout", async (args, context) => {
    if (args.enabled !== undefined && typeof args.enabled !== "boolean")
      throw mcpFailure("invalid-request", { message: "enabled must be a boolean." });
    const writeProviders = parseProviders(args.writeProviders, "writeProviders");
    const applyProviders = parseProviders(args.applyProviders, "applyProviders");
    const current = await context.storage.loadConfig();
    const existing = normalizeMcpManagementRolloutSettings(current.global.mcpManagement);
    const next: McpManagementRolloutSettings = {
      enabled: (args.enabled as boolean | undefined) ?? existing.enabled,
      writeProviders: writeProviders ?? existing.writeProviders,
      applyProviders: applyProviders ?? existing.applyProviders,
    };
    await context.storage.updateMcpManagementRollout(next);
    return mcpManagement(context).refreshRollout();
  });
}
