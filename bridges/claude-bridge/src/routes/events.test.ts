import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { SSEStreamingApi } from "hono/streaming";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { TransformStream, type ReadableStreamDefaultReader } from "node:stream/web";

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

import events, {
  createBoundedSseWriter,
  createEventsRouter,
  createSseConnectionClosure,
  parseEventCursor,
} from "./events.js";
import { eventEmitter } from "../services/event-emitter.js";

const app = new Hono();
app.route("/", events);

const decoder = new TextDecoder();

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 2000,
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

  test("accounts backlog in encoded bytes, not UTF-16 code units", async () => {
    const { write, overflowReasons, releaseFirst } = stallingWriter({
      maxPendingBytes: 8,
    });

    // "1234" is 4 bytes pending; "ééé" is 3 code units but 6 UTF-8 bytes, so
    // the true backlog is 10 bytes. Counting `.length` (7) would let a stalled
    // consumer keep queueing multi-byte transcripts past the cap.
    const first = write({ event: "a", data: "1234" });
    await write({ event: "a", data: "ééé" });

    expect(overflowReasons).toHaveLength(1);
    releaseFirst();
    await first;
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

describe("createSseConnectionClosure", () => {
  test("many settled writes leave no waiter behind", async () => {
    // A per-frame race against a connection-lifetime promise kept one reaction
    // per frame until the connection closed. Each write's waiter goes when the
    // write settles, so a long-lived stream holds none between writes.
    const closure = createSseConnectionClosure();
    for (let index = 0; index < 1_000; index += 1) {
      await closure.race(Promise.resolve());
      expect(closure.pendingWaiters).toBe(0);
    }
    await expect(closure.race(Promise.reject(new Error("write failed")))).rejects.toThrow(
      "write failed",
    );
    expect(closure.pendingWaiters).toBe(0);
    closure.close();
  });

  test("a write that never settles is released by the close", async () => {
    const closure = createSseConnectionClosure();
    const stalled = Promise.withResolvers<void>();
    let released = false;
    const racing = closure.race(stalled.promise).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(closure.pendingWaiters).toBe(1);
    expect(released).toBe(false);

    closure.close();
    await racing;
    expect(released).toBe(true);
    expect(closure.pendingWaiters).toBe(0);
    expect(closure.isClosed).toBe(true);
    await closure.closed;
    // A late rejection of the abandoned write is not unhandled, and a write
    // after the close neither waits nor registers.
    stalled.reject(new Error("late"));
    await closure.race(new Promise(() => undefined));
    expect(closure.pendingWaiters).toBe(0);
  });
});

describe("parseEventCursor", () => {
  test("parses only bounded generation-aware cursors", () => {
    expect(parseEventCursor(`${eventEmitter.generation}:42`)).toEqual({
      generation: eventEmitter.generation,
      revision: 42,
    });
    expect(parseEventCursor("42")).toBeNull();
    expect(parseEventCursor("generation:-1")).toBeNull();
    expect(parseEventCursor("generation:9007199254740992")).toBeNull();
    expect(parseEventCursor("bad/generation:1")).toBeNull();
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

  test("refuses a subscription that does not ask for observation mode", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
    const response = await app.request("/subscribe");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "observe=1 is required: this bridge serves only the observation stream",
    });
    expect(eventEmitter.subscriberCount).toBe(subscribersBefore);
  });

  test("opens with a connected event and forwards content-free frames", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
    const controller = new AbortController();
    const res = await app.request("/subscribe?observe=1", { signal: controller.signal });

    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    try {
      const initial = await readUntil(reader!, (b) => b.includes("event: connected"));
      expect(initial).toContain('"status":"connected"');
      expect(initial).toContain('"observe":true');
      expect(initial).toContain('"resetRequired":false');
      expect(initial).toContain(`id: ${eventEmitter.currentCursor}`);
      expect(initial).not.toContain("event: replay.required");

      await waitFor(() => eventEmitter.subscriberCount > subscribersBefore);
      eventEmitter.emit({
        type: "session.updated",
        sessionId: "observed-live",
        data: { backgroundTasks: { t: { id: "t", outputTail: "private output" } } },
      });

      const live = await readUntil(reader!, (b) => b.includes("observed-live"));
      expect(live).toContain("event: session.updated");
      expect(live).toContain(`id: ${eventEmitter.currentCursor}`);
      expect(live).toContain('data: {"sessionId":"observed-live"}');
      expect(live).not.toContain("private output");
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
    const firstResponse = await app.request("/subscribe?observe=1", {
      signal: firstController.signal,
    });
    const secondResponse = await app.request("/subscribe?observe=1", {
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
        data: { message: { id: "message-1", text: "secret transcript text" } },
      });

      const [firstEvent, secondEvent] = await Promise.all([
        readUntil(firstReader!, (buffer) => buffer.includes("event: message.updated")),
        readUntil(secondReader!, (buffer) => buffer.includes("event: message.updated")),
      ]);
      for (const frames of [firstEvent, secondEvent]) {
        expect(frames).toContain('data: {"sessionId":"shared-session"}');
        expect(frames).not.toContain("secret transcript text");
      }
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

  test("a current cursor resumes without a reset and is echoed back", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
    eventEmitter.emit({ type: "session.idle", sessionId: "before-current-cursor" });
    const cursor = eventEmitter.currentCursor;
    const controller = new AbortController();
    const response = await app.request(`/subscribe?observe=1&since=${encodeURIComponent(cursor)}`, {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    try {
      const frames = await readUntil(reader!, (buffer) => buffer.includes("event: connected"));
      expect(frames).toContain(`id: ${cursor}`);
      expect(frames).toContain('"resetRequired":false');
      expect(frames).not.toContain("event: replay.required");
      expect(frames).not.toContain("before-current-cursor");
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    }
  });

  test("a cursor behind the current revision requires a reset, echoing the cursor first", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
    const before = eventEmitter.currentRevision;
    eventEmitter.emit({
      type: "message.updated",
      sessionId: "missed-while-disconnected",
      data: { message: { id: "m-1", text: "secret transcript text" } },
    });
    const controller = new AbortController();
    const cursor = `${eventEmitter.generation}:${before}`;
    const response = await app.request(`/subscribe?observe=1&since=${encodeURIComponent(cursor)}`, {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    try {
      const frames = await readUntil(reader!, (buffer) =>
        buffer.includes("event: replay.required"),
      );
      // The connected frame keeps the client's own position; only the gap
      // frame moves it to the current revision.
      expect(frames.indexOf(`id: ${cursor}`)).toBeLessThan(frames.indexOf("replay.required"));
      expect(frames).toContain('"resetRequired":true');
      expect(frames).toContain(`"through":"${eventEmitter.currentCursor}"`);
      expect(frames).not.toContain("missed-while-disconnected");
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    }
  });

  test("prefers Last-Event-ID and requires reset for a stale generation", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
    const controller = new AbortController();
    const currentCursor = encodeURIComponent(eventEmitter.currentCursor);
    const response = await app.request(`/subscribe?observe=1&since=${currentCursor}`, {
      headers: { "Last-Event-ID": "stale-generation:7" },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    try {
      const frames = await readUntil(reader!, (buffer) =>
        buffer.includes("event: replay.required"),
      );
      expect(frames).toContain("id: stale-generation:7");
      expect(frames).toContain('"resetRequired":true');
      expect(frames).toContain(`"through":"${eventEmitter.currentCursor}"`);
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    }
  });

  test("requires reset for malformed and future cursors", async () => {
    for (const cursor of [
      "legacy-numeric-cursor",
      `${eventEmitter.generation}:${eventEmitter.currentRevision + 100}`,
    ]) {
      const subscribersBefore = eventEmitter.subscriberCount;
      const controller = new AbortController();
      const response = await app.request(
        `/subscribe?observe=1&since=${encodeURIComponent(cursor)}`,
        { signal: controller.signal },
      );
      const reader = response.body?.getReader();
      try {
        const frames = await readUntil(reader!, (buffer) =>
          buffer.includes("event: replay.required"),
        );
        expect(frames).toContain('"resetRequired":true');
      } finally {
        controller.abort();
        await reader?.cancel().catch(() => {});
        await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
      }
    }
  });

  test("delivers events emitted during the handshake once each, in revision order", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
    const before = eventEmitter.currentRevision;
    eventEmitter.emit({ type: "session.idle", sessionId: "before-handshake" });
    const controller = new AbortController();
    const response = await app.request(
      `/subscribe?observe=1&since=${encodeURIComponent(`${eventEmitter.generation}:${before}`)}`,
      { signal: controller.signal },
    );
    const reader = response.body?.getReader();

    try {
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore + 1);
      for (let index = 1; index <= 3; index += 1) {
        eventEmitter.emit({
          type: "session.idle",
          sessionId: `emitted-during-handshake-${index}`,
        });
      }
      const frames = await readUntil(reader!, (buffer) =>
        buffer.includes('"sessionId":"emitted-during-handshake-3"'),
      );
      for (let index = 1; index <= 3; index += 1) {
        expect(
          frames.match(new RegExp(`"sessionId":"emitted-during-handshake-${index}"`, "g")),
        ).toHaveLength(1);
      }
      const revisions = [
        ...frames.matchAll(new RegExp(`^id: ${eventEmitter.generation}:(\\d+)$`, "gm")),
      ].map((match) => Number(match[1]));
      // connected (the client's cursor), replay.required, then the three live frames.
      expect(revisions).toEqual([before, before + 1, before + 2, before + 3, before + 4]);
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    }
  });

  test("aborting without draining a handshake removes the subscriber", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
    const controller = new AbortController();
    const response = await app.request(
      `/subscribe?observe=1&since=${encodeURIComponent("stale-generation:1")}`,
      { signal: controller.signal },
    );

    await waitFor(() => eventEmitter.subscriberCount === subscribersBefore + 1);
    controller.abort();
    await response.body?.cancel().catch(() => {});
    await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
  });

  test("a rejected handshake write removes the subscriber", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
    const mutableEmitter = eventEmitter as unknown as { generation: string };
    const originalGeneration = mutableEmitter.generation;
    // Hono rejects an SSE id containing a newline before writing it. Changing
    // the otherwise opaque generation gives the real route a deterministic
    // handshake-write failure without replacing Hono internals.
    mutableEmitter.generation = "invalid\ngeneration";
    try {
      const response = await app.request("/subscribe?observe=1");
      await response.text();
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    } finally {
      mutableEmitter.generation = originalGeneration;
    }
  });

  test("route-level live backlog overflow closes and removes the subscriber", async () => {
    const boundedApp = new Hono();
    boundedApp.route("/", createEventsRouter({ maxPendingFrames: 1 }));
    const subscribersBefore = eventEmitter.subscriberCount;
    const response = await boundedApp.request("/subscribe?observe=1");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    try {
      await readUntil(reader!, (buffer) => buffer.includes("event: connected"));
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore + 1);

      eventEmitter.emit({ type: "session.updated", sessionId: "live-overflow-1" });
      eventEmitter.emit({ type: "session.updated", sessionId: "live-overflow-2" });

      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    } finally {
      await reader?.cancel().catch(() => {});
    }
  });

  test("route-level handshake backlog overflow closes and removes the subscriber", async () => {
    const boundedApp = new Hono();
    boundedApp.route("/", createEventsRouter({ maxPendingFrames: 1 }));
    const subscribersBefore = eventEmitter.subscriberCount;
    const response = await boundedApp.request("/subscribe?observe=1");

    await waitFor(() => eventEmitter.subscriberCount === subscribersBefore + 1);
    eventEmitter.emit({ type: "session.updated", sessionId: "handshake-overflow-1" });
    eventEmitter.emit({ type: "session.updated", sessionId: "handshake-overflow-2" });

    await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    await response.body?.cancel().catch(() => {});
  });

  test("route-level handshake byte overflow closes and removes the subscriber", async () => {
    const boundedApp = new Hono();
    boundedApp.route(
      "/",
      createEventsRouter({
        maxPendingFrames: 100,
        maxPendingBytes: 32,
      }),
    );
    const subscribersBefore = eventEmitter.subscriberCount;
    const response = await boundedApp.request("/subscribe?observe=1");

    await waitFor(() => eventEmitter.subscriberCount === subscribersBefore + 1);
    eventEmitter.emit({
      type: "message.updated",
      sessionId: "handshake-byte-overflow",
      data: { message: { content: "x".repeat(256) } },
    });

    await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    await response.body?.cancel().catch(() => {});
  });

  test("a rejected keepalive logs a warning and closes its connection", async () => {
    const keepaliveApp = new Hono();
    const intervalMs = 30_000;
    keepaliveApp.route("/", createEventsRouter({ keepaliveIntervalMs: intervalMs }));
    const subscribersBefore = eventEmitter.subscriberCount;
    const logs = captureLogs();
    const originalWrite = SSEStreamingApi.prototype.writeSSE;
    const writes = spyOn(SSEStreamingApi.prototype, "writeSSE").mockImplementation(function (
      this: SSEStreamingApi,
      message,
    ) {
      if (message.event === "keepalive")
        return Promise.reject(new Error("keepalive transport failed"));
      return originalWrite.call(this, message);
    });
    const intervals = spyOn(globalThis, "setInterval");
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await keepaliveApp.request("/subscribe?observe=1", {
        signal: controller.signal,
      });
      reader = response.body!.getReader();
      await readUntil(reader, (buffer) => buffer.includes("event: connected"));
      await waitFor(() => intervals.mock.calls.some((call) => call[1] === intervalMs));
      const keepalive = intervals.mock.calls.find((call) => call[1] === intervalMs)![0];
      (keepalive as () => void)();
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
      expect(
        logs.records().find((record) => record.event === "sse.keepalive-failed"),
      ).toMatchObject({
        area: "bridge.claude",
        level: "warn",
        fields: { error: { name: "Error", message: "keepalive transport failed" } },
      });
      expect(logs.records().find((record) => record.event === "sse.closed")).toMatchObject({
        fields: { reason: "keepalive failed" },
      });
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      writes.mockRestore();
      intervals.mockRestore();
      logs.restore();
    }
  });

  test("emits keepalives on the configured interval and cleans up on abort", async () => {
    const keepaliveApp = new Hono();
    keepaliveApp.route("/", createEventsRouter({ keepaliveIntervalMs: 5 }));
    const subscribersBefore = eventEmitter.subscriberCount;
    const controller = new AbortController();
    const response = await keepaliveApp.request("/subscribe?observe=1", {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    try {
      const frames = await readUntil(reader!, (buffer) => buffer.includes("event: keepalive"));
      expect(frames).toContain("event: connected");
      expect(frames).toContain("event: keepalive");
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    }
  });
});
