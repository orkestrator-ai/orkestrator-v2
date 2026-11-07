import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { isMultiReviewTerminalPhase } from "@orkestrator/protocol/multi-review";
import { toast } from "sonner";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { multiReviewStore, usePaneLayoutStore, useFileDirtyStore } from "@/stores";
import { useNodeScope } from "@/lib/node-scope/providers";
import type { PaneLeaf } from "@/types/paneLayout";
import { createDraggableTabId, getNativeAgentData, parseDraggableTabId } from "@/types/paneLayout";
import { cn, createSessionKey } from "@/lib/utils";
import {
  discardFileDraft,
  getFileDraftRevisionState,
  releaseFileDraftRevisionState,
  resolveFileDraftDiscardConflict,
} from "@/lib/file-draft-persistence";
import {
  composeDraftKey,
  discardComposeDraft,
  DraftRevisionConflictError,
  resolveComposeDraftDiscardConflict,
} from "@/lib/compose-draft-persistence";
import { DraggableTab } from "./DraggableTab";
import { TabLaunchPlaceholder, useEnvironmentTabLaunches } from "./TabLaunchShimmer";
import { moveTabFocus, TAB_STRIP_CLASS } from "./TabShell";
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
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { useScopeBackend } from "@/hooks/useScopeBackend";

const log = createLogger("web.pane-layout");

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
  const nodeBackend = useScopeBackend();
  const removeTab = usePaneLayoutStore((state) => state.removeTab);
  const multiReviews = useNodeScope().store(multiReviewStore);
  const launches = useEnvironmentTabLaunches(environmentId);
  // A launch lands in the focused pane, so its placeholder sits there too.
  const placeholders = isPaneFocused ? launches.filter((launch) => !launch.arrived) : [];
  const placeholderHasFocus = placeholders.some((launch) => launch.focused);
  const isDirty = useFileDirtyStore((state) => state.isDirty);
  const clearDirty = useFileDirtyStore((state) => state.clearDirty);
  // The node this pane's file drafts are kept on.
  const draftScope = useNodeScope();

  const discardTabDraft = useCallback(
    (tabId: string): Promise<void> => {
      const tab = pane.tabs.find((candidate) => candidate.id === tabId);
      if (tab?.type === "file" && tab.fileData?.filePath) {
        const filePath = tab.fileData.filePath;
        const revisionState = getFileDraftRevisionState(tabId, draftScope);
        return discardFileDraft(environmentId, filePath, revisionState, draftScope)
          .then(() => {
            releaseFileDraftRevisionState(tabId, draftScope);
          })
          .catch((error) => {
            if (error instanceof DraftRevisionConflictError) {
              toast.error("File draft changed in another window", {
                id: `file-draft-close-conflict:${tabId}`,
                description:
                  "The tab stayed open. Discard the newer saved draft explicitly, then close it again.",
                action: {
                  label: "Discard saved draft",
                  onClick: () => {
                    void resolveFileDraftDiscardConflict(
                      environmentId,
                      filePath,
                      revisionState,
                      draftScope,
                    )
                      .then(() => {
                        releaseFileDraftRevisionState(tabId, draftScope);
                      })
                      .catch((retryError) => {
                        log.warn("draft.file-conflict-resolve-failed", {
                          environmentId,
                          tabId,
                          error: formatLogError(retryError),
                        });
                        toast.error("The saved draft changed again. Try discarding it once more.");
                      });
                  },
                },
              });
            }
            throw error;
          });
      }
      const platform = tab ? getNativeAgentData(tab)?.platform : undefined;
      const namespace =
        platform === "claude" ||
        platform === "codex" ||
        platform === "opencode" ||
        platform === "pi"
          ? platform
          : null;
      if (!namespace) return Promise.resolve();
      const sessionKey = createSessionKey(environmentId, tabId);
      const draftKey = composeDraftKey(namespace, environmentId, sessionKey);
      return discardComposeDraft(draftKey).catch((error) => {
        if (error instanceof DraftRevisionConflictError) {
          toast.error("Draft changed in another window", {
            id: `compose-draft-close-conflict:${tabId}`,
            description:
              "The tab stayed open. Discard the newer saved draft explicitly, then close it again.",
            action: {
              label: "Discard saved draft",
              onClick: () => {
                void resolveComposeDraftDiscardConflict(draftKey).catch((retryError) => {
                  log.warn("draft.compose-conflict-resolve-failed", {
                    environmentId,
                    tabId,
                    error: formatLogError(retryError),
                  });
                  toast.error("The saved draft changed again. Try discarding it once more.");
                });
              },
            },
          });
        }
        throw error;
      });
    },
    [draftScope, environmentId, pane.tabs],
  );

  // State for unsaved changes confirmation dialog
  const [pendingCloseTabIds, setPendingCloseTabIds] = useState<string[]>([]);
  const [pendingCloseTabNames, setPendingCloseTabNames] = useState<string[]>([]);

  // Create sortable IDs for all tabs in this pane
  // When a tab from another pane is being dragged over this pane,
  // include it in the sortable items so dnd-kit can show visual feedback
  const sortableIds = useMemo(() => {
    const ids: string[] = pane.tabs.map((tab) => createDraggableTabId(tab.id, pane.id));

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

  const closeParentMultiReviews = useCallback(
    async (tabIds: string[]): Promise<Set<string>> => {
      const parents = tabIds.flatMap((tabId) => {
        const tab = pane.tabs.find((candidate) => candidate.id === tabId);
        const data = tab?.multiReviewTabData;
        return tab?.type === "multi-review" && data && !data.reviewerId
          ? [{ tabId, workflowId: data.workflowId }]
          : [];
      });
      const failedTabIds = new Set<string>();
      for (const { tabId, workflowId } of parents) {
        const phase = multiReviews.getState().workflows.get(workflowId)?.phase;
        // Active, failed, and not-yet-hydrated reviews remain backend-owned when
        // hidden. The launcher can reattach them, preserving background work.
        if (!phase || !isMultiReviewTerminalPhase(phase)) continue;
        try {
          await nodeBackend.deleteMultiReviewWorkflow(workflowId);
          multiReviews.getState().removeWorkflow(workflowId);
        } catch (error) {
          failedTabIds.add(tabId);
          toast.error("Could not close Multi Review", {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return failedTabIds;
    },
    [multiReviews, pane.tabs, nodeBackend],
  );

  const isRefreshableAgentTab = useCallback(
    (type: PaneLeaf["tabs"][number]["type"]) =>
      type === "agent-native" ||
      type === "claude-tmux" ||
      type === "multi-review" ||
      type === "browser",
    [],
  );

  const keyboardClosedTabRef = useRef<{ tabId: string; index: number } | null>(null);

  const closeTabs = useCallback(
    async (tabIds: string[]) => {
      const uniqueTabIds = Array.from(new Set(tabIds));
      const idsInPane = uniqueTabIds.filter((tabId) => pane.tabs.some((tab) => tab.id === tabId));

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

      try {
        await Promise.all(idsInPane.map(discardTabDraft));
      } catch (error) {
        keyboardClosedTabRef.current = null;
        log.warn("draft.discard-failed", {
          environmentId,
          tabCount: idsInPane.length,
          error: formatLogError(error),
        });
        return;
      }

      const becameDirty = idsInPane.filter((tabId) => isDirty(tabId));
      if (becameDirty.length > 0) {
        setPendingCloseTabIds(idsInPane);
        setPendingCloseTabNames(
          becameDirty.map((tabId) => {
            const dirtyTab = pane.tabs.find((tab) => tab.id === tabId);
            return dirtyTab?.fileData?.filePath.split("/").pop() ?? "file";
          }),
        );
        return;
      }

      const failedTabIds = await closeParentMultiReviews(idsInPane);
      if (keyboardClosedTabRef.current && failedTabIds.has(keyboardClosedTabRef.current.tabId)) {
        keyboardClosedTabRef.current = null;
      }
      const closableTabIds = idsInPane.filter((tabId) => !failedTabIds.has(tabId));

      for (let i = closableTabIds.length - 1; i >= 0; i--) {
        clearDirty(closableTabIds[i]!);
        removeTab(pane.id, closableTabIds[i]!, environmentId);
      }
    },
    [
      clearDirty,
      closeParentMultiReviews,
      discardTabDraft,
      environmentId,
      pane.id,
      pane.tabs,
      removeTab,
      isDirty,
    ],
  );

  const handleClose = useCallback(
    (tabId: string) => {
      closeTabs([tabId]);
    },
    [closeTabs],
  );

  // Closing a tab from the keyboard removes the element holding focus. Focus
  // goes to the tab now in its place rather than falling back to the page.
  const stripRef = useRef<HTMLDivElement>(null);
  const handleKeyboardClose = useCallback(
    (tabId: string) => {
      keyboardClosedTabRef.current = {
        tabId,
        index: pane.tabs.findIndex((tab) => tab.id === tabId),
      };
      closeTabs([tabId]);
    },
    [closeTabs, pane.tabs],
  );
  const restoreKeyboardCloseFocus = useCallback(
    (dialogDismissed = false) => {
      const closed = keyboardClosedTabRef.current;
      if (!closed || pane.tabs.some((tab) => tab.id === closed.tabId)) return;
      // The dialog owns focus until its close autofocus lifecycle runs.
      if (pendingCloseTabIds.length > 0 && !dialogDismissed) return;
      const active = document.activeElement;
      if (active?.closest('[role="alertdialog"]') && !dialogDismissed) return;
      keyboardClosedTabRef.current = null;
      // A surface that took focus for itself, such as a terminal, keeps it.
      if (active && active !== document.body && !active.closest('[role="alertdialog"]')) return;
      const tabs = stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
      tabs?.[Math.min(closed.index, tabs.length - 1)]?.focus();
    },
    [pane.tabs, pendingCloseTabIds.length],
  );
  useEffect(() => restoreKeyboardCloseFocus(), [restoreKeyboardCloseFocus]);

  const handleCloseAll = useCallback(() => {
    closeTabs(pane.tabs.map((tab) => tab.id));
  }, [closeTabs, pane.tabs]);

  const handleCloseOthers = useCallback(
    (tabId: string) => {
      closeTabs(pane.tabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id));
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

  const handleConfirmClose = useCallback(async () => {
    if (pendingCloseTabIds.length === 0) {
      return;
    }
    const confirmedTabIds = pendingCloseTabIds;

    try {
      await Promise.all(confirmedTabIds.map(discardTabDraft));
    } catch (error) {
      keyboardClosedTabRef.current = null;
      setPendingCloseTabIds([]);
      setPendingCloseTabNames([]);
      log.warn("draft.discard-failed", {
        environmentId,
        tabCount: confirmedTabIds.length,
        error: formatLogError(error),
      });
      return;
    }

    const failedTabIds = await closeParentMultiReviews(confirmedTabIds);
    if (keyboardClosedTabRef.current && failedTabIds.has(keyboardClosedTabRef.current.tabId)) {
      keyboardClosedTabRef.current = null;
    }
    const closableTabIds = confirmedTabIds.filter((tabId) => !failedTabIds.has(tabId));

    for (const tabId of closableTabIds) {
      clearDirty(tabId);
    }

    for (let i = closableTabIds.length - 1; i >= 0; i--) {
      removeTab(pane.id, closableTabIds[i]!, environmentId);
    }
    setPendingCloseTabIds([]);
    setPendingCloseTabNames([]);
  }, [
    clearDirty,
    closeParentMultiReviews,
    discardTabDraft,
    environmentId,
    pendingCloseTabIds,
    pane.id,
    removeTab,
  ]);

  const handleCancelClose = useCallback(() => {
    keyboardClosedTabRef.current = null;
    setPendingCloseTabIds([]);
    setPendingCloseTabNames([]);
  }, []);

  // Always show tab bar when there's at least one tab (even for single-tab panes).
  // This provides a consistent drag-drop target for cross-pane tab moves and
  // makes it clear which pane is which. Only hide when truly empty.
  if (pane.tabs.length === 0 && placeholders.length === 0) {
    return null;
  }

  return (
    <>
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Environment tabs"
        aria-orientation="horizontal"
        // During a keyboard drag the arrow keys move the tab, not focus.
        onKeyDown={activeDragId ? undefined : moveTabFocus}
        className={cn(
          // The rule below the row is the same declaration the action bar uses
          // above it, so the tab strip is bounded by one hairline on each side
          // rather than two that only look alike.
          TAB_STRIP_CLASS,
          isDropTarget && "bg-primary/10",
        )}
      >
        <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
          {pane.tabs.map((tab, index) => {
            const isActive = tab.id === pane.activeTabId && !placeholderHasFocus;
            return (
              <DraggableTab
                key={tab.id}
                tab={tab}
                environmentId={environmentId}
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
                onKeyboardClose={() => handleKeyboardClose(tab.id)}
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
        {placeholders.map((launch) => (
          <TabLaunchPlaceholder
            key={launch.tabId}
            environmentId={environmentId}
            paneId={pane.id}
            launch={launch}
            isPaneFocused={isPaneFocused}
          />
        ))}
      </div>

      {/* Confirmation dialog for closing tabs with unsaved changes */}
      <AlertDialog
        open={pendingCloseTabIds.length > 0}
        onOpenChange={(open) => !open && handleCancelClose()}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            if (
              keyboardClosedTabRef.current &&
              !pane.tabs.some((tab) => tab.id === keyboardClosedTabRef.current?.tabId)
            ) {
              event.preventDefault();
              restoreKeyboardCloseFocus(true);
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes in {pendingCloseTabLabel}. Are you sure you want to close
              these tabs without saving? Your changes will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelClose}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleConfirmClose();
              }}
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
