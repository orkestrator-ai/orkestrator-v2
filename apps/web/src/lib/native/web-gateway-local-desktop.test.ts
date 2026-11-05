import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import {
  gatewayEventStreamContractScenarios,
  type EventStreamContractAdapter,
} from "@orkestrator/protocol/gateway-event-stream-contract-fixtures";
import {
  terminalInputContractScenarios,
  type TerminalContractAdapter,
} from "@orkestrator/protocol/terminal-input-contract-fixtures";
import { installLocalDesktopGateway, type BrowserGatewayOptions } from "./web-gateway";

const BASE_URL = "http://127.0.0.1:50123";
const TERMINAL_EVENT = "terminal-output-local:session-1";
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
let logs: LogCapture;

beforeEach(() => {
  // Malformed frames and closed connections are part of the contract.
  logs = captureLogs();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  logs.restore();
});

type HostListener = (payload: unknown) => void;

/** What the preload exposes: its own IPC `invoke`, and events main raises itself. */
function desktopHost() {
  const hostListeners = new Map<string, Set<HostListener>>();
  const invoke = mock(async () => {
    throw new Error("a command must not take the IPC path");
  });
  const api = {
    isolatedViewState: true,
    invoke,
    listen(event: string, callback: HostListener) {
      const set = hostListeners.get(event) ?? new Set<HostListener>();
      hostListeners.set(event, set);
      set.add(callback);
      return () => set.delete(callback);
    },
    clipboard: { readText: async () => "from-preload" },
  };
  return {
    api,
    invoke,
    hostListenerCount: (event: string) => hostListeners.get(event)?.size ?? 0,
    emit: (event: string, payload: unknown) => {
      for (const callback of hostListeners.get(event) ?? []) callback(payload);
    },
  };
}

function installed(host = desktopHost(), overrides: BrowserGatewayOptions = {}) {
  const target = {
    location: { protocol: "file:", href: "file:///index.html", origin: "file://" },
    orkestratorDesktopHost: { api: host.api, baseUrl: BASE_URL },
  } as unknown as Window;
  installLocalDesktopGateway(target as never, overrides);
  return target.orkestrator as unknown as NonNullable<Window["orkestrator"]> & {
    clipboard: { readText(): Promise<string> };
    isolatedViewState: boolean;
  };
}

function holdOpen(): Response {
  return new Response(new ReadableStream<Uint8Array>({}), { status: 200 });
}

class ScriptedEventSource {
  static instances: ScriptedEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    ScriptedEventSource.instances.push(this);
  }
  addEventListener(): void {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

const flush = async () => {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
};

describe("local desktop gateway transport", () => {
  beforeEach(() => {
    ScriptedEventSource.instances = [];
    globalThis.EventSource = ScriptedEventSource as unknown as typeof EventSource;
  });

  test("keeps native APIs from the preload and sets no remote gateway marker", async () => {
    globalThis.fetch = mock(async () => holdOpen()) as unknown as typeof fetch;
    const host = desktopHost();
    const target = {
      location: { protocol: "file:", href: "file:///index.html", origin: "file://" },
      orkestratorDesktopHost: { api: host.api, baseUrl: BASE_URL },
    } as unknown as Window;
    installLocalDesktopGateway(target as never);

    expect(target.orkestratorGateway).toBeUndefined();
    expect(target.orkestrator?.isolatedViewState).toBe(true);
    expect(await target.orkestrator!.clipboard.readText()).toBe("from-preload");
    expect(target.orkestrator?.eventStreamConnection).toBeDefined();
  });

  test("does nothing in a window the preload gave the relay API", () => {
    const relayApi = { invoke: mock(async () => "relay") };
    const target = { orkestrator: relayApi } as unknown as Window;
    installLocalDesktopGateway(target as never);
    expect(target.orkestrator as unknown).toBe(relayApi);
  });

  test("sends a command to the backend with no credential of its own", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ result: "from-backend" }), { status: 200 });
    }) as unknown as typeof fetch;
    const host = desktopHost();
    const api = installed(host);

    expect(await api.invoke("get_config")).toBe("from-backend");
    expect(host.invoke).not.toHaveBeenCalled();
    expect(requests[0]!.url).toBe(`${BASE_URL}/__orkestrator/invoke`);
    expect(requests[0]!.init.credentials).toBe("omit");
    expect(new Headers(requests[0]!.init.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      command: "get_config",
      args: {},
    });
  });

  test("a per-node relayed event comes from its own stream, so main is never told of it", async () => {
    const event = "relayed-node-event:bk_leaf";
    globalThis.fetch = mock(async () => holdOpen()) as unknown as typeof fetch;
    const host = desktopHost();
    const api = installed(host);
    const received: unknown[] = [];
    const stop = api.listen(event, (payload) => received.push(payload));
    await flush();

    expect(host.hostListenerCount(event)).toBe(0);
    const stream = ScriptedEventSource.instances.find(
      (source) => new URL(source.url).searchParams.get("includeEvents") === event,
    );
    expect(stream).toBeDefined();
    stream!.open();
    stream!.onmessage?.({
      data: JSON.stringify({ event, payload: { nodeId: "bk_leaf", kind: "resync" } }),
      lastEventId: "relayed:1",
    });
    expect(received).toEqual([{ nodeId: "bk_leaf", kind: "resync" }]);
    stop();
  });

  test("hears backend events from its stream and main's own events from the preload", async () => {
    const encoder = new TextEncoder();
    const streamUrls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      streamUrls.push(String(input));
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ event: "resource-changed", payload: { from: "backend" } })}\n\n`,
              ),
            );
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const host = desktopHost();
    const api = installed(host);
    const received: unknown[] = [];
    const stop = api.listen("resource-changed", (payload) => received.push(payload));
    const menu: unknown[] = [];
    api.listen("menu-zoom", (payload) => menu.push(payload));
    await flush();

    expect(received).toEqual([{ from: "backend" }]);
    expect(new URL(streamUrls[0]!).searchParams.get("excludeEvents")).toBe("terminal-output-");
    host.emit("menu-zoom", "in");
    expect(menu).toEqual(["in"]);

    stop();
    expect(host.hostListenerCount("resource-changed")).toBe(0);
  });

  test("every terminal shares one credential-free stream, and never listens over IPC", async () => {
    globalThis.fetch = mock(async () => holdOpen()) as unknown as typeof fetch;
    const host = desktopHost();
    const api = installed(host);
    api.listen(TERMINAL_EVENT, () => undefined);
    api.listen("terminal-output-local:session-2", () => undefined);
    await flush();

    expect(host.hostListenerCount(TERMINAL_EVENT)).toBe(0);
    // One long-lived request for all terminals: the plain-HTTP connection pool
    // has about six per origin, and commands need the rest.
    expect(ScriptedEventSource.instances).toHaveLength(1);
    const stream = ScriptedEventSource.instances[0]!;
    expect(stream.url.startsWith(`${BASE_URL}/__orkestrator/events?`)).toBe(true);
    expect(new URL(stream.url).searchParams.get("includeEvents")).toBe(
      `${TERMINAL_EVENT},terminal-output-local:session-2`,
    );
    // Main's injected wildcard CORS grant does not admit a credentialed request.
    expect(stream.init?.withCredentials).toBe(false);
  });

  test("a reopened terminal stream asks the consumer to re-read its snapshot", async () => {
    globalThis.fetch = mock(async () => holdOpen()) as unknown as typeof fetch;
    const api = installed();
    const payloads: unknown[] = [];
    api.listen(TERMINAL_EVENT, (payload) => payloads.push(payload));
    await flush();
    const first = ScriptedEventSource.instances[0]!;
    first.open();
    first.onmessage?.({
      data: JSON.stringify({ event: TERMINAL_EVENT, payload: { data: "live" } }),
      lastEventId: "",
    });
    expect(payloads).toEqual([{ data: "live" }]);

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((run: () => void) => {
      run();
      return 0;
    }) as unknown as typeof setTimeout;
    try {
      first.readyState = 2;
      first.onerror?.();
      await flush();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
    const second = ScriptedEventSource.instances[1]!;
    expect(second).toBeDefined();
    second.open();
    expect(payloads).toEqual([{ data: "live" }, { desynced: true }]);
  });

  test("a command sent as the page goes away survives it, within the size limit", async () => {
    const inits: RequestInit[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = installed();

    await api.invoke("save_pane_layout", { layout: "before" });
    window.dispatchEvent(new Event("pagehide"));
    await api.invoke("save_pane_layout", { layout: "final" });
    await api.invoke("save_pane_layout", { layout: "x".repeat(64 * 1024) });
    window.dispatchEvent(new Event("pageshow"));
    await api.invoke("save_pane_layout", { layout: "after" });

    expect(inits.map((init) => init.keepalive === true)).toEqual([false, true, false, false]);
  });
});

const localDesktopEventStreamAdapter: EventStreamContractAdapter = {
  start(server, observe, onEvent) {
    let attempt = 0;
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      attempt += 1;
      const connection = server(attempt, new URL(String(input)).searchParams.get("since"));
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of connection.chunks) controller.enqueue(encoder.encode(chunk));
            if (connection.close) controller.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const api = installed(desktopHost(), { eventReconnectDelayMs: 5 });
    const unlisten = observe.map((event) =>
      api.listen(event, (payload: unknown) => onEvent(event, payload)),
    );
    return { stop: () => unlisten.forEach((stop) => stop()) };
  },
};

const localDesktopTerminalAdapter: TerminalContractAdapter = {
  create(backend, options = {}) {
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const reply = await backend(
        JSON.parse(String(init?.body)) as { command: string; args: Record<string, unknown> },
        init?.signal ?? null,
      );
      return "result" in reply
        ? new Response(JSON.stringify({ result: reply.result }), { status: 200 })
        : new Response(JSON.stringify({ error: reply.error }), { status: reply.status });
    }) as unknown as typeof fetch;
    const api = installed(desktopHost(), { terminalInputSendTimeoutMs: options.sendTimeoutMs });
    return { invoke: (command, args) => api.invoke(command, args) };
  },
};

describe("local desktop gateway event stream contract", () => {
  for (const scenario of gatewayEventStreamContractScenarios) {
    test(scenario.name, async () => {
      const { actual, expected } = await scenario.run(localDesktopEventStreamAdapter);
      expect(actual).toEqual(expected);
    });
  }
});

describe("local desktop gateway terminal input contract", () => {
  for (const scenario of terminalInputContractScenarios) {
    test(scenario.name, async () => {
      const { actual, expected } = await scenario.run(localDesktopTerminalAdapter);
      expect(actual).toEqual(expected);
    });
  }
});
