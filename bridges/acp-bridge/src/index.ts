import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

type Provider = "cursor" | "grok";
type JsonObject = Record<string, unknown>;

interface BridgeMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: Array<{ type: "text" | "reasoning"; text: string }>;
  createdAt: string;
}

interface SessionState {
  id: string;
  acpSessionId: string;
  status: "idle" | "running" | "error";
  error?: string;
  messages: BridgeMessage[];
  child: AcpProcess;
  revision: number;
  structured: Map<string, unknown>;
  approvals: Map<string, ApprovalState>;
}

interface ApprovalState {
  id: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
  requestedAt: number;
  expiresAt: number;
  respond(optionId?: string): void;
  timer: ReturnType<typeof setTimeout>;
}

const provider = parseProvider(process.env.ACP_PROVIDER);
const port = parsePort(process.env.PORT);
const hostname = process.env.HOSTNAME?.trim() || "127.0.0.1";
const workingDirectory = resolve(process.env.CWD?.trim() || process.cwd());
const authToken = process.env.ACP_BRIDGE_TOKEN?.trim() || randomBytes(32).toString("base64url");
const executable = process.env.ACP_AGENT_PATH?.trim() || (provider === "cursor" ? "cursor" : "grok");
const sessions = new Map<string, SessionState>();
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES = 500;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 256;
const MAX_APPROVALS_PER_SESSION = 64;
const MAX_STRUCTURED_RESULTS = 200;

class AcpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  #closed = false;
  onUpdate: (params: JsonObject) => void = () => undefined;
  onPermission: (id: number, params: JsonObject) => void = (id) => {
    this.respond(id, { outcome: { outcome: "cancelled" } });
  };
  onClose: (error: Error) => void = () => undefined;

  constructor() {
    const args = provider === "cursor" ? ["acp"] : ["agent", "stdio"];
    this.child = spawn(executable, args, {
      cwd: workingDirectory,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#acceptLine(line));
    // Agent stderr can contain prompts, file paths, or tool output. Drain it so
    // the child cannot block, but never forward its contents into bridge logs.
    this.child.stderr.resume();
    this.child.once("error", (error) => this.#close(error));
    this.child.once("exit", (code, signal) => {
      this.#close(new Error(`${provider} ACP process exited (code ${code ?? "null"}, signal ${signal ?? "null"})`));
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "orkestrator", title: "Orkestrator", version: "1.0.0" },
    });
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error(`${provider} ACP process is not running`));
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: JsonObject): void {
    if (!this.#closed) this.#write({ jsonrpc: "2.0", method, params });
  }

  respond(id: number, result: unknown): void {
    if (!this.#closed) this.#write({ jsonrpc: "2.0", id, result });
  }

  close(): void {
    if (this.#closed) return;
    this.child.kill("SIGTERM");
  }

  #write(value: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #acceptLine(line: string): void {
    if (!line.trim() || Buffer.byteLength(line) > MAX_LINE_BYTES) return;
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonObject;
        pending.reject(new Error(typeof error.message === "string" ? error.message : "ACP request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.id === "number" && typeof message.method === "string") {
      // Permission and unsupported client-side operations deny/fail closed.
      if (message.method === "session/request_permission") {
        this.onPermission(message.id, isObject(message.params) ? message.params : {});
      } else {
        this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Unsupported ACP client method: ${message.method}` },
        });
      }
      return;
    }
    if (message.method === "session/update" && isObject(message.params)) {
      this.onUpdate(message.params);
    }
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.onClose(error);
  }
}

async function createSession(): Promise<SessionState> {
  if (sessions.size >= MAX_SESSIONS) throw new Error("ACP session limit reached");
  const child = new AcpProcess();
  try {
    await child.initialize();
    const created = await child.request("session/new", { cwd: workingDirectory, mcpServers: [] });
    if (!isObject(created) || typeof created.sessionId !== "string") {
      throw new Error(`${provider} returned an invalid ACP session`);
    }
    const id = randomBytes(16).toString("hex");
    const state: SessionState = {
      id,
      acpSessionId: created.sessionId,
      status: "idle",
      messages: [],
      child,
      revision: 0,
      structured: new Map(),
      approvals: new Map(),
    };
    child.onUpdate = (params) => applySessionUpdate(state, params);
    child.onPermission = (requestId, params) => parkPermission(state, requestId, params);
    child.onClose = (error) => {
      clearApprovals(state);
      if (sessions.get(state.id) !== state) return;
      state.status = "error";
      state.error = error.message;
      state.revision += 1;
    };
    sessions.set(id, state);
    return state;
  } catch (error) {
    child.close();
    throw error;
  }
}

function clearApprovals(state: SessionState): void {
  for (const approval of state.approvals.values()) clearTimeout(approval.timer);
  state.approvals.clear();
}

function parkPermission(state: SessionState, requestId: number, params: JsonObject): void {
  if (state.approvals.size >= MAX_APPROVALS_PER_SESSION) {
    state.child.respond(requestId, { outcome: { outcome: "cancelled" } });
    return;
  }
  const options = Array.isArray(params.options)
    ? params.options.flatMap((candidate) => {
        if (!isObject(candidate) || typeof candidate.optionId !== "string") return [];
        return [{
          optionId: candidate.optionId.slice(0, 256),
          name: (typeof candidate.name === "string" ? candidate.name : candidate.optionId).slice(0, 256),
          ...(typeof candidate.kind === "string" ? { kind: candidate.kind.slice(0, 64) } : {}),
        }];
      }).slice(0, 20)
    : [];
  const id = randomBytes(12).toString("hex");
  const requestedAt = Date.now();
  const expiresAt = requestedAt + 5 * 60_000;
  const finish = (optionId?: string) => {
    const approval = state.approvals.get(id);
    if (!approval) return;
    clearTimeout(approval.timer);
    state.approvals.delete(id);
    if (optionId && approval.options.some((option) => option.optionId === optionId)) {
      state.child.respond(requestId, { outcome: { outcome: "selected", optionId } });
    } else {
      state.child.respond(requestId, { outcome: { outcome: "cancelled" } });
    }
    state.revision += 1;
  };
  const timer = setTimeout(() => finish(), expiresAt - requestedAt);
  timer.unref();
  state.approvals.set(id, {
    id,
    title: permissionTitle(params),
    options,
    requestedAt,
    expiresAt,
    respond: finish,
    timer,
  });
  state.revision += 1;
}

function permissionTitle(params: JsonObject): string {
  const toolCall = isObject(params.toolCall) ? params.toolCall : undefined;
  const title = typeof params.title === "string"
    ? params.title
    : typeof toolCall?.title === "string"
      ? toolCall.title
      : "Permission requested";
  return title.slice(0, 500);
}

function applySessionUpdate(state: SessionState, params: JsonObject): void {
  if (params.sessionId !== state.acpSessionId || !isObject(params.update)) return;
  const update = params.update;
  const kind = typeof update.sessionUpdate === "string"
    ? update.sessionUpdate
    : typeof update.type === "string"
      ? update.type
      : "";
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const text = contentText(update.content);
    if (!text) return;
    let message = state.messages.at(-1);
    if (!message || message.role !== "assistant" || state.status !== "running") {
      message = {
        id: randomBytes(12).toString("hex"),
        role: "assistant",
        content: "",
        parts: [],
        createdAt: new Date().toISOString(),
      };
      state.messages.push(message);
    }
    const partType = kind === "agent_thought_chunk" ? "reasoning" : "text";
    const previous = message.parts.at(-1);
    if (previous?.type === partType) previous.text += text;
    else message.parts.push({ type: partType, text });
    if (partType === "text") message.content += text;
    state.revision += 1;
    boundTranscript(state);
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isObject(value)) return "";
  return typeof value.text === "string" ? value.text : "";
}

function boundTranscript(state: SessionState): void {
  while (state.messages.length > MAX_MESSAGES) state.messages.shift();
  let bytes = Buffer.byteLength(JSON.stringify(state.messages));
  while (bytes > MAX_TRANSCRIPT_BYTES && state.messages.length > 1) {
    state.messages.shift();
    bytes = Buffer.byteLength(JSON.stringify(state.messages));
  }
}

function publicSession(state: SessionState): JsonObject {
  return {
    id: state.id,
    provider,
    status: state.status,
    error: state.error,
    messages: state.messages,
    revision: state.revision,
    sessionId: state.id,
  };
}

function publicApprovals(state: SessionState): unknown[] {
  return [...state.approvals.values()].map(({ id, title, options, requestedAt, expiresAt }) => ({
    id,
    title,
    options,
    // Compatibility fields let the backend's normalized interaction monitor
    // observe and fail-close unattended ACP permissions just like Codex ones.
    approvalId: id,
    kind: "permissions",
    permissions: { fileSystem: true },
    actionable: true,
    requestedAt,
    expiresAt,
  }));
}

function setStructuredResult(state: SessionState, requestId: string, value: unknown): void {
  if (!state.structured.has(requestId) && state.structured.size >= MAX_STRUCTURED_RESULTS) {
    const oldest = state.structured.keys().next().value;
    if (typeof oldest === "string") state.structured.delete(oldest);
  }
  state.structured.set(requestId, value);
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/global/health" && request.method === "GET") {
    return json(response, 200, { ok: true, provider, version: "1.0.0" });
  }
  if (!authenticated(request)) return json(response, 401, { error: "Unauthorized" });
  if (url.pathname === "/global/auth-check" && request.method === "GET") {
    return json(response, 200, { ok: true });
  }
  if (url.pathname === "/session/create" && request.method === "POST") {
    const state = await createSession();
    return json(response, 201, publicSession(state));
  }
  const match = /^\/session\/([^/]+)(?:\/(messages|status|activity|prompt|cancel|abort|structured-output|interactions|approvals(?:\/[^/]+)?))?$/.exec(url.pathname);
  if (!match) return json(response, 404, { error: "Not found" });
  const state = sessions.get(match[1]!);
  if (!state) {
    if (match[2] === "activity") return json(response, 200, { activity: "missing" });
    return json(response, 404, { error: "Session not found" });
  }
  const action = match[2];
  if (!action && request.method === "GET") return json(response, 200, publicSession(state));
  if (action === "messages" && request.method === "GET") return json(response, 200, { messages: state.messages, revision: state.revision });
  if (action === "status" && request.method === "GET") return json(response, 200, { status: state.status, error: state.error, revision: state.revision });
  if (action === "activity" && request.method === "GET") return json(response, 200, { activity: state.status === "running" ? "working" : "idle" });
  if (action === "approvals" && request.method === "GET") return json(response, 200, { approvals: publicApprovals(state), revision: state.revision });
  if (action === "interactions" && request.method === "GET") return json(response, 200, { interactions: [], revision: state.revision });
  if (action?.startsWith("approvals/") && request.method === "POST") {
    const approval = state.approvals.get(decodeURIComponent(action.slice("approvals/".length)));
    if (!approval) return json(response, 404, { error: "Approval not found" });
    const body = await readJson(request);
    const explicitOption = typeof body.optionId === "string" ? body.optionId : undefined;
    const approvedOption = body.decision === "approve"
      ? approval.options.find((option) => option.kind === "allow_once")?.optionId
        ?? approval.options.find((option) => option.kind?.startsWith("allow"))?.optionId
      : undefined;
    approval.respond(explicitOption ?? approvedOption);
    return json(response, 200, { resolved: true });
  }
  if (action === "structured-output" && request.method === "GET") {
    const requestId = url.searchParams.get("requestId") || "";
    return json(response, 200, { structuredOutput: state.structured.get(requestId) ?? null });
  }
  if (action === "prompt" && request.method === "POST") {
    if (state.status === "running") return json(response, 409, { error: "Session is already running" });
    const body = await readJson(request);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const schema = isObject(body.outputSchema) ? body.outputSchema : undefined;
    if (!prompt) return json(response, 400, { error: "prompt is required" });
    state.messages.push({
      id: randomBytes(12).toString("hex"), role: "user", content: prompt,
      parts: [{ type: "text", text: prompt }], createdAt: new Date().toISOString(),
    });
    state.status = "running";
    state.error = undefined;
    state.revision += 1;
    boundTranscript(state);
    const acpPrompt = schema
      ? `${prompt}\n\nReturn only one JSON value matching this JSON Schema. Do not use a Markdown fence or add commentary.\n\n${JSON.stringify(schema)}`
      : prompt;
    void state.child.request("session/prompt", {
      sessionId: state.acpSessionId,
      prompt: [{ type: "text", text: acpPrompt }],
    }).then(() => {
      state.status = "idle";
      if (schema && requestId) {
        const output = [...state.messages].reverse().find((message) => message.role === "assistant")?.content.trim() ?? "";
        try {
          setStructuredResult(state, requestId, { ok: true, value: JSON.parse(output), provider, requestId });
        } catch {
          setStructuredResult(state, requestId, {
            ok: false,
            provider,
            requestId,
            error: { code: "malformed_output", message: `${provider} returned malformed JSON`, provider, retryable: true },
          });
        }
      }
      state.revision += 1;
    }, (error: unknown) => {
      state.status = "error";
      state.error = error instanceof Error ? error.message : String(error);
      state.revision += 1;
    });
    return json(response, 202, { accepted: true });
  }
  if ((action === "cancel" || action === "abort") && request.method === "POST") {
    for (const approval of [...state.approvals.values()]) approval.respond();
    state.child.notify("session/cancel", { sessionId: state.acpSessionId });
    return json(response, 202, { accepted: true });
  }
  if (!action && request.method === "DELETE") {
    for (const approval of state.approvals.values()) approval.respond();
    state.child.close();
    sessions.delete(state.id);
    return json(response, 200, { deleted: true });
  }
  return json(response, 405, { error: "Method not allowed" });
}

function authenticated(request: IncomingMessage): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(authToken);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!isObject(parsed)) throw new Error("Expected a JSON object");
  return parsed;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseProvider(value: string | undefined): Provider {
  if (value === "cursor" || value === "grok") return value;
  throw new Error("ACP_PROVIDER must be cursor or grok");
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value || "4099");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("PORT is invalid");
  return parsed;
}

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(port, hostname, () => console.log(`ACP bridge (${provider}) listening on ${hostname}:${port}`));

function shutdown(): void {
  for (const state of sessions.values()) state.child.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
