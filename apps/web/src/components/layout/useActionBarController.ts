import { environmentDeletionFailure } from "@orkestrator/protocol/node-summaries";
import { useEnvironmentChangeProjection } from "@/hooks/useChangeProjection";
import { environmentBrowserTarget } from "@/lib/preview-service-entry";
import {
  ensurePreviewServiceSync,
  previewServiceStore,
  usePreviewServiceStore,
} from "@/stores/previewServiceStore";
import {
  agentSettingsTiers,
  resolvedActionDefault,
  resolvedDefaultAgent,
} from "@/lib/agent-settings";
import {
  resolveActionDefaults,
  resolveAgentPlatformSettings,
} from "@orkestrator/protocol/agent-settings";
import { isEnvironmentSetupSettled } from "@orkestrator/protocol/environment-readiness";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  useUIStore,
  type ProjectBoardTab,
  useEnvironmentStore,
  useProjectStore,
  useConfigStore,
  useFilesPanelStore,
  multiReviewStore,
} from "@/stores";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { useTerminalContext, MAX_TABS, type AgentLaunchModeOverride } from "@/contexts";
import type { DefaultAgent, Environment } from "@/types";
import type {
  ActionDefaultKey,
  ResolvedActionDefault,
} from "@orkestrator/protocol/action-defaults";
import { usePullRequest, useEnvironments } from "@/hooks";
import {
  createPushChangesPrompt,
  createReviewPrompt,
  defaultPrTargetBranch,
  resolvePrTargetBranch,
  PUSH_CHANGES_TAB_TITLE,
  REVIEW_TAB_TITLE,
} from "@orkestrator/protocol/git-workflow-prompts";
import { createOrkestratorScriptPrompt } from "@orkestrator/protocol/orkestrator-script-prompt";
import { createPRPrompt, createResolveConflictsPrompt } from "@orkestrator/protocol/pr-prompt";
import { backendForScope } from "@/lib/backend/scope-backend";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { getEnvironmentBrowserUrl, getEnvironmentPortAddress } from "@/lib/environment-address";
import { isBackendOnAnotherDevice, isGatewayBrowserPreviewSupported } from "@/lib/gateway-url";
import { showTabLimitReachedToast } from "@/lib/tab-limit-toast";
import { onAppShortcut } from "@/lib/app-shortcuts";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { beginTabLaunch, claimTabLaunch, type TabLaunchHandle } from "@/lib/tab-launch";
import type { TabLaunchSurface } from "@/stores/tabLaunchStore";
import { getReviewAgent, type ReviewLaunchSelection } from "@/components/review/ReviewLaunchDialog";
import { type MultiReviewLaunchSelection } from "@/components/review/MultiReviewLaunchDialog";
import { type AgentLaunchSelection } from "@/components/launch/AgentLaunchDialog";
import { useReviewModelCatalog } from "@/hooks/useBuildLaunchOptions";
import { modelSupportsSpeed } from "@/lib/agent-launch";
import { useLongPressAction } from "@/hooks/useLongPressAction";
import { handTabInitialPromptToBackend } from "@/lib/tab-initial-prompt";
import { createUuid } from "@/lib/uuid";
import {
  paneLayoutStore,
  usePaneLayoutStore,
  getAllLeaves,
  type EnvironmentPaneState,
} from "@/stores/paneLayoutStore";
import { legacyLaunchMultiReview } from "@/lib/multi-review-launch-compat";
import { findProjectHomeEnvironment } from "@/lib/project-home";
import { prTargetBranchSuggestions } from "@/lib/pr-target-branches";
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";
import { mergePrControl } from "@/lib/merge-pr-control";
import { useMergePrRequestStore } from "@/stores/mergePrRequestStore";
import { toast } from "sonner";
import type { ResolveLaunchResult } from "./ActionBar.types";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { useScopeBackend } from "@/hooks/useScopeBackend";

const log = createLogger("web.action-bar");

/**
 * A Create PR launch that has not yet produced a pull request.
 *
 * The claim exists to keep a second launch out while the first agent works, so
 * it has to be released the moment that work can no longer finish.
 */
interface CreatePrLaunchClaim {
  /** Tab the launch published; null until the backend acknowledges it. */
  tabId: string | null;
  /** Whether that tab has been seen in the pane layout at least once. */
  tabSeen: boolean;
  /** Wall-clock when this environment's claim was first taken. */
  claimedAt: number;
  /** Whether the backend accepted the launch and now owns a live session. */
  acknowledged: boolean;
}

/**
 * How long an unacknowledged claim waits before releasing itself. This covers
 * a hung `launchNativeAgentJob` only. Once the backend accepts the launch the
 * claim stays until a PR appears, the launched tab is closed, or the tab is
 * known to have appeared and already been torn down.
 */
export const CREATE_PR_TAB_GRACE_MS = 60_000;

/** Tab ids currently published in an environment's live pane layout. */
function listEnvironmentTabIds(
  environments: ReadonlyMap<string, EnvironmentPaneState>,
  environmentId: string,
): string[] {
  const environmentState = environments.get(environmentId);
  if (!environmentState) return [];
  return getAllLeaves(environmentState.root).flatMap((leaf) => leaf.tabs.map((tab) => tab.id));
}

/** Whether an environment's live pane layout still holds a given tab. */
function isTabOpen(
  environments: ReadonlyMap<string, EnvironmentPaneState>,
  environmentId: string,
  tabId: string,
): boolean {
  return listEnvironmentTabIds(environments, environmentId).includes(tabId);
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return !!target.closest("input, textarea, select, [contenteditable='true'], .xterm");
}

export interface ActionBarControllerInput {
  presentation: "bar" | "grid";
}

export function useActionBarController({ presentation }: ActionBarControllerInput) {
  const nodeBackend = useScopeBackend();
  const dockerAvailable = useDockerAvailability();
  const isGrid = presentation === "grid";
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const selectProject = useUIStore((state) => state.selectProject);
  const setProjectCollapsed = useUIStore((state) => state.setProjectCollapsed);
  const selectEnvironment = useUIStore((state) => state.selectEnvironment);
  const projectBoardTab = useUIStore((state) => state.projectBoardTab);
  const setProjectBoardTab = useUIStore((state) => state.setProjectBoardTab);
  const selectedEnvironment = useEnvironmentStore((state) =>
    selectedEnvironmentId
      ? state.environments.find((environment) => environment.id === selectedEnvironmentId)
      : undefined,
  );
  const workspaceReady = isEnvironmentSetupSettled(selectedEnvironment);
  const setupRunning = selectedEnvironment?.setupPhase === "running";
  const getProjectById = useProjectStore((state) => state.getProjectById);
  const config = useConfigStore((state) => state.config);
  const { createTab, selectTab, tabCount } = useTerminalContext();
  const filesPanelOpen = useFilesPanelChromeStore((state) => state.isOpen);
  const toggleFilesPanelStore = useFilesPanelChromeStore((state) => state.togglePanel);
  const openFilesPanelOnAllFiles = useFilesPanelStore((state) => state.openPanelOnAllFiles);
  const changes = useFilesPanelStore((state) => state.changes);
  // The Files button's dot follows the environment's backend measurement; the
  // panel's legacy list is only the fallback for a backend without one.
  const changeProjection = useEnvironmentChangeProjection(selectedEnvironmentId);
  const hasChanges = changeProjection ? changeProjection.badge.visible : changes.length > 0;
  const sidebarOpen = useUIChromeStore((state) => state.sidebarOpen);
  const toggleSidebar = useUIChromeStore((state) => state.toggleSidebar);

  const [isOpeningEditor, setIsOpeningEditor] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [runCommands, setRunCommands] = useState<string[] | null>(null);
  const [isLoadingRunCommands, setIsLoadingRunCommands] = useState(false);
  /** Bumped to re-read orkestrator-ai.json without changing the environment. */
  const [runCommandsRescanToken, setRunCommandsRescanToken] = useState(0);
  /** Source of the last run-command load; a repeat read of it refreshes quietly. */
  const runCommandsSourceRef = useRef<string | null>(null);
  const agentActivityObservationRef = useRef<{
    environmentId: string | null;
    state: Environment["agentActivityState"];
    completedAt: Environment["agentSessionCompletedAt"];
  }>({ environmentId: null, state: undefined, completedAt: undefined });
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [cleanupTarget, setCleanupTarget] = useState<{
    environmentId: string;
    environmentName: string;
    isMerged: boolean;
  } | null>(null);
  const cleanupTargetRef = useRef(cleanupTarget);
  cleanupTargetRef.current = cleanupTarget;
  const [deletingEnvironmentId, setDeletingEnvironmentId] = useState<string | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  // The trash button's confirmation stays with the environment it was opened
  // for, so a selection change underneath it cannot retarget the deletion.
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const deleteTarget = useEnvironmentStore((state) =>
    deleteTargetId
      ? (state.environments.find((environment) => environment.id === deleteTargetId) ?? null)
      : null,
  );
  const [mergeDialogOpenState, setMergeDialogOpenState] = useState(false);
  const [mergingEnvironmentId, setMergingEnvironmentId] = useState<string | null>(null);
  // A row's "Merge PR" menu item selects its environment and asks for the
  // dialog the green button opens. Eligibility is checked once on admission;
  // an admitted dialog has the same lifetime as one opened with the button.
  const mergePrRequest = useMergePrRequestStore((state) => state.request);
  // The selected environment is on this action bar's node; a request for the
  // same id on another node is not for it.
  const actionBarScope = useScopesWithCommandFallback().scope;
  const actionBarNodeId = actionBarScope.nodeId;
  // The selected environment's pane layouts, on the same node (plan item 3013).
  const paneLayouts = actionBarScope.store(paneLayoutStore);
  const selectedMergePrControl = selectedEnvironment
    ? mergePrControl(selectedEnvironment, {
        dockerAvailable,
        merging: mergingEnvironmentId === selectedEnvironmentId,
      })
    : null;
  const mergePrRequested =
    mergePrRequest !== null &&
    mergePrRequest.nodeId === actionBarNodeId &&
    mergePrRequest.environmentId === selectedEnvironmentId &&
    selectedMergePrControl?.disabled === false;
  const [handledMergePrNonce, setHandledMergePrNonce] = useState<number | null>(null);
  // Adjust this component's state before committing a new request, so later
  // readiness updates cannot dismiss a confirmation the user is reading.
  if (mergePrRequest && mergePrRequest.nonce !== handledMergePrNonce) {
    setHandledMergePrNonce(mergePrRequest.nonce);
    if (mergePrRequested) setMergeDialogOpenState(true);
  }
  const mergeDialogOpen = mergeDialogOpenState;
  const setMergeDialogOpen = useCallback((open: boolean) => {
    setMergeDialogOpenState(open);
    if (open) return;
    const request = useMergePrRequestStore.getState().request;
    if (request) useMergePrRequestStore.getState().clearMergePrRequest(request.nonce);
  }, []);
  useEffect(() => {
    if (mergePrRequest) {
      useMergePrRequestStore.getState().clearMergePrRequest(mergePrRequest.nonce);
    }
  }, [mergePrRequest]);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [resolveLaunchEnvironmentId, setResolveLaunchEnvironmentId] = useState<string | null>(null);

  const resolveLaunchEnvironmentIdRef = useRef<string | null>(null);
  const selectedEnvironmentIdRef = useRef(selectedEnvironmentId);
  selectedEnvironmentIdRef.current = selectedEnvironmentId;
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [scriptDialogEnvironmentId, setScriptDialogEnvironmentId] = useState<string | null>(null);
  const [scriptLaunchError, setScriptLaunchError] = useState<string | null>(null);
  const scriptDialogOpen = scriptDialogEnvironmentId !== null;
  const scriptSubmitRef = useRef(false);
  const [scriptSubmitting, setScriptSubmitting] = useState(false);
  const createScriptButtonRef = useRef<HTMLButtonElement>(null);
  const [multiReviewDialogOpen, setMultiReviewDialogOpen] = useState(false);
  const [multiReviewLaunchPending, setMultiReviewLaunchPending] = useState(false);
  const multiReviewLaunchInFlightRef = useRef(false);
  const [prDialogTarget, setPrDialogTarget] = useState<{
    environmentId: string;
    projectId: string;
    targetBranch: string;
  } | null>(null);
  const [prLaunchError, setPrLaunchError] = useState<string | null>(null);
  const [prBranchSuggestions, setPrBranchSuggestions] = useState<string[]>([]);
  const prBranchRequestRef = useRef(0);
  const prDialogOpen = prDialogTarget !== null;
  const createPrButtonRef = useRef<HTMLButtonElement>(null);
  const createPrLaunchClaimsRef = useRef(new Map<string, CreatePrLaunchClaim>());
  const [createPrLaunchClaims, setCreatePrLaunchClaims] = useState<
    ReadonlyMap<string, CreatePrLaunchClaim>
  >(() => new Map());
  /** Tab ids observed in an environment while its claim was still unbound. */
  const pendingSeenTabIdsRef = useRef(new Map<string, Set<string>>());
  /** One grace timer per unacknowledged claim; later claims must not reset it. */
  const createPrGraceTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [resolveDialogTarget, setResolveDialogTarget] = useState<{
    environmentId: string;
    projectId: string;
    targetBranch: string;
  } | null>(null);
  const [resolveLaunchError, setResolveLaunchError] = useState<string | null>(null);
  const resolveDialogOpen = resolveDialogTarget !== null;
  const resolveButtonRef = useRef<HTMLButtonElement>(null);

  const anyLaunchDialogOpen =
    reviewDialogOpen ||
    scriptDialogOpen ||
    multiReviewDialogOpen ||
    prDialogOpen ||
    resolveDialogOpen;
  const reviewModelCatalog = useReviewModelCatalog(selectedProjectId ?? "", anyLaunchDialogOpen);
  // Drag-to-scroll state for toolbar
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);

  const selectedProject = selectedProjectId ? getProjectById(selectedProjectId) : null;
  // A project's page runs on its project home, the environment that works
  // directly in the checkout: the toolbar's environment controls target it
  // while the project tabs choose between its own tabs and the board panels.
  const isProjectHomeSelected = selectedEnvironment?.projectHome === true;
  const isProjectView = !!selectedProject && (!selectedEnvironment || isProjectHomeSelected);
  /** A board panel, rather than environment tabs, fills the main view. */
  const isProjectBoardView =
    isProjectView && (!isProjectHomeSelected || projectBoardTab !== "home");
  const projectDeleting = useProjectStore((state) =>
    state.deletingProjects.has(selectedProjectId ?? ""),
  );
  const projectHomeId = useEnvironmentStore((state) =>
    selectedProjectId && !projectDeleting
      ? (findProjectHomeEnvironment(
          state.environments,
          selectedProjectId,
          state.deletingEnvironments,
        )?.id ?? null)
      : null,
  );
  // The project board shows the project's own checkout in the files panel, so
  // the toggle stays available whenever the project has one configured.
  const hasProjectCheckout = !!selectedProject?.localPath?.trim();
  const canToggleFilesPanel = !!selectedEnvironment || (isProjectView && hasProjectCheckout);
  const toggleFilesPanel = useCallback(() => {
    // Nothing is being changed on the project board, so the checkout opens on
    // its file tree rather than an empty change list.
    if (!filesPanelOpen && isProjectBoardView && hasProjectCheckout) {
      openFilesPanelOnAllFiles();
      return;
    }
    toggleFilesPanelStore();
  }, [
    filesPanelOpen,
    isProjectBoardView,
    hasProjectCheckout,
    openFilesPanelOnAllFiles,
    toggleFilesPanelStore,
  ]);

  // Jobs launched from the board run in the project home, whose tabs the
  // board covers. Bring them forward so the launched tab is visible.
  const projectHomeRevealRef = useRef<{ homeId: string | null; tab: ProjectBoardTab }>({
    homeId: null,
    tab: projectBoardTab,
  });
  projectHomeRevealRef.current = {
    homeId: isProjectHomeSelected ? (selectedEnvironmentId ?? null) : null,
    tab: projectBoardTab,
  };
  // Focus moves when the user presses, not when the backend finishes.
  const beginLaunchedTab = useCallback(
    (environmentId: string, tabId: string, title: string, surface: TabLaunchSurface = "agent") => {
      const { homeId, tab } = projectHomeRevealRef.current;
      if (homeId === environmentId && tab !== "home") setProjectBoardTab("home");
      return beginTabLaunch(environmentId, { tabId, title, surface }, actionBarScope);
    },
    [actionBarScope, setProjectBoardTab],
  );

  const openProjectBoardTab = useCallback(
    (tab: typeof projectBoardTab) => {
      if (!selectedProjectId) return;
      setProjectBoardTab(tab);
      selectEnvironment(projectHomeId);
    },
    [projectHomeId, selectEnvironment, selectedProjectId, setProjectBoardTab],
  );

  const isCleanupTargetDeleting = Boolean(
    cleanupTarget &&
    (deletingEnvironmentId === cleanupTarget.environmentId ||
      (selectedEnvironmentId === cleanupTarget.environmentId &&
        selectedEnvironment &&
        !environmentDeletionFailure(selectedEnvironment) &&
        (selectedEnvironment.lifecycleOperation === "deleting" ||
          selectedEnvironment.deletionRequestedAt))),
  );
  const isMerging = Boolean(
    selectedEnvironmentId &&
    (mergingEnvironmentId === selectedEnvironmentId ||
      selectedEnvironment?.lifecycleOperation === "merging"),
  );

  const isLocalEnvironment = selectedEnvironment?.environmentType === "local";
  const isLocalReady = isLocalEnvironment && !!selectedEnvironment?.worktreePath;
  const isRunning =
    isLocalReady ||
    (dockerAvailable && !isLocalEnvironment && selectedEnvironment?.status === "running");

  const {
    prUrl,
    prState,
    hasMergeConflicts,
    checkSummary,
    monitorSyncStatus,
    lastSuccessfulCheckAt,
    viewPR,
    setModeCreatePending,
  } = usePullRequest({
    environmentId: selectedEnvironmentId,
  });

  const { deleteEnvironment } = useEnvironments(selectedProjectId, {
    listenForRenameEvents: false,
  });

  const hasPR = !!prUrl;
  const createPrLaunchPending = Boolean(
    selectedEnvironmentId && createPrLaunchClaims.has(selectedEnvironmentId),
  );
  const isPRMerged = prState === "merged";
  const cleanupTargetIsMerged = cleanupTarget?.isMerged ?? isPRMerged;
  const isPRClosed = prState === "closed";
  const isPRFinished = isPRMerged || isPRClosed;
  const isSelectedEnvironmentDeleting = Boolean(
    selectedEnvironment &&
    !environmentDeletionFailure(selectedEnvironment) &&
    (selectedEnvironment.lifecycleOperation === "deleting" ||
      selectedEnvironment.deletionRequestedAt),
  );
  // In flight from this window only. A deletion that failed keeps its record's
  // marker, and deleting again retries it, as it does from a row.
  const isSelectedEnvironmentDeleteInFlight = useEnvironmentStore((state) =>
    selectedEnvironmentId ? state.deletingEnvironments.has(selectedEnvironmentId) : false,
  );

  const releaseCreatePrLaunch = useCallback((environmentId: string) => {
    pendingSeenTabIdsRef.current.delete(environmentId);
    const timer = createPrGraceTimersRef.current.get(environmentId);
    if (timer) {
      clearTimeout(timer);
      createPrGraceTimersRef.current.delete(environmentId);
    }
    if (!createPrLaunchClaimsRef.current.delete(environmentId)) return;
    setCreatePrLaunchClaims(new Map(createPrLaunchClaimsRef.current));
  }, []);

  const bindCreatePrLaunchTab = useCallback(
    (environmentId: string, tabId: string) => {
      const { environments } = paneLayouts.getState();
      const tabOpen = isTabOpen(environments, environmentId, tabId);
      const seenDuringPending =
        pendingSeenTabIdsRef.current.get(environmentId)?.has(tabId) ?? false;
      pendingSeenTabIdsRef.current.delete(environmentId);

      // The tab appeared and left while launchNativeAgentJob was still in
      // flight. Presence could not bind it then, so treat it as already torn
      // down instead of waiting out the grace period.
      if (!tabOpen && seenDuringPending) {
        releaseCreatePrLaunch(environmentId);
        return;
      }

      const existing = createPrLaunchClaimsRef.current.get(environmentId);
      createPrLaunchClaimsRef.current.set(environmentId, {
        tabId,
        tabSeen: tabOpen,
        claimedAt: existing?.claimedAt ?? Date.now(),
        acknowledged: true,
      });
      setCreatePrLaunchClaims(new Map(createPrLaunchClaimsRef.current));
    },
    [releaseCreatePrLaunch, paneLayouts],
  );

  useEffect(() => {
    if (hasPR && selectedEnvironmentId) {
      releaseCreatePrLaunch(selectedEnvironmentId);
    }
  }, [hasPR, releaseCreatePrLaunch, selectedEnvironmentId]);

  // Change key for the claimed tabs' presence. The selector collapses the pane
  // tree to a primitive so the pane store's unrelated writes (active tab,
  // browser URLs, splits) cannot re-render the whole toolbar. Pending claims
  // stay a constant token: their tabs are recorded by a store subscription
  // that does not need to render.
  const createPrLaunchTabPresence = usePaneLayoutStore((state) =>
    [...createPrLaunchClaims]
      .map(([environmentId, claim]) =>
        claim.tabId
          ? `${environmentId}:${isTabOpen(state.environments, environmentId, claim.tabId) ? "open" : "gone"}`
          : `${environmentId}:pending`,
      )
      .join(","),
  );

  // Remember every tab that appears while a claim is still unbound so bind can
  // tell "published then closed" from "not published yet".
  useEffect(() => {
    if (createPrLaunchClaims.size === 0) return;
    const recordPendingSeenTabs = () => {
      const { environments } = paneLayouts.getState();
      for (const [environmentId, claim] of createPrLaunchClaimsRef.current) {
        if (claim.tabId) continue;
        let seen = pendingSeenTabIdsRef.current.get(environmentId);
        if (!seen) {
          seen = new Set();
          pendingSeenTabIdsRef.current.set(environmentId, seen);
        }
        for (const tabId of listEnvironmentTabIds(environments, environmentId)) {
          seen.add(tabId);
        }
      }
    };
    recordPendingSeenTabs();
    return paneLayouts.subscribe(recordPendingSeenTabs);
  }, [createPrLaunchClaims, paneLayouts]);

  // A claim survives its launch only while the tab that owns the work is open.
  // Closing that tab tears the session down (Codex interrupt included), so a
  // claim held past the close would leave Create PR disabled with nothing left
  // running that could ever release it.
  useEffect(() => {
    const claims = createPrLaunchClaimsRef.current;
    if (claims.size === 0) return;
    const { environments } = paneLayouts.getState();
    let changed = false;
    for (const [environmentId, claim] of Array.from(claims)) {
      if (!claim.tabId) continue;
      if (isTabOpen(environments, environmentId, claim.tabId)) {
        if (claim.tabSeen) continue;
        claims.set(environmentId, { ...claim, tabSeen: true });
        changed = true;
      } else if (claim.tabSeen) {
        claims.delete(environmentId);
        pendingSeenTabIdsRef.current.delete(environmentId);
        changed = true;
      }
    }
    if (changed) setCreatePrLaunchClaims(new Map(claims));
    // `createPrLaunchTabPresence` is the trigger, not an input: the effect reads
    // the same state it was computed from, one level below the memoized key.
  }, [createPrLaunchTabPresence, paneLayouts]);

  // One timer per unacknowledged claim, keyed by that claim's own claimedAt.
  // A later Create PR in another environment must not restart this one, and an
  // accepted launch is never released by wall-clock alone.
  useEffect(() => {
    const timers = createPrGraceTimersRef.current;
    const claims = createPrLaunchClaimsRef.current;
    for (const [environmentId, timer] of Array.from(timers)) {
      const claim = claims.get(environmentId);
      if (!claim || claim.acknowledged || claim.tabSeen) {
        clearTimeout(timer);
        timers.delete(environmentId);
      }
    }
    for (const [environmentId, claim] of claims) {
      if (claim.acknowledged || claim.tabSeen || timers.has(environmentId)) continue;
      const remaining = Math.max(0, claim.claimedAt + CREATE_PR_TAB_GRACE_MS - Date.now());
      timers.set(
        environmentId,
        setTimeout(() => {
          timers.delete(environmentId);
          const current = createPrLaunchClaimsRef.current.get(environmentId);
          if (current && !current.acknowledged && !current.tabSeen) {
            releaseCreatePrLaunch(environmentId);
          }
        }, remaining),
      );
    }
  }, [createPrLaunchClaims, releaseCreatePrLaunch]);

  useEffect(() => {
    const timers = createPrGraceTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const canCreateTab = !!createTab && tabCount < MAX_TABS;
  // Workflow launches publish their own durable tab and start in the backend.
  // They must not depend on the active environment's renderer tab factory.
  const canLaunchBackendJob = Boolean(selectedEnvironmentId && tabCount < MAX_TABS);
  // A resend needs no new tab, so a full tab bar only stops Resolve when there
  // is no Resolve tab to send to. The backend decides whether that tab can
  // still take the prompt, and reports the tab limit if it has to open another.
  const hasOpenResolveTab = usePaneLayoutStore((state) => {
    const pane = selectedEnvironmentId ? state.environments.get(selectedEnvironmentId) : undefined;
    return Boolean(
      pane &&
      getAllLeaves(pane.root).some((leaf) =>
        leaf.tabs.some((tab) => tab.jobCompletionAction === "refresh-pr-after-agent-completion"),
      ),
    );
  });
  const canLaunchResolve =
    canLaunchBackendJob || Boolean(selectedEnvironmentId && hasOpenResolveTab);
  const editorOnAnotherDevice = isBackendOnAnotherDevice(actionBarScope);
  // For containers, we need containerId; for local environments, we need worktreePath
  const canOpenEditor =
    !editorOnAnotherDevice &&
    isRunning &&
    ((isLocalEnvironment && !!selectedEnvironment?.worktreePath) ||
      (!isLocalEnvironment && !!selectedEnvironment?.containerId));
  const environmentPortAddress = getEnvironmentPortAddress(selectedEnvironment);
  const environmentBrowserUrl = getEnvironmentBrowserUrl(selectedEnvironment);
  // Web and iOS clients can preview registered services through private
  // preview origins (opened top-level), even though they have no native view.
  const previewPublicationAvailable = usePreviewServiceStore(
    (state) => state.capabilities?.surfaces.browserTopLevel.available === true,
  );
  useEffect(() => {
    ensurePreviewServiceSync(actionBarScope);
    void actionBarScope.store(previewServiceStore).getState().loadCapabilities();
  }, [actionBarScope]);
  const browserPreviewSupported = isGatewayBrowserPreviewSupported() || previewPublicationAvailable;
  const canCopyEnvironmentUrl = !!environmentPortAddress;

  // The object test only narrows the type: no environment means no
  // cleanupAfterMergeError, so `!error` already covers that case. Depending on
  // the whole environment would re-open a dismissed dialog on any field change.
  // Deletion completion must not re-open the same persisted error either; only
  // selection/error changes should trigger this effect, guarded while deleting.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const error = selectedEnvironment?.cleanupAfterMergeError;
    if (!selectedEnvironment || !error || deletingEnvironmentId === selectedEnvironment.id) return;
    setCleanupTarget({
      environmentId: selectedEnvironment.id,
      environmentName: selectedEnvironment.name,
      isMerged: true,
    });
    setCleanupError(error);
    setCleanupDialogOpen(true);
  }, [
    selectedEnvironment?.cleanupAfterMergeError,
    selectedEnvironment?.id,
    selectedEnvironment?.name,
  ]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  // Handler for opening in editor
  const handleOpenInEditor = useCallback(async () => {
    if (editorOnAnotherDevice) return;

    // Extract values for type safety
    const worktreePath = selectedEnvironment?.worktreePath;
    const containerId = selectedEnvironment?.containerId;

    // For local environments, use worktreePath; for containers, use containerId
    if (isLocalEnvironment && !worktreePath) return;
    if (!isLocalEnvironment && !containerId) return;

    setIsOpeningEditor(true);
    setEditorError(null);
    try {
      const editor = config.global.preferredEditor || "vscode";
      if (isLocalEnvironment && worktreePath) {
        await backendForScope(actionBarScope).openLocalInEditor(worktreePath, editor);
      } else if (containerId) {
        await backendForScope(actionBarScope).openInEditor(containerId, editor);
      }
    } catch (err) {
      log.error("editor.open-failed", { error: formatLogError(err) });
      const errorMessage = err instanceof Error ? err.message : String(err);
      setEditorError(errorMessage);
    } finally {
      setIsOpeningEditor(false);
    }
  }, [
    actionBarScope,
    selectedEnvironment?.containerId,
    selectedEnvironment?.worktreePath,
    editorOnAnotherDevice,
    isLocalEnvironment,
    config.global.preferredEditor,
  ]);

  const handleCopyEnvironmentUrl = useCallback(() => {
    if (!environmentPortAddress) return;

    navigator.clipboard
      .writeText(environmentPortAddress)
      .then(() => {
        toast.success("Copied URL", { description: environmentPortAddress });
      })
      .catch(() => {
        toast.error("Failed to copy URL");
      });
  }, [environmentPortAddress]);

  // Get the default agent - per-environment override takes precedence over global config
  const enabledAgentList = useMemo<DefaultAgent[]>(
    () => config.global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"],
    [config.global.enabledAgentPlatforms],
  );
  const enabledAgents = useMemo(() => new Set<DefaultAgent>(enabledAgentList), [enabledAgentList]);
  const configuredDefaultAgent: DefaultAgent = resolvedDefaultAgent(
    config,
    selectedEnvironment?.projectId,
    selectedEnvironment,
  );
  const defaultAgent: DefaultAgent = enabledAgents.has(configuredDefaultAgent)
    ? configuredDefaultAgent
    : (enabledAgents.values().next().value ?? "claude");
  /** The one configured default shared by plain clicks and launch dialogs. */
  const settingsTiers = useMemo(
    () => agentSettingsTiers(config, selectedEnvironment?.projectId, selectedEnvironment),
    [config, selectedEnvironment],
  );
  const actionDefaultFor = useCallback(
    (key: ActionDefaultKey) => resolvedActionDefault(settingsTiers, key, enabledAgentList),
    [enabledAgentList, settingsTiers],
  );
  const { preferredModelsByPlatform, preferredEffortsByPlatform, preferredFastModesByPlatform } =
    useMemo(() => {
      const models: Partial<Record<DefaultAgent, string>> = {};
      const efforts: Partial<Record<DefaultAgent, string>> = {};
      const fastModes: Partial<Record<DefaultAgent, boolean>> = {};
      for (const platform of enabledAgentList) {
        const resolved = resolveAgentPlatformSettings(settingsTiers, platform);
        if (resolved.model) models[platform] = resolved.model;
        if (resolved.reasoningEffort) efforts[platform] = resolved.reasoningEffort;
        if (typeof resolved.fastMode === "boolean") fastModes[platform] = resolved.fastMode;
      }
      return {
        preferredModelsByPlatform: models,
        preferredEffortsByPlatform: efforts,
        preferredFastModesByPlatform: fastModes,
      };
    }, [enabledAgentList, settingsTiers]);
  /**
   * One resolved action default as launch-dialog preferences.
   *
   * The platform maps are the base every time. Layering one action's own model,
   * reasoning level and speed over a *different* action's preferences would let
   * that other action's choices reach this one, which is exactly what a
   * per-action default exists to prevent.
   */
  const launchDialogDefaultsFromResolved = useCallback(
    (actionDefault: ResolvedActionDefault) => {
      return {
        defaultAgent: actionDefault.agent,
        // Each platform's own resolved model, so the dialog opens on what that
        // platform would actually run rather than on a model from another
        // platform's catalogue.
        preferredModels: {
          ...preferredModelsByPlatform,
          ...(actionDefault.model ? { [actionDefault.agent]: actionDefault.model } : {}),
        },
        preferredReasoningEfforts: {
          ...preferredEffortsByPlatform,
          ...(actionDefault.reasoningEffort
            ? { [actionDefault.agent]: actionDefault.reasoningEffort }
            : {}),
        },
        preferredFastModes: {
          ...preferredFastModesByPlatform,
          ...(actionDefault.fastMode !== undefined
            ? { [actionDefault.agent]: actionDefault.fastMode }
            : {}),
        },
      };
    },
    [preferredEffortsByPlatform, preferredFastModesByPlatform, preferredModelsByPlatform],
  );
  /** Settings action defaults as launch-dialog preferences. */
  const launchDialogDefaultsFor = useCallback(
    (key: ActionDefaultKey) => launchDialogDefaultsFromResolved(actionDefaultFor(key)),
    [actionDefaultFor, launchDialogDefaultsFromResolved],
  );
  /** Launch-dialog preferences only when this action names an enabled platform. */
  const configuredLaunchDialogDefaultsFor = useCallback(
    (key: ActionDefaultKey) => {
      const configured = resolveActionDefaults(settingsTiers)[key];
      if (!configured?.platform || !enabledAgents.has(configured.platform)) return undefined;
      return launchDialogDefaultsFor(key);
    },
    [enabledAgents, launchDialogDefaultsFor, settingsTiers],
  );

  // Handler for code review
  const handleReview = useCallback(
    (
      agentOverride?: AgentPlatform,
      launchOptions?: {
        agentLaunchMode?: AgentLaunchModeOverride;
        initialAgentModel?: string;
        initialReasoningEffort?: string;
        initialFastMode?: boolean;
      },
    ) => {
      if (!createTab || !selectedEnvironmentId || !selectedProjectId || !canCreateTab) return;
      const releaseLaunch = claimTabLaunch(
        `review:${agentOverride ?? "default"}`,
        selectedEnvironmentId,
        actionBarScope,
      );
      if (!releaseLaunch) return;

      // The same target-branch rule the backend's `review.start` action applies.
      const targetBranch = defaultPrTargetBranch(
        config.repositories[selectedProjectId]?.prBaseBranch,
      );
      const reviewPrompt = createReviewPrompt(targetBranch, config.global.reviewInstruction);

      // A plain click has no dialog to configure the run, so the Defaults tab is
      // what stands in for one. An explicit override — the dialog, or a caller
      // that already chose an agent — always wins.
      const actionDefault = actionDefaultFor("review");
      const agent = agentOverride || actionDefault.agent;
      // The configured default only carries its model and reasoning level while
      // the launch is still going to the platform it named.
      const defaultForAgent = agent === actionDefault.agent ? actionDefault : undefined;
      // Resolved before the tab is created so the tab's own model selector and
      // the first queued turn cannot disagree about what a plain click asked for.
      // Every follow-up turn in the tab reads the tab's model, not this queue
      // entry, so omitting it here would confine the default to one turn.
      const initialAgentModel = launchOptions?.initialAgentModel ?? defaultForAgent?.model;
      const initialReasoningEffort =
        launchOptions?.initialReasoningEffort ?? defaultForAgent?.reasoningEffort;
      const requestedModel = initialAgentModel ?? preferredModelsByPlatform[agent];
      const configuredFastMode =
        launchOptions?.initialFastMode ??
        defaultForAgent?.fastMode ??
        preferredFastModesByPlatform[agent];
      const initialFastMode =
        typeof configuredFastMode === "boolean" &&
        modelSupportsSpeed(agent, reviewModelCatalog, requestedModel)
          ? configuredFastMode
          : undefined;
      const tabId = `tab-${createUuid()}`;
      const created = createTab(agent, {
        tabId,
        // Keep a renderer-owned fallback until the durable queue mutation
        // succeeds. If persistence fails, the native tab can still retry the
        // launch instead of becoming an empty, unrecoverable review tab.
        initialPrompt: reviewPrompt,
        displayTitle: REVIEW_TAB_TITLE,
        isReviewTab: true,
        agentLaunchMode: "native",
        ...launchOptions,
        ...(initialAgentModel ? { initialAgentModel } : {}),
        ...(initialReasoningEffort ? { initialReasoningEffort } : {}),
        // Written after the caller options so an unsupported explicit speed
        // choice is erased rather than leaking through the spread above.
        initialFastMode,
      });
      if (!created) {
        releaseLaunch({ retryable: true });
        toast.error("Could not open review", {
          description: "The environment is not ready or the maximum tab count was reached.",
        });
        return;
      }

      // When neither the dialog nor a configured default named a model, the
      // queued turn falls back to the platform's globally configured one. The tab
      // is left to resolve that itself, which is why it is not passed above.
      const model = requestedModel === "default" ? undefined : requestedModel;
      const reasoningEffort = initialReasoningEffort ?? preferredEffortsByPlatform[agent];

      // Do not await UI lifecycle work after this hand-off. The queue mutation is
      // durable and wakes the backend dispatcher, so unmounting this ActionBar or
      // switching environments cannot delay the review until the tab is opened.
      void handTabInitialPromptToBackend(
        {
          environmentId: selectedEnvironmentId,
          tabId,
          agent,
          prompt: reviewPrompt,
          options: {
            model,
            reasoningEffort:
              agent === "claude" || agent === "codex"
                ? (reasoningEffort ?? "high")
                : reasoningEffort,
            mode: "build",
            ...(typeof initialFastMode === "boolean" ? { fastMode: initialFastMode } : {}),
          },
        },
        undefined,
        actionBarScope,
      )
        .then(() => releaseLaunch())
        .catch((error) => {
          releaseLaunch({ retryable: true });
          toast.error("Could not start review", {
            description: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [
      actionBarScope,
      actionDefaultFor,
      canCreateTab,
      preferredModelsByPlatform,
      preferredEffortsByPlatform,
      preferredFastModesByPlatform,
      reviewModelCatalog,
      config.global.reviewInstruction,
      config.repositories,
      createTab,
      selectedEnvironmentId,
      selectedProjectId,
    ],
  );

  const openReviewDialog = useCallback(() => {
    if (!selectedEnvironment || !canCreateTab) return;
    setReviewDialogOpen(true);
  }, [canCreateTab, selectedEnvironment]);

  const reviewLongPress = useLongPressAction(
    openReviewDialog,
    Boolean(selectedEnvironment) && canCreateTab,
  );

  const openMultiReviewDialog = useCallback(() => {
    if (
      !selectedEnvironment ||
      !canCreateTab ||
      !isRunning ||
      !workspaceReady ||
      setupRunning ||
      multiReviewLaunchInFlightRef.current
    )
      return;
    setMultiReviewDialogOpen(true);
  }, [canCreateTab, isRunning, selectedEnvironment, setupRunning, workspaceReady]);

  const multiReviewLongPress = useLongPressAction(
    openMultiReviewDialog,
    Boolean(selectedEnvironment) &&
      canCreateTab &&
      isRunning &&
      workspaceReady &&
      !setupRunning &&
      !multiReviewLaunchPending,
  );

  const handleConfiguredReview = useCallback(
    (selection: ReviewLaunchSelection) => {
      const agent = getReviewAgent(selection.tabType);
      handleReview(agent, {
        agentLaunchMode: "native",
        initialAgentModel: selection.model,
        initialReasoningEffort: selection.reasoningEffort,
        initialFastMode: selection.fastMode,
      });
      setReviewDialogOpen(false);
    },
    [handleReview],
  );

  const handleMultiReview = useCallback(
    async (selection: MultiReviewLaunchSelection) => {
      if (
        multiReviewLaunchInFlightRef.current ||
        !createTab ||
        !selectedEnvironmentId ||
        !selectedProjectId ||
        !selectedEnvironment ||
        !canCreateTab ||
        !isRunning ||
        !workspaceReady ||
        setupRunning
      )
        return;
      multiReviewLaunchInFlightRef.current = true;
      setMultiReviewLaunchPending(true);
      const requestId = createUuid();
      // Mirrors the backend's id for a new review's root tab; an active review
      // it reuses answers with its own.
      const launch = beginLaunchedTab(
        selectedEnvironmentId,
        `multi-review:${requestId}`,
        "Multi Review",
        "page",
      );
      setMultiReviewDialogOpen(false);
      const announceReused = () =>
        toast.info("Multi Review already running", {
          description:
            "Reopened the review already running in this environment." +
            " Cancel or abandon it there to start a new one.",
        });
      try {
        // One request: the backend reuses an active review, takes the target
        // branch and instruction from saved settings, starts the review and
        // writes its tab into the layout, so a crash here cannot orphan it.
        const launched = await nodeBackend
          .launchMultiReview({
            requestId,
            environmentId: selectedEnvironmentId,
            reviewers: selection.reviewers,
            reviewModel: selection.reviewModel,
            fixModel: selection.fixModel,
            autoFix: selection.autoFix,
            autoPr: selection.autoPr,
          })
          .catch((error: unknown) => {
            if (incompatibility(error, "launch_multi_review")?.code !== "unknown-command")
              throw error;
            return null;
          });
        if (!launched) {
          launch.failed();
          const legacy = await legacyLaunchMultiReview({
            scope: actionBarScope,
            environmentId: selectedEnvironmentId,
            projectId: selectedProjectId,
            targetBranch: defaultPrTargetBranch(
              config.repositories[selectedProjectId]?.prBaseBranch,
            ),
            reviewInstruction: config.global.reviewInstruction,
            selection,
            createTab: (workflowId) =>
              Boolean(
                createTab("multi-review", {
                  multiReviewId: workflowId,
                  displayTitle: "Multi Review",
                }),
              ),
          });
          if (legacy.reused) announceReused();
          return;
        }
        actionBarScope.store(multiReviewStore).getState().replaceWorkflow(launched.workflow);
        if (launched.ui.status !== "opened" || !launched.ui.tabId) {
          throw new Error(launched.recovery ?? "The review's tab could not be opened.");
        }
        launch.settled(launched.ui.tabId);
        if (launched.reused) announceReused();
      } catch (error) {
        launch.failed();
        // Back to the dialog, so the launch can simply be retried.
        setMultiReviewDialogOpen(true);
        toast.error("Could not open Multi Review", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        multiReviewLaunchInFlightRef.current = false;
        setMultiReviewLaunchPending(false);
      }
    },
    [
      actionBarScope,
      beginLaunchedTab,
      canCreateTab,
      config.global.reviewInstruction,
      config.repositories,
      createTab,
      isRunning,
      selectedEnvironment,
      selectedEnvironmentId,
      selectedProjectId,
      setupRunning,
      workspaceReady,
      nodeBackend,
    ],
  );

  // Load run commands from orkestrator-ai.json when workspace is ready
  useEffect(() => {
    // Extract values for type safety
    const worktreePath = selectedEnvironment?.worktreePath;
    const containerId = selectedEnvironment?.containerId;

    // For container environments, we need containerId
    // For local environments, we need worktreePath
    const hasContainer = !isLocalEnvironment && !!containerId;
    const hasWorktree = isLocalEnvironment && !!worktreePath;

    if ((!hasContainer && !hasWorktree) || !isRunning || !workspaceReady) {
      runCommandsSourceRef.current = null;
      setRunCommands(null);
      return;
    }

    let cancelled = false;
    // Re-reading the same source (after an agent finishes) keeps the current
    // commands usable instead of flashing the run button disabled.
    const source = hasContainer
      ? `${selectedEnvironmentId}:container:${containerId}`
      : `${selectedEnvironmentId}:local:${worktreePath}`;
    const isRescan = runCommandsSourceRef.current === source;
    runCommandsSourceRef.current = source;
    if (!isRescan) setIsLoadingRunCommands(true);

    const readConfigPromise =
      isLocalEnvironment && worktreePath
        ? backendForScope(actionBarScope).readLocalFile(worktreePath, "orkestrator-ai.json")
        : containerId
          ? backendForScope(actionBarScope).readContainerFile(containerId, "orkestrator-ai.json")
          : null;

    if (!readConfigPromise) {
      setIsLoadingRunCommands(false);
      return;
    }

    readConfigPromise
      .then((result) => {
        if (cancelled) return;
        try {
          const config = JSON.parse(result.content) as { run?: unknown };
          const commands = Array.isArray(config.run)
            ? config.run.filter(
                (command): command is string =>
                  typeof command === "string" && command.trim().length > 0,
              )
            : [];
          if (commands.length > 0) {
            setRunCommands(commands);
          } else {
            setRunCommands(null);
          }
        } catch {
          if (!isRescan) setRunCommands(null);
        }
      })
      .catch((error) => {
        log.error("run-commands.read-failed", { error: formatLogError(error) });
        if (!cancelled && !isRescan) {
          setRunCommands(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingRunCommands(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    actionBarScope,
    selectedEnvironmentId,
    selectedEnvironment?.containerId,
    selectedEnvironment?.worktreePath,
    isLocalEnvironment,
    isRunning,
    workspaceReady,
    runCommandsRescanToken,
  ]);

  // A native session can finish while another one keeps the aggregate working.
  // The backend's per-session completion token catches that case; the aggregate
  // edge still covers other agent sources.
  const selectedAgentActivityState = selectedEnvironment?.agentActivityState;
  const selectedAgentSessionCompletedAt = selectedEnvironment?.agentSessionCompletedAt;
  useEffect(() => {
    const previous = agentActivityObservationRef.current;
    agentActivityObservationRef.current = {
      environmentId: selectedEnvironmentId,
      state: selectedAgentActivityState,
      completedAt: selectedAgentSessionCompletedAt,
    };
    if (
      previous.environmentId === selectedEnvironmentId &&
      ((previous.state === "working" && selectedAgentActivityState !== "working") ||
        (selectedAgentSessionCompletedAt !== undefined &&
          previous.completedAt !== selectedAgentSessionCompletedAt))
    ) {
      setRunCommandsRescanToken((token) => token + 1);
    }
  }, [selectedAgentActivityState, selectedAgentSessionCompletedAt, selectedEnvironmentId]);

  // Handler for run commands
  const handleRun = useCallback(async () => {
    const environmentId = selectedEnvironmentId;
    if (!environmentId || tabCount >= MAX_TABS || !runCommands || runCommands.length === 0) return;
    const releaseLaunch = claimTabLaunch("run", environmentId, actionBarScope);
    if (!releaseLaunch) return;
    const tabId = `terminal-job-${createUuid()}`;
    const launch = beginLaunchedTab(environmentId, tabId, "Run Commands", "terminal");
    try {
      const result = await backendForScope(actionBarScope).launchTerminalJob({
        requestId: `run-commands-${createUuid()}`,
        environmentId,
        tabId,
        tabType: "plain",
        data: `${runCommands.join(" && ")}\n`,
        title: "Run Commands",
      });
      launch.settled(result.tabId);
      releaseLaunch();
    } catch (error) {
      launch.failed();
      releaseLaunch({ retryable: true });
      toast.error("Could not run commands", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [actionBarScope, beginLaunchedTab, runCommands, selectedEnvironmentId, tabCount]);

  const handleCreateScript = useCallback(
    (
      agentOverride?: DefaultAgent,
      launchOptions?: {
        agentLaunchMode?: AgentLaunchModeOverride;
        initialAgentModel?: string;
        initialReasoningEffort?: string;
        initialFastMode?: boolean;
      },
    ): Promise<boolean> => {
      const environmentId = selectedEnvironmentId;
      if (!environmentId || tabCount >= MAX_TABS || !isRunning) return Promise.resolve(false);

      const actionDefault = actionDefaultFor("createScript");
      const agent = agentOverride || actionDefault.agent;
      const defaultForAgent = agent === actionDefault.agent ? actionDefault : undefined;
      const initialAgentModel = launchOptions?.initialAgentModel ?? defaultForAgent?.model;
      const initialReasoningEffort =
        launchOptions?.initialReasoningEffort ?? defaultForAgent?.reasoningEffort;
      const requestedModel = initialAgentModel ?? preferredModelsByPlatform[agent];
      const configuredFastMode =
        launchOptions?.initialFastMode ??
        defaultForAgent?.fastMode ??
        preferredFastModesByPlatform[agent];
      const initialFastMode =
        typeof configuredFastMode === "boolean" &&
        modelSupportsSpeed(agent, reviewModelCatalog, requestedModel)
          ? configuredFastMode
          : undefined;
      const initialPrompt = createOrkestratorScriptPrompt(isLocalEnvironment);
      const releaseLaunch = claimTabLaunch(
        `create-script:${agentOverride ?? "default"}`,
        environmentId,
        actionBarScope,
      );
      if (!releaseLaunch) return Promise.resolve(false);
      const tabId = `agent-job-${createUuid()}`;
      const launch = beginLaunchedTab(environmentId, tabId, "Run Script");
      return nodeBackend
        .launchNativeAgentJob({
          requestId: `run-script-${createUuid()}`,
          environmentId,
          tabId,
          agent,
          prompt: initialPrompt,
          title: "Run Script",
          conversationMode: "build",
          ...(initialAgentModel ? { modelId: initialAgentModel } : {}),
          ...(initialReasoningEffort ? { reasoningId: initialReasoningEffort } : {}),
          ...(typeof initialFastMode === "boolean" ? { fastMode: initialFastMode } : {}),
        })
        .then((result) => {
          launch.settled(result.tabId);
          releaseLaunch({ retryable: result.status === "rejected" });
          if (result.status !== "rejected") return true;
          toast.error("Could not start script creation", {
            description: result.error || "The agent rejected the request.",
          });
          return false;
        })
        .catch((error) => {
          launch.failed();
          releaseLaunch({ retryable: true });
          toast.error("Could not start script creation", {
            description: error instanceof Error ? error.message : String(error),
          });
          return false;
        });
    },
    [
      actionBarScope,
      beginLaunchedTab,
      actionDefaultFor,
      isRunning,
      isLocalEnvironment,
      preferredFastModesByPlatform,
      preferredModelsByPlatform,
      reviewModelCatalog,
      selectedEnvironmentId,
      tabCount,
      nodeBackend,
    ],
  );

  const openScriptDialog = useCallback(() => {
    if (!selectedEnvironmentId) return;
    setScriptLaunchError(null);
    setScriptDialogEnvironmentId(selectedEnvironmentId);
  }, [selectedEnvironmentId]);

  const scriptLongPress = useLongPressAction(openScriptDialog, Boolean(selectedEnvironmentId));

  const scriptEligibilityError = !scriptDialogEnvironmentId
    ? null
    : selectedEnvironmentId !== scriptDialogEnvironmentId
      ? "The selected environment changed. Close this dialog and reopen it from the intended environment."
      : !isRunning
        ? "The environment is no longer running."
        : tabCount >= MAX_TABS
          ? "The maximum number of tabs has been reached."
          : null;

  const handleConfiguredCreateScript = useCallback(
    async (selection: AgentLaunchSelection) => {
      if (!scriptDialogEnvironmentId || scriptEligibilityError || scriptSubmitRef.current) return;
      scriptSubmitRef.current = true;
      setScriptSubmitting(true);
      try {
        const created = await handleCreateScript(selection.agent, {
          agentLaunchMode: "native",
          initialAgentModel: selection.model,
          initialReasoningEffort: selection.reasoningEffort,
          initialFastMode: selection.fastMode,
        });
        if (!created) {
          setScriptLaunchError(
            "The run-script agent tab could not be created. Check the environment and tab limit, then try again.",
          );
          return;
        }
        setScriptLaunchError(null);
        setScriptDialogEnvironmentId(null);
      } finally {
        scriptSubmitRef.current = false;
        setScriptSubmitting(false);
      }
    },
    [handleCreateScript, scriptDialogEnvironmentId, scriptEligibilityError],
  );

  const handleCreateAgentTab = useCallback(
    (agent: DefaultAgent, agentLaunchMode?: AgentLaunchModeOverride) => {
      if (!createTab || !canCreateTab) return;

      createTab(agent, agentLaunchMode ? { agentLaunchMode } : undefined);
    },
    [createTab, canCreateTab],
  );

  const handleCreateNativeTab = useCallback(() => {
    if (!createTab || !canCreateTab) return;
    createTab("agent-native");
  }, [canCreateTab, createTab]);

  const handleCreateBrowserTab = useCallback(() => {
    if (!createTab || !canCreateTab) return;
    if (!selectedEnvironment) {
      createTab("browser", { initialUrl: environmentBrowserUrl ?? undefined });
      return;
    }
    const environmentId = selectedEnvironment.id;
    const tabId = `tab-${createUuid()}`;
    if (!createTab("browser", { tabId })) return;
    const launch = beginLaunchedTab(environmentId, tabId, "Browser", "page");
    // Prefer the registered entry service: the tab then follows the service
    // across container recreation instead of pinning today's host port.
    void environmentBrowserTarget(selectedEnvironment, environmentBrowserUrl, actionBarScope)
      .catch(() => environmentBrowserUrl ?? undefined)
      .then((initialUrl) => {
        if (initialUrl) {
          paneLayouts.getState().updateTabBrowserUrl(tabId, initialUrl, environmentId);
        }
        launch.settled();
      });
  }, [
    paneLayouts,
    actionBarScope,
    beginLaunchedTab,
    canCreateTab,
    createTab,
    environmentBrowserUrl,
    selectedEnvironment,
  ]);

  const hasRunCommands = runCommands && runCommands.length > 0;
  const canRunCommands =
    !!selectedEnvironmentId &&
    tabCount < MAX_TABS &&
    isRunning &&
    !isLoadingRunCommands &&
    !!hasRunCommands &&
    !setupRunning;

  const handleRunButtonClick = useCallback(() => {
    if (!canRunCommands) {
      return;
    }
    void handleRun();
  }, [canRunCommands, handleRun]);

  // Drag-to-scroll handlers for toolbar
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    setIsDragging(true);
    setStartX(e.pageX - container.offsetLeft);
    setScrollLeft(container.scrollLeft);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      const container = scrollContainerRef.current;
      if (!container) return;

      e.preventDefault();
      const x = e.pageX - container.offsetLeft;
      const walk = (x - startX) * 1.5; // Multiplier for scroll speed
      container.scrollLeft = scrollLeft - walk;
    },
    [isDragging, startX, scrollLeft],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const suppressNativeContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      // Keep custom Radix menus enabled for explicitly marked triggers.
      if (target.closest("[data-toolbar-custom-context-menu='true']")) {
        return;
      }

      event.preventDefault();
    };

    container.addEventListener("contextmenu", suppressNativeContextMenu, true);

    return () => {
      container.removeEventListener("contextmenu", suppressNativeContextMenu, true);
    };
  }, []);

  // An app shortcut, so it opens a tab wherever focus is. Setup owns the first
  // tab while it runs, so the key waits for it. Only the workspace on show
  // takes it: a hidden one (this window's own while another node is shown in
  // its tree, plan item 5003) stays as it is.
  useEffect(
    () =>
      onAppShortcut(
        "new-agent-tab",
        () => {
          if (setupRunning) return;
          if (tabCount >= MAX_TABS && createTab && selectedEnvironment) {
            showTabLimitReachedToast(MAX_TABS);
            return;
          }
          if (canCreateTab) createTab?.("agent-native");
        },
        { workspace: actionBarScope },
      ),
    [actionBarScope, canCreateTab, createTab, selectedEnvironment, setupRunning, tabCount],
  );

  // Keyboard shortcuts for terminal tabs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      // Handle Ctrl+number for tab selection (1-9) - works on all platforms
      // Using Ctrl specifically to avoid conflicts with ⌘+number on Mac (used for other OS shortcuts)
      // Note: selectTab internally bounds-checks against the active pane's tab count
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        // Use e.code (physical key) as primary since e.key can vary with keyboard layouts
        // e.code is "Digit1", "Digit2", etc. for number keys
        let num = NaN;
        if (e.code?.startsWith("Digit")) {
          num = parseInt(e.code.slice(5), 10);
        } else {
          // Fallback to e.key for compatibility
          num = parseInt(e.key, 10);
        }

        if (num >= 1 && num <= 9 && selectTab) {
          e.preventDefault();
          selectTab(num - 1); // Convert to 0-based index
          return;
        }
      }

      if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c") {
        if (canCopyEnvironmentUrl) {
          if (isEditableShortcutTarget(e.target)) {
            return;
          }
          e.preventDefault();
          handleCopyEnvironmentUrl();
        }
        return;
      }

      // ⌘ shortcuts on Mac only to avoid conflicts
      // (Ctrl+T/N/O are commonly used by browsers and other apps on Windows/Linux)
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isEditableShortcutTarget(e.target)) return;

      const reportTabLimit = () => {
        if (tabCount < MAX_TABS || !createTab || !selectedEnvironment) return false;
        e.preventDefault();
        showTabLimitReachedToast(MAX_TABS);
        return true;
      };

      // Command+N is deliberately absent: the desktop File menu owns it as the
      // "New Window" accelerator, and a browser-served client hands it to the
      // browser. The renderer acting on it too would open two windows for one
      // keypress on the platforms where both the menu and the DOM see it.
      switch (e.key.toLowerCase()) {
        case "r":
          if (reportTabLimit()) break;
          if (canCreateTab) {
            e.preventDefault();
            createTab?.("plain");
          }
          break;
        case "g":
          if (hasRunCommands && reportTabLimit()) break;
          if (canRunCommands) {
            e.preventDefault();
            handleRun();
          }
          break;
        case "o":
          if (canOpenEditor) {
            e.preventDefault();
            handleOpenInEditor();
          }
          break;
        case "e":
          // Toggle files panel
          if (canToggleFilesPanel) {
            e.preventDefault();
            toggleFilesPanel();
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    createTab,
    selectTab,
    tabCount,
    canCreateTab,
    canLaunchBackendJob,
    canLaunchResolve,
    editorOnAnotherDevice,
    canOpenEditor,
    handleOpenInEditor,
    canCopyEnvironmentUrl,
    handleCopyEnvironmentUrl,
    selectedEnvironment,
    hasRunCommands,
    canRunCommands,
    handleRun,
    toggleFilesPanel,
    canToggleFilesPanel,
    enabledAgents,
  ]);

  // Handler for PR creation - launches agent tab with PR workflow prompt
  const handleCreatePR = useCallback(
    async (
      agentOverride?: AgentPlatform,
      launchOptions?: {
        agentLaunchMode?: AgentLaunchModeOverride;
        initialAgentModel?: string;
        initialReasoningEffort?: string;
        initialFastMode?: boolean;
      },
      targetBranchOverride?: string,
    ): Promise<boolean> => {
      const operationEnvironmentId = selectedEnvironmentId;
      if (
        !operationEnvironmentId ||
        !selectedProjectId ||
        tabCount >= MAX_TABS ||
        !isRunning ||
        hasPR ||
        createPrLaunchClaimsRef.current.has(operationEnvironmentId)
      )
        return false;

      createPrLaunchClaimsRef.current.set(operationEnvironmentId, {
        tabId: null,
        tabSeen: false,
        claimedAt: Date.now(),
        acknowledged: false,
      });
      setCreatePrLaunchClaims(new Map(createPrLaunchClaimsRef.current));

      let launch: TabLaunchHandle | null = null;
      try {
        const repoConfig = config.repositories[selectedProjectId];
        const targetBranch = resolvePrTargetBranch({
          override: targetBranchOverride,
          repositoryBase: repoConfig?.prBaseBranch,
        });
        const prPrompt = createPRPrompt(targetBranch);
        const actionDefault = actionDefaultFor("pr");
        const agent = agentOverride || actionDefault.agent;
        const defaultForAgent = agent === actionDefault.agent ? actionDefault : undefined;
        // Resolved once so the queued path and the tab-owned path cannot disagree
        // about which model a plain click asked for.
        const initialAgentModel = launchOptions?.initialAgentModel ?? defaultForAgent?.model;
        const initialReasoningEffort =
          launchOptions?.initialReasoningEffort ?? defaultForAgent?.reasoningEffort;
        const requestedModel = initialAgentModel ?? preferredModelsByPlatform[agent];
        const configuredFastMode =
          launchOptions?.initialFastMode ??
          defaultForAgent?.fastMode ??
          preferredFastModesByPlatform[agent];
        const initialFastMode =
          typeof configuredFastMode === "boolean" &&
          modelSupportsSpeed(agent, reviewModelCatalog, requestedModel)
            ? configuredFastMode
            : undefined;
        const tabId = `agent-job-${createUuid()}`;
        launch = beginLaunchedTab(operationEnvironmentId, tabId, "PR");
        const result = await backendForScope(actionBarScope).launchNativeAgentJob({
          requestId: `create-pr-${createUuid()}`,
          environmentId: operationEnvironmentId,
          tabId,
          agent,
          prompt: prPrompt,
          title: "PR",
          conversationMode: "build",
          ...(requestedModel && requestedModel !== "default" ? { modelId: requestedModel } : {}),
          ...(initialReasoningEffort ? { reasoningId: initialReasoningEffort } : {}),
          ...(typeof initialFastMode === "boolean" ? { fastMode: initialFastMode } : {}),
        });
        launch.settled(result.tabId);
        if (result.status === "rejected") {
          releaseCreatePrLaunch(operationEnvironmentId);
          toast.error("Could not start pull request creation", {
            description: result.error || "The agent rejected the request.",
          });
          return false;
        }
        // Bind or re-arm the claim onto the accepted tab. Grace may have
        // released an in-flight entry; the backend still owns the session.
        bindCreatePrLaunchTab(operationEnvironmentId, result.tabId);
        // Monitoring starts only after the backend owns the session and turn.
        // Keep the local launch claim until a PR appears so a fast acknowledgement
        // cannot reopen the duplicate-launch window while the agent is still working.
        setModeCreatePending();
        return true;
      } catch (error) {
        launch?.failed();
        releaseCreatePrLaunch(operationEnvironmentId);
        toast.error("Could not start pull request creation", {
          description: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    [
      actionBarScope,
      beginLaunchedTab,
      actionDefaultFor,
      bindCreatePrLaunchTab,
      config.repositories,
      hasPR,
      isRunning,
      preferredFastModesByPlatform,
      preferredModelsByPlatform,
      reviewModelCatalog,
      releaseCreatePrLaunch,
      selectedEnvironmentId,
      selectedProjectId,
      setModeCreatePending,
      tabCount,
    ],
  );

  useEffect(() => {
    const handleCreatePRShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        isEditableShortcutTarget(event.target) ||
        event.key.toLowerCase() !== "p" ||
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        !selectedEnvironmentId ||
        !selectedProjectId ||
        !isRunning ||
        hasPR
      ) {
        return;
      }

      event.preventDefault();
      if (event.repeat || createPrLaunchPending) return;
      if (tabCount >= MAX_TABS) {
        showTabLimitReachedToast(MAX_TABS);
        return;
      }
      void handleCreatePR();
    };

    window.addEventListener("keydown", handleCreatePRShortcut);
    return () => window.removeEventListener("keydown", handleCreatePRShortcut);
  }, [
    createPrLaunchPending,
    handleCreatePR,
    hasPR,
    isRunning,
    selectedEnvironmentId,
    selectedProjectId,
    tabCount,
  ]);

  const canConfigurePR = Boolean(
    tabCount < MAX_TABS &&
    isRunning &&
    !hasPR &&
    !createPrLaunchPending &&
    selectedEnvironmentId &&
    selectedProjectId,
  );

  const openPrDialog = useCallback(() => {
    if (!canConfigurePR || !selectedEnvironmentId || !selectedProjectId) return;
    const projectId = selectedProjectId;
    const targetBranch = defaultPrTargetBranch(config.repositories[projectId]?.prBaseBranch);
    setPrLaunchError(null);
    setPrDialogTarget({
      environmentId: selectedEnvironmentId,
      projectId,
      targetBranch,
    });
    // Suggestions are a convenience: the field still accepts any branch name,
    // so a project without a readable local checkout simply offers only the default.
    const request = ++prBranchRequestRef.current;
    setPrBranchSuggestions([targetBranch]);
    void Promise.resolve()
      .then(() => backendForScope(actionBarScope).getProjectGitStatus(projectId))
      .then((status) => {
        if (prBranchRequestRef.current !== request) return;
        setPrBranchSuggestions(prTargetBranchSuggestions(status.branches, targetBranch));
      })
      .catch(() => undefined);
  }, [
    actionBarScope,
    canConfigurePR,
    config.repositories,
    selectedEnvironmentId,
    selectedProjectId,
  ]);

  const prLongPress = useLongPressAction(openPrDialog, canConfigurePR);

  const prEligibilityError = !prDialogTarget
    ? null
    : selectedEnvironmentId !== prDialogTarget.environmentId ||
        selectedProjectId !== prDialogTarget.projectId
      ? "The selected environment changed. Close this dialog and reopen it from the intended environment."
      : hasPR
        ? "A pull request now exists for this environment."
        : createPrLaunchPending
          ? "Pull request creation is already underway for this environment."
          : !isRunning
            ? "The environment is no longer running."
            : // `canCreateTab` folds two distinct causes together, so report them
              // separately: an unregistered `createTab` means the environment's
              // terminal is not ready, which the tab limit wording would misdescribe.
              tabCount >= MAX_TABS
              ? "The maximum number of tabs has been reached."
              : null;

  const handleConfiguredCreatePR = useCallback(
    async (selection: AgentLaunchSelection) => {
      if (!prDialogTarget || prEligibilityError) return;
      const created = await handleCreatePR(
        selection.agent,
        {
          agentLaunchMode: "native",
          initialAgentModel: selection.model,
          initialReasoningEffort: selection.reasoningEffort,
          initialFastMode: selection.fastMode,
        },
        selection.targetBranch || prDialogTarget.targetBranch,
      );
      if (!created) {
        setPrLaunchError(
          "The pull request agent tab could not be created. Check the environment and tab limit, then try again.",
        );
        return;
      }
      setPrLaunchError(null);
      setPrDialogTarget(null);
    },
    [handleCreatePR, prDialogTarget, prEligibilityError],
  );

  // Handler for pushing changes to an existing PR - launches agent tab with commit/push prompt
  const handlePushChanges = useCallback(
    async (agentOverride?: AgentPlatform) => {
      const environmentId = selectedEnvironmentId;
      if (!environmentId || tabCount >= MAX_TABS || !isRunning) return;
      const releaseLaunch = claimTabLaunch(
        `push:${agentOverride ?? "default"}`,
        environmentId,
        actionBarScope,
      );
      if (!releaseLaunch) return;

      const pushPrompt = createPushChangesPrompt();
      // The context menu picks an agent only, so its choice keeps the configured
      // model and reasoning level only while it stays on the same platform.
      const actionDefault = actionDefaultFor("push");
      const agent = agentOverride || actionDefault.agent;
      const defaultForAgent = agent === actionDefault.agent ? actionDefault : undefined;
      const requestedModel = defaultForAgent?.model ?? preferredModelsByPlatform[agent];
      const configuredFastMode = defaultForAgent?.fastMode ?? preferredFastModesByPlatform[agent];
      const fastMode =
        typeof configuredFastMode === "boolean" &&
        modelSupportsSpeed(agent, reviewModelCatalog, requestedModel)
          ? configuredFastMode
          : undefined;
      const tabId = `agent-job-${createUuid()}`;
      const launch = beginLaunchedTab(environmentId, tabId, PUSH_CHANGES_TAB_TITLE);
      try {
        const result = await backendForScope(actionBarScope).launchNativeAgentJob({
          requestId: `push-changes-${createUuid()}`,
          environmentId,
          tabId,
          agent,
          prompt: pushPrompt,
          title: PUSH_CHANGES_TAB_TITLE,
          conversationMode: "build",
          ...(defaultForAgent?.model ? { modelId: defaultForAgent.model } : {}),
          ...(defaultForAgent?.reasoningEffort
            ? { reasoningId: defaultForAgent.reasoningEffort }
            : {}),
          ...(typeof fastMode === "boolean" ? { fastMode } : {}),
        });
        launch.settled(result.tabId);
        if (result.status === "rejected") {
          throw new Error(result.error || "The agent rejected the request.");
        }
        releaseLaunch();
      } catch (error) {
        launch.failed();
        releaseLaunch({ retryable: true });
        toast.error("Could not push changes", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [
      actionBarScope,
      beginLaunchedTab,
      actionDefaultFor,
      isRunning,
      preferredFastModesByPlatform,
      preferredModelsByPlatform,
      reviewModelCatalog,
      selectedEnvironmentId,
      tabCount,
    ],
  );

  // Launch conflict resolution as a backend-owned job. The resulting tab is a
  // projection of the already-running session, never the trigger that starts it.
  const handleResolveConflicts = useCallback(
    async (options?: {
      agent?: AgentPlatform;
      launch?: {
        agentLaunchMode?: AgentLaunchModeOverride;
        initialAgentModel?: string;
        initialReasoningEffort?: string;
        initialFastMode?: boolean;
      };
      targetBranch?: string;
      /**
       * Where a failure is reported. The configured launch renders the message
       * inside its own dialog, so a toast there would report the same failure
       * twice, in two different wordings.
       */
      reportFailure?: "toast" | "return";
    }): Promise<ResolveLaunchResult> => {
      const {
        agent: agentOverride,
        launch: launchOptions,
        targetBranch: targetBranchOverride,
        reportFailure = "toast",
      } = options ?? {};
      const operationEnvironmentId = selectedEnvironmentId;
      if (
        !operationEnvironmentId ||
        !selectedProjectId ||
        !canLaunchResolve ||
        resolveLaunchEnvironmentIdRef.current !== null
      )
        return { ok: false, message: null };

      resolveLaunchEnvironmentIdRef.current = operationEnvironmentId;
      setResolveLaunchEnvironmentId(operationEnvironmentId);

      const repoConfig = config.repositories[selectedProjectId];
      const targetBranch = resolvePrTargetBranch({
        override: targetBranchOverride,
        environmentBase: selectedEnvironment?.prBaseBranch,
        repositoryBase: repoConfig?.prBaseBranch,
      });
      const resolvePrompt = createResolveConflictsPrompt(targetBranch);
      const fail = (message: string): ResolveLaunchResult => {
        if (reportFailure === "toast") {
          toast.error("Could not open conflict resolution", { description: message });
        }
        return { ok: false, message };
      };

      let launch: TabLaunchHandle | null = null;
      try {
        const actionDefault = actionDefaultFor("resolve");
        const agent = agentOverride || actionDefault.agent;
        const defaultForAgent = agent === actionDefault.agent ? actionDefault : undefined;
        // Same precedence as every other action: the dialog's selection first,
        // then the configured default, resolved once rather than by spread order.
        const initialAgentModel = launchOptions?.initialAgentModel ?? defaultForAgent?.model;
        const initialReasoningEffort =
          launchOptions?.initialReasoningEffort ?? defaultForAgent?.reasoningEffort;
        const requestedModel = initialAgentModel ?? preferredModelsByPlatform[agent];
        const configuredFastMode =
          launchOptions?.initialFastMode ??
          defaultForAgent?.fastMode ??
          preferredFastModesByPlatform[agent];
        const initialFastMode =
          typeof configuredFastMode === "boolean" &&
          modelSupportsSpeed(agent, reviewModelCatalog, requestedModel)
            ? configuredFastMode
            : undefined;
        // An open Resolve tab is usually reused, so there is no new tab to show;
        // the tab the backend answers with takes focus.
        const tabId = hasOpenResolveTab ? undefined : `agent-job-${createUuid()}`;
        launch = beginLaunchedTab(
          operationEnvironmentId,
          tabId ?? `resolve-focus-${createUuid()}`,
          "Resolve",
        );
        const result = await backendForScope(actionBarScope).launchNativeAgentJob({
          requestId: `resolve-${createUuid()}`,
          environmentId: operationEnvironmentId,
          ...(tabId ? { tabId } : {}),
          agent,
          prompt: resolvePrompt,
          title: "Resolve",
          conversationMode: "build",
          completionAction: "refresh-pr-after-agent-completion",
          // A plain press keeps whatever the open tab runs; the dialog's agent
          // and model are an explicit choice the backend has to honour.
          tabReuse: agentOverride || launchOptions ? "same-agent" : "any-agent",
          ...(initialAgentModel ? { modelId: initialAgentModel } : {}),
          ...(initialReasoningEffort ? { reasoningId: initialReasoningEffort } : {}),
          ...(typeof initialFastMode === "boolean" ? { fastMode: initialFastMode } : {}),
        });
        launch.settled(result.tabId);
        if (result.status === "rejected") {
          return fail(result.error || "The conflict-resolution agent rejected the prompt.");
        }
        if (result.status === "unknown") {
          toast.info("Conflict resolution is reconciling", {
            description:
              "The backend owns the launch and will recover its status without keeping this environment open.",
          });
        }
        if (result.queued) {
          toast.info("Conflict resolution is queued", {
            description: "The Resolve tab runs it when its current work ends.",
          });
        }
        if (result.completionActionArmed === false) {
          toast.warning("Automatic PR refresh was not scheduled", {
            description:
              result.warning ||
              "Conflict resolution is running, but PR status may need a manual refresh when it finishes.",
          });
        }
        return { ok: true };
      } catch (error) {
        launch?.failed();
        return fail(error instanceof Error ? error.message : String(error));
      } finally {
        if (resolveLaunchEnvironmentIdRef.current === operationEnvironmentId) {
          resolveLaunchEnvironmentIdRef.current = null;
          setResolveLaunchEnvironmentId(null);
        }
      }
    },
    [
      actionBarScope,
      beginLaunchedTab,
      actionDefaultFor,
      canLaunchResolve,
      hasOpenResolveTab,
      config.repositories,
      preferredFastModesByPlatform,
      preferredModelsByPlatform,
      reviewModelCatalog,
      selectedEnvironment?.prBaseBranch,
      selectedEnvironmentId,
      selectedProjectId,
    ],
  );

  const resolveLaunchInFlight = resolveLaunchEnvironmentId !== null;

  // An unknown mergeability (null) still allows configuring a resolve: GitHub
  // can take a while to compute it, and the user may already know it conflicts.
  const canConfigureResolve = Boolean(
    canLaunchResolve &&
    isRunning &&
    hasPR &&
    !isPRFinished &&
    hasMergeConflicts !== false &&
    selectedEnvironmentId &&
    selectedProjectId &&
    !resolveLaunchInFlight,
  );

  const openResolveDialog = useCallback(() => {
    if (!canConfigureResolve || !selectedEnvironmentId || !selectedProjectId) return;
    setResolveLaunchError(null);
    setResolveDialogTarget({
      environmentId: selectedEnvironmentId,
      projectId: selectedProjectId,
      targetBranch: resolvePrTargetBranch({
        environmentBase: selectedEnvironment?.prBaseBranch,
        repositoryBase: config.repositories[selectedProjectId]?.prBaseBranch,
      }),
    });
  }, [
    canConfigureResolve,
    config.repositories,
    selectedEnvironment?.prBaseBranch,
    selectedEnvironmentId,
    selectedProjectId,
  ]);

  useEffect(() => {
    const handleConfigureShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        isEditableShortcutTarget(event.target) ||
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        !event.shiftKey
      ) {
        return;
      }

      let openDialog: (() => void) | undefined;
      switch (event.key.toLowerCase()) {
        case "r":
          if (selectedEnvironment && canCreateTab) openDialog = openReviewDialog;
          break;
        case "m":
          if (
            selectedEnvironment &&
            canCreateTab &&
            isRunning &&
            workspaceReady &&
            !setupRunning &&
            !multiReviewLaunchPending
          ) {
            openDialog = openMultiReviewDialog;
          }
          break;
        case "g":
          if (selectedEnvironmentId) openDialog = openScriptDialog;
          break;
        case "u":
          if (canConfigureResolve) {
            openDialog = openResolveDialog;
          } else if (canConfigurePR) {
            openDialog = openPrDialog;
          }
          break;
      }

      if (!openDialog) return;
      event.preventDefault();
      openDialog();
    };

    window.addEventListener("keydown", handleConfigureShortcut);
    return () => window.removeEventListener("keydown", handleConfigureShortcut);
  }, [
    canConfigurePR,
    canConfigureResolve,
    canCreateTab,
    isRunning,
    multiReviewLaunchPending,
    openMultiReviewDialog,
    openPrDialog,
    openResolveDialog,
    openReviewDialog,
    openScriptDialog,
    selectedEnvironment,
    selectedEnvironmentId,
    setupRunning,
    workspaceReady,
  ]);

  const resolveLongPress = useLongPressAction(openResolveDialog, canConfigureResolve);

  // A launch already in flight is deliberately absent: it is progress, not an
  // eligibility fault, and is reported through the dialog's busy state instead.
  const resolveEligibilityError = !resolveDialogTarget
    ? null
    : selectedEnvironmentId !== resolveDialogTarget.environmentId ||
        selectedProjectId !== resolveDialogTarget.projectId
      ? "The selected environment changed. Close this dialog and reopen it from the intended environment."
      : !hasPR || isPRFinished || hasMergeConflicts === false
        ? "This pull request no longer has merge conflicts to resolve."
        : !isRunning
          ? "The environment is no longer running."
          : !canLaunchResolve
            ? "The maximum number of tabs has been reached."
            : null;

  const handleConfiguredResolve = useCallback(
    async (selection: AgentLaunchSelection) => {
      if (!resolveDialogTarget || resolveEligibilityError || resolveLaunchInFlight) return;
      setResolveLaunchError(null);
      const result = await handleResolveConflicts({
        agent: selection.agent,
        launch: {
          agentLaunchMode: "native",
          initialAgentModel: selection.model,
          initialReasoningEffort: selection.reasoningEffort,
          initialFastMode: selection.fastMode,
        },
        targetBranch: resolveDialogTarget.targetBranch,
        // The dialog stays open on failure and owns the message, so the toast
        // would be a second, less specific copy of the same report.
        reportFailure: "return",
      });
      if (result.ok) {
        setResolveDialogTarget(null);
        return;
      }
      if (result.message) setResolveLaunchError(result.message);
    },
    [handleResolveConflicts, resolveDialogTarget, resolveEligibilityError, resolveLaunchInFlight],
  );

  const activateProjectForCleanup = useCallback(
    (environmentId: string) => {
      if (selectedEnvironmentIdRef.current !== environmentId) return;
      const projectId = selectedEnvironment?.projectId ?? selectedProjectId;
      if (!projectId) return;
      setProjectCollapsed(projectId, false);
      selectProject(projectId);
    },
    [selectProject, selectedEnvironment?.projectId, selectedProjectId, setProjectCollapsed],
  );

  // Handler for cleaning up (deleting) an environment after PR is merged/closed.
  // The dialog closes as soon as the deletion starts so it never blocks the
  // rest of the app while a container or worktree is torn down; the project
  // takes focus and deleteEnvironment reports a failure as a toast.
  const handleCleanup = useCallback(async () => {
    const operationEnvironmentId = cleanupTarget?.environmentId ?? selectedEnvironmentId;
    if (!operationEnvironmentId || deletingEnvironmentId === operationEnvironmentId) return;

    activateProjectForCleanup(operationEnvironmentId);
    setDeletingEnvironmentId(operationEnvironmentId);
    setCleanupError(null);
    setCleanupDialogOpen(false);
    setCleanupTarget(null);
    try {
      await deleteEnvironment(operationEnvironmentId);
      // The user may have reopened cleanup while teardown was running. Close
      // that obsolete dialog, but preserve one opened for another environment.
      if (cleanupTargetRef.current?.environmentId === operationEnvironmentId) {
        setCleanupDialogOpen(false);
        setCleanupTarget(null);
        setCleanupError(null);
      }
    } catch (err) {
      log.error("environment.delete-failed", { error: formatLogError(err) });
    } finally {
      setDeletingEnvironmentId((current) => (current === operationEnvironmentId ? null : current));
    }
  }, [
    activateProjectForCleanup,
    cleanupTarget?.environmentId,
    deletingEnvironmentId,
    selectedEnvironmentId,
    deleteEnvironment,
  ]);

  // The trash button: the same deletion a row's Delete runs, which leaves the
  // environment's workspace itself and reports a failure as a toast.
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTargetId) return;
    setDeleteTargetId(null);
    try {
      await deleteEnvironment(deleteTargetId);
    } catch (err) {
      log.error("environment.delete-failed", { error: formatLogError(err) });
    }
  }, [deleteEnvironment, deleteTargetId]);

  // Handler for merging a PR, optionally deleting its environment after GitHub
  // confirms that the merge completed.
  const handleMergePR = useCallback(
    async (cleanupAfterMerge: boolean) => {
      if (!selectedEnvironmentId || !prUrl) return;

      // Close dialog immediately and show spinner on main button
      setMergeDialogOpen(false);
      const operationEnvironmentId = selectedEnvironmentId;
      const operationEnvironmentName = selectedEnvironment?.name ?? selectedEnvironmentId;
      const operationBranch = selectedEnvironment?.branch ?? "current branch";
      setMergingEnvironmentId(operationEnvironmentId);
      setMergeError(null);

      try {
        log.info("merge.started", { environmentId: operationEnvironmentId });
        const mergeResult = await backendForScope(actionBarScope).mergeEnvironmentPr(
          operationEnvironmentId,
          "squash",
          true,
          cleanupAfterMerge,
        );
        log.info("merge.completed", { outcome: mergeResult.outcome });

        if (mergeResult.outcome !== "merged") {
          toast.success(mergeResult.outcome === "pending" ? "Merge pending" : "Merge submitted", {
            description: operationBranch,
            id: `branch-merge-submitted-${operationEnvironmentId}`,
          });
          return;
        }

        toast.success("Branch merged", {
          description: operationBranch,
          id: `branch-merged-${operationEnvironmentId}`,
        });

        if (cleanupAfterMerge && mergeResult.cleanupOutcome !== "failed") {
          activateProjectForCleanup(operationEnvironmentId);
        }

        if (mergeResult.cleanupOutcome === "failed") {
          setCleanupError(mergeResult.cleanupError ?? "An unexpected error occurred");
          setCleanupTarget({
            environmentId: operationEnvironmentId,
            environmentName: operationEnvironmentName,
            isMerged: true,
          });
          setCleanupDialogOpen(true);
        }
      } catch (err) {
        log.error("merge.failed", { error: formatLogError(err) });
        // backend invoke errors come as strings, not Error objects
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "An unexpected error occurred";
        setMergeError(message);
        setMergeDialogOpen(true); // Re-open dialog to show error
      } finally {
        setMergingEnvironmentId((current) => (current === operationEnvironmentId ? null : current));
      }
    },
    [
      actionBarScope,
      activateProjectForCleanup,
      selectedEnvironment?.branch,
      selectedEnvironment?.name,
      selectedEnvironmentId,
      prUrl,
      setMergeDialogOpen,
    ],
  );

  // Get target branch for PR dialog
  const targetBranch = selectedProjectId
    ? defaultPrTargetBranch(config.repositories[selectedProjectId]?.prBaseBranch)
    : "main";
  const sourceBranch = selectedEnvironment?.branch || "current branch";

  return {
    isGrid,
    selectedEnvironmentId,
    selectedProjectId,
    projectBoardTab,
    openProjectBoardTab,
    selectedEnvironment,
    workspaceReady,
    setupRunning,
    getProjectById,
    config,
    createTab,
    selectTab,
    tabCount,
    filesPanelOpen,
    toggleFilesPanel,
    canToggleFilesPanel,
    changes,
    hasChanges,
    sidebarOpen,
    toggleSidebar,
    isOpeningEditor,
    setIsOpeningEditor,
    editorError,
    setEditorError,
    runCommands,
    setRunCommands,
    isLoadingRunCommands,
    setIsLoadingRunCommands,
    cleanupDialogOpen,
    setCleanupDialogOpen,
    cleanupTarget,
    setCleanupTarget,
    deletingEnvironmentId,
    setDeletingEnvironmentId,
    cleanupError,
    setCleanupError,
    mergeDialogOpen,
    setMergeDialogOpen,
    mergingEnvironmentId,
    setMergingEnvironmentId,
    mergeError,
    setMergeError,
    resolveLaunchEnvironmentId,
    setResolveLaunchEnvironmentId,
    resolveLaunchEnvironmentIdRef,
    selectedEnvironmentIdRef,
    reviewDialogOpen,
    setReviewDialogOpen,
    scriptDialogEnvironmentId,
    setScriptDialogEnvironmentId,
    scriptLaunchError,
    scriptSubmitting,
    setScriptLaunchError,
    scriptDialogOpen,
    createScriptButtonRef,
    multiReviewDialogOpen,
    setMultiReviewDialogOpen,
    multiReviewLaunchPending,
    setMultiReviewLaunchPending,
    multiReviewLaunchInFlightRef,
    prDialogTarget,
    setPrDialogTarget,
    prLaunchError,
    setPrLaunchError,
    prBranchSuggestions,
    prDialogOpen,
    createPrButtonRef,
    createPrLaunchPending,
    resolveDialogTarget,
    setResolveDialogTarget,
    resolveLaunchError,
    setResolveLaunchError,
    resolveDialogOpen,
    resolveButtonRef,
    anyLaunchDialogOpen,
    reviewModelCatalog,
    scrollContainerRef,
    isDragging,
    setIsDragging,
    startX,
    setStartX,
    scrollLeft,
    setScrollLeft,
    selectedProject,
    isProjectView,
    hasProjectCheckout,
    isCleanupTargetDeleting,
    isMerging,
    isLocalEnvironment,
    isLocalReady,
    isRunning,
    prUrl,
    prState,
    hasMergeConflicts,
    checkSummary,
    monitorSyncStatus,
    lastSuccessfulCheckAt,
    viewPR,
    setModeCreatePending,
    deleteEnvironment,
    hasPR,
    isPRMerged,
    cleanupTargetIsMerged,
    isPRClosed,
    isPRFinished,
    isSelectedEnvironmentDeleting,
    isSelectedEnvironmentDeleteInFlight,
    deleteTarget,
    setDeleteTargetId,
    handleConfirmDelete,
    canCreateTab,
    canLaunchBackendJob,
    canLaunchResolve,
    editorOnAnotherDevice,
    canOpenEditor,
    environmentPortAddress,
    environmentBrowserUrl,
    browserPreviewSupported,
    canCopyEnvironmentUrl,
    handleOpenInEditor,
    handleCopyEnvironmentUrl,
    enabledAgentList,
    enabledAgents,
    configuredDefaultAgent,
    defaultAgent,
    launchDialogDefaultsFor,
    launchDialogDefaultsFromResolved,
    configuredLaunchDialogDefaultsFor,
    handleReview,
    openReviewDialog,
    reviewLongPress,
    handleConfiguredReview,
    openMultiReviewDialog,
    multiReviewLongPress,
    handleMultiReview,
    openScriptDialog,
    scriptLongPress,
    scriptEligibilityError,
    handleConfiguredCreateScript,
    handleCreateAgentTab,
    handleCreateNativeTab,
    handleCreateBrowserTab,
    hasRunCommands,
    canRunCommands,
    handleRunButtonClick,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    handleCreatePR,
    canConfigurePR,
    openPrDialog,
    prLongPress,
    prEligibilityError,
    handleConfiguredCreatePR,
    handlePushChanges,
    handleResolveConflicts,
    resolveLaunchInFlight,
    canConfigureResolve,
    openResolveDialog,
    resolveLongPress,
    resolveEligibilityError,
    handleConfiguredResolve,
    handleCleanup,
    handleMergePR,
    targetBranch,
    sourceBranch,
  };
}
