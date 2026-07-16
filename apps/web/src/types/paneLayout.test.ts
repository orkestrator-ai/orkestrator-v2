import { describe, expect, test } from "bun:test";
import {
  MAX_SPLIT_DEPTH,
  PANE_LAYOUT_VERSION,
  createDraggableTabId,
  createEdgeDroppableId,
  createTabbarDroppableId,
  isGitFileStatus,
  isPaneLeaf,
  isPaneSplit,
  parseDraggableTabId,
  parseEdgeDroppableId,
} from "./paneLayout";

describe("pane layout runtime helpers", () => {
  test("exports supported schema and depth constants", () => {
    expect(PANE_LAYOUT_VERSION).toBe(1);
    expect(MAX_SPLIT_DEPTH).toBe(9);
  });

  test("recognizes pane node and git status variants", () => {
    const leaf = { kind: "leaf" as const, id: "pane", tabs: [], activeTabId: null };
    expect(isPaneLeaf(leaf)).toBe(true);
    expect(isPaneSplit({
      kind: "split",
      id: "split",
      direction: "horizontal",
      children: [leaf, { ...leaf, id: "pane-2" }],
      sizes: [50, 50],
      depth: 1,
    })).toBe(true);
    for (const status of ["M", "A", "D", "?", "R", "C"]) expect(isGitFileStatus(status)).toBe(true);
    for (const value of ["X", "", null, 1]) expect(isGitFileStatus(value)).toBe(false);
  });

  test("creates and parses drag identifiers", () => {
    expect(createDraggableTabId("tab-one", "pane-two")).toBe("tab:tab-one:pane:pane-two");
    expect(parseDraggableTabId("tab:tab-one:pane:pane-two")).toEqual({ tabId: "tab-one", paneId: "pane-two" });
    expect(parseDraggableTabId("not-a-tab")).toBeNull();
    expect(createEdgeDroppableId("pane:one", "left")).toBe("edge:pane:one:left");
    expect(parseEdgeDroppableId("edge:pane:one:left")).toEqual({ paneId: "pane:one", direction: "left" });
    expect(parseEdgeDroppableId("edge:pane:one:diagonal")).toBeNull();
    expect(createTabbarDroppableId("pane:one")).toBe("tabbar:pane:one");
  });
});
