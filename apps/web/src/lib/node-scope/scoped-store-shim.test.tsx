import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { act, cleanup, render, screen } from "@testing-library/react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { getWindowScope, resetWindowScopeForTests } from "./app-window-scope";
import { defineScopedStore } from "./scoped-store";
import {
  commandScopeStore,
  noteShimUse,
  scopedStoreHook,
  setShimUseObserver,
  type ShimUse,
} from "./scoped-store-shim";

const COMMAND_NODE = "bk_shim-command" as BackendId;
const LEAF_NODE = "bk_shim-leaf" as BackendId;

interface CounterState {
  count: number;
  label: string;
  increment(): void;
}

const counterStore = defineScopedStore<CounterState>("test-shim-counter", (scope) => (set) => ({
  count: 0,
  label: `counter of ${scope.nodeId}`,
  increment: () => set((state) => ({ count: state.count + 1 })),
}));
const useCounterStore = scopedStoreHook(counterStore);

function Count({ testId = "count" }: { testId?: string }) {
  const count = useCounterStore((state) => state.count);
  const label = useCounterStore((state) => state.label);
  return (
    <span data-testid={testId}>
      {label}:{count}
    </span>
  );
}

let restoreObserver: (() => void) | null = null;

function observeShimUses(): ShimUse[] {
  const uses: ShimUse[] = [];
  restoreObserver = setShimUseObserver((use) => uses.push(use));
  return uses;
}

afterEach(() => {
  restoreObserver?.();
  restoreObserver = null;
  cleanupNodeScopes();
  cleanup();
  resetWindowScopeForTests();
});

describe("scopedStoreHook statics (the deprecated command-scope shim)", () => {
  test("getState and setState act on the app's command scope instance", () => {
    resetWindowScopeForTests(new FakeNodeClient({ nodeId: COMMAND_NODE }));
    useCounterStore.setState({ count: 4 });
    useCounterStore.getState().increment();
    const commandInstance = getWindowScope().commandScope().store(counterStore);
    expect(commandInstance.getState().count).toBe(5);
    expect(useCounterStore.getState().label).toBe(`counter of ${COMMAND_NODE}`);
    expect(commandScopeStore(counterStore)).toBe(commandInstance);
    expect(useCounterStore.def).toBe(counterStore);
  });

  test("subscribe and getInitialState read the command scope's instance", () => {
    resetWindowScopeForTests(new FakeNodeClient({ nodeId: COMMAND_NODE }));
    const listener = mock((_state: CounterState) => {});
    const unsubscribe = useCounterStore.subscribe(listener);
    getWindowScope().commandScope().store(counterStore).getState().increment();
    unsubscribe();
    useCounterStore.getState().increment();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(useCounterStore.getInitialState().count).toBe(0);
  });

  test("a new window scope starts the shim from fresh state", () => {
    resetWindowScopeForTests(new FakeNodeClient({ nodeId: COMMAND_NODE }));
    useCounterStore.setState({ count: 9 });
    resetWindowScopeForTests(new FakeNodeClient({ nodeId: COMMAND_NODE }));
    expect(useCounterStore.getState().count).toBe(0);
  });

  test("every static notes a shim use, and noteShimUse is silent with no observer", () => {
    resetWindowScopeForTests(new FakeNodeClient({ nodeId: COMMAND_NODE }));
    noteShimUse("test-shim-counter", "getState");
    const uses = observeShimUses();
    useCounterStore.getState();
    useCounterStore.setState({ count: 1 });
    useCounterStore.subscribe(() => {})();
    useCounterStore.getInitialState();
    expect(uses).toEqual([
      { store: "test-shim-counter", via: "getState" },
      { store: "test-shim-counter", via: "setState" },
      { store: "test-shim-counter", via: "subscribe" },
      { store: "test-shim-counter", via: "getInitialState" },
    ]);
  });

  test("setShimUseObserver returns a restore for the previous observer", () => {
    const outer: ShimUse[] = [];
    const inner: ShimUse[] = [];
    const restoreOuter = setShimUseObserver((use) => outer.push(use));
    const restoreInner = setShimUseObserver((use) => inner.push(use));
    noteShimUse("a", "getState");
    restoreInner();
    noteShimUse("b", "setState");
    restoreOuter();
    noteShimUse("c", "subscribe");
    expect(inner).toEqual([{ store: "a", via: "getState" }]);
    expect(outer).toEqual([{ store: "b", via: "setState" }]);
  });
});

describe("scopedStoreHook as a hook", () => {
  test("inside a node scope it reads that scope's instance, not the command scope's", () => {
    resetWindowScopeForTests(new FakeNodeClient({ nodeId: COMMAND_NODE }));
    const uses = observeShimUses();
    const { scope } = renderInNodeScope(<Count />, { nodeId: LEAF_NODE, role: "leaf" });
    expect(screen.getByTestId("count").textContent).toBe(`counter of ${LEAF_NODE}:0`);

    act(() => useCounterStore.setState({ count: 7 }));
    expect(screen.getByTestId("count").textContent).toBe(`counter of ${LEAF_NODE}:0`);

    act(() => scope.store(counterStore).getState().increment());
    expect(screen.getByTestId("count").textContent).toBe(`counter of ${LEAF_NODE}:1`);
    expect(uses.filter((use) => use.via === "hook-without-provider")).toEqual([]);
  });

  test("two node scopes in one window keep separate instances", () => {
    const first = renderInNodeScope(<Count testId="first" />, { nodeId: COMMAND_NODE });
    renderInNodeScope(<Count testId="second" />, {
      nodeId: LEAF_NODE,
      role: "leaf",
      windowScope: first.windowScope,
    });
    act(() => first.scope.store(counterStore).getState().increment());
    expect(screen.getByTestId("first").textContent).toBe(`counter of ${COMMAND_NODE}:1`);
    expect(screen.getByTestId("second").textContent).toBe(`counter of ${LEAF_NODE}:0`);
  });

  test("outside a provider it reads the command scope and notes the fallback", () => {
    resetWindowScopeForTests(new FakeNodeClient({ nodeId: COMMAND_NODE }));
    const uses = observeShimUses();
    render(<Count />);
    expect(screen.getByTestId("count").textContent).toBe(`counter of ${COMMAND_NODE}:0`);
    act(() => useCounterStore.getState().increment());
    expect(screen.getByTestId("count").textContent).toBe(`counter of ${COMMAND_NODE}:1`);
    expect(uses).toContainEqual({ store: "test-shim-counter", via: "hook-without-provider" });
  });

  test("with no selector it returns the whole state", () => {
    const seen: CounterState[] = [];
    function Whole() {
      seen.push(useCounterStore());
      return null;
    }
    const { scope } = renderInNodeScope(<Whole />, { nodeId: LEAF_NODE, role: "leaf" });
    expect(seen.at(-1)).toBe(scope.store(counterStore).getState());
  });
});
