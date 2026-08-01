import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type EnvironmentPaneState,
  usePaneLayoutStore,
} from "@/stores/paneLayoutStore";
import type { PaneNode } from "@/types/paneLayout";
import {
  applyStoredPaneSelection,
  clearStoredPaneSelection,
  paneSelectionOf,
  readStoredPaneSelection,
  startPaneSelectionPersistence,
  writeStoredPaneSelection,
} from "./pane-selection-storage";

const STORAGE_KEY = "orkestrator.pane-selection.v1";

function leaf(id: string, tabIds: string[], activeTabId?: string | null): PaneNode {
  return {
    kind: "leaf",
    id,
    tabs: tabIds.map((tabId) => ({ id: tabId, type: "plain" as const })),
    activeTabId: activeTabId === undefined ? tabIds[0] ?? null : activeTabId,
  };
}

function split(left: PaneNode, right: PaneNode): PaneNode {
  return {
    kind: "split",
    id: "split",
    direction: "horizontal",
    children: [left, right],
    sizes: [50, 50],
    depth: 1,
  };
}

function paneState(root: PaneNode, activePaneId: string): EnvironmentPaneState {
  return { root, activePaneId, containerId: "container-1" };
}

beforeEach(() => {
  localStorage.clear();
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
});

afterEach(() => {
  localStorage.clear();
});

describe("paneSelectionOf", () => {
  test("captures the selected tab of every pane and the active pane", () => {
    const state = paneState(
      split(leaf("left", ["a", "b"], "b"), leaf("right", ["c"], "c")),
      "right",
    );

    expect(paneSelectionOf(state)).toEqual({
      activePaneId: "right",
      activeTabIds: { left: "b", right: "c" },
    });
  });

  test("omits a pane with nothing selected", () => {
    const state = paneState(
      split(leaf("left", [], null), leaf("right", ["c"], "c")),
      "left",
    );

    expect(paneSelectionOf(state)).toEqual({
      activePaneId: "left",
      activeTabIds: { right: "c" },
    });
  });
});

describe("read/write/clear", () => {
  test("round-trips a selection per environment", () => {
    writeStoredPaneSelection("env-1", {
      activePaneId: "right",
      activeTabIds: { left: "b" },
    });
    writeStoredPaneSelection("env-2", {
      activePaneId: "default",
      activeTabIds: { default: "z" },
    });

    expect(readStoredPaneSelection("env-1")).toEqual({
      activePaneId: "right",
      activeTabIds: { left: "b" },
    });
    expect(readStoredPaneSelection("env-2")).toEqual({
      activePaneId: "default",
      activeTabIds: { default: "z" },
    });
    expect(readStoredPaneSelection("env-unknown")).toBeNull();
  });

  test("a second write replaces rather than duplicates an environment", () => {
    writeStoredPaneSelection("env-1", { activePaneId: "a", activeTabIds: { a: "1" } });
    writeStoredPaneSelection("env-1", { activePaneId: "b", activeTabIds: { b: "2" } });

    expect(readStoredPaneSelection("env-1")).toEqual({
      activePaneId: "b",
      activeTabIds: { b: "2" },
    });
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as {
      entries: unknown[];
    };
    expect(raw.entries).toHaveLength(1);
  });

  test("clearing removes only the named environment", () => {
    writeStoredPaneSelection("env-1", { activePaneId: "a", activeTabIds: {} });
    writeStoredPaneSelection("env-2", { activePaneId: "b", activeTabIds: {} });

    clearStoredPaneSelection("env-1");

    expect(readStoredPaneSelection("env-1")).toBeNull();
    expect(readStoredPaneSelection("env-2")).not.toBeNull();
  });

  test("clearing an absent environment does not rewrite the record", () => {
    writeStoredPaneSelection("env-1", { activePaneId: "a", activeTabIds: {} });
    const before = localStorage.getItem(STORAGE_KEY);

    clearStoredPaneSelection("env-missing");

    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
  });

  test("evicts the oldest environments past the bound", () => {
    for (let index = 0; index < 70; index += 1) {
      writeStoredPaneSelection(`env-${index}`, {
        activePaneId: "default",
        activeTabIds: { default: `tab-${index}` },
      });
    }

    // 64 is the cap, so the six oldest are gone and the newest survive.
    expect(readStoredPaneSelection("env-0")).toBeNull();
    expect(readStoredPaneSelection("env-5")).toBeNull();
    expect(readStoredPaneSelection("env-6")).not.toBeNull();
    expect(readStoredPaneSelection("env-69")).not.toBeNull();
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as {
      entries: unknown[];
    };
    expect(raw.entries).toHaveLength(64);
  });

  test("trims to stay inside the byte bound", () => {
    const wide = (seed: string) => {
      const activeTabIds: Record<string, string> = {};
      for (let index = 0; index < 200; index += 1) {
        activeTabIds[`pane-${seed}-${index}`] = `tab-${seed}-${index}`.padEnd(60, "x");
      }
      return { activePaneId: "default", activeTabIds };
    };
    for (let index = 0; index < 20; index += 1) {
      writeStoredPaneSelection(`env-${index}`, wide(String(index)));
    }

    expect(localStorage.getItem(STORAGE_KEY)!.length).toBeLessThanOrEqual(64 * 1024);
    // Whatever survives, it is the most recent write.
    expect(readStoredPaneSelection("env-19")).not.toBeNull();
    expect(readStoredPaneSelection("env-0")).toBeNull();
  });

  test("treats a corrupt or foreign record as empty rather than throwing", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(readStoredPaneSelection("env-1")).toBeNull();

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1 }));
    expect(readStoredPaneSelection("env-1")).toBeNull();

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: "nope" }));
    expect(readStoredPaneSelection("env-1")).toBeNull();

    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: [
        null,
        "entry",
        { environmentId: "", activePaneId: "a", activeTabIds: {} },
        { environmentId: "env-1", activePaneId: "", activeTabIds: {} },
        { environmentId: "env-2", activePaneId: "a", activeTabIds: "nope" },
        {
          environmentId: "env-3",
          activePaneId: "a",
          activeTabIds: { good: "tab", bad: 7, blank: "" },
        },
      ],
    }));
    expect(readStoredPaneSelection("env-1")).toBeNull();
    expect(readStoredPaneSelection("env-2")).toBeNull();
    expect(readStoredPaneSelection("env-3")).toEqual({
      activePaneId: "a",
      activeTabIds: { good: "tab" },
    });
  });

  test("degrades quietly when storage is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage is blocked");
      },
    });
    try {
      expect(() =>
        writeStoredPaneSelection("env-1", { activePaneId: "a", activeTabIds: {} })
      ).not.toThrow();
      expect(readStoredPaneSelection("env-1")).toBeNull();
      expect(() => clearStoredPaneSelection("env-1")).not.toThrow();
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      }
    }
  });

  test("survives a setItem that rejects the write", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      expect(() =>
        writeStoredPaneSelection("env-1", { activePaneId: "a", activeTabIds: {} })
      ).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  test("treats a getItem failure as an empty record", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    let attempts = 0;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          attempts += 1;
          throw new Error("SecurityError");
        },
        setItem: () => undefined,
      } as Pick<Storage, "getItem" | "setItem">,
    });
    try {
      expect(readStoredPaneSelection("env-1")).toBeNull();
      expect(() =>
        writeStoredPaneSelection("env-1", { activePaneId: "a", activeTabIds: {} })
      ).not.toThrow();
      expect(() => clearStoredPaneSelection("env-1")).not.toThrow();
      expect(attempts).toBe(3);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      }
    }
  });
});

describe("applyStoredPaneSelection", () => {
  const restored = paneState(
    split(leaf("left", ["a", "b"]), leaf("right", ["c", "d"])),
    "left",
  );

  test("re-applies a remembered pane and tab", () => {
    const applied = applyStoredPaneSelection(restored, "env-1", {
      activePaneId: "right",
      activeTabIds: { left: "b", right: "d" },
    });

    expect(applied.activePaneId).toBe("right");
    expect(applied.root).toMatchObject({
      children: [
        { id: "left", activeTabId: "b" },
        { id: "right", activeTabId: "d" },
      ],
    });
  });

  test("ignores a pane or tab the restored layout no longer contains", () => {
    // Another client closed "d" and removed the "right" pane between sessions.
    const applied = applyStoredPaneSelection(
      paneState(leaf("left", ["a", "b"]), "left"),
      "env-1",
      { activePaneId: "right", activeTabIds: { left: "gone", right: "d" } },
    );

    expect(applied.activePaneId).toBe("left");
    expect(applied.root).toMatchObject({ id: "left", activeTabId: "a" });
  });

  test("returns the layout untouched when nothing was remembered", () => {
    expect(applyStoredPaneSelection(restored, "env-1", null)).toBe(restored);
  });

  test("reads from storage when no selection is supplied", () => {
    writeStoredPaneSelection("env-1", {
      activePaneId: "right",
      activeTabIds: { right: "d" },
    });

    const applied = applyStoredPaneSelection(restored, "env-1");

    expect(applied.activePaneId).toBe("right");
    expect(applied.root).toMatchObject({
      children: [{ id: "left" }, { id: "right", activeTabId: "d" }],
    });
  });
});

describe("startPaneSelectionPersistence", () => {
  const hydrate = (environmentId: string, state: EnvironmentPaneState) => {
    usePaneLayoutStore.setState((previous) => ({
      environments: new Map(previous.environments).set(environmentId, state),
      hydration: new Map(previous.hydration).set(environmentId, "done"),
    }));
  };

  test("mirrors a selection change", () => {
    const stop = startPaneSelectionPersistence();
    hydrate("env-1", paneState(leaf("default", ["a", "b"], "a"), "default"));
    hydrate("env-1", paneState(leaf("default", ["a", "b"], "b"), "default"));
    stop();

    expect(readStoredPaneSelection("env-1")).toEqual({
      activePaneId: "default",
      activeTabIds: { default: "b" },
    });
  });

  test("does not write for a change that leaves selection alone", () => {
    const stop = startPaneSelectionPersistence();
    hydrate("env-1", paneState(leaf("default", ["a"], "a"), "default"));
    const afterFirst = localStorage.getItem(STORAGE_KEY);
    // Adding a tab without selecting it is a structural change the shared
    // backend record already covers.
    hydrate("env-1", paneState(leaf("default", ["a", "b"], "a"), "default"));
    stop();

    expect(localStorage.getItem(STORAGE_KEY)).toBe(afterFirst);
  });

  test("ignores an environment that has not finished hydrating", () => {
    const stop = startPaneSelectionPersistence();
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-1", paneState(leaf("default", ["a"], "a"), "default")],
      ]),
      hydration: new Map([["env-1", "pending"]]),
    });
    stop();

    expect(readStoredPaneSelection("env-1")).toBeNull();
  });

  test("does not re-mirror state that already existed when it started", () => {
    hydrate("env-1", paneState(leaf("default", ["a"], "a"), "default"));
    const stop = startPaneSelectionPersistence();
    // A remount must not overwrite the remembered selection with whatever the
    // store happens to hold before the user has touched anything.
    usePaneLayoutStore.setState((previous) => ({
      activeEnvironmentId: "env-1",
      environments: previous.environments,
    }));
    stop();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("stops mirroring once detached", () => {
    const stop = startPaneSelectionPersistence();
    hydrate("env-1", paneState(leaf("default", ["a", "b"], "a"), "default"));
    stop();
    hydrate("env-1", paneState(leaf("default", ["a", "b"], "b"), "default"));

    expect(readStoredPaneSelection("env-1")).toEqual({
      activePaneId: "default",
      activeTabIds: { default: "a" },
    });
  });
});
