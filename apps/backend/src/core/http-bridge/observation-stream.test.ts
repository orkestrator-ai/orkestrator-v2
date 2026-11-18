import { describe, expect, test } from "bun:test";
import { ManualClock } from "@orkestrator/protocol/testing/manual-clock";
import type { BridgeConnection } from "../agent-provider-contract.js";
import { frameSessionId, HttpBridgeObservationStream } from "./observation-stream.js";
import { HttpBridgeProvider } from "./provider.js";

const connection: BridgeConnection = {
  agent: "claude",
  baseUrl: "http://bridge.invalid",
  authToken: "secret-token",
};

/** One fake `/event/subscribe` response whose frames the test writes. */
class FakeStream {
  readonly url: string;
  readonly headers: Headers;
  /** Set the moment the observer aborts this connection. */
  aborted = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly response: Response;
  private readonly encoder = new TextEncoder();

  constructor(url: string, headers: Headers) {
    this.url = url;
    this.headers = headers;
    this.response = new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.controller = controller;
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  frame(event: string, data: unknown, id?: string): void {
    this.controller.enqueue(
      this.encoder.encode(
        `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      ),
    );
  }

  end(): void {
    this.controller.close();
  }
}

function harness(options: { silenceMs?: number; clock?: ManualClock } = {}) {
  const streams: FakeStream[] = [];
  const hints: Array<string | undefined> = [];
  const waiters: Array<() => void> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const stream = new FakeStream(String(input), new Headers(init?.headers));
    init?.signal?.addEventListener("abort", () => {
      stream.aborted = true;
      try {
        stream.end();
      } catch {
        // Already closed.
      }
    });
    streams.push(stream);
    for (const waiter of waiters.splice(0)) waiter();
    return stream.response;
  }) as typeof fetch;
  const observer = new HttpBridgeObservationStream({
    connection,
    fetchImpl,
    hint: (sessionId) => hints.push(sessionId),
    retryInitialMs: 1,
    retryMaxMs: 1,
    random: () => 0,
    ...(options.silenceMs ? { silenceMs: options.silenceMs } : {}),
    ...(options.clock ? { now: () => options.clock!.now(), timers: options.clock } : {}),
  });
  const nextStream = async (count: number): Promise<FakeStream> => {
    while (streams.length < count) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    return streams[count - 1]!;
  };
  return { observer, streams, hints, nextStream };
}

/**
 * Yields to the event loop until `condition` holds: frames reach the observer
 * through a real stream reader. The test's own budget is the watchdog.
 */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setImmediate(resolve));
}

describe("HttpBridgeObservationStream", () => {
  test("subscribes in observation mode and is live only once the bridge connects", async () => {
    const { observer, hints, nextStream } = harness();
    try {
      observer.start();
      const first = await nextStream(1);
      expect(first.url).toBe("http://bridge.invalid/event/subscribe?observe=1");
      expect(first.headers.get("x-orkestrator-claude-token")).toBe("secret-token");
      expect(first.headers.get("accept")).toBe("text/event-stream");
      expect(observer.isLive).toBe(false);

      first.frame("connected", { status: "connected", observe: true }, "gen:4");
      await until(() => observer.isLive);
      // A connect re-reads whatever happened while disconnected.
      expect(hints).toEqual([undefined]);

      first.frame("session.updated", { sessionId: "s-1" }, "gen:5");
      first.frame("keepalive", { timestamp: "now" });
      first.frame("message.updated", { sessionId: 'quote"d' }, "gen:6");
      await until(() => hints.length === 3);
      expect(hints).toEqual([undefined, "s-1", 'quote"d']);
      expect(observer.stats().cursor).toBe("gen:6");
    } finally {
      observer.close();
    }
  });

  test("marks a gap, reconnects from its cursor and is not live in between", async () => {
    const { observer, hints, nextStream } = harness();
    try {
      observer.start();
      const first = await nextStream(1);
      first.frame("connected", { observe: true }, "gen:1");
      first.frame("session.idle", { sessionId: "s-1" }, "gen:2");
      await until(() => hints.length === 2);
      first.frame("replay.required", { through: "gen:9" }, "gen:9");
      await until(() => hints.length === 3);
      expect(hints).toEqual([undefined, "s-1", undefined]);
      expect(observer.stats().gaps).toBe(1);

      // The bridge restarts: the stream ends, every session is hinted, and the
      // reconnect resumes from the last id it saw.
      first.end();
      // Losing the stream hints every session.
      await until(() => hints.length === 4);
      expect(observer.isLive).toBe(false);
      expect(hints.at(-1)).toBeUndefined();
      const second = await nextStream(2);
      expect(second.url).toBe("http://bridge.invalid/event/subscribe?observe=1&since=gen%3A9");
      expect(observer.isLive).toBe(false);
      second.frame("connected", { observe: true }, "other:0");
      await until(() => observer.isLive);
      expect(observer.stats().connects).toBe(2);

      // Codex reports an expired cursor without a session.
      second.frame("session.reconcile-required", { reason: "cursor-expired" }, "12");
      // ...and a rewind of one session with it.
      second.frame("session.reconcile-required", { sessionId: "s-2" }, "13");
      await until(() => hints.length === 7);
      expect(hints.slice(-2)).toEqual([undefined, "s-2"]);
    } finally {
      observer.close();
    }
  });

  test("a silent connection stops being live and is reconnected", async () => {
    const clock = new ManualClock({ start: 1_000 });
    const { observer, streams, nextStream } = harness({ silenceMs: 20, clock });
    try {
      observer.start();
      const first = await nextStream(1);
      first.frame("connected", { observe: true }, "gen:1");
      await until(() => observer.isLive);
      // The watchdog checks every third of the bound.
      expect(clock.intervalPeriods()).toEqual([6]);
      clock.advance(20);
      expect(observer.isLive).toBe(true);
      expect(first.aborted).toBe(false);
      // No frame for longer than the silence bound: not live, even before the
      // watchdog has torn the connection down (its next check is at 24 ms).
      clock.advance(1);
      expect(observer.isLive).toBe(false);
      expect(first.aborted).toBe(false);
      expect(streams).toHaveLength(1);
      // The watchdog aborts it and a fresh connection opens.
      clock.advance(3);
      expect(first.aborted).toBe(true);
      await nextStream(2);
    } finally {
      observer.close();
    }
  });

  test("close stops the subscription and every hint", async () => {
    const { observer, hints, streams, nextStream } = harness();
    observer.start();
    const first = await nextStream(1);
    first.frame("connected", { observe: true }, "gen:1");
    await until(() => observer.isLive);
    observer.close();
    // The subscription loop has exited, so nothing can follow.
    await observer.stopped();
    expect(observer.isLive).toBe(false);
    expect(hints).toEqual([undefined]);
    expect(streams).toHaveLength(1);
  });

  test("close ends a pending reconnect delay at once", async () => {
    let requests = 0;
    let delaying = false;
    const observer = new HttpBridgeObservationStream({
      connection,
      fetchImpl: (async () => {
        requests += 1;
        return new Response(null, { status: 503 });
      }) as unknown as typeof fetch,
      hint: () => undefined,
      // Without the abort, the loop would sit in this delay for ten minutes,
      // far past the test's budget.
      retryInitialMs: 600_000,
      retryMaxMs: 600_000,
      // Drawn as the delay is chosen, immediately before the loop sleeps.
      random: () => {
        delaying = true;
        return 0;
      },
    });
    observer.start();
    await until(() => delaying);
    observer.close();
    await observer.stopped();
    expect(requests).toBe(1);
  });
});

describe("frameSessionId", () => {
  test("reads only a leading sessionId", () => {
    expect(frameSessionId('{"sessionId":"abc","message":{}}')).toBe("abc");
    expect(frameSessionId('{"sessionId":"a\\\\b"}')).toBe("a\\b");
    expect(frameSessionId('{"message":{"sessionId":"nested"}}')).toBeUndefined();
    expect(frameSessionId("{}")).toBeUndefined();
    expect(frameSessionId(null)).toBeUndefined();
    expect(frameSessionId("not json")).toBeUndefined();
  });
});

describe("HttpBridgeProvider observation stream", () => {
  test("only Claude and Codex subscribe, on the observer's first ask, until disposed", async () => {
    const requests: string[] = [];
    let aborted = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input));
      init?.signal?.addEventListener("abort", () => (aborted += 1));
      return new Response(new ReadableStream<Uint8Array>(), { status: 200 });
    }) as typeof fetch;
    const hint = () => undefined;

    const cursor = new HttpBridgeProvider(
      { ...connection, agent: "cursor" },
      fetchImpl,
      undefined,
      hint,
    );
    expect(cursor.observationStreamLive()).toBe(false);
    // Without a hint sink nothing would consume the stream.
    const unobserved = new HttpBridgeProvider(connection, fetchImpl);
    expect(unobserved.observationStreamLive()).toBe(false);
    // A subscription is requested within the first ask (the Claude case below
    // proves it), so none having been requested by now means none will be.
    expect(requests).toEqual([]);

    const claude = new HttpBridgeProvider(connection, fetchImpl, undefined, hint);
    expect(claude.observationStreamLive()).toBe(false);
    expect(claude.observationStreamLive()).toBe(false);
    expect(requests).toEqual(["http://bridge.invalid/event/subscribe?observe=1"]);
    claude.dispose();
    expect(aborted).toBe(1);

    // Disposed before the observer ever asked: never subscribes afterwards.
    const retired = new HttpBridgeProvider(connection, fetchImpl, undefined, hint);
    retired.dispose();
    expect(retired.observationStreamLive()).toBe(false);
    expect(requests).toHaveLength(1);
  });
});
