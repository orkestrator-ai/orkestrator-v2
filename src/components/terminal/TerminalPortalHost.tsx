import { memo, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { usePaneLayoutStore, getAllLeaves } from "@/stores/paneLayoutStore";
import { useConfigStore, useEnvironmentStore } from "@/stores";
import { useTerminalPortalStore } from "@/stores/terminalPortalStore";
import { PersistentTerminal } from "./PersistentTerminal";
import type { TabInfo, PaneLeaf } from "@/types/paneLayout";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_SCROLLBACK,
  resolveTerminalBackgroundColor,
} from "@/constants/terminal";

// Default fallback for environments not yet in the store
const DEFAULT_ROOT: PaneLeaf = { kind: "leaf", id: "default", tabs: [], activeTabId: null };

interface TerminalPortalHostProps {
  containerId: string | null;
  environmentId: string;
}

/**
 * Centralized host for all terminal instances using React portals.
 *
 * This component:
 * 1. Tracks all terminal tabs across all panes
 * 2. Creates/disposes xterm.js Terminal instances as tabs are added/removed
 * 3. Renders each terminal via portal into its current pane's content area
 *
 * Benefits:
 * - Terminals stay alive when tabs move between panes (no destroy/recreate)
 * - Instant tab moves without buffer serialization overhead
 * - Preserves scroll position, selection, cursor position during moves
 */
export const TerminalPortalHost = memo(function TerminalPortalHost({
  containerId,
  environmentId,
}: TerminalPortalHostProps) {
  // Get pane layout state for THIS environment (not the globally active one)
  // This is critical: each TerminalPortalHost must use its own environment's tabs,
  // otherwise all environments would share the same terminal tab structure
  const { environments, activeEnvironmentId } = usePaneLayoutStore(
    useShallow((state) => ({
      environments: state.environments,
      activeEnvironmentId: state.activeEnvironmentId,
    }))
  );

  // Get THIS environment's root and active pane (not the global active environment's)
  const currentEnvState = environments.get(environmentId);
  const root = currentEnvState?.root ?? DEFAULT_ROOT;
  const activePaneId = currentEnvState?.activePaneId ?? "default";

  // Get terminal store functions
  const {
    terminals,
    createTerminal,
    disposeTerminal,
    hasTerminal,
  } = useTerminalPortalStore();

  // Get workspace ready setter from environment store
  const setWorkspaceReady = useEnvironmentStore((state) => state.setWorkspaceReady);

  const terminalAppearance = useConfigStore(
    (state) => state.config.global.terminalAppearance
  ) || DEFAULT_TERMINAL_APPEARANCE;
  const terminalScrollback = useConfigStore(
    (state) => state.config.global.terminalScrollback
  ) ?? DEFAULT_TERMINAL_SCROLLBACK;
  const terminalAppearanceResolved = useMemo(
    () => ({
      ...terminalAppearance,
      backgroundColor: resolveTerminalBackgroundColor(
        terminalAppearance.backgroundColor,
      ),
    }),
    [terminalAppearance]
  );

  // Handle workspace ready callback - fires when any terminal becomes ready
  // Always set the state to true - this ensures the state is updated even if it was
  // reset to false by TerminalContainer for a new container startup
  const handleWorkspaceReady = useCallback(() => {
    console.log("[TerminalPortalHost] handleWorkspaceReady called - setting workspace ready for environment:", environmentId);
    setWorkspaceReady(environmentId, true);
  }, [environmentId, setWorkspaceReady]);

  // Build a map of tabId -> paneId for all terminal tabs
  // Memoize to prevent new Map on every render
  const leaves = getAllLeaves(root);
  const terminalTabsMap = useMemo(() => {
    const map = new Map<string, { tab: TabInfo; paneId: string }>();
    for (const leaf of leaves) {
      for (const tab of leaf.tabs) {
        // Only handle terminal tabs (not file tabs)
        if (tab.type !== "file") {
          map.set(tab.id, { tab, paneId: leaf.id });
        }
      }
    }
    return map;
  }, [leaves]);

  // Create a stable key for terminalTabsMap to use in dependencies
  // This prevents unnecessary effect runs while still reacting to actual changes
  const terminalTabsKey = useMemo(() => {
    return Array.from(terminalTabsMap.entries())
      .map(([id, info]) => `${id}:${info.paneId}`)
      .sort()
      .join(",");
  }, [terminalTabsMap]);

  // Create terminals for new tabs, dispose terminals for removed tabs
  useEffect(() => {
    // Skip if no active environment
    if (!activeEnvironmentId) return;

    // Create terminals for new tabs
    for (const [tabId] of terminalTabsMap) {
      if (!hasTerminal(environmentId, tabId)) {
        console.debug("[TerminalPortalHost] Creating terminal for tab:", tabId, "in env:", environmentId);
        createTerminal({
          tabId,
          containerId,
          environmentId,
          appearance: terminalAppearanceResolved,
          scrollback: terminalScrollback,
        });
      }
    }

    // Dispose terminals for removed tabs (only check terminals in this environment)
    for (const [, terminalData] of terminals) {
      // Only consider terminals belonging to this environment
      if (terminalData.environmentId !== environmentId) continue;

      if (!terminalTabsMap.has(terminalData.tabId)) {
        console.debug("[TerminalPortalHost] Disposing terminal for removed tab:", terminalData.tabId, "in env:", environmentId);
        disposeTerminal(environmentId, terminalData.tabId);
      }
    }
  }, [
    activeEnvironmentId,
    containerId,
    environmentId,
    terminalTabsKey, // Use stable key instead of Map reference
    terminalTabsMap, // Still need the map for the logic
    terminals,
    hasTerminal,
    createTerminal,
    disposeTerminal,
    terminalAppearanceResolved,
    terminalScrollback,
  ]);


  // Render terminals via portals (only for this environment)
  const portalElements: React.ReactNode[] = [];

  for (const [, terminalData] of terminals) {
    // Only render terminals belonging to this environment
    if (terminalData.environmentId !== environmentId) continue;

    const tabId = terminalData.tabId;
    const tabInfo = terminalTabsMap.get(tabId);
    if (!tabInfo) {
      continue;
    }

    const { tab, paneId } = tabInfo;
    const portalTarget = terminalData.portalElement;

    // Get the active tab for this pane to determine visibility
    const paneLeaf = leaves.find((l) => l.id === paneId);
    const isActive = paneLeaf?.activeTabId === tabId;
    // Terminal is focused if it's the active tab in the active pane of the ACTIVE environment.
    // This prevents clipboard paste handlers from firing across multiple environments.
    const isFocused = isActive && paneId === activePaneId && environmentId === activeEnvironmentId;

    portalElements.push(
      createPortal(
        <PersistentTerminal
          key={`${environmentId}::${tabId}`}
          terminalData={terminalData}
          tabId={tabId}
          tabType={tab.type}
          containerId={containerId}
          environmentId={environmentId}
          isEnvironmentVisible={environmentId === activeEnvironmentId}
          isActive={isActive}
          isFocused={isFocused}
          isFirstTab={tabId === "default" && paneId === "default"}
          initialPrompt={tab.initialPrompt}
          initialCommands={tab.initialCommands}
          paneId={paneId}
          onReady={handleWorkspaceReady}
        />,
        portalTarget,
        `terminal-portal-${environmentId}::${tabId}`
      )
    );
  }

  // Return fragment with all portals
  return <>{portalElements}</>;
});
