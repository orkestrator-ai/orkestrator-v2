/**
 * Build-pipeline-facing provider boundary.
 *
 * Provider transports and interactive native-agent capabilities live in
 * `native-agent-provider.ts`; pipeline code intentionally sees only this
 * smaller contract and factory.
 */
import {
  createNativeAgentProvider,
  type AgentSessionProvider,
  type BridgeConnection,
  type ProviderCreateSessionOptions,
  type ProviderDependencies,
} from "./native-agent-provider.js";
import type { PipelineSessionPhase } from "@orkestrator/protocol/build-pipeline";

export {
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  ProviderSessionFailedError,
  ProviderUnavailableError,
  readProviderStatus,
} from "./native-agent-provider.js";
export type {
  BridgeConnection,
  ProviderActivityState,
  ProviderCreateSessionOptions,
  ProviderDependencies,
  ProviderExecutionMode,
  ProviderInteractionObservationEvent,
  ProviderSendOptions,
  ProviderSessionRegistration,
  ProviderStatus,
} from "./native-agent-provider.js";

export type BuildPipelineProvider = Omit<AgentSessionProvider, "createSession"> & {
  createSession(
    phase: PipelineSessionPhase,
    label: string,
    options?: ProviderCreateSessionOptions,
  ): Promise<string>;
};

export function createBuildPipelineProvider(
  connection: BridgeConnection,
  dependencies: ProviderDependencies = {},
): BuildPipelineProvider {
  return createNativeAgentProvider(connection, dependencies);
}
