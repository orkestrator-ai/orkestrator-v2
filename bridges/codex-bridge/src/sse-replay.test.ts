/**
 * Exercises `/event/subscribe` over real HTTP: the `id:` framing, the cursor
 * handshake, and the subscribe-then-check ordering that stops an event emitted
 * mid-handshake from falling between the cursor check and the live stream.
 *
 * The bridge serves only the observation stream (`?observe=1`): content-free
 * frames and no replay, so a reconnect is either caught up or told of its gap.
 */
import { describe, expect, test } from "bun:test";
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
process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING = "1";

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

const latestRevision = () => __testing.latestRevisionForTesting();

/**
 * Opens an observation subscription (`query` is appended after `?observe=1`),
 * runs `during` while it is live, then aborts and returns whatever was written.
 */
async function collect(
  query: string,
  during: () => void | Promise<void>,
  options: { headers?: Record<string, string>; expected?: number } = {},
): Promise<Frame[]> {
  const controller = new AbortController();
  const response = await app.request(`/event/subscribe?observe=1${query}`, {
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

  // The `connected` frame plus any gap frame.
  await drain(1);
  await during();
  await drain(parseFrames(text).length + (options.expected ?? 1));

  controller.abort();
  await reader.cancel().catch(() => undefined);
  return parseFrames(text);
}

describe("/event/subscribe", () => {
  test("requires the bridge token in a header, never on the query string", async () => {
    const token = "sse-test-token";
    __testing.setBridgeAuthForTesting(token);
    try {
      expect((await app.request("/event/subscribe?observe=1")).status).toBe(401);
      expect((await app.request(`/event/subscribe?observe=1&token=${token}`)).status).toBe(401);

      const controller = new AbortController();
      const response = await app.request("/event/subscribe?observe=1", {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      controller.abort();
    } finally {
      __testing.setBridgeAuthForTesting();
    }
  });

  test("refuses a subscription that does not ask for observation mode", async () => {
    const subscribers = __testing.getSubscriberCountForTesting();
    for (const query of ["", "?observe=0", "?since=1"]) {
      const response = await app.request(`/event/subscribe${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "observe=1 is required: this bridge serves only the observation stream",
      });
    }
    expect(__testing.getSubscriberCountForTesting()).toBe(subscribers);
  });

  // No assertion on subscriber count for open streams: Hono's
  // `app.request({ signal })` does not reliably propagate the abort to
  // `c.req.raw.signal`, so a handler can outlive its test. That is a quirk of
  // driving SSE through `app.request`, not a leak in the endpoint, and asserting
  // on it would just be flaky.

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

  test("the connected frame confirms observation mode and reports the current revision", async () => {
    const before = latestRevision();
    const frames = await collect("", () => {
      __testing.emitForTesting({ type: "session.updated", sessionId: "s2" });
    });

    const connected = frames.find((frame) => frame.event === "connected");
    expect(connected).toBeDefined();
    expect(connected!.data).toMatchObject({ status: "connected", revision: before, observe: true });
  });

  test("frames carry the event type, cursor and session, never the payload", async () => {
    const frames = await collect(
      "",
      () => {
        __testing.emitForTesting({
          type: "message.updated",
          sessionId: "observed-live",
          data: { message: { id: "m-live", content: "secret transcript text" } },
        });
      },
      { expected: 1 },
    );
    const live = frames.find((frame) => frame.data.sessionId === "observed-live");
    expect(live).toMatchObject({ event: "message.updated", data: { sessionId: "observed-live" } });
    expect(Object.keys(live!.data)).toEqual(["sessionId"]);
    expect(JSON.stringify(frames)).not.toContain("secret transcript text");
  });

  test("a cursor behind the current revision gets a reconcile frame, not the missed events", async () => {
    __testing.emitForTesting({ type: "session.updated", sessionId: "gap" });
    const cursor = latestRevision();
    __testing.emitForTesting({ type: "session.idle", sessionId: "gap-missed-1" });
    __testing.emitForTesting({ type: "session.error", sessionId: "gap-missed-2" });

    const frames = await collect(`&since=${cursor}`, () => undefined);

    const reconcile = frames.find((frame) => frame.event === "session.reconcile-required");
    expect(reconcile).toMatchObject({
      id: String(latestRevision()),
      data: {
        reason: "cursor-expired",
        requestedRevision: cursor,
        latestRevision: latestRevision(),
      },
    });
    // A reconcile frame without a session tells the backend every session may
    // have changed; the missed frames themselves are not retained.
    expect(reconcile!.data.sessionId).toBeUndefined();
    expect(frames.some((frame) => String(frame.data.sessionId ?? "").startsWith("gap"))).toBe(
      false,
    );
  });

  test("a caught-up cursor gets no reconcile frame", async () => {
    const cursor = latestRevision();
    const frames = await collect(`&since=${cursor}`, () => undefined);

    expect(frames.find((frame) => frame.event === "connected")).toBeDefined();
    expect(frames.some((frame) => frame.event === "session.reconcile-required")).toBe(false);
  });

  test("forwards an explicit runtime reconciliation frame with its session", async () => {
    const frames = await collect("", () => {
      __testing.emitForTesting({
        type: "session.reconcile-required",
        sessionId: "ordered-overflow",
        data: { reason: "ordered-event-queue-overflow" },
      });
    });
    expect(frames).toContainEqual(
      expect.objectContaining({
        event: "session.reconcile-required",
        data: { sessionId: "ordered-overflow" },
      }),
    );
  });

  test("accepts the cursor from a Last-Event-ID header", async () => {
    const current = await collect("", () => undefined, {
      headers: { "Last-Event-ID": String(latestRevision()) },
    });
    expect(current.some((frame) => frame.event === "session.reconcile-required")).toBe(false);

    const cursor = latestRevision();
    __testing.emitForTesting({ type: "session.idle", sessionId: "via-header" });
    // What a native EventSource sends when it reconnects by itself.
    const behind = await collect("", () => undefined, {
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(behind.find((frame) => frame.event === "session.reconcile-required")).toMatchObject({
      data: { requestedRevision: cursor },
    });
  });

  test("asks for a reconcile when the cursor is from the future", async () => {
    // A client reconnecting to a restarted bridge, whose revisions began again.
    const frames = await collect("&since=999999", () => undefined);

    const reconcile = frames.find((frame) => frame.event === "session.reconcile-required");
    expect(reconcile).toBeDefined();
    expect(reconcile!.data.reason).toBe("cursor-expired");
    expect(reconcile!.data.requestedRevision).toBe(999999);
  });

  test("a garbled cursor is treated as a fresh subscription", async () => {
    // Must not fail the connection: a corrupt Last-Event-ID would otherwise leave
    // the client with no stream at all.
    const frames = await collect("&since=not-a-number", () => undefined);
    expect(frames.find((frame) => frame.event === "connected")).toBeDefined();
    expect(frames.some((frame) => frame.event === "session.reconcile-required")).toBe(false);
  });

  test("parses only non-negative safe integers as a cursor", () => {
    const parse = __testing.parseEventCursorForTesting;
    expect(parse("0")).toBe(0);
    expect(parse("42")).toBe(42);
    expect(parse(" 7 ")).toBe(7);
    for (const input of [null, undefined, "", "  ", "abc", "-1", "1.5", "1e3", "0x10", "٣"]) {
      expect(parse(input)).toBeNull();
    }
    expect(parse("99999999999999999999")).toBeNull();
  });

  test("an event emitted during the handshake is delivered exactly once", async () => {
    const cursor = latestRevision();

    const controller = new AbortController();
    const response = await app.request(`/event/subscribe?observe=1&since=${cursor}`, {
      signal: controller.signal,
    });

    // Emitted *immediately* after the request, racing the cursor check. This is
    // the ordering bug the buffered-listener design exists to prevent: the event
    // must not fall between the check and the live stream, and must not be sent
    // twice either.
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
    expect(sessionIds.filter((id) => id === "during-connect")).toHaveLength(1);
  });

  test("a fresh connection keeps its original anchor when an event lands before connected", async () => {
    const anchor = latestRevision();
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
      expect(frames.filter((frame) => frame.data.sessionId === "fresh-anchor-race")).toHaveLength(
        1,
      );
    } finally {
      __testing.setSseRouteTestHooksForTesting(null);
    }
  });

  test("events arriving during the buffered drain stay in revision order", async () => {
    const cursor = latestRevision();
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
      const frames = await collect(`&since=${cursor}`, () => undefined, {
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
        drained.map((frame) => Number(frame.id)).sort((a, b) => a - b),
      );
    } finally {
      __testing.setSseRouteTestHooksForTesting(null);
    }
  });

  test("starts keepalives only after the buffered handshake tail is written", async () => {
    const cursor = latestRevision();
    const order: string[] = [];
    __testing.setSseRouteTestHooksForTesting({
      beforeBufferedDrain: () => {
        order.push("drain");
        __testing.emitForTesting({
          type: "session.updated",
          sessionId: "keepalive-order",
        });
      },
      beforeBufferedWrite: () => {
        order.push("write");
      },
      afterKeepaliveStarted: () => {
        order.push("keepalive");
      },
    });

    try {
      const frames = await collect(`&since=${cursor}`, () => undefined, { expected: 1 });
      expect(frames.some((frame) => frame.data.sessionId === "keepalive-order")).toBe(true);
      expect(order).toEqual(["drain", "write", "keepalive"]);
    } finally {
      __testing.setSseRouteTestHooksForTesting(null);
    }
  });

  test("closes a subscriber whose handshake buffer exceeds its cap", async () => {
    const cursor = latestRevision();
    const originalError = console.info;
    const errors: string[] = [];
    console.info = ((message: unknown) => errors.push(String(message))) as typeof console.info;
    __testing.setSseRouteTestHooksForTesting({
      maxBufferedHandshakeEvents: 2,
      afterSubscriberRegistered: () => {
        for (let index = 0; index < 3; index += 1) {
          __testing.emitForTesting({
            type: "session.updated",
            sessionId: `overflow-${index}`,
          });
        }
      },
    });

    try {
      const frames = await collect(`&since=${cursor}`, () => undefined, { expected: 0 });
      expect(
        frames.filter((frame) => String(frame.data.sessionId).startsWith("overflow-")),
      ).toHaveLength(0);
      expect(errors.some((message) => message.includes("handshake buffer overflowed"))).toBe(true);
    } finally {
      console.info = originalError;
      __testing.setSseRouteTestHooksForTesting(null);
    }
  });

  test("health reports the event cursor", async () => {
    const body = (await (await app.request("/global/health")).json()) as {
      events?: { latestRevision?: number; subscribers?: number };
    };
    expect(body.events?.latestRevision).toBe(latestRevision());
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
      expect((await response.json()).error).toContain("requestId must be a non-empty string");
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
    for (const body of [
      {},
      { decision: "yes" },
      { decision: "accept" },
      { decision: 1 },
      // Retired by #1325: each saved a Codex rule Orkestrator cannot revoke.
      { decision: "approve-with-execpolicy-amendment" },
      { decision: "approve-with-network-amendment", amendmentIndex: 0 },
    ]) {
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
    const cursor = latestRevision();
    __testing.emitForTesting({ type: "session.idle", sessionId: "idem-1" });
    __testing.emitForTesting({ type: "session.idle", sessionId: "idem-2" });

    const frames = await collect(`&since=${cursor}`, () => undefined);
    const connected = frames.find((frame) => frame.event === "connected")!;

    /**
     * The critical property: a client adopts the id of *every* frame, so if this
     * carried the latest revision and the socket died here, the retry would look
     * caught up and the client would never learn of the gap.
     */
    expect(Number(connected.id)).toBe(cursor);
    expect(Number(connected.data.revision)).toBeGreaterThan(cursor);
  });

  test("a fresh subscription anchors at the latest revision", async () => {
    // No cursor means the client chose to start now, so adopting the latest
    // revision is right — there is nothing behind it that it wants.
    const latest = latestRevision();
    const frames = await collect("", () => undefined);
    const connected = frames.find((frame) => frame.event === "connected")!;
    expect(Number(connected.id)).toBe(latest);
  });

  test("an expired cursor's reconcile frame anchors at the latest revision", async () => {
    // The client has been told to resync from scratch, so it should not come back
    // asking for the range it missed.
    const frames = await collect("&since=999999", () => undefined);
    const reconcile = frames.find((frame) => frame.event === "session.reconcile-required")!;
    expect(Number(reconcile.id)).toBe(latestRevision());
  });
});
