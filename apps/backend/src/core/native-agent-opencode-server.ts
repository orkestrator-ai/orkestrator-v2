/**
 * The OpenCode server dependencies of one environment's providers: the
 * interactive native-agent service's (`openCodeEnvironmentDependencies`) and a
 * workflow provider's (build pipelines, Multi Review, graph agent nodes, graph
 * describe, goal verifiers and suborks: `openCodeWorkflowDependencies`).
 *
 * Both reach the same server: the host one of a local environment
 * (`opencode2-host-server.ts`) or the in-container one
 * (`opencode2-container-server.ts`).
 */
import {
  nativeAgentCapabilities,
  normalizeOpenCodeModelProviders,
} from "@orkestrator/protocol/native-agent";
import type { NativeAgentServiceOptions } from "./native-agent-service-shared.js";
import type { OpenCodeEnvironmentDependencies, OpenCode2WorkerMailbox } from "./opencode2/index.js";

type ConfigReader = {
  loadConfig?: () => Promise<{ global: { openCodeModelProviders?: unknown } }>;
};

/** The server dependencies of one environment's OpenCode provider, or undefined without a host. */
export function openCodeEnvironmentDependencies(
  host: NativeAgentServiceOptions["openCodeServer"],
  storage: ConfigReader,
  environmentId: string,
  options: { workerMailbox?: OpenCode2WorkerMailbox } = {},
): OpenCodeEnvironmentDependencies | undefined {
  if (!host) return undefined;
  return {
    connection: (start) => host(environmentId, start),
    // Read per call: a settings edit applies at once.
    allowedModelProviders: async () =>
      normalizeOpenCodeModelProviders(
        storage.loadConfig ? (await storage.loadConfig()).global.openCodeModelProviders : undefined,
      ),
    ...(options.workerMailbox ? { workerMailbox: options.workerMailbox } : {}),
  };
}

/** A workflow provider's server dependencies for one environment. */
export function openCodeWorkflowDependencies(
  host: NativeAgentServiceOptions["openCodeServer"],
  storage: ConfigReader,
  environmentId: string,
  workflow: { workerMailbox?: OpenCode2WorkerMailbox } = {},
): OpenCodeEnvironmentDependencies | undefined {
  return openCodeEnvironmentDependencies(host, storage, environmentId, workflow);
}

/**
 * Whether a session receives the per-tab Orkestrator MCP credential with
 * each dispatch: the platform's own answer, or OpenCode, whose server takes
 * the connection per session (`opencode2/mcp.ts`).
 */
export function sessionTakesAgentTools(
  agent: Parameters<typeof nativeAgentCapabilities>[0],
): boolean {
  return nativeAgentCapabilities(agent).agentTools === true || agent === "opencode";
}
