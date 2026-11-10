import { flushSync } from "react-dom";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, Pause, Play, Plus, RotateCcw } from "lucide-react";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { useCoordinatorActions } from "./useCoordinatorActions";
import { useCoordinatorActiveTurn } from "./useCoordinatorActiveTurn";
import { useCoordinatorGitActions } from "./useCoordinatorGitActions";
import { useCoordinatorLaunches } from "./useCoordinatorLaunches";
import { useCoordinatorSelection } from "./useCoordinatorSelection";
import { useCoordinatorPanelData } from "./useCoordinatorPanelData";
import { CoordinatorConversationPane } from "./CoordinatorConversationPane";
import { CoordinatorToolbar } from "./CoordinatorToolbar";
import { CoordinatorWorkerPrompts } from "./CoordinatorWorkerPrompts";
import { ProjectCheckoutNotice } from "./ProjectCheckoutNotice";
import { useProjectCheckout } from "./useProjectCheckout";
import { coordinatorPaneLayoutStore } from "@/stores/coordinatorPaneLayoutStore";
import {
  COORDINATOR_SIDE_AGENT_EXPLANATION,
  COORDINATOR_TIER_LABELS,
  COORDINATOR_TIER_MEANINGS,
  CoordinatorActionAlert,
  CoordinatorBanner,
  coordinatorReadOnlyTier,
} from "./CoordinatorPanelNotices";
import type { AgentPlatformBadge } from "@/components/chat/AgentModelPicker";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { CoordinatorPaneTree } from "./CoordinatorPaneTree";
import { CoordinatorConversationTab } from "./CoordinatorConversationTab";
import { isCoordinatorTurnPhaseActive } from "@/lib/coordinator-active-turn";
import {
  collectCoordinatorLeaves,
  focusCoordinatorPane,
  focusedCoordinatorConversationId,
} from "@/lib/coordinator-pane-layout";
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
import { Button } from "@/components/ui/button";
import {
  FLOATING_NOTICE_ACTION,
  FloatingNoticeAnchor,
  FloatingNoticeLayer,
} from "@/components/ui/floating-notice";
import { useNodeScope, useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { createSessionKey } from "@/lib/utils";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { nativeComposeStore } from "@/stores/nativeComposeStore";
import { useActiveCoordinatorConversationStore } from "@/stores/activeCoordinatorConversationStore";
import { unusedCoordinatorConversationIds } from "@/lib/coordinator-unused-conversations";
import { CoordinatorPullRequestWatchProvider } from "@/lib/coordinator-pull-request-watch";
import { useScopeBackend } from "@/hooks/useScopeBackend";

interface CoordinatorPanelProps {
  projectId: string;
}

export function CoordinatorPanel({ projectId }: CoordinatorPanelProps) {
  const nodeBackend = useScopeBackend();
  // The project is on the node of the scope this page renders in.
  const nodeId = useScopesWithCommandFallback().scope.nodeId;
  // This node's coordinator tab groups (plan item 3011).
  const paneLayouts = useNodeScope().store(coordinatorPaneLayoutStore);
  // The same node's compose drafts (plan item 3013).
  const composeDrafts = useNodeScope().store(nativeComposeStore);
  // Read from this node's own project list: a project id is per node.
  const checkout = useProjectCheckout(projectId);
  const {
    snapshot,
    git,
    loading,
    error: loadError,
    clearError: clearLoadError,
    freshness,
    load,
    applySnapshot: setSnapshot,
    applyGit: setGit,
    invalidateView,
    refreshView,
  } = useCoordinatorPanelData(projectId);
  const {
    runAction,
    actionError,
    setActionError: setError,
    gitBusy,
    fetching,
    conversationBusy,
  } = useCoordinatorActions();
  // Closing the main conversation is confirmed; side agents close at once.
  // Change agent is the same close, followed by a new, unassigned main.
  const [pendingMainClose, setPendingMainClose] = useState<{
    id: string;
    title: string;
    paneId: string;
    changeAgent: boolean;
  } | null>(null);
  const [replacement, setReplacement] = useState<{ projectId: string; id: string } | null>(null);
  const error = actionError ?? loadError;

  const { runGit, prepareSwitch, confirmUpstreamMerge } = useCoordinatorGitActions({
    projectId,
    snapshot,
    setGit,
    refreshView,
    runAction,
  });

  // The main coordinator first, then side agents in number order.
  const conversations = useMemo(
    () =>
      (snapshot?.workspace.conversations.filter((item) => !item.closedAt) ?? []).toSorted(
        (a, b) =>
          (a.role === "main" ? 0 : 1) - (b.role === "main" ? 0 : 1) ||
          (a.sideOrdinal ?? 0) - (b.sideOrdinal ?? 0),
      ),
    [snapshot],
  );
  const conversationIds = useMemo(() => {
    const ids = conversations.map((item) => item.id);
    if (replacement?.projectId === projectId && !ids.includes(replacement.id)) {
      ids.push(replacement.id);
    }
    return ids;
  }, [conversations, projectId, replacement]);
  const {
    layout,
    backendSelectedId,
    updateLayout,
    changeLayout,
    selectConversation,
    selectionPending,
  } = useCoordinatorSelection({
    projectId,
    snapshot,
    conversationIds,
    setSnapshot,
    invalidateView,
    setError,
  });
  const hasMain = conversations.some((item) => item.role === "main");
  const newConversationLabel = hasMain ? "New side agent" : "Start coordinator";
  const availablePlatforms = useMemo(
    () =>
      AGENT_PLATFORMS.filter(
        (platform) => snapshot?.providerAvailability[platform]?.available === true,
      ),
    [snapshot],
  );
  // Only the caveats that come with an *available* platform. A reason attached
  // to one the user cannot pick is an explanation of an absence, and belongs
  // nowhere near the picker. These are shown inside the model picker, so the
  // limitation is readable at the moment the platform is chosen — including a
  // mailbox that cannot deliver a worker's reply, and a read-only boundary
  // nothing outside the agent verifies. The reason is shown as the backend
  // wrote it: the tier pill beside it already says whether the boundary is
  // verified, so the note does not say so a second time.
  const { platformNotes, platformBadges } = useMemo(() => {
    const notes: Partial<Record<AgentPlatform, string>> = {};
    const badges: Partial<Record<AgentPlatform, AgentPlatformBadge>> = {};
    for (const platform of availablePlatforms) {
      const qualification = snapshot?.providerAvailability[platform];
      if (qualification?.reason) notes[platform] = qualification.reason;
      const tier = coordinatorReadOnlyTier(qualification?.tier);
      if (tier) {
        badges[platform] = {
          label: `Read-only · ${COORDINATOR_TIER_LABELS[tier]}`,
          description: COORDINATOR_TIER_MEANINGS[tier],
          tone: tier === "enforced" ? "positive" : "caution",
        };
      }
    }
    return { platformNotes: notes, platformBadges: badges };
  }, [availablePlatforms, snapshot]);
  const { pendingLaunches, startConversation } = useCoordinatorLaunches({
    projectId,
    snapshot,
    setSnapshot,
    confirmUpstreamMerge,
  });
  // The conversation in the focused group; the backend's selection until the
  // layout has caught up with it.
  const focusedId = layout ? focusedCoordinatorConversationId(layout) : null;
  const selected =
    conversations.find((item) => item.id === focusedId) ??
    conversations.find((item) => item.id === backendSelectedId);
  // The window's agent information button reads the focused conversation as
  // its active tab, so its usage, limits and account show as for any agent tab.
  const workspaceId = snapshot?.workspace.id;
  const selectedId = selected?.id;
  const selectedTabId = selected?.tabId;
  const selectedAgent = selected?.agent;
  const selectedProviderSessionId = selected?.providerSessionId;
  useEffect(() => {
    if (!workspaceId || !selectedId || !selectedTabId) return;
    const store = useActiveCoordinatorConversationStore.getState();
    store.publish({
      nodeId,
      projectId,
      tabId: selectedTabId,
      data: {
        platform: selectedAgent,
        environmentId: coordinatorRuntimeId(workspaceId, selectedId),
        isLocal: true,
        sessionId: selectedProviderSessionId,
      },
    });
    return () => store.clear(nodeId, projectId, selectedTabId);
  }, [
    nodeId,
    projectId,
    selectedAgent,
    selectedId,
    selectedProviderSessionId,
    selectedTabId,
    workspaceId,
  ]);
  const selectedSessionKey =
    snapshot && selected
      ? createSessionKey(coordinatorRuntimeId(snapshot.workspace.id, selected.id), selected.tabId)
      : null;
  const selectedTurnPhase = useNativeAgentProjectionStore((state) =>
    selectedSessionKey ? state.projections.get(selectedSessionKey)?.turn.phase : undefined,
  );
  const selectedTurnActive = isCoordinatorTurnPhaseActive(selectedTurnPhase);

  // A settled turn may have changed delegations: one coalesced conditional read.
  useEffect(() => {
    if (!selectedSessionKey || selectedTurnActive) return;
    invalidateView();
  }, [invalidateView, selectedSessionKey, selectedTurnActive]);
  const mountedConversationIds = useMemo(
    () =>
      new Set(
        layout
          ? collectCoordinatorLeaves(layout.root).flatMap((pane) =>
              pane.activeConversationId ? [pane.activeConversationId] : [],
            )
          : [],
      ),
    [layout],
  );
  const activeTurn = useCoordinatorActiveTurn(
    projectId,
    snapshot?.workspace,
    mountedConversationIds,
  );

  if (checkout !== "ready") {
    return <ProjectCheckoutNotice projectId={projectId} state={checkout} />;
  }

  if (loading && !snapshot) {
    return (
      <div
        id="project-panel-coordinator"
        role="tabpanel"
        className="grid h-full place-items-center"
      >
        <div role="status">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Loading coordinator</span>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div
        id="project-panel-coordinator"
        role="tabpanel"
        className="grid h-full place-items-center p-8"
      >
        <div className="max-w-lg rounded-xl border border-destructive/40 bg-card p-6 text-center">
          <AlertCircle className="mx-auto mb-3 size-8 text-destructive" />
          <h2 className="font-semibold">Coordinator unavailable</h2>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <Button className="mt-4" variant="outline" onClick={() => void load()}>
            <RotateCcw className="size-4" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const conversationById = new Map(conversations.map((item) => [item.id, item]));
  /**
   * Opens a conversation: the main when none is open, else a side agent.
   * `replacingMain` closes that main first, so the new one is a fresh,
   * unassigned main whose composer offers every qualified platform.
   */
  const createConversation = (replacingMain?: string) => {
    // Empty, unassigned side agents close as the new one opens, so unused
    // composers cannot use up the open-conversation limit.
    const closeUnused = unusedCoordinatorConversationIds(
      snapshot.workspace,
      composeDrafts.getState().drafts,
      pendingLaunches,
    );
    void runAction(
      "conversation",
      async () => {
        const originalPane =
          replacingMain && layout
            ? collectCoordinatorLeaves(layout.root).find((pane) =>
                pane.conversationIds.includes(replacingMain),
              )
            : null;
        const originalIndex = originalPane?.conversationIds.indexOf(replacingMain!) ?? 0;
        let closedSnapshot = null;
        let createdSnapshot;
        setReplacement(replacingMain ? { projectId, id: replacingMain } : null);
        try {
          closedSnapshot = replacingMain
            ? await nodeBackend.closeCoordinatorConversation(projectId, replacingMain)
            : null;
          createdSnapshot = await nodeBackend.createCoordinatorConversation(
            projectId,
            undefined,
            closeUnused,
          );
        } catch (cause) {
          // Closing succeeded even though creation failed; never leave a
          // closed conversation visible as though it were still usable.
          if (closedSnapshot) setSnapshot(closedSnapshot);
          setReplacement(null);
          throw cause;
        }
        if (replacingMain) {
          // Mail can ensure a main between close and create. In that case
          // create returns a side: keep it, but replacement and focus belong
          // to the actual main, never to the API's selected side.
          const main = createdSnapshot.workspace.conversations.find(
            (item) => item.role === "main" && !item.closedAt,
          );
          if (!main) {
            setSnapshot(createdSnapshot);
            setReplacement(null);
            throw new Error("No open main conversation after changing agent");
          }
          createdSnapshot = {
            ...createdSnapshot,
            workspace: { ...createdSnapshot.workspace, selectedConversationId: main.id },
          };
        }
        // Read after the requests, before publishing the new open set can
        // reconcile away the placeholder. Keep moves and divider edits made
        // while the backend was busy.
        const latestLayout = paneLayouts.getState().entries[projectId]?.layout;
        const replacementLayout =
          replacingMain && latestLayout ? structuredClone(latestLayout) : null;
        const replacementId = createdSnapshot.workspace.selectedConversationId;
        if (replacementLayout && replacementId) {
          const panes = collectCoordinatorLeaves(replacementLayout.root);
          const target =
            panes.find((pane) => pane.conversationIds.includes(replacingMain!)) ??
            panes.find((pane) => pane.id === originalPane?.id) ??
            panes.find((pane) => pane.id === replacementLayout.activePaneId) ??
            panes[0];
          if (target) {
            // A newer snapshot may already have inserted the new ID.
            for (const pane of panes) {
              pane.conversationIds = pane.conversationIds.filter((id) => id !== replacementId);
            }
            const index = target.conversationIds.indexOf(replacingMain!);
            if (index >= 0) target.conversationIds[index] = replacementId;
            else
              target.conversationIds.splice(
                Math.min(originalIndex, target.conversationIds.length),
                0,
                replacementId,
              );
            target.activeConversationId = replacementId;
            replacementLayout.activePaneId = target.id;
          }
        }
        // Publish the open set before the external layout store: a store
        // notification can synchronously render and reconcile the new ID.
        flushSync(() => {
          setSnapshot(createdSnapshot);
          setReplacement(null);
        });
        if (replacementLayout && replacementId) {
          paneLayouts.getState().setLayout(projectId, replacementLayout);
        }
        const createdId = createdSnapshot.workspace.selectedConversationId;
        if (createdId && (replacingMain || selectionPending())) selectConversation(createdId);
      },
      {
        failureMessage: replacingMain
          ? "Could not change the coordinator's agent"
          : "Could not create conversation",
      },
    );
  };
  const paused = snapshot.workspace.lifecycleState === "paused";
  const setPaused = (pause: boolean) => {
    const action = pause
      ? nodeBackend.pauseProjectCoordinator
      : nodeBackend.resumeProjectCoordinator;
    void runAction("conversation", async () => setSnapshot(await action(projectId)), {
      failureMessage: "Could not update Coordinator",
    });
  };
  const closeConversation = (conversationId: string) => {
    void runAction(
      "conversation",
      async () =>
        setSnapshot(await nodeBackend.closeCoordinatorConversation(projectId, conversationId)),
      { failureMessage: "Could not close conversation" },
    );
  };
  const retryConversation = (conversationId: string) => {
    void runAction(
      "conversation",
      async () =>
        setSnapshot(await nodeBackend.retryCoordinatorConversation(projectId, conversationId)),
      { failureMessage: "Could not retry conversation" },
    );
  };
  // Keep action failures announced even when the repository retains the same error.
  const actionAlert = error;

  return (
    <CoordinatorPullRequestWatchProvider projectId={projectId}>
      <div
        id="project-panel-coordinator"
        role="tabpanel"
        data-agent-scope=""
        className="flex h-full min-h-0 flex-col bg-background"
      >
        <CoordinatorToolbar
          snapshot={snapshot}
          git={git}
          announcedError={actionAlert}
          gitBusy={gitBusy}
          fetching={fetching}
          conversationBusy={conversationBusy}
          freshness={freshness}
          runGit={runGit}
          prepareSwitch={prepareSwitch}
          activeTurn={activeTurn}
          selectedAgent={selected?.agent}
          paused={paused}
          onPause={() => setPaused(true)}
        />

        {/* Panel-wide notices use a collapsible stack; conversations own their stacks. */}
        <FloatingNoticeLayer anchor={false}>
          {actionAlert ? (
            <CoordinatorActionAlert
              message={actionAlert}
              onDismiss={() => {
                setError(null);
                clearLoadError();
              }}
            />
          ) : null}
          {/* Only from a backend that predates per-conversation startup errors,
        or a record one stored (version-compatibility.md). */}
          {snapshot.workspace.lifecycleState === "error" ? (
            <CoordinatorBanner
              tone="error"
              label="Startup failed"
              summary="Coordinator startup failed."
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  className={FLOATING_NOTICE_ACTION}
                  disabled={conversationBusy}
                  onClick={() =>
                    void runAction("conversation", load, {
                      failureMessage: "Could not open Coordinator",
                    })
                  }
                >
                  <RotateCcw className="size-3" />
                  Retry
                </Button>
              }
            >
              <span className="font-medium">Coordinator startup failed.</span>{" "}
              <span className="text-muted-foreground">
                {snapshot.workspace.lastStartupError ?? "The coordinator could not be started."}
              </span>
            </CoordinatorBanner>
          ) : null}
          {paused ? (
            <CoordinatorBanner
              tone="info"
              label="Paused"
              summary="Coordination is paused."
              icon={Pause}
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  className={FLOATING_NOTICE_ACTION}
                  disabled={conversationBusy}
                  onClick={() => setPaused(false)}
                >
                  <Play className="size-3" />
                  Resume
                </Button>
              }
            >
              Coordination is paused. Mail and new turns wait until you resume; conversations stay
              readable.
            </CoordinatorBanner>
          ) : null}

          {/* The prompts banner owns the app-wide subscriptions; it sits beside
        the conversations, so a write it alone reads does not render them. */}
          <CoordinatorWorkerPrompts snapshot={snapshot} />

          <div className="relative min-h-0 min-w-0 flex-1">
            {/* The area has no shared transcript gutter when conversations split. */}
            <FloatingNoticeAnchor className="top-12 right-3" />
            {layout ? (
              <CoordinatorPaneTree
                layout={layout}
                onLayoutChange={changeLayout}
                onFocusPane={(paneId) =>
                  changeLayout((current) => focusCoordinatorPane(current, paneId))
                }
                conversationLabel={(id) => conversationById.get(id)?.title ?? "Conversation"}
                renderTab={(id, pane, paneFocused) => {
                  const item = conversationById.get(id);
                  if (!item) return null;
                  const requestMainClose = (changeAgent: boolean) =>
                    setPendingMainClose({
                      id: item.id,
                      title: item.title,
                      paneId: pane.id,
                      changeAgent,
                    });
                  return (
                    <CoordinatorConversationTab
                      key={id}
                      conversation={item}
                      pane={pane}
                      layout={layout}
                      paneFocused={paneFocused}
                      markMain={conversations.length > 1}
                      conversationBusy={conversationBusy}
                      onSelect={() => {
                        updateLayout((current) => focusCoordinatorPane(current, pane.id, id));
                        selectConversation(id);
                      }}
                      onClose={() =>
                        item.role === "main" ? requestMainClose(false) : closeConversation(item.id)
                      }
                      onChangeAgent={() => requestMainClose(true)}
                      onLayoutChange={changeLayout}
                    />
                  );
                }}
                renderStripActions={(pane) => (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-1 shrink-0"
                    disabled={conversationBusy}
                    onClick={(event) => {
                      // The new conversation joins the focused group, so focus
                      // this one without selecting the tab it is about to replace.
                      event.stopPropagation();
                      updateLayout((current) => focusCoordinatorPane(current, pane.id));
                      createConversation();
                    }}
                    title={hasMain ? COORDINATOR_SIDE_AGENT_EXPLANATION : newConversationLabel}
                  >
                    <Plus className="size-3.5" />
                    {/* The strip scrolls, so on a phone the action is its icon. */}
                    <span className="max-sm:sr-only">{newConversationLabel}</span>
                  </Button>
                )}
                renderContent={(pane, paneFocused) => {
                  const conversationId = pane.activeConversationId;
                  return (
                    <CoordinatorConversationPane
                      conversation={
                        conversationId ? conversationById.get(conversationId) : undefined
                      }
                      paneFocused={paneFocused}
                      projectId={projectId}
                      snapshot={snapshot}
                      availablePlatforms={availablePlatforms}
                      platformNotes={platformNotes}
                      platformBadges={platformBadges}
                      launch={conversationId ? pendingLaunches.get(conversationId) : undefined}
                      startConversation={startConversation}
                      confirmUpstreamMerge={confirmUpstreamMerge}
                      conversationBusy={conversationBusy}
                      newConversationLabel={newConversationLabel}
                      onCreateConversation={() => createConversation()}
                      onRetry={() => void load()}
                      onRetryConversation={retryConversation}
                      onCloseConversation={(id) => {
                        const item = conversationById.get(id);
                        if (item?.role === "main") {
                          setPendingMainClose({
                            id,
                            title: item.title,
                            paneId: pane.id,
                            changeAgent: false,
                          });
                        } else closeConversation(id);
                      }}
                    />
                  );
                }}
              />
            ) : null}
          </div>
        </FloatingNoticeLayer>

        <AlertDialog
          open={pendingMainClose !== null}
          onOpenChange={(open) => {
            if (!open) setPendingMainClose(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pendingMainClose?.changeAgent
                  ? "Change the coordinator's agent?"
                  : "Close the main conversation?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pendingMainClose?.changeAgent
                  ? `${pendingMainClose.title} will close and a new main conversation opens, where you choose its agent. Open delegations move to the new main. A report that arrives before you choose starts it with the default agent.`
                  : `${pendingMainClose?.title ?? "The main conversation"} will close. The next message to the coordinator starts a new main conversation with the default agent, and open delegations move to it.${
                      pendingMainClose && conversationById.get(pendingMainClose.id)?.agent
                        ? " To choose the agent yourself, use Change agent instead."
                        : ""
                    }`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep open</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const target = pendingMainClose;
                  setPendingMainClose(null);
                  if (!target) return;
                  if (!target.changeAgent) {
                    closeConversation(target.id);
                    return;
                  }
                  // The next main joins the group the old one was in.
                  updateLayout((current) => focusCoordinatorPane(current, target.paneId));
                  createConversation(target.id);
                }}
              >
                {pendingMainClose?.changeAgent ? "Change agent" : "Close conversation"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </CoordinatorPullRequestWatchProvider>
  );
}
