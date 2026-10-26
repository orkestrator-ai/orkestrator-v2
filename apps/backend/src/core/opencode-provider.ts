import { OpenCodeSessionPolicy } from "./opencode-session-policy.js";
import { createOpenCodeSdkClient, type OpencodeClient } from "./opencode-sdk-client.js";
import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2/types";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import type { ReconnectBackoff } from "@orkestrator/protocol/reconnect-backoff";
import {
  createOpenCodeMonitorBackoff,
  OpenCodeObservationStream,
  readOpenCodeActivityBatch,
} from "./opencode-observation-stream.js";
import { isKnownOpenCodeEvent } from "./opencode-events.js";
import {
  boundedOpenCodeMessageHistory,
  findOpenCodeMessageId,
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
  OpenCodeMessageIdCoordinator,
  openCodeRequestMarker,
} from "@orkestrator/protocol/opencode-message-id";
import type {
  AgentModel,
  NativeAgentContextUsage,
  NativeAgentControlUpdate,
  NativeAgentExecutionPolicy,
  NativeAgentForkOutcome,
  NativeAgentRuntimeSummary,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";
import { EMPTY_NATIVE_AGENT_COMPOSER_STATE } from "@orkestrator/protocol/native-agent";
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
  type ProviderSessionStateSnapshot,
  type ProviderPrepareDispatchOptions,
  type ProviderSendOptions,
  type ProviderCommandCatalogue,
  type ProviderCommandRefreshResult,
  type ProviderSessionRegistration,
  type ProviderStatus,
  ProviderUnavailableError,
  type ProviderRuntimeHealth,
} from "./agent-provider-contract.js";
import {
  asRecord,
  assertSdkResponse,
  InteractionSnapshotTracker,
  isTransientHttpStatus,
  MAX_TRACKED_INTERACTION_SESSIONS,
  MAX_TRACKED_PROVIDER_INTERACTIONS,
  nonEmptyString,
  setBoundedMapEntry,
} from "./agent-provider-runtime.js";
import { openCodeCatalogCacheKey, resolveOpenCodeDefaultModel } from "./opencode-model-catalog.js";
import {
  collectNormalizedOpenCodeSubagentIds,
  collectRawOpenCodeSubagentIds,
  hydrateNormalizedOpenCodeSubagents,
  normalizeOpenCodeTranscriptMessages,
  normalizeOpenCodeTerminalState,
  openCodeStructuredPrompt,
} from "./opencode-messages.js";
import {
  openCodeSessionStateSnapshot,
  openCodeTranscriptPage,
  openCodeTranscriptSnapshot,
  openCodeTranscriptSource,
  readOpenCodeMessages,
  type OpenCodeTranscriptPageOptions,
  type OpenCodeTranscriptSnapshotOptions,
} from "./opencode-snapshots.js";
import {
  OpenCodeDiscoveryMetadataCache,
  readOpenCodeDiscoveryFanOut,
  type OpenCodeDiscoveryCacheEntry,
  type OpenCodeDiscoveryMetadata as OpenCodeDiscoveryMetadataResult,
} from "./opencode-discovery-metadata.js";
import { OpenCodeInteractionAdapter } from "./opencode-interactions.js";
import { OpenCodeSessionLifecycle } from "./opencode-session-lifecycle.js";
import { OpenCodeCapabilities } from "./opencode-capabilities.js";
import { OpenCodeCatalogCache } from "./opencode-catalog-cache.js";
import {
  dispatchOpenCodeCommand,
  OpenCodeCommandRegistry,
  resolveOpenCodeCommandDispatch,
} from "./opencode-commands.js";
import { openCodeContextUsage } from "./opencode-usage.js";
import { OpenCodeStreamState } from "./opencode-stream-state.js";
import { openCodeCommandChangesFor, OpenCodeCommandChanges } from "./opencode-command-changes.js";
import { OpenCodeChangeEvidence } from "./opencode-change-evidence.js";
import { openCodeInstanceReload, type OpenCodeInstanceReload } from "./opencode-command-reload.js";
import {
  DEFAULT_OPENCODE_EXISTENCE_CACHE_TTL_MS,
  effectiveOpenCodePolicy,
  openCodeAgentFor,
  listOpenCodeResumableSessions,
  type OpenCodeProviderDependencies,
  openCodeCoordinatorAgent,
  openCodeRequestTimeoutMs,
  OPENCODE_SUBAGENT_FETCH_CONCURRENCY,
  OPENCODE_SUBAGENT_MAX_SESSIONS,
  OPENCODE_SUBAGENT_MESSAGE_LIMIT,
  openCodeFileParts,
  openCodeMessageIdScope,
  openCodeModelSelection,
  preflightOpenCodeModel,
  openCodePromptToolOptions,
  openCodePromptParts,
  openCodeReasoningVariant,
  openCodeRequestOptions,
  optionalOpenCodeSdkCall,
  resolveAllowedOpenCodeModelProviders,
  resolveOpenCodePromptModel,
  readOpenCodeComposerCatalog,
  waitForOpenCodeRetry,
} from "./opencode-provider-helpers.js";
import { OpenCodeReviewSessionPermissions } from "./opencode-review-session-permissions.js";
import { OpenCodeWorkflowResultBroker } from "./opencode-workflow-result-broker.js";
import { readOpenCodeStructuredOutput } from "./opencode-structured-output.js";
import { readOpenCodeTurnTerminalError } from "./opencode-turn-outcome.js";
import { OpenCodeActionRetryCoordinator } from "./opencode-action-retry.js";
import { reconcileOpenCodeStreamState } from "./opencode-stream-reconciliation.js";
import {
  openCodeRevertMarker,
  openCodeRevertNotice,
  withoutRevertedOpenCodeMessages,
  type OpenCodeRevertMarker,
} from "./opencode-revert.js";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";

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
  private readonly interactiveMetadata = new Map<string, OpenCodeDiscoveryCacheEntry>();
  private readonly discovery = new OpenCodeDiscoveryMetadataCache(this.interactiveMetadata, {
    read: (sessionId, providers, providersKey) =>
      readOpenCodeDiscoveryFanOut(sessionId, providers, providersKey, {
        optionalSdkCall: (group, method, args) =>
          this.optionalSdkCall(group as never, method as never, args as never),
        readComposerCatalog: (allowed, connectedOnly) => this.catalog.read(allowed, connectedOnly),
        drift: () => this.health.drift(),
        notices: () => this.health.listNotices(),
        directory: this.connection.directory,
      }),
    allowedProviders: () => this.allowedModelProviders(),
    // Composer reads are picker-facing, so they carry the connectivity filter
    // and must key on it exactly as `OpenCodeCatalogCache.read` does.
    cacheKey: (providers) => openCodeCatalogCacheKey(providers, true),
    applyStreamState: (sessionId, metadata) => this.applyStreamMetadata(sessionId, metadata),
    store: (sessionId, entry) =>
      setBoundedMapEntry(
        this.interactiveMetadata,
        sessionId,
        entry,
        MAX_TRACKED_INTERACTION_SESSIONS,
      ),
    now: () => Date.now(),
  });
  private readonly catalog = new OpenCodeCatalogCache((allowed, options) =>
    readOpenCodeComposerCatalog(this.client, this.requestOptions(), allowed, options),
  );
  private readonly commands: OpenCodeCommandRegistry;
  private readonly commandReload: OpenCodeInstanceReload;
  private readonly sessionPolicy: OpenCodeSessionPolicy;
  private readonly sessionPolicies = new Map<string, NativeAgentExecutionPolicy>();
  /** A coordinator's research tool ids; empty everywhere else. */
  private readonly researchTools: () => readonly string[];
  private readonly workflowResults: OpenCodeWorkflowResultBroker;
  private readonly reviewPermissions: OpenCodeReviewSessionPermissions;
  private readonly monitorController = new AbortController();
  /** One owner, one sequential wait: the loop below never arms two retries. */
  private readonly monitorBackoff: ReconnectBackoff;
  private readonly waitForMonitorRetry: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
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
  private readonly actionRetry: OpenCodeActionRetryCoordinator;
  /** Shell-call badges; absent when the worktree is not readable from here. */
  private readonly commandChanges?: OpenCodeCommandChanges;
  /** Change evidence; also feeds the shell probe its events, turns and releases. */
  readonly changeEvidence: OpenCodeChangeEvidence;
  readonly changeEvidenceSource = (id: string) => this.changeEvidence.connectionSource(id);
  private activeStreamController: AbortController | null = null;
  private streamReconciliation: Promise<void> | null = null;
  private monitorPromise: Promise<void>;
  private disposed = false;
  /** Stream liveness and wakeup hints for the backend observer (step 07). */
  private readonly observation: OpenCodeObservationStream;
  private readonly resolveOpenCodeModelProviders?: () =>
    | readonly string[]
    | undefined
    | Promise<readonly string[] | undefined>;

  constructor(
    private readonly connection: BridgeConnection,
    private readonly dependencies: OpenCodeProviderDependencies,
  ) {
    const basic = Buffer.from(`opencode:${connection.authToken}`).toString("base64");
    const createClient = dependencies.openCodeClientFactory ?? createOpenCodeSdkClient;
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
    this.researchTools = dependencies.coordinatorResearchToolIds ?? (() => []);
    this.sessionPolicy = new OpenCodeSessionPolicy(
      this.client,
      this.sessionPolicies,
      () => this.requestOptions(),
      this.researchTools,
      dependencies.ensureCoordinatorResearch,
    );
    this.reviewPermissions = new OpenCodeReviewSessionPermissions(
      this.client,
      connection.directory,
      () => this.requestOptions(),
      (sessionId, policy) => this.sessionPolicy.remember(sessionId, policy),
      this.researchTools,
    );
    this.workflowResults = new OpenCodeWorkflowResultBroker(
      this.client,
      connection.directory,
      () => this.requestOptions(),
      (sessionId, operation) =>
        this.messageIds.runExclusive(openCodeMessageIdScope(connection, sessionId), operation),
    );
    this.capabilitiesAdapter = new OpenCodeCapabilities(
      this.client,
      connection.directory,
      () => this.requestOptions(),
      () => this.allowedModelProviders(),
    );
    this.interactionAdapter = new OpenCodeInteractionAdapter(
      this.client,
      connection.directory,
      () => this.requestOptions(),
      this.interactionTracker,
    );
    this.now = dependencies.now ?? Date.now;
    this.monitorBackoff = createOpenCodeMonitorBackoff(dependencies, this.now);
    this.waitForMonitorRetry = dependencies.waitForMonitorRetry ?? waitForOpenCodeRetry;
    this.commandReload = openCodeInstanceReload(
      this.client,
      connection.directory,
      () => this.requestOptions(),
      () => {
        // Before the disposal event arrives: the next dispatch re-registers.
        this.workflowResults.invalidate();
        this.invalidateInteractiveMetadata();
        this.commands.reloaded();
      },
      () => this.invalidateResearch(),
    );
    this.commands = new OpenCodeCommandRegistry(
      () => this.capabilitiesAdapter.readCommands(),
      () => this.now(),
      undefined,
      this.commandReload,
    );
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
    this.observation = new OpenCodeObservationStream(dependencies.onObservationHint);
    this.actionRetry = new OpenCodeActionRetryCoordinator(
      connection,
      this.client,
      this.messageIds,
      this.streamState,
      this.lifecycle,
      this.workflowResults,
      this.reviewPermissions,
      () => this.requestOptions(),
      (sessionId) => this.observation.changed(sessionId),
    );
    this.resolveOpenCodeModelProviders = dependencies.resolveOpenCodeModelProviders;
    this.commandChanges = openCodeCommandChangesFor(
      connection.directory,
      dependencies.commandChanges,
      (sessionId) => this.streamState.touch(sessionId),
    );
    this.changeEvidence = OpenCodeChangeEvidence.forConnection(connection, this.commandChanges);
    this.monitorPromise = this.monitorRequests();
  }

  registerSession(sessionId: string, interaction?: ProviderSessionRegistration): void {
    this.lifecycle.ownedSessions.add(sessionId);
    this.streamState.register(sessionId);
    this.interactionTracker.register(sessionId, interaction);
    if (interaction?.reviewerSession) this.reviewPermissions.registerCandidate(sessionId);
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

  /** See {@link preflightOpenCodeModel}; a successful read also refreshes the catalogue. */
  private async assertSelectedModelAvailable(model: string | undefined): Promise<void> {
    await preflightOpenCodeModel({
      client: this.client,
      model,
      requestOptions: this.requestOptions(),
      allowedProviders: () => this.allowedModelProviders(),
      // Keep the effective default reservable even beyond the catalogue cap.
      defaultModelId: this.catalog.selectedModelId,
      publishCatalog: (catalog, allowedProviders) => {
        this.catalog.publish(catalog, allowedProviders);
        this.invalidateInteractiveMetadata();
      },
    });
  }

  async modelCatalog(): Promise<AgentModel[]> {
    return (await this.catalog.read(await this.allowedModelProviders(), true)).models;
  }

  /** Shares the read `rawModelCatalog` makes: connectivity is reported either way. */
  async connectedModelProviders(): Promise<string[] | undefined> {
    const catalog = await this.catalog.read([], false, await this.allowedModelProviders());
    return catalog.connectedProviderIds;
  }

  /** The effective default, from the same connected catalogue the picker reads. */
  async resolveDefaultModel(modelId: string | undefined) {
    const catalog = await this.catalog.read(await this.allowedModelProviders(), true);
    return resolveOpenCodeDefaultModel(modelId, catalog);
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
    return (await this.catalog.read([], false, await this.allowedModelProviders())).models;
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
            sseMaxRetryAttempts: 1,
          },
        );
        if (!response || !("stream" in response)) {
          throw new Error("OpenCode returned no event stream");
        }
        let receivedFrame = false;
        let startupError: unknown;
        const startup = this.reconcileStreamState().catch((error) => {
          startupError = error;
          if (this.activeStreamController === streamController) streamController.abort();
        });
        for await (const raw of response.stream as AsyncIterable<unknown>) {
          if (this.disposed) return;
          if (!receivedFrame) {
            receivedFrame = true;
            this.monitorBackoff.connected();
            this.observation.connected();
          }
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
      this.observation.lost();
      this.streamState.markGap();
      this.lifecycle.invalidateEvents();
      try {
        await this.waitForMonitorRetry(
          this.monitorBackoff.nextDelayMs(),
          this.monitorController.signal,
        );
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
    this.commandReload.observeEvent(event.type, properties);
    if (event.type === "server.instance.disposed" || event.type === "global.disposed") {
      this.invalidateResearch();
    }
    const rawSessionId =
      typeof properties.sessionID === "string" ? properties.sessionID : undefined;
    const globalEvent =
      event.type === "mcp.tools.changed" ||
      event.type === "server.connected" ||
      event.type === "server.instance.disposed" ||
      event.type === "global.disposed";
    const owned = Boolean(rawSessionId && this.lifecycle.ownedSessions.has(rawSessionId));
    // Tool starts and ends reach the probe in stream order, before any await.
    this.changeEvidence.observeScoped(event, this.lifecycle.ownedSessions);
    if (globalEvent || owned) {
      const effect = this.streamState.apply(event as OpenCodeEvent, this.now());
      if (effect.status && effect.sessionId) {
        this.lifecycle.observeStreamEvent(effect.sessionId, effect.status);
        this.observation.changed(effect.sessionId);
        this.actionRetry.observeStatus(effect.sessionId, effect.status);
      }
      if (effect.abortTurn && effect.sessionId) {
        this.actionRetry.requestAbort(effect.sessionId);
      }
      if (effect.refreshMcp) {
        this.invalidateInteractiveMetadata();
      }
      if (effect.refreshInteractions) {
        await this.interactionAdapter
          .listPendingInteractions(effect.refreshInteractions)
          .catch(() => undefined);
      }
      if (effect.reconnect) {
        this.observation.lost();
        this.workflowResults.invalidate();
        this.invalidateResearch();
        this.invalidateInteractiveMetadata();
        this.lifecycle.invalidateEvents();
        this.activeStreamController?.abort();
        return;
      }
    }
    if (rawSessionId && owned) this.observation.ownedEvent(event.type, rawSessionId);
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
    await reconcileOpenCodeStreamState({
      disposed: () => this.disposed,
      lifecycle: this.lifecycle,
      streamState: this.streamState,
      now: this.now,
      invalidateMetadata: () => this.invalidateInteractiveMetadata(),
      readMessages: (sessionId, limit) => this.readMessagesSnapshot(sessionId, limit),
      reconciled: (sessionId) => this.actionRetry.reconciled(sessionId),
    });
    // Recover idle edges lost across a stream gap; reload rechecks the directory.
    if (!this.disposed) this.commandReload.idleObserved();
  }

  async createSession(
    _phase: string,
    label: string,
    options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    return this.commandReload.withinDispatch(async () => {
      try {
        await this.dependencies.ensureCoordinatorResearch?.();
        const created = await this.reviewPermissions.createSession(label, options);
        this.lifecycle.rememberExistingSession(created.sessionId);
        this.registerSession(created.sessionId, options.interaction);
        if (created.policy) {
          this.sessionPolicy.remember(created.sessionId, created.policy);
        }
        return created.sessionId;
      } catch (error) {
        throw new ProviderUnavailableError("OpenCode session creation is unavailable", {
          cause: error,
        });
      }
    });
  }

  prepareDispatch(sessionId: string, options: ProviderPrepareDispatchOptions = {}): Promise<void> {
    return this.workflowResults.prepare(sessionId, options);
  }

  async send(sessionId: string, prompt: string, options: ProviderSendOptions): Promise<void> {
    await this.commandReload.withinPromptDispatch((commandDispatch) =>
      this.sendGated(sessionId, prompt, options, commandDispatch),
    );
  }

  private async sendGated(
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
    commandDispatch: () => void,
  ) {
    await this.dependencies.ensureCoordinatorResearch?.();
    const policy = this.sessionPolicies.get(sessionId);
    if (policy) await this.sessionPolicy.synchronize(sessionId, policy);
    await this.workflowResults.prepare(sessionId, {
      agentMcp: options.agentMcp,
      workflowResultTool: options.workflowResultTool,
    });
    const shapedPrompt = options.schema ? openCodeStructuredPrompt(prompt, options.schema) : prompt;
    const parts = openCodePromptParts(shapedPrompt, options);
    const selectedModel = await resolveOpenCodePromptModel(
      this.client,
      sessionId,
      options.model ?? this.connection.model,
      this.requestOptions(),
      () => this.resolveDefaultModel(undefined),
    );
    const model = openCodeModelSelection(selectedModel);
    const variant = openCodeReasoningVariant(options, this.connection.effort);
    openCodeRequestMarker(options.requestId);
    await this.assertSelectedModelAvailable(selectedModel);
    // A selected or typed OpenCode command runs through `session.command`.
    // Anything literal — workflow prompts included — keeps reaching the model.
    const command = await resolveOpenCodeCommandDispatch(
      this.commands,
      prompt,
      options,
      openCodeCoordinatorAgent(this.sessionPolicies.get(sessionId)),
    );
    const scope = openCodeMessageIdScope(this.connection, sessionId);
    await this.messageIds.runExclusive(scope, async () => {
      await this.actionRetry.guardSend(sessionId);
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
      const workflowTool = options.workflowResultTool;
      const reviewEnabled = await this.reviewPermissions.enableForTurn(sessionId, options);
      // Grant inside the lock; another provider may have owned the preceding turn.
      await this.workflowResults.begin(sessionId, options.requestId, workflowTool);
      const dispatchStartedAt = this.now();
      this.streamState.beginTurn(sessionId, dispatchStartedAt);
      this.actionRetry.beginTurn(sessionId);
      await this.changeEvidence.beginTurn(sessionId, messageID);
      let response;
      try {
        if (command) {
          commandDispatch();
          const outcome = await dispatchOpenCodeCommand({
            client: this.client,
            command,
            request: {
              sessionID: sessionId,
              directory: this.connection.directory,
              messageID,
              model: selectedModel,
              agent: openCodeAgentFor(this.sessionPolicies.get(sessionId), options),
              variant,
              parts: openCodeFileParts(parts),
            },
            signal: this.monitorController.signal,
            timeoutMs: openCodeRequestTimeoutMs(this.connection),
            dispatched: async () =>
              (await this.dispatchStatus(sessionId, options.requestId)) === "dispatched",
          });
          if (outcome.materialized) {
            this.messageIds.markAccepted(scope, options.requestId);
            return;
          }
          response = outcome.response;
        } else {
          response = await this.client.session.promptAsync(
            {
              sessionID: sessionId,
              directory: this.connection.directory,
              messageID,
              parts,
              model,
              agent: openCodeAgentFor(this.sessionPolicies.get(sessionId), options, "build"),
              variant,
              ...openCodePromptToolOptions(options, reviewEnabled),
            },
            this.requestOptions(),
          );
        }
      } catch (error) {
        // The request may have reached OpenCode before the response was lost.
        // The reservation keeps the same ID until transcript reconciliation.
        // Drop the dispatch clock so a later turn cannot inherit an abandoned stamp.
        this.streamState.rejectTurn(sessionId, dispatchStartedAt);
        throw new AmbiguousPromptDispatchError("OpenCode prompt dispatch outcome is unknown", {
          cause: error,
        });
      }
      if ("error" in response && response.error) {
        this.streamState.rejectTurn(sessionId, dispatchStartedAt);
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
        await this.workflowResults.settle(sessionId, options.requestId, () =>
          this.reviewPermissions.restoreIfNeeded(sessionId),
        );
        throw new PromptRejectedError(
          command
            ? `OpenCode could not run /${command.binding.name}`
            : "OpenCode rejected the prompt",
        );
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
    if (this.actionRetry.isPending(sessionId)) return "running";
    try {
      const lifecycle = (await this.lifecycle.readSessionLifecycle([sessionId], false, true)).get(
        sessionId,
      );
      if (!lifecycle) {
        throw new Error(`OpenCode lifecycle snapshot omitted ${sessionId}`);
      }
      if (lifecycle === "running") return "running";
      this.actionRetry.reconciled(sessionId);
      if (lifecycle === "missing") return "missing";
      if (lifecycle === "idle") return "idle";
      return "error";
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode status is unavailable", {
        cause: error,
      });
    }
  }

  readonly turnTerminalError = (sessionId: string, requestId: string) =>
    readOpenCodeTurnTerminalError(this.client, sessionId, requestId, this.requestOptions());

  async settleTurn(sessionId: string, requestId: string): Promise<boolean> {
    return this.workflowResults.settleCompleted(
      sessionId,
      requestId,
      () => this.status(sessionId),
      () => this.reviewPermissions.restoreIfNeeded(sessionId),
    );
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
    return readOpenCodeActivityBatch(sessionIds, {
      lifecycle: this.lifecycle,
      client: this.client,
      directory: this.connection.directory,
      requestOptions: () => this.requestOptions(),
    });
  }

  readonly usageMessageLimit = OPEN_CODE_MESSAGE_HISTORY_LIMIT;
  readonly messageReadLimit = OPEN_CODE_MESSAGE_HISTORY_LIMIT;

  usageFromMessages(messages: readonly unknown[]): NativeAgentContextUsage | undefined {
    const sessionId = messages
      .map((message) => nonEmptyString(asRecord(asRecord(message)?.info)?.sessionID))
      .find((value): value is string => value !== undefined);
    if (sessionId) return this.streamState.contextUsage(sessionId, messages);
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

  async transcriptSnapshot(sessionId: string, options: OpenCodeTranscriptSnapshotOptions) {
    return openCodeTranscriptSnapshot(this.transcriptSource(sessionId), options);
  }

  /** Older history from OpenCode's own `before` read; like the snapshot, no child hydration. */
  async transcriptPage(sessionId: string, options: OpenCodeTranscriptPageOptions) {
    return openCodeTranscriptPage(this.transcriptSource(sessionId), options);
  }

  private transcriptSource(sessionId: string) {
    return openCodeTranscriptSource(this.streamState, sessionId, {
      readMessages: (limit, before) => this.readMessagesSnapshot(sessionId, limit, before),
      recordUnknown: (type) => this.health.recordUnknown(`part:${type}`),
      revertMarker: () => this.revertMarker(sessionId),
      ...(this.commandChanges
        ? { commandChanges: () => this.commandChanges!.changes(sessionId) }
        : {}),
    });
  }

  /**
   * OpenCode's pending revert for a transcript read. `session.updated` and the
   * revert actions keep it current; after a stream gap, or before either has
   * been seen, it is read from the session. A failed read serves the marker
   * last seen and leaves it unknown, so the next read asks again.
   */
  private async revertMarker(sessionId: string): Promise<OpenCodeRevertMarker | undefined> {
    if (this.streamState.revertMarkerKnown(sessionId)) {
      return this.streamState.revertMarker(sessionId);
    }
    const version = this.streamState.revertVersion(sessionId);
    try {
      const response = await this.client.session.get(
        { sessionID: sessionId },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode session revert read");
      const session = asRecord(response.data);
      const marker = openCodeRevertMarker(session);
      if (session?.id === sessionId && (session.revert === undefined || marker)) {
        this.streamState.observeRevert(sessionId, marker, version);
      }
    } catch {
      // The transcript stays readable; only the marker is stale.
    }
    return this.streamState.revertMarker(sessionId);
  }

  /** An action response overtaken by another observation needs an authoritative reread. */
  private observeRevertResult(sessionId: string, session: unknown, version: number): void {
    const info = asRecord(session);
    const marker = openCodeRevertMarker(session);
    if (
      info?.id === sessionId &&
      (info.revert === undefined || marker) &&
      this.streamState.observeRevert(sessionId, marker, version)
    )
      return;
    // Keep the last observed marker while a later read resolves ambiguous ordering.
    this.streamState.invalidateRevert(sessionId);
  }

  async sessionStateSnapshot(sessionId: string): Promise<ProviderSessionStateSnapshot> {
    const eventVersionBefore = this.streamState.eventVersion(sessionId);
    const status = await this.projectedStatus(sessionId);
    const eventVersionAfter = this.streamState.eventVersion(sessionId);
    const notices = [
      ...this.actionRetry.notices(sessionId),
      ...openCodeRevertNotice(this.streamState.revertMarker(sessionId)),
    ];
    const streamedError = notices.some((notice) => notice.kind === "error");
    // The clock is authoritative only when a dispatch or an observed busy/retry
    // event set it. A read must never manufacture one, and an observation that
    // the turn is over ends it so a finished turn cannot be inherited. An idle
    // read is trusted only when no event arrived while it was in flight, and
    // only once a running observation has confirmed the turn.
    const running = status === "running" && !streamedError;
    const settled =
      streamedError ||
      ((status !== "idle" || this.streamState.isTurnConfirmed(sessionId)) &&
        eventVersionAfter === eventVersionBefore);
    if (running) {
      this.streamState.confirmTurn(sessionId);
    } else if (settled) {
      this.streamState.endTurn(sessionId);
    }
    const turnStartedAt = running ? this.streamState.turnStartedAt(sessionId) : undefined;
    const sessionModel = this.streamState.sessionModel(sessionId);
    return {
      ...openCodeSessionStateSnapshot({
        status,
        revision: this.streamState.revision(sessionId),
        ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
        title: this.streamState.title(sessionId),
        messages: this.streamState.usageMessages(sessionId).slice(-OPEN_CODE_MESSAGE_HISTORY_LIMIT),
        contextUsage: this.streamState.contextUsage(sessionId),
        policy: this.sessionPolicies.get(sessionId),
        runtime: this.streamState.runtime(sessionId),
        notices,
      }),
      commandCatalogueRevision: this.commands.revision,
      ...(sessionModel.modelId ? { sessionModelId: sessionModel.modelId } : {}),
      ...(sessionModel.reasoningId ? { sessionReasoningId: sessionModel.reasoningId } : {}),
      ...(await this.catalog.signInReadiness(() => this.allowedModelProviders())),
    };
  }

  private async projectedMessages(sessionId: string, limit: number): Promise<unknown[]> {
    const current = this.streamState.currentMessages(sessionId);
    if (current) return [...boundedOpenCodeMessageHistory(current.slice(-limit), { count: limit })];
    const messages = await this.readMessagesSnapshot(sessionId, limit);
    this.streamState.replaceMessages(sessionId, messages, undefined, limit);
    return [...boundedOpenCodeMessageHistory(messages.slice(-limit), { count: limit })];
  }

  private async projectedStatus(sessionId: string): Promise<ProviderStatus> {
    if (this.actionRetry.isPending(sessionId)) return "running";
    const lifecycle = (await this.lifecycle.readSessionLifecycle([sessionId], false)).get(
      sessionId,
    );
    if (lifecycle === "running") return "running";
    this.actionRetry.reconciled(sessionId);
    if (lifecycle === "idle" || lifecycle === "missing") return lifecycle;
    if (!lifecycle) {
      throw new ProviderUnavailableError(`OpenCode lifecycle snapshot omitted ${sessionId}`);
    }
    return "error";
  }

  private readMessagesSnapshot(sessionId: string, limit?: number, before?: string) {
    return readOpenCodeMessages(this.client, this.requestOptions(), sessionId, limit, before);
  }

  async interactiveSnapshot(sessionId: string): Promise<ProviderInteractiveSnapshot> {
    const eventVersionBefore = this.streamState.eventVersion(sessionId);
    const [status, heldMessages, metadata, commandChanges, revert] = await Promise.all([
      this.projectedStatus(sessionId),
      this.projectedMessages(sessionId, OPEN_CODE_MESSAGE_HISTORY_LIMIT),
      this.readInteractiveMetadata(sessionId),
      this.commandChanges?.changes(sessionId),
      this.revertMarker(sessionId),
    ]);
    const eventVersionAfter = this.streamState.eventVersion(sessionId);
    const rawMessages = [...withoutRevertedOpenCodeMessages(heldMessages, revert)];
    const outcomeMessages = await this.actionRetry.messagesWithFailures(sessionId, rawMessages);
    const normalizedMessages = normalizeOpenCodeTranscriptMessages(
      outcomeMessages,
      (type) => this.health.recordUnknown(`part:${type}`),
      commandChanges,
    );
    const messages = await this.hydrateSubagentTranscripts(
      normalizedMessages,
      collectRawOpenCodeSubagentIds(outcomeMessages),
    );
    // OpenCode persists terminal errors on the final assistant message rather
    // than in its lifecycle snapshot. Normalize that provider detail here so
    // the shared projection can render the same durable terminal row for every
    // provider, including aborts initiated outside this renderer.
    const persistedTerminal = normalizeOpenCodeTerminalState(
      [...outcomeMessages]
        .reverse()
        .find((candidate) => Boolean(asRecord(asRecord(candidate)?.info))),
    );
    // A previous assistant stop can still be the transcript tail while this
    // retry is live. It cannot settle the turn whose abort is pending or failed.
    const terminal =
      status === "running" && this.actionRetry.isUnsettled(sessionId) ? null : persistedTerminal;
    const streamNotices = [...this.actionRetry.notices(sessionId), ...openCodeRevertNotice(revert)];
    const streamedError = streamNotices.find((notice) => notice.kind === "error");
    const latestUsage = this.streamState.contextUsage(sessionId, outcomeMessages);
    const running = status === "running" && !terminal && !streamedError;
    const settled =
      Boolean(terminal) ||
      Boolean(streamedError) ||
      ((status !== "idle" || this.streamState.isTurnConfirmed(sessionId)) &&
        eventVersionAfter === eventVersionBefore);
    if (running) {
      this.streamState.confirmTurn(sessionId);
    } else if (settled) {
      this.streamState.endTurn(sessionId);
    }
    const turnStartedAt = running ? this.streamState.turnStartedAt(sessionId) : undefined;
    return {
      status: terminal?.kind === "error" || streamedError ? "error" : status,
      messages,
      messagesComplete: heldMessages.length < OPEN_CODE_MESSAGE_HISTORY_LIMIT,
      ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
      ...(metadata.title ? { title: metadata.title } : {}),
      composer: {
        ...EMPTY_NATIVE_AGENT_COMPOSER_STATE,
        models: metadata.models,
        ...(metadata.selectedModelId ? { selectedModelId: metadata.selectedModelId } : {}),
        executionProfiles: metadata.executionProfiles,
      },
      ...(metadata.sessionModelId ? { sessionModelId: metadata.sessionModelId } : {}),
      ...(metadata.sessionReasoningId ? { sessionReasoningId: metadata.sessionReasoningId } : {}),
      ...(await this.catalog.signInReadiness(() => this.allowedModelProviders())),
      ...(latestUsage ? { contextUsage: latestUsage } : {}),
      ...(this.sessionPolicies.get(sessionId)
        ? { policy: this.sessionPolicies.get(sessionId) }
        : {}),
      runtime: metadata.runtime,
      providerRevision: this.streamState.revision(sessionId),
      ...([...(terminal && !streamedError ? [terminal] : []), ...streamNotices].length > 0
        ? { notices: [...(terminal && !streamedError ? [terminal] : []), ...streamNotices] }
        : {}),
      ...(terminal?.kind === "error" || streamedError
        ? {
            phase: "error" as const,
            // A failure the backend aborted leaves a stop on the message; the
            // streamed failure says why.
            error:
              (terminal?.kind === "error" ? terminal.message : undefined) ??
              streamedError?.message ??
              terminal?.message ??
              "OpenCode session failed",
          }
        : {}),
    };
  }

  /**
   * Bounded inventory, drift and diagnostics for one session.
   *
   * The inventory comes from the same cached fan-out the interactive snapshot
   * uses, so asking for health does not multiply SDK calls, and health is
   * optional metadata: the authoritative liveness answer is the session status,
   * never this.
   *
   * This never awaits the fan-out. Health is a supplementary panel, and a cold
   * OpenCode server can take hundreds of milliseconds to answer eight optional
   * endpoints — time a transcript must not spend. A cached entry answers
   * immediately and refreshes behind the caller when it has aged out; with no
   * entry at all, live stream state answers now and the fan-out fills the cache
   * for the next read.
   */
  async runtimeHealth(sessionId: string): Promise<ProviderRuntimeHealth> {
    const cached = this.discovery.peek(sessionId);
    if (cached) {
      const metadata = this.applyStreamMetadata(sessionId, cached);
      if (cached.expiresAt <= Date.now()) {
        void this.discovery.refresh(sessionId).catch(() => undefined);
      }
      return { summary: metadata.runtime, notices: metadata.runtime.notices ?? [] };
    }
    void this.discovery.refresh(sessionId).catch(() => undefined);
    const streamed = this.applyStreamMetadata(sessionId, {
      runtime: { ...this.streamState.runtime(sessionId) },
      title: this.streamState.title(sessionId),
    });
    return { summary: streamed.runtime, notices: [] };
  }

  private readInteractiveMetadata(sessionId: string): Promise<OpenCodeDiscoveryMetadataResult> {
    return this.discovery.read(sessionId);
  }

  private invalidateInteractiveMetadata(): void {
    this.discovery.invalidate();
  }

  private applyStreamMetadata<
    T extends {
      runtime: NativeAgentRuntimeSummary;
      title?: string;
      sessionModelId?: string;
      sessionReasoningId?: string;
    },
  >(sessionId: string, metadata: T): T {
    const title = this.streamState.title(sessionId);
    const sessionModel = this.streamState.sessionModel(sessionId);
    const runtime = { ...metadata.runtime, ...this.streamState.runtime(sessionId) };
    return {
      ...metadata,
      runtime,
      ...(title ? { title } : {}),
      ...(sessionModel.modelId ? { sessionModelId: sessionModel.modelId } : {}),
      ...(sessionModel.reasoningId ? { sessionReasoningId: sessionModel.reasoningId } : {}),
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
          const commandChanges = await this.commandChanges?.changes(childSessionId);
          const messages = normalizeOpenCodeTranscriptMessages(
            raw,
            (type) => this.health.recordUnknown(`part:${type}`),
            commandChanges,
          );
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
    this.catalog.clear();
    this.commands.invalidate();
    this.invalidateInteractiveMetadata();
  }

  /** Directory-scoped: the same list serves every session of this runtime. */
  commandCatalogue(): Promise<ProviderCommandCatalogue> {
    return this.commands.catalogue();
  }

  refreshCommands(): Promise<ProviderCommandRefreshResult> {
    return this.commands.refreshCommands();
  }

  async slashCommands() {
    return (await this.commands.catalogue()).commands;
  }

  mcpServers() {
    return this.capabilitiesAdapter.mcpServers();
  }

  /** MCP apply: one idle-gated `instance.dispose`; the apply scheduler owns retries. */
  async reloadMcpConfiguration(): Promise<"reloaded" | "busy"> {
    return this.commandReload.requestOnce();
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
    return this.commandReload.withinDispatch(async () => {
      const status = await this.status(sessionId);
      if (status === "missing") throw new PromptRejectedError("OpenCode session was not found");
      if (policy) await this.sessionPolicy.apply(sessionId, effectiveOpenCodePolicy(policy));
      this.lifecycle.rememberExistingSession(sessionId);
      return sessionId;
    });
  }

  async synchronizeSessionPolicy(
    sessionId: string,
    policy: NativeAgentExecutionPolicy,
  ): Promise<void> {
    return this.commandReload.withinDispatch(() =>
      this.sessionPolicy.synchronize(sessionId, policy),
    );
  }

  private invalidateResearch(): void {
    this.dependencies.invalidateCoordinatorResearch?.();
    this.sessionPolicy.invalidateResearch();
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
    this.streamState.seedForkedSessionModel(forkedId, forked, sessionId);
    return {
      sessionId: forkedId,
      ...(typeof forked?.title === "string" ? { title: forked.title } : {}),
    };
  }

  async performSessionAction(
    sessionId: string,
    action: NativeAgentSessionAction,
  ): Promise<NativeAgentSessionActionOutcome> {
    const release = await this.commandReload.enterDispatch();
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
      // Both answer with the updated Session. Its revert marker is what the
      // transcript hides. Only install an answer if no observation overtook
      // the request; otherwise the next read reconciles with session.get.
      if (action.kind === "undo") {
        const version = this.streamState.revertVersion(sessionId);
        const response = await this.client.session.revert(
          {
            sessionID: sessionId,
            ...(action.messageId ? { messageID: action.messageId } : {}),
          },
          { ...this.requestOptions(), throwOnError: true },
        );
        this.observeRevertResult(sessionId, response.data, version);
        return { outcome: "applied" };
      }
      if (action.kind === "redo") {
        const version = this.streamState.revertVersion(sessionId);
        const response = await this.client.session.unrevert(
          { sessionID: sessionId },
          { ...this.requestOptions(), throwOnError: true },
        );
        this.observeRevertResult(sessionId, response.data, version);
        return { outcome: "applied" };
      }
      // No share/unshare: OpenCode 1.19.1 discontinued session sharing, so
      // `session.share` always fails upstream and links it made no longer open.
    } catch (error) {
      throw new ProviderUnavailableError(`OpenCode ${action.kind} failed`, { cause: error });
    } finally {
      release();
    }
    throw new PromptRejectedError(`OpenCode does not support ${action.kind}`);
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    return readOpenCodeStructuredOutput(this.client, sessionId, requestId, this.requestOptions());
  }

  async abort(sessionId: string): Promise<void> {
    await this.workflowResults.abort(
      sessionId,
      () => this.streamState.endTurn(sessionId),
      () => this.reviewPermissions.restoreIfNeeded(sessionId),
    );
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.workflowResults.closeRetaining(
      sessionId,
      () => this.streamState.endTurn(sessionId),
      () => this.reviewPermissions.restoreIfNeeded(sessionId),
    );
    this.releaseSession(sessionId);
  }

  releaseSession(sessionId: string): void {
    this.lifecycle.release(sessionId);
    this.streamState.forget(sessionId);
    this.changeEvidence.forget(sessionId);
    this.interactiveMetadata.delete(sessionId);
    this.sessionPolicies.delete(sessionId);
    this.sessionPolicy.forget(sessionId);
    this.actionRetry.forget(sessionId);
  }

  /** See `AgentSessionProvider.observationStreamLive`. */
  observationStreamLive(): boolean {
    return this.observation.isLive;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.observation.close();
    this.monitorController.abort();
    this.activeStreamController?.abort();
    await this.monitorPromise;
    await Promise.allSettled(this.requestTasks);
    this.lifecycle.clear();
    this.requestTasks.clear();
    this.streamState.clear();
    this.changeEvidence.dispose();
  }

  private requestOptions(): { signal: AbortSignal } {
    return openCodeRequestOptions(this.connection, this.monitorController.signal);
  }
}
