/**
 * A loopback model for `coordinator-routing-fake.spec.ts` (to-do 7545 task
 * 4), so a Pi coordinator and the build it starts run on the profile's real
 * Pi bridge and SDK with no login and nothing billed. Run with Bun (specs run
 * under Node): `bun coordinator-routing-fake-model.ts`. It prints its origin
 * (`http://127.0.0.1:<port>`) as the first stdout line.
 *
 * It serves OpenAI chat completions (`POST …/chat/completions`). What it
 * answers is `coordinator-routing-fake-model-script.ts`.
 *
 * Control route, loopback only: `GET /__calls` answers counts only
 * (completions, refusals, tool calls by name, parked worker requests, and the
 * facts counted about each wake). No prompt, header, body or argument is kept.
 */
import {
  FAKE_REPLY,
  scriptedTurn,
  type FakeStep,
  type WakeFacts,
} from "./coordinator-routing-fake-model-script";

export const FAKE_MODEL_ID = "routing-1";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_TRACKED = 1_000;

const counts = { completions: 0, refused: 0, parked: 0, released: 0 };
const toolCalls: Record<string, number> = {};
const wakes: WakeFacts[] = [];

function chunk(id: string, delta: Record<string, unknown>, finish: string | null, usage?: object) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: FAKE_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

let sequence = 0;

function answer(step: Exclude<FakeStep, { kind: "park" }>, stream: boolean): Response {
  const id = `routing-${++sequence}`;
  const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
  const call =
    step.kind === "tool"
      ? {
          id: `call-${sequence}`,
          type: "function",
          function: { name: step.name, arguments: JSON.stringify(step.input) },
        }
      : undefined;
  const text = step.kind === "text" ? step.text : FAKE_REPLY;
  if (!stream) {
    return Response.json({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: FAKE_MODEL_ID,
      choices: [
        {
          index: 0,
          message: call
            ? { role: "assistant", content: null, tool_calls: [call] }
            : { role: "assistant", content: text },
          finish_reason: call ? "tool_calls" : "stop",
        },
      ],
      usage,
    });
  }
  const body = call
    ? chunk(id, { role: "assistant", tool_calls: [{ index: 0, ...call }] }, null) +
      chunk(id, {}, "tool_calls", usage)
    : chunk(id, { role: "assistant", content: text }, null) + chunk(id, {}, "stop", usage);
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

/** Held until the client gives up on the request (the build's turn is aborted). */
function parked(signal: AbortSignal): Promise<Response> {
  counts.parked += 1;
  return new Promise((resolve) => {
    const done = () => {
      counts.released += 1;
      resolve(new Response("aborted", { status: 499 }));
    };
    if (signal.aborted) return done();
    signal.addEventListener("abort", done, { once: true });
  });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // A parked request writes nothing until it is aborted.
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/__calls") {
      return Response.json({ ...counts, toolCalls: { ...toolCalls }, wakes: [...wakes] });
    }
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: FAKE_MODEL_ID, object: "model" }] });
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      counts.refused += 1;
      return new Response("not served", { status: 404 });
    }
    if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) {
      counts.refused += 1;
      return new Response("too large", { status: 413 });
    }
    let body: { stream?: unknown; messages?: unknown; tools?: unknown };
    try {
      const text = await request.text();
      if (text.length > MAX_REQUEST_BYTES) throw new Error("too large");
      body = JSON.parse(text) as typeof body;
    } catch {
      counts.refused += 1;
      return new Response("bad request", { status: 400 });
    }
    counts.completions += 1;
    const turn = scriptedTurn({ messages: body.messages, tools: body.tools });
    if (turn.wake && wakes.length < MAX_TRACKED) wakes.push(turn.wake);
    if (turn.step.kind === "park") return parked(request.signal);
    if (turn.step.kind === "tool") {
      const name = turn.step.name;
      if (Object.keys(toolCalls).length < MAX_TRACKED || name in toolCalls)
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
    }
    return answer(turn.step, body.stream === true);
  },
});

console.log(`http://127.0.0.1:${server.port}`);
