/** Shared provider factory used by interactive native-agent sessions. */
import type { BridgeConnection, NativeAgentRuntimeProvider } from "./agent-provider-contract.js";
import { HttpBridgeProvider } from "./http-bridge-provider.js";
import type { HttpBridgeProviderDependencies } from "./http-bridge-transport.js";
import { OpenCodeProvider, type OpenCodeProviderDependencies } from "./opencode-provider.js";
import type { WorkflowResultReader } from "./workflow-result-service.js";

export * from "./agent-provider-contract.js";

export type ProviderDependencies = HttpBridgeProviderDependencies &
  OpenCodeProviderDependencies & {
    workflowResults?: WorkflowResultReader;
  };

export function createNativeAgentProvider(
  connection: BridgeConnection,
  dependencies: ProviderDependencies = {},
): NativeAgentRuntimeProvider {
  const provider =
    connection.agent === "opencode"
      ? new OpenCodeProvider(connection, dependencies)
      : new HttpBridgeProvider(connection, dependencies.fetch ?? fetch, dependencies.stageImages);
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
