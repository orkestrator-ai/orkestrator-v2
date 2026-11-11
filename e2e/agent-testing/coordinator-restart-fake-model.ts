/**
 * A loopback model for `coordinator-restart-fake.spec.ts` (to-do 4680 (retired) task
 * 2), so a Pi coordinator and the builds it starts run on the profiles' real
 * Pi bridges and SDK with no login and nothing billed. Run with Bun (specs run
 * under Node): `bun coordinator-restart-fake-model.ts`. It prints its origin
 * (`http://127.0.0.1:<port>`) as the first stdout line.
 *
 * It serves OpenAI chat completions (`POST <base>/chat/completions`) under two
 * bases, `/desk/v1` for the command node's profile and `/leaf/v1` for the
 * leaf's, so each node's calls are counted apart. What it answers is
 * `coordinator-restart-fake-model-script.ts`; a build worker always gets the
 * script's usage-limit refusal (HTTP 429).
 *
 * Control route, loopback only: `GET /__calls` answers counts only
 * (completions, refusals, tool calls by name, usage-limit refusals by node,
 * the facts counted about each wake and each restart answer). No prompt,
 * header, body or argument is kept.
 */
import {
  FAKE_REPLY,
  scriptedTurn,
  usageLimitRefusal,
  type FakeStep,
  type RestartFacts,
  type WakeFacts,
} from "./coordinator-restart-fake-model-script";

export const FAKE_MODEL_ID = "restart-1";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_TRACKED = 1_000;
const NODES = ["desk", "leaf"] as const;
type NodeName = (typeof NODES)[number];

interface NodeCounts {
  completions: number;
  usageLimited: number;
  toolCalls: Record<string, number>;
  wakes: WakeFacts[];
  restarts: RestartFacts[];
}

const fresh = (): NodeCounts => ({
  completions: 0,
  usageLimited: 0,
  toolCalls: {},
  wakes: [],
  restarts: [],
});
const counts: Record<NodeName, NodeCounts> = { desk: fresh(), leaf: fresh() };
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

function answer(step: Exclude<FakeStep, { kind: "usage-limit" }>, stream: boolean): Response {
  const id = `restart-${++sequence}`;
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

function nodeOf(pathname: string): NodeName | undefined {
  const first = pathname.split("/")[1];
  return NODES.find((name) => name === first);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/__calls") {
      return Response.json({ refused, desk: counts.desk, leaf: counts.leaf });
    }
    const node = nodeOf(url.pathname);
    if (request.method === "GET" && node && url.pathname.endsWith("/models")) {
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
    const tally = counts[node];
    tally.completions += 1;
    const turn = scriptedTurn({ messages: body.messages, tools: body.tools });
    if (turn.wake && tally.wakes.length < MAX_TRACKED) tally.wakes.push(turn.wake);
    if (turn.restart && tally.restarts.length < MAX_TRACKED) tally.restarts.push(turn.restart);
    if (turn.step.kind === "usage-limit") {
      tally.usageLimited += 1;
      const refusal = usageLimitRefusal();
      return Response.json(refusal.body, { status: refusal.status });
    }
    if (turn.step.kind === "tool") {
      const name = turn.step.name;
      if (Object.keys(tally.toolCalls).length < MAX_TRACKED || name in tally.toolCalls)
        tally.toolCalls[name] = (tally.toolCalls[name] ?? 0) + 1;
    }
    return answer(turn.step, body.stream === true);
  },
});

console.log(`http://127.0.0.1:${server.port}`);
