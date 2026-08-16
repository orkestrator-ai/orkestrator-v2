import * as shared from "./native-agent-service-shared.js";
const {
  createHash,
  BUILD_PIPELINE_AGENTS,
  isActiveBuildPhase,
  isBuildPipeline,
  aggregateAgentActivityState,
  AGENT_INTERACTION_ORIGINS,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  isAgentInteractionPolicy,
  nativeAgentCapabilities,
  resolveReasoningId,
  withSessionActionSlashCommands,
  boundTranscriptResponse,
  resolveStartupLaunch,
  PendingNativeAgentDispatchError,
  AmbiguousPromptDispatchError,
  createNativeAgentProvider,
  PromptRejectedError,
  ProviderUnavailableError,
  readProviderStatus,
  assertValidPromptAttachments,
  INITIAL_PROMPT_STAGING_DIRECTORY,
  stagePromptImages,
  inspectOpenCodeIncompleteTurn,
  openCodeIncompleteTurnRequestId,
  OPENCODE_INCOMPLETE_TURN_CONTINUATION,
  PROVIDER_REPORTED_INTERACTION_GRACE_MS,
  controlsFromSessionInput,
  isValidInteractionMetadata,
  isAgentTurnEndTransition,
  QUEUE_RETRY_BASE_MS,
  QUEUE_RETRY_CEILING_MS,
  MAX_QUEUE_DISPATCH_ATTEMPTS,
  LAUNCH_RETRY_MS,
  ACP_SESSION_CREATE_ATTEMPTS,
  ACP_SESSION_CREATE_RETRY_BASE_MS,
  ACTIVITY_STATUS_CONCURRENCY,
  ACTIVITY_RETRY_BASE_MS,
  ACTIVITY_RETRY_CEILING_MS,
  OPENCODE_RECOVERY_RETRY_BASE_MS,
  OPENCODE_RECOVERY_RETRY_CEILING_MS,
  PARKED_DISPATCH_CONFLICT_MESSAGE,
  OPENCODE_RECOVERY_MAX_CANDIDATES,
  OPENCODE_MANUAL_PROMPT_CLAIM_MS,
  OPENCODE_INCOMPLETE_TURN_HISTORY_LIMIT,
  ABSENT_BRIDGE_RECHECK_MS,
  INTERACTION_MONITOR_MAX_OBSERVATIONS,
  INTERACTION_MONITOR_MAX_TRACKED_REQUESTS,
  INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS,
  INTERACTION_MONITOR_DEFAULT_CONCURRENCY,
  INTERACTION_MONITOR_DEFAULT_PER_ENVIRONMENT,
  INTERACTION_MONITOR_DEFAULT_MAX_RETRIES,
  INTERACTION_MONITOR_DEFAULT_RETRY_BASE_MS,
  NATIVE_PROJECTION_CACHE_LIMIT,
  NATIVE_PROJECTION_MAX_MESSAGES,
  NATIVE_PROJECTION_MAX_WINDOW_MESSAGES,
  NATIVE_PROJECTION_MAX_BYTES,
  NATIVE_TOOL_DETAIL_CACHE_MAX_ENTRIES,
  NATIVE_TOOL_DETAIL_CACHE_MAX_BYTES,
  NATIVE_TOOL_DETAIL_MAX_BYTES,
  NATIVE_MODEL_CATALOG_TTL_MS,
  NATIVE_MODEL_CATALOG_CACHE_LIMIT,
  NATIVE_SLASH_COMMAND_TTL_MS,
  NATIVE_SLASH_COMMAND_CACHE_LIMIT,
  NATIVE_DISCOVERY_RETRY_MS,
  nativeCapabilities,
  nativeComposerControls,
  nonBlank,
  isEnvironmentReadyForAgents,
  LEGACY_TIMESTAMP_ENVIRONMENT_NAME,
  COMPACT_TIMESTAMP_ENVIRONMENT_NAME,
  isGeneratedEnvironmentName,
  nativeAgentSessionStorageKey,
} = shared;
void [createHash, BUILD_PIPELINE_AGENTS, isActiveBuildPhase, isBuildPipeline, aggregateAgentActivityState, AGENT_INTERACTION_ORIGINS, INTERACTIVE_AGENT_INTERACTION_POLICY, UNATTENDED_AGENT_INTERACTION_POLICY, isAgentInteractionPolicy, nativeAgentCapabilities, resolveReasoningId, withSessionActionSlashCommands, boundTranscriptResponse, resolveStartupLaunch, PendingNativeAgentDispatchError, AmbiguousPromptDispatchError, createNativeAgentProvider, PromptRejectedError, ProviderUnavailableError, readProviderStatus, assertValidPromptAttachments, INITIAL_PROMPT_STAGING_DIRECTORY, stagePromptImages, inspectOpenCodeIncompleteTurn, openCodeIncompleteTurnRequestId, OPENCODE_INCOMPLETE_TURN_CONTINUATION, PROVIDER_REPORTED_INTERACTION_GRACE_MS, controlsFromSessionInput, isValidInteractionMetadata, isAgentTurnEndTransition, QUEUE_RETRY_BASE_MS, QUEUE_RETRY_CEILING_MS, MAX_QUEUE_DISPATCH_ATTEMPTS, LAUNCH_RETRY_MS, ACP_SESSION_CREATE_ATTEMPTS, ACP_SESSION_CREATE_RETRY_BASE_MS, ACTIVITY_STATUS_CONCURRENCY, ACTIVITY_RETRY_BASE_MS, ACTIVITY_RETRY_CEILING_MS, OPENCODE_RECOVERY_RETRY_BASE_MS, OPENCODE_RECOVERY_RETRY_CEILING_MS, PARKED_DISPATCH_CONFLICT_MESSAGE, OPENCODE_RECOVERY_MAX_CANDIDATES, OPENCODE_MANUAL_PROMPT_CLAIM_MS, OPENCODE_INCOMPLETE_TURN_HISTORY_LIMIT, ABSENT_BRIDGE_RECHECK_MS, INTERACTION_MONITOR_MAX_OBSERVATIONS, INTERACTION_MONITOR_MAX_TRACKED_REQUESTS, INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS, INTERACTION_MONITOR_DEFAULT_CONCURRENCY, INTERACTION_MONITOR_DEFAULT_PER_ENVIRONMENT, INTERACTION_MONITOR_DEFAULT_MAX_RETRIES, INTERACTION_MONITOR_DEFAULT_RETRY_BASE_MS, NATIVE_PROJECTION_CACHE_LIMIT, NATIVE_PROJECTION_MAX_MESSAGES, NATIVE_PROJECTION_MAX_WINDOW_MESSAGES, NATIVE_PROJECTION_MAX_BYTES, NATIVE_TOOL_DETAIL_CACHE_MAX_ENTRIES, NATIVE_TOOL_DETAIL_CACHE_MAX_BYTES, NATIVE_TOOL_DETAIL_MAX_BYTES, NATIVE_MODEL_CATALOG_TTL_MS, NATIVE_MODEL_CATALOG_CACHE_LIMIT, NATIVE_SLASH_COMMAND_TTL_MS, NATIVE_SLASH_COMMAND_CACHE_LIMIT, NATIVE_DISCOVERY_RETRY_MS, nativeCapabilities, nativeComposerControls, nonBlank, isEnvironmentReadyForAgents, LEGACY_TIMESTAMP_ENVIRONMENT_NAME, COMPACT_TIMESTAMP_ENVIRONMENT_NAME, isGeneratedEnvironmentName, nativeAgentSessionStorageKey];
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

import { NativeAgentServiceDispatch } from "./native-agent-service-dispatch.ts";

export class NativeAgentServiceProjection extends NativeAgentServiceDispatch {
  protected cacheToolDetails(
    sessionKey: string,
    messageId: string,
    partPath: string,
    details: Omit<NativeAgentToolDetails, "detailRef">,
  ): string {
    const serializedDetails = JSON.stringify(details);
    const detailRef = createHash("sha256")
      .update(`${sessionKey}\0${messageId}\0${partPath}\0${serializedDetails}`)
      .digest("hex")
      .slice(0, 32);
    let stored: NativeAgentToolDetails = { detailRef, ...details };
    let bytes = Buffer.byteLength(serializedDetails) + detailRef.length + 32;
    if (bytes > NATIVE_TOOL_DETAIL_MAX_BYTES) {
      stored = {
        detailRef,
        toolError: "Tool details exceeded the deferred display limit.",
      };
      bytes = Buffer.byteLength(JSON.stringify(stored));
    }

    const previous = this.toolDetailCache.get(detailRef);
    if (previous) this.toolDetailCacheBytes -= previous.bytes;
    this.toolDetailCache.delete(detailRef);
    this.toolDetailCache.set(detailRef, { sessionKey, details: stored, bytes });
    this.toolDetailCacheBytes += bytes;
    this.pruneToolDetailCache();
    return detailRef;
  }

  protected pruneToolDetailCache(): void {
    while (
      this.toolDetailCache.size
        > (this.options.toolDetailCacheMaxEntries ?? NATIVE_TOOL_DETAIL_CACHE_MAX_ENTRIES)
      || this.toolDetailCacheBytes
        > (this.options.toolDetailCacheMaxBytes ?? NATIVE_TOOL_DETAIL_CACHE_MAX_BYTES)
    ) {
      const oldest = [...this.toolDetailCache.keys()].find(
        (candidate) => !this.pinnedToolDetailRefs.has(candidate),
      );
      if (!oldest) break;
      const entry = this.toolDetailCache.get(oldest);
      if (entry) this.toolDetailCacheBytes -= entry.bytes;
      this.toolDetailCache.delete(oldest);
    }
  }

  protected projectionPart(
    sessionKey: string,
    messageId: string,
    raw: unknown,
    partPath: string,
  ): unknown {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const part = raw as Record<string, unknown>;
    const projected: Record<string, unknown> = { ...part };

    // A staged path is the durable image reference. Re-sending the same image
    // as an inline data URL on every snapshot only duplicates transport bytes.
    if (
      part.type === "file"
      && typeof part.content === "string"
      && (
        part.content.startsWith("/")
        || part.content.startsWith("file://")
        || /^[A-Za-z]:[\\/]/.test(part.content)
      )
      && typeof part.fileUrl === "string"
      && part.fileUrl.startsWith("data:image/")
    ) {
      delete projected.fileUrl;
    }

    const rawDiff = part.toolDiff && typeof part.toolDiff === "object"
      && !Array.isArray(part.toolDiff)
      ? part.toolDiff as Record<string, unknown>
      : undefined;
    const hasHeavyDiff = Boolean(rawDiff && (
      typeof rawDiff.diff === "string"
      || typeof rawDiff.before === "string"
      || typeof rawDiff.after === "string"
    ));
    if (
      typeof part.toolOutput === "string"
      || typeof part.toolError === "string"
      || hasHeavyDiff
    ) {
      projected.detailRef = this.cacheToolDetails(sessionKey, messageId, partPath, {
        ...(typeof part.toolOutput === "string" ? { toolOutput: part.toolOutput } : {}),
        ...(typeof part.toolError === "string" ? { toolError: part.toolError } : {}),
        ...(rawDiff ? { toolDiff: rawDiff } : {}),
      });
      delete projected.toolOutput;
      delete projected.toolError;
      if (rawDiff) {
        projected.toolDiff = {
          ...(typeof rawDiff.filePath === "string" ? { filePath: rawDiff.filePath } : {}),
          ...(typeof rawDiff.additions === "number" ? { additions: rawDiff.additions } : {}),
          ...(typeof rawDiff.deletions === "number" ? { deletions: rawDiff.deletions } : {}),
          // Without this the renderer cannot tell a stripped diff from a
          // location-only hint, and every provider that identifies a file
          // mutation by diff content rather than tool name loses its edit
          // treatment until the row is expanded.
          ...(hasHeavyDiff ? { deferred: true } : {}),
        };
      }
    }

    for (const field of ["parts", "childTools", "subagentActions"] as const) {
      if (!Array.isArray(part[field])) continue;
      projected[field] = part[field].map((child, index) =>
        this.projectionPart(sessionKey, messageId, child, `${partPath}/${field}/${index}`)
      );
    }
    if (part.task && typeof part.task === "object" && !Array.isArray(part.task)) {
      projected.task = this.projectionPart(
        sessionKey,
        messageId,
        part.task,
        `${partPath}/task`,
      );
    }
    return projected;
  }

  protected projectionMessages(
    sessionKey: string,
    messages: unknown[],
    limit: number,
  ): { messages: unknown[]; window: NativeAgentMessageWindow } {
    const requested = messages.slice(-limit).map((raw) => {
      const message = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null;
      const role = message?.role;
      if (
        !message
        || typeof message.id !== "string"
        || (role !== "user" && role !== "assistant" && role !== "system")
        || typeof message.content !== "string"
        || !Array.isArray(message.parts)
        || typeof message.createdAt !== "string"
      ) {
        throw new ProviderUnavailableError(
          "Provider returned a non-normalized native transcript",
        );
      }
      return {
        id: message.id,
        role,
        content: message.content,
        parts: message.parts.map((part, index) =>
          this.projectionPart(sessionKey, message.id as string, part, String(index))
        ),
        createdAt: message.createdAt,
        ...(typeof message.modelId === "string" ? { modelId: message.modelId } : {}),
        ...(typeof message.turnId === "string" ? { turnId: message.turnId } : {}),
        ...(typeof message.planReview === "boolean" ? { planReview: message.planReview } : {}),
      };
    });
    let boundedTranscript;
    try {
      boundedTranscript = boundTranscriptResponse(requested, NATIVE_PROJECTION_MAX_BYTES, {
        // The bound applies to the bare message array; the surrounding
        // projection is not what this ceiling protects.
        envelopeReserveBytes: 0,
        // A half-rendered final message is worse than an explicit failure here:
        // the renderer has a recovery path for an unavailable projection, and
        // the bridges have already bounded their own responses well below this.
        contentFallbackBytes: null,
      });
    } catch (error) {
      /*
       * The bound's only failure mode is the `JSON.stringify` it uses to
       * measure, which throws a `TypeError` on a circular structure or a
       * BigInt. The normalized provider contract is JSON, so that is a
       * transport violation rather than something to leak to a renderer.
       * Measuring separately up front just to say so would serialize the whole
       * transcript twice on every refresh.
       */
      if (!(error instanceof TypeError)) throw error;
      throw new ProviderUnavailableError(
        "Provider returned a non-serializable native transcript",
      );
    }
    const { messages: bounded, messageWindow, overflowed } = boundedTranscript;
    if (overflowed) {
      throw new ProviderUnavailableError(
        "Provider transcript contains one message body larger than 16 MiB",
      );
    }
    const omittedParts = messageWindow.omittedParts ?? 0;
    const truncatedByCount = messages.length > requested.length;
    const truncatedByBytes = bounded.length < requested.length || omittedParts > 0;
    const omittedMessages = messages.length - bounded.length;
    return {
      messages: bounded,
      window: {
        limit,
        truncated: truncatedByCount || truncatedByBytes,
        ...(truncatedByBytes
          ? {
              truncationReason: "bytes" as const,
              ...(omittedMessages > 0 ? { omittedMessages } : {}),
              ...(omittedParts > 0 ? { omittedParts } : {}),
            }
          : truncatedByCount ? { truncationReason: "count" as const } : {}),
      },
    };
  }

  async getProjectionToolDetails(
    input: NativeAgentProjectionInput & { detailRef: string },
  ): Promise<NativeAgentToolDetails> {
    this.assertProjectionInput(input);
    if (!nonBlank(input.detailRef) || input.detailRef.length > 128) {
      throw new Error("Native agent tool detail reference is invalid");
    }
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    let entry = this.toolDetailCache.get(input.detailRef);
    if (!entry || entry.sessionKey !== sessionKey) {
      this.pinnedToolDetailRefs.add(input.detailRef);
      try {
        await this.refreshProjection(input, true);
        entry = this.toolDetailCache.get(input.detailRef);
      } finally {
        this.pinnedToolDetailRefs.delete(input.detailRef);
        this.pruneToolDetailCache();
      }
    }
    if (!entry || entry.sessionKey !== sessionKey) {
      throw new Error("Native agent tool details are no longer available");
    }
    this.toolDetailCache.delete(input.detailRef);
    this.toolDetailCache.set(input.detailRef, entry);
    return entry.details;
  }

  /**
   * Resolve the transcript window for one refresh.
   *
   * Callers that ask for a bigger window raise it; callers that ask for nothing
   * inherit the window the session already had. Clamped so a renderer cannot
   * ask the provider for an unbounded transcript.
   */
  protected resolveMessageLimit(
    requested: number | undefined,
    previous: number | undefined,
  ): number {
    const candidate = requested ?? previous ?? NATIVE_PROJECTION_MAX_MESSAGES;
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      return NATIVE_PROJECTION_MAX_MESSAGES;
    }
    return Math.min(candidate, NATIVE_PROJECTION_MAX_WINDOW_MESSAGES);
  }

  protected async projectionComposer(
    input: NativeAgentProjectionInput,
    session: PersistedNativeAgentSession,
    providerComposer?: NativeAgentComposerState,
    providerControls?: NativeAgentControlUpdate,
  ): Promise<NativeAgentComposerState> {
    let models = providerComposer?.models ?? [];
    if (models.length === 0) {
      const cached = this.modelCatalogCache.get(input.environmentId);
      if (cached) {
        models = cached.models.filter((model) => model.platform === input.agent);
        if (cached.expiresAt <= this.now()) {
          // Model discovery can probe several runtimes and take seconds. An
          // expired entry is still perfectly adequate for rendering the
          // transcript and existing picker selection, so refresh it out of the
          // transcript-critical path. The next projection poll observes the
          // refreshed catalogue.
          void this.refreshProjectionModelCatalog(input.environmentId)
            .then(() => {
              if (!this.stopped) {
                this.storage.announceNativeAgentSessionProjection(input.environmentId);
              }
            })
            .catch(() => {
              const retained = this.modelCatalogCache.get(input.environmentId);
              if (retained === cached) {
                retained.expiresAt = this.now() + NATIVE_DISCOVERY_RETRY_MS;
              }
            });
        }
      } else {
        try {
          const bounded = await this.refreshProjectionModelCatalog(input.environmentId);
          models = bounded.filter((model) => model.platform === input.agent);
        } catch {
          // A stale or unavailable catalog must not hide the transcript.
        }
      }
    }
    const selectedModelId = providerControls?.modelId
      ?? session.controls?.modelId
      ?? providerComposer?.selectedModelId
      ?? models[0]?.id;
    const selectedModel = models.find((model) => model.id === selectedModelId)
      ?? models[0];
    const selectedReasoningId = providerControls?.reasoningId
      ?? session.controls?.reasoningId
      ?? providerComposer?.selectedReasoningId
      // The advertised default matters for Cursor/Grok, where it carries the
      // agent's own current effort rather than a static catalog value.
      ?? resolveReasoningId(
        selectedModel?.reasoning ?? [],
        undefined,
        selectedModel?.defaultReasoningId,
      )
      ?? selectedModel?.defaultReasoningId;
    const supportsSpeed = providerComposer?.fastModeAvailable === true
      || selectedModel?.supportsSpeed === true;
    const capabilities = nativeCapabilities(input.agent);
    return {
      models,
      ...(selectedModel ? { selectedModelId: selectedModel.id } : {}),
      ...(selectedReasoningId
        ? {
            selectedReasoningId,
          }
        : {}),
      fastModeAvailable: supportsSpeed,
      fastModeEnabled: supportsSpeed
        ? providerControls?.fastMode
          ?? session.controls?.fastMode
          ?? providerComposer?.fastModeEnabled
          ?? false
        : null,
      ...(capabilities.composer.mode ? {
        selectedModeId: providerControls?.mode
          ?? session.controls?.mode
          ?? providerComposer?.selectedModeId
          ?? "build",
      } : {}),
      modes: capabilities.composer.mode
        ? providerComposer?.modes.length
          ? providerComposer.modes
          : [{ id: "build", label: "Build" }, { id: "plan", label: "Plan" }]
        : [],
      ...(providerComposer?.executionProfiles?.length ? {
        executionProfiles: providerComposer.executionProfiles,
      } : {}),
      ...(providerControls?.executionProfileId
        ?? session.controls?.executionProfileId
        ?? providerComposer?.selectedExecutionProfileId
        ?? undefined
        ? {
            selectedExecutionProfileId: providerControls?.executionProfileId
              ?? session.controls?.executionProfileId
              ?? providerComposer?.selectedExecutionProfileId
              ?? undefined,
          }
        : {}),
      ...(capabilities.composer.localSettings ? {
        includeLocalSettings: providerControls?.includeLocalSettings
          ?? session.controls?.includeLocalSettings
          ?? providerComposer?.includeLocalSettings
          ?? false,
      } : {}),
      ...(capabilities.composer.promptSuggestions ? {
        promptSuggestionsEnabled: providerControls?.promptSuggestions
          ?? session.controls?.promptSuggestions
          ?? providerComposer?.promptSuggestionsEnabled
          ?? false,
      } : {}),
    };
  }

  protected refreshProjectionModelCatalog(environmentId: string): Promise<AgentModel[]> {
    const pending = this.modelCatalogRefreshes.get(environmentId);
    if (pending) return pending.operation;
    const validity = { current: true };
    const operation = (async () => {
      const catalog = await this.invoke<AgentModel[]>(
        "get_native_agent_model_catalog",
        { environmentId },
      );
      const bounded = Array.isArray(catalog) ? catalog.slice(0, 512) : [];
      if (!validity.current) {
        throw new ProviderUnavailableError("Model catalog refresh was invalidated");
      }
      if (
        !this.modelCatalogCache.has(environmentId)
        && this.modelCatalogCache.size >= NATIVE_MODEL_CATALOG_CACHE_LIMIT
      ) {
        const oldest = this.modelCatalogCache.keys().next().value as string | undefined;
        if (oldest) this.modelCatalogCache.delete(oldest);
      }
      this.modelCatalogCache.set(environmentId, {
        models: bounded,
        expiresAt: this.now() + NATIVE_MODEL_CATALOG_TTL_MS,
      });
      return bounded;
    })();
    const entry = { operation, validity };
    this.modelCatalogRefreshes.set(environmentId, entry);
    return operation.finally(() => {
      if (this.modelCatalogRefreshes.get(environmentId) === entry) {
        this.modelCatalogRefreshes.delete(environmentId);
      }
    });
  }

  protected refreshProjectionSlashCommands(
    key: string,
    provider: NativeAgentRuntimeProvider,
  ): Promise<NativeAgentSlashCommand[]> {
    const pending = this.slashCommandRefreshes.get(key);
    if (pending) return pending.operation;
    const validity = { current: true };
    const operation = (async () => {
      const commands = (await provider.slashCommands!()).slice(0, 512);
      if (!validity.current) {
        throw new ProviderUnavailableError("Slash command refresh was invalidated");
      }
      if (
        !this.slashCommandCache.has(key)
        && this.slashCommandCache.size >= NATIVE_SLASH_COMMAND_CACHE_LIMIT
      ) {
        const oldest = this.slashCommandCache.keys().next().value as string | undefined;
        if (oldest) this.slashCommandCache.delete(oldest);
      }
      this.slashCommandCache.set(key, {
        commands,
        expiresAt: this.now() + NATIVE_SLASH_COMMAND_TTL_MS,
      });
      return commands;
    })();
    const entry = { operation, validity };
    this.slashCommandRefreshes.set(key, entry);
    return operation.finally(() => {
      if (this.slashCommandRefreshes.get(key) === entry) {
        this.slashCommandRefreshes.delete(key);
      }
    });
  }

  protected async projectionSlashCommands(
    input: NativeAgentProjectionInput,
    provider: NativeAgentRuntimeProvider,
  ): Promise<NativeAgentSlashCommand[]> {
    const capabilities = nativeCapabilities(input.agent);
    // Runtime-performed commands exist even for a provider that advertises no
    // command discovery of its own, so they are merged outside the early exit.
    const withActions = (commands: NativeAgentSlashCommand[]) =>
      withSessionActionSlashCommands(commands, capabilities);
    if (!capabilities.slashCommands || !provider.slashCommands) {
      return withActions([]);
    }
    const key = `${input.environmentId}\0${input.agent}`;
    const cached = this.slashCommandCache.get(key);
    if (cached) {
      if (cached.expiresAt <= this.now()) {
        // Command discovery is optional UI metadata. Keep the expired list
        // visible and update it asynchronously so a transcript refresh never
        // waits on /global/slash-commands or a provider SDK request.
        void this.refreshProjectionSlashCommands(key, provider)
          .then(() => {
            if (!this.stopped) {
              this.storage.announceNativeAgentSessionProjection(input.environmentId);
            }
          })
          .catch(() => {
            const retained = this.slashCommandCache.get(key);
            if (retained === cached) {
              retained.expiresAt = this.now() + NATIVE_DISCOVERY_RETRY_MS;
            }
          });
      }
      return withActions(cached.commands);
    }
    try {
      const commands = await this.refreshProjectionSlashCommands(key, provider);
      return withActions(commands);
    } catch {
      // Discovery metadata is optional. Keep the transcript usable when a
      // provider temporarily cannot enumerate commands.
      return withActions([]);
    }
  }

  protected invalidateProjection(key: string): void {
    this.projectionCache.delete(key);
    this.projectionEpochs.set(key, (this.projectionEpochs.get(key) ?? 0) + 1);
  }

  /**
   * Drop the epoch counter for a key that is neither cached nor being read.
   *
   * The epoch only means anything relative to a read that captured it, so once
   * a key has no cache entry and no in-flight refresh, restarting it at zero is
   * indistinguishable from keeping it. Without this the map would outlive every
   * bound `projectionCache` enforces and grow with key churn for the life of
   * the process.
   */
  protected pruneProjectionEpoch(key: string): void {
    if (this.projectionCache.has(key)) return;
    if (this.projectionRefreshes.has(key)) return;
    this.projectionEpochs.delete(key);
  }

  protected refreshProjection(
    input: NativeAgentProjectionInput,
    force: boolean,
  ): Promise<NativeAgentSessionProjection | null> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const previousRefresh = this.projectionRefreshes.get(key);
    const operation = (async () => {
      if (previousRefresh) await previousRefresh.catch(() => undefined);
      const epoch = this.projectionEpochs.get(key) ?? 0;
      return this.refreshProjectionOnce(input, force, key, epoch);
    })();
    this.projectionRefreshes.set(key, operation);
    return operation.finally(() => {
      if (this.projectionRefreshes.get(key) === operation) {
        this.projectionRefreshes.delete(key);
      }
      this.pruneProjectionEpoch(key);
    });
  }

  protected async refreshProjectionOnce(
    input: NativeAgentProjectionInput,
    force: boolean,
    key: string,
    epoch: number,
  ): Promise<NativeAgentSessionProjection | null> {
    const previous = this.projectionCache.get(key);
    const messageLimit = this.resolveMessageLimit(
      input.messageLimit,
      previous?.input.messageLimit,
    );
    const windowed: NativeAgentProjectionInput = { ...input, messageLimit };
    if (
      !force
      && previous
      && previous.input.messageLimit === messageLimit
    ) {
      return previous.projection;
    }
    let generation = previous?.generation ?? `unresolved:${input.agent}`;
    try {
      const resolved = await this.resolveProjectionSession(input);
      if (!resolved) {
        if ((this.projectionEpochs.get(key) ?? 0) === epoch) {
          this.projectionCache.delete(key);
        }
        return null;
      }
      const providerCacheKey = `${input.environmentId}\0${input.agent}`;
      generation = this.providerConnections.get(providerCacheKey)
        ?? `in-process:${input.agent}`;
      const capabilities = nativeCapabilities(input.agent);
      // These reads describe independent parts of one projection. Keeping
      // them serial made a transcript wait for every approval, queue and slash
      // command round trip in turn, even though none produces message text.
      const snapshotPromise: Promise<ProviderInteractiveSnapshot> = resolved.provider.interactiveSnapshot
        ? resolved.provider.interactiveSnapshot(
            resolved.session.providerSessionId,
          )
        : (async () => ({
            // A terminal turn error belongs in the projection as `error` plus
            // its detail, not as a thrown read that would report the whole
            // runtime as unreachable.
            ...await readProviderStatus(
              resolved.provider,
              resolved.session.providerSessionId,
            ),
            messages: await resolved.provider.messages(resolved.session.providerSessionId),
          }))();
      const interactionSnapshotPromise = resolved.provider.interactions
        ? resolved.provider.interactions.listPendingInteractions(
            resolved.session.providerSessionId,
          )
        : Promise.resolve({ requests: [], revision: 0 });
      const queuePromise = capabilities.queue
        ? this.storage.getPromptQueue(`${input.agent}\0${input.logicalSessionKey}`)
        : Promise.resolve(null);
      const slashCommandsPromise = this.projectionSlashCommands(
        input,
        resolved.provider,
      );
      const [snapshot, interactionSnapshot, queue, slashCommands] = await Promise.all([
        snapshotPromise,
        interactionSnapshotPromise,
        queuePromise,
        slashCommandsPromise,
      ]);
      if (snapshot.providerGeneration !== undefined) {
        generation = `${generation}:${String(snapshot.providerGeneration)}`;
      }
      if (snapshot.status === "missing") {
        throw new ProviderUnavailableError("Native agent provider session is recovering");
      }
      const blocked = interactionSnapshot.requests.length > 0;
      const composer = await this.projectionComposer(
        input,
        resolved.session,
        snapshot.composer,
        snapshot.controls,
      );
      const selectedModel = composer.models.find(
        (model) => model.id === composer.selectedModelId,
      );
      const contextUsage = snapshot.contextUsage
        ? {
            ...snapshot.contextUsage,
            ...(snapshot.contextUsage.maximumTokens === undefined
              && selectedModel?.contextWindow
              ? { maximumTokens: selectedModel.contextWindow }
              : {}),
            ...(snapshot.contextUsage.percentage === undefined
              && (snapshot.contextUsage.maximumTokens ?? selectedModel?.contextWindow)
              ? {
                  percentage: Math.max(0, Math.min(
                    100,
                    snapshot.contextUsage.usedTokens
                      / (snapshot.contextUsage.maximumTokens ?? selectedModel!.contextWindow!)
                      * 100,
                  )),
                }
              : {}),
          }
        : undefined;
      const transcript = this.projectionMessages(key, snapshot.messages, messageLimit);
      const terminalNotices = [
        ...(snapshot.notices ?? []).filter(
          (notice) => notice.kind === "error" || notice.kind === "stopped",
        ),
        ...(snapshot.error && !(snapshot.notices ?? []).some(
          (notice) => notice.kind === "error" && notice.message === snapshot.error,
        ) ? [{ kind: "error" as const, message: snapshot.error }] : []),
      ];
      const messages = [
        ...transcript.messages,
        ...terminalNotices.map((notice) => ({
          id: `native-terminal:${notice.kind}:${createHash("sha256")
            .update(notice.message)
            .digest("hex")
            .slice(0, 16)}`,
          role: "system" as const,
          content: notice.message,
          parts: [{ type: "text" as const, content: notice.message }],
          // Provider terminal metadata does not consistently carry a time.
          // A fixed value keeps repeated authoritative reads byte-stable.
          createdAt: "1970-01-01T00:00:00.000Z",
        })),
      ];
      // Reading the projection is the only moment a parked dispatch is
      // reliably revisited, so it is where the provider gets asked whether the
      // prompt landed after all. A record that outlived the backend generation
      // that created it is settled here instead of waiting for the user.
      if (resolved.session.pendingDispatch) {
        this.scheduleAmbiguousDispatchSettle(
          input,
          key,
          resolved.session.pendingDispatch.requestId,
          resolved.provider,
        );
      }
      const projection: NativeAgentSessionProjection = {
        platform: input.agent,
        environmentId: input.environmentId,
        sessionId: resolved.session.providerSessionId,
        messageWindow: transcript.window,
        ...(snapshot.title ? { title: snapshot.title } : {}),
        ...(snapshot.shareUrl === undefined ? {} : { shareUrl: snapshot.shareUrl }),
        connection: "connected",
        turn: {
          phase: snapshot.phase === "cancelling"
            || snapshot.phase === "recovering"
            || snapshot.phase === "error"
            ? snapshot.phase
            : blocked
              ? "blocked"
              : snapshot.phase ?? (snapshot.status === "error"
                ? "error"
                : snapshot.status === "running" ? "running" : "idle"),
          ...(snapshot.turnStartedAt === undefined
            ? {} : { startedAt: snapshot.turnStartedAt }),
          ...(snapshot.error ? { error: snapshot.error } : {}),
        },
        messages,
        interactions: interactionSnapshot.requests,
        composerControls: nativeComposerControls(
          composer,
          snapshot.status === "running" || blocked,
        ),
        composer,
        capabilities,
        ...(slashCommands.length > 0 ? { slashCommands } : {}),
        ...(queue ? {
          queue: {
            items: queue.messages,
            ...(queue.inFlight ? { inFlightRequestId: queue.inFlight.requestId } : {}),
            ...(queue.dispatchError ? {
              blocked: {
                messageId: queue.dispatchError.messageId,
                error: queue.dispatchError.message,
              },
            } : {}),
          },
        } : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...(snapshot.rateLimits ? { rateLimits: snapshot.rateLimits } : {}),
        ...(snapshot.runtime ? { runtime: snapshot.runtime } : {}),
        ...((snapshot.notices ?? []).some(
          (notice) => notice.kind !== "error" && notice.kind !== "stopped",
        ) ? {
          notices: snapshot.notices!.filter(
            (notice) => notice.kind !== "error" && notice.kind !== "stopped",
          ),
        } : {}),
        ...(resolved.session.pendingDispatch ? {
          recoverableDispatch: {
            requestId: resolved.session.pendingDispatch.requestId,
            createdAt: resolved.session.pendingDispatch.createdAt,
          },
        } : {}),
        ...(snapshot.backgroundTasks
          ? { backgroundTasks: snapshot.backgroundTasks }
          : {}),
        ...(snapshot.suggestedPrompt
          ? { suggestedPrompt: snapshot.suggestedPrompt }
          : {}),
        ...(snapshot.completionBlockedByBackgroundTasks === undefined
          ? {}
          : {
              completionBlockedByBackgroundTasks:
                snapshot.completionBlockedByBackgroundTasks,
            }),
        ...(capabilities.fork ? {
          turnBoundaries: messages.flatMap((candidate) => {
            const message = candidate as Record<string, unknown>;
            return typeof message.id === "string"
              ? [{
                  turnId: typeof message.turnId === "string"
                    ? message.turnId
                    : message.id,
                  messageId: message.id,
                  resumable: capabilities.resume,
                  forkable: true,
                }]
              : [];
          }),
        } : {}),
        ...(resolved.session.openCodeIncompleteTurnNotice ? {
          notices: [...(snapshot.notices ?? []), {
            kind: "incomplete-turn" as const,
            message: resolved.session.openCodeIncompleteTurnNotice.kind === "failed"
              ? "The previous OpenCode turn ended before completion."
              : "OpenCode could not complete the previous turn after recovery.",
          }],
        } : {}),
        revision: 0,
        generation,
        cursor: snapshot.providerRevision === undefined
          ? undefined
          : String(snapshot.providerRevision),
      };
      return this.commitProjection(key, windowed, projection, generation, epoch);
    } catch (error) {
      const projection: NativeAgentSessionProjection = {
        ...(previous?.projection ?? {
          platform: input.agent,
          environmentId: input.environmentId,
          messages: [],
          interactions: [],
          composerControls: [],
          capabilities: nativeCapabilities(input.agent),
          revision: 0,
          generation,
        }),
        connection: "error",
        turn: {
          phase: "recovering",
          error: error instanceof Error ? error.message : "Native agent is unavailable",
        },
        notices: [{
          kind: "recovery",
          message: "Reconnecting to the native agent runtime…",
        }],
        revision: 0,
        generation,
      };
      return this.commitProjection(key, windowed, projection, generation, epoch);
    }
  }

  protected commitProjection(
    key: string,
    input: NativeAgentProjectionInput,
    candidate: NativeAgentSessionProjection,
    generation: string,
    epoch: number,
  ): NativeAgentSessionProjection {
    if ((this.projectionEpochs.get(key) ?? 0) !== epoch) {
      /*
       * This read lost a race with a mutation that replaced the tab's provider
       * identity, so it must not become the cached authoritative state. It is
       * still a real answer though: `null` is reserved for "this logical tab
       * resolves to no provider session", and returning it here would make an
       * ordinary resume look like a deleted session to any caller that does not
       * fence reads itself. Hand back the newest committed projection, or the
       * uncommitted candidate at revision 0 when nothing is cached yet.
       */
      return this.projectionCache.get(key)?.projection
        ?? { ...candidate, revision: 0, generation, cursor: `${generation}:0` };
    }
    const previous = this.projectionCache.get(key);
    const fingerprint = JSON.stringify({
      ...candidate,
      revision: 0,
      cursor: candidate.cursor,
    });
    if (
      previous
      && previous.generation === generation
      && previous.fingerprint === fingerprint
    ) {
      return previous.projection;
    }
    const revision = previous?.generation === generation
      ? previous.projection.revision + 1
      : 1;
    const projection = {
      ...candidate,
      revision,
      generation,
      cursor: `${generation}:${revision}`,
    };
    if (!previous && this.projectionCache.size >= NATIVE_PROJECTION_CACHE_LIMIT) {
      const oldest = this.projectionCache.keys().next().value as string | undefined;
      /*
       * Capacity eviction is not an identity change: bumping the evicted key's
       * epoch would fence an unrelated in-flight read for it and report that
       * session as missing. Drop the entry only, and reclaim its epoch when no
       * read is relying on it.
       */
      if (oldest) {
        this.projectionCache.delete(oldest);
        this.pruneProjectionEpoch(oldest);
      }
    }
    this.projectionCache.set(key, {
      input: { ...input },
      projection,
      fingerprint,
      generation,
    });
    this.storage.announceNativeAgentSessionProjection(input.environmentId);
    return projection;
  }


}

