import { beforeEach, describe, expect, mock, test } from "bun:test";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { PaneLeaf, TabInfo } from "@/types/paneLayout";
import { openGraphDesignerTab } from "./graph-designer-open-tab";

const ENVIRONMENT_ID = "env-1";

function seed(tabs: TabInfo[]) {
  usePaneLayoutStore.setState({
    environments: new Map([
      [
        ENVIRONMENT_ID,
        {
          root: { kind: "leaf", id: "pane-1", tabs, activeTabId: tabs[0]?.id ?? null },
          activePaneId: "pane-1",
          containerId: null,
        },
      ],
    ]),
  });
}

function leaf(): PaneLeaf {
  return usePaneLayoutStore.getState().environments.get(ENVIRONMENT_ID)!.root as PaneLeaf;
}

function open(options: {
  tabs: TabInfo[];
  maxTabs?: number;
  template?: Parameters<typeof openGraphDesignerTab>[0]["template"];
}) {
  const addTab = mock((paneId: string, tab: TabInfo, environmentId: string) =>
    usePaneLayoutStore.getState().addTab(paneId, tab, environmentId),
  );
  const onTabLimit = mock(() => {});
  const opened = openGraphDesignerTab({
    environmentId: ENVIRONMENT_ID,
    activePaneId: "pane-1",
    allTabs: options.tabs,
    maxTabs: options.maxTabs ?? 9,
    ...(options.template ? { template: options.template } : {}),
    addTab,
    onTabLimit,
  });
  return { opened, addTab, onTabLimit };
}

beforeEach(() => seed([{ id: "terminal", type: "plain" }]));

describe("openGraphDesignerTab", () => {
  test("adds one Graphs tab, with the template to show when given", () => {
    const tabs: TabInfo[] = [{ id: "terminal", type: "plain" }];
    const { opened, addTab } = open({ tabs, template: { scope: "builtin", id: "multi-review" } });
    expect(opened).toBe(true);
    expect(addTab).toHaveBeenCalledTimes(1);
    const added = leaf().tabs.find((tab) => tab.type === "graph-designer")!;
    expect(added.graphDesignerData).toEqual({ selected: { scope: "builtin", id: "multi-review" } });
  });

  test("focuses the existing tab instead of adding another, and switches its template", () => {
    const designer: TabInfo = { id: "graphs", type: "graph-designer", graphDesignerData: {} };
    const tabs: TabInfo[] = [designer, { id: "terminal", type: "plain" }];
    seed(tabs);
    usePaneLayoutStore.getState().setActiveTab("pane-1", "terminal", ENVIRONMENT_ID);
    // Opening an existing tab does not count against the limit.
    const { opened, addTab, onTabLimit } = open({
      tabs,
      maxTabs: 2,
      template: { scope: "user", id: "mine" },
    });
    expect(opened).toBe(true);
    expect(addTab).not.toHaveBeenCalled();
    expect(onTabLimit).not.toHaveBeenCalled();
    expect(leaf().activeTabId).toBe("graphs");
    expect(leaf().tabs[0]!.graphDesignerData).toEqual({ selected: { scope: "user", id: "mine" } });
  });

  test("refuses a new tab at the tab limit", () => {
    const tabs: TabInfo[] = [{ id: "terminal", type: "plain" }];
    const { opened, addTab, onTabLimit } = open({ tabs, maxTabs: 1 });
    expect(opened).toBe(false);
    expect(addTab).not.toHaveBeenCalled();
    expect(onTabLimit).toHaveBeenCalledTimes(1);
  });

  test("updateTabGraphDesigner changes only Graphs tabs, and only when the data differs", () => {
    seed([
      { id: "graphs", type: "graph-designer", graphDesignerData: {} },
      { id: "terminal", type: "plain" },
    ]);
    const store = usePaneLayoutStore.getState();
    const before = store.environments;
    store.updateTabGraphDesigner(
      "terminal",
      { selected: { scope: "user", id: "x" } },
      ENVIRONMENT_ID,
    );
    expect(usePaneLayoutStore.getState().environments).toBe(before);
    store.updateTabGraphDesigner(
      "graphs",
      { selected: { scope: "user", id: "x" } },
      ENVIRONMENT_ID,
    );
    const after = usePaneLayoutStore.getState().environments;
    expect(after).not.toBe(before);
    expect(leaf().tabs[0]!.graphDesignerData).toEqual({ selected: { scope: "user", id: "x" } });
    usePaneLayoutStore
      .getState()
      .updateTabGraphDesigner("graphs", { selected: { scope: "user", id: "x" } }, ENVIRONMENT_ID);
    expect(usePaneLayoutStore.getState().environments).toBe(after);
  });
});
