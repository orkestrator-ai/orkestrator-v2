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
import type { NativeAgentRuntimeProvider } from "./agent-provider-contract.js";
import type { PipelineSessionPhase } from "@orkestrator/protocol/build-pipeline";

export {
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  ProviderDispatchPreparationError,
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
  ProviderPrepareDispatchOptions,
  ProviderSendOptions,
  ProviderSessionObservation,
  ProviderSessionRegistration,
  ProviderStatus,
} from "./native-agent-provider.js";

export type BuildPipelineProvider = Omit<AgentSessionProvider, "createSession"> &
  /**
   * The live-turn steer surface of the runtime provider, and its model
   * connectivity answer. Optional so a provider without them (and narrow test
   * providers) simply cannot steer, and keeps the configured model.
   */
  Partial<
    Pick<
      NativeAgentRuntimeProvider,
      "activeSteerRun" | "steerSupported" | "performSessionAction" | "substituteUnavailableModel"
    >
  > & {
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
