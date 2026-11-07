import { describe, expect, mock, spyOn, test } from "bun:test";
import { createNodeTransport, type NodeTransport } from "./node-transport";
import { browserWindowLifecycle, createWindowShell } from "./window-shell";
import {
  createBrowserGatewayApi,
  installBrowserGatewayApi,
  originalSetTimeout,
  pngBlob,
  type TestGatewayWindow,
  MockEventSource,
  waitForCondition,
  useGatewayTestGlobals,
} from "./web-gateway.test-support";

/**
 * The window-only half of the browser gateway API: cookie-session detection,
 * boot metrics, `webClient`, connections, clipboard, `process` and `window`.
 */
useGatewayTestGlobals();

describe("browser window shell", () => {
  for (const failure of ["network", "server"] as const) {
    test(`retries a ${failure} startup probe after connectivity returns`, async () => {
      const methods: string[] = [];
      globalThis.fetch = mock(async (_input, init) => {
        methods.push(init?.method ?? "GET");
        if (methods.length === 1) {
          if (failure === "network") throw new TypeError("offline");
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch;
      createBrowserGatewayApi({ browserSessionActivity: true });
      await Promise.resolve();
      await Promise.resolve();
      window.dispatchEvent(new Event("online"));
      await waitForCondition(() => methods.length === 2, "Probe did not retry");
      await Promise.resolve();
      window.dispatchEvent(new Event("pointerdown"));
      await waitForCondition(() => methods.includes("POST"), "Renewal did not resume");
    });
  }

  test("retries a failed startup probe without an online event", async () => {
    let probes = 0;
    globalThis.fetch = mock(async () => {
      probes++;
      return new Response(null, { status: probes === 1 ? 503 : 200 });
    }) as unknown as typeof fetch;
    createBrowserGatewayApi({ browserSessionActivity: true });
    await waitForCondition(() => probes === 2, "Backoff did not retry", 3000);
  });

  test("an initial session 401 starts login recovery once", async () => {
    const lapsed = mock(() => undefined);
    globalThis.fetch = mock(
      async () => new Response(null, { status: 401 }),
    ) as unknown as typeof fetch;
    createBrowserGatewayApi({ browserSessionActivity: true, onCredentialLapsed: lapsed });
    await waitForCondition(() => lapsed.mock.calls.length === 1, "Initial rejection was ignored");
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(lapsed).toHaveBeenCalledTimes(1);
  });

  test("renews cookie sessions only after explicit browser activity", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const lapsed = mock(() => undefined);
    globalThis.fetch = mock(async (input, init) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method });
      return method === "GET"
        ? new Response(JSON.stringify({ active: true }), { status: 200 })
        : new Response(null, { status: 401 });
    }) as unknown as typeof fetch;

    createBrowserGatewayApi({ browserSessionActivity: true, onCredentialLapsed: lapsed });
    await waitForCondition(() => calls.length === 1, "Cookie session was not detected");
    expect(calls).toEqual([{ url: "/__orkestrator/session", method: "GET" }]);

    window.dispatchEvent(new Event("pointerdown"));
    await waitForCondition(() => calls.length === 2, "Explicit activity did not renew the session");
    expect(calls[1]).toEqual({ url: "/__orkestrator/session", method: "POST" });

    // A 401 renewal is a lapsed session, so the tab is sent to the login page
    // rather than left rendering stale state, and both listeners come off so
    // unrelated later activity cannot become a background keepalive loop.
    await waitForCondition(() => lapsed.mock.calls.length === 1, "Lapsed session was not surfaced");
    window.dispatchEvent(new Event("keydown"));
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    expect(lapsed).toHaveBeenCalledTimes(1);
  });

  test("surfaces a lapsed cookie session detected by a command rather than by activity", async () => {
    // The idle deadline can pass with no keyboard or pointer activity at all, so
    // the authoritative signal is a 401 from a command the tab was already making.
    const lapsed = mock(() => undefined);
    let probes = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (!String(input).includes("/session")) {
        return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 });
      }
      probes += 1;
      return new Response(JSON.stringify({ active: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const api = createBrowserGatewayApi({
      browserSessionActivity: true,
      onCredentialLapsed: lapsed,
    });
    await waitForCondition(() => probes === 1, "Cookie session was not detected");

    await expect(api.invoke("list_projects")).rejects.toThrow("Authentication required");
    expect(lapsed).toHaveBeenCalledTimes(1);
    // Recovery happens once; a burst of failing commands must not fight over it.
    await expect(api.invoke("list_projects")).rejects.toThrow("Authentication required");
    expect(lapsed).toHaveBeenCalledTimes(1);
  });

  test("leaves a client with no cookie session alone when a command returns 401", async () => {
    // A durable-token client has no deadline to trip, so a 401 there is not a
    // lapsed session and must not navigate the tab away from the app.
    const lapsed = mock(() => undefined);
    let probes = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (!String(input).includes("/session")) {
        return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 });
      }
      probes += 1;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const api = createBrowserGatewayApi({
      browserSessionActivity: true,
      onCredentialLapsed: lapsed,
    });
    await waitForCondition(() => probes === 1, "Cookie session probe did not run");

    await expect(api.invoke("list_projects")).rejects.toThrow("Authentication required");
    expect(lapsed).not.toHaveBeenCalled();
  });

  test("probes for a cookie session on a same-origin install, never for a bearer client", async () => {
    // Every same-origin gateway client now holds an expiring cookie session
    // (login form or agent-test link). A bearer client has none to renew.
    const install = async (options: Parameters<typeof installBrowserGatewayApi>[1] = {}) => {
      const probed: string[] = [];
      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/__orkestrator/session")) probed.push(String(input));
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch;
      const fakeWindow: TestGatewayWindow = {
        location: { protocol: "http:" },
        orkestrator: undefined,
        orkestratorGateway: undefined,
      };
      installBrowserGatewayApi(
        fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
        options,
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(fakeWindow.orkestrator).toBeDefined();
      return probed;
    };

    expect(await install()).toHaveLength(1);
    expect(await install({ token: "bearer-token-123456" })).toHaveLength(0);
  });

  test("disposing a gateway stops its cookie-session activity renewals", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = mock(async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ active: true }), { status: 200 });
    }) as unknown as typeof fetch;
    // Boot metrics also POST from this install path, so every assertion below is
    // scoped to the session route rather than to the method alone.
    const sessionCalls = (method: string) =>
      calls.filter((call) => call.url.includes("/session") && call.method === method);
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "http:" },
      orkestrator: undefined,
      orkestratorGateway: undefined,
    };
    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      { browserSessionActivity: true },
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

  test("exposes an optional server-connections API", async () => {
    const connectionList = { activeConnectionId: "remote-1", connections: [] };
    const connections = {
      list: mock(async () => connectionList),
      probe: mock(async () => true),
      connect: mock(async () => connectionList),
      updateToken: mock(async () => connectionList),
      use: mock(async () => connectionList),
      forget: mock(async () => connectionList),
    };
    const api = createBrowserGatewayApi({ connections });
    expect(api.connections).toBeDefined();
    await expect(api.connections?.list()).resolves.toBe(connectionList);
    expect(createBrowserGatewayApi().connections).toBeUndefined();
  });

  test("enables boot metrics for every installed browser client", async () => {
    // The install path is the only place production turns boot metrics on, so
    // dropping the flag here would disable the feature everywhere.
    const metricsFetch = mock(async (input: RequestInfo | URL) =>
      String(input).includes("/session")
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 202 }),
    );
    globalThis.fetch = metricsFetch as unknown as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "https:" },
      orkestrator: undefined,
      orkestratorGateway: undefined,
    };

    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
    );
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
    globalThis.fetch = mock(
      async () => new Response(null, { status: 202 }),
    ) as unknown as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const FALLBACK_TIMER_ID = 15_000 as unknown as ReturnType<typeof setTimeout>;
    const cleared: unknown[] = [];
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
      delay === 15_000
        ? FALLBACK_TIMER_ID
        : originalSetTimeout(handler, delay, ...args)) as typeof setTimeout;
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
    await waitForCondition(
      () => metricsFetch.mock.calls.length === 1,
      "Boot metrics were not reported",
    );

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
      value: mock((entryType: string) =>
        entryType === "resource"
          ? [
              // A hashed bundle URL has no .css suffix, so only initiatorType
              // classifies it.
              {
                name: "https://cdn.test/a1b2c3",
                initiatorType: "css",
                transferSize: 10,
                decodedBodySize: 20,
              },
              {
                name: "https://cdn.test/app.css",
                initiatorType: "link",
                transferSize: 5,
                decodedBodySize: 6,
              },
              {
                name: "https://cdn.test/app.js",
                initiatorType: "script",
                transferSize: 7,
                decodedBodySize: 8,
              },
            ]
          : [],
      ),
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
          return [
            {
              type: "reload",
              nextHopProtocol: "http/1.1",
              transferSize: 321,
              encodedBodySize: 222,
              decodedBodySize: 654,
              domContentLoadedEventEnd: 11,
              loadEventEnd: 19,
            },
          ];
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
      value: mock((entryType: string) => (entryType === "navigation" ? [{ loadEventEnd }] : [])),
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
      if (String(input).endsWith("/events?excludeEvents=terminal-output-&relayedEvents=per-node")) {
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

  test("reads and updates gateway token settings through the authenticated endpoint", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({ input: String(input), init });
      const token = init?.method === "PUT" ? "replacement-token-123456" : "gateway-token-123456";
      return new Response(JSON.stringify({ token, editable: true, source: "file" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi();

    await expect(api.webClient.getTokenSettings()).resolves.toMatchObject({
      token: "gateway-token-123456",
    });
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
        return new Response(
          JSON.stringify({
            token: "replacement-token-123456",
            editable: true,
            source: "file",
          }),
          { status: 200 },
        );
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
    await expect(api.webClient.resetServe()).rejects.toThrow(
      "only available for the local desktop app",
    );
  });

  test("surfaces JSON and non-JSON errors from gateway token requests", async () => {
    globalThis.fetch = mock()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "token unavailable" }), { status: 503 }),
      )
      .mockResolvedValueOnce(
        new Response("upstream failed", { status: 502 }),
      ) as unknown as typeof fetch;
    const api = createBrowserGatewayApi();

    await expect(api.webClient.getTokenSettings()).rejects.toThrow("token unavailable");
    await expect(api.webClient.setToken("replacement-token-123456")).rejects.toThrow(
      "Gateway settings request failed with HTTP 502",
    );
  });

  test("uses browser fallbacks for unavailable native-only APIs", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const api = createBrowserGatewayApi();

    await expect(api.clipboard.readText()).resolves.toBe("");
    await expect(api.clipboard.writeText("copy me")).rejects.toThrow(
      "Clipboard text writes are not supported by this browser",
    );
    await expect(api.clipboard.readImage()).resolves.toBeNull();
    await expect(api.clipboard.writeImage("data:image/png;base64,AA==")).resolves.toBeUndefined();
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
        read: mock(async () => [{ types: ["text/plain"], getType } as unknown as ClipboardItem]),
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
        read: mock(async () => [{ types: ["image/png"], getType } as unknown as ClipboardItem]),
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
        read: mock(async () => [{ types: ["image/png"], getType } as unknown as ClipboardItem]),
      },
    });

    const api = createBrowserGatewayApi();
    await expect(api.clipboard.readImage()).rejects.toMatchObject({
      code: "too-large",
    });
  });
});

describe("the window shell wires itself into its command transport", () => {
  test("a credential refusal the transport reports reaches the cookie session", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) =>
      String(input).endsWith("/session")
        ? new Response("{}", { status: 200 })
        : new Response("{}", { status: 401 }),
    ) as unknown as typeof fetch;
    const lapsed = mock(() => undefined);
    let transport: NodeTransport | null = null;
    const shell = createWindowShell(
      { browserSessionActivity: true, onCredentialLapsed: lapsed },
      (hooks) => {
        transport = createNodeTransport({
          baseUrl: null,
          resolvePageUrl: (pathname) => pathname,
          onCredentialRejected: hooks.onCredentialRejected,
          metrics: hooks.metrics,
          lifecycle: hooks.lifecycle,
        });
        return transport;
      },
    );
    try {
      expect(shell.transport).toBe(transport!);
      await waitForCondition(
        () => (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0,
        "The cookie session was never probed",
      );
      await new Promise((resolve) => originalSetTimeout(resolve, 5));
      // A command's 401 is reported by the transport and handled by the shell.
      await expect(shell.transport.invoke("ping")).rejects.toMatchObject({ status: 401 });
      expect(lapsed).toHaveBeenCalledTimes(1);
    } finally {
      shell.transport.dispose();
      shell.dispose();
    }
  });

  test("webClient status names the command transport's own base", async () => {
    const shell = createWindowShell({}, () =>
      createNodeTransport({ baseUrl: "https://command.example/" }),
    );
    try {
      await expect(shell.api.webClient.getStatus()).resolves.toMatchObject({
        url: "https://command.example/",
      });
    } finally {
      shell.transport.dispose();
      shell.dispose();
    }
  });

  test("the browser lifecycle adds each DOM listener on subscribe and removes it on stop", () => {
    const added = spyOn(window, "addEventListener");
    const removed = spyOn(window, "removeEventListener");
    try {
      const lifecycle = browserWindowLifecycle();
      const hiding: boolean[] = [];
      const stop = lifecycle.onPageHide((value) => hiding.push(value));
      expect(added.mock.calls.map(([type]) => type)).toEqual(["pagehide", "pageshow"]);
      window.dispatchEvent(new Event("pagehide"));
      window.dispatchEvent(new Event("pageshow"));
      expect(hiding).toEqual([true, false]);
      stop();
      expect(removed.mock.calls.map(([type]) => type)).toEqual(["pagehide", "pageshow"]);
      window.dispatchEvent(new Event("pagehide"));
      expect(hiding).toEqual([true, false]);
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
  });
});
