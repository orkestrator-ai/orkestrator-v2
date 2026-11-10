/**
 * A loopback model for `coordinator-slow-remote-live.spec.ts` (to-do 4720), so
 * the profile's real Pi bridge runs the main coordinators' turns with no login
 * and nothing billed. Run with Bun (specs run under Node):
 * `bun coordinator-slow-remote-fake-model.ts`. It prints its origin
 * (`http://127.0.0.1:<port>`) as the first stdout line.
 *
 * It serves OpenAI chat completions (`POST …/chat/completions`), which Pi uses
 * for a provider declared with `api: "openai-completions"` in its
 * `models.json`. What it answers is `scriptedStep`: a worker prompt carrying a
 * mail marker sends that one mail through Orkestrator's `send_message` tool,
 * and every other request gets one short text reply. A request whose latest
 * user message carries `HOLD_MARKER` is parked until `POST /__release`, which
 * keeps that coordinator's turn running for as long as the spec needs.
 *
 * `GET /__calls` answers counts only (completions, held, refused, mail tool
 * calls). No prompt, header or body is kept.
 */
import { piCompletionChunk } from "../../scripts/pi-fake-model-shared";
import {
  FAKE_MODEL_ID,
  scriptedStep,
  shouldHold,
  type FakeStep,
} from "./coordinator-slow-remote-support";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

const counts = { completions: 0, refused: 0, heldTotal: 0, mailCalls: 0 };
const parked = new Set<() => void>();
let released = false;
let sequence = 0;

function releaseAll(): void {
  released = true;
  for (const resolve of Array.from(parked)) resolve();
}

function waitForRelease(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (released) return resolve();
    const done = () => {
      parked.delete(done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    parked.add(done);
    signal.addEventListener("abort", done, { once: true });
  });
}

function answer(step: FakeStep, stream: boolean): Response {
  const id = `slow-remote-${++sequence}`;
  const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
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
    ? piCompletionChunk(
        FAKE_MODEL_ID,
        id,
        { role: "assistant", tool_calls: [{ index: 0, ...call }] },
        null,
      ) + piCompletionChunk(FAKE_MODEL_ID, id, {}, "tool_calls", usage)
    : piCompletionChunk(FAKE_MODEL_ID, id, { role: "assistant", content: text }, null) +
      piCompletionChunk(FAKE_MODEL_ID, id, {}, "stop", usage);
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
      return Response.json({ ...counts, held: parked.size, released });
    }
    if (request.method === "POST" && url.pathname === "/__release") {
      releaseAll();
      return Response.json({ released: true });
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
    if (shouldHold(body.messages)) {
      counts.heldTotal += 1;
      await waitForRelease(request.signal);
    }
    const step = scriptedStep({ messages: body.messages, tools: body.tools });
    if (step.kind === "tool") counts.mailCalls += 1;
    return answer(step, body.stream === true);
  },
});

console.log(`http://127.0.0.1:${server.port}`);
