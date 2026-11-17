import { describe, expect, test } from "bun:test";
import type { PaneLeaf, PaneNode, PaneSplit, TabInfo } from "@/types/paneLayout";
import {
  designAgentPanelSize,
  normalizeEmbeddedTabs,
  sanitizeDesignAgentPanel,
  visibleTabsOf,
  withEmbeddedTabIds,
} from "./pane-layout-embedded";

const design = (id: string): TabInfo => ({
  id,
  type: "design-canvas",
  designCanvasData: { canvasId: "00000000-0000-4000-8000-000000000001" },
});
const agent = (id: string, embeddedIn?: string): TabInfo => ({
  id,
  type: "agent-native",
  nativeAgentData: { platform: "claude", environmentId: "env" },
  ...(embeddedIn ? { embeddedIn } : {}),
});
const leaf = (id: string, tabs: TabInfo[], activeTabId = tabs[0]?.id ?? null): PaneLeaf => ({
  kind: "leaf",
  id,
  tabs,
  activeTabId,
});
const split = (first: PaneNode, second: PaneNode): PaneSplit => ({
  kind: "split",
  id: "split-1",
  direction: "horizontal",
  children: [first, second],
  sizes: [50, 50],
  depth: 1,
});

describe("normalizeEmbeddedTabs", () => {
  test("returns the same state when nothing is embedded", () => {
    const state = { root: leaf("p1", [design("d1"), agent("a1")]), activePaneId: "p1" };
    expect(normalizeEmbeddedTabs(state)).toBe(state);
  });

  test("returns the same state when the embedding already holds", () => {
    const state = { root: leaf("p1", [design("d1"), agent("a1", "d1")]), activePaneId: "p1" };
    expect(normalizeEmbeddedTabs(state)).toBe(state);
  });

  test("a pane selecting an embedded agent selects its design instead", () => {
    const state = {
      root: leaf("p1", [design("d1"), agent("a1", "d1")], "a1"),
      activePaneId: "p1",
    };
    expect((normalizeEmbeddedTabs(state).root as PaneLeaf).activeTabId).toBe("d1");
  });

  test("an agent follows its design to another pane, and the emptied pane closes", () => {
    const state = {
      root: split(leaf("p1", [agent("a1", "d1")]), leaf("p2", [agent("other"), design("d1")])),
      activePaneId: "p1",
    };
    const next = normalizeEmbeddedTabs(state);
    expect(next.root).toMatchObject({
      kind: "leaf",
      id: "p2",
      tabs: [{ id: "other" }, { id: "d1" }, { id: "a1", embeddedIn: "d1" }],
    });
    expect(next.activePaneId).toBe("p2");
  });

  test("an agent whose design is gone becomes an ordinary tab", () => {
    const state = { root: leaf("p1", [agent("a1", "missing")]), activePaneId: "p1" };
    const tab = (normalizeEmbeddedTabs(state).root as PaneLeaf).tabs[0]!;
    expect(tab.id).toBe("a1");
    expect("embeddedIn" in tab).toBe(false);
  });

  test("a design shows one agent; a second becomes an ordinary tab", () => {
    const state = {
      root: leaf("p1", [design("d1"), agent("a1", "d1"), agent("a2", "d1")]),
      activePaneId: "p1",
    };
    const tabs = (normalizeEmbeddedTabs(state).root as PaneLeaf).tabs;
    expect(tabs.map((tab) => [tab.id, tab.embeddedIn])).toEqual([
      ["d1", undefined],
      ["a1", "d1"],
      ["a2", undefined],
    ]);
  });

  test("a design is never embedded, and nothing embeds in a non-design tab", () => {
    const state = {
      root: leaf("p1", [{ ...design("d1"), embeddedIn: "d2" }, design("d2"), agent("a1", "a2")]),
      activePaneId: "p1",
    };
    const tabs = (normalizeEmbeddedTabs(state).root as PaneLeaf).tabs;
    expect(tabs.every((tab) => tab.embeddedIn === undefined)).toBe(true);
  });
});

describe("embedded tab helpers", () => {
  const tabs = [design("d1"), agent("a1", "d1"), agent("a2")];

  test("the strip shows only tabs that are not embedded", () => {
    expect(visibleTabsOf(tabs).map((tab) => tab.id)).toEqual(["d1", "a2"]);
  });

  test("closing a design also closes the agent inside it, first", () => {
    expect(withEmbeddedTabIds(tabs, ["d1"])).toEqual(["a1", "d1"]);
    expect(withEmbeddedTabIds(tabs, ["a2"])).toEqual(["a2"]);
  });

  test("panel state is restored only when well formed, with the size clamped", () => {
    expect(sanitizeDesignAgentPanel({ dock: "top", open: false, size: 99 })).toEqual({
      dock: "top",
      open: false,
      size: 80,
    });
    expect(sanitizeDesignAgentPanel({ dock: "middle", open: true })).toBeUndefined();
    expect(sanitizeDesignAgentPanel({ dock: "left" })).toBeUndefined();
    expect(sanitizeDesignAgentPanel(null)).toBeUndefined();
  });

  test("the default size depends on the dock axis", () => {
    expect(designAgentPanelSize({ dock: "left", open: true })).toBe(34);
    expect(designAgentPanelSize({ dock: "bottom", open: true })).toBe(40);
    expect(designAgentPanelSize({ dock: "right", open: true, size: 5 })).toBe(15);
  });
});
