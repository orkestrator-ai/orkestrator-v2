import * as shared from "./native-agent-service-shared.js";
import { composeDraftHoldsQueue } from "./compose-draft-occupancy.js";
import {
  ACP_SESSION_CREATE_ATTEMPTS,
  ACP_SESSION_CREATE_RETRY_BASE_MS,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  ProviderUnavailableError,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  createNativeAgentProvider,
  nonBlank,
} from "./native-agent-service-shared.js";
import { bridgeConnectionIdentity, providerCacheKey } from "./native-agent-provider-registry.js";
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
type IncompleteTurnNotice = shared.IncompleteTurnNotice;
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
  IncompleteTurnNotice,
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
  PromptDispatchPreparation,
];

import { NativeAgentServiceReconciliation } from "./native-agent-service-reconciliation.ts";
import type { ProviderMcpConfigEvidenceRead } from "./agent-provider-contract.js";
import { agentSessionOwnerKey } from "@orkestrator/protocol/coordinator";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import {
  coordinatorRuntimeEnvironment,
  coordinatorRuntimeUnavailableMessage,
  resolveCoordinatorRuntime,
} from "./coordinator-runtime.js";

export class NativeAgentServiceProvider extends NativeAgentServiceReconciliation {
  /**
   * Forget a closed provider session's in-memory registration on the cached
   * provider, if one exists. Never resolves or starts a bridge: tab teardown
   * calls this after the provider-side close was confirmed, and only when no
   * other logical tab still maps to the same provider session.
   */
  releaseProviderSession(
    environmentId: string,
    agent: EnsureNativeAgentSessionInput["agent"],
    providerSessionId: string,
  ): void {
    this.providerRegistry
      .cached(providerCacheKey(environmentId, agent))
      ?.releaseSession?.(providerSessionId);
  }

  /**
   * Tab close through the provider, so the provider's own close runs: for
   * OpenCode that settles workflow-turn ownership, restores temporary reviewer
   * permissions and rejects pending requests before forgetting the session.
   *
   * Never starts a bridge. The cached provider is used only while it still
   * points at the running bridge; a restarted bridge gets a fresh provider,
   * cached like any other. `not-running` means no bridge answers, so the
   * caller keeps its durable intent.
   */
  async closeProviderSessionIfRunning(
    environmentId: string,
    agent: EnsureNativeAgentSessionInput["agent"],
    providerSessionId: string,
  ): Promise<"closed" | "not-running" | "unsupported"> {
    this.assertAcceptingWork();
    const cacheKey = providerCacheKey(environmentId, agent);
    const input = { environmentId, agent, logicalSessionKey: "tab-close" };
    let provider: NativeAgentRuntimeProvider | undefined;
    if (this.options.provider) {
      this.providerRegistry.clearBridgeAbsent(cacheKey);
      provider = await this.observeProvider(input);
    } else {
      const environment = await this.assertEnvironmentLive(environmentId);
      const connection = await this.observeBridgeConnection(agent, environment);
      if (!connection) return "not-running";
      const identity = bridgeConnectionIdentity(connection);
      const cached = this.providerRegistry.cachedForConnection(cacheKey, identity);
      if (cached) {
        provider = cached;
      } else {
        this.assertAcceptingWork();
        provider = createNativeAgentProvider(connection, {
          autoAnswerRequests: false,
          stageImages: (images) => this.stageImages(environmentId, images),
          environment: this.providerEnvironment(environmentId),
        });
        this.providerRegistry.cache(cacheKey, provider, identity);
      }
    }
    if (!provider) return "not-running";
    if (!provider.closeSession) return "unsupported";
    await provider.closeSession(providerSessionId);
    return "closed";
  }

  /** Destructive lifecycle admission: fresh metadata reads, without starting a bridge. */
  async assertEnvironmentIdleForMove(environmentId: string): Promise<void> {
    const sessions = (await this.storage.listNativeAgentSessions()).filter(
      (session) => session.environmentId === environmentId,
    );
    for (const session of sessions) {
      if (session.pendingDispatch)
        throw new Error("An agent submission is unresolved; settle it before moving");
      if (!session.providerSessionId) continue;
      this.providerRegistry.clearBridgeAbsent(providerCacheKey(environmentId, session.agent));
      const input = {
        environmentId,
        agent: session.agent,
        logicalSessionKey: session.logicalSessionKey,
      };
      let provider: NativeAgentRuntimeProvider | undefined;
      if (this.options.provider) {
        provider = await this.observeProvider(input);
      } else {
        // The move stops bridges between its two reads. Cached providers can
        // still point at a stopped child, so verify its current connection.
        const connection = await this.observeBridgeConnection(
          session.agent,
          await this.assertEnvironmentLive(environmentId),
        );
        if (connection) {
          const key = providerCacheKey(environmentId, session.agent);
          const identity = bridgeConnectionIdentity(connection);
          const cached = this.providerRegistry.cachedForConnection(key, identity);
          if (cached) provider = cached;
          else {
            provider = createNativeAgentProvider(connection, { autoAnswerRequests: false });
            this.providerRegistry.cache(key, provider, identity);
          }
        }
      }
      if (!provider) {
        const observed = this.observedSessionActivity.get(session.key);
        if (observed && observed.state !== "idle")
          throw new Error(
            "An agent is running in this environment; wait for it to finish before moving",
          );
        continue;
      }
      if (!provider.activity)
        throw new Error("Agent activity cannot be verified; stop the agent before moving");
      const state = await provider.activity(session.providerSessionId);
      if (state !== "idle" && state !== "missing")
        throw new Error(
          "An agent is running in this environment; wait for it to finish before moving",
        );
      this.observedSessionActivity.set(session.key, {
        providerSessionId: session.providerSessionId,
        state: "idle",
      });
    }
  }

  /**
   * Reload MCP configuration in an environment's *already running* bridge.
   *
   * Resolves the provider the way the activity sweep does, so it never starts
   * a bridge, and calls a session-free bridge route, so it neither touches a
   * session's liveness nor re-attaches an idle thread — and it still works
   * after a bridge restart forgot every session. `not-running` is an answer:
   * a process that is not running reads the saved file when it starts.
   */
  async reloadMcpConfigurationIfRunning(
    environmentId: string,
    agent: BuildPipelineAgent,
  ): Promise<"reloaded" | "not-running" | "unsupported"> {
    const provider = await this.observeProvider({
      environmentId,
      agent,
      logicalSessionKey: "mcp-configuration-reload",
    });
    if (!provider) return "not-running";
    if (!provider.reloadMcpConfiguration) return "unsupported";
    return provider.reloadMcpConfiguration();
  }

  /**
   * Which saved MCP configuration a session's live runtime was built from,
   * for the MCP apply scheduler only.
   *
   * Observation-only on every hop: the persisted mapping supplies the
   * provider session id, the provider is resolved the way the activity sweep
   * resolves it (never starting a bridge), and the bridge route read is
   * `/runtime-health`, which touches no liveness, hydrates no transcript and
   * re-attaches nothing. The answer is never projected to a renderer.
   */
  async mcpConfigEvidenceIfRunning(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): Promise<ProviderMcpConfigEvidenceRead> {
    const session = await this.storage.getNativeAgentSession(
      shared.nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey),
    );
    if (!session?.providerSessionId) return { state: "none" };
    const provider = await this.observeProvider({ environmentId, agent, logicalSessionKey });
    if (!provider) return { state: "not-running" };
    if (!provider.mcpConfigEvidence) return { state: "none" };
    const evidence = await provider.mcpConfigEvidence(session.providerSessionId);
    return evidence ? { state: "evidence", evidence } : { state: "none" };
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
    const coordinator = await resolveCoordinatorRuntime(this.storage, environmentId);
    if (coordinator.status === "unavailable") {
      throw new Error(coordinatorRuntimeUnavailableMessage(coordinator));
    }
    if (coordinator.status === "ready") {
      return coordinatorRuntimeEnvironment(environmentId, coordinator);
    }
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
        session.interactionPolicy.mode !== input.interactionPolicy.mode) ||
      (input.owner !== undefined &&
        session.owner !== undefined &&
        agentSessionOwnerKey(session.owner) !== agentSessionOwnerKey(input.owner)) ||
      (input.executionPolicy !== undefined &&
        session.executionPolicy !== undefined &&
        session.executionPolicy !== input.executionPolicy) ||
      (input.policy !== undefined &&
        session.policy !== undefined &&
        JSON.stringify(session.policy) !== JSON.stringify(input.policy))
    ) {
      throw new Error("Native agent session key collision");
    }
  }

  protected async createProviderSession(
    provider: NativeAgentRuntimeProvider,
    input: EnsureNativeAgentSessionInput,
  ): Promise<string> {
    await this.assertEnvironmentLive(input.environmentId);
    const environment = await this.storage.getEnvironment(input.environmentId);
    const prefix = `env-${input.environmentId}:`;
    const tabId = input.logicalSessionKey.startsWith(prefix)
      ? input.logicalSessionKey.slice(prefix.length)
      : "";
    const agentMcp =
      nativeAgentCapabilities(input.agent).agentTools === true &&
      input.owner?.kind === "environment" &&
      tabId &&
      environment &&
      this.options.resolveAgentToolConnection
        ? this.options.resolveAgentToolConnection(
            input.environmentId,
            input.owner.projectId,
            tabId,
            environment.environmentType === "local" ? "host" : "container",
          )
        : undefined;
    const options = {
      clientSessionKey: input.logicalSessionKey,
      model: input.model,
      effort: input.reasoningEffort,
      mode: input.sessionMode,
      fastMode: input.fastMode,
      agentMcp,
      policy: input.policy,
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
    return composeDraftHoldsQueue(value);
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

  /**
   * The mode actually sent with a queued prompt. Backend-authored prompts may
   * ask to leave the session's own mode untouched (`preserveSessionMode`):
   * several providers persist a prompt's mode on the session, so sending the
   * `build` default would silently change a mode the user chose.
   */
  protected queueDispatchMode(
    agent: BuildPipelineAgent,
    message: unknown,
  ): ProviderExecutionMode | undefined {
    if (
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).preserveSessionMode === true &&
      (message as Record<string, unknown>).mode === undefined &&
      (message as Record<string, unknown>).planModeEnabled === undefined
    ) {
      return undefined;
    }
    return this.queueExecutionMode(agent, message);
  }
}
