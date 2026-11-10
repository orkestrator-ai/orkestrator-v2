/**
 * A loopback model for `auto-pipeline-live.spec.ts` (to-do 7547 task 4), so
 * the profile's real Pi bridge and Pi SDK sessions run every turn of the
 * Auto-pipeline flow with no login and nothing billed. Run with Bun (specs run
 * under Node): `bun auto-pipeline-fake-model.ts`. It prints its origin
 * (`http://127.0.0.1:<port>`) as the first stdout line.
 *
 * It serves OpenAI chat completions (`POST …/chat/completions`), which Pi uses
 * for a provider declared with `api: "openai-completions"` in its
 * `models.json`. What it answers is `auto-pipeline-fake-model-script.ts`.
 *
 * Control routes, loopback only:
 * - `GET /__calls`: counts only (completions, refusals, submissions by tool,
 *   tools currently held). No prompt, header, body or capability is kept.
 * - `POST /__release?tool=<name>`: answers every request parked on that
 *   submission tool, and every later one at once.
 *
 * `AUTO_PIPELINE_FAKE_HOLD` (comma list of submission tool names) parks the
 * turn that would submit one of them until it is released, so a spec can do
 * something at a known point (switch environments, change the ticket's
 * delivery policy) before the pipeline moves on.
 */
import { FAKE_REPLY, scriptedTurn, type FakeStep } from "./auto-pipeline-fake-model-script";

export const FAKE_MODEL_ID = "autopipe-1";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_TRACKED = 1_000;

const held = new Set(
  (process.env.AUTO_PIPELINE_FAKE_HOLD ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => /^submit_[a-z_]+$/.test(tool)),
);
const released = new Set<string>();
const parked = new Map<string, Set<() => void>>();
const counts = { completions: 0, refused: 0 };
const submissions: Record<string, number> = {};

function waitFor(tool: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!held.has(tool) || released.has(tool)) return resolve();
    const waiters = parked.get(tool) ?? new Set<() => void>();
    parked.set(tool, waiters);
    const done = () => {
      waiters.delete(done);
      if (waiters.size === 0) parked.delete(tool);
      signal.removeEventListener("abort", done);
      resolve();
    };
    waiters.add(done);
    signal.addEventListener("abort", done, { once: true });
  });
}

function release(tool: string): void {
  released.add(tool);
  for (const resolve of Array.from(parked.get(tool) ?? [])) resolve();
  parked.delete(tool);
}

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
  const id = `autopipe-${++sequence}`;
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

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // A held request writes nothing until it is released.
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/__calls") {
      return Response.json({
        ...counts,
        submissions: { ...submissions },
        held: [...parked.keys()],
      });
    }
    if (request.method === "POST" && url.pathname === "/__release") {
      const tool = url.searchParams.get("tool") ?? "";
      if (!/^submit_[a-z_]+$/.test(tool)) return new Response("bad tool", { status: 400 });
      release(tool);
      return Response.json({ released: tool });
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
    if (turn.submits && turn.workflow) {
      await waitFor(turn.workflow, request.signal);
      if (Object.keys(submissions).length < MAX_TRACKED || turn.workflow in submissions)
        submissions[turn.workflow] = (submissions[turn.workflow] ?? 0) + 1;
    }
    return answer(turn.step, body.stream === true);
  },
});

console.log(`http://127.0.0.1:${server.port}`);
