import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  BuildPipelineAgent,
  PipelineSessionPhase,
  TaskSnapshotImage,
} from "@orkestrator/protocol/build-pipeline";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";

export type ProviderStatus = "running" | "idle" | "error" | "missing";

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
    clientSessionKey?: string,
  ): Promise<string>;
  send(
    sessionId: string,
    prompt: string,
    options: {
      requestId: string;
      images?: TaskSnapshotImage[];
      schema?: JsonSchema;
    },
  ): Promise<void>;
  status(sessionId: string): Promise<ProviderStatus>;
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
  monitorRetryMs?: number;
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

function mimeType(filename: string): string {
  const extension = filename.split(".").at(-1)?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return "image/png";
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

class HttpBridgeProvider implements BuildPipelineProvider {
  readonly agent: "claude" | "codex";

  constructor(
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.agent = connection.agent as "claude" | "codex";
  }

  async createSession(
    phase: PipelineSessionPhase,
    label: string,
    clientSessionKey?: string,
  ): Promise<string> {
    const response = await bridgeFetch(
      this.connection,
      "/session/create",
      {
        method: "POST",
        body: JSON.stringify(this.agent === "codex"
          ? {
              title: label,
              model: this.connection.model,
              modelReasoningEffort: this.connection.effort,
              mode: phase === "review" || phase === "verify" ? "plan" : "build",
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
    options: {
      requestId: string;
      images?: TaskSnapshotImage[];
      schema?: JsonSchema;
    },
  ): Promise<void> {
    const attachments = options.images?.map((image) => this.agent === "claude"
      ? {
          type: "image",
          source: {
            type: "base64",
            media_type: mimeType(image.filename),
            data: image.data,
          },
        }
      : {
          type: "image",
          filename: image.filename,
          dataUrl: `data:${mimeType(image.filename)};base64,${image.data}`,
        });
    const response = await bridgeFetch(
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
                model: this.connection.model,
                effort: this.connection.effort,
                permissionMode: "bypassPermissions",
              }
            : {}),
        }),
      },
      this.fetchImpl,
    );
    if (isTransientHttpStatus(response.status)) {
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

  constructor(
    private readonly connection: BridgeConnection,
    dependencies: ProviderDependencies,
  ) {
    const basic = Buffer.from(`opencode:${connection.authToken}`).toString("base64");
    this.client = dependencies.openCodeClient ?? createOpencodeClient({
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
    this.monitorPromise = this.monitorRequests();
  }

  registerSession(sessionId: string): void {
    this.ownedSessions.add(sessionId);
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
    if (
      !requestId
      || !sessionId
      || !this.ownedSessions.has(sessionId)
      || this.answeringRequestIds.has(requestId)
    ) {
      return;
    }

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
    _clientSessionKey?: string,
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
    options: {
      requestId: string;
      images?: TaskSnapshotImage[];
      schema?: JsonSchema;
    },
  ): Promise<void> {
    const parts: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    for (const image of options.images ?? []) {
      parts.push({
        type: "file",
        mime: mimeType(image.filename),
        filename: image.filename,
        url: `data:${mimeType(image.filename)};base64,${image.data}`,
      });
    }
    const modelParts = this.connection.model?.split("/");
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
        agent: "build",
        variant: this.connection.effort,
        format: options.schema
          ? { type: "json_schema", schema: options.schema, retryCount: 2 }
          : undefined,
      }, this.requestOptions());
    } catch (error) {
      // The request may have reached OpenCode before the response was lost.
      // The durable message ID lets the supervisor reconcile and safely retry.
      throw new ProviderUnavailableError(
        "OpenCode prompt dispatch is unavailable",
        { cause: error },
      );
    }
    if ("error" in response && response.error) {
      throw new PromptRejectedError("OpenCode rejected the prompt");
    }
  }

  async status(sessionId: string): Promise<ProviderStatus> {
    if (this.blockedSessions.has(sessionId)) return "error";
    try {
      const response = await this.client.session.status(
        undefined,
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode status read");
      if (!response.data) throw new Error("OpenCode returned no status");
      const status = response.data[sessionId];
      if (!status) return "missing";
      return status.type === "busy" || status.type === "retry" ? "running" : "idle";
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode status is unavailable", {
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
    : new HttpBridgeProvider(connection, dependencies.fetch ?? fetch);
}

export type { BridgeConnection, ProviderDependencies };
