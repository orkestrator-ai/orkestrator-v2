import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeConnectionState } from "@orkestrator/protocol/node-client";
import {
  resolveNodeBrowserPreviewUrl,
  resolveNodeGatewayUrl,
  resolveNodeLoopbackBaseUrl,
} from "@/lib/gateway-url";
import type { NodeTransportLifecycle } from "@/lib/native/node-transport";
import type { OpenedNodeWorkspace } from "@/lib/portal/workspaces";
import {
  createNodeClientRegistry,
  NodeGrantOpenError,
  type LeafTransportClient,
  type LeafTransportClientOptions,
  type NodeClientRegistry,
  type NodeClientRegistryOptions,
} from "./node-clients";
import { createSignal, constantSignal } from "./signal";
import { typedInvoke } from "./typed-invoke";
import { typedListen } from "./typed-listen";
import { WindowScope } from "./window-scope";

const LEAF = "bk_leaf" as BackendId;
const OTHER = "bk_other" as BackendId;
const originalFetch = globalThis.fetch;

/** The command node: hands out grants, renews and closes them. */
function fakeCommandNode(directOrigins: Record<string, string[]> = {}) {
  let next = 0;
  const opened: OpenedNodeWorkspace[] = [];
  const renewed: string[] = [];
  const closed: string[] = [];
  let renewFails = false;
  let openFails = 0;
  let holdOpen: Promise<void> | null = null;
  const invoke = mock(async (command: string, args?: Record<string, unknown>) => {
    if (command === "open_node_workspace") {
      if (holdOpen) await holdOpen;
      if (openFails > 0) {
        openFails -= 1;
        throw new Error("command node unavailable");
      }
      next += 1;
      const nodeId = String(args?.nodeId);
      const workspace: OpenedNodeWorkspace = {
        workspaceId: `w${next}`,
        nodeId: nodeId as BackendId,
        nodeName: `Node ${nodeId}`,
        grant: { token: `grant-${next}`, expiresAt: Date.now() + 15 * 60_000 },
        directOrigins: directOrigins[nodeId] ?? [],
        relayBase: `/__orkestrator/nodes/${nodeId}`,
        commandRouteKind: "ssh",
      };
      opened.push(workspace);
      return workspace;
    }
    if (command === "renew_node_workspace") {
      renewed.push(String(args?.workspaceId));
      if (renewFails) throw new Error("grant lapsed");
      return null;
    }
    if (command === "close_node_workspace") {
      closed.push(String(args?.workspaceId));
      return null;
    }
    throw new Error(`unexpected ${command}`);
  });
  return {
    invoke,
    opened,
    renewed,
    closed,
    opens: () => invoke.mock.calls.filter(([command]) => command === "open_node_workspace").length,
    failRenewals: () => {
      renewFails = true;
    },
    failNextOpens: (count: number) => {
      openFails = count;
    },
    holdOpens: () => {
      let release!: () => void;
      holdOpen = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        holdOpen = null;
        release();
      };
    },
  };
}

/** A transport client that records what the registry asked of it. */
interface FakeLeafClient extends LeafTransportClient {
  readonly options: LeafTransportClientOptions;
  readonly setCredential: ReturnType<typeof mock>;
  readonly dispose: ReturnType<typeof mock>;
  emit(event: string, payload: unknown): void;
  listenerCount(): number;
  setConnection(state: NodeConnectionState): void;
}

function fakeClientFactory() {
  const created: FakeLeafClient[] = [];
  const create = (options: LeafTransportClientOptions): LeafTransportClient => {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const connection = createSignal<NodeConnectionState>("connecting");
    const client: FakeLeafClient = {
      options,
      nodeId: options.nodeId,
      baseUrl: options.transport.baseUrl,
      url: (pathname) => `${options.transport.baseUrl}${pathname}`,
      setCredential: mock((_token: string) => {}),
      invokeRaw: async <T>(command: string) => ({ command, base: options.transport.baseUrl }) as T,
      invoke: typedInvoke(async (command) => ({ command, base: options.transport.baseUrl })),
      listenRaw<T>(event: string, handler: (payload: T) => void) {
        const set = handlers.get(event) ?? new Set();
        handlers.set(event, set);
        const wrapped = handler as (payload: unknown) => void;
        set.add(wrapped);
        return () => {
          set.delete(wrapped);
        };
      },
      listen: typedListen((event, handler) => client.listenRaw(event, handler)),
      eventStreamReady: async () => {},
      terminal: { listenOutput: () => () => {}, outputReady: async () => {} },
      connection,
      domains: constantSignal(null),
      capabilities: constantSignal(null),
      suspend() {},
      resume() {},
      dispose: mock(() => {}),
      emit(event, payload) {
        for (const handler of Array.from(handlers.get(event) ?? [])) handler(payload);
      },
      listenerCount: () => Array.from(handlers.values()).reduce((n, set) => n + set.size, 0),
      setConnection: (state) => connection.set(state),
    };
    created.push(client);
    return client;
  };
  return { create, created };
}

function fakeLifecycle() {
  const pageHide = new Set<(hiding: boolean) => void>();
  const lifecycle: NodeTransportLifecycle = {
    onVisibility: () => () => {},
    onOnline: () => () => {},
    onPageHide(listener) {
      pageHide.add(listener);
      return () => pageHide.delete(listener);
    },
  };
  return {
    lifecycle,
    hide: () => {
      for (const listener of Array.from(pageHide)) listener(true);
    },
    show: () => {
      for (const listener of Array.from(pageHide)) listener(false);
    },
    listeners: () => pageHide.size,
  };
}

const waitFor = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
};

let registries: NodeClientRegistry[] = [];
afterEach(() => {
  for (const registry of registries) registry.dispose();
  registries = [];
  globalThis.fetch = originalFetch;
});

function setup(
  config: {
    directOrigins?: Record<string, string[]>;
    reachable?: string[];
    options?: Partial<NodeClientRegistryOptions>;
  } = {},
) {
  const command = fakeCommandNode(config.directOrigins);
  const clients = fakeClientFactory();
  const page = fakeLifecycle();
  // `online`/`focus` for the renewal, counting its listeners.
  const renewalListeners = new Set<EventListenerOrEventListenerObject>();
  const renewalEvents = {
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
      renewalListeners.add(listener),
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
      renewalListeners.delete(listener),
  } as Pick<Window, "addEventListener" | "removeEventListener">;
  const reachable = new Set(config.reachable ?? []);
  const probe = mock(async (origin: string, _token: string, _nodeId: string) =>
    reachable.has(origin),
  );
  const closeOnPageHide = mock((_workspaceId: string) => {});
  const clearRichContent = mock((_nodeId: BackendId) => {});
  const registry = createNodeClientRegistry({
    commandInvoke: command.invoke as never,
    commandNodeName: () => "Desk",
    closeOnPageHide,
    lifecycle: page.lifecycle,
    createClient: clients.create,
    probe,
    renewal: { tickMs: 5, renewIntervalMs: 60 * 60_000, events: renewalEvents },
    openPolicy: { retries: 1, retryBaseDelayMs: 1, retryMaxDelayMs: 2, attemptTimeoutMs: 2_000 },
    clearRichContent,
    ...config.options,
  });
  registries.push(registry);
  return {
    command,
    clients,
    page,
    probe,
    reachable,
    registry,
    closeOnPageHide,
    clearRichContent,
    /** Forces a renewal check, as `focus` does. */
    renewNow: () => {
      for (const listener of Array.from(renewalListeners)) {
        if (typeof listener === "function") listener(new Event("focus"));
        else listener.handleEvent(new Event("focus"));
      }
    },
    renewalListeners: () => renewalListeners.size,
  };
}

describe("opening a leaf", () => {
  test("direct success: the grant's bearer goes straight to the leaf, terminals on WebSocket", async () => {
    const { registry, clients, probe } = setup({
      directOrigins: { [LEAF]: ["https://leaf.test"] },
      reachable: ["https://leaf.test"],
    });
    const client = await registry.acquire(LEAF);
    expect(probe).toHaveBeenCalledWith("https://leaf.test", "grant-1", LEAF);
    expect(client.route.get()).toEqual({
      nodeName: `Node ${LEAF}`,
      path: "direct",
      routeKind: "https",
      baseUrl: "https://leaf.test",
      relayBaseUrl: `${window.location.origin}/__orkestrator/nodes/${LEAF}`,
    });
    expect(client.baseUrl).toBe("https://leaf.test");
    const transport = clients.created[0]!.options.transport;
    expect(transport.baseUrl).toBe("https://leaf.test");
    expect(transport.credential).toBe("grant-1");
    expect(transport.terminalTransport).toBe("websocket");
    expect(await client.invokeRaw("get_projects")).toEqual({
      command: "get_projects",
      base: "https://leaf.test",
    });
  });

  test("direct failure then relay: the relay base on this page's own session, no bearer", async () => {
    const { registry, clients } = setup({
      directOrigins: { [LEAF]: ["https://down.test", "https://also-down.test"] },
    });
    const client = await registry.acquire(LEAF);
    expect(client.route.get()).toMatchObject({
      path: "relay",
      routeKind: "ssh",
      via: "Desk",
      baseUrl: `${window.location.origin}/__orkestrator/nodes/${LEAF}`,
    });
    const transport = clients.created[0]!.options.transport;
    expect(transport.baseUrl).toBe(`${window.location.origin}/__orkestrator/nodes/${LEAF}`);
    expect(transport.credential).toBeUndefined();
  });

  test("an HTML answer or another installation is not the leaf: relay", async () => {
    // The real probe, as `workspaces.test.ts` drives it.
    globalThis.fetch = mock(async (input: RequestInfo | URL) =>
      String(input).includes("html")
        ? new Response("<html>login</html>")
        : new Response(JSON.stringify({ installationId: "bk_wrong", endpointRole: "client" })),
    ) as unknown as typeof fetch;
    const { registry } = setup({
      directOrigins: { [LEAF]: ["https://html.test", "https://wrong.test"] },
      options: { probe: undefined },
    });
    const client = await registry.acquire(LEAF);
    expect(client.route.get().path).toBe("relay");
  });

  test("an open that keeps failing rejects after its retries, and the next acquire tries afresh", async () => {
    const { registry, command } = setup();
    command.failNextOpens(2);
    const failure = await registry.acquire(LEAF).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NodeGrantOpenError);
    expect((failure as NodeGrantOpenError).nodeId).toBe(LEAF);
    expect(command.opens()).toBe(2);
    expect(registry.references(LEAF)).toBe(0);
    const client = await registry.acquire(LEAF);
    expect(client.route.get().path).toBe("relay");
    expect(command.opens()).toBe(3);
  });

  test("an attempt that outlasts its timeout fails, and its late grant is revoked", async () => {
    const { registry, command } = setup({
      options: { openPolicy: { retries: 0, attemptTimeoutMs: 20 } },
    });
    const releaseOpen = command.holdOpens();
    const failure = await registry.acquire(LEAF).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NodeGrantOpenError);
    expect((failure as Error).message).toContain("timed out");
    releaseOpen();
    await waitFor(() => command.closed.length === 1, "the late grant to be revoked");
    expect(command.closed).toEqual(["w1"]);
  });

  test("a failed attempt is retried on the schedule", async () => {
    const { registry, command } = setup();
    command.failNextOpens(1);
    await registry.acquire(LEAF);
    expect(command.opens()).toBe(2);
  });
});

describe("grant lifetime", () => {
  test("renewal renews the grant in use", async () => {
    const { registry, command, renewNow } = setup();
    await registry.acquire(LEAF);
    renewNow();
    await waitFor(() => command.renewed.length === 1, "renewal");
    expect(command.renewed).toEqual(["w1"]);
  });

  test("a lapse reopens and swaps the bearer without a reload", async () => {
    const { registry, command, clients, clearRichContent, renewNow } = setup({
      directOrigins: { [LEAF]: ["https://leaf.test"] },
      reachable: ["https://leaf.test"],
    });
    const client = await registry.acquire(LEAF);
    const received: unknown[] = [];
    client.listenRaw("environments-changed", (payload) => received.push(payload));
    command.failRenewals();
    renewNow();
    await waitFor(() => command.closed.includes("w1"), "the lapsed grant to be replaced");

    expect(command.opens()).toBe(2);
    // Same transport client: the new grant is a credential swap, not a new page.
    expect(clients.created).toHaveLength(1);
    expect(clients.created[0]!.setCredential).toHaveBeenCalledWith("grant-2");
    expect(clients.created[0]!.dispose).not.toHaveBeenCalled();
    expect(clearRichContent).toHaveBeenCalledWith(LEAF);
    clients.created[0]!.emit("environments-changed", { n: 1 });
    expect(received).toEqual([{ n: 1 }]);
  });

  test("a refused credential reopens at once, and a second refusal waits out the interval", async () => {
    const intervalMs = 40;
    const { registry, command, clients } = setup({
      directOrigins: { [LEAF]: ["https://leaf.test"] },
      reachable: ["https://leaf.test"],
      options: { credentialReopenMinIntervalMs: intervalMs },
    });
    await registry.acquire(LEAF);
    const reject = () => clients.created[0]!.options.transport.onCredentialRejected?.();
    const firstRefusalAt = performance.now();
    reject();
    await waitFor(() => command.closed.includes("w1"), "the refused grant to be replaced");
    expect(clients.created[0]!.setCredential).toHaveBeenCalledWith("grant-2");
    reject();
    await waitFor(() => command.closed.includes("w2"), "the second reopen");
    expect(performance.now() - firstRefusalAt).toBeGreaterThanOrEqual(intervalMs - 5);
    expect(clients.created[0]!.setCredential).toHaveBeenLastCalledWith("grant-3");
  });

  test("a reopen on another route replaces the transport and keeps the holder's listeners", async () => {
    const { registry, clients, reachable, renewNow, command } = setup({
      directOrigins: { [LEAF]: ["https://leaf.test"] },
      reachable: ["https://leaf.test"],
    });
    const client = await registry.acquire(LEAF);
    const received: unknown[] = [];
    client.listenRaw("environments-changed", (payload) => received.push(payload));
    reachable.clear();
    command.failRenewals();
    renewNow();
    await waitFor(() => clients.created.length === 2, "a relayed transport");

    expect(client.route.get().path).toBe("relay");
    expect(client.baseUrl).toBe(`${window.location.origin}/__orkestrator/nodes/${LEAF}`);
    expect(clients.created[0]!.dispose).toHaveBeenCalled();
    expect(clients.created[0]!.listenerCount()).toBe(0);
    clients.created[1]!.emit("environments-changed", "after");
    expect(received).toEqual(["after"]);
    clients.created[1]!.setConnection("live");
    expect(client.connection.get()).toBe("live");
  });

  test("one grant per node: the last release revokes it and stops renewal", async () => {
    const { registry, command, clients, renewNow, renewalListeners } = setup();
    const first = await registry.acquire(LEAF);
    const second = await registry.acquire(LEAF);
    expect(command.opens()).toBe(1);
    expect(registry.references(LEAF)).toBe(2);

    first.dispose();
    first.dispose();
    expect(command.closed).toEqual([]);
    expect(registry.references(LEAF)).toBe(1);

    registry.release(LEAF);
    expect(registry.references(LEAF)).toBe(0);
    await waitFor(() => command.closed.length === 1, "the revoke");
    expect(command.closed).toEqual(["w1"]);
    expect(clients.created[0]!.dispose).toHaveBeenCalled();
    await expect(second.invokeRaw("get_projects")).rejects.toThrow("disposed");
    // The renewal stopped with the grant: nothing hears `focus` any more.
    expect(renewalListeners()).toBe(0);
    renewNow();
    expect(command.renewed).toEqual([]);
  });

  test("released while opening: the acquire rejects and the late grant is revoked", async () => {
    const { registry, command } = setup();
    const releaseOpen = command.holdOpens();
    const acquiring = registry.acquire(LEAF).catch((error: unknown) => error);
    await waitFor(() => command.invoke.mock.calls.length === 1, "the open");
    registry.release(LEAF);
    releaseOpen();
    expect(await acquiring).toBeInstanceOf(Error);
    await waitFor(() => command.closed.length === 1, "the late grant to be revoked");
    expect(command.closed).toEqual(["w1"]);
  });

  test("pagehide revokes with a keepalive close; a restored page opens a new grant", async () => {
    const { registry, command, clients, page, closeOnPageHide } = setup({
      directOrigins: { [LEAF]: ["https://leaf.test"] },
      reachable: ["https://leaf.test"],
    });
    await registry.acquire(LEAF);
    page.hide();
    expect(closeOnPageHide).toHaveBeenCalledWith("w1");
    // The ordinary close would not outlive the page.
    expect(command.closed).toEqual([]);

    page.show();
    await waitFor(() => command.opens() === 2, "a new grant");
    await waitFor(() => clients.created[0]!.setCredential.mock.calls.length === 1, "the swap");
    expect(clients.created[0]!.setCredential).toHaveBeenCalledWith("grant-2");
  });

  test("the default pagehide close is a keepalive command to the page's gateway", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ result: null })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { registry, page } = setup({ options: { closeOnPageHide: undefined } });
    await registry.acquire(LEAF);
    page.hide();
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe("/__orkestrator/invoke");
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(String(init.body))).toEqual({
      command: "close_node_workspace",
      args: { workspaceId: "w1" },
    });
  });

  test("dispose revokes every grant and stops listening to the page", async () => {
    const { registry, command, page } = setup();
    await registry.acquire(LEAF);
    await registry.acquire(OTHER);
    registry.dispose();
    await waitFor(() => command.closed.length === 2, "both revokes");
    expect(command.closed.sort()).toEqual(["w1", "w2"]);
    expect(page.listeners()).toBe(0);
    await expect(registry.acquire(LEAF)).rejects.toThrow("disposed");
  });
});

describe("per-node URLs", () => {
  test("element loads go through the relay even for a direct leaf; fetches use the route", async () => {
    const { registry } = setup({
      directOrigins: { [LEAF]: ["https://leaf.test"] },
      reachable: ["https://leaf.test"],
    });
    const client = await registry.acquire(LEAF);
    const relay = `${window.location.origin}/__orkestrator/nodes/${LEAF}`;
    expect(client.url("/__orkestrator/hello")).toBe("https://leaf.test/__orkestrator/hello");
    expect(client.resolveMediaUrl("media/a.png")).toBe(`${relay}/media/a.png`);
    expect(client.resolvePreviewUrl("http://localhost:5173/app?x=1#h")).toBe(
      `${relay}/__orkestrator/browser/loopback/5173/app?x=1#h`,
    );
    expect(client.resolveLoopbackUrl("http://127.0.0.1:8080/api/")).toBe(
      `${relay}/__orkestrator/proxy/loopback/8080/api`,
    );
    await expect(client.resolveExternalLoopbackUrl("http://127.0.0.1:8080/api/")).resolves.toBe(
      `${relay}/__orkestrator/proxy/loopback/8080/api`,
    );
  });

  test("the node-taking variants in gateway-url", () => {
    expect(resolveNodeGatewayUrl("https://leaf.test/", "/x")).toBe("https://leaf.test/x");
    expect(resolveNodeLoopbackBaseUrl("https://leaf.test", "https://example.com/")).toBe(
      "https://example.com/",
    );
    expect(resolveNodeLoopbackBaseUrl("https://leaf.test", "http://localhost/")).toBe(
      "https://leaf.test/__orkestrator/proxy/loopback/80",
    );
    expect(resolveNodeBrowserPreviewUrl("https://leaf.test", "https://localhost:3000/")).toBe(
      "https://localhost:3000/",
    );
    expect(resolveNodeBrowserPreviewUrl("https://leaf.test", "http://[::1]:3000/p")).toBe(
      "https://leaf.test/__orkestrator/browser/loopback/3000/p",
    );
  });
});

describe("two leaves", () => {
  test("two leaves acquired at once get independent grants and transports", async () => {
    // The real browser NodeClient and transport, against two fake leaves.
    const calls: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ result: { from: new URL(url).host } }));
    }) as unknown as typeof fetch;
    const { registry, command } = setup({
      directOrigins: { [LEAF]: ["https://leaf.test"], [OTHER]: ["https://other.test"] },
      reachable: ["https://leaf.test", "https://other.test"],
      options: { createClient: undefined },
    });
    const [leaf, other] = await Promise.all([registry.acquire(LEAF), registry.acquire(OTHER)]);
    expect(command.opens()).toBe(2);
    const tokens = Object.fromEntries(command.opened.map((w) => [w.nodeId, w.grant.token]));
    expect(tokens[LEAF]).not.toBe(tokens[OTHER]);

    expect(await leaf.invokeRaw("get_projects")).toEqual({ from: "leaf.test" });
    expect(await other.invokeRaw("get_projects")).toEqual({ from: "other.test" });
    // Each client read its own node's hello on its own grant (plan item 2011).
    expect(calls).toEqual([
      { url: "https://leaf.test/__orkestrator/hello", authorization: `Bearer ${tokens[LEAF]}` },
      { url: "https://other.test/__orkestrator/hello", authorization: `Bearer ${tokens[OTHER]}` },
      { url: "https://leaf.test/__orkestrator/invoke", authorization: `Bearer ${tokens[LEAF]}` },
      { url: "https://other.test/__orkestrator/invoke", authorization: `Bearer ${tokens[OTHER]}` },
    ]);

    // Releasing one leaves the other working on its own grant.
    leaf.dispose();
    await waitFor(() => command.closed.length === 1, "the revoke");
    expect(await other.invokeRaw("get_projects")).toEqual({ from: "other.test" });
  });

  test("two relayed leaves warm at once share one main stream request (5005)", async () => {
    // The real browser NodeClient and transport; both leaves relay (no direct origin).
    const streams: Array<{ url: URL; signal: AbortSignal | null | undefined }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.href);
      if (url.pathname.endsWith("/events")) {
        streams.push({ url, signal: init?.signal });
        return new Response(new ReadableStream<Uint8Array>(), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify({ result: null }));
    }) as unknown as typeof fetch;
    const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
    const href = window.location.href;
    happyDOM.setURL("https://command.test/");
    const { registry } = setup({ options: { createClient: undefined } });
    const [leaf, other] = await Promise.all([registry.acquire(LEAF), registry.acquire(OTHER)]);
    expect(leaf.route.get().path).toBe("relay");
    const stopLeaf = leaf.listenRaw("environment-changed", () => {});
    const stopOther = other.listenRaw("environment-changed", () => {});
    await waitFor(
      () => streams.some((stream) => stream.url.pathname === "/__orkestrator/nodes/events"),
      "the shared request",
    );
    const shared = streams.find((stream) => stream.url.pathname === "/__orkestrator/nodes/events")!;
    const query = shared.url.searchParams;
    expect(query.get("nodes")?.split(",").sort()).toEqual([LEAF, OTHER].sort());
    // Each node names the workspace this window opened for it.
    expect([query.get(`workspace.${LEAF}`), query.get(`workspace.${OTHER}`)].sort()).toEqual([
      "w1",
      "w2",
    ]);
    // No leaf keeps a stream of its own once they share.
    await waitFor(
      () =>
        streams
          .filter((stream) => stream.url.pathname.endsWith("/__orkestrator/events"))
          .every((stream) => stream.signal?.aborted),
      "per-node streams closed",
    );
    stopLeaf();
    stopOther();
    registry.dispose();
    happyDOM.setURL(href);
  });

  test("a leaf opens as a leaf scope of the window, and disposing the scope releases it", async () => {
    const { registry, command } = setup();
    const windowScope = new WindowScope();
    try {
      const scope = await registry.openLeafScope(windowScope, LEAF, { tier: "warm" });
      expect(scope.role).toBe("leaf");
      expect(windowScope.get(LEAF)).toBe(scope);
      expect(await registry.openLeafScope(windowScope, LEAF)).toBe(scope);
      expect(registry.references(LEAF)).toBe(1);
      scope.dispose();
      expect(registry.references(LEAF)).toBe(0);
      await waitFor(() => command.closed.length === 1, "the revoke");
    } finally {
      windowScope.dispose();
    }
  });
});
