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
  permissions: Array<{ id: string; sessionID: string; action: string; resources: string[] }>;
  forms: Array<{ id: string; sessionID: string; title: string; fields: unknown }>;
  replies: Array<{ kind: "permission" | "form"; id: string; decision?: string }>;
}

export class FakeOpenCode2Server {
  readonly sessions = new Map<string, FakeOpenCode2Session>();
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  /** Answer the next prompt with this status and body instead of admitting it. */
  failNextPrompt?: { status: number; body?: unknown } | "network";
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

  client(): OpenCode2Client {
    return new OpenCode2Client({
      baseUrl: `http://127.0.0.1:${this.server.port}`,
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
  finishRun(sessionId: string, outcome: "succeeded" | "interrupted" = "succeeded"): void {
    const session = this.sessions.get(sessionId)!;
    this.drainInbox(session);
    session.rows.push({ id: this.id("msg"), type: "assistant", content: [], time: { created: 1 } });
    session.rows.push({ id: this.id("msg"), type: "idle", outcome, time: { created: 1 } });
    session.running = false;
    this.emit(sessionId, "session.execution.succeeded");
  }

  private id(prefix: string): string {
    return `${prefix}_${String(++this.counter).padStart(12, "0")}fake`;
  }

  private emit(sessionId: string, type: string): void {
    const seq = (this.seq.get(sessionId) ?? 0) + 1;
    this.seq.set(sessionId, seq);
    const frame = `data: ${JSON.stringify({ type, data: { sessionID: sessionId }, durable: { aggregateID: sessionId, seq, version: 1 } })}\n\n`;
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
          this.events.add(controller);
          controller.enqueue(new TextEncoder().encode(`data: {"type":"server.connected"}\n\n`));
        },
        cancel: () => undefined,
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/api/session" && request.method === "POST") {
      const id = this.id("ses");
      this.sessions.set(id, {
        id,
        rows: [],
        inbox: [],
        running: false,
        model: body?.model,
        permissions: [],
        forms: [],
        replies: [],
      });
      return ok({ id, model: body?.model, metadata: body?.metadata });
    }
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
        payload: { text: body!.text, metadata: body!.metadata },
        delivery: body!.delivery,
      };
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
      const order = url.searchParams.get("order") ?? "desc";
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const rows =
        order === "asc"
          ? session.rows.slice(0, limit)
          : [...session.rows].reverse().slice(0, limit);
      return Response.json({ data: rows, cursor: {} });
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
