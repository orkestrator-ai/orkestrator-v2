import type { TabInfo } from "@/types/paneLayout";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { createUniqueTabId } from "@/components/terminal/TerminalContainer.helpers";
import { decideDesignOpen, type DesignPlacement, type DesignTabLike } from "./design-open";

/**
 * Applies a design-open decision to the pane store. A canvas already shown in
 * any pane is focused rather than duplicated; that is resolved before the tab
 * limit and split depth because focusing adds nothing. A new tab never
 * bypasses MAX_TABS, and an adjacent split falls back to the current pane at
 * maximum depth.
 */
export function openDesignCanvasTab(options: {
  environmentId: string;
  canvasId: string | undefined;
  placement: DesignPlacement | undefined;
  requestedTabId: string | undefined;
  allTabs: readonly DesignTabLike[];
  activePaneId: string;
  maxTabs: number;
  addTab: (paneId: string, tab: TabInfo, environmentId: string) => void;
  onTabLimit: () => void;
}): boolean {
  const { environmentId, canvasId } = options;
  const layoutStore = usePaneLayoutStore.getState();
  if (!canvasId || layoutStore.hydration.get(environmentId) !== "done") return false;
  const currentPaneId =
    layoutStore.environments.get(environmentId)?.activePaneId ?? options.activePaneId;
  const decision = decideDesignOpen(canvasId, options.placement ?? "split", {
    tabs: options.allTabs,
    maxTabs: options.maxTabs,
    canSplit: layoutStore.canAddTabInSplit(currentPaneId, environmentId),
    hasCurrentPane: Boolean(layoutStore.getPane(currentPaneId, environmentId)),
  });
  if (decision.kind === "focus") {
    const pane = layoutStore.findPaneWithTab(decision.tabId, environmentId);
    if (!pane) return false;
    layoutStore.setActivePane(pane.id, environmentId);
    layoutStore.setActiveTab(pane.id, decision.tabId, environmentId);
    return true;
  }
  if (decision.kind === "refuse") {
    if (decision.reason === "tab-limit") options.onTabLimit();
    return false;
  }
  const designTabId = options.requestedTabId?.trim() || createUniqueTabId("design");
  if (options.allTabs.some((tab) => tab.id === designTabId)) {
    console.warn("[design] Refusing duplicate tab ID:", designTabId);
    return false;
  }
  const newTab: TabInfo = {
    id: designTabId,
    type: "design-canvas",
    designCanvasData: { canvasId },
  };
  if (decision.placement === "split")
    return layoutStore.addTabInSplit(currentPaneId, newTab, environmentId);
  options.addTab(currentPaneId, newTab, environmentId);
  return Boolean(usePaneLayoutStore.getState().findPaneWithTab(designTabId, environmentId));
}
