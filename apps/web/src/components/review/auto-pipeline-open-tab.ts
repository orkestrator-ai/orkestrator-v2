import { createUniqueTabId } from "@/components/terminal/TerminalContainer.helpers";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import type { AutoPipelineTabData, TabInfo } from "@/types/paneLayout";

/**
 * Opens the Auto-pipeline tab for one source agent tab. There is one tab per
 * source: opening it again focuses that tab rather than counting a new one, so
 * it is resolved before the tab limit. Kept free of the tab view's own
 * modules, which load lazily. The layout is `scope`'s node's.
 */
export function openAutoPipelineTab(options: {
  scope: NodeScope;
  environmentId: string;
  activePaneId: string;
  allTabs: readonly Pick<TabInfo, "id" | "type" | "autoPipelineData">[];
  maxTabs: number;
  target: AutoPipelineTabData;
  addTab: (paneId: string, tab: TabInfo, environmentId: string) => void;
  onTabLimit: () => void;
}): boolean {
  const { environmentId, target } = options;
  const store = options.scope.store(paneLayoutStore).getState();
  const openTab = options.allTabs.find(
    (tab) =>
      tab.type === "auto-pipeline" && tab.autoPipelineData?.sourceTabId === target.sourceTabId,
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
      id: createUniqueTabId("auto-pipeline"),
      type: "auto-pipeline",
      autoPipelineData: {
        sourceTabId: target.sourceTabId,
        ...(target.sourceLabel?.trim()
          ? { sourceLabel: target.sourceLabel.trim().slice(0, 200) }
          : {}),
      },
    },
    environmentId,
  );
  return true;
}
