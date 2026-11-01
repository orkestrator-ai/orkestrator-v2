import { AgentInfoPermissionRules } from "./AgentInfoPermissionRules";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import {
  ArrowRight,
  ArrowRightLeft,
  Copy,
  Info,
  RotateCcw,
  Scissors,
  Share2,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, createSessionKey } from "@/lib/utils";
import { isRemoteGatewayConnection } from "@/lib/gateway-url";
import { getNativeAgentData, type TabInfo } from "@/types/paneLayout";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { createUuid } from "@/lib/uuid";
import {
  AGENT_PROVIDER_LABELS,
  createAgentHandoff,
  forgetAgentHandoff,
  type AgentProvider,
} from "@/lib/agent-handoff";
import {
  adoptNativeAgentSession,
  beginNativeAgentSignIn,
  cancelNativeAgentSignIn,
  forkNativeAgentSession,
  getBuildPipelineSessionProjection,
  getMultiReviewReviewerProjection,
  getNativeAgentAuthStatus,
  getNativeAgentProjection,
  openInBrowser,
  performNativeAgentSessionAction,
  performNativeAgentMcpAction,
  signOutNativeAgent,
  stopNativeAgentBackgroundTask,
  updateNativeAgentControls,
} from "@/lib/backend";
import { useSystemUsage } from "@/hooks/useSystemUsage";
import { ClaudeAccountSignInAction } from "@/components/claude/ClaudeAccountSignInAction";
import { normalizeNativeMessages } from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  describeNativeAgentExecutionPolicy,
  nativeAgentCapabilities,
  nativeAgentSteerRejectionMessage,
  normalizePendingSignIn,
  NATIVE_AGENT_PENDING_SIGN_IN_TTL_MS,
  type NativeAgentAuthStatus,
  type NativeAgentControlUpdate,
} from "@orkestrator/protocol/native-agent";
import {
  AGENT_PLATFORMS,
  AGENT_PLATFORM_LABELS,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import { agentMailCapabilities } from "@orkestrator/protocol/agent-mail";
import type { MultiReviewReviewer } from "@orkestrator/protocol/multi-review";
import type { AgentSessionAccount } from "@orkestrator/protocol/agent-accounts";
import { openAgentMailForTab } from "@/components/agent-mail/agent-mail-ui";
import { AgentInfoMcpSection } from "./AgentInfoMcpSection";
import { AgentInfoAccountSection } from "./AgentInfoAccountSection";

interface AgentInfoButtonProps {
  activeTab: TabInfo | null;
  mobile?: boolean;
  /**
   * In a realm: the window's title bar shows the trigger and asks for the
   * popover, which opens here under it (see `RealmTitleBarPanels`).
   */
  remote?: RealmPanelControl;
}

interface SessionActionState {
  actionId: number;
  name: string;
  sessionIdentity: string;
}

interface SessionValueState<T> {
  sessionIdentity: string | null;
  value: T;
}

interface ControlUpdateState {
  actionId: number;
  sessionIdentity: string;
}

/** Host-meter freshness requested while the agent-information popover is open. */
export const AGENT_INFO_SYSTEM_USAGE_INTERVAL_MS = 3_000;

/** Account auth is shared by tabs of one environment/provider, not by all accounts. */
function deviceCodeToastId(environmentId: string, agent: string): string {
  return `agent-info-device-code:${JSON.stringify([environmentId, agent])}`;
}

/** The device-code toast's cancel: abandons the login on the provider's side too. */
function cancelDeviceCodeSignIn(input: {
  environmentId: string;
  agent: AgentPlatform;
  logicalSessionKey: string;
}): { label: string; onClick: () => void } {
  return {
    label: "Cancel sign-in",
    onClick: () => {
      toast.dismiss(deviceCodeToastId(input.environmentId, input.agent));
      void cancelNativeAgentSignIn(input).catch(() => toast.error("Could not cancel the sign-in"));
    },
  };
}

interface ActiveNativeSession {
  provider: AgentPlatform;
  providerLabel: string;
  environmentId: string;
  sessionKey: string;
  providerSessionId?: string;
  buildPipelineId?: string;
  /** A Multi Review reviewer: the workflow owns the session, as a pipeline owns a stage. */
  multiReviewReviewer?: { workflowId: string; reviewerId: string };
}

type ReviewerSession = Pick<
  MultiReviewReviewer,
  "id" | "agent" | "sessionKey" | "providerSessionId"
>;

function nativeProviderLabel(provider: AgentPlatform): string {
  return provider === "opencode"
    ? "OpenCode"
    : provider === "claude" || provider === "codex"
      ? `${AGENT_PROVIDER_LABELS[provider]} Native`
      : AGENT_PLATFORM_LABELS[provider];
}

function resolveActiveNativeSession(
  tab: TabInfo | null,
  pipelineId: string | undefined,
  pipelineAgent: AgentPlatform | undefined,
  sessionAgent: AgentPlatform | undefined,
  sessionKey: string | undefined,
  providerSessionId: string | undefined,
  reviewer?: ReviewerSession,
): ActiveNativeSession | null {
  if (!tab) return null;
  const data = getNativeAgentData(tab);
  if (data?.platform && AGENT_PLATFORMS.includes(data.platform)) {
    return {
      provider: data.platform,
      providerLabel: nativeProviderLabel(data.platform),
      environmentId: data.environmentId,
      sessionKey: createSessionKey(data.environmentId, tab.id),
      providerSessionId: data.sessionId,
    };
  }
  const review = tab.type === "multi-review" ? tab.multiReviewTabData : undefined;
  if (review?.reviewerId && !review.pipelinePass) {
    if (!reviewer || !AGENT_PLATFORMS.includes(reviewer.agent)) return null;
    return {
      provider: reviewer.agent,
      providerLabel: nativeProviderLabel(reviewer.agent),
      environmentId: review.environmentId,
      // The key the backend dispatches a reviewer under when it has not rotated one.
      sessionKey:
        reviewer.sessionKey ?? `multi-review:${review.workflowId}:reviewer:${reviewer.id}`,
      providerSessionId: reviewer.providerSessionId,
      multiReviewReviewer: { workflowId: review.workflowId, reviewerId: review.reviewerId },
    };
  }
  if (tab.type !== "claude-build" || !tab.buildTabData || !pipelineId || !sessionKey) return null;
  const provider = sessionAgent ?? pipelineAgent;
  if (!provider || !AGENT_PLATFORMS.includes(provider)) return null;
  return {
    provider,
    providerLabel: nativeProviderLabel(provider),
    environmentId: tab.buildTabData.environmentId,
    sessionKey,
    providerSessionId,
    buildPipelineId: pipelineId,
  };
}

import {
  AgentInteractionCapability,
  AgentRuntimePanel,
  type AgentInfoUsageSnapshot,
  Metric,
  SystemUsagePanel,
  UsagePanel,
  describeRewindTarget,
  formatCount,
  summarizeRewindPreview,
  ConnectionPathPanel,
} from "./AgentInfoButton.panels";
import { useFederation } from "@/components/federation/FederationProvider";
import type { RealmPanelControl } from "@/lib/federation/workspace-realm";
import { workspaceTarget } from "@/lib/portal/portal-transport";

export {
  describeRewindTarget,
  formatResetDateTime,
  labelWindowMinutes,
  limitWindowPosition,
  summarizeRewindPreview,
  windowDurationMinutes,
} from "./AgentInfoButton.panels";

/** The agent-information trigger, shared with a window's title bar over a realm. */
export function AgentInfoTrigger({
  open,
  mobile = false,
  remote = false,
  onClick,
  ref,
}: {
  open: boolean;
  mobile?: boolean;
  remote?: boolean;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <Button
      ref={ref}
      variant={open ? "secondary" : "ghost"}
      size="icon"
      className={mobile ? "h-9 w-9" : "h-8 w-8 text-muted-foreground hover:text-foreground"}
      onClick={onClick}
      aria-label={open ? "Close agent information" : "Open agent information"}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-controls={remote ? undefined : "agent-information-popover"}
    >
      <Info className={mobile ? "h-4.5 w-4.5" : "h-4 w-4"} />
    </Button>
  );
}

export function AgentInfoButton({ activeTab, mobile = false, remote }: AgentInfoButtonProps) {
  const [open, setOpen] = useState(remote?.request?.open ?? false);
  const remoteRequest = remote?.request ?? null;
  const [appliedRequest, setAppliedRequest] = useState(remoteRequest);
  if (appliedRequest !== remoteRequest) {
    setAppliedRequest(remoteRequest);
    if (remoteRequest) setOpen(remoteRequest.open);
  }
  const reportOpen = useEffectEvent((next: boolean) => remote?.onOpenChange(next));
  useEffect(() => reportOpen(open), [open, remoteRequest?.seq]);
  const federation = useFederation();
  // How this window reaches the node its workspace is on, when that is not
  // the command node it connected to.
  const [connectionPath] = useState(workspaceTarget);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [runtimeNoticeDialogId, setRuntimeNoticeDialogId] = useState<string | null>(null);
  const [busyState, setBusyState] = useState<SessionActionState | null>(null);
  // Joins the title bar's host sample; while open this popover's faster demand
  // wins, and closing it restores the title bar's cadence.
  const systemUsage = useSystemUsage({
    intervalMs: AGENT_INFO_SYSTEM_USAGE_INTERVAL_MS,
    active: open,
  });
  const [steerState, setSteerState] = useState<SessionValueState<string>>({
    sessionIdentity: null,
    value: "",
  });
  const [shareState, setShareState] = useState<SessionValueState<boolean>>({
    sessionIdentity: null,
    value: false,
  });
  const [controlUpdateState, setControlUpdateState] = useState<ControlUpdateState | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef(false);
  const reportDismiss = useEffectEvent(() => remote?.onDismiss?.());
  useEffect(() => {
    if (open && remoteRequest?.open) {
      panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [open, remoteRequest?.open, remoteRequest?.seq]);
  const actionIdRef = useRef(0);
  const controlUpdateIdRef = useRef(0);
  const controlUpdateInFlightRef = useRef<ControlUpdateState | null>(null);
  const buildPipelineId =
    activeTab?.type === "claude-build" ? activeTab.buildTabData?.pipelineId : undefined;
  const buildPipeline = useBuildPipelineStore((state) =>
    buildPipelineId ? state.pipelines.get(buildPipelineId) : undefined,
  );
  const viewedBuildSessionId = useBuildPipelineStore((state) =>
    buildPipelineId ? state.viewedSessionIds.get(buildPipelineId) : undefined,
  );
  const viewedBuildSession =
    buildPipeline?.sessions.find((candidate) => candidate.sdkSessionId === viewedBuildSessionId) ??
    buildPipeline?.sessions[buildPipeline.currentSessionIndex] ??
    buildPipeline?.sessions.at(-1);
  const reviewTabData =
    activeTab?.type === "multi-review" && !activeTab.multiReviewTabData?.pipelinePass
      ? activeTab.multiReviewTabData
      : undefined;
  const reviewerRecord = useMultiReviewStore((state) =>
    reviewTabData?.reviewerId
      ? state.workflows
          .get(reviewTabData.workflowId)
          ?.reviewers.find((entry) => entry.id === reviewTabData.reviewerId)
      : undefined,
  );
  // Every workflow revision replaces the record; only the session identity matters here.
  const reviewerId = reviewerRecord?.id;
  const reviewerAgent = reviewerRecord?.agent;
  const reviewerSessionKey = reviewerRecord?.sessionKey;
  const reviewerProviderSessionId = reviewerRecord?.providerSessionId;
  const reviewer = useMemo<ReviewerSession | undefined>(
    () =>
      reviewerId && reviewerAgent
        ? {
            id: reviewerId,
            agent: reviewerAgent,
            sessionKey: reviewerSessionKey,
            providerSessionId: reviewerProviderSessionId,
          }
        : undefined,
    [reviewerAgent, reviewerId, reviewerProviderSessionId, reviewerSessionKey],
  );
  const activeSession = useMemo(
    () =>
      resolveActiveNativeSession(
        activeTab,
        buildPipeline?.id,
        buildPipeline?.agentType,
        viewedBuildSession?.agent,
        viewedBuildSession?.sessionKey,
        viewedBuildSession?.sdkSessionId,
        reviewer,
      ),
    [
      activeTab,
      reviewer,
      buildPipeline?.agentType,
      buildPipeline?.id,
      viewedBuildSession?.agent,
      viewedBuildSession?.sdkSessionId,
      viewedBuildSession?.sessionKey,
    ],
  );
  const environmentContainerId = useEnvironmentStore(
    (state) =>
      state.environments.find((environment) => environment.id === activeSession?.environmentId)
        ?.containerId,
  );
  const sessionContainerId =
    (activeTab ? getNativeAgentData(activeTab)?.containerId : undefined) ??
    environmentContainerId ??
    undefined;
  // A build stage or a reviewer: its workflow drives it, so the panel only reports.
  const isWorkflowSession = Boolean(
    activeSession?.buildPipelineId || activeSession?.multiReviewReviewer,
  );
  const enabledAgentPlatforms = useConfigStore(
    (state) => state.config.global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"],
  );
  const messagingEnabled = useConfigStore(
    (state) => state.config.global.agentMessaging?.enabled === true,
  );
  /*
   * Every platform can send and receive a transfer, so the only thing that can
   * make one impossible is having nowhere to send it: an agent the user has
   * disabled is not a destination, and neither is the source itself.
   */
  const handoffDestinations =
    activeSession && !isWorkflowSession
      ? (Object.keys(AGENT_PROVIDER_LABELS) as AgentProvider[]).filter(
          (provider) =>
            provider !== activeSession.provider && enabledAgentPlatforms.includes(provider),
        )
      : [];
  const canHandoff = handoffDestinations.length > 0;
  const neutralProjection = useNativeAgentProjectionStore((state) => {
    if (!activeSession) return undefined;
    const projection = state.projections.get(activeSession.sessionKey);
    // Workflow restarts can replace the provider session under the same key.
    if (isWorkflowSession && projection?.sessionId !== activeSession.providerSessionId)
      return undefined;
    return projection;
  });
  // A session that lists its MCP servers needs no separate count tile.
  const reportsMcpList = neutralProjection?.runtime?.mcp !== undefined;
  const neutralControlUpdatePending =
    controlUpdateState?.sessionIdentity === activeSession?.sessionKey;
  const updateNeutralControls = useCallback(
    async (update: NativeAgentControlUpdate) => {
      const session = activeSession;
      if (!session || session.buildPipelineId || session.multiReviewReviewer) return;
      if (controlUpdateInFlightRef.current?.sessionIdentity === session.sessionKey) return;

      const pending = {
        actionId: ++controlUpdateIdRef.current,
        sessionIdentity: session.sessionKey,
      };
      controlUpdateInFlightRef.current = pending;
      setControlUpdateState(pending);
      const startingProjection = useNativeAgentProjectionStore
        .getState()
        .projections.get(session.sessionKey);
      try {
        const next = await updateNativeAgentControls({
          environmentId: session.environmentId,
          agent: session.provider,
          logicalSessionKey: session.sessionKey,
          update,
        });
        if (!next) throw new Error(`${session.providerLabel} session is unavailable`);
        const projectionState = useNativeAgentProjectionStore.getState();
        const current = projectionState.projections.get(session.sessionKey);
        const currentReplacedSession =
          current?.sessionId && next.sessionId && current.sessionId !== next.sessionId;
        const currentSupersededGeneration =
          startingProjection &&
          current &&
          current.generation !== startingProjection.generation &&
          next.generation === startingProjection.generation;
        const currentHasNewerRevision =
          current && current.generation === next.generation && current.revision > next.revision;
        if (!currentReplacedSession && !currentSupersededGeneration && !currentHasNewerRevision) {
          projectionState.setProjection(session.sessionKey, next);
        }
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : `Failed to update ${session.providerLabel} settings`,
        );
      } finally {
        if (controlUpdateInFlightRef.current?.actionId === pending.actionId) {
          controlUpdateInFlightRef.current = null;
        }
        setControlUpdateState((current) =>
          current?.actionId === pending.actionId ? null : current,
        );
      }
    },
    [activeSession],
  );
  const neutralMessages = useMemo(
    () => normalizeNativeMessages((neutralProjection?.messages ?? []) as NativeMessage[]),
    [neutralProjection?.messages],
  );
  // The live projection's capabilities win; before one arrives, the shared
  // capability table answers for the platform instead of a provider list here.
  const sessionCapabilities =
    neutralProjection?.capabilities ??
    (activeSession ? nativeAgentCapabilities(activeSession.provider) : undefined);
  const sessionActions = sessionCapabilities?.actions;
  const canFork = !isWorkflowSession && (sessionCapabilities?.fork ?? false);
  const canCompact = !isWorkflowSession && (sessionActions?.compact ?? false);

  const neutralContextUsage = neutralProjection?.contextUsage;
  const neutralMaximumTokens = neutralContextUsage?.maximumTokens;
  const usage: AgentInfoUsageSnapshot | undefined = neutralContextUsage
    ? {
        ...neutralContextUsage,
        usedTokens: neutralContextUsage.usedTokens,
        ...(neutralMaximumTokens !== undefined &&
        Number.isFinite(neutralMaximumTokens) &&
        neutralMaximumTokens > 0
          ? {
              totalTokens: neutralMaximumTokens,
              percentUsed:
                neutralContextUsage.percentage ??
                (neutralContextUsage.usedTokens / neutralMaximumTokens) * 100,
            }
          : {}),
      }
    : undefined;
  const neutralRateLimits =
    neutralProjection?.rateLimits ?? neutralProjection?.contextUsage?.rateLimits;
  const liveClaudeTasks = neutralProjection?.backgroundTasks ?? [];
  const modelId = neutralProjection?.composer?.selectedModelId;

  const currentSessionId = neutralProjection?.sessionId ?? activeSession?.providerSessionId;
  const currentSessionLoading =
    neutralProjection?.turn.phase === "running" ||
    neutralProjection?.turn.phase === "recovering" ||
    neutralProjection?.turn.phase === "cancelling";
  /*
   * The tab key is not enough: resume replaces the provider session beneath
   * the same tab. Including the provider session id makes transient controls
   * change ownership immediately on both tab switches and same-tab resumes.
   */
  const sessionIdentity = activeSession
    ? `${activeSession.provider}:${activeSession.sessionKey}:${currentSessionId ?? "pending"}`
    : null;
  const currentSessionIdentityRef = useRef(sessionIdentity);
  // Read only by action continuations, which always resume after a commit.
  useLayoutEffect(() => {
    currentSessionIdentityRef.current = sessionIdentity;
  }, [sessionIdentity]);
  /*
   * One component instance serves every tab, so everything typed or latched
   * for the previous session has to go when the active tab changes. `steerText`
   * in particular is posted to `currentSessionId`: text composed for session A
   * would otherwise be delivered to session B's active turn. Reset while
   * rendering the new identity so no frame shows the previous session's state.
   */
  const [renderedSessionIdentity, setRenderedSessionIdentity] = useState(sessionIdentity);
  if (renderedSessionIdentity !== sessionIdentity) {
    setRenderedSessionIdentity(sessionIdentity);
    setOpen(false);
    setHandoffOpen(false);
    setRuntimeNoticeDialogId(null);
    setShareState({ sessionIdentity, value: false });
    setSteerState({ sessionIdentity, value: "" });
  }
  const busyAction = busyState?.sessionIdentity === sessionIdentity ? busyState.name : null;
  const steerText = steerState.sessionIdentity === sessionIdentity ? steerState.value : "";
  // The projection's share URL is the backend's authoritative share state; the
  // local latch only covers the window before the next projection arrives.
  const sessionShared =
    neutralProjection?.shareUrl !== undefined
      ? neutralProjection.shareUrl !== null
      : shareState.sessionIdentity === sessionIdentity && shareState.value;

  useEffect(() => {
    if (!open || !activeSession || !currentSessionId) return;
    let cancelled = false;
    const requestedSessionId = currentSessionId;
    const projection = activeSession.buildPipelineId
      ? getBuildPipelineSessionProjection({
          pipelineId: activeSession.buildPipelineId,
          sessionKey: activeSession.sessionKey,
          refreshUsage: true,
        })
      : activeSession.multiReviewReviewer
        ? getMultiReviewReviewerProjection({
            ...activeSession.multiReviewReviewer,
            refreshUsage: true,
          })
        : getNativeAgentProjection({
            environmentId: activeSession.environmentId,
            agent: activeSession.provider,
            logicalSessionKey: activeSession.sessionKey,
            refreshUsage: true,
          });
    void projection
      .then((projection) => {
        if (cancelled || !projection || projection.sessionId !== requestedSessionId) return;
        useNativeAgentProjectionStore
          .getState()
          .setProjection(activeSession.sessionKey, projection);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeSession, currentSessionId, open]);

  // Read when the panel opens rather than carried by the projection: an
  // account read is not free, and only this panel shows the account.
  const accountEnvironmentId = activeSession?.environmentId;
  const accountAgent = activeSession?.provider;
  const accountSessionKey = activeSession?.sessionKey;
  const accountKey =
    accountEnvironmentId && accountAgent && accountSessionKey
      ? `${accountEnvironmentId}\0${accountAgent}\0${accountSessionKey}`
      : null;
  const [accountStatus, setAccountStatus] = useState<{
    key: string;
    status: NativeAgentAuthStatus | null;
  } | null>(null);
  const [accountReadFailed, setAccountReadFailed] = useState(false);
  const accountReaderRef = useRef<{
    refresh: () => Promise<void>;
    invalidate: () => void;
    watchSignIn: () => void;
  } | null>(null);
  useEffect(() => {
    if (!open || !accountKey || !accountEnvironmentId || !accountAgent || !accountSessionKey)
      return;
    let cancelled = false;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observedPendingSignIn: string | null = null;
    let signInReadsRemaining = 0;
    let signInDeadline = 0;
    const invalidate = () => {
      sequence++;
      clearTimeout(timer);
      signInReadsRemaining = 0;
      signInDeadline = 0;
    };
    const refresh = async () => {
      if (cancelled) return;
      clearTimeout(timer);
      const request = ++sequence;
      try {
        const status = await getNativeAgentAuthStatus({
          environmentId: accountEnvironmentId,
          agent: accountAgent,
          logicalSessionKey: accountSessionKey,
        });
        if (cancelled || request !== sequence) return;
        if (typeof status?.state !== "string") throw new Error("Account status is unavailable");
        setAccountStatus({ key: accountKey, status });
        setAccountReadFailed(false);
        if (status.state === "signed-in") {
          signInReadsRemaining = 0;
          toast.dismiss(deviceCodeToastId(accountEnvironmentId, accountAgent));
        } else {
          const pending = normalizePendingSignIn(status.pendingSignIn);
          if (pending) {
            const identity = JSON.stringify([pending.code, pending.url, pending.expiresAt]);
            if (observedPendingSignIn !== identity)
              toast.info(`Device code: ${pending.code}`, {
                id: deviceCodeToastId(accountEnvironmentId, accountAgent),
                duration: pending.expiresAt - Date.now(),
                closeButton: true,
                cancel: cancelDeviceCodeSignIn({
                  environmentId: accountEnvironmentId,
                  agent: accountAgent,
                  logicalSessionKey: accountSessionKey,
                }),
                action: {
                  label: "Open sign-in link",
                  onClick: () => {
                    void openInBrowser(pending.url).catch(() =>
                      toast.error("Could not open the sign-in link"),
                    );
                  },
                },
              });
            observedPendingSignIn = identity;
            signInReadsRemaining = Math.ceil((pending.expiresAt - Date.now()) / 2_000);
            signInDeadline = pending.expiresAt;
          } else if (observedPendingSignIn || status.pendingSignIn === null) {
            observedPendingSignIn = null;
            toast.dismiss(deviceCodeToastId(accountEnvironmentId, accountAgent));
          }
        }
      } catch {
        if (cancelled || request !== sequence) return;
        setAccountReadFailed(true);
      }
      // Login completion happens outside this panel. Bound the follow-up reads
      // to two minutes for browser login or the device-code deadline, and stop
      // them on close, identity change or sign-out.
      if (signInReadsRemaining > 0 && Date.now() < signInDeadline) {
        signInReadsRemaining--;
        timer = setTimeout(() => void refresh(), 2_000);
      }
    };
    const reader = {
      refresh,
      invalidate,
      watchSignIn: () => {
        if (cancelled) return;
        signInReadsRemaining = 60;
        signInDeadline = Date.now() + 120_000;
        void refresh();
      },
    };
    accountReaderRef.current = reader;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      invalidate();
      window.removeEventListener("focus", onFocus);
      if (accountReaderRef.current === reader) accountReaderRef.current = null;
      // A failure belongs to this read cycle; the next open or identity starts clean.
      setAccountReadFailed(false);
    };
  }, [open, accountAgent, accountEnvironmentId, accountKey, accountSessionKey]);
  const auth = accountStatus?.key === accountKey ? accountStatus.status : null;
  // An account read only labels the live projection it was requested for.
  // A stopped bridge reports its next-start account, while an unreachable
  // projection can retain the previous account's quotas indefinitely.
  const sessionAccountKey =
    accountEnvironmentId && accountAgent
      ? JSON.stringify([
          sessionIdentity,
          neutralProjection?.generation,
          neutralProjection?.connection,
        ])
      : undefined;
  const [sessionAccount, setSessionAccount] = useState<{
    key: string;
    account: AgentSessionAccount | null;
  } | null>(null);
  const reportSessionAccount = useCallback(
    (account: AgentSessionAccount | null) => {
      if (sessionAccountKey) setSessionAccount({ key: sessionAccountKey, account });
    },
    [sessionAccountKey],
  );
  const usageAccount =
    sessionAccountKey &&
    sessionAccount?.key === sessionAccountKey &&
    sessionAccount.account?.source === "account" &&
    sessionAccount.account.running &&
    sessionAccount.account.platform === accountAgent &&
    neutralProjection?.connection === "connected" &&
    neutralProjection.platform === accountAgent &&
    neutralProjection.environmentId === accountEnvironmentId
      ? sessionAccount.account.account
      : undefined;

  const openForkTab = async (
    sessionId: string,
    title: string | undefined,
    closeCurrentPanel: boolean,
    controls?: NativeAgentControlUpdate,
  ) => {
    if (!activeTab || !activeSession) return;
    const id = createUuid();
    await adoptNativeAgentSession({
      environmentId: activeSession.environmentId,
      agent: activeSession.provider,
      logicalSessionKey: createSessionKey(activeSession.environmentId, id),
      providerSessionId: sessionId,
      controls,
    });
    /*
     * Built field by field, never by spreading the source tab. `TabInfo`
     * carries one-shot bootstrap fields (`initialPrompt`, `initialCommands`,
     * `initialAgentModel`, `initialReasoningEffort`) that are cleared only once
     * consumed; forking a tab whose initial prompt had not run yet produced a
     * fork that immediately auto-submitted it. The three in-tab fork handlers
     * construct their tabs the same way.
     */
    const tab: TabInfo = {
      id,
      type: "agent-native",
      displayTitle: title ?? `${activeSession.providerLabel} fork`,
      nativeAgentData: {
        ...getNativeAgentData(activeTab)!,
        platform: activeSession.provider,
        sessionId,
      },
    };
    const panes = usePaneLayoutStore.getState();
    panes.addTab(
      panes.getActivePaneId(activeSession.environmentId),
      tab,
      activeSession.environmentId,
    );
    if (closeCurrentPanel) setOpen(false);
  };

  const openHandoffTab = (source: AgentProvider, destination: AgentProvider, handoffId: string) => {
    if (!activeTab || !activeSession) return;
    const sourceData = getNativeAgentData(activeTab);
    if (!sourceData) return;
    const nativeData = {
      containerId: sourceData.containerId,
      environmentId: activeSession.environmentId,
      isLocal: sourceData.isLocal,
    };
    const id = createUuid();
    const destinationLabel = AGENT_PROVIDER_LABELS[destination];
    const tab: TabInfo = {
      id,
      type: "agent-native",
      displayTitle: `${destinationLabel} · from ${AGENT_PROVIDER_LABELS[source]}`,
      agentHandoffId: handoffId,
      nativeAgentData: { ...nativeData, platform: destination },
    };
    const panes = usePaneLayoutStore.getState();
    panes.addTab(
      panes.getActivePaneId(activeSession.environmentId),
      tab,
      activeSession.environmentId,
    );
    setOpen(false);
  };

  const runAction = async (
    name: string,
    action: (scope: { isCurrent: () => boolean; sessionIdentity: string }) => Promise<void>,
  ) => {
    if (!sessionIdentity) return;
    const actionId = ++actionIdRef.current;
    const actionState = { actionId, name, sessionIdentity };
    const isCurrent = () => currentSessionIdentityRef.current === sessionIdentity;
    setBusyState(actionState);
    try {
      await action({ isCurrent, sessionIdentity });
    } catch (error) {
      if (isCurrent()) {
        toast.error(error instanceof Error ? error.message : `${name} failed`);
      }
    } finally {
      setBusyState((current) =>
        current?.actionId === actionId && current.sessionIdentity === sessionIdentity
          ? null
          : current,
      );
    }
  };

  const forkCurrent = () =>
    runAction("fork", async ({ isCurrent }) => {
      if (!activeSession || !currentSessionId) return;
      const fork = await forkNativeAgentSession({
        environmentId: activeSession.environmentId,
        agent: activeSession.provider,
        logicalSessionKey: activeSession.sessionKey,
      });
      await openForkTab(fork.sessionId, fork.title, isCurrent(), fork.controls);
    });

  const continueIn = (
    destination: AgentProvider,
    sourceSession: ActiveNativeSession,
    sourceSessionId: string,
  ) =>
    runAction(`continue-${destination}`, async ({ isCurrent }) => {
      // The backend reads the whole transcript, measures the changes and stores
      // the result; the source tab only names what it is looking at.
      const handoff = await createAgentHandoff({
        handoffId: createUuid(),
        environmentId: sourceSession.environmentId,
        sourceAgent: sourceSession.provider,
        logicalSessionKey: sourceSession.sessionKey,
        sourceSessionId,
        destinationProvider: destination,
        ...(activeTab?.agentHandoffId ? { priorHandoffId: activeTab.agentHandoffId } : {}),
        ...(neutralProjection?.title ? { sourceTitle: neutralProjection.title } : {}),
        ...(modelId ? { sourceModel: modelId } : {}),
      });
      if (!isCurrent()) {
        // The source tab changed while this ran, so no destination tab will own
        // the snapshot. The backend reclaims an unreferenced handoff itself.
        forgetAgentHandoff(handoff.id);
        return;
      }
      openHandoffTab(sourceSession.provider, destination, handoff.id);
      toast.success(
        `Continuing in ${AGENT_PROVIDER_LABELS[destination]} with ` +
          `${formatCount(handoff.stats.messageCount, "message")} and ` +
          formatCount(handoff.stats.toolCallCount, "tool call"),
      );
    });

  const compactCurrent = () =>
    runAction("compact", async () => {
      if (!activeSession || !currentSessionId) return;
      await performNativeAgentSessionAction({
        environmentId: activeSession.environmentId,
        agent: activeSession.provider,
        logicalSessionKey: activeSession.sessionKey,
        action: { kind: "compact", modelId },
      });
      toast.success("Context compaction started");
    });

  const close = () => {
    restoreFocusRef.current = true;
    setRuntimeNoticeDialogId(null);
    setOpen(false);
  };

  useEffect(() => {
    if (!open && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      reportDismiss();
      triggerRef.current?.focus();
    }
  }, [open]);

  /*
   * Escape must be *claimed*, not merely observed. All three chat tabs bind a
   * window-level Escape handler that aborts the running turn, guarded only by
   * `event.defaultPrevented`; dismissing this popover mid-turn used to kill the
   * turn as well. Capture phase makes the outcome independent of mount order —
   * the tab's bubble-phase listener sees the key already consumed however the
   * two components happened to mount.
   */
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Let the portaled Radix dialog claim the first Escape. Its handler
      // prevents the same key from reaching the chat tab's abort shortcut.
      if (runtimeNoticeDialogId !== null) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [open, runtimeNoticeDialogId]);

  return (
    <div
      className={cn("relative", remote ? "h-0 w-0" : mobile ? "h-9 w-9" : "h-8 w-8")}
      data-testid={remote ? "realm-agent-info-panel" : undefined}
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {remote ? null : (
        <AgentInfoTrigger
          ref={triggerRef}
          open={open}
          mobile={mobile}
          onClick={() => setOpen((value) => !value)}
        />
      )}

      {open ? (
        <button
          type="button"
          className="fixed inset-0 z-40 cursor-default bg-transparent"
          onClick={close}
          aria-label="Close agent information"
        />
      ) : null}

      <section
        ref={panelRef}
        id="agent-information-popover"
        role="dialog"
        aria-label="Agent information"
        aria-hidden={!open}
        className={cn(
          "absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[min(calc(100vw-1rem),23rem)] origin-top-right overflow-hidden rounded-xl border border-border/80 bg-popover/98 shadow-[0_22px_70px_rgba(0,0,0,0.52)] backdrop-blur-xl transition duration-150",
          open
            ? "visible scale-100 opacity-100"
            : "pointer-events-none invisible scale-95 opacity-0",
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border/60 px-4 py-3.5">
          <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
              Active session
            </div>
            <h2 className="mt-1 truncate text-sm font-semibold text-foreground">
              {activeSession?.providerLabel ?? "No native agent"}
            </h2>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="-mr-1 -mt-1 h-7 w-7 text-muted-foreground"
            onClick={close}
            aria-label="Close agent information"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </header>

        <div className="max-h-[min(76vh,42rem)] overflow-y-auto p-4">
          <ConnectionPathPanel
            path={connectionPath}
            boundMachineName={federation.enabled ? (federation.boundMachine?.name ?? null) : null}
          />
          <SystemUsagePanel
            usage={systemUsage.sample}
            stale={systemUsage.stale}
            sampledAt={systemUsage.sampledAt}
          />
          {activeSession ? (
            <div className="space-y-5">
              {activeTab &&
              !isWorkflowSession &&
              messagingEnabled &&
              agentMailCapabilities("agent-native", activeSession.provider).canPull ? (
                <div className="flex gap-2 border-b border-border/60 pb-4">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      close();
                      openAgentMailForTab(activeSession.environmentId, activeTab.id);
                    }}
                  >
                    Messages…
                  </Button>
                </div>
              ) : null}
              <div>
                <UsagePanel
                  usage={usage}
                  modelId={modelId}
                  /*
                   * Claude's projection carries its quota windows as an
                   * independent authoritative snapshot, including an empty one.
                   * Every other provider reports through the usage snapshot,
                   * falling back to the projection's windows when it has none.
                   */
                  rateLimits={
                    activeSession.provider === "claude"
                      ? neutralRateLimits
                      : (usage?.rateLimits ?? neutralRateLimits)
                  }
                  accountLabel={usageAccount?.label}
                  accountEmail={usageAccount?.identity.email}
                />
              </div>

              <AgentInfoAccountSection
                key={sessionAccountKey}
                environmentId={activeSession.environmentId}
                provider={activeSession.provider}
                open={open}
                onSessionAccount={reportSessionAccount}
                refreshKey={`${neutralProjection?.generation}:${neutralProjection?.connection}:${neutralProjection?.turn.phase}`}
              />

              {!isWorkflowSession && neutralProjection?.composer?.executionProfiles?.length ? (
                <div className="space-y-2 border-t border-border/60 pt-4">
                  <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                    Execution profile
                  </div>
                  <select
                    disabled={neutralControlUpdatePending}
                    value={neutralProjection.composer.selectedExecutionProfileId ?? ""}
                    onChange={(event) => {
                      void updateNeutralControls({
                        executionProfileId: event.target.value || null,
                      });
                    }}
                    className="h-9 w-full rounded-md border border-border/70 bg-input-surface px-3 text-sm"
                    aria-label="Execution profile"
                  >
                    <option value="">Provider default</option>
                    {neutralProjection.composer.executionProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.id}
                        {profile.modelId ? ` · ${profile.modelId}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {/*
                Deliberately outside the execution-profile block. These are
                session options, not agent options: `sessionInitData.agents`
                defaults to `[]`, so nesting them under a non-empty agent list
                hid both toggles — including the prompt-suggestion opt-in that
                gates the feature — for any Claude session whose init payload
                omitted agents.
              */}
              {!isWorkflowSession && activeSession.provider === "claude" ? (
                <div className="space-y-1.5 border-t border-border/60 pt-4">
                  <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                    Session options
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      disabled={neutralControlUpdatePending || !neutralProjection}
                      checked={neutralProjection?.composer?.includeLocalSettings ?? false}
                      onChange={(event) => {
                        void updateNeutralControls({
                          includeLocalSettings: event.target.checked,
                        });
                      }}
                    />
                    Include .claude/settings.local.json
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      disabled={neutralControlUpdatePending || !neutralProjection}
                      checked={neutralProjection?.composer?.promptSuggestionsEnabled ?? false}
                      onChange={(event) => {
                        void updateNeutralControls({ promptSuggestions: event.target.checked });
                      }}
                    />
                    Suggest a follow-up after each turn
                  </label>
                </div>
              ) : null}

              {!isWorkflowSession && (canFork || canCompact || canHandoff) ? (
                <div className="space-y-2 border-t border-border/60 pt-4">
                  <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                    Session actions
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {canFork ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!currentSessionId || busyAction !== null}
                        onClick={() => void forkCurrent()}
                        className="justify-start gap-2"
                      >
                        <Copy className="h-3.5 w-3.5" />
                        Fork session
                      </Button>
                    ) : null}
                    {canCompact ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!currentSessionId || busyAction !== null}
                        onClick={() => void compactCurrent()}
                        className="justify-start gap-2"
                      >
                        <Scissors className="h-3.5 w-3.5" />
                        Compact
                      </Button>
                    ) : null}

                    {canHandoff ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!currentSessionId || currentSessionLoading || busyAction !== null}
                        aria-expanded={handoffOpen}
                        onClick={() => setHandoffOpen((value) => !value)}
                        className={cn(
                          "col-span-2 justify-start gap-2",
                          handoffOpen && "border-primary/40 bg-primary/5",
                        )}
                      >
                        <ArrowRightLeft className="h-3.5 w-3.5" />
                        Continue in…
                      </Button>
                    ) : null}

                    {canHandoff && handoffOpen && currentSessionId ? (
                      <div className="col-span-2 rounded-lg border border-border/70 bg-muted/20 p-2.5">
                        <div className="mb-2 flex items-center gap-2">
                          <span className="rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] font-medium">
                            {AGENT_PROVIDER_LABELS[activeSession.provider]}
                          </span>
                          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">
                            {handoffDestinations.map((provider) => (
                              <Button
                                key={provider}
                                variant="secondary"
                                size="sm"
                                className="h-8 min-w-0 px-2 text-xs"
                                disabled={busyAction !== null || currentSessionLoading}
                                onClick={() =>
                                  void continueIn(provider, activeSession, currentSessionId)
                                }
                              >
                                {busyAction === `continue-${provider}`
                                  ? "Preparing…"
                                  : AGENT_PROVIDER_LABELS[provider]}
                              </Button>
                            ))}
                          </div>
                        </div>
                        <p className="text-[10px] leading-relaxed text-muted-foreground">
                          Copies the completed transcript and tool history into a new agent. This
                          source session stays intact; live tasks and approvals do not transfer.
                        </p>
                      </div>
                    ) : null}

                    {!isWorkflowSession &&
                    activeSession.provider === "claude" &&
                    currentSessionId ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyAction !== null}
                        className="justify-start gap-2"
                        onClick={() =>
                          void runAction("rewind", async () => {
                            const target = neutralMessages
                              .filter((message) => message.role === "user")
                              .at(-1);
                            if (!target?.id) throw new Error("No file checkpoint is available");
                            const { preview } = await performNativeAgentSessionAction({
                              environmentId: activeSession.environmentId,
                              agent: activeSession.provider,
                              logicalSessionKey: activeSession.sessionKey,
                              action: {
                                kind: "rewind-files",
                                messageId: target.id,
                                dryRun: true,
                              },
                            });
                            /*
                             * This mutates the worktree, so the confirmation names
                             * the message it is anchored to and lists the files it
                             * will touch. It used to paste a truncated
                             * `JSON.stringify` of the dry run into the dialog.
                             */
                            const { files, fileCount } = summarizeRewindPreview(preview);
                            const shown = files.slice(0, 10);
                            const body =
                              fileCount === 0
                                ? "Claude reported no file changes for this checkpoint."
                                : [
                                    `${fileCount} ${fileCount === 1 ? "file" : "files"} will be restored:`,
                                    ...shown.map((file) => `  • ${file}`),
                                    ...(files.length > shown.length
                                      ? [`  • …and ${files.length - shown.length} more`]
                                      : []),
                                  ].join("\n");
                            if (
                              !window.confirm(
                                [
                                  `Rewind your files to the state before ${describeRewindTarget(target.content)}?`,
                                  body,
                                  "This overwrites the working tree and cannot be undone.",
                                ].join("\n\n"),
                              )
                            )
                              return;
                            await performNativeAgentSessionAction({
                              environmentId: activeSession.environmentId,
                              agent: activeSession.provider,
                              logicalSessionKey: activeSession.sessionKey,
                              action: { kind: "rewind-files", messageId: target.id },
                            });
                            toast.success(
                              fileCount === 0
                                ? "Claude files rewound"
                                : `Claude restored ${fileCount} ${fileCount === 1 ? "file" : "files"}`,
                            );
                          })
                        }
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Rewind files
                      </Button>
                    ) : null}

                    {!isWorkflowSession && currentSessionId && sessionActions?.undo ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyAction !== null}
                        className="justify-start gap-2"
                        onClick={() =>
                          void runAction("undo", async () => {
                            const messageId = neutralMessages
                              .filter((message) => message.role === "user")
                              .at(-1)?.id;
                            await performNativeAgentSessionAction({
                              environmentId: activeSession.environmentId,
                              agent: activeSession.provider,
                              logicalSessionKey: activeSession.sessionKey,
                              action: { kind: "undo", messageId },
                            });
                            toast.success("Session reverted");
                          })
                        }
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Undo turn
                      </Button>
                    ) : null}

                    {!isWorkflowSession && currentSessionId && sessionActions?.share ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyAction !== null}
                        className="justify-start gap-2"
                        onClick={() =>
                          void runAction(
                            "share",
                            async ({ isCurrent, sessionIdentity: actionIdentity }) => {
                              if (
                                !window.confirm(
                                  "Create a share link? The conversation will leave this machine and be accessible to anyone with the link.",
                                )
                              )
                                return;
                              const { shareUrl: url } = await performNativeAgentSessionAction({
                                environmentId: activeSession.environmentId,
                                agent: activeSession.provider,
                                logicalSessionKey: activeSession.sessionKey,
                                action: { kind: "share" },
                              });
                              /*
                               * The conversation is published the moment `share()`
                               * resolves. Latch that first: every failure after this
                               * point (a missing URL, a clipboard rejection on focus
                               * or permission grounds) used to skip the flag, so the
                               * user saw an error while the link was live and
                               * "Stop sharing" never rendered.
                               */
                              if (isCurrent()) {
                                setShareState({
                                  sessionIdentity: actionIdentity,
                                  value: true,
                                });
                              }
                              // The originating session is now shared, but a
                              // different active session must not receive its URL,
                              // clipboard side effect, or notification.
                              if (!isCurrent()) return;
                              if (!url) {
                                toast.warning(
                                  "Session shared, but the agent did not return the link. Use Stop sharing to revoke it.",
                                );
                                return;
                              }
                              try {
                                await navigator.clipboard.writeText(url);
                                if (isCurrent()) toast.success("Share link copied");
                              } catch {
                                if (isCurrent())
                                  toast.warning(
                                    `Session shared, but the link could not be copied: ${url}`,
                                  );
                              }
                            },
                          )
                        }
                      >
                        <Share2 className="h-3.5 w-3.5" />
                        Share…
                      </Button>
                    ) : null}

                    {!isWorkflowSession && currentSessionId && sessionActions?.redo ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyAction !== null}
                        className="justify-start gap-2"
                        onClick={() =>
                          void runAction("redo", async () => {
                            await performNativeAgentSessionAction({
                              environmentId: activeSession.environmentId,
                              agent: activeSession.provider,
                              logicalSessionKey: activeSession.sessionKey,
                              action: { kind: "redo" },
                            });
                            toast.success("Revert undone");
                          })
                        }
                      >
                        <RotateCcw className="h-3.5 w-3.5 scale-x-[-1]" />
                        Redo turn
                      </Button>
                    ) : null}

                    {!isWorkflowSession &&
                    currentSessionId &&
                    sessionActions?.share &&
                    sessionShared ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyAction !== null}
                        className="justify-start gap-2"
                        onClick={() =>
                          void runAction(
                            "unshare",
                            async ({ isCurrent, sessionIdentity: actionIdentity }) => {
                              await performNativeAgentSessionAction({
                                environmentId: activeSession.environmentId,
                                agent: activeSession.provider,
                                logicalSessionKey: activeSession.sessionKey,
                                action: { kind: "unshare" },
                              });
                              if (isCurrent()) {
                                setShareState({
                                  sessionIdentity: actionIdentity,
                                  value: false,
                                });
                                toast.success("Share link disabled");
                              }
                            },
                          )
                        }
                      >
                        <X className="h-3.5 w-3.5" />
                        Stop sharing
                      </Button>
                    ) : null}

                    {!isWorkflowSession &&
                    activeSession.provider === "codex" &&
                    currentSessionId ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyAction !== null}
                        className="justify-start gap-2"
                        onClick={() =>
                          void runAction("review", async () => {
                            await performNativeAgentSessionAction({
                              environmentId: activeSession.environmentId,
                              agent: activeSession.provider,
                              logicalSessionKey: activeSession.sessionKey,
                              action: { kind: "review" },
                            });
                            toast.success("Reviewing uncommitted changes");
                          })
                        }
                      >
                        <Info className="h-3.5 w-3.5" />
                        Review changes
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {!isWorkflowSession &&
              neutralProjection?.capabilities.actions?.steer &&
              neutralProjection.turn.phase === "running" &&
              !neutralProjection.recoverableDispatch ? (
                <div className="space-y-2 border-t border-border/60 pt-4">
                  <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                    Active turn
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={steerText}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSteerState({
                          sessionIdentity,
                          value,
                        });
                      }}
                      placeholder={`Correct or redirect ${AGENT_PLATFORM_LABELS[activeSession.provider]}`}
                      className="h-8 text-xs"
                    />
                    <Button
                      size="sm"
                      className="h-8"
                      disabled={!steerText.trim() || busyAction !== null}
                      onClick={() =>
                        void runAction(
                          "steer",
                          async ({ isCurrent, sessionIdentity: actionIdentity }) => {
                            const text = steerText.trim();
                            const outcome = await performNativeAgentSessionAction({
                              environmentId: activeSession.environmentId,
                              agent: activeSession.provider,
                              logicalSessionKey: activeSession.sessionKey,
                              action: { kind: "steer", text },
                            });
                            if (outcome.outcome === "unknown") {
                              throw new Error(
                                "Delivery is unconfirmed. Resolve the backend recovery card in the chat tab before sending another instruction.",
                              );
                            }
                            if (outcome.outcome === "mismatch") {
                              throw new Error("The active turn changed before delivery.");
                            }
                            if (outcome.outcome === "idle") {
                              throw new Error("There is no active turn to steer.");
                            }
                            if (outcome.outcome === "rejected") {
                              throw new Error(nativeAgentSteerRejectionMessage(outcome));
                            }
                            if (isCurrent()) {
                              setSteerState({
                                sessionIdentity: actionIdentity,
                                value: "",
                              });
                              toast.success("Sent to the active turn");
                            }
                          },
                        )
                      }
                    >
                      Send now
                    </Button>
                  </div>
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    Sends directly to the current {AGENT_PLATFORM_LABELS[activeSession.provider]}{" "}
                    turn. Regular compose messages still queue.
                  </p>
                </div>
              ) : null}

              {!isWorkflowSession &&
              activeSession.provider === "claude" &&
              currentSessionId &&
              liveClaudeTasks.some(
                (task) =>
                  task.status === "running" ||
                  task.status === "pending" ||
                  task.status === "paused",
              ) ? (
                <div className="space-y-2 border-t border-border/60 pt-4">
                  <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                    Background tasks
                  </div>
                  {liveClaudeTasks
                    .filter(
                      (task) =>
                        task.status === "running" ||
                        task.status === "pending" ||
                        task.status === "paused",
                    )
                    .map((task) => (
                      <div
                        key={task.id}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <span className="min-w-0 truncate">{task.description ?? task.id}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 gap-1.5"
                          onClick={() =>
                            void runAction(`stop-${task.id}`, async () => {
                              await stopNativeAgentBackgroundTask({
                                environmentId: activeSession.environmentId,
                                agent: activeSession.provider,
                                logicalSessionKey: activeSession.sessionKey,
                                taskId: task.id,
                              });
                            })
                          }
                        >
                          <Square className="h-3 w-3" />
                          Stop
                        </Button>
                      </div>
                    ))}
                </div>
              ) : null}

              <div className="space-y-2 border-t border-border/60 pt-4">
                <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                  Runtime
                </div>
                {neutralProjection?.policy ? (
                  <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-xs">
                    <div className="font-medium text-foreground">Execution policy</div>
                    <p className="mt-0.5 leading-relaxed text-muted-foreground">
                      {describeNativeAgentExecutionPolicy(neutralProjection.policy)}
                    </p>
                    {neutralProjection.policy.note ? (
                      <p className="mt-1 leading-relaxed text-muted-foreground">
                        {neutralProjection.policy.note}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {accountReadFailed ? (
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span>Could not read account status.</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void accountReaderRef.current?.refresh()}
                    >
                      Retry account status
                    </Button>
                  </div>
                ) : null}
                {auth ? (
                  <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium text-foreground">
                          {auth.account?.label ?? activeSession.providerLabel}
                        </div>
                        <div className="mt-0.5 text-muted-foreground">
                          {auth.state.replaceAll("-", " ")}
                          {auth.account?.plan ? ` · ${auth.account.plan}` : ""}
                        </div>
                      </div>
                      {auth.state === "signed-in" && auth.signOut ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7"
                          disabled={busyAction !== null}
                          onClick={() =>
                            void runAction("auth-sign-out", async () => {
                              const reader = accountReaderRef.current;
                              reader?.invalidate();
                              await signOutNativeAgent({
                                environmentId: activeSession.environmentId,
                                agent: activeSession.provider,
                                logicalSessionKey: activeSession.sessionKey,
                              });
                              toast.success(`Signed out of ${activeSession.providerLabel}`);
                              await reader?.refresh();
                            })
                          }
                        >
                          Sign out
                        </Button>
                      ) : auth.signIn?.kind !== "none" && auth.signIn?.kind !== "terminal" ? (
                        <Button
                          size="sm"
                          className="h-7"
                          disabled={busyAction !== null}
                          onClick={() =>
                            void runAction("auth-sign-in", async () => {
                              const reader = accountReaderRef.current;
                              reader?.invalidate();
                              const result = await beginNativeAgentSignIn({
                                environmentId: activeSession.environmentId,
                                agent: activeSession.provider,
                                logicalSessionKey: activeSession.sessionKey,
                                // No loopback callback reaches a remote backend.
                                ...(isRemoteGatewayConnection() ? { deviceCode: true } : {}),
                              });
                              // The code is needed for as long as the sign-in takes.
                              if (result.code) {
                                toast.info(`Device code: ${result.code}`, {
                                  id: deviceCodeToastId(
                                    activeSession.environmentId,
                                    activeSession.provider,
                                  ),
                                  duration: NATIVE_AGENT_PENDING_SIGN_IN_TTL_MS,
                                  closeButton: true,
                                  cancel: cancelDeviceCodeSignIn({
                                    environmentId: activeSession.environmentId,
                                    agent: activeSession.provider,
                                    logicalSessionKey: activeSession.sessionKey,
                                  }),
                                  ...(result.url
                                    ? {
                                        action: {
                                          label: "Open sign-in link",
                                          onClick: () => {
                                            void openInBrowser(result.url!).catch(() =>
                                              toast.error("Could not open the sign-in link"),
                                            );
                                          },
                                        },
                                      }
                                    : {}),
                                });
                              }
                              reader?.watchSignIn();
                              // Opening a browser is independent of starting the login.
                              if (result.url) {
                                void openInBrowser(result.url).catch(() => {
                                  toast.error("Could not open the sign-in link");
                                });
                              }
                            })
                          }
                        >
                          Sign in
                        </Button>
                      ) : null}
                    </div>
                    {activeSession.provider === "claude" && auth.state !== "signed-in" ? (
                      // Claude's route is the backend-driven account login, not
                      // a bridge sign-in, so it has its own action.
                      <div className="mt-2">
                        <ClaudeAccountSignInAction containerId={sessionContainerId} />
                      </div>
                    ) : null}
                    {auth.signIn?.hint && auth.state !== "signed-in" ? (
                      <p className="mt-2 leading-relaxed text-muted-foreground">
                        {auth.signIn.hint}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <AgentInfoMcpSection
                  environmentId={activeSession.environmentId}
                  provider={activeSession.provider}
                  sessionKey={activeSession.sessionKey}
                  servers={neutralProjection?.runtime?.mcp}
                  readOnly={isWorkflowSession}
                  busyAction={busyAction}
                  onAction={(server, action) =>
                    void runAction(`mcp-${server.id}-${action}`, async () => {
                      const result = await performNativeAgentMcpAction({
                        environmentId: activeSession.environmentId,
                        agent: activeSession.provider,
                        logicalSessionKey: activeSession.sessionKey,
                        serverId: server.id,
                        action,
                      });
                      if (result.url) {
                        window.open(result.url, "_blank", "noopener,noreferrer");
                      }
                    })
                  }
                />
                {activeSession.provider === "claude" ? (
                  <div
                    className={cn(
                      "grid gap-2 text-center text-xs",
                      reportsMcpList ? "grid-cols-2" : "grid-cols-3",
                    )}
                  >
                    {/* The server list above already counts servers and tools;
                        the tile is only for a session that reports no list. */}
                    {reportsMcpList ? null : (
                      <Metric
                        label="MCP"
                        value={String(neutralProjection?.runtime?.mcpServers ?? 0)}
                      />
                    )}
                    <Metric
                      label="Plugins"
                      value={String(neutralProjection?.runtime?.plugins ?? 0)}
                    />
                    <Metric
                      label="Commands"
                      value={String(neutralProjection?.runtime?.commands ?? 0)}
                    />
                  </div>
                ) : activeSession.provider === "opencode" ? (
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    {reportsMcpList ? null : (
                      <Metric
                        label="MCP"
                        value={String(neutralProjection?.runtime?.mcpServers ?? 0)}
                      />
                    )}
                    <Metric
                      label="Skills"
                      value={String(neutralProjection?.runtime?.skills ?? 0)}
                    />
                    <Metric
                      label="LSP"
                      value={String(neutralProjection?.runtime?.lspServers ?? 0)}
                    />
                    <Metric label="Todos" value={String(neutralProjection?.runtime?.todos ?? 0)} />
                    <Metric label="Files" value={String(neutralProjection?.runtime?.files ?? 0)} />
                  </div>
                ) : (
                  // One panel for every platform, including Codex. Inventory,
                  // drift and provider notices all arrive on the neutral
                  // projection, so there is nothing left for a provider-shaped
                  // panel to add.
                  <AgentRuntimePanel
                    runtime={neutralProjection?.runtime}
                    providerLabel={activeSession.providerLabel}
                    openNoticeId={runtimeNoticeDialogId}
                    onOpenNoticeChange={setRuntimeNoticeDialogId}
                  />
                )}
                {(activeSession.provider === "claude" || activeSession.provider === "opencode") &&
                (neutralProjection?.runtime?.state ||
                  neutralProjection?.runtime?.version ||
                  neutralProjection?.runtime?.drift ||
                  (neutralProjection?.runtime?.notices?.length ?? 0) > 0) ? (
                  <AgentRuntimePanel
                    runtime={neutralProjection?.runtime}
                    providerLabel={activeSession.providerLabel}
                    includeMetrics={false}
                    openNoticeId={runtimeNoticeDialogId}
                    onOpenNoticeChange={setRuntimeNoticeDialogId}
                  />
                ) : null}
                <AgentInteractionCapability
                  kinds={neutralProjection?.capabilities?.interactions?.kinds}
                  providerLabel={activeSession.providerLabel}
                />
                {isWorkflowSession ? null : (
                  <AgentInfoPermissionRules
                    environmentId={activeSession.environmentId}
                    agent={activeSession.provider}
                    logicalSessionKey={activeSession.sessionKey}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/70 px-4 py-5">
              <p className="text-sm text-foreground">Select a native agent tab.</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Context, tokens, cost, limits, and runtime details are scoped to the active agent
                session.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
