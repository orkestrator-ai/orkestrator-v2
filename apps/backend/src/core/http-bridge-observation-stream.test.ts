import { describe, expect, test } from "bun:test";
import type { BridgeConnection } from "./agent-provider-contract.js";
import { frameSessionId, HttpBridgeObservationStream } from "./http-bridge-observation-stream.js";
import { HttpBridgeProvider } from "./http-bridge-provider.js";

const connection: BridgeConnection = {
  agent: "claude",
  baseUrl: "http://bridge.invalid",
  authToken: "secret-token",
};

/** One fake `/event/subscribe` response whose frames the test writes. */
class FakeStream {
  readonly url: string;
  readonly headers: Headers;
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

function harness(options: { silenceMs?: number; now?: () => number } = {}) {
  const streams: FakeStream[] = [];
  const hints: Array<string | undefined> = [];
  const waiters: Array<() => void> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const stream = new FakeStream(String(input), new Headers(init?.headers));
    init?.signal?.addEventListener("abort", () => {
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
    ...(options.now ? { now: options.now } : {}),
  });
  const nextStream = async (count: number): Promise<FakeStream> => {
    while (streams.length < count) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    return streams[count - 1]!;
  };
  return { observer, streams, hints, nextStream };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("HttpBridgeObservationStream", () => {
  test("subscribes in observation mode and is live only once the bridge confirms it", async () => {
    const { observer, hints, nextStream } = harness();
    try {
      observer.start();
      const first = await nextStream(1);
      expect(first.url).toBe("http://bridge.invalid/event/subscribe?observe=1");
      expect(first.headers.get("x-orkestrator-claude-token")).toBe("secret-token");
      expect(first.headers.get("accept")).toBe("text/event-stream");
      expect(observer.isLive).toBe(false);

      first.frame("connected", { status: "connected", observe: true }, "gen:4");
      await settle();
      expect(observer.isLive).toBe(true);
      // A connect re-reads whatever happened while disconnected.
      expect(hints).toEqual([undefined]);

      first.frame("session.updated", { sessionId: "s-1" }, "gen:5");
      first.frame("keepalive", { timestamp: "now" });
      first.frame("message.updated", { sessionId: 'quote"d' }, "gen:6");
      await settle();
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
      await settle();
      first.frame("replay.required", { through: "gen:9" }, "gen:9");
      await settle();
      expect(hints).toEqual([undefined, "s-1", undefined]);
      expect(observer.stats().gaps).toBe(1);

      // The bridge restarts: the stream ends, every session is hinted, and the
      // reconnect resumes from the last id it saw.
      first.end();
      await settle();
      expect(observer.isLive).toBe(false);
      expect(hints.at(-1)).toBeUndefined();
      const second = await nextStream(2);
      expect(second.url).toBe("http://bridge.invalid/event/subscribe?observe=1&since=gen%3A9");
      expect(observer.isLive).toBe(false);
      second.frame("connected", { observe: true }, "other:0");
      await settle();
      expect(observer.isLive).toBe(true);
      expect(observer.stats().connects).toBe(2);

      // Codex reports an expired cursor without a session.
      second.frame("session.reconcile-required", { reason: "cursor-expired" }, "12");
      // ...and a rewind of one session with it.
      second.frame("session.reconcile-required", { sessionId: "s-2" }, "13");
      await settle();
      expect(hints.slice(-2)).toEqual([undefined, "s-2"]);
    } finally {
      observer.close();
    }
  });

  test("an older bridge that ignores observation mode is closed for good", async () => {
    const { observer, streams, nextStream } = harness();
    observer.start();
    const first = await nextStream(1);
    first.frame("connected", { status: "connected", replayed: 0 }, "gen:1");
    await settle();
    await settle();
    expect(observer.isLive).toBe(false);
    expect(observer.stats().unsupported).toBe(true);
    expect(streams).toHaveLength(1);
  });

  test("a silent connection stops being live and is reconnected", async () => {
    let clock = 1_000;
    const { observer, nextStream } = harness({ silenceMs: 20, now: () => clock });
    try {
      observer.start();
      const first = await nextStream(1);
      first.frame("connected", { observe: true }, "gen:1");
      await settle();
      expect(observer.isLive).toBe(true);
      // No frame for longer than the silence bound: not live, even before the
      // watchdog has torn the connection down.
      clock += 21;
      expect(observer.isLive).toBe(false);
      // The watchdog aborts it and a fresh connection opens.
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
    await settle();
    observer.close();
    await settle();
    expect(observer.isLive).toBe(false);
    expect(hints).toEqual([undefined]);
    await settle();
    expect(streams).toHaveLength(1);
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
    await settle();
    expect(requests).toEqual([]);

    const claude = new HttpBridgeProvider(connection, fetchImpl, undefined, hint);
    expect(claude.observationStreamLive()).toBe(false);
    expect(claude.observationStreamLive()).toBe(false);
    await settle();
    expect(requests).toEqual(["http://bridge.invalid/event/subscribe?observe=1"]);
    claude.dispose();
    await settle();
    expect(aborted).toBe(1);

    // Disposed before the observer ever asked: never subscribes afterwards.
    const retired = new HttpBridgeProvider(connection, fetchImpl, undefined, hint);
    retired.dispose();
    expect(retired.observationStreamLive()).toBe(false);
    await settle();
    expect(requests).toHaveLength(1);
  });
});
