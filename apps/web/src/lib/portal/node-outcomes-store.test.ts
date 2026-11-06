import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  NODE_OUTCOMES_CHANGED_EVENT,
  NODE_SUMMARY_CHANGED_EVENT,
} from "@orkestrator/protocol/node-summaries";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import {
  NODE_OUTCOMES_REFRESH_DEBOUNCE_MS,
  NodeOutcomesStore,
  type NodeOutcomeRecord,
} from "./portal-store";

type Handler = (event: { payload: unknown }) => void;

function fakeEvents() {
  const handlers = new Map<string, Set<Handler>>();
  const listen = mock(async (event: string, handler: Handler) => {
    const set = handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(event, set);
    return () => set.delete(handler);
  });
  const emit = (event: string, payload: unknown) => {
    for (const handler of Array.from(handlers.get(event) ?? [])) handler({ payload });
  };
  const count = (event: string) => handlers.get(event)?.size ?? 0;
  return { listen, emit, count };
}

const record = (nodeId: string, outcomeId: string): NodeOutcomeRecord => ({
  outcomeId,
  nodeId,
  command: "stop_environment",
  recordedAt: "2026-11-06T00:00:00.000Z",
});

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
let clock: ReturnType<typeof installControlledTimeout>;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  clock = installControlledTimeout(NODE_OUTCOMES_REFRESH_DEBOUNCE_MS, { maxPending: 2 });
});
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  clock.assertDrained();
  clock.restore();
});

function createStore(read: (nodeId: string) => Promise<NodeOutcomeRecord[]>) {
  const events = fakeEvents();
  const store = new NodeOutcomesStore(read, events.listen as never);
  return { store, events };
}

describe("NodeOutcomesStore", () => {
  test("many notices for one machine share one subscription and one read", async () => {
    const read = mock(async (nodeId: string) => [record(nodeId, "o-1")]);
    const { store, events } = createStore(read);
    const seen: NodeOutcomeRecord[][] = [];

    const stops = Array.from({ length: 3 }, () =>
      store.subscribe("node-a", (value) => seen.push(value)),
    );
    cleanups.push(...stops);
    await settle();

    expect(read).toHaveBeenCalledTimes(1);
    expect(events.count(NODE_SUMMARY_CHANGED_EVENT)).toBe(1);
    expect(seen).toHaveLength(3);
    for (const stop of stops) stop();
    expect(events.count(NODE_SUMMARY_CHANGED_EVENT)).toBe(0);
  });

  test("a change re-reads only the machine it names, once per debounce window", async () => {
    const read = mock(async (nodeId: string) => [record(nodeId, `o-${nodeId}`)]);
    const { store, events } = createStore(read);
    const stopA = store.subscribe("node-a", () => {});
    const stopB = store.subscribe("node-b", () => {});
    cleanups.push(stopA, stopB);
    await settle();
    read.mockClear();

    for (let index = 0; index < 5; index++) {
      events.emit(NODE_SUMMARY_CHANGED_EVENT, { nodeId: "node-a", epoch: 1 });
    }
    clock.advance();
    await settle();

    expect(read.mock.calls.map(([nodeId]) => nodeId)).toEqual(["node-a"]);
    stopA();
    stopB();
  });

  test("a change for a machine nobody shows costs nothing", async () => {
    const read = mock(async (_nodeId: string) => []);
    const { store, events } = createStore(read);
    const stop = store.subscribe("node-a", () => {});
    cleanups.push(stop);
    await settle();
    read.mockClear();

    events.emit(NODE_SUMMARY_CHANGED_EVENT, { nodeId: "node-z", epoch: 1 });
    clock.advance();
    await settle();

    expect(read).not.toHaveBeenCalled();
    stop();
  });

  test("a reconnected event stream re-reads every watched machine", async () => {
    const read = mock(async (_nodeId: string) => []);
    const { store, events } = createStore(read);
    const stopA = store.subscribe("node-a", () => {});
    const stopB = store.subscribe("node-b", () => {});
    cleanups.push(stopA, stopB);
    await settle();
    read.mockClear();

    events.emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT, {});
    clock.advance();
    await settle();

    expect(read.mock.calls.map(([nodeId]) => nodeId).sort()).toEqual(["node-a", "node-b"]);
    stopA();
    stopB();
  });

  test("refreshes requested during a read share one follow-up read", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const read = mock(async (nodeId: string) => {
      await gate;
      return [record(nodeId, "o-1")];
    });
    const { store } = createStore(read);
    const delivered = Promise.withResolvers<void>();
    let deliveries = 0;
    const stop = store.subscribe("node-a", () => {
      if (++deliveries === 2) delivered.resolve();
    });
    cleanups.push(stop);

    void store.refresh("node-a");
    void store.refresh("node-a");
    release();
    await delivered.promise;
    await settle();

    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });
  test("obsolete async registrations cannot join a replacement subscription", async () => {
    const { store, events } = createStore(async () => []);
    const first = store.subscribe("node-a", () => {});
    first();
    const second = store.subscribe("node-a", () => {});
    cleanups.push(second);
    await settle();
    for (const event of [
      NODE_SUMMARY_CHANGED_EVENT,
      NODE_OUTCOMES_CHANGED_EVENT,
      NATIVE_EVENT_STREAM_CONNECTED_EVENT,
    ]) {
      expect(events.count(event)).toBe(1);
    }
    second();
    for (const event of [
      NODE_SUMMARY_CHANGED_EVENT,
      NODE_OUTCOMES_CHANGED_EVENT,
      NATIVE_EVENT_STREAM_CONNECTED_EVENT,
    ]) {
      expect(events.count(event)).toBe(0);
    }
  });

  test("another window receives outcome records and dismissals without a summary change", async () => {
    let records: NodeOutcomeRecord[] = [];
    const events = fakeEvents();
    const first = new NodeOutcomesStore(async () => records, events.listen as never);
    const second = new NodeOutcomesStore(async () => records, events.listen as never);
    const seen: NodeOutcomeRecord[][] = [];
    cleanups.push(
      first.subscribe("node-a", () => {}),
      second.subscribe("node-a", (value) => seen.push(value)),
    );
    await settle();
    records = [record("node-a", "external")];
    events.emit(NODE_OUTCOMES_CHANGED_EVENT, { nodeId: "node-a" });
    clock.advance();
    await settle();
    expect(seen.at(-1)).toEqual(records);
    records = [];
    events.emit(NODE_OUTCOMES_CHANGED_EVENT, { nodeId: "node-a" });
    clock.advance();
    await settle();
    expect(seen.at(-1)).toEqual([]);
  });
});
