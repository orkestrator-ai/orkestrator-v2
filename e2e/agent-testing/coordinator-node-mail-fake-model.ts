/**
 * A loopback model for `coordinator-node-mail-fake.spec.ts` (to-do 2900), so
 * the Pi main coordinators of two `dev:test` profiles, one attached to the
 * other as its leaf, mail each other with no login and nothing billed. Run
 * with Bun (specs run under Node): `bun coordinator-node-mail-fake-model.ts`.
 * It prints its origin (`http://127.0.0.1:<port>`) as the first stdout line.
 *
 * It serves OpenAI chat completions under two base paths, one per profile:
 * `/desk/v1/chat/completions` for the command node and
 * `/leaf/v1/chat/completions` for the leaf. What it answers is
 * `coordinator-node-mail-fake-model-script.ts`.
 *
 * Control route, loopback only: `GET /__calls` answers counts and facts per
 * node (completions, refusals, tool calls by name, and the facts counted
 * about each wake). No prompt, header, body or argument is kept.
 */
import {
  FAKE_REPLY,
  scriptedTurn,
  type CarrierFacts,
  type FakeNode,
  type FakeStep,
} from "./coordinator-node-mail-fake-model-script";

export const FAKE_MODEL_ID = "node-mail-1";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_TRACKED = 1_000;

type NodeCalls = {
  completions: number;
  toolCalls: Record<string, number>;
  wakes: CarrierFacts[][];
};
const calls: Record<FakeNode, NodeCalls> = {
  desk: { completions: 0, toolCalls: {}, wakes: [] },
  leaf: { completions: 0, toolCalls: {}, wakes: [] },
};
let refused = 0;

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

function answer(step: FakeStep, stream: boolean): Response {
  const id = `node-mail-${++sequence}`;
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

/** The node a request came from, by the base path its profile was given. */
function nodeOf(pathname: string): FakeNode | undefined {
  if (pathname.startsWith("/desk/")) return "desk";
  if (pathname.startsWith("/leaf/")) return "leaf";
  return undefined;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/__calls") {
      return Response.json({ refused, desk: calls.desk, leaf: calls.leaf });
    }
    const node = nodeOf(url.pathname);
    if (node && request.method === "GET" && url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: FAKE_MODEL_ID, object: "model" }] });
    }
    if (!node || request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      refused += 1;
      return new Response("not served", { status: 404 });
    }
    if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) {
      refused += 1;
      return new Response("too large", { status: 413 });
    }
    let body: { stream?: unknown; messages?: unknown; tools?: unknown };
    try {
      const text = await request.text();
      if (text.length > MAX_REQUEST_BYTES) throw new Error("too large");
      body = JSON.parse(text) as typeof body;
    } catch {
      refused += 1;
      return new Response("bad request", { status: 400 });
    }
    const counts = calls[node];
    counts.completions += 1;
    const turn = scriptedTurn(node, { messages: body.messages, tools: body.tools });
    if (turn.wake && counts.wakes.length < MAX_TRACKED) counts.wakes.push(turn.wake);
    if (turn.step.kind === "tool") {
      const name = turn.step.name;
      if (Object.keys(counts.toolCalls).length < MAX_TRACKED || name in counts.toolCalls)
        counts.toolCalls[name] = (counts.toolCalls[name] ?? 0) + 1;
    }
    return answer(turn.step, body.stream === true);
  },
});

console.log(`http://127.0.0.1:${server.port}`);
