import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2/types";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import { isKnownOpenCodeEvent } from "./opencode-events.js";
import { openCodeExecutionProfiles } from "./opencode-execution-profiles.js";
import {
  boundedOpenCodeMessageHistory,
  findOpenCodeMessageId,
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
  OpenCodeMessageIdCoordinator,
  openCodeRequestMarker,
} from "@orkestrator/protocol/opencode-message-id";
import {
  AGENT_INTERACTION_LIMITS,
  type AgentInteractionKind,
} from "@orkestrator/protocol/agent-interactions";
import type {
  AgentModel,
  NativeAgentComposerState,
  NativeAgentContextUsage,
  NativeAgentControlUpdate,
  NativeAgentExecutionPolicy,
  NativeAgentForkOutcome,
  NativeAgentRuntimeSummary,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";
import { EMPTY_NATIVE_AGENT_COMPOSER_STATE } from "@orkestrator/protocol/native-agent";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  parseLeadingSlashCommand,
  type ParsedSlashCommand,
} from "@orkestrator/protocol/agent-slash-commands";
import {
  AmbiguousPromptDispatchError,
  type AgentInteractionProviderCapability,
  type BridgeConnection,
  type NativeAgentRuntimeProvider,
  PromptRejectedError,
  type ProviderActivityState,
  type ProviderCreateSessionOptions,
  type ProviderDispatchStatus,
  type ProviderInteractiveSnapshot,
  type ProviderInteractionObservationEvent,
  type ProviderSendOptions,
  type ProviderSessionRegistration,
  type ProviderStatus,
  ProviderUnavailableError,
  type ProviderRuntimeHealth,
} from "./agent-provider-contract.js";
import {
  asRecord,
  assertSdkResponse,
  InteractionSnapshotTracker,
  INTERACTIVE_RUNTIME_METADATA_TTL_MS,
  isTransientHttpStatus,
  MAX_TRACKED_INTERACTION_SESSIONS,
  MAX_TRACKED_PROVIDER_INTERACTIONS,
  nonEmptyString,
  providerInventoryCount,
  serializedByteLength,
  setBoundedMapEntry,
  setBoundedSetEntry,
} from "./agent-provider-runtime.js";
import {
  normalizeOpenCodeComposerCatalog,
  openCodeCatalogCacheKey,
  openCodeModelDispatchability,
  selectOpenCodeComposerCatalog,
} from "./opencode-model-catalog.js";
import {
  collectNormalizedOpenCodeSubagentIds,
  collectRawOpenCodeSubagentIds,
  hydrateNormalizedOpenCodeSubagents,
  normalizeOpenCodeInteractiveMessage,
  normalizeOpenCodeTerminalState,
  openCodeStructuredPrompt,
  parseOpenCodeStructuredText,
} from "./opencode-messages.js";
import { boundedOwnedOpenCodeCollection } from "./opencode-snapshots.js";
import { OpenCodeInteractionAdapter } from "./opencode-interactions.js";
import { OpenCodeSessionLifecycle } from "./opencode-session-lifecycle.js";
import { OpenCodeCapabilities } from "./opencode-capabilities.js";
import { openCodeContextUsage } from "./opencode-usage.js";
import { OpenCodeStreamState } from "./opencode-stream-state.js";
import {
  DEFAULT_MONITOR_RETRY_MS,
  DEFAULT_OPENCODE_EXISTENCE_CACHE_TTL_MS,
  effectiveOpenCodePolicy,
  openCodeAgentFor,
  listOpenCodeResumableSessions,
  type OpenCodeProviderDependencies,
  OPENCODE_COMMAND_NAME_TTL_MS,
  OPENCODE_SUBAGENT_FETCH_CONCURRENCY,
  OPENCODE_SUBAGENT_MAX_SESSIONS,
  OPENCODE_SUBAGENT_MESSAGE_LIMIT,
  openCodeFileParts,
  openCodeMessageIdScope,
  openCodeModelSelection,
  openCodePermissionRules,
  openCodePromptParts,
  openCodeReasoningVariant,
  openCodeRequestOptions,
  optionalOpenCodeSdkCall,
  resolveAllowedOpenCodeModelProviders,
  waitForOpenCodeRetry,
} from "./opencode-provider-helpers.js";

const defaultOpenCodeMessageIds = new OpenCodeMessageIdCoordinator();
export type { OpenCodeProviderDependencies } from "./opencode-provider-helpers.js";

export class OpenCodeProvider implements NativeAgentRuntimeProvider {
  readonly agent = "opencode" as const;
  private readonly client: OpencodeClient;
  private readonly messageIds: OpenCodeMessageIdCoordinator;
  private readonly interactionTracker = new InteractionSnapshotTracker();
  private readonly interactionAdapter: OpenCodeInteractionAdapter;
  readonly interactions: AgentInteractionProviderCapability = {
    listPendingInteractions: (sessionId) =>
      this.interactionAdapter.listPendingInteractions(sessionId),
    resolveInteraction: (sessionId, interactionId, resolution) =>
      this.interactionAdapter.resolveInteraction(sessionId, interactionId, resolution),
  };
  private readonly lifecycle: OpenCodeSessionLifecycle;
  private readonly capabilitiesAdapter: OpenCodeCapabilities;
  private readonly interactiveMetadata = new Map<
    string,
    {
      expiresAt: number;
      providersKey: string;
      executionProfiles: NonNullable<NativeAgentComposerState["executionProfiles"]>;
      runtime: NativeAgentRuntimeSummary;
      models: AgentModel[];
      selectedModelId?: string;
      selectedReasoningId?: string;
      title?: string;
      shareUrl?: string | null;
    }
  >();
  private catalogMetadata: {
    expiresAt: number;
    providersKey: string;
    catalog: ReturnType<typeof normalizeOpenCodeComposerCatalog>;
  } | null = null;
  private commandNames: { names: Set<string>; expiresAt: number } | null = null;
  private readonly blockedSessions = new Set<string>();
  private readonly failedQuestionSessions = new Set<string>();
  private readonly sessionPolicies = new Map<string, NativeAgentExecutionPolicy>();
  private readonly monitorController = new AbortController();
  private readonly monitorRetryMs: number;
  private readonly now: () => number;
  private readonly answeringRequestIds = new Set<string>();
  private readonly requestTasks = new Set<Promise<void>>();
  /**
   * SSE event types this provider had no branch for.
   *
   * Shared across sessions because the subscription is: one stream serves the
   * whole OpenCode server, so drift is a property of the connection rather than
   * of any one session.
   */
  private readonly health = new RuntimeHealthRecorder();
  private readonly streamState = new OpenCodeStreamState();
  private activeStreamController: AbortController | null = null;
  private reconciliation: Promise<void> | null = null;
  private streamReconciliation: Promise<void> | null = null;
  private monitorPromise: Promise<void>;
  private disposed = false;
  private readonly autoAnswerRequests: boolean;
  private readonly onInteractionObservation?: (
    event: ProviderInteractionObservationEvent,
  ) => void | Promise<void>;
  private readonly resolveOpenCodeModelProviders?: () =>
    | readonly string[]
    | undefined
    | Promise<readonly string[] | undefined>;

  constructor(
    private readonly connection: BridgeConnection,
    dependencies: OpenCodeProviderDependencies,
  ) {
    const basic = Buffer.from(`opencode:${connection.authToken}`).toString("base64");
    const createClient = dependencies.openCodeClientFactory ?? createOpencodeClient;
    this.client =
      dependencies.openCodeClient ??
      createClient({
        baseUrl: connection.baseUrl,
        directory: connection.directory,
        headers: {
          Authorization: `Basic ${basic}`,
          "X-Orkestrator-OpenCode-Token": connection.authToken,
        },
      });
    this.messageIds = dependencies.openCodeMessageIdCoordinator ?? defaultOpenCodeMessageIds;
    this.capabilitiesAdapter = new OpenCodeCapabilities(this.client, connection.directory, () =>
      this.requestOptions(),
    );
    this.interactionAdapter = new OpenCodeInteractionAdapter(
      this.client,
      connection.directory,
      () => this.requestOptions(),
      this.interactionTracker,
    );
    this.monitorRetryMs = Math.max(1, dependencies.monitorRetryMs ?? DEFAULT_MONITOR_RETRY_MS);
    this.now = dependencies.now ?? Date.now;
    this.lifecycle = new OpenCodeSessionLifecycle(
      this.client,
      connection.directory,
      this.now,
      Math.max(
        1,
        dependencies.openCodeExistenceCacheTtlMs ?? DEFAULT_OPENCODE_EXISTENCE_CACHE_TTL_MS,
      ),
      () => this.requestOptions(),
      dependencies.openCodeStatusReconcileIntervalMs,
    );
    this.autoAnswerRequests = dependencies.autoAnswerRequests === true;
    this.onInteractionObservation = dependencies.onInteractionObservation;
    this.resolveOpenCodeModelProviders = dependencies.resolveOpenCodeModelProviders;
    this.monitorPromise = this.monitorRequests();
  }

  registerSession(sessionId: string, interaction?: ProviderSessionRegistration): void {
    this.lifecycle.ownedSessions.add(sessionId);
    this.streamState.register(sessionId);
    this.interactionTracker.register(sessionId, interaction);
    if (!this.autoAnswerRequests) return;
    const activeReconciliation = this.reconciliation;
    const reconciliation = activeReconciliation
      ? activeReconciliation.catch(() => undefined).then(() => this.reconcilePendingRequests())
      : this.reconcilePendingRequests();
    void reconciliation.catch(() => {
      // The reconnect loop will try again. Registration must stay synchronous
      // so restoring a pipeline does not block on an external service.
    });
  }

  private async optionalSdkCall(
    namespace: string,
    method: string,
    parameters: Record<string, unknown>,
  ): Promise<unknown> {
    return optionalOpenCodeSdkCall(
      this.client,
      this.requestOptions(),
      namespace,
      method,
      parameters,
    );
  }

  private allowedModelProviders(): Promise<readonly string[]> {
    return resolveAllowedOpenCodeModelProviders(this.resolveOpenCodeModelProviders);
  }

  private async readComposerCatalog(
    allowedProviders: readonly string[],
    requireConnected: boolean,
    priorityProviders: readonly string[] = [],
  ): Promise<ReturnType<typeof normalizeOpenCodeComposerCatalog>> {
    const providersKey = openCodeCatalogCacheKey(
      allowedProviders,
      requireConnected,
      priorityProviders,
    );
    if (
      this.catalogMetadata &&
      this.catalogMetadata.expiresAt > Date.now() &&
      this.catalogMetadata.providersKey === providersKey
    ) {
      return this.catalogMetadata.catalog;
    }
    const [providerResult, fallbackResult] = await Promise.allSettled([
      this.optionalSdkCall("provider", "list", {}),
      this.optionalSdkCall("config", "providers", {}),
    ]);
    const payload = (result: PromiseSettledResult<unknown>): unknown =>
      result.status === "fulfilled" ? (asRecord(result.value)?.data ?? {}) : {};
    const catalog = selectOpenCodeComposerCatalog(
      payload(providerResult),
      () => payload(fallbackResult),
      allowedProviders,
      { requireConnected, priorityProviders },
    );
    this.catalogMetadata = {
      expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
      providersKey,
      catalog,
    };
    return catalog;
  }

  /**
   * `promptAsync` returns before OpenCode resolves the requested model. When a
   * provider is disconnected, OpenCode can therefore accept and persist only
   * the user message, publish a transient error, and leave the session idle.
   * Preflight the live connectivity snapshot so that failure is definitive and
   * no apparently stuck turn is created.
   *
   * The preflight only ever *rejects* on the positive signal it exists for: a
   * catalogue that was read successfully and that reports the selected model's
   * provider as not connected. An unreadable catalogue — a thrown transport
   * error, a timeout, an error envelope, or a build that does not serve
   * `/provider` — is no evidence about the model, so dispatch proceeds. Failing
   * closed there would let one flaky read on a *secondary* endpoint block every
   * prompt, which is strictly worse than the stuck turn this guards against;
   * `readComposerCatalog` tolerates the same call failing for the same reason.
   */
  private async assertSelectedModelAvailable(model: string | undefined): Promise<void> {
    if (!model || !model.includes("/")) return;
    const provider = asRecord(asRecord(this.client)?.provider);
    if (typeof provider?.list !== "function") return;

    let response: unknown;
    try {
      response = await (
        provider.list as (parameters: Record<string, unknown>, options: unknown) => Promise<unknown>
      ).call(provider, {}, this.requestOptions());
    } catch {
      return;
    }
    const envelope = asRecord(response);
    if (envelope?.error) return;
    const allowedProviders = await this.allowedModelProviders();
    const catalog = normalizeOpenCodeComposerCatalog(envelope?.data ?? {}, allowedProviders, {
      requireConnected: true,
    });
    // The preflight is fresher than the composer cache, so publish it into both
    // cache layers: a rejected send immediately removes the stale choice.
    // Publishing a degenerate read would instead suppress the `config.providers`
    // fallback for a whole TTL, so it is held to the same bar
    // `readComposerCatalog` applies before it accepts a live catalogue.
    if (catalog.connectedProviderIds !== undefined || catalog.models.length > 0) {
      this.catalogMetadata = {
        expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
        providersKey: openCodeCatalogCacheKey(allowedProviders, true),
        catalog,
      };
      this.interactiveMetadata.clear();
    }
    // Judged unfiltered: the allowlist governs what the picker offers, not what
    // OpenCode can serve, and an unreported connectivity set still dispatches.
    if (openCodeModelDispatchability(envelope?.data ?? {}, model) !== "unavailable") return;
    throw new PromptRejectedError(
      "The selected OpenCode model is not connected or is no longer available. Choose an available model and retry.",
    );
  }

  async modelCatalog(): Promise<AgentModel[]> {
    return (await this.readComposerCatalog(await this.allowedModelProviders(), true)).models;
  }

  async rawModelCatalog(): Promise<AgentModel[]> {
    // The empty allowlist has the documented provider-filter meaning of
    // unrestricted, while `normalizeOpenCodeComposerCatalog` still enforces
    // its provider/model bounds before this reaches persistent storage.
    // Connectivity is deliberately not applied either: this catalogue backs the
    // durable cache, which must still offer a provider the user authenticates
    // after it was written.
    //
    // The allowlist is still passed, as an ordering priority rather than a
    // filter. Unrestricted means the bounds are spent on whichever providers
    // OpenCode happens to list first, which on a real catalogue of thousands of
    // models truncated the managed pair out entirely — leaving every read of
    // this catalogue, filtered or not, with no selectable model at all.
    return (await this.readComposerCatalog([], false, await this.allowedModelProviders())).models;
  }

  private async monitorRequests(): Promise<void> {
    while (!this.disposed) {
      try {
        const streamController = new AbortController();
        this.activeStreamController = streamController;
        const response = await this.client.event.subscribe(
          { directory: this.connection.directory },
          {
            signal: AbortSignal.any([this.monitorController.signal, streamController.signal]),
          },
        );
        if (!response || !("stream" in response)) {
          throw new Error("OpenCode returned no event stream");
        }
        let startupError: unknown;
        const startup = Promise.all([
          this.reconcileStreamState(),
          ...(this.autoAnswerRequests ? [this.reconcilePendingRequests()] : []),
        ]).catch((error) => {
          startupError = error;
          if (this.activeStreamController === streamController) streamController.abort();
        });
        for await (const raw of response.stream as AsyncIterable<unknown>) {
          if (this.disposed) return;
          this.dispatchRequest(raw);
        }
        await startup;
        if (startupError) throw startupError;
        if (this.activeStreamController === streamController) {
          this.activeStreamController = null;
        }
      } catch (error) {
        if (this.disposed || this.monitorController.signal.aborted) return;
        console.warn(
          "[opencode-provider] Request monitor reconnecting:",
          error instanceof Error ? error.name : "unknown error",
        );
        this.activeStreamController?.abort();
      }
      this.streamState.markGap();
      this.lifecycle.invalidateEvents();
      try {
        await waitForOpenCodeRetry(this.monitorRetryMs, this.monitorController.signal);
      } catch {
        return;
      }
    }
  }

  private dispatchRequest(raw: unknown): void {
    if (this.requestTasks.size >= MAX_TRACKED_PROVIDER_INTERACTIONS) {
      // Force snapshot reconciliation instead of silently dropping an
      // authoritative request event when the bounded worker set is full.
      console.warn("[opencode-provider] Request worker limit reached");
      this.activeStreamController?.abort();
      return;
    }
    const task = this.handleRequest(raw)
      .catch((error) => {
        if (this.disposed || this.monitorController.signal.aborted) return;
        console.warn(
          "[opencode-provider] Request handling failed:",
          error instanceof Error ? error.name : "unknown error",
        );
        this.activeStreamController?.abort();
      })
      .finally(() => {
        this.requestTasks.delete(task);
      });
    this.requestTasks.add(task);
  }

  private async handleRequest(raw: unknown): Promise<void> {
    const event =
      raw && typeof raw === "object"
        ? (raw as { type?: unknown; properties?: Record<string, unknown> })
        : {};
    // Before any session filtering: an event type this provider does not know
    // is drift regardless of whose session it belonged to, and the session
    // filter below would otherwise hide every new type on someone else's
    // session. Names only — `properties` carries prompts and file contents.
    if (typeof event.type !== "string" || !isKnownOpenCodeEvent(event.type)) {
      this.health.recordUnknown(typeof event.type === "string" ? event.type : "(untyped)");
      return;
    }
    const properties = event.properties ?? {};
    const rawSessionId =
      typeof properties.sessionID === "string" ? properties.sessionID : undefined;
    const globalEvent =
      event.type === "mcp.tools.changed" ||
      event.type === "server.connected" ||
      event.type === "server.instance.disposed" ||
      event.type === "global.disposed";
    if (globalEvent || (rawSessionId && this.lifecycle.ownedSessions.has(rawSessionId))) {
      const effect = this.streamState.apply(event as OpenCodeEvent);
      if (effect.status && effect.sessionId) {
        this.lifecycle.observeEvent(effect.sessionId, effect.status);
      }
      if (effect.refreshMcp) {
        this.interactiveMetadata.clear();
      }
      if (effect.refreshInteractions) {
        await this.interactionAdapter
          .listPendingInteractions(effect.refreshInteractions)
          .catch(() => undefined);
      }
      if (effect.reconnect) {
        this.interactiveMetadata.clear();
        this.lifecycle.invalidateEvents();
        this.activeStreamController?.abort();
        return;
      }
    }
    const requestId = typeof properties.id === "string" ? properties.id : undefined;
    const sessionId = rawSessionId;
    if (!sessionId || !this.lifecycle.ownedSessions.has(sessionId)) return;
    if (requestId && requestId.length > AGENT_INTERACTION_LIMITS.maxIdLength) return;

    const observedKind: AgentInteractionKind | null =
      event.type === "permission.asked"
        ? "permission"
        : event.type === "question.asked"
          ? "question"
          : null;

    const observe = async (
      state: ProviderInteractionObservationEvent["state"],
      providerState?: ProviderInteractionObservationEvent["providerState"],
    ): Promise<void> => {
      if (!requestId || !observedKind) return;
      await this.onInteractionObservation?.({
        sessionId,
        interactionId: requestId,
        kind: observedKind,
        registration: this.interactionTracker.registration(sessionId),
        state,
        providerState,
      });
    };

    if (!this.autoAnswerRequests) return;
    if (event.type === "question.replied") {
      this.blockedSessions.delete(sessionId);
      this.failedQuestionSessions.delete(sessionId);
      return;
    }
    if (event.type === "question.rejected") {
      this.blockedSessions.delete(sessionId);
      setBoundedSetEntry(this.failedQuestionSessions, sessionId, MAX_TRACKED_INTERACTION_SESSIONS);
      return;
    }
    if (!requestId || this.answeringRequestIds.has(requestId)) return;

    this.answeringRequestIds.add(requestId);
    try {
      if (event.type === "permission.asked") {
        await observe("detected").catch(() => undefined);
        const response = await this.client.permission.reply(
          {
            requestID: requestId,
            directory: this.connection.directory,
            reply: "reject",
          },
          this.requestOptions(),
        );
        assertSdkResponse(response, "OpenCode permission response");
        await observe("withdrawn", "error").catch(() => undefined);
      } else if (event.type === "question.asked") {
        // The owner persists the fail-closed terminal outcome before the
        // upstream question is removed. If persistence fails, leave the
        // request pending so a restart cannot silently advance the workflow.
        this.blockedSessions.add(sessionId);
        await observe("detected");
        // No cleanup on failure: the request may still be live and
        // user-resolvable, so the session stays blocked and the
        // reconnect/reconciliation loop retries the fail-closed reject.
        const response = await this.client.question.reject(
          {
            requestID: requestId,
            directory: this.connection.directory,
          },
          this.requestOptions(),
        );
        assertSdkResponse(response, "OpenCode question rejection");
        this.blockedSessions.delete(sessionId);
        // Terminal, not blocked. The rejection is delivered, so the supervisor
        // must stop parking on it — this set is what unparks it, and is
        // deliberately *not* conditional on the interaction policy. Whether a
        // refusal fails the workflow or merely declines one request is decided
        // by the pipeline that owns the session, from
        // `agentInteractionPolicyAction`; gating this here instead would leave
        // a declined session parked forever.
        setBoundedSetEntry(
          this.failedQuestionSessions,
          sessionId,
          MAX_TRACKED_INTERACTION_SESSIONS,
        );
        await observe("withdrawn", "error").catch(() => undefined);
      }
    } finally {
      this.answeringRequestIds.delete(requestId);
    }
  }

  private async reconcilePendingRequests(): Promise<void> {
    if (!this.reconciliation) {
      this.reconciliation = this.reconcilePendingRequestsNow().finally(() => {
        this.reconciliation = null;
      });
    }
    return this.reconciliation;
  }

  private async reconcileStreamState(): Promise<void> {
    if (!this.streamReconciliation) {
      this.streamReconciliation = this.reconcileStreamStateNow().finally(() => {
        this.streamReconciliation = null;
      });
    }
    return this.streamReconciliation;
  }

  private async reconcileStreamStateNow(): Promise<void> {
    if (this.disposed) return;
    const sessionIds = Array.from(this.lifecycle.ownedSessions);
    if (sessionIds.length === 0) return;
    this.streamState.markGap();
    this.interactiveMetadata.clear();
    await this.lifecycle.readSessionLifecycle(sessionIds, true, true);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (!this.disposed) {
        const sessionId = sessionIds[cursor++];
        if (!sessionId) return;
        try {
          const eventVersion = this.streamState.eventVersion(sessionId);
          const messages = [
            ...boundedOpenCodeMessageHistory(
              await this.readMessagesSnapshot(sessionId, OPEN_CODE_MESSAGE_HISTORY_LIMIT),
              { count: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
            ),
          ];
          this.streamState.replaceMessages(sessionId, messages, eventVersion);
        } catch {
          // The dirty flag remains set. The next projection read retries the
          // authoritative snapshot instead of exposing a partial event tail.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, sessionIds.length) }, () => worker()));
  }

  private async reconcilePendingRequestsNow(): Promise<void> {
    if (this.disposed || this.lifecycle.ownedSessions.size === 0) return;
    const [permissions, questions] = await Promise.all([
      this.client.permission.list({ directory: this.connection.directory }, this.requestOptions()),
      this.client.question.list({ directory: this.connection.directory }, this.requestOptions()),
    ]);
    assertSdkResponse(permissions, "OpenCode pending permission read");
    assertSdkResponse(questions, "OpenCode pending question read");
    const pendingPermissions = boundedOwnedOpenCodeCollection(
      permissions.data,
      this.lifecycle.ownedSessions,
      "OpenCode pending permission read",
    );
    const pendingQuestions = boundedOwnedOpenCodeCollection(
      questions.data,
      this.lifecycle.ownedSessions,
      "OpenCode pending question read",
    );
    if (
      serializedByteLength([pendingPermissions, pendingQuestions]) >
      AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
    ) {
      throw new ProviderUnavailableError("OpenCode interaction snapshot is oversized");
    }
    for (const request of pendingPermissions) {
      await this.handleRequest({ type: "permission.asked", properties: request });
    }
    for (const request of pendingQuestions) {
      await this.handleRequest({ type: "question.asked", properties: request });
    }
  }

  async createSession(
    _phase: string,
    label: string,
    options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    try {
      const effectivePolicy = options.policy ? effectiveOpenCodePolicy(options.policy) : undefined;
      const permission = effectivePolicy ? openCodePermissionRules(effectivePolicy) : undefined;
      const response = await this.client.session.create(
        { title: label, ...(permission ? { permission } : {}) },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode session creation");
      if (!response.data?.id) throw new Error("OpenCode returned an empty session");
      this.lifecycle.rememberExistingSession(response.data.id);
      this.registerSession(response.data.id, options.interaction);
      if (effectivePolicy) this.sessionPolicies.set(response.data.id, effectivePolicy);
      return response.data.id;
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode session creation is unavailable", {
        cause: error,
      });
    }
  }

  async send(sessionId: string, prompt: string, options: ProviderSendOptions): Promise<void> {
    const shapedPrompt = options.schema ? openCodeStructuredPrompt(prompt, options.schema) : prompt;
    const parts = openCodePromptParts(shapedPrompt, options);
    const selectedModel = options.model ?? this.connection.model;
    const model = openCodeModelSelection(selectedModel);
    const variant = openCodeReasoningVariant(options, this.connection.effort);
    // Validate the caller-owned marker locally before consulting OpenCode.
    openCodeRequestMarker(options.requestId);
    await this.assertSelectedModelAvailable(selectedModel);
    // A submission that names one of OpenCode's commands runs as that command
    // rather than as prompt text the model has to interpret. Only interactive
    // dispatch opts in: a workflow prompt that happens to start with a slash
    // must keep reaching the model verbatim.
    const command = options.allowProviderCommands
      ? await this.resolveProviderCommand(shapedPrompt)
      : null;
    const scope = openCodeMessageIdScope(this.connection, sessionId);
    await this.messageIds.runExclusive(scope, async () => {
      // The bounded newest transcript recovers an accepted ambiguous dispatch
      // after a restart. In-memory reservations cover the gap before OpenCode
      // materializes a just-accepted user message.
      let history: readonly unknown[];
      try {
        const historyResponse = await this.client.session.messages(
          { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
          this.requestOptions(),
        );
        assertSdkResponse(historyResponse, "OpenCode pre-dispatch transcript read");
        history = boundedOpenCodeMessageHistory(historyResponse.data);
      } catch (error) {
        throw new ProviderUnavailableError("OpenCode pre-dispatch transcript is unavailable", {
          cause: error,
        });
      }
      const messageID = this.messageIds.resolve(scope, history, options.requestId);
      let response;
      try {
        response = command
          ? await this.client.session.command(
              {
                sessionID: sessionId,
                directory: this.connection.directory,
                messageID,
                command: command.name.replace(/^\//, ""),
                // `arguments` is a *required* field on the server's command request
                // body, so a bare `/init` must still send an empty string. Passing
                // `undefined` drops the key in `JSON.stringify` and the server
                // answers 400, which the caller reads as a failed dispatch.
                arguments: command.arguments ?? "",
                model: options.model ?? this.connection.model,
                agent: openCodeAgentFor(this.sessionPolicies.get(sessionId), options),
                variant,
                // Text became the command name and its arguments; only the files
                // survive as parts.
                parts: openCodeFileParts(parts),
              },
              this.requestOptions(),
            )
          : await this.client.session.promptAsync(
              {
                sessionID: sessionId,
                directory: this.connection.directory,
                messageID,
                parts,
                model,
                agent: openCodeAgentFor(this.sessionPolicies.get(sessionId), options, "build"),
                variant,
              },
              this.requestOptions(),
            );
      } catch (error) {
        // The request may have reached OpenCode before the response was lost.
        // The reservation keeps the same ID until transcript reconciliation.
        throw new AmbiguousPromptDispatchError("OpenCode prompt dispatch outcome is unknown", {
          cause: error,
        });
      }
      if ("error" in response && response.error) {
        const status = response.response?.status;
        if (
          status === 404 ||
          status === 409 ||
          (status !== undefined && isTransientHttpStatus(status))
        ) {
          throw new ProviderUnavailableError(
            `OpenCode prompt dispatch is temporarily unavailable (HTTP ${status})`,
          );
        }
        throw new PromptRejectedError("OpenCode rejected the prompt");
      }
      this.messageIds.markAccepted(scope, options.requestId);
    });
  }

  async dispatchStatus(sessionId: string, requestId: string): Promise<ProviderDispatchStatus> {
    try {
      // Fail closed before asking OpenCode. The marker parser is the same
      // validation used by send(), so a malformed caller-owned id can never
      // accidentally match provider history.
      openCodeRequestMarker(requestId);
      const response = await this.client.session.messages(
        { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode dispatch transcript read");
      const history = boundedOpenCodeMessageHistory(response.data);
      return findOpenCodeMessageId(history, requestId) ? "dispatched" : "unknown";
    } catch {
      // A failed, malformed, or oversized transcript read is not evidence that
      // the prompt did or did not run. Only the exact durable marker above is
      // allowed to clear a pending dispatch.
      return "unknown";
    }
  }

  async status(sessionId: string): Promise<ProviderStatus> {
    if (this.blockedSessions.has(sessionId)) return "blocked";
    if (this.failedQuestionSessions.has(sessionId)) return "error";
    try {
      const lifecycle = (await this.lifecycle.readSessionLifecycle([sessionId], false, true)).get(
        sessionId,
      );
      if (!lifecycle) {
        throw new Error(`OpenCode lifecycle snapshot omitted ${sessionId}`);
      }
      if (lifecycle === "running") return "running";
      if (lifecycle === "idle" || lifecycle === "missing") return lifecycle;
      return "error";
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode status is unavailable", {
        cause: error,
      });
    }
  }

  async activity(sessionId: string): Promise<ProviderActivityState> {
    const activity = await this.activityBatch([sessionId]);
    const state = activity.get(sessionId);
    // `activityBatch` answers for every id it is given, so a gap is a broken
    // provider rather than a missing session. Defaulting to `missing` here
    // would turn that bug into a deleted session mapping.
    if (!state) {
      throw new ProviderUnavailableError(`OpenCode activity snapshot omitted ${sessionId}`);
    }
    return state;
  }

  async activityBatch(sessionIds: readonly string[]): Promise<Map<string, ProviderActivityState>> {
    try {
      const activity = new Map<string, ProviderActivityState>();
      const sessionIdsToRead = [...new Set(sessionIds)].filter((sessionId) => {
        if (!this.blockedSessions.has(sessionId)) return true;
        // A blocked session asked a question this provider will not answer, so
        // it is parked on a human. `status()` calls that `error` because a
        // pipeline must stop advancing on it; for the sidebar the honest
        // answer is `waiting`. `idle` is the one answer that is certainly
        // wrong — it retires the indicator on a turn nobody has resolved.
        activity.set(sessionId, "waiting");
        return false;
      });
      if (sessionIdsToRead.length === 0) return activity;

      const lifecycle = await this.lifecycle.readSessionLifecycle(sessionIdsToRead, true);

      const runningSessionIds = new Set<string>();
      for (const sessionId of sessionIdsToRead) {
        const state = lifecycle.get(sessionId);
        if (state === "missing") {
          activity.set(sessionId, "missing");
        } else if (state === "running") {
          runningSessionIds.add(sessionId);
        } else if (state) {
          activity.set(sessionId, "idle");
        } else {
          throw new ProviderUnavailableError(`OpenCode lifecycle snapshot omitted ${sessionId}`);
        }
      }
      if (runningSessionIds.size === 0) return activity;

      const [questions, permissions] = await Promise.all([
        this.client.question.list({ directory: this.connection.directory }, this.requestOptions()),
        this.client.permission.list(
          { directory: this.connection.directory },
          this.requestOptions(),
        ),
      ]);
      assertSdkResponse(questions, "OpenCode pending question read");
      assertSdkResponse(permissions, "OpenCode pending permission read");
      const pendingQuestions = boundedOwnedOpenCodeCollection(
        questions.data,
        runningSessionIds,
        "OpenCode pending question read",
      );
      const pendingPermissions = boundedOwnedOpenCodeCollection(
        permissions.data,
        runningSessionIds,
        "OpenCode pending permission read",
      );
      if (
        serializedByteLength([pendingQuestions, pendingPermissions]) >
        AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
      ) {
        throw new ProviderUnavailableError("OpenCode interaction snapshot is oversized");
      }
      const waitingSessionIds = new Set<string>();
      for (const request of [...pendingQuestions, ...pendingPermissions]) {
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          continue;
        }
        const sessionId = (request as { sessionID?: unknown }).sessionID;
        if (typeof sessionId === "string" && runningSessionIds.has(sessionId)) {
          waitingSessionIds.add(sessionId);
        }
      }
      for (const sessionId of runningSessionIds) {
        activity.set(sessionId, waitingSessionIds.has(sessionId) ? "waiting" : "working");
      }
      return activity;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError("OpenCode activity is unavailable", {
        cause: error,
      });
    }
  }

  readonly usageMessageLimit = OPEN_CODE_MESSAGE_HISTORY_LIMIT;

  usageFromMessages(messages: readonly unknown[]): NativeAgentContextUsage | undefined {
    return openCodeContextUsage(messages);
  }

  async messages(sessionId: string, options: { limit?: number } = {}): Promise<unknown[]> {
    try {
      const limit = options.limit;
      if (
        limit !== undefined &&
        (!Number.isSafeInteger(limit) || limit <= 0 || limit > OPEN_CODE_MESSAGE_HISTORY_LIMIT)
      ) {
        throw new RangeError("OpenCode transcript limit is invalid");
      }
      const messages = await this.readMessagesSnapshot(sessionId, limit);
      if (limit === undefined) return messages;
      return [...boundedOpenCodeMessageHistory(messages, { count: limit })];
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode transcript is unavailable", {
        cause: error,
      });
    }
  }

  private async projectedMessages(sessionId: string, limit: number): Promise<unknown[]> {
    const current = this.streamState.currentMessages(sessionId);
    if (current) return [...boundedOpenCodeMessageHistory(current, { count: limit })];
    const messages = await this.readMessagesSnapshot(sessionId, limit);
    this.streamState.replaceMessages(sessionId, messages);
    return [...boundedOpenCodeMessageHistory(messages, { count: limit })];
  }

  private async projectedStatus(sessionId: string): Promise<ProviderStatus> {
    if (this.blockedSessions.has(sessionId)) return "blocked";
    if (this.failedQuestionSessions.has(sessionId)) return "error";
    const lifecycle = (await this.lifecycle.readSessionLifecycle([sessionId], false)).get(
      sessionId,
    );
    if (lifecycle === "running") return "running";
    if (lifecycle === "idle" || lifecycle === "missing") return lifecycle;
    if (!lifecycle) {
      throw new ProviderUnavailableError(`OpenCode lifecycle snapshot omitted ${sessionId}`);
    }
    return "error";
  }

  private async readMessagesSnapshot(sessionId: string, limit?: number): Promise<unknown[]> {
    const response = await this.client.session.messages(
      { sessionID: sessionId, ...(limit === undefined ? {} : { limit }) },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode transcript read");
    return Array.isArray(response.data) ? response.data : [];
  }

  async interactiveSnapshot(sessionId: string): Promise<ProviderInteractiveSnapshot> {
    const [status, rawMessages, metadata] = await Promise.all([
      this.projectedStatus(sessionId),
      this.projectedMessages(sessionId, OPEN_CODE_MESSAGE_HISTORY_LIMIT),
      this.readInteractiveMetadata(sessionId),
    ]);
    const normalizedMessages = rawMessages.flatMap((message, index) => {
      const normalized = normalizeOpenCodeInteractiveMessage(message, index, (type) =>
        this.health.recordUnknown(`part:${type}`),
      );
      return normalized ? [normalized] : [];
    });
    const messages = await this.hydrateSubagentTranscripts(
      normalizedMessages,
      collectRawOpenCodeSubagentIds(rawMessages),
    );
    // OpenCode persists terminal errors on the final assistant message rather
    // than in its lifecycle snapshot. Normalize that provider detail here so
    // the shared projection can render the same durable terminal row for every
    // provider, including aborts initiated outside this renderer.
    const terminal = normalizeOpenCodeTerminalState(
      [...rawMessages].reverse().find((candidate) => Boolean(asRecord(asRecord(candidate)?.info))),
    );
    const streamNotices = this.streamState.notices(sessionId);
    const streamedError = streamNotices.find((notice) => notice.kind === "error");
    const latestUsage = openCodeContextUsage(rawMessages);
    return {
      status: terminal?.kind === "error" || streamedError ? "error" : status,
      messages,
      messagesComplete: rawMessages.length < OPEN_CODE_MESSAGE_HISTORY_LIMIT,
      ...(metadata.title ? { title: metadata.title } : {}),
      ...(metadata.shareUrl === undefined ? {} : { shareUrl: metadata.shareUrl }),
      composer: {
        ...EMPTY_NATIVE_AGENT_COMPOSER_STATE,
        models: metadata.models,
        ...(metadata.selectedModelId ? { selectedModelId: metadata.selectedModelId } : {}),
        ...(metadata.selectedReasoningId
          ? { selectedReasoningId: metadata.selectedReasoningId }
          : {}),
        executionProfiles: metadata.executionProfiles,
      },
      ...(latestUsage ? { contextUsage: latestUsage } : {}),
      ...(this.sessionPolicies.get(sessionId)
        ? { policy: this.sessionPolicies.get(sessionId) }
        : {}),
      runtime: metadata.runtime,
      providerRevision: this.streamState.revision(sessionId),
      ...([...(terminal ? [terminal] : []), ...streamNotices].length > 0
        ? { notices: [...(terminal ? [terminal] : []), ...streamNotices] }
        : {}),
      ...(terminal?.kind === "error" || streamedError
        ? {
            phase: "error" as const,
            error: terminal?.message ?? streamedError?.message ?? "OpenCode session failed",
          }
        : {}),
    };
  }

  /**
   * Bounded inventory, drift and diagnostics for one session.
   *
   * The inventory comes from the same cached fan-out the interactive snapshot
   * uses, so asking for health does not multiply SDK calls. A read that fails
   * answers empty rather than throwing: health is optional metadata, and the
   * authoritative liveness answer is the session status.
   */
  async runtimeHealth(sessionId: string): Promise<ProviderRuntimeHealth> {
    try {
      const metadata = await this.readInteractiveMetadata(sessionId);
      return { summary: metadata.runtime, notices: metadata.runtime.notices ?? [] };
    } catch {
      return { summary: {}, notices: [] };
    }
  }

  private async readInteractiveMetadata(sessionId: string): Promise<{
    executionProfiles: NonNullable<NativeAgentComposerState["executionProfiles"]>;
    runtime: NativeAgentRuntimeSummary;
    models: AgentModel[];
    selectedModelId?: string;
    selectedReasoningId?: string;
    title?: string;
    shareUrl?: string | null;
  }> {
    // Resolved before the cache is consulted: this entry carries a catalogue
    // filtered against a specific allowlist, and a settings edit must invalidate
    // it here as well as in `readComposerCatalog`.
    const allowedProviders = await this.allowedModelProviders();
    // Composer reads are picker-facing, so they carry the connectivity filter
    // and must key on it exactly as `readComposerCatalog` does.
    const providersKey = openCodeCatalogCacheKey(allowedProviders, true);
    const cached = this.interactiveMetadata.get(sessionId);
    if (cached && cached.expiresAt > Date.now() && cached.providersKey === providersKey) {
      return this.applyStreamMetadata(sessionId, cached);
    }

    const directory = this.connection.directory;
    const results = await Promise.allSettled([
      this.optionalSdkCall("app", "agents", { directory }),
      this.optionalSdkCall("app", "skills", { directory }),
      this.optionalSdkCall("mcp", "status", { directory }),
      this.optionalSdkCall("lsp", "status", { directory }),
      this.optionalSdkCall("formatter", "status", { directory }),
      this.optionalSdkCall("session", "todo", { sessionID: sessionId, directory }),
      this.optionalSdkCall("session", "diff", { sessionID: sessionId, directory }),
      this.optionalSdkCall("session", "get", { sessionID: sessionId, directory }),
      this.readComposerCatalog(allowedProviders, true),
    ]);
    const data = (index: number, fallback: unknown): unknown => {
      const result = results[index];
      return result?.status === "fulfilled" ? (asRecord(result.value)?.data ?? fallback) : fallback;
    };
    const executionProfiles = openCodeExecutionProfiles(data(0, []));
    const drift = this.health.drift();
    const notices = this.health.listNotices();
    const runtime: NativeAgentRuntimeSummary = {
      skills: providerInventoryCount(data(1, [])),
      mcpServers: providerInventoryCount(data(2, {})),
      lspServers: providerInventoryCount(data(3, [])),
      formatters: providerInventoryCount(data(4, [])),
      todos: providerInventoryCount(data(5, [])),
      files: providerInventoryCount(data(6, [])),
      // The event subscription serves the whole server, so drift observed on it
      // belongs to every session's panel rather than to one of them.
      ...(drift ? { drift } : {}),
      ...(notices.length > 0 ? { notices } : {}),
    };
    const sessionResult = results[7];
    const sessionData =
      sessionResult?.status === "fulfilled"
        ? asRecord(asRecord(sessionResult.value)?.data)
        : undefined;
    const title = nonEmptyString(sessionData?.title);
    const shareUrl =
      sessionResult?.status === "fulfilled"
        ? (nonEmptyString(asRecord(sessionData?.share)?.url) ?? null)
        : undefined;
    const catalogResult = results[8];
    const catalog = catalogResult?.status === "fulfilled" ? catalogResult.value : { models: [] };
    const entry = {
      expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
      providersKey,
      executionProfiles,
      runtime,
      models: catalog.models,
      ...(title ? { title } : {}),
      ...(shareUrl === undefined ? {} : { shareUrl }),
      ...(catalog.selectedModelId ? { selectedModelId: catalog.selectedModelId } : {}),
      ...(catalog.selectedReasoningId ? { selectedReasoningId: catalog.selectedReasoningId } : {}),
    };
    setBoundedMapEntry(
      this.interactiveMetadata,
      sessionId,
      entry,
      MAX_TRACKED_INTERACTION_SESSIONS,
    );
    return this.applyStreamMetadata(sessionId, entry);
  }

  private applyStreamMetadata<
    T extends {
      runtime: NativeAgentRuntimeSummary;
      title?: string;
    },
  >(sessionId: string, metadata: T): T {
    const title = this.streamState.title(sessionId);
    const runtime = { ...metadata.runtime, ...this.streamState.runtime(sessionId) };
    return {
      ...metadata,
      runtime,
      ...(title ? { title } : {}),
    };
  }

  private async hydrateSubagentTranscripts(
    rootMessages: Record<string, unknown>[],
    rootSubagentIds: readonly string[],
  ): Promise<Record<string, unknown>[]> {
    const queued = [
      ...new Set([...rootSubagentIds, ...collectNormalizedOpenCodeSubagentIds(rootMessages)]),
    ].slice(0, OPENCODE_SUBAGENT_MAX_SESSIONS);
    if (queued.length === 0) return rootMessages;
    const seen = new Set<string>();
    const children = new Map<string, Record<string, unknown>[]>();
    while (queued.length > 0 && seen.size < OPENCODE_SUBAGENT_MAX_SESSIONS) {
      const batch: string[] = [];
      while (
        queued.length > 0 &&
        batch.length < OPENCODE_SUBAGENT_FETCH_CONCURRENCY &&
        seen.size + batch.length < OPENCODE_SUBAGENT_MAX_SESSIONS
      ) {
        const candidate = queued.shift();
        if (candidate && !seen.has(candidate) && !batch.includes(candidate)) {
          batch.push(candidate);
        }
      }
      if (batch.length === 0) continue;
      const results = await Promise.allSettled(
        batch.map(async (childSessionId) => {
          const raw = await this.messages(childSessionId, {
            limit: OPENCODE_SUBAGENT_MESSAGE_LIMIT,
          });
          const messages = raw.flatMap((message, index) => {
            const normalized = normalizeOpenCodeInteractiveMessage(message, index, (type) =>
              this.health.recordUnknown(`part:${type}`),
            );
            return normalized ? [normalized] : [];
          });
          return { messages, nestedIds: collectRawOpenCodeSubagentIds(raw) };
        }),
      );
      for (let index = 0; index < batch.length; index += 1) {
        const childSessionId = batch[index]!;
        seen.add(childSessionId);
        const result = results[index];
        if (result?.status !== "fulfilled") continue;
        children.set(childSessionId, result.value.messages);
        for (const nestedId of new Set([
          ...result.value.nestedIds,
          ...collectNormalizedOpenCodeSubagentIds(result.value.messages),
        ])) {
          if (
            !seen.has(nestedId) &&
            !queued.includes(nestedId) &&
            seen.size + queued.length < OPENCODE_SUBAGENT_MAX_SESSIONS
          )
            queued.push(nestedId);
        }
      }
    }
    return hydrateNormalizedOpenCodeSubagents(rootMessages, children);
  }

  listResumableSessions() {
    return listOpenCodeResumableSessions(
      this.client,
      this.connection.directory,
      this.requestOptions(),
    );
  }

  refreshCatalog(): void {
    this.catalogMetadata = null;
    this.commandNames = null;
    this.interactiveMetadata.clear();
  }

  /**
   * Match a submission against the commands this runtime can execute.
   *
   * Discovery is only attempted for text that actually starts with a slash, and
   * the result is cached, so an ordinary prompt never pays for a command list.
   * A discovery failure resolves to "not a command": sending the text to the
   * model is recoverable, refusing the user's prompt is not.
   */
  private async resolveProviderCommand(prompt: string): Promise<ParsedSlashCommand | null> {
    const parsed = parseLeadingSlashCommand(prompt);
    if (!parsed) return null;
    let names =
      this.commandNames && this.commandNames.expiresAt > this.now()
        ? this.commandNames.names
        : null;
    if (!names) {
      try {
        names = new Set((await this.slashCommands()).map((command) => command.name.toLowerCase()));
        this.commandNames = {
          names,
          expiresAt: this.now() + OPENCODE_COMMAND_NAME_TTL_MS,
        };
      } catch {
        return null;
      }
    }
    return names.has(parsed.name) ? parsed : null;
  }

  slashCommands() {
    return this.capabilitiesAdapter.slashCommands();
  }

  mcpServers() {
    return this.capabilitiesAdapter.mcpServers();
  }

  mcpServerAction(
    _sessionId: string,
    serverId: string,
    action: Parameters<OpenCodeCapabilities["mcpServerAction"]>[1],
  ) {
    return this.capabilitiesAdapter.mcpServerAction(serverId, action);
  }

  authStatus() {
    return this.capabilitiesAdapter.authStatus();
  }

  setSessionTitle(sessionId: string, title: string) {
    return this.capabilitiesAdapter.setSessionTitle(sessionId, title);
  }

  async resumeSession(
    sessionId: string,
    _controls?: NativeAgentControlUpdate,
    policy?: NativeAgentExecutionPolicy,
  ): Promise<string> {
    const status = await this.status(sessionId);
    if (status === "missing") throw new PromptRejectedError("OpenCode session was not found");
    if (policy) {
      const effectivePolicy = effectiveOpenCodePolicy(policy);
      const response = await this.client.session.update(
        { sessionID: sessionId, permission: openCodePermissionRules(effectivePolicy) },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode resumed session policy update");
      this.sessionPolicies.set(sessionId, effectivePolicy);
    }
    this.lifecycle.rememberExistingSession(sessionId);
    return sessionId;
  }

  async forkSession(sessionId: string, messageId?: string): Promise<NativeAgentForkOutcome> {
    const response = await this.client.session.fork(
      {
        sessionID: sessionId,
        directory: this.connection.directory,
        ...(messageId ? { messageID: messageId } : {}),
      },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode session fork");
    const forked = asRecord(response.data);
    const forkedId = nonEmptyString(forked?.id);
    if (!forkedId) throw new ProviderUnavailableError("OpenCode returned a malformed fork");
    this.lifecycle.rememberExistingSession(forkedId);
    return {
      sessionId: forkedId,
      ...(typeof forked?.title === "string" ? { title: forked.title } : {}),
    };
  }

  async performSessionAction(
    sessionId: string,
    action: NativeAgentSessionAction,
  ): Promise<NativeAgentSessionActionOutcome> {
    try {
      if (action.kind === "compact") {
        const model = action.modelId?.trim();
        const split = model && model !== "default" ? model.indexOf("/") : -1;
        await this.client.session.summarize(
          {
            sessionID: sessionId,
            ...(split > 0
              ? {
                  providerID: model!.slice(0, split),
                  modelID: model!.slice(split + 1),
                }
              : {}),
            auto: false,
          },
          { ...this.requestOptions(), throwOnError: true },
        );
        return { outcome: "applied" };
      }
      if (action.kind === "undo") {
        await this.client.session.revert(
          {
            sessionID: sessionId,
            ...(action.messageId ? { messageID: action.messageId } : {}),
          },
          { ...this.requestOptions(), throwOnError: true },
        );
        return { outcome: "applied" };
      }
      if (action.kind === "redo") {
        await this.client.session.unrevert(
          { sessionID: sessionId },
          { ...this.requestOptions(), throwOnError: true },
        );
        return { outcome: "applied" };
      }
      if (action.kind === "share") {
        const response = await this.client.session.share(
          { sessionID: sessionId },
          { ...this.requestOptions(), throwOnError: true },
        );
        const share = asRecord(asRecord(response.data)?.share);
        this.interactiveMetadata.delete(sessionId);
        return {
          outcome: "applied",
          ...(typeof share?.url === "string" ? { shareUrl: share.url } : {}),
        };
      }
      if (action.kind === "unshare") {
        await this.client.session.unshare(
          { sessionID: sessionId },
          { ...this.requestOptions(), throwOnError: true },
        );
        this.interactiveMetadata.delete(sessionId);
        return { outcome: "applied" };
      }
    } catch (error) {
      throw new ProviderUnavailableError(`OpenCode ${action.kind} failed`, { cause: error });
    }
    throw new PromptRejectedError(`OpenCode does not support ${action.kind}`);
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    openCodeRequestMarker(requestId);
    let response;
    try {
      response = await this.client.session.messages(
        { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode structured-output read");
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode structured output is unavailable", {
        cause: error,
      });
    }
    if (!Array.isArray(response.data)) return null;
    let entries: readonly unknown[];
    try {
      entries = boundedOpenCodeMessageHistory(response.data);
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode structured output history is invalid", {
        cause: error,
      });
    }
    const providerMessageId = findOpenCodeMessageId(entries, requestId);
    if (!providerMessageId) return null;
    const assistant = [...entries].reverse().find((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const candidate = (entry as { info?: unknown }).info;
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        return false;
      }
      const info = candidate as { role?: unknown; parentID?: unknown };
      return info.role === "assistant" && info.parentID === providerMessageId;
    });
    if (!assistant) return null;
    const assistantRecord = assistant as {
      info: Record<string, unknown>;
      parts?: unknown;
    };
    const info = assistantRecord.info as {
      error?: unknown;
      structured?: unknown;
      time?: { completed?: unknown };
    };
    if (!info.time?.completed) return null;
    if (info.error) {
      return {
        ok: false,
        provider: "opencode",
        requestId,
        error: {
          code: "provider_error",
          message: "OpenCode did not produce a structured result",
          provider: "opencode",
          retryable: true,
        },
      };
    }
    let value: unknown;
    try {
      value =
        info.structured === undefined
          ? parseOpenCodeStructuredText(assistantRecord.parts)
          : info.structured;
    } catch {
      return {
        ok: false,
        provider: "opencode",
        requestId,
        error: {
          code: "malformed_output",
          message: "OpenCode did not produce a valid JSON result",
          provider: "opencode",
          retryable: true,
        },
      };
    }
    return {
      ok: true,
      provider: "opencode",
      requestId,
      value: value as T,
    };
  }

  async abort(sessionId: string): Promise<void> {
    try {
      const response = await this.client.session.abort(
        { sessionID: sessionId },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode abort");
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode abort is unavailable", {
        cause: error,
      });
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      const response = await this.client.session.delete(
        { sessionID: sessionId },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode session delete");
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode session delete is unavailable", {
        cause: error,
      });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.monitorController.abort();
    this.activeStreamController?.abort();
    await this.monitorPromise;
    await Promise.allSettled(this.requestTasks);
    this.lifecycle.clear();
    this.blockedSessions.clear();
    this.failedQuestionSessions.clear();
    this.answeringRequestIds.clear();
    this.requestTasks.clear();
    this.streamState.clear();
  }

  private requestOptions(): { signal: AbortSignal } {
    return openCodeRequestOptions(this.connection, this.monitorController.signal);
  }
}
