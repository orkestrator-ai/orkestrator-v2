import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createBrowserGatewayApi } from "./web-gateway";
import { clearDirectGatewayTransport } from "./gateway-auth-transport";

const originalFetch = globalThis.fetch;
const restorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore();
  globalThis.fetch = originalFetch;
  clearDirectGatewayTransport();
});

async function flush() {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

/** Advance the gateway's own clock and drive its timers without wall-clock races. */
function clock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { run: () => void; delay: number }>();
  const intervals = new Map<number, () => void>();
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
    run: () => void,
    delay = 0,
  ) => {
    const id = nextId++;
    timers.set(id, { run, delay });
    return id;
  }) as typeof setTimeout);
  const clearTimeout = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
    timers.delete(id);
  }) as typeof globalThis.clearTimeout);
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((run: () => void) => {
    const id = nextId++;
    intervals.set(id, run);
    return id;
  }) as typeof setInterval);
  const clearInterval = spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => {
    intervals.delete(id);
  }) as typeof globalThis.clearInterval);
  restorers.push(() => {
    timeout.mockRestore();
    clearTimeout.mockRestore();
    interval.mockRestore();
    clearInterval.mockRestore();
  });
  return {
    now: () => now,
    silence() {
      now += 1000;
      for (const run of intervals.values()) run();
    },
    fire(delay: number) {
      const timer = [...timers].find(([, value]) => value.delay === delay);
      if (!timer) throw new Error(`No ${delay} ms timer`);
      timers.delete(timer[0]);
      timer[1].run();
    },
  };
}

class Socket {
  readyState: number = WebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
  ready() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "ready", version: 1, socketId: "fixture" }) });
    const request = this.sent.find((frame) => frame.type === "subscribe")!;
    this.onmessage?.({
      data: JSON.stringify({
        type: "subscribed",
        requestId: request.requestId,
        sessionId: "one",
        channelId: 1,
        baseGeneration: 1,
        baseRevision: 0,
        targetGeneration: 1,
        targetRevision: 0,
        recovery: "current",
      }),
    });
  }
}

for (const transport of ["http-sse", "websocket"] as const) {
  test(`direct ${transport} replaces an unanswered terminal fallback when the main stream recovers`, async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    restorers.push(() => warn.mockRestore());
    const timers = clock();
    const mains: Array<{ signal: AbortSignal; resolve(response: Response): void }> = [];
    const terminals: Array<{ signal: AbortSignal; resolve(response: Response): void }> = [];
    const sockets: Socket[] = [];
    globalThis.fetch = mock((input: unknown, init?: RequestInit) => {
      const attempts = new URL(String(input)).searchParams.has("includeEvents") ? terminals : mains;
      return new Promise<Response>((resolve, reject) => {
        attempts.push({ signal: init!.signal!, resolve });
        init!.signal!.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://gateway.test",
      token: "direct-token-123456",
      terminalTransport: transport,
      terminalWebSocketFactory: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      terminalWebSocketReconnectDelayMs: 7,
      eventReconnectDelayMs: 100,
      eventReconnectRandom: () => 0.999999,
      eventReconnectNow: timers.now,
      eventStreamSilenceLimitMs: 1000,
      eventStreamConnectTimeoutMs: 1000,
    });
    const output = mock(() => undefined);
    const stopMain = api.listen("changed", () => undefined);
    const stopTerminal = api.listen("terminal-output-one", output);
    const open = () => new Response(new ReadableStream({ start() {} }));
    try {
      mains[0]!.resolve(open());
      terminals[0]!.resolve(open());
      await flush();
      await api.eventStreamReady("terminal-output-one");
      if (transport === "websocket") {
        // An open fallback upgrades to a ready channel before the silent outage.
        sockets[0]!.ready();
        await flush();
        expect(terminals[0]!.signal.aborted).toBe(true);
      }
      timers.silence();
      await flush();
      expect(mains[0]!.signal.aborted).toBe(true);
      expect(terminals[0]!.signal.aborted).toBe(true);
      if (transport === "websocket") {
        expect(sockets[0]!.readyState).toBe(WebSocket.CLOSED);
        timers.fire(7);
        // The reconnecting socket also gets no answer while the link is down.
        expect(sockets).toHaveLength(2);
      } else {
        // First the main retry starts, still pending, then the fallback retry.
        timers.fire(100);
        timers.fire(100);
      }
      if (mains.length === 1) timers.fire(100);
      expect(terminals).toHaveLength(2);
      expect(terminals[1]!.signal.aborted).toBe(false);
      mains[1]!.resolve(open());
      await flush();
      expect(api.eventStreamConnection.state()).toBe("connected");
      expect(terminals[1]!.signal.aborted).toBe(true);
      expect(terminals).toHaveLength(3);
      if (transport === "websocket") {
        expect(sockets[1]!.readyState).toBe(WebSocket.CLOSED);
        timers.fire(14);
        expect(sockets).toHaveLength(3);
      }
      // A late response from the superseded request cannot steal the replacement.
      terminals[1]!.resolve(open());
      await flush();
      expect(terminals[2]!.signal.aborted).toBe(false);
      terminals[2]!.resolve(open());
      await flush();
      expect(output).toHaveBeenCalledWith({ desynced: true });
    } finally {
      stopTerminal();
      stopMain();
    }
  });
}

test("unanswered direct terminal attempts keep retrying while the main stream is silent", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  restorers.push(() => warn.mockRestore());
  const timers = clock();
  type Attempt = { signal: AbortSignal; resolve(response: Response): void };
  const mains: Attempt[] = [];
  const terminals: Attempt[] = [];
  globalThis.fetch = mock((input: unknown, init?: RequestInit) => {
    const attempts = new URL(String(input)).searchParams.has("includeEvents") ? terminals : mains;
    return new Promise<Response>((resolve, reject) => {
      attempts.push({ signal: init!.signal!, resolve });
      init!.signal!.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
    });
  }) as unknown as typeof fetch;
  const api = createBrowserGatewayApi({
    baseUrl: "https://gateway.test",
    token: "direct-token-123456",
    eventReconnectDelayMs: 100,
    eventReconnectRandom: () => 0.999999,
    eventReconnectNow: timers.now,
    eventStreamSilenceLimitMs: 1000,
    eventStreamConnectTimeoutMs: 1000,
  });
  const stopMain = api.listen("changed", () => undefined);
  const stopTerminal = api.listen("terminal-output-one", () => undefined);
  const open = () => new Response(new ReadableStream({ start() {} }));
  try {
    mains[0]!.resolve(open());
    terminals[0]!.resolve(open());
    await flush();
    timers.silence();
    await flush();
    timers.fire(100);
    timers.fire(100);
    await flush();
    expect(mains).toHaveLength(2);
    expect(terminals).toHaveLength(2);

    // Neither retry is answered. The next main-stream watchdog expires both,
    // then each owner's ladder schedules a new attempt without a server error.
    timers.silence();
    await flush();
    expect(mains[1]!.signal.aborted).toBe(true);
    expect(terminals[1]!.signal.aborted).toBe(true);
    timers.fire(200);
    timers.fire(200);
    await flush();
    expect(mains).toHaveLength(3);
    expect(terminals).toHaveLength(3);
    expect(terminals[2]!.signal.aborted).toBe(false);

    mains[2]!.resolve(open());
    await flush();
    expect(terminals[2]!.signal.aborted).toBe(true);
    expect(terminals).toHaveLength(4);
    expect(api.eventStreamConnection.state()).toBe("connected");
  } finally {
    stopTerminal();
    stopMain();
  }
});
