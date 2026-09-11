import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type {
  AgentInteractionProviderCapability,
  BridgeConnection,
  NativeAgentRuntimeProvider,
  ProviderActivityObservation,
  ProviderActivityState,
  ProviderActiveSteerRun,
  ProviderCreateSessionOptions,
  ProviderDispatchStatus,
  ProviderExecutionMode,
  ProviderInteractiveSnapshot,
  ProviderSessionStateSnapshot,
  ProviderTranscriptSnapshot,
  ProviderSendOptions,
  ProviderSessionObservation,
  ProviderSessionRegistration,
  ProviderSteerDispatchStatus,
  ProviderStatus,
  ProviderNativeAgentSessionAction,
} from "./agent-provider-contract.js";
import {
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  ProviderSessionFailedError,
  ProviderUnavailableError,
  type ProviderRuntimeHealth,
  ProviderUnreachableError,
} from "./agent-provider-contract.js";
import type {
  NativeAgentComposerState,
  NativeAgentContextUsage,
  NativeAgentControlUpdate,
  NativeAgentExecutionPolicy,
  NativeAgentForkOutcome,
  NativeAgentResumeEntry,
  NativeAgentRuntimeSummary,
  NativeAgentSessionActionOutcome,
  NativeAgentTurnPhase,
} from "@orkestrator/protocol/native-agent";
import {
  EMPTY_NATIVE_AGENT_COMPOSER_STATE,
  isNativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import type { PromptAttachment } from "./prompt-attachments.js";
import { bridgeRuntimeSummary, snapshotNotices } from "./http-bridge-runtime-health.js";
import {
  refreshHttpBridgeRuntimeMetadata,
  type HttpBridgeRuntimeMetadata,
} from "./http-bridge-runtime-metadata.js";
import {
  asRecord,
  INTERACTIVE_RUNTIME_METADATA_RETRY_MS,
  INTERACTIVE_RUNTIME_METADATA_TTL_MS,
  isTransientHttpStatus,
  MAX_TRACKED_INTERACTION_SESSIONS,
  nonEmptyString,
  normalizeProviderRateLimits,
  normalizeProviderRuntimeSummary,
  setBoundedMapEntry,
} from "./agent-provider-runtime.js";
import { HttpBridgeInteractionAdapter } from "./http-bridge-interactions.js";
import { HttpBridgeCatalogAdapter, type HttpBridgeAgent } from "./http-bridge-catalog.js";
import { contextUsageWithPlanUsage } from "./plan-usage-cache.js";
import { normalizeClaudeBackgroundTasks } from "./http-bridge-claude-runtime.js";
import {
  readHttpBridgeAuthoritativeSessionState,
  readHttpBridgeLegacyTranscript,
  readHttpBridgeTranscriptSnapshot,
  type LegacyTranscriptSnapshot,
} from "./http-bridge-progressive.js";
import {
  assertOk,
  assertOkWithErrorDetail,
  boundedJson,
  bridgeFetch,
  normalizeProviderReadiness,
  fetchSessionSnapshot,
  readProviderActivityObservation,
  resolvePromptAttachments,
  sessionSnapshotBudget,
  type HttpBridgeProviderDependencies,
} from "./http-bridge-transport.js";

/**
 * Drop the staged `dataUrl` before an attachment reaches a bridge that reads
 * the workspace itself.
 *
 * Those bridges read every attachment's bytes from the workspace and ignore
 * `dataUrl`, but they cap a request body at 2MiB. Forwarding the data URL
 * spends that whole budget on a copy the bridge discards, so a screenshot much
 * over 1.5MB would come back as HTTP 413 — a terminal rejection of a prompt the
 * bridge is perfectly able to read from disk. The Claude and Codex bridges do
 * consume `dataUrl`, so this is deliberately scoped to the ones that do not.
 */
function bridgePromptAttachments(
  agent: HttpBridgeProvider["agent"],
  attachments: PromptAttachment[] | undefined,
): PromptAttachment[] | undefined {
  if (!attachments || (agent !== "cursor" && agent !== "grok" && agent !== "pi")) {
    return attachments;
  }
  return attachments.map((attachment) => ({
    type: attachment.type,
    path: attachment.path,
    ...(attachment.filename ? { filename: attachment.filename } : {}),
  }));
}

export class HttpBridgeProvider implements NativeAgentRuntimeProvider {
  readonly agent: HttpBridgeAgent;
  private readonly stageImages?: HttpBridgeProviderDependencies["stageImages"];
  private readonly interactionAdapter: HttpBridgeInteractionAdapter;
  private readonly catalogAdapter: HttpBridgeCatalogAdapter;
  readonly interactions: AgentInteractionProviderCapability;
  /**
   * The Codex mode each session was last known to be in.
   *
   * Codex binds its mode to the session rather than the prompt, so re-asserting
   * the mode a session was just created with costs a config round trip and
   * changes nothing. A session this provider did not create — one restored
   * through {@link registerSession} after a restart — is absent here, and those
   * do have to be reconciled against the bridge.
   */
  private readonly codexModes = new Map<string, ProviderExecutionMode>();
  private readonly interactiveMetadata = new Map<string, HttpBridgeRuntimeMetadata>();
  /** Runtime inventory is optional UI metadata and must not delay transcripts. */
  private readonly runtimeMetadataRefreshes = new Map<string, Promise<void>>();
  private runtimeMetadataGeneration = 0;

  constructor(
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
    stageImages?: HttpBridgeProviderDependencies["stageImages"],
  ) {
    this.agent = connection.agent as HttpBridgeAgent;
    this.stageImages = stageImages;
    this.interactionAdapter = new HttpBridgeInteractionAdapter(this.agent, connection, fetchImpl);
    this.catalogAdapter = new HttpBridgeCatalogAdapter(this.agent, connection, fetchImpl);
    this.interactions = {
      listPendingInteractions: (sessionId) =>
        this.interactionAdapter.listPendingInteractions(sessionId),
      resolveInteraction: (sessionId, interactionId, resolution) =>
        this.interactionAdapter.resolveInteraction(sessionId, interactionId, resolution),
    };
  }

  registerSession(sessionId: string, interaction?: ProviderSessionRegistration): void {
    this.interactionAdapter.registerSession(sessionId, interaction);
  }

  async createSession(
    _phase: string,
    label: string,
    options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    const clientSessionKey = options.clientSessionKey;
    const mode = options.mode ?? "build";
    const response = await bridgeFetch(
      this.connection,
      "/session/create",
      {
        method: "POST",
        body: JSON.stringify(
          this.agent === "codex"
            ? {
                title: label,
                model: options.model ?? this.connection.model,
                modelReasoningEffort: options.effort ?? this.connection.effort,
                mode,
                clientSessionKey,
                agentMcp: options.agentMcp,
                policy: options.policy,
              }
            : this.agent === "cursor" || this.agent === "grok" || this.agent === "pi"
              ? {
                  title: label,
                  clientSessionKey,
                  model: options.model ?? this.connection.model,
                  reasoningEffort: options.effort ?? this.connection.effort,
                  mode,
                  readOnly: options.readOnly ?? (options.mode === "build" ? false : undefined),
                  agentMcp: options.agentMcp,
                  policy: options.policy,
                  ...(typeof (options.fastMode ?? this.connection.fastMode) === "boolean"
                    ? { fastMode: options.fastMode ?? this.connection.fastMode }
                    : {}),
                }
              : {
                  title: label,
                  clientSessionKey,
                  agentMcp: options.agentMcp,
                  policy: options.policy,
                },
        ),
      },
      this.fetchImpl,
      "session-start",
    );
    await assertOkWithErrorDetail(response, `${this.agent} session creation`);
    const body = (await response.json()) as { sessionId?: unknown };
    if (typeof body.sessionId !== "string") {
      throw new Error(`${this.agent} returned a malformed session`);
    }
    this.registerSession(body.sessionId, options.interaction);
    if (this.agent === "codex") this.codexModes.set(body.sessionId, mode);
    return body.sessionId;
  }

  /** Best-effort bridge cold-start outside the at-most-once dispatch window. */
  async prepareDispatch(sessionId: string): Promise<void> {
    if (this.agent !== "cursor" && this.agent !== "grok" && this.agent !== "pi") return;
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/attach`,
      { method: "POST", body: "{}" },
      this.fetchImpl,
      "attach",
    );
    // 404 is an older bridge or a session this bridge no longer holds. Neither
    // is worth failing on: the prompt request answers both authoritatively.
    if (response.status === 404) return;
    await assertOkWithErrorDetail(response, `${this.agent} session attach`);
  }

  /**
   * Ask the bridge whether it already holds this request id.
   *
   * Answers `dispatched` only on an explicit positive from the bridge's own
   * dispatch journal. A missing route, an unknown session, an unparseable body
   * and a record lost to a bridge restart all read as `unknown`, because none
   * of them is evidence that the prompt did not run.
   */
  async dispatchStatus(sessionId: string, requestId: string): Promise<ProviderDispatchStatus> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/dispatch` +
        `?requestId=${encodeURIComponent(requestId)}`,
      {},
      this.fetchImpl,
    );
    if (!response.ok) return "unknown";
    const body = asRecord(
      await boundedJson(response, `${this.agent} dispatch status`).catch(() => null),
    );
    return body?.dispatch === "dispatched" ? "dispatched" : "unknown";
  }

  async activeSteerRun(sessionId: string): Promise<ProviderActiveSteerRun> {
    const response = await fetchSessionSnapshot(this.connection, sessionId, this.fetchImpl);
    if (response.status === 404)
      throw new PromptRejectedError(`${this.agent} session was not found`);
    await assertOkWithErrorDetail(response, `${this.agent} steer status read`);
    const status = asRecord(
      await boundedJson(
        response,
        `${this.agent} steer status read`,
        sessionSnapshotBudget(this.agent),
      ),
    );
    if (status?.status !== "running") return { state: "idle" };
    const candidateRunId = nonEmptyString(status.turnId);
    const runId =
      candidateRunId && Buffer.byteLength(candidateRunId, "utf8") <= 512
        ? candidateRunId
        : undefined;
    return runId ? { state: "running", runId } : { state: "unknown" };
  }

  async steerSupported(sessionId: string): Promise<boolean> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/steer/dispatch` +
        `?requestId=${encodeURIComponent("orkestrator-steer-qualification")}`,
      {},
      this.fetchImpl,
    ).catch(() => null);
    if (!response?.ok) return false;
    const body = asRecord(
      await boundedJson(response, `${this.agent} steer qualification`).catch(() => null),
    );
    return body?.dispatch === "unknown" || body?.dispatch === "dispatched";
  }

  async steerStatus(sessionId: string, requestId: string): Promise<ProviderSteerDispatchStatus> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/steer/dispatch` +
        `?requestId=${encodeURIComponent(requestId)}`,
      {},
      this.fetchImpl,
    );
    if (!response.ok) return "unknown";
    const body = asRecord(
      await boundedJson(response, `${this.agent} steer status`).catch(() => null),
    );
    if (body?.dispatch === "dispatched") return "dispatched";
    if (body?.dispatch === "absent") return "absent";
    return "unknown";
  }

  async send(sessionId: string, prompt: string, options: ProviderSendOptions): Promise<void> {
    if (this.agent === "codex" && options.mode && this.codexModes.get(sessionId) !== options.mode) {
      await this.ensureCodexMode(sessionId, options.mode);
      this.codexModes.set(sessionId, options.mode);
    }
    const attachments = bridgePromptAttachments(
      this.agent,
      await resolvePromptAttachments(options, this.stageImages),
    );
    let response: Response;
    try {
      response = await bridgeFetch(
        this.connection,
        `/session/${encodeURIComponent(sessionId)}/prompt`,
        {
          method: "POST",
          body: JSON.stringify({
            prompt,
            requestId: options.requestId,
            attachments,
            outputSchema: options.schema,
            readOnly: options.readOnly ?? (options.mode === "build" ? false : undefined),
            parameterValues: options.parameterValues,
            persistDefaults: options.persistDefaults,
            ...(this.agent === "claude"
              ? {
                  model: options.model ?? this.connection.model,
                  effort: options.effort ?? this.connection.effort,
                  fastMode: options.fastMode ?? this.connection.fastMode,
                  agent: options.subAgent,
                  includeLocalSettings: options.includeLocalSettings,
                  promptSuggestions: options.promptSuggestions,
                  agentMcp: options.agentMcp,
                  permissionMode: options.readOnly
                    ? "dontAsk"
                    : options.mode === "plan"
                      ? "plan"
                      : typeof options.parameterValues?.permissionMode === "string"
                        ? options.parameterValues.permissionMode
                        : "bypassPermissions",
                }
              : this.agent === "codex"
                ? {
                    fastMode: options.fastMode ?? this.connection.fastMode,
                    agentMcp: options.agentMcp,
                  }
                : this.agent === "cursor" || this.agent === "grok" || this.agent === "pi"
                  ? {
                      fastMode: options.fastMode ?? this.connection.fastMode,
                      model: options.model ?? this.connection.model,
                      reasoningEffort: options.effort ?? this.connection.effort,
                      mode: options.mode,
                      agentMcp: options.agentMcp,
                    }
                  : { fastMode: options.fastMode ?? this.connection.fastMode }),
          }),
        },
        this.fetchImpl,
        "prompt",
      );
    } catch (error) {
      // A bridge that was never reached cannot have run the turn, so this is a
      // plain retryable rejection. Parking it as ambiguous would ask the user
      // to resolve a dispatch that provably never happened.
      if (error instanceof ProviderUnreachableError) throw error;
      if (error instanceof ProviderUnavailableError) {
        throw new AmbiguousPromptDispatchError(`${this.agent} prompt dispatch outcome is unknown`, {
          cause: error,
        });
      }
      throw error;
    }
    // A session can briefly disappear while a bridge reconciles a restarted
    // provider, and an idle status read can race with another client starting a
    // turn. Both are retryable dispatch races, not validation rejections that
    // should park the user's prompt indefinitely.
    if (
      response.status === 404 ||
      response.status === 409 ||
      isTransientHttpStatus(response.status)
    ) {
      throw new ProviderUnavailableError(
        `${this.agent} prompt dispatch is temporarily unavailable (HTTP ${response.status})`,
      );
    }
    if (!response.ok) {
      // Bridges answer terminal rejections with an actionable message (e.g. an
      // ACP prompt whose outcome is unknown after a restart). Surface it so the
      // pipeline failure tells the user what to do instead of a bare status.
      const detail = asRecord(await response.json().catch(() => null));
      const detailText = nonEmptyString(detail?.error)?.trim() ?? "";
      // Cursor uses 401 for a missing SDK credential as well as for bridge
      // transport authentication. The former is an expected, user-actionable
      // admission failure, so preserve the bridge's friendly instruction and
      // do not expose the lowercase provider key or HTTP plumbing in the chat.
      if (
        this.agent === "cursor" &&
        response.status === 401 &&
        detailText &&
        detail?.kind === "authentication-required"
      ) {
        throw new PromptRejectedError(detailText);
      }
      const detailMessage = detailText ? `: ${detailText}` : "";
      throw new PromptRejectedError(
        `${this.agent} rejected the prompt (HTTP ${response.status})${detailMessage}`,
      );
    }
  }

  /**
   * Codex stores execution mode on the session rather than accepting it on the
   * prompt route. Reused workflow threads can move between plan and build
   * turns, so reconcile the idle thread before dispatching when needed.
   */
  private async ensureCodexMode(sessionId: string, mode: ProviderExecutionMode): Promise<void> {
    const path = `/session/${encodeURIComponent(sessionId)}/config`;
    const currentResponse = await bridgeFetch(this.connection, path, {}, this.fetchImpl);
    if (
      currentResponse.status === 404 ||
      currentResponse.status === 409 ||
      isTransientHttpStatus(currentResponse.status)
    ) {
      throw new ProviderUnavailableError(
        `Codex mode reconciliation is temporarily unavailable (HTTP ${currentResponse.status})`,
      );
    }
    assertOk(currentResponse, "Codex config read");
    const current = (await currentResponse.json()) as {
      model?: unknown;
      modelReasoningEffort?: unknown;
      mode?: unknown;
      fastMode?: unknown;
      durable?: unknown;
    };
    if (
      (current.mode !== "plan" && current.mode !== "build") ||
      (current.model !== undefined && typeof current.model !== "string") ||
      (current.modelReasoningEffort !== undefined &&
        typeof current.modelReasoningEffort !== "string") ||
      typeof current.fastMode !== "boolean" ||
      typeof current.durable !== "boolean"
    ) {
      throw new Error("Codex returned a malformed session config");
    }
    if (current.mode === mode && current.durable) return;

    const updateResponse = await bridgeFetch(
      this.connection,
      path,
      {
        method: "POST",
        body: JSON.stringify({
          model: current.model,
          modelReasoningEffort: current.modelReasoningEffort,
          mode,
          fastMode: current.fastMode,
        }),
      },
      this.fetchImpl,
    );
    if (
      updateResponse.status === 404 ||
      updateResponse.status === 409 ||
      isTransientHttpStatus(updateResponse.status)
    ) {
      throw new ProviderUnavailableError(
        `Codex mode update is temporarily unavailable (HTTP ${updateResponse.status})`,
      );
    }
    assertOk(updateResponse, "Codex config update");
    const update = (await updateResponse.json()) as { durable?: unknown };
    if (update.durable !== true) {
      throw new ProviderUnavailableError("Codex mode update was not durably persisted");
    }
  }

  /**
   * Read the session's lifecycle state.
   *
   * The failed-turn contract is split, so read it before branching on the
   * result: a terminal turn error is delivered as a `ProviderSessionFailedError`
   * **throw** when the bridge supplied a detail, and returned as `"error"` only
   * when it did not. A caller that branches on `status === "error"` therefore
   * reaches that branch exactly when the provider declined to explain itself —
   * which is backwards. Any such caller must read through `readProviderStatus`,
   * which turns the throw back into `{ status: "error", error }` so the branch
   * fires either way and the detail is available to it.
   */
  async status(sessionId: string): Promise<ProviderStatus> {
    return (await this.observeSession(sessionId)).status;
  }

  async refreshUsage(sessionId: string): Promise<NativeAgentContextUsage | undefined> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/usage`,
      {},
      this.fetchImpl,
    );
    // Usage is an additive capability. Older bridges and providers without a
    // detailed account endpoint keep their last ordinary status snapshot.
    if (response.status === 404 || response.status === 405) return undefined;
    assertOk(response, `${this.agent} usage read`);
    const body = asRecord(await boundedJson(response, `${this.agent} usage read`));
    return contextUsageWithPlanUsage(this.agent, body?.contextUsage);
  }

  async observeSession(sessionId: string): Promise<ProviderSessionObservation> {
    const response = await fetchSessionSnapshot(this.connection, sessionId, this.fetchImpl);
    if (response.status === 404) return { status: "missing" };
    assertOk(response, `${this.agent} status read`);
    const body =
      asRecord(
        await boundedJson(response, `${this.agent} status read`, {
          remaining: 16 * 1024 * 1024,
        }),
      ) ?? {};
    if (body.status === "error" && typeof body.error === "string") {
      const detail = body.error.trim().slice(0, 4_000);
      if (detail) {
        throw new ProviderSessionFailedError(this.agent, detail);
      }
    }
    const status =
      body.status === "running" || body.status === "idle" || body.status === "error"
        ? body.status
        : "error";
    const contextUsage = contextUsageWithPlanUsage(this.agent, body.contextUsage);
    return {
      status,
      // sessionTokens has explicit cumulative semantics. Do not expose an
      // occupancy-only bridge snapshot as review consumption.
      ...(contextUsage?.sessionTokens !== undefined ? { contextUsage } : {}),
      ...(this.agent === "cursor" &&
      status === "idle" &&
      contextUsage !== undefined &&
      contextUsage.sessionTokens === undefined
        ? { usagePending: true }
        : {}),
    };
  }

  /**
   * Read activity from the bridge's dedicated observation route.
   *
   * This deliberately does not reuse `status()` plus the pending-input routes.
   * Those are the routes a *tab* reads, so each one is a liveness touch: the
   * codex bridge refreshes `lastAccessed` (blocking idle thread detaching) and
   * the claude bridge additionally hydrates the persisted transcript. This
   * method is polled every couple of seconds for every session in every
   * environment, so it must have no side effect at all — `/activity` exists
   * only to answer it.
   *
   * The route reports an unknown session in-band as `missing` and never 404s.
   * A 404 here therefore means the route itself is absent — an older bridge —
   * and must surface as a failure rather than as "this session is gone", which
   * the caller would act on by deleting the user's session mapping.
   */
  async observeActivity(sessionId: string): Promise<ProviderActivityObservation> {
    return readProviderActivityObservation(this.connection, sessionId, this.fetchImpl);
  }

  async activity(sessionId: string): Promise<ProviderActivityState> {
    return (await this.observeActivity(sessionId)).state;
  }

  private async readLegacyTranscript(sessionId: string): Promise<LegacyTranscriptSnapshot> {
    return readHttpBridgeLegacyTranscript({
      agent: this.agent,
      connection: this.connection,
      fetchImpl: this.fetchImpl,
      sessionId,
    });
  }

  async transcriptSnapshot(
    sessionId: string,
    options: { limit: number; targetBytes: number; knownSourceToken?: string },
  ): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> {
    return readHttpBridgeTranscriptSnapshot({
      agent: this.agent,
      connection: this.connection,
      fetchImpl: this.fetchImpl,
      sessionId,
      options,
      readLegacy: () => this.readLegacyTranscript(sessionId),
    });
  }

  /** Legacy bounded message surface retained for older callers. */
  async messages(sessionId: string, options?: { limit?: number }): Promise<unknown[]> {
    const messages = (await this.readLegacyTranscript(sessionId)).messages;
    const limit = options?.limit;
    if (limit === undefined) return messages;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError(`${this.agent} transcript limit must be a positive integer`);
    }
    return messages.length > limit ? messages.slice(-limit) : messages;
  }

  async sessionStateSnapshot(sessionId: string): Promise<ProviderSessionStateSnapshot> {
    return readHttpBridgeAuthoritativeSessionState({
      agent: this.agent,
      connection: this.connection,
      fetchImpl: this.fetchImpl,
      sessionId,
      metadata: this.interactiveMetadata,
      refreshRuntimeMetadata: () => this.refreshRuntimeMetadata(sessionId),
      readRuntimeHealth: () => this.runtimeHealth(sessionId),
    });
  }

  /**
   * Bounded inventory, drift and provider diagnostics for one session.
   *
   * Answers in band for a bridge that predates the route and for a session it
   * does not have. A failure here must never fail the environment: this hop
   * cannot tell "older bridge" from "gone session", and health is optional
   * metadata either way — the authoritative liveness answer is `/activity`.
   */
  async runtimeHealth(sessionId: string): Promise<ProviderRuntimeHealth> {
    try {
      const response = await bridgeFetch(
        this.connection,
        `/session/${encodeURIComponent(sessionId)}/runtime-health`,
        {},
        this.fetchImpl,
      );
      if (!response.ok) return { summary: {}, notices: [], authoritative: false };
      const summary = bridgeRuntimeSummary(
        await boundedJson(response, `${this.agent} runtime health read`, {
          remaining: 512 * 1024,
        }),
      );
      if (!summary) return { summary: {}, notices: [], authoritative: false };
      return { summary, notices: summary.notices ?? [], authoritative: true };
    } catch {
      return { summary: {}, notices: [], authoritative: false };
    }
  }

  private refreshRuntimeMetadata(sessionId: string): Promise<void> {
    return refreshHttpBridgeRuntimeMetadata({
      sessionId,
      metadata: this.interactiveMetadata,
      refreshes: this.runtimeMetadataRefreshes,
      generation: this.runtimeMetadataGeneration,
      currentGeneration: () => this.runtimeMetadataGeneration,
      read: () => this.runtimeHealth(sessionId),
    });
  }

  async interactiveSnapshot(sessionId: string): Promise<ProviderInteractiveSnapshot> {
    const cachedMetadata = this.interactiveMetadata.get(sessionId);
    const refreshMetadata = !cachedMetadata || cachedMetadata.expiresAt <= Date.now();
    if (cachedMetadata && refreshMetadata) {
      // Runtime health is optional and no-touch. Keep the previous snapshot on
      // the foreground path while a bounded refresh runs for every bridge.
      void this.refreshRuntimeMetadata(sessionId);
    }
    if (this.agent === "cursor" || this.agent === "grok" || this.agent === "pi") {
      const [response, transcript, health, bridgeQueue] = await Promise.all([
        bridgeFetch(
          this.connection,
          `/session/${encodeURIComponent(sessionId)}/status`,
          {},
          this.fetchImpl,
        ),
        this.readLegacyTranscript(sessionId),
        refreshMetadata && !cachedMetadata
          ? this.runtimeHealth(sessionId)
          : Promise.resolve(undefined),
        this.agent === "pi"
          ? bridgeFetch(
              this.connection,
              `/session/${encodeURIComponent(sessionId)}/queue`,
              {},
              this.fetchImpl,
            )
              .then(async (queueResponse) =>
                queueResponse.ok
                  ? asRecord(await boundedJson(queueResponse, "Pi queue snapshot"))
                  : undefined,
              )
              .catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      if (response.status === 404) return { status: "missing", messages: [] };
      assertOk(response, `${this.agent} interactive status`);
      const payload = asRecord(
        await boundedJson(response, `${this.agent} interactive status`, { remaining: 512 * 1024 }),
      );
      // `/messages` returns status and revision from the same synchronous ACP
      // snapshot as its transcript. Prefer that pair so a turn transition
      // between the parallel requests cannot combine two different revisions.
      const hasTranscriptSnapshot =
        transcript.status !== undefined && transcript.revision !== undefined;
      const status = hasTranscriptSnapshot ? transcript.status : payload?.status;
      const messages = transcript.messages;
      const composer = asRecord(payload?.composer);
      const providerRevision = hasTranscriptSnapshot ? transcript.revision : payload?.revision;
      const providerError = hasTranscriptSnapshot ? transcript.error : payload?.error;
      if (
        (status !== "idle" && status !== "running" && status !== "error") ||
        !Array.isArray(messages) ||
        !Number.isSafeInteger(providerRevision) ||
        !composer ||
        !Array.isArray(composer.models) ||
        !Array.isArray(composer.modes)
      ) {
        throw new ProviderUnavailableError(
          `${this.agent} returned a malformed interactive snapshot`,
        );
      }
      const contextUsage = contextUsageWithPlanUsage(this.agent, payload?.contextUsage);
      const statusRuntime = normalizeProviderRuntimeSummary(payload?.runtime);
      const healthRuntime =
        health && Object.keys(health.summary).length > 0 ? health.summary : undefined;
      const runtime =
        healthRuntime || statusRuntime || cachedMetadata?.runtime
          ? {
              ...cachedMetadata?.runtime,
              ...statusRuntime,
              ...healthRuntime,
            }
          : undefined;
      if (refreshMetadata && !cachedMetadata && health) {
        setBoundedMapEntry(
          this.interactiveMetadata,
          sessionId,
          {
            expiresAt:
              Date.now() +
              (health.authoritative === false
                ? INTERACTIVE_RUNTIME_METADATA_RETRY_MS
                : INTERACTIVE_RUNTIME_METADATA_TTL_MS),
            ...(runtime ? { runtime } : {}),
            runtimeHealthAuthoritative: health.authoritative !== false,
          },
          MAX_TRACKED_INTERACTION_SESSIONS,
        );
      }
      const readiness = normalizeProviderReadiness(payload?.readiness);
      const policy = isNativeAgentExecutionPolicy(payload?.policy) ? payload.policy : undefined;
      const reportedKinds = asRecord(asRecord(payload?.capabilities)?.interactions)?.kinds;
      const interactionKinds = Array.isArray(reportedKinds)
        ? reportedKinds.filter((kind): kind is string => typeof kind === "string")
        : undefined;
      const noticeOptions: Parameters<typeof snapshotNotices>[0] = {
        transcriptTruncated: transcript.truncated,
        ...(runtime ? { runtime } : {}),
      };
      const statusNotices = snapshotNotices(noticeOptions);
      return {
        status,
        messages,
        messagesComplete: !transcript.truncated,
        ...(typeof payload?.title === "string" && payload.title.trim()
          ? { title: payload.title.trim() }
          : {}),
        composer: composer as unknown as NativeAgentComposerState,
        ...(readiness ? { readiness } : {}),
        providerRevision: providerRevision as number,
        ...(contextUsage ? { contextUsage } : {}),
        ...(policy ? { policy } : {}),
        ...(runtime ? { runtime } : {}),
        ...(health
          ? { runtimeHealthAuthoritative: health.authoritative !== false }
          : cachedMetadata?.runtimeHealthAuthoritative !== undefined
            ? { runtimeHealthAuthoritative: cachedMetadata.runtimeHealthAuthoritative }
            : {}),
        ...(Array.isArray(bridgeQueue?.items)
          ? { providerQueue: { items: bridgeQueue.items.slice(0, 512) } }
          : {}),
        // The bridge's own answer for this session, which overrides the
        // platform table. Pi reports it; the others do not, and absent leaves
        // the table standing.
        ...(interactionKinds ? { interactionKinds } : {}),
        ...(statusNotices.length > 0 ? { notices: statusNotices } : {}),
        ...(typeof providerError === "string" ? { error: providerError } : {}),
      };
    }

    const sessionPath =
      this.agent === "codex"
        ? `/session/${encodeURIComponent(sessionId)}/status`
        : `/session/${encodeURIComponent(sessionId)}`;
    const [sessionResponse, transcript, configResponse, initResponse, runtimeResponse] =
      await Promise.all([
        bridgeFetch(this.connection, sessionPath, {}, this.fetchImpl),
        this.readLegacyTranscript(sessionId),
        this.agent === "codex"
          ? bridgeFetch(
              this.connection,
              `/session/${encodeURIComponent(sessionId)}/config`,
              {},
              this.fetchImpl,
            )
          : Promise.resolve(undefined),
        this.agent === "claude" && refreshMetadata
          ? bridgeFetch(
              this.connection,
              `/session/${encodeURIComponent(sessionId)}/init`,
              {},
              this.fetchImpl,
            )
          : Promise.resolve(undefined),
        refreshMetadata && !cachedMetadata
          ? this.runtimeHealth(sessionId)
          : Promise.resolve(undefined),
      ]);
    const messages = transcript.messages;
    if (sessionResponse.status === 404) return { status: "missing", messages: [] };
    assertOk(sessionResponse, `${this.agent} interactive session read`);
    const payload = asRecord(
      await boundedJson(sessionResponse, `${this.agent} interactive session read`, {
        remaining: 512 * 1024,
      }),
    );
    const status = payload?.status;
    if (!payload || (status !== "idle" && status !== "running" && status !== "error")) {
      throw new ProviderUnavailableError(`${this.agent} returned a malformed interactive session`);
    }
    if (this.agent === "codex") {
      if (!configResponse) {
        throw new ProviderUnavailableError("Codex interactive config response is missing");
      }
      assertOk(configResponse, "Codex interactive config read");
      const config = asRecord(
        await boundedJson(configResponse, "Codex interactive config read", {
          remaining: 128 * 1024,
        }),
      );
      const rawPhase = payload?.phase;
      let runtime: NativeAgentRuntimeSummary | undefined = cachedMetadata?.runtime;
      if (runtimeResponse?.authoritative !== false) runtime = runtimeResponse?.summary ?? runtime;
      if (refreshMetadata && !cachedMetadata && runtimeResponse) {
        setBoundedMapEntry(
          this.interactiveMetadata,
          sessionId,
          {
            expiresAt:
              Date.now() +
              (runtimeResponse.authoritative === false
                ? INTERACTIVE_RUNTIME_METADATA_RETRY_MS
                : INTERACTIVE_RUNTIME_METADATA_TTL_MS),
            ...(runtime ? { runtime } : {}),
            runtimeHealthAuthoritative: runtimeResponse.authoritative !== false,
          },
          MAX_TRACKED_INTERACTION_SESSIONS,
        );
      }
      const codexContextUsage = contextUsageWithPlanUsage(this.agent, payload.contextUsage);
      const codexNotices = snapshotNotices({
        transcriptTruncated: transcript.truncated,
        ...(runtime ? { runtime } : {}),
      });
      const phase: NativeAgentTurnPhase | undefined =
        rawPhase === "cancelling"
          ? "cancelling"
          : rawPhase === "recovering" || rawPhase === "starting"
            ? "recovering"
            : rawPhase === "failed"
              ? "error"
              : rawPhase === "running"
                ? "running"
                : rawPhase === "idle"
                  ? "idle"
                  : undefined;
      return {
        status,
        messages,
        messagesComplete: !transcript.truncated,
        ...(typeof payload.title === "string" && payload.title.trim()
          ? { title: payload.title.trim() }
          : {}),
        controls: {
          ...(typeof config?.model === "string" ? { modelId: config.model } : {}),
          ...(typeof config?.modelReasoningEffort === "string"
            ? { reasoningId: config.modelReasoningEffort }
            : {}),
          ...(config?.mode === "build" || config?.mode === "plan" ? { mode: config.mode } : {}),
          ...(typeof config?.fastMode === "boolean" ? { fastMode: config.fastMode } : {}),
        },
        ...(phase ? { phase } : {}),
        ...(typeof payload.turnStartedAt === "string" &&
        Number.isFinite(Date.parse(payload.turnStartedAt))
          ? { turnStartedAt: Date.parse(payload.turnStartedAt) }
          : {}),
        ...(Number.isSafeInteger(payload.messageRevision)
          ? { providerRevision: payload.messageRevision as number }
          : {}),
        ...(Number.isSafeInteger(payload.engineGeneration)
          ? { providerGeneration: payload.engineGeneration as number }
          : {}),
        ...(codexContextUsage ? { contextUsage: codexContextUsage } : {}),
        ...(isNativeAgentExecutionPolicy(config?.policy) ? { policy: config.policy } : {}),
        ...(runtime ? { runtime } : {}),
        ...(runtimeResponse
          ? { runtimeHealthAuthoritative: runtimeResponse.authoritative !== false }
          : cachedMetadata?.runtimeHealthAuthoritative !== undefined
            ? { runtimeHealthAuthoritative: cachedMetadata.runtimeHealthAuthoritative }
            : {}),
        ...(codexNotices.length > 0 ? { notices: codexNotices } : {}),
        ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      };
    }
    let executionProfiles: NativeAgentComposerState["executionProfiles"] =
      cachedMetadata?.executionProfiles;
    let runtime: NativeAgentRuntimeSummary | undefined = cachedMetadata?.runtime;
    if (runtimeResponse && runtimeResponse.authoritative !== false) {
      runtime = { ...runtime, ...runtimeResponse.summary };
    }
    if (initResponse?.ok) {
      const initPayload = asRecord(
        await boundedJson(initResponse, "Claude init read", { remaining: 256 * 1024 }),
      );
      const initData = asRecord(initPayload?.initData);
      runtime = {
        ...runtime,
        mcpServers: Array.isArray(initData?.mcpServers) ? initData.mcpServers.length : 0,
        plugins: Array.isArray(initData?.plugins) ? initData.plugins.length : 0,
        commands: Array.isArray(initData?.slashCommands) ? initData.slashCommands.length : 0,
      };
      if (Array.isArray(initData?.agents)) {
        executionProfiles = initData.agents.slice(0, 128).flatMap((candidate) => {
          const agent = asRecord(candidate);
          const name = nonEmptyString(agent?.name);
          if (!name) return [];
          return [
            {
              id: name,
              label: name,
              ...(typeof agent?.description === "string" ? { description: agent.description } : {}),
              ...(typeof agent?.model === "string" ? { modelId: agent.model } : {}),
            },
          ];
        });
      }
    }
    if (refreshMetadata) {
      if (cachedMetadata) {
        // A background health refresh owns runtime and expiry once cached data
        // exists. Only merge the independent Claude-init catalogue here so a
        // slower foreground read cannot overwrite freshly reconciled notices.
        const current = this.interactiveMetadata.get(sessionId);
        if (current && executionProfiles) current.executionProfiles = executionProfiles;
      } else {
        setBoundedMapEntry(
          this.interactiveMetadata,
          sessionId,
          {
            expiresAt:
              Date.now() +
              (runtimeResponse?.authoritative === false
                ? INTERACTIVE_RUNTIME_METADATA_RETRY_MS
                : INTERACTIVE_RUNTIME_METADATA_TTL_MS),
            ...(executionProfiles ? { executionProfiles } : {}),
            ...(runtime ? { runtime } : {}),
            ...(runtimeResponse
              ? { runtimeHealthAuthoritative: runtimeResponse.authoritative !== false }
              : {}),
          },
          MAX_TRACKED_INTERACTION_SESSIONS,
        );
      }
    }
    const claudeContextUsage = contextUsageWithPlanUsage(this.agent, payload.contextUsage);
    const claudeNotices = snapshotNotices({
      transcriptTruncated: transcript.truncated,
      ...(runtime ? { runtime } : {}),
    });
    return {
      status,
      messages,
      ...(typeof payload.title === "string" && payload.title.trim()
        ? { title: payload.title.trim() }
        : {}),
      composer: {
        ...EMPTY_NATIVE_AGENT_COMPOSER_STATE,
        ...(executionProfiles?.length ? { executionProfiles } : {}),
      },
      ...(typeof payload.planMode === "boolean"
        ? { controls: { mode: payload.planMode ? "plan" : "build" } }
        : {}),
      ...(typeof payload.turnStartedAt === "number" && Number.isFinite(payload.turnStartedAt)
        ? { turnStartedAt: payload.turnStartedAt }
        : {}),
      ...(claudeContextUsage ? { contextUsage: claudeContextUsage } : {}),
      ...(isNativeAgentExecutionPolicy(payload.policy) ? { policy: payload.policy } : {}),
      ...(normalizeProviderRateLimits(payload.rateLimits).length > 0
        ? { rateLimits: normalizeProviderRateLimits(payload.rateLimits) }
        : {}),
      ...(runtime ? { runtime } : {}),
      ...(runtimeResponse
        ? { runtimeHealthAuthoritative: runtimeResponse.authoritative !== false }
        : cachedMetadata?.runtimeHealthAuthoritative !== undefined
          ? { runtimeHealthAuthoritative: cachedMetadata.runtimeHealthAuthoritative }
          : {}),
      ...(claudeNotices.length > 0 ? { notices: claudeNotices } : {}),
      ...(normalizeClaudeBackgroundTasks(payload.backgroundTasks)
        ? { backgroundTasks: normalizeClaudeBackgroundTasks(payload.backgroundTasks) }
        : {}),
      ...(typeof payload.promptSuggestion === "string"
        ? { suggestedPrompt: payload.promptSuggestion.slice(0, 4_000) }
        : {}),
      ...(typeof payload.completionBlockedByBackgroundTasks === "boolean"
        ? { completionBlockedByBackgroundTasks: payload.completionBlockedByBackgroundTasks }
        : {}),
      ...(typeof payload.error === "string" ? { error: payload.error } : {}),
    };
  }

  async updateInteractiveControls(
    sessionId: string,
    update: NativeAgentControlUpdate,
  ): Promise<NativeAgentComposerState | undefined> {
    if (this.agent === "claude") {
      const response = await bridgeFetch(
        this.connection,
        `/session/${encodeURIComponent(sessionId)}/config`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(update.modelId ? { model: update.modelId } : {}),
            ...(update.reasoningId ? { reasoningId: update.reasoningId } : {}),
            ...(update.mode ? { mode: update.mode } : {}),
            ...(update.fastMode === undefined ? {} : { fastMode: update.fastMode }),
            ...(update.parameterValues ? { parameterValues: update.parameterValues } : {}),
          }),
        },
        this.fetchImpl,
      );
      await assertOkWithErrorDetail(response, "Claude session config update");
      return undefined;
    }
    if (this.agent === "codex") {
      const response = await bridgeFetch(
        this.connection,
        `/session/${encodeURIComponent(sessionId)}/config`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(update.modelId ? { model: update.modelId } : {}),
            ...(update.reasoningId ? { modelReasoningEffort: update.reasoningId } : {}),
            ...(update.mode ? { mode: update.mode } : {}),
            ...(update.fastMode === undefined ? {} : { fastMode: update.fastMode }),
            ...(update.parameterValues ? { parameterValues: update.parameterValues } : {}),
          }),
        },
        this.fetchImpl,
      );
      assertOk(response, "Codex session config update");
      return undefined;
    }
    if (this.agent !== "cursor" && this.agent !== "grok" && this.agent !== "pi") {
      return undefined;
    }
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/config`,
      { method: "POST", body: JSON.stringify(update) },
      this.fetchImpl,
    );
    await assertOkWithErrorDetail(response, `${this.agent} config update`);
    const composer = asRecord(await boundedJson(response, `${this.agent} config update`));
    if (!composer || !Array.isArray(composer.models) || !Array.isArray(composer.modes)) {
      throw new ProviderUnavailableError(`${this.agent} returned a malformed composer`);
    }
    return composer as unknown as NativeAgentComposerState;
  }

  async refreshCatalog(): Promise<void> {
    // Execution profiles and runtime inventory are discovered alongside models,
    // so an explicit refresh has to drop them too or the picker re-renders the
    // same stale list it was asked to replace.
    this.runtimeMetadataGeneration += 1;
    this.interactiveMetadata.clear();
    // Providers with live discovery state refresh their own authority here;
    // older bridges answer 404 and remain compatible with the cache-only path.
    const response = await bridgeFetch(
      this.connection,
      "/global/refresh-catalog",
      { method: "POST" },
      this.fetchImpl,
      "catalog-refresh",
    );
    // Compatibility with bridges from before the refresh route existed.
    // Not an error: `refreshProjectionModels` has already dropped its own
    // caches, so re-listing still gets the best catalogue that older bridge can
    // provide. Any *other* failing status is reported, and the caller decides
    // what to do with it — today it logs and re-lists anyway rather than
    // failing the refresh the user asked for.
    if (response.status !== 404) {
      await assertOkWithErrorDetail(response, `${this.agent} catalogue refresh`);
    }
  }

  async listResumableSessions(): Promise<NativeAgentResumeEntry[]> {
    const response = await bridgeFetch(this.connection, "/session/list", {}, this.fetchImpl);
    // The ACP bridge answers 410 with the reason the agent cannot list its own
    // history. Dropping that body would reduce a specific, actionable message
    // to a bare status code in front of the user.
    await assertOkWithErrorDetail(response, `${this.agent} resumable session list`);
    const payload = asRecord(
      await boundedJson(response, `${this.agent} resumable session list`, {
        remaining: 2 * 1024 * 1024,
      }),
    );
    if (!payload || !Array.isArray(payload.sessions)) {
      throw new ProviderUnavailableError(`${this.agent} returned a malformed session list`);
    }
    return payload.sessions.slice(0, 512).flatMap((candidate) => {
      const session = asRecord(candidate);
      const id = nonEmptyString(session?.id);
      if (!id) return [];
      const createdAt = nonEmptyString(session?.createdAt);
      const updatedAt = nonEmptyString(session?.updatedAt) ?? nonEmptyString(session?.lastActivity);
      const status =
        session?.status === "running" || session?.status === "error" || session?.status === "idle"
          ? session.status
          : undefined;
      const messageCount = Number.isSafeInteger(session?.messageCount)
        ? (session!.messageCount as number)
        : undefined;
      const parentId = nonEmptyString(session?.parentId);
      const branchLabel = nonEmptyString(session?.branchLabel);
      return [
        {
          sessionId: id,
          ...(typeof session?.title === "string" ? { title: session.title } : {}),
          ...(createdAt && Number.isFinite(Date.parse(createdAt)) ? { createdAt } : {}),
          ...(updatedAt && Number.isFinite(Date.parse(updatedAt)) ? { updatedAt } : {}),
          ...(status ? { status } : {}),
          ...(messageCount === undefined
            ? {}
            : { detail: `${messageCount} message${messageCount === 1 ? "" : "s"}` }),
          ...(parentId ? { parentId: parentId.slice(0, 512) } : {}),
          ...(branchLabel ? { branchLabel: branchLabel.slice(0, 256) } : {}),
        },
      ];
    });
  }

  slashCommands(sessionId?: string) {
    return this.catalogAdapter.slashCommands(sessionId);
  }

  mcpServers(sessionId: string) {
    return this.catalogAdapter.mcpServers(sessionId);
  }

  mcpServerAction(
    sessionId: string,
    serverId: string,
    action: Parameters<HttpBridgeCatalogAdapter["mcpServerAction"]>[2],
  ) {
    return this.catalogAdapter.mcpServerAction(sessionId, serverId, action);
  }

  authStatus() {
    return this.catalogAdapter.authStatus();
  }

  beginSignIn() {
    return this.catalogAdapter.beginSignIn();
  }

  signOut() {
    return this.catalogAdapter.signOut();
  }

  setSessionTitle(sessionId: string, title: string) {
    return this.catalogAdapter.setSessionTitle(sessionId, title);
  }

  async stopBackgroundTask(sessionId: string, taskId: string): Promise<void> {
    if (this.agent !== "claude") {
      throw new PromptRejectedError(`${this.agent} does not support background tasks`);
    }
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/stop`,
      { method: "POST" },
      this.fetchImpl,
    );
    await assertOkWithErrorDetail(response, "Claude background task stop");
  }

  async dismissSuggestedPrompt(sessionId: string): Promise<void> {
    if (this.agent !== "claude") {
      throw new PromptRejectedError(`${this.agent} does not support prompt suggestions`);
    }
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/prompt-suggestion`,
      { method: "DELETE" },
      this.fetchImpl,
    );
    if (response.status !== 404) {
      await assertOkWithErrorDetail(response, "Claude prompt suggestion dismissal");
    }
  }

  async resumeSession(
    sessionId: string,
    controls?: NativeAgentControlUpdate,
    policy?: NativeAgentExecutionPolicy,
  ): Promise<string> {
    if (this.agent === "cursor" || this.agent === "grok" || this.agent === "pi") {
      const response = await bridgeFetch(
        this.connection,
        "/session/resume",
        {
          method: "POST",
          body: JSON.stringify({
            sessionId,
            ...(controls?.modelId ? { modelId: controls.modelId } : {}),
            ...(controls?.reasoningId ? { reasoningId: controls.reasoningId } : {}),
            ...(controls?.mode ? { mode: controls.mode } : {}),
            ...(controls?.fastMode === undefined ? {} : { fastMode: controls.fastMode }),
            ...(controls?.parameterValues ? { parameterValues: controls.parameterValues } : {}),
            ...(policy ? { policy } : {}),
          }),
        },
        this.fetchImpl,
      );
      await assertOkWithErrorDetail(response, `${this.agent} session resume`);
      const payload = asRecord(await boundedJson(response, `${this.agent} session resume`));
      const resumedId = nonEmptyString(payload?.sessionId);
      if (!resumedId) {
        throw new ProviderUnavailableError(`${this.agent} returned a malformed resumed session`);
      }
      return resumedId;
    }
    if (this.agent === "claude") {
      const response = await bridgeFetch(
        this.connection,
        `/session/${encodeURIComponent(sessionId)}`,
        {},
        this.fetchImpl,
      );
      assertOk(response, "Claude session resume");
      if (policy) {
        const policyResponse = await bridgeFetch(
          this.connection,
          `/session/${encodeURIComponent(sessionId)}/config`,
          { method: "POST", body: JSON.stringify({ policy }) },
          this.fetchImpl,
        );
        await assertOkWithErrorDetail(policyResponse, "Claude resumed session policy update");
      }
      return sessionId;
    }
    const response = await bridgeFetch(
      this.connection,
      "/session/resume",
      {
        method: "POST",
        body: JSON.stringify({
          threadId: sessionId,
          ...(controls?.modelId ? { model: controls.modelId } : {}),
          ...(controls?.reasoningId ? { modelReasoningEffort: controls.reasoningId } : {}),
          ...(controls?.mode ? { mode: controls.mode } : {}),
          ...(controls?.fastMode === undefined ? {} : { fastMode: controls.fastMode }),
          ...(controls?.parameterValues ? { parameterValues: controls.parameterValues } : {}),
          ...(policy ? { policy } : {}),
        }),
      },
      this.fetchImpl,
    );
    assertOk(response, "Codex session resume");
    const payload = asRecord(await boundedJson(response, "Codex session resume"));
    const resumedId = nonEmptyString(payload?.sessionId);
    if (!resumedId)
      throw new ProviderUnavailableError("Codex returned a malformed resumed session");
    return resumedId;
  }

  async forkSession(sessionId: string, messageId?: string): Promise<NativeAgentForkOutcome> {
    if (this.agent === "cursor" || this.agent === "grok") {
      throw new PromptRejectedError(`${this.agent} does not support session forks`);
    }
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/fork`,
      {
        method: "POST",
        body: JSON.stringify(
          this.agent === "codex" ? { lastMessageId: messageId } : { upToMessageId: messageId },
        ),
      },
      this.fetchImpl,
    );
    await assertOkWithErrorDetail(response, `${this.agent} session fork`);
    const payload = asRecord(await boundedJson(response, `${this.agent} session fork`));
    const forkedId = nonEmptyString(payload?.sessionId);
    if (!forkedId) throw new ProviderUnavailableError(`${this.agent} returned a malformed fork`);
    return {
      sessionId: forkedId,
      ...(typeof payload?.title === "string" ? { title: payload.title } : {}),
      ...(typeof payload?.draft === "string" ? { draft: payload.draft } : {}),
    };
  }

  async performSessionAction(
    sessionId: string,
    action: ProviderNativeAgentSessionAction,
  ): Promise<NativeAgentSessionActionOutcome> {
    if (this.agent === "grok") {
      throw new PromptRejectedError(`${this.agent} does not support session actions`);
    }
    const base = `/session/${encodeURIComponent(sessionId)}`;
    if (action.kind === "compact") {
      const response = await bridgeFetch(
        this.connection,
        `${base}/compact`,
        { method: "POST" },
        this.fetchImpl,
      );
      await assertOkWithErrorDetail(response, `${this.agent} session compaction`);
      return { outcome: "applied" };
    }
    if (this.agent === "claude" && action.kind === "rewind-files") {
      const response = await bridgeFetch(
        this.connection,
        `${base}/rewind`,
        {
          method: "POST",
          body: JSON.stringify({ messageId: action.messageId, dryRun: action.dryRun === true }),
        },
        this.fetchImpl,
      );
      await assertOkWithErrorDetail(response, "Claude file rewind");
      return {
        outcome: "applied",
        preview: await boundedJson(response, "Claude file rewind", { remaining: 512 * 1024 }),
      };
    }
    if (this.agent === "codex" && action.kind === "review") {
      const response = await bridgeFetch(
        this.connection,
        `${base}/review`,
        { method: "POST", body: JSON.stringify({ type: "uncommittedChanges" }) },
        this.fetchImpl,
      );
      await assertOkWithErrorDetail(response, "Codex native review");
      return { outcome: "applied" };
    }
    if (
      (this.agent === "claude" || this.agent === "pi" || this.agent === "cursor") &&
      action.kind === "steer"
    ) {
      let response: Response;
      try {
        response = await bridgeFetch(
          this.connection,
          `${base}/steer`,
          {
            method: "POST",
            body: JSON.stringify({
              input: action.text,
              requestId: action.requestId,
              expectedRunId: action.expectedRunId,
            }),
          },
          this.fetchImpl,
        );
      } catch {
        return { outcome: "unknown", requestId: action.requestId };
      }
      if (response.status === 404)
        throw new PromptRejectedError(`${this.agent} session was not found`);
      const payload = asRecord(
        await boundedJson(response, `${this.agent} steer`).catch(() => ({})),
      );
      if (payload?.outcome === "unknown") {
        return { outcome: "unknown", requestId: action.requestId };
      }
      if (payload?.outcome === "idle") return { outcome: "idle" };
      if (payload?.outcome === "mismatch") return { outcome: "mismatch" };
      await assertOkWithErrorDetail(response, `${this.agent} steer`);
      return { outcome: "applied" };
    }
    if (
      (this.agent === "codex" || this.agent === "cursor" || this.agent === "pi") &&
      action.kind === "rewind-messages"
    ) {
      const response = await bridgeFetch(
        this.connection,
        `${base}/rewind-messages`,
        {
          method: "POST",
          body: JSON.stringify({ messageId: action.messageId }),
        },
        this.fetchImpl,
      );
      await assertOkWithErrorDetail(response, `${this.agent} message rewind`);
      return { outcome: "applied" };
    }
    if (this.agent === "pi" && action.kind === "switch-branch") {
      const response = await bridgeFetch(
        this.connection,
        `${base}/branches/${encodeURIComponent(action.entryId)}`,
        { method: "POST" },
        this.fetchImpl,
      );
      await assertOkWithErrorDetail(response, "Pi branch switch");
      return { outcome: "applied" };
    }
    if (this.agent === "codex" && action.kind === "steer") {
      let response: Response;
      try {
        response = await bridgeFetch(
          this.connection,
          `${base}/steer`,
          {
            method: "POST",
            body: JSON.stringify({
              input: action.text,
              requestId: action.requestId,
              expectedTurnId: action.expectedRunId,
            }),
          },
          this.fetchImpl,
        );
      } catch {
        return { outcome: "unknown", requestId: action.requestId };
      }
      const payload = asRecord(
        await boundedJson(response, "Codex steer response").catch(() => ({})),
      );
      if (payload?.outcome === "unknown")
        return { outcome: "unknown", requestId: action.requestId };
      if (payload?.outcome === "idle") return { outcome: "idle" };
      if (response.status === 409) return { outcome: "mismatch" };
      await assertOkWithErrorDetail(response, "Codex steer");
      return { outcome: "applied" };
    }
    throw new PromptRejectedError(`${this.agent} does not support ${action.kind}`);
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/structured-output?requestId=${encodeURIComponent(requestId)}`,
      {},
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} structured-output read`);
    const body = (await response.json()) as { structuredOutput?: unknown };
    return (body.structuredOutput ?? null) as StructuredOutputResult<T> | null;
  }

  async abort(sessionId: string): Promise<void> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/abort`,
      { method: "POST" },
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} abort`);
  }

  async hardAbort(sessionId: string): Promise<void> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/hard-abort`,
      { method: "POST" },
      this.fetchImpl,
    );
    if (response.status === 404) return this.abort(sessionId);
    assertOk(response, `${this.agent} hard abort`);
  }

  async closeSession(sessionId: string): Promise<void> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
      this.fetchImpl,
    );
    if (response.status !== 404) await assertOkWithErrorDetail(response, `${this.agent} close`);
    this.codexModes.delete(sessionId);
  }
}
