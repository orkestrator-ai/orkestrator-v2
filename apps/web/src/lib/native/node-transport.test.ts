import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import type { BackendId } from "@orkestrator/protocol/federation";
import { relayedNodeEventName } from "@orkestrator/protocol/node-events";
import { incompatibility, toWire, unknownCommand } from "@orkestrator/protocol/contract/errors";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import { GatewayHttpError } from "./gateway-http-error";
import {
  createNodeTransport,
  type NodeTransport,
  type NodeTransportLifecycle,
  type NodeTransportOptions,
} from "./node-transport";

/**
 * Several node transports in one page (docs/reports/unified-federation.md §6.2):
 * each keeps its own streams, cursors, terminals, backoff and credential, and
 * disposing one leaves the others running. Each fake gateway below is one
 * origin; one `fetch` mock routes between them.
 */
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
const originalHref = window.location.href;
const transports: NodeTransport[] = [];
let logs: LogCapture;

const A = "https://leaf-a.test";
const B = "https://leaf-b.test";
/** The top of each jitter range, so the ladder itself is visible. */
const TOP_OF_RANGE = () => 0.999_999;

beforeEach(() => {
  logs = captureLogs();
});

afterEach(() => {
  for (const transport of transports.splice(0)) transport.dispose();
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  happyDOM.setURL(originalHref);
  logs.restore();
});

function transport(options: NodeTransportOptions): NodeTransport {
  const created = createNodeTransport(options);
  transports.push(created);
  return created;
}

/** One open `/events` request the test drives. */
type FakeStream = {
  url: URL;
  authorization: string | null;
  push(frame: string): void;
  /** The gateway ends the stream cleanly. */
  end(): void;
  /** Whether the client cancelled or aborted it. */
  closedByClient(): boolean;
};

type FakeGateway = {
  streams: FakeStream[];
  invokes: Array<{ command: string; authorization: string | null }>;
  statusRequests: string[];
  /** Status answered for `/events`; 200 opens a stream the test drives. */
  eventsStatus: number;
  statusStatus: number;
};

/** Routes every request to the fake gateway that owns its origin. */
function fakeGateways(...origins: string[]): Record<string, FakeGateway> {
  const gateways: Record<string, FakeGateway> = {};
  for (const origin of origins) {
    gateways[origin] = {
      streams: [],
      invokes: [],
      statusRequests: [],
      eventsStatus: 200,
      statusStatus: 200,
    };
  }
  const encoder = new TextEncoder();
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const gateway = gateways[url.origin];
    if (!gateway) throw new TypeError(`No gateway at ${url.origin}`);
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname.endsWith("/__orkestrator/invoke")) {
      const { command } = JSON.parse(String(init?.body)) as { command: string };
      gateway.invokes.push({ command, authorization });
      return Response.json({ result: url.origin });
    }
    if (url.pathname.endsWith("/__orkestrator/status")) {
      gateway.statusRequests.push(url.pathname);
      return new Response("{}", { status: gateway.statusStatus });
    }
    if (!url.pathname.endsWith("/__orkestrator/events")) return new Response(null, { status: 404 });
    if (gateway.eventsStatus !== 200) return new Response(null, { status: gateway.eventsStatus });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
      cancel() {
        cancelled = true;
      },
    });
    gateway.streams.push({
      url,
      authorization,
      push: (frame) => controller.enqueue(encoder.encode(frame)),
      end: () => controller.close(),
      closedByClient: () => cancelled || init?.signal?.aborted === true,
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return gateways;
}

function frame(id: string, event: string, payload: unknown): string {
  return `id: ${id}\ndata: ${JSON.stringify({ event, payload })}\n\n`;
}

const mainStreams = (gateway: FakeGateway) =>
  gateway.streams.filter((stream) => !stream.url.searchParams.has("includeEvents"));
const terminalStreams = (gateway: FakeGateway) =>
  gateway.streams.filter((stream) => stream.url.searchParams.has("includeEvents"));

/** Nothing fires until the test fires it; every armed timer records its delay. */
function manualTimers() {
  type ManualTimer = { id: number; delay: number; run: () => void };
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
    pending.set(timer.id, timer);
    return timer.id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    pending.delete(handle as unknown as number);
  }) as unknown as typeof clearTimeout;
  return {
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

async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => originalSetTimeout(resolve, 1));
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => originalSetTimeout(resolve, 5));
}

/** A lifecycle the test drives, counting live subscriptions. */
function fakeLifecycle() {
  const visibility = new Set<(visible: boolean) => void>();
  const online = new Set<() => void>();
  const pageHide = new Set<(hiding: boolean) => void>();
  const lifecycle: NodeTransportLifecycle = {
    onVisibility(listener) {
      visibility.add(listener);
      return () => visibility.delete(listener);
    },
    onOnline(listener) {
      online.add(listener);
      return () => online.delete(listener);
    },
    onPageHide(listener) {
      pageHide.add(listener);
      return () => pageHide.delete(listener);
    },
  };
  return {
    lifecycle,
    subscriptions: () => visibility.size + online.size + pageHide.size,
    becomeVisible: () => visibility.forEach((listener) => listener(true)),
  };
}

describe("two node transports in one page", () => {
  test("keep separate main streams, cursors and credentials", async () => {
    const gateways = fakeGateways(A, B);
    const timers = manualTimers();
    const ladder = { eventReconnectDelayMs: 100, eventReconnectRandom: TOP_OF_RANGE };
    const a = transport({ baseUrl: A, credential: "token-a", ...ladder });
    const b = transport({ baseUrl: `${B}/`, credential: "token-b", ...ladder });
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.listen("changed", (payload) => seenA.push(payload));
    b.listen("changed", (payload) => seenB.push(payload));
    await until(
      () => mainStreams(gateways[A]!).length === 1 && mainStreams(gateways[B]!).length === 1,
      "Each transport should open its own main stream",
    );
    expect(mainStreams(gateways[A]!)[0]!.authorization).toBe("Bearer token-a");
    expect(mainStreams(gateways[B]!)[0]!.authorization).toBe("Bearer token-b");
    await until(
      () => a.eventStreamConnection.state() === "connected",
      "A never reported connected",
    );

    mainStreams(gateways[A]!)[0]!.push(frame("a:1", "changed", "from-a"));
    mainStreams(gateways[B]!)[0]!.push(frame("b:7", "changed", "from-b"));
    await until(() => seenA.length === 1 && seenB.length === 1, "Events were not delivered");
    expect(seenA).toEqual(["from-a"]);
    expect(seenB).toEqual(["from-b"]);

    // A's gateway drops its stream; only A reconnects, from its own cursor.
    mainStreams(gateways[A]!)[0]!.end();
    await until(() => timers.pendingDelays().includes(100), "A did not schedule a reconnect");
    expect(a.eventStreamConnection.state()).toBe("disconnected");
    expect(b.eventStreamConnection.state()).toBe("connected");
    timers.fire(100);
    await until(() => mainStreams(gateways[A]!).length === 2, "A did not reconnect");
    expect(mainStreams(gateways[A]!)[1]!.url.searchParams.get("since")).toBe("a:1");
    expect(mainStreams(gateways[B]!)).toHaveLength(1);
    expect(mainStreams(gateways[B]!)[0]!.closedByClient()).toBe(false);

    // A new credential on A changes nothing for B.
    a.setCredential("token-a2");
    await a.invoke("ping");
    await b.invoke("ping");
    expect(gateways[A]!.invokes).toEqual([{ command: "ping", authorization: "Bearer token-a2" }]);
    expect(gateways[B]!.invokes).toEqual([{ command: "ping", authorization: "Bearer token-b" }]);
    expect(b.credential()).toBe("token-b");
  });

  test("keep separate terminal streams and terminal input", async () => {
    const gateways = fakeGateways(A, B);
    manualTimers();
    const a = transport({ baseUrl: A, credential: "token-a", terminalInputBatchDelayMs: 0 });
    const b = transport({ baseUrl: B, credential: "token-b", terminalInputBatchDelayMs: 0 });
    const outputA: unknown[] = [];
    const outputB: unknown[] = [];
    a.listen("terminal-output-s1", (payload) => outputA.push(payload));
    b.listen("terminal-output-s1", (payload) => outputB.push(payload));
    await until(
      () =>
        terminalStreams(gateways[A]!).length === 1 && terminalStreams(gateways[B]!).length === 1,
      "Each transport should open its own terminal stream",
    );
    await a.eventStreamReady("terminal-output-s1");
    await b.eventStreamReady("terminal-output-s1");
    // Terminal output never rides the main stream.
    expect(mainStreams(gateways[A]!)).toHaveLength(0);

    terminalStreams(gateways[A]!)[0]!.push(frame("", "terminal-output-s1", { data: "a" }));
    terminalStreams(gateways[B]!)[0]!.push(frame("", "terminal-output-s1", { data: "b" }));
    await until(() => outputA.length === 1 && outputB.length === 1, "Output was not delivered");
    expect(outputA).toEqual([{ data: "a" }]);
    expect(outputB).toEqual([{ data: "b" }]);

    await Promise.all([
      a.invoke("terminal_write", { sessionId: "s1", data: "x" }),
      b.invoke("terminal_write", { sessionId: "s1", data: "y" }),
    ]);
    expect(gateways[A]!.invokes.map((call) => call.authorization)).toEqual(["Bearer token-a"]);
    expect(gateways[B]!.invokes.map((call) => call.authorization)).toEqual(["Bearer token-b"]);
  });

  test("keep separate reconnect ladders", async () => {
    const gateways = fakeGateways(A, B);
    const timers = manualTimers();
    const options = {
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
      probeCredentialOnStreamFailure: false,
    } as const;
    const a = transport({ baseUrl: A, ...options });
    const b = transport({ baseUrl: B, ...options });
    gateways[A]!.eventsStatus = 503;
    a.listen("changed", () => undefined);
    await until(() => timers.pendingDelays().includes(100), "A did not back off");
    timers.fire(100);
    await until(() => timers.pendingDelays().includes(200), "A did not climb its ladder");
    timers.fire(200);
    await until(() => timers.pendingDelays().includes(400), "A did not climb its ladder");

    // B's first failure starts at the bottom of its own ladder.
    gateways[B]!.eventsStatus = 503;
    b.listen("changed", () => undefined);
    await until(() => timers.pendingDelays().includes(100), "B did not start at its first rung");
    expect(timers.pendingDelays().sort((x, y) => x - y)).toEqual([100, 400]);
  });

  test("disposing one leaves the other running", async () => {
    const gateways = fakeGateways(A, B);
    manualTimers();
    const lifecycleA = fakeLifecycle();
    const lifecycleB = fakeLifecycle();
    const a = transport({ baseUrl: A, lifecycle: lifecycleA.lifecycle, keepaliveOnPageHide: true });
    const b = transport({ baseUrl: B, lifecycle: lifecycleB.lifecycle, keepaliveOnPageHide: true });
    const seenB: unknown[] = [];
    const states: string[] = [];
    a.eventStreamConnection.subscribe((state) => states.push(state));
    a.listen("changed", () => undefined);
    a.listen("terminal-output-s1", () => undefined);
    b.listen("changed", (payload) => seenB.push(payload));
    b.listen("terminal-output-s1", () => undefined);
    await until(
      () => gateways[A]!.streams.length === 2 && gateways[B]!.streams.length === 2,
      "Streams did not open",
    );
    expect(lifecycleA.subscriptions()).toBe(3);

    a.dispose();
    await settle();
    expect(gateways[A]!.streams.every((stream) => stream.closedByClient())).toBe(true);
    expect(a.eventStreamConnection.state()).toBe("idle");
    expect(states.at(-1)).toBe("idle");
    expect(lifecycleA.subscriptions()).toBe(0);
    // A disposed transport opens nothing more.
    a.listen("other", () => undefined);
    await settle();
    expect(gateways[A]!.streams).toHaveLength(2);

    expect(gateways[B]!.streams.some((stream) => stream.closedByClient())).toBe(false);
    expect(lifecycleB.subscriptions()).toBe(3);
    mainStreams(gateways[B]!)[0]!.push(frame("b:1", "changed", "still-live"));
    await until(() => seenB.length === 1, "B stopped delivering after A was disposed");
    expect(b.eventStreamConnection.state()).toBe("connected");
  });

  test("a lifecycle wake retries only the transport that is waiting", async () => {
    const gateways = fakeGateways(A, B);
    const timers = manualTimers();
    const lifecycleA = fakeLifecycle();
    const lifecycleB = fakeLifecycle();
    const options = { eventReconnectDelayMs: 100, probeCredentialOnStreamFailure: false };
    const a = transport({ baseUrl: A, lifecycle: lifecycleA.lifecycle, ...options });
    const b = transport({ baseUrl: B, lifecycle: lifecycleB.lifecycle, ...options });
    gateways[A]!.eventsStatus = 503;
    a.listen("changed", () => undefined);
    b.listen("changed", () => undefined);
    await until(() => timers.pendingDelays().length === 1, "A did not back off");
    gateways[A]!.eventsStatus = 200;

    lifecycleA.becomeVisible();
    await until(() => mainStreams(gateways[A]!).length === 1, "A was not retried on wake");
    expect(mainStreams(gateways[B]!)).toHaveLength(1);
    // B was not waiting, so its own wake reopens nothing.
    lifecycleB.becomeVisible();
    await settle();
    expect(mainStreams(gateways[B]!)).toHaveLength(1);
  });
});

describe("a node transport's own credential", () => {
  const RELAYED = relayedNodeEventName("bk_leaf" as BackendId);
  const relayedStreams = (gateway: FakeGateway) =>
    gateway.streams.filter((stream) => stream.url.searchParams.get("includeEvents") === RELAYED);
  const terminalOnly = (gateway: FakeGateway) =>
    terminalStreams(gateway).filter(
      (stream) => stream.url.searchParams.get("includeEvents") !== RELAYED,
    );

  test("setCredential reopens that transport's streams with the new bearer and no other's", async () => {
    const gateways = fakeGateways(A, B);
    const timers = manualTimers();
    const ladder = { eventReconnectDelayMs: 100, eventReconnectRandom: TOP_OF_RANGE };
    const a = transport({ baseUrl: A, credential: "token-a", ...ladder });
    const b = transport({ baseUrl: B, credential: "token-b", ...ladder });
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    for (const [node, seen] of [
      [a, seenA],
      [b, seenB],
    ] as const) {
      node.listen("changed", (payload) => seen.push(payload));
      node.listen("terminal-output-s1", () => undefined);
      node.listen(RELAYED, () => undefined);
    }
    await until(
      () => gateways[A]!.streams.length === 3 && gateways[B]!.streams.length === 3,
      "Each transport should open a main, a terminal and a relayed stream",
    );
    for (const [origin, token] of [
      [A, "Bearer token-a"],
      [B, "Bearer token-b"],
    ] as const) {
      expect(gateways[origin]!.streams.map((stream) => stream.authorization)).toEqual([
        token,
        token,
        token,
      ]);
    }
    await until(() => a.eventStreamConnection.state() === "connected", "A never connected");
    mainStreams(gateways[A]!)[0]!.push(frame("a:3", "changed", "before"));
    await until(() => seenA.length === 1, "A's event was not delivered");

    a.setCredential(" token-a2 ");
    await until(() => gateways[A]!.streams.length === 6, "A's streams were not reopened");
    expect(gateways[A]!.streams.slice(0, 3).every((stream) => stream.closedByClient())).toBe(true);
    const [main, terminal, relayed] = [
      mainStreams(gateways[A]!)[1]!,
      terminalOnly(gateways[A]!)[1]!,
      relayedStreams(gateways[A]!)[1]!,
    ];
    for (const stream of [main, terminal, relayed]) {
      expect(stream.authorization).toBe("Bearer token-a2");
    }
    // The main stream resumes from its cursor, so nothing between is lost.
    expect(main.url.searchParams.get("since")).toBe("a:3");
    // A replacement is not a failure: no backoff was armed.
    expect(timers.pendingDelays()).toEqual([]);
    expect(a.eventStreamConnection.state()).toBe("connected");
    main.push(frame("a:4", "changed", "after"));
    await until(() => seenA.length === 2, "A's reopened stream did not deliver");
    expect(seenA).toEqual(["before", "after"]);

    // B kept every stream, on its own bearer.
    expect(gateways[B]!.streams).toHaveLength(3);
    expect(gateways[B]!.streams.some((stream) => stream.closedByClient())).toBe(false);
    await b.invoke("ping");
    expect(gateways[B]!.invokes).toEqual([{ command: "ping", authorization: "Bearer token-b" }]);

    // The same credential again reopens nothing.
    a.setCredential("token-a2");
    await settle();
    expect(gateways[A]!.streams).toHaveLength(6);
  });

  test("a new credential after a refusal reopens at once instead of waiting out the backoff", async () => {
    const gateways = fakeGateways(A);
    const timers = manualTimers();
    const rejected = mock(() => undefined);
    const leaf = transport({
      baseUrl: A,
      credential: "lapsed-grant",
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
      onCredentialRejected: rejected,
    });
    gateways[A]!.eventsStatus = 401;
    leaf.listen("changed", () => undefined);
    await until(() => rejected.mock.calls.length === 1, "The refusal was not reported");
    await until(() => timers.pendingDelays().includes(100), "No retry was scheduled");
    expect(leaf.eventStreamConnection.state()).toBe("connecting");

    // The node is reopened with a new grant: no reload, no wait.
    gateways[A]!.eventsStatus = 200;
    leaf.setCredential("fresh-grant");
    await until(() => mainStreams(gateways[A]!).length === 1, "The stream was not reopened");
    expect(mainStreams(gateways[A]!)[0]!.authorization).toBe("Bearer fresh-grant");
    expect(timers.pendingDelays()).toEqual([]);
    await until(
      () => leaf.eventStreamConnection.state() === "connected",
      "The reopened stream did not connect",
    );
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  test("creating node transports leaves the page's fetch and EventSource alone", async () => {
    fakeGateways(A, B);
    manualTimers();
    const pageFetch = globalThis.fetch;
    const pageEventSource = globalThis.EventSource;
    const a = transport({ baseUrl: A, credential: "token-a" });
    const b = transport({ baseUrl: B, credential: "token-b" });
    a.listen("changed", () => undefined);
    b.listen("terminal-output-s1", () => undefined);
    a.setCredential("token-a2");
    await a.invoke("ping");
    await settle();
    expect(globalThis.fetch).toBe(pageFetch);
    expect(globalThis.EventSource).toBe(pageEventSource);
  });
});

describe("a node transport reads no globals", () => {
  test("it needs a base URL and ignores the page's configured gateway", async () => {
    expect(() => createNodeTransport({ baseUrl: "  " })).toThrow("needs a base URL");
    const gateways = fakeGateways(A);
    const previous = window.orkestratorGateway;
    window.orkestratorGateway = { enabled: true, baseUrl: "https://elsewhere.test" };
    try {
      const a = transport({ baseUrl: A });
      expect(await a.invoke("ping")).toBe(A);
      expect(gateways[A]!.invokes).toHaveLength(1);
      expect(a.url("/__orkestrator/status")).toBe(`${A}/__orkestrator/status`);
    } finally {
      window.orkestratorGateway = previous;
    }
  });

  test("the page's own gateway resolves through the resolver its owner passes", async () => {
    const gateways = fakeGateways(A);
    const resolved: string[] = [];
    const page = transport({
      baseUrl: null,
      resolvePageUrl: (pathname) => {
        resolved.push(pathname);
        return `${A}${pathname}`;
      },
    });
    await page.invoke("ping");
    expect(resolved).toEqual(["/__orkestrator/invoke"]);
    expect(gateways[A]!.invokes).toHaveLength(1);
    expect(page.baseUrl).toBeNull();
  });

  test("it attaches no document or window listeners of its own", async () => {
    fakeGateways(A);
    manualTimers();
    const onDocument = spyOn(document, "addEventListener");
    const onWindow = spyOn(window, "addEventListener");
    try {
      const a = transport({ baseUrl: A, keepaliveOnPageHide: true });
      a.listen("changed", () => undefined);
      a.listen("terminal-output-s1", () => undefined);
      await settle();
      expect(onDocument).not.toHaveBeenCalled();
      expect(onWindow).not.toHaveBeenCalled();
    } finally {
      onDocument.mockRestore();
      onWindow.mockRestore();
    }
  });

  test("the opt-in terminal WebSocket comes only from its option", async () => {
    fakeGateways(A);
    manualTimers();
    localStorage.setItem("orkestrator-terminal-transport", "websocket");
    const sockets: string[] = [];
    try {
      const a = transport({
        baseUrl: A,
        terminalWebSocketFactory: (url) => {
          sockets.push(url);
          throw new Error("no sockets in this test");
        },
      });
      a.listen("terminal-output-s1", () => undefined);
      await settle();
      expect(sockets).toEqual([]);
    } finally {
      localStorage.removeItem("orkestrator-terminal-transport");
    }
  });
});

describe("a relayed node transport whose grant is revoked", () => {
  const RELAY = "http://localhost:1420/__orkestrator/nodes/bk_leaf";

  /** A relay base on the page's own origin, as `openLeafWorkspace` builds one. */
  function relayedTransport(onCredentialRejected: () => void): NodeTransport {
    happyDOM.setURL("http://localhost:1420/");
    return transport({
      baseUrl: RELAY,
      eventReconnectDelayMs: 100,
      eventReconnectRandom: TOP_OF_RANGE,
      onCredentialRejected,
    });
  }

  for (const failure of ["stream ends", "relay answers 502"] as const) {
    test(`detects the revocation through /status when the ${failure}`, async () => {
      const gateways = fakeGateways("http://localhost:1420");
      const relay = gateways["http://localhost:1420"]!;
      const timers = manualTimers();
      const rejected = mock(() => undefined);
      const leaf = relayedTransport(rejected);
      const states: string[] = [];
      leaf.eventStreamConnection.subscribe((state) => states.push(state));
      leaf.listen("changed", () => undefined);
      await until(() => leaf.eventStreamConnection.state() === "connected", "Never connected");
      expect(leaf.requestCredentials).toBe("same-origin");

      // The leaf revokes the forwarded grant: the stream says nothing about why.
      relay.statusStatus = 401;
      if (failure === "relay answers 502") {
        relay.eventsStatus = 502;
        mainStreams(relay)[0]!.end();
        await until(() => timers.pendingDelays().includes(100), "No reconnect was scheduled");
        // The first loss probes; the retry answered 502 then probes no more.
        await until(() => rejected.mock.calls.length === 1, "The revocation was not noticed");
        timers.fire(100);
        await settle();
      } else {
        mainStreams(relay)[0]!.end();
      }
      await until(() => rejected.mock.calls.length === 1, "The revocation was not noticed");
      await settle();
      expect(relay.statusRequests).toEqual(["/__orkestrator/nodes/bk_leaf/__orkestrator/status"]);
      // A refused credential, not an outage waiting for a reconnect.
      expect(leaf.eventStreamConnection.state()).toBe("connecting");
      expect(rejected).toHaveBeenCalledTimes(1);
    });
  }

  for (const [status, meaning] of [
    [200, "the grant still holds"],
    [404, "an older command node has no relayed /status"],
  ] as const) {
    test(`stays an outage when /status answers ${status} (${meaning})`, async () => {
      const gateways = fakeGateways("http://localhost:1420");
      const relay = gateways["http://localhost:1420"]!;
      manualTimers();
      const rejected = mock(() => undefined);
      const leaf = relayedTransport(rejected);
      leaf.listen("changed", () => undefined);
      await until(() => leaf.eventStreamConnection.state() === "connected", "Never connected");
      relay.statusStatus = status;
      mainStreams(relay)[0]!.end();
      await until(() => relay.statusRequests.length === 1, "/status was not probed");
      await settle();
      expect(rejected).not.toHaveBeenCalled();
      expect(leaf.eventStreamConnection.state()).toBe("disconnected");
    });
  }

  test("a network failure asks again after an earlier refusal", async () => {
    const gateways = fakeGateways("http://localhost:1420");
    const relay = gateways["http://localhost:1420"]!;
    const timers = manualTimers();
    const rejected = mock(() => undefined);
    const leaf = relayedTransport(rejected);
    leaf.listen("changed", () => undefined);
    await until(() => leaf.eventStreamConnection.state() === "connected", "Never connected");
    relay.statusStatus = 401;
    mainStreams(relay)[0]!.end();
    await until(() => rejected.mock.calls.length === 1, "The first refusal was not noticed");

    // The command node goes away entirely: nothing answers, which ends what the
    // refusal said, so the outage shows and the next answer is checked again.
    const answering = globalThis.fetch;
    const unanswered: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      unanswered.push(new URL(String(input)).pathname);
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    timers.fire(100);
    await until(
      () => leaf.eventStreamConnection.state() === "disconnected",
      "A network failure was not an outage",
    );
    await until(
      () => unanswered.includes("/__orkestrator/nodes/bk_leaf/__orkestrator/status"),
      "The credential was not asked about again",
    );
    globalThis.fetch = answering;
    await until(() => timers.pendingDelays().length === 1, "No retry was scheduled");
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});

describe("a failed invoke (plan item 1005)", () => {
  test("keeps the gateway's code and an incompatibility's bounded details", async () => {
    const bodies: Record<string, unknown> = {
      get_missing: toWire(unknownCommand("get_missing", "git")),
      get_versioned: {
        error: "Domain git version 9 is not supported; this backend accepts versions 1 to 2.",
        code: "unsupported-version",
        details: { domain: "git", range: { min: 1, max: 2 }, extra: "dropped" },
      },
      get_coded: { error: "Busy", code: "workspace-busy" },
      get_plain: { error: "Plain failure" },
    };
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { command } = JSON.parse(String(init?.body)) as { command: string };
      return new Response(JSON.stringify(bodies[command]), { status: 500 });
    }) as unknown as typeof fetch;
    const node = transport({ baseUrl: A, credential: "token-a" });
    const failure = (command: string) => node.invoke(command).catch((error: unknown) => error);

    const missing = await failure("get_missing");
    expect(missing).toBeInstanceOf(GatewayHttpError);
    expect(missing).toMatchObject({
      status: 500,
      code: "unknown-command",
      details: { domain: "git", command: "get_missing" },
      message: unknownBackendCommandMessage("get_missing"),
    });
    expect(incompatibility(missing, "get_missing")?.code).toBe("unknown-command");
    expect(incompatibility(missing, "get_other")).toBeNull();

    const versioned = (await failure("get_versioned")) as GatewayHttpError;
    expect(versioned.details).toEqual({ domain: "git", range: { min: 1, max: 2 } });
    expect(incompatibility(versioned)?.code).toBe("unsupported-version");

    const coded = (await failure("get_coded")) as GatewayHttpError;
    expect(coded.code).toBe("workspace-busy");
    expect(coded.details).toBeUndefined();
    expect(incompatibility(coded)).toBeNull();

    const plain = (await failure("get_plain")) as GatewayHttpError;
    expect(plain.code).toBeUndefined();
    expect(plain.message).toBe("Plain failure");
  });
});

describe("contract negotiation over a node transport (plan item 2011)", () => {
  const RELAY = "https://command.test/__orkestrator/nodes/bk_leaf";
  const HELLO = {
    schemaVersion: 1,
    installationId: "bk_leaf",
    generation: "gen-1",
    appVersion: "2.30.0",
    clientApi: { minVersion: 1, maxVersion: 1 },
    capabilities: {},
    profile: {
      revision: 1,
      displayName: "Leaf",
      colorToken: "teal",
      updatedAt: "2026-11-07T00:00:00.000Z",
    },
    endpointRole: "client",
    domains: { "node-mail": { min: 1, max: 1 } },
  };

  function answering(respond: (url: string) => Response) {
    const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return respond(url);
    }) as unknown as typeof fetch;
    return requests;
  }

  test("an invoke envelope's contract fields go beside command and args, and nothing else", async () => {
    const requests = answering(() => new Response(JSON.stringify({ result: { ok: true } })));
    const node = transport({ baseUrl: A, credential: "grant-a" });
    await node.invoke(
      "deliver_node_mail",
      { body: "hi", steer: true },
      {
        envelope: {
          domain: "node-mail",
          version: 1,
          critical: ["steer"],
          args: { smuggled: true },
        } as never,
      },
    );
    await node.invoke("get_projects", { page: 1 });
    expect(requests.map((request) => request.body)).toEqual([
      {
        command: "deliver_node_mail",
        args: { body: "hi", steer: true },
        domain: "node-mail",
        version: 1,
        critical: ["steer"],
      },
      { command: "get_projects", args: { page: 1 } },
    ]);
  });

  test("hello reads the node's own hello on a relay base, and tells no hello from a failure", async () => {
    let status = 200;
    let body = JSON.stringify(HELLO);
    const requests = answering(() => new Response(body, { status }));
    const node = transport({ baseUrl: RELAY });
    const hello = await node.hello();
    expect(requests.at(-1)?.url).toBe(`${RELAY}/__orkestrator/hello`);
    expect(hello?.domains).toEqual({ "node-mail": { min: 1, max: 1 } });

    status = 404;
    expect(await node.hello()).toBeNull();
    status = 200;
    body = "<!doctype html><title>Orkestrator</title>";
    expect(await node.hello()).toBeNull();
    status = 401;
    await expect(node.hello()).rejects.toThrow("HTTP 401");
    status = 503;
    await expect(node.hello()).rejects.toThrow("HTTP 503");
  });

  test("hello carries the transport's bearer", async () => {
    const requests = answering(() => new Response(JSON.stringify(HELLO)));
    await transport({ baseUrl: B, credential: "grant-b" }).hello();
    expect(requests.at(-1)).toMatchObject({
      url: `${B}/__orkestrator/hello`,
      authorization: "Bearer grant-b",
    });
  });
});

describe("a main stream opener (plan item 5005)", () => {
  test("carries the main stream, and `reconnect` replaces it from its cursor without a failure", async () => {
    const gateways = fakeGateways(A);
    const opened: Array<{ url: string; control: { reconnect(): void } }> = [];
    const node = transport({
      baseUrl: A,
      openMainStream: (url, init, control) => {
        opened.push({ url, control });
        return fetch(url, init);
      },
    });
    const received: unknown[] = [];
    node.listen("environment-changed", (payload) => received.push(payload));
    await waitFor(() => mainStreams(gateways[A]!).length === 1, "the first stream");
    const first = mainStreams(gateways[A]!)[0]!;
    first.push(frame("g:1", "gateway.connected", { status: "fresh" }));
    first.push(frame("g:2", "environment-changed", { id: "one" }));
    await waitFor(() => received.length === 1, "the first event");
    expect(node.eventStreamConnection.state()).toBe("connected");
    const states: string[] = [];
    node.eventStreamConnection.subscribe((state) => states.push(state));

    opened[0]!.control.reconnect();
    await waitFor(() => mainStreams(gateways[A]!).length === 2, "the replacement");
    expect(first.closedByClient()).toBe(true);
    expect(opened).toHaveLength(2);
    expect(new URL(opened[1]!.url).searchParams.get("since")).toBe("g:2");
    mainStreams(gateways[A]!)[1]!.push(frame("g:3", "environment-changed", { id: "two" }));
    await waitFor(() => received.length === 2, "the event on the replacement");
    // Never reported as an outage.
    expect(states).toEqual([]);
  });
});

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => originalSetTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}
