import { HumanPromptBanner } from "@/components/chat/HumanPromptBanner";
import { useHumanPrompts } from "@/hooks/useUserCommands";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  GitBranch,
  Hourglass,
  Loader2,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  MessagesSquare,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  coordinatorRuntimeId,
  type ProjectGitStatus,
  type ProjectGitSwitchConfirmation,
} from "@orkestrator/protocol/coordinator";
import { useCoordinatorPanelData } from "./useCoordinatorPanelData";
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
import { unusedCoordinatorConversationIds } from "@/lib/coordinator-unused-conversations";
import { useNativeNoticeDismissalStore } from "@/stores/nativeNoticeDismissalStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useStore } from "zustand";
import { portalStore } from "@/lib/portal/portal-store";
import { useProjectStore } from "@/stores/projectStore";
import {
  selectCoordinatorPaneLayout,
  useCoordinatorPaneLayoutStore,
} from "@/stores/coordinatorPaneLayoutStore";
import { shouldOfferUpstreamMerge } from "@/lib/coordinator-upstream-merge";
import {
  selectDeclinedUpstreamMerge,
  useCoordinatorUpstreamDeclineStore,
} from "@/stores/coordinatorUpstreamDeclineStore";

/** How long a message waits on the pre-send fetch before it is sent without asking. */
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
  // Asked before a message to the main coordinator when its checkout can merge
  // upstream commits it has not merged: it would otherwise read older code.
  const [upstreamMerge, setUpstreamMerge] = useState<{
    status: ProjectGitStatus;
    resolve: (choice: "merge" | "skip") => void;
  } | null>(null);
  const upstreamCheckLifetimeRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const lifetime = new AbortController();
    upstreamCheckLifetimeRef.current = lifetime;
    return () => lifetime.abort();
  }, [projectId]);
  const mergeActionRef = useRef<HTMLButtonElement>(null);
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
   * Tab groups. The layout is renderer presentation over the backend's open
   * conversations: reconciling adds conversations no group holds yet to the
   * focused group and drops closed ones, so it never decides what is open.
   * Nothing is reconciled before the first snapshot, which would otherwise
   * read as "every conversation closed" and discard the remembered layout.
   */
  const storedLayout = useCoordinatorPaneLayoutStore(selectCoordinatorPaneLayout(projectId));
  const setStoredLayout = useCoordinatorPaneLayoutStore((state) => state.setLayout);
  const layout = useMemo(
    () => (snapshot ? reconcileCoordinatorLayout(storedLayout, conversationIds) : null),
    [conversationIds, snapshot, storedLayout],
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
   * message to the main coordinator (its first prompt included), a
   * cooldown-bound fetch refreshes the "behind" state, and when the upstream
   * commits can be fast-forwarded the user is asked whether to merge them.
   *
   * Merging resolves only after the fast-forward, so the message then reads
   * the merged code; a failed fast-forward rejects, which the composer reports
   * with the draft kept. Declining resolves straight away and is remembered
   * against the upstream tip, so the question returns only with new commits.
   * A blocked checkout (local commits, uncommitted changes, an unfinished
   * operation) is not asked about: the header already says why it cannot sync.
   * Nor is one while any of this coordinator's conversations is running a
   * turn, since the backend refuses to change the checkout under it.
   */
  const confirmUpstreamMerge = useCallback(
    async (conversation: { role?: string }) => {
      const lifetime = upstreamCheckLifetimeRef.current;
      if (!lifetime || lifetime.signal.aborted) return false;
      if (conversation.role === "side") return;
      const current = snapshotRef.current;
      const projections = useNativeAgentProjectionStore.getState().projections;
      const turnRunning = current?.workspace.conversations.some((item) => {
        if (item.closedAt || !item.agent) return false;
        const phase = projections.get(
          createSessionKey(coordinatorRuntimeId(current.workspace.id, item.id), item.tabId),
        )?.turn.phase;
        return (
          phase === "running" ||
          phase === "blocked" ||
          phase === "cancelling" ||
          phase === "recovering"
        );
      });
      const homeIds = new Set(
        useEnvironmentStore
          .getState()
          .environments.filter(
            (environment) => environment.projectId === projectId && environment.projectHome,
          )
          .map((environment) => environment.id),
      );
      const homeRunning = Array.from(projections.values()).some(
        (projection) =>
          homeIds.has(projection.environmentId) &&
          ["running", "blocked", "cancelling", "recovering"].includes(projection.turn.phase),
      );
      if (turnRunning || homeRunning) return;
      let cancel!: () => void;
      const cancelled = new Promise<false>((resolve) => {
        cancel = () => resolve(false);
        lifetime.signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        // An unreachable or slow remote is no reason to hold the message: past
        // the bound it is sent without asking, and the fetch still lands.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const status = await Promise.race([
          cancelled,
          backend
            .fetchProjectGit(projectId)
            .then((fetched) => {
              if (!lifetime.signal.aborted) setGit(fetched);
              return fetched;
            })
            .catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), UPSTREAM_CHECK_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        if (lifetime.signal.aborted || status === false) return false;
        const declined = selectDeclinedUpstreamMerge(projectId)(
          useCoordinatorUpstreamDeclineStore.getState(),
        );
        if (!status || !shouldOfferUpstreamMerge(status, declined)) return;
        const choice = await Promise.race([
          cancelled,
          new Promise<"merge" | "skip">((resolve) => setUpstreamMerge({ status, resolve })),
        ]);
        if (lifetime.signal.aborted || choice === false) return false;
        setUpstreamMerge(null);
        if (choice === "skip") {
          if (status.upstream && status.upstreamCommit) {
            useCoordinatorUpstreamDeclineStore.getState().decline(projectId, {
              upstream: status.upstream,
              upstreamCommit: status.upstreamCommit,
            });
          }
          return;
        }
        setOperation("sync");
        setError(null);
        try {
          const synced = await backend.syncProjectGit(projectId);
          if (lifetime.signal.aborted) return false;
          setGit(synced);
          await refreshView();
          if (lifetime.signal.aborted) return false;
        } catch (cause) {
          if (
            cause instanceof Error &&
            cause.message === "Stop the active coordinator turn before changing the checkout"
          )
            return;
          void backend
            .getProjectGitStatus(projectId)
            .then(setGit)
            .catch(() => undefined);
          throw cause;
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
  const environments = useEnvironmentStore((state) => state.environments);
  // Workers on other nodes are named from the command node's summaries.
  const nodes = useStore(portalStore.store, (state) => state.nodes);
  /*
   * Workers this coordinator is still owed an answer by.
   *
   * Derived from the snapshot's durable associations rather than anything this
   * component observed, so it is correct on a fresh mount, after a reload, and
   * after the page was closed for an hour — the coordinator keeps waiting while
   * nobody is looking at it.
   *
   * Associations are project-wide, so the selected conversation identity is a
   * load-bearing filter rather than presentation state.
   *
   * `needsPerson` is the delegation's waiting episode, which status wakes
   * record from the worker tab's own turn activity (never the environment
   * aggregate) and announce as a coordinator change when it starts or ends.
   */
  const awaitingWorkers = useMemo(() => {
    if (!snapshot || !selected) return [];
    return snapshot.workflows.flatMap((association) => {
      if (
        association.coordinatorId !== snapshot.workspace.id ||
        association.conversationId !== selected.id ||
        association.delegation?.state !== "running"
      )
        return [];
      if (association.nodeId) {
        const node = nodes.find((item) => item.nodeId === association.nodeId);
        const remote = node?.environments.find(
          (item) => item.ref.environmentId === association.resourceId,
        );
        return [
          {
            id: association.id,
            environmentId: association.resourceId,
            label: `${remote?.name ?? association.resourceId} on ${node?.view.displayName ?? association.nodeId}`,
            needsPerson: Boolean(association.delegation.waiting),
          },
        ];
      }
      const environment = environments.find((item) => item.id === association.resourceId);
      return [
        {
          id: association.id,
          environmentId: association.resourceId,
          label: environment?.name ?? association.resourceId,
          needsPerson: Boolean(association.delegation.waiting),
        },
      ];
    });
  }, [snapshot, selected, environments, nodes]);
  const workersNeedingPerson = awaitingWorkers.filter((worker) => worker.needsPerson).length;
  /*
   * Commands in this coordinator's workers that are waiting on the user — a
   * sign-in link, a code, a password — shown here so the person talking to
   * the coordinator sees them without opening the worker.
   */
  const workerEnvironmentIds = useMemo(
    () =>
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
    [snapshot],
  );
  const workerPrompts = useHumanPrompts(workerEnvironmentIds);
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
  const newestContextEvent = snapshot?.workspace.repositoryContextEvents?.at(-1);
  const contextNoticeSessionIdentity = snapshot
    ? `coordinator\u0000${projectId}\u0000${snapshot.workspace.id}\u0000${selected?.id ?? "none"}`
    : undefined;
  const contextNoticeOccurrenceId = newestContextEvent
    ? `repository-context\u0000${newestContextEvent.revision}`
    : undefined;
  const contextNoticeDismissed = useNativeNoticeDismissalStore((state) =>
    contextNoticeSessionIdentity && contextNoticeOccurrenceId
      ? (state.sessions
          .find((session) => session.sessionIdentity === contextNoticeSessionIdentity)
          ?.occurrenceIds.includes(contextNoticeOccurrenceId) ?? false)
      : false,
  );
  const dismissNotice = useNativeNoticeDismissalStore((state) => state.dismiss);
  const latestContextEvent =
    newestContextEvent &&
    (selected?.repositoryContextRevisionAcknowledged ?? 0) < newestContextEvent.revision &&
    !contextNoticeDismissed
      ? newestContextEvent
      : undefined;

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
    if (conversation.agent && !providerState?.available) {
      return (
        <div className="grid h-full place-items-center p-8 text-center">
          <div className="max-w-lg">
            <AlertCircle className="mx-auto mb-3 size-7 text-amber-300" />
            <h2 className="font-semibold">
              {AGENT_PLATFORM_LABELS[conversation.agent]} is unavailable for Coordinator
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {providerState?.reason ?? snapshot.workspace.lastStartupError}
            </p>
          </div>
        </div>
      );
    }
    if (snapshot.workspace.lifecycleState === "error") {
      return (
        <div className="grid h-full place-items-center p-8 text-center">
          <div className="max-w-lg">
            <AlertCircle className="mx-auto mb-3 size-7 text-destructive" />
            <h2 className="font-semibold">Coordinator startup failed</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {snapshot.workspace.lastStartupError ?? "The coordinator could not be started."}
            </p>
            <Button className="mt-4" variant="outline" onClick={() => void load()}>
              <RotateCcw className="size-4" />
              Retry
            </Button>
          </div>
        </div>
      );
    }
    if (snapshot.workspace.lifecycleState === "paused") {
      return (
        <div className="grid h-full place-items-center text-center">
          <div>
            <Pause className="mx-auto mb-3 size-7 text-muted-foreground" />
            <p>Coordination is paused. Messages and new turns will wait.</p>
          </div>
        </div>
      );
    }
    // Scoped to the conversation that produced it, so another group cannot
    // replay one conversation's first prompt into its own.
    const launch = pendingLaunch?.conversationId === conversation.id ? pendingLaunch : null;
    const environmentId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    return (
      <div key={conversation.id} className="flex h-full min-h-0 flex-col">
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
            unassignedPlaceholder="Ask the coordinator to inspect or plan…"
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

  return (
    <div
      id="project-panel-coordinator"
      role="tabpanel"
      data-agent-scope=""
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="shrink-0 border-b border-border/70 bg-chrome px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="flex min-w-0 items-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200">
            <LockKeyhole className="size-3.5" />
            Read-only coordinator
          </span>
          <code
            className="max-w-[28rem] truncate text-xs text-muted-foreground"
            title={snapshot.projectPath}
          >
            {snapshot.projectPath}
          </code>
          <span
            className="rounded bg-elevated px-1.5 py-1 text-[11px] text-muted-foreground"
            title="Branch or HEAD changes increment this context. Earlier analysis may describe an older revision."
          >
            Context r{snapshot.workspace.repositoryContextRevision}
          </span>
          {awaitingWorkers.length > 0 ? (
            <span
              className="flex items-center gap-1.5 rounded bg-elevated px-1.5 py-1 text-[11px] text-muted-foreground"
              data-awaiting-workers={awaitingWorkers.length}
              data-workers-need-person={workersNeedingPerson || undefined}
              title={`Coordinator is idle. It will be woken once each of these workers finishes.\n${awaitingWorkers
                .map((worker) =>
                  worker.needsPerson
                    ? `${worker.label}: waiting for you (an approval or a question in its tab)`
                    : worker.label,
                )
                .join("\n")}`}
            >
              <Hourglass className="size-3" />
              Waiting on {awaitingWorkers.length}{" "}
              {awaitingWorkers.length === 1 ? "worker" : "workers"}
              {workersNeedingPerson > 0 ? (
                <span className="flex items-center gap-1 text-amber-300">
                  <AlertCircle className="size-3" aria-hidden="true" />
                  {workersNeedingPerson} {workersNeedingPerson === 1 ? "needs" : "need"} you
                </span>
              ) : null}
            </span>
          ) : null}
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
          <Button
            size="sm"
            variant="outline"
            disabled={operation !== null}
            onClick={() => {
              setOperation("conversation");
              setError(null);
              const action =
                snapshot.workspace.lifecycleState === "paused"
                  ? backend.resumeProjectCoordinator
                  : backend.pauseProjectCoordinator;
              void action(projectId)
                .then(setSnapshot)
                .catch((cause) =>
                  setError(cause instanceof Error ? cause.message : "Could not update Coordinator"),
                )
                .finally(() => setOperation(null));
            }}
          >
            {snapshot.workspace.lifecycleState === "paused" ? (
              <Play className="size-3.5" />
            ) : (
              <Pause className="size-3.5" />
            )}
            {snapshot.workspace.lifecycleState === "paused" ? "Resume" : "Pause"}
          </Button>
        </div>
        {dirty ? (
          <p className="mt-1 text-xs text-amber-300">
            The checkout has {git?.trackedChanges} tracked and {git?.untrackedChanges} untracked
            changes. Sync is blocked
            {discardableDirty ? "; switching branches will ask before discarding them." : "."}
          </p>
        ) : null}
        {blocked && switchBlocked ? <p className="mt-1 text-xs text-amber-300">{blocked}</p> : null}
        {git?.lastError || error ? (
          <details className="mt-1 text-xs text-red-300">
            <summary className="cursor-pointer">Repository or coordinator error</summary>
            <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap">
              {git?.lastError?.stderr ?? git?.lastError?.message ?? error}
            </pre>
          </details>
        ) : null}
        {!snapshot.controlMcp.enabled || !snapshot.controlMcp.running ? (
          <p className="mt-1 text-xs text-amber-300">
            Orchestration controls are unavailable because Control MCP is{" "}
            {snapshot.controlMcp.enabled ? "not running" : "disabled"}
            {snapshot.controlMcp.error ? `: ${snapshot.controlMcp.error}` : "."}
          </p>
        ) : null}
      </div>

      <HumanPromptBanner
        prompts={workerPrompts}
        label={(entry) =>
          environments.find((item) => item.id === entry.environmentId)?.name ?? entry.environmentId
        }
      />

      {latestContextEvent ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-3 border-b border-blue-400/20 bg-blue-400/5 px-3 py-1.5 text-xs text-blue-200"
        >
          <span className="min-w-0 flex-1">
            Repository context changed to {latestContextEvent.branch ?? "detached HEAD"} at{" "}
            <code>{latestContextEvent.headCommit?.slice(0, 12) ?? "an unborn commit"}</code>{" "}
            (context r{latestContextEvent.revision}). Earlier analysis may be stale; the next turn
            receives the new context.
          </span>
          <button
            type="button"
            aria-label="Dismiss repository context notice"
            title="Dismiss notice"
            className="shrink-0 cursor-pointer rounded-sm opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
            onClick={() => {
              if (contextNoticeSessionIdentity && contextNoticeOccurrenceId) {
                dismissNotice(contextNoticeSessionIdentity, contextNoticeOccurrenceId);
              }
            }}
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
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
                    setOperation("conversation");
                    void backend
                      .closeCoordinatorConversation(projectId, item.id)
                      .then(setSnapshot)
                      .catch((cause) =>
                        setError(
                          cause instanceof Error ? cause.message : "Could not close conversation",
                        ),
                      )
                      .finally(() => setOperation(null));
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
                      <AgentPlatformIcon platform={item.agent} accent className={TAB_ICON_CLASS} />
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
      <div className="shrink-0 border-t border-border/60 px-3 py-1 text-center text-[11px] text-muted-foreground">
        Coordinator can inspect and plan against this checkout. Code changes, commands, builds, and
        fixes run in disposable worker environments.
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
        open={upstreamMerge !== null}
        onOpenChange={(open) => {
          // Escape and "Don't merge" both send without merging.
          if (!open) upstreamMerge?.resolve("skip");
        }}
      >
        <AlertDialogContent
          onOpenAutoFocus={(event) => {
            // Enter merges: the default action, not the dismissal Radix focuses.
            event.preventDefault();
            mergeActionRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Merge {upstreamMerge?.status.behind} upstream{" "}
              {upstreamMerge?.status.behind === 1 ? "commit" : "commits"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              There {upstreamMerge?.status.behind === 1 ? "is" : "are"}{" "}
              {upstreamMerge?.status.behind} upstream{" "}
              {upstreamMerge?.status.behind === 1 ? "commit" : "commits"} on{" "}
              {upstreamMerge?.status.upstream} that{" "}
              {upstreamMerge?.status.behind === 1 ? "hasn’t" : "haven’t"} been merged into{" "}
              {upstreamMerge?.status.branch ?? "this checkout"}. Do you wish to merge{" "}
              {upstreamMerge?.status.behind === 1 ? "it" : "them"}? Merging fast-forwards the
              checkout before your message is sent, so the coordinator reads the latest code.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Don’t merge</AlertDialogCancel>
            <AlertDialogAction ref={mergeActionRef} onClick={() => upstreamMerge?.resolve("merge")}>
              Merge and send
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
