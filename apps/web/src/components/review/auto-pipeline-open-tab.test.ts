import { expect, test } from "bun:test";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { TabInfo } from "@/types/paneLayout";
import { openAutoPipelineTab } from "./auto-pipeline-open-tab";

/** A scope whose pane layout knows one pane, `pane-1`, holding the tabs given. */
function harness(options: { paneHolds?: string[]; maxTabs?: number; allTabs?: TabInfo[] } = {}) {
  const calls: string[] = [];
  const added: TabInfo[] = [];
  const store = {
    findPaneWithTab: (tabId: string) =>
      (options.paneHolds ?? []).includes(tabId) ? { id: "pane-1" } : null,
    setActivePane: (paneId: string) => calls.push(`pane:${paneId}`),
    setActiveTab: (paneId: string, tabId: string) => calls.push(`tab:${paneId}:${tabId}`),
  };
  const scope = { store: () => ({ getState: () => store }) } as unknown as NodeScope;
  let limited = 0;
  const open = (target: { sourceTabId: string; sourceLabel?: string }) =>
    openAutoPipelineTab({
      scope,
      environmentId: "env",
      activePaneId: "active-pane",
      allTabs: options.allTabs ?? [],
      maxTabs: options.maxTabs ?? 10,
      target,
      addTab: (_paneId, tab) => added.push(tab),
      onTabLimit: () => {
        limited += 1;
      },
    });
  return { open, calls, added, limitedCount: () => limited };
}

const existing: TabInfo = {
  id: "auto-1",
  type: "auto-pipeline",
  autoPipelineData: { sourceTabId: "source" },
};

test("opening the same source again focuses its tab, even at the tab limit", () => {
  const view = harness({ paneHolds: ["auto-1"], maxTabs: 1, allTabs: [existing] });
  expect(view.open({ sourceTabId: "source" })).toBe(true);
  expect(view.calls).toEqual(["pane:pane-1", "tab:pane-1:auto-1"]);
  expect(view.added).toHaveLength(0);
  expect(view.limitedCount()).toBe(0);
});

test("an open tab whose pane cannot be found reports that nothing opened", () => {
  const view = harness({ allTabs: [existing] });
  expect(view.open({ sourceTabId: "source" })).toBe(false);
  expect(view.calls).toHaveLength(0);
  expect(view.added).toHaveLength(0);
});

test("a new source at the tab limit is refused and reported", () => {
  const view = harness({ maxTabs: 1, allTabs: [existing] });
  expect(view.open({ sourceTabId: "other" })).toBe(false);
  expect(view.limitedCount()).toBe(1);
  expect(view.added).toHaveLength(0);
});

test("a new source opens a tab in the active pane with a trimmed, bounded label", () => {
  const view = harness();
  expect(view.open({ sourceTabId: "source", sourceLabel: `  ${"x".repeat(300)}  ` })).toBe(true);
  expect(view.added).toHaveLength(1);
  expect(view.added[0]!.type).toBe("auto-pipeline");
  expect(view.added[0]!.autoPipelineData).toEqual({
    sourceTabId: "source",
    sourceLabel: "x".repeat(200),
  });
  const blank = harness();
  blank.open({ sourceTabId: "source", sourceLabel: "   " });
  expect(blank.added[0]!.autoPipelineData).toEqual({ sourceTabId: "source" });
});
