import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { TransformStream } from "node:stream/web";

// hono's `streamSSE` constructs a `TransformStream` and immediately calls
// `writable.getWriter()`. Bun's test runtime *does* expose a `TransformStream`
// global, but its `writable` has no `getWriter`, so hono throws and the route
// 500s. The node:stream/web implementation works, so install it unconditionally
// — same as codex-bridge/src/index-abort.test.ts.
//
// This must not be guarded by `if (!globalThis.TransformStream)`: that guard
// never fires, so the test only passed when another file (codex-bridge's) had
// already replaced the global in a shared process. Under `bun test --parallel`
// (which implies --isolate) that leakage is gone and the test fails on its own.
globalThis.TransformStream = TransformStream as typeof globalThis.TransformStream;

import events from "./events.js";
import { eventEmitter } from "../services/event-emitter.js";

const app = new Hono();
app.route("/", events);

const decoder = new TextDecoder();

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 2000
): Promise<string> {
  const startedAt = Date.now();
  let buffer = "";
  while (Date.now() - startedAt < timeoutMs) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    if (predicate(buffer)) return buffer;
  }
  throw new Error(`Timed out waiting for SSE chunk. Buffer so far: ${buffer}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("GET /subscribe (SSE)", () => {
  // Hono's `app.request({ signal })` doesn't reliably propagate the abort to
  // `c.req.raw.signal`, which makes per-test cleanup of the SSE handler racy.
  // We exercise the full happy path in one test that holds a single connection.
  test("opens with a connected event and forwards emitted events to the stream", async () => {
    const controller = new AbortController();
    const res = await app.request("/subscribe", { signal: controller.signal });

    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    try {
      const initial = await readUntil(reader!, (b) => b.includes("event: connected"));
      expect(initial).toContain("event: connected");
      expect(initial).toContain('"status":"connected"');

      // After we read "connected", the server's `await stream.writeSSE(...)`
      // resolves and the next line — `eventEmitter.subscribe(...)` — runs.
      // Wait for that subscribe to register before emitting, otherwise the
      // event is broadcast to zero subscribers and we hang forever.
      await waitFor(() => eventEmitter.subscriberCount > 0);

      eventEmitter.emit({
        type: "session.updated",
        sessionId: "s-events-test",
        data: { status: "running" },
      });

      const forwarded = await readUntil(reader!, (b) =>
        b.includes("event: session.updated")
      );
      expect(forwarded).toContain('"sessionId":"s-events-test"');
      expect(forwarded).toContain('"status":"running"');
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
    }
  });
});
