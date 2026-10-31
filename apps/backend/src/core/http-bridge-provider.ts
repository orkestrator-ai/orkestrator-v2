import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type {
  AgentInteractionProviderCapability,
  BridgeConnection,
  NativeAgentRuntimeProvider,
  ProviderActivityBatchEntry,
  ProviderActivityObservation,
  ProviderActivityState,
  ProviderActiveSteerRun,
  ProviderCommonDependencies,
  ProviderCreateSessionOptions,
  ProviderDispatchStatus,
  ProviderExecutionMode,
  ProviderInteractiveSnapshot,
  ProviderSessionStateSnapshot,
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
  ProviderUnavailableError,
  type ProviderMcpConfigReport,
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
  nativeAgentCapabilities,
  nativeAgentPolicyForBridge,
  parseNativeAgentSteerRejection,
} from "@orkestrator/protocol/native-agent";
import { bridgeRuntimeSummary, snapshotNotices } from "./http-bridge-runtime-health.js";
import { ensureCodexMode, updateCodexSessionConfig } from "./http-bridge-codex-config.js";
import { readBridgeMcpConfigEvidence } from "./http-bridge-mcp-evidence.js";
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
  commandCatalogueRevisionField,
  nonEmptyString,
  normalizeProviderRateLimits,
  normalizeProviderRuntimeSummary,
  setBoundedMapEntry,
} from "./agent-provider-runtime.js";
import { HttpBridgeInteractionAdapter } from "./http-bridge-interactions.js";
import { HttpBridgeCatalogAdapter, type HttpBridgeAgent } from "./http-bridge-catalog.js";
import { assertPromptOutcomeKnown, bridgePromptBody } from "./http-bridge-prompt-body.js";
import { withoutRetiredParameterValues } from "./native-agent-retired-parameters.js";
import { contextUsageWithPlanUsage, type PlanUsageState } from "./plan-usage-cache.js";
import {
  claudeBackgroundObservation,
  claudeReadOnlySandboxObservation,
  claudeTurnActivityFromPayload,
  normalizeClaudeBackgroundTasks,
} from "./http-bridge-claude-runtime.js";
import { readHttpBridgeAuthoritativeSessionState } from "./http-bridge-progressive.js";
import {
  assertOk,
  assertOkWithErrorDetail,
  throwExplainedTurnFailure,
  boundedJson,
  promptDispatchUnavailableError,
  bridgeFetch,
  normalizeProviderAuthNotice,
  normalizeProviderReadiness,
  fetchSessionSnapshot,
  readProviderActivityObservation,
  resolvePromptAttachments,
  sessionSnapshotBudget,
  type HttpBridgeProviderDependencies,
  bridgePromptAttachments,
} from "./http-bridge-transport.js";
import { closeBridgeSessionRetaining } from "./bridge-session-close.js";
import { HttpBridgeTranscriptReader } from "./http-bridge-transcript-reader.js";
import { HttpBridgeActivityBatchReader } from "./http-bridge-activity-batch.js";
import { bridgeChangeEvidenceSource } from "./http-bridge-change-evidence.js";
import { readAcpTurnTerminalError } from "./http-bridge-turn-outcome.js";
import { HttpBridgeObservationWakeup } from "./http-bridge-observation-stream.js";
import { readBridgeResumableSessions } from "./http-bridge-resumable-sessions.js";

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
  /** What this bridge connection answered about transcript v2; see the module. */
  private readonly transcripts: HttpBridgeTranscriptReader;
  /** Scoped to this connection, so a restarted bridge re-detects the batch route. */
  private readonly activityBatchReader: HttpBridgeActivityBatchReader;
  /** The bridge's change-evidence spool (docs/architecture/change-tracking.md). */
  readonly changeEvidenceSource: ReturnType<typeof bridgeChangeEvidenceSource>;
  /** Grok only: see {@link readAcpTurnTerminalError}. */
  readonly turnTerminalError?: (sessionId: string, requestId: string) => Promise<string | null>;
  /** Claude and Codex: the bridge event stream as the idle wakeup. */
  private readonly observationWakeup: HttpBridgeObservationWakeup;

  constructor(
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
    stageImages?: HttpBridgeProviderDependencies["stageImages"],
    observationHint?: ProviderCommonDependencies["onObservationHint"],
    private readonly planUsage?: PlanUsageState,
  ) {
    this.agent = connection.agent as HttpBridgeAgent;
    this.observationWakeup = new HttpBridgeObservationWakeup(
      connection,
      fetchImpl,
      observationHint,
    );
    this.transcripts = new HttpBridgeTranscriptReader(this.agent, connection, fetchImpl);
    this.stageImages = stageImages;
    this.interactionAdapter = new HttpBridgeInteractionAdapter(this.agent, connection, fetchImpl);
    this.catalogAdapter = new HttpBridgeCatalogAdapter(this.agent, connection, fetchImpl);
    this.activityBatchReader = new HttpBridgeActivityBatchReader(connection, fetchImpl);
    this.changeEvidenceSource = bridgeChangeEvidenceSource(connection, fetchImpl);
    this.interactions = this.interactionAdapter;
    if (this.agent === "grok") {
      this.turnTerminalError = (sessionId, requestId) =>
        readAcpTurnTerminalError(connection, fetchImpl, sessionId, requestId);
    }
  }

  private contextUsage(value: unknown) {
    return contextUsageWithPlanUsage(
      this.planUsage,
      this.agent,
      value,
      this.connection.accountId ?? "unknown",
    );
  }

  /** See `AgentSessionProvider.observationStreamLive` and `HttpBridgeObservationWakeup`. */
  observationStreamLive(): boolean {
    return this.observationWakeup.live();
  }

  dispose(): void {
    this.observationWakeup.close();
  }

  /**
   * The policy as this bridge reads it: capabilities newer than the bridge's
   * vocabulary travel in `extendedDeny`, with stand-ins where the bridge does
   * not translate them, so a bridge older than the backend (one baked into a
   * container image) never rejects the policy and falls back to its default.
   */
  private wirePolicy(
    policy: NativeAgentExecutionPolicy | undefined,
  ): NativeAgentExecutionPolicy | undefined {
    return policy ? nativeAgentPolicyForBridge(policy, this.agent) : undefined;
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
                policy: this.wirePolicy(options.policy),
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
                  policy: this.wirePolicy(options.policy),
                  ...(typeof (options.fastMode ?? this.connection.fastMode) === "boolean"
                    ? { fastMode: options.fastMode ?? this.connection.fastMode }
                    : {}),
                }
              : {
                  title: label,
                  clientSessionKey,
                  agentMcp: options.agentMcp,
                  policy: this.wirePolicy(options.policy),
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
  async prepareDispatch(
    sessionId: string,
    options: { agentMcp?: ProviderSendOptions["agentMcp"]; workflowResultTool?: string } = {},
  ): Promise<void> {
    if (this.agent !== "cursor" && this.agent !== "grok" && this.agent !== "pi") return;
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/attach`,
      { method: "POST", body: JSON.stringify({ agentMcp: options.agentMcp }) },
      this.fetchImpl,
      "attach",
    );
    // 404 is an older bridge or a session this bridge no longer holds. 409
    // means a turn is already in flight, so the live agent must stay put.
    // Neither is worth failing on: the prompt request answers both
    // authoritatively.
    if (response.status === 404 || response.status === 409) return;
    await assertOkWithErrorDetail(response, `${this.agent} session attach`);
  }

  /**
   * Ask the bridge whether it already holds this request id.
   *
   * Answers `dispatched` only on an explicit positive from the bridge's own
   * dispatch journal, and `absent` only on the bridge's explicit proof that the
   * id never reached it. A missing route, an unknown session and an
   * unparseable body all read as `unknown`, because none of them is evidence
   * that the prompt did not run.
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
    // The additive flag preserves `dispatched` for older backends, while a
    // newer backend can distinguish a pending turn from a completed one.
    if (body?.dispatch === "dispatched" && body.pending === true) return "pending";
    // `lost` and `absent` are additive: a bridge that predates them answers
    // `unknown` there.
    return body?.dispatch === "dispatched" ||
      body?.dispatch === "lost" ||
      body?.dispatch === "absent"
      ? body.dispatch
      : "unknown";
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
      await ensureCodexMode(this.connection, this.fetchImpl, sessionId, options.mode);
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
          body: JSON.stringify(
            bridgePromptBody(this.agent, this.connection, prompt, options, attachments),
          ),
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
    // A 500 or 502 is not evidence that the turn never started: a handler can
    // fail after its provider call (a crash, a failed send, a proxy error), and
    // Cursor's explicit `dispatch-outcome-unknown` says exactly that. Retrying
    // it as a fresh dispatch — or letting the user resend under a new id — can
    // run the same turn twice, so both park as ambiguous with the existing
    // retry-under-the-same-id and discard controls. Statuses that mean "not
    // processed" (503 unavailable, including a failed mandatory publication,
    // 408/425/429, 404/409) keep the retryable mapping below.
    if (response.status === 500 || response.status === 502) {
      throw new AmbiguousPromptDispatchError(
        `${this.agent} prompt dispatch outcome is unknown (HTTP ${response.status})`,
      );
    }
    // Missing sessions after restart and raced turns are retryable refusals.
    // Preserve the bridge's reason: changing a launch-only setting can require
    // the user to wait for background work to finish or stop it first.
    if (
      response.status === 404 ||
      response.status === 409 ||
      isTransientHttpStatus(response.status)
    ) {
      throw await promptDispatchUnavailableError(this.agent, response);
    }
    if (!response.ok) {
      // Bridges answer terminal rejections with an actionable message. Surface it
      // so a failure says what to do instead of a bare status.
      const detail = asRecord(await response.json().catch(() => null));
      assertPromptOutcomeKnown(this.agent, response.status, detail);
      const detailText = nonEmptyString(detail?.error)?.trim() ?? "";
      // A bridge answers 401 both for a missing provider login and for its own
      // transport token. Only the former carries `kind`, and it is an expected,
      // user-actionable admission failure: keep the bridge's instruction and
      // leave the provider key and HTTP plumbing out of the chat. Background
      // work never shows the readiness banner, so this is its only notice.
      if (response.status === 401 && detailText && detail?.kind === "authentication-required") {
        throw new PromptRejectedError(detailText);
      }
      // A selected command the bridge could no longer run was refused before
      // anything was sent. Its message is already user-facing and specific.
      if (response.status === 422 && detailText && detail?.kind === "command-unavailable") {
        throw new PromptRejectedError(detailText);
      }
      // A turn that requires a provider sandbox the bridge's host cannot run
      // commands in (Claude under Ubuntu's AppArmor bwrap profile). The reason
      // says what blocks it and how to allow it.
      if (response.status === 422 && detailText && detail?.kind === "sandbox-unavailable") {
        throw new PromptRejectedError(detailText);
      }
      const detailMessage = detailText ? `: ${detailText}` : "";
      throw new PromptRejectedError(
        `${this.agent} rejected the prompt (HTTP ${response.status})${detailMessage}`,
      );
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
    return this.contextUsage(body?.contextUsage);
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
    const failure = throwExplainedTurnFailure(this.agent, body);
    const status =
      body.status === "running" || body.status === "idle" || body.status === "error"
        ? body.status
        : "error";
    const contextUsage = this.contextUsage(body.contextUsage);
    return {
      status,
      ...failure,
      // sessionTokens has explicit cumulative semantics. Do not expose an
      // occupancy-only bridge snapshot as review consumption.
      ...(contextUsage?.sessionTokens !== undefined ? { contextUsage } : {}),
      ...(this.agent === "cursor" &&
      status === "idle" &&
      contextUsage !== undefined &&
      contextUsage.sessionTokens === undefined
        ? { usagePending: true }
        : {}),
      ...claudeBackgroundObservation(body, status),
      ...claudeReadOnlySandboxObservation(body),
    };
  }

  /** The no-touch `/activity` read; see {@link readProviderActivityObservation}. */
  async observeActivity(sessionId: string): Promise<ProviderActivityObservation> {
    return readProviderActivityObservation(this.connection, sessionId, this.fetchImpl);
  }

  /**
   * {@link observeActivity} for a bounded set of sessions in one request, from
   * the same no-touch read on the bridge. `"unsupported"` (an older bridge) is
   * remembered for this connection; see {@link HttpBridgeActivityBatchReader}.
   */
  observeActivityBatch(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderActivityBatchEntry> | "unsupported"> {
    return this.activityBatchReader.read(sessionIds);
  }

  async humanPromptOutput(sessionId: string) {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/human-prompts`,
      {},
      this.fetchImpl,
    );
    if (response.status === 404 || response.status === 405) return null;
    assertOk(response, "Human prompt observation");
    return asRecord(
      await boundedJson(response, "Human prompt observation", { remaining: 512 * 1024 }),
    );
  }

  async activity(sessionId: string): Promise<ProviderActivityState> {
    return (await this.observeActivity(sessionId)).state;
  }

  transcriptSnapshot(...args: Parameters<HttpBridgeTranscriptReader["snapshot"]>) {
    return this.transcripts.snapshot(...args);
  }

  transcriptDetail(sessionId: string, locator: string) {
    return this.transcripts.detail(sessionId, locator);
  }

  transcriptPage(...args: Parameters<HttpBridgeTranscriptReader["page"]>) {
    return this.transcripts.page(...args);
  }

  /** Legacy bounded message surface retained for older callers. */
  async messages(sessionId: string, options?: { limit?: number }): Promise<unknown[]> {
    const limit = options?.limit;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      throw new RangeError(`${this.agent} transcript limit must be a positive integer`);
    }
    const messages = (await this.transcripts.legacy(sessionId, limit)).messages;
    // A bridge that predates `?limit=` answered its whole window.
    if (limit === undefined) return messages;
    return messages.length > limit ? messages.slice(-limit) : messages;
  }

  async sessionStateSnapshot(sessionId: string): Promise<ProviderSessionStateSnapshot> {
    return readHttpBridgeAuthoritativeSessionState({
      agent: this.agent,
      connection: this.connection,
      fetchImpl: this.fetchImpl,
      sessionId,
      planUsage: this.planUsage,
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

  /** Backend-only MCP apply evidence; see `http-bridge-mcp-evidence.ts`. */
  mcpConfigEvidence(sessionId: string): Promise<ProviderMcpConfigReport> {
    const { connection, fetchImpl, agent } = this;
    return readBridgeMcpConfigEvidence({ connection, fetchImpl, agent, sessionId });
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
        this.transcripts.legacy(sessionId),
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
      const contextUsage = this.contextUsage(payload?.contextUsage);
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
        ...commandCatalogueRevisionField(payload?.commandRevision),
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
        this.transcripts.legacy(sessionId),
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
      const codexContextUsage = this.contextUsage(payload.contextUsage);
      const codexReadiness = normalizeProviderReadiness(payload.readiness);
      const codexAuthNotice = normalizeProviderAuthNotice(payload.authNotice);
      const codexNotices = snapshotNotices({
        transcriptTruncated: transcript.truncated,
        ...(runtime ? { runtime } : {}),
        ...(codexAuthNotice ? { auth: codexAuthNotice } : {}),
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
        ...commandCatalogueRevisionField(payload.commandRevision),
        ...(codexContextUsage ? { contextUsage: codexContextUsage } : {}),
        ...(codexReadiness ? { readiness: codexReadiness } : {}),
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
    const claudeContextUsage = this.contextUsage(payload.contextUsage);
    const claudeTurnActivity = claudeTurnActivityFromPayload(payload);
    const claudeReadiness = normalizeProviderReadiness(payload.readiness);
    const claudeAuthNotice = normalizeProviderAuthNotice(payload.authNotice);
    const claudeNotices = snapshotNotices({
      transcriptTruncated: transcript.truncated,
      ...(runtime ? { runtime } : {}),
      ...(claudeAuthNotice ? { auth: claudeAuthNotice } : {}),
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
      // Claude publishes its inventory revision on `GET /session/:id`, as the
      // other bridges do on `/status`; without it this path never revalidates
      // on `commands_changed`.
      ...commandCatalogueRevisionField(payload.commandRevision),
      ...(claudeTurnActivity ? { turnActivity: claudeTurnActivity } : {}),
      ...(claudeReadiness ? { readiness: claudeReadiness } : {}),
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
            ...(update.approvalMode ? { approvalMode: update.approvalMode } : {}),
          }),
        },
        this.fetchImpl,
      );
      await assertOkWithErrorDetail(response, "Claude session config update");
      return undefined;
    }
    if (this.agent === "codex") {
      // Clear before I/O: any failed or non-durable write leaves cached mode untrusted.
      const hasConfig =
        [update.modelId, update.reasoningId, update.mode].some(Boolean) ||
        update.fastMode !== undefined;
      if (hasConfig) this.codexModes.delete(sessionId);
      const outcome = await updateCodexSessionConfig(
        this.connection,
        this.fetchImpl,
        sessionId,
        update,
      );
      if (outcome?.durable) this.codexModes.set(sessionId, outcome.mode);
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

  listResumableSessions(): Promise<NativeAgentResumeEntry[]> {
    return readBridgeResumableSessions(this.agent, this.connection, this.fetchImpl);
  }

  slashCommands(sessionId?: string) {
    return this.catalogAdapter.slashCommands(sessionId);
  }

  commandCatalogue(sessionId?: string) {
    return this.catalogAdapter.commandCatalogue(sessionId);
  }

  refreshCommands(sessionId?: string) {
    return this.catalogAdapter.refreshCommands(sessionId);
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

  reloadMcpConfiguration() {
    return this.catalogAdapter.reloadMcpConfiguration();
  }

  authStatus() {
    return this.catalogAdapter.authStatus();
  }

  beginSignIn(options?: { deviceCode?: boolean }) {
    return this.catalogAdapter.beginSignIn(options);
  }

  cancelSignIn() {
    return this.catalogAdapter.cancelSignIn();
  }

  signOut() {
    return this.catalogAdapter.signOut();
  }

  setSessionTitle(sessionId: string, title: string) {
    return this.catalogAdapter.setSessionTitle(sessionId, title);
  }

  async setResumableSessionArchived(resumableSessionId: string, archived: boolean): Promise<void> {
    if (!nativeAgentCapabilities(this.agent).actions?.archive) {
      throw new PromptRejectedError(`${this.agent} cannot archive conversations`);
    }
    const response = await bridgeFetch(
      this.connection,
      `/session/list/${encodeURIComponent(resumableSessionId)}/${archived ? "archive" : "unarchive"}`,
      { method: "POST" },
      this.fetchImpl,
    );
    await assertOkWithErrorDetail(
      response,
      `${this.agent} ${archived ? "archive" : "unarchive"} conversation`,
    );
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
    const parameterValues = withoutRetiredParameterValues(this.agent, controls?.parameterValues);
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
            ...(parameterValues ? { parameterValues } : {}),
            ...(policy ? { policy: this.wirePolicy(policy) } : {}),
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
          { method: "POST", body: JSON.stringify({ policy: this.wirePolicy(policy) }) },
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
          ...(parameterValues ? { parameterValues } : {}),
          ...(policy ? { policy: this.wirePolicy(policy) } : {}),
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
    // The ACP bridge serves only `compact`, by running the agent's own
    // `/compact` (422 `command-unavailable` when the agent offers none).
    if (this.agent === "grok" && action.kind !== "compact") {
      throw new PromptRejectedError(`${this.agent} does not support ${action.kind}`);
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
      // Only the exact 429 refusal contract for this request id proves "not
      // sent". A generic 429/5xx or a malformed refusal stays ambiguous.
      const rejection = parseNativeAgentSteerRejection(response.status, payload, action.requestId);
      if (rejection) return rejection;
      if (payload?.outcome === "unknown" || payload?.outcome === "rejected") {
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

  // Non-destructive POST close; never Claude's destructive DELETE (bridge-session-close.ts).
  async closeSession(sessionId: string): Promise<void> {
    await closeBridgeSessionRetaining(this.agent, sessionId, (method, path) =>
      bridgeFetch(this.connection, path, { method }, this.fetchImpl),
    );
    this.releaseSession(sessionId);
  }

  releaseSession(sessionId: string): void {
    this.codexModes.delete(sessionId);
  }
}
