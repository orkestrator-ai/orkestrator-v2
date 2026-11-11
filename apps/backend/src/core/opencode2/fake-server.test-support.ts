/**
 * A stateful fake of the OpenCode 2.x routes the provider uses, shaped like
 * the pinned 2.2.6 server (`{ data }` envelopes, `idle` rows at run ends,
 * input-id idempotency that answers a conflicting reuse with the original).
 * Test-only. Runs are driven by the test (`finishRun`), not by a model.
 */
import { OpenCode2Client } from "./client.js";

type Row = Record<string, unknown> & { id: string; type: string };

export interface FakeOpenCode2Session {
  id: string;
  rows: Row[];
  inbox: Row[];
  running: boolean;
  model?: unknown;
  /** The session's own permission rules (`permissions` on the wire). */
  rules?: unknown[];
  metadata?: Record<string, unknown>;
  /** Pending permission requests. */
  permissions: Array<{
    id: string;
    sessionID: string;
    action: string;
    resources: string[];
    metadata?: Record<string, unknown>;
  }>;
  forms: Array<{
    id: string;
    sessionID: string;
    title: string;
    fields: unknown;
    metadata?: Record<string, unknown>;
  }>;
  replies: Array<{
    kind: "permission" | "form";
    id: string;
    decision?: string;
    answer?: unknown;
  }>;
  /** `Session.Info` fields the provider reads beyond the id. */
  info: Record<string, unknown>;
  agent?: string;
  title?: string;
  archived?: boolean;
  parentID?: string;
  revert?: { messageID: string };
}

/** A `Model.Info` row as `/api/model` lists it, settings (and their key) included. */
export function fakeOpenCode2Model(
  providerID: string,
  id: string,
  variants: string[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    modelID: id,
    providerID,
    type: "chat",
    name: id,
    settings: { apiKey: "fake-provider-key", baseURL: "http://127.0.0.1:1/v1" },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: variants.map((variant) => ({ id: variant, settings: { reasoningEffort: variant } })),
    status: "active",
    enabled: true,
    limit: { context: 16000, output: 2000 },
    ...extra,
  };
}

export class FakeOpenCode2Server {
  readonly sessions = new Map<string, FakeOpenCode2Session>();
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  /** Answer the next prompt with this status and body instead of admitting it. */
  failNextPrompt?: { status: number; body?: unknown } | "network";
  /** Answer the next form reply with this status and body instead of applying it. */
  failNextFormReply?: { status: number; body?: unknown };
  /** Runtime MCP servers by name, as `PUT /api/experimental/mcp/:server` left them. */
  readonly mcp = new Map<string, { config: unknown; status: string }>();
  /** The status a newly added MCP server reports (`connected` unless a test says otherwise). */
  mcpAddStatus = "connected";
  /** Session updates to drop silently (a write that did not persist). */
  dropNextSessionUpdate = false;
  /** `/api/model`; tests replace it. The default is one fixture model with variants. */
  models: Array<Record<string, unknown>> = [
    fakeOpenCode2Model("fixture", "fixture", ["low", "high"]),
  ];
  defaultModel: Record<string, unknown> | null = null;
  agents: Array<Record<string, unknown>> = [
    { id: "build", name: "Build", mode: "primary", hidden: false, description: "Default" },
    { id: "plan", name: "Plan", mode: "primary", hidden: false, description: "Read-only" },
    { id: "general", name: "General", mode: "subagent", hidden: false },
    { id: "title", name: "Title", mode: "primary", hidden: true },
  ];
  commands: Array<Record<string, unknown>> = [
    { name: "init", description: "guided AGENTS.md setup" },
    { name: "review", description: "review changes" },
  ];
  providers: Array<Record<string, unknown>> = [
    { id: "fixture", name: "Fixture", activation: "enabled", settings: { apiKey: "fake" } },
  ];
  /** `/api/credential`, values included, as the real list answers them. */
  readonly credentials: Array<{
    id: string;
    integrationID: string;
    label: string;
    active: boolean;
    value: unknown;
  }> = [];
  private readonly server: ReturnType<typeof Bun.serve>;
  private events = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private seq = new Map<string, number>();
  private counter = 0;

  constructor() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
  }

  /** Where the fake listens, for a test that builds its own connection. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  client(): OpenCode2Client {
    return new OpenCode2Client({
      baseUrl: this.baseUrl,
      password: "pw",
      directory: "/work",
      timeoutMs: 2_000,
    });
  }

  stop(): void {
    for (const controller of this.events) {
      try {
        controller.close();
      } catch {}
    }
    this.server.stop(true);
  }

  /** Settle the running run: deliver what the run would have answered, then `idle`. */
  finishRun(
    sessionId: string,
    outcome: "succeeded" | "interrupted" | "failed" = "succeeded",
    answer?: string,
  ): void {
    const session = this.sessions.get(sessionId)!;
    this.drainInbox(session);
    session.rows.push({
      id: this.id("msg"),
      type: "assistant",
      content: answer === undefined ? [] : [{ type: "text", text: answer }],
      time: { created: 1 },
    });
    session.rows.push({ id: this.id("msg"), type: "idle", outcome, time: { created: 1 } });
    session.running = false;
    session.info.outcome = outcome;
    this.emit(sessionId, "session.execution.succeeded");
  }

  /** Append a history row as the server would (a tool-call response, a shell row, …). */
  pushRow(sessionId: string, row: Record<string, unknown> & { type: string; id?: string }): string {
    const id = row.id ?? this.id("msg");
    this.sessions.get(sessionId)!.rows.push({ time: { created: 1 }, ...row, id } as Row);
    return id;
  }

  /** Replace a history row in place, the way a late tool result lands on its response. */
  reviseRow(sessionId: string, id: string, patch: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId)!;
    const index = session.rows.findIndex((row) => row.id === id);
    session.rows[index] = { ...session.rows[index]!, ...patch };
    this.emit(sessionId, "session.tool.success", { assistantMessageID: id }, false);
  }

  /** Send one event to every open stream; `durable: false` sends an ephemeral one. */
  emitEvent(
    sessionId: string,
    type: string,
    data: Record<string, unknown> = {},
    durable = true,
  ): void {
    this.emit(sessionId, type, data, durable);
  }

  /** `GET /api/event` connections opened so far. */
  eventConnections = 0;

  /** Write the real server's idle keepalive, a `: heartbeat` comment, to every open stream. */
  heartbeat(): void {
    this.broadcast(": heartbeat\n\n");
  }

  /** End every open `/api/event` body from the server side, as a dropped subscriber sees it. */
  endEvents(): void {
    for (const controller of Array.from(this.events)) {
      this.events.delete(controller);
      try {
        controller.close();
      } catch {}
    }
  }

  /** A fresh `msg_`/`ses_`/`per_`/`frm_` id in the server's ascending format. */
  nextId(prefix: string): string {
    return this.id(prefix);
  }

  private id(prefix: string): string {
    return `${prefix}_${String(++this.counter).padStart(12, "0")}fake`;
  }

  private emit(
    sessionId: string,
    type: string,
    data: Record<string, unknown> = {},
    durable = true,
  ): void {
    const seq = (this.seq.get(sessionId) ?? 0) + 1;
    if (durable) this.seq.set(sessionId, seq);
    const frame = `data: ${JSON.stringify({
      type,
      data: { sessionID: sessionId, ...data },
      ...(durable ? { durable: { aggregateID: sessionId, seq, version: 1 } } : {}),
    })}\n\n`;
    this.broadcast(frame);
  }

  private broadcast(frame: string): void {
    const bytes = new TextEncoder().encode(frame);
    for (const controller of this.events) {
      try {
        controller.enqueue(bytes);
      } catch {
        this.events.delete(controller);
      }
    }
  }

  private drainInbox(session: FakeOpenCode2Session): void {
    for (const item of session.inbox.splice(0)) {
      session.rows.push({
        id: item.id,
        type: "user",
        text: (item.payload as { text: string }).text,
        metadata: (item.payload as { metadata?: unknown }).metadata,
        time: { created: 1 },
      });
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const text =
      request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    this.calls.push({ method: request.method, path, ...(body ? { body } : {}) });
    const ok = (data: unknown) => Response.json({ data });
    const notFound = () =>
      Response.json({ _tag: "SessionNotFoundError", message: "missing" }, { status: 404 });

    // Bare, like the real route.
    if (path === "/api/info") return Response.json({ version: "2.2.6", pid: process.pid });
    if (path === "/api/event") {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.eventConnections += 1;
          this.events.add(controller);
          controller.enqueue(new TextEncoder().encode(`data: {"type":"server.connected"}\n\n`));
        },
        cancel: () => undefined,
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/api/mcp") {
      return Response.json({
        location: { directory: "/work" },
        data: [...this.mcp].map(([name, entry]) => ({ name, status: { status: entry.status } })),
      });
    }
    const mcp = /^\/api\/experimental\/mcp\/([^/]+)(?:\/(connect|disconnect))?$/.exec(path);
    if (mcp) {
      const name = decodeURIComponent(mcp[1]!);
      const entry = this.mcp.get(name);
      if (request.method === "PUT") {
        this.mcp.set(name, { config: body!.config, status: this.mcpAddStatus });
        return new Response(null, { status: 204 });
      }
      if (!entry) {
        return Response.json(
          { _tag: "McpServerNotFoundError", server: name, message: "missing" },
          { status: 404 },
        );
      }
      if (request.method === "DELETE") this.mcp.delete(name);
      else entry.status = mcp[2] === "disconnect" ? "disabled" : "connected";
      return new Response(null, { status: 204 });
    }
    if (path === "/api/session" && request.method === "POST") {
      const id = this.id("ses");
      this.sessions.set(id, {
        id,
        rows: [],
        inbox: [],
        running: false,
        model: body?.model,
        ...(body?.permissions ? { rules: body.permissions as unknown[] } : {}),
        ...(body?.metadata ? { metadata: body.metadata as Record<string, unknown> } : {}),
        agent: typeof body?.agent === "string" ? body.agent : "build",
        permissions: [],
        forms: [],
        replies: [],
        info: {
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      return ok({ id, model: body?.model, metadata: body?.metadata });
    }
    if (path === "/api/session" && request.method === "GET") {
      const archived = url.searchParams.get("archived");
      const listed = [...this.sessions.values()]
        .filter((session) => archived !== "false" || !session.archived)
        .reverse()
        .map((session) => this.sessionInfo(session));
      return Response.json({ data: listed, cursor: {} });
    }
    if (path === "/api/model") return Response.json({ location: {}, data: this.models });
    if (path === "/api/model/default") {
      return Response.json({ location: {}, data: this.defaultModel ?? this.models[0] ?? null });
    }
    if (path === "/api/agent") return ok(this.agents);
    if (path === "/api/command") return Response.json({ location: {}, data: this.commands });
    if (path === "/api/provider") return ok(this.providers);
    const credentialRoute = this.credentialRoute(request.method, path, body);
    if (credentialRoute) return credentialRoute;
    if (path === "/api/session/active") {
      const active: Record<string, unknown> = {};
      for (const session of this.sessions.values()) {
        if (session.running) active[session.id] = { type: "running" };
      }
      return ok(active);
    }
    const match = /^\/api\/session\/([^/]+)(?:\/(.+))?$/.exec(path);
    const session = match ? this.sessions.get(decodeURIComponent(match[1]!)) : undefined;
    if (!match || !session) return notFound();
    const rest = match[2] ?? "";
    const busy = () =>
      Response.json({ _tag: "SessionBusyError", message: "busy" }, { status: 409 });

    if (rest === "" && request.method === "GET") return ok(this.sessionInfo(session));
    if (rest === "" && request.method === "PATCH") {
      if (this.dropNextSessionUpdate) {
        this.dropNextSessionUpdate = false;
        return new Response(null, { status: 204 });
      }
      if (typeof body?.title === "string") session.title = body.title;
      if (typeof body?.archived === "boolean") session.archived = body.archived;
      // Both fields replace what the session held (2.2.6).
      if (body && "permissions" in body) session.rules = (body.permissions as unknown[]) ?? [];
      if (body && "metadata" in body) {
        session.metadata = (body.metadata as Record<string, unknown> | null) ?? undefined;
      }
      return new Response(null, { status: 204 });
    }
    if (rest === "agent") {
      session.agent = String(body!.agent);
      session.rows.push({ id: this.id("msg"), type: "agent-switched", time: { created: 1 } });
      return new Response(null, { status: 204 });
    }
    if (rest === "command") {
      const known = this.commands.some((command) => command.name === body!.name);
      if (!known) {
        return Response.json(
          { _tag: "CommandNotFoundError", command: body!.name, message: "Command not found" },
          { status: 404 },
        );
      }
      // The server expands the template into an ordinary prompt with no metadata.
      const item: Row = {
        id: this.id("msg"),
        type: "user",
        payload: { text: `TEMPLATE(${String(body!.name)}):${String(body!.text)}` },
        delivery: body!.delivery,
      };
      if (session.running) session.inbox.push(item);
      else {
        session.running = true;
        this.drainOne(session, item);
      }
      return new Response(null, { status: 204 });
    }
    if (rest === "compact") {
      const item = { id: this.id("msg"), type: "compaction", payload: {}, delivery: "queue" };
      session.rows.push({ id: item.id, type: "compaction", time: { created: 1 } });
      return ok(item);
    }
    if (rest === "revert/stage") {
      if (session.running) return busy();
      const target = session.rows.find((row) => row.id === body!.messageID);
      if (!target) {
        return Response.json({ _tag: "MessageNotFoundError", message: "no" }, { status: 404 });
      }
      session.revert = { messageID: target.id };
      return ok({ messageID: target.id, files: [] });
    }
    if (rest === "revert" && request.method === "DELETE") {
      if (session.running) return busy();
      session.revert = undefined;
      return new Response(null, { status: 204 });
    }
    if (rest === "fork") {
      const before = body?.before as string | undefined;
      const cut = before ? session.rows.findIndex((row) => row.id === before) : -1;
      const id = this.id("ses");
      this.sessions.set(id, {
        id,
        rows: (cut >= 0 ? session.rows.slice(0, cut) : [...session.rows]).map((row, index) => ({
          ...row,
          id: `${row.id}_${index + 1}`,
        })),
        inbox: [],
        running: false,
        model: session.model,
        agent: session.agent,
        title: `${session.title ?? "Untitled"} (fork #1)`,
        parentID: undefined,
        // A fork copies its parent's rules and metadata, like any child (2.2.6).
        ...(session.rules ? { rules: [...session.rules] } : {}),
        ...(session.metadata ? { metadata: { ...session.metadata } } : {}),
        info: {
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        permissions: [],
        forms: [],
        replies: [],
      });
      return ok(this.sessionInfo(this.sessions.get(id)!));
    }

    if (rest === "prompt") {
      const failure = this.failNextPrompt;
      this.failNextPrompt = undefined;
      if (failure === "network") return new Response(null, { status: 502 });
      if (failure)
        return Response.json(failure.body ?? { _tag: "Refused" }, { status: failure.status });
      const existing = [...session.rows, ...session.inbox].find((row) => row.id === body!.id);
      if (existing) {
        const payload = existing.payload ?? { text: existing.text, metadata: existing.metadata };
        return ok({ id: existing.id, type: "user", payload, delivery: body!.delivery });
      }
      const item: Row = {
        id: String(body!.id),
        type: "user",
        payload: {
          text: body!.text,
          metadata: body!.metadata,
          ...(body!.files ? { files: body!.files } : {}),
        },
        delivery: body!.delivery,
      };
      // A prompt commits a staged revert: everything from its boundary on goes.
      if (session.revert) {
        const cut = session.rows.findIndex((row) => row.id === session.revert!.messageID);
        if (cut >= 0) session.rows.splice(cut);
        session.revert = undefined;
      }
      if (session.running) {
        // Steer delivers at the next step boundary; queue waits for the run's end.
        if (body!.delivery === "steer") this.drainOne(session, item);
        else session.inbox.push(item);
      } else {
        // Both deliveries wake an idle session (2.2.6).
        session.running = true;
        this.drainOne(session, item);
        this.emit(session.id, "session.execution.started");
      }
      return ok({ id: item.id, type: "user", payload: item.payload, delivery: item.delivery });
    }
    if (rest === "message") {
      const rawCursor = url.searchParams.get("cursor");
      // Like 2.2.6: a cursor carries its own order and refuses an explicit one.
      if (rawCursor && url.searchParams.has("order")) {
        return Response.json({ _tag: "InvalidCursorError", message: "order" }, { status: 400 });
      }
      const cursor = rawCursor
        ? (JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8")) as {
            id: string;
            order: "asc" | "desc";
          })
        : undefined;
      const order = cursor?.order ?? url.searchParams.get("order") ?? "desc";
      const limit = Number(url.searchParams.get("limit") ?? 50);
      // 2.2.6 refuses a page larger than 200 rows.
      if (limit > 200) {
        return Response.json(
          { _tag: "InvalidRequestError", message: "Expected a value less than or equal to 200" },
          { status: 400 },
        );
      }
      const type = url.searchParams.get("type");
      let rows = type ? session.rows.filter((row) => row.type === type) : [...session.rows];
      if (order === "desc") rows.reverse();
      if (cursor) {
        const anchor = rows.findIndex((row) => row.id === cursor.id);
        // A vanished anchor answers an empty page, as the real store does.
        rows = anchor < 0 ? [] : rows.slice(anchor + 1);
      }
      rows = rows.slice(0, limit);
      const encode = (id: string) =>
        Buffer.from(JSON.stringify({ id, order, direction: "next" })).toString("base64url");
      return Response.json({
        data: rows,
        cursor: rows.length > 0 ? { next: encode(rows.at(-1)!.id) } : {},
      });
    }
    const messageRead = /^message\/([^/]+)$/.exec(rest);
    if (messageRead) {
      const row = session.rows.find((candidate) => candidate.id === messageRead[1]);
      return row ? ok(row) : Response.json({ _tag: "NotFound", message: "row" }, { status: 404 });
    }
    const formReply = /^form\/([^/]+)\/reply$/.exec(rest);
    if (formReply) {
      const failure = this.failNextFormReply;
      this.failNextFormReply = undefined;
      if (failure)
        return Response.json(failure.body ?? { _tag: "Refused" }, { status: failure.status });
      if (!session.forms.some((f) => f.id === formReply[1])) {
        return Response.json({ _tag: "Form.NotFoundError", message: "form" }, { status: 404 });
      }
      session.forms = session.forms.filter((f) => f.id !== formReply[1]);
      session.replies.push({ kind: "form", id: formReply[1]!, answer: body!.answer });
      return new Response(null, { status: 204 });
    }
    if (rest === "inbox") return ok(session.inbox);
    if (rest === "model") {
      session.model = body!.model;
      return new Response(null, { status: 204 });
    }
    if (rest === "interrupt") {
      const interrupted = session.running;
      if (interrupted) this.finishRun(session.id, "interrupted");
      // Bare, like the real route.
      return Response.json({ interrupted });
    }
    if (rest === "permission") return ok(session.permissions);
    if (rest === "form") return ok(session.forms);
    const permissionReply = /^permission\/([^/]+)\/reply$/.exec(rest);
    if (permissionReply) {
      if (!session.permissions.some((p) => p.id === permissionReply[1])) {
        return Response.json({ _tag: "PermissionNotFoundError", message: "x" }, { status: 404 });
      }
      session.permissions = session.permissions.filter((p) => p.id !== permissionReply[1]);
      session.replies.push({
        kind: "permission",
        id: permissionReply[1]!,
        decision: String(body!.decision),
      });
      return new Response(null, { status: 204 });
    }
    const form = /^form\/([^/]+)$/.exec(rest);
    if (form && request.method === "DELETE") {
      session.forms = session.forms.filter((f) => f.id !== form[1]);
      session.replies.push({ kind: "form", id: form[1]!, decision: "rejected" });
      return new Response(null, { status: 204 });
    }
    return Response.json({ _tag: "NotFound", message: rest }, { status: 404 });
  }

  private sessionInfo(session: FakeOpenCode2Session): Record<string, unknown> {
    return {
      id: session.id,
      projectID: "project",
      ...(session.model ? { model: session.model } : {}),
      ...(session.agent ? { agent: session.agent } : {}),
      ...(session.title ? { title: session.title } : {}),
      ...(session.parentID ? { parentID: session.parentID } : {}),
      ...(session.revert ? { revert: session.revert } : {}),
      cost: 0,
      ...session.info,
      ...(session.metadata ? { metadata: session.metadata } : {}),
      ...(session.rules ? { permissions: session.rules } : {}),
      time: {
        created: 1_700_000_000_000,
        updated: 1_700_000_001_000,
        ...(session.archived ? { archived: 1 } : {}),
      },
      location: { directory: "/work" },
    };
  }

  private credentialRoute(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
  ): Response | undefined {
    if (path === "/api/credential" && method === "GET") {
      return Response.json({ data: this.credentials });
    }
    if (path === "/api/credential" && method === "POST") {
      const integrationID = String(body!.integrationID);
      if (body!.activate !== false) {
        for (const credential of this.credentials) {
          if (credential.integrationID === integrationID) credential.active = false;
        }
      }
      const entry = {
        id: this.id("cred"),
        integrationID,
        label: String(body!.label ?? "default"),
        active: body!.activate !== false,
        value: body!.value,
      };
      this.credentials.push(entry);
      return Response.json({ data: entry });
    }
    const remove = /^\/api\/credential\/([^/]+)$/.exec(path);
    if (remove && method === "DELETE") {
      const index = this.credentials.findIndex((credential) => credential.id === remove[1]);
      if (index >= 0) this.credentials.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return undefined;
  }

  private drainOne(session: FakeOpenCode2Session, item: Row): void {
    session.rows.push({
      id: item.id,
      type: "user",
      text: (item.payload as { text: string }).text,
      metadata: (item.payload as { metadata?: unknown }).metadata,
      time: { created: 1 },
    });
  }
}
