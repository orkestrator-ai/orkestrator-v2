import type { PaneLeaf } from "@/types/paneLayout";

/** Stable id shared by every renderer materialising the one-shot startup agent. */
export const STARTUP_AGENT_TAB_ID = "startup-agent";

/** True when a pane is still showing the setup terminal, or nothing valid. */
export function paneSelectionIsSetupHandoffSource(leaf: PaneLeaf | null): boolean {
  if (!leaf) return false;
  const selected = leaf.tabs.find((tab) => tab.id === leaf.activeTabId);
  return !selected || selected.isSetupTab === true;
}
