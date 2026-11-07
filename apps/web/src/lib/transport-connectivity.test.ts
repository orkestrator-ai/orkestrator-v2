import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LOCAL_CONNECTION_ID, type ConnectionList } from "@orkestrator/protocol/connections";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { readCoordinatorFor, resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  installFakeReadCoordinator,
  type FakeReadEnvironment,
} from "@/lib/testing/read-coordinator";
import type { GatewayEventStreamConnectionState } from "@/lib/native/web-gateway";
import {
  connectionListDisconnected,
  getNodeConnectivity,
  getTransportConnectivity,
  resetTransportConnectivityForTests,
  setTransportDisconnected,
  startTransportConnectivity,
  subscribeTransportConnectivity,
} from "./transport-connectivity";

let reads: FakeReadEnvironment;
let clock = 1_000;

beforeEach(() => {
  reads = installFakeReadCoordinator();
  clock = 1_000;
  resetTransportConnectivityForTests(() => clock);
});

afterEach(() => {
  resetTransportConnectivityForTests();
  resetReadCoordinatorForTests();
});

function fakeStream(initial: GatewayEventStreamConnectionState) {
  let state = initial;
  const listeners = new Set<(state: GatewayEventStreamConnectionState) => void>();
  return {
    eventStreamConnection: {
      state: () => state,
      subscribe(listener: (state: GatewayEventStreamConnectionState) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    set(next: GatewayEventStreamConnectionState) {
      state = next;
      for (const listener of listeners) listener(next);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

describe("transport connectivity", () => {
  test("pauses the read coordinator while any owner reports an outage", () => {
    setTransportDisconnected("gateway-event-stream", true);
    expect(reads.coordinator.getDiagnostics().disconnected).toBe(true);
    expect(getTransportConnectivity()).toEqual({ disconnected: true, since: 1_000 });

    clock = 2_000;
    setTransportDisconnected("desktop-connection", true);
    // The outage began with the first owner.
    expect(getTransportConnectivity()).toEqual({ disconnected: true, since: 1_000 });

    setTransportDisconnected("gateway-event-stream", false);
    expect(reads.coordinator.getDiagnostics().disconnected).toBe(true);
    expect(getTransportConnectivity()).toEqual({ disconnected: true, since: 2_000 });

    setTransportDisconnected("desktop-connection", false);
    expect(reads.coordinator.getDiagnostics().disconnected).toBe(false);
    expect(getTransportConnectivity()).toEqual({ disconnected: false, since: null });
  });

  test("a repeated report neither restarts the outage nor notifies", () => {
    let notifications = 0;
    const unsubscribe = subscribeTransportConnectivity(() => {
      notifications += 1;
    });
    setTransportDisconnected("gateway-event-stream", true);
    clock = 5_000;
    setTransportDisconnected("gateway-event-stream", true);
    setTransportDisconnected("desktop-connection", false);
    expect(notifications).toBe(1);
    expect(getTransportConnectivity().since).toBe(1_000);
    unsubscribe();
  });

  test("follows the gateway main stream and forgets it when stopped", () => {
    const stream = fakeStream("connecting");
    const stop = startTransportConnectivity(stream);
    expect(getTransportConnectivity().disconnected).toBe(false);

    stream.set("connected");
    stream.set("disconnected");
    expect(getTransportConnectivity().disconnected).toBe(true);
    expect(reads.coordinator.getDiagnostics().disconnected).toBe(true);

    stream.set("connected");
    expect(getTransportConnectivity().disconnected).toBe(false);

    stream.set("disconnected");
    stop();
    expect(stream.listenerCount).toBe(0);
    expect(getTransportConnectivity().disconnected).toBe(false);
  });

  test("adopts a stream that is already down when it starts", () => {
    const stop = startTransportConnectivity(fakeStream("disconnected"));
    expect(getTransportConnectivity().disconnected).toBe(true);
    stop();
  });

  test("a transport without a connection signal reports nothing", () => {
    const stop = startTransportConnectivity({});
    expect(getTransportConnectivity().disconnected).toBe(false);
    stop();
  });
});

describe("per node and the window aggregate", () => {
  afterEach(() => resetWindowScopeForTests());

  test("a leaf's outage is its own, and the window aggregate shows it", () => {
    const client = new FakeNodeClient({ nodeId: "bk_leaf" as BackendId });
    const leaf = getWindowScope().open({ role: "leaf", client });
    const command = getWindowScope().commandScope();
    let notifications = 0;
    const unsubscribe = subscribeTransportConnectivity(() => {
      notifications += 1;
    });

    const stop = startTransportConnectivity(undefined, leaf);
    client.connection.set("connecting");
    expect(getNodeConnectivity(leaf).disconnected).toBe(false);
    client.connection.set("lapsed");
    expect(getNodeConnectivity(leaf)).toEqual({ disconnected: true, since: 1_000 });
    expect(getNodeConnectivity(command).disconnected).toBe(false);
    expect(readCoordinatorFor(leaf).getDiagnostics().disconnected).toBe(true);
    // The command scope's (fake) coordinator keeps reading.
    expect(reads.coordinator.getDiagnostics().disconnected).toBe(false);
    expect(getTransportConnectivity()).toEqual({ disconnected: true, since: 1_000 });

    clock = 3_000;
    setTransportDisconnected("desktop-connection", true);
    // The aggregate's outage began with the earliest node's.
    expect(getTransportConnectivity()).toEqual({ disconnected: true, since: 1_000 });
    expect(notifications).toBe(1);

    // A closing node no longer counts.
    leaf.dispose();
    expect(getTransportConnectivity()).toEqual({ disconnected: true, since: 3_000 });
    setTransportDisconnected("desktop-connection", false);
    expect(getTransportConnectivity()).toEqual({ disconnected: false, since: null });
    expect(notifications).toBe(3);
    stop();
    unsubscribe();
  });
});

describe("connectionListDisconnected", () => {
  const list = (overrides: Partial<ConnectionList>): ConnectionList => ({
    activeConnectionId: LOCAL_CONNECTION_ID,
    connections: [],
    ...overrides,
  });

  test("Local is down only once the desktop reports it unavailable", () => {
    expect(connectionListDisconnected(list({}))).toBe(false);
    expect(connectionListDisconnected(list({ localAvailable: true }))).toBe(false);
    expect(connectionListDisconnected(list({ localAvailable: false }))).toBe(true);
  });

  test("a remote is down while reconnecting or unreachable, not while connecting", () => {
    const remote = (transport: NonNullable<ConnectionList["connections"][number]["transport"]>) =>
      list({
        activeConnectionId: "remote-1",
        // A stopped Local does not make the active remote unreachable.
        localAvailable: false,
        connections: [
          {
            id: "remote-1",
            name: "studio",
            address: "studio.tailnet.ts.net",
            kind: "remote",
            active: true,
            requiresToken: true,
            transport,
          } as ConnectionList["connections"][number],
        ],
      });
    expect(connectionListDisconnected(remote("connected"))).toBe(false);
    expect(connectionListDisconnected(remote("connecting"))).toBe(false);
    expect(connectionListDisconnected(remote("authentication-required"))).toBe(false);
    expect(connectionListDisconnected(remote("reconnecting"))).toBe(true);
    expect(connectionListDisconnected(remote("unreachable"))).toBe(true);
  });
});
