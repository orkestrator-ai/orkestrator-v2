import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
import { getNativeAgentData, type TabInfo } from "@/types/paneLayout";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useConfigStore } from "@/stores/configStore";
import {
  compactClaudeSession,
  forkClaudeSession,
  getSession as getClaudeSession,
  getSessionMessages as getClaudeSessionMessages,
  rewindClaudeFiles,
  stopClaudeBackgroundTask,
} from "@/lib/claude-client";
import {
  compactOpenCodeSession,
  forkOpenCodeSession,
  getSessionMessages as getOpenCodeSessionMessages,
  getSessionStatus as getOpenCodeSessionStatus,
  revertOpenCodeSession,
  shareOpenCodeSession,
  unrevertOpenCodeSession,
  unshareOpenCodeSession,
} from "@/lib/opencode-client";
import {
  CodexForkError,
  compactCodexSession,
  describeCodexSteerFailure,
  forkCodexSession,
  getCodexRuntimeHealth,
  getSessionMessages as getCodexSessionMessages,
  getSessionStatus as getCodexSessionStatus,
  startCodexNativeReview,
  steerCodexSession,
} from "@/lib/codex-client";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { createUuid } from "@/lib/uuid";
import {
  AGENT_PROVIDER_LABELS,
  agentHandoffTranscriptDigest,
  composeAgentHandoffTransferMessages,
  createAgentHandoffSnapshot,
  forgetAgentHandoff,
  loadAgentHandoff,
  persistAgentHandoff,
  type AgentProvider,
} from "@/lib/agent-handoff";
import {
  deleteAgentHandoff,
  forkNativeAgentSession,
  getNativeAgentProjection,
  performNativeAgentSessionAction,
  stopNativeAgentBackgroundTask,
  updateNativeAgentControls,
} from "@/lib/backend";
import {
  normalizeClaudeMessagesForDisplay,
  normalizeCodexNativeMessage,
  normalizeOpenCodeNativeMessage,
  normalizeNativeMessages,
} from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { NativeAgentControlUpdate } from "@orkestrator/protocol/native-agent";
import {
  AGENT_PLATFORMS,
  AGENT_PLATFORM_LABELS,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";

interface AgentInfoButtonProps {
  activeTab: TabInfo | null;
  mobile?: boolean;
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

interface CodexSteerRetry {
  sessionIdentity: string;
  text: string;
  requestId: string;
}

const EMPTY_CLAUDE_TASKS: Record<string, never> = {};

interface ActiveNativeSession {
  provider: AgentPlatform;
  providerLabel: string;
  environmentId: string;
  sessionKey: string;
  providerSessionId?: string;
}

function resolveActiveNativeSession(tab: TabInfo | null): ActiveNativeSession | null {
  if (!tab) return null;
  const data = getNativeAgentData(tab);
  if (!data?.platform || !AGENT_PLATFORMS.includes(data.platform)) return null;
  return {
    provider: data.platform,
    // Claude, Codex and OpenCode keep the headings they have always had. An
    // agent added since takes its name from the shared platform table rather
    // than growing a second one here.
    providerLabel:
      data.platform === "opencode"
        ? "OpenCode"
        : data.platform === "claude" || data.platform === "codex"
          ? `${AGENT_PROVIDER_LABELS[data.platform]} Native`
          : AGENT_PLATFORM_LABELS[data.platform],
    environmentId: data.environmentId,
    sessionKey: createSessionKey(data.environmentId, tab.id),
    providerSessionId: data.sessionId,
  };
}

import {
  AgentRuntimePanel,
  CodexRuntimePanel,
  type AgentInfoUsageSnapshot,
  Metric,
  UsagePanel,
  codexLimitsFromHealth,
  describeRewindTarget,
  formatCount,
  readOpenCodeShareUrl,
  summarizeRewindPreview,
} from "./AgentInfoButton.panels";

export {
  describeRewindTarget,
  formatResetDateTime,
  summarizeRewindPreview,
  weeklyWindowPosition,
} from "./AgentInfoButton.panels";

export function AgentInfoButton({ activeTab, mobile = false }: AgentInfoButtonProps) {
  const [open, setOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [busyState, setBusyState] = useState<SessionActionState | null>(null);
  const [codexHealth, setCodexHealth] = useState<unknown>(null);
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
  const restoreFocusRef = useRef(false);
  const actionIdRef = useRef(0);
  const controlUpdateIdRef = useRef(0);
  const controlUpdateInFlightRef = useRef<ControlUpdateState | null>(null);
  const shareVersionRef = useRef(0);
  const codexSteerRetryRef = useRef<CodexSteerRetry | null>(null);
  const activeSession = useMemo(() => resolveActiveNativeSession(activeTab), [activeTab]);
  const enabledAgentPlatforms = useConfigStore(
    (state) => state.config.global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"],
  );
  /*
   * Every platform can send and receive a transfer, so the only thing that can
   * make one impossible is having nowhere to send it: an agent the user has
   * disabled is not a destination, and neither is the source itself.
   */
  const handoffDestinations = activeSession
    ? (Object.keys(AGENT_PROVIDER_LABELS) as AgentProvider[]).filter(
        (provider) =>
          provider !== activeSession.provider && enabledAgentPlatforms.includes(provider),
      )
    : [];
  const canHandoff = handoffDestinations.length > 0;
  const neutralProjection = useNativeAgentProjectionStore((state) =>
    activeSession ? state.projections.get(activeSession.sessionKey) : undefined,
  );
  const neutralControlUpdatePending =
    controlUpdateState?.sessionIdentity === activeSession?.sessionKey;
  const updateNeutralControls = useCallback(
    async (update: NativeAgentControlUpdate) => {
      const session = activeSession;
      if (!session) return;
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
  const canFork =
    neutralProjection?.capabilities.fork ??
    (activeSession?.provider === "claude" ||
      activeSession?.provider === "codex" ||
      activeSession?.provider === "opencode");
  const canCompact =
    neutralProjection?.capabilities.actions?.compact ??
    (activeSession?.provider === "claude" ||
      activeSession?.provider === "codex" ||
      activeSession?.provider === "opencode");

  const claudeUsage = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.contextUsage.get(activeSession.sessionKey)
      : undefined,
  );
  const claudeRateLimits = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.rateLimits.get(activeSession.sessionKey)
      : undefined,
  );
  const openCodeUsage = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.contextUsage.get(activeSession.sessionKey)
      : undefined,
  );
  const codexUsage = useCodexStore((state) =>
    activeSession?.provider === "codex"
      ? state.contextUsage.get(activeSession.sessionKey)
      : undefined,
  );
  const claudeModel = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.selectedModel.get(activeSession.sessionKey)
      : undefined,
  );
  const openCodeModel = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.selectedModel.get(activeSession.environmentId)
      : undefined,
  );
  const codexModel = useCodexStore((state) =>
    activeSession?.provider === "codex"
      ? state.selectedModel.get(activeSession.sessionKey)
      : undefined,
  );
  const claudeClient = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.clients.get(activeSession.environmentId)
      : undefined,
  );
  const openCodeClient = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.clients.get(activeSession.environmentId)
      : undefined,
  );
  const codexClient = useCodexStore((state) =>
    activeSession?.provider === "codex"
      ? state.clients.get(activeSession.environmentId)
      : undefined,
  );
  const claudeSession = useClaudeStore((state) =>
    activeSession?.provider === "claude" ? state.sessions.get(activeSession.sessionKey) : undefined,
  );
  const openCodeSession = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.sessions.get(activeSession.sessionKey)
      : undefined,
  );
  const codexSession = useCodexStore((state) =>
    activeSession?.provider === "codex" ? state.sessions.get(activeSession.sessionKey) : undefined,
  );
  const claudeInit = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.sessionInitData.get(activeSession.environmentId)
      : undefined,
  );
  const claudeAgent = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.selectedAgent.get(activeSession.sessionKey)
      : undefined,
  );
  const includeLocalSettings = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? (state.includeLocalSettings.get(activeSession.sessionKey) ?? false)
      : false,
  );
  const promptSuggestionOptIn = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? (state.promptSuggestionOptIn.get(activeSession.sessionKey) ?? false)
      : false,
  );
  const claudeTasks = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? (state.backgroundTasks.get(activeSession.sessionKey) ?? EMPTY_CLAUDE_TASKS)
      : EMPTY_CLAUDE_TASKS,
  );
  const openCodeHealth = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.runtimeHealth.get(activeSession.environmentId)
      : undefined,
  );
  /*
   * Todos and diffs belong to one session, but the environment-keyed snapshot
   * is written by whichever OpenCode session reported last. The compatibility
   * store mirrors each snapshot under the session key, so prefer that and fall
   * back to the environment entry only until the first session-scoped write.
   */
  const openCodeSessionHealth = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.runtimeHealth.get(activeSession.sessionKey)
      : undefined,
  );
  const openCodeAgent = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.selectedAgent.get(activeSession.sessionKey)
      : undefined,
  );

  const neutralContextUsage = neutralProjection?.contextUsage;
  const neutralMaximumTokens = neutralContextUsage?.maximumTokens;
  const neutralUsage: AgentInfoUsageSnapshot | undefined = neutralContextUsage
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
  const usage: AgentInfoUsageSnapshot | undefined =
    (activeSession?.provider === "claude"
      ? claudeUsage
      : activeSession?.provider === "opencode"
        ? openCodeUsage
        : activeSession?.provider === "codex"
          ? codexUsage
          : undefined) ?? neutralUsage;
  const neutralRateLimits =
    neutralProjection?.rateLimits ?? neutralProjection?.contextUsage?.rateLimits;
  const liveClaudeTasks = neutralProjection?.backgroundTasks ?? Object.values(claudeTasks);
  const modelId =
    (activeSession?.provider === "claude"
      ? claudeModel
      : activeSession?.provider === "opencode"
        ? openCodeModel
        : activeSession?.provider === "codex"
          ? codexModel
          : undefined) ?? neutralProjection?.composer?.selectedModelId;

  const currentSessionId =
    (activeSession?.provider === "claude"
      ? claudeSession?.sessionId
      : activeSession?.provider === "opencode"
        ? openCodeSession?.sessionId
        : activeSession?.provider === "codex"
          ? codexSession?.sessionId
          : undefined) ??
    neutralProjection?.sessionId ??
    activeSession?.providerSessionId;
  const currentSessionLoading =
    (activeSession?.provider === "claude"
      ? (claudeSession?.isLoading ?? false)
      : activeSession?.provider === "opencode"
        ? (openCodeSession?.isLoading ?? false)
        : activeSession?.provider === "codex"
          ? (codexSession?.isLoading ?? false)
          : false) ||
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
  currentSessionIdentityRef.current = sessionIdentity;
  const busyAction = busyState?.sessionIdentity === sessionIdentity ? busyState.name : null;
  const steerText = steerState.sessionIdentity === sessionIdentity ? steerState.value : "";
  const openCodeShared =
    neutralProjection?.shareUrl !== undefined
      ? neutralProjection.shareUrl !== null
      : shareState.sessionIdentity === sessionIdentity && shareState.value;

  // Keyed on the session, not the `activeSession` object: that is memoised on
  // activeTab, so depending on it refetches runtime health every time the user
  // switches tabs within one session. AgentInfoButton.test pins the call count.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!open || activeSession?.provider !== "codex" || !codexClient || !currentSessionId) {
      setCodexHealth(null);
      return;
    }
    let cancelled = false;
    void getCodexRuntimeHealth(codexClient, currentSessionId)
      .then((health) => {
        if (cancelled) return;
        setCodexHealth(health);
        if (activeSession) {
          const limits = codexLimitsFromHealth(health);
          const store = useCodexStore.getState();
          const current = store.contextUsage.get(activeSession.sessionKey);
          if (current && (limits.rateLimits.length > 0 || limits.credits)) {
            store.setContextUsage(activeSession.sessionKey, {
              ...current,
              ...limits,
              updatedAt: new Date().toISOString(),
            });
          }
        }
      })
      .catch(() => {
        if (!cancelled) setCodexHealth({ error: "Runtime health unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [activeSession?.provider, codexClient, currentSessionId, open]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  const openForkTab = (
    sessionId: string,
    title: string | undefined,
    closeCurrentPanel: boolean,
  ) => {
    if (!activeTab || !activeSession) return;
    const id = createUuid();
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

  const readAuthoritativeHandoffMessages = async (
    sourceSession: ActiveNativeSession,
    sourceSessionId: string,
  ): Promise<NativeMessage[]> => {
    if (sourceSession.provider === "claude" && claudeClient) {
      const status = await getClaudeSession(claudeClient, sourceSessionId);
      if (!status) throw new Error("Claude session is unavailable");
      if (status.status !== "idle") {
        throw new Error("Wait for Claude to finish before continuing in another agent");
      }
      const messages = normalizeClaudeMessagesForDisplay(
        await getClaudeSessionMessages(claudeClient, sourceSessionId, { throwOnError: true }),
      );
      const statusAfterRead = await getClaudeSession(claudeClient, sourceSessionId);
      if (!statusAfterRead) throw new Error("Claude session is unavailable");
      if (statusAfterRead.status !== "idle") {
        throw new Error("Claude started working while its conversation was being transferred");
      }
      if (statusAfterRead.lastActivity !== status.lastActivity) {
        throw new Error("Claude conversation changed while it was being transferred");
      }
      return messages;
    }
    if (sourceSession.provider === "opencode" && openCodeClient) {
      const status = await getOpenCodeSessionStatus(openCodeClient, sourceSessionId, {
        throwOnError: true,
      });
      if (!status) throw new Error("OpenCode session is unavailable");
      if (status === "busy" || status === "retry") {
        throw new Error("Wait for OpenCode to finish before continuing in another agent");
      }
      const messages = (
        await getOpenCodeSessionMessages(openCodeClient, sourceSessionId, { throwOnError: true })
      ).map(normalizeOpenCodeNativeMessage);
      const statusAfterRead = await getOpenCodeSessionStatus(openCodeClient, sourceSessionId, {
        throwOnError: true,
      });
      if (!statusAfterRead) throw new Error("OpenCode session is unavailable");
      if (statusAfterRead === "busy" || statusAfterRead === "retry") {
        throw new Error("OpenCode started working while its conversation was being transferred");
      }
      const messagesAfterRead = (
        await getOpenCodeSessionMessages(openCodeClient, sourceSessionId, { throwOnError: true })
      ).map(normalizeOpenCodeNativeMessage);
      const finalStatus = await getOpenCodeSessionStatus(openCodeClient, sourceSessionId, {
        throwOnError: true,
      });
      if (!finalStatus) throw new Error("OpenCode session is unavailable");
      if (finalStatus === "busy" || finalStatus === "retry") {
        throw new Error("OpenCode started working while its conversation was being transferred");
      }
      // OpenCode exposes no revision counter, so a second read is the only way
      // to detect a turn that started and finished inside the read window.
      // Compare digests rather than serializing both transcripts twice: these
      // can be tens of megabytes and this runs on the main thread.
      if (
        agentHandoffTranscriptDigest(messagesAfterRead) !== agentHandoffTranscriptDigest(messages)
      ) {
        throw new Error("OpenCode conversation changed while it was being transferred");
      }
      return messagesAfterRead;
    }
    if (sourceSession.provider === "codex" && codexClient) {
      const status = await getCodexSessionStatus(codexClient, sourceSessionId, {
        throwOnError: true,
      });
      if (!status) throw new Error("Codex session is unavailable");
      if (status.status !== "idle") {
        throw new Error("Wait for Codex to finish before continuing in another agent");
      }
      const messages = (
        await getCodexSessionMessages(codexClient, sourceSessionId, { throwOnError: true })
      ).map(normalizeCodexNativeMessage);
      const statusAfterRead = await getCodexSessionStatus(codexClient, sourceSessionId, {
        throwOnError: true,
      });
      if (!statusAfterRead) throw new Error("Codex session is unavailable");
      if (statusAfterRead.status !== "idle") {
        throw new Error("Codex started working while its conversation was being transferred");
      }
      if (status.messageRevision !== undefined && statusAfterRead.messageRevision !== undefined) {
        if (statusAfterRead.messageRevision !== status.messageRevision) {
          throw new Error("Codex conversation changed while it was being transferred");
        }
        return messages;
      }
      /*
       * `messageRevision` is optional: an older bridge or a malformed status
       * payload drops it. Treating that as "unchanged" would fail open and
       * transfer a torn snapshot silently, so re-read and compare instead.
       */
      const messagesAfterRead = (
        await getCodexSessionMessages(codexClient, sourceSessionId, { throwOnError: true })
      ).map(normalizeCodexNativeMessage);
      if (
        agentHandoffTranscriptDigest(messagesAfterRead) !== agentHandoffTranscriptDigest(messages)
      ) {
        throw new Error("Codex conversation changed while it was being transferred");
      }
      return messagesAfterRead;
    }
    const identity = {
      environmentId: sourceSession.environmentId,
      agent: sourceSession.provider,
      logicalSessionKey: sourceSession.sessionKey,
    } as const;
    const before = await getNativeAgentProjection(identity);
    if (!before || before.sessionId !== sourceSessionId) {
      throw new Error(`${sourceSession.providerLabel} session is unavailable`);
    }
    if (before.turn.phase !== "idle" && before.turn.phase !== "error") {
      throw new Error(
        `Wait for ${sourceSession.providerLabel} to finish before continuing in another agent`,
      );
    }
    const messages = normalizeNativeMessages(before.messages as NativeMessage[]);
    const after = await getNativeAgentProjection(identity);
    if (
      !after ||
      after.sessionId !== sourceSessionId ||
      after.turn.phase !== before.turn.phase ||
      after.generation !== before.generation ||
      after.revision !== before.revision
    ) {
      throw new Error(
        `${sourceSession.providerLabel} conversation changed while it was being transferred`,
      );
    }
    return messages;
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
      if (activeSession.provider === "claude" && claudeClient) {
        const fork = await forkClaudeSession(claudeClient, currentSessionId);
        openForkTab(fork.sessionId, fork.title, isCurrent());
      } else if (activeSession.provider === "opencode" && openCodeClient) {
        const fork = await forkOpenCodeSession(openCodeClient, currentSessionId);
        openForkTab(fork.id, fork.title, isCurrent());
      } else if (activeSession.provider === "codex" && codexClient) {
        /*
         * The bridge differentiates its refusals (404 missing, 409 running, 422
         * not a fork point, 503 unavailable) and `CodexForkError` carries that
         * body verbatim. The old single message blamed "an active or empty
         * session" for all four, including a bridge that was simply down.
         */
        let fork: Awaited<ReturnType<typeof forkCodexSession>>;
        try {
          fork = await forkCodexSession(codexClient, currentSessionId);
        } catch (error) {
          throw error instanceof CodexForkError ? error : new Error("Failed to fork Codex session");
        }
        openForkTab(fork.sessionId, fork.title, isCurrent());
      } else {
        const fork = await forkNativeAgentSession({
          environmentId: activeSession.environmentId,
          agent: activeSession.provider,
          logicalSessionKey: activeSession.sessionKey,
        });
        openForkTab(fork.sessionId, fork.title, isCurrent());
      }
    });

  const continueIn = (
    destination: AgentProvider,
    sourceSession: ActiveNativeSession,
    sourceSessionId: string,
  ) =>
    runAction(`continue-${destination}`, async ({ isCurrent }) => {
      const providerMessages = await readAuthoritativeHandoffMessages(
        sourceSession,
        sourceSessionId,
      );
      if (!isCurrent()) return;
      const priorHandoff = activeTab?.agentHandoffId
        ? await loadAgentHandoff(activeTab.agentHandoffId)
        : null;
      if (activeTab?.agentHandoffId && !priorHandoff) {
        throw new Error("The previous conversation transfer could not be loaded");
      }
      if (
        priorHandoff &&
        (priorHandoff.environmentId !== sourceSession.environmentId ||
          priorHandoff.destinationProvider !== sourceSession.provider)
      ) {
        throw new Error("The previous conversation transfer does not belong to this session");
      }
      if (!isCurrent()) return;
      const messages = composeAgentHandoffTransferMessages(priorHandoff, providerMessages);
      if (messages.length === 0) {
        throw new Error("This conversation has no history to transfer");
      }
      const handoff = createAgentHandoffSnapshot({
        id: createUuid(),
        environmentId: sourceSession.environmentId,
        sourceProvider: sourceSession.provider,
        destinationProvider: destination,
        sourceSessionId,
        // The legacy stores answer for the three providers that have one; every
        // other agent's title lives only on the projection, which is also the
        // fallback while a legacy store has not loaded its session yet.
        sourceTitle:
          (sourceSession.provider === "claude"
            ? claudeSession?.title
            : sourceSession.provider === "opencode"
              ? openCodeSession?.title
              : sourceSession.provider === "codex"
                ? codexSession?.title
                : undefined) ?? neutralProjection?.title,
        sourceModel: modelId,
        sourceAgent:
          sourceSession.provider === "claude"
            ? claudeAgent
            : sourceSession.provider === "opencode"
              ? openCodeAgent
              : undefined,
        messages,
      });
      await persistAgentHandoff(handoff);
      if (!isCurrent()) {
        // The source tab changed while persistence was in flight, so no
        // destination tab will own this sensitive snapshot. Remove it instead
        // of leaving an unreachable handoff in durable storage.
        forgetAgentHandoff(handoff.id);
        await deleteAgentHandoff(handoff.id, handoff.environmentId);
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
      const succeeded =
        activeSession.provider === "claude" && claudeClient
          ? await compactClaudeSession(claudeClient, currentSessionId)
          : activeSession.provider === "opencode" && openCodeClient
            ? (await compactOpenCodeSession(openCodeClient, currentSessionId, openCodeModel), true)
            : activeSession.provider === "codex" && codexClient
              ? await compactCodexSession(codexClient, currentSessionId)
              : (await performNativeAgentSessionAction({
                  environmentId: activeSession.environmentId,
                  agent: activeSession.provider,
                  logicalSessionKey: activeSession.sessionKey,
                  action: { kind: "compact", modelId },
                }),
                true);
      if (!succeeded) throw new Error("The provider could not compact this session");
      toast.success("Context compaction started");
    });

  const close = () => {
    restoreFocusRef.current = true;
    setOpen(false);
  };

  /*
   * One component instance serves every tab, so everything typed or latched
   * for the previous session has to go when the active tab changes. `steerText`
   * in particular is posted to `currentSessionId`: text composed for session A
   * would otherwise be delivered to session B's active turn.
   */
  useEffect(() => {
    setOpen(false);
    setHandoffOpen(false);
    shareVersionRef.current += 1;
    codexSteerRetryRef.current = null;
    setShareState({ sessionIdentity, value: false });
    setSteerState({ sessionIdentity, value: "" });
  }, [sessionIdentity]);

  /*
   * `openCodeShared` is an optimistic flag; the server's session record is the
   * truth. Re-reading it whenever the popover opens is what makes revocation
   * reachable after a tab switch or an app restart — component state alone
   * loses the fact that the conversation is published while the link stays
   * live.
   */
  useEffect(() => {
    if (!open || activeSession?.provider !== "opencode" || !openCodeClient || !currentSessionId) {
      return;
    }
    let cancelled = false;
    const shareVersion = shareVersionRef.current;
    const requestedIdentity = sessionIdentity;
    void readOpenCodeShareUrl(openCodeClient, currentSessionId)
      .then((url) => {
        if (
          !cancelled &&
          requestedIdentity !== null &&
          currentSessionIdentityRef.current === requestedIdentity &&
          shareVersionRef.current === shareVersion
        ) {
          // The provider snapshot is authoritative in both directions. A null
          // URL means a formerly shared session was revoked elsewhere.
          setShareState({ sessionIdentity: requestedIdentity, value: Boolean(url) });
        }
      })
      .catch((error: unknown) => {
        // A failed lookup must not clear the flag: that would hide "Stop
        // sharing" for a conversation that is still published.
        console.warn("[AgentInfoButton] Failed to read OpenCode share state:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSession?.provider, currentSessionId, open, openCodeClient, sessionIdentity]);

  useEffect(() => {
    if (!open && restoreFocusRef.current) {
      restoreFocusRef.current = false;
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
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [open]);

  return (
    <div
      className={cn("relative", mobile ? "h-9 w-9" : "h-8 w-8")}
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <Button
        ref={triggerRef}
        variant={open ? "secondary" : "ghost"}
        size="icon"
        className={mobile ? "h-9 w-9" : "h-8 w-8 text-muted-foreground hover:text-foreground"}
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? "Close agent information" : "Open agent information"}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="agent-information-popover"
      >
        <Info className={mobile ? "h-4.5 w-4.5" : "h-4 w-4"} />
      </Button>

      {open ? (
        <button
          type="button"
          className="fixed inset-0 z-40 cursor-default bg-transparent"
          onClick={close}
          aria-label="Close agent information"
        />
      ) : null}

      <section
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
          {activeSession ? (
            <div className="space-y-5">
              <UsagePanel
                usage={usage}
                modelId={modelId}
                rateLimits={
                  activeSession.provider === "claude"
                    ? (claudeRateLimits ?? neutralRateLimits)
                    : undefined
                }
              />

              {(activeSession.provider === "claude" && (claudeInit?.agents?.length ?? 0) > 0) ||
              (activeSession.provider === "opencode" && (openCodeHealth?.agents.length ?? 0) > 0) ||
              (neutralProjection?.composer?.executionProfiles?.length ?? 0) > 0 ? (
                <div className="space-y-2 border-t border-border/60 pt-4">
                  <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                    Execution profile
                  </div>
                  <select
                    disabled={neutralControlUpdatePending}
                    value={
                      neutralProjection?.composer?.selectedExecutionProfileId ??
                      (activeSession.provider === "claude" ? claudeAgent : openCodeAgent) ??
                      ""
                    }
                    onChange={(event) => {
                      const value = event.target.value || undefined;
                      if (neutralProjection) {
                        void updateNeutralControls({ executionProfileId: value ?? null });
                        return;
                      }
                      if (activeSession.provider === "claude") {
                        useClaudeStore.getState().setSelectedAgent(activeSession.sessionKey, value);
                      } else {
                        useOpenCodeStore
                          .getState()
                          .setSelectedAgent(activeSession.sessionKey, value);
                      }
                    }}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    aria-label="Execution profile"
                  >
                    <option value="">Provider default</option>
                    {(neutralProjection?.composer?.executionProfiles?.length
                      ? neutralProjection.composer.executionProfiles.map((profile) => ({
                          name: profile.id,
                          model: profile.modelId,
                        }))
                      : activeSession.provider === "claude"
                        ? (claudeInit?.agents ?? [])
                        : (openCodeHealth?.agents.filter(
                            (agent) => agent.mode === "primary" || agent.mode === "all",
                          ) ?? [])
                    ).map((agent) => (
                      <option key={agent.name} value={agent.name}>
                        {agent.name}
                        {("mode" in agent ? agent.modelId : agent.model)
                          ? ` · ${"mode" in agent ? agent.modelId : agent.model}`
                          : ""}
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
              {activeSession.provider === "claude" ? (
                <div className="space-y-1.5 border-t border-border/60 pt-4">
                  <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                    Session options
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      disabled={neutralControlUpdatePending}
                      checked={
                        neutralProjection?.composer?.includeLocalSettings ?? includeLocalSettings
                      }
                      onChange={(event) => {
                        if (neutralProjection) {
                          void updateNeutralControls({
                            includeLocalSettings: event.target.checked,
                          });
                        } else
                          useClaudeStore
                            .getState()
                            .setIncludeLocalSettings(
                              activeSession.sessionKey,
                              event.target.checked,
                            );
                      }}
                    />
                    Include .claude/settings.local.json
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      disabled={neutralControlUpdatePending}
                      checked={
                        neutralProjection?.composer?.promptSuggestionsEnabled ??
                        promptSuggestionOptIn
                      }
                      onChange={(event) => {
                        if (neutralProjection) {
                          void updateNeutralControls({ promptSuggestions: event.target.checked });
                        } else
                          useClaudeStore
                            .getState()
                            .setPromptSuggestionOptIn(
                              activeSession.sessionKey,
                              event.target.checked,
                            );
                      }}
                    />
                    Suggest a follow-up after each turn
                  </label>
                </div>
              ) : null}

              {canFork || canCompact || canHandoff ? (
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

                    {activeSession.provider === "claude" && currentSessionId ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyAction !== null}
                        className="justify-start gap-2"
                        onClick={() =>
                          void runAction("rewind", async () => {
                            const target =
                              claudeSession?.messages
                                .filter((message) => message.role === "user")
                                .at(-1) ??
                              neutralMessages.filter((message) => message.role === "user").at(-1);
                            if (!target?.id) throw new Error("No file checkpoint is available");
                            const preview = claudeClient
                              ? await rewindClaudeFiles(
                                  claudeClient,
                                  currentSessionId,
                                  target.id,
                                  true,
                                )
                              : (
                                  await performNativeAgentSessionAction({
                                    environmentId: activeSession.environmentId,
                                    agent: activeSession.provider,
                                    logicalSessionKey: activeSession.sessionKey,
                                    action: {
                                      kind: "rewind-files",
                                      messageId: target.id,
                                      dryRun: true,
                                    },
                                  })
                                ).preview;
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
                            if (claudeClient) {
                              await rewindClaudeFiles(claudeClient, currentSessionId, target.id);
                            } else {
                              await performNativeAgentSessionAction({
                                environmentId: activeSession.environmentId,
                                agent: activeSession.provider,
                                logicalSessionKey: activeSession.sessionKey,
                                action: { kind: "rewind-files", messageId: target.id },
                              });
                            }
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

                    {activeSession.provider === "opencode" && currentSessionId ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyAction !== null}
                          className="justify-start gap-2"
                          onClick={() =>
                            void runAction("undo", async () => {
                              const messageId =
                                openCodeSession?.messages
                                  .filter((message) => message.role === "user")
                                  .at(-1)?.id ??
                                neutralMessages.filter((message) => message.role === "user").at(-1)
                                  ?.id;
                              if (openCodeClient) {
                                await revertOpenCodeSession(
                                  openCodeClient,
                                  currentSessionId,
                                  messageId,
                                );
                              } else {
                                await performNativeAgentSessionAction({
                                  environmentId: activeSession.environmentId,
                                  agent: activeSession.provider,
                                  logicalSessionKey: activeSession.sessionKey,
                                  action: { kind: "undo", messageId },
                                });
                              }
                              toast.success("OpenCode session reverted");
                            })
                          }
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Undo turn
                        </Button>
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
                                    "Create an OpenCode share link? The conversation will leave this machine and be accessible to anyone with the link.",
                                  )
                                )
                                  return;
                                shareVersionRef.current += 1;
                                const url = openCodeClient
                                  ? await shareOpenCodeSession(openCodeClient, currentSessionId)
                                  : (
                                      await performNativeAgentSessionAction({
                                        environmentId: activeSession.environmentId,
                                        agent: activeSession.provider,
                                        logicalSessionKey: activeSession.sessionKey,
                                        action: { kind: "share" },
                                      })
                                    ).shareUrl;
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
                                    "Session shared, but OpenCode did not return the link. Use Stop sharing to revoke it.",
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
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyAction !== null}
                          className="justify-start gap-2"
                          onClick={() =>
                            void runAction("redo", async () => {
                              if (openCodeClient) {
                                await unrevertOpenCodeSession(openCodeClient, currentSessionId);
                              } else {
                                await performNativeAgentSessionAction({
                                  environmentId: activeSession.environmentId,
                                  agent: activeSession.provider,
                                  logicalSessionKey: activeSession.sessionKey,
                                  action: { kind: "redo" },
                                });
                              }
                              toast.success("OpenCode revert undone");
                            })
                          }
                        >
                          <RotateCcw className="h-3.5 w-3.5 scale-x-[-1]" />
                          Redo turn
                        </Button>
                        {openCodeShared ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyAction !== null}
                            className="justify-start gap-2"
                            onClick={() =>
                              void runAction(
                                "unshare",
                                async ({ isCurrent, sessionIdentity: actionIdentity }) => {
                                  shareVersionRef.current += 1;
                                  if (openCodeClient) {
                                    await unshareOpenCodeSession(openCodeClient, currentSessionId);
                                  } else {
                                    await performNativeAgentSessionAction({
                                      environmentId: activeSession.environmentId,
                                      agent: activeSession.provider,
                                      logicalSessionKey: activeSession.sessionKey,
                                      action: { kind: "unshare" },
                                    });
                                  }
                                  if (isCurrent()) {
                                    setShareState({
                                      sessionIdentity: actionIdentity,
                                      value: false,
                                    });
                                    toast.success("OpenCode share link disabled");
                                  }
                                },
                              )
                            }
                          >
                            <X className="h-3.5 w-3.5" />
                            Stop sharing
                          </Button>
                        ) : null}
                      </>
                    ) : null}

                    {activeSession.provider === "codex" && currentSessionId ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyAction !== null || codexSession?.isLoading}
                        className="justify-start gap-2"
                        onClick={() =>
                          void runAction("review", async () => {
                            if (codexClient) {
                              const started = await startCodexNativeReview(
                                codexClient,
                                currentSessionId,
                              );
                              if (!started) throw new Error("Codex native review could not start");
                            } else {
                              await performNativeAgentSessionAction({
                                environmentId: activeSession.environmentId,
                                agent: activeSession.provider,
                                logicalSessionKey: activeSession.sessionKey,
                                action: { kind: "review" },
                              });
                            }
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

              {activeSession.provider === "codex" && currentSessionId && currentSessionLoading ? (
                <div className="space-y-2 border-t border-border/60 pt-4">
                  <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                    Active turn
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={steerText}
                      onChange={(event) => {
                        const value = event.target.value;
                        const retry = codexSteerRetryRef.current;
                        if (
                          retry &&
                          (retry.sessionIdentity !== sessionIdentity || retry.text !== value.trim())
                        ) {
                          codexSteerRetryRef.current = null;
                        }
                        setSteerState({
                          sessionIdentity,
                          value,
                        });
                      }}
                      placeholder="Correct or redirect Codex"
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
                            const pendingRetry = codexSteerRetryRef.current;
                            const reusesAmbiguousRequest =
                              pendingRetry?.sessionIdentity === actionIdentity &&
                              pendingRetry.text === text;
                            const requestId = reusesAmbiguousRequest
                              ? pendingRetry.requestId
                              : createUuid();
                            if (!reusesAmbiguousRequest) {
                              codexSteerRetryRef.current = null;
                            }
                            const outcome = codexClient
                              ? await steerCodexSession(
                                  codexClient,
                                  currentSessionId,
                                  text,
                                  requestId,
                                )
                              : await performNativeAgentSessionAction({
                                  environmentId: activeSession.environmentId,
                                  agent: activeSession.provider,
                                  logicalSessionKey: activeSession.sessionKey,
                                  action: { kind: "steer", text, requestId },
                                }).then((result) =>
                                  result.outcome === "applied"
                                    ? { outcome: "accepted" as const }
                                    : result.outcome === "unknown"
                                      ? {
                                          outcome: "unknown" as const,
                                          requestId: result.requestId ?? requestId,
                                        }
                                      : result.outcome === "mismatch"
                                        ? { outcome: "mismatch" as const }
                                        : { outcome: "idle" as const },
                                );
                            if (outcome.outcome === "unknown" && isCurrent()) {
                              codexSteerRetryRef.current = {
                                sessionIdentity: actionIdentity,
                                text,
                                requestId: outcome.requestId,
                              };
                            } else if (
                              outcome.outcome !== "unknown" &&
                              codexSteerRetryRef.current?.requestId === requestId
                            ) {
                              codexSteerRetryRef.current = null;
                            }
                            const failure = describeCodexSteerFailure(outcome);
                            if (failure) {
                              throw new Error(failure);
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
                    Sends directly to the current Codex turn. Regular compose messages still queue.
                  </p>
                </div>
              ) : null}

              {activeSession.provider === "claude" &&
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
                              if (claudeClient) {
                                const stopped = await stopClaudeBackgroundTask(
                                  claudeClient,
                                  currentSessionId,
                                  task.id,
                                );
                                if (!stopped) throw new Error("Claude could not stop this task");
                              } else {
                                await stopNativeAgentBackgroundTask({
                                  environmentId: activeSession.environmentId,
                                  agent: activeSession.provider,
                                  logicalSessionKey: activeSession.sessionKey,
                                  taskId: task.id,
                                });
                              }
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
                {activeSession.provider === "claude" ? (
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <Metric
                      label="MCP"
                      value={String(
                        neutralProjection?.runtime?.mcpServers ??
                          claudeInit?.mcpServers.length ??
                          0,
                      )}
                    />
                    <Metric
                      label="Plugins"
                      value={String(
                        neutralProjection?.runtime?.plugins ?? claudeInit?.plugins.length ?? 0,
                      )}
                    />
                    <Metric
                      label="Commands"
                      value={String(
                        neutralProjection?.runtime?.commands ??
                          claudeInit?.slashCommands?.length ??
                          0,
                      )}
                    />
                  </div>
                ) : activeSession.provider === "opencode" ? (
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <Metric
                      label="MCP"
                      value={String(
                        neutralProjection?.runtime?.mcpServers ??
                          openCodeHealth?.mcpServers.length ??
                          0,
                      )}
                    />
                    <Metric
                      label="Skills"
                      value={String(
                        neutralProjection?.runtime?.skills ?? openCodeHealth?.skills.length ?? 0,
                      )}
                    />
                    <Metric
                      label="LSP"
                      value={String(
                        neutralProjection?.runtime?.lspServers ??
                          openCodeHealth?.lspServers.length ??
                          0,
                      )}
                    />
                    <Metric
                      label="Todos"
                      value={String(
                        neutralProjection?.runtime?.todos ??
                          (openCodeSessionHealth ?? openCodeHealth)?.todos?.length ??
                          0,
                      )}
                    />
                    <Metric
                      label="Files"
                      value={String(
                        neutralProjection?.runtime?.files ??
                          (openCodeSessionHealth ?? openCodeHealth)?.diffs?.length ??
                          0,
                      )}
                    />
                  </div>
                ) : activeSession.provider === "codex" ? (
                  <CodexRuntimePanel health={codexHealth} runtime={neutralProjection?.runtime} />
                ) : (
                  <AgentRuntimePanel
                    runtime={neutralProjection?.runtime}
                    providerLabel={activeSession.providerLabel}
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
