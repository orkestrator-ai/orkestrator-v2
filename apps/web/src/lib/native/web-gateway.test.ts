import { describe, expect, mock, test } from "bun:test";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "./events";
import {
  gatewayWarnings,
  createBrowserGatewayApi,
  installBrowserGatewayApi,
  originalSetTimeout,
  type TestGatewayWindow,
  EVENT_SOURCE_CONNECTING,
  EVENT_SOURCE_CLOSED,
  gatewayControlFrame,
  MockEventSource,
  waitForCondition,
  useGatewayTestGlobals,
} from "./web-gateway.test-support";

/** Installation, commands and the authoritative and filtered event streams. */
useGatewayTestGlobals();

describe("web gateway browser API", () => {
  test("installs only when the Electron preload API is absent", () => {
    const existingApi = { invoke: mock(async () => null) } as unknown as Window["orkestrator"];
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "http:" },
      orkestrator: existingApi,
      orkestratorGateway: undefined,
    };

    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
    );

    expect(fakeWindow.orkestrator).toBe(existingApi);
    expect(fakeWindow.orkestratorGateway).toBeUndefined();

    fakeWindow.orkestrator = undefined;
    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
    );

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

  test("installing a direct client patches neither fetch nor EventSource", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const pageFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;
    globalThis.fetch = pageFetch;
    const pageEventSource = globalThis.EventSource;
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
    expect(globalThis.fetch).toBe(pageFetch);
    expect(globalThis.EventSource).toBe(pageEventSource);

    // The transport sends its own bearer; a raw page fetch carries none.
    await (fakeWindow.orkestrator as Window["orkestrator"])?.invoke("get_projects");
    await globalThis.fetch(
      "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback/7777/health",
    );
    expect(requests).toEqual([
      {
        url: "https://workstation.tailnet.ts.net/__orkestrator/invoke",
        authorization: "Bearer direct-token-123456",
      },
      {
        url: "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback/7777/health",
        authorization: null,
      },
    ]);
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

    await expect(api.invoke("get_projects", { projectId: "project-1" })).resolves.toEqual({
      ok: true,
    });
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

  test("parses direct gateway CRLF event streams and aborts them when idle", async () => {
    const encoder = new TextEncoder();
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("data: not-json\r\n\r"));
            controller.enqueue(
              encoder.encode('\ndata: {"event":"changed","payload":{"ok":true}}\r\n\r\n'),
            );
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
    });
    const callback = mock(() => undefined);

    const unsubscribe = api.listen("changed", callback);
    await new Promise<void>((resolve) => {
      const poll = () => (callback.mock.calls.length > 0 ? resolve() : setTimeout(poll, 1));
      poll();
    });
    expect(callback).toHaveBeenCalledWith({ ok: true });
    expect(requestSignal?.aborted).toBe(false);

    unsubscribe();
    expect(requestSignal?.aborted).toBe(true);
  });

  test("reconnects a direct event stream while listeners remain", async () => {
    const encoder = new TextEncoder();
    const logs = captureLogs();
    let attempt = 0;
    globalThis.fetch = mock(async () => {
      attempt += 1;
      if (attempt === 1) return new Response(null, { status: 503 });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(gatewayControlFrame("gateway.connected", "fresh")));
            controller.enqueue(
              encoder.encode('data: {"event":"changed","payload":"reconnected"}\n\n'),
            );
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      eventReconnectDelayMs: 0,
    });
    const connected = mock(() => undefined);
    const stopConnected = api.listen("native-event-stream-connected", connected);

    try {
      const payload = await new Promise<string>((resolve) => {
        const unsubscribe = api.listen<string>("changed", (value) => {
          unsubscribe();
          resolve(value);
        });
      });
      expect(payload).toBe("reconnected");
      expect(attempt).toBe(2);
      expect(gatewayWarnings(logs)).toEqual([
        expect.objectContaining({
          level: "warn",
          area: "web.gateway",
          event: "events.disconnected",
        }),
      ]);
      expect(connected).toHaveBeenCalledTimes(1);
    } finally {
      stopConnected();
      logs.restore();
    }
  });

  test("isolates a throwing direct-stream listener from its siblings", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode('data: {"event":"changed","payload":"delivered"}\n\n'),
              );
            },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const logs = captureLogs();
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
    });
    const received = mock(() => undefined);
    const stopThrowing = api.listen("changed", () => {
      throw new Error("listener failed");
    });
    const stopReceived = api.listen("changed", received);
    try {
      await new Promise<void>((resolve) => {
        const poll = () => (received.mock.calls.length ? resolve() : setTimeout(poll, 1));
        poll();
      });
      expect(received).toHaveBeenCalledWith("delivered");
      expect(logs.records().filter(({ level }) => level === "error")).toEqual([
        expect.objectContaining({
          level: "error",
          area: "web.gateway",
          event: "event-listener.failed",
          fields: {
            eventName: "changed",
            error: expect.objectContaining({ message: "listener failed" }),
          },
        }),
      ]);
    } finally {
      stopThrowing();
      stopReceived();
      logs.restore();
    }
  });

  test("cancels a failed direct stream before reconnecting", async () => {
    let attempts = 0;
    const firstRequest: { signal?: AbortSignal } = {};
    globalThis.fetch = mock(async (_input, init) => {
      attempts += 1;
      if (attempts === 1) {
        if (init?.signal) firstRequest.signal = init.signal;
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("stream failed"));
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        new ReadableStream({
          start() {},
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const logs = captureLogs();
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      eventReconnectDelayMs: 0,
    });
    const unsubscribe = api.listen("changed", () => undefined);
    try {
      await new Promise<void>((resolve) => {
        const poll = () => (attempts >= 2 ? resolve() : setTimeout(poll, 1));
        poll();
      });
      expect(firstRequest.signal?.aborted).toBe(true);
      expect(gatewayWarnings(logs)).toEqual([
        expect.objectContaining({
          level: "warn",
          area: "web.gateway",
          event: "events.disconnected",
        }),
      ]);
    } finally {
      unsubscribe();
      logs.restore();
    }
  });

  test("announces a fresh browser stream but not a replayed reconnect", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const connected = mock(() => undefined);
    const unsubscribe = api.listen("native-event-stream-connected", connected);
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");

    source.onopen?.();
    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          event: "gateway.connected",
          payload: { status: "fresh" },
        }),
        lastEventId: "12345678:0",
      }),
    );
    source.onopen?.();
    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          event: "gateway.connected",
          payload: { status: "caught-up" },
        }),
        lastEventId: "12345678:0",
      }),
    );

    expect(connected).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test("ignores malformed, missing, and replay-success connected statuses", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const connected = mock(() => undefined);
    const unsubscribe = api.listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, connected);
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
      source.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ event: "gateway.connected", payload }),
          lastEventId: "12345678:0",
        }),
      );
    }

    expect(connected).not.toHaveBeenCalled();

    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          event: "gateway.connected",
          payload: { status: "fresh" },
        }),
        lastEventId: "12345678:0",
      }),
    );
    expect(connected).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test("announces same-origin reconciliation only from its explicit control frame", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const connected = mock(() => undefined);
    const reconcileFrame = mock(() => undefined);
    const stopConnected = api.listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, connected);
    const stopReconcile = api.listen("gateway.reconcile-required", reconcileFrame);
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");

    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          event: "gateway.connected",
          payload: { status: "reconcile" },
        }),
        lastEventId: "",
      }),
    );
    expect(connected).not.toHaveBeenCalled();

    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          event: "gateway.reconcile-required",
          payload: { reason: "cursor-expired" },
        }),
        lastEventId: "12345678:9",
      }),
    );

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconcileFrame).not.toHaveBeenCalled();
    stopReconcile();
    stopConnected();
  });

  test("notifies listeners when a direct gateway stream connects", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(gatewayControlFrame("gateway.connected", "fresh")));
            },
          }),
          { status: 200 },
        ),
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
    const logs = captureLogs();
    let attempt = 0;
    const attemptsAtConnect: number[] = [];
    const requestUrls: string[] = [];
    globalThis.fetch = mock(async (input) => {
      requestUrls.push(String(input));
      attempt += 1;
      if (attempt === 1) return new Response(null, { status: 503 });
      return new Response(
        new ReadableStream({
          start(controller) {
            // Each attempt issues a distinct id so a `since` assertion below
            // cannot be satisfied by a cursor that never advanced.
            if (attempt === 2) {
              controller.enqueue(
                encoder.encode(gatewayControlFrame("gateway.connected", "fresh", "12345678:2")),
              );
              controller.close();
            } else if (attempt === 3) {
              controller.enqueue(
                encoder.encode(gatewayControlFrame("gateway.connected", "caught-up", "12345678:3")),
              );
              controller.close();
            } else {
              controller.enqueue(
                encoder.encode(gatewayControlFrame("gateway.connected", "reconcile", "12345678:3")),
              );
              controller.enqueue(
                encoder.encode(
                  gatewayControlFrame("gateway.reconcile-required", "cursor-expired", "12345678:9"),
                ),
              );
            }
          },
        }),
        { status: 200 },
      );
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
      logs.restore();
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
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(gatewayControlFrame("gateway.connected", "fresh", "12345678:0")),
              );
              controller.enqueue(
                encoder.encode('id: 12345678:7\ndata: {"event":"changed","payload":"latest"}\n\n'),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
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

    await waitForCondition(() => requestUrls.length === 2, "The direct stream did not reconnect");

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
        return new Response(
          new ReadableStream({
            start(controller) {
              // Last id wins within a block, per the SSE field-parsing rules.
              controller.enqueue(
                encoder.encode(
                  'id: 12345678:1\nid: 12345678:4\ndata: {"event":"changed","payload":"multi"}\n\n',
                ),
              );
              // No data means nothing to dispatch and no cursor to adopt.
              controller.enqueue(encoder.encode("id: 12345678:5\n\n"));
              // A blank id must not blank the cursor the client already holds.
              controller.enqueue(
                encoder.encode('id: \ndata: {"event":"changed","payload":"blank-id"}\n\n'),
              );
              // A comment-only frame is a keepalive, not an event.
              controller.enqueue(encoder.encode(": keepalive\n\n"));
              controller.close();
            },
          }),
          { status: 200 },
        );
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

    await waitForCondition(() => requestUrls.length === 2, "The direct stream did not reconnect");

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
        return new Response(
          new ReadableStream({
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
          }),
          { status: 200 },
        );
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

    await waitForCondition(() => requestUrls.length === 2, "The direct stream did not reconnect");

    expect(changed).toHaveBeenCalledWith("split");
    expect(new URL(requestUrls[1]!).searchParams.get("since")).toBe("12345678:6");
    unsubscribe();
  });

  test("ignores a server frame that impersonates the transport connected event", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(gatewayControlFrame("gateway.connected", "fresh")));
              controller.enqueue(
                encoder.encode(
                  `data: {"event":"${NATIVE_EVENT_STREAM_CONNECTED_EVENT}","payload":"spoofed"}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode('data: {"event":"changed","payload":"real"}\n\n'));
            },
          }),
          { status: 200 },
        ),
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
    globalThis.fetch = mock(
      async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
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
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ error: "not allowed" }), { status: 403 }),
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
    globalThis.fetch = mock(
      async () => new Response("<html>Bad Gateway</html>", { status: 502 }),
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
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: "Container is not running" }), {
          status: 500,
        }),
    ) as unknown as typeof fetch;

    const api = createBrowserGatewayApi();

    const error = await api.invoke("start_claude_server_cmd").then(
      () => null,
      (reason: unknown) => reason,
    );
    expect((error as Error).message).toBe("Container is not running");
    expect((error as { status?: unknown }).status).toBe(500);
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
      "/__orkestrator/events?excludeEvents=terminal-output-&relayedEvents=per-node&keepaliveEvents=1",
    );
    expect(source.options).toEqual({ withCredentials: true });

    const connectedCallback = mock(() => undefined);
    const unsubscribeConnected = api.listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, connectedCallback);
    source.onopen?.({} as Event);
    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          event: "gateway.connected",
          payload: { status: "fresh" },
        }),
        lastEventId: "12345678:0",
      }),
    );
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

    const logs = captureLogs();
    try {
      source.onerror?.();
      expect(logs.records()).toContainEqual(
        expect.objectContaining({
          level: "warn",
          area: "web.gateway",
          event: "events.disconnected",
          fields: { transport: "event-source" },
        }),
      );
    } finally {
      logs.restore();
    }

    unsubscribeConnected();
    unsubscribe();

    expect(source.closed).toBe(true);
  });

  test("retains the newest browser cursor across a dropped stream and stream recreation", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const logs = captureLogs();
    try {
      const api = createBrowserGatewayApi({ eventReconnectDelayMs: 0 });
      const cursorCallback = mock(() => undefined);
      const unsubscribe = api.listen("gateway.cursor", cursorCallback);
      const firstSource = MockEventSource.instances[0];
      if (!firstSource) throw new Error("EventSource was not created");

      firstSource.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            event: "gateway.cursor",
            payload: { generation: "12345678", revision: 5 },
          }),
          lastEventId: "12345678:5",
        }),
      );

      // The replacement resumes from the cursor, as a browser's own retry would
      // through Last-Event-ID.
      firstSource.fail(EVENT_SOURCE_CONNECTING);
      await waitForCondition(
        () => MockEventSource.instances.length === 2,
        "The dropped stream was not replaced",
      );
      const secondSource = MockEventSource.instances[1]!;
      expect(secondSource.url).toBe(
        "/__orkestrator/events?excludeEvents=terminal-output-&since=12345678%3A5&relayedEvents=per-node&keepaliveEvents=1",
      );
      secondSource.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            event: "gateway.cursor",
            payload: { generation: "12345678", revision: 8 },
          }),
          lastEventId: "12345678:8",
        }),
      );

      expect(cursorCallback).not.toHaveBeenCalled();
      unsubscribe();
      expect(secondSource.closed).toBe(true);

      const stopReplacement = api.listen("menu-zoom", () => undefined);
      expect(MockEventSource.instances).toHaveLength(3);
      expect(MockEventSource.instances[2]?.url).toBe(
        "/__orkestrator/events?excludeEvents=terminal-output-&since=12345678%3A8&relayedEvents=per-node&keepaliveEvents=1",
      );
      stopReplacement();
    } finally {
      logs.restore();
    }
  });

  test("rebuilds the authoritative browser stream after a fatal error", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const logs = captureLogs();
    try {
      const api = createBrowserGatewayApi({ eventReconnectDelayMs: 0 });
      const unsubscribe = api.listen("menu-zoom", () => undefined);
      const first = MockEventSource.instances[0];
      if (!first) throw new Error("EventSource was not created");

      first.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ event: "menu-zoom", payload: "in" }),
          lastEventId: "12345678:4",
        }),
      );

      // CLOSED means the browser has given up. Nothing else rebuilds the main
      // stream, so leaving it here strands every authoritative event until the
      // tab reloads.
      first.fail(EVENT_SOURCE_CLOSED);
      await waitForCondition(
        () => MockEventSource.instances.length === 2,
        "The authoritative stream was not rebuilt after a fatal error",
      );
      expect(MockEventSource.instances[1]?.url).toBe(
        "/__orkestrator/events?excludeEvents=terminal-output-&since=12345678%3A4&relayedEvents=per-node&keepaliveEvents=1",
      );

      // The abandoned socket must not keep dispatching into the live listeners.
      const stale = mock(() => undefined);
      const stopStale = api.listen("menu-zoom", stale);
      first.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ event: "menu-zoom", payload: "stale" }),
          lastEventId: "12345678:9",
        }),
      );
      expect(stale).not.toHaveBeenCalled();
      stopStale();
      unsubscribe();
    } finally {
      logs.restore();
    }
  });

  test("takes a dropped browser stream's retry over instead of leaving it to the browser", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const logs = captureLogs();
    try {
      const api = createBrowserGatewayApi({ eventReconnectDelayMs: 0 });
      const unsubscribe = api.listen("menu-zoom", () => undefined);
      const source = MockEventSource.instances[0];
      if (!source) throw new Error("EventSource was not created");

      // Left CONNECTING, the browser would keep retrying at its own fixed pace.
      source.fail(EVENT_SOURCE_CONNECTING);
      expect(source.closed).toBe(true);
      await waitForCondition(
        () => MockEventSource.instances.length === 2,
        "The dropped stream was not replaced",
      );
      unsubscribe();
    } finally {
      logs.restore();
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
    for (const event of ["gateway.reconcile-required", "gateway.connected"] as const) {
      terminal.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            event,
            payload:
              event === "gateway.connected" ? { status: "fresh" } : { reason: "cursor-expired" },
          }),
          lastEventId: "87654321:99",
        }),
      );
    }
    expect(connected).not.toHaveBeenCalled();

    // The main stream's genuine handshake still announces exactly once.
    main.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          event: "gateway.connected",
          payload: { status: "fresh" },
        }),
        lastEventId: "12345678:3",
      }),
    );
    expect(connected).toHaveBeenCalledTimes(1);

    // ...and the terminal frame's id never became the authoritative cursor.
    stopTerminal();
    stopConnected();
    const stopReplacement = api.listen("menu-zoom", () => undefined);
    const replacement = MockEventSource.instances.at(-1);
    expect(replacement?.url).toBe(
      "/__orkestrator/events?excludeEvents=terminal-output-&since=12345678%3A3&relayedEvents=per-node&keepaliveEvents=1",
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
      source.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ event, payload }),
          lastEventId: "12345678:2",
        }),
      );
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
    main.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ event: "menu-zoom", payload: "in" }),
        lastEventId: "12345678:7",
      }),
    );

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

    const unsubscribeTerminal = api.listen("terminal-output-session:one", () => undefined);
    await Promise.resolve();

    expect(firstSource.closed).toBe(false);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]?.url).toBe(
      "/__orkestrator/events?excludeEvents=terminal-output-&includeEvents=terminal-output-session%3Aone",
    );
    let ready = false;
    const readyPromise = api.eventStreamReady("terminal-output-session:one").then(() => {
      ready = true;
    });
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
    // The shared terminal stream drops its last terminal on the next microtask.
    await Promise.resolve();

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

    secondSource.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ event: "terminal-output-one", payload: "YQ==" }),
      }),
    );
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
      api.listen(`terminal-output-session-${index}`, () => undefined),
    );
    await Promise.resolve();

    expect(MockEventSource.instances).toHaveLength(1);
    const source = MockEventSource.instances[0]!;
    const url = new URL(source.url, "https://workstation.tailnet.ts.net");
    expect(url.searchParams.get("includeEvents")?.split(",")).toEqual(
      Array.from({ length: 12 }, (_, index) => `terminal-output-session-${index}`).sort(),
    );

    source.onopen?.();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        api.eventStreamReady(`terminal-output-session-${index}`),
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

    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ event: "terminal-output-one", payload: "YQ==" }),
      }),
    );
    expect(firstOutput).toHaveBeenCalledWith("YQ==");

    stopFirst();
    stopSecondAgain();
    await Promise.resolve();
    expect(source.closed).toBe(true);
  });

  test("rebuilds the shared terminal stream only after a fatal disconnect", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const logs = captureLogs();
    const api = createBrowserGatewayApi({ eventReconnectDelayMs: 1 });
    const output = mock(() => undefined);

    try {
      const stop = api.listen("terminal-output-session-1", output);
      await Promise.resolve();
      const source = MockEventSource.instances[0]!;
      source.open();
      await api.eventStreamReady("terminal-output-session-1");

      // Whatever state the failure left the socket in, the ladder owns the retry
      // and every browser terminal shares this one socket.
      source.fail(EVENT_SOURCE_CONNECTING);
      expect(source.closed).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(MockEventSource.instances).toHaveLength(2);
      expect(logs.records()).toContainEqual(
        expect.objectContaining({
          level: "warn",
          area: "web.gateway",
          event: "terminal-stream.disconnected",
          fields: { transport: "event-source" },
        }),
      );
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
      logs.restore();
    }
  });

  test("does not rebuild a dead shared stream once its last listener has left", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const logs = captureLogs();
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
      logs.restore();
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
    staleSource.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ event: "terminal-output-one", payload: "YQ==" }),
      }),
    );
    expect(firstOutput).not.toHaveBeenCalled();

    staleSource.onopen?.();
    expect(firstOutput).not.toHaveBeenCalled();

    // A late fatal error on the stale socket must not schedule a rebuild of the
    // live one either.
    const logs = captureLogs();
    try {
      staleSource.fail(EVENT_SOURCE_CLOSED);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(MockEventSource.instances).toHaveLength(2);
    } finally {
      logs.restore();
    }

    stopFirst();
    stopSecond();
    await Promise.resolve();
  });

  test("tells a reconnected direct terminal stream to resynchronize", async () => {
    const encoder = new TextEncoder();
    const logs = captureLogs();
    let attempt = 0;
    globalThis.fetch = mock(async () => {
      attempt += 1;
      return new Response(
        new ReadableStream({
          start(controller) {
            // Only the first connection carries output; every later one stands in
            // for a socket the gateway dropped under backpressure.
            if (attempt === 1) {
              controller.enqueue(
                encoder.encode(
                  'data: {"event":"terminal-output-session-1","payload":{"bytesBase64":"YQ==","revision":1,"generation":1}}\n\n',
                ),
              );
            }
            controller.close();
          },
        }),
        { status: 200 },
      );
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
        stop = api.listen<{ desynced?: boolean }>("terminal-output-session-1", (payload) => {
          payloads.push(payload);
          if (payload?.desynced) resolve();
        });
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
      logs.restore();
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
    const stopConnected = api.listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, connected);
    source.onopen?.();
    expect(connected).not.toHaveBeenCalled();
    expect(payloads).toHaveLength(2);

    stopConnected();
    stop();
  });

  test("reconnects the direct terminal stream on its configured delay and stops once its listener leaves", async () => {
    const logs = captureLogs();
    let attempt = 0;
    globalThis.fetch = mock(async () => {
      attempt += 1;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        { status: 200 },
      );
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
      logs.restore();
    }
  });

  test("retries the direct terminal stream after non-ok and bodyless responses, then cleans up", async () => {
    const logs = captureLogs();
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
      expect(gatewayWarnings(logs)).toEqual([
        expect.objectContaining({
          level: "warn",
          area: "web.gateway",
          event: "terminal-stream.disconnected",
          fields: {
            transport: "fetch",
            error: expect.objectContaining({
              message: "Gateway terminal event stream failed with HTTP 503",
            }),
          },
        }),
        expect.objectContaining({
          level: "warn",
          area: "web.gateway",
          event: "terminal-stream.disconnected",
          fields: {
            transport: "fetch",
            error: expect.objectContaining({
              message: "Gateway terminal event stream failed with HTTP 200",
            }),
          },
        }),
      ]);
      expect(signals[2]?.aborted).toBe(false);

      stop();
      // The shared terminal stream drops its last terminal on the next microtask.
      await Promise.resolve();
      expect(signals[2]?.aborted).toBe(true);
      await new Promise((resolve) => originalSetTimeout(resolve, 2));
      expect(attempt).toBe(3);
    } finally {
      logs.restore();
    }
  });

  test("leaves terminal readiness pending when a browser stream errors before opening", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const logs = captureLogs();
    const api = createBrowserGatewayApi();

    try {
      const stop = api.listen("terminal-output-session-1", () => undefined);
      await Promise.resolve();
      let ready = false;
      const readyPromise = api.eventStreamReady("terminal-output-session-1").then(() => {
        ready = true;
      });
      const source = MockEventSource.instances[0];
      if (!source) throw new Error("EventSource was not created");

      source.onerror?.();
      await Promise.resolve();
      // An EventSource that never opens never latches readiness. Callers must
      // therefore bound their own wait (see NATIVE_EVENT_STREAM_READY_TIMEOUT_MS)
      // instead of assuming this promise always settles while the tab lives.
      expect(ready).toBe(false);
      expect(logs.records()).toContainEqual(
        expect.objectContaining({
          level: "warn",
          area: "web.gateway",
          event: "terminal-stream.disconnected",
          fields: { transport: "event-source" },
        }),
      );

      // Dropping the listener still releases anyone already waiting.
      stop();
      await readyPromise;
      expect(ready).toBe(true);
    } finally {
      logs.restore();
    }
  });
});
