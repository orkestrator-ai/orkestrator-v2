import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BackendId } from "@orkestrator/protocol/federation";
import { act, cleanup, render } from "@testing-library/react";
import { configureLogger, resetLogger, type LogRecord } from "@orkestrator/protocol/logger";
import { cleanupNodeScopes, renderInNodeScope } from "@/test/render-in-node-scope";
import { claudeOptionsStore, useClaudeOptionsStore } from "@/stores/claudeOptionsStore";
import { resetWindowScopeForTests } from "./app-window-scope";
import { defineScopedStore } from "./scoped-store";
import { noteShimUse, scopedStoreHook, setShimUseObserver } from "./scoped-store-shim";
import {
  configureShimUnderLeafGuard,
  defaultShimGuardMode,
  inTreeLeafMounted,
  installShimGuardProbe,
  isGuardedShimStore,
  markInTreeLeafMounted,
  mountedInTreeLeaves,
  resetShimUnderLeafGuardForTests,
  SHIM_GUARD_ENV,
  SHIM_GUARD_EXEMPT_STORES,
  ShimUnderLeafError,
  shimUnderLeafCounts,
  shimUnderLeafGuard,
  useInTreeLeafMount,
  WORKSPACE_SUBTREE_STORES,
} from "./shim-under-leaf-guard";

const LEAF = "bk_guard-leaf";
const webSrc = path.resolve(import.meta.dir, "../..");
const repositoryRoot = path.resolve(webSrc, "../../..");

/** A store outside the workspace subtree that has a shim (only tests define one). */
const outsideStore = defineScopedStore<{ count: number }>("test-guard-outside", () => () => ({
  count: 0,
}));
const useOutsideStore = scopedStoreHook(outsideStore);

function ReadsClaudeOptionsWithoutProvider() {
  const options = useClaudeOptionsStore((state) => state.options);
  return <span>{Object.keys(options).length}</span>;
}

function LeafMount({ nodeId }: { nodeId: string }) {
  useInTreeLeafMount(nodeId);
  return null;
}

let restoreGuard: (() => void) | null = null;

beforeEach(() => {
  resetShimUnderLeafGuardForTests();
});

afterEach(() => {
  restoreGuard?.();
  restoreGuard = null;
  cleanup();
  resetShimUnderLeafGuardForTests();
  resetWindowScopeForTests();
});

describe("with an in-tree leaf mounted", () => {
  test("a shim use of a workspace store throws in tests, for every kind of use", () => {
    expect(defaultShimGuardMode()).toBe("throw");
    const release = markInTreeLeafMounted(LEAF);
    try {
      expect(() => useClaudeOptionsStore.getState()).toThrow(ShimUnderLeafError);
      expect(() => useClaudeOptionsStore.setState({})).toThrow(ShimUnderLeafError);
      expect(() => useClaudeOptionsStore.subscribe(() => undefined)).toThrow(ShimUnderLeafError);
      expect(() => useClaudeOptionsStore.getInitialState()).toThrow(ShimUnderLeafError);
      // The hook outside any provider falls back to the command scope: caught too.
      const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
      try {
        expect(() => render(<ReadsClaudeOptionsWithoutProvider />)).toThrow(ShimUnderLeafError);
      } finally {
        consoleError.mockRestore();
      }
    } finally {
      release();
    }
    // Counted before throwing, so a use whose throw a callback swallowed still shows.
    expect(shimUnderLeafCounts()).toEqual(
      expect.arrayContaining([
        { store: "claude-options", via: "getState", count: 1 },
        { store: "claude-options", via: "setState", count: 1 },
        { store: "claude-options", via: "subscribe", count: 1 },
        { store: "claude-options", via: "getInitialState", count: 1 },
        expect.objectContaining({ store: "claude-options", via: "hook-without-provider" }),
      ]),
    );
  });

  test("the error names the store and the remedy, never a value", () => {
    const release = markInTreeLeafMounted(LEAF);
    let caught: unknown;
    try {
      useClaudeOptionsStore.setState({ options: { "env-secret": {} as never } });
    } catch (error) {
      caught = error;
    } finally {
      release();
    }
    expect(caught).toBeInstanceOf(ShimUnderLeafError);
    const error = caught as ShimUnderLeafError;
    expect(error.store).toBe("claude-options");
    expect(error.via).toBe("setState");
    expect(error.message).toContain("scope.store(def)");
    expect(error.message).not.toContain("env-secret");
  });

  test("a store outside the workspace subtree does not throw", () => {
    const release = markInTreeLeafMounted(LEAF);
    try {
      // Every exempt store by name, and a shimmed store that is in neither list.
      for (const { store } of SHIM_GUARD_EXEMPT_STORES) {
        expect(() => noteShimUse(store, "getState")).not.toThrow();
      }
      expect(useOutsideStore.getState().count).toBe(0);
      useOutsideStore.setState({ count: 1 });
      expect(useOutsideStore.getState().count).toBe(1);
    } finally {
      release();
    }
    expect(shimUnderLeafCounts()).toEqual([]);
  });

  test("the scope's own instance, named explicitly, is never a shim use", () => {
    const release = markInTreeLeafMounted(LEAF);
    try {
      const { scope } = renderInNodeScope(<ReadsClaudeOptionsWithoutProvider />, {
        nodeId: LEAF as BackendId,
        role: "leaf",
      });
      act(() => scope.store(claudeOptionsStore).setState({ options: {} }));
      expect(scope.store(claudeOptionsStore).getState().options).toEqual({});
    } finally {
      release();
      cleanupNodeScopes();
    }
    expect(shimUnderLeafCounts()).toEqual([]);
  });
});

describe("with no in-tree leaf mounted", () => {
  test("nothing throws and nothing is counted", () => {
    expect(inTreeLeafMounted()).toBe(false);
    expect(() => useClaudeOptionsStore.getState()).not.toThrow();
    useClaudeOptionsStore.setState({});
    useClaudeOptionsStore.subscribe(() => undefined)();
    expect(() => render(<ReadsClaudeOptionsWithoutProvider />)).not.toThrow();
    for (const store of WORKSPACE_SUBTREE_STORES) {
      expect(() => noteShimUse(store, "getState")).not.toThrow();
    }
    expect(shimUnderLeafCounts()).toEqual([]);
  });

  test("a mount mark lasts exactly as long as the component, and counts nodes", () => {
    const first = render(<LeafMount nodeId={LEAF} />);
    const second = render(<LeafMount nodeId="bk_other" />);
    expect(mountedInTreeLeaves()).toEqual(["bk_guard-leaf", "bk_other"]);
    expect(() => useClaudeOptionsStore.getState()).toThrow(ShimUnderLeafError);
    first.unmount();
    expect(mountedInTreeLeaves()).toEqual(["bk_other"]);
    second.unmount();
    expect(inTreeLeafMounted()).toBe(false);
    expect(() => useClaudeOptionsStore.getState()).not.toThrow();

    // A release is idempotent; two marks of one node need two releases.
    const a = markInTreeLeafMounted(LEAF);
    const b = markInTreeLeafMounted(LEAF);
    a();
    a();
    expect(inTreeLeafMounted()).toBe(true);
    b();
    expect(inTreeLeafMounted()).toBe(false);
  });
});

describe("in production", () => {
  test("a use is counted and logged once per store and kind, content free, and never throws", () => {
    restoreGuard = configureShimUnderLeafGuard({ mode: "count" });
    const records: LogRecord[] = [];
    configureLogger({
      level: "info",
      sink: (output) => {
        if (output.record) records.push(output.record);
      },
    });
    const release = markInTreeLeafMounted(LEAF);
    try {
      expect(useClaudeOptionsStore.getState()).toBeTruthy();
      useClaudeOptionsStore.getState();
      useClaudeOptionsStore.setState({});
      noteShimUse("ui-chrome", "getState");
    } finally {
      release();
      resetLogger();
    }
    expect(shimUnderLeafCounts()).toEqual([
      { store: "claude-options", via: "getState", count: 2 },
      { store: "claude-options", via: "setState", count: 1 },
    ]);
    const guardRecords = records.filter((record) => record.event === "shim-under-leaf");
    expect(guardRecords.map((record) => [record.area, record.level, record.fields])).toEqual([
      ["web.node-scope", "warn", { store: "claude-options", via: "getState" }],
      ["web.node-scope", "warn", { store: "claude-options", via: "setState" }],
    ]);
  });
});

describe("mode and probe", () => {
  test("the flag sets the mode; otherwise development and tests throw and production counts", () => {
    expect(
      defaultShimGuardMode({ [SHIM_GUARD_ENV]: "throw", DEV: false, MODE: "production" }),
    ).toBe("throw");
    expect(defaultShimGuardMode({ [SHIM_GUARD_ENV]: "count", DEV: true })).toBe("count");
    expect(defaultShimGuardMode({ DEV: true, MODE: "development" })).toBe("throw");
    expect(defaultShimGuardMode({ NODE_ENV: "test" })).toBe("throw");
    expect(defaultShimGuardMode({ DEV: false, MODE: "production" })).toBe("count");
    expect(defaultShimGuardMode({ [SHIM_GUARD_ENV]: "loud", DEV: false })).toBe("count");
  });

  test("the e2e probe reports the mode, the mounted leaves and the caught uses", () => {
    const target = {} as Window;
    const probe = installShimGuardProbe(target);
    expect(target.orkestratorShimGuard).toBe(probe);
    expect(probe.mode).toBe("throw");
    const release = markInTreeLeafMounted(LEAF);
    expect(probe.mountedLeaves()).toEqual([LEAF]);
    expect(() => shimUnderLeafGuard({ store: "environment", via: "subscribe" })).toThrow();
    release();
    expect(probe.uses()).toEqual([{ store: "environment", via: "subscribe", count: 1 }]);
  });

  test("an observer a test installs replaces the guard, and restoring brings it back", () => {
    const seen: string[] = [];
    const restore = setShimUseObserver((use) => seen.push(use.store));
    const release = markInTreeLeafMounted(LEAF);
    try {
      expect(() => useClaudeOptionsStore.getState()).not.toThrow();
      restore();
      expect(() => useClaudeOptionsStore.getState()).toThrow(ShimUnderLeafError);
    } finally {
      release();
    }
    expect(seen).toEqual(["claude-options"]);
  });
});

describe("the store lists", () => {
  test("every shimmed store is classified, and the workspace and exempt lists are disjoint", () => {
    const registry = readFileSync(
      path.join(repositoryRoot, "tests/source-guards/scoped-store-shim.ts"),
      "utf8",
    );
    const shimmed = Array.from(
      registry.matchAll(/^\s*store: "([^"]+)",$/gmu),
      (match) => match[1]!,
    );
    expect(shimmed.length).toBeGreaterThan(30);
    const exempt = new Set(SHIM_GUARD_EXEMPT_STORES.map((entry) => entry.store));
    for (const store of shimmed) {
      expect({ store, classified: isGuardedShimStore(store) || exempt.has(store) }).toEqual({
        store,
        classified: true,
      });
    }
    for (const store of WORKSPACE_SUBTREE_STORES) expect(exempt.has(store)).toBe(false);
    // The 3013 set: every one is a registered shimmed store.
    for (const store of WORKSPACE_SUBTREE_STORES) expect(shimmed).toContain(store);
  });

  test("every store module that is not a scoped def is listed as exempt, and every entry exists", () => {
    const storesDir = path.join(webSrc, "stores");
    const windowModules = readdirSync(storesDir)
      .filter((file) => file.endsWith(".ts") && !file.includes(".test.") && file !== "index.ts")
      .filter(
        (file) => !readFileSync(path.join(storesDir, file), "utf8").includes("defineScopedStore"),
      )
      .map((file) => `stores/${file.replace(/\.ts$/u, "")}`)
      .sort();
    const listed = SHIM_GUARD_EXEMPT_STORES.map((entry) => entry.module).sort();
    expect(listed).toEqual(windowModules);
    for (const entry of SHIM_GUARD_EXEMPT_STORES) {
      expect(existsSync(path.join(webSrc, `${entry.module}.ts`))).toBe(true);
    }
  });
});
