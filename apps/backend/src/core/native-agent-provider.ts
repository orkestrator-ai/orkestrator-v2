/** Shared provider factory used by interactive native-agent sessions. */
import type {
  BridgeConnection,
  NativeAgentRuntimeProvider,
} from "./agent-provider-contract.js";
import {
  HttpBridgeProvider,
} from "./http-bridge-provider.js";
import type {
  HttpBridgeProviderDependencies,
} from "./http-bridge-transport.js";
import {
  OpenCodeProvider,
  type OpenCodeProviderDependencies,
} from "./opencode-provider.js";

export * from "./agent-provider-contract.js";

export type ProviderDependencies = HttpBridgeProviderDependencies
  & OpenCodeProviderDependencies;

export function createNativeAgentProvider(
  connection: BridgeConnection,
  dependencies: ProviderDependencies = {},
): NativeAgentRuntimeProvider {
  return connection.agent === "opencode"
    ? new OpenCodeProvider(connection, dependencies)
    : new HttpBridgeProvider(
        connection,
        dependencies.fetch ?? fetch,
        dependencies.stageImages,
      );
}
