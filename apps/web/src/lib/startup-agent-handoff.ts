import type { PaneLeaf } from "@/types/paneLayout";

/**
 * The startup tab's stable id and the ready-for-handoff predicate are shared
 * with the backend through the protocol, so both sides agree on them.
 */
export {
  environmentIsReadyForSetupHandoff,
  STARTUP_AGENT_TAB_ID,
} from "@orkestrator/protocol/tab-initial-prompt";

/** True when a pane is still showing the setup terminal, or nothing valid. */
export function paneSelectionIsSetupHandoffSource(leaf: PaneLeaf | null): boolean {
  if (!leaf) return false;
  const selected = leaf.tabs.find((tab) => tab.id === leaf.activeTabId);
  return !selected || selected.isSetupTab === true;
}
