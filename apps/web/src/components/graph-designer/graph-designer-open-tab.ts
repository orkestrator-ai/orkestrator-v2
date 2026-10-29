import type { GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import { createUniqueTabId } from "@/components/terminal/TerminalContainer.helpers";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { TabInfo } from "@/types/paneLayout";

/**
 * Opens the Graphs designer in an environment. There is one designer tab per
 * environment: opening it again focuses that tab (and shows `template` when
 * one is given) rather than counting a new tab, so it is resolved before the
 * tab limit. Kept free of the designer's own modules, which load lazily.
 */
export function openGraphDesignerTab(options: {
  environmentId: string;
  activePaneId: string;
  allTabs: readonly Pick<TabInfo, "id" | "type">[];
  maxTabs: number;
  template?: GraphTemplateRef;
  addTab: (paneId: string, tab: TabInfo, environmentId: string) => void;
  onTabLimit: () => void;
}): boolean {
  const { environmentId } = options;
  const store = usePaneLayoutStore.getState();
  const openTab = options.allTabs.find((tab) => tab.type === "graph-designer");
  if (openTab) {
    const pane = store.findPaneWithTab(openTab.id, environmentId);
    if (!pane) return false;
    if (options.template) {
      store.updateTabGraphDesigner(openTab.id, { selected: options.template }, environmentId);
    }
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
      id: createUniqueTabId("graphs"),
      type: "graph-designer",
      graphDesignerData: options.template ? { selected: options.template } : {},
    },
    environmentId,
  );
  return true;
}
