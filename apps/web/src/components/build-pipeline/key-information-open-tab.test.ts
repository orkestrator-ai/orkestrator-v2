import { beforeEach, describe, expect, mock, test } from "bun:test";
import { appCommandScope } from "@/lib/node-scope-slots";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import type { PaneLeaf, TabInfo } from "@/types/paneLayout";
import { openKeyInformationTab } from "./key-information-open-tab";
import { appCommandStore } from "@/test/app-command-store";

const ENVIRONMENT_ID = "env-1";

function seed(tabs: TabInfo[]) {
  appCommandStore(paneLayoutStore).setState({
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
  return appCommandStore(paneLayoutStore).getState().environments.get(ENVIRONMENT_ID)!
    .root as PaneLeaf;
}

function open(
  tabs: TabInfo[],
  pipelineId: string,
  {
    maxTabs = 9,
    environmentId = ENVIRONMENT_ID,
    view,
  }: { maxTabs?: number; environmentId?: string; view?: "notes" } = {},
) {
  const addTab = mock((paneId: string, tab: TabInfo, environmentId: string) =>
    appCommandStore(paneLayoutStore).getState().addTab(paneId, tab, environmentId),
  );
  const onTabLimit = mock(() => {});
  const opened = openKeyInformationTab({
    scope: appCommandScope(),
    environmentId: ENVIRONMENT_ID,
    activePaneId: "pane-1",
    allTabs: tabs,
    maxTabs,
    target: { environmentId, pipelineId, ...(view ? { view } : {}) },
    addTab,
    onTabLimit,
  });
  return { opened, addTab, onTabLimit };
}

const buildTab: TabInfo = {
  id: "build",
  type: "claude-build",
  buildTabData: { environmentId: ENVIRONMENT_ID, pipelineId: "pipeline-1", taskId: "task-1" },
};

beforeEach(() => seed([buildTab]));

describe("openKeyInformationTab", () => {
  test("adds one key information tab for the pipeline and selects it", () => {
    const { opened, addTab } = open([buildTab], "pipeline-1");
    expect(opened).toBe(true);
    expect(addTab).toHaveBeenCalledTimes(1);
    const added = leaf().tabs.find((tab) => tab.type === "key-information")!;
    expect(added.keyInformationTabData).toEqual({
      environmentId: ENVIRONMENT_ID,
      pipelineId: "pipeline-1",
    });
    expect(leaf().activeTabId).toBe(added.id);
  });

  test("focuses the pipeline's open tab instead of adding another, even at the tab limit", () => {
    const tabs: TabInfo[] = [
      buildTab,
      {
        id: "brief",
        type: "key-information",
        keyInformationTabData: { environmentId: ENVIRONMENT_ID, pipelineId: "pipeline-1" },
      },
    ];
    seed(tabs);
    appCommandStore(paneLayoutStore).getState().setActiveTab("pane-1", "build", ENVIRONMENT_ID);
    const { opened, addTab } = open(tabs, "pipeline-1", { maxTabs: 2 });
    expect(opened).toBe(true);
    expect(addTab).not.toHaveBeenCalled();
    expect(leaf().activeTabId).toBe("brief");
  });

  test("the notes are a tab of their own, focused rather than repeated", () => {
    const brief: TabInfo = {
      id: "brief",
      type: "key-information",
      keyInformationTabData: { environmentId: ENVIRONMENT_ID, pipelineId: "pipeline-1" },
    };
    seed([buildTab, brief]);
    const first = open([buildTab, brief], "pipeline-1", { view: "notes" });
    expect(first.opened).toBe(true);
    expect(first.addTab).toHaveBeenCalledTimes(1);
    const notes = leaf().tabs.find((tab) => tab.keyInformationTabData?.view === "notes")!;
    expect(notes.keyInformationTabData).toEqual({
      environmentId: ENVIRONMENT_ID,
      pipelineId: "pipeline-1",
      view: "notes",
    });
    expect(leaf().activeTabId).toBe(notes.id);

    const tabs = leaf().tabs;
    appCommandStore(paneLayoutStore).getState().setActiveTab("pane-1", "build", ENVIRONMENT_ID);
    const again = open(tabs, "pipeline-1", { view: "notes", maxTabs: tabs.length });
    expect(again.opened).toBe(true);
    expect(again.addTab).not.toHaveBeenCalled();
    expect(leaf().activeTabId).toBe(notes.id);

    // The key information tab is still the one the plain view finds.
    open(tabs, "pipeline-1");
    expect(leaf().activeTabId).toBe("brief");
  });

  test("another pipeline is a new tab, refused at the tab limit", () => {
    const { opened, addTab, onTabLimit } = open([buildTab], "pipeline-2", { maxTabs: 1 });
    expect(opened).toBe(false);
    expect(addTab).not.toHaveBeenCalled();
    expect(onTabLimit).toHaveBeenCalledTimes(1);
  });

  test("refuses a pipeline from another environment", () => {
    const { opened, addTab } = open([buildTab], "pipeline-1", { environmentId: "env-2" });
    expect(opened).toBe(false);
    expect(addTab).not.toHaveBeenCalled();
  });
});
