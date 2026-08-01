import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EnvironmentPaneState } from "@/stores/paneLayoutStore";
import type { PaneNode } from "@/types/paneLayout";
import {
  applyStoredPaneSelection,
  clearStoredPaneSelection,
  readStoredPaneSelection,
} from "./pane-selection-storage";

const STORAGE_KEY = "orkestrator.pane-selection.v1";

function writeStoredPaneSelection(
  environmentId: string,
  selection: { activePaneId: string; activeTabIds: Record<string, string> },
): void {
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw ? JSON.parse(raw) as { entries?: unknown[] } : {};
  const entries = (parsed.entries ?? []).filter((entry) =>
    !!entry
    && typeof entry === "object"
    && (entry as { environmentId?: unknown }).environmentId !== environmentId
  );
  entries.push({ environmentId, ...selection });
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries }));
}

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
});

afterEach(() => {
  localStorage.clear();
});

describe("read/clear", () => {
  test("reads a legacy selection per environment", () => {
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
      expect(readStoredPaneSelection("env-1")).toBeNull();
      expect(() => clearStoredPaneSelection("env-1")).not.toThrow();
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      }
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
      expect(() => clearStoredPaneSelection("env-1")).not.toThrow();
      expect(attempts).toBe(2);
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
