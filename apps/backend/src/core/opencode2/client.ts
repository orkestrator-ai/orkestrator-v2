/**
 * A small typed client for the OpenCode 2.x server API (`/api/*`).
 *
 * OpenCode 2.x serves no legacy routes, so the 1.x SDK cannot drive it
 * (to-do 0008, retired (`git show 17d28238c:docs/todo/agent-engines/0008-opencode-v2.md`)). This client covers only the
 * routes the 2.x provider uses, verified against the pinned server and its
 * committed `packages/protocol/openapi.json` (2.2.6; 2.3.0's and 2.3.1's add
 * and remove no route it calls). It is written here rather
 * than taken from `@opencode/client` because that package pins `effect` to an
 * exact version the backend does not use, and because every read must be
 * bounded (AGENTS.md invariant 11).
 *
 * Successful 2.x answers are `{ data }` envelopes (list routes add a
 * `cursor`), except `/api/info` and `interrupt`, which answer bare objects, and
 * the mutations that answer 204 (verified against the 2.2.6 and 2.3.0 OpenAPI). A 4xx is a definitive refusal and surfaces as
 * {@link OpenCode2RequestError} with the server's `_tag`; anything else
 * (network, 5xx, an oversized or malformed body) is
 * {@link ProviderUnavailableError}, which says nothing about whether the
 * request took effect.
 */
import { ProviderUnavailableError } from "../agent-provider-contract.js";
import type {
  OpenCode2BackgroundJob,
  OpenCode2Form,
  OpenCode2InboxDelivery,
  OpenCode2InboxItem,
  OpenCode2Info,
  OpenCode2McpRemoteConfig,
  OpenCode2McpServer,
  OpenCode2Message,
  OpenCode2ModelRef,
  OpenCode2PermissionDecision,
  OpenCode2PermissionRequest,
  OpenCode2PermissionRule,
  OpenCode2Session,
  OpenCode2UserInput,
} from "./types.js";

/** Default bound for a single JSON answer. */
export const OPENCODE2_MAX_RESPONSE_BYTES = 256 * 1024;
/** Message pages carry tool output and can be large; they get their own bound. */
export const OPENCODE2_MAX_MESSAGE_PAGE_BYTES = 8 * 1024 * 1024;
export const OPENCODE2_DEFAULT_TIMEOUT_MS = 30_000;
/** Child sessions read per parent; 2.x's own list default is 50. */
export const OPENCODE2_CHILD_SESSION_LIMIT = 50;
/** OpenCode 2.x fixes the Basic-auth username. */
export const OPENCODE2_USERNAME = "opencode";

export interface OpenCode2Connection {
  baseUrl: string;
  password: string;
  /** Sent as `x-opencode-directory`, which scopes a request to a project location. */
  directory: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** A definitive 4xx refusal from the server. The request did not take effect. */
export class OpenCode2RequestError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly tag: string | undefined,
    message: string,
  ) {
    super(`${operation} was refused (${status}${tag ? ` ${tag}` : ""}): ${message}`);
    this.name = "OpenCode2RequestError";
  }
}

export interface OpenCode2MessagePage {
  /** Newest first unless `order: "asc"` was asked for. */
  messages: OpenCode2Message[];
  cursor: { previous?: string; next?: string };
}

export interface OpenCode2PromptInput extends OpenCode2UserInput {
  /** `msg_`-prefixed input id; the same id with the same text is an idempotent retry. */
  id: string;
  delivery: OpenCode2InboxDelivery;
  metadata?: Record<string, unknown>;
}

export type OpenCode2RequestOptions = {
  /** Most 2.x answers are `{ data }` envelopes; `/api/info` and `interrupt` are not. */
  bare?: boolean;
  query?: Record<string, string | undefined>;
  body?: unknown;
  maxBytes?: number;
  signal?: AbortSignal;
};

export class OpenCode2Client {
  private readonly fetchImpl: typeof fetch;
  private readonly authorization: string;

  constructor(private readonly connection: OpenCode2Connection) {
    this.fetchImpl = connection.fetch ?? fetch;
    this.authorization = `Basic ${btoa(`${OPENCODE2_USERNAME}:${connection.password}`)}`;
  }

  get baseUrl(): string {
    return this.connection.baseUrl;
  }

  /** The project location every request is scoped to (`x-opencode-directory`). */
  get directory(): string {
    return this.connection.directory;
  }

  /**
   * One bounded call to a 2.x route, for the feature modules beside this
   * client (`models.ts`, `commands.ts`, `revert.ts`, `sessions.ts`,
   * `credentials.ts`). Same envelope, 4xx and size rules as every typed
   * method here; `envelope: true` returns the whole `{ data, cursor, … }`.
   */
  api<T = unknown>(
    method: string,
    path: string,
    operation: string,
    options: OpenCode2RequestOptions & { envelope?: false },
  ): Promise<T>;
  api(
    method: string,
    path: string,
    operation: string,
    options: OpenCode2RequestOptions & { envelope: true },
  ): Promise<Record<string, unknown>>;
  async api(
    method: string,
    path: string,
    operation: string,
    options: OpenCode2RequestOptions & { envelope?: boolean } = {},
  ): Promise<unknown> {
    const { envelope, ...rest } = options;
    if (envelope) return this.requestEnvelope(method, path, operation, rest);
    return this.request(method, path, operation, rest);
  }

  /** The 2.x health probe. 1.x's `/global/health` answers HTML on 2.x and must not be used. */
  async info(signal?: AbortSignal): Promise<OpenCode2Info> {
    const info = await this.request<OpenCode2Info>("GET", "/api/info", "OpenCode info", {
      signal,
      bare: true,
    });
    if (!info || typeof info.version !== "string") {
      throw new ProviderUnavailableError("OpenCode info is not a 2.x answer");
    }
    return info;
  }

  createSession(input: {
    model?: OpenCode2ModelRef;
    agent?: string;
    metadata?: Record<string, unknown>;
    permissions?: readonly OpenCode2PermissionRule[];
  }): Promise<OpenCode2Session> {
    return this.request("POST", "/api/session", "OpenCode session create", {
      body: { ...input, location: { directory: this.connection.directory } },
    });
  }

  getSession(sessionId: string, signal?: AbortSignal): Promise<OpenCode2Session> {
    return this.request("GET", `/api/session/${seg(sessionId)}`, "OpenCode session read", {
      signal,
    });
  }

  async updateSession(
    sessionId: string,
    patch: {
      metadata?: Record<string, unknown> | null;
      permissions?: readonly OpenCode2PermissionRule[] | null;
    },
  ): Promise<void> {
    await this.request("PATCH", `/api/session/${seg(sessionId)}`, "OpenCode session update", {
      body: patch,
    });
  }

  /**
   * One page of history. A `cursor` carries its own order, and the server
   * refuses one combined with `order` (`InvalidCursorError`), so `order` is
   * dropped whenever a cursor is sent. `type` narrows to one row kind.
   */
  async listMessages(
    sessionId: string,
    options: {
      limit?: number;
      order?: "asc" | "desc";
      cursor?: string;
      type?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<OpenCode2MessagePage> {
    const envelope = await this.requestEnvelope(
      "GET",
      `/api/session/${seg(sessionId)}/message`,
      "OpenCode message list",
      {
        query: {
          limit: options.limit === undefined ? undefined : String(options.limit),
          order: options.cursor === undefined ? options.order : undefined,
          cursor: options.cursor,
          type: options.type,
        },
        maxBytes: OPENCODE2_MAX_MESSAGE_PAGE_BYTES,
        signal: options.signal,
      },
    );
    if (!Array.isArray(envelope.data)) {
      throw new ProviderUnavailableError("OpenCode message list is malformed");
    }
    const cursor = asRecord(envelope.cursor);
    return {
      messages: envelope.data as OpenCode2Message[],
      cursor: {
        ...(typeof cursor?.previous === "string" ? { previous: cursor.previous } : {}),
        ...(typeof cursor?.next === "string" ? { next: cursor.next } : {}),
      },
    };
  }

  /** One history row by id; a 404 means the row (or session) no longer exists. */
  getMessage(
    sessionId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<OpenCode2Message> {
    return this.request(
      "GET",
      `/api/session/${seg(sessionId)}/message/${seg(messageId)}`,
      "OpenCode message read",
      { maxBytes: OPENCODE2_MAX_MESSAGE_PAGE_BYTES, signal },
    );
  }

  /**
   * Admit user input. `steer` delivers at the next safe step boundary of the
   * running run, or starts a run when the session is idle; so does `queue` on
   * an idle session (observed on 2.2.6, contrary to the spec).
   */
  prompt(sessionId: string, input: OpenCode2PromptInput): Promise<OpenCode2Message> {
    return this.request("POST", `/api/session/${seg(sessionId)}/prompt`, "OpenCode prompt", {
      body: input,
    });
  }

  async selectModel(sessionId: string, model: OpenCode2ModelRef): Promise<void> {
    await this.request("POST", `/api/session/${seg(sessionId)}/model`, "OpenCode model switch", {
      body: { model },
    });
  }

  async selectAgent(sessionId: string, agent: string): Promise<void> {
    await this.request("POST", `/api/session/${seg(sessionId)}/agent`, "OpenCode agent switch", {
      body: { agent },
    });
  }

  async interrupt(
    sessionId: string,
    options: { resume?: boolean; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const answer = await this.request<{ interrupted?: unknown }>(
      "POST",
      `/api/session/${seg(sessionId)}/interrupt`,
      "OpenCode interrupt",
      {
        bare: true,
        signal: options.signal,
        query: { resume: options.resume === undefined ? undefined : String(options.resume) },
      },
    );
    return answer?.interrupted === true;
  }

  /**
   * Every session with a run in progress, in one read: `{ [sessionId]: { type: "running" } }`.
   * Sessions absent from the map are not running.
   */
  async activeSessions(signal?: AbortSignal): Promise<ReadonlySet<string>> {
    const data = await this.request<Record<string, unknown>>(
      "GET",
      "/api/session/active",
      "OpenCode active sessions",
      { signal },
    );
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ProviderUnavailableError("OpenCode active sessions is malformed");
    }
    return new Set(Object.keys(data).filter((id) => id.startsWith("ses")));
  }

  /**
   * The newest child sessions of `parentId` (`GET /api/session?parentID=`):
   * the sessions its `subagent` calls created. Since 2.3.0 every subagent
   * runs in the background, so a child may still run after its parent's run
   * settled. Bounded to {@link OPENCODE2_CHILD_SESSION_LIMIT}.
   */
  async listChildSessions(parentId: string, signal?: AbortSignal): Promise<OpenCode2Session[]> {
    const data = await this.request<unknown>("GET", "/api/session", "OpenCode child sessions", {
      query: { parentID: parentId, limit: String(OPENCODE2_CHILD_SESSION_LIMIT), order: "desc" },
      signal,
    });
    if (!Array.isArray(data)) {
      throw new ProviderUnavailableError("OpenCode child sessions is malformed");
    }
    // The filter is the server's; a row naming another parent is never trusted.
    return data.filter(
      (session): session is OpenCode2Session =>
        !!session &&
        typeof session === "object" &&
        typeof (session as { id?: unknown }).id === "string" &&
        (session as { parentID?: unknown }).parentID === parentId,
    );
  }

  /**
   * Wait until the location's plugins have loaded, so a plugin's effects (the
   * credential plugin's hardening, a rebuilt location's commands) are in place.
   *
   * Since 2.2.7 no request handler waits for plugins: `/api/agent` and the
   * catalogue reads answer with whatever has loaded so far, and a location
   * that has not activated lists no plugins. `GET /api/agent` activates the
   * location; `GET /api/plugin` then lists the whole set at once when its load
   * finishes (observed on 2.3.0), which is what is waited for. With
   * `pluginId`, that plugin must be among them and `active`; a server that
   * loaded without it answers `missing`, one whose setup threw `failed`.
   * Resolves `timeout` when nothing loaded in time; transport errors throw.
   */
  async awaitPlugins(options: {
    timeoutMs: number;
    pluginId?: string;
    intervalMs?: number;
    signal?: AbortSignal;
  }): Promise<"loaded" | "missing" | "failed" | "timeout"> {
    const deadline = Date.now() + options.timeoutMs;
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
      : AbortSignal.timeout(options.timeoutMs);
    await this.request("GET", "/api/agent", "OpenCode agent list", { signal });
    for (;;) {
      const plugins = await this.request<unknown>("GET", "/api/plugin", "OpenCode plugin list", {
        signal,
      });
      if (Array.isArray(plugins) && plugins.length > 0) {
        if (!options.pluginId) return "loaded";
        const plugin = plugins
          .map((entry) => asRecord(entry))
          .find((entry) => entry?.id === options.pluginId);
        if (!plugin) return "missing";
        return asRecord(plugin.state)?.status === "active" ? "loaded" : "failed";
      }
      if (Date.now() >= deadline) return "timeout";
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 25));
    }
  }

  /** Input admitted but not yet delivered into the history. */
  async listInbox(sessionId: string, signal?: AbortSignal): Promise<OpenCode2InboxItem[]> {
    const data = await this.request<unknown>(
      "GET",
      `/api/session/${seg(sessionId)}/inbox`,
      "OpenCode inbox",
      { signal },
    );
    if (!Array.isArray(data)) throw new ProviderUnavailableError("OpenCode inbox is malformed");
    return data as OpenCode2InboxItem[];
  }

  /**
   * Background jobs (`GET /api/experimental/job`): the work a session moved
   * to the background whose report has not reached its inbox yet. Since
   * 2.3.1 every foreground shell still running at its timeout becomes one.
   * The route is experimental upstream (no compatibility promise), so it is
   * held to the exact pin like `/api/experimental/mcp/*` and re-read on every
   * bump. `sessionId` filters to that session's jobs, `descendants` adds its
   * child sessions'; an unknown session is a 404.
   */
  async listBackgroundJobs(
    filter: { sessionId?: string; kind?: "shell"; descendants?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<OpenCode2BackgroundJob[]> {
    const data = await this.request<unknown>(
      "GET",
      "/api/experimental/job",
      "OpenCode background jobs",
      {
        query: {
          sessionID: filter.sessionId,
          kind: filter.kind,
          descendants: filter.sessionId && filter.descendants ? "true" : undefined,
        },
        signal,
      },
    );
    if (!Array.isArray(data)) {
      throw new ProviderUnavailableError("OpenCode background jobs is malformed");
    }
    const jobs: OpenCode2BackgroundJob[] = [];
    for (const entry of data) {
      const job = asRecord(entry);
      const time = asRecord(job?.time);
      const status = job?.status;
      if (
        !job ||
        typeof job.id !== "string" ||
        !job.id ||
        typeof job.kind !== "string" ||
        !job.kind ||
        typeof job.sessionID !== "string" ||
        !job.sessionID ||
        (status !== "running" &&
          status !== "completed" &&
          status !== "error" &&
          status !== "cancelled") ||
        typeof time?.started !== "number" ||
        !Number.isFinite(time.started) ||
        (time.completed !== undefined &&
          (typeof time.completed !== "number" || !Number.isFinite(time.completed))) ||
        (status !== "running" && time.completed === undefined) ||
        (job.kind === "shell" &&
          (typeof job.shellID !== "string" || !/^[a-zA-Z0-9_-]+$/.test(job.shellID)))
      ) {
        throw new ProviderUnavailableError("OpenCode background jobs contains a malformed entry");
      }
      if (!filter.kind || job.kind === filter.kind) jobs.push(entry as OpenCode2BackgroundJob);
    }
    return jobs;
  }

  /**
   * Terminate a shell command and remove it with its retained output
   * (`DELETE /api/shell/{id}`, location-scoped). A command already gone
   * answers 204 too. Its background job then settles and reports to its
   * session (2.3.1).
   */
  async removeShell(shellId: string, signal?: AbortSignal): Promise<void> {
    await this.request("DELETE", `/api/shell/${seg(shellId)}`, "OpenCode shell remove", { signal });
  }

  /** Withdraw an inbox item that has not been delivered yet. */
  async withdrawInput(sessionId: string, inputId: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      "DELETE",
      `/api/session/${seg(sessionId)}/inbox/${seg(inputId)}`,
      "OpenCode inbox withdraw",
      { signal },
    );
  }

  listPermissions(sessionId: string, signal?: AbortSignal): Promise<OpenCode2PermissionRequest[]> {
    return this.request(
      "GET",
      `/api/session/${seg(sessionId)}/permission`,
      "OpenCode permissions",
      { signal },
    );
  }

  async replyPermission(
    sessionId: string,
    requestId: string,
    decision: OpenCode2PermissionDecision,
    message?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      "POST",
      `/api/session/${seg(sessionId)}/permission/${seg(requestId)}/reply`,
      "OpenCode permission reply",
      { body: { decision, ...(message ? { message } : {}) }, signal },
    );
  }

  listForms(sessionId: string, signal?: AbortSignal): Promise<OpenCode2Form[]> {
    return this.request("GET", `/api/session/${seg(sessionId)}/form`, "OpenCode forms", { signal });
  }

  async replyForm(sessionId: string, formId: string, answer: Record<string, unknown>) {
    await this.request(
      "POST",
      `/api/session/${seg(sessionId)}/form/${seg(formId)}/reply`,
      "OpenCode form reply",
      { body: { answer } },
    );
  }

  async rejectForm(sessionId: string, formId: string, message?: string, signal?: AbortSignal) {
    await this.request(
      "DELETE",
      `/api/session/${seg(sessionId)}/form/${seg(formId)}`,
      "OpenCode form reject",
      { query: { message }, signal },
    );
  }

  // ── MCP (location-scoped; `/api/experimental/mcp/*` is guarded by the exact pin) ──

  /** The location's MCP servers and their connection status. */
  async listMcpServers(signal?: AbortSignal): Promise<OpenCode2McpServer[]> {
    const data = await this.request<unknown>("GET", "/api/mcp", "OpenCode MCP list", { signal });
    if (!Array.isArray(data)) throw new ProviderUnavailableError("OpenCode MCP list is malformed");
    if (
      !data.every(
        (server) =>
          !!server &&
          typeof (server as { name?: unknown }).name === "string" &&
          typeof (server as { status?: { status?: unknown } }).status?.status === "string",
      )
    )
      throw new ProviderUnavailableError("OpenCode MCP list is malformed");
    return data as OpenCode2McpServer[];
  }

  /**
   * Add or replace a runtime MCP server; it starts connecting at once and
   * lives until the server restarts. The config carries a bearer token, so a
   * refusal never repeats the server's message (it may echo the config).
   */
  async putMcpServer(name: string, config: OpenCode2McpRemoteConfig): Promise<void> {
    try {
      await this.request("PUT", `/api/experimental/mcp/${seg(name)}`, "OpenCode MCP add", {
        body: { config },
      });
    } catch (error) {
      if (error instanceof OpenCode2RequestError) {
        throw new OpenCode2RequestError(error.operation, error.status, error.tag, "refused");
      }
      throw error;
    }
  }

  async removeMcpServer(name: string): Promise<void> {
    await this.request("DELETE", `/api/experimental/mcp/${seg(name)}`, "OpenCode MCP remove");
  }

  async connectMcpServer(name: string): Promise<void> {
    await this.request(
      "POST",
      `/api/experimental/mcp/${seg(name)}/connect`,
      "OpenCode MCP connect",
    );
  }

  async disconnectMcpServer(name: string): Promise<void> {
    await this.request(
      "POST",
      `/api/experimental/mcp/${seg(name)}/disconnect`,
      "OpenCode MCP disconnect",
    );
  }

  /**
   * Open the live event stream. The caller owns the response body and must
   * cancel it (or abort `signal`) to stop; see `readOpenCode2Events`.
   */
  async openEvents(signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url("/api/event"), {
        headers: this.headers(false, "text/event-stream"),
        signal,
      });
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode event stream is unavailable", { cause: error });
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderUnavailableError(`OpenCode event stream answered ${response.status}`);
    }
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      await response.body.cancel().catch(() => undefined);
      throw new ProviderUnavailableError("OpenCode event stream is not an event stream");
    }
    return response.body;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    operation: string,
    options: OpenCode2RequestOptions = {},
  ): Promise<T> {
    const envelope = await this.requestEnvelope(method, path, operation, options);
    return envelope.data as T;
  }

  private async requestEnvelope(
    method: string,
    path: string,
    operation: string,
    options: OpenCode2RequestOptions,
  ): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.connection.timeoutMs ?? OPENCODE2_DEFAULT_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path, options.query), {
        method,
        headers: this.headers(options.body !== undefined),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });
    } catch (error) {
      throw new ProviderUnavailableError(`${operation} is unavailable`, { cause: error });
    }
    if (response.status === 204) {
      await response.body?.cancel().catch(() => undefined);
      return { data: undefined };
    }
    // A 2xx answered as HTML is the bundled web app's fallback, not the API.
    if ((response.headers.get("content-type") ?? "").includes("text/html")) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderUnavailableError(`${operation} reached a page, not the OpenCode 2.x API`);
    }
    const body = await readBoundedJson(response, operation, options.maxBytes);
    if (response.status >= 400 && response.status < 500) {
      const record = asRecord(body);
      throw new OpenCode2RequestError(
        operation,
        response.status,
        typeof record?._tag === "string" ? record._tag.slice(0, 120) : undefined,
        typeof record?.message === "string" ? record.message.slice(0, 500) : "no detail",
      );
    }
    if (!response.ok) {
      throw new ProviderUnavailableError(`${operation} answered ${response.status}`);
    }
    if (options.bare) return { data: body };
    const envelope = asRecord(body);
    if (!envelope || !("data" in envelope)) {
      throw new ProviderUnavailableError(`${operation} is not a 2.x envelope`);
    }
    return envelope;
  }

  private url(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(path, this.connection.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private headers(json: boolean, accept = "application/json"): Headers {
    const headers = new Headers({
      authorization: this.authorization,
      accept,
      "x-opencode-directory": this.connection.directory,
    });
    if (json) headers.set("content-type", "application/json");
    return headers;
  }
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read a JSON body, refusing it past `maxBytes` (declared or streamed). */
export async function readBoundedJson(
  response: Response,
  operation: string,
  maxBytes = OPENCODE2_MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderUnavailableError(`${operation} is oversized`);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderUnavailableError(`${operation} is oversized`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw error;
    throw new ProviderUnavailableError(`${operation} was cut off`, { cause: error });
  } finally {
    reader.releaseLock();
  }
  if (bytes === 0) return null;
  const text = new TextDecoder().decode(Buffer.concat(chunks, bytes));
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderUnavailableError(`${operation} is malformed`);
  }
}
