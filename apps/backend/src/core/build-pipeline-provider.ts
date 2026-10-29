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
      "activeSteerRun" | "steerSupported" | "performSessionAction" | "resolveDefaultModel"
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
  return withResolvedDefaultModel(createNativeAgentProvider(connection, dependencies), connection);
}

/**
 * Start a workflow session that names no model on the runtime's effective
 * default.
 *
 * Builds resolve their model before they get here, but Multi Review passes a
 * launcher's "Default" choice straight through as no model. Left
 * alone, a runtime with `resolveDefaultModel` would fall back to its own
 * server-side choice, which for OpenCode ignores the provider allowlist. The
 * runtime retains the created session's model for model-less turns, including
 * after provider recreation. A connection with its own model already decides,
 * so it is left untouched.
 */
function withResolvedDefaultModel(
  provider: BuildPipelineProvider,
  connection: Pick<BridgeConnection, "model">,
): BuildPipelineProvider {
  const resolve = provider.resolveDefaultModel?.bind(provider);
  if (!resolve || connection.model) return provider;
  const createSession = provider.createSession.bind(provider);
  return Object.assign(provider, {
    async createSession(
      phase: PipelineSessionPhase,
      label: string,
      options: ProviderCreateSessionOptions = {},
    ): Promise<string> {
      if (options.model) return createSession(phase, label, options);
      const model = (await resolve(undefined).catch(() => undefined))?.modelId;
      return createSession(phase, label, model ? { ...options, model } : options);
    },
  });
}
