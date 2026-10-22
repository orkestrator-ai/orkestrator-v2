import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  CHANGE_PROJECTION_CHANGED_EVENT,
  type ChangeProjection,
  type ChangeProjectionEvent,
  type ChangeViewResult,
} from "@orkestrator/protocol/change-resources";
import { invoke } from "@/lib/native/backend";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { useChangeProjection } from "@/hooks/useChangeProjection";
import { useChangeProjectionStore } from "@/stores/changeProjectionStore";
import {
  environmentProjectionFixture,
  exactCount,
  resetChangeProjectionStore,
} from "@/components/files-panel/change-projection-test-fixture";
import {
  resetChangeSubscriptionsForTests,
  subscribeChangeResource,
  subscribeToolPresentation,
} from "./subscriptions";

// `@/lib/native/backend` and `@/lib/native/events` are mocked for every
// renderer test in tests/setup.ts.
const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const listenMock = listen as unknown as ReturnType<typeof mock>;

const KEY = "environment-net/environment/env-1/live";

interface ViewRequest {
  args: Record<string, unknown>;
  resolve: (result: ChangeViewResult) => void;
}

let callbacks: Map<string, (event: { payload: unknown }) => void>;
let order: string[];
let views: ViewRequest[];

function projection(revision: number, overrides: Partial<ChangeProjection> = {}) {
  return environmentProjectionFixture("env-1", {
    revision,
    measurementId: `m-${revision}`,
    counters: { additions: exactCount(revision), deletions: exactCount(0), changedFiles: 1 },
    ...overrides,
  });
}

function emit(payload: ChangeProjectionEvent) {
  callbacks.get(CHANGE_PROJECTION_CHANGED_EVENT)!({ payload });
}

function reconnect() {
  callbacks.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT)!({ payload: undefined });
}

async function settle() {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function held() {
  return useChangeProjectionStore.getState().projections.get(KEY);
}

describe("change projection subscriptions", () => {
  beforeEach(() => {
    resetChangeSubscriptionsForTests();
    resetChangeProjectionStore();
    callbacks = new Map();
    order = [];
    views = [];
    listenMock.mockReset();
    listenMock.mockImplementation(async (event: string, callback) => {
      order.push(`listen:${event}`);
      callbacks.set(event, callback);
      return () => callbacks.delete(event);
    });
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command !== "changes_get_view") throw new Error(`unexpected ${command}`);
      order.push(`read:${String(args.resourceKey)}`);
      return new Promise<ChangeViewResult>((resolve) => views.push({ args, resolve }));
    });
  });

  afterEach(async () => {
    // Answer anything still pending so no read outlives its test.
    for (const view of views)
      view.resolve({ kind: "unchanged", ownerGeneration: "x", revision: 0 });
    await settle();
    cleanup();
    listenMock.mockReset();
    listenMock.mockImplementation(() => Promise.resolve(() => undefined));
    invokeMock.mockReset();
  });

  test("V08: subscribes to events before reading the snapshot", async () => {
    const release = subscribeChangeResource(KEY);
    await settle();
    expect(order).toEqual([
      `listen:${NATIVE_EVENT_STREAM_CONNECTED_EVENT}`,
      `listen:${CHANGE_PROJECTION_CHANGED_EVENT}`,
      `read:${KEY}`,
    ]);
    // The first read is unconditional: the client holds nothing yet.
    expect(views[0]!.args).toEqual({ resourceKey: KEY });
    release();
  });

  test("V08: an event during the initial read is kept; the older snapshot does not overwrite it", async () => {
    const release = subscribeChangeResource(KEY);
    await settle();
    expect(views).toHaveLength(1);
    emit({ kind: "projection", projection: projection(3) });
    expect(held()?.revision).toBe(3);
    views[0]!.resolve({ kind: "projection", projection: projection(2) });
    await settle();
    expect(held()?.revision).toBe(3);
    expect(held()?.measurementId).toBe("m-3");
    release();
  });

  test("V08: a snapshot newer than an event during the read replaces it", async () => {
    const release = subscribeChangeResource(KEY);
    await settle();
    emit({ kind: "projection", projection: projection(3) });
    views[0]!.resolve({ kind: "projection", projection: projection(4) });
    await settle();
    expect(held()?.revision).toBe(4);
    release();
  });

  test("V08: a reconnect re-reads every registered resource conditionally", async () => {
    const other = "turn-net/turn/t1/live";
    const releases = [subscribeChangeResource(KEY), subscribeChangeResource(other)];
    await settle();
    views[0]!.resolve({ kind: "projection", projection: projection(5) });
    views[1]!.resolve({
      kind: "projection",
      projection: projection(1, { resourceKey: other }),
    });
    await settle();
    views.length = 0;

    // Events were missed while disconnected; the transport signals a resync.
    reconnect();
    await settle();
    expect(views.map((view) => view.args.resourceKey).sort()).toEqual([KEY, other].sort());
    const keyRead = views.find((view) => view.args.resourceKey === KEY)!;
    expect(keyRead.args).toEqual({ resourceKey: KEY, knownGeneration: "gen-1", knownRevision: 5 });
    keyRead.resolve({ kind: "projection", projection: projection(9) });
    await settle();
    expect(held()?.revision).toBe(9);
    for (const release of releases) release();
  });

  test("V08: a read started before a reconnect cannot overwrite the state read after it", async () => {
    const release = subscribeChangeResource(KEY);
    await settle();
    const stale = views[0]!;
    // The backend was replaced while the first read was in flight.
    reconnect();
    await settle();
    expect(views).toHaveLength(2);
    views[1]!.resolve({
      kind: "projection",
      projection: projection(1, { ownerGeneration: "gen-2" }),
    });
    await settle();
    expect(held()?.ownerGeneration).toBe("gen-2");
    // The pre-reconnect answer arrives last, from the old owner generation.
    stale.resolve({ kind: "projection", projection: projection(8, { ownerGeneration: "gen-1" }) });
    await settle();
    expect(held()?.ownerGeneration).toBe("gen-2");
    expect(held()?.revision).toBe(1);
    release();
  });

  test("V08: reset, deleted and content-invalidated events are applied", async () => {
    const release = subscribeChangeResource(KEY);
    await settle();
    views[0]!.resolve({ kind: "projection", projection: projection(2) });
    await settle();
    views.length = 0;

    emit({ kind: "reset", resourceKey: KEY, ownerGeneration: "gen-2" });
    await settle();
    expect(views).toHaveLength(1);
    views[0]!.resolve({
      kind: "reset",
      projection: projection(1, { ownerGeneration: "gen-2" }),
    });
    await settle();
    // A new owner generation replaces a higher revision of the old one.
    expect(held()).toMatchObject({ ownerGeneration: "gen-2", revision: 1 });

    emit({
      kind: "content-invalidated",
      resourceKey: KEY,
      ownerGeneration: "gen-2",
      contentGeneration: 4,
      pathIds: ["p:src/a.ts"],
    });
    expect(useChangeProjectionStore.getState().contentGenerations.get(KEY)).toEqual({
      generation: 4,
      ownerGeneration: "gen-2",
      pathIds: ["p:src/a.ts"],
    });

    emit({ kind: "deleted", resourceKey: KEY, ownerGeneration: "gen-2", revision: 2 });
    expect(held()).toBeUndefined();
    expect(useChangeProjectionStore.getState().deleted.has(KEY)).toBe(true);
    release();
  });

  test("events for resources nobody shows are ignored", async () => {
    const release = subscribeChangeResource(KEY);
    await settle();
    emit({
      kind: "projection",
      projection: projection(1, { resourceKey: "turn-net/turn/other/live" }),
    });
    expect(useChangeProjectionStore.getState().projections.has("turn-net/turn/other/live")).toBe(
      false,
    );
    release();
  });

  test("V02: unmounting every consumer releases interest; a later mount re-reads the current revision", async () => {
    const first = renderHook(() => useChangeProjection(KEY));
    const second = renderHook(() => useChangeProjection(KEY));
    await act(settle);
    // One shared read for both consumers.
    expect(views).toHaveLength(1);
    await act(async () => {
      views[0]!.resolve({ kind: "projection", projection: projection(2) });
      await settle();
    });
    expect(first.result.current?.revision).toBe(2);
    expect(second.result.current?.measurementId).toBe("m-2");

    first.unmount();
    // One consumer still shows it: events keep applying.
    act(() => emit({ kind: "projection", projection: projection(3) }));
    expect(held()?.revision).toBe(3);
    second.unmount();
    // Nobody shows it now; the client does not keep tracking it.
    emit({ kind: "projection", projection: projection(4) });
    expect(held()?.revision).toBe(3);
    views.length = 0;

    // The backend kept measuring meanwhile; remounting re-reads from the
    // revision the client last held and shows the backend's current one.
    const again = renderHook(() => useChangeProjection(KEY));
    await act(settle);
    expect(views).toHaveLength(1);
    expect(views[0]!.args).toEqual({
      resourceKey: KEY,
      knownGeneration: "gen-1",
      knownRevision: 3,
    });
    await act(async () => {
      views[0]!.resolve({ kind: "projection", projection: projection(6) });
      await settle();
    });
    expect(again.result.current?.revision).toBe(6);
    expect(again.result.current?.measurementId).toBe("m-6");
    again.unmount();
  });

  test("a failed read leaves the last projection in place for the next resync", async () => {
    const release = subscribeChangeResource(KEY);
    await settle();
    views[0]!.resolve({ kind: "projection", projection: projection(2) });
    await settle();
    invokeMock.mockImplementation(() => Promise.reject(new Error("transport down")));
    reconnect();
    await settle();
    expect(held()?.revision).toBe(2);
    release();
  });
  test("owner replacement resets content counters and retires late owners", async () => {
    const release = subscribeChangeResource(KEY);
    await settle();
    const store = useChangeProjectionStore.getState();
    store.applyProjection(projection(1, { ownerGeneration: "A" }));
    emit({
      kind: "content-invalidated",
      resourceKey: KEY,
      ownerGeneration: "A",
      contentGeneration: 100,
      pathIds: null,
    });
    store.applyProjection(projection(1, { ownerGeneration: "B" }));
    emit({
      kind: "content-invalidated",
      resourceKey: KEY,
      ownerGeneration: "B",
      contentGeneration: 1,
      pathIds: ["u:b"],
    });
    emit({
      kind: "content-invalidated",
      resourceKey: KEY,
      ownerGeneration: "A",
      contentGeneration: 101,
      pathIds: ["u:a"],
    });
    expect(useChangeProjectionStore.getState().contentGenerations.get(KEY)).toEqual({
      generation: 1,
      ownerGeneration: "B",
      pathIds: ["u:b"],
    });
    release();
  });

  test("a null tool presentation reconciles after delayed evidence and again on reconnect", async () => {
    let available = false,
      reads = 0;
    const scope = { environmentId: "env-1", provider: "codex", conversationId: "s" };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "changes_get_tool_presentations") {
        reads++;
        return {
          presentations: {
            call: available
              ? {
                  schemaVersion: 1,
                  operationId: "op",
                  revision: reads,
                  toolKind: "file-edit",
                  changes: [{ role: "effect", resourceKey: KEY, prominence: "primary" }],
                }
              : null,
          },
          projections: {},
        };
      }
      return { kind: "unchanged", ownerGeneration: "gen-1", revision: 0 };
    });
    const release = subscribeToolPresentation(scope, "call");
    await settle();
    const key = "env-1\0codex\0s\0call";
    expect(useChangeProjectionStore.getState().toolPresentations.get(key)).toBeNull();
    available = true;
    // Nobody has resource interest yet: only the tool row is mounted.
    emit({ kind: "projection", projection: projection(2) });
    await settle();
    expect(useChangeProjectionStore.getState().toolPresentations.get(key)?.changes).toHaveLength(1);
    const before = reads;
    reconnect();
    await settle();
    expect(reads).toBeGreaterThan(before);
    release();
    const after = reads;
    emit({ kind: "projection", projection: projection(3) });
    await settle();
    expect(reads).toBe(after);
  });
});
