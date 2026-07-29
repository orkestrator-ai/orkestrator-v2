import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  createBrowserGatewayApi,
  installBrowserGatewayApi,
} from "./web-gateway";
import {
  clearDirectGatewayTransport,
  configureDirectGatewayTransport,
} from "./gateway-auth-transport";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "./events";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
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
});

afterEach(() => {
  clearDirectGatewayTransport();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
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
    expect(reportedMetrics).toMatchObject({
      platform: "iphone-wkwebview",
      navigationType: "reload",
      nextHopProtocol: "http/1.1",
      transferSize: 321,
      jsTransferSize: 123,
      cssTransferSize: 45,
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

  test("announces every browser EventSource connection", () => {
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
    source.onopen?.();

    expect(connected).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  test("notifies listeners when a direct gateway stream connects", async () => {
    globalThis.fetch = mock(async () =>
      new Response(new ReadableStream({ start() {} }), { status: 200 })
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

  test("re-notifies connected listeners on each successful direct reconnect, not on failed attempts", async () => {
    const warning = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warning;
    let attempt = 0;
    const attemptsAtConnect: number[] = [];
    globalThis.fetch = mock(async () => {
      attempt += 1;
      // Fail the first attempt, then succeed and immediately end the stream so
      // the reconnect loop runs again.
      if (attempt === 1) return new Response(null, { status: 503 });
      return new Response(new ReadableStream({ start(controller) { controller.close(); } }), { status: 200 });
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
      expect(attemptsAtConnect[1]).toBe(3);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("ignores a server frame that impersonates the transport connected event", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () =>
      new Response(new ReadableStream({
        start(controller) {
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
