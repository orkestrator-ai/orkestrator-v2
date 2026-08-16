import * as shared from "./native-agent-service-shared.js";
import {
  AmbiguousPromptDispatchError,
  BUILD_PIPELINE_AGENTS,
  PARKED_DISPATCH_CONFLICT_MESSAGE,
  PendingNativeAgentDispatchError,
  nativeAgentSessionStorageKey,
  nativeCapabilities,
  nonBlank,
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

import { NativeAgentServiceBase } from "./native-agent-service-base.ts";

export abstract class NativeAgentServiceDispatch extends NativeAgentServiceBase {
  protected async dispatchIntentInternal(
    input: DispatchNativeAgentPromptInput,
    preserveExistingPending: boolean,
  ): Promise<NativeAgentDispatchOutcome> {
    let manualOpenCodeSession: PersistedNativeAgentSession | null = null;
    try {
      const isManualOpenCode = input.agent === "opencode"
        && input.origin !== "build-pipeline"
        && input.origin !== "looped-review";
      if (isManualOpenCode) {
        manualOpenCodeSession = await this.ensureSession(input);
        await this.claimOpenCodeManualPrompt({
          environmentId: input.environmentId,
          logicalSessionKey: input.logicalSessionKey,
          providerSessionId: manualOpenCodeSession.providerSessionId,
          requestId: input.requestId,
        });
      }
      return await this.attemptDispatch(input, true, preserveExistingPending);
    } catch (error) {
      // Everything before the first dispatch attempt: session creation, the
      // OpenCode manual claim. A normal send has no earlier record to preserve;
      // an explicit recovery retry does, and must leave it parked on failure.
      if (!preserveExistingPending) {
        await this.storage.clearPendingNativeAgentDispatch(
          nativeAgentSessionStorageKey(
            input.environmentId,
            input.agent,
            input.logicalSessionKey,
          ),
          input.requestId,
        ).catch(() => false);
      }
      return {
        outcome: "rejected",
        error: error instanceof Error ? error.message : "Prompt dispatch failed",
      };
    } finally {
      if (manualOpenCodeSession) {
        this.releaseOpenCodeManualPrompt({
          environmentId: input.environmentId,
          logicalSessionKey: input.logicalSessionKey,
          providerSessionId: manualOpenCodeSession.providerSessionId,
          requestId: input.requestId,
        });
      }
    }
  }

  /**
   * One dispatch attempt, plus a single bounded retry once a stale block has
   * been cleared.
   *
   * `allowRecoveryRetry` is what bounds it. A prompt refused because an earlier
   * dispatch is still parked can legitimately proceed the moment that parked
   * record is settled against the provider — but only once, so a session that
   * keeps re-parking cannot drive an unbounded dispatch loop.
   */
  protected async attemptDispatch(
    input: DispatchNativeAgentPromptInput,
    allowRecoveryRetry: boolean,
    preserveExistingPending: boolean,
  ): Promise<NativeAgentDispatchOutcome> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    try {
      await this.dispatchPromptInternal(input, undefined, true);
      void this.refreshProjection(input, true).catch(() => undefined);
      return { outcome: "accepted", requestId: input.requestId };
    } catch (error) {
      if (error instanceof PendingNativeAgentDispatchError) {
        // The only thing refusing this prompt is an older dispatch nobody has
        // resolved. If the provider can prove that one landed, the block was
        // stale and this prompt was never in conflict with anything.
        if (
          allowRecoveryRetry
          && await this.settleAmbiguousDispatch(
            input,
            key,
            error.pendingRequestId,
          )
        ) {
          return this.attemptDispatch(input, false, preserveExistingPending);
        }
        void this.refreshProjection(input, true).catch(() => undefined);
        return { outcome: "rejected", error: PARKED_DISPATCH_CONFLICT_MESSAGE };
      }
      if (error instanceof AmbiguousPromptDispatchError) {
        // Ask the provider before handing the ambiguity to the user. A lost
        // acknowledgement is not the same fact as a lost prompt, and the
        // provider's own dispatch journal can usually tell the two apart.
        if (await this.settleAmbiguousDispatch(input, key, input.requestId)) {
          void this.refreshProjection(input, true).catch(() => undefined);
          return { outcome: "accepted", requestId: input.requestId };
        }
        void this.refreshProjection(input, true).catch(() => undefined);
        return {
          outcome: "unknown",
          requestId: input.requestId,
          error: error.message,
        };
      }
      if (!preserveExistingPending) {
        await this.storage.clearPendingNativeAgentDispatch(
          key,
          input.requestId,
        ).catch(() => false);
      }
      return {
        outcome: "rejected",
        error: error instanceof Error ? error.message : "Prompt dispatch failed",
      };
    }
  }

  /**
   * Discard a parked dispatch without sending it.
   *
   * The other half of the recovery choice: retrying re-offers the prompt under
   * the same idempotency key, discarding accepts that it may have run and stops
   * blocking the session. Deliberately requires the exact request id the caller
   * was shown, so a stale tab cannot drop a newer parked dispatch it never saw.
   */
  async discardRecoverableDispatch(
    input: NativeAgentProjectionInput & { requestId: string },
  ): Promise<{ discarded: boolean }> {
    this.assertProjectionInput(input);
    if (!nonBlank(input.requestId)) {
      throw new Error("Recoverable native agent request ID must not be blank");
    }
    const discarded = await this.storage.clearPendingNativeAgentDispatch(
      nativeAgentSessionStorageKey(
        input.environmentId,
        input.agent,
        input.logicalSessionKey,
      ),
      input.requestId,
    );
    if (discarded) {
      void this.refreshProjection(input, true).catch(() => undefined);
    }
    return { discarded };
  }

  /**
   * Settle a parked dispatch against the provider's own journal.
   *
   * A dispatch becomes recoverable because Orkestrator lost the answer, not
   * because the provider lost the prompt — and every bridge keeps a durable
   * record keyed by the same request id. Asking it turns the common case (the
   * turn is running; only the acknowledgement went missing) back into a plain
   * accepted dispatch, instead of a banner the user has to act on.
   *
   * Read-only and strictly one-directional: it can only ever *clear* a pending
   * record, and only on an explicit `dispatched`. Providers with no journal to
   * ask, an unreachable bridge, and any failure at all leave the record exactly
   * where it was, because "I could not find out" must never read as "it ran".
   */
  protected async settleAmbiguousDispatch(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    resolved?: NativeAgentRuntimeProvider,
  ): Promise<boolean> {
    try {
      // Cheapest question first. Projection reads drive this on every refresh,
      // and a provider with no journal to ask must not cost a storage read each
      // time to establish that it still has nothing to say.
      const provider = resolved ?? await this.provider(input);
      if (!provider.dispatchStatus) return false;
      // Re-read rather than trusting the caller's snapshot: a real
      // acknowledgement may have landed since, and confirming against a stale
      // record would resurrect a request id that is no longer parked.
      const session = await this.storage.getNativeAgentSession(key);
      if (session?.pendingDispatch?.requestId !== requestId) return false;
      const status = await provider.dispatchStatus(
        session.providerSessionId,
        requestId,
      );
      if (status !== "dispatched") return false;
      return await this.storage.confirmNativeAgentDispatch(key, requestId);
    } catch {
      return false;
    }
  }

  /**
   * Settle a parked dispatch in the background, at most once at a time per
   * session.
   *
   * Driven from projection reads so a record that outlived the dispatch that
   * created it — a backend restart mid-flight, a bridge that came back after
   * the tab was closed — is resolved by the next refresh rather than waiting
   * for the user. Never awaited by the projection: an authoritative snapshot
   * must not be delayed by, or fail because of, an optional reconciliation.
   */
  protected scheduleAmbiguousDispatchSettle(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    resolved: NativeAgentRuntimeProvider,
  ): void {
    const inFlight = `${key}\0${requestId}`;
    if (this.settlingDispatches.has(inFlight)) return;
    this.settlingDispatches.add(inFlight);
    void this.trackScan(
      this.settleAmbiguousDispatch(input, key, requestId, resolved)
        .then((settled) => {
          if (settled) void this.refreshProjection(input, true).catch(() => undefined);
        })
        .catch(() => undefined)
        .finally(() => this.settlingDispatches.delete(inFlight)),
    ).catch(() => undefined);
  }

  async retryRecoverableDispatch(
    input: NativeAgentProjectionInput & { requestId: string },
  ): Promise<NativeAgentDispatchOutcome> {
    this.assertProjectionInput(input);
    if (!nonBlank(input.requestId)) {
      throw new Error("Recoverable native agent request ID must not be blank");
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.storage.getNativeAgentSession(key);
    const pending = session?.pendingDispatch;
    if (!session || !pending) {
      return {
        outcome: "rejected",
        error: "There is no recoverable dispatch for this session",
      };
    }
    if (pending.requestId !== input.requestId) {
      return {
        outcome: "rejected",
        error: "The recoverable dispatch changed; refresh before retrying",
      };
    }
    return this.dispatchIntentInternal({
      environmentId: session.environmentId,
      agent: session.agent,
      logicalSessionKey: session.logicalSessionKey,
      origin: session.origin,
      interactionPolicy: session.interactionPolicy,
      prompt: pending.prompt,
      requestId: pending.requestId,
      images: pending.images,
      attachments: pending.attachments,
      schema: pending.schema,
      mode: pending.mode,
      fastMode: pending.fastMode,
      subAgent: pending.subAgent,
      executionAgent: pending.executionAgent,
      includeLocalSettings: pending.includeLocalSettings,
      promptSuggestions: pending.promptSuggestions,
      model: pending.model,
      reasoningEffort: pending.reasoningEffort,
    }, true);
  }

  async stopProjectionSession(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    await resolved.provider.abort(resolved.session.providerSessionId);
    return this.refreshProjection(input, true);
  }

  async stopProjectionBackgroundTask(
    input: NativeAgentProjectionInput & { taskId: string },
  ): Promise<NativeAgentSessionProjection | null> {
    if (!nonBlank(input.taskId)) throw new Error("Background task ID must not be blank");
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    if (!resolved.provider.stopBackgroundTask) {
      throw new Error(`${input.agent} does not support background tasks`);
    }
    await resolved.provider.stopBackgroundTask(
      resolved.session.providerSessionId,
      input.taskId,
    );
    return this.refreshProjection(input, true);
  }

  async dismissProjectionSuggestedPrompt(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    if (!resolved.provider.dismissSuggestedPrompt) {
      throw new Error(`${input.agent} does not support prompt suggestions`);
    }
    await resolved.provider.dismissSuggestedPrompt(
      resolved.session.providerSessionId,
    );
    return this.refreshProjection(input, true);
  }

  async listProjectionResumableSessions(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentResumeEntry[]> {
    this.assertProjectionInput(input);
    if (!nativeCapabilities(input.agent).resume) return [];
    const provider = await this.provider(input);
    if (!provider.listResumableSessions) {
      throw new Error(`${input.agent} does not support session resume`);
    }
    /*
     * Ordered here rather than in each picker: providers return their own order
     * (OpenCode's is creation order), so the session the user most likely wants
     * was not necessarily at the top. Unknown timestamps sink to the bottom
     * instead of sorting as 1970.
     */
    const entries = await provider.listResumableSessions();
    const activityAt = (entry: NativeAgentResumeEntry) => {
      const raw = entry.updatedAt ?? entry.createdAt;
      const parsed = raw ? Date.parse(raw) : Number.NaN;
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    return [...entries]
      .sort((left, right) => activityAt(right) - activityAt(left))
      .slice(0, 512);
  }

  async resumeProjectionSession(
    input: NativeAgentProjectionInput & {
      providerSessionId: string;
      controls?: NativeAgentControlUpdate;
    },
  ): Promise<NativeAgentSessionProjection | null> {
    this.assertProjectionInput(input);
    if (!nonBlank(input.providerSessionId)) {
      throw new Error("Native agent resume session ID must not be blank");
    }
    if (!nativeCapabilities(input.agent).resume) {
      throw new Error(`${input.agent} does not support session resume`);
    }
    const provider = await this.provider(input);
    if (!provider.resumeSession) {
      throw new Error(`${input.agent} does not support session resume`);
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const existing = await this.storage.getNativeAgentSession(key);
    this.invalidateProjection(key);
    const resumedId = await provider.resumeSession(
      input.providerSessionId,
      input.controls,
    );
    await this.adoptSession({
      ...input,
      providerSessionId: resumedId,
      expectedProviderSessionId: existing?.providerSessionId,
      controls: input.controls,
      model: input.controls?.modelId,
      reasoningEffort: input.controls?.reasoningId,
      sessionMode: input.controls?.mode,
      fastMode: input.controls?.fastMode,
    });
    return this.refreshProjection(input, true);
  }

  async forkProjectionSession(
    input: NativeAgentProjectionInput & { messageId?: string },
  ): Promise<NativeAgentForkOutcome> {
    if (!nativeCapabilities(input.agent).fork) {
      throw new Error(`${input.agent} does not support session forks`);
    }
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) throw new Error("Native agent session was not found");
    if (!resolved.provider.forkSession) {
      throw new Error(`${input.agent} does not support session forks`);
    }
    return resolved.provider.forkSession(
      resolved.session.providerSessionId,
      input.messageId,
    );
  }

  async performProjectionAction(
    input: NativeAgentProjectionInput & { action: NativeAgentSessionAction },
  ): Promise<NativeAgentSessionActionOutcome> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) throw new Error("Native agent session was not found");
    const capability = {
      compact: "compact",
      "rewind-files": "rewindFiles",
      undo: "undo",
      redo: "redo",
      share: "share",
      unshare: "share",
      steer: "steer",
      review: "review",
    }[input.action.kind] as keyof NonNullable<NativeAgentCapabilities["actions"]>;
    if (!nativeCapabilities(input.agent).actions?.[capability]) {
      throw new Error(`${input.agent} does not support ${input.action.kind}`);
    }
    if (!resolved.provider.performSessionAction) {
      throw new Error(`${input.agent} does not support ${input.action.kind}`);
    }
    const outcome = await resolved.provider.performSessionAction(
      resolved.session.providerSessionId,
      input.action,
    );
    this.invalidateProjection(resolved.key);
    return outcome;
  }

  async updateProjectionControls(
    input: NativeAgentProjectionInput & { update: NativeAgentControlUpdate },
  ): Promise<NativeAgentSessionProjection | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    const current = await this.refreshProjection(input, true);
    const composer = current?.composer;
    if (input.update.modelId !== undefined) {
      if (!composer?.models.some((model: NativeAgentComposerState["models"][number]) => model.id === input.update.modelId)) {
        throw new Error("Native agent model selection is invalid");
      }
    }
    if (input.update.reasoningId !== undefined) {
      const modelId = input.update.modelId ?? composer?.selectedModelId;
      const model = composer?.models.find((candidate: NativeAgentComposerState["models"][number]) => candidate.id === modelId);
      if (!model?.reasoning?.some((option: NonNullable<NativeAgentComposerState["models"][number]["reasoning"]>[number]) => option.id === input.update.reasoningId)) {
        throw new Error("Native agent reasoning selection is invalid");
      }
    }
    if (
      input.update.fastMode !== undefined
      && composer?.fastModeAvailable !== true
    ) {
      throw new Error("Native agent fast mode is unavailable");
    }
    if (
      input.update.mode !== undefined
      && !composer?.modes.some((mode: NativeAgentComposerState["modes"][number]) => mode.id === input.update.mode)
    ) {
      throw new Error("Native agent conversation mode is invalid");
    }
    if (
      input.update.executionProfileId !== undefined
      && input.update.executionProfileId !== null
      && !composer?.executionProfiles?.some(
        (profile: NonNullable<NativeAgentComposerState["executionProfiles"]>[number]) => profile.id === input.update.executionProfileId,
      )
    ) {
      throw new Error("Native agent execution profile is invalid");
    }
    const capabilities = nativeCapabilities(input.agent).composer;
    if (input.update.includeLocalSettings !== undefined && !capabilities.localSettings) {
      throw new Error("Native agent local settings are unavailable");
    }
    if (input.update.promptSuggestions !== undefined && !capabilities.promptSuggestions) {
      throw new Error("Native agent prompt suggestions are unavailable");
    }
    if (resolved.provider.updateInteractiveControls) {
      await resolved.provider.updateInteractiveControls(
        resolved.session.providerSessionId,
        input.update,
      );
    }
    await this.storage.updateNativeAgentSessionControls(
      resolved.key,
      resolved.session.providerSessionId,
      input.update,
    );
    return this.refreshProjection(input, true);
  }

  async resolveProjectionInteraction(
    input: NativeAgentProjectionInput & {
      interactionId: string;
      resolution: AgentInteractionResolution;
    },
  ): Promise<AgentInteractionApplyOutcome> {
    if (!nonBlank(input.interactionId)) {
      throw new Error("Native agent interaction ID must not be blank");
    }
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) {
      throw new Error("Native agent session was not found");
    }
    if (!resolved.provider.interactions) {
      throw new Error(`${input.agent} does not support interactive requests`);
    }
    const outcome = await resolved.provider.interactions.resolveInteraction(
      resolved.session.providerSessionId,
      input.interactionId,
      input.resolution,
    );
    void this.refreshProjection(input, true).catch(() => undefined);
    return outcome;
  }

  protected assertProjectionInput(input: NativeAgentProjectionInput): void {
    this.assertAcceptingWork();
    if (
      !nonBlank(input.environmentId)
      || !nonBlank(input.logicalSessionKey)
      || !BUILD_PIPELINE_AGENTS.includes(input.agent)
    ) {
      throw new Error("Invalid native agent projection request");
    }
  }

  protected async resolveProjectionSession(input: NativeAgentProjectionInput) {
    this.assertProjectionInput(input);
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.storage.getNativeAgentSession(key);
    if (!session) return null;
    this.assertSessionIdentity(session, input, key);
    const provider = await this.provider(input);
    provider.registerSession?.(session.providerSessionId, {
      origin: session.origin,
      interactionPolicy: session.interactionPolicy,
    });
    return { key, session, provider };
  }


}
