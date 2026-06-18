import { memo, useCallback, useRef, useLayoutEffect } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useShallow } from "zustand/react/shallow";
import { usePaneLayoutStore, useEnvironmentStore, useConfigStore } from "@/stores";
import { useTerminalPortalStore } from "@/stores/terminalPortalStore";
import type { PaneLeaf } from "@/types/paneLayout";
import { createTabbarDroppableId } from "@/types/paneLayout";
import { cn } from "@/lib/utils";
import { FileViewerTab } from "@/components/terminal/FileViewerTab";
import { OpenCodeChatTab } from "@/components/opencode";
import { ClaudeChatTab } from "@/components/claude/ClaudeChatTab";
import { ClaudeTmuxChatTab } from "@/components/claude/ClaudeTmuxChatTab";
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
  const { setActivePane, setActiveTab, environments } = usePaneLayoutStore(
    useShallow((state) => ({
      setActivePane: state.setActivePane,
      setActiveTab: state.setActiveTab,
      environments: state.environments,
    }))
  );

  // Derive activePaneId from current environment state
  const currentEnvState = environments.get(environmentId);
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

  // Register this pane's content area as a terminal host
  useLayoutEffect(() => {
    const host = portalHostRef.current;
    if (!host) return;

    registerPaneHost(environmentId, pane.id, host);

    return () => {
      unregisterPaneHost(environmentId, pane.id);
    };
  }, [environmentId, pane.id, registerPaneHost, unregisterPaneHost]);

  // Handle clicking on the pane to focus it
  const handlePaneClick = useCallback(() => {
    if (activePaneId !== pane.id) {
      setActivePane(pane.id, environmentId);
    }
  }, [activePaneId, environmentId, pane.id, setActivePane]);

  // Handle tab selection
  const handleTabSelect = useCallback(
    (tabId: string) => {
      setActiveTab(pane.id, tabId, environmentId);
    },
    [environmentId, pane.id, setActiveTab]
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
          environmentId={environmentId}
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
                  isReviewTab={tab.isReviewTab}
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
                  isReviewTab={tab.isReviewTab}
                />
              </div>
            );
          }

          // Claude tmux chat tabs
          if (tab.type === "claude-tmux" && tab.claudeTmuxData) {
            return (
              <div
                key={tab.id}
                className={cn(
                  "absolute inset-0",
                  isTabActive && isActive ? "z-10 pointer-events-auto" : "hidden"
                )}
              >
                <ClaudeTmuxChatTab
                  tabId={tab.id}
                  data={tab.claudeTmuxData}
                  isActive={isTabActive && isActive}
                  initialPrompt={tab.initialPrompt}
                  isReviewTab={tab.isReviewTab}
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
                  isReviewTab={tab.isReviewTab}
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
