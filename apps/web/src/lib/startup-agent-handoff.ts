import type { PaneLeaf } from "@/types/paneLayout";
import {
  isEnvironmentSetupSettled,
  type EnvironmentSetupState,
} from "@orkestrator/protocol/environment-readiness";

/** Stable id shared by every renderer materialising the one-shot startup agent. */
export const STARTUP_AGENT_TAB_ID = "startup-agent";

/**
 * The backend's setup-settled predicate (`@orkestrator/protocol/environment-readiness`),
 * which it also uses before activating the startup agent. Prompt-less launches
 * never mint a provider session, so this is the durable boundary that setup has
 * finished (or the user overrode a failure) and the agent tab can take focus.
 */
export function environmentIsReadyForSetupHandoff(
  environment: EnvironmentSetupState | null | undefined,
): boolean {
  return isEnvironmentSetupSettled(environment);
}

/** True when a pane is still showing the setup terminal, or nothing valid. */
export function paneSelectionIsSetupHandoffSource(leaf: PaneLeaf | null): boolean {
  if (!leaf) return false;
  const selected = leaf.tabs.find((tab) => tab.id === leaf.activeTabId);
  return !selected || selected.isSetupTab === true;
}
