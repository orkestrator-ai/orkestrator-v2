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
  createSession(phase: PipelineSessionPhase, label: string): Promise<string>;
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
}

type BridgeConnection = {
  agent: BuildPipelineAgent;
  baseUrl: string;
  authToken: string;
  directory?: string;
  model?: string;
  effort?: string;
};

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
): Promise<Response> {
  const headers = authHeaders(connection);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  try {
    return await fetch(`${connection.baseUrl}${path}`, { ...init, headers });
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
    if (
      response.status === 408
      || response.status === 429
      || response.status >= 500
    ) {
      throw new ProviderUnavailableError(
        `${operation} is temporarily unavailable (HTTP ${response.status})`,
      );
    }
    throw new Error(`${operation} failed (HTTP ${response.status})`);
  }
}

class HttpBridgeProvider implements BuildPipelineProvider {
  readonly agent: "claude" | "codex";

  constructor(private readonly connection: BridgeConnection) {
    this.agent = connection.agent as "claude" | "codex";
  }

  async createSession(phase: PipelineSessionPhase, label: string): Promise<string> {
    const response = await bridgeFetch(this.connection, "/session/create", {
      method: "POST",
      body: JSON.stringify(this.agent === "codex"
        ? {
            title: label,
            model: this.connection.model,
            modelReasoningEffort: this.connection.effort,
            mode: phase === "review" || phase === "verify" ? "plan" : "build",
          }
        : { title: label }),
    });
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
    );
    if (
      response.status === 408
      || response.status === 429
      || response.status >= 500
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

  async status(sessionId: string): Promise<ProviderStatus> {
    const path = this.agent === "claude"
      ? `/session/${encodeURIComponent(sessionId)}`
      : `/session/${encodeURIComponent(sessionId)}/status`;
    const response = await bridgeFetch(this.connection, path);
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
    );
    if (!response.ok) return null;
    const body = await response.json() as { structuredOutput?: unknown };
    return (body.structuredOutput ?? null) as StructuredOutputResult<T> | null;
  }

  async abort(sessionId: string): Promise<void> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/abort`,
      { method: "POST" },
    );
    assertOk(response, `${this.agent} abort`);
  }
}

class OpenCodeProvider implements BuildPipelineProvider {
  readonly agent = "opencode" as const;
  private readonly client: OpencodeClient;
  private readonly blockedSessions = new Set<string>();

  constructor(private readonly connection: BridgeConnection) {
    const basic = Buffer.from(`opencode:${connection.authToken}`).toString("base64");
    this.client = createOpencodeClient({
      baseUrl: connection.baseUrl,
      directory: connection.directory,
      headers: {
        Authorization: `Basic ${basic}`,
        "X-Orkestrator-OpenCode-Token": connection.authToken,
      },
    });
    void this.monitorRequests().catch((error) => {
      console.warn("[build-pipeline] OpenCode request monitor stopped:", error);
    });
  }

  private async monitorRequests(): Promise<void> {
    const response = await this.client.event.subscribe();
    if (!response || !("stream" in response)) return;
    for await (const raw of response.stream as AsyncIterable<unknown>) {
      const event = raw && typeof raw === "object"
        ? raw as { type?: unknown; properties?: Record<string, unknown> }
        : {};
      const properties = event.properties ?? {};
      const requestId = typeof properties.id === "string"
        ? properties.id
        : undefined;
      if (event.type === "permission.asked" && requestId) {
        await this.client.permission.reply({
          requestID: requestId,
          reply: Array.isArray(properties.always) && properties.always.length
            ? "always"
            : "once",
        });
      } else if (event.type === "question.asked" && requestId) {
        const sessionId = typeof properties.sessionID === "string"
          ? properties.sessionID
          : typeof properties.sessionId === "string"
            ? properties.sessionId
            : undefined;
        if (sessionId) this.blockedSessions.add(sessionId);
        await this.client.question.reject({ requestID: requestId });
      }
    }
  }

  async createSession(_phase: PipelineSessionPhase, label: string): Promise<string> {
    try {
      const response = await this.client.session.create({ title: label });
      if (!response.data?.id) throw new Error("OpenCode returned an empty session");
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
      });
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
      const response = await this.client.session.status();
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
      const response = await this.client.session.messages({ sessionID: sessionId });
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
      response = await this.client.session.messages({ sessionID: sessionId });
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
    await this.client.session.abort({ sessionID: sessionId });
  }
}

export function createBuildPipelineProvider(
  connection: BridgeConnection,
): BuildPipelineProvider {
  return connection.agent === "opencode"
    ? new OpenCodeProvider(connection)
    : new HttpBridgeProvider(connection);
}

export type { BridgeConnection };
