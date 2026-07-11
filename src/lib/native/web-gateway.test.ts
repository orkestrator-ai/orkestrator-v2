import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createBrowserGatewayApi, installBrowserGatewayApi } from "./web-gateway";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
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
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  delete window.orkestrator;
  delete window.orkestratorGateway;
  mock.restore();
});

describe("web gateway browser API", () => {
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
    source.onmessage?.({
      data: JSON.stringify({ event: "menu-zoom", payload: "in" }),
    } as MessageEvent);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("in");

    unsubscribe();

    expect(source.closed).toBe(true);
  });

  test("uses browser fallbacks for unavailable native-only APIs", async () => {
    const api = createBrowserGatewayApi();

    await expect(api.clipboard.readImage()).resolves.toBeNull();
    await expect(api.clipboard.writeImage("data:image/png;base64,AA==")).resolves.toBeUndefined();
    await expect(api.dialog.open()).resolves.toBeNull();
    await expect(api.window.startDragging()).resolves.toBeUndefined();
  });
});
