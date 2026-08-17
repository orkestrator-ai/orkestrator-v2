import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  createBrowserGatewayApi,
  installBrowserGatewayApi,
  TERMINAL_TRANSPORT_STORAGE_KEY,
} from "./web-gateway";
import { TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES } from "./terminal-input-batcher";
import {
  clearDirectGatewayTransport,
  configureDirectGatewayTransport,
} from "./gateway-auth-transport";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "./events";
import { decodeTerminalBinaryFrame, TERMINAL_BINARY_FRAME_TYPE } from "@orkestrator/protocol/terminal-websocket";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalWebSocket = globalThis.WebSocket;
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalGetEntriesByType = performance.getEntriesByType;
const originalDocumentReadyStateDescriptor = Object.getOwnPropertyDescriptor(document, "readyState");
const originalWebkitDescriptor = Object.getOwnPropertyDescriptor(window, "webkit");
const originalSetTimeout = globalThis.setTimeout;

function pngBlob(width: number, height: number): Blob {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: "image/png" });
}
type TestGatewayWindow = {
  location: Pick<Location, "protocol">;
  orkestrator?: Window["orkestrator"];
  orkestratorGateway?: Window["orkestratorGateway"];
};

const EVENT_SOURCE_CONNECTING = 0;
const EVENT_SOURCE_OPEN = 1;
const EVENT_SOURCE_CLOSED = 2;

function gatewayControlFrame(
  event: "gateway.connected" | "gateway.reconcile-required",
  statusOrReason: string,
  id = "12345678:0",
): string {
  const payload = event === "gateway.connected"
    ? { status: statusOrReason, generation: "12345678", revision: 0 }
    : { reason: statusOrReason, generation: "12345678", latestRevision: 0 };
  return `id: ${id}\ndata: ${JSON.stringify({ event, payload })}\n\n`;
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: ((event?: Event) => void) | null = null;
  onmessage: ((message: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  /**
   * Mirrors the real `EventSource`. A browser retries a `CONNECTING` socket on
   * its own but abandons a `CLOSED` one, and the gateway has to tell those
   * apart to know whether it must rebuild the shared terminal stream itself.
   */
  readyState: number = EVENT_SOURCE_CONNECTING;

  constructor(
    public readonly url: string,
    public readonly options?: EventSourceInit,
  ) {
    MockEventSource.instances.push(this);
  }

  /** Drive a successful connection the way the browser would. */
  open(): void {
    this.readyState = EVENT_SOURCE_OPEN;
    this.onopen?.();
  }

  /** Fail the socket, either recoverably (browser retries) or fatally. */
  fail(readyState: number = EVENT_SOURCE_CLOSED): void {
    this.readyState = readyState;
    this.onerror?.();
  }

  close(): void {
    this.closed = true;
    this.readyState = EVENT_SOURCE_CLOSED;
  }
}

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readonly sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "orkestrator-terminal.v1";
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closeCode: number | undefined;
  closeReason: string | undefined;

  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[],
  ) {
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(data: string | ArrayBuffer | Uint8Array): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("Socket is not open");
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean { return true; }
}

function sentControlFrames(socket: MockWebSocket): Array<Record<string, unknown>> {
  return socket.sent
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.parse(value) as Record<string, unknown>);
}

function decodeSentBinaryFrame(value: ArrayBufferLike | ArrayBufferView) {
  if (value instanceof ArrayBuffer) return decodeTerminalBinaryFrame(value);
  if (ArrayBuffer.isView(value)) {
    return decodeTerminalBinaryFrame(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new TypeError("Unsupported mock WebSocket binary frame");
}

function openTerminalSocket(socket: MockWebSocket): void {
  socket.open();
  socket.receive(JSON.stringify({ type: "ready", version: 1, socketId: "socket-test" }));
}

function subscribeTerminalSocket(
  socket: MockWebSocket,
  sessionId: string,
  recovery: "current" | "snapshot-required" = "snapshot-required",
  channelId = 1,
): number {
  const request = sentControlFrames(socket).findLast((frame) =>
    frame.type === "subscribe" && frame.sessionId === sessionId
  );
  if (!request || typeof request.requestId !== "number") {
    throw new Error(`No subscription request for ${sessionId}`);
  }
  socket.receive(JSON.stringify({
    type: "subscribed",
    requestId: request.requestId,
    sessionId,
    channelId,
    recovery,
    baseGeneration: recovery === "snapshot-required" ? null : 1,
    baseRevision: recovery === "snapshot-required" ? null : 0,
    targetGeneration: 1,
    targetRevision: 0,
  }));
  return channelId;
}

async function waitForCondition(
  condition: () => boolean,
  message = "Condition was not met",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 500;
    const poll = () => {
      if (condition()) return resolve();
      if (Date.now() > deadline) return reject(new Error(message));
      originalSetTimeout(poll, 1);
    };
    poll();
  });
}

beforeEach(() => {
  delete window.orkestrator;
  delete window.orkestratorGateway;
  MockEventSource.instances = [];
  MockWebSocket.instances = [];
  localStorage.removeItem(TERMINAL_TRANSPORT_STORAGE_KEY);
});

afterEach(() => {
  clearDirectGatewayTransport();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  globalThis.WebSocket = originalWebSocket;
  localStorage.removeItem(TERMINAL_TRANSPORT_STORAGE_KEY);
  Object.defineProperty(performance, "getEntriesByType", {
    configurable: true,
    value: originalGetEntriesByType,
  });
  if (originalDocumentReadyStateDescriptor) {
    Object.defineProperty(document, "readyState", originalDocumentReadyStateDescriptor);
  } else {
    Reflect.deleteProperty(document, "readyState");
  }
  if (originalWebkitDescriptor) {
    Object.defineProperty(window, "webkit", originalWebkitDescriptor);
  } else {
    delete (window as Window & { webkit?: unknown }).webkit;
  }
  globalThis.setTimeout = originalSetTimeout;
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  }
  delete window.__orkestratorClientPlatform;
  delete window.orkestrator;
  delete window.orkestratorGateway;
  mock.restore();
});

describe("web gateway browser API", () => {
  test("renews agent-test sessions only after explicit browser activity", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const lapsed = mock(() => undefined);
    globalThis.fetch = mock(async (input, init) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method });
      return method === "GET"
        ? new Response(JSON.stringify({ active: true }), { status: 200 })
        : new Response(null, { status: 401 });
    }) as unknown as typeof fetch;

    createBrowserGatewayApi({ agentTestSessionActivity: true, onCredentialLapsed: lapsed });
    await waitForCondition(() => calls.length === 1, "Agent-test session was not detected");
    expect(calls).toEqual([{ url: "/__orkestrator/agent-test/session", method: "GET" }]);

    window.dispatchEvent(new Event("pointerdown"));
    await waitForCondition(() => calls.length === 2, "Explicit activity did not renew the session");
    expect(calls[1]).toEqual({ url: "/__orkestrator/agent-test/session", method: "POST" });

    // A 401 renewal is a lapsed session, so the tab is sent to the login page
    // rather than left rendering stale state, and both listeners come off so
    // unrelated later activity cannot become a background keepalive loop.
    await waitForCondition(() => lapsed.mock.calls.length === 1, "Lapsed session was not surfaced");
    window.dispatchEvent(new Event("keydown"));
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    expect(lapsed).toHaveBeenCalledTimes(1);
  });

  test("surfaces a lapsed agent-test session detected by a command rather than by activity", async () => {
    // The idle deadline can pass with no keyboard or pointer activity at all, so
    // the authoritative signal is a 401 from a command the tab was already making.
    const lapsed = mock(() => undefined);
    let probes = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (!String(input).includes("/agent-test/session")) {
        return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 });
      }
      probes += 1;
      return new Response(JSON.stringify({ active: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const api = createBrowserGatewayApi({
      agentTestSessionActivity: true,
      onCredentialLapsed: lapsed,
    });
    await waitForCondition(() => probes === 1, "Agent-test session was not detected");

    await expect(api.invoke("list_projects")).rejects.toThrow("Authentication required");
    expect(lapsed).toHaveBeenCalledTimes(1);
    // Recovery happens once; a burst of failing commands must not fight over it.
    await expect(api.invoke("list_projects")).rejects.toThrow("Authentication required");
    expect(lapsed).toHaveBeenCalledTimes(1);
  });

  test("leaves a client with no agent-test session alone when a command returns 401", async () => {
    // A durable-token client has no deadline to trip, so a 401 there is not a
    // lapsed session and must not navigate the tab away from the app.
    const lapsed = mock(() => undefined);
    let probes = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (!String(input).includes("/agent-test/session")) {
        return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 });
      }
      probes += 1;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const api = createBrowserGatewayApi({
      agentTestSessionActivity: true,
      onCredentialLapsed: lapsed,
    });
    await waitForCondition(() => probes === 1, "Agent-test session probe did not run");

    await expect(api.invoke("list_projects")).rejects.toThrow("Authentication required");
    expect(lapsed).not.toHaveBeenCalled();
  });

  test("probes for an agent-test session only when served by a development profile", async () => {
    // Every production gateway client runs this install path. Probing there would
    // spend a request per boot on a route that is always 404. Under Bun
    // `import.meta.env` aliases `process.env`, so the profile signal is set here
    // rather than inherited from whatever shell happens to run the suite.
    const previousProfile = process.env.VITE_ORKESTRATOR_PROFILE;
    const install = async () => {
      const probed: string[] = [];
      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        if (String(input).includes("/agent-test/session")) probed.push(String(input));
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch;
      const fakeWindow: TestGatewayWindow = {
        location: { protocol: "http:" },
        orkestrator: undefined,
        orkestratorGateway: undefined,
      };
      installBrowserGatewayApi(
        fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(fakeWindow.orkestrator).toBeDefined();
      return probed;
    };

    try {
      delete process.env.VITE_ORKESTRATOR_PROFILE;
      expect(await install()).toHaveLength(0);

      process.env.VITE_ORKESTRATOR_PROFILE = "agent-probe-qa";
      expect(await install()).toHaveLength(1);
    } finally {
      if (previousProfile === undefined) delete process.env.VITE_ORKESTRATOR_PROFILE;
      else process.env.VITE_ORKESTRATOR_PROFILE = previousProfile;
    }
  });

  test("disposing a gateway stops its agent-test activity renewals", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = mock(async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ active: true }), { status: 200 });
    }) as unknown as typeof fetch;
    // Boot metrics also POST from this install path, so every assertion below is
    // scoped to the session route rather than to the method alone.
    const sessionCalls = (method: string) => calls.filter((call) => (
      call.url.includes("/agent-test/session") && call.method === method
    ));
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "http:" },
      orkestrator: undefined,
      orkestratorGateway: undefined,
    };
    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      { agentTestSessionActivity: true },
    );
    // Prove the listener is live before disposing, so a passing assertion after
    // the replacement cannot just mean it was never attached. The probe attaches
    // a microtask after its GET resolves and `waitForCondition` checks
    // synchronously first, so the event is redispatched until it lands; the
    // renewal throttle keeps that to a single POST.
    await waitForCondition(() => {
      window.dispatchEvent(new Event("pointerdown"));
      return sessionCalls("POST").length === 1;
    }, "Activity did not renew the session");
    expect(sessionCalls("GET")).toHaveLength(1);

    // Replacing the gateway runs its disposer. The old closure's window listeners
    // must come off with it, or a replaced tab keeps renewing a session forever.
    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      { replaceExisting: true },
    );
    window.dispatchEvent(new Event("keydown"));
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionCalls("POST")).toHaveLength(1);
  });

  test("passes through an optional server-connections API", async () => {
    const connectionList = { activeConnectionId: "remote-1", connections: [] };
    const connections = {
      list: mock(async () => connectionList),
      connect: mock(async () => connectionList),
      use: mock(async () => connectionList),
      forget: mock(async () => connectionList),
    };
    const api = createBrowserGatewayApi({ connections });
    expect(api.connections).toBe(connections);
    await expect(api.connections?.list()).resolves.toBe(connectionList);
    expect(createBrowserGatewayApi().connections).toBeUndefined();
  });

  test("installs only when the Electron preload API is absent", () => {
    const existingApi = { invoke: mock(async () => null) } as unknown as Window["orkestrator"];
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "http:" },
      orkestrator: existingApi,
      orkestratorGateway: undefined,
    };

    installBrowserGatewayApi(fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">);

    expect(fakeWindow.orkestrator).toBe(existingApi);
    expect(fakeWindow.orkestratorGateway).toBeUndefined();

    fakeWindow.orkestrator = undefined;
    installBrowserGatewayApi(fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">);

    expect(fakeWindow.orkestratorGateway).toEqual({ enabled: true });
    expect(typeof (fakeWindow.orkestrator as Window["orkestrator"])?.invoke).toBe("function");

    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      {
        baseUrl: "https://workstation.tailnet.ts.net/",
        token: "direct-token-123456",
        replaceExisting: true,
      },
    );
    expect(fakeWindow.orkestratorGateway).toEqual({
      enabled: true,
      baseUrl: "https://workstation.tailnet.ts.net",
    });
  });

  test("does not install the browser gateway on non-HTTP pages", () => {
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "file:" },
      orkestrator: undefined,
      orkestratorGateway: undefined,
    };

    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
    );

    expect(fakeWindow.orkestrator).toBeUndefined();
    expect(fakeWindow.orkestratorGateway).toBeUndefined();
  });

  test("installing a direct client configures scoped bearer transport", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "https:" },
      orkestrator: undefined,
      orkestratorGateway: undefined,
    };

    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      {
        baseUrl: "https://workstation.tailnet.ts.net/",
        token: "direct-token-123456",
      },
    );
    await globalThis.fetch(
      "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback/7777/health",
    );
    await globalThis.fetch("https://example.com/not-the-gateway");

    expect(requests).toEqual([
      {
        url: "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback/7777/health",
        authorization: "Bearer direct-token-123456",
      },
      {
        url: "https://example.com/not-the-gateway",
        authorization: null,
      },
    ]);
  });

  test("enables boot metrics for every installed browser client", async () => {
    // The install path is the only place production turns boot metrics on, so
    // dropping the flag here would disable the feature everywhere.
    const metricsFetch = mock(async (input: RequestInfo | URL) => (
      String(input).includes("/agent-test/session")
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 202 })
    ));
    globalThis.fetch = metricsFetch as unknown as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "https:" },
      orkestrator: undefined,
      orkestratorGateway: undefined,
    };

    installBrowserGatewayApi(fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">);
    const installed = fakeWindow.orkestrator as Window["orkestrator"];
    const stop = installed!.listen("menu-zoom", () => undefined);
    MockEventSource.instances[0]?.open();
    window.dispatchEvent(new Event("load"));
    await waitForCondition(
      () => metricsFetch.mock.calls.some(([input]) => String(input).includes("/client-metrics")),
      "The installed client did not report boot metrics",
    );

    // Explicitly opting out must still be honoured.
    const optedOut = mock(async () => new Response(null, { status: 202 }));
    globalThis.fetch = optedOut as unknown as typeof fetch;
    const quiet = createBrowserGatewayApi({});
    const stopQuiet = quiet.listen("menu-zoom", () => undefined);
    MockEventSource.instances.at(-1)?.open();
    window.dispatchEvent(new Event("load"));
    await new Promise((resolve) => originalSetTimeout(resolve, 5));
    expect(optedOut).toHaveBeenCalledTimes(0);

    stop();
    stopQuiet();
  });

  test("reports boot metrics when the page finished loading before anything subscribed", async () => {
    // The API is constructed at module evaluation, long before the first
    // listen(), so a readyState captured then is stale. If load already fired,
    // a listener registered now never runs and the report would be stranded on
    // the 15s fallback.
    Object.defineProperty(document, "readyState", { configurable: true, value: "loading" });
    const metricsFetch = mock(async () => new Response(null, { status: 202 }));
    globalThis.fetch = metricsFetch as unknown as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    let fallbackScheduled = false;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 15_000) {
        fallbackScheduled = true;
        return 15_000 as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;

    try {
      const api = createBrowserGatewayApi({ reportBootMetrics: true });
      Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });

      const stop = api.listen("menu-zoom", () => undefined);
      MockEventSource.instances[0]?.open();
      await waitForCondition(
        () => metricsFetch.mock.calls.length === 1,
        "Boot metrics were stranded on the 15s fallback",
      );
      expect(fallbackScheduled).toBe(true);
      stop();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("reports through the fallback when the event stream never connects, then stops on teardown", async () => {
    Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
    const metricsFetch = mock(async () => new Response(null, { status: 202 }));
    globalThis.fetch = metricsFetch as unknown as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    let fallback: (() => void) | undefined;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 15_000 && typeof handler === "function") {
        fallback = () => handler(...args);
        return 15_000 as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;

    try {
      const api = createBrowserGatewayApi({ reportBootMetrics: true });
      const stop = api.listen("menu-zoom", () => undefined);
      // Deliberately never open the EventSource: this is the case the fallback
      // exists for, where eventStreamConnectedMs is still null.
      expect(fallback).toBeDefined();
      fallback?.();
      await waitForCondition(
        () => metricsFetch.mock.calls.length === 1,
        "The fallback did not report without a connected stream",
      );
      const payload = JSON.parse(
        String((metricsFetch.mock.calls[0] as unknown as [string, RequestInit])[1]?.body),
      ) as Record<string, unknown>;
      expect(payload.eventStreamConnectedMs).toBeNull();

      stop();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("disarms the boot metrics fallback when the last listener goes away", async () => {
    // Nothing is listening any more, so there is no boot left to measure. A
    // surviving 15s timer would hold this whole closure and still report for a
    // session that has already torn down.
    Object.defineProperty(document, "readyState", { configurable: true, value: "loading" });
    globalThis.fetch = mock(async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const FALLBACK_TIMER_ID = 15_000 as unknown as ReturnType<typeof setTimeout>;
    const cleared: unknown[] = [];
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => (
      delay === 15_000
        ? FALLBACK_TIMER_ID
        : originalSetTimeout(handler, delay, ...args)
    )) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: unknown) => {
      cleared.push(id);
      if (id !== FALLBACK_TIMER_ID) originalClearTimeout(id as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout;

    try {
      const api = createBrowserGatewayApi({ reportBootMetrics: true });
      const stop = api.listen("menu-zoom", () => undefined);
      expect(cleared).not.toContain(FALLBACK_TIMER_ID);

      stop();
      expect(cleared).toContain(FALLBACK_TIMER_ID);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("posts boot metrics as a keepalive JSON beacon", async () => {
    Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
    const metricsFetch = mock(async () => new Response(null, { status: 202 }));
    globalThis.fetch = metricsFetch as unknown as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    const api = createBrowserGatewayApi({ reportBootMetrics: true });
    const stop = api.listen("menu-zoom", () => undefined);
    MockEventSource.instances[0]?.open();
    await waitForCondition(() => metricsFetch.mock.calls.length === 1, "Boot metrics were not reported");

    const [url, init] = metricsFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/__orkestrator/client-metrics");
    expect(init.method).toBe("POST");
    // `keepalive` is the only reason the beacon survives a tab closed mid-boot,
    // which is exactly the boot this metric measures.
    expect(init.keepalive).toBe(true);
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    stop();
  });

  test("prefers the injected native platform over the WebKit sniff", async () => {
    Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
    const platforms: unknown[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      platforms.push((JSON.parse(String(init?.body)) as Record<string, unknown>).platform);
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    // Both signals present: the iPad/iPhone distinction only exists in the
    // injected value, so the sniff must not win.
    Object.defineProperty(window, "webkit", { configurable: true, value: {} });
    window.__orkestratorClientPlatform = "ipad-wkwebview";
    const api = createBrowserGatewayApi({ reportBootMetrics: true });
    const stop = api.listen("menu-zoom", () => undefined);
    MockEventSource.instances[0]?.open();
    await waitForCondition(() => platforms.length === 1, "Boot metrics were not reported");

    expect(platforms).toEqual(["ipad-wkwebview"]);
    stop();
  });

  test("attributes stylesheet resources by initiator type as well as by name", async () => {
    Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
    let payload: Record<string, unknown> | null = null;
    globalThis.fetch = mock(async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    Object.defineProperty(performance, "getEntriesByType", {
      configurable: true,
      value: mock((entryType: string) => (entryType === "resource"
        ? [
          // A hashed bundle URL has no .css suffix, so only initiatorType
          // classifies it.
          { name: "https://cdn.test/a1b2c3", initiatorType: "css", transferSize: 10, decodedBodySize: 20 },
          { name: "https://cdn.test/app.css", initiatorType: "link", transferSize: 5, decodedBodySize: 6 },
          { name: "https://cdn.test/app.js", initiatorType: "script", transferSize: 7, decodedBodySize: 8 },
        ]
        : [])),
    });

    const api = createBrowserGatewayApi({ reportBootMetrics: true });
    const stop = api.listen("menu-zoom", () => undefined);
    MockEventSource.instances[0]?.open();
    await waitForCondition(() => payload !== null, "Boot metrics were not reported");

    expect(payload).toMatchObject({
      resourceCount: 3,
      cssTransferSize: 15,
      cssDecodedBodySize: 26,
      jsTransferSize: 7,
      jsDecodedBodySize: 8,
    });
    stop();
  });

  test("invokes backend commands through the gateway", async () => {
    globalThis.fetch = mock(async (input, init) => {
      expect(input).toBe("/__orkestrator/invoke");
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "get_projects", args: { projectId: "project-1" } }),
      });
      return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    const api = createBrowserGatewayApi();

    await expect(api.invoke("get_projects", { projectId: "project-1" })).resolves.toEqual({ ok: true });
  });

  test("micro-batches HTTP terminal typing and flushes Enter in order", async () => {
    const invokes: Array<{ command: string; args: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (_input, init) => {
      invokes.push(JSON.parse(String(init?.body)) as {
        command: string;
        args: Record<string, unknown>;
      });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const api = createBrowserGatewayApi();
    const writes = ["h", "i", "\r"].map((data) => api.invoke("terminal_write", {
      sessionId: "session-1",
      data,
    }));
    await Promise.all(writes);

    expect(invokes).toEqual([{
      command: "terminal_write",
      args: { sessionId: "session-1", data: "hi\r" },
    }]);
  });

  test("batches local-terminal input and keeps malformed invokes on the immediate path", async () => {
    const invokes: Array<{ command: string; args: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (_input, init) => {
      invokes.push(JSON.parse(String(init?.body)) as {
        command: string;
        args: Record<string, unknown>;
      });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const api = createBrowserGatewayApi();
    await Promise.all(["o", "k", "\r"].map((data) => api.invoke("local_terminal_write", {
      sessionId: "local-1",
      data,
    })));
    await api.invoke("terminal_write", { sessionId: 42, data: "x" });
    await api.invoke("terminal_write", { sessionId: "empty", data: "" });

    expect(invokes).toEqual([
      {
        command: "local_terminal_write",
        args: { sessionId: "local-1", data: "ok\r" },
      },
      {
        command: "terminal_write",
        args: { sessionId: 42, data: "x" },
      },
    ]);
  });

  test("splits large Unicode-safe terminal input into bounded ordered requests", async () => {
    const chunks: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { args: { data: string } };
      chunks.push(body.args.data);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const input = `${"x".repeat(TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES - 1)}😀tail`;

    const api = createBrowserGatewayApi();
    await api.invoke("terminal_write", { sessionId: "session-large", data: input });

    const encoder = new TextEncoder();
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) =>
      encoder.encode(chunk).byteLength <= TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES
    )).toBe(true);
    expect(chunks.join("")).toBe(input);
  });

  test("fails a terminal queue closed after HTTP rejection and resets it on session restart", async () => {
    const invokes: Array<{ command: string; args: Record<string, unknown> }> = [];
    let rejectFirstWrite = true;
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        command: string;
        args: Record<string, unknown>;
      };
      invokes.push(body);
      if (body.command === "terminal_write" && rejectFirstWrite) {
        rejectFirstWrite = false;
        return new Response(JSON.stringify({ error: "gateway unavailable" }), { status: 503 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const api = createBrowserGatewayApi();
    const failed = ["a", "b", "\r"].map((data) => api.invoke("terminal_write", {
      sessionId: "session-recover",
      data,
    }));
    const failedResults = await Promise.allSettled(failed);
    expect(failedResults).toHaveLength(3);
    for (const result of failedResults) {
      expect(result.status).toBe("rejected");
      expect(String(result.status === "rejected" ? result.reason : ""))
        .toContain("gateway unavailable");
    }
    await expect(api.invoke("terminal_write", {
      sessionId: "session-recover",
      data: "blocked",
    })).rejects.toThrow("gateway unavailable");
    expect(invokes).toHaveLength(1);

    await api.invoke("start_terminal_session", { sessionId: "session-recover" });
    await api.invoke("terminal_write", { sessionId: "session-recover", data: "ok\r" });
    expect(invokes.map(({ command }) => command)).toEqual([
      "terminal_write",
      "start_terminal_session",
      "terminal_write",
    ]);
  });

  test("times out a hung terminal send and does not dispatch its queued suffix", async () => {
    const fetchMock = mock((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const api = createBrowserGatewayApi({ terminalInputSendTimeoutMs: 5 });

    const prefix = api.invoke("terminal_write", { sessionId: "hung", data: "prefix" });
    const suffix = api.invoke("terminal_write", { sessionId: "hung", data: "suffix" });
    const timeoutResults = await Promise.allSettled([prefix, suffix]);
    for (const result of timeoutResults) {
      expect(result.status).toBe("rejected");
      expect(String(result.status === "rejected" ? result.reason : ""))
        .toContain("timed out");
    }
    await expect(api.invoke("terminal_write", {
      sessionId: "hung",
      data: "later",
    })).rejects.toThrow("timed out");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("flushes accepted terminal input before resize and close lifecycle commands", async () => {
    const invokes: Array<{ command: string; args: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (_input, init) => {
      invokes.push(JSON.parse(String(init?.body)) as {
        command: string;
        args: Record<string, unknown>;
      });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({ terminalInputBatchDelayMs: 50 });

    const scenarios = [
      ["terminal_write", "terminal_resize", "container-resize"],
      ["terminal_write", "detach_terminal", "container-close"],
      ["local_terminal_write", "local_terminal_resize", "local-resize"],
      ["local_terminal_write", "close_local_terminal_session", "local-close"],
    ] as const;
    for (const [writeCommand, lifecycleCommand, sessionId] of scenarios) {
      const write = api.invoke(writeCommand, { sessionId, data: "x" });
      const lifecycle = api.invoke(lifecycleCommand, { sessionId, cols: 100, rows: 30 });
      await Promise.all([write, lifecycle]);
    }
    await api.invoke("start_local_terminal_session", { sessionId: "local-restart" });

    expect(invokes.map(({ command }) => command)).toEqual([
      "terminal_write", "terminal_resize",
      "terminal_write", "detach_terminal",
      "local_terminal_write", "local_terminal_resize",
      "local_terminal_write", "close_local_terminal_session",
      "start_local_terminal_session",
    ]);
  });

  test("keeps post-lifecycle input behind resize and rejects it after close", async () => {
    const runScenario = async ({
      writeCommand,
      lifecycleCommand,
      closes,
    }: {
      writeCommand: "terminal_write" | "local_terminal_write";
      lifecycleCommand: "terminal_resize" | "detach_terminal" | "close_local_terminal_session";
      closes: boolean;
    }) => {
      const invokes: string[] = [];
      let releaseFirst: () => void = () => {};
      const firstResponse = new Promise<Response>((resolve) => {
        releaseFirst = () => resolve(new Response(JSON.stringify({}), { status: 200 }));
      });
      globalThis.fetch = mock(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          command: string;
          args: Record<string, unknown>;
        };
        invokes.push(`${body.command}:${String(body.args.data ?? "")}`);
        if (invokes.length === 1) return firstResponse;
        return new Response(JSON.stringify({}), { status: 200 });
      }) as unknown as typeof fetch;
      const api = createBrowserGatewayApi({ terminalInputBatchDelayMs: 50 });

      const first = api.invoke(writeCommand, { sessionId: "ordered", data: "prefix" });
      await waitForCondition(() => invokes.length === 1, "First terminal write did not start");
      const lifecycle = api.invoke(lifecycleCommand, {
        sessionId: "ordered",
        cols: 100,
        rows: 30,
      });
      const later = api.invoke(writeCommand, { sessionId: "ordered", data: "\r" });

      if (closes) {
        await expect(later).rejects.toThrow("closed until the session restarts");
      }
      releaseFirst();
      await Promise.all([first, lifecycle, ...(closes ? [] : [later])]);
      expect(invokes).toEqual(closes
        ? [`${writeCommand}:prefix`, `${lifecycleCommand}:`]
        : [`${writeCommand}:prefix`, `${lifecycleCommand}:`, `${writeCommand}:\r`]);
    };

    await runScenario({
      writeCommand: "terminal_write",
      lifecycleCommand: "terminal_resize",
      closes: false,
    });
    await runScenario({
      writeCommand: "terminal_write",
      lifecycleCommand: "detach_terminal",
      closes: true,
    });
    await runScenario({
      writeCommand: "local_terminal_write",
      lifecycleCommand: "close_local_terminal_session",
      closes: true,
    });
  });

  test("start aborts active input, resets a closed queue, and gates later writes", async () => {
    const invokes: string[] = [];
    let firstSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        command: string;
        args: Record<string, unknown>;
      };
      invokes.push(`${body.command}:${String(body.args.data ?? "")}`);
      if (invokes.length === 1) {
        firstSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({ terminalInputBatchDelayMs: 50 });

    const active = api.invoke("terminal_write", { sessionId: "restart", data: "active" });
    await waitForCondition(() => invokes.length === 1, "Active terminal write did not start");
    const activeResult = active.catch((error) => error);
    const start = api.invoke("start_terminal_session", { sessionId: "restart" });
    const later = api.invoke("terminal_write", { sessionId: "restart", data: "ok\r" });

    await expect(activeResult).resolves.toEqual(new Error("Terminal HTTP input queue reset"));
    await Promise.all([start, later]);
    expect(firstSignal?.aborted).toBe(true);
    expect(invokes).toEqual([
      "terminal_write:active",
      "start_terminal_session:",
      "terminal_write:ok\r",
    ]);

    await api.invoke("detach_terminal", { sessionId: "restart" });
    await expect(api.invoke("terminal_write", { sessionId: "restart", data: "blocked" }))
      .rejects.toThrow("closed until the session restarts");
    await api.invoke("start_terminal_session", { sessionId: "restart" });
    await expect(api.invoke("terminal_write", { sessionId: "restart", data: "fresh\r" }))
      .resolves.toBeUndefined();
  });

  test("disposing a replaced gateway aborts in-flight and queued terminal input", async () => {
    let oldSignal: AbortSignal | undefined;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/agent-test/session")) return new Response(null, { status: 404 });
      oldSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "http:" },
      orkestrator: undefined,
      orkestratorGateway: undefined,
    };
    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      { terminalInputBatchDelayMs: 50 },
    );
    const oldApi = fakeWindow.orkestrator!;
    const active = oldApi.invoke("terminal_write", { sessionId: "old", data: "active" });
    const queued = oldApi.invoke("terminal_write", { sessionId: "old", data: "q" });
    const activeResult = active.catch((error) => error);
    const queuedResult = queued.catch((error) => error);
    await waitForCondition(() => oldSignal !== undefined, "Old terminal write did not start");
    const resizeResult = oldApi.invoke("terminal_resize", {
      sessionId: "old",
      cols: 100,
      rows: 30,
    }).catch((error) => error);
    const closeResult = oldApi.invoke("detach_terminal", { sessionId: "old" })
      .catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();

    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      { replaceExisting: true },
    );

    expect(fakeWindow.orkestrator).not.toBe(oldApi);
    expect(oldSignal?.aborted).toBe(true);
    await expect(activeResult).resolves.toEqual(new Error("Browser gateway replaced"));
    await expect(queuedResult).resolves.toEqual(new Error("Browser gateway replaced"));
    await expect(resizeResult).resolves.toEqual(new Error("Browser gateway replaced"));
    await expect(closeResult).resolves.toEqual(new Error("Browser gateway replaced"));
    await expect(oldApi.invoke("terminal_write", { sessionId: "old", data: "later" }))
      .rejects.toThrow("Browser gateway replaced");
    expect(fetchMock.mock.calls.filter(([input]) => !String(input).includes("/agent-test/session")))
      .toHaveLength(1);
  });

  test("keeps a live terminal writable when its close never reached the backend", async () => {
    const invokes: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        command: string;
        args: Record<string, unknown>;
      };
      invokes.push(body.command);
      if (body.command === "detach_terminal" && body.args.sessionId === "still-alive") {
        return new Response(JSON.stringify({ error: "gateway unavailable" }), { status: 503 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi();

    await expect(api.invoke("detach_terminal", { sessionId: "still-alive" }))
      .rejects.toThrow("gateway unavailable");

    // The backend terminal survived the failed detach, so its input must not be
    // rejected for the lifetime of the page.
    await api.invoke("terminal_write", { sessionId: "still-alive", data: "ls\r" });
    expect(invokes).toEqual(["detach_terminal", "terminal_write"]);

    // A close that does land still closes the queue.
    await api.invoke("detach_terminal", { sessionId: "other" });
    await expect(api.invoke("terminal_write", { sessionId: "other", data: "x" }))
      .rejects.toThrow("closed until the session restarts");
    expect(invokes).toEqual(["detach_terminal", "terminal_write", "detach_terminal"]);
  });

  test("re-arms a terminal whose input failed once the transport recovers", async () => {
    const invokes: string[] = [];
    let rejectWrites = true;
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        command: string;
        args: Record<string, unknown>;
      };
      invokes.push(body.command);
      if (body.command === "terminal_write" && rejectWrites) {
        return new Response(JSON.stringify({ error: "gateway unavailable" }), { status: 503 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi();

    await expect(api.invoke("terminal_write", { sessionId: "flaky", data: "a\r" }))
      .rejects.toThrow("gateway unavailable");
    await expect(api.invoke("terminal_write", { sessionId: "flaky", data: "b\r" }))
      .rejects.toThrow("gateway unavailable");

    // A resize that succeeds proves the transport recovered.
    rejectWrites = false;
    await api.invoke("terminal_resize", { sessionId: "flaky", cols: 100, rows: 30 });
    await api.invoke("terminal_write", { sessionId: "flaky", data: "c\r" });

    expect(invokes).toEqual([
      "terminal_write",
      "terminal_resize",
      "terminal_write",
    ]);
  });

  test("leaves a failed queue closed when the recovering resize also fails", async () => {
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { command: string };
      return body.command === "start_terminal_session"
        ? new Response(JSON.stringify({}), { status: 200 })
        : new Response(JSON.stringify({ error: "gateway unavailable" }), { status: 503 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi();

    await expect(api.invoke("terminal_write", { sessionId: "down", data: "a\r" }))
      .rejects.toThrow("gateway unavailable");
    await expect(api.invoke("terminal_resize", { sessionId: "down", cols: 80, rows: 24 }))
      .rejects.toThrow("gateway unavailable");
    await expect(api.invoke("terminal_write", { sessionId: "down", data: "b\r" }))
      .rejects.toThrow("gateway unavailable");
  });

  test("reopens a terminal whose start command failed", async () => {
    const invokes: string[] = [];
    let rejectStart = true;
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { command: string };
      invokes.push(body.command);
      if (body.command === "start_terminal_session" && rejectStart) {
        rejectStart = false;
        return new Response(JSON.stringify({ error: "container gone" }), { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi();

    await api.invoke("detach_terminal", { sessionId: "restart" });
    await expect(api.invoke("start_terminal_session", { sessionId: "restart" }))
      .rejects.toThrow("container gone");

    // The failed start already cleared the close marker, so a retry works and
    // input is accepted rather than rejected against a session that now exists.
    await api.invoke("start_terminal_session", { sessionId: "restart" });
    await api.invoke("terminal_write", { sessionId: "restart", data: "ok\r" });
    expect(invokes).toEqual([
      "detach_terminal",
      "start_terminal_session",
      "start_terminal_session",
      "terminal_write",
    ]);
  });

  test("rejects lifecycle commands issued after the gateway was replaced", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "http:" },
      orkestrator: undefined,
      orkestratorGateway: undefined,
    };
    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      {},
    );
    const oldApi = fakeWindow.orkestrator!;
    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      { replaceExisting: true },
    );

    for (const [command, args] of [
      ["terminal_resize", { sessionId: "gone", cols: 80, rows: 24 }],
      ["detach_terminal", { sessionId: "gone" }],
      ["start_terminal_session", { sessionId: "gone" }],
    ] as const) {
      await expect(oldApi.invoke(command, args)).rejects.toThrow("Browser gateway replaced");
    }
  });

  test("replaces a gateway this module did not create without disposing it", () => {
    const foreignApi = { invoke: async () => undefined } as unknown as Window["orkestrator"];
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "http:" },
      orkestrator: foreignApi,
      orkestratorGateway: undefined,
    };

    expect(() => installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      { replaceExisting: true },
    )).not.toThrow();
    expect(fakeWindow.orkestrator).not.toBe(foreignApi);
  });

  test("routes a lifecycle command with no usable session id straight through", async () => {
    const invokes: Array<{ command: string; args: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (_input, init) => {
      invokes.push(JSON.parse(String(init?.body)) as {
        command: string;
        args: Record<string, unknown>;
      });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({ terminalInputBatchDelayMs: 50 });

    // Without a string session id there is no queue to order against, so the
    // command must not be silently dropped or attached to another terminal.
    await api.invoke("terminal_resize", { cols: 80, rows: 24 });
    await api.invoke("detach_terminal", { sessionId: 42 });
    expect(invokes.map(({ command }) => command)).toEqual(["terminal_resize", "detach_terminal"]);

    // The absent session id did not close any real terminal's queue.
    await api.invoke("terminal_write", { sessionId: "42", data: "x\r" });
    expect(invokes.map(({ command }) => command)).toEqual([
      "terminal_resize",
      "detach_terminal",
      "terminal_write",
    ]);
  });

  test("wires the configured batch and queue byte limits into the batcher", async () => {
    const sent: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { args: { data: string } };
      sent.push(body.args.data);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      terminalInputMaxBatchBytes: 4,
      terminalInputMaxQueuedBytes: 8,
    });

    await api.invoke("terminal_write", { sessionId: "bounded", data: "abcdefgh" });
    expect(sent).toEqual(["abcd", "efgh"]);

    await expect(api.invoke("terminal_write", { sessionId: "bounded", data: "too-long-to-fit" }))
      .rejects.toThrow("exceeds the 8-byte terminal queue limit");
  });

  test("batches direct terminal writes with bearer authentication", async () => {
    const requests: Array<{ url: string; authorization: string | null; data: string }> = [];
    globalThis.fetch = mock(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { args: { data: string } };
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        data: body.args.data,
      });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
    });

    await Promise.all(["d", "i", "r", "\r"].map((data) => api.invoke("terminal_write", {
      sessionId: "direct-terminal",
      data,
    })));

    expect(requests).toEqual([{
      url: "https://workstation.tailnet.ts.net/__orkestrator/invoke",
      authorization: "Bearer direct-token-123456",
      data: "dir\r",
    }]);
  });

  test("opts into the terminal WebSocket explicitly or from storage and forwards URL and token", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    globalThis.fetch = mock(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    const createSocket = (url: string, protocols: string | string[]) =>
      new MockWebSocket(url, protocols) as unknown as WebSocket;
    const direct = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      terminalTransport: "websocket",
      terminalWebSocketFactory: createSocket,
    });

    const stopDirect = direct.listen("terminal-output-direct", () => undefined);
    const directSocket = MockWebSocket.instances[0];
    if (!directSocket) throw new Error("Direct terminal socket was not created");
    expect(String(directSocket.url)).toBe("wss://workstation.tailnet.ts.net/__orkestrator/terminal");
    expect(directSocket.protocols).toBe("orkestrator-terminal.v1");
    directSocket.open();
    expect(sentControlFrames(directSocket)[0]).toEqual({
      type: "authenticate",
      version: 1,
      token: "direct-token-123456",
    });
    stopDirect();

    localStorage.setItem(TERMINAL_TRANSPORT_STORAGE_KEY, "websocket");
    const stored = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalWebSocketFactory: createSocket,
    });
    const stopStored = stored.listen("terminal-output-stored", () => undefined);
    expect(MockWebSocket.instances).toHaveLength(2);
    stopStored();

    const forcedHttp = createBrowserGatewayApi({
      terminalTransport: "http-sse",
      terminalWebSocketFactory: createSocket,
    });
    const stopHttp = forcedHttp.listen("terminal-output-http", () => undefined);
    await Promise.resolve();
    expect(MockWebSocket.instances).toHaveLength(2);
    stopHttp();
  });

  test("keeps fallback per channel until its WebSocket snapshot succeeds", async () => {
    const createSocket = (url: string, protocols: string | string[]) =>
      new MockWebSocket(url, protocols) as unknown as WebSocket;
    const fallbackSignals = new Map<string, AbortSignal>();
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        const event = new URL(String(input)).searchParams.get("includeEvents");
        if (event && init?.signal) fallbackSignals.set(event, init.signal);
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { command: string };
      expect(body.command).toBe("get_terminal_output_snapshot");
      return new Response(JSON.stringify({
        result: { generation: 1, revision: 0, data: "" },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: createSocket,
    });

    const stopFirst = api.listen("terminal-output-session-1", () => undefined);
    const stopSecond = api.listen("terminal-output-session-2", () => undefined);
    await waitForCondition(() => fallbackSignals.size === 2);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    subscribeTerminalSocket(socket, "session-1");
    expect(fallbackSignals.get("terminal-output-session-1")?.aborted).toBe(false);
    expect(fallbackSignals.get("terminal-output-session-2")?.aborted).toBe(false);

    await api.invoke("get_terminal_output_snapshot", { sessionId: "session-1" });
    await waitForCondition(
      () => fallbackSignals.get("terminal-output-session-1")?.aborted === true,
      "Snapshot completion did not retire fallback",
    );
    expect(fallbackSignals.get("terminal-output-session-2")?.aborted).toBe(false);
    stopFirst();
    stopSecond();
  });

  test("retains fallback and retries a channel when its snapshot fails", async () => {
    let fallbackSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        fallbackSignal = init?.signal ?? undefined;
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "snapshot unavailable" }), { status: 503 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });

    const stop = api.listen("terminal-output-session-1", () => undefined);
    await waitForCondition(() => fallbackSignal !== undefined);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    subscribeTerminalSocket(socket, "session-1");

    await expect(api.invoke("get_terminal_output_snapshot", { sessionId: "session-1" }))
      .rejects.toThrow("snapshot unavailable");
    await waitForCondition(
      () => sentControlFrames(socket).some((frame) => frame.type === "unsubscribe"),
      "Snapshot failure did not reset the WebSocket subscription",
    );
    expect(fallbackSignal?.aborted).toBe(false);
    stop();
  });

  test("waits for WebSocket input and resize acknowledgements before HTTP close and restart", async () => {
    const invokes: string[] = [];
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { command: string };
      invokes.push(body.command);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stop = api.listen("terminal-output-ordered", () => undefined);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    const channelId = subscribeTerminalSocket(socket, "ordered", "current");

    const input = api.invoke("terminal_write", { sessionId: "ordered", data: "final" });
    await waitForCondition(
      () => socket.sent.some((frame) => typeof frame !== "string"),
      "WebSocket input was not sent",
    );
    const binary = socket.sent.find((frame) => typeof frame !== "string");
    if (!binary || binary instanceof Blob) throw new Error("Input frame was not binary");
    const inputFrame = decodeSentBinaryFrame(binary as ArrayBufferLike | ArrayBufferView);
    expect(inputFrame.type).toBe(TERMINAL_BINARY_FRAME_TYPE.input);

    const resize = api.invoke("terminal_resize", { sessionId: "ordered", cols: 100, rows: 30 });
    const close = api.invoke("detach_terminal", { sessionId: "ordered" });
    const restart = api.invoke("start_terminal_session", { sessionId: "ordered" });
    await Promise.resolve();
    expect(sentControlFrames(socket).some((frame) => frame.type === "resize")).toBe(false);
    expect(invokes).toEqual([]);

    socket.receive(JSON.stringify({
      type: "operation-result",
      channelId,
      operationId: inputFrame.revision,
      operation: "input",
      ok: true,
    }));
    await waitForCondition(
      () => sentControlFrames(socket).some((frame) => frame.type === "resize"),
      "Resize did not follow acknowledged input",
    );
    const resizeFrame = sentControlFrames(socket).find((frame) => frame.type === "resize")!;
    expect(invokes).toEqual([]);
    socket.receive(JSON.stringify({
      type: "operation-result",
      channelId,
      operationId: resizeFrame.operationId,
      operation: "resize",
      ok: true,
    }));

    await Promise.all([input, resize, close, restart]);
    expect(invokes).toEqual(["detach_terminal", "start_terminal_session"]);
    stop();
  });

  test("does not re-arm a terminal fallback that a ready WebSocket channel retired", async () => {
    let eventStreamRequests = 0;
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        eventStreamRequests += 1;
        const signal = init?.signal;
        return new Response(new ReadableStream({
          start(controller) {
            // A real aborted body errors its reader, which is what runs the
            // reconnect bookkeeping. A stream that just hangs would hide it.
            signal?.addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
            });
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        result: { generation: 1, revision: 0, output: "" },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      eventReconnectDelayMs: 1,
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });

    const stop = api.listen("terminal-output-session-1", () => undefined);
    await waitForCondition(() => eventStreamRequests === 1);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    subscribeTerminalSocket(socket, "session-1");
    await api.invoke("get_terminal_output_snapshot", { sessionId: "session-1" });
    await waitForCondition(
      () => sentControlFrames(socket).some((frame) => frame.type === "ack")
        || eventStreamRequests === 1,
      "Channel never became ready",
    );

    const settled = eventStreamRequests;
    await new Promise((resolve) => originalSetTimeout(resolve, 30));
    // Stopping the fallback aborts its controller, and that abort is exactly
    // what schedules the reconnect. Both transports carrying the same terminal
    // would double every byte the milestone is trying to save.
    expect(eventStreamRequests).toBe(settled);
    stop();
  });

  test("pipelines consecutive WebSocket writes instead of waiting for each acknowledgement", async () => {
    globalThis.fetch = mock(async (input) => {
      if (String(input).includes("/__orkestrator/events?")) {
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stop = api.listen("terminal-output-typed", () => undefined);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    const channelId = subscribeTerminalSocket(socket, "typed", "current");

    const writes = [
      api.invoke("terminal_write", { sessionId: "typed", data: "a" }),
      api.invoke("terminal_write", { sessionId: "typed", data: "b" }),
      api.invoke("terminal_write", { sessionId: "typed", data: "c" }),
    ];
    // No acknowledgement has been delivered yet. Chaining each keystroke on the
    // previous ack would cap typing at one round trip per character.
    await waitForCondition(
      () => socket.sent.filter((frame) => typeof frame !== "string").length === 3,
      "Writes were serialized behind their acknowledgements",
    );
    const frames = socket.sent
      .filter((frame) => typeof frame !== "string")
      .map((frame) => decodeSentBinaryFrame(frame as ArrayBufferLike | ArrayBufferView));
    expect(frames.map((frame) => new TextDecoder().decode(frame.bytes))).toEqual(["a", "b", "c"]);

    for (const frame of frames) {
      socket.receive(JSON.stringify({
        type: "operation-result",
        channelId,
        operationId: frame.revision,
        operation: "input",
        ok: true,
      }));
    }
    await Promise.all(writes);
    stop();
  });

  test("keeps socket input working after a transient HTTP write failure latched the queue", async () => {
    let failWrites = true;
    const invokes: string[] = [];
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { command: string };
      invokes.push(body.command);
      if (failWrites && body.command.endsWith("terminal_write")) {
        return new Response(JSON.stringify({ error: "write failed" }), { status: 503 });
      }
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stop = api.listen("terminal-output-latched", () => undefined);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);

    // The channel is not ready yet, so this write takes the HTTP path and
    // fails, latching the batcher's queue for this terminal.
    await expect(api.invoke("terminal_write", { sessionId: "latched", data: "x" }))
      .rejects.toThrow();
    failWrites = false;

    const channelId = subscribeTerminalSocket(socket, "latched", "current");
    const write = api.invoke("terminal_write", { sessionId: "latched", data: "y" });
    // A latched HTTP queue must not veto a healthy socket: the flush rejection
    // belongs to the write that already failed, not to this one.
    await waitForCondition(
      () => socket.sent.some((frame) => typeof frame !== "string"),
      "A latched HTTP queue blocked a healthy WebSocket write",
    );
    const frame = decodeSentBinaryFrame(
      socket.sent.find((value) => typeof value !== "string") as ArrayBufferLike,
    );
    socket.receive(JSON.stringify({
      type: "operation-result", channelId, operationId: frame.revision, operation: "input", ok: true,
    }));
    await write;
    stop();
  });

  test("falls back to an HTTP resize when the socket rejects the operation", async () => {
    const invokes: string[] = [];
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      invokes.push((JSON.parse(String(init?.body)) as { command: string }).command);
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stop = api.listen("terminal-output-sized", () => undefined);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    const channelId = subscribeTerminalSocket(socket, "sized", "current");

    const resize = api.invoke("terminal_resize", { sessionId: "sized", cols: 100, rows: 30 });
    await waitForCondition(
      () => sentControlFrames(socket).some((frame) => frame.type === "resize"),
      "Resize was never attempted over the socket",
    );
    const resizeFrame = sentControlFrames(socket).find((frame) => frame.type === "resize")!;
    socket.receive(JSON.stringify({
      type: "operation-result",
      channelId,
      operationId: resizeFrame.operationId,
      operation: "resize",
      ok: false,
      message: "Unknown terminal channel",
    }));

    // A refused socket resize still has to reach the backend. Letting the
    // rejection propagate would leave the PTY at stale dimensions silently.
    await resize;
    expect(invokes).toContain("terminal_resize");
    stop();
  });

  test("coalesces the shared browser stream rebuild when channels become ready together", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      result: { generation: 1, revision: 0, output: "" },
    }), { status: 200 })) as unknown as typeof fetch;
    // The shared stream is the same-origin path, so there is no base URL to
    // derive the socket address from — the document has to have a real one.
    const happyWindow = window as unknown as { happyDOM: { setURL(url: string): void } };
    happyWindow.happyDOM.setURL("http://localhost:1420/");
    const api = createBrowserGatewayApi({
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stopFirst = api.listen("terminal-output-one", () => undefined);
    const stopSecond = api.listen("terminal-output-two", () => undefined);
    await waitForCondition(() => MockEventSource.instances.length === 1);
    MockEventSource.instances[0]!.open();

    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    subscribeTerminalSocket(socket, "one", "current", 1);
    subscribeTerminalSocket(socket, "two", "current", 2);

    // Every rebuild costs the still-fallback terminals a snapshot reconcile, so
    // channels retiring their fallback in a burst must produce one rebuild.
    await new Promise((resolve) => originalSetTimeout(resolve, 120));
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.closed).toBe(true);
    stopFirst();
    stopSecond();
    happyWindow.happyDOM.setURL("about:blank");
  });

  test("disposes an opted-in terminal socket when the browser adapter is replaced", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    globalThis.fetch = mock(async () =>
      new Response(new ReadableStream({ start() {} }), { status: 200 })) as unknown as typeof fetch;
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "http:" },
      orkestrator: undefined,
      orkestratorGateway: undefined,
    };
    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      {
        baseUrl: "http://localhost:4319",
        terminalTransport: "websocket",
        terminalWebSocketFactory: (url, protocols) =>
          new MockWebSocket(url, protocols) as unknown as WebSocket,
      },
    );
    const stop = fakeWindow.orkestrator!.listen("terminal-output-dispose", () => undefined);
    const socket = MockWebSocket.instances[0]!;

    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      { replaceExisting: true },
    );

    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(socket.closeReason).toBe("Gateway adapter disposed");
    stop();
  });

  test("reconnects an active terminal socket with a rotated gateway token", async () => {
    globalThis.fetch = mock(async (input) => {
      if (String(input).includes("/gateway-settings")) {
        return new Response(JSON.stringify({
          token: "rotated-token-654321",
          configured: true,
        }), { status: 200 });
      }
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      token: "initial-token-123456",
      terminalTransport: "websocket",
      terminalWebSocketReconnectDelayMs: 0,
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stop = api.listen("terminal-output-token", () => undefined);
    const first = MockWebSocket.instances[0]!;
    first.open();
    expect(sentControlFrames(first)[0]?.token).toBe("initial-token-123456");

    await api.webClient.setToken("rotated-token-654321");
    expect(first.closeReason).toBe("Gateway credential changed");
    await waitForCondition(() => MockWebSocket.instances.length === 2);
    const second = MockWebSocket.instances[1]!;
    second.open();
    expect(sentControlFrames(second)[0]?.token).toBe("rotated-token-654321");
    stop();
  });

  test("keeps SSE fallback when terminal WebSocket construction fails", async () => {
    let fallbackSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      fallbackSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketReconnectDelayMs: 60_000,
      terminalWebSocketFactory: () => {
        throw new Error("WebSocket unavailable");
      },
    });

    const stop = api.listen("terminal-output-fallback", () => undefined);
    const ready = api.eventStreamReady("terminal-output-fallback");
    await expect(ready).resolves.toBeUndefined();
    expect(fallbackSignal?.aborted).toBe(false);
    stop();
    expect(fallbackSignal?.aborted).toBe(true);
  });

  test("surfaces a rejected WebSocket input operation without an ambiguous HTTP retry", async () => {
    const invokes: string[] = [];
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { command: string };
      invokes.push(body.command);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stop = api.listen("terminal-output-rejected", () => undefined);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    const channelId = subscribeTerminalSocket(socket, "rejected", "current");

    const input = api.invoke("terminal_write", { sessionId: "rejected", data: "dangerous" });
    await waitForCondition(() => socket.sent.some((frame) => typeof frame !== "string"));
    const binary = socket.sent.find((frame) => typeof frame !== "string");
    if (!binary || binary instanceof Blob) throw new Error("Input frame was not binary");
    const inputFrame = decodeSentBinaryFrame(binary as ArrayBufferLike | ArrayBufferView);
    socket.receive(JSON.stringify({
      type: "operation-result",
      channelId,
      operationId: inputFrame.revision,
      operation: "input",
      ok: false,
      message: "terminal write rejected",
    }));

    await expect(input).rejects.toThrow("terminal write rejected");
    expect(invokes).toEqual([]);
    stop();
  });

  test("connects directly to a configured backend with bearer authentication", async () => {
    globalThis.fetch = mock(async (input, init) => {
      expect(input).toBe("https://workstation.tailnet.ts.net/__orkestrator/invoke");
      expect(init).toMatchObject({
        method: "POST",
        credentials: "omit",
        headers: {
          authorization: "Bearer direct-token-123456",
          "content-type": "application/json",
        },
      });
      return new Response(JSON.stringify({ result: ["project-1"] }), { status: 200 });
    }) as unknown as typeof fetch;

    // No window.orkestratorGateway: the API must target its own configured base URL.
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
    });

    await expect(api.invoke("get_projects")).resolves.toEqual(["project-1"]);
    await expect(api.webClient.getStatus()).resolves.toMatchObject({
      url: "https://workstation.tailnet.ts.net/",
    });
  });

  test("reports sanitized boot metrics through the gateway", async () => {
    let metricsPayload: Record<string, unknown> | null = null;
    globalThis.fetch = mock(async (input, init) => {
      expect(input).toBe("/__orkestrator/client-metrics");
      metricsPayload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }) as unknown as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    Object.defineProperty(performance, "getEntriesByType", {
      configurable: true,
      value: mock((entryType: string) => {
        if (entryType === "navigation") {
          return [{
            type: "reload",
            nextHopProtocol: "http/1.1",
            transferSize: 321,
            encodedBodySize: 222,
            decodedBodySize: 654,
            domContentLoadedEventEnd: 11,
            loadEventEnd: 19,
          }];
        }
        if (entryType === "resource") {
          return [
            {
              name: "http://example.test/assets/app.js",
              initiatorType: "script",
              transferSize: 123,
              encodedBodySize: 111,
              decodedBodySize: 222,
            },
            {
              name: "http://example.test/assets/app.css",
              initiatorType: "link",
              transferSize: 45,
              encodedBodySize: 33,
              decodedBodySize: 44,
            },
          ];
        }
        if (entryType === "paint") {
          return [
            { name: "first-paint", startTime: 7 },
            { name: "first-contentful-paint", startTime: 9 },
          ];
        }
        return [];
      }),
    });
    window.__orkestratorClientPlatform = "iphone-wkwebview";

    const api = createBrowserGatewayApi({ reportBootMetrics: true });
    const stop = api.listen("menu-zoom", () => undefined);
    window.dispatchEvent(new Event("load"));
    MockEventSource.instances[0]?.open();

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 500;
      const poll = () => {
        if (metricsPayload) return resolve();
        if (Date.now() > deadline) return reject(new Error("Boot metrics were not reported"));
        setTimeout(poll, 1);
      };
      poll();
    });

    const reportedMetrics = metricsPayload;
    // Every aggregate is asserted, not just a sample: encoded-vs-decoded size
    // is the compression ratio this milestone exists to measure, so swapping
    // the two reducers has to fail here.
    expect(reportedMetrics).toMatchObject({
      platform: "iphone-wkwebview",
      navigationType: "reload",
      nextHopProtocol: "http/1.1",
      transferSize: 321,
      encodedBodySize: 222,
      decodedBodySize: 654,
      resourceCount: 2,
      resourceTransferSize: 123 + 45,
      resourceEncodedBodySize: 111 + 33,
      resourceDecodedBodySize: 222 + 44,
      jsTransferSize: 123,
      jsDecodedBodySize: 222,
      cssTransferSize: 45,
      cssDecodedBodySize: 44,
      domContentLoadedMs: 11,
      loadEventMs: 19,
      firstPaintMs: 7,
      firstContentfulPaintMs: 9,
    });
    if (!reportedMetrics) throw new Error("Boot metrics were not captured");
    expect(typeof reportedMetrics["eventStreamConnectedMs"]).toBe("number");
    stop();
  });

  test("waits until the task after load before sampling finalized navigation timing", async () => {
    Object.defineProperty(document, "readyState", {
      configurable: true,
      value: "loading",
    });
    let loadEventEnd = 0;
    const metrics: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(async (_input, init) => {
      metrics.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    Object.defineProperty(performance, "getEntriesByType", {
      configurable: true,
      value: mock((entryType: string) =>
        entryType === "navigation" ? [{ loadEventEnd }] : []),
    });

    const api = createBrowserGatewayApi({ reportBootMetrics: true });
    const stop = api.listen("menu-zoom", () => undefined);
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");
    source.open();
    await new Promise((resolve) => originalSetTimeout(resolve, 2));
    expect(metrics).toHaveLength(0);

    window.dispatchEvent(new Event("load"));
    expect(metrics).toHaveLength(0);
    loadEventEnd = 42;
    await waitForCondition(() => metrics.length === 1, "Boot metrics were not reported after load");

    expect(metrics[0]?.loadEventMs).toBe(42);
    stop();
  });

  test("uses the 15-second fallback once across later load and reconnect events", async () => {
    Object.defineProperty(document, "readyState", {
      configurable: true,
      value: "loading",
    });
    let fallback: (() => void) | undefined;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 15_000 && typeof handler === "function") {
        fallback = () => handler(...args);
        return 15_000 as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;
    const metricsFetch = mock(async () => new Response(null, { status: 202 }));
    globalThis.fetch = metricsFetch as unknown as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    try {
      const api = createBrowserGatewayApi({ reportBootMetrics: true });
      const stop = api.listen("menu-zoom", () => undefined);
      const source = MockEventSource.instances[0];
      if (!source) throw new Error("EventSource was not created");
      source.open();
      expect(fallback).toBeDefined();

      fallback?.();
      await waitForCondition(() => metricsFetch.mock.calls.length === 1);
      window.dispatchEvent(new Event("load"));
      source.open();
      fallback?.();
      await new Promise((resolve) => originalSetTimeout(resolve, 2));

      expect(metricsFetch).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("posts direct boot metrics with bearer auth and detects both platform fallbacks", async () => {
    const reports: Array<{
      input: string;
      authorization: string | null;
      credentials: RequestCredentials | undefined;
      platform: unknown;
    }> = [];
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).endsWith("/events?excludeEvents=terminal-output-")) {
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      const headers = new Headers(init?.headers);
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      reports.push({
        input: String(input),
        authorization: headers.get("authorization"),
        credentials: init?.credentials,
        platform: payload.platform,
      });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    Object.defineProperty(window, "webkit", { configurable: true, value: {} });
    const iosApi = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net/",
      token: "direct-token-123456",
      reportBootMetrics: true,
    });
    const stopIos = iosApi.listen("menu-zoom", () => undefined);
    await waitForCondition(() => reports.length === 1, "iOS boot metrics were not reported");
    stopIos();

    delete (window as Window & { webkit?: unknown }).webkit;
    const desktopApi = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      reportBootMetrics: true,
    });
    const stopDesktop = desktopApi.listen("menu-zoom", () => undefined);
    await waitForCondition(() => reports.length === 2, "Desktop boot metrics were not reported");
    stopDesktop();

    expect(reports).toEqual([
      {
        input: "https://workstation.tailnet.ts.net/__orkestrator/client-metrics",
        authorization: "Bearer direct-token-123456",
        credentials: "omit",
        platform: "ios-wkwebview",
      },
      {
        input: "https://workstation.tailnet.ts.net/__orkestrator/client-metrics",
        authorization: "Bearer direct-token-123456",
        credentials: "omit",
        platform: "desktop-browser",
      },
    ]);
  });

  test("does not retry a failed boot metrics submission", async () => {
    const metricsFetch = mock(async () => {
      throw new Error("offline");
    });
    globalThis.fetch = metricsFetch as unknown as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    const api = createBrowserGatewayApi({ reportBootMetrics: true });
    const stop = api.listen("menu-zoom", () => undefined);
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");
    source.open();
    await waitForCondition(() => metricsFetch.mock.calls.length === 1);

    source.open();
    window.dispatchEvent(new Event("load"));
    await new Promise((resolve) => originalSetTimeout(resolve, 2));

    expect(metricsFetch).toHaveBeenCalledTimes(1);
    stop();
  });

  test("authenticates proxied loopback fetches and named event streams", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    globalThis.fetch = mock(async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({ url: String(input), authorization: headers.get("authorization") });
      if (String(input).endsWith("/event/subscribe")) {
        return new Response(
          'event: message.updated\ndata: {"sessionId":"session-1"}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    configureDirectGatewayTransport(
      "https://workstation.tailnet.ts.net",
      "direct-token-123456",
    );

    await fetch(
      "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback/7777/global/health",
    );
    await fetch("https://example.com/not-the-gateway");

    const eventData = await new Promise<string>((resolve) => {
      const source = new globalThis.EventSource(
        "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback/7777/event/subscribe",
      );
      source.addEventListener("message.updated", (event) => {
        resolve((event as MessageEvent).data as string);
        source.close();
      });
    });

    expect(eventData).toBe('{"sessionId":"session-1"}');
    expect(requests).toEqual([
      {
        url: "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback/7777/global/health",
        authorization: "Bearer direct-token-123456",
      },
      { url: "https://example.com/not-the-gateway", authorization: null },
      {
        url: "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback/7777/event/subscribe",
        authorization: "Bearer direct-token-123456",
      },
    ]);
  });

  test("parses direct gateway CRLF event streams and aborts them when idle", async () => {
    const encoder = new TextEncoder();
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: not-json\r\n\r"));
          controller.enqueue(encoder.encode("\ndata: {\"event\":\"changed\",\"payload\":{\"ok\":true}}\r\n\r\n"));
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
    });
    const callback = mock(() => undefined);

    const unsubscribe = api.listen("changed", callback);
    await new Promise<void>((resolve) => {
      const poll = () => callback.mock.calls.length > 0 ? resolve() : setTimeout(poll, 1);
      poll();
    });
    expect(callback).toHaveBeenCalledWith({ ok: true });
    expect(requestSignal?.aborted).toBe(false);

    unsubscribe();
    expect(requestSignal?.aborted).toBe(true);
  });

  test("reconnects a direct event stream while listeners remain", async () => {
    const encoder = new TextEncoder();
    const warning = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warning;
    let attempt = 0;
    globalThis.fetch = mock(async () => {
      attempt += 1;
      if (attempt === 1) return new Response(null, { status: 503 });
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(gatewayControlFrame("gateway.connected", "fresh")));
          controller.enqueue(encoder.encode('data: {"event":"changed","payload":"reconnected"}\n\n'));
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      eventReconnectDelayMs: 0,
    });
    const connected = mock(() => undefined);
    const stopConnected = api.listen(
      "native-event-stream-connected",
      connected,
    );

    try {
      const payload = await new Promise<string>((resolve) => {
        const unsubscribe = api.listen<string>("changed", (value) => {
          unsubscribe();
          resolve(value);
        });
      });
      expect(payload).toBe("reconnected");
      expect(attempt).toBe(2);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(connected).toHaveBeenCalledTimes(1);
    } finally {
      stopConnected();
      console.warn = originalWarn;
    }
  });

  test("announces a fresh browser stream but not a replayed reconnect", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const connected = mock(() => undefined);
    const unsubscribe = api.listen(
      "native-event-stream-connected",
      connected,
    );
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");

    source.onopen?.();
    source.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({
        event: "gateway.connected",
        payload: { status: "fresh" },
      }),
      lastEventId: "12345678:0",
    }));
    source.onopen?.();
    source.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({
        event: "gateway.connected",
        payload: { status: "caught-up" },
      }),
      lastEventId: "12345678:0",
    }));

    expect(connected).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test("ignores malformed, missing, and replay-success connected statuses", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const connected = mock(() => undefined);
    const unsubscribe = api.listen(
      NATIVE_EVENT_STREAM_CONNECTED_EVENT,
      connected,
    );
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");

    for (const payload of [
      undefined,
      {},
      { status: 42 },
      { status: "caught-up" },
      { status: "replayed" },
      { status: "reconcile" },
    ]) {
      source.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({ event: "gateway.connected", payload }),
        lastEventId: "12345678:0",
      }));
    }

    expect(connected).not.toHaveBeenCalled();

    source.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({
        event: "gateway.connected",
        payload: { status: "fresh" },
      }),
      lastEventId: "12345678:0",
    }));
    expect(connected).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test("announces same-origin reconciliation only from its explicit control frame", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const connected = mock(() => undefined);
    const reconcileFrame = mock(() => undefined);
    const stopConnected = api.listen(
      NATIVE_EVENT_STREAM_CONNECTED_EVENT,
      connected,
    );
    const stopReconcile = api.listen("gateway.reconcile-required", reconcileFrame);
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");

    source.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({
        event: "gateway.connected",
        payload: { status: "reconcile" },
      }),
      lastEventId: "",
    }));
    expect(connected).not.toHaveBeenCalled();

    source.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({
        event: "gateway.reconcile-required",
        payload: { reason: "cursor-expired" },
      }),
      lastEventId: "12345678:9",
    }));

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconcileFrame).not.toHaveBeenCalled();
    stopReconcile();
    stopConnected();
  });

  test("notifies listeners when a direct gateway stream connects", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(gatewayControlFrame("gateway.connected", "fresh")));
        },
      }), { status: 200 })
    ) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
    });

    await new Promise<void>((resolve) => {
      const unsubscribe = api.listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
        unsubscribe();
        resolve();
      });
    });
  });

  test("reconciles only fresh streams and explicit replay misses across direct reconnects", async () => {
    const encoder = new TextEncoder();
    const warning = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warning;
    let attempt = 0;
    const attemptsAtConnect: number[] = [];
    const requestUrls: string[] = [];
    globalThis.fetch = mock(async (input) => {
      requestUrls.push(String(input));
      attempt += 1;
      if (attempt === 1) return new Response(null, { status: 503 });
      return new Response(new ReadableStream({
        start(controller) {
          // Each attempt issues a distinct id so a `since` assertion below
          // cannot be satisfied by a cursor that never advanced.
          if (attempt === 2) {
            controller.enqueue(encoder.encode(
              gatewayControlFrame("gateway.connected", "fresh", "12345678:2"),
            ));
            controller.close();
          } else if (attempt === 3) {
            controller.enqueue(encoder.encode(
              gatewayControlFrame("gateway.connected", "caught-up", "12345678:3"),
            ));
            controller.close();
          } else {
            controller.enqueue(encoder.encode(
              gatewayControlFrame("gateway.connected", "reconcile", "12345678:3"),
            ));
            controller.enqueue(encoder.encode(
              gatewayControlFrame("gateway.reconcile-required", "cursor-expired", "12345678:9"),
            ));
          }
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      eventReconnectDelayMs: 0,
    });

    try {
      await new Promise<void>((resolve) => {
        const unsubscribe = api.listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
          attemptsAtConnect.push(attempt);
          if (attemptsAtConnect.length === 2) {
            unsubscribe();
            resolve();
          }
        });
      });

      // The 503 attempt throws before the connected event is dispatched, so the
      // first notification belongs to attempt 2 and never to attempt 1.
      expect(attemptsAtConnect[0]).toBe(2);
      expect(attemptsAtConnect[1]).toBe(4);
      // The first attempt has no cursor to resume from; every later one carries
      // the newest id the previous attempt actually delivered.
      expect(new URL(requestUrls[0]!).searchParams.has("since")).toBe(false);
      expect(new URL(requestUrls[1]!).searchParams.has("since")).toBe(false);
      expect(new URL(requestUrls[2]!).searchParams.get("since")).toBe("12345678:2");
      expect(new URL(requestUrls[3]!).searchParams.get("since")).toBe("12345678:3");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("resumes a direct fetch reconnect from the newest authoritative event id", async () => {
    const encoder = new TextEncoder();
    const requestUrls: string[] = [];
    let attempt = 0;
    globalThis.fetch = mock(async (input) => {
      requestUrls.push(String(input));
      attempt += 1;
      if (attempt === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(
              gatewayControlFrame("gateway.connected", "fresh", "12345678:0"),
            ));
            controller.enqueue(encoder.encode(
              'id: 12345678:7\ndata: {"event":"changed","payload":"latest"}\n\n',
            ));
            controller.close();
          },
        }), { status: 200 });
      }
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      eventReconnectDelayMs: 0,
    });
    const changed = mock(() => undefined);
    const unsubscribe = api.listen("changed", changed);

    await waitForCondition(
      () => requestUrls.length === 2,
      "The direct stream did not reconnect",
    );

    expect(changed).toHaveBeenCalledWith("latest");
    expect(new URL(requestUrls[1]!).searchParams.get("since")).toBe("12345678:7");
    unsubscribe();
  });

  test("takes the last id in a block and ignores id-only and empty-id frames", async () => {
    const encoder = new TextEncoder();
    const requestUrls: string[] = [];
    let attempt = 0;
    globalThis.fetch = mock(async (input) => {
      requestUrls.push(String(input));
      attempt += 1;
      if (attempt === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            // Last id wins within a block, per the SSE field-parsing rules.
            controller.enqueue(encoder.encode(
              'id: 12345678:1\nid: 12345678:4\ndata: {"event":"changed","payload":"multi"}\n\n',
            ));
            // No data means nothing to dispatch and no cursor to adopt.
            controller.enqueue(encoder.encode("id: 12345678:5\n\n"));
            // A blank id must not blank the cursor the client already holds.
            controller.enqueue(encoder.encode(
              'id: \ndata: {"event":"changed","payload":"blank-id"}\n\n',
            ));
            // A comment-only frame is a keepalive, not an event.
            controller.enqueue(encoder.encode(": keepalive\n\n"));
            controller.close();
          },
        }), { status: 200 });
      }
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      eventReconnectDelayMs: 0,
    });
    const changed = mock((_payload: unknown) => undefined);
    const unsubscribe = api.listen("changed", changed);

    await waitForCondition(
      () => requestUrls.length === 2,
      "The direct stream did not reconnect",
    );

    expect(changed.mock.calls.map(([payload]) => payload)).toEqual(["multi", "blank-id"]);
    expect(new URL(requestUrls[1]!).searchParams.get("since")).toBe("12345678:4");
    unsubscribe();
  });

  test("reassembles a direct fetch frame split across chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const requestUrls: string[] = [];
    let attempt = 0;
    globalThis.fetch = mock(async (input) => {
      requestUrls.push(String(input));
      attempt += 1;
      if (attempt === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            // The id, the data, and even the blank-line terminator arrive in
            // separate reads — a stream that only parsed whole chunks would
            // drop the frame and never advance its cursor.
            controller.enqueue(encoder.encode("id: 1234"));
            controller.enqueue(encoder.encode('5678:6\ndata: {"event":"cha'));
            controller.enqueue(encoder.encode('nged","payload":"split"}\r\n'));
            controller.enqueue(encoder.encode("\r\n"));
            controller.close();
          },
        }), { status: 200 });
      }
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      eventReconnectDelayMs: 0,
    });
    const changed = mock(() => undefined);
    const unsubscribe = api.listen("changed", changed);

    await waitForCondition(
      () => requestUrls.length === 2,
      "The direct stream did not reconnect",
    );

    expect(changed).toHaveBeenCalledWith("split");
    expect(new URL(requestUrls[1]!).searchParams.get("since")).toBe("12345678:6");
    unsubscribe();
  });

  test("ignores a server frame that impersonates the transport connected event", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            gatewayControlFrame("gateway.connected", "fresh"),
          ));
          controller.enqueue(encoder.encode(
            `data: {"event":"${NATIVE_EVENT_STREAM_CONNECTED_EVENT}","payload":"spoofed"}\n\n`,
          ));
          controller.enqueue(encoder.encode('data: {"event":"changed","payload":"real"}\n\n'));
        },
      }), { status: 200 })
    ) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
    });

    const connectedPayloads: unknown[] = [];
    const stopConnected = api.listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, (payload) => {
      connectedPayloads.push(payload);
    });

    const changed = await new Promise<string>((resolve) => {
      const unsubscribe = api.listen<string>("changed", (value) => {
        unsubscribe();
        resolve(value);
      });
    });
    stopConnected();

    expect(changed).toBe("real");
    // Exactly one notification: the synthetic connect. The server frame carrying
    // the same event name must not reach transport listeners.
    expect(connectedPayloads).toEqual([undefined]);
  });

  test("tolerates a connect with no subscribers for the connected event", async () => {
    globalThis.fetch = mock(async () =>
      new Response(new ReadableStream({ start() {} }), { status: 200 })
    ) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
    });

    // Only "changed" is subscribed, so dispatchEvent finds no callback set for
    // the connected event and must return without throwing.
    const unsubscribe = api.listen("changed", () => undefined);
    await Promise.resolve();
    expect(() => unsubscribe()).not.toThrow();
  });

  test("throws gateway invoke errors from non-ok responses", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ error: "not allowed" }), { status: 403 })
    ) as unknown as typeof fetch;

    const api = createBrowserGatewayApi();

    await expect(api.invoke("get_projects")).rejects.toThrow("not allowed");
  });

  test("carries the HTTP status on the thrown invoke error", async () => {
    /*
     * The status has to survive as a property. `classifyNewEnvironmentConnection
     * StartupError` retries an infrastructure 502/503/504 by reading
     * `error.status`; with the code only interpolated into the message, that
     * branch could never fire for any error the renderer actually sees.
     */
    globalThis.fetch = mock(async () =>
      new Response("<html>Bad Gateway</html>", { status: 502 })
    ) as unknown as typeof fetch;

    const api = createBrowserGatewayApi();

    const error = await api.invoke("start_claude_server_cmd").then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as { status?: unknown }).status).toBe(502);
    // A non-JSON body still yields an actionable message.
    expect((error as Error).message).toBe("Gateway command failed with HTTP 502");
  });

  test("keeps the backend's own message for a command that failed", async () => {
    // A failing backend command comes back as 500 with its message, so the
    // startup classifier decides on the text rather than the envelope status.
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ error: "Container is not running" }), {
        status: 500,
      })
    ) as unknown as typeof fetch;

    const api = createBrowserGatewayApi();

    const error = await api.invoke("start_claude_server_cmd").then(
      () => null,
      (reason: unknown) => reason,
    );
    expect((error as Error).message).toBe("Container is not running");
    expect((error as { status?: unknown }).status).toBe(500);
  });

  test("reads and updates gateway token settings through the authenticated endpoint", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({ input: String(input), init });
      const token = init?.method === "PUT" ? "replacement-token-123456" : "gateway-token-123456";
      return new Response(JSON.stringify({ token, editable: true, source: "file" }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi();

    await expect(api.webClient.getTokenSettings()).resolves.toMatchObject({ token: "gateway-token-123456" });
    await expect(api.webClient.setToken("replacement-token-123456")).resolves.toMatchObject({
      token: "replacement-token-123456",
    });
    expect(requests).toEqual([
      {
        input: "/__orkestrator/gateway-settings",
        init: { credentials: "same-origin" },
      },
      {
        input: "/__orkestrator/gateway-settings",
        init: {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "replacement-token-123456" }),
        },
      },
    ]);
  });

  test("uses a rotated direct token for later requests and reports the change", async () => {
    const authorization: Array<string | null> = [];
    const onTokenChanged = mock(() => undefined);
    globalThis.fetch = mock(async (input, init) => {
      authorization.push(new Headers(init?.headers).get("authorization"));
      if (String(input).endsWith("/gateway-settings")) {
        return new Response(JSON.stringify({
          token: "replacement-token-123456",
          editable: true,
          source: "file",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      onTokenChanged,
    });

    await api.webClient.setToken("replacement-token-123456");
    await api.invoke("get_projects");

    expect(authorization).toEqual([
      "Bearer direct-token-123456",
      "Bearer replacement-token-123456",
    ]);
    expect(onTokenChanged).toHaveBeenCalledWith("replacement-token-123456");
  });

  test("reports browser gateway status and rejects desktop-only lifecycle controls", async () => {
    const api = createBrowserGatewayApi();

    await expect(api.webClient.getStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      url: `${window.location.origin}/`,
      error: null,
      resetAvailable: false,
    });
    await expect(api.webClient.setEnabled()).rejects.toThrow("only available in the desktop app");
    await expect(api.webClient.resetServe()).rejects.toThrow("only available for the local desktop app");
  });

  test("surfaces JSON and non-JSON errors from gateway token requests", async () => {
    globalThis.fetch = mock()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "token unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response("upstream failed", { status: 502 })) as unknown as typeof fetch;
    const api = createBrowserGatewayApi();

    await expect(api.webClient.getTokenSettings()).rejects.toThrow("token unavailable");
    await expect(api.webClient.setToken("replacement-token-123456")).rejects.toThrow(
      "Gateway settings request failed with HTTP 502",
    );
  });

  test("subscribes to gateway events and closes the stream when idle", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const callback = mock(() => undefined);

    const unsubscribe = api.listen("menu-zoom", callback);

    expect(MockEventSource.instances).toHaveLength(1);
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");
    expect(source.url).toBe(
      "/__orkestrator/events?excludeEvents=terminal-output-",
    );
    expect(source.options).toEqual({ withCredentials: true });

    const connectedCallback = mock(() => undefined);
    const unsubscribeConnected = api.listen(
      NATIVE_EVENT_STREAM_CONNECTED_EVENT,
      connectedCallback,
    );
    source.onopen?.({} as Event);
    source.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({
        event: "gateway.connected",
        payload: { status: "fresh" },
      }),
      lastEventId: "12345678:0",
    }));
    expect(connectedCallback).toHaveBeenCalledTimes(1);

    source.onmessage?.({
      data: JSON.stringify({ event: "other", payload: "out" }),
    } as MessageEvent);
    source.onmessage?.({ data: "not json" } as MessageEvent);
    source.onmessage?.({
      data: JSON.stringify({ event: "menu-zoom", payload: "in" }),
    } as MessageEvent);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("in");

    const warning = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warning;
    try {
      source.onerror?.();
      expect(warning).toHaveBeenCalledWith("[RemoteGateway] Event stream disconnected");
    } finally {
      console.warn = originalWarn;
    }

    unsubscribeConnected();
    unsubscribe();

    expect(source.closed).toBe(true);
  });

  test("retains the newest browser cursor across automatic retry and stream recreation", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const warning = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warning;
    try {
      const api = createBrowserGatewayApi();
      const cursorCallback = mock(() => undefined);
      const unsubscribe = api.listen("gateway.cursor", cursorCallback);
      const firstSource = MockEventSource.instances[0];
      if (!firstSource) throw new Error("EventSource was not created");

      firstSource.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({
          event: "gateway.cursor",
          payload: { generation: "12345678", revision: 5 },
        }),
        lastEventId: "12345678:5",
      }));

      // CONNECTING means the browser owns the retry. The client must keep the
      // same EventSource and continue accepting its later authoritative IDs.
      firstSource.fail(EVENT_SOURCE_CONNECTING);
      expect(MockEventSource.instances).toHaveLength(1);
      expect(firstSource.closed).toBe(false);
      firstSource.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({
          event: "gateway.cursor",
          payload: { generation: "12345678", revision: 8 },
        }),
        lastEventId: "12345678:8",
      }));

      expect(cursorCallback).not.toHaveBeenCalled();
      unsubscribe();
      expect(firstSource.closed).toBe(true);

      const stopReplacement = api.listen("menu-zoom", () => undefined);
      expect(MockEventSource.instances).toHaveLength(2);
      expect(MockEventSource.instances[1]?.url).toBe(
        "/__orkestrator/events?excludeEvents=terminal-output-&since=12345678%3A8",
      );
      stopReplacement();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("rebuilds the authoritative browser stream after a fatal error", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const warning = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warning;
    try {
      const api = createBrowserGatewayApi({ eventReconnectDelayMs: 0 });
      const unsubscribe = api.listen("menu-zoom", () => undefined);
      const first = MockEventSource.instances[0];
      if (!first) throw new Error("EventSource was not created");

      first.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({ event: "menu-zoom", payload: "in" }),
        lastEventId: "12345678:4",
      }));

      // CLOSED means the browser has given up. Nothing else rebuilds the main
      // stream, so leaving it here strands every authoritative event until the
      // tab reloads.
      first.fail(EVENT_SOURCE_CLOSED);
      await waitForCondition(
        () => MockEventSource.instances.length === 2,
        "The authoritative stream was not rebuilt after a fatal error",
      );
      expect(MockEventSource.instances[1]?.url).toBe(
        "/__orkestrator/events?excludeEvents=terminal-output-&since=12345678%3A4",
      );

      // The abandoned socket must not keep dispatching into the live listeners.
      const stale = mock(() => undefined);
      const stopStale = api.listen("menu-zoom", stale);
      first.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({ event: "menu-zoom", payload: "stale" }),
        lastEventId: "12345678:9",
      }));
      expect(stale).not.toHaveBeenCalled();
      stopStale();
      unsubscribe();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("does not rebuild a browser stream the browser is still retrying", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const warning = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warning;
    try {
      const api = createBrowserGatewayApi({ eventReconnectDelayMs: 0 });
      const unsubscribe = api.listen("menu-zoom", () => undefined);
      const source = MockEventSource.instances[0];
      if (!source) throw new Error("EventSource was not created");

      source.fail(EVENT_SOURCE_CONNECTING);
      expect(MockEventSource.instances).toHaveLength(1);
      expect(source.closed).toBe(false);
      unsubscribe();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("ignores replay control frames that arrive on a terminal stream", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const connected = mock(() => undefined);
    const stopConnected = api.listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, connected);
    const stopTerminal = api.listen("terminal-output-one", () => undefined);
    await waitForCondition(
      () => MockEventSource.instances.length === 2,
      "The terminal stream was not created",
    );
    const main = MockEventSource.instances[0];
    const terminal = MockEventSource.instances[1];
    if (!main || !terminal) throw new Error("Streams were not created");

    // A control frame has authority only on the authoritative stream. Acting on
    // one here would fire an app-wide resync, or latch the connection flag and
    // permanently suppress the main stream's own one-shot fresh announcement.
    for (const event of [
      "gateway.reconcile-required",
      "gateway.connected",
    ] as const) {
      terminal.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({
          event,
          payload: event === "gateway.connected"
            ? { status: "fresh" }
            : { reason: "cursor-expired" },
        }),
        lastEventId: "87654321:99",
      }));
    }
    expect(connected).not.toHaveBeenCalled();

    // The main stream's genuine handshake still announces exactly once.
    main.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({
        event: "gateway.connected",
        payload: { status: "fresh" },
      }),
      lastEventId: "12345678:3",
    }));
    expect(connected).toHaveBeenCalledTimes(1);

    // ...and the terminal frame's id never became the authoritative cursor.
    stopTerminal();
    stopConnected();
    const stopReplacement = api.listen("menu-zoom", () => undefined);
    const replacement = MockEventSource.instances.at(-1);
    expect(replacement?.url).toBe(
      "/__orkestrator/events?excludeEvents=terminal-output-&since=12345678%3A3",
    );
    stopReplacement();
  });

  test("never forwards replay control frames to ordinary listeners", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const connectedListener = mock(() => undefined);
    const cursorListener = mock(() => undefined);
    const reconcileListener = mock(() => undefined);
    const stops = [
      api.listen("gateway.connected", connectedListener),
      api.listen("gateway.cursor", cursorListener),
      api.listen("gateway.reconcile-required", reconcileListener),
    ];
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");

    for (const [event, payload] of [
      ["gateway.connected", { status: "fresh" }],
      ["gateway.cursor", { generation: "12345678", revision: 2 }],
      ["gateway.reconcile-required", { reason: "invalid-cursor" }],
    ] as const) {
      source.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({ event, payload }),
        lastEventId: "12345678:2",
      }));
    }

    expect(connectedListener).not.toHaveBeenCalled();
    expect(cursorListener).not.toHaveBeenCalled();
    expect(reconcileListener).not.toHaveBeenCalled();
    for (const stop of stops) stop();
  });

  test("keeps the terminal stream URL free of the authoritative cursor", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const stopMain = api.listen("menu-zoom", () => undefined);
    const main = MockEventSource.instances[0];
    if (!main) throw new Error("EventSource was not created");
    main.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({ event: "menu-zoom", payload: "in" }),
      lastEventId: "12345678:7",
    }));

    const stopTerminal = api.listen("terminal-output-one", () => undefined);
    await waitForCondition(
      () => MockEventSource.instances.length === 2,
      "The terminal stream was not created",
    );

    // Terminal streams have their own snapshot protocol and are deliberately
    // absent from the replay sequence; a cursor here would make the gateway
    // treat them as replay participants.
    expect(MockEventSource.instances[1]?.url).toBe(
      "/__orkestrator/events?excludeEvents=terminal-output-&includeEvents=terminal-output-one",
    );
    expect(MockEventSource.instances[1]?.url).not.toContain("since");
    stopTerminal();
    stopMain();
  });

  test("keeps the authoritative stream stable and uses one filtered browser terminal stream", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();

    const unsubscribeMenu = api.listen("menu-zoom", () => undefined);
    const firstSource = MockEventSource.instances[0];
    if (!firstSource) throw new Error("EventSource was not created");

    const unsubscribeTerminal = api.listen(
      "terminal-output-session:one",
      () => undefined,
    );
    await Promise.resolve();

    expect(firstSource.closed).toBe(false);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]?.url).toBe(
      "/__orkestrator/events?excludeEvents=terminal-output-&includeEvents=terminal-output-session%3Aone",
    );
    let ready = false;
    const readyPromise = api.eventStreamReady("terminal-output-session:one")
      .then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    MockEventSource.instances[1]?.onopen?.();
    await readyPromise;
    expect(ready).toBe(true);

    unsubscribeTerminal();
    await Promise.resolve();
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]?.closed).toBe(true);
    expect(firstSource.closed).toBe(false);

    unsubscribeMenu();
    expect(firstSource.closed).toBe(true);
  });

  test("aborts a terminal stream that never becomes ready when its listener leaves", async () => {
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
    });

    const unsubscribe = api.listen("terminal-output-stuck", () => undefined);
    const ready = api.eventStreamReady("terminal-output-stuck");
    await Promise.resolve();
    expect(requestSignal?.aborted).toBe(false);

    unsubscribe();

    expect(requestSignal?.aborted).toBe(true);
    await expect(ready).resolves.toBeUndefined();
  });

  test("multiplexes added terminals and resynchronizes existing listeners after the filter changes", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const firstOutput = mock(() => undefined);
    const secondOutput = mock(() => undefined);

    const stopFirst = api.listen("terminal-output-one", firstOutput);
    await Promise.resolve();
    const firstSource = MockEventSource.instances[0]!;
    firstSource.onopen?.();
    await api.eventStreamReady("terminal-output-one");

    const stopSecond = api.listen("terminal-output-two", secondOutput);
    await Promise.resolve();
    const secondSource = MockEventSource.instances[1]!;
    expect(firstSource.closed).toBe(true);
    expect(secondSource.url).toBe(
      "/__orkestrator/events?excludeEvents=terminal-output-&includeEvents=terminal-output-one%2Cterminal-output-two",
    );
    secondSource.onopen?.();
    await api.eventStreamReady("terminal-output-two");
    expect(firstOutput).toHaveBeenCalledWith({ desynced: true });
    expect(secondOutput).not.toHaveBeenCalled();

    secondSource.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({ event: "terminal-output-one", payload: "YQ==" }),
    }));
    expect(firstOutput).toHaveBeenLastCalledWith("YQ==");
    expect(secondOutput).not.toHaveBeenCalled();

    stopSecond();
    await Promise.resolve();
    const thirdSource = MockEventSource.instances[2]!;
    expect(secondSource.closed).toBe(true);
    expect(thirdSource.url).toBe(
      "/__orkestrator/events?excludeEvents=terminal-output-&includeEvents=terminal-output-one",
    );
    thirdSource.onopen?.();
    expect(firstOutput).toHaveBeenLastCalledWith({ desynced: true });
    stopFirst();
    await Promise.resolve();
    expect(thirdSource.closed).toBe(true);
  });

  test("coalesces many same-origin terminal listeners into one WebKit-safe stream", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();

    const stops = Array.from({ length: 12 }, (_, index) =>
      api.listen(`terminal-output-session-${index}`, () => undefined)
    );
    await Promise.resolve();

    expect(MockEventSource.instances).toHaveLength(1);
    const source = MockEventSource.instances[0]!;
    const url = new URL(source.url, "https://workstation.tailnet.ts.net");
    expect(url.searchParams.get("includeEvents")?.split(",")).toEqual(
      Array.from({ length: 12 }, (_, index) => `terminal-output-session-${index}`)
        .sort(),
    );

    source.onopen?.();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        api.eventStreamReady(`terminal-output-session-${index}`)
      ),
    );

    for (const stop of stops) stop();
    await Promise.resolve();
    expect(source.closed).toBe(true);
  });

  test("leaves the shared stream alone when a terminal resubscribes the same event", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const firstOutput = mock(() => undefined);

    const stopFirst = api.listen("terminal-output-one", firstOutput);
    const stopSecond = api.listen("terminal-output-two", () => undefined);
    await Promise.resolve();
    expect(MockEventSource.instances).toHaveLength(1);
    const source = MockEventSource.instances[0]!;
    source.open();
    await api.eventStreamReady("terminal-output-one");
    expect(firstOutput).not.toHaveBeenCalled();

    // A terminal reconnecting to the same PTY drops and re-adds the identical
    // `terminal-output-<sessionId>` event. The filter is unchanged, so tearing
    // the socket down would desync the *other* terminal for nothing.
    stopSecond();
    const stopSecondAgain = api.listen("terminal-output-two", () => undefined);
    await Promise.resolve();

    expect(MockEventSource.instances).toHaveLength(1);
    expect(source.closed).toBe(false);
    expect(firstOutput).not.toHaveBeenCalled();

    // The resubscribed stream still has to become ready: it is riding an
    // already-open socket, so no further `onopen` is coming for it.
    await api.eventStreamReady("terminal-output-two");

    source.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({ event: "terminal-output-one", payload: "YQ==" }),
    }));
    expect(firstOutput).toHaveBeenCalledWith("YQ==");

    stopFirst();
    stopSecondAgain();
    await Promise.resolve();
    expect(source.closed).toBe(true);
  });

  test("rebuilds the shared terminal stream only after a fatal disconnect", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const warning = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warning;
    const api = createBrowserGatewayApi({ eventReconnectDelayMs: 1 });
    const output = mock(() => undefined);

    try {
      const stop = api.listen("terminal-output-session-1", output);
      await Promise.resolve();
      const source = MockEventSource.instances[0]!;
      source.open();
      await api.eventStreamReady("terminal-output-session-1");

      // A CONNECTING socket is one the browser is still retrying itself.
      // Rebuilding here would race that retry.
      source.fail(EVENT_SOURCE_CONNECTING);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(MockEventSource.instances).toHaveLength(1);
      expect(warning).toHaveBeenCalledWith(
        "[RemoteGateway] Terminal event stream disconnected",
      );

      // A CLOSED socket is dead. Nothing else rebuilds it, and every browser
      // terminal now shares this one socket.
      source.fail(EVENT_SOURCE_CLOSED);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(MockEventSource.instances).toHaveLength(2);
      const replacement = MockEventSource.instances[1]!;
      expect(replacement.url).toBe(
        "/__orkestrator/events?excludeEvents=terminal-output-&includeEvents=terminal-output-session-1",
      );

      // The rebuilt socket missed whatever the PTY emitted while it was dead,
      // so the terminal must be told to reconcile rather than resume silently.
      replacement.open();
      expect(output).toHaveBeenCalledWith({ desynced: true });

      stop();
      await Promise.resolve();
      expect(replacement.closed).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("does not rebuild a dead shared stream once its last listener has left", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const warning = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warning;
    const api = createBrowserGatewayApi({ eventReconnectDelayMs: 1 });

    try {
      const stop = api.listen("terminal-output-session-1", () => undefined);
      await Promise.resolve();
      const source = MockEventSource.instances[0]!;
      source.open();
      await api.eventStreamReady("terminal-output-session-1");

      source.fail(EVENT_SOURCE_CLOSED);
      // Unsubscribing before the backoff elapses must cancel the pending
      // rebuild; reconnecting a stream nobody consumes would leak a socket.
      stop();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(MockEventSource.instances).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("ignores a superseded shared stream that opens or delivers late", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const firstOutput = mock(() => undefined);

    const stopFirst = api.listen("terminal-output-one", firstOutput);
    await Promise.resolve();
    const staleSource = MockEventSource.instances[0]!;
    staleSource.open();
    await api.eventStreamReady("terminal-output-one");

    const stopSecond = api.listen("terminal-output-two", () => undefined);
    await Promise.resolve();
    expect(MockEventSource.instances).toHaveLength(2);
    expect(staleSource.closed).toBe(true);

    // A socket the gateway has already replaced must not be able to dispatch
    // into the live generation, nor resurrect itself as the current source.
    staleSource.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({ event: "terminal-output-one", payload: "YQ==" }),
    }));
    expect(firstOutput).not.toHaveBeenCalled();

    staleSource.onopen?.();
    expect(firstOutput).not.toHaveBeenCalled();

    // A late fatal error on the stale socket must not schedule a rebuild of the
    // live one either.
    const originalWarn = console.warn;
    console.warn = mock(() => undefined);
    try {
      staleSource.fail(EVENT_SOURCE_CLOSED);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(MockEventSource.instances).toHaveLength(2);
    } finally {
      console.warn = originalWarn;
    }

    stopFirst();
    stopSecond();
    await Promise.resolve();
  });

  test("tells a reconnected direct terminal stream to resynchronize", async () => {
    const encoder = new TextEncoder();
    const warning = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warning;
    let attempt = 0;
    globalThis.fetch = mock(async () => {
      attempt += 1;
      return new Response(new ReadableStream({
        start(controller) {
          // Only the first connection carries output; every later one stands in
          // for a socket the gateway dropped under backpressure.
          if (attempt === 1) {
            controller.enqueue(encoder.encode(
              'data: {"event":"terminal-output-session-1","payload":{"bytesBase64":"YQ==","revision":1,"generation":1}}\n\n',
            ));
          }
          controller.close();
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      eventReconnectDelayMs: 0,
    });

    try {
      const payloads: unknown[] = [];
      let stop = () => {};
      await new Promise<void>((resolve) => {
        stop = api.listen<{ desynced?: boolean }>(
          "terminal-output-session-1",
          (payload) => {
            payloads.push(payload);
            if (payload?.desynced) resolve();
          },
        );
      });
      stop();

      // The gateway has no replay buffer, so everything the PTY emitted during
      // the gap is gone from this socket. Without the synthetic desync notice
      // none of the consumer's reconcile triggers fire and the terminal stays
      // permanently truncated.
      expect(payloads[0]).toEqual({
        bytesBase64: "YQ==",
        revision: 1,
        generation: 1,
      });
      expect(payloads[1]).toEqual({ desynced: true });
      expect(attempt).toBeGreaterThanOrEqual(2);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("tells a reconnected browser EventSource terminal stream to resynchronize", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const payloads: unknown[] = [];
    const stop = api.listen("terminal-output-session-1", (payload) => {
      payloads.push(payload);
    });
    await Promise.resolve();
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");

    source.onopen?.();
    await api.eventStreamReady("terminal-output-session-1");
    // A first connection has nothing to reconcile against.
    expect(payloads).toEqual([]);

    source.onopen?.();
    expect(payloads).toEqual([{ desynced: true }]);

    // Resyncing must stay scoped to this terminal; the app-wide connected event
    // would make every other consumer refetch for one dropped byte stream.
    const connected = mock(() => undefined);
    const stopConnected = api.listen(
      NATIVE_EVENT_STREAM_CONNECTED_EVENT,
      connected,
    );
    source.onopen?.();
    expect(connected).not.toHaveBeenCalled();
    expect(payloads).toHaveLength(2);

    stopConnected();
    stop();
  });

  test("reconnects a direct terminal stream on its configured delay and stops once its listener leaves", async () => {
    const warning = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warning;
    let attempt = 0;
    globalThis.fetch = mock(async () => {
      attempt += 1;
      return new Response(new ReadableStream({
        start(controller) { controller.close(); },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const slow = createBrowserGatewayApi({
        baseUrl: "https://workstation.tailnet.ts.net",
        token: "direct-token-123456",
        eventReconnectDelayMs: 60_000,
      });
      const stopSlow = slow.listen("terminal-output-slow", () => undefined);
      await slow.eventStreamReady("terminal-output-slow");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      // The retry is on a timer, so a long delay must not busy-reconnect.
      expect(attempt).toBe(1);
      stopSlow();

      const fast = createBrowserGatewayApi({
        baseUrl: "https://workstation.tailnet.ts.net",
        token: "direct-token-123456",
        eventReconnectDelayMs: 0,
      });
      const stopFast = fast.listen("terminal-output-fast", () => undefined);
      await new Promise<void>((resolve) => {
        const poll = () => (attempt >= 4 ? resolve() : setTimeout(poll, 1));
        poll();
      });

      stopFast();
      const attemptsAtStop = attempt;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      // Nothing consumes this terminal any more, so the retry loop must end
      // rather than reconnecting a stream forever in the background.
      expect(attempt).toBe(attemptsAtStop);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("retries direct terminal streams after non-ok and bodyless responses, then cleans up", async () => {
    const warning = mock((_message: string, _error?: unknown) => undefined);
    const originalWarn = console.warn;
    console.warn = warning;
    const signals: AbortSignal[] = [];
    let attempt = 0;
    globalThis.fetch = mock(async (_input, init) => {
      attempt += 1;
      if (init?.signal) signals.push(init.signal);
      if (attempt === 1) return new Response(null, { status: 503 });
      if (attempt === 2) return new Response(null, { status: 200 });
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const api = createBrowserGatewayApi({
        baseUrl: "https://workstation.tailnet.ts.net",
        token: "direct-token-123456",
        eventReconnectDelayMs: 0,
      });
      const stop = api.listen("terminal-output-session-1", () => undefined);
      await api.eventStreamReady("terminal-output-session-1");

      expect(attempt).toBe(3);
      expect(warning).toHaveBeenCalledTimes(2);
      expect((warning.mock.calls[0]?.[1] as Error).message).toBe(
        "Gateway terminal event stream failed with HTTP 503",
      );
      expect((warning.mock.calls[1]?.[1] as Error).message).toBe(
        "Gateway terminal event stream failed with HTTP 200",
      );
      expect(signals[2]?.aborted).toBe(false);

      stop();
      expect(signals[2]?.aborted).toBe(true);
      await new Promise((resolve) => originalSetTimeout(resolve, 2));
      expect(attempt).toBe(3);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("leaves terminal readiness pending when a browser stream errors before opening", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const warning = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warning;
    const api = createBrowserGatewayApi();

    try {
      const stop = api.listen("terminal-output-session-1", () => undefined);
      await Promise.resolve();
      let ready = false;
      const readyPromise = api
        .eventStreamReady("terminal-output-session-1")
        .then(() => { ready = true; });
      const source = MockEventSource.instances[0];
      if (!source) throw new Error("EventSource was not created");

      source.onerror?.();
      await Promise.resolve();
      // An EventSource that never opens never latches readiness. Callers must
      // therefore bound their own wait (see NATIVE_EVENT_STREAM_READY_TIMEOUT_MS)
      // instead of assuming this promise always settles while the tab lives.
      expect(ready).toBe(false);
      expect(warning).toHaveBeenCalledWith(
        "[RemoteGateway] Terminal event stream disconnected",
      );

      // Dropping the listener still releases anyone already waiting.
      stop();
      await readyPromise;
      expect(ready).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("uses browser fallbacks for unavailable native-only APIs", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const api = createBrowserGatewayApi();

    await expect(api.clipboard.readText()).resolves.toBe("");
    await expect(api.clipboard.writeText("copy me")).resolves.toBeUndefined();
    await expect(api.clipboard.readImage()).resolves.toBeNull();
    await expect(api.clipboard.writeImage("data:image/png;base64,AA==")).resolves.toBeUndefined();
    await expect(api.dialog.open()).resolves.toBeNull();
    await expect(api.window.startDragging()).resolves.toBeUndefined();
    // Browser clients have no webContents to zoom, and reporting false is what
    // routes the renderer to its CSS `zoom` fallback.
    await expect(api.window.setZoomFactor(1.5)).resolves.toBe(false);
  });

  test("delegates text clipboard operations and closes the browser process", async () => {
    const readText = mock(async () => "clipboard contents");
    const writeText = mock(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText, writeText },
    });
    const originalClose = window.close;
    const close = mock(() => undefined);
    window.close = close;

    try {
      const api = createBrowserGatewayApi();
      await expect(api.clipboard.readText()).resolves.toBe("clipboard contents");
      await expect(api.clipboard.writeText("copy me")).resolves.toBeUndefined();
      expect(writeText).toHaveBeenCalledWith("copy me");
      await expect(api.process.exit()).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      window.close = originalClose;
    }
  });

  test("reads browser clipboard images for keyboard-driven paste", async () => {
    const imageBlob = pngBlob(32, 18);
    const getType = mock(async () => imageBlob);
    const read = mock(async () => [
      { types: ["text/plain", "image/png"], getType } as unknown as ClipboardItem,
    ]);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read },
    });

    const api = createBrowserGatewayApi();
    const result = await api.clipboard.readImage();
    expect(result).toEqual({ width: 32, height: 18, blob: imageBlob });
    expect(result).not.toHaveProperty("dataUrl");
    expect(read).toHaveBeenCalledTimes(1);
    expect(getType).toHaveBeenCalledWith("image/png");
  });

  test("returns null when browser clipboard items do not contain an image", async () => {
    const getType = mock(async () => new Blob(["text"], { type: "text/plain" }));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: mock(async () => [
          { types: ["text/plain"], getType } as unknown as ClipboardItem,
        ]),
      },
    });

    const api = createBrowserGatewayApi();
    await expect(api.clipboard.readImage()).resolves.toBeNull();
    expect(getType).not.toHaveBeenCalled();
  });

  test("allows large browser clipboard images through for renderer resizing", async () => {
    const getType = mock(async () => pngBlob(9000, 1));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: mock(async () => [
          { types: ["image/png"], getType } as unknown as ClipboardItem,
        ]),
      },
    });

    const api = createBrowserGatewayApi();
    await expect(api.clipboard.readImage()).resolves.toMatchObject({
      width: 9000,
      height: 1,
      blob: expect.any(Blob),
    });
  });

  test("rejects pathological browser clipboard dimensions", async () => {
    const getType = mock(async () => pngBlob(40000, 1));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: mock(async () => [
          { types: ["image/png"], getType } as unknown as ClipboardItem,
        ]),
      },
    });

    const api = createBrowserGatewayApi();
    await expect(api.clipboard.readImage()).rejects.toMatchObject({
      code: "too-large",
    });
  });
});
