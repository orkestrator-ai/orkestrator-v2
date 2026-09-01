import { memo, useLayoutEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { usePaneLayoutStore, getAllLeaves } from "@/stores/paneLayoutStore";
import { useConfigStore } from "@/stores";
import { createPortalTargetKey, useTerminalPortalStore } from "@/stores/terminalPortalStore";
import { PersistentTerminal } from "./PersistentTerminal";
import type { TabInfo, PaneLeaf } from "@/types/paneLayout";
import type { TerminalTabType } from "@/contexts";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_SCROLLBACK,
  resolveTerminalBackgroundColor,
} from "@/constants/terminal";

// Terminal tab types that need PersistentTerminal instances.
// Using an allowlist ensures new non-terminal TabType variants don't accidentally spawn PTY sessions.
const TERMINAL_TAB_TYPES: ReadonlySet<string> = new Set<TerminalTabType>([
  "plain",
  "claude",
  "opencode",
  "codex",
  "cursor",
  "grok",
  "pi",
  "root",
]);

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
  // otherwise all environments would share the same terminal tab structure.
  // The per-environment record has a stable reference, so selecting it directly
  // avoids rerendering this host when other environments' layouts change.
  const currentEnvState = usePaneLayoutStore((state) => state.environments.get(environmentId));
  const activeEnvironmentId = usePaneLayoutStore((state) => state.activeEnvironmentId);

  // Get THIS environment's root and active pane (not the global active environment's)
  const root = currentEnvState?.root ?? DEFAULT_ROOT;
  const activePaneId = currentEnvState?.activePaneId ?? "default";

  // Both maps participate in rendering. In particular, a pane host can mount
  // after its terminal already exists; selecting only the stable getter would
  // leave that terminal detached until an unrelated terminal mutation.
  const terminals = useTerminalPortalStore((state) => state.terminals);
  const paneHosts = useTerminalPortalStore((state) => state.paneHosts);

  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ||
    DEFAULT_TERMINAL_APPEARANCE;
  const terminalScrollback =
    useConfigStore((state) => state.config.global.terminalScrollback) ??
    DEFAULT_TERMINAL_SCROLLBACK;
  const terminalAppearanceResolved = useMemo(
    () => ({
      ...terminalAppearance,
      backgroundColor: resolveTerminalBackgroundColor(terminalAppearance.backgroundColor),
    }),
    [terminalAppearance],
  );

  // Build a map of tabId -> paneId for all terminal tabs
  // Memoize to prevent new Map on every render. getAllLeaves must be memoized
  // too: a fresh leaves array each render invalidated the map memo below and
  // defeated the stable-key design entirely.
  const leaves = useMemo(() => getAllLeaves(root), [root]);
  const terminalTabsMap = useMemo(() => {
    const map = new Map<string, { tab: TabInfo; paneId: string }>();
    for (const leaf of leaves) {
      for (const tab of leaf.tabs) {
        // Only handle terminal tabs — native agent and file tabs are rendered
        // directly by PaneLeafContainer; creating PersistentTerminals for them
        // would spawn unnecessary PTY sessions and useAgentState polling.
        if (TERMINAL_TAB_TYPES.has(tab.type)) {
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

  // Create terminals for new tabs, dispose terminals for removed tabs.
  // Deliberately keyed on the stable `terminalTabsKey` rather than the map or
  // the terminals Map: the create/dispose pass reads the freshest store state
  // via getState(), and its own writes must not retrigger the effect.
  useLayoutEffect(() => {
    const store = useTerminalPortalStore.getState();

    // Create terminals for new tabs
    for (const [tabId] of terminalTabsMap) {
      if (!store.hasTerminal(environmentId, tabId)) {
        console.debug(
          "[TerminalPortalHost] Creating terminal for tab:",
          tabId,
          "in env:",
          environmentId,
        );
        store.createTerminal({
          tabId,
          containerId,
          environmentId,
          appearance: terminalAppearanceResolved,
          scrollback: terminalScrollback,
        });
      }
    }

    // Dispose terminals for removed tabs (only check terminals in this environment)
    for (const [, terminalData] of store.terminals) {
      // Only consider terminals belonging to this environment
      if (terminalData.environmentId !== environmentId) continue;

      if (!terminalTabsMap.has(terminalData.tabId)) {
        console.debug(
          "[TerminalPortalHost] Disposing terminal for removed tab:",
          terminalData.tabId,
          "in env:",
          environmentId,
        );
        store.disposeTerminal(environmentId, terminalData.tabId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- terminalTabsMap is derived 1:1 from terminalTabsKey
  }, [
    containerId,
    environmentId,
    terminalTabsKey, // Stable key stands in for terminalTabsMap
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
    const portalTarget = paneHosts.get(createPortalTargetKey(environmentId, paneId));
    if (!portalTarget) {
      continue;
    }

    // Get the active tab for this pane to determine visibility
    const paneLeaf = leaves.find((l) => l.id === paneId);
    const isActive = paneLeaf?.activeTabId === tabId;
    // Terminal is focused if it's the active tab in the active pane of the ACTIVE environment.
    // This prevents clipboard paste handlers from firing across multiple environments.
    const isFocused = isActive && paneId === activePaneId && environmentId === activeEnvironmentId;

    portalElements.push(
      createPortal(
        <div
          className={`absolute inset-0 ${isActive ? "pointer-events-auto" : "pointer-events-none"}`}
        >
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
            isReviewTab={tab.isReviewTab}
            initialAgentModel={tab.initialAgentModel}
            initialReasoningEffort={tab.initialReasoningEffort}
            paneId={paneId}
            isSetupTab={tab.isSetupTab}
            backendManagedTerminal={tab.backendManagedTerminal}
          />
        </div>,
        portalTarget,
        `terminal-portal-${environmentId}::${tabId}`,
      ),
    );
  }

  // Return fragment with all portals
  return <>{portalElements}</>;
});
