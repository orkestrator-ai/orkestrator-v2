import { createElement } from "react";
import { render, cleanup } from "@testing-library/react";
import { CoordinatorAccountSwitchNotices } from "@/components/federation/CoordinatorAccountSwitchNotices";
import { mockToastInfo } from "../../../../../tests/mocks/sonner";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  NODE_EVENT_WATCH_RENEW_MS,
  NODE_EVENT_WATCH_TTL_MS,
  RELAYED_NODE_EVENT,
  relayedNodeEventName,
} from "@orkestrator/protocol/node-events";
import { FakeIntervals } from "@orkestrator/protocol/testing/fake-intervals";
import { invoke } from "@/lib/native/backend";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { portalStore } from "@/lib/portal/portal-store";
import { resetNodeEventsForTests, subscribeNodeEvents } from "./node-events";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const listenMock = listen as unknown as ReturnType<typeof mock>;
const LEAF = "bk_leaf" as BackendId;
const PER_NODE_EVENT = relayedNodeEventName(LEAF);
let perNodeListenGate: Promise<void> | null = null;
const originalInterval = globalThis.setInterval;
const originalClear = globalThis.clearInterval;
let clock: FakeIntervals;
let handlers: Map<string, Set<(event: { payload: unknown }) => void>>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let watchGate: Promise<void> | null;
let listenGate: Promise<void> | null;
let failListen: boolean;
let failWatch: boolean;
let renewed: boolean;
let perNodeEvents: boolean;
let listenOrder: string[];
let expiresAt: number;
let stopped: number;

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function subscriber(events = ["change-projection-changed"]) {
  return { events, onEvent: mock(() => undefined), onResync: mock(() => undefined) };
}
function emit(event: string, payload?: unknown) {
  for (const handler of handlers.get(event) ?? []) handler({ payload });
}

beforeEach(() => {
  resetNodeEventsForTests();
  mockToastInfo.mockClear();
  clock = new FakeIntervals();
  globalThis.setInterval = clock.setInterval.bind(clock) as typeof setInterval;
  globalThis.clearInterval = clock.clearInterval.bind(clock) as typeof clearInterval;
  handlers = new Map();
  calls = [];
  watchGate = null;
  listenGate = null;
  failListen = false;
  failWatch = false;
  renewed = true;
  perNodeEvents = false;
  listenOrder = [];
  stopped = 0;
  expiresAt = NODE_EVENT_WATCH_TTL_MS;
  portalStore.store.setState({ selfId: "bk_command" as BackendId });
  listenMock.mockReset();
  listenMock.mockImplementation(async (event: string, handler) => {
    if (failListen) throw new Error("listen failed");
    if (event === RELAYED_NODE_EVENT && listenGate) await listenGate;
    if (event === PER_NODE_EVENT && perNodeListenGate) await perNodeListenGate;
    listenOrder.push(event);
    const set = handlers.get(event) ?? new Set();
    set.add(handler);
    handlers.set(event, set);
    return () => {
      stopped++;
      set.delete(handler);
    };
  });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "watch_node_events") {
      if (watchGate) await watchGate;
      if (failWatch) throw new Error("watch failed");
      const result = {
        watchId: args.watchId,
        expiresAt: clock.now + NODE_EVENT_WATCH_TTL_MS,
        renewed: renewed && clock.now < expiresAt,
        ...(perNodeEvents ? { perNodeEvents: true } : {}),
      };
      expiresAt = result.expiresAt;
      return result;
    }
    return { removed: true };
  });
});
afterEach(() => {
  cleanup();
  resetNodeEventsForTests();
  globalThis.setInterval = originalInterval;
  globalThis.clearInterval = originalClear;
  portalStore.store.setState({ selfId: null });
  listenMock.mockReset();
  listenMock.mockImplementation(async () => () => undefined);
  invokeMock.mockReset();
});

test("listens on the node's own name when the command node relays that way", async () => {
  perNodeEvents = true;
  const sub = subscriber();
  const stop = subscribeNodeEvents(LEAF, sub);
  await settle();
  expect(listenOrder).toContain(PER_NODE_EVENT);
  expect(sub.onResync).toHaveBeenCalledTimes(1);

  emit(PER_NODE_EVENT, {
    nodeId: LEAF,
    kind: "event",
    event: "change-projection-changed",
    payload: 7,
  });
  expect(sub.onEvent).toHaveBeenCalledWith("change-projection-changed", 7);
  emit(PER_NODE_EVENT, { nodeId: LEAF, kind: "resync" });
  expect(sub.onResync).toHaveBeenCalledTimes(2);

  // A renewal does not add a second listener, and releasing removes it.
  clock.tick(NODE_EVENT_WATCH_RENEW_MS);
  await settle();
  expect(listenOrder.filter((event) => event === PER_NODE_EVENT)).toHaveLength(1);
  stop();
  await settle();
  expect(handlers.get(PER_NODE_EVENT)?.size).toBe(0);
});

test("the first read waits for the per-node stream, and a release during it leaves nothing", async () => {
  perNodeEvents = true;
  let open!: () => void;
  perNodeListenGate = new Promise<void>((done) => {
    open = done;
  });
  const sub = subscriber();
  const stop = subscribeNodeEvents(LEAF, sub);
  await settle();
  expect(calls.some((call) => call.command === "watch_node_events")).toBe(true);
  expect(sub.onResync).not.toHaveBeenCalled();
  open();
  perNodeListenGate = null;
  await settle();
  expect(sub.onResync).toHaveBeenCalledTimes(1);
  stop();
  await settle();

  perNodeListenGate = new Promise<void>((done) => {
    open = done;
  });
  const late = subscriber();
  const release = subscribeNodeEvents(LEAF, late);
  await settle();
  release();
  await settle();
  open();
  perNodeListenGate = null;
  await settle();
  expect(late.onResync).not.toHaveBeenCalled();
  expect(handlers.get(PER_NODE_EVENT)?.size).toBe(0);
});

test("an older command node relays on the old name, and no per-node listener opens", async () => {
  const sub = subscriber();
  const stop = subscribeNodeEvents(LEAF, sub);
  await settle();
  expect(listenOrder).not.toContain(PER_NODE_EVENT);
  emit(RELAYED_NODE_EVENT, {
    nodeId: LEAF,
    kind: "event",
    event: "change-projection-changed",
    payload: 1,
  });
  expect(sub.onEvent).toHaveBeenCalledWith("change-projection-changed", 1);
  emit(RELAYED_NODE_EVENT, { nodeId: LEAF, kind: "resync" });
  expect(sub.onResync).toHaveBeenCalledTimes(2);
  stop();
  await settle();
});

test("frames on the old name still arrive with a per-node command node, for the desktop relay", async () => {
  perNodeEvents = true;
  const sub = subscriber();
  const stop = subscribeNodeEvents(LEAF, sub);
  await settle();
  emit(RELAYED_NODE_EVENT, {
    nodeId: LEAF,
    kind: "event",
    event: "change-projection-changed",
    payload: 2,
  });
  expect(sub.onEvent).toHaveBeenCalledTimes(1);
  stop();
  await settle();
});

test("a command node downgraded under the lease drops the per-node listener", async () => {
  perNodeEvents = true;
  const sub = subscriber();
  const stop = subscribeNodeEvents(LEAF, sub);
  await settle();
  expect(handlers.get(PER_NODE_EVENT)?.size).toBe(1);
  perNodeEvents = false;
  clock.tick(NODE_EVENT_WATCH_RENEW_MS);
  await settle();
  expect(handlers.get(PER_NODE_EVENT)?.size).toBe(0);
  stop();
  await settle();
});

test("renews the same lease before expiry; an expired lease resyncs every subscriber", async () => {
  const first = subscriber();
  const second = subscriber();
  const stop = subscribeNodeEvents(LEAF, first);
  const stop2 = subscribeNodeEvents(LEAF, second);
  await settle();
  expect(first.onResync).toHaveBeenCalledTimes(1);
  clock.tick(NODE_EVENT_WATCH_RENEW_MS - 1);
  await settle();
  expect(calls).toHaveLength(1);
  clock.tick(1);
  await settle();
  expect(calls[1]!.args.watchId).toBe(calls[0]!.args.watchId);
  expect(first.onResync).toHaveBeenCalledTimes(1);
  expiresAt = clock.now;
  clock.tick(NODE_EVENT_WATCH_RENEW_MS);
  await settle();
  expect(first.onResync).toHaveBeenCalledTimes(2);
  expect(second.onResync).toHaveBeenCalledTimes(2);
  stop();
  stop2();
  await settle();
  expect(clock.periods()).toEqual([]);
});

test("prefix changes during watch setup wait for the confirmed union", async () => {
  let resolve!: () => void;
  watchGate = new Promise<void>((done) => {
    resolve = done;
  });
  const first = subscriber(["a-"]);
  const stop = subscribeNodeEvents(LEAF, first);
  await settle();
  const second = subscriber(["b-"]);
  const stop2 = subscribeNodeEvents(LEAF, second);
  expect(second.onResync).not.toHaveBeenCalled();
  let resolveUnion!: () => void;
  watchGate = new Promise<void>((done) => {
    resolveUnion = done;
  });
  resolve();
  await settle();
  expect(
    calls.filter((call) => call.command === "watch_node_events").map((call) => call.args.prefixes),
  ).toEqual([["a-"], ["a-", "b-"]]);
  expect(first.onResync).toHaveBeenCalledTimes(1);
  expect(second.onResync).not.toHaveBeenCalled();
  resolveUnion();
  await settle();
  expect(second.onResync).toHaveBeenCalledTimes(1);
  emit(RELAYED_NODE_EVENT, { nodeId: LEAF, kind: "event", event: "b-", payload: 1 });
  expect(second.onEvent).toHaveBeenCalledWith("b-", 1);
  expect(first.onEvent).not.toHaveBeenCalled();
  stop2();
  await settle();
  expect(calls.at(-1)!.args.prefixes).toEqual(["a-"]);
  stop();
  await settle();
});

for (const failure of ["listen", "watch"] as const)
  test(`retries failed ${failure} setup on renewal`, async () => {
    failListen = failure === "listen";
    failWatch = failure === "watch";
    const sub = subscriber();
    const stop = subscribeNodeEvents(LEAF, sub);
    await settle();
    expect(sub.onResync).toHaveBeenCalledTimes(1);
    failListen = false;
    failWatch = false;
    renewed = false;
    clock.tick(NODE_EVENT_WATCH_RENEW_MS);
    await settle();
    expect(calls.some((call) => call.command === "watch_node_events")).toBe(true);
    expect(sub.onResync).toHaveBeenCalledTimes(2);
    stop();
    await settle();
  });

for (const stage of ["listen", "watch", "renewal"] as const)
  test(`last release cleans up pending ${stage}`, async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    if (stage === "listen") listenGate = gate;
    if (stage === "watch") watchGate = gate;
    const sub = subscriber();
    const stop = subscribeNodeEvents(LEAF, sub);
    await settle();
    if (stage === "renewal") {
      watchGate = gate;
      clock.tick(NODE_EVENT_WATCH_RENEW_MS);
      await settle();
    }
    const before = sub.onResync.mock.calls.length;
    stop();
    await settle();
    resolve();
    await settle();
    expect(sub.onResync).toHaveBeenCalledTimes(before);
    expect(clock.periods()).toEqual([]);
    if (stage === "listen")
      expect(calls.filter((call) => call.command === "watch_node_events")).toHaveLength(0);
    else expect(calls.at(-1)!.command).toBe("unwatch_node_events");
  });

test("self resync waits for every event listener and cleanup fences late setup", async () => {
  portalStore.store.setState({ selfId: LEAF });
  let resolve!: () => void;
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  const original = listenMock.getMockImplementation()!;
  listenMock.mockImplementation(async (event: string, handler) => {
    if (event === "b-") await gate;
    return original(event, handler);
  });
  const sub = subscriber(["a-", "b-"]);
  const stop = subscribeNodeEvents(LEAF, sub);
  await settle();
  emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT);
  await settle();
  expect(sub.onResync).not.toHaveBeenCalled();
  resolve();
  await settle();
  expect(sub.onResync).toHaveBeenCalledTimes(1);
  emit("b-", 2);
  expect(sub.onEvent).toHaveBeenCalledWith("b-", 2);
  emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT);
  await settle();
  expect(sub.onResync).toHaveBeenCalledTimes(2);
  stop();
  expect(stopped).toBe(4);
  const late = subscriber(["a-"]);
  const release = subscribeNodeEvents(LEAF, late);
  release();
  await settle();
  expect(late.onResync).not.toHaveBeenCalled();
  expect(stopped).toBe(6);
});

test("a command reconnect during watch setup cannot confirm the old lease", async () => {
  let resolve!: () => void;
  watchGate = new Promise<void>((done) => {
    resolve = done;
  });
  const sub = subscriber();
  const stop = subscribeNodeEvents(LEAF, sub);
  await settle();
  emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT);
  await settle();
  resolve();
  await settle();
  expect(calls.filter((call) => call.command === "watch_node_events")).toHaveLength(2);
  expect(sub.onResync).toHaveBeenCalledTimes(1);
  stop();
  await settle();
});

test("leaf account-switch envelopes reach one toast through the command node", async () => {
  portalStore.store.setState({ nodes: [{ nodeId: LEAF }] as never });
  const view = render(createElement(CoordinatorAccountSwitchNotices));
  await settle();
  expect(calls.find((call) => call.command === "watch_node_events")?.args.prefixes).toEqual([
    "coordinator-account-switched",
  ]);
  emit(RELAYED_NODE_EVENT, {
    nodeId: LEAF,
    kind: "event",
    event: "coordinator-account-switched",
    payload: {
      requestId: "leaf-switch",
      nodeName: "Leaf",
      coordinatorName: "Leaf coordinator",
      toAccountLabel: "Spare",
      state: "executed",
      platform: "claude",
    },
  });
  expect(mockToastInfo).toHaveBeenCalledTimes(1);
  expect(mockToastInfo.mock.calls[0]?.[1]).toMatchObject({
    id: "coordinator-account-switch:bk_leaf:leaf-switch",
    description: "The Leaf coordinator switched the active Claude account on Leaf to “Spare”.",
  });
  view.unmount();
  await settle();
  expect(calls.at(-1)?.command).toBe("unwatch_node_events");
  portalStore.store.setState({ nodes: [] });
});
