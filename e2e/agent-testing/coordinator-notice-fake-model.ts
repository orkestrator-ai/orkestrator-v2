/**
 * A loopback provider for `coordinator-notice-live.spec.ts` (to-do 7542):
 * the Claude CLIs of two linked `dev:test` profiles run on fixture accounts
 * against it, the leaf's Pi main coordinator is scripted by it, and both
 * backends read Claude plan usage from it
 * (`ORKESTRATOR_AGENT_TEST_USAGE_ORIGIN`). Nothing logs in and nothing is
 * billed. Run with Bun (specs run under Node): `bun coordinator-notice-fake-model.ts`.
 * It prints its origin (`http://127.0.0.1:<port>`) as the first stdout line.
 *
 * - `POST /v1/messages` (and `count_tokens`): Anthropic Messages for Claude.
 * - `POST /pi/v1/chat/completions`, `GET /pi/v1/models`: the leaf's Pi.
 * - `GET /api/oauth/usage`: Claude plan usage per fixture token.
 *
 * What it answers is `coordinator-notice-fake-model-script.ts`.
 *
 * Control routes, loopback only:
 * - `GET /__calls`: counts and facts (accounts, markers, refusals, the facts
 *   of each usage-limit notice a coordinator was woken with). No prompt,
 *   header, token or body is kept.
 * - `POST /__hold`: from now on, park refused calls instead of answering.
 * - `POST /__release`: answer every parked call (refused) and stop parking.
 *   A scenario holds so every session's stop lands in one coalescing window.
 */
import {
  accountOfToken,
  claudeLastUserText,
  claudeUsage,
  claudeUserTexts,
  isLimited,
  markerOf,
  noticeFacts,
  piTurn,
  type FixtureAccount,
  type NoticeFacts,
  type PiStep,
  type SessionKind,
} from "./coordinator-notice-fake-model-script";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_TRACKED = 2_000;
const MODEL = "claude-sonnet-4-6";
const PI_MODEL = "notice-qa-1";
const REPLY = "Noted.";

type Account = FixtureAccount | "unknown";
interface ClaudeCall {
  account: Account;
  marker?: { kind: SessionKind; run: string };
  refused: boolean;
  parked: boolean;
}
interface Wake {
  /** Which platform's coordinator was woken: the command node's Claude or the leaf's Pi. */
  by: "claude" | "pi";
  account?: Account;
  notices: NoticeFacts[];
}

const state = {
  claude: [] as ClaudeCall[],
  wakes: [] as Wake[],
  piCompletions: 0,
  piToolCalls: {} as Record<string, number>,
  usageReads: {} as Record<string, number>,
  refused: 0,
  hold: false,
};
const seenWakes = new Set<string>();
const parked: Array<() => void> = [];

function track<T>(list: T[], item: T): void {
  if (list.length < MAX_TRACKED) list.push(item);
}

function sse(events: Array<{ type: string } & Record<string, unknown>>): Response {
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
  );
}

let sequence = 0;

function claudeReply(stream: boolean): Response {
  const id = `msg_notice_${++sequence}`;
  const usage = { input_tokens: 1, output_tokens: 1 };
  if (!stream) {
    return Response.json({
      id,
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text: REPLY }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    });
  }
  return sse([
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

/** The refusal the Anthropic API sends for a plan limit; the CLI words the user-facing text. */
function claudeRefusal(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "Plan limit reached." },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(Math.floor((Date.now() + 86_400_000) / 1000)),
        "anthropic-ratelimit-unified-representative-claim": "seven_day",
      },
    },
  );
}

/** Counts a coordinator wake once, by a hash of the prompt kept only in memory. */
function noteWake(by: Wake["by"], prompt: string, notices: NoticeFacts[], account?: Account): void {
  if (notices.length === 0) return;
  const key = `${by}\0${Bun.hash(prompt)}`;
  if (seenWakes.has(key)) return;
  seenWakes.add(key);
  track(state.wakes, { by, ...(account ? { account } : {}), notices });
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_REQUEST_BYTES) return null;
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function claudeMessages(request: Request): Promise<Response> {
  const body = await readBody(request);
  if (!body) {
    state.refused += 1;
    return new Response("bad request", { status: 400 });
  }
  const account: Account = accountOfToken(request.headers.get("authorization")) ?? "unknown";
  const marker = markerOf(claudeUserTexts(body));
  const refuse = marker !== null && isLimited(account === "unknown" ? undefined : account);
  const stream = body.stream === true;
  const prompt = claudeLastUserText(body);
  noteWake("claude", prompt, noticeFacts(prompt), account);
  const call: ClaudeCall = {
    account,
    ...(marker ? { marker } : {}),
    refused: refuse,
    parked: refuse && state.hold,
  };
  track(state.claude, call);
  if (!refuse) return claudeReply(stream);
  if (call.parked) {
    await new Promise<void>((resolve) => parked.push(resolve));
  }
  return claudeRefusal();
}

function piChunk(id: string, delta: Record<string, unknown>, finish: string | null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: PI_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } } : {}),
  })}\n\n`;
}

function piAnswer(step: PiStep, stream: boolean): Response {
  const id = `notice-qa-${++sequence}`;
  const call =
    step.kind === "tool"
      ? {
          id: `call-${sequence}`,
          type: "function",
          function: { name: step.name, arguments: JSON.stringify(step.input) },
        }
      : undefined;
  const text = step.kind === "text" ? step.text : "";
  if (!stream) {
    return Response.json({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: PI_MODEL,
      choices: [
        {
          index: 0,
          message: call
            ? { role: "assistant", content: null, tool_calls: [call] }
            : { role: "assistant", content: text },
          finish_reason: call ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  }
  const frames = call
    ? piChunk(id, { role: "assistant", tool_calls: [{ index: 0, ...call }] }, null) +
      piChunk(id, {}, "tool_calls")
    : piChunk(id, { role: "assistant", content: text }, null) + piChunk(id, {}, "stop");
  return new Response(`${frames}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

async function piCompletions(request: Request): Promise<Response> {
  const body = await readBody(request);
  if (!body) {
    state.refused += 1;
    return new Response("bad request", { status: 400 });
  }
  const turn = piTurn({ messages: body.messages, tools: body.tools });
  state.piCompletions += 1;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  noteWake("pi", JSON.stringify(messages.at(-1) ?? null), turn.notices);
  if (turn.step.kind === "tool") {
    state.piToolCalls[turn.step.name] = (state.piToolCalls[turn.step.name] ?? 0) + 1;
  }
  return piAnswer(turn.step, body.stream === true);
}

function usage(request: Request): Response {
  const account = accountOfToken(request.headers.get("authorization"));
  if (!account) {
    state.refused += 1;
    return Response.json({ error: "unknown token" }, { status: 401 });
  }
  state.usageReads[account] = (state.usageReads[account] ?? 0) + 1;
  return Response.json(claudeUsage(account, Date.now()));
}

function release(): void {
  state.hold = false;
  for (const resolve of parked.splice(0)) resolve();
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /__calls") {
      return Response.json({ ...state, parked: parked.length });
    }
    if (route === "POST /__hold") {
      state.hold = true;
      return Response.json({ hold: true });
    }
    if (route === "POST /__release") {
      release();
      return Response.json({ hold: false });
    }
    if (route === "GET /api/oauth/usage") return usage(request);
    if (route === "GET /pi/v1/models") {
      return Response.json({ object: "list", data: [{ id: PI_MODEL, object: "model" }] });
    }
    if (route === "POST /pi/v1/chat/completions") return piCompletions(request);
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      return claudeMessages(request);
    }
    if (request.method === "POST" && url.pathname.startsWith("/v1/messages/count_tokens")) {
      return Response.json({ input_tokens: 1 });
    }
    // The CLI's other reads (a model list, a profile) get an empty answer.
    if (request.method === "GET" && url.pathname.startsWith("/v1/")) {
      return Response.json({ data: [], has_more: false });
    }
    state.refused += 1;
    return new Response("not served", { status: 404 });
  },
});

process.once("SIGTERM", () => {
  release();
  server.stop(true);
  process.exit(0);
});

console.log(`http://127.0.0.1:${server.port}`);
