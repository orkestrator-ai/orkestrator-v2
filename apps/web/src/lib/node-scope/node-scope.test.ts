import { afterEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { defineScopedService } from "./scoped-service";
import { defineScopedStore } from "./scoped-store";
import { WindowScope } from "./window-scope";

const NODE_A = "bk_node-a" as BackendId;
const NODE_B = "bk_node-b" as BackendId;

interface CounterState {
  count: number;
  nodeId: BackendId;
  increment(): void;
}

let creations = 0;
const counterStore = defineScopedStore<CounterState>("test-counter", (scope) => (set) => {
  creations += 1;
  return {
    count: 0,
    nodeId: scope.nodeId,
    increment: () => set((state) => ({ count: state.count + 1 })),
  };
});

const windows: WindowScope[] = [];
function openWindow(): WindowScope {
  const windowScope = new WindowScope({ budgets: { transcripts: 1_000 } });
  windows.push(windowScope);
  return windowScope;
}

afterEach(() => {
  for (const windowScope of windows.splice(0)) windowScope.dispose();
  creations = 0;
});

describe("NodeScope stores", () => {
  test("creates a store on first use only, and reuses it after", () => {
    const scope = openWindow().open({ role: "command", client: new FakeNodeClient() });
    expect(creations).toBe(0);
    const store = scope.store(counterStore);
    expect(creations).toBe(1);
    expect(scope.store(counterStore)).toBe(store);
    expect(creations).toBe(1);
  });

  test("the same definition in two scopes holds independent state", () => {
    const windowScope = openWindow();
    const a = windowScope.open({ role: "command", client: new FakeNodeClient({ nodeId: NODE_A }) });
    const b = windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_B }) });

    a.store(counterStore).getState().increment();
    a.store(counterStore).getState().increment();
    b.store(counterStore).getState().increment();

    expect(a.store(counterStore).getState()).toMatchObject({ count: 2, nodeId: NODE_A });
    expect(b.store(counterStore).getState()).toMatchObject({ count: 1, nodeId: NODE_B });
    expect(a.store(counterStore)).not.toBe(b.store(counterStore));
  });

  test("a disposed scope refuses to create or return stores", () => {
    const scope = openWindow().open({ role: "command", client: new FakeNodeClient() });
    scope.store(counterStore);
    scope.dispose();
    expect(() => scope.store(counterStore)).toThrow(/disposed/);
  });

  test("two definitions may not share a name", () => {
    const scope = openWindow().open({ role: "command", client: new FakeNodeClient() });
    const twin = defineScopedStore<{ value: number }>("test-counter", () => () => ({ value: 1 }));
    scope.store(counterStore);
    expect(() => scope.store(twin)).toThrow(/both named test-counter/);
  });

  test("a store creator can register cleanup that runs on dispose", () => {
    const events: string[] = [];
    const ticking = defineScopedStore<{ ticks: number }>("test-ticking", (scope) => () => {
      scope.onDispose("ticking", () => events.push("ticking stopped"));
      return { ticks: 0 };
    });
    const scope = openWindow().open({ role: "command", client: new FakeNodeClient() });
    scope.store(ticking);
    expect(events).toEqual([]);
    scope.dispose();
    expect(events).toEqual(["ticking stopped"]);
  });
});

describe("NodeScope dispose", () => {
  test("stops services, releases budget reservations and disposes the client", () => {
    const windowScope = openWindow();
    const clientA = new FakeNodeClient({ nodeId: NODE_A });
    const clientB = new FakeNodeClient({ nodeId: NODE_B });
    const a = windowScope.open({ role: "command", client: clientA });
    const b = windowScope.open({ role: "leaf", client: clientB });
    const stopped: string[] = [];
    const listening = defineScopedService("test-listening", (scope, signal) => {
      const unlisten = scope.client.listenRaw("resource-changed", () => {});
      signal.addEventListener("abort", () => stopped.push(`${scope.nodeId} aborted`));
      return {
        stop() {
          unlisten();
          stopped.push(`${scope.nodeId} stopped`);
        },
      };
    });
    const handleA = a.service(listening);
    b.service(listening);
    windowScope.budgets.transcripts.reserve(NODE_A, "session-1", 300);
    windowScope.budgets.images.reserve(NODE_A, "image-1", 10);
    windowScope.budgets.transcripts.reserve(NODE_B, "session-2", 200);

    a.dispose();

    expect(stopped).toEqual([`${NODE_A} stopped`, `${NODE_A} aborted`]);
    expect(handleA.status).toBe("stopped");
    expect(handleA.signal.aborted).toBe(true);
    expect(clientA.listenerCount()).toBe(0);
    expect(clientA.disposed).toBe(true);
    expect(windowScope.budgets.transcripts.usedBytesFor(NODE_A)).toBe(0);
    expect(windowScope.budgets.images.usedBytes).toBe(0);
    // The other scope is untouched.
    expect(windowScope.budgets.transcripts.usedBytesFor(NODE_B)).toBe(200);
    expect(clientB.listenerCount("resource-changed")).toBe(1);
    expect(b.health.get()).toEqual({ state: "ok" });
    expect(a.health.get()).toEqual({ state: "disposed" });
    expect(windowScope.get(NODE_A)).toBeNull();
    expect(windowScope.get(NODE_B)).toBe(b);
  });

  test("is idempotent", () => {
    const client = new FakeNodeClient();
    const scope = openWindow().open({ role: "command", client });
    let stops = 0;
    scope.onDispose("count", () => (stops += 1));
    scope.dispose();
    scope.dispose();
    expect(stops).toBe(1);
    expect(scope.disposed).toBe(true);
  });

  test("a throwing cleanup step does not stop the rest", () => {
    const logs = captureLogs();
    const client = new FakeNodeClient();
    const scope = openWindow().open({ role: "command", client });
    scope.onDispose("throws", () => {
      throw new Error("cleanup failed");
    });
    expect(() => scope.dispose()).not.toThrow();
    logs.restore();
    expect(client.disposed).toBe(true);
    expect(logs.records().map((record) => record.event)).toEqual(["finalizer.failed"]);
  });

  test("records its tier; only an open scope changes tier", () => {
    const scope = openWindow().open({ role: "leaf", client: new FakeNodeClient(), tier: "warm" });
    const seen: string[] = [];
    const stop = scope.tier.subscribe((tier) => seen.push(tier));
    scope.setTier("live");
    stop();
    expect(seen).toEqual(["live"]);
    scope.dispose();
    expect(() => scope.setTier("warm")).toThrow(/disposed/);
  });
});
