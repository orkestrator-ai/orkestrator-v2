import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import {
  focusedCoordinatorConversationId,
  reconcileCoordinatorLayout,
  revealCoordinatorConversation,
  type CoordinatorPaneLayout,
} from "@/lib/coordinator-pane-layout";
import { useNodeScope } from "@/lib/node-scope/providers";
import {
  coordinatorPaneLayoutStore,
  selectCoordinatorPaneLayout,
  selectCoordinatorPaneLayoutReady,
  selectCoordinatorPaneLayoutStatus,
  useCoordinatorPaneLayoutStore,
} from "@/stores/coordinatorPaneLayoutStore";
import { useScopeBackend } from "@/hooks/useScopeBackend";

interface UseCoordinatorSelectionOptions {
  projectId: string;
  snapshot: CoordinatorSnapshot | null;
  /** The open conversations, in tab order. */
  conversationIds: string[];
  setSnapshot: (snapshot: CoordinatorSnapshot) => void;
  invalidateView: () => void;
  setError: (error: string | null) => void;
}

/** The panel's tab groups, and which conversation the backend has selected. */
export function useCoordinatorSelection({
  projectId,
  snapshot,
  conversationIds,
  setSnapshot,
  invalidateView,
  setError,
}: UseCoordinatorSelectionOptions) {
  const nodeBackend = useScopeBackend();
  const conversationIdsRef = useRef(conversationIds);
  // This node's tab groups (plan item 3011).
  const paneLayouts = useNodeScope().store(coordinatorPaneLayoutStore);
  /*
   * Tab groups. The layout is stored by the backend per project so every
   * client shows the same groups, and is presentation over the backend's open
   * conversations: reconciling adds conversations no group holds yet to the
   * focused group and drops closed ones, so it never decides what is open.
   * Nothing is reconciled before the first snapshot and the stored layout are
   * both read, which would otherwise read as "every conversation closed" (or
   * "no layout") and discard the remembered one. A read that failed is not
   * ready either (to-do 5000, retired): `layoutStatus` says so, and the panel
   * shows that instead of groups.
   */
  const storedLayout = useCoordinatorPaneLayoutStore(selectCoordinatorPaneLayout(projectId));
  const storedLayoutReady = useCoordinatorPaneLayoutStore(
    selectCoordinatorPaneLayoutReady(projectId),
  );
  const layoutStatus = useCoordinatorPaneLayoutStore(selectCoordinatorPaneLayoutStatus(projectId));
  const setStoredLayout = useCoordinatorPaneLayoutStore((state) => state.setLayout);
  const retryLayout = useCallback(() => {
    void paneLayouts.getState().retry(projectId);
  }, [paneLayouts, projectId]);
  useEffect(() => {
    void paneLayouts.getState().hydrate(projectId);
  }, [paneLayouts, projectId]);
  const layout = useMemo(
    () =>
      snapshot && storedLayoutReady
        ? reconcileCoordinatorLayout(storedLayout, conversationIds)
        : null,
    [conversationIds, snapshot, storedLayout, storedLayoutReady],
  );
  const layoutRef = useRef(layout);
  // Before the effects and handlers below read them.
  useLayoutEffect(() => {
    conversationIdsRef.current = conversationIds;
    layoutRef.current = layout;
  });
  const updateLayout = useCallback(
    (change: (layout: CoordinatorPaneLayout) => CoordinatorPaneLayout) => {
      const current = selectCoordinatorPaneLayout(projectId)(paneLayouts.getState());
      if (!current && !layoutRef.current) return;
      setStoredLayout(
        projectId,
        change(
          reconcileCoordinatorLayout(current ?? layoutRef.current, conversationIdsRef.current),
        ),
      );
    },
    [paneLayouts, projectId, setStoredLayout],
  );
  const backendSelectedId = snapshot?.workspace.selectedConversationId ?? null;
  useEffect(() => {
    if (layout && layout !== storedLayout) setStoredLayout(projectId, layout);
  }, [layout, projectId, setStoredLayout, storedLayout]);
  // Selection intent outlives an individual request. Serialize writes so an
  // older answer (or its reconciliation read) cannot reveal a superseded pane.
  const selectionRef = useRef<{
    projectId: string;
    desired: string | null;
    pending: boolean;
    live: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    const selection = { projectId, desired: null as string | null, pending: false, live: true };
    selectionRef.current = selection;
    return () => {
      selection.live = false;
    };
  }, [projectId]);
  useEffect(() => {
    const selection = selectionRef.current;
    if (!selection || selection.pending) return;
    if (backendSelectedId) {
      updateLayout((current) => revealCoordinatorConversation(current, backendSelectedId));
    }
  }, [backendSelectedId, snapshot, updateLayout]);
  const selectConversation = useCallback(
    (conversationId: string) => {
      const selection = selectionRef.current;
      if (!selection || selection.projectId !== projectId) return;
      selection.desired = conversationId;
      if (selection.pending) return;
      selection.pending = true;
      setError(null);
      void (async () => {
        while (selection.live && selection.desired !== null) {
          const requested = selection.desired;
          try {
            const next = await nodeBackend.selectCoordinatorConversation(projectId, requested);
            if (!selection.live) return;
            if (selection.desired === requested) {
              setSnapshot(next);
              updateLayout((current) => revealCoordinatorConversation(current, requested));
              selection.desired = null;
            }
          } catch (cause) {
            if (!selection.live) return;
            if (selection.desired !== requested) continue;
            selection.desired = null;
            setError(cause instanceof Error ? cause.message : "Could not select conversation");
            invalidateView();
            break;
          }
        }
        selection.pending = false;
      })();
    },
    [invalidateView, projectId, setError, setSnapshot, updateLayout, nodeBackend],
  );
  /**
   * Applies a layout change, then keeps the backend's selection on the
   * conversation in the focused group. That selection is what the header, the
   * pause check, and the next visit follow.
   */
  const changeLayout = useCallback(
    (change: (layout: CoordinatorPaneLayout) => CoordinatorPaneLayout) => {
      updateLayout(change);
      const current = selectCoordinatorPaneLayout(projectId)(paneLayouts.getState());
      const focused = current ? focusedCoordinatorConversationId(current) : null;
      if (focused && focused !== (selectionRef.current?.desired ?? backendSelectedId)) {
        selectConversation(focused);
      }
    },
    [backendSelectedId, paneLayouts, projectId, selectConversation, updateLayout],
  );
  const selectionPending = useCallback(() => selectionRef.current?.pending === true, []);
  return {
    layout,
    layoutStatus,
    retryLayout,
    backendSelectedId,
    updateLayout,
    changeLayout,
    selectConversation,
    selectionPending,
  };
}
