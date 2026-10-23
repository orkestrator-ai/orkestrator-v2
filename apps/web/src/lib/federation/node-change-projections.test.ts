import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  CHANGE_PROJECTION_CHANGED_EVENT,
  environmentChangeResourceKey,
  type ChangeProjection,
} from "@orkestrator/protocol/change-resources";
import type { BackendId, EnvironmentRef } from "@orkestrator/protocol/federation";
import { RELAYED_NODE_EVENT, type RelayedNodeEvent } from "@orkestrator/protocol/node-events";
import { invoke } from "@/lib/native/backend";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import {
  environmentProjectionFixture,
  exactCount,
} from "@/components/files-panel/change-projection-test-fixture";
import {
  nodeChangeProjectionStore,
  resetNodeChangeProjectionsForTests,
  subscribeNodeChangeResource,
  useNodeEnvironmentChangeProjection,
} from "./node-change-projections";
import { resetNodeEventsForTests } from "./node-events";

// `@/lib/native/backend` and `@/lib/native/events` are mocked for every
// renderer test in tests/setup.ts; with no portal bridge the portal channel
// uses them.
const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const listenMock = listen as unknown as ReturnType<typeof mock>;

const LEAF = "bk_leaf" as BackendId;
const KEY = environmentChangeResourceKey("env-1");

let callbacks: Map<string, (event: { payload: unknown }) => void>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let order: string[];
let views: Map<string, ChangeProjection>;
let renewed: boolean;

function projection(revision: number, environmentId = "env-1"): ChangeProjection {
  return environmentProjectionFixture(environmentId, {
    revision,
    measurementId: `m-${revision}`,
    counters: { additions: exactCount(revision), deletions: exactCount(0), changedFiles: 1 },
  });
}

function relay(frame: RelayedNodeEvent) {
  callbacks.get(RELAYED_NODE_EVENT)!({ payload: frame });
}

function held(nodeId: BackendId = LEAF, resourceKey = KEY) {
  return nodeChangeProjectionStore.getState().projections.get(`${nodeId}\0${resourceKey}`);
}

function reads() {
  return calls.filter(
    (call) => call.command === "invoke_on_node" && call.args.command === "changes_get_view",
  );
}

async function settle() {
  for (let index = 0; index < 8; index++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("another node's change projections", () => {
  beforeEach(() => {
    resetNodeChangeProjectionsForTests();
    resetNodeEventsForTests();
    callbacks = new Map();
    calls = [];
    order = [];
    views = new Map([[KEY, projection(1)]]);
    renewed = false;
    listenMock.mockReset();
    listenMock.mockImplementation(async (event: string, callback) => {
      order.push(`listen:${event}`);
      callbacks.set(event, callback);
      return () => callbacks.delete(event);
    });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "watch_node_events") {
        order.push(`watch:${(args.prefixes as string[]).join(",")}`);
        return { watchId: args.watchId, expiresAt: 0, renewed };
      }
      if (command === "unwatch_node_events") return { removed: true };
      if (command === "invoke_on_node") {
        const inner = args.args as Record<string, unknown>;
        order.push(`read:${String(inner.resourceKey)}`);
        const view = views.get(String(inner.resourceKey));
        return {
          outcome: "ok",
          result: view ? { kind: "projection", projection: view } : { kind: "deleted" },
        };
      }
      throw new Error(`unexpected ${command}`);
    });
  });

  afterEach(async () => {
    resetNodeChangeProjectionsForTests();
    resetNodeEventsForTests();
    await settle();
    cleanup();
    listenMock.mockReset();
    listenMock.mockImplementation(() => Promise.resolve(() => undefined));
    invokeMock.mockReset();
  });

  test("subscribes and leases the node's events before the first read", async () => {
    const release = subscribeNodeChangeResource(LEAF, KEY);
    await settle();
    expect(order).toEqual([
      `listen:${NATIVE_EVENT_STREAM_CONNECTED_EVENT}`,
      `listen:${RELAYED_NODE_EVENT}`,
      `watch:${CHANGE_PROJECTION_CHANGED_EVENT}`,
      `read:${KEY}`,
    ]);
    expect(reads()[0]!.args).toEqual({
      nodeId: LEAF,
      command: "changes_get_view",
      args: { resourceKey: KEY },
      requestKey: expect.any(String),
    });
    expect(held()?.revision).toBe(1);
    release();
  });

  test("applies the node's relayed projections; other nodes' are ignored", async () => {
    const release = subscribeNodeChangeResource(LEAF, KEY);
    await settle();
    relay({
      nodeId: LEAF,
      kind: "event",
      event: CHANGE_PROJECTION_CHANGED_EVENT,
      payload: { kind: "projection", projection: projection(4) },
    });
    expect(held()?.revision).toBe(4);
    relay({
      nodeId: "bk_other" as BackendId,
      kind: "event",
      event: CHANGE_PROJECTION_CHANGED_EVENT,
      payload: { kind: "projection", projection: projection(9) },
    });
    expect(held()?.revision).toBe(4);
    // An older revision of the same owner never replaces a newer one.
    relay({
      nodeId: LEAF,
      kind: "event",
      event: CHANGE_PROJECTION_CHANGED_EVENT,
      payload: { kind: "projection", projection: projection(2) },
    });
    expect(held()?.revision).toBe(4);
    release();
  });

  test("a relayed resync re-reads conditionally", async () => {
    const release = subscribeNodeChangeResource(LEAF, KEY);
    await settle();
    views.set(KEY, projection(6));
    relay({ nodeId: LEAF, kind: "resync" });
    await settle();
    expect(reads()).toHaveLength(2);
    expect(reads()[1]!.args.args).toEqual({
      resourceKey: KEY,
      knownGeneration: projection(1).ownerGeneration,
      knownRevision: 1,
    });
    expect(held()?.revision).toBe(6);
    release();
  });

  test("one lease per node; the last release drops it and the held projection", async () => {
    const other = environmentChangeResourceKey("env-2");
    views.set(other, projection(3, "env-2"));
    const releaseFirst = subscribeNodeChangeResource(LEAF, KEY);
    const releaseSecond = subscribeNodeChangeResource(LEAF, other);
    await settle();
    expect(calls.filter((call) => call.command === "watch_node_events")).toHaveLength(1);
    expect(held(LEAF, other)?.revision).toBe(3);

    releaseFirst();
    expect(held()).toBeUndefined();
    expect(calls.some((call) => call.command === "unwatch_node_events")).toBe(false);
    releaseSecond();
    await settle();
    expect(calls.filter((call) => call.command === "unwatch_node_events")).toHaveLength(1);
    expect(held(LEAF, other)).toBeUndefined();
  });

  test("the command node's stream reconnecting re-leases and re-reads", async () => {
    const release = subscribeNodeChangeResource(LEAF, KEY);
    await settle();
    views.set(KEY, projection(7));
    callbacks.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT)!({ payload: undefined });
    await settle();
    expect(calls.filter((call) => call.command === "watch_node_events")).toHaveLength(2);
    expect(held()?.revision).toBe(7);
    release();
  });

  test("an older command node without the relay still gets one read", async () => {
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "watch_node_events") throw new Error("Unknown command: watch_node_events");
      return { outcome: "ok", result: { kind: "projection", projection: projection(2) } };
    });
    const release = subscribeNodeChangeResource(LEAF, KEY);
    await settle();
    expect(held()?.revision).toBe(2);
    release();
  });

  test("the row hook shows the environment's projection while mounted", async () => {
    const ref = { backendId: LEAF, environmentId: "env-1" } as EnvironmentRef;
    const { result, unmount } = renderHook(() => useNodeEnvironmentChangeProjection(ref));
    await act(settle);
    expect(result.current?.revision).toBe(1);
    unmount();
    expect(held()).toBeUndefined();
  });
  function deferredReads() {
    const pending: Array<{ resourceKey: string; resolve: (result: unknown) => void }> = [];
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command !== "invoke_on_node") return original(command, args);
      calls.push({ command, args });
      return new Promise((resolve) =>
        pending.push({
          resourceKey: String((args.args as Record<string, unknown>).resourceKey),
          resolve: (result) => resolve({ outcome: "ok", result }),
        }),
      );
    });
    return pending;
  }

  for (const kind of ["projection", "deleted", "generation"] as const) {
    test(`live ${kind} supersedes an older pending snapshot`, async () => {
      const pending = deferredReads();
      const release = subscribeNodeChangeResource(LEAF, KEY);
      await settle();
      const next = {
        ...projection(2),
        ...(kind === "generation" ? { ownerGeneration: "new-owner" } : {}),
      };
      relay({
        nodeId: LEAF,
        kind: "event",
        event: CHANGE_PROJECTION_CHANGED_EVENT,
        payload:
          kind === "deleted"
            ? { kind: "deleted", resourceKey: KEY, ownerGeneration: "gen-1", revision: 2 }
            : { kind: "projection", projection: next },
      });
      pending[0]!.resolve(
        kind === "projection"
          ? { kind: "deleted" }
          : { kind: "projection", projection: projection(100) },
      );
      await settle();
      expect(held()).toEqual(kind === "deleted" ? undefined : next);
      release();
    });
  }

  test("release and resubscribe fences both resource and node interest identities", async () => {
    const pending = deferredReads();
    const keep = subscribeNodeChangeResource(LEAF, environmentChangeResourceKey("keep"));
    const first = subscribeNodeChangeResource(LEAF, KEY);
    await settle();
    first();
    const second = subscribeNodeChangeResource(LEAF, KEY);
    pending
      .find((item) => item.resourceKey === KEY)!
      .resolve({ kind: "projection", projection: projection(99) });
    pending.find((item) => item.resourceKey !== KEY)!.resolve({ kind: "deleted" });
    await settle();
    expect(held()).toBeUndefined();
    pending.at(-1)!.resolve({ kind: "projection", projection: projection(2) });
    await settle();
    expect(held()?.revision).toBe(2);
    second();
    keep();
    const third = subscribeNodeChangeResource(LEAF, KEY);
    await settle();
    third();
    const fourth = subscribeNodeChangeResource(LEAF, KEY);
    await settle();
    pending.at(-1)!.resolve({ kind: "projection", projection: projection(99) });
    await settle();
    expect(held()).toBeUndefined();
    pending.at(-1)!.resolve({ kind: "projection", projection: projection(3) });
    await settle();
    expect(held()?.revision).toBe(3);
    fourth();
  });

  test("resync fences pending reads and coalesces one trailing read per resource", async () => {
    const pending = deferredReads();
    const release = subscribeNodeChangeResource(LEAF, KEY);
    await settle();
    for (let i = 0; i < 10; i++) relay({ nodeId: LEAF, kind: "resync" });
    expect(pending).toHaveLength(1);
    pending[0]!.resolve({ kind: "projection", projection: projection(99) });
    await settle();
    expect(held()).toBeUndefined();
    expect(pending).toHaveLength(2);
    pending[1]!.resolve({ kind: "projection", projection: projection(2) });
    await settle();
    expect(held()?.revision).toBe(2);
    release();
  });

  test("bounds concurrent reads while draining every interested resource", async () => {
    const pending = deferredReads();
    const releases = Array.from({ length: 10 }, (_, i) =>
      subscribeNodeChangeResource(LEAF, environmentChangeResourceKey(`env-${i}`)),
    );
    await settle();
    expect(pending).toHaveLength(6);
    for (const item of pending.slice()) item.resolve({ kind: "deleted" });
    await settle();
    expect(pending).toHaveLength(10);
    for (const item of pending.slice(6)) item.resolve({ kind: "deleted" });
    await settle();
    for (const release of releases) release();
  });
  test("a live reset invalidates the pending snapshot and queues a fresh generation read", async () => {
    const pending = deferredReads();
    const release = subscribeNodeChangeResource(LEAF, KEY);
    await settle();
    relay({
      nodeId: LEAF,
      kind: "event",
      event: CHANGE_PROJECTION_CHANGED_EVENT,
      payload: { kind: "reset", resourceKey: KEY, ownerGeneration: "new-owner" },
    });
    pending[0]!.resolve({ kind: "projection", projection: projection(99) });
    await settle();
    expect(held()).toBeUndefined();
    expect(pending).toHaveLength(2);
    const next = { ...projection(1), ownerGeneration: "new-owner" };
    pending[1]!.resolve({ kind: "reset", projection: next });
    await settle();
    expect(held()).toEqual(next);
    release();
  });
});
