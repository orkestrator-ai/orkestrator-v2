/**
 * A loopback model for `federation-two-profile.spec.ts`, so the leaf
 * profile's real Pi bridge runs a native turn with no login and nothing
 * billed. Run with Bun (specs run under Node):
 * `bun federation-two-profile-fake-model.ts`. It prints its origin
 * (`http://127.0.0.1:<port>`) as the first stdout line.
 *
 * It serves OpenAI chat completions (`POST …/chat/completions`), which Pi uses
 * for a provider declared with `api: "openai-completions"` in its
 * `models.json`, and answers every request with one short text reply. A
 * request whose latest user message carries `HOLD_MARKER` is parked until the
 * next `POST /__release`, which keeps the leaf's turn (and so its activity)
 * at "working" for exactly as long as the spec wants. A release frees only
 * what is parked at that moment; the next held request parks again.
 *
 * `GET /__calls` answers counts only. No prompt, header or body is kept.
 */
import { piCompletionChunk } from "../../scripts/pi-fake-model-shared";
import { FAKE_MODEL_ID, shouldHold } from "./federation-two-profile-support";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const REPLY = "Done.";

const counts = { completions: 0, refused: 0, heldTotal: 0, releases: 0 };
const parked = new Set<() => void>();
let sequence = 0;

function releaseParked(): number {
  const waiting = Array.from(parked);
  for (const resolve of waiting) resolve();
  counts.releases += 1;
  return waiting.length;
}

function waitForRelease(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      parked.delete(done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    parked.add(done);
    signal.addEventListener("abort", done, { once: true });
  });
}

function answer(stream: boolean): Response {
  const id = `federation-${++sequence}`;
  const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
  if (!stream) {
    return Response.json({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: FAKE_MODEL_ID,
      choices: [
        { index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" },
      ],
      usage,
    });
  }
  const body =
    piCompletionChunk(FAKE_MODEL_ID, id, { role: "assistant", content: REPLY }, null) +
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
      return Response.json({ ...counts, held: parked.size });
    }
    if (request.method === "POST" && url.pathname === "/__release") {
      return Response.json({ released: releaseParked() });
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
    let body: { stream?: unknown; messages?: unknown };
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
    return answer(body.stream === true);
  },
});

console.log(`http://127.0.0.1:${server.port}`);
