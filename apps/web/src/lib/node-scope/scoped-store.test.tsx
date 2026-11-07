/**
 * A per-node store's hook (`scopedStoreHook(def)`, plan item 3018): it reads
 * the nearest node scope, has no command-scope statics, and outside a
 * provider throws in development and tests. Production keeps
 * `useNodeScope()`'s fallback to the app's command scope.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { act, cleanup, render, screen } from "@testing-library/react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { getWindowScope, resetWindowScopeForTests } from "./app-window-scope";
import { defineScopedStore, scopedStoreHook } from "./scoped-store";
import { WindowScope } from "./window-scope";

const COMMAND_NODE = "bk_strict-command" as BackendId;
const LEAF_NODE = "bk_strict-leaf" as BackendId;

interface CounterState {
  count: number;
  label: string;
  increment(): void;
}

const counterStore = defineScopedStore<CounterState>("test-strict-counter", (scope) => (set) => ({
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

function WholeState() {
  const state = useCounterStore();
  return <span data-testid="whole">{state.count}</span>;
}

/** Runs `run` with the environment a production renderer has (no DEV, MODE or test NODE_ENV). */
function inProduction(run: () => void): void {
  const env = import.meta.env as unknown as Record<string, unknown>;
  const saved = { DEV: env.DEV, MODE: env.MODE, NODE_ENV: env.NODE_ENV };
  env.DEV = false;
  env.MODE = "production";
  env.NODE_ENV = "production";
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}

afterEach(() => {
  cleanupNodeScopes();
  cleanup();
  resetWindowScopeForTests();
});

describe("scopedStoreHook", () => {
  test("reads the nearest node scope's instance, with or without a selector", () => {
    const { scope } = renderInNodeScope(
      <>
        <Count />
        <WholeState />
      </>,
      { nodeId: LEAF_NODE, role: "leaf" },
    );
    expect(screen.getByTestId("count").textContent).toBe(`counter of ${LEAF_NODE}:0`);
    act(() => scope.store(counterStore).getState().increment());
    expect(screen.getByTestId("count").textContent).toBe(`counter of ${LEAF_NODE}:1`);
    expect(screen.getByTestId("whole").textContent).toBe("1");
  });

  test("two scopes in one window render their own instances", () => {
    const windowScope = new WindowScope();
    const a = renderInNodeScope(<Count testId="a" />, {
      windowScope,
      client: new FakeNodeClient({ nodeId: COMMAND_NODE }),
    });
    renderInNodeScope(<Count testId="b" />, {
      windowScope,
      role: "leaf",
      client: new FakeNodeClient({ nodeId: LEAF_NODE }),
    });
    act(() => a.scope.store(counterStore).getState().increment());
    expect(screen.getByTestId("a").textContent).toBe(`counter of ${COMMAND_NODE}:1`);
    expect(screen.getByTestId("b").textContent).toBe(`counter of ${LEAF_NODE}:0`);
  });

  test("carries its definition and no command-scope statics", () => {
    expect(useCounterStore.def).toBe(counterStore);
    for (const name of ["getState", "setState", "subscribe", "getInitialState"])
      expect([name, name in useCounterStore]).toEqual([name, false]);
  });

  // Development is the same check (`import.meta.env.DEV`, which a bun test
  // cannot set: its import.meta.env is process.env, whose values are strings).
  test("outside a provider it throws in tests, and names the remedy", () => {
    resetWindowScopeForTests(new FakeNodeClient({ nodeId: COMMAND_NODE }));
    const silence = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Count />)).toThrow(/needs a NodeScopeProvider.*renderInNodeScope/);
    } finally {
      console.error = silence;
    }
    // Nothing reached the command scope's instance.
    expect(getWindowScope().commandScope().store(counterStore).getState().count).toBe(0);
  });

  test("in production, outside a provider, it reads the app's command scope", () => {
    resetWindowScopeForTests(new FakeNodeClient({ nodeId: COMMAND_NODE }));
    getWindowScope().commandScope().store(counterStore).setState({ count: 7 });
    inProduction(() => {
      render(<Count />);
    });
    expect(screen.getByTestId("count").textContent).toBe(`counter of ${COMMAND_NODE}:7`);
  });
});
