import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  NODE_EVENT_WATCH_RENEW_MS,
  NODE_EVENT_WATCH_TTL_MS,
  RELAYED_NODE_EVENT,
} from "@orkestrator/protocol/node-events";
import { FakeIntervals } from "@orkestrator/protocol/testing/fake-intervals";
import { invoke } from "@/lib/native/backend";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { portalStore } from "@/lib/portal/portal-store";
import { resetNodeEventsForTests, subscribeNodeEvents } from "./node-events";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const listenMock = listen as unknown as ReturnType<typeof mock>;
const LEAF = "bk_leaf" as BackendId;
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
  stopped = 0;
  expiresAt = NODE_EVENT_WATCH_TTL_MS;
  portalStore.store.setState({ selfId: "bk_command" as BackendId });
  listenMock.mockReset();
  listenMock.mockImplementation(async (event: string, handler) => {
    if (failListen) throw new Error("listen failed");
    if (event === RELAYED_NODE_EVENT && listenGate) await listenGate;
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
      };
      expiresAt = result.expiresAt;
      return result;
    }
    return { removed: true };
  });
});
afterEach(() => {
  resetNodeEventsForTests();
  globalThis.setInterval = originalInterval;
  globalThis.clearInterval = originalClear;
  portalStore.store.setState({ selfId: null });
  listenMock.mockReset();
  listenMock.mockImplementation(async () => () => undefined);
  invokeMock.mockReset();
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
