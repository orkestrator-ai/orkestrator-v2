import { createUniqueTabId } from "@/components/terminal/TerminalContainer.helpers";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { GraphRunTabData, TabInfo } from "@/types/paneLayout";

/**
 * Opens a graph run in its own `graph-run` tab. There is one tab per run:
 * opening it again focuses that tab rather than counting a new one, so it is
 * resolved before the tab limit. Kept free of the run view's own modules,
 * which load lazily.
 */
export function openGraphRunTab(options: {
  environmentId: string;
  activePaneId: string;
  allTabs: readonly Pick<TabInfo, "id" | "type" | "graphRunData">[];
  maxTabs: number;
  run: GraphRunTabData;
  addTab: (paneId: string, tab: TabInfo, environmentId: string) => void;
  onTabLimit: () => void;
}): boolean {
  const { environmentId, run } = options;
  const store = usePaneLayoutStore.getState();
  const openTab = options.allTabs.find(
    (tab) => tab.type === "graph-run" && tab.graphRunData?.runId === run.runId,
  );
  if (openTab) {
    const pane = store.findPaneWithTab(openTab.id, environmentId);
    if (!pane) return false;
    store.setActivePane(pane.id, environmentId);
    store.setActiveTab(pane.id, openTab.id, environmentId);
    return true;
  }
  if (options.allTabs.length >= options.maxTabs) {
    options.onTabLimit();
    return false;
  }
  options.addTab(
    options.activePaneId,
    {
      id: createUniqueTabId("graph-run"),
      type: "graph-run",
      graphRunData: {
        runId: run.runId,
        ...(run.title?.trim() ? { title: run.title.trim().slice(0, 200) } : {}),
      },
    },
    environmentId,
  );
  return true;
}
