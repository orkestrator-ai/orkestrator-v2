import { useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import { usePanelRef } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { FilesPanel } from "@/components/files-panel";
import { DEFAULT_TERMINAL_APPEARANCE, resolveTerminalBackgroundColor } from "@/constants/terminal";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import {
  getAllLeaves,
  useConfigStore,
  useFilesPanelStore,
  usePaneLayoutStore,
  useUIStore,
} from "@/stores";
import {
  coordinatorConversationTab,
  useActiveCoordinatorConversationStore,
} from "@/stores/activeCoordinatorConversationStore";
import {
  PULL_REQUEST_PANEL_MIN_WIDTH_PX,
  PULL_REQUEST_PANEL_WIDTH_PX,
} from "@/stores/filesPanelStore";
import type { EnvironmentPaneState } from "@/stores/paneLayoutStore";
import { ActionBar } from "./ActionBar";

/** The active tab of an environment's active pane, as the store holds it. */
function selectActivePaneTab(environment: EnvironmentPaneState | undefined) {
  if (!environment) return null;
  const activePane = getAllLeaves(environment.root).find(
    (leaf) => leaf.id === environment.activePaneId,
  );
  if (!activePane?.activeTabId) return null;
  return activePane.tabs.find((tab) => tab.id === activePane.activeTabId) ?? null;
}

/** Wide enough for a pull request opened in the panel; files views stay narrow by choice. */
export const FILES_PANEL_MAX_SIZE = "960px";

/**
 * Widens a narrow files panel when it shows a pull request, once per opened
 * tab, so the user's own narrower width for files is otherwise kept.
 */
export function useFilesPanelPullRequestWidth(open: boolean) {
  const panelRef = usePanelRef();
  const activeTab = useFilesPanelStore((state) => state.activeTab);
  const showsPullRequest = open && activeTab.startsWith("pull-request:");
  useEffect(() => {
    if (!showsPullRequest) return;
    // A panel that opens with this tab registers with its group after this
    // effect runs, and reading its size before then throws. Retry for a few
    // frames; widening is cosmetic, so giving up is safe.
    let frame = 0;
    let attempts = 0;
    const widen = () => {
      const panel = panelRef.current;
      try {
        if (panel && panel.getSize().inPixels < PULL_REQUEST_PANEL_MIN_WIDTH_PX) {
          panel.resize(`${PULL_REQUEST_PANEL_WIDTH_PX}px`);
        }
        if (panel) return;
      } catch {
        // Not laid out yet.
      }
      if (++attempts < 10) frame = requestAnimationFrame(widen);
    };
    frame = requestAnimationFrame(widen);
    return () => cancelAnimationFrame(frame);
  }, [panelRef, showsPullRequest, activeTab]);
  return panelRef;
}

/**
 * The tab the nearest node's workspace has in front: its coordinator
 * conversation on a project board, else the selected environment's active
 * pane tab. Only the selected environment's tab, so a pane-layout change in
 * any other environment does not re-render the reader (WEB-7).
 */
export function useWorkspaceActiveTab() {
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const paneActiveTab = usePaneLayoutStore((state) =>
    selectedEnvironmentId
      ? selectActivePaneTab(state.environments.get(selectedEnvironmentId))
      : null,
  );
  const projectBoardTab = useUIStore((state) => state.projectBoardTab);
  const coordinatorConversation = useActiveCoordinatorConversationStore((state) => state.active);
  // The selection is this workspace's node's, so a conversation must be on it too.
  const nodeId = useScopesWithCommandFallback().scope.nodeId;
  const coordinatorTab = useMemo(
    () =>
      coordinatorConversationTab(
        coordinatorConversation,
        { nodeId, projectId: selectedProjectId },
        projectBoardTab,
      ),
    [coordinatorConversation, nodeId, selectedProjectId, projectBoardTab],
  );
  // Keep the coordinator descriptor stable when unrelated pane layouts change.
  return coordinatorTab ?? paneActiveTab;
}

/** The central panel's colours: the terminal background of the nearest node's settings. */
export function useCentralPanelThemeVars(): CSSProperties {
  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ??
    DEFAULT_TERMINAL_APPEARANCE;
  const panelBackgroundColor = resolveTerminalBackgroundColor(terminalAppearance.backgroundColor);
  return useMemo(
    () =>
      ({
        "--color-background": panelBackgroundColor,
        "--color-card": panelBackgroundColor,
        "--color-popover": panelBackgroundColor,
        "--color-muted": panelBackgroundColor,
        "--color-secondary": panelBackgroundColor,
        "--color-accent": panelBackgroundColor,
        "--color-input": panelBackgroundColor,
      }) as CSSProperties,
    [panelBackgroundColor],
  );
}

/**
 * Another node's workspace in a command node's window, below the window's
 * title bar and beside its sidebar: its toolbar, `main`, and its files
 * panel. `InTreeWorkspace` draws it inside the node's scope; the window's
 * title bar shows the node's meters and agent button (`ShownNodeTitleBar`).
 */
export function NodeWorkspaceLayout({
  main,
  filesPanelOpen,
  phone,
}: {
  main: ReactNode;
  /** The window's one files panel state for every machine. */
  filesPanelOpen: boolean;
  /** The phone layout, where the files panel is the window's own sheet and not drawn here. */
  phone: boolean;
}) {
  const centralPanelThemeVars = useCentralPanelThemeVars();
  const filesPanelRef = useFilesPanelPullRequestWidth(filesPanelOpen);
  return (
    <>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={filesPanelOpen ? 70 : 100} minSize={30}>
          <div className="flex h-full flex-col" style={centralPanelThemeVars}>
            <ActionBar />
            <main className="min-h-0 flex-1 overflow-hidden bg-background">{main}</main>
          </div>
        </ResizablePanel>
        {filesPanelOpen && !phone && (
          <>
            <ResizableHandle />
            <ResizablePanel
              defaultSize={30}
              minSize="240px"
              maxSize={FILES_PANEL_MAX_SIZE}
              panelRef={filesPanelRef}
            >
              <FilesPanel />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </>
  );
}
