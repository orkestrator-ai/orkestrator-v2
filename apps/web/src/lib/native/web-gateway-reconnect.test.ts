import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createBrowserGatewayApi, installBrowserGatewayApi } from "./web-gateway";
import { clearDirectGatewayTransport } from "./gateway-auth-transport";

/**
 * The gateway's event stream reconnect policy: consecutive failures back off
 * with capped jitter from the configured first delay, there is only ever one
 * pending reconnect per owner, and only a stream that stayed up resets the
 * ladder. The main stream still resumes from its cursor; the terminal
 * fallback streams still announce a desync on every reopen.
 */
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalWarn = console.warn;

afterEach(() => {
  clearDirectGatewayTransport();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  console.warn = originalWarn;
  // Tests that simulate a hidden or visible tab shadow the prototype getter.
  Reflect.deleteProperty(document, "visibilityState");
});

const EVENTS_PATH = "/__orkestrator/events";

/**
 * Run every timer promptly but record the delay it asked for, and how many
 * were pending at once. Only timers armed by the code under test are affected:
 * the helpers below hold the original functions.
 */
function acceleratedTimers() {
  const delays: number[] = [];
  const pending = new Set<unknown>();
  let maxPending = 0;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    delays.push(delay ?? 0);
    const handle: ReturnType<typeof setTimeout> = originalSetTimeout(() => {
      pending.delete(handle);
      if (typeof handler === "function") handler(...args);
    }, 0);
    pending.add(handle);
    maxPending = Math.max(maxPending, pending.size);
    return handle;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    pending.delete(handle);
    originalClearTimeout(handle);
  }) as unknown as typeof clearTimeout;
  return { delays, pending, maxPending: () => maxPending };
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => originalSetTimeout(resolve, 1));
  }
}

function streamOnce(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

describe("gateway main event stream reconnect backoff", () => {
  test("repeated failures back off from the configured delay to the cap, one timer at a time", async () => {
    console.warn = mock(() => undefined);
    const eventRequests: string[] = [];
    globalThis.fetch = mock(async (input) => {
      const url = String(input);
      if (!url.includes(EVENTS_PATH)) return new Response(null, { status: 404 });
      eventRequests.push(url);
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch;
    const timers = acceleratedTimers();
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      eventReconnectDelayMs: 100,
      eventReconnectMaxDelayMs: 800,
      // The top of each jitter range, so the ladder itself is visible.
      eventReconnectRandom: () => 0.999_999,
    });
    const unsubscribe = api.listen("changed", () => undefined);
    try {
      await waitFor(() => eventRequests.length >= 6, "the stream did not keep retrying");
      unsubscribe();

      expect(timers.delays.slice(0, 5)).toEqual([100, 200, 400, 800, 800]);
      expect(timers.maxPending()).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  test("the first retry after a failure is never slower than the configured delay", async () => {
    console.warn = mock(() => undefined);
    let eventRequests = 0;
    globalThis.fetch = mock(async (input) => {
      if (!String(input).includes(EVENTS_PATH)) return new Response(null, { status: 404 });
      eventRequests += 1;
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch;
    const timers = acceleratedTimers();
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      eventReconnectDelayMs: 2_000,
      eventReconnectRandom: () => 0.3,
    });
    const unsubscribe = api.listen("changed", () => undefined);
    try {
      await waitFor(() => eventRequests >= 2, "the stream did not retry");
      unsubscribe();
      expect(timers.delays[0]).toBeGreaterThanOrEqual(1_000);
      expect(timers.delays[0]).toBeLessThanOrEqual(2_000);
    } finally {
      unsubscribe();
    }
  });

  test("every backed-off attempt resumes from the newest authoritative cursor", async () => {
    console.warn = mock(() => undefined);
    const eventRequests: string[] = [];
    globalThis.fetch = mock(async (input) => {
      const url = String(input);
      if (!url.includes(EVENTS_PATH)) return new Response(null, { status: 404 });
      eventRequests.push(url);
      if (eventRequests.length === 1) {
        return streamOnce(['id: 12345678:7\ndata: {"event":"changed","payload":"latest"}\n\n']);
      }
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch;
    const timers = acceleratedTimers();
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      eventReconnectDelayMs: 10,
      eventReconnectRandom: () => 0.999_999,
    });
    const received: unknown[] = [];
    const unsubscribe = api.listen("changed", (payload) => received.push(payload));
    try {
      await waitFor(() => eventRequests.length >= 4, "the stream did not keep retrying");
      unsubscribe();

      expect(received).toEqual(["latest"]);
      // The stream that delivered and closed at once did not count as healthy.
      expect(timers.delays.slice(0, 3)).toEqual([10, 20, 40]);
      for (const url of eventRequests.slice(1, 4)) {
        expect(new URL(url).searchParams.get("since")).toBe("12345678:7");
      }
    } finally {
      unsubscribe();
    }
  });

  test("removing the last listener cancels the pending retry and forgets the outage", async () => {
    console.warn = mock(() => undefined);
    let eventRequests = 0;
    let failing = true;
    globalThis.fetch = mock(async (input) => {
      if (!String(input).includes(EVENTS_PATH)) return new Response(null, { status: 404 });
      eventRequests += 1;
      return failing
        ? new Response(null, { status: 503 })
        : new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const timers = acceleratedTimers();
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      eventReconnectDelayMs: 100,
      eventReconnectRandom: () => 0.999_999,
    });
    const first = api.listen("changed", () => undefined);
    await waitFor(() => eventRequests >= 3, "the stream did not retry");
    first();
    const requestsAfterClose = eventRequests;
    await new Promise((resolve) => originalSetTimeout(resolve, 10));
    expect(eventRequests).toBe(requestsAfterClose);
    expect(timers.pending.size).toBe(0);

    const delaysBefore = timers.delays.length;
    const second = api.listen("changed", () => undefined);
    try {
      await waitFor(() => timers.delays.length > delaysBefore, "the new stream did not retry");
      failing = false;
      expect(timers.delays[delaysBefore]).toBe(100);
    } finally {
      second();
    }
  });
});

const EVENT_SOURCE_CONNECTING = 0;
const EVENT_SOURCE_OPEN = 1;
const EVENT_SOURCE_CLOSED = 2;
const DIRECT = {
  baseUrl: "https://workstation.tailnet.ts.net",
  token: "direct-token-123456",
} as const;
/** The top of each jitter range, so the ladder itself is visible. */
const TOP_OF_RANGE = () => 0.999_999;

/** Drives the same-origin `EventSource` the way the browser would. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = EVENT_SOURCE_CONNECTING;
  closed = false;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  /** The terminal events this socket was opened for, or null for the main stream. */
  get terminalEvents(): string[] | null {
    return (
      new URL(this.url, "http://gateway.test").searchParams.get("includeEvents")?.split(",") ?? null
    );
  }

  open(): void {
    this.readyState = EVENT_SOURCE_OPEN;
    this.onopen?.();
  }

  /** A fatal failure: the browser abandons a CLOSED socket. */
  fail(): void {
    this.readyState = EVENT_SOURCE_CLOSED;
    this.onerror?.();
  }

  close(): void {
    this.closed = true;
    this.readyState = EVENT_SOURCE_CLOSED;
  }
}

function terminalSources(): MockEventSource[] {
  return MockEventSource.instances.filter((source) => source.terminalEvents !== null);
}

/**
 * Nothing fires until the test fires it. Every armed timer records the delay it
 * asked for, so a test reads the reconnect ladder straight off `delays()`.
 */
function manualTimers() {
  type ManualTimer = { id: number; delay: number; run: () => void };
  const armed: ManualTimer[] = [];
  const pending = new Map<number, ManualTimer>();
  let nextId = 1;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const timer: ManualTimer = {
      id: nextId++,
      delay: delay ?? 0,
      run: () => {
        if (typeof handler === "function") handler(...args);
      },
    };
    armed.push(timer);
    pending.set(timer.id, timer);
    return timer.id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    pending.delete(handle as unknown as number);
  }) as unknown as typeof clearTimeout;
  return {
    delays: () => armed.map((timer) => timer.delay),
    pendingDelays: () => [...pending.values()].map((timer) => timer.delay),
    /** Fire the one pending timer that asked for `delay`. */
    fire(delay: number): void {
      const matches = [...pending.values()].filter((timer) => timer.delay === delay);
      if (matches.length !== 1) {
        throw new Error(`Expected one pending ${delay} ms timer, found ${matches.length}`);
      }
      pending.delete(matches[0]!.id);
      matches[0]!.run();
    },
  };
}

/** Let promise chains run without waiting on any real timer. */
async function until(condition: () => boolean, message: string): Promise<void> {
  for (let turn = 0; turn < 1_000; turn += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

/** A terminal stream response the test closes when it wants the stream to drop. */
function openTerminalResponse(): { response: Response; drop: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    }),
    { status: 200 },
  );
  return { response, drop: () => controller.close() };
}

describe("gateway terminal fallback reconnect backoff", () => {
  test("a shared browser terminal stream that keeps dying backs off to the cap, one timer at a time", async () => {
    console.warn = mock(() => undefined);
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const timers = manualTimers();
    const api = createBrowserGatewayApi({
      eventReconnectDelayMs: 100,
      eventReconnectMaxDelayMs: 800,
      eventReconnectRandom: TOP_OF_RANGE,
    });
    const stop = api.listen("terminal-output-a", () => undefined);
    await flushMicrotasks();

    for (const delay of [100, 200, 400, 800, 800]) {
      terminalSources().at(-1)!.fail();
      expect(timers.pendingDelays()).toEqual([delay]);
      timers.fire(delay);
      await flushMicrotasks();
    }

    expect(timers.delays()).toEqual([100, 200, 400, 800, 800]);
    expect(terminalSources()).toHaveLength(6);
    stop();
  });

  test("by default the first retry is no slower than the old fixed 2 s and the ladder caps at 16 s", async () => {
    console.warn = mock(() => undefined);
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const timers = manualTimers();
    const api = createBrowserGatewayApi({ eventReconnectRandom: TOP_OF_RANGE });
    const stop = api.listen("terminal-output-a", () => undefined);
    await flushMicrotasks();

    for (const delay of [2_000, 4_000, 8_000, 16_000, 16_000]) {
      terminalSources().at(-1)!.fail();
      timers.fire(delay);
      await flushMicrotasks();
    }

    expect(timers.delays()).toEqual([2_000, 4_000, 8_000, 16_000, 16_000]);
    stop();
  });

  test("jitter spreads two tabs that lose their shared terminal streams at the same instant", async () => {
    console.warn = mock(() => undefined);
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const timers = manualTimers();
    const samples = (values: number[]) => () => values.shift() ?? 0;
    const firstTab = createBrowserGatewayApi({
      eventReconnectDelayMs: 1_000,
      eventReconnectRandom: samples([0.1, 0.8, 0.3]),
    });
    const secondTab = createBrowserGatewayApi({
      eventReconnectDelayMs: 1_000,
      eventReconnectRandom: samples([0.9, 0.2, 0.7]),
    });
    const stopFirst = firstTab.listen("terminal-output-a", () => undefined);
    const stopSecond = secondTab.listen("terminal-output-a", () => undefined);
    await flushMicrotasks();

    const ladders: number[][] = [[], []];
    for (let failure = 0; failure < 3; failure += 1) {
      const [first, second] = terminalSources().slice(-2);
      first!.fail();
      second!.fail();
      const [firstDelay, secondDelay] = timers.pendingDelays();
      ladders[0]!.push(firstDelay!);
      ladders[1]!.push(secondDelay!);
      timers.fire(firstDelay!);
      timers.fire(secondDelay!);
      await flushMicrotasks();
    }

    // Equal jitter: each rung is drawn from [base / 2, base], independently
    // per tab, so the two no longer retry in lock-step.
    expect(ladders).toEqual([
      [550, 1_800, 2_600],
      [950, 1_200, 3_400],
    ]);
    stopFirst();
    stopSecond();
  });

  test("only a shared stream that stayed open for 30 s resets the ladder", async () => {
    console.warn = mock(() => undefined);
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const timers = manualTimers();
    let now = 0;
    const api = createBrowserGatewayApi({
      eventReconnectDelayMs: 100,
      eventReconnectMaxDelayMs: 800,
      eventReconnectRandom: TOP_OF_RANGE,
      eventReconnectNow: () => now,
    });
    const payloads: unknown[] = [];
    const stop = api.listen("terminal-output-a", (payload) => payloads.push(payload));
    await flushMicrotasks();

    terminalSources().at(-1)!.fail();
    timers.fire(100);
    await flushMicrotasks();
    terminalSources().at(-1)!.fail();
    timers.fire(200);
    await flushMicrotasks();

    // Up for just under the healthy window: still the same outage.
    terminalSources().at(-1)!.open();
    now += 29_999;
    terminalSources().at(-1)!.fail();
    timers.fire(400);
    await flushMicrotasks();

    // Up for the whole window: the next loss is a first failure again.
    terminalSources().at(-1)!.open();
    now += 30_000;
    terminalSources().at(-1)!.fail();

    expect(timers.delays()).toEqual([100, 200, 400, 100]);
    // The second open was a reopen, so it still asked for a snapshot.
    expect(payloads).toEqual([{ desynced: true }]);
    stop();
  });

  describe("rebuilding an open shared stream for a new filter", () => {
    /** Two failures in, with the third socket open at `now = 0`. */
    async function openAfterTwoFailures() {
      console.warn = mock(() => undefined);
      MockEventSource.instances = [];
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const timers = manualTimers();
      const clock = { now: 0 };
      const api = createBrowserGatewayApi({
        eventReconnectDelayMs: 100,
        eventReconnectMaxDelayMs: 800,
        eventReconnectRandom: TOP_OF_RANGE,
        eventReconnectNow: () => clock.now,
      });
      const stopA = api.listen("terminal-output-a", () => undefined);
      await flushMicrotasks();
      terminalSources().at(-1)!.fail();
      timers.fire(100);
      await flushMicrotasks();
      terminalSources().at(-1)!.fail();
      timers.fire(200);
      await flushMicrotasks();
      terminalSources().at(-1)!.open();
      return { api, timers, clock, stopA };
    }

    test("a replacement that never opens does not inherit its predecessor's uptime", async () => {
      const { api, timers, clock, stopA } = await openAfterTwoFailures();

      clock.now += 5_000;
      const stopB = api.listen("terminal-output-b", () => undefined);
      await flushMicrotasks();
      expect(terminalSources()).toHaveLength(4);
      expect(terminalSources()[2]!.closed).toBe(true);

      // Still connecting well past 30 s after the predecessor opened.
      clock.now += 26_000;
      terminalSources().at(-1)!.fail();

      expect(timers.delays()).toEqual([100, 200, 400]);
      stopB();
      stopA();
    });

    test("a replacement that opens only briefly does not combine with its predecessor's uptime", async () => {
      const { api, timers, clock, stopA } = await openAfterTwoFailures();

      clock.now += 5_000;
      const stopB = api.listen("terminal-output-b", () => undefined);
      await flushMicrotasks();

      // Connecting for 15 s, then open for 20 s: no single socket reached 30 s.
      clock.now += 15_000;
      terminalSources().at(-1)!.open();
      clock.now += 20_000;
      terminalSources().at(-1)!.fail();

      expect(timers.delays()).toEqual([100, 200, 400]);
      stopB();
      stopA();
    });

    test("a predecessor that had already stayed open for 30 s still resets the ladder", async () => {
      const { api, timers, clock, stopA } = await openAfterTwoFailures();

      clock.now += 30_000;
      const stopB = api.listen("terminal-output-b", () => undefined);
      await flushMicrotasks();
      terminalSources().at(-1)!.fail();

      expect(timers.delays()).toEqual([100, 200, 100]);
      stopB();
      stopA();
    });
  });

  test("narrowing waits for a dead shared stream's retry; a new terminal or a Reconnect does not", async () => {
    console.warn = mock(() => undefined);
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const timers = manualTimers();
    const api = createBrowserGatewayApi({
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
    });
    const stopA = api.listen("terminal-output-a", () => undefined);
    const stopB = api.listen("terminal-output-b", () => undefined);
    await flushMicrotasks();
    terminalSources()[0]!.open();
    terminalSources()[0]!.fail();
    expect(timers.pendingDelays()).toEqual([100]);

    // Closing a terminal only narrows the filter; the pending rebuild covers it.
    stopB();
    await flushMicrotasks();
    expect(terminalSources()).toHaveLength(1);
    expect(timers.pendingDelays()).toEqual([100]);

    // A newly mounted terminal has no output until a socket carries it.
    const stopC = api.listen("terminal-output-c", () => undefined);
    await flushMicrotasks();
    expect(terminalSources()).toHaveLength(2);
    expect(terminalSources()[1]!.terminalEvents).toEqual([
      "terminal-output-a",
      "terminal-output-c",
    ]);
    expect(timers.pendingDelays()).toEqual([]);

    // That early attempt did not reset the ladder.
    terminalSources()[1]!.fail();
    expect(timers.pendingDelays()).toEqual([200]);

    // The user's Reconnect re-listens, which is a new stream: rebuild now.
    stopA();
    await flushMicrotasks();
    expect(terminalSources()).toHaveLength(2);
    const stopAgain = api.listen("terminal-output-a", () => undefined);
    await flushMicrotasks();
    expect(terminalSources()).toHaveLength(3);
    expect(terminalSources()[2]!.terminalEvents).toEqual([
      "terminal-output-a",
      "terminal-output-c",
    ]);

    stopAgain();
    stopC();
  });

  test("a terminal WebSocket asking for fallback again does not hurry a dead shared stream", async () => {
    console.warn = mock(() => undefined);
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    // The same-origin socket address comes from the document, so it needs one.
    const happyWindow = window as unknown as { happyDOM: { setURL(url: string): void } };
    happyWindow.happyDOM.setURL("http://localhost:1420/");
    const timers = manualTimers();
    const api = createBrowserGatewayApi({
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
      terminalTransport: "websocket",
      terminalWebSocketReconnectDelayMs: 7,
      terminalWebSocketFactory: () => {
        throw new Error("WebSocket blocked");
      },
    });
    const stop = api.listen("terminal-output-a", () => undefined);
    await flushMicrotasks();
    terminalSources()[0]!.fail();
    expect(timers.pendingDelays().sort((a, b) => a - b)).toEqual([7, 100]);

    // Each failed socket attempt asks for the fallback again.
    timers.fire(7);
    await flushMicrotasks();
    timers.fire(14);
    await flushMicrotasks();
    expect(terminalSources()).toHaveLength(1);

    timers.fire(100);
    await flushMicrotasks();
    expect(terminalSources()).toHaveLength(2);
    stop();
  });

  test("removing the last terminal cancels the pending retry and the next one starts a fresh ladder", async () => {
    console.warn = mock(() => undefined);
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const timers = manualTimers();
    const api = createBrowserGatewayApi({
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
    });
    const stopA = api.listen("terminal-output-a", () => undefined);
    await flushMicrotasks();
    terminalSources()[0]!.fail();
    timers.fire(100);
    await flushMicrotasks();
    terminalSources()[1]!.fail();
    expect(timers.pendingDelays()).toEqual([200]);

    stopA();
    await flushMicrotasks();
    expect(timers.pendingDelays()).toEqual([]);

    const stopB = api.listen("terminal-output-b", () => undefined);
    await flushMicrotasks();
    terminalSources()[2]!.fail();
    expect(timers.pendingDelays()).toEqual([100]);
    stopB();
  });

  test("the main stream reopening retries a waiting shared terminal stream at once, keeping its ladder", async () => {
    console.warn = mock(() => undefined);
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const timers = manualTimers();
    const api = createBrowserGatewayApi({
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
    });
    const stopMain = api.listen("changed", () => undefined);
    const stopTerminal = api.listen("terminal-output-a", () => undefined);
    await flushMicrotasks();
    const main = MockEventSource.instances.find((source) => source.terminalEvents === null)!;
    terminalSources()[0]!.fail();
    timers.fire(100);
    await flushMicrotasks();
    terminalSources()[1]!.fail();
    expect(timers.pendingDelays()).toEqual([200]);

    main.open();
    await flushMicrotasks();
    expect(timers.pendingDelays()).toEqual([]);
    expect(terminalSources()).toHaveLength(3);

    terminalSources()[2]!.fail();
    expect(timers.pendingDelays()).toEqual([400]);
    stopTerminal();
    stopMain();
  });

  test("each direct terminal stream keeps its own ladder, and re-listening starts a fresh one at once", async () => {
    console.warn = mock(() => undefined);
    const requests: string[] = [];
    globalThis.fetch = mock(async (input) => {
      const url = new URL(String(input));
      requests.push(url.searchParams.get("includeEvents") ?? "main");
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch;
    const timers = manualTimers();
    const api = createBrowserGatewayApi({
      ...DIRECT,
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
    });
    const requestsFor = (event: string) => requests.filter((value) => value === event).length;

    const stopA = api.listen("terminal-output-a", () => undefined);
    await until(() => timers.pendingDelays().length === 1, "terminal a did not schedule a retry");
    timers.fire(100);
    await until(() => timers.pendingDelays()[0] === 200, "terminal a did not back off");
    timers.fire(200);
    await until(() => timers.pendingDelays()[0] === 400, "terminal a did not back off again");

    // Another terminal is its own owner: a's outage history does not slow it.
    const stopB = api.listen("terminal-output-b", () => undefined);
    await until(() => timers.pendingDelays().length === 2, "terminal b did not schedule a retry");
    expect(timers.pendingDelays().sort((a, b) => a - b)).toEqual([100, 400]);

    // The user's Reconnect re-listens: one attempt now, then a fresh ladder.
    stopA();
    expect(timers.pendingDelays()).toEqual([100]);
    const stopAgain = api.listen("terminal-output-a", () => undefined);
    expect(requestsFor("terminal-output-a")).toBe(4);
    await until(() => timers.pendingDelays().length === 2, "re-listened a did not schedule");
    expect(timers.pendingDelays()).toEqual([100, 100]);
    expect(requestsFor("main")).toBe(0);

    stopAgain();
    stopB();
    expect(timers.pendingDelays()).toEqual([]);
  });

  test("only a direct terminal stream that stayed open for 30 s resets its ladder", async () => {
    console.warn = mock(() => undefined);
    const responses: Array<() => Response> = [
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 503 }),
    ];
    let drop: () => void = () => {};
    let requests = 0;
    globalThis.fetch = mock(async () => {
      requests += 1;
      const next = responses.shift();
      if (next) return next();
      const open = openTerminalResponse();
      drop = open.drop;
      return open.response;
    }) as unknown as typeof fetch;
    const timers = manualTimers();
    let now = 0;
    const api = createBrowserGatewayApi({
      ...DIRECT,
      eventReconnectDelayMs: 100,
      eventReconnectMaxDelayMs: 800,
      eventReconnectRandom: TOP_OF_RANGE,
      eventReconnectNow: () => now,
    });
    const payloads: unknown[] = [];
    const stop = api.listen("terminal-output-a", (payload) => payloads.push(payload));

    await until(() => timers.pendingDelays()[0] === 100, "no first retry");
    timers.fire(100);
    await until(() => timers.pendingDelays()[0] === 200, "no second retry");
    timers.fire(200);
    await api.eventStreamReady("terminal-output-a");

    // Up for just under the healthy window: still the same outage.
    now += 29_999;
    drop();
    await until(() => timers.pendingDelays()[0] === 400, "a short-lived stream reset the ladder");
    timers.fire(400);
    await until(() => payloads.length === 1, "the reopen did not announce a desync");
    expect(payloads).toEqual([{ desynced: true }]);

    // Up for the whole window: the next loss is a first failure again.
    now += 30_000;
    drop();
    await until(() => timers.pendingDelays().length === 1, "the healthy stream did not retry");
    expect(timers.delays()).toEqual([100, 200, 400, 100]);
    expect(requests).toBe(4);
    stop();
  });

  test("a terminal WebSocket asking for fallback again does not hurry a direct stream's retry", async () => {
    console.warn = mock(() => undefined);
    let terminalRequests = 0;
    globalThis.fetch = mock(async () => {
      terminalRequests += 1;
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch;
    const timers = manualTimers();
    const api = createBrowserGatewayApi({
      ...DIRECT,
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
      terminalTransport: "websocket",
      terminalWebSocketReconnectDelayMs: 7,
      terminalWebSocketFactory: () => {
        throw new Error("WebSocket blocked");
      },
    });
    const stop = api.listen("terminal-output-a", () => undefined);
    await until(() => timers.pendingDelays().includes(100), "the fallback did not schedule");

    // Each failed socket attempt asks for the fallback again.
    timers.fire(7);
    await flushMicrotasks();
    timers.fire(14);
    await flushMicrotasks();
    expect(terminalRequests).toBe(1);

    timers.fire(100);
    await until(() => terminalRequests === 2, "the backed-off retry did not run");
    stop();
  });

  test("the main stream reopening retries waiting direct terminal streams at once, keeping their ladders", async () => {
    console.warn = mock(() => undefined);
    let mainAttempts = 0;
    let terminalRequests = 0;
    globalThis.fetch = mock(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.has("includeEvents")) {
        terminalRequests += 1;
        return new Response(null, { status: 503 });
      }
      mainAttempts += 1;
      if (mainAttempts === 1) return new Response(null, { status: 503 });
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const timers = manualTimers();
    const api = createBrowserGatewayApi({
      ...DIRECT,
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
    });
    const stopTerminal = api.listen("terminal-output-a", () => undefined);
    await until(() => timers.pendingDelays()[0] === 100, "terminal did not schedule");
    timers.fire(100);
    await until(() => timers.pendingDelays()[0] === 200, "terminal did not back off");

    const stopMain = api.listen("changed", () => undefined);
    await until(() => timers.pendingDelays().length === 2, "main stream did not schedule");
    timers.fire(100);
    await until(() => terminalRequests === 3, "the main stream did not hurry the terminal");
    expect(mainAttempts).toBe(2);

    // The early attempt failed too, so it waits for the next rung.
    await until(() => timers.pendingDelays().includes(400), "the ladder was reset");
    expect(timers.pendingDelays()).toEqual([400]);
    stopTerminal();
    stopMain();
  });
});

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Direct-mode fetch that fails every stream and counts main and terminal requests. */
function failingDirectStreams() {
  const counts = { main: 0, terminal: 0 };
  globalThis.fetch = mock(async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/events")) return new Response(null, { status: 404 });
    if (url.searchParams.has("includeEvents")) counts.terminal += 1;
    else counts.main += 1;
    return new Response(null, { status: 503 });
  }) as unknown as typeof fetch;
  return counts;
}

describe("gateway streams waiting out a backoff when the tab or network comes back", () => {
  test("a visible tab retries the waiting main stream and terminal at once, keeping their ladders", async () => {
    console.warn = mock(() => undefined);
    const counts = failingDirectStreams();
    const timers = manualTimers();
    const api = createBrowserGatewayApi({
      ...DIRECT,
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
    });
    const stopTerminal = api.listen("terminal-output-a", () => undefined);
    const stopMain = api.listen("changed", () => undefined);
    await until(() => timers.pendingDelays().length === 2, "both streams did not schedule");
    expect(counts).toEqual({ main: 1, terminal: 1 });

    // Hiding the tab or losing the network is not a reason to try sooner.
    setVisibility("hidden");
    window.dispatchEvent(new Event("offline"));
    await flushMicrotasks();
    expect(counts).toEqual({ main: 1, terminal: 1 });
    expect(timers.pendingDelays()).toEqual([100, 100]);

    setVisibility("visible");
    expect(counts).toEqual({ main: 2, terminal: 2 });
    expect(timers.pendingDelays()).toEqual([]);

    // Both early attempts failed, so each waits for its next step.
    await until(() => timers.pendingDelays().length === 2, "the early attempts did not reschedule");
    expect(timers.pendingDelays()).toEqual([200, 200]);
    stopTerminal();
    stopMain();
  });

  test("coming back online retries the waiting shared terminal stream and main stream at once", async () => {
    console.warn = mock(() => undefined);
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const timers = manualTimers();
    const api = createBrowserGatewayApi({
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
    });
    const mainSources = () =>
      MockEventSource.instances.filter((source) => source.terminalEvents === null);
    const stopMain = api.listen("changed", () => undefined);
    const stopTerminal = api.listen("terminal-output-a", () => undefined);
    await flushMicrotasks();
    mainSources()[0]!.fail();
    terminalSources()[0]!.fail();
    expect(timers.pendingDelays()).toEqual([100, 100]);

    window.dispatchEvent(new Event("online"));
    await flushMicrotasks();
    expect(mainSources()).toHaveLength(2);
    expect(terminalSources()).toHaveLength(2);
    expect(timers.pendingDelays()).toEqual([]);

    mainSources()[1]!.fail();
    terminalSources()[1]!.fail();
    expect(timers.pendingDelays()).toEqual([200, 200]);
    stopTerminal();
    stopMain();
  });

  test("nothing reconnects on visible or online when no stream is waiting", async () => {
    console.warn = mock(() => undefined);
    const counts = { main: 0, terminal: 0 };
    globalThis.fetch = mock(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.has("includeEvents")) counts.terminal += 1;
      else counts.main += 1;
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const timers = manualTimers();
    const api = createBrowserGatewayApi({ ...DIRECT, eventReconnectDelayMs: 100 });
    const stopTerminal = api.listen("terminal-output-a", () => undefined);
    const stopMain = api.listen("changed", () => undefined);
    await api.eventStreamReady("terminal-output-a");
    await flushMicrotasks();
    expect(counts).toEqual({ main: 1, terminal: 1 });

    setVisibility("visible");
    window.dispatchEvent(new Event("online"));
    await flushMicrotasks();

    expect(counts).toEqual({ main: 1, terminal: 1 });
    expect(timers.delays()).toEqual([]);
    stopTerminal();
    stopMain();
  });

  test("disposing the gateway removes its visibility and online listeners", async () => {
    console.warn = mock(() => undefined);
    const counts = failingDirectStreams();
    const timers = manualTimers();
    const addToDocument = spyOn(document, "addEventListener");
    const removeFromDocument = spyOn(document, "removeEventListener");
    const addToWindow = spyOn(window, "addEventListener");
    const removeFromWindow = spyOn(window, "removeEventListener");
    const gatewayWindow = {
      location: { protocol: "http:" },
      orkestrator: undefined,
      orkestratorGateway: undefined,
    } as unknown as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">;
    try {
      installBrowserGatewayApi(gatewayWindow, {
        ...DIRECT,
        agentTestSessionActivity: false,
        eventReconnectDelayMs: 100,
        eventReconnectRandom: TOP_OF_RANGE,
      });
      const visibilityListener = addToDocument.mock.calls.find(
        ([type]) => type === "visibilitychange",
      )?.[1];
      const onlineListener = addToWindow.mock.calls.find(([type]) => type === "online")?.[1];
      expect(visibilityListener).toBeDefined();
      expect(onlineListener).toBeDefined();

      const replaced = gatewayWindow.orkestrator!;
      replaced.listen("changed", () => undefined);
      await until(() => timers.pendingDelays().includes(100), "the main stream did not schedule");
      // Live before disposal, so the check after it proves removal.
      window.dispatchEvent(new Event("online"));
      expect(counts.main).toBe(2);
      await until(
        () => timers.pendingDelays().includes(200),
        "the early attempt did not reschedule",
      );

      installBrowserGatewayApi(gatewayWindow, {
        ...DIRECT,
        agentTestSessionActivity: false,
        replaceExisting: true,
      });
      expect(removeFromDocument).toHaveBeenCalledWith("visibilitychange", visibilityListener);
      expect(removeFromWindow).toHaveBeenCalledWith("online", onlineListener);

      setVisibility("visible");
      window.dispatchEvent(new Event("online"));
      await flushMicrotasks();
      expect(counts.main).toBe(2);
    } finally {
      addToDocument.mockRestore();
      removeFromDocument.mockRestore();
      addToWindow.mockRestore();
      removeFromWindow.mockRestore();
    }
  });
});

describe("gateway main stream connection state", () => {
  test("a same-origin stream reports connected, disconnected while the browser retries, and idle when unused", async () => {
    console.warn = mock(() => undefined);
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const timers = manualTimers();
    const api = createBrowserGatewayApi({
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
    });
    const states: string[] = [];
    const unsubscribeState = api.eventStreamConnection.subscribe((state) => states.push(state));
    // Observing the state never opens a stream.
    expect(api.eventStreamConnection.state()).toBe("idle");
    expect(MockEventSource.instances).toHaveLength(0);

    const stop = api.listen("changed", () => undefined);
    const main = () => MockEventSource.instances.filter((s) => s.terminalEvents === null).at(-1)!;
    expect(api.eventStreamConnection.state()).toBe("connecting");
    main().open();
    expect(api.eventStreamConnection.state()).toBe("connected");

    // A recoverable error: the browser keeps the socket CONNECTING and retries.
    main().readyState = EVENT_SOURCE_CONNECTING;
    main().onerror?.();
    expect(api.eventStreamConnection.state()).toBe("disconnected");
    main().open();
    expect(api.eventStreamConnection.state()).toBe("connected");

    // A fatal error: still disconnected through the backed-off retry...
    main().fail();
    expect(api.eventStreamConnection.state()).toBe("disconnected");
    timers.fire(100);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(api.eventStreamConnection.state()).toBe("disconnected");
    // ...until the retry opens.
    main().open();
    expect(api.eventStreamConnection.state()).toBe("connected");

    stop();
    expect(api.eventStreamConnection.state()).toBe("idle");
    expect(states).toEqual([
      "connecting",
      "connected",
      "disconnected",
      "connected",
      "disconnected",
      "connected",
      "idle",
    ]);
    unsubscribeState();
  });

  test("a direct stream reports disconnected across failed retries until one opens", async () => {
    console.warn = mock(() => undefined);
    let drop: (() => void) | null = null;
    let eventRequests = 0;
    globalThis.fetch = mock(async (input) => {
      if (!String(input).includes(EVENTS_PATH)) return new Response(null, { status: 404 });
      eventRequests += 1;
      if (eventRequests === 1) {
        const open = openTerminalResponse();
        drop = open.drop;
        return open.response;
      }
      if (eventRequests === 2) return new Response(null, { status: 503 });
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const timers = manualTimers();
    const api = createBrowserGatewayApi({
      ...DIRECT,
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
    });
    const stop = api.listen("changed", () => undefined);
    try {
      await until(
        () => api.eventStreamConnection.state() === "connected",
        "the stream did not connect",
      );
      drop!();
      await until(
        () => api.eventStreamConnection.state() === "disconnected",
        "the dropped stream was not reported",
      );
      timers.fire(100);
      await until(
        () => timers.pendingDelays().includes(200),
        "the failed retry did not reschedule",
      );
      expect(api.eventStreamConnection.state()).toBe("disconnected");
      timers.fire(200);
      await until(
        () => api.eventStreamConnection.state() === "connected",
        "the retry did not reconnect",
      );
    } finally {
      stop();
    }
    expect(api.eventStreamConnection.state()).toBe("idle");
  });
});

test("replacing a disconnected gateway reports idle and clears its state listeners", () => {
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  const target = { location: { protocol: "https:" } } as Pick<
    Window,
    "location" | "orkestrator" | "orkestratorGateway"
  >;
  installBrowserGatewayApi(target);
  const old = target.orkestrator!;
  const states: string[] = [];
  const stopState = old.eventStreamConnection!.subscribe((state) => states.push(state));
  const stop = old.listen("changed", () => undefined);
  const main = MockEventSource.instances[0]!;
  main.open();
  main.readyState = EVENT_SOURCE_CONNECTING;
  main.onerror?.();
  expect(old.eventStreamConnection!.state()).toBe("disconnected");

  installBrowserGatewayApi(target, { replaceExisting: true });
  expect(old.eventStreamConnection!.state()).toBe("idle");
  expect(states).toEqual(["connecting", "connected", "disconnected", "idle"]);
  const stateCount = states.length;
  // Trigger a state change on the old adapter after replacement: its observers
  // must already have been removed, even if a transport callback arrives late.
  main.open();
  stop();
  expect(states).toHaveLength(stateCount);
  const next = target.orkestrator!;
  expect(next.eventStreamConnection!.state()).toBe("idle");
  const stopNext = next.listen("changed", () => undefined);
  MockEventSource.instances.at(-1)!.open();
  expect(next.eventStreamConnection!.state()).toBe("connected");
  expect(states).toHaveLength(stateCount);
  stopNext();
  stopState();
});
