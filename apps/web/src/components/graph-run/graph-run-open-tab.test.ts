import { beforeEach, describe, expect, mock, test } from "bun:test";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { PaneLeaf, TabInfo } from "@/types/paneLayout";
import { openGraphRunTab } from "./graph-run-open-tab";

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

function open(tabs: TabInfo[], runId: string, maxTabs = 9) {
  const addTab = mock((paneId: string, tab: TabInfo, environmentId: string) =>
    usePaneLayoutStore.getState().addTab(paneId, tab, environmentId),
  );
  const onTabLimit = mock(() => {});
  const opened = openGraphRunTab({
    environmentId: ENVIRONMENT_ID,
    activePaneId: "pane-1",
    allTabs: tabs,
    maxTabs,
    run: { runId, title: " Multi Review " },
    addTab,
    onTabLimit,
  });
  return { opened, addTab, onTabLimit };
}

beforeEach(() => seed([{ id: "terminal", type: "plain" }]));

describe("openGraphRunTab", () => {
  test("adds one tab per run, titled with the run's name", () => {
    const { opened, addTab } = open([{ id: "terminal", type: "plain" }], "run-1");
    expect(opened).toBe(true);
    expect(addTab).toHaveBeenCalledTimes(1);
    const added = leaf().tabs.find((tab) => tab.type === "graph-run")!;
    expect(added.graphRunData).toEqual({ runId: "run-1", title: "Multi Review" });
  });

  test("focuses the run's open tab instead of adding another", () => {
    const tabs: TabInfo[] = [
      { id: "terminal", type: "plain" },
      { id: "run-tab", type: "graph-run", graphRunData: { runId: "run-1" } },
    ];
    seed(tabs);
    const { opened, addTab } = open(tabs, "run-1", 2);
    expect(opened).toBe(true);
    expect(addTab).not.toHaveBeenCalled();
    expect(leaf().activeTabId).toBe("run-tab");
  });

  test("another run is a new tab, refused at the tab limit", () => {
    const tabs: TabInfo[] = [
      { id: "terminal", type: "plain" },
      { id: "run-tab", type: "graph-run", graphRunData: { runId: "run-1" } },
    ];
    seed(tabs);
    const { opened, onTabLimit } = open(tabs, "run-2", 2);
    expect(opened).toBe(false);
    expect(onTabLimit).toHaveBeenCalledTimes(1);
  });
});
