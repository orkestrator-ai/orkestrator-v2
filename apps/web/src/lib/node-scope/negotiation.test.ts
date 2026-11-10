import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BackendHello } from "@orkestrator/protocol/backend-profile";
import { nodeMailDomain } from "@orkestrator/protocol/contract/domains/node-mail";
import { deliverNodeMailCommand } from "@orkestrator/protocol/contract/domains/node-mail";
import { InvalidCommandResultError } from "@orkestrator/protocol/contract/command";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NegotiatedDomains, NodeClient } from "@orkestrator/protocol/node-client";
import type {
  GatewayEventStreamConnectionState,
  NodeTransport,
  NodeTransportOptions,
} from "@/lib/native/node-transport";
import { createBrowserNodeClient } from "./browser-node-client";
import { createWindowOrkestratorClient } from "./command-client";
import { createDesktopNodeClient, snapshotHello } from "./desktop-node-client";
import { createHelloNegotiation, helloFrom } from "./negotiation";

type Api = NonNullable<Window["orkestrator"]>;
type StreamState = GatewayEventStreamConnectionState;

const LEAF = "bk_leaf" as BackendId;
const COMMAND = "bk_command" as BackendId;
const MAIL: NegotiatedDomains = { "node-mail": { min: 1, max: 1 } };

function hello(
  generation: string,
  options: { installationId?: string; domains?: NegotiatedDomains; capabilities?: string[] } = {},
): BackendHello {
  return {
    schemaVersion: 1,
    installationId: (options.installationId ?? LEAF) as BackendId,
    generation,
    appVersion: "2.30.0",
    clientApi: { minVersion: 1, maxVersion: 1 },
    capabilities: Object.fromEntries((options.capabilities ?? []).map((name) => [name, 1])),
    profile: {
      revision: 1,
      displayName: "Leaf",
      colorToken: "teal",
      updatedAt: "2026-11-07T00:00:00.000Z",
    },
    endpointRole: "client",
    ...(options.domains ? { domains: options.domains } : {}),
  } as BackendHello;
}

/** Settles queued promise callbacks (the clients read the hello asynchronously). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
function track<C extends NodeClient>(client: C): C {
  disposers.push(() => client.dispose());
  return client;
}

describe("createHelloNegotiation", () => {
  test("publishes new values only for another generation's hello", async () => {
    let answer: unknown = hello("g1", { domains: MAIL, capabilities: ["node-mail-steer"] });
    const negotiation = createHelloNegotiation(async () => answer);
    expect(negotiation.domains.get()).toBeNull();
    await negotiation.refresh();
    const first = negotiation.domains.get();
    expect(first).toEqual(MAIL);
    expect(negotiation.capabilities.get()).toEqual(new Set(["node-mail-steer"]));
    expect(negotiation.installationId.get()).toBe(LEAF);

    // The same generation again (a reconnect to the same process): same objects.
    answer = hello("g1", { domains: MAIL, capabilities: ["node-mail-steer"] });
    await negotiation.refresh();
    expect(negotiation.domains.get()).toBe(first);

    // A restarted or upgraded backend: new objects.
    answer = hello("g2", { domains: MAIL });
    await negotiation.refresh();
    expect(negotiation.domains.get()).not.toBe(first);
    expect(negotiation.domains.get()).toEqual(MAIL);
    expect(negotiation.capabilities.get()).toEqual(new Set());
  });

  test("no hello is pre-contract; an unknown answer or a failure changes nothing", async () => {
    let answer: () => unknown = () => hello("g1", { domains: MAIL });
    const negotiation = createHelloNegotiation(async () => answer());
    await negotiation.refresh();
    const domains = negotiation.domains.get();

    answer = () => undefined;
    await negotiation.refresh();
    answer = () => {
      throw new Error("unreachable");
    };
    await negotiation.refresh();
    expect(negotiation.domains.get()).toBe(domains);

    answer = () => null;
    await negotiation.refresh();
    expect(negotiation.domains.get()).toBeNull();
    expect(negotiation.capabilities.get()).toBeNull();
    expect(negotiation.installationId.get()).toBeNull();

    // A hello without `domains` is pre-contract but still gates on capabilities.
    answer = () => hello("g3", { capabilities: ["node-mail-steer"] });
    await negotiation.refresh();
    expect(negotiation.domains.get()).toBeNull();
    expect(negotiation.capabilities.get()).toEqual(new Set(["node-mail-steer"]));
  });

  test("coalesces reads, `ensure` reads only until an answer, and dispose stops publishing", async () => {
    let release!: () => void;
    const source = mock(
      () => new Promise<unknown>((resolve) => (release = () => resolve(hello("g1")))),
    );
    const negotiation = createHelloNegotiation(source);
    const first = negotiation.ensure();
    void negotiation.ensure();
    expect(source).toHaveBeenCalledTimes(1);
    release();
    await first;
    await negotiation.ensure();
    expect(source).toHaveBeenCalledTimes(1);

    const pending = negotiation.refresh();
    void negotiation.refresh();
    release();
    await settle();
    release();
    await pending;
    expect(source).toHaveBeenCalledTimes(3);

    negotiation.dispose();
    await negotiation.refresh();
    expect(source).toHaveBeenCalledTimes(3);
  });

  test("helloFrom accepts only a valid hello", () => {
    expect(helloFrom(hello("g1"))?.generation).toBe("g1");
    expect(helloFrom({ schemaVersion: 2 })).toBeNull();
    expect(helloFrom("<html>")).toBeNull();
    expect(helloFrom(null)).toBeNull();
  });
});

/** The slice of a node transport the browser client uses, with a settable hello. */
function fakeTransport(options: NodeTransportOptions) {
  const streamListeners = new Set<(state: StreamState) => void>();
  let stream: StreamState = "idle";
  let answer: unknown = null;
  const transport = {
    invoke: mock(
      (command: string, args?: Record<string, unknown>, _options?: unknown): Promise<unknown> =>
        Promise.resolve({ command, args }),
    ),
    hello: mock(async () => answer),
    listen: () => () => {},
    eventStreamReady: () => Promise.resolve(),
    eventStreamConnection: {
      state: () => stream,
      subscribe: (listener: (state: StreamState) => void) => {
        streamListeners.add(listener);
        return () => {
          streamListeners.delete(listener);
        };
      },
    },
    baseUrl: options.baseUrl,
    requestCredentials: "omit" as RequestCredentials,
    url: (pathname: string) => `${options.baseUrl}${pathname}`,
    requestHeaders: () => undefined,
    readResponse: async <T>() => undefined as T,
    credential: () => undefined,
    setCredential: () => {},
    dispose: () => {},
  };
  return {
    transport: transport as unknown as NodeTransport,
    raw: transport,
    answer: (value: unknown) => {
      answer = value;
    },
    setStream(state: StreamState) {
      stream = state;
      for (const listener of Array.from(streamListeners)) listener(state);
    },
  };
}

describe("the browser NodeClient's hello", () => {
  function open(first: unknown) {
    let fake!: ReturnType<typeof fakeTransport>;
    const client = track(
      createBrowserNodeClient({
        nodeId: LEAF,
        transport: { baseUrl: "https://leaf.test", credential: "grant" },
        createTransport: (options) => {
          fake = fakeTransport(options);
          fake.answer(first);
          return fake.transport;
        },
      }),
    );
    return { client, fake };
  }

  test("is read at creation, and again on a reconnect after a drop", async () => {
    const { client, fake } = open(hello("g1", { domains: MAIL }));
    await settle();
    expect(fake.raw.hello).toHaveBeenCalledTimes(1);
    const first = client.domains.get();
    expect(first).toEqual(MAIL);

    // The first open after creation does not read again.
    fake.setStream("connected");
    await settle();
    expect(fake.raw.hello).toHaveBeenCalledTimes(1);

    // Reconnect to an upgraded backend: a new generation, new objects.
    fake.answer(hello("g2", { domains: { "node-mail": { min: 1, max: 2 } } }));
    fake.setStream("disconnected");
    fake.setStream("connected");
    await settle();
    expect(fake.raw.hello).toHaveBeenCalledTimes(2);
    expect(client.domains.get()).not.toBe(first);
    expect(client.domains.get()).toEqual({ "node-mail": { min: 1, max: 2 } });
  });

  test("a node without a hello stays pre-contract", async () => {
    const { client } = open(null);
    await settle();
    expect(client.domains.get()).toBeNull();
    expect(client.capabilities.get()).toBeNull();
  });

  test("typed invoke sends the envelope beside the arguments and decodes the result", async () => {
    const { client, fake } = open(null);
    fake.raw.invoke.mockImplementation(async () => ({ messageId: "m1", ignored: true }));
    const result = await client.invoke(deliverNodeMailCommand, { body: "hi", steer: true });
    expect(result).toEqual({ messageId: "m1" });
    expect(fake.raw.invoke).toHaveBeenLastCalledWith(
      "deliver_node_mail",
      { body: "hi", steer: true },
      { envelope: { domain: "node-mail", version: nodeMailDomain.version, critical: ["steer"] } },
    );
    // An untyped call is unchanged: two arguments, no envelope.
    await client.invokeRaw("get_projects", { page: 1 });
    expect(fake.raw.invoke).toHaveBeenLastCalledWith("get_projects", { page: 1 });

    fake.raw.invoke.mockImplementation(async () => ({ messageId: 7 }));
    await expect(client.invoke(deliverNodeMailCommand, { body: "hi" })).rejects.toBeInstanceOf(
      InvalidCommandResultError,
    );
  });
});

/** The preload's `node(nodeId)` and `nodes` for one leaf, with main's snapshot. */
function fakeDesktopHost(snapshot: () => unknown) {
  const stateListeners = new Set<(state: StreamState) => void>();
  let state: StreamState = "idle";
  const nodeApi = {
    nodeId: LEAF,
    invoke: mock((command: string, args?: Record<string, unknown>, _options?: unknown) =>
      Promise.resolve({ command, args }),
    ),
    listen: () => () => {},
    eventStreamReady: () => Promise.resolve(),
    eventStreamConnection: {
      state: () => state,
      subscribe(listener: (next: StreamState) => void) {
        stateListeners.add(listener);
        return () => {
          stateListeners.delete(listener);
        };
      },
    },
  };
  const gateway = mock(async (_nodeId: string) => snapshot());
  const api = {
    invoke: mock(() => Promise.resolve(null)),
    listen: () => () => {},
    node: () => nodeApi,
    nodes: { release: async () => {}, gateway },
  } as unknown as Api;
  return {
    api,
    nodeApi,
    gateway,
    setState(next: StreamState) {
      state = next;
      for (const listener of Array.from(stateListeners)) listener(next);
    },
  };
}

describe("the desktop NodeClient's hello", () => {
  test("comes from main's gateway snapshot when the stream connects, and after a drop", async () => {
    let current: unknown = { nodeId: LEAF, hello: hello("g1", { domains: MAIL }) };
    const host = fakeDesktopHost(() => current);
    const client = track(
      createDesktopNodeClient({ nodeId: LEAF, host: () => host.api, commandNodeId: COMMAND }),
    );
    await settle();
    expect(host.gateway).not.toHaveBeenCalled();
    expect(client.domains.get()).toBeNull();

    host.setState("connected");
    await settle();
    expect(host.gateway).toHaveBeenCalledWith(LEAF);
    const first = client.domains.get();
    expect(first).toEqual(MAIL);

    // A snapshot without an answer (main could not tell) keeps the generation.
    current = { nodeId: LEAF };
    host.setState("disconnected");
    host.setState("connected");
    await settle();
    expect(client.domains.get()).toBe(first);

    // A pre-contract node after a reconnect.
    current = { nodeId: LEAF, hello: null };
    host.setState("disconnected");
    host.setState("connected");
    await settle();
    expect(client.domains.get()).toBeNull();
    expect(host.gateway).toHaveBeenCalledTimes(3);
  });

  test("typed invoke crosses IPC with the envelope as options, never inside the arguments", async () => {
    const host = fakeDesktopHost(() => null);
    const client = track(
      createDesktopNodeClient({ nodeId: LEAF, host: () => host.api, commandNodeId: COMMAND }),
    );
    await client.invoke(deliverNodeMailCommand, { body: "hi" });
    expect(host.nodeApi.invoke).toHaveBeenLastCalledWith(
      "deliver_node_mail",
      { body: "hi" },
      { envelope: { domain: "node-mail", version: nodeMailDomain.version } },
    );
  });

  test("snapshotHello tells an answer from no answer", () => {
    expect(snapshotHello(null)).toBeUndefined();
    expect(snapshotHello({ nodeId: LEAF })).toBeUndefined();
    expect(snapshotHello({ nodeId: LEAF, hello: null })).toBeNull();
    expect(snapshotHello({ hello: { a: 1 } })).toEqual({ a: 1 });
  });
});

describe("the command NodeClient's hello", () => {
  test("a hosted page reads its gateway's hello and adopts the proven id", async () => {
    let answer: unknown = hello("g1", { installationId: COMMAND, domains: MAIL });
    const streamListeners = new Set<(state: StreamState) => void>();
    const api = {
      invoke: mock(() => Promise.resolve(null)),
      hello: mock(async () => answer),
      listen: () => () => {},
      eventStreamConnection: {
        state: () => "connected" as StreamState,
        subscribe: (listener: (state: StreamState) => void) => {
          streamListeners.add(listener);
          return () => streamListeners.delete(listener);
        },
      },
    } as unknown as Api;
    const client = track(
      createWindowOrkestratorClient("provisional:command-node" as BackendId, () => api),
    );
    await settle();
    expect(client.domains.get()).toEqual(MAIL);
    expect(client.provenNodeId.get()).toBe(COMMAND);
    expect(client.nodeId).toBe(COMMAND);

    // A reconnect after a drop reads it again.
    answer = hello("g2", { installationId: COMMAND });
    for (const listener of Array.from(streamListeners)) listener("disconnected");
    for (const listener of Array.from(streamListeners)) listener("connected");
    await settle();
    expect(client.domains.get()).toBeNull();
    expect((api as unknown as { hello: ReturnType<typeof mock> }).hello).toHaveBeenCalledTimes(2);
  });

  test("an Electron IPC window reads main's snapshot for its proven id, again on a connection change", async () => {
    const listeners = new Map<string, () => void>();
    let answer: unknown = hello("g1", { installationId: COMMAND, domains: MAIL });
    const gateway = mock(async (nodeId: string) => ({ nodeId, commandNode: true, hello: answer }));
    const api = {
      invoke: mock(() => Promise.resolve(null)),
      listen: (event: string, callback: () => void) => {
        listeners.set(event, callback);
        return () => listeners.delete(event);
      },
      nodes: { release: async () => {}, gateway },
    } as unknown as Api;
    const client = track(createWindowOrkestratorClient(COMMAND, () => api));
    await settle();
    expect(gateway).toHaveBeenCalledWith(COMMAND);
    expect(client.domains.get()).toEqual(MAIL);

    answer = null;
    listeners.get("desktop-connections-changed")?.();
    await settle();
    expect(client.domains.get()).toBeNull();
    client.dispose();
    expect(listeners.size).toBe(0);
  });

  test("a provisional Electron window asks main nothing, and a host without a hello leaves domains unknown", async () => {
    const gateway = mock(async () => null);
    const api = {
      invoke: mock(() => Promise.resolve(null)),
      listen: () => () => {},
      nodes: { release: async () => {}, gateway },
    } as unknown as Api;
    const client = track(
      createWindowOrkestratorClient("provisional:command-node" as BackendId, () => api),
    );
    await settle();
    expect(gateway).not.toHaveBeenCalled();
    expect(client.domains.get()).toBeNull();
    expect(client.provenNodeId.get()).toBeNull();
  });
});
