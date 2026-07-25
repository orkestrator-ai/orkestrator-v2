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
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for SSE chunk. Buffer so far: ${buffer}`)),
          remainingMs,
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
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
  test("the test reader times out when an SSE stream stalls", async () => {
    const reader = new ReadableStream<Uint8Array>().getReader();
    try {
      await expect(readUntil(reader, () => false, 10)).rejects.toThrow(
        "Timed out waiting for SSE chunk",
      );
    } finally {
      await reader.cancel();
    }
  });

  test("opens with a connected event and forwards emitted events to the stream", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
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
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    }
  });

  test("broadcasts to multiple clients and removes both subscribers on abort", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstResponse = await app.request("/subscribe", {
      signal: firstController.signal,
    });
    const secondResponse = await app.request("/subscribe", {
      signal: secondController.signal,
    });
    const firstReader = firstResponse.body?.getReader();
    const secondReader = secondResponse.body?.getReader();
    expect(firstReader).toBeDefined();
    expect(secondReader).toBeDefined();

    try {
      await Promise.all([
        readUntil(firstReader!, (buffer) => buffer.includes("event: connected")),
        readUntil(secondReader!, (buffer) => buffer.includes("event: connected")),
      ]);
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore + 2);

      eventEmitter.emit({
        type: "message.updated",
        sessionId: "shared-session",
        data: { message: { id: "message-1" } },
      });

      const [firstEvent, secondEvent] = await Promise.all([
        readUntil(firstReader!, (buffer) => buffer.includes("event: message.updated")),
        readUntil(secondReader!, (buffer) => buffer.includes("event: message.updated")),
      ]);
      expect(firstEvent).toContain('"sessionId":"shared-session"');
      expect(secondEvent).toContain('"sessionId":"shared-session"');
    } finally {
      firstController.abort();
      secondController.abort();
      await Promise.all([
        firstReader?.cancel().catch(() => {}),
        secondReader?.cancel().catch(() => {}),
      ]);
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    }
  });
});
