import { HumanPromptBanner } from "@/components/chat/HumanPromptBanner";
import { useHumanPrompts } from "@/hooks/useUserCommands";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  GitBranch,
  Loader2,
  Pause,
  Play,
  Plus,
  MessagesSquare,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import {
  coordinatorRuntimeId,
  type ProjectGitStatus,
  type ProjectGitSwitchConfirmation,
} from "@orkestrator/protocol/coordinator";
import { useCoordinatorPanelData } from "./useCoordinatorPanelData";
import { useCoordinatorWorkItems } from "./useCoordinatorWorkItems";
import { CoordinatorWorkPanel } from "./CoordinatorWorkPanel";
import { openCoordinatorWorkTarget } from "@/lib/coordinator-work-navigation";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import {
  COORDINATOR_COMPOSER_PLACEHOLDER,
  COORDINATOR_STARTER_PROMPTS,
  CoordinatorBanner,
  CoordinatorErrorDetails,
  CoordinatorIsolationBadge,
} from "./CoordinatorPanelNotices";
import {
  AGENT_PLATFORM_LABELS,
  AGENT_PLATFORMS,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import { AgentMailBanner } from "@/components/agent-mail/AgentMailBanner";
import { AgentNativeTab } from "@/components/native-agent";
import { TAB_ICON_CLASS } from "@/components/pane-layout/TabShell";
import { CoordinatorPaneTree, SortableCoordinatorTab } from "./CoordinatorPaneTree";
import {
  focusCoordinatorPane,
  focusedCoordinatorConversationId,
  reconcileCoordinatorLayout,
  revealCoordinatorConversation,
  type CoordinatorPaneLayout,
} from "@/lib/coordinator-pane-layout";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as backend from "@/lib/backend";
import { cn, createSessionKey } from "@/lib/utils";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { useActiveCoordinatorConversationStore } from "@/stores/activeCoordinatorConversationStore";
import { unusedCoordinatorConversationIds } from "@/lib/coordinator-unused-conversations";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useProjectStore } from "@/stores/projectStore";
import {
  selectCoordinatorPaneLayout,
  selectCoordinatorPaneLayoutReady,
  useCoordinatorPaneLayoutStore,
} from "@/stores/coordinatorPaneLayoutStore";
import { checkUpstreamMergeOffer } from "@/lib/coordinator-upstream-check";
import { CoordinatorPullRequestWatchProvider } from "@/lib/coordinator-pull-request-watch";

/** How long a message waits on the pre-send fetch before it is sent without merging. */
const UPSTREAM_CHECK_TIMEOUT_MS = 5_000;

interface CoordinatorPanelProps {
  projectId: string;
}

function gitSummary(status: ProjectGitStatus | null): string {
  if (!status) return "Reading repository…";
  if (!status.upstream) return status.detached ? "Detached HEAD" : "No upstream configured";
  if (status.remoteState !== "fresh") return "Remote status is stale";
  if ((status.ahead ?? 0) > 0 && (status.behind ?? 0) > 0) {
    return `${status.ahead} ahead, ${status.behind} behind — diverged`;
  }
  if ((status.behind ?? 0) > 0) return `${status.behind} commits behind`;
  if ((status.ahead ?? 0) > 0) return `${status.ahead} commits ahead`;
  return "Up to date";
}

export function CoordinatorPanel({ projectId }: CoordinatorPanelProps) {
  const project = useProjectStore((state) => state.projects.find((item) => item.id === projectId));
  const {
    snapshot,
    git,
    loading,
    error: loadError,
    load,
    applySnapshot: setSnapshot,
    applyGit: setGit,
    invalidateView,
    refreshView,
  } = useCoordinatorPanelData(projectId);
  const [operation, setOperation] = useState<"fetch" | "sync" | "switch" | "conversation" | null>(
    null,
  );
  const [pendingSwitch, setPendingSwitch] = useState<ProjectGitSwitchConfirmation | null>(null);
  // Closing the main conversation is confirmed; side agents close at once.
  const [pendingMainClose, setPendingMainClose] = useState<{ id: string; title: string } | null>(
    null,
  );
  const upstreamCheckLifetimeRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const lifetime = new AbortController();
    upstreamCheckLifetimeRef.current = lifetime;
    return () => lifetime.abort();
  }, [projectId]);
  const [actionError, setError] = useState<string | null>(null);
  const error = actionError ?? loadError;
  const [pendingLaunch, setPendingLaunch] = useState<{
    conversationId: string;
    prompt: string;
    modelId?: string;
    reasoningId?: string;
    fastMode: boolean;
    mode?: "build" | "plan";
    executionProfileId?: string;
  } | null>(null);

  const runGit = useCallback(
    async (
      kind: "fetch" | "sync" | "switch",
      ref?: string,
      confirmation?: ProjectGitSwitchConfirmation,
    ) => {
      setOperation(kind);
      setError(null);
      try {
        const next =
          kind === "fetch"
            ? await backend.fetchProjectGit(projectId, true)
            : kind === "sync"
              ? await backend.syncProjectGit(projectId)
              : await backend.switchProjectGitBranch(
                  projectId,
                  ref!,
                  confirmation
                    ? {
                        confirmationToken: confirmation.token,
                        includeNestedRepositories: confirmation.requiresEnhancedConfirmation,
                      }
                    : {},
                );
        setGit(next);
        await refreshView();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : `Git ${kind} failed`);
        void backend
          .getProjectGitStatus(projectId)
          .then(setGit)
          .catch(() => undefined);
      } finally {
        setOperation(null);
      }
    },
    [projectId, refreshView, setGit],
  );

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
  const conversationIds = useMemo(() => conversations.map((item) => item.id), [conversations]);
  const conversationIdsRef = useRef(conversationIds);
  /*
   * Tab groups. The layout is stored by the backend per project so every
   * client shows the same groups, and is presentation over the backend's open
   * conversations: reconciling adds conversations no group holds yet to the
   * focused group and drops closed ones, so it never decides what is open.
   * Nothing is reconciled before the first snapshot and the stored layout are
   * both read, which would otherwise read as "every conversation closed" (or
   * "no layout") and discard the remembered one.
   */
  const storedLayout = useCoordinatorPaneLayoutStore(selectCoordinatorPaneLayout(projectId));
  const storedLayoutReady = useCoordinatorPaneLayoutStore(
    selectCoordinatorPaneLayoutReady(projectId),
  );
  const setStoredLayout = useCoordinatorPaneLayoutStore((state) => state.setLayout);
  useEffect(() => {
    void useCoordinatorPaneLayoutStore.getState().hydrate(projectId);
  }, [projectId]);
  const layout = useMemo(
    () =>
      snapshot && storedLayoutReady
        ? reconcileCoordinatorLayout(storedLayout, conversationIds)
        : null,
    [conversationIds, snapshot, storedLayout, storedLayoutReady],
  );
  const layoutRef = useRef(layout);
  const snapshotRef = useRef(snapshot);
  // Before the effects and handlers below read them.
  useLayoutEffect(() => {
    conversationIdsRef.current = conversationIds;
    layoutRef.current = layout;
    snapshotRef.current = snapshot;
  });
  const updateLayout = useCallback(
    (change: (layout: CoordinatorPaneLayout) => CoordinatorPaneLayout) => {
      const current = selectCoordinatorPaneLayout(projectId)(
        useCoordinatorPaneLayoutStore.getState(),
      );
      if (!current && !layoutRef.current) return;
      setStoredLayout(
        projectId,
        change(
          reconcileCoordinatorLayout(current ?? layoutRef.current, conversationIdsRef.current),
        ),
      );
    },
    [projectId, setStoredLayout],
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
            const next = await backend.selectCoordinatorConversation(projectId, requested);
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
    [invalidateView, projectId, setSnapshot, updateLayout],
  );
  /**
   * Applies a layout change, then keeps the backend's selection on the
   * conversation in the focused group. That selection is what the header, the
   * pause check, and the next visit follow.
   */
  const changeLayout = useCallback(
    (change: (layout: CoordinatorPaneLayout) => CoordinatorPaneLayout) => {
      updateLayout(change);
      const current = selectCoordinatorPaneLayout(projectId)(
        useCoordinatorPaneLayoutStore.getState(),
      );
      const focused = current ? focusedCoordinatorConversationId(current) : null;
      if (focused && focused !== (selectionRef.current?.desired ?? backendSelectedId)) {
        selectConversation(focused);
      }
    },
    [backendSelectedId, projectId, selectConversation, updateLayout],
  );
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
  // nothing outside the agent verifies.
  const platformNotes = useMemo(() => {
    const notes: Partial<Record<AgentPlatform, string>> = {};
    for (const platform of availablePlatforms) {
      const qualification = snapshot?.providerAvailability[platform];
      if (!qualification?.reason) continue;
      notes[platform] =
        qualification.tier === "enforced"
          ? qualification.reason
          : `${qualification.reason} Orkestrator cannot verify this boundary independently.`;
    }
    return notes;
  }, [availablePlatforms, snapshot]);
  const assignAgent = useCallback(
    async (
      conversationId: string,
      platform: AgentPlatform,
      launch: {
        modelId?: string;
        reasoningId?: string;
        fastMode: boolean;
        mode?: "build" | "plan";
        executionProfileId?: string;
      },
      prompt: string,
    ) => {
      const next = await backend.assignCoordinatorConversationAgent(
        projectId,
        conversationId,
        platform,
      );
      // Held only until the assigned tab mounts and consumes them. They are not
      // durable state: the backend owns the conversation, and a reload before
      // the first dispatch legitimately returns the user to the composer with
      // their draft rather than replaying a prompt that was never sent.
      setPendingLaunch({ conversationId, prompt, ...launch });
      setSnapshot(next);
    },
    [projectId, setSnapshot],
  );
  /*
   * The main coordinator reads this checkout, so a message sent while the
   * branch is behind its upstream is answered from older code. Before each
   * message to the main coordinator (its first prompt included), the backend
   * refreshes the "behind" state with a cooldown-bound fetch and decides
   * whether the upstream commits can be merged
   * (`check_coordinator_upstream_merge`). Whenever Git can fast-forward the
   * checkout cleanly, the panel does so without asking.
   *
   * Merging resolves only after the fast-forward, so the message then reads
   * the merged code. A fast-forward that fails anyway (the remote moved, the
   * network dropped) is reported in the toolbar and the message is still
   * sent: nobody is asked any more, so a failure must not strand the draft
   * with no way to send it. A blocked checkout (local commits, uncommitted
   * changes, an unfinished operation) is left alone: the header already says
   * why it cannot sync. So is one while any of this coordinator's
   * conversations or the project home is running a turn, since the backend
   * refuses to change the checkout under it.
   */
  const confirmUpstreamMerge = useCallback(
    async (conversation: { role?: string }) => {
      const lifetime = upstreamCheckLifetimeRef.current;
      if (!lifetime || lifetime.signal.aborted) return false;
      if (conversation.role === "side") return;
      // Only an older backend needs this panel to judge running turns itself.
      const turnRunning = () => {
        const current = snapshotRef.current;
        const projections = useNativeAgentProjectionStore.getState().projections;
        const active = (phase: string | undefined) =>
          phase === "running" ||
          phase === "blocked" ||
          phase === "cancelling" ||
          phase === "recovering";
        const conversationRunning = current?.workspace.conversations.some(
          (item) =>
            !item.closedAt &&
            item.agent &&
            active(
              projections.get(
                createSessionKey(coordinatorRuntimeId(current.workspace.id, item.id), item.tabId),
              )?.turn.phase,
            ),
        );
        const homeIds = new Set(
          useEnvironmentStore
            .getState()
            .environments.filter(
              (environment) => environment.projectId === projectId && environment.projectHome,
            )
            .map((environment) => environment.id),
        );
        return (
          conversationRunning === true ||
          Array.from(projections.values()).some(
            (projection) => homeIds.has(projection.environmentId) && active(projection.turn.phase),
          )
        );
      };
      let cancel!: () => void;
      const cancelled = new Promise<false>((resolve) => {
        cancel = () => resolve(false);
        lifetime.signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        // An unreachable or slow remote is no reason to hold the message: past
        // the bound it is sent without merging, and the fetch still lands.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const check = await Promise.race([
          cancelled,
          checkUpstreamMergeOffer(projectId, {
            turnRunning,
            onStatus: (fetched) => {
              if (!lifetime.signal.aborted) setGit(fetched);
            },
          }).catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), UPSTREAM_CHECK_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        if (lifetime.signal.aborted || check === false) return false;
        if (!check?.offer) return;
        setOperation("sync");
        setError(null);
        try {
          const synced = await backend.syncProjectGit(projectId);
          if (lifetime.signal.aborted) return false;
          setGit(synced);
          await refreshView();
          if (lifetime.signal.aborted) return false;
        } catch (cause) {
          if (lifetime.signal.aborted) return false;
          if (
            cause instanceof Error &&
            cause.message === "Stop the active coordinator turn before changing the checkout"
          )
            return;
          setError(cause instanceof Error ? cause.message : "Could not merge the upstream commits");
          void backend
            .getProjectGitStatus(projectId)
            .then(setGit)
            .catch(() => undefined);
        } finally {
          if (!lifetime.signal.aborted) setOperation(null);
        }
      } finally {
        lifetime.signal.removeEventListener("abort", cancel);
      }
    },
    [projectId, refreshView, setGit],
  );
  const startConversation = useCallback(
    async (
      conversation: { id: string; role?: string },
      platform: AgentPlatform,
      launch: Parameters<typeof assignAgent>[2],
      prompt: string,
    ) => {
      if ((await confirmUpstreamMerge(conversation)) === false) return;
      await assignAgent(conversation.id, platform, launch, prompt);
    },
    [assignAgent, confirmUpstreamMerge],
  );
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
      projectId,
      tabId: selectedTabId,
      data: {
        platform: selectedAgent,
        environmentId: coordinatorRuntimeId(workspaceId, selectedId),
        isLocal: true,
        sessionId: selectedProviderSessionId,
      },
    });
    return () => store.clear(projectId, selectedTabId);
  }, [projectId, selectedAgent, selectedId, selectedProviderSessionId, selectedTabId, workspaceId]);
  const environments = useEnvironmentStore((state) => state.environments);
  const pipelines = useBuildPipelineStore((state) => state.pipelines);
  const multiReviews = useMultiReviewStore((state) => state.workflows);
  /*
   * Commands waiting on the user in this coordinator's work — a question, an
   * approval, a sign-in link, a code — in its workers and in the environments
   * its builds and reviews run in. Read once: the Work panel marks those rows
   * as needing the user, and the banner shows the workers' own prompts so the
   * person talking to the coordinator sees them without opening the worker.
   */
  const workerEnvironmentIds = useMemo(
    () =>
      new Set(
        snapshot
          ? snapshot.workflows
              .filter(
                (association) =>
                  association.kind === "environment" &&
                  association.coordinatorId === snapshot.workspace.id &&
                  !association.nodeId &&
                  !association.pending,
              )
              .map((association) => association.resourceId)
          : [],
      ),
    [snapshot],
  );
  const workEnvironmentIds = useMemo(() => {
    if (!snapshot) return [];
    const ids = new Set(workerEnvironmentIds);
    for (const association of snapshot.workflows) {
      if (association.coordinatorId !== snapshot.workspace.id || association.nodeId) continue;
      const environmentId =
        association.kind === "build-pipeline"
          ? pipelines.get(association.resourceId)?.environmentId
          : association.kind === "multi-review"
            ? multiReviews.get(association.resourceId)?.environmentId
            : undefined;
      if (environmentId) ids.add(environmentId);
    }
    return Array.from(ids);
  }, [snapshot, workerEnvironmentIds, pipelines, multiReviews]);
  const workPrompts = useHumanPrompts(workEnvironmentIds);
  const workerPrompts = useMemo(
    () => workPrompts.filter((entry) => workerEnvironmentIds.has(entry.environmentId)),
    [workPrompts, workerEnvironmentIds],
  );
  const promptEnvironmentIds = useMemo(
    () => new Set(workPrompts.map((entry) => entry.environmentId)),
    [workPrompts],
  );
  // Everything this coordinator started, from every conversation and node.
  const work = useCoordinatorWorkItems(snapshot, promptEnvironmentIds);
  const selectedSessionKey =
    snapshot && selected
      ? createSessionKey(coordinatorRuntimeId(snapshot.workspace.id, selected.id), selected.tabId)
      : null;
  const selectedTurnPhase = useNativeAgentProjectionStore((state) =>
    selectedSessionKey ? state.projections.get(selectedSessionKey)?.turn.phase : undefined,
  );
  // The conversation's own tab id, never a reconstructed one: the workspace
  // assigns it, and a key that does not match leaves the prompt held for good.
  const launchConversation = pendingLaunch
    ? snapshot?.workspace.conversations.find((item) => item.id === pendingLaunch.conversationId)
    : undefined;
  const launchSessionKey =
    snapshot && launchConversation
      ? createSessionKey(
          coordinatorRuntimeId(snapshot.workspace.id, launchConversation.id),
          launchConversation.tabId,
        )
      : null;
  // Either half is enough: a turn that has started, or a message already in the
  // transcript. A slow first read shows neither, which is precisely when the
  // prompt still has to be held. Only phases a turn produces count: the first
  // read of a new session is the backend's `recovering` placeholder while the
  // provider mapping settles, and an `error` with no transcript is a failed
  // start. Releasing on either dropped the prompt before it was ever sent.
  const launchObserved = useNativeAgentProjectionStore((state) => {
    if (!launchSessionKey) return false;
    const projection = state.projections.get(launchSessionKey);
    if (!projection) return false;
    const phase = projection.turn.phase;
    return (
      phase === "running" ||
      phase === "blocked" ||
      phase === "cancelling" ||
      projection.messages.length > 0
    );
  });
  const coordinatorTurnActive =
    selectedTurnPhase === "running" ||
    selectedTurnPhase === "blocked" ||
    selectedTurnPhase === "cancelling" ||
    selectedTurnPhase === "recovering";
  const blocked = git?.repositoryOperationBlockedReason ?? null;
  const dirty = Boolean(git && (git.trackedChanges > 0 || git.untrackedChanges > 0));
  const discardableDirty = Boolean(
    dirty &&
    git &&
    !git.mergeInProgress &&
    !git.rebaseInProgress &&
    !git.sequencerInProgress &&
    git.conflicts === 0,
  );
  const switchBlocked = Boolean(blocked && !discardableDirty);
  const pendingSwitchBranch = git?.branches.find((branch) => branch.ref === pendingSwitch?.ref);

  /*
   * Held until the turn is observed, not until the tab has rendered once.
   *
   * The agent tab dispatches an opening prompt only after its first
   * authoritative read, so dropping the prompt on the next render — which the
   * snapshot poll triggers within a second or two — raced that read and left
   * the text sitting in the composer unsent. Evidence of the turn is the
   * authoritative signal, and re-dispatch is safe in the meantime because the
   * opening submit carries a deterministic idempotency key.
   */
  if (pendingLaunch && launchObserved) setPendingLaunch(null);

  // A settled turn may have changed delegations: one coalesced conditional read.
  useEffect(() => {
    if (!selectedSessionKey || coordinatorTurnActive) return;
    invalidateView();
  }, [coordinatorTurnActive, invalidateView, selectedSessionKey]);

  if (!project?.localPath) {
    return (
      <div
        id="project-panel-coordinator"
        role="tabpanel"
        className="grid h-full place-items-center p-8"
      >
        <div className="max-w-lg rounded-xl border border-border bg-card p-6 text-center">
          <GitBranch className="mx-auto mb-3 size-8 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Connect a local checkout</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Coordinator reads the project’s real local checkout. Set a valid local path in
            Repository settings to continue.
          </p>
        </div>
      </div>
    );
  }

  if (loading && !snapshot) {
    return (
      <div
        id="project-panel-coordinator"
        role="tabpanel"
        className="grid h-full place-items-center"
      >
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
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
  const createConversation = () => {
    setOperation("conversation");
    setError(null);
    // Empty, unassigned side agents close as the new one opens, so unused
    // composers cannot use up the open-conversation limit.
    const closeUnused = unusedCoordinatorConversationIds(
      snapshot.workspace,
      useNativeComposeStore.getState().drafts,
      pendingLaunch?.conversationId,
    );
    void backend
      .createCoordinatorConversation(projectId, undefined, closeUnused)
      .then((createdSnapshot) => {
        setSnapshot(createdSnapshot);
        const createdId = createdSnapshot.workspace.selectedConversationId;
        if (createdId && selectionRef.current?.pending) selectConversation(createdId);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Could not create conversation"),
      )
      .finally(() => setOperation(null));
  };
  // One group's front conversation. Only the front tab of each group is
  // mounted; the backend owns the session, so a tab brought forward rehydrates.
  const renderConversation = (conversationId: string | null, paneFocused: boolean) => {
    const conversation = conversationId ? conversationById.get(conversationId) : undefined;
    if (!conversation) {
      return (
        <div className="grid h-full place-items-center text-center">
          <div>
            <p className="text-sm text-muted-foreground">
              No coordinator is open. Mail for the coordinator will start one with the default
              agent.
            </p>
            <Button
              className="mt-3"
              variant="outline"
              disabled={operation !== null}
              onClick={createConversation}
            >
              <Plus className="size-4" />
              {newConversationLabel}
            </Button>
          </div>
        </div>
      );
    }
    const providerState = conversation.agent
      ? snapshot.providerAvailability[conversation.agent]
      : undefined;
    // A banner over the transcript rather than a replacement for it: the
    // conversation stays readable while its platform is unavailable.
    const providerUnavailable = Boolean(conversation.agent && !providerState?.available);
    // Scoped to the conversation that produced it, so another group cannot
    // replay one conversation's first prompt into its own.
    const launch = pendingLaunch?.conversationId === conversation.id ? pendingLaunch : null;
    const environmentId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    return (
      <div key={conversation.id} className="flex h-full min-h-0 flex-col">
        {providerUnavailable && conversation.agent ? (
          <CoordinatorBanner
            tone="warning"
            action={
              <Button size="sm" variant="outline" onClick={() => void load()}>
                <RotateCcw className="size-3.5" />
                Retry
              </Button>
            }
          >
            <span className="font-medium">
              {AGENT_PLATFORM_LABELS[conversation.agent]} is unavailable for Coordinator.
            </span>{" "}
            <span className="text-muted-foreground">
              {providerState?.reason ?? snapshot.workspace.lastStartupError}
            </span>
          </CoordinatorBanner>
        ) : null}
        <AgentMailBanner
          environmentId={environmentId}
          tabId={conversation.tabId}
          agentAvailable={availablePlatforms.length > 0}
        />
        <div className="relative min-h-0 flex-1">
          <AgentNativeTab
            tabId={conversation.tabId}
            data={{
              platform: conversation.agent,
              environmentId,
              isLocal: true,
              sessionId: conversation.providerSessionId,
            }}
            isActive
            ownsGlobalShortcuts={paneFocused}
            executionPolicy="coordinator-read-only"
            coordinatorProjectId={projectId}
            coordinatorWorkspacePath={snapshot.projectPath}
            availablePlatforms={availablePlatforms}
            platformNotes={platformNotes}
            composerPlaceholder={COORDINATOR_COMPOSER_PLACEHOLDER}
            connectionEnabled={
              snapshot.workspace.lifecycleState === "ready" && providerState?.available !== false
            }
            // Only the main coordinator delegates, so only it is offered work
            // that has to run in a pipeline or environment.
            {...(conversation.role === "main"
              ? { unassignedStarterPrompts: COORDINATOR_STARTER_PROMPTS }
              : {})}
            emptyPlatformsMessage="No agent platform meets this coordinator's read-only requirement on this machine. Enable a qualified platform, or lower the coordinator safety level in Settings."
            onAssignPlatform={
              conversation.agent
                ? undefined
                : (platform, prompt, options) =>
                    startConversation(conversation, platform, options, prompt)
            }
            beforeSend={
              conversation.role === "side" ? undefined : () => confirmUpstreamMerge(conversation)
            }
            {...(launch
              ? {
                  initialPrompt: launch.prompt,
                  initialAgentModel: launch.modelId,
                  initialReasoningEffort: launch.reasoningId,
                  initialConversationMode: launch.mode,
                  initialFastMode: launch.fastMode,
                  initialExecutionProfileId: launch.executionProfileId,
                }
              : {})}
          />
        </div>
      </div>
    );
  };
  const branchSwitchDisabled = operation !== null || switchBlocked || coordinatorTurnActive;
  const syncDisabled = branchSwitchDisabled || dirty;
  const canSync = Boolean(git?.upstream && git.behind && git.behind > 0 && !git.ahead && !blocked);
  const paused = snapshot.workspace.lifecycleState === "paused";
  const setPaused = (pause: boolean) => {
    setOperation("conversation");
    setError(null);
    const action = pause ? backend.pauseProjectCoordinator : backend.resumeProjectCoordinator;
    void action(projectId)
      .then(setSnapshot)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Could not update Coordinator"),
      )
      .finally(() => setOperation(null));
  };
  const closeConversation = (conversationId: string) => {
    setOperation("conversation");
    void backend
      .closeCoordinatorConversation(projectId, conversationId)
      .then(setSnapshot)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Could not close conversation"),
      )
      .finally(() => setOperation(null));
  };
  const clearFinishedWork = (associationIds: string[]) =>
    backend
      .hideCoordinatorWork(projectId, associationIds)
      .then(setSnapshot)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Could not clear finished work"),
      );
  // The badge speaks for the conversation in front: its platform's read-only
  // boundary is either enforced or only something the agent is asked to keep.
  const selectedQualification = selected?.agent
    ? snapshot.providerAvailability[selected.agent]
    : undefined;
  const advisoryPlatform =
    selected?.agent && selectedQualification && selectedQualification.tier !== "enforced"
      ? AGENT_PLATFORM_LABELS[selected.agent]
      : null;
  const gitError = git?.lastError ? git.lastError.stderr || git.lastError.message : null;
  // An action failure that only repeats the repository's own error is shown once.
  const coordinatorError = error && error !== gitError ? error : null;

  return (
    <CoordinatorPullRequestWatchProvider projectId={projectId}>
      <div
        id="project-panel-coordinator"
        role="tabpanel"
        data-agent-scope=""
        className="flex h-full min-h-0 flex-col bg-background"
      >
        <div className="shrink-0 border-b border-border/70 bg-chrome px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CoordinatorIsolationBadge
              projectPath={snapshot.projectPath}
              contextRevision={snapshot.workspace.repositoryContextRevision}
              advisoryPlatform={advisoryPlatform}
            />
            <div className="min-w-3 flex-1" />
            <Select
              value={git?.branch ? `refs/heads/${git.branch}` : undefined}
              onValueChange={(value) => {
                if (!discardableDirty) {
                  void runGit("switch", value);
                  return;
                }
                setOperation("switch");
                setError(null);
                void backend
                  .prepareProjectGitBranchSwitch(projectId, value)
                  .then(setPendingSwitch)
                  .catch((cause) => {
                    setError(
                      cause instanceof Error ? cause.message : "Could not prepare branch switch",
                    );
                    void backend
                      .getProjectGitStatus(projectId)
                      .then(setGit)
                      .catch(() => undefined);
                  })
                  .finally(() => setOperation(null));
              }}
              disabled={branchSwitchDisabled}
            >
              <SelectTrigger
                size="sm"
                className="max-w-56"
                title={
                  (switchBlocked ? blocked : null) ??
                  (dirty
                    ? "Switch branch and choose whether to discard local changes"
                    : "Switch branch")
                }
              >
                <GitBranch className="size-3.5" />
                <SelectValue placeholder={git?.detached ? "Detached HEAD" : "Choose branch"} />
              </SelectTrigger>
              <SelectContent align="end">
                {git?.branches.map((branch) => (
                  <SelectItem
                    key={branch.ref}
                    value={branch.ref}
                    disabled={Boolean(branch.occupiedWorktreePath)}
                  >
                    {branch.name}
                    {branch.occupiedWorktreePath ? " (in another worktree)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span
              className={cn(
                "text-xs text-muted-foreground",
                git?.remoteState === "fresh" && !git.lastError && "text-emerald-300",
              )}
            >
              {git?.remoteState === "fresh" && !git.lastError ? (
                <CheckCircle2 className="mr-1 inline size-3.5" />
              ) : null}
              {gitSummary(git)}
            </span>
            {canSync ? (
              <Button
                size="sm"
                variant="outline"
                disabled={syncDisabled}
                onClick={() => void runGit("sync")}
              >
                <RotateCcw className="size-3.5" />
                Sync
              </Button>
            ) : null}
            <Button
              size="icon"
              variant="ghost"
              aria-label="Refresh repository status"
              title="Fetch and refresh"
              disabled={operation !== null}
              onClick={() => void runGit("fetch")}
            >
              <RefreshCw className={cn("size-4", operation === "fetch" && "animate-spin")} />
            </Button>
            {/* While paused, the banner below the header offers Resume. */}
            {paused ? null : (
              <Button
                size="sm"
                variant="outline"
                disabled={operation !== null}
                onClick={() => setPaused(true)}
              >
                <Pause className="size-3.5" />
                Pause
              </Button>
            )}
          </div>
          {dirty ? (
            <p className="mt-1 text-xs text-amber-300">
              The checkout has {git?.trackedChanges} tracked and {git?.untrackedChanges} untracked
              changes. Sync is blocked
              {discardableDirty ? "; switching branches will ask before discarding them." : "."}
            </p>
          ) : null}
          {blocked && switchBlocked ? (
            <p className="mt-1 text-xs text-amber-300">{blocked}</p>
          ) : null}
          {gitError ? (
            <CoordinatorErrorDetails label="Repository error" message={gitError} />
          ) : null}
          {coordinatorError ? (
            <CoordinatorErrorDetails label="Coordinator error" message={coordinatorError} />
          ) : null}
          {!snapshot.controlMcp.enabled || !snapshot.controlMcp.running ? (
            <p className="mt-1 text-xs text-amber-300">
              Orchestration controls are unavailable because Control MCP is{" "}
              {snapshot.controlMcp.enabled ? "not running" : "disabled"}
              {snapshot.controlMcp.error ? `: ${snapshot.controlMcp.error}` : "."}
            </p>
          ) : null}
        </div>

        {snapshot.workspace.lifecycleState === "error" ? (
          <CoordinatorBanner
            tone="error"
            action={
              <Button size="sm" variant="outline" onClick={() => void load()}>
                <RotateCcw className="size-3.5" />
                Retry
              </Button>
            }
          >
            <span className="font-medium">Coordinator startup failed.</span>{" "}
            <span className="text-red-200/80">
              {snapshot.workspace.lastStartupError ?? "The coordinator could not be started."}
            </span>
          </CoordinatorBanner>
        ) : null}
        {paused ? (
          <CoordinatorBanner
            tone="info"
            icon={<Pause className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            action={
              <Button
                size="sm"
                variant="outline"
                disabled={operation !== null}
                onClick={() => setPaused(false)}
              >
                <Play className="size-3.5" />
                Resume
              </Button>
            }
          >
            Coordination is paused. Messages will wait until you resume.
          </CoordinatorBanner>
        ) : null}

        <HumanPromptBanner
          prompts={workerPrompts}
          label={(entry) =>
            environments.find((item) => item.id === entry.environmentId)?.name ??
            entry.environmentId
          }
        />

        <div className="relative flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1">
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
                  return (
                    <SortableCoordinatorTab
                      key={id}
                      conversationId={id}
                      paneId={pane.id}
                      isActive={pane.activeConversationId === id}
                      isFocused={paneFocused}
                      onClick={(event) => {
                        // Selecting is the whole action; the pane's own focus
                        // handler would only repeat it with the previous tab.
                        event.stopPropagation();
                        updateLayout((current) => focusCoordinatorPane(current, pane.id, id));
                        selectConversation(id);
                      }}
                      closeLabel={
                        item.role === "main"
                          ? `Close ${item.title}. The next message for the coordinator starts a new one with the default agent.`
                          : `Close ${item.title}`
                      }
                      onClose={() => {
                        if (item.role === "main") {
                          setPendingMainClose({ id: item.id, title: item.title });
                          return;
                        }
                        closeConversation(item.id);
                      }}
                    >
                      <button
                        type="button"
                        className="flex max-w-44 items-center gap-1.5"
                        // The badge is part of what identifies the tab, so it belongs in
                        // the accessible name rather than being read as loose text after it.
                        aria-label={
                          item.agent
                            ? `${item.title}, ${AGENT_PLATFORM_LABELS[item.agent]}`
                            : `${item.title}, no agent chosen yet`
                        }
                      >
                        {/* Which agent a conversation belongs to is fixed at its first
                        prompt and cannot be changed afterwards, so the tab strip is
                        where that has to be legible: the brand mark once assigned,
                        and an explicit prompt while it is not. */}
                        {item.agent ? (
                          <AgentPlatformIcon
                            platform={item.agent}
                            accent
                            className={TAB_ICON_CLASS}
                          />
                        ) : (
                          <MessagesSquare className={cn(TAB_ICON_CLASS, "text-muted-foreground")} />
                        )}
                        <span className="truncate">{item.title}</span>
                        {item.agent ? null : (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            Choose agent
                          </span>
                        )}
                      </button>
                    </SortableCoordinatorTab>
                  );
                }}
                renderStripActions={(pane) => (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-1 shrink-0"
                    disabled={operation !== null}
                    onClick={(event) => {
                      // The new conversation joins the focused group, so focus
                      // this one without selecting the tab it is about to replace.
                      event.stopPropagation();
                      updateLayout((current) => focusCoordinatorPane(current, pane.id));
                      createConversation();
                    }}
                  >
                    <Plus className="size-3.5" />
                    {newConversationLabel}
                  </Button>
                )}
                renderContent={(pane, paneFocused) =>
                  renderConversation(pane.activeConversationId, paneFocused)
                }
              />
            ) : null}
          </div>
          <CoordinatorWorkPanel
            items={work.items}
            counts={work.counts}
            openDelegations={work.openDelegations}
            onOpen={(target) => openCoordinatorWorkTarget(target)}
            onClearFinished={clearFinishedWork}
          />
        </div>
        <div className="shrink-0 border-t border-border/60 px-3 py-1 text-center text-[11px] text-muted-foreground">
          Code changes, commands, builds and fixes run in build pipelines or prompt environments.
        </div>
        <AlertDialog
          open={pendingSwitch !== null}
          onOpenChange={(open) => {
            if (!open) setPendingSwitch(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard changes and switch branch?</AlertDialogTitle>
              <AlertDialogDescription>
                Switching to {pendingSwitchBranch?.name ?? "the selected branch"} will permanently
                discard {pendingSwitch?.trackedChanges ?? 0} tracked changes and{" "}
                {pendingSwitch?.untrackedFiles ?? 0} untracked files from this checkout, including
                files inside untracked directories. Ignored files are kept.
                {pendingSwitch?.nestedRepositories.length
                  ? ` This will also permanently delete nested repositories: ${pendingSwitch.nestedRepositories.join(", ")}.`
                  : ""}
                {pendingSwitch?.dirtySubmodules.length
                  ? ` This will also reset dirty submodules: ${pendingSwitch.dirtySubmodules.join(", ")}.`
                  : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep changes</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  const confirmation = pendingSwitch;
                  setPendingSwitch(null);
                  if (confirmation) void runGit("switch", confirmation.ref, confirmation);
                }}
              >
                Discard and switch
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog
          open={pendingMainClose !== null}
          onOpenChange={(open) => {
            if (!open) setPendingMainClose(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Close the main conversation?</AlertDialogTitle>
              <AlertDialogDescription>
                {pendingMainClose?.title ?? "The main conversation"} will close. The next message to
                the coordinator starts a new main conversation with the default agent.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep open</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const target = pendingMainClose;
                  setPendingMainClose(null);
                  if (target) closeConversation(target.id);
                }}
              >
                Close conversation
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </CoordinatorPullRequestWatchProvider>
  );
}
