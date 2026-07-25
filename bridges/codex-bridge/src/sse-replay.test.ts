/**
 * Exercises `/event/subscribe` over real HTTP.
 *
 * The unit tests in `event-ring.test.ts` cover the buffer; this covers the parts
 * only the endpoint can get wrong — the `id:` framing, the cursor handshake, and
 * the subscribe-then-replay ordering that stops an event emitted mid-handshake
 * from falling into the gap between the replay and the live stream.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { TransformStream } from "node:stream/web";

/**
 * hono's `streamSSE` constructs a `TransformStream` and immediately calls
 * `writable.getWriter()`. Bun's global `TransformStream` has no `getWriter` on its
 * `writable`, so the route 500s. Installed unconditionally and *before* importing
 * index.ts — a `if (!globalThis.TransformStream)` guard never fires and only
 * appears to work when another file has already replaced the global.
 */
globalThis.TransformStream = TransformStream as typeof globalThis.TransformStream;

// Importing index.ts spawns the engine and binds a port; neither is wanted here.
process.env.CODEX_BRIDGE_NO_ENGINE = "1";
process.env.CODEX_BRIDGE_NO_SERVER = "1";

const { app, __testing } = await import("./index.js");

interface Frame {
  event: string;
  id?: string;
  data: Record<string, unknown>;
}

/** Parses SSE wire text into frames. */
function parseFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split("\n\n")) {
    if (block.trim().length === 0) continue;
    let event = "message";
    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    } catch {
      // Keep the frame; the assertion will report the raw shape.
    }
    frames.push({ event, ...(id === undefined ? {} : { id }), data });
  }
  return frames;
}

/**
 * Opens a subscription, runs `during` while it is live, then aborts and returns
 * whatever was written.
 */
async function collect(
  query: string,
  during: () => void | Promise<void>,
  options: { headers?: Record<string, string>; expected?: number } = {},
): Promise<Frame[]> {
  const controller = new AbortController();
  const response = await app.request(`/event/subscribe${query}`, {
    signal: controller.signal,
    ...(options.headers ? { headers: options.headers } : {}),
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";

  /**
   * Reads until `expected` frames have arrived or the stream goes quiet.
   *
   * Counting frames rather than reads matters: one `reader.read()` can return
   * several frames coalesced, or a partial one, so a fixed number of reads would
   * be flaky in both directions.
   */
  const drain = async (expected: number, quietMs = 150) => {
    const deadline = Date.now() + 2_000;
    while (parseFrames(text).length < expected && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(quietMs).then(() => ({ done: true, value: undefined }) as const),
      ]);
      if (chunk.done) break;
      text += decoder.decode(chunk.value as Uint8Array, { stream: true });
    }
  };

  // The `connected` frame plus any replay.
  await drain(1);
  await during();
  await drain(parseFrames(text).length + (options.expected ?? 1));

  controller.abort();
  await reader.cancel().catch(() => undefined);
  return parseFrames(text);
}

describe("/event/subscribe", () => {
  let baseline = 0;

  beforeAll(() => {
    baseline = __testing.eventRingForTesting().latestRevision;
  });

  // No assertion on subscriber count: Hono's `app.request({ signal })` does not
  // reliably propagate the abort to `c.req.raw.signal`, so a handler can outlive
  // its test. That is a quirk of driving SSE through `app.request`, not a leak in
  // the endpoint, and asserting on it would just be flaky.

  test("stamps every frame with a monotonic id", async () => {
    const frames = await collect(
      "",
      () => {
        __testing.emitForTesting({ type: "session.updated", sessionId: "s1" });
        __testing.emitForTesting({ type: "session.idle", sessionId: "s1" });
      },
      { expected: 2 },
    );

    const live = frames.filter((frame) => frame.event.startsWith("session."));
    expect(live.length).toBeGreaterThanOrEqual(2);
    const ids = live.map((frame) => Number(frame.id));
    // Strictly increasing: the id is the client's cursor, so a repeat or a gap
    // would corrupt the next reconnect.
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]!).toBeGreaterThan(ids[index - 1]!);
    }
  });

  test("the connected frame reports the current revision", async () => {
    const before = __testing.eventRingForTesting().latestRevision;
    const frames = await collect("", () => {
      __testing.emitForTesting({ type: "session.updated", sessionId: "s2" });
    });

    const connected = frames.find((frame) => frame.event === "connected");
    expect(connected).toBeDefined();
    expect(connected!.data.revision).toBe(before);
    // A fresh subscription is not a replay.
    expect(connected!.data.replayed).toBe(0);
  });

  test("replays only what the cursor missed", async () => {
    // Emit while nobody is listening — the case the ring exists for.
    __testing.emitForTesting({ type: "session.updated", sessionId: "gap" });
    const cursor = __testing.eventRingForTesting().latestRevision;
    __testing.emitForTesting({ type: "session.idle", sessionId: "gap-missed-1" });
    __testing.emitForTesting({ type: "session.error", sessionId: "gap-missed-2" });

    const frames = await collect(`?since=${cursor}`, () => undefined, { expected: 2 });

    const connected = frames.find((frame) => frame.event === "connected");
    expect(connected!.data.replayed).toBe(2);

    const replayed = frames.filter((frame) => frame.event.startsWith("session."));
    expect(replayed.map((frame) => frame.data.sessionId)).toEqual([
      "gap-missed-1",
      "gap-missed-2",
    ]);
    // The event before the cursor must not be re-sent.
    expect(replayed.some((frame) => frame.data.sessionId === "gap")).toBe(false);
  });

  test("a caught-up cursor replays nothing", async () => {
    const cursor = __testing.eventRingForTesting().latestRevision;
    const frames = await collect(`?since=${cursor}`, () => undefined);

    expect(frames.find((frame) => frame.event === "connected")!.data.replayed).toBe(0);
    expect(frames.some((frame) => frame.event === "session.reconcile-required")).toBe(false);
  });

  test("accepts the cursor from a Last-Event-ID header", async () => {
    const cursor = __testing.eventRingForTesting().latestRevision;
    __testing.emitForTesting({ type: "session.idle", sessionId: "via-header" });

    // What a native EventSource sends when the browser reconnects by itself.
    const frames = await collect("", () => undefined, {
      headers: { "Last-Event-ID": String(cursor) },
    });

    expect(frames.find((frame) => frame.event === "connected")!.data.replayed).toBe(1);
    expect(
      frames.some((frame) => frame.data.sessionId === "via-header"),
    ).toBe(true);
  });

  test("asks for a reconcile when the cursor is from the future", async () => {
    // A client reconnecting to a restarted bridge, whose revisions began again.
    const frames = await collect("?since=999999", () => undefined);

    const reconcile = frames.find((frame) => frame.event === "session.reconcile-required");
    expect(reconcile).toBeDefined();
    expect(reconcile!.data.reason).toBe("cursor-expired");
    expect(reconcile!.data.requestedRevision).toBe(999999);
  });

  test("a garbled cursor is treated as a fresh subscription", async () => {
    // Must not fail the connection: a corrupt Last-Event-ID would otherwise leave
    // the client with no stream at all.
    const frames = await collect("?since=not-a-number", () => undefined);
    expect(frames.find((frame) => frame.event === "connected")).toBeDefined();
    expect(frames.some((frame) => frame.event === "session.reconcile-required")).toBe(false);
  });

  test("an event emitted during the handshake is delivered exactly once", async () => {
    const cursor = __testing.eventRingForTesting().latestRevision;
    __testing.emitForTesting({ type: "session.idle", sessionId: "before-connect" });

    const controller = new AbortController();
    const response = await app.request(`/event/subscribe?since=${cursor}`, {
      signal: controller.signal,
    });

    // Emitted *immediately* after the request, racing the replay computation. This
    // is the ordering bug the buffered-listener design exists to prevent: the
    // event must not fall between the replay and the live stream, and must not be
    // sent twice either.
    __testing.emitForTesting({ type: "session.error", sessionId: "during-connect" });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(100).then(() => ({ done: true, value: undefined }) as const),
      ]);
      if (chunk.done) break;
      text += decoder.decode(chunk.value as Uint8Array, { stream: true });
      if (text.includes("during-connect")) break;
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);

    const frames = parseFrames(text);
    const sessionIds = frames
      .filter((frame) => frame.event.startsWith("session."))
      .map((frame) => frame.data.sessionId);

    expect(sessionIds).toContain("before-connect");
    expect(sessionIds.filter((id) => id === "during-connect")).toHaveLength(1);
    expect(sessionIds.filter((id) => id === "before-connect")).toHaveLength(1);
  });

  test("a fresh connection keeps its original anchor when an event lands before connected", async () => {
    const anchor = __testing.eventRingForTesting().latestRevision;
    __testing.setSseRouteTestHooksForTesting({
      afterSubscriberRegistered: () => {
        __testing.emitForTesting({
          type: "session.updated",
          sessionId: "fresh-anchor-race",
        });
      },
    });

    try {
      const frames = await collect("", () => undefined);
      const connected = frames.find((frame) => frame.event === "connected")!;
      expect(Number(connected.id)).toBe(anchor);
      expect(
        frames.filter((frame) => frame.data.sessionId === "fresh-anchor-race"),
      ).toHaveLength(1);
    } finally {
      __testing.setSseRouteTestHooksForTesting(null);
    }
  });

  test("events arriving during the buffered drain stay in revision order", async () => {
    const cursor = __testing.eventRingForTesting().latestRevision;
    let injectedDuringWrite = false;
    __testing.setSseRouteTestHooksForTesting({
      beforeBufferedDrain: () => {
        __testing.emitForTesting({
          type: "session.updated",
          sessionId: "buffered-drain-1",
        });
        __testing.emitForTesting({
          type: "session.updated",
          sessionId: "buffered-drain-2",
        });
      },
      beforeBufferedWrite: () => {
        if (injectedDuringWrite) return;
        injectedDuringWrite = true;
        __testing.emitForTesting({
          type: "session.updated",
          sessionId: "buffered-drain-3",
        });
      },
    });

    try {
      const frames = await collect(`?since=${cursor}`, () => undefined, {
        expected: 3,
      });
      const drained = frames.filter((frame) =>
        String(frame.data.sessionId ?? "").startsWith("buffered-drain-"),
      );
      expect(drained.map((frame) => frame.data.sessionId)).toEqual([
        "buffered-drain-1",
        "buffered-drain-2",
        "buffered-drain-3",
      ]);
      expect(drained.map((frame) => Number(frame.id))).toEqual(
        [...drained.map((frame) => Number(frame.id))].sort((a, b) => a - b),
      );
    } finally {
      __testing.setSseRouteTestHooksForTesting(null);
    }
  });

  test("the ring grows as events are emitted and reports its stats", () => {
    const stats = __testing.eventRingForTesting().getStats();
    expect(stats.latestRevision).toBeGreaterThan(baseline);
    expect(stats.retained).toBeGreaterThan(0);
    expect(stats.capacity).toBeGreaterThan(0);
  });

  test("health reports the event ring", async () => {
    const body = (await (await app.request("/global/health")).json()) as {
      events?: { latestRevision?: number; capacity?: number; subscribers?: number };
    };
    expect(body.events?.capacity).toBeGreaterThan(0);
    expect(body.events?.latestRevision).toBeGreaterThan(0);
    expect(typeof body.events?.subscribers).toBe("number");
  });
});

describe("/session/:id/prompt", () => {
  test("rejects a missing or blank requestId before dispatch", async () => {
    for (const body of [{ prompt: "hello" }, { prompt: "hello", requestId: "   " }]) {
      const response = await app.request("/session/session-does-not-exist/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        "requestId must be a non-empty string",
      );
    }
  });
});

describe("/session/:id/config", () => {
  test("reports 404 for a session the bridge does not know", async () => {
    const response = await app.request("/session/session-does-not-exist/config");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });
});

describe("/session/:id/approvals", () => {
  test("returns an empty list for an unknown session rather than 404", async () => {
    // A stale tab polling a closed session should see "nothing pending", not an
    // error it has to special-case.
    const response = await app.request("/session/session-does-not-exist/approvals");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ approvals: [] });
  });

  test("rejects a missing or invalid decision", async () => {
    for (const body of [{}, { decision: "yes" }, { decision: "accept" }, { decision: 1 }]) {
      const response = await app.request("/session/s/approvals/apr-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("decision must be one of");
    }
  });

  test("rejects a non-JSON body", async () => {
    const response = await app.request("/session/s/approvals/apr-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  test("an unknown approval id is 409, not 404", async () => {
    // 409 tells the UI "the window closed, drop the card"; a 404 would read as
    // "wrong URL" and invite a retry.
    const response = await app.request("/session/s/approvals/apr-nope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "stale" });
  });

  test("the approval id is path-encoded safely", async () => {
    // Ids are ours (`apr-<gen>-<seq>`), but the route must not break if one ever
    // contains a character that needs encoding.
    const response = await app.request(
      `/session/s/approvals/${encodeURIComponent("apr-1-1/../evil")}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "deny" }),
      },
    );
    expect([404, 409]).toContain(response.status);
  });
});

describe("connected frame id", () => {
  test("echoes the client's cursor so the handshake is idempotent", async () => {
    __testing.emitForTesting({ type: "session.updated", sessionId: "idem-0" });
    const cursor = __testing.eventRingForTesting().latestRevision;
    __testing.emitForTesting({ type: "session.idle", sessionId: "idem-1" });
    __testing.emitForTesting({ type: "session.idle", sessionId: "idem-2" });

    const frames = await collect(`?since=${cursor}`, () => undefined, { expected: 2 });
    const connected = frames.find((frame) => frame.event === "connected")!;

    /**
     * The critical property: a browser EventSource adopts the id of *every* frame,
     * so if this carried the latest revision and the socket died here, the retry
     * would ask for everything after the newest event and silently skip the two
     * frames it was mid-way through replaying.
     */
    expect(Number(connected.id)).toBe(cursor);
    expect(Number(connected.data.revision)).toBeGreaterThan(cursor);
  });

  test("a fresh subscription anchors at the latest revision", async () => {
    // No cursor means the client chose to start now, so adopting the latest
    // revision is right — there is nothing behind it that it wants.
    const latest = __testing.eventRingForTesting().latestRevision;
    const frames = await collect("", () => undefined);
    const connected = frames.find((frame) => frame.event === "connected")!;
    expect(Number(connected.id)).toBe(latest);
  });

  test("an expired cursor anchors at the latest revision", async () => {
    // The client has been told to resync from scratch, so it should not come back
    // asking for the range that no longer exists.
    const frames = await collect("?since=999999", () => undefined);
    const reconcile = frames.find((frame) => frame.event === "session.reconcile-required")!;
    expect(Number(reconcile.id)).toBe(__testing.eventRingForTesting().latestRevision);
  });
});
