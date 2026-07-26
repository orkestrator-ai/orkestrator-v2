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

import events, { createBoundedSseWriter } from "./events.js";
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

describe("createBoundedSseWriter", () => {
  /** A writer whose first frame stalls until released, so a backlog can build. */
  function stallingWriter(limits?: { maxPendingFrames?: number; maxPendingBytes?: number }) {
    const written: string[] = [];
    const overflowReasons: number[] = [];
    let releaseFirst!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const write = createBoundedSseWriter(
      async (frame) => {
        if (written.length === 0) await firstWriteGate;
        written.push(frame.data);
      },
      () => overflowReasons.push(overflowReasons.length),
      limits,
    );
    return { write, written, overflowReasons, releaseFirst };
  }

  test("serializes concurrent writes into submission order", async () => {
    const written: string[] = [];
    const write = createBoundedSseWriter(
      async (frame) => {
        // A later frame resolving first would interleave bytes on the wire.
        await new Promise((resolve) => setTimeout(resolve, frame.data === "1" ? 15 : 0));
        written.push(frame.data);
      },
      () => undefined,
    );

    await Promise.all([
      write({ event: "a", data: "1" }),
      write({ event: "a", data: "2" }),
      write({ event: "a", data: "3" }),
    ]);

    expect(written).toEqual(["1", "2", "3"]);
  });

  test("closes the subscriber once the frame backlog exceeds its cap", async () => {
    const { write, written, overflowReasons, releaseFirst } = stallingWriter({
      maxPendingFrames: 3,
    });

    const attempts = [
      write({ event: "a", data: "1" }),
      write({ event: "a", data: "2" }),
      write({ event: "a", data: "3" }),
    ];
    await write({ event: "a", data: "4" });
    expect(overflowReasons).toHaveLength(1);

    // Every later frame is dropped too: the consumer has already proven it
    // cannot keep up, and re-queueing would recreate the unbounded retention.
    releaseFirst();
    await Promise.all(attempts);
    await write({ event: "a", data: "5" });
    expect(written).toEqual(["1", "2", "3"]);
    expect(overflowReasons).toHaveLength(1);
  });

  test("closes the subscriber once the byte backlog exceeds its cap", async () => {
    const { write, written, overflowReasons, releaseFirst } = stallingWriter({
      maxPendingBytes: 8,
    });

    const first = write({ event: "a", data: "12345" });
    await write({ event: "a", data: "678901" });

    expect(overflowReasons).toHaveLength(1);
    releaseFirst();
    await first;
    expect(written).toEqual(["12345"]);
  });

  test("accepts a single oversized frame when idle", async () => {
    const written: string[] = [];
    let overflowed = 0;
    const write = createBoundedSseWriter(
      async (frame) => {
        written.push(frame.data);
      },
      () => (overflowed += 1),
      { maxPendingBytes: 4 },
    );

    // Nothing is pending, so this cannot be a slow consumer — rejecting it
    // would wedge an otherwise healthy connection on its first big message.
    await write({ event: "a", data: "larger-than-the-byte-cap" });
    expect(written).toEqual(["larger-than-the-byte-cap"]);
    expect(overflowed).toBe(0);
  });

  test("releases backlog accounting so a drained connection keeps flowing", async () => {
    const written: string[] = [];
    let overflowed = 0;
    const write = createBoundedSseWriter(
      async (frame) => {
        written.push(frame.data);
      },
      () => (overflowed += 1),
      { maxPendingFrames: 2, maxPendingBytes: 4 },
    );

    // Each write drains before the next, so the caps are never approached even
    // though the total far exceeds them.
    for (let index = 0; index < 10; index += 1) {
      await write({ event: "a", data: `frame-${index}` });
    }

    expect(written).toHaveLength(10);
    expect(overflowed).toBe(0);
  });

  test("keeps later frames flowing after one write fails, and surfaces the failure", async () => {
    const written: string[] = [];
    const write = createBoundedSseWriter(
      async (frame) => {
        if (frame.data === "boom") throw new Error("write failed");
        written.push(frame.data);
      },
      () => undefined,
    );

    const failing = write({ event: "a", data: "boom" });
    const following = write({ event: "a", data: "after" });

    // The caller can still observe the original failure...
    await expect(failing).rejects.toThrow("write failed");
    // ...without it poisoning the chain for every later frame.
    await following;
    expect(written).toEqual(["after"]);
  });

  test("a failed write still releases its backlog slot", async () => {
    let overflowed = 0;
    const write = createBoundedSseWriter(
      async () => {
        throw new Error("always fails");
      },
      () => (overflowed += 1),
      { maxPendingFrames: 2 },
    );

    // Leaked accounting would trip the cap after two frames.
    for (let index = 0; index < 5; index += 1) {
      await write({ event: "a", data: `f${index}` }).catch(() => undefined);
    }
    expect(overflowed).toBe(0);
  });
});

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
