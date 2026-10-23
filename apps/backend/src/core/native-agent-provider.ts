/** Shared provider factory used by interactive native-agent sessions. */
import type { BridgeConnection, NativeAgentRuntimeProvider } from "./agent-provider-contract.js";
import { HttpBridgeProvider } from "./http-bridge-provider.js";
import type { HttpBridgeProviderDependencies } from "./http-bridge-transport.js";
import type { AppConfig } from "./models.js";
import { OpenCodeProvider, type OpenCodeProviderDependencies } from "./opencode-provider.js";
import { openCodeEnvironmentDependencies } from "./opencode-provider-environment.js";
import { resolveCodexBridgeDefaultModel } from "./session-held-model.js";
import type { WorkflowResultReader } from "./workflow-result-service.js";

export * from "./agent-provider-contract.js";

/**
 * What the shared native-agent service knows about the environment a provider
 * serves, in platform-neutral terms. `createNativeAgentProvider` derives each
 * platform's environment-scoped dependencies from it, so the service never
 * assembles them itself.
 */
export interface NativeAgentProviderEnvironment {
  environmentId: string;
  /**
   * Backend data directory. Absent for storage doubles without one, which then
   * get no on-disk provider state rather than git runs in fixture directories.
   */
  dataDir?: string;
  /**
   * Reads the persisted configuration. Called per use rather than once:
   * providers are cached for the life of a bridge connection, so a settings
   * edit would otherwise not reach them until the environment restarted.
   */
  loadConfig?: () => Promise<Pick<AppConfig, "global">>;
}

export type ProviderDependencies = HttpBridgeProviderDependencies &
  OpenCodeProviderDependencies & {
    workflowResults?: WorkflowResultReader;
    /** Platform-specific dependencies are derived from this; explicit ones win. */
    environment?: NativeAgentProviderEnvironment;
  };

export function createNativeAgentProvider(
  connection: BridgeConnection,
  dependencies: ProviderDependencies = {},
): NativeAgentRuntimeProvider {
  const provider: NativeAgentRuntimeProvider =
    connection.agent === "opencode"
      ? new OpenCodeProvider(connection, {
          ...openCodeEnvironmentDependencies(dependencies.environment),
          ...dependencies,
        })
      : new HttpBridgeProvider(
          connection,
          dependencies.fetch ?? fetch,
          dependencies.stageImages,
          dependencies.onObservationHint,
        );
  // Codex runs the model its session was created with; the other bridges carry
  // the model on each prompt and keep the configured one.
  if (connection.agent === "codex") {
    provider.resolveDefaultModel = (modelId) =>
      resolveCodexBridgeDefaultModel(connection, dependencies.fetch ?? fetch, modelId);
  }
  if (dependencies.workflowResults) {
    const providerStructured = provider.structured.bind(provider);
    provider.structured = async <T>(sessionId: string, requestId: string) => {
      try {
        const lookup = dependencies.workflowResults!.lookup
          ? await dependencies.workflowResults!.lookup<T>(requestId)
          : {
              result: await dependencies.workflowResults!.structured<T>(requestId),
              registered: await dependencies.workflowResults!.registered(requestId),
            };
        if (lookup.result || lookup.registered) return lookup.result;
      } catch (error) {
        console.warn(
          "[native-agent] Workflow result store unavailable; using provider result:",
          error,
        );
      }
      return providerStructured<T>(sessionId, requestId);
    };
  }
  return provider;
}
