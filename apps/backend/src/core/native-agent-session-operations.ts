import type {
  AgentInteractionApplyOutcome,
  AgentInteractionResolution,
  EnsureNativeAgentSessionInput,
  AdoptNativeAgentSessionInput,
  NativeAgentAuthStatus,
  NativeAgentCapabilities,
  NativeAgentComposerState,
  NativeAgentControlUpdate,
  NativeAgentForkOutcome,
  NativeAgentMcpServerAction,
  NativeAgentProjectionInput,
  NativeAgentResumeEntry,
  NativeAgentRuntimeProvider,
  NativeAgentServiceOptions,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
  NativeAgentSessionProjection,
  PersistedNativeAgentSession,
  StorageService,
} from "./native-agent-service-shared.js";
import {
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  NativeAgentProviderSessionMissingError,
  isFallbackExecutionProfileId,
  nativeAgentSessionStorageKey,
  nativeCapabilities,
  nonBlank,
} from "./native-agent-service-shared.js";
import {
  providerSessionHeldElsewhere,
  replacedSessionCloseIntent,
  withProviderSessionTeardownLock,
} from "./provider-session-ownership.js";
import type { NativeAgentInteractionTracker } from "./native-agent-interaction-tracker.js";
import type { NativeAgentPromptQueueDispatcher } from "./native-agent-prompt-queue-dispatcher.js";
import type {
  NativeAgentTranscriptProjection,
  ResolvedProjectionSession,
} from "./native-agent-transcript-projection.js";
import type { PermissionRuleChoice, PermissionRuleEnforcer } from "./permission-rules/enforcer.js";

/** What the session operations need from the service that wires them. */
export interface NativeAgentSessionOperationsHost {
  storage: StorageService;
  options: NativeAgentServiceOptions;
  projections: NativeAgentTranscriptProjection;
  /** Stop takes the session mutation intent and the turn-interrupt fences here. */
  promptQueues: NativeAgentPromptQueueDispatcher;
  interactions: NativeAgentInteractionTracker;
  /** Orkestrator's permission rules (todo 0723); absent with a narrow storage double. */
  permissionRules?: PermissionRuleEnforcer;
  now(): number;
  assertProjectionInput(input: NativeAgentProjectionInput): void;
  resolveProjectionSession(
    input: NativeAgentProjectionInput,
  ): Promise<ResolvedProjectionSession | null>;
  /** Resolve a provider, starting its bridge if needed. */
  provider(input: EnsureNativeAgentSessionInput): Promise<NativeAgentRuntimeProvider>;
  /** Resolve a provider for observation only, never starting a bridge. */
  observeProvider(
    input: EnsureNativeAgentSessionInput,
  ): Promise<NativeAgentRuntimeProvider | undefined>;
  /** Resolve coordinator authority from persisted ownership, never caller metadata. */
  trustedSessionInput<T extends EnsureNativeAgentSessionInput>(input: T): Promise<T>;
  adoptSession(input: AdoptNativeAgentSessionInput): Promise<PersistedNativeAgentSession>;
  getProjection(input: NativeAgentProjectionInput): Promise<NativeAgentSessionProjection | null>;
  /** A `steer` session action, which stays with the service's persisted-steer dispatch. */
  performProjectionSteer(
    input: NativeAgentProjectionInput,
    resolved: ResolvedProjectionSession,
    action: Extract<NativeAgentSessionAction, { kind: "steer" }>,
  ): Promise<NativeAgentSessionActionOutcome>;
}

/**
 * The session controls a native tab offers that are not a prompt dispatch:
 * Stop and its abort ladder, background-task stop, suggested prompts, the
 * resume list, resume (and closing the session it replaced), fork, session and
 * MCP actions, sign-in, composer controls and interaction answers.
 *
 * It owns no state. Stop's fences live on `NativeAgentPromptQueueDispatcher`,
 * every cache it invalidates or refreshes on `NativeAgentTranscriptProjection`.
 * Steer stays on the service with the persisted-steer dispatch it shares with
 * the prompt queue.
 */
export class NativeAgentSessionOperations {
  constructor(private readonly host: NativeAgentSessionOperationsHost) {}

  async stopProjectionSession(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    return this.host.promptQueues.withSessionMutationIntent(input, () =>
      this.stopProjectionSessionWithIntent(input),
    );
  }

  private async stopProjectionSessionWithIntent(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) return null;
    const providerSessionId = resolved.session.providerSessionId;
    // Mark the active turn before stopping it: a stopped turn reads as idle,
    // and an observer must never mistake it for one that finished on its own.
    // A prompt the provider has not accepted yet (Pi's startup) is the turn
    // being stopped; it joins `dispatchedRequestIds` only once accepted.
    const inFlight = resolved.session.pendingDispatch;
    const requestId =
      inFlight && !inFlight.mailRefused
        ? inFlight.requestId
        : resolved.session.dispatchedRequestIds?.at(-1);
    let recordingInterrupt: Promise<void> | undefined;
    if (requestId) {
      const before = await resolved.provider
        .status(providerSessionId)
        .catch(() => "running" as const);
      // A live background task can keep status running after the turn released input.
      const released =
        (before === "running" || before === "blocked") && resolved.provider.observeActivity
          ? await resolved.provider
              .observeActivity(providerSessionId)
              .then((activity) => activity.readyForInput === true)
              .catch(() => false)
          : false;
      if ((before === "running" || before === "blocked") && !released) {
        this.host.promptQueues.fenceTurnInterrupt(resolved.key, providerSessionId, requestId);
        // Not awaited before the abort. A dispatch the provider has not
        // acknowledged holds this session's storage queue until it does, so
        // the write waits out exactly the startup the stop has to reach. The
        // in-memory fence above classifies the turn as interrupted meanwhile,
        // as it does when the write fails.
        recordingInterrupt = this.host.storage
          .recordNativeAgentTurnInterrupt(resolved.key, providerSessionId, requestId)
          .then(
            (persisted) => {
              if (persisted) this.host.promptQueues.releaseTurnInterrupt(resolved.key, requestId);
            },
            () => {
              console.warn(
                "[native-agent] Turn interrupt persistence failed; automatic publication remains fenced",
              );
            },
          );
      }
    }
    // Abort can stop transport and still fail during provider cleanup. Always
    // check authoritative status and finish the stop ladder before surfacing it.
    const stopErrors: unknown[] = [];
    try {
      await resolved.provider.abort(providerSessionId);
    } catch (error) {
      stopErrors.push(error);
    }
    const graceMs = Math.max(0, this.host.options.abortGraceMs ?? 5_000);
    const deadline = this.host.now() + graceMs;
    let status = await resolved.provider.status(providerSessionId).catch(() => "running" as const);
    while ((status === "running" || status === "blocked") && this.host.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, deadline - this.host.now())),
      );
      status = await resolved.provider.status(providerSessionId).catch(() => "running" as const);
    }
    const stoppedGracefully = status !== "running" && status !== "blocked";
    let hardAbortAttempted = false;
    if (!stoppedGracefully && resolved.provider.hardAbort) {
      hardAbortAttempted = true;
      try {
        await resolved.provider.hardAbort(providerSessionId);
      } catch (error) {
        stopErrors.push(error);
      }
    }
    await recordingInterrupt;
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    this.host.projections.recordStopNotice(
      sessionKey,
      stoppedGracefully
        ? "The turn stopped after a graceful interrupt."
        : hardAbortAttempted
          ? "The turn did not stop within the grace period and a force-stop was requested."
          : "The turn did not stop within the grace period; this provider has no force-stop action.",
    );
    const projection = await this.host.projections.refreshProjection(input, true);
    if (stopErrors.length > 0) throw stopErrors[0];
    return projection;
  }

  async stopProjectionBackgroundTask(
    input: NativeAgentProjectionInput & { taskId: string },
  ): Promise<NativeAgentSessionProjection | null> {
    if (!nonBlank(input.taskId)) throw new Error("Background task ID must not be blank");
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) return null;
    if (!resolved.provider.stopBackgroundTask) {
      throw new Error(`${input.agent} does not support background tasks`);
    }
    await resolved.provider.stopBackgroundTask(resolved.session.providerSessionId, input.taskId);
    return this.host.projections.refreshProjection(input, true);
  }

  async dismissProjectionSuggestedPrompt(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) return null;
    if (!resolved.provider.dismissSuggestedPrompt) {
      throw new Error(`${input.agent} does not support prompt suggestions`);
    }
    await resolved.provider.dismissSuggestedPrompt(resolved.session.providerSessionId);
    return this.host.projections.refreshProjection(input, true);
  }

  /**
   * Take a conversation out of this tab's resume list, or put it back. Never
   * the tab's own conversation, which is not in its list; the provider keeps
   * the history either way.
   */
  async setProjectionResumableSessionArchived(
    input: NativeAgentProjectionInput & { resumableSessionId: string; archived: boolean },
  ): Promise<void> {
    this.host.assertProjectionInput(input);
    if (!nativeCapabilities(input.agent).actions?.archive) {
      throw new Error(`${input.agent} cannot archive conversations`);
    }
    const provider = await this.host.provider(input);
    if (!provider.setResumableSessionArchived) {
      throw new Error(`${input.agent} cannot archive conversations`);
    }
    await provider.setResumableSessionArchived(input.resumableSessionId, input.archived);
  }

  async listProjectionResumableSessions(
    input: NativeAgentProjectionInput & { includeArchived?: boolean },
  ): Promise<NativeAgentResumeEntry[]> {
    this.host.assertProjectionInput(input);
    if (!nativeCapabilities(input.agent).resume) return [];
    const provider = await this.host.provider(input);
    if (!provider.listResumableSessions) {
      throw new Error(`${input.agent} does not support session resume`);
    }
    /*
     * Ordered here rather than in each picker: providers return their own order
     * (OpenCode's is creation order), so the session the user most likely wants
     * was not necessarily at the top. Unknown timestamps sink to the bottom
     * instead of sorting as 1970.
     */
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const current = await this.host.storage.getNativeAgentSession(sessionKey);
    const [entries, currentState] = await Promise.all([
      provider.listResumableSessions(
        input.includeArchived && nativeCapabilities(input.agent).actions?.archive
          ? { includeArchived: true }
          : undefined,
      ),
      current?.providerSessionId && provider.sessionStateSnapshot
        ? provider.sessionStateSnapshot(current.providerSessionId).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const currentResumableSessionId =
      currentState?.resumableSessionId ?? current?.providerSessionId;
    const activityAt = (entry: NativeAgentResumeEntry) => {
      const raw = entry.updatedAt ?? entry.createdAt;
      const parsed = raw ? Date.parse(raw) : Number.NaN;
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    return entries
      .filter((entry) => entry.sessionId !== currentResumableSessionId)
      .sort(
        // Archived rows go last, so they can never crowd a live one past the cap.
        (left, right) =>
          Number(left.archived === true) - Number(right.archived === true) ||
          activityAt(right) - activityAt(left),
      )
      .slice(0, 512);
  }

  async resumeProjectionSession(
    input: NativeAgentProjectionInput & {
      providerSessionId: string;
      controls?: NativeAgentControlUpdate;
    },
  ): Promise<NativeAgentSessionProjection | null> {
    this.host.assertProjectionInput(input);
    if (!nonBlank(input.providerSessionId)) {
      throw new Error("Native agent resume session ID must not be blank");
    }
    if (!nativeCapabilities(input.agent).resume) {
      throw new Error(`${input.agent} does not support session resume`);
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const existing = await this.host.storage.getNativeAgentSession(key);
    const trustedInput = await this.host.trustedSessionInput({
      ...input,
      origin: existing?.origin ?? "interactive-native",
      interactionPolicy: existing?.interactionPolicy ?? INTERACTIVE_AGENT_INTERACTION_POLICY,
      executionPolicy: undefined,
      policy: undefined,
    });
    const provider = await this.host.provider(trustedInput);
    if (!provider.resumeSession) {
      throw new Error(`${input.agent} does not support session resume`);
    }
    this.host.projections.invalidateProjection(key);
    // Wait for any last-owner close before reopening the conversation. Adoption
    // takes the same fence and rechecks liveness before publishing its mapping.
    const resumeAndAdopt = async () => {
      const id = await withProviderSessionTeardownLock(
        this.host.storage,
        input.environmentId,
        input.agent,
        input.providerSessionId,
        () => provider.resumeSession!(input.providerSessionId, input.controls, trustedInput.policy),
      );
      await this.host.adoptSession({
        ...trustedInput,
        providerSessionId: id,
        expectedProviderSessionId: existing?.providerSessionId,
        controls: input.controls,
        model: input.controls?.modelId,
        reasoningEffort: input.controls?.reasoningId,
        sessionMode: input.controls?.mode,
        fastMode: input.controls?.fastMode,
      });
      return id;
    };
    let resumedId: string;
    try {
      resumedId = await resumeAndAdopt();
    } catch (error) {
      // A last-owner close can take the fence between the reopen and the
      // adoption, which then finds the session missing. That close has
      // finished by then, so one more reopen recovers the conversation.
      if (!(error instanceof NativeAgentProviderSessionMissingError)) throw error;
      resumedId = await resumeAndAdopt();
    }
    const replacedId = existing?.providerSessionId;
    const closingReplaced =
      replacedId && replacedId !== resumedId
        ? this.closeReplacedSession(provider, input.environmentId, input.agent, replacedId)
        : undefined;
    // The close runs beside the projection refresh; the resume answers once both settle.
    return this.host.projections.refreshProjection(input, true).finally(() => closingReplaced);
  }

  /**
   * Close the session a resume replaced, which the tab no longer shows. A new
   * tab is given an empty session before its resume picker opens, so without
   * this every resume leaves one behind; for Grok, an agent process holding
   * an `ACP_MAX_SESSIONS` slot that nothing reaps. Same last-owner rules and
   * lock as tab teardown. The close keeps the vendor conversation.
   *
   * Never throws: the resume already succeeded. The close is journaled
   * first as a teardown intent (`replacedSessionCloseIntent`) and cleared
   * once it is confirmed, so a close that stays pending, times out or is cut
   * short by a backend exit is replayed by `reconcile_tab_teardowns` under
   * the same rules. An environment the journal cannot hold (a coordinator
   * runtime) still gets the one best-effort close.
   */
  private async closeReplacedSession(
    provider: NativeAgentRuntimeProvider,
    environmentId: string,
    agent: NativeAgentProjectionInput["agent"],
    providerSessionId: string,
  ): Promise<void> {
    try {
      await withProviderSessionTeardownLock(
        this.host.storage,
        environmentId,
        agent,
        providerSessionId,
        async () => {
          if (!provider.closeSession) return;
          const heldElsewhere = await providerSessionHeldElsewhere(this.host.storage, {
            environmentId,
            agent,
            providerSessionId,
          });
          if (heldElsewhere) return;
          const intent = replacedSessionCloseIntent(agent, providerSessionId);
          const journaled = await this.host.storage
            .setTabTeardownIntent(environmentId, intent)
            .then(
              () => true,
              () => false,
            );
          await provider.closeSession(providerSessionId);
          if (journaled) {
            await this.host.storage.clearTabTeardownIntent(
              environmentId,
              intent.tabId,
              intent.createdAt,
            );
          }
        },
      );
    } catch (error) {
      console.warn(
        `[native-agent] The ${agent} session a resume replaced was not closed:`,
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }

  async forkProjectionSession(
    input: NativeAgentProjectionInput & { messageId?: string },
  ): Promise<NativeAgentForkOutcome> {
    if (!nativeCapabilities(input.agent).fork) {
      throw new Error(`${input.agent} does not support session forks`);
    }
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) throw new Error("Native agent session was not found");
    if (!resolved.provider.forkSession) {
      throw new Error(`${input.agent} does not support session forks`);
    }
    const projection = await this.host.getProjection(input);
    const composer = projection?.composer;
    const outcome = await resolved.provider.forkSession(
      resolved.session.providerSessionId,
      input.messageId,
    );
    try {
      this.host.options.changeTracking?.()?.noteFork({
        environmentId: resolved.session.environmentId,
        provider: input.agent,
        parentLogicalSessionKey: resolved.session.logicalSessionKey,
        childProviderSessionId: outcome.sessionId,
      });
    } catch {
      // Lineage is best effort; the child still gets its own fresh baseline.
    }
    return {
      ...outcome,
      controls: {
        ...resolved.session.controls,
        ...(composer?.selectedModelId ? { modelId: composer.selectedModelId } : {}),
        ...(composer?.selectedReasoningId ? { reasoningId: composer.selectedReasoningId } : {}),
        ...outcome.controls,
      },
    };
  }

  async performProjectionAction(
    input: NativeAgentProjectionInput & { action: NativeAgentSessionAction },
  ): Promise<NativeAgentSessionActionOutcome> {
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) throw new Error("Native agent session was not found");
    if (
      resolved.session.executionPolicy === "coordinator-read-only" &&
      ["rewind-files", "undo", "redo"].includes(input.action.kind)
    ) {
      throw new Error("Read-only coordinator sessions cannot change project files");
    }
    const capability = {
      compact: "compact",
      "rewind-files": "rewindFiles",
      undo: "undo",
      redo: "redo",
      share: "share",
      unshare: "share",
      steer: "steer",
      review: "review",
      "rewind-messages": "rewindMessages",
      "switch-branch": "branches",
    }[input.action.kind] as keyof NonNullable<NativeAgentCapabilities["actions"]>;
    if (!nativeCapabilities(input.agent).actions?.[capability]) {
      throw new Error(`${input.agent} does not support ${input.action.kind}`);
    }
    if (!resolved.provider.performSessionAction) {
      throw new Error(`${input.agent} does not support ${input.action.kind}`);
    }
    if (input.action.kind === "steer") {
      return this.host.performProjectionSteer(input, resolved, input.action);
    }
    const outcome = await resolved.provider.performSessionAction(
      resolved.session.providerSessionId,
      input.action,
    );
    this.host.projections.invalidateProjection(resolved.key);
    return outcome;
  }

  async performProjectionMcpAction(
    input: NativeAgentProjectionInput & {
      serverId: string;
      action: NativeAgentMcpServerAction;
    },
  ): Promise<{ url?: string }> {
    if (!nonBlank(input.serverId)) throw new Error("MCP server ID must not be blank");
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) throw new Error("Native agent session was not found");
    if (!resolved.provider.mcpServerAction) {
      throw new Error(`${input.agent} does not support MCP server actions`);
    }
    const outcome = await resolved.provider.mcpServerAction(
      resolved.session.providerSessionId,
      input.serverId,
      input.action,
    );
    this.host.projections.invalidateProjection(resolved.key);
    return outcome;
  }

  /**
   * Read the provider's account on demand. Deliberately uncached and absent from
   * the projection: an account read can reach the provider's auth service, and
   * the projection is rebuilt on every session change.
   */
  async readProjectionAuthStatus(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentAuthStatus | null> {
    const provider = await this.host.provider(input);
    return provider.authStatus ? provider.authStatus() : null;
  }

  async beginProjectionSignIn(
    input: NativeAgentProjectionInput & { deviceCode?: boolean },
  ): Promise<{ url?: string; code?: string }> {
    const provider = await this.host.provider(input);
    if (!provider.beginSignIn) throw new Error(`${input.agent} does not support sign-in here`);
    // A browser sign-in redirects to the agent's loopback, which no browser
    // reaches inside a container or, per the client, on another machine.
    const environment = await this.host.storage.getEnvironment(input.environmentId);
    const deviceCode =
      input.deviceCode === true || environment?.environmentType === "containerized";
    const outcome = await provider.beginSignIn(deviceCode ? { deviceCode: true } : undefined);
    this.host.projections.invalidateProjection(
      nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
    );
    return outcome;
  }

  /** Abandon an in-tab sign-in; a platform without cancel has nothing to release. */
  async cancelProjectionSignIn(input: NativeAgentProjectionInput): Promise<{ cancelled: boolean }> {
    this.host.assertProjectionInput(input);
    try {
      const provider = await this.host.observeProvider(input);
      return provider?.cancelSignIn ? await provider.cancelSignIn() : { cancelled: false };
    } finally {
      this.host.projections.invalidateProjection(
        nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
      );
    }
  }

  async signOutProjectionProvider(input: NativeAgentProjectionInput): Promise<void> {
    const provider = await this.host.provider(input);
    if (!provider.signOut) throw new Error(`${input.agent} does not support sign-out here`);
    await provider.signOut();
    this.host.projections.invalidateProjection(
      nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
    );
  }
  async updateProjectionControls(
    input: NativeAgentProjectionInput & { update: NativeAgentControlUpdate },
  ): Promise<NativeAgentSessionProjection | null> {
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) return null;
    const current = await this.host.projections.refreshProjection(input, true);
    const composer = current?.composer;
    if (input.update.modelId !== undefined) {
      if (
        !composer?.models.some(
          (model: NativeAgentComposerState["models"][number]) => model.id === input.update.modelId,
        )
      ) {
        throw new Error("Native agent model selection is invalid");
      }
    }
    if (input.update.reasoningId !== undefined) {
      const modelId = input.update.modelId ?? composer?.selectedModelId;
      const model =
        composer?.models.find(
          (candidate: NativeAgentComposerState["models"][number]) => candidate.id === modelId,
        ) ?? composer?.models[0];
      if (
        !model?.reasoning?.some(
          (option: NonNullable<NativeAgentComposerState["models"][number]["reasoning"]>[number]) =>
            option.id === input.update.reasoningId,
        )
      ) {
        throw new Error("Native agent reasoning selection is invalid");
      }
    }
    if (input.update.parameterValues !== undefined) {
      const modelId = input.update.modelId ?? composer?.selectedModelId;
      const model =
        composer?.models.find(
          (candidate: NativeAgentComposerState["models"][number]) => candidate.id === modelId,
        ) ?? composer?.models[0];
      for (const [parameterId, value] of Object.entries(input.update.parameterValues)) {
        const parameter = model?.parameters?.find((candidate) => candidate.id === parameterId);
        if (!parameter || typeof value !== (parameter.kind === "toggle" ? "boolean" : "string")) {
          throw new Error(`Native agent parameter ${parameterId} is invalid`);
        }
        if (
          parameter.kind === "select" &&
          !parameter.options?.some((option) => option.id === value)
        ) {
          throw new Error(`Native agent parameter ${parameterId} selection is invalid`);
        }
      }
    }
    if (input.update.persistDefaults && composer?.persistedDefaults !== true) {
      throw new Error("This provider cannot persist composer defaults");
    }
    if (input.update.fastMode !== undefined && composer?.fastModeAvailable !== true) {
      throw new Error("Native agent fast mode is unavailable");
    }
    if (
      input.update.mode !== undefined &&
      !composer?.modes.some(
        (mode: NativeAgentComposerState["modes"][number]) => mode.id === input.update.mode,
      )
    ) {
      throw new Error("Native agent conversation mode is invalid");
    }
    if (
      input.update.executionProfileId !== undefined &&
      input.update.executionProfileId !== null &&
      !composer?.executionProfiles?.some(
        (profile: NonNullable<NativeAgentComposerState["executionProfiles"]>[number]) =>
          profile.id === input.update.executionProfileId,
      ) &&
      // An empty list means the provider's agent listing failed or has not
      // arrived, not that the id is wrong — the compose bar still has to offer
      // Plan/Build there, and a 400 would strand the user on whichever agent
      // the session happened to start with. Only the two built-in ids are
      // exempt: anything else is unverifiable *and* unguessable, and it is
      // forwarded verbatim as the provider's `agent` name.
      !(
        (composer?.executionProfiles?.length ?? 0) === 0 &&
        isFallbackExecutionProfileId(input.update.executionProfileId)
      )
    ) {
      throw new Error("Native agent execution profile is invalid");
    }
    if (
      input.update.approvalMode !== undefined &&
      !composer?.approvalModes?.some(
        (mode) => mode.id === input.update.approvalMode && !mode.disabled,
      )
    ) {
      throw new Error("Native agent approval mode is invalid");
    }
    const capabilities = nativeCapabilities(input.agent).composer;
    if (input.update.includeLocalSettings !== undefined && !capabilities.localSettings) {
      throw new Error("Native agent local settings are unavailable");
    }
    if (input.update.promptSuggestions !== undefined && !capabilities.promptSuggestions) {
      throw new Error("Native agent prompt suggestions are unavailable");
    }
    await this.host.storage.updateNativeAgentSessionControls(
      resolved.key,
      resolved.session.providerSessionId,
      input.update,
      async () => {
        await resolved.provider.updateInteractiveControls?.(
          resolved.session.providerSessionId,
          // Leaving Plan restores the session's existing approval mode.
          input.update.mode === "build" && input.update.approvalMode === undefined
            ? { ...input.update, approvalMode: composer?.selectedApprovalModeId }
            : input.update,
        );
      },
    );
    return this.host.projections.refreshProjection(input, true);
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
    const resolved = await this.host.resolveProjectionSession(input);
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
    // Observers must re-read instead of reporting an answered question as pending.
    this.host.interactions.forgetPendingInteractions(resolved.key);
    void this.host.projections.refreshProjection(input, true).catch(() => undefined);
    return outcome;
  }

  /**
   * The card's "Approve and remember" (todo 0723): answers the request
   * allow-once and saves the Orkestrator rule the user chose. Only reachable
   * from a person's click in the renderer; no agent, CLI or MCP surface
   * creates a rule.
   */
  async approveProjectionInteractionAndRemember(
    input: NativeAgentProjectionInput & { interactionId: string; choice: PermissionRuleChoice },
  ): Promise<{
    outcome: AgentInteractionApplyOutcome;
    rule?: import("@orkestrator/protocol/permission-rules").NativeAgentPermissionRule;
    ruleSaveWarning?: string;
  }> {
    if (!nonBlank(input.interactionId)) {
      throw new Error("Native agent interaction ID must not be blank");
    }
    if (!this.host.permissionRules) throw new Error("Permission rules are unavailable");
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) {
      throw new Error("Native agent session was not found");
    }
    const result = await this.host.permissionRules.approveAndRemember(
      resolved.session,
      resolved.provider,
      input.interactionId,
      input.choice,
    );
    this.host.interactions.forgetPendingInteractions(resolved.key);
    void this.host.projections.refreshProjection(input, true).catch(() => undefined);
    return result;
  }

  /**
   * Pause or resume an interaction's countdown. The request stays pending, but
   * its deadline moved: cached pending reads are dropped and the projection
   * refreshed so every client sees the new state.
   */
  async holdProjectionInteraction(
    input: NativeAgentProjectionInput & { interactionId: string; held: boolean },
  ): Promise<AgentInteractionApplyOutcome> {
    if (!nonBlank(input.interactionId)) {
      throw new Error("Native agent interaction ID must not be blank");
    }
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) {
      throw new Error("Native agent session was not found");
    }
    const interactions = resolved.provider.interactions;
    if (!interactions?.holdInteraction) {
      return {
        result: "rejected",
        interactionId: input.interactionId,
        sessionId: resolved.session.providerSessionId,
        revision: 0,
      };
    }
    const outcome = await interactions.holdInteraction(
      resolved.session.providerSessionId,
      input.interactionId,
      input.held,
    );
    this.host.interactions.forgetPendingInteractions(resolved.key);
    void this.host.projections.refreshProjection(input, true).catch(() => undefined);
    return outcome;
  }
}
