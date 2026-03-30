import { memo, useCallback, useRef, useLayoutEffect } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useShallow } from "zustand/react/shallow";
import { usePaneLayoutStore, useEnvironmentStore, useConfigStore } from "@/stores";
import { useTerminalPortalStore, createTerminalKey } from "@/stores/terminalPortalStore";
import type { PaneLeaf } from "@/types/paneLayout";
import { createTabbarDroppableId } from "@/types/paneLayout";
import { cn } from "@/lib/utils";
import { FileViewerTab } from "@/components/terminal/FileViewerTab";
import { OpenCodeChatTab } from "@/components/opencode";
import { ClaudeChatTab } from "@/components/claude/ClaudeChatTab";
import { CodexChatTab } from "@/components/codex";
import { BuildChatTab } from "@/components/build-pipeline";
import { DraggableTabBar } from "./DraggableTabBar";
import { DropZoneOverlay } from "./DropZoneOverlay";

interface PaneLeafContainerProps {
  pane: PaneLeaf;
  containerId: string | null;
  environmentId: string;
  isActive: boolean;
  /** Currently dragged tab ID (for cross-pane visual feedback) */
  activeDragId?: string | null;
  /** Pane ID currently being dragged over */
  dragOverPaneId?: string | null;
}

export const PaneLeafContainer = memo(function PaneLeafContainer({
  pane,
  containerId: _containerId,
  environmentId,
  isActive,
  activeDragId,
  dragOverPaneId,
}: PaneLeafContainerProps) {
  // Use selectors to only subscribe to the specific values we need
  // This prevents re-renders when other parts of the store change
  const { setActivePane, setActiveTab, environments, activeEnvironmentId } = usePaneLayoutStore(
    useShallow((state) => ({
      setActivePane: state.setActivePane,
      setActiveTab: state.setActiveTab,
      environments: state.environments,
      activeEnvironmentId: state.activeEnvironmentId,
    }))
  );

  // Derive activePaneId from current environment state
  const currentEnvState = activeEnvironmentId ? environments.get(activeEnvironmentId) : null;
  const activePaneId = currentEnvState?.activePaneId ?? "default";
  const containerRef = useRef<HTMLDivElement>(null);

  // Read target branch reactively from config store (not stale tab data)
  const projectId = useEnvironmentStore((state) => state.getEnvironmentById(environmentId)?.projectId);
  const repositories = useConfigStore((state) => state.config.repositories);
  const targetBranch = projectId ? (repositories[projectId]?.prBaseBranch || "main") : "main";

  // Set up droppable for tabbar
  const { setNodeRef, isOver } = useDroppable({
    id: createTabbarDroppableId(pane.id),
  });

  // Pane host for terminal rendering (tab targets are moved here)
  const portalHostRef = useRef<HTMLDivElement>(null);
  const { registerPaneHost, unregisterPaneHost } = useTerminalPortalStore(
    useShallow((state) => ({
      registerPaneHost: state.registerPaneHost,
      unregisterPaneHost: state.unregisterPaneHost,
    }))
  );
  const terminals = useTerminalPortalStore((state) => state.terminals);

  // Register this pane's content area as a terminal host
  useLayoutEffect(() => {
    const host = portalHostRef.current;
    if (!host) return;

    registerPaneHost(environmentId, pane.id, host);

    return () => {
      unregisterPaneHost(environmentId, pane.id);
    };
  }, [environmentId, pane.id, registerPaneHost, unregisterPaneHost]);

  // Keep terminal portal elements attached to this pane host
  useLayoutEffect(() => {
    const host = portalHostRef.current;
    if (!host) return;

    // Collect portal elements for this pane's terminal tabs
    const portalElements: HTMLDivElement[] = [];
    for (const tab of pane.tabs) {
      // Skip non-terminal tabs (file and native agent tabs render directly)
      if (
        tab.type === "file"
        || tab.type === "opencode-native"
        || tab.type === "claude-native"
        || tab.type === "codex-native"
        || tab.type === "claude-build"
      ) {
        continue;
      }
      const terminalKey = createTerminalKey(environmentId, tab.id);
      const terminalData = terminals.get(terminalKey);
      if (terminalData?.portalElement) {
        portalElements.push(terminalData.portalElement);
      }
    }

    // Ensure host contains exactly these portals (preserve existing to avoid unnecessary DOM churn)
    const existing = Array.from(host.children) as HTMLElement[];
    const existingSet = new Set(existing);

    // Remove stale children
    for (const child of existing) {
      if (!portalElements.includes(child as HTMLDivElement)) {
        host.removeChild(child);
      }
    }

    // Append missing portals
    for (const portalElement of portalElements) {
      if (!existingSet.has(portalElement)) {
        host.appendChild(portalElement);
      }
    }
  }, [pane.tabs, terminals, environmentId]);

  // Handle clicking on the pane to focus it
  const handlePaneClick = useCallback(() => {
    if (activePaneId !== pane.id) {
      setActivePane(pane.id);
    }
  }, [activePaneId, pane.id, setActivePane]);

  // Handle tab selection
  const handleTabSelect = useCallback(
    (tabId: string) => {
      setActiveTab(pane.id, tabId);
    },
    [pane.id, setActiveTab]
  );

  // Check if this pane is focused (active in the layout)
  const isPaneFocused = activePaneId === pane.id;

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden bg-background",
        isPaneFocused && "ring-1 ring-primary/20"
      )}
      onClick={handlePaneClick}
    >
      {/* Tab bar */}
      <div ref={setNodeRef}>
        <DraggableTabBar
          pane={pane}
          onTabSelect={handleTabSelect}
          isDropTarget={isOver}
          activeDragId={activeDragId}
          dragOverPaneId={dragOverPaneId}
          isPaneFocused={isPaneFocused}
        />
      </div>

      {/* Tab content */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* Portal target for terminal rendering - terminals render here via TerminalPortalHost */}
        <div ref={portalHostRef} className="absolute inset-0 pointer-events-none" />

        {/* File and OpenCode native tabs render directly (no portal needed) */}
        {pane.tabs.map((tab) => {
          const isTabActive = tab.id === pane.activeTabId;

          // File viewer tabs
          if (tab.type === "file" && tab.fileData) {
            return (
              <FileViewerTab
                key={tab.id}
                tabId={tab.id}
                filePath={tab.fileData.filePath}
                containerId={tab.fileData.containerId}
                worktreePath={tab.fileData.worktreePath}
                isLocalEnvironment={tab.fileData.isLocalEnvironment}
                isActive={isTabActive && isActive}
                language={tab.fileData.language}
                isDiff={tab.fileData.isDiff}
                gitStatus={tab.fileData.gitStatus}
                baseBranch={tab.fileData.isDiff ? targetBranch : tab.fileData.baseBranch}
              />
            );
          }

          // OpenCode native chat tabs
          if (tab.type === "opencode-native" && tab.openCodeNativeData) {
            return (
              <div
                key={tab.id}
                className={cn(
                  "absolute inset-0",
                  isTabActive && isActive ? "z-10 pointer-events-auto" : "hidden"
                )}
              >
                <OpenCodeChatTab
                  tabId={tab.id}
                  data={tab.openCodeNativeData}
                  isActive={isTabActive && isActive}
                  initialPrompt={tab.initialPrompt}
                />
              </div>
            );
          }

          // Claude native chat tabs
          if (tab.type === "claude-native" && tab.claudeNativeData) {
            return (
              <div
                key={tab.id}
                className={cn(
                  "absolute inset-0",
                  isTabActive && isActive ? "z-10 pointer-events-auto" : "hidden"
                )}
              >
                <ClaudeChatTab
                  tabId={tab.id}
                  data={tab.claudeNativeData}
                  isActive={isTabActive && isActive}
                  initialPrompt={tab.initialPrompt}
                />
              </div>
            );
          }

          // Codex native chat tabs
          if (tab.type === "codex-native" && tab.codexNativeData) {
            return (
              <div
                key={tab.id}
                className={cn(
                  "absolute inset-0",
                  isTabActive && isActive ? "z-10 pointer-events-auto" : "hidden"
                )}
              >
                <CodexChatTab
                  tabId={tab.id}
                  data={tab.codexNativeData}
                  isActive={isTabActive && isActive}
                  initialPrompt={tab.initialPrompt}
                />
              </div>
            );
          }

          // Build pipeline tabs
          if (tab.type === "claude-build" && tab.buildTabData) {
            return (
              <div
                key={tab.id}
                className={cn(
                  "absolute inset-0",
                  isTabActive && isActive ? "z-10 pointer-events-auto" : "hidden"
                )}
              >
                <BuildChatTab
                  data={tab.buildTabData}
                  isActive={isTabActive && isActive}
                />
              </div>
            );
          }

          // Terminal tabs are rendered via portals from TerminalPortalHost
          return null;
        })}

        {/* Drop zone overlay for edge splits */}
        <DropZoneOverlay paneId={pane.id} />
      </div>
    </div>
  );
});
