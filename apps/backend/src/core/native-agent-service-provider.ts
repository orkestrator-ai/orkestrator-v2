import * as shared from "./native-agent-service-shared.js";
import {
  ABSENT_BRIDGE_RECHECK_MS,
  ACP_SESSION_CREATE_ATTEMPTS,
  ACP_SESSION_CREATE_RETRY_BASE_MS,
  INITIAL_PROMPT_STAGING_DIRECTORY,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  ProviderUnavailableError,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  createHash,
  createNativeAgentProvider,
  nonBlank,
  stagePromptImages,
} from "./native-agent-service-shared.js";
type BuildPipelineAgent = shared.BuildPipelineAgent;
type PipelineSessionPhase = shared.PipelineSessionPhase;
type TaskSnapshotImage = shared.TaskSnapshotImage;
type AgentActivityState = shared.AgentActivityState;
type AgentInteractionKind = shared.AgentInteractionKind;
type AgentInteractionApplyOutcome = shared.AgentInteractionApplyOutcome;
type AgentInteractionOrigin = shared.AgentInteractionOrigin;
type AgentInteractionPolicy = shared.AgentInteractionPolicy;
type AgentInteractionResolution = shared.AgentInteractionResolution;
type AgentModel = shared.AgentModel;
type NativeAgentCapabilities = shared.NativeAgentCapabilities;
type NativeAgentComposerControl = shared.NativeAgentComposerControl;
type NativeAgentComposerState = shared.NativeAgentComposerState;
type NativeAgentControlUpdate = shared.NativeAgentControlUpdate;
type NativeAgentDispatchOutcome = shared.NativeAgentDispatchOutcome;
type NativeAgentForkOutcome = shared.NativeAgentForkOutcome;
type NativeAgentMessageWindow = shared.NativeAgentMessageWindow;
type NativeAgentResumeEntry = shared.NativeAgentResumeEntry;
type NativeAgentSessionProjection = shared.NativeAgentSessionProjection;
type NativeAgentSessionAction = shared.NativeAgentSessionAction;
type NativeAgentSessionActionOutcome = shared.NativeAgentSessionActionOutcome;
type NativeAgentSlashCommand = shared.NativeAgentSlashCommand;
type NativeAgentToolDetails = shared.NativeAgentToolDetails;
type JsonSchema = shared.JsonSchema;
type Environment = shared.Environment;
type OpenCodeIncompleteTurnNotice = shared.OpenCodeIncompleteTurnNotice;
type PersistedNativeAgentSession = shared.PersistedNativeAgentSession;
type PersistedNativeAgentPendingDispatch = shared.PersistedNativeAgentPendingDispatch;
type StorageService = shared.StorageService;
type BridgeConnection = shared.BridgeConnection;
type NativeAgentRuntimeProvider = shared.NativeAgentRuntimeProvider;
type ProviderInteractiveSnapshot = shared.ProviderInteractiveSnapshot;
type ProviderInteractionObservationEvent = shared.ProviderInteractionObservationEvent;
type ProviderExecutionMode = shared.ProviderExecutionMode;
type PromptAttachment = shared.PromptAttachment;
type CommandInvoker = shared.CommandInvoker;
type EnsureNativeAgentSessionInput = shared.EnsureNativeAgentSessionInput;
type DispatchNativeAgentPromptInput = shared.DispatchNativeAgentPromptInput;
type AdoptNativeAgentSessionInput = shared.AdoptNativeAgentSessionInput;
type NativeAgentProjectionInput = shared.NativeAgentProjectionInput;
type NativeAgentProjectionCacheEntry = shared.NativeAgentProjectionCacheEntry;
type NativeAgentActivityTransition = shared.NativeAgentActivityTransition;
type NativeAgentServiceOptions = shared.NativeAgentServiceOptions;
type AgentInteractionObservation = shared.AgentInteractionObservation;
type OpenCodeRecoveryCandidate = shared.OpenCodeRecoveryCandidate;
type PromptDispatchPreparation = shared.PromptDispatchPreparation;
export type NativeAgentServiceLayerTypes = [
  BuildPipelineAgent,
  PipelineSessionPhase,
  TaskSnapshotImage,
  AgentActivityState,
  AgentInteractionKind,
  AgentInteractionApplyOutcome,
  AgentInteractionOrigin,
  AgentInteractionPolicy,
  AgentInteractionResolution,
  AgentModel,
  NativeAgentCapabilities,
  NativeAgentComposerControl,
  NativeAgentComposerState,
  NativeAgentControlUpdate,
  NativeAgentDispatchOutcome,
  NativeAgentForkOutcome,
  NativeAgentMessageWindow,
  NativeAgentResumeEntry,
  NativeAgentSessionProjection,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
  NativeAgentSlashCommand,
  NativeAgentToolDetails,
  JsonSchema,
  Environment,
  OpenCodeIncompleteTurnNotice,
  PersistedNativeAgentSession,
  PersistedNativeAgentPendingDispatch,
  StorageService,
  BridgeConnection,
  NativeAgentRuntimeProvider,
  ProviderInteractiveSnapshot,
  ProviderInteractionObservationEvent,
  ProviderExecutionMode,
  PromptAttachment,
  CommandInvoker,
  EnsureNativeAgentSessionInput,
  DispatchNativeAgentPromptInput,
  AdoptNativeAgentSessionInput,
  NativeAgentProjectionInput,
  NativeAgentProjectionCacheEntry,
  NativeAgentActivityTransition,
  NativeAgentServiceOptions,
  AgentInteractionObservation,
  OpenCodeRecoveryCandidate,
  PromptDispatchPreparation,
];

import { NativeAgentServiceReconciliation } from "./native-agent-service-reconciliation.ts";

export class NativeAgentServiceProvider extends NativeAgentServiceReconciliation {
  protected async provider(
    input: EnsureNativeAgentSessionInput,
  ): Promise<NativeAgentRuntimeProvider> {
    this.assertAcceptingWork();
    const cacheKey = `${input.environmentId}\0${input.agent}`;
    const environment = await this.assertEnvironmentLive(input.environmentId);
    const cached = this.providers.get(cacheKey);

    if (this.options.provider) {
      if (cached) return cached;
      const provider = await this.options.provider(input, environment);
      await this.assertEnvironmentLive(input.environmentId);
      this.assertAcceptingWork();
      this.cacheProvider(cacheKey, provider);
      return provider;
    }
    // A renderer readiness request or tab teardown can replace the bridge
    // without going through this service. Re-resolve its generation before
    // trusting a cached provider, otherwise that provider keeps sending to the
    // dead port/token for the rest of the backend process.
    const connection = await this.bridgeConnection(
      input.agent,
      environment,
      input.model,
      input.reasoningEffort,
    );
    const connectionIdentity = this.bridgeConnectionIdentity(connection);
    if (cached && this.providerConnections.get(cacheKey) === connectionIdentity) return cached;
    await this.assertEnvironmentLive(input.environmentId);
    this.assertAcceptingWork();
    const provider = createNativeAgentProvider(connection, {
      // Interactive sessions belong to a tab that renders approvals and
      // questions. Answering them here would run a command the user never saw
      // and cancel the card that exists to answer it.
      autoAnswerRequests: false,
      stageImages: (images) => this.stageImages(input.environmentId, images),
      // Read per call rather than per provider: providers are cached for the
      // life of a bridge connection, so a settings edit would otherwise not
      // reach the catalogue until the environment restarted.
      resolveOpenCodeModelProviders: async () =>
        (await this.storage.loadConfig()).global.openCodeModelProviders,
    });
    this.cacheProvider(cacheKey, provider, connectionIdentity);
    return provider;
  }

  /**
   * Publish a provider and retire any "no bridge is running" note for it.
   *
   * Reaching here means a bridge was just started or connected to, so the
   * observer's cooldown is stale and would otherwise keep the sidebar reporting
   * idle for up to its full window after a user opens a tab.
   */
  protected cacheProvider(
    cacheKey: string,
    provider: NativeAgentRuntimeProvider,
    connectionIdentity?: string,
  ): void {
    this.providers.set(cacheKey, provider);
    if (connectionIdentity) {
      this.providerConnections.set(cacheKey, connectionIdentity);
    } else {
      this.providerConnections.delete(cacheKey);
    }
    this.absentBridgeUntil.delete(cacheKey);
  }

  protected bridgeConnectionIdentity(connection: BridgeConnection): string {
    return createHash("sha256")
      .update(connection.agent)
      .update("\0")
      .update(connection.baseUrl)
      .update("\0")
      .update(connection.authToken)
      .digest("hex");
  }

  /**
   * Resolve a provider for observation only, never starting a bridge.
   *
   * `provider()` resolves its connection by *invoking the start command*, so
   * calling it from the activity sweep would spawn a bridge process for every
   * environment that has ever held a session — at startup, with no tab open,
   * and then keep them all alive on a two-second poll. An environment with no
   * running bridge has no turn in flight, which the caller records as idle, so
   * `undefined` here is an answer rather than a failure.
   */
  protected async observeProvider(
    input: EnsureNativeAgentSessionInput,
  ): Promise<NativeAgentRuntimeProvider | undefined> {
    this.assertAcceptingWork();
    const cacheKey = `${input.environmentId}\0${input.agent}`;
    if ((this.absentBridgeUntil.get(cacheKey) ?? 0) > this.now()) {
      return undefined;
    }
    const environment = await this.assertEnvironmentLive(input.environmentId);
    const cached = this.providers.get(cacheKey);
    if (cached) return cached;

    if (this.options.provider) {
      const provider = await this.options.provider(input, environment);
      await this.assertEnvironmentLive(input.environmentId);
      this.assertAcceptingWork();
      this.providers.set(cacheKey, provider);
      this.providerConnections.delete(cacheKey);
      return provider;
    }
    const connection = await this.observeBridgeConnection(input.agent, environment);
    if (!connection) {
      this.absentBridgeUntil.set(cacheKey, this.now() + ABSENT_BRIDGE_RECHECK_MS);
      return undefined;
    }
    await this.assertEnvironmentLive(input.environmentId);
    this.assertAcceptingWork();
    const provider = createNativeAgentProvider(connection, {
      autoAnswerRequests: false,
      stageImages: (images) => this.stageImages(input.environmentId, images),
    });
    this.cacheProvider(cacheKey, provider, this.bridgeConnectionIdentity(connection));
    return provider;
  }

  /** Forget a provider whose environment is gone, along with its observer state. */
  protected forgetProviderState(cacheKey: string): void {
    this.providers.delete(cacheKey);
    this.providerConnections.delete(cacheKey);
    this.absentBridgeUntil.delete(cacheKey);
    this.activityRetryAt.delete(cacheKey);
    this.activityAttempts.delete(cacheKey);
  }

  /**
   * Drop a provider whose read-only activity call failed so the next sweep
   * reconnects with fresh bridge coordinates. The identity check avoids
   * evicting a replacement installed by concurrent work.
   *
   * Deliberately does not dispose. `OpenCodeProvider.dispose()` aborts the
   * controller whose signal is attached to *every* request that provider makes,
   * including a `promptAsync` the user is waiting on — so disposing here would
   * let a failed background health read cancel a live prompt and report it as
   * an ambiguous dispatch. Eviction alone is enough: these providers are built
   * with `autoAnswerRequests: false`, so they hold no event stream, and
   * `pruneProviders` still disposes a provider whose environment has gone away,
   * where nothing can be in flight.
   */
  protected evictProvider(
    input: Pick<EnsureNativeAgentSessionInput, "environmentId" | "agent">,
    provider: NativeAgentRuntimeProvider,
  ): void {
    const cacheKey = `${input.environmentId}\0${input.agent}`;
    if (this.providers.get(cacheKey) !== provider) return;
    this.providers.delete(cacheKey);
    this.providerConnections.delete(cacheKey);
  }

  /** Stage base64 images into the workspace so a bridge will accept them. */
  protected async stageImages(
    environmentId: string,
    images: readonly TaskSnapshotImage[],
  ): Promise<PromptAttachment[]> {
    const environment = await this.assertEnvironmentLive(environmentId);
    return stagePromptImages(this.invoke, environment, images, INITIAL_PROMPT_STAGING_DIRECTORY);
  }

  /**
   * Dispose providers whose environment has gone away.
   *
   * Without this a deleted environment's provider stays cached for the life of
   * the process, holding its bridge connection open.
   */
  protected async pruneProviders(liveEnvironmentIds: Set<string>): Promise<void> {
    const stale: Array<[string, NativeAgentRuntimeProvider]> = [];
    for (const [cacheKey, provider] of this.providers) {
      const environmentId = cacheKey.slice(0, cacheKey.indexOf("\0"));
      if (!liveEnvironmentIds.has(environmentId) && !this.providerDispatchCounts.has(provider)) {
        stale.push([cacheKey, provider]);
      }
    }
    if (stale.length === 0) return;
    for (const [cacheKey] of stale) this.forgetProviderState(cacheKey);
    // Unlike observer eviction, an absent environment is safe to dispose only
    // after any provider call that passed the pre-dispatch liveness fence has
    // settled. Active providers remain cached for the next sweep to prune.
    await Promise.allSettled(stale.map(([, provider]) => provider.dispose?.()));
  }

  protected trackScan(task: Promise<void>): Promise<void> {
    const tracked = task.finally(() => {
      this.scanTasks.delete(tracked);
    });
    this.scanTasks.add(tracked);
    return tracked;
  }

  protected assertAcceptingWork(): void {
    if (this.stopped) throw new Error("Native agent service is shut down");
  }

  protected async assertEnvironmentLive(environmentId: string): Promise<Environment> {
    this.assertAcceptingWork();
    const environment = await this.storage.getEnvironment(environmentId);
    if (!environment || environment.deletionRequestedAt) {
      throw new Error("Native agent environment is unavailable");
    }
    this.assertAcceptingWork();
    return environment;
  }

  protected assertSessionIdentity(
    session: PersistedNativeAgentSession,
    input: EnsureNativeAgentSessionInput,
    key: string,
  ): void {
    if (
      session.key !== key ||
      session.environmentId !== input.environmentId ||
      session.agent !== input.agent ||
      session.logicalSessionKey !== input.logicalSessionKey ||
      (input.origin !== undefined && session.origin !== input.origin) ||
      (input.interactionPolicy !== undefined &&
        session.interactionPolicy.mode !== input.interactionPolicy.mode)
    ) {
      throw new Error("Native agent session key collision");
    }
  }

  protected async createProviderSession(
    provider: NativeAgentRuntimeProvider,
    input: EnsureNativeAgentSessionInput,
  ): Promise<string> {
    await this.assertEnvironmentLive(input.environmentId);
    const options = {
      clientSessionKey: input.logicalSessionKey,
      model: input.model,
      effort: input.reasoningEffort,
      mode: input.sessionMode,
      fastMode: input.fastMode,
      interaction: {
        origin: input.origin ?? "interactive-native",
        interactionPolicy:
          input.interactionPolicy ??
          (input.origin === "build-pipeline" || input.origin === "looped-review"
            ? UNATTENDED_AGENT_INTERACTION_POLICY
            : INTERACTIVE_AGENT_INTERACTION_POLICY),
        phase: input.phase,
      },
    };
    const maxAttempts =
      input.agent === "cursor" || input.agent === "grok" || input.agent === "pi"
        ? ACP_SESSION_CREATE_ATTEMPTS
        : 1;
    let providerSessionId: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        providerSessionId = await provider.createSession(
          input.phase ?? "build",
          input.title?.trim() || "Agent Session",
          options,
        );
        break;
      } catch (error) {
        if (!(error instanceof ProviderUnavailableError) || attempt === maxAttempts) {
          throw error;
        }
        // ACP and Pi session/create are both idempotent by clientSessionKey.
        // Retrying here keeps a short bridge initialization race represented as
        // "connecting" by the waiting renderer, without risking two sessions.
        // Pi belongs here because its cold start builds a model runtime the
        // same way an ACP spawn does.
        await this.assertEnvironmentLive(input.environmentId);
        const delay = ACP_SESSION_CREATE_RETRY_BASE_MS * 2 ** (attempt - 1);
        await (this.options.delay
          ? this.options.delay(delay)
          : new Promise<void>((resolve) => setTimeout(resolve, delay)));
      }
    }
    if (!providerSessionId) {
      throw new ProviderUnavailableError(`${input.agent} session creation did not complete`);
    }
    await this.assertEnvironmentLive(input.environmentId);
    return providerSessionId;
  }

  protected composeDraftHoldsQueue(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (!value || typeof value !== "object" || Array.isArray(value)) return true;
    const draft = value as Record<string, unknown>;
    if (typeof draft.text !== "string") return true;
    if (!Array.isArray(draft.mentions) || !Array.isArray(draft.attachments)) {
      return true;
    }
    return (
      draft.text.trim().length > 0 || draft.mentions.length > 0 || draft.attachments.length > 0
    );
  }

  protected queueBoolean(message: unknown, field: string): boolean | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return undefined;
    }
    const value = (message as Record<string, unknown>)[field];
    return typeof value === "boolean" ? value : undefined;
  }

  protected queueString(message: unknown, field: string): string | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return undefined;
    }
    const value = (message as Record<string, unknown>)[field];
    return nonBlank(value) ? value : undefined;
  }

  protected queueReasoningEffort(message: unknown): string | undefined {
    return (
      this.queueString(message, "reasoningEffort") ??
      this.queueString(message, "effort") ??
      this.queueString(message, "variant")
    );
  }

  protected queueFastMode(agent: BuildPipelineAgent, message: unknown): boolean | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return undefined;
    }
    const record = message as Record<string, unknown>;
    // Native compose queues persist the shared `fastMode` field for every
    // provider. Keep accepting Claude's legacy `fastModeEnabled` shape while
    // forwarding the shared field to Codex, Cursor, and Grok.
    //
    // Each candidate is type-checked before the next is considered rather than
    // coalesced first: `??` only falls through on null/undefined, so a garbage
    // legacy value would otherwise shadow a perfectly good shared field and
    // silently drop the user's speed selection.
    const candidates =
      agent === "claude" ? [record.fastModeEnabled, record.fastMode] : [record.fastMode];
    for (const candidate of candidates) {
      if (typeof candidate === "boolean") return candidate;
    }
    return undefined;
  }

  protected queueExecutionMode(agent: BuildPipelineAgent, message: unknown): ProviderExecutionMode {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return "plan";
    }
    const record = message as Record<string, unknown>;
    if (agent === "claude") {
      if (record.planModeEnabled === true) return "plan";
      if (record.planModeEnabled === false || record.planModeEnabled === undefined) {
        return "build";
      }
      return "plan";
    }
    if (record.mode === "plan" || record.mode === "build") return record.mode;
    return record.mode === undefined ? "build" : "plan";
  }

  protected async bridgeConnection(
    agent: BuildPipelineAgent,
    environment: Environment,
    model?: string,
    effort?: string,
  ): Promise<BridgeConnection> {
    const suffix = agent === "opencode" ? "opencode" : agent;
    if (environment.environmentType === "local") {
      const result = await this.invoke<{ port: number; authToken?: string }>(
        `start_local_${suffix}_server_cmd`,
        { environmentId: environment.id },
      );
      if (!result.authToken) {
        throw new Error(`${agent} bridge authentication is unavailable`);
      }
      return {
        agent,
        baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken,
        directory: environment.worktreePath,
        model,
        effort,
      };
    }

    if (!environment.containerId) {
      throw new Error("Native agent container is unavailable");
    }
    const result = await this.invoke<{ hostPort: number; authToken?: string }>(
      `start_${suffix}_server`,
      { containerId: environment.containerId },
    );
    if (!result.authToken) {
      throw new Error(`${agent} bridge authentication is unavailable`);
    }
    return {
      agent,
      baseUrl: `http://127.0.0.1:${result.hostPort}`,
      authToken: result.authToken,
      model,
      effort,
    };
  }

  /**
   * Bridge coordinates for an already-running bridge, or `undefined`.
   *
   * The peek commands are the read-only twins of the start commands: they
   * report a live, authenticated bridge and never spawn one. Anything that
   * cannot be answered without starting a process is reported as "not running"
   * rather than started on the observer's behalf.
   */
  protected async observeBridgeConnection(
    agent: BuildPipelineAgent,
    environment: Environment,
  ): Promise<BridgeConnection | undefined> {
    if (environment.environmentType === "local") {
      const result = await this.invoke<{ port: number; authToken: string } | null>(
        "peek_local_agent_bridge",
        { environmentId: environment.id, agent },
      );
      if (!result?.authToken) return undefined;
      return {
        agent,
        baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken,
        directory: environment.worktreePath,
      };
    }

    if (!environment.containerId) return undefined;
    const result = await this.invoke<{ hostPort: number; authToken: string } | null>(
      "peek_container_agent_bridge",
      {
        containerId: environment.containerId,
        agent,
      },
    );
    if (!result?.authToken) return undefined;
    return {
      agent,
      baseUrl: `http://127.0.0.1:${result.hostPort}`,
      authToken: result.authToken,
    };
  }
}
