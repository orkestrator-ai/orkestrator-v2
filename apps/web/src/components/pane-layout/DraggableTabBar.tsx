import { useMemo, useState, useCallback } from "react";
import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { usePaneLayoutStore, useFileDirtyStore } from "@/stores";
import type { PaneLeaf } from "@/types/paneLayout";
import { createDraggableTabId, parseDraggableTabId } from "@/types/paneLayout";
import { cn } from "@/lib/utils";
import { DraggableTab } from "./DraggableTab";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface DraggableTabBarProps {
  pane: PaneLeaf;
  environmentId: string;
  onTabSelect: (tabId: string) => void;
  onTabRefresh?: (tabId: string) => void;
  isDropTarget?: boolean;
  /** Currently dragged tab ID (for cross-pane visual feedback) */
  activeDragId?: string | null;
  /** Pane ID currently being dragged over */
  dragOverPaneId?: string | null;
  /** Whether this pane is the focused pane */
  isPaneFocused?: boolean;
}

export function DraggableTabBar({
  pane,
  environmentId,
  onTabSelect,
  onTabRefresh,
  isDropTarget = false,
  activeDragId,
  dragOverPaneId,
  isPaneFocused = false,
}: DraggableTabBarProps) {
  const { removeTab } = usePaneLayoutStore();
  const { isDirty, clearDirty } = useFileDirtyStore();

  // State for unsaved changes confirmation dialog
  const [pendingCloseTabIds, setPendingCloseTabIds] = useState<string[]>([]);
  const [pendingCloseTabNames, setPendingCloseTabNames] = useState<string[]>(
    [],
  );

  // Create sortable IDs for all tabs in this pane
  // When a tab from another pane is being dragged over this pane,
  // include it in the sortable items so dnd-kit can show visual feedback
  const sortableIds = useMemo(() => {
    const ids: string[] = pane.tabs.map((tab) =>
      createDraggableTabId(tab.id, pane.id),
    );

    // If a tab from another pane is being dragged over this pane, add it to the list
    if (activeDragId && dragOverPaneId === pane.id) {
      const draggedTab = parseDraggableTabId(activeDragId);
      // Only add if it's from a different pane (cross-pane drag)
      if (draggedTab && draggedTab.paneId !== pane.id) {
        ids.push(activeDragId);
      }
    }

    return ids;
  }, [pane.tabs, pane.id, activeDragId, dragOverPaneId]);

  // All tabs can be closed
  const canClose = true;

  const isRefreshableAgentTab = useCallback(
    (type: PaneLeaf["tabs"][number]["type"]) =>
      type === "claude-native" ||
      type === "codex-native" ||
      type === "opencode-native" ||
      type === "claude-tmux" ||
      type === "browser",
    [],
  );

  const closeTabs = useCallback(
    (tabIds: string[]) => {
      const uniqueTabIds = Array.from(new Set(tabIds));
      const idsInPane = uniqueTabIds.filter((tabId) =>
        pane.tabs.some((tab) => tab.id === tabId),
      );

      if (idsInPane.length === 0) {
        return;
      }

      // If any file tabs are dirty, confirm before closing any of the selected tabs.
      const dirtyFileIds = idsInPane.filter((tabId) => {
        const tab = pane.tabs.find((t) => t.id === tabId);
        return tab?.type === "file" && isDirty(tabId);
      });

      if (dirtyFileIds.length > 0) {
        setPendingCloseTabIds(idsInPane);
        setPendingCloseTabNames(
          dirtyFileIds.map((tabId) => {
            const dirtyTab = pane.tabs.find((tab) => tab.id === tabId);
            return dirtyTab?.fileData?.filePath.split("/").pop() ?? "file";
          }),
        );
        return;
      }

      for (let i = idsInPane.length - 1; i >= 0; i--) {
        removeTab(pane.id, idsInPane[i]!, environmentId);
      }
    },
    [environmentId, pane.id, pane.tabs, removeTab, isDirty],
  );

  const handleClose = useCallback(
    (tabId: string) => {
      closeTabs([tabId]);
    },
    [closeTabs],
  );

  const handleCloseAll = useCallback(() => {
    closeTabs(pane.tabs.map((tab) => tab.id));
  }, [closeTabs, pane.tabs]);

  const handleCloseOthers = useCallback(
    (tabId: string) => {
      closeTabs(
        pane.tabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id),
      );
    },
    [closeTabs, pane.tabs],
  );

  const handleCloseToRight = useCallback(
    (tabId: string) => {
      const index = pane.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return;
      closeTabs(pane.tabs.slice(index + 1).map((tab) => tab.id));
    },
    [closeTabs, pane.tabs],
  );

  const pendingCloseTabLabel = useMemo(() => {
    if (pendingCloseTabNames.length === 1) {
      return pendingCloseTabNames[0];
    }
    return `${pendingCloseTabNames.length} files`;
  }, [pendingCloseTabNames]);

  const handleConfirmClose = useCallback(() => {
    if (pendingCloseTabIds.length === 0) {
      return;
    }

    for (const tabId of pendingCloseTabIds) {
      clearDirty(tabId);
    }

    for (let i = pendingCloseTabIds.length - 1; i >= 0; i--) {
      removeTab(pane.id, pendingCloseTabIds[i]!, environmentId);
    }

    setPendingCloseTabIds([]);
    setPendingCloseTabNames([]);
  }, [environmentId, pendingCloseTabIds, pane.id, clearDirty, removeTab]);

  const handleCancelClose = useCallback(() => {
    setPendingCloseTabIds([]);
    setPendingCloseTabNames([]);
  }, []);

  // Always show tab bar when there's at least one tab (even for single-tab panes).
  // This provides a consistent drag-drop target for cross-pane tab moves and
  // makes it clear which pane is which. Only hide when truly empty.
  if (pane.tabs.length === 0) {
    return null;
  }

  return (
    <>
      <div
        className={cn(
          "flex min-h-[40px] items-center gap-0.5 overflow-x-auto bg-background [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:min-h-[32px]",
          isDropTarget && "bg-primary/10",
        )}
      >
        <SortableContext
          items={sortableIds}
          strategy={horizontalListSortingStrategy}
        >
          {pane.tabs.map((tab, index) => {
            const isActive = tab.id === pane.activeTabId;
            return (
              <DraggableTab
                key={tab.id}
                tab={tab}
                paneId={pane.id}
                index={index}
                isActive={isActive}
                isFocused={isActive && isPaneFocused}
                onSelect={() => onTabSelect(tab.id)}
                onRefresh={
                  onTabRefresh && isRefreshableAgentTab(tab.type)
                    ? () => onTabRefresh(tab.id)
                    : undefined
                }
                onClose={() => handleClose(tab.id)}
                onCloseAll={() => handleCloseAll()}
                onCloseOthers={() => handleCloseOthers(tab.id)}
                onCloseToRight={() => handleCloseToRight(tab.id)}
                canClose={canClose}
                canCloseAll={pane.tabs.length > 1}
                canCloseOthers={pane.tabs.length > 1}
                canCloseToRight={index < pane.tabs.length - 1}
              />
            );
          })}
        </SortableContext>
      </div>

      {/* Confirmation dialog for closing tabs with unsaved changes */}
      <AlertDialog
        open={pendingCloseTabIds.length > 0}
        onOpenChange={(open) => !open && handleCancelClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes in {pendingCloseTabLabel}. Are you sure
              you want to close these tabs without saving? Your changes will be
              lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelClose}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmClose}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Close Without Saving
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
