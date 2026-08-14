import { lazy, memo, useCallback, useRef, useLayoutEffect, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useShallow } from "zustand/react/shallow";
import { usePaneLayoutStore, useEnvironmentStore, useConfigStore } from "@/stores";
import { useTerminalPortalStore } from "@/stores/terminalPortalStore";
import type { PaneLeaf } from "@/types/paneLayout";
import { createTabbarDroppableId, getNativeAgentData } from "@/types/paneLayout";
import { cn } from "@/lib/utils";
import { DraggableTabBar } from "./DraggableTabBar";
import { DropZoneOverlay } from "./DropZoneOverlay";
import {
  LazyLoadBoundary,
  LazyLoadInlineErrorFallback,
  type LazyLoadErrorDetails,
} from "@/components/LazyLoadBoundary";

const LazyFileViewerTab = lazy(async () => ({
  default: (await import("@/components/terminal/FileViewerTab")).FileViewerTab,
}));
const LazyAgentNativeTab = lazy(async () => ({
  default: (await import("@/components/native-agent")).AgentNativeTab,
}));
const LazyClaudeTmuxChatTab = lazy(async () => ({
  default: (await import("@/components/claude/ClaudeTmuxChatTab")).ClaudeTmuxChatTab,
}));
const LazyBuildChatTab = lazy(async () => ({
  default: (await import("@/components/build-pipeline/BuildChatTab")).BuildChatTab,
}));
const LazyLoopedReviewTab = lazy(async () => ({
  default: (await import("@/components/review/LoopedReviewTab")).LoopedReviewTab,
}));
const LazyBrowserTab = lazy(async () => ({
  default: (await import("@/components/browser/BrowserTab")).BrowserTab,
}));

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
  const [tabRefreshRequestIds, setTabRefreshRequestIds] = useState(
    () => new Map<string, number>(),
  );

  // Read the diff baseline reactively from the environment/config stores.
  const { projectId, createdFromCommit } = useEnvironmentStore(
    useShallow((state) => {
      const env = state.getEnvironmentById(environmentId);
      return { projectId: env?.projectId, createdFromCommit: env?.createdFromCommit };
    })
  );
  const repositories = useConfigStore((state) => state.config.repositories);
  const comparisonRef = createdFromCommit || (projectId ? (repositories[projectId]?.prBaseBranch || "main") : "main");

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

  const handleTabRefresh = useCallback((tabId: string) => {
    setTabRefreshRequestIds((current) => {
      const next = new Map(current);
      next.set(tabId, (current.get(tabId) ?? 0) + 1);
      return next;
    });
  }, []);

  // Check if this pane is focused (active in the layout)
  const isPaneFocused = activePaneId === pane.id;
  const renderTabFallback = useCallback((isVisible: boolean) => (
    <div
      className={cn(
        "absolute inset-0 flex items-center justify-center bg-background/80 text-muted-foreground",
        isVisible ? "z-10 pointer-events-auto" : "hidden",
      )}
    >
      Loading tab...
    </div>
  ), []);
  // A tab that is not on screen must not blank the whole application when its
  // chunk fails, so the failure surface is scoped exactly like the loading one.
  const renderTabError = useCallback(
    (isVisible: boolean) => (details: LazyLoadErrorDetails) => (
      <LazyLoadInlineErrorFallback {...details} isVisible={isVisible} />
    ),
    [],
  );

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
          onTabRefresh={handleTabRefresh}
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
              <LazyLoadBoundary
                key={tab.id}
                loadingFallback={renderTabFallback(isTabActive && isActive)}
                renderError={renderTabError(isTabActive && isActive)}
              >
                <LazyFileViewerTab
                  tabId={tab.id}
                  environmentId={environmentId}
                  filePath={tab.fileData.filePath}
                  containerId={tab.fileData.containerId}
                  worktreePath={tab.fileData.worktreePath}
                  isLocalEnvironment={tab.fileData.isLocalEnvironment}
                  isActive={isTabActive && isActive}
                  language={tab.fileData.language}
                  isDiff={tab.fileData.isDiff}
                  gitStatus={tab.fileData.gitStatus}
                  baseBranch={tab.fileData.isDiff ? comparisonRef : tab.fileData.baseBranch}
                />
              </LazyLoadBoundary>
            );
          }

          // Backend-local browser preview tabs
          if (tab.type === "browser" && tab.browserData) {
            return (
              <LazyLoadBoundary
                key={tab.id}
                loadingFallback={renderTabFallback(isTabActive && isActive)}
                renderError={renderTabError(isTabActive && isActive)}
              >
                <LazyBrowserTab
                  tabId={tab.id}
                  environmentId={environmentId}
                  data={tab.browserData}
                  isActive={isTabActive && isActive}
                  refreshRequestId={tabRefreshRequestIds.get(tab.id) ?? 0}
                />
              </LazyLoadBoundary>
            );
          }

          const nativeAgentData = getNativeAgentData(tab);
          if (nativeAgentData) {
            return (
              <div
                key={tab.id}
                className={cn(
                  "absolute inset-0",
                  isTabActive && isActive ? "z-10 pointer-events-auto" : "hidden"
                )}
              >
                <LazyLoadBoundary
                  loadingFallback={renderTabFallback(isTabActive && isActive)}
                  renderError={renderTabError(isTabActive && isActive)}
                >
                  <LazyAgentNativeTab
                    tabId={tab.id}
                    data={nativeAgentData}
                    isActive={isTabActive && isActive}
                    ownsGlobalShortcuts={isTabActive && isActive && isPaneFocused}
                    initialPrompt={tab.initialPrompt}
                    isReviewTab={tab.isReviewTab}
                    initialAgentModel={tab.initialAgentModel}
                    initialReasoningEffort={tab.initialReasoningEffort}
                    initialConversationMode={tab.initialConversationMode}
                    initialFastMode={tab.initialFastMode}
                    agentHandoffId={tab.agentHandoffId}
                    consumedAgentHandoffId={tab.consumedAgentHandoffId}
                    refreshRequestId={tabRefreshRequestIds.get(tab.id) ?? 0}
                  />
                </LazyLoadBoundary>
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
                <LazyLoadBoundary
                  loadingFallback={renderTabFallback(isTabActive && isActive)}
                  renderError={renderTabError(isTabActive && isActive)}
                >
                  <LazyClaudeTmuxChatTab
                    tabId={tab.id}
                    data={tab.claudeTmuxData}
                    isActive={isTabActive && isActive}
                    ownsGlobalShortcuts={isTabActive && isActive && isPaneFocused}
                    initialPrompt={tab.initialPrompt}
                    isReviewTab={tab.isReviewTab}
                    initialAgentModel={tab.initialAgentModel}
                    initialReasoningEffort={tab.initialReasoningEffort}
                    refreshRequestId={tabRefreshRequestIds.get(tab.id) ?? 0}
                  />
                </LazyLoadBoundary>
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
                <LazyLoadBoundary
                  loadingFallback={renderTabFallback(isTabActive && isActive)}
                  renderError={renderTabError(isTabActive && isActive)}
                >
                  <LazyBuildChatTab
                    data={tab.buildTabData}
                    isActive={isTabActive && isActive}
                    ownsGlobalShortcuts={isTabActive && isActive && isPaneFocused}
                  />
                </LazyLoadBoundary>
              </div>
            );
          }

          if (tab.type === "looped-review" && tab.loopedReviewTabData) {
            return (
              <div
                key={tab.id}
                className={cn(
                  "absolute inset-0",
                  isTabActive && isActive ? "z-10 pointer-events-auto" : "hidden",
                )}
              >
                <LazyLoadBoundary
                  loadingFallback={renderTabFallback(isTabActive && isActive)}
                  renderError={renderTabError(isTabActive && isActive)}
                >
                  <LazyLoopedReviewTab
                    data={tab.loopedReviewTabData}
                    isActive={isTabActive && isActive}
                  />
                </LazyLoadBoundary>
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
