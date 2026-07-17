import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createBrowserGatewayApi, installBrowserGatewayApi } from "./web-gateway";
import {
  clearDirectGatewayTransport,
  configureDirectGatewayTransport,
} from "./gateway-auth-transport";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

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

class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((message: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(
    public readonly url: string,
    public readonly options?: EventSourceInit,
  ) {
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
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
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  }
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
    } finally {
      console.warn = originalWarn;
    }
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
    expect(source.url).toBe("/__orkestrator/events");
    expect(source.options).toEqual({ withCredentials: true });

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

    unsubscribe();

    expect(source.closed).toBe(true);
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
    expect(result).toMatchObject({ width: 32, height: 18 });
    expect(result?.dataUrl).toStartWith("data:image/png;base64,");
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

  test("rejects oversized browser clipboard image metadata before data URL encoding", async () => {
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
    await expect(api.clipboard.readImage()).rejects.toMatchObject({ code: "too-large" });
  });
});
