import { describe, expect, mock, test } from "bun:test";
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

import events, {
  createBoundedSseWriter,
  createEventsRouter,
  createReplayBuffer,
  createReplayRetention,
  getReplayFrames,
  parseReplayCursor,
  serializeEventData,
} from "./events.js";
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

describe("replay retention", () => {
  test("drops an idle ring and re-arms it for the next subscriber", async () => {
    const clear = mock(() => undefined);
    const retention = createReplayRetention({ clear }, 5);
    const release = retention.acquire();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(clear).not.toHaveBeenCalled();
    expect(retention.shouldRetain()).toBe(true);

    release();
    await waitFor(() => clear.mock.calls.length === 1);
    expect(retention.shouldRetain()).toBe(false);

    const releaseAgain = retention.acquire();
    expect(retention.shouldRetain()).toBe(true);
    expect(retention.liveSubscribers).toBe(1);
    releaseAgain();
  });
});

describe("serializeEventData", () => {
  test("serializes an event once and reuses the string for later subscribers", () => {
    const event = {
      type: "message.updated" as const,
      sessionId: "s-1",
      data: { message: { id: "m-1" } },
    };

    const first = serializeEventData(event);
    expect(first).toBe('{"sessionId":"s-1","message":{"id":"m-1"}}');

    // The payload mutating after the first serialization must not change what
    // later subscribers send: the frame was snapshotted at emit time.
    event.data.message.id = "mutated";
    expect(serializeEventData(event)).toBe(first);
  });

  test("serializes each event object independently", () => {
    const first = serializeEventData({ type: "session.idle", sessionId: "a", data: {} });
    const second = serializeEventData({ type: "session.idle", sessionId: "b", data: {} });
    expect(first).toBe('{"sessionId":"a"}');
    expect(second).toBe('{"sessionId":"b"}');
  });
});

describe("SSE replay ring", () => {
  test("returns frames after a cursor through the requested ceiling", () => {
    const before = eventEmitter.currentRevision;
    eventEmitter.emit({
      type: "session.updated",
      sessionId: "replay-one",
      data: { status: "running" },
    });
    eventEmitter.emit({
      type: "session.idle",
      sessionId: "replay-two",
    });
    const through = eventEmitter.currentRevision;

    const replay = getReplayFrames({
      generation: eventEmitter.generation,
      revision: before,
    }, through);
    expect(replay.resetRequired).toBe(false);
    expect(replay.frames.map((frame) => frame.revision)).toEqual([
      before + 1,
      before + 2,
    ]);
    expect(replay.frames.map((frame) => frame.event)).toEqual([
      "session.updated",
      "session.idle",
    ]);
  });

  test("requires a reset for stale-generation and future cursors", () => {
    const through = eventEmitter.currentRevision;
    expect(getReplayFrames({
      generation: "dead-bridge-generation",
      revision: through,
    }, through)).toEqual({ frames: [], resetRequired: true });
    expect(getReplayFrames({
      generation: eventEmitter.generation,
      revision: through + 1,
    }, through)).toEqual({ frames: [], resetRequired: true });
  });

  test("parses only bounded generation-aware cursors", () => {
    expect(parseReplayCursor(`${eventEmitter.generation}:42`)).toEqual({
      generation: eventEmitter.generation,
      revision: 42,
    });
    expect(parseReplayCursor("42")).toBeNull();
    expect(parseReplayCursor("generation:-1")).toBeNull();
    expect(parseReplayCursor("generation:9007199254740992")).toBeNull();
    expect(parseReplayCursor("bad/generation:1")).toBeNull();
  });

  test("requires a reset once a cursor falls outside the retained frame window", () => {
    const before = eventEmitter.currentRevision;
    for (let index = 0; index <= 512; index += 1) {
      eventEmitter.emit({
        type: "session.updated",
        sessionId: `replay-window-${index}`,
        data: { status: "running" },
      });
    }
    const replay = getReplayFrames({
      generation: eventEmitter.generation,
      revision: before,
    }, eventEmitter.currentRevision);
    expect(replay).toEqual({ frames: [], resetRequired: true });
  });

  test("evicts by encoded-byte weight independently of the frame cap", () => {
    const generation = "byte-window";
    const secondEvent = {
      type: "session.idle" as const,
      sessionId: "second",
      data: { value: "retained" },
    };
    const secondBytes =
      Buffer.byteLength(serializeEventData(secondEvent))
      + Buffer.byteLength(secondEvent.type);
    const replay = createReplayBuffer({
      maxFrames: 10,
      maxBytes: secondBytes,
    });

    replay.append({
      type: "session.updated",
      sessionId: "first",
      data: { value: "evicted" },
    }, 1, generation);
    replay.append(secondEvent, 2, generation);

    expect(replay.getFrames(
      { generation, revision: 0 },
      2,
      generation,
    )).toEqual({ frames: [], resetRequired: true });
    expect(replay.getFrames(
      { generation, revision: 1 },
      2,
      generation,
    ).frames.map((frame) => frame.revision)).toEqual([2]);
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

  test("replays retained frames from a query cursor", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
    const before = eventEmitter.currentRevision;
    eventEmitter.emit({
      type: "session.updated",
      sessionId: "query-replay-session",
      data: { status: "running" },
    });
    const controller = new AbortController();
    const cursor = encodeURIComponent(`${eventEmitter.generation}:${before}`);
    const response = await app.request(`/subscribe?since=${cursor}`, {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    try {
      const frames = await readUntil(
        reader!,
        (buffer) => buffer.includes('"sessionId":"query-replay-session"'),
      );
      expect(frames).toContain(`id: ${eventEmitter.generation}:${before}`);
      expect(frames).toContain("event: connected");
      expect(frames).toContain("event: session.updated");
      expect(frames).not.toContain("event: replay.required");
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
    const response = await app.request(`/subscribe?since=${currentCursor}`, {
      headers: { "Last-Event-ID": "stale-generation:7" },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    try {
      const frames = await readUntil(
        reader!,
        (buffer) => buffer.includes("event: replay.required"),
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
        `/subscribe?since=${encodeURIComponent(cursor)}`,
        { signal: controller.signal },
      );
      const reader = response.body?.getReader();
      try {
        const frames = await readUntil(
          reader!,
          (buffer) => buffer.includes("event: replay.required"),
        );
        expect(frames).toContain('"resetRequired":true');
      } finally {
        controller.abort();
        await reader?.cancel().catch(() => {});
        await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
      }
    }
  });

  test("requires authoritative rehydration when a route cursor is outside the window", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
    const before = eventEmitter.currentRevision;
    for (let index = 0; index <= 512; index += 1) {
      eventEmitter.emit({
        type: "session.updated",
        sessionId: `route-window-${index}`,
        data: { status: "running" },
      });
    }
    const controller = new AbortController();
    const response = await app.request(
      `/subscribe?since=${encodeURIComponent(
        `${eventEmitter.generation}:${before}`,
      )}`,
      { signal: controller.signal },
    );
    const reader = response.body?.getReader();

    try {
      const frames = await readUntil(
        reader!,
        (buffer) => buffer.includes("event: replay.required"),
      );
      expect(frames).toContain('"resetRequired":true');
      expect(frames).not.toContain(`"sessionId":"route-window-0"`);
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    }
  });

  test("delivers events emitted while retained replay is flushing in revision order", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
    const before = eventEmitter.currentRevision;
    for (let index = 0; index < 100; index += 1) {
      eventEmitter.emit({
        type: "session.updated",
        sessionId: `replay-backlog-${index}`,
        data: { status: "running" },
      });
    }
    const controller = new AbortController();
    const response = await app.request(
      `/subscribe?since=${encodeURIComponent(
        `${eventEmitter.generation}:${before}`,
      )}`,
      { signal: controller.signal },
    );
    const reader = response.body?.getReader();

    try {
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore + 1);
      for (let index = 1; index <= 3; index += 1) {
        eventEmitter.emit({
          type: "session.idle",
          sessionId: `emitted-during-replay-${index}`,
        });
      }
      const frames = await readUntil(
        reader!,
        (buffer) => buffer.includes('"sessionId":"emitted-during-replay-3"'),
      );
      for (let index = 1; index <= 3; index += 1) {
        expect(frames.match(
          new RegExp(`"sessionId":"emitted-during-replay-${index}"`, "g"),
        )).toHaveLength(1);
      }
      const revisions = [...frames.matchAll(
        new RegExp(`^id: ${eventEmitter.generation}:(\\d+)$`, "gm"),
      )].map((match) => Number(match[1]));
      expect(revisions.length).toBeGreaterThan(100);
      expect(revisions.every(
        (revision, index) => index === 0 || revision > revisions[index - 1]!,
      )).toBe(true);
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    }
  });

  test("aborting without draining a replay handshake removes the subscriber", async () => {
    const subscribersBefore = eventEmitter.subscriberCount;
    const before = eventEmitter.currentRevision;
    const payload = "x".repeat(256 * 1024);
    for (let index = 0; index < 80; index += 1) {
      eventEmitter.emit({
        type: "message.updated",
        sessionId: `stalled-replay-${index}`,
        data: { message: { payload, index } },
      });
    }
    const controller = new AbortController();
    const response = await app.request(
      `/subscribe?since=${encodeURIComponent(
        `${eventEmitter.generation}:${before}`,
      )}`,
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
      const response = await app.request("/subscribe");
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
    const response = await boundedApp.request("/subscribe");
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
    const response = await boundedApp.request("/subscribe");

    await waitFor(() => eventEmitter.subscriberCount === subscribersBefore + 1);
    eventEmitter.emit({ type: "session.updated", sessionId: "handshake-overflow-1" });
    eventEmitter.emit({ type: "session.updated", sessionId: "handshake-overflow-2" });

    await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    await response.body?.cancel().catch(() => {});
  });

  test("route-level handshake byte overflow closes and removes the subscriber", async () => {
    const boundedApp = new Hono();
    boundedApp.route("/", createEventsRouter({
      maxPendingFrames: 100,
      maxPendingBytes: 32,
    }));
    const subscribersBefore = eventEmitter.subscriberCount;
    const response = await boundedApp.request("/subscribe");

    await waitFor(() => eventEmitter.subscriberCount === subscribersBefore + 1);
    eventEmitter.emit({
      type: "message.updated",
      sessionId: "handshake-byte-overflow",
      data: { message: { content: "x".repeat(256) } },
    });

    await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    await response.body?.cancel().catch(() => {});
  });

  test("emits keepalives on the configured interval and cleans up on abort", async () => {
    const keepaliveApp = new Hono();
    keepaliveApp.route("/", createEventsRouter({ keepaliveIntervalMs: 5 }));
    const subscribersBefore = eventEmitter.subscriberCount;
    const controller = new AbortController();
    const response = await keepaliveApp.request("/subscribe", {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    try {
      const frames = await readUntil(
        reader!,
        (buffer) => buffer.includes("event: keepalive"),
      );
      expect(frames).toContain("event: connected");
      expect(frames).toContain("event: keepalive");
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await waitFor(() => eventEmitter.subscriberCount === subscribersBefore);
    }
  });
});
