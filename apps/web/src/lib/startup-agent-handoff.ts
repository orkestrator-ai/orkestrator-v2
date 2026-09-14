import type { PaneLeaf } from "@/types/paneLayout";

/** Stable id shared by every renderer materialising the one-shot startup agent. */
export const STARTUP_AGENT_TAB_ID = "startup-agent";

/**
 * Same ready-for-handoff predicate the backend uses before activating the
 * startup agent. Prompt-less launches never mint a provider session, so this
 * is the durable boundary that setup has finished and the agent tab can take
 * focus.
 */
export function environmentIsReadyForSetupHandoff(
  environment:
    | {
        setupPhase?: string;
        setupScriptsComplete?: boolean;
        setupOverride?: boolean;
      }
    | null
    | undefined,
): boolean {
  if (!environment) return false;
  return (
    environment.setupPhase === "ready" ||
    environment.setupScriptsComplete === true ||
    environment.setupOverride === true
  );
}

/** True when a pane is still showing the setup terminal, or nothing valid. */
export function paneSelectionIsSetupHandoffSource(leaf: PaneLeaf | null): boolean {
  if (!leaf) return false;
  const selected = leaf.tabs.find((tab) => tab.id === leaf.activeTabId);
  return !selected || selected.isSetupTab === true;
}
