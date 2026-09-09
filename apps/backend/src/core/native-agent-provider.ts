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
      const toolResult = await dependencies.workflowResults!.structured<T>(requestId);
      if (toolResult || (await dependencies.workflowResults!.registered(requestId))) {
        return toolResult;
      }
      return providerStructured<T>(sessionId, requestId);
    };
  }
  return provider;
}
