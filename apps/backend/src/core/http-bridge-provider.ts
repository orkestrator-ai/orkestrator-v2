import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type {
  AgentInteractionProviderCapability,
  BridgeConnection,
  NativeAgentRuntimeProvider,
  ProviderActivityState,
  ProviderCreateSessionOptions,
  ProviderDispatchStatus,
  ProviderExecutionMode,
  ProviderInteractiveSnapshot,
  ProviderSendOptions,
  ProviderSessionRegistration,
  ProviderStatus,
} from "./agent-provider-contract.js";
import {
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  ProviderSessionFailedError,
  ProviderUnavailableError,
  ProviderUnreachableError,
} from "./agent-provider-contract.js";
import type {
  NativeAgentComposerState,
  NativeAgentBackgroundTaskSummary,
  NativeAgentControlUpdate,
  NativeAgentForkOutcome,
  NativeAgentResumeEntry,
  NativeAgentRuntimeSummary,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
  NativeAgentSlashCommand,
  NativeAgentTurnPhase,
} from "@orkestrator/protocol/native-agent";
import { EMPTY_NATIVE_AGENT_COMPOSER_STATE } from "@orkestrator/protocol/native-agent";
import type { PromptAttachment } from "./prompt-attachments.js";
import {
  asRecord,
  INTERACTIVE_RUNTIME_METADATA_RETRY_MS,
  INTERACTIVE_RUNTIME_METADATA_TTL_MS,
  isProviderActivityState,
  isTransientHttpStatus,
  MAX_TRACKED_INTERACTION_SESSIONS,
  nonEmptyString,
  normalizeProviderContextUsage,
  normalizeProviderRateLimits,
  normalizeProviderRuntimeSummary,
  providerInventoryCount,
  setBoundedMapEntry,
} from "./agent-provider-runtime.js";
import { HttpBridgeInteractionAdapter } from "./http-bridge-interactions.js";
import {
  assertOk,
  assertOkWithErrorDetail,
  boundedJson,
  bridgeFetch,
  resolvePromptAttachments,
  type HttpBridgeProviderDependencies,
} from "./http-bridge-transport.js";

function normalizeClaudeBackgroundTasks(
  value: unknown,
): NativeAgentBackgroundTaskSummary[] | undefined {
  const tasks = asRecord(value);
  if (!tasks) return undefined;
  const allowed = new Set([
    "pending",
    "running",
    "completed",
    "failed",
    "killed",
    "paused",
  ]);
  return Object.entries(tasks).slice(0, 256).flatMap(([id, raw]) => {
    const task = asRecord(raw);
    if (!task || !allowed.has(String(task.status))) return [];
    return [{
      id,
      status: task.status as NativeAgentBackgroundTaskSummary["status"],
      ...(typeof task.description === "string"
        ? { description: task.description.slice(0, 1_000) }
        : {}),
      // Bounded like every other free-form provider string here: the renderer
      // only ever compares it against a transcript `toolUseId`, so an
      // over-long value can never match and must not be carried.
      ...(typeof task.toolUseId === "string" && task.toolUseId.length <= 512
        ? { toolUseId: task.toolUseId }
        : {}),
    }];
  });
}

const CLAUDE_BUILT_IN_SLASH_COMMANDS: readonly NativeAgentSlashCommand[] = [
  { name: "/clear", description: "Clear conversation history" },
  { name: "/compact", description: "Compact conversation to reduce tokens" },
  { name: "/context", description: "Show current context" },
  { name: "/cost", description: "Show token usage and cost" },
  { name: "/doctor", description: "Check system health" },
  { name: "/goal", description: "Set, view, or clear a completion goal" },
  { name: "/help", description: "Show available commands" },
  { name: "/init", description: "Re-initialize the session" },
  { name: "/logout", description: "Log out of Claude" },
  { name: "/memory", description: "Show memory usage" },
  { name: "/model", description: "Show or change model" },
  { name: "/permissions", description: "Manage permissions" },
  { name: "/review", description: "Review recent changes" },
  { name: "/status", description: "Show session status" },
  { name: "/vim", description: "Toggle vim mode" },
];


/**
 * Drop the staged `dataUrl` before an attachment reaches an ACP bridge.
 *
 * That bridge reads every attachment's bytes from the workspace itself and
 * ignores `dataUrl`, but it caps a request body at 2MiB. Forwarding the data URL
 * spends that whole budget on a copy the bridge discards, so a screenshot much
 * over 1.5MB would come back as HTTP 413 — a terminal rejection of a prompt the
 * bridge is perfectly able to read from disk. The Claude and Codex bridges do
 * consume `dataUrl`, so this is deliberately scoped to the ACP agents.
 */
function bridgePromptAttachments(
  agent: HttpBridgeProvider["agent"],
  attachments: PromptAttachment[] | undefined,
): PromptAttachment[] | undefined {
  if (!attachments || (agent !== "cursor" && agent !== "grok")) return attachments;
  return attachments.map((attachment) => ({
    type: attachment.type,
    path: attachment.path,
    ...(attachment.filename ? { filename: attachment.filename } : {}),
  }));
}


export class HttpBridgeProvider implements NativeAgentRuntimeProvider {
  readonly agent: "claude" | "codex" | "cursor" | "grok";
  private readonly stageImages?: HttpBridgeProviderDependencies["stageImages"];
  private readonly interactionAdapter: HttpBridgeInteractionAdapter;
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
  private readonly interactiveMetadata = new Map<string, {
    expiresAt: number;
    executionProfiles?: NativeAgentComposerState["executionProfiles"];
    runtime?: NativeAgentRuntimeSummary;
  }>();
  /** Runtime inventory is optional UI metadata and must not delay transcripts. */
  private readonly codexRuntimeMetadataRefreshes = new Map<string, Promise<void>>();
  private codexRuntimeMetadataGeneration = 0;

  constructor(
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
    stageImages?: HttpBridgeProviderDependencies["stageImages"],
  ) {
    this.agent = connection.agent as "claude" | "codex" | "cursor" | "grok";
    this.stageImages = stageImages;
    this.interactionAdapter = new HttpBridgeInteractionAdapter(
      this.agent,
      connection,
      fetchImpl,
    );
    this.interactions = {
      listPendingInteractions: (sessionId) =>
        this.interactionAdapter.listPendingInteractions(sessionId),
      resolveInteraction: (sessionId, interactionId, resolution) =>
        this.interactionAdapter.resolveInteraction(sessionId, interactionId, resolution),
    };
  }

  registerSession(
    sessionId: string,
    interaction?: ProviderSessionRegistration,
  ): void {
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
        body: JSON.stringify(this.agent === "codex"
          ? {
              title: label,
              model: options.model ?? this.connection.model,
              modelReasoningEffort: options.effort ?? this.connection.effort,
              mode,
              clientSessionKey,
            }
          : this.agent === "cursor" || this.agent === "grok"
            ? {
                title: label,
                clientSessionKey,
                model: options.model ?? this.connection.model,
                reasoningEffort: options.effort ?? this.connection.effort,
                mode,
                ...(typeof options.fastMode === "boolean" ? { fastMode: options.fastMode } : {}),
              }
            : { title: label, clientSessionKey }),
      },
      this.fetchImpl,
      "session-start",
    );
    await assertOkWithErrorDetail(response, `${this.agent} session creation`);
    const body = await response.json() as { sessionId?: unknown };
    if (typeof body.sessionId !== "string") {
      throw new Error(`${this.agent} returned a malformed session`);
    }
    this.registerSession(body.sessionId, options.interaction);
    if (this.agent === "codex") this.codexModes.set(body.sessionId, mode);
    return body.sessionId;
  }

  /**
   * Attach the bridge's agent process before the dispatch window opens.
   *
   * Only the ACP bridges expose this: they are the ones whose prompt route
   * performs a full spawn plus `initialize` plus `session/load` when no child
   * is attached, which is the work that used to run inside the at-most-once
   * window and abort the caller mid-flight. A bridge that predates the route
   * answers 404 and the prompt request does the work itself, exactly as before.
   */
  async prepareDispatch(sessionId: string): Promise<void> {
    if (this.agent !== "cursor" && this.agent !== "grok") return;
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
  async dispatchStatus(
    sessionId: string,
    requestId: string,
  ): Promise<ProviderDispatchStatus> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/dispatch`
        + `?requestId=${encodeURIComponent(requestId)}`,
      {},
      this.fetchImpl,
    );
    if (!response.ok) return "unknown";
    const body = asRecord(
      await boundedJson(response, `${this.agent} dispatch status`)
        .catch(() => null),
    );
    return body?.dispatch === "dispatched" ? "dispatched" : "unknown";
  }

  async send(
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
  ): Promise<void> {
    if (
      this.agent === "codex"
      && options.mode
      && this.codexModes.get(sessionId) !== options.mode
    ) {
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
            ...(this.agent === "claude"
              ? {
                  model: options.model ?? this.connection.model,
                  effort: options.effort ?? this.connection.effort,
                  fastMode: options.fastMode,
                  agent: options.subAgent,
                  includeLocalSettings: options.includeLocalSettings,
                  promptSuggestions: options.promptSuggestions,
                  permissionMode:
                    options.mode === "plan" ? "plan" : "bypassPermissions",
                }
              : this.agent === "cursor" || this.agent === "grok"
                ? {
                    fastMode: options.fastMode,
                    model: options.model ?? this.connection.model,
                    reasoningEffort: options.effort ?? this.connection.effort,
                    mode: options.mode,
                  }
                : { fastMode: options.fastMode }),
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
        throw new AmbiguousPromptDispatchError(
          `${this.agent} prompt dispatch outcome is unknown`,
          { cause: error },
        );
      }
      throw error;
    }
    // A session can briefly disappear while a bridge reconciles a restarted
    // provider, and an idle status read can race with another client starting a
    // turn. Both are retryable dispatch races, not validation rejections that
    // should park the user's prompt indefinitely.
    if (
      response.status === 404
      || response.status === 409
      || isTransientHttpStatus(response.status)
    ) {
      throw new ProviderUnavailableError(
        `${this.agent} prompt dispatch is temporarily unavailable (HTTP ${response.status})`,
      );
    }
    if (!response.ok) {
      // Bridges answer terminal rejections with an actionable message (e.g. an
      // ACP prompt whose outcome is unknown after a restart). Surface it so the
      // pipeline failure tells the user what to do instead of a bare status.
      const detail = await response.json().catch(() => null) as { error?: unknown } | null;
      const detailMessage = detail !== null && typeof detail.error === "string"
        ? `: ${detail.error}`
        : "";
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
  private async ensureCodexMode(
    sessionId: string,
    mode: ProviderExecutionMode,
  ): Promise<void> {
    const path = `/session/${encodeURIComponent(sessionId)}/config`;
    const currentResponse = await bridgeFetch(
      this.connection,
      path,
      {},
      this.fetchImpl,
    );
    if (
      currentResponse.status === 404
      || currentResponse.status === 409
      || isTransientHttpStatus(currentResponse.status)
    ) {
      throw new ProviderUnavailableError(
        `Codex mode reconciliation is temporarily unavailable (HTTP ${currentResponse.status})`,
      );
    }
    assertOk(currentResponse, "Codex config read");
    const current = await currentResponse.json() as {
      model?: unknown;
      modelReasoningEffort?: unknown;
      mode?: unknown;
      fastMode?: unknown;
      durable?: unknown;
    };
    if (
      (current.mode !== "plan" && current.mode !== "build")
      || (current.model !== undefined && typeof current.model !== "string")
      || (
        current.modelReasoningEffort !== undefined
        && typeof current.modelReasoningEffort !== "string"
      )
      || typeof current.fastMode !== "boolean"
      || typeof current.durable !== "boolean"
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
      updateResponse.status === 404
      || updateResponse.status === 409
      || isTransientHttpStatus(updateResponse.status)
    ) {
      throw new ProviderUnavailableError(
        `Codex mode update is temporarily unavailable (HTTP ${updateResponse.status})`,
      );
    }
    assertOk(updateResponse, "Codex config update");
    const update = await updateResponse.json() as { durable?: unknown };
    if (update.durable !== true) {
      throw new ProviderUnavailableError(
        "Codex mode update was not durably persisted",
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
    const path = this.agent === "claude"
      ? `/session/${encodeURIComponent(sessionId)}`
      : `/session/${encodeURIComponent(sessionId)}/status`;
    const response = await bridgeFetch(
      this.connection,
      path,
      {},
      this.fetchImpl,
    );
    if (response.status === 404) return "missing";
    assertOk(response, `${this.agent} status read`);
    const body = await response.json() as { status?: unknown; error?: unknown };
    if (body.status === "error" && typeof body.error === "string") {
      const detail = body.error.trim().slice(0, 4_000);
      if (detail) {
        throw new ProviderSessionFailedError(this.agent, detail);
      }
    }
    return body.status === "running" || body.status === "idle" || body.status === "error"
      ? body.status
      : "error";
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
  async activity(sessionId: string): Promise<ProviderActivityState> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/activity`,
      {},
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} activity read`);
    const body = await response.json() as { activity?: unknown };
    if (!isProviderActivityState(body.activity)) {
      throw new ProviderUnavailableError(
        `${this.agent} returned a malformed activity snapshot`,
      );
    }
    return body.activity;
  }

  private async readTranscript(sessionId: string): Promise<{
    messages: unknown[];
    truncated: boolean;
    revision?: number;
    status?: "idle" | "running" | "error";
    error?: string;
  }> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/messages`,
      {},
      this.fetchImpl,
    );
    if (response.status === 404) return { messages: [], truncated: false };
    assertOk(response, `${this.agent} transcript read`);
    const body = asRecord(await boundedJson(
      response,
      `${this.agent} transcript read`,
      { remaining: 16 * 1024 * 1024 },
    ));
    const messageWindow = asRecord(body?.messageWindow);
    const transcriptStatus = body?.status;
    const transcriptRevision = body?.revision;
    return {
      messages: Array.isArray(body?.messages) ? body.messages : [],
      truncated: messageWindow?.truncated === true,
      ...(Number.isSafeInteger(transcriptRevision)
        ? { revision: transcriptRevision as number }
        : {}),
      ...(transcriptStatus === "idle"
        || transcriptStatus === "running"
        || transcriptStatus === "error"
        ? { status: transcriptStatus }
        : {}),
      ...(typeof body?.error === "string" ? { error: body.error } : {}),
    };
  }

  async messages(sessionId: string): Promise<unknown[]> {
    return (await this.readTranscript(sessionId)).messages;
  }

  private codexRuntimeSummary(payload: unknown): NativeAgentRuntimeSummary | undefined {
    const health = asRecord(payload);
    if (!health) return undefined;
    const engine = asRecord(health.engine);
    const groupedNotices = new Map<string, number>();
    if (Array.isArray(health.notices)) {
      for (const candidate of health.notices.slice(-128)) {
        const message = asRecord(candidate)?.message;
        if (typeof message !== "string" || message.length === 0) continue;
        const bounded = message.slice(0, 1_000);
        groupedNotices.set(bounded, (groupedNotices.get(bounded) ?? 0) + 1);
      }
    }
    return {
      mcpServers: providerInventoryCount(health.mcp),
      skills: providerInventoryCount(health.skills),
      hooks: providerInventoryCount(health.hooks),
      ...(typeof engine?.state === "string" ? { state: engine.state.slice(0, 64) } : {}),
      ...(typeof engine?.codexVersion === "string"
        ? { version: engine.codexVersion.slice(0, 64) }
        : {}),
      ...(groupedNotices.size > 0
        ? {
            notices: [...groupedNotices.entries()].slice(-5).map(([message, count]) => ({
              message,
              ...(count > 1 ? { count } : {}),
            })),
          }
        : {}),
    };
  }

  private refreshCodexRuntimeMetadata(sessionId: string): Promise<void> {
    const pending = this.codexRuntimeMetadataRefreshes.get(sessionId);
    if (pending) return pending;
    const retained = this.interactiveMetadata.get(sessionId);
    const generation = this.codexRuntimeMetadataGeneration;
    const operation = (async () => {
      try {
        const response = await bridgeFetch(
          this.connection,
          `/session/${encodeURIComponent(sessionId)}/runtime-health`,
          {},
          this.fetchImpl,
        );
        assertOk(response, "Codex runtime health read");
        const runtime = this.codexRuntimeSummary(await boundedJson(
          response,
          "Codex runtime health read",
          { remaining: 512 * 1024 },
        ));
        if (!runtime) {
          throw new ProviderUnavailableError(
            "Codex runtime health read returned malformed metadata",
          );
        }
        if (generation !== this.codexRuntimeMetadataGeneration) return;
        setBoundedMapEntry(this.interactiveMetadata, sessionId, {
          expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
          runtime,
        }, MAX_TRACKED_INTERACTION_SESSIONS);
      } catch {
        // Keep known inventory usable and avoid retrying a failed optional
        // endpoint on every 500ms projection poll.
        if (
          generation === this.codexRuntimeMetadataGeneration
          && retained
          && this.interactiveMetadata.get(sessionId) === retained
        ) {
          retained.expiresAt = Date.now() + INTERACTIVE_RUNTIME_METADATA_RETRY_MS;
        }
      }
    })();
    this.codexRuntimeMetadataRefreshes.set(sessionId, operation);
    return operation.finally(() => {
      if (this.codexRuntimeMetadataRefreshes.get(sessionId) === operation) {
        this.codexRuntimeMetadataRefreshes.delete(sessionId);
      }
    });
  }

  async interactiveSnapshot(
    sessionId: string,
  ): Promise<ProviderInteractiveSnapshot> {
    if (this.agent === "cursor" || this.agent === "grok") {
      const [response, transcript] = await Promise.all([
        bridgeFetch(
          this.connection,
          `/session/${encodeURIComponent(sessionId)}/status`,
          {},
          this.fetchImpl,
        ),
        this.readTranscript(sessionId),
      ]);
      if (response.status === 404) return { status: "missing", messages: [] };
      assertOk(response, `${this.agent} interactive status`);
      const payload = asRecord(await boundedJson(
        response,
        `${this.agent} interactive status`,
        { remaining: 512 * 1024 },
      ));
      // `/messages` returns status and revision from the same synchronous ACP
      // snapshot as its transcript. Prefer that pair so a turn transition
      // between the parallel requests cannot combine two different revisions.
      const hasTranscriptSnapshot = transcript.status !== undefined
        && transcript.revision !== undefined;
      const status = hasTranscriptSnapshot ? transcript.status : payload?.status;
      const messages = transcript.messages;
      const composer = asRecord(payload?.composer);
      const providerRevision = hasTranscriptSnapshot ? transcript.revision : payload?.revision;
      const providerError = hasTranscriptSnapshot ? transcript.error : payload?.error;
      if (
        (status !== "idle" && status !== "running" && status !== "error")
        || !Array.isArray(messages)
        || !Number.isSafeInteger(providerRevision)
        || !composer
        || !Array.isArray(composer.models)
        || !Array.isArray(composer.modes)
      ) {
        throw new ProviderUnavailableError(
          `${this.agent} returned a malformed interactive snapshot`,
        );
      }
      const contextUsage = normalizeProviderContextUsage(payload?.contextUsage);
      const runtime = normalizeProviderRuntimeSummary(payload?.runtime);
      return {
        status,
        messages,
        ...(typeof payload?.title === "string" && payload.title.trim()
          ? { title: payload.title.trim() }
          : {}),
        composer: composer as unknown as NativeAgentComposerState,
        providerRevision: providerRevision as number,
        ...(contextUsage ? { contextUsage } : {}),
        ...(runtime ? { runtime } : {}),
        ...(transcript.truncated ? {
          notices: [{
            kind: "warning" as const,
            message: "Earlier transcript content was omitted to stay within the 16 MiB transport limit.",
          }],
        } : {}),
        ...(typeof providerError === "string" ? { error: providerError } : {}),
      };
    }

    const sessionPath = this.agent === "codex"
      ? `/session/${encodeURIComponent(sessionId)}/status`
      : `/session/${encodeURIComponent(sessionId)}`;
    const cachedMetadata = this.interactiveMetadata.get(sessionId);
    const refreshMetadata = !cachedMetadata || cachedMetadata.expiresAt <= Date.now();
    if (this.agent === "codex" && cachedMetadata && refreshMetadata) {
      // `/runtime-health` fans out to several app-server inventory RPCs. The
      // previous inventory remains useful while that optional refresh runs;
      // message/status/config reads below are the foreground critical path.
      void this.refreshCodexRuntimeMetadata(sessionId);
    }
    const [sessionResponse, transcript, configResponse, initResponse, runtimeResponse] = await Promise.all([
      bridgeFetch(this.connection, sessionPath, {}, this.fetchImpl),
      this.readTranscript(sessionId),
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
      this.agent === "codex" && refreshMetadata && !cachedMetadata
        ? bridgeFetch(
            this.connection,
            `/session/${encodeURIComponent(sessionId)}/runtime-health`,
            {},
            this.fetchImpl,
          )
        : Promise.resolve(undefined),
    ]);
    const messages = transcript.messages;
    if (sessionResponse.status === 404) return { status: "missing", messages: [] };
    assertOk(sessionResponse, `${this.agent} interactive session read`);
    const payload = asRecord(await boundedJson(
      sessionResponse,
      `${this.agent} interactive session read`,
      { remaining: 512 * 1024 },
    ));
    const status = payload?.status;
    if (!payload || (status !== "idle" && status !== "running" && status !== "error")) {
      throw new ProviderUnavailableError(
        `${this.agent} returned a malformed interactive session`,
      );
    }
    if (this.agent === "codex") {
      if (!configResponse) {
        throw new ProviderUnavailableError("Codex interactive config response is missing");
      }
      assertOk(configResponse, "Codex interactive config read");
      const config = asRecord(await boundedJson(
        configResponse,
        "Codex interactive config read",
        { remaining: 128 * 1024 },
      ));
      const rawPhase = payload?.phase;
      let runtime: NativeAgentRuntimeSummary | undefined = cachedMetadata?.runtime;
      if (runtimeResponse?.ok) {
        runtime = this.codexRuntimeSummary(await boundedJson(
          runtimeResponse,
          "Codex runtime health read",
          { remaining: 512 * 1024 },
        ));
      }
      if (refreshMetadata && !cachedMetadata) {
        setBoundedMapEntry(this.interactiveMetadata, sessionId, {
          expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
          ...(runtime ? { runtime } : {}),
        }, MAX_TRACKED_INTERACTION_SESSIONS);
      }
      const phase: NativeAgentTurnPhase | undefined = rawPhase === "cancelling"
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
        ...(typeof payload.title === "string" && payload.title.trim()
          ? { title: payload.title.trim() }
          : {}),
        controls: {
          ...(typeof config?.model === "string" ? { modelId: config.model } : {}),
          ...(typeof config?.modelReasoningEffort === "string"
            ? { reasoningId: config.modelReasoningEffort }
            : {}),
          ...(config?.mode === "build" || config?.mode === "plan"
            ? { mode: config.mode }
            : {}),
          ...(typeof config?.fastMode === "boolean"
            ? { fastMode: config.fastMode }
            : {}),
        },
        ...(phase ? { phase } : {}),
        ...(typeof payload.turnStartedAt === "string"
          && Number.isFinite(Date.parse(payload.turnStartedAt))
          ? { turnStartedAt: Date.parse(payload.turnStartedAt) }
          : {}),
        ...(Number.isSafeInteger(payload.messageRevision)
          ? { providerRevision: payload.messageRevision as number }
          : {}),
        ...(Number.isSafeInteger(payload.engineGeneration)
          ? { providerGeneration: payload.engineGeneration as number }
          : {}),
        ...(normalizeProviderContextUsage(payload.contextUsage)
          ? { contextUsage: normalizeProviderContextUsage(payload.contextUsage) }
          : {}),
        ...(runtime ? { runtime } : {}),
        ...(transcript.truncated ? {
          notices: [{
            kind: "warning" as const,
            message: "Earlier transcript content was omitted to stay within the 16 MiB transport limit.",
          }],
        } : {}),
        ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      };
    }
    let executionProfiles: NativeAgentComposerState["executionProfiles"] =
      cachedMetadata?.executionProfiles;
    let runtime: NativeAgentRuntimeSummary | undefined = cachedMetadata?.runtime;
    if (initResponse?.ok) {
      const initPayload = asRecord(await boundedJson(
        initResponse,
        "Claude init read",
        { remaining: 256 * 1024 },
      ));
      const initData = asRecord(initPayload?.initData);
      runtime = {
        mcpServers: Array.isArray(initData?.mcpServers) ? initData.mcpServers.length : 0,
        plugins: Array.isArray(initData?.plugins) ? initData.plugins.length : 0,
        commands: Array.isArray(initData?.slashCommands) ? initData.slashCommands.length : 0,
      };
      if (Array.isArray(initData?.agents)) {
        executionProfiles = initData.agents.slice(0, 128).flatMap((candidate) => {
          const agent = asRecord(candidate);
          const name = nonEmptyString(agent?.name);
          if (!name) return [];
          return [{
            id: name,
            label: name,
            ...(typeof agent?.description === "string" ? { description: agent.description } : {}),
            ...(typeof agent?.model === "string" ? { modelId: agent.model } : {}),
          }];
        });
      }
    }
    if (refreshMetadata) {
      setBoundedMapEntry(this.interactiveMetadata, sessionId, {
        expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
        ...(executionProfiles ? { executionProfiles } : {}),
        ...(runtime ? { runtime } : {}),
      }, MAX_TRACKED_INTERACTION_SESSIONS);
    }
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
      ...(normalizeProviderContextUsage(payload.contextUsage)
        ? { contextUsage: normalizeProviderContextUsage(payload.contextUsage) }
        : {}),
      ...(normalizeProviderRateLimits(payload.rateLimits).length > 0
        ? { rateLimits: normalizeProviderRateLimits(payload.rateLimits) }
        : {}),
      ...(runtime ? { runtime } : {}),
      ...(transcript.truncated ? {
        notices: [{
          kind: "warning" as const,
          message: "Earlier transcript content was omitted to stay within the 16 MiB transport limit.",
        }],
      } : {}),
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
      if (update.mode === undefined) return undefined;
      const response = await bridgeFetch(
        this.connection,
        `/session/${encodeURIComponent(sessionId)}/preferences`,
        {
          method: "PUT",
          body: JSON.stringify({ planMode: update.mode === "plan" }),
        },
        this.fetchImpl,
      );
      assertOk(response, "Claude session preference update");
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
          }),
        },
        this.fetchImpl,
      );
      assertOk(response, "Codex session config update");
      return undefined;
    }
    if (this.agent !== "cursor" && this.agent !== "grok") return undefined;
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/config`,
      { method: "POST", body: JSON.stringify(update) },
      this.fetchImpl,
    );
    await assertOkWithErrorDetail(response, `${this.agent} config update`);
    const composer = asRecord(await boundedJson(
      response,
      `${this.agent} config update`,
    ));
    if (!composer || !Array.isArray(composer.models) || !Array.isArray(composer.modes)) {
      throw new ProviderUnavailableError(`${this.agent} returned a malformed composer`);
    }
    return composer as unknown as NativeAgentComposerState;
  }

  refreshCatalog(): void {
    // Execution profiles and runtime inventory are discovered alongside models,
    // so an explicit refresh has to drop them too or the picker re-renders the
    // same stale list it was asked to replace.
    this.codexRuntimeMetadataGeneration += 1;
    this.interactiveMetadata.clear();
  }

  async listResumableSessions(): Promise<NativeAgentResumeEntry[]> {
    const response = await bridgeFetch(
      this.connection,
      "/session/list",
      {},
      this.fetchImpl,
    );
    // The ACP bridge answers 410 with the reason the agent cannot list its own
    // history. Dropping that body would reduce a specific, actionable message
    // to a bare status code in front of the user.
    await assertOkWithErrorDetail(response, `${this.agent} resumable session list`);
    const payload = asRecord(await boundedJson(
      response,
      `${this.agent} resumable session list`,
      { remaining: 2 * 1024 * 1024 },
    ));
    if (!payload || !Array.isArray(payload.sessions)) {
      throw new ProviderUnavailableError(`${this.agent} returned a malformed session list`);
    }
    return payload.sessions.slice(0, 512).flatMap((candidate) => {
      const session = asRecord(candidate);
      const id = nonEmptyString(session?.id);
      if (!id) return [];
      const createdAt = nonEmptyString(session?.createdAt);
      const updatedAt = nonEmptyString(session?.updatedAt)
        ?? nonEmptyString(session?.lastActivity);
      const status = session?.status === "running"
        || session?.status === "error"
        || session?.status === "idle"
        ? session.status
        : undefined;
      const messageCount = Number.isSafeInteger(session?.messageCount)
        ? session!.messageCount as number
        : undefined;
      return [{
        sessionId: id,
        ...(typeof session?.title === "string" ? { title: session.title } : {}),
        ...(createdAt && Number.isFinite(Date.parse(createdAt)) ? { createdAt } : {}),
        ...(updatedAt && Number.isFinite(Date.parse(updatedAt)) ? { updatedAt } : {}),
        ...(status ? { status } : {}),
        ...(messageCount === undefined
          ? {}
          : { detail: `${messageCount} message${messageCount === 1 ? "" : "s"}` }),
      }];
    });
  }

  async slashCommands(): Promise<NativeAgentSlashCommand[]> {
    if (this.agent === "cursor" || this.agent === "grok") return [];
    const response = await bridgeFetch(
      this.connection,
      this.agent === "codex" ? "/global/slash-commands" : "/plugins/commands",
      {},
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} slash command list`);
    const payload = asRecord(await boundedJson(
      response,
      `${this.agent} slash command list`,
      { remaining: 512 * 1024 },
    ));
    const commands = new Map<string, NativeAgentSlashCommand>(
      this.agent === "claude"
        ? CLAUDE_BUILT_IN_SLASH_COMMANDS.map((command) => [command.name, command])
        : [],
    );
    if (!payload || !Array.isArray(payload.commands)) return [...commands.values()];
    for (const candidate of payload.commands.slice(0, 512)) {
      const command = typeof candidate === "string" ? { name: candidate } : asRecord(candidate);
      const rawName = nonEmptyString(command?.name);
      if (!rawName) continue;
      const name = rawName.startsWith("/") ? rawName : `/${rawName}`;
      commands.set(name, {
        name: name.slice(0, 256),
        ...(typeof command?.description === "string"
          ? { description: command.description.slice(0, 1_000) }
          : {}),
        ...(typeof command?.argumentHint === "string"
          ? { argumentHint: command.argumentHint.slice(0, 512) }
          : {}),
      });
    }
    return [...commands.values()].slice(0, 512);
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
  ): Promise<string> {
    if (this.agent === "cursor" || this.agent === "grok") {
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
          ...(controls?.reasoningId
            ? { modelReasoningEffort: controls.reasoningId }
            : {}),
          ...(controls?.mode ? { mode: controls.mode } : {}),
          ...(controls?.fastMode === undefined
            ? {} : { fastMode: controls.fastMode }),
        }),
      },
      this.fetchImpl,
    );
    assertOk(response, "Codex session resume");
    const payload = asRecord(await boundedJson(response, "Codex session resume"));
    const resumedId = nonEmptyString(payload?.sessionId);
    if (!resumedId) throw new ProviderUnavailableError("Codex returned a malformed resumed session");
    return resumedId;
  }

  async forkSession(
    sessionId: string,
    messageId?: string,
  ): Promise<NativeAgentForkOutcome> {
    if (this.agent === "cursor" || this.agent === "grok") {
      throw new PromptRejectedError(`${this.agent} does not support session forks`);
    }
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/fork`,
      {
        method: "POST",
        body: JSON.stringify(this.agent === "codex"
          ? { lastMessageId: messageId }
          : { upToMessageId: messageId }),
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
    };
  }

  async performSessionAction(
    sessionId: string,
    action: NativeAgentSessionAction,
  ): Promise<NativeAgentSessionActionOutcome> {
    if (this.agent === "cursor" || this.agent === "grok") {
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
    if (this.agent === "codex" && action.kind === "steer") {
      const statusResponse = await bridgeFetch(this.connection, `${base}/status`, {}, this.fetchImpl);
      if (statusResponse.status === 404) throw new PromptRejectedError("Codex session was not found");
      await assertOkWithErrorDetail(statusResponse, "Codex steer status read");
      const status = asRecord(await boundedJson(statusResponse, "Codex steer status read"));
      if (status?.status !== "running") return { outcome: "idle" };
      const turnId = nonEmptyString(status.turnId);
      if (!turnId) return { outcome: "unknown", requestId: action.requestId };
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
              expectedTurnId: turnId,
            }),
          },
          this.fetchImpl,
        );
      } catch {
        return { outcome: "unknown", requestId: action.requestId };
      }
      const payload = asRecord(await boundedJson(response, "Codex steer response").catch(() => ({})));
      if (payload?.outcome === "unknown") return { outcome: "unknown", requestId: action.requestId };
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
    const body = await response.json() as { structuredOutput?: unknown };
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
}
