import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  BuildPipelineAgent,
  PipelineSessionPhase,
  TaskSnapshotImage,
} from "@orkestrator/protocol/build-pipeline";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  AGENT_ACTIVITY_STATES,
  type AgentActivityState,
} from "@orkestrator/protocol/agent-activity";
import {
  mimeTypeForFilename,
  promptAttachmentUrl,
  type PromptAttachment,
} from "./prompt-attachments.js";

export type ProviderStatus = "running" | "idle" | "error" | "missing";
export type ProviderActivityState = AgentActivityState | "missing";
export type ProviderExecutionMode = "plan" | "build";

const PROVIDER_ACTIVITY_STATES: readonly ProviderActivityState[] = [
  ...AGENT_ACTIVITY_STATES,
  "missing",
];

/**
 * Validate a bridge-supplied activity token before it can reach the durable
 * projection. An unrecognized value must fail loudly: coercing it to `idle`
 * would silently retire a spinner for a turn that is still running.
 */
function isProviderActivityState(
  value: unknown,
): value is ProviderActivityState {
  return PROVIDER_ACTIVITY_STATES.includes(value as ProviderActivityState);
}

export class PromptRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptRejectedError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined
      ? undefined
      : { cause: options.cause });
    this.name = "ProviderUnavailableError";
  }
}

/**
 * A prompt transport failed without proving whether the provider accepted it.
 *
 * Callers retain the durable request id and reconcile provider status before
 * retrying this error. Preflight and explicit HTTP failures must use
 * ProviderUnavailableError instead so bounded reconnect handling can run.
 */
export class AmbiguousPromptDispatchError extends ProviderUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AmbiguousPromptDispatchError";
  }
}

export interface ProviderCreateSessionOptions {
  /** Second layer of idempotency: bridges derive a stable session id from it. */
  clientSessionKey?: string;
  /**
   * Execution mode for the session, overriding what the phase implies.
   *
   * Several distinct phases collapse onto `review`, which would otherwise create
   * a read-only Codex session for a phase that has to commit changes. The caller
   * knows which; the phase alone does not.
   */
  mode?: ProviderExecutionMode;
  /**
   * Per-session model and effort.
   *
   * Passed per call rather than baked into the connection so one provider can
   * serve every session in an environment. Caching a provider per model would
   * accumulate one instance — and for OpenCode one event stream — per variant a
   * user ever selects.
   */
  model?: string;
  effort?: string;
}

export interface ProviderSendOptions {
  requestId: string;
  /**
   * Attachments that already exist in the workspace.
   *
   * Preferred over {@link ProviderSendOptions.images}: both bridges require a
   * `path`, so only a staged attachment can actually be delivered.
   */
  attachments?: PromptAttachment[];
  /**
   * Base64 images with no workspace path yet.
   *
   * Staged by the provider's `stageImages` dependency when one is configured.
   * Without it there is nothing that can be sent, so the images are refused
   * rather than silently dropped by the bridge.
   */
  images?: TaskSnapshotImage[];
  schema?: JsonSchema;
  mode?: ProviderExecutionMode;
  fastMode?: boolean;
  /** Claude sub-agent selected for this prompt. */
  subAgent?: string;
  includeLocalSettings?: boolean;
  promptSuggestions?: boolean;
  /** Overrides the connection default for this prompt only. */
  model?: string;
  effort?: string;
}

export interface BuildPipelineProvider {
  readonly agent: BuildPipelineAgent;
  /**
   * Register a session restored from durable pipeline state. Providers that
   * monitor environment-wide event streams must ignore requests for every
   * session not registered here or created through createSession().
   */
  registerSession?(sessionId: string): void;
  createSession(
    phase: PipelineSessionPhase,
    label: string,
    options?: ProviderCreateSessionOptions,
  ): Promise<string>;
  send(
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
  ): Promise<void>;
  status(sessionId: string): Promise<ProviderStatus>;
  /**
   * Authoritative activity including input parked at the provider. Optional so
   * narrow test providers and non-interactive integrations can fall back to
   * the coarser status contract.
   */
  activity?(sessionId: string): Promise<ProviderActivityState>;
  /**
   * Read authoritative activity for several sessions from one provider
   * snapshot. Providers whose upstream API is session-scoped may omit this and
   * let callers fall back to activity()/status() per session.
   */
  activityBatch?(
    sessionIds: readonly string[],
  ): Promise<Map<string, ProviderActivityState>>;
  messages(sessionId: string): Promise<unknown[]>;
  structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null>;
  abort(sessionId: string): Promise<void>;
  dispose?(): Promise<void> | void;
}

type BridgeConnection = {
  agent: BuildPipelineAgent;
  baseUrl: string;
  authToken: string;
  directory?: string;
  model?: string;
  effort?: string;
  requestTimeoutMs?: number;
};

type ProviderDependencies = {
  fetch?: typeof fetch;
  openCodeClient?: OpencodeClient;
  /** Injectable factory for testing the production OpenCode client wiring. */
  openCodeClientFactory?: typeof createOpencodeClient;
  monitorRetryMs?: number;
  /**
   * Stage base64 images into the workspace so they can be attached by path.
   *
   * Supplied by whichever service owns a command invoker; without it a
   * base64-only image cannot be delivered to any bridge.
   */
  stageImages?: (
    images: readonly TaskSnapshotImage[],
  ) => Promise<PromptAttachment[]>;
  /**
   * Answer OpenCode permission and question requests on the user's behalf.
   *
   * Only correct for pipeline-owned sessions, which have no human watching.
   * Interactive sessions must leave this off so the request reaches the tab:
   * approving on the user's behalf would run a command they never saw, and
   * rejecting a question cancels the card that exists to answer it.
   */
  autoAnswerRequests?: boolean;
};

const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MONITOR_RETRY_MS = 1_000;

function authHeaders(connection: BridgeConnection): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (connection.agent === "claude") {
    headers.set("X-Orkestrator-Claude-Token", connection.authToken);
  } else if (connection.agent === "codex") {
    headers.set("X-Orkestrator-Codex-Token", connection.authToken);
  }
  return headers;
}

async function bridgeFetch(
  connection: BridgeConnection,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers = authHeaders(connection);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const timeoutMs = Math.max(
    1,
    connection.requestTimeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS,
  );
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fetchImpl(`${connection.baseUrl}${path}`, {
      ...init,
      headers,
      signal,
    });
  } catch (error) {
    throw new ProviderUnavailableError(
      `${connection.agent} bridge is unavailable`,
      { cause: error },
    );
  }
}

function assertOk(response: Response, operation: string): void {
  if (!response.ok) {
    if (isTransientHttpStatus(response.status)) {
      throw new ProviderUnavailableError(
        `${operation} is temporarily unavailable (HTTP ${response.status})`,
      );
    }
    throw new Error(`${operation} failed (HTTP ${response.status})`);
  }
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

/**
 * Produce the attachment list a bridge will accept.
 *
 * Base64-only images have no `path`, which every bridge validator requires, so
 * they must be staged first. Refusing them outright when no stager is wired is
 * deliberate: the alternative is a prompt that references an image the agent was
 * never given.
 */
async function resolvePromptAttachments(
  options: ProviderSendOptions,
  stageImages: ProviderDependencies["stageImages"],
): Promise<PromptAttachment[] | undefined> {
  const attachments = options.attachments ? [...options.attachments] : [];
  const images = options.images ?? [];
  if (images.length > 0) {
    if (!stageImages) {
      throw new PromptRejectedError(
        "Prompt images require workspace staging before they can be attached",
      );
    }
    attachments.push(...await stageImages(images));
  }
  return attachments.length > 0 ? attachments : undefined;
}

class HttpBridgeProvider implements BuildPipelineProvider {
  readonly agent: "claude" | "codex";
  private readonly stageImages?: ProviderDependencies["stageImages"];

  constructor(
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
    stageImages?: ProviderDependencies["stageImages"],
  ) {
    this.agent = connection.agent as "claude" | "codex";
    this.stageImages = stageImages;
  }

  async createSession(
    phase: PipelineSessionPhase,
    label: string,
    options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    const clientSessionKey = options.clientSessionKey;
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
              mode: options.mode
                ?? (phase === "review" || phase === "verify" ? "plan" : "build"),
              clientSessionKey,
            }
          : { title: label, clientSessionKey }),
      },
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} session creation`);
    const body = await response.json() as { sessionId?: unknown };
    if (typeof body.sessionId !== "string") {
      throw new Error(`${this.agent} returned a malformed session`);
    }
    return body.sessionId;
  }

  async send(
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
  ): Promise<void> {
    if (this.agent === "codex" && options.mode) {
      await this.ensureCodexMode(sessionId, options.mode);
    }
    const attachments = await resolvePromptAttachments(options, this.stageImages);
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
              : { fastMode: options.fastMode }),
          }),
        },
        this.fetchImpl,
      );
    } catch (error) {
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
      throw new PromptRejectedError(
        `${this.agent} rejected the prompt (HTTP ${response.status})`,
      );
    }
  }

  /**
   * Codex stores execution mode on the session rather than accepting it on the
   * prompt route. A review's addressing turn deliberately stays in the same
   * thread for context, so switch that idle thread from read-only plan mode to
   * build mode before dispatching the fixes.
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
    const body = await response.json() as { status?: unknown };
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

  async messages(sessionId: string): Promise<unknown[]> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/messages`,
      {},
      this.fetchImpl,
    );
    if (response.status === 404) return [];
    assertOk(response, `${this.agent} transcript read`);
    const body = await response.json() as { messages?: unknown };
    return Array.isArray(body.messages) ? body.messages : [];
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

class OpenCodeProvider implements BuildPipelineProvider {
  readonly agent = "opencode" as const;
  private readonly client: OpencodeClient;
  private readonly ownedSessions = new Set<string>();
  private readonly blockedSessions = new Set<string>();
  private readonly monitorController = new AbortController();
  private readonly monitorRetryMs: number;
  private readonly answeringRequestIds = new Set<string>();
  private reconciliation: Promise<void> | null = null;
  private monitorPromise: Promise<void>;
  private disposed = false;
  private readonly autoAnswerRequests: boolean;

  constructor(
    private readonly connection: BridgeConnection,
    dependencies: ProviderDependencies,
  ) {
    const basic = Buffer.from(`opencode:${connection.authToken}`).toString("base64");
    const createClient = dependencies.openCodeClientFactory ?? createOpencodeClient;
    this.client = dependencies.openCodeClient ?? createClient({
      baseUrl: connection.baseUrl,
      directory: connection.directory,
      headers: {
        Authorization: `Basic ${basic}`,
        "X-Orkestrator-OpenCode-Token": connection.authToken,
      },
    });
    this.monitorRetryMs = Math.max(
      1,
      dependencies.monitorRetryMs ?? DEFAULT_MONITOR_RETRY_MS,
    );
    this.autoAnswerRequests = dependencies.autoAnswerRequests !== false;
    // An interactive provider has nothing to monitor: every request belongs to a
    // tab that will answer it. Subscribing anyway would open a permanent event
    // stream per provider for no consumer.
    this.monitorPromise = this.autoAnswerRequests
      ? this.monitorRequests()
      : Promise.resolve();
  }

  registerSession(sessionId: string): void {
    this.ownedSessions.add(sessionId);
    if (!this.autoAnswerRequests) return;
    const activeReconciliation = this.reconciliation;
    const reconciliation = activeReconciliation
      ? activeReconciliation
          .catch(() => undefined)
          .then(() => this.reconcilePendingRequests())
      : this.reconcilePendingRequests();
    void reconciliation.catch(() => {
      // The reconnect loop will try again. Registration must stay synchronous
      // so restoring a pipeline does not block on an external service.
    });
  }

  private async monitorRequests(): Promise<void> {
    while (!this.disposed) {
      try {
        await this.reconcilePendingRequests();
        const response = await this.client.event.subscribe(
          { directory: this.connection.directory },
          { signal: this.monitorController.signal },
        );
        if (!response || !("stream" in response)) {
          throw new Error("OpenCode returned no event stream");
        }
        for await (const raw of response.stream as AsyncIterable<unknown>) {
          if (this.disposed) return;
          await this.handleRequest(raw);
        }
      } catch (error) {
        if (this.disposed || this.monitorController.signal.aborted) return;
        console.warn(
          "[build-pipeline] OpenCode request monitor reconnecting:",
          error instanceof Error ? error.name : "unknown error",
        );
      }
      try {
        await waitForRetry(this.monitorRetryMs, this.monitorController.signal);
      } catch {
        return;
      }
    }
  }

  private async handleRequest(raw: unknown): Promise<void> {
    const event = raw && typeof raw === "object"
      ? raw as { type?: unknown; properties?: Record<string, unknown> }
      : {};
    const properties = event.properties ?? {};
    const requestId = typeof properties.id === "string"
      ? properties.id
      : undefined;
    const sessionId = typeof properties.sessionID === "string"
      ? properties.sessionID
      : undefined;
    if (!sessionId || !this.ownedSessions.has(sessionId)) return;

    // An answered question releases the session: someone (a human in the
    // OpenCode UI) resolved what this provider could not, so the pipeline can
    // advance instead of reading a permanent error. `question.rejected` is
    // deliberately not cleared — this provider's own rejection raises it, and
    // that block is what makes the stuck attempt fail rather than hang.
    if (event.type === "question.replied") {
      this.blockedSessions.delete(sessionId);
      return;
    }
    if (!this.autoAnswerRequests) return;
    if (!requestId || this.answeringRequestIds.has(requestId)) return;

    this.answeringRequestIds.add(requestId);
    try {
      if (event.type === "permission.asked") {
        const response = await this.client.permission.reply({
          requestID: requestId,
          directory: this.connection.directory,
          reply: "once",
        }, this.requestOptions());
        assertSdkResponse(response, "OpenCode permission response");
      } else if (event.type === "question.asked") {
        this.blockedSessions.add(sessionId);
        const response = await this.client.question.reject({
          requestID: requestId,
          directory: this.connection.directory,
        }, this.requestOptions());
        assertSdkResponse(response, "OpenCode question rejection");
      }
    } finally {
      this.answeringRequestIds.delete(requestId);
    }
  }

  private async reconcilePendingRequests(): Promise<void> {
    if (!this.reconciliation) {
      this.reconciliation = this.reconcilePendingRequestsNow()
        .finally(() => {
          this.reconciliation = null;
        });
    }
    return this.reconciliation;
  }

  private async reconcilePendingRequestsNow(): Promise<void> {
    if (this.disposed || this.ownedSessions.size === 0) return;
    const [permissions, questions] = await Promise.all([
      this.client.permission.list(
        { directory: this.connection.directory },
        this.requestOptions(),
      ),
      this.client.question.list(
        { directory: this.connection.directory },
        this.requestOptions(),
      ),
    ]);
    assertSdkResponse(permissions, "OpenCode pending permission read");
    assertSdkResponse(questions, "OpenCode pending question read");
    for (const request of permissions.data ?? []) {
      await this.handleRequest({ type: "permission.asked", properties: request });
    }
    for (const request of questions.data ?? []) {
      await this.handleRequest({ type: "question.asked", properties: request });
    }
  }

  async createSession(
    _phase: PipelineSessionPhase,
    label: string,
    _options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    try {
      const response = await this.client.session.create(
        { title: label },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode session creation");
      if (!response.data?.id) throw new Error("OpenCode returned an empty session");
      this.registerSession(response.data.id);
      return response.data.id;
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode session creation is unavailable", {
        cause: error,
      });
    }
  }

  async send(
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
  ): Promise<void> {
    const parts: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    // OpenCode accepts inline data, so its images need no staging. Attachments
    // that arrive already staged are referenced by path instead.
    for (const image of options.images ?? []) {
      parts.push({
        type: "file",
        mime: mimeTypeForFilename(image.filename),
        filename: image.filename,
        url: `data:${mimeTypeForFilename(image.filename)};base64,${image.data}`,
      });
    }
    for (const attachment of options.attachments ?? []) {
      parts.push({
        type: "file",
        mime: mimeTypeForFilename(attachment.filename ?? attachment.path),
        filename: attachment.filename,
        url: promptAttachmentUrl(attachment),
      });
    }
    const modelParts = (options.model ?? this.connection.model)?.split("/");
    let response;
    try {
      response = await this.client.session.promptAsync({
        sessionID: sessionId,
        directory: this.connection.directory,
        messageID: options.requestId,
        parts: parts as never,
        model: modelParts && modelParts.length > 1
          ? { providerID: modelParts[0]!, modelID: modelParts.slice(1).join("/") }
          : undefined,
        agent: options.mode ?? "build",
        variant: options.effort ?? this.connection.effort,
        format: options.schema
          ? { type: "json_schema", schema: options.schema, retryCount: 2 }
          : undefined,
      }, this.requestOptions());
    } catch (error) {
      // The request may have reached OpenCode before the response was lost.
      // The durable message ID lets the supervisor reconcile and safely retry.
      throw new AmbiguousPromptDispatchError(
        "OpenCode prompt dispatch outcome is unknown",
        { cause: error },
      );
    }
    if ("error" in response && response.error) {
      const status = response.response?.status;
      if (
        status === 404
        || status === 409
        || (status !== undefined && isTransientHttpStatus(status))
      ) {
        throw new ProviderUnavailableError(
          `OpenCode prompt dispatch is temporarily unavailable (HTTP ${status})`,
        );
      }
      throw new PromptRejectedError("OpenCode rejected the prompt");
    }
  }

  async status(sessionId: string): Promise<ProviderStatus> {
    if (this.blockedSessions.has(sessionId)) return "error";
    try {
      const response = await this.client.session.status(
        { directory: this.connection.directory },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode status read");
      if (!response.data) throw new Error("OpenCode returned no status");
      const status = response.data[sessionId];
      if (!status) return "missing";
      if (status.type === "busy" || status.type === "retry") return "running";
      return status.type === "idle" ? "idle" : "error";
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
      throw new ProviderUnavailableError(
        `OpenCode activity snapshot omitted ${sessionId}`,
      );
    }
    return state;
  }

  async activityBatch(
    sessionIds: readonly string[],
  ): Promise<Map<string, ProviderActivityState>> {
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

      const statusResponse = await this.client.session.status(
        { directory: this.connection.directory },
        this.requestOptions(),
      );
      assertSdkResponse(statusResponse, "OpenCode status read");
      if (!statusResponse.data) throw new Error("OpenCode returned no status");

      const runningSessionIds = new Set<string>();
      for (const sessionId of sessionIdsToRead) {
        const status = statusResponse.data[sessionId];
        if (!status) {
          activity.set(sessionId, "missing");
        } else if (status.type === "busy" || status.type === "retry") {
          runningSessionIds.add(sessionId);
        } else {
          activity.set(sessionId, "idle");
        }
      }
      if (runningSessionIds.size === 0) return activity;

      const [questions, permissions] = await Promise.all([
        this.client.question.list(
          { directory: this.connection.directory },
          this.requestOptions(),
        ),
        this.client.permission.list(
          { directory: this.connection.directory },
          this.requestOptions(),
        ),
      ]);
      assertSdkResponse(questions, "OpenCode pending question read");
      assertSdkResponse(permissions, "OpenCode pending permission read");
      const waitingSessionIds = new Set<string>();
      for (const request of [
        ...(questions.data ?? []),
        ...(permissions.data ?? []),
      ]) {
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          continue;
        }
        const sessionId = (request as { sessionID?: unknown }).sessionID;
        if (typeof sessionId === "string" && runningSessionIds.has(sessionId)) {
          waitingSessionIds.add(sessionId);
        }
      }
      for (const sessionId of runningSessionIds) {
        activity.set(
          sessionId,
          waitingSessionIds.has(sessionId) ? "waiting" : "working",
        );
      }
      return activity;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError("OpenCode activity is unavailable", {
        cause: error,
      });
    }
  }

  async messages(sessionId: string): Promise<unknown[]> {
    try {
      const response = await this.client.session.messages(
        { sessionID: sessionId },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode transcript read");
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode transcript is unavailable", {
        cause: error,
      });
    }
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    let response;
    try {
      response = await this.client.session.messages(
        { sessionID: sessionId },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode structured-output read");
    } catch (error) {
      throw new ProviderUnavailableError(
        "OpenCode structured output is unavailable",
        { cause: error },
      );
    }
    if (!Array.isArray(response.data)) return null;
    const assistant = [...response.data].reverse().find((entry) => {
      const info = entry.info as { role?: unknown; parentID?: unknown };
      return info.role === "assistant" && info.parentID === requestId;
    });
    if (!assistant) return null;
    const info = assistant.info as {
      error?: unknown;
      structured?: unknown;
      time?: { completed?: unknown };
    };
    if (!info.time?.completed) return null;
    if (info.error || info.structured === undefined) {
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
    return {
      ok: true,
      provider: "opencode",
      requestId,
      value: info.structured as T,
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.monitorController.abort();
    await this.monitorPromise;
    this.ownedSessions.clear();
    this.blockedSessions.clear();
    this.answeringRequestIds.clear();
  }

  private requestOptions(): { signal: AbortSignal } {
    const timeoutMs = Math.max(
      1,
      this.connection.requestTimeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS,
    );
    return {
      signal: AbortSignal.any([
        this.monitorController.signal,
        AbortSignal.timeout(timeoutMs),
      ]),
    };
  }
}

function assertSdkResponse(
  response: { error?: unknown },
  operation: string,
): void {
  if (response.error) {
    throw new Error(`${operation} failed`);
  }
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createBuildPipelineProvider(
  connection: BridgeConnection,
  dependencies: ProviderDependencies = {},
): BuildPipelineProvider {
  return connection.agent === "opencode"
    ? new OpenCodeProvider(connection, dependencies)
    : new HttpBridgeProvider(
        connection,
        dependencies.fetch ?? fetch,
        dependencies.stageImages,
      );
}

export type { BridgeConnection, ProviderDependencies };
