import { keyInformationTabId } from "@orkestrator/protocol/pane-layout";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import type { KeyInformationTabData, TabInfo } from "@/types/paneLayout";

/**
 * Opens a build pipeline's key information or notes in its own
 * `key-information` tab. There is one tab per pipeline and view: opening it
 * again focuses that tab rather than counting a new one, so it is resolved
 * before the tab limit. Kept free of the tab view's own modules, which load
 * lazily. The layout is `scope`'s node's.
 */
export function openKeyInformationTab(options: {
  scope: NodeScope;
  environmentId: string;
  activePaneId: string;
  allTabs: readonly Pick<TabInfo, "id" | "type" | "keyInformationTabData">[];
  maxTabs: number;
  target: KeyInformationTabData;
  addTab: (paneId: string, tab: TabInfo, environmentId: string) => void;
  onTabLimit: () => void;
}): boolean {
  const { environmentId, target } = options;
  if (!target.pipelineId || target.environmentId !== environmentId) return false;
  const store = options.scope.store(paneLayoutStore).getState();
  const openTab = options.allTabs.find(
    (tab) =>
      tab.type === "key-information" &&
      tab.keyInformationTabData?.pipelineId === target.pipelineId &&
      tab.keyInformationTabData.view === target.view,
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
      // All clients opening the same logical view must merge as one tab.
      id: keyInformationTabId(environmentId, target.pipelineId, target.view),
      type: "key-information",
      keyInformationTabData: {
        environmentId,
        pipelineId: target.pipelineId,
        ...(target.view ? { view: target.view } : {}),
      },
    },
    environmentId,
  );
  return true;
}
