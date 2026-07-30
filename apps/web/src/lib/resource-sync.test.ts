import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NativeEvent, UnlistenFn } from "@/lib/native/events";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";

/**
 * The global setup mocks `@/lib/native/events` for every suite. `startResourceSync`
 * needs to drive that listener, so this file overrides the mock with a
 * controllable one and restores the shared shape afterwards — the
 * snapshot-and-restore pattern from AGENTS.md — so later files still see the
 * no-op listener they expect.
 */
import * as realEvents from "@/lib/native/events";

const realEventsSnapshot = { ...realEvents };

type Handler = (event: NativeEvent<unknown>) => void;
type ListenMode = "immediate" | "deferred" | "reject";

let listenCalls: Array<{ event: string; handler: Handler }> = [];
let unlistenCount = 0;
let listenMode: ListenMode = "immediate";
let listenModesByEvent = new Map<string, ListenMode>();
let deferredListens: Array<{ event: string; resolve: () => void }> = [];

const listenMock = mock((event: string, handler: Handler): Promise<UnlistenFn> => {
  listenCalls.push({ event, handler });
  const stop: UnlistenFn = () => { unlistenCount += 1; };
  const mode = listenModesByEvent.get(event) ?? listenMode;
  if (mode === "reject") return Promise.reject(new Error("no transport"));
  if (mode === "deferred") {
    return new Promise<UnlistenFn>((resolve) => {
      deferredListens.push({ event, resolve: () => resolve(stop) });
    });
  }
  return Promise.resolve(stop);
});

mock.module("@/lib/native/events", () => ({
  listen: listenMock,
  emit: mock(() => Promise.resolve()),
  NATIVE_EVENT_STREAM_CONNECTED_EVENT: "native-event-stream-connected",
}));

afterAll(() => {
  mock.module("@/lib/native/events", () => realEventsSnapshot);
});

const {
  dispatchResourceChange,
  onResourceChanged,
  onResourceResync,
  requestResourceResync,
  resetResourceSync,
  startResourceSync,
} = await import("./resource-sync");

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Comfortably past the module's 50ms coalescing window. */
const COALESCED = 80;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

function change(overrides: Partial<ResourceChange> = {}): ResourceChange {
  return { resource: "environment", id: "env-1", revision: 1, ...overrides };
}

beforeEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  resetResourceSync();
  listenCalls = [];
  unlistenCount = 0;
  listenMode = "immediate";
  listenModesByEvent = new Map();
  deferredListens = [];
  listenMock.mockClear();
});

afterEach(() => {
  resetResourceSync();
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe("onResourceChanged", () => {
  test("delivers a change to a subscriber of that kind", async () => {
    const seen: ResourceChange[] = [];
    onResourceChanged("environment", (received) => seen.push(received));

    dispatchResourceChange(change());
    await tick(COALESCED);

    expect(seen).toEqual([change()]);
  });

  test("does not deliver a change of a different kind", async () => {
    const seen: ResourceChange[] = [];
    onResourceChanged("environment", (received) => seen.push(received));

    dispatchResourceChange(change({ resource: "kanban", id: "project-1" }));
    await tick(COALESCED);

    expect(seen).toEqual([]);
  });

  test("delivers to every subscriber of the same kind", async () => {
    let first = 0;
    let second = 0;
    onResourceChanged("environment", () => { first += 1; });
    onResourceChanged("environment", () => { second += 1; });

    dispatchResourceChange(change());
    await tick(COALESCED);

    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  test("stops delivering after unsubscribe", async () => {
    let calls = 0;
    const unsubscribe = onResourceChanged("environment", () => { calls += 1; });
    unsubscribe();

    dispatchResourceChange(change());
    await tick(COALESCED);

    expect(calls).toBe(0);
  });

  test("unsubscribing one handler leaves its siblings attached", async () => {
    let kept = 0;
    const drop = onResourceChanged("environment", () => { throw new Error("unreachable"); });
    onResourceChanged("environment", () => { kept += 1; });
    drop();

    dispatchResourceChange(change());
    await tick(COALESCED);

    expect(kept).toBe(1);
  });

  test("a handler that unsubscribes itself mid-delivery does not disturb the others", async () => {
    // deliver() iterates a copy for exactly this reason.
    let sibling = 0;
    const unsubscribe = onResourceChanged("environment", () => { unsubscribe(); });
    onResourceChanged("environment", () => { sibling += 1; });

    dispatchResourceChange(change());
    await tick(COALESCED);

    expect(sibling).toBe(1);
  });

  test("a throwing handler does not stop the remaining handlers", async () => {
    let reached = 0;
    onResourceChanged("environment", () => { throw new Error("handler exploded"); });
    onResourceChanged("environment", () => { reached += 1; });

    dispatchResourceChange(change());
    await tick(COALESCED);

    expect(reached).toBe(1);
  });
});

describe("dispatchResourceChange coalescing", () => {
  test("collapses a burst for one id into a single delivery", async () => {
    const seen: ResourceChange[] = [];
    onResourceChanged("environment", (received) => seen.push(received));

    dispatchResourceChange(change({ revision: 1 }));
    dispatchResourceChange(change({ revision: 2 }));
    dispatchResourceChange(change({ revision: 3 }));
    await tick(COALESCED);

    expect(seen).toHaveLength(1);
  });

  test("keeps the highest revision seen in a burst", async () => {
    const seen: ResourceChange[] = [];
    onResourceChanged("environment", (received) => seen.push(received));

    dispatchResourceChange(change({ revision: 5 }));
    // An out-of-order frame must not drag the delivered ordering backwards.
    dispatchResourceChange(change({ revision: 2 }));
    await tick(COALESCED);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.revision).toBe(5);
  });

  test("does not coalesce across different ids of the same kind", async () => {
    const seen: string[] = [];
    onResourceChanged("environment", (received) => seen.push(received.id));

    dispatchResourceChange(change({ id: "env-1" }));
    dispatchResourceChange(change({ id: "env-2" }));
    await tick(COALESCED);

    expect(seen.sort()).toEqual(["env-1", "env-2"]);
  });

  test("does not coalesce the same id across different kinds", async () => {
    const seen: string[] = [];
    onResourceChanged("environment", () => seen.push("environment"));
    onResourceChanged("session", () => seen.push("session"));

    dispatchResourceChange({ resource: "environment", id: "shared", revision: 1 });
    dispatchResourceChange({ resource: "session", id: "shared", revision: 1 });
    await tick(COALESCED);

    expect(seen.sort()).toEqual(["environment", "session"]);
  });

  test("delivers again for a change arriving after the window closed", async () => {
    let calls = 0;
    onResourceChanged("environment", () => { calls += 1; });

    dispatchResourceChange(change({ revision: 1 }));
    await tick(COALESCED);
    dispatchResourceChange(change({ revision: 2 }));
    await tick(COALESCED);

    expect(calls).toBe(2);
  });

  test("dispatching with no subscriber attached is harmless", async () => {
    expect(() => dispatchResourceChange(change())).not.toThrow();
    await tick(COALESCED);
  });
});

describe("resetResourceSync", () => {
  test("drops a queued dispatch before it is delivered", async () => {
    let calls = 0;
    onResourceChanged("environment", () => { calls += 1; });

    dispatchResourceChange(change());
    resetResourceSync();
    await tick(COALESCED);

    expect(calls).toBe(0);
  });

  test("stops every active transport and remains idempotent", async () => {
    startResourceSync();
    startResourceSync();
    await tick(0);

    resetResourceSync();
    expect(unlistenCount).toBe(4);

    resetResourceSync();
    expect(unlistenCount).toBe(4);
  });
});

describe("onResourceResync", () => {
  test("unsubscribes independently and isolates throwing handlers", () => {
    const removed = mock(() => undefined);
    const reached = mock(() => undefined);
    const unsubscribe = onResourceResync(removed);
    unsubscribe();
    onResourceResync(() => {
      throw new Error("resync exploded");
    });
    onResourceResync(reached);

    expect(() => requestResourceResync()).not.toThrow();
    expect(removed).not.toHaveBeenCalled();
    expect(reached).toHaveBeenCalledTimes(1);
  });
});

describe("startResourceSync", () => {
  test("subscribes to the resource-changed event", async () => {
    startResourceSync();
    await tick(0);

    expect(listenCalls.map((call) => call.event)).toEqual([
      "resource-changed",
      "native-event-stream-connected",
    ]);
  });

  test("routes a valid payload to subscribers", async () => {
    const seen: ResourceChange[] = [];
    onResourceChanged("environment", (received) => seen.push(received));
    startResourceSync();
    await tick(0);

    listenCalls[0]!.handler({ payload: change({ revision: 9 }) });
    await tick(COALESCED);

    expect(seen).toEqual([change({ revision: 9 })]);
  });

  test("drops a malformed payload rather than triggering a refetch", async () => {
    let calls = 0;
    onResourceChanged("environment", () => { calls += 1; });
    startResourceSync();
    await tick(0);

    for (const payload of [null, "environment", { resource: "nope", id: "x", revision: 1 },
      { resource: "environment", id: "", revision: 1 },
      { resource: "environment", id: "env-1", revision: Number.NaN }]) {
      listenCalls[0]!.handler({ payload });
    }
    await tick(COALESCED);

    expect(calls).toBe(0);
  });

  test("detaches the listener when the returned disposer runs", async () => {
    const stop = startResourceSync();
    await tick(0);

    stop();

    expect(unlistenCount).toBe(2);
  });

  test("detaches both subscriptions when they resolve after disposal in either order", async () => {
    // Each listen has its own promise. A single stored resolver would leave one
    // subscription untested and could conceal a late-listener leak.
    listenMode = "deferred";
    const stop = startResourceSync();
    stop();

    expect(deferredListens.map(({ event }) => event)).toEqual([
      "resource-changed",
      "native-event-stream-connected",
    ]);
    deferredListens[1]!.resolve();
    deferredListens[0]!.resolve();
    await tick(0);

    expect(unlistenCount).toBe(2);
  });

  test("survives a transport that never attaches", async () => {
    listenMode = "reject";
    const stop = startResourceSync();
    await tick(0);

    expect(() => stop()).not.toThrow();
  });

  test("requests an authoritative resync after initial attachment", async () => {
    const resync = mock(() => undefined);
    onResourceResync(resync);

    startResourceSync();
    await tick(10);

    expect(resync).toHaveBeenCalledTimes(1);
  });

  test("does not duplicate the fallback resync when connection arrives before the second listener attaches", async () => {
    const resync = mock(() => undefined);
    onResourceResync(resync);
    listenModesByEvent.set("resource-changed", "deferred");

    startResourceSync();
    await tick(0);
    expect(deferredListens).toHaveLength(1);

    const connected = listenCalls.find(
      ({ event }) => event === "native-event-stream-connected",
    );
    connected?.handler({ payload: undefined });
    expect(resync).toHaveBeenCalledTimes(1);

    deferredListens[0]!.resolve();
    await tick(10);

    expect(resync).toHaveBeenCalledTimes(1);
  });

  test("does not run the zero-delay fallback after the transport is stopped", async () => {
    const resync = mock(() => undefined);
    onResourceResync(resync);
    const stop = startResourceSync();
    // Let both listen promises attach and schedule the zero-delay fallback,
    // then dispose before that task gets a chance to run.
    await Promise.resolve();
    await Promise.resolve();

    stop();
    await tick(10);

    expect(resync).not.toHaveBeenCalled();
  });

  test("deduplicates the initial connection signal and resyncs on reconnect", async () => {
    const resync = mock(() => undefined);
    onResourceResync(resync);
    startResourceSync();
    await tick(10);
    resync.mockClear();

    const connected = listenCalls.find(
      ({ event }) => event === "native-event-stream-connected",
    );
    connected?.handler({ payload: undefined });
    connected?.handler({ payload: undefined });

    expect(resync).toHaveBeenCalledTimes(1);
  });

  test("requests a resync when a global revision gap is observed", async () => {
    const resync = mock(() => undefined);
    onResourceResync(resync);
    startResourceSync();
    await tick(10);
    resync.mockClear();

    const resource = listenCalls.find(({ event }) => event === "resource-changed");
    resource?.handler({ payload: change({ revision: 10 }) });
    resource?.handler({ payload: change({ revision: 12 }) });

    expect(resync).toHaveBeenCalledTimes(1);
  });

  test("accepts a contiguous retained replay without a broad resync", async () => {
    const resync = mock(() => undefined);
    onResourceResync(resync);
    startResourceSync();
    await tick(10);
    resync.mockClear();

    const resource = listenCalls.find(({ event }) => event === "resource-changed");
    resource?.handler({ payload: change({ revision: 10 }) });
    resource?.handler({ payload: change({ revision: 11 }) });

    expect(resync).not.toHaveBeenCalled();
  });

  test("broadly resyncs on a fresh or unrecoverable transport signal after replayed changes", async () => {
    const resync = mock(() => undefined);
    onResourceResync(resync);
    startResourceSync();
    await tick(10);
    resync.mockClear();

    const resource = listenCalls.find(({ event }) => event === "resource-changed");
    const connected = listenCalls.find(
      ({ event }) => event === "native-event-stream-connected",
    );
    connected?.handler({ payload: undefined });
    resync.mockClear();

    // Caught-up and replayed gateway handshakes are intentionally absent from
    // this transport-level signal, so their contiguous events do not refetch.
    resource?.handler({ payload: change({ revision: 20 }) });
    resource?.handler({ payload: change({ revision: 21 }) });
    expect(resync).not.toHaveBeenCalled();

    // The web gateway emits this signal for a fresh stream or explicit replay
    // miss. Either case must invalidate all resource snapshots.
    connected?.handler({ payload: undefined });
    expect(resync).toHaveBeenCalledTimes(1);
  });

  test("requests a resync when the backend sequence resets", async () => {
    const resync = mock(() => undefined);
    onResourceResync(resync);
    startResourceSync();
    await tick(10);
    resync.mockClear();

    const resource = listenCalls.find(({ event }) => event === "resource-changed");
    resource?.handler({ payload: change({ revision: 10 }) });
    resource?.handler({ payload: change({ revision: 1 }) });

    expect(resync).toHaveBeenCalledTimes(1);
  });

  test("periodically resyncs as a safety net and clears the timer on stop", async () => {
    let intervalCallback: (() => void) | undefined;
    const clearIntervalMock = mock(() => undefined);
    globalThis.setInterval = ((callback: TimerHandler, timeout?: number) => {
      expect(timeout).toBe(60_000);
      intervalCallback = callback as () => void;
      return 42 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = clearIntervalMock as typeof clearInterval;
    const resync = mock(() => undefined);
    onResourceResync(resync);

    const stop = startResourceSync();
    await tick(10);
    resync.mockClear();
    intervalCallback?.();

    expect(resync).toHaveBeenCalledTimes(1);
    stop();
    expect(clearIntervalMock).toHaveBeenCalledWith(42);
  });
});
