import { afterEach, describe, expect, mock, test } from "bun:test";
import { createBrowserGatewayApi } from "./web-gateway";
import { clearDirectGatewayTransport } from "./gateway-auth-transport";

/**
 * The gateway's main event stream reconnect policy: consecutive failures back
 * off with capped jitter from the configured first delay, there is only ever
 * one pending reconnect, and every attempt still resumes from the cursor.
 */
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalWarn = console.warn;

afterEach(() => {
  clearDirectGatewayTransport();
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  console.warn = originalWarn;
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
