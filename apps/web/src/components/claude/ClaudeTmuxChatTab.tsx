// Claude tmux mode chat tab.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  History,
  Sparkles,
  Terminal as TerminalIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useVirtuosoScrollState } from "@/hooks";
import { Button } from "@/components/ui/button";
import { NativeComposeDock } from "@/components/chat/NativeComposeDock";
import { AgentThinkingIndicator } from "@/components/chat/AgentThinkingIndicator";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { getNativeMessageSearchText } from "@/components/chat/native-message-search";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { ClaudeQuestionCard } from "@/components/claude/ClaudeQuestionCard";
import { ClaudeTmuxInteractiveTerminal } from "@/components/claude/ClaudeTmuxInteractiveTerminal";
import { ResumeTmuxSessionDialog } from "@/components/claude/ResumeTmuxSessionDialog";
import { formatElapsed } from "@/lib/format-elapsed";
import { createUuid } from "@/lib/uuid";
import { isDefaultTimestampEnvironmentName } from "@/lib/environment-name";
import {
  answerSelectionPrompt,
  answerPreToolUse,
  getPendingHooks,
  getStatus,
  getTranscript,
  interruptSession,
  replyHook,
  startSession,
  submit as submitToTmux,
  switchEffort,
  switchFastMode,
  switchModel,
  switchPlanMode,
  subscribe,
  type TmuxPendingHook,
  type TmuxEvent,
} from "@/lib/claude-tmux-client";
import { buildTmuxPromptWithAttachments } from "@orkestrator/protocol/tmux-prompt";
import {
  tmuxSelectionPromptFingerprint,
  type TmuxAgentObservation,
  type TmuxSelectionPrompt,
} from "@orkestrator/protocol/tmux-observation";
import {
  payloadToApproval,
  payloadToElicitation,
  payloadToPermission,
  payloadToPlan,
  payloadToQuestion,
  compactConsecutiveAssistantMessages,
  createClaudeTmuxStateKey,
  migrateLegacyClaudeTmuxState,
  useClaudeTmuxStore,
  type TmuxPendingElicitation,
  type TmuxPendingPermission,
  type TmuxPendingPlan,
  type TmuxPendingQuestion,
  type TmuxAttachment,
  type TmuxQueuedMessage,
} from "@/stores/claudeTmuxStore";
import { findPreviousNativeMessage, normalizeClaudeMessagesForDisplay } from "@/lib/chat/native-message-adapters";
import { resolveCatalogModelLabel } from "@/lib/chat/model-label";
import { pinActiveNativeAgentParts } from "@/lib/chat/native-agent-pinning";
import { applyTmuxAgentUsageSummaries } from "@/lib/claude-tmux-usage";
import type { ClaudeEffortLevel } from "@/lib/claude-client";
import { useClaudeStore } from "@/stores/claudeStore";
import { tmuxQuestionDraftKey } from "@/stores/promptDraftStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useConfigStore } from "@/stores/configStore";
import { enqueueAgentPrompt, removeAgentPrompt } from "@/lib/prompt-queue-sources";
import {
  getClaudeModelCatalog,
  renameEnvironmentFromPrompt,
  updateGlobalConfig,
} from "@/lib/backend";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import type { ClaudeTmuxData } from "@/types/paneLayout";

interface Props {
  tabId: string;
  data: ClaudeTmuxData;
  isActive: boolean;
  /** Whether this pane currently owns document-level shortcuts. */
  ownsGlobalShortcuts?: boolean;
  initialPrompt?: string;
  isReviewTab?: boolean;
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  refreshRequestId?: number;
}

import {
  ApprovalCard,
  DEFAULT_EFFORT,
  EFFORT_LABELS,
  StartScreen,
  TmuxComposeBar,
  TmuxElicitationCard,
  TmuxPermissionCard,
  TmuxPlanCard,
  autoAllowPermissionHook,
  claudeCatalogRequestGenerations,
  elicitationResponse,
  fallbackEffort,
  getTmuxModel,
  hookTiming,
  hookToolName,
  isQuestionPermissionPayload,
  pendingSnapshotFromHooks,
  permissionRequestResponse,
  preToolAllow,
  preToolDeny,
  questionAnswersToRecord,
  resolveTmuxModelPreference,
  selectionPromptInitialAnswer,
  selectionPromptKey,
  selectionPromptOptionValue,
  selectionPromptToQuestion,
  shouldAutoAllowPermissionHook,
  supportedEffortLevels,
  tmuxModelIsAvailable,
  tmuxModelList,
} from "./ClaudeTmuxChatTab.parts";

export function ClaudeTmuxChatTab({
  tabId,
  data,
  isActive,
  ownsGlobalShortcuts = isActive,
  initialPrompt,
  isReviewTab = false,
  initialAgentModel,
  initialReasoningEffort,
  refreshRequestId = 0,
}: Props) {
  const { environmentId, containerId } = data;
  const stateKey = useMemo(
    () => createClaudeTmuxStateKey(environmentId, tabId),
    [environmentId, tabId],
  );
  const worktreePath = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId)?.worktreePath,
  );

  const scopedTabState = useClaudeTmuxStore((s) => s.tabs.get(stateKey));
  const legacyTabState = useClaudeTmuxStore((s) => s.tabs.get(tabId));
  const shouldUseLegacyTabState =
    !scopedTabState &&
    legacyTabState &&
    (!legacyTabState.environmentId || legacyTabState.environmentId === environmentId);
  const tabState = scopedTabState ?? (shouldUseLegacyTabState ? legacyTabState : undefined);
  const storeKey = stateKey;
  const setRunning = useClaudeTmuxStore((s) => s.setRunning);
  const applyTranscriptLine = useClaudeTmuxStore((s) => s.applyTranscriptLine);
  const replaceTranscript = useClaudeTmuxStore((s) => s.replaceTranscript);
  const addPendingApproval = useClaudeTmuxStore((s) => s.addPendingApproval);
  const removePendingApproval = useClaudeTmuxStore((s) => s.removePendingApproval);
  const addPendingQuestion = useClaudeTmuxStore((s) => s.addPendingQuestion);
  const removePendingQuestion = useClaudeTmuxStore((s) => s.removePendingQuestion);
  const addPendingPlan = useClaudeTmuxStore((s) => s.addPendingPlan);
  const removePendingPlan = useClaudeTmuxStore((s) => s.removePendingPlan);
  const addPendingPermission = useClaudeTmuxStore((s) => s.addPendingPermission);
  const removePendingPermission = useClaudeTmuxStore((s) => s.removePendingPermission);
  const addPendingElicitation = useClaudeTmuxStore((s) => s.addPendingElicitation);
  const removePendingElicitation = useClaudeTmuxStore((s) => s.removePendingElicitation);
  const replacePendingHooks = useClaudeTmuxStore((s) => s.replacePendingHooks);
  const pushInfoEvent = useClaudeTmuxStore((s) => s.pushInfoEvent);
  const setTabBusy = useClaudeTmuxStore((s) => s.setBusy);
  const setObservation = useClaudeTmuxStore((s) => s.setObservation);
  const clearSelectionPrompt = useClaudeTmuxStore((s) => s.clearSelectionPrompt);
  const clearTabInitialPrompt = usePaneLayoutStore((s) => s.clearTabInitialPrompt);
  const clearTabInitialAgentOptions = usePaneLayoutStore((s) => s.clearTabInitialAgentOptions);
  const setConfig = useConfigStore((s) => s.setConfig);
  const persistedClaudeModel = useConfigStore((s) => s.config.global.claudeModel);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interactiveMode, setInteractiveMode] = useState(false);
  const sdkModels = useClaudeStore(
    (s) => s.modelCatalogs.get(environmentId)?.models ?? s.models,
  );
  const setModels = useClaudeStore((s) => s.setModels);
  const setModelCatalog = useClaudeStore((s) => s.setModelCatalog);
  const availableModels = useMemo(() => tmuxModelList(sdkModels), [sdkModels]);
  const resolveModelLabel = useCallback(
    (modelId: string) => resolveCatalogModelLabel(modelId, availableModels),
    [availableModels],
  );
  const initialLaunchOptionsRef = useRef({
    model: initialAgentModel,
    reasoningEffort: initialReasoningEffort,
  });
  const initialLaunchModel = initialLaunchOptionsRef.current.model;
  const initialLaunchReasoningEffort = initialLaunchOptionsRef.current.reasoningEffort;
  const initialLaunchModelPendingRef = useRef(Boolean(initialLaunchModel));
  const initialLaunchOptionsPendingRef = useRef(
    Boolean(initialLaunchModel || initialLaunchReasoningEffort),
  );
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    resolveTmuxModelPreference(
      initialLaunchModel ?? useConfigStore.getState().config.global.claudeModel,
      tmuxModelList(useClaudeStore.getState().getModels(environmentId)),
    ),
  );
  const [modelSwitching, setModelSwitching] = useState(false);
  const [effortSwitching, setEffortSwitching] = useState(false);
  const [fastModeSwitching, setFastModeSwitching] = useState(false);
  const [fastModeEnabled, setFastModeEnabled] = useState<boolean | null>(false);
  const [modeSwitching, setModeSwitching] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const promptControlBusyRef = useRef(false);
  const [backendHydrated, setBackendHydrated] = useState(false);
  const startedRef = useRef(false);
  const autoStartAttemptedRef = useRef(false);
  const permissionModeEventVersionRef = useRef(0);
  const fastModeMutationVersionRef = useRef(0);
  const submitPromptRef = useRef<
    ((
      text: string,
      attachments: TmuxAttachment[],
      clearDraftOnSuccess: boolean,
    ) => Promise<boolean>) | null
  >(null);

  // Auto-start unless the user is presented with a choice (no initial prompt
  // and there are prior sessions to resume — they should pick first).
  const hasInitialPrompt = Boolean(initialPrompt?.trim());
  const messages = tabState?.messages ?? [];
  const pendingApprovals = tabState?.pendingApprovals ?? [];
  const pendingQuestions = tabState?.pendingQuestions ?? [];
  const pendingPlans = tabState?.pendingPlans ?? [];
  const pendingPermissions = tabState?.pendingPermissions ?? [];
  const pendingElicitations = tabState?.pendingElicitations ?? [];
  const running = tabState?.running ?? false;
  const isThinking = tabState?.busy ?? false;
  const busyStartedAt = tabState?.busyStartedAt ?? null;
  const selectionPrompt = tabState?.observation.prompt ?? null;
  const resumedSession = tabState?.resumed ?? false;
  const hasStarted = startedRef.current || running;
  const showStartScreen = !hasStarted && (!hasInitialPrompt || autoStartAttemptedRef.current);
  const hasPendingHookCards =
    pendingApprovals.length +
      pendingQuestions.length +
      pendingPlans.length +
      pendingPermissions.length +
      pendingElicitations.length >
    0;
  const visibleSelectionPrompt = hasPendingHookCards ? null : selectionPrompt;
  const agentUsageSummaries = tabState?.observation.usage ?? [];
  const transcriptMessages = useMemo(
    () =>
      applyTmuxAgentUsageSummaries(
        compactConsecutiveAssistantMessages(messages),
        agentUsageSummaries,
      ),
    [messages, agentUsageSummaries],
  );
  const displayMessages = useMemo(
    () => pinActiveNativeAgentParts(normalizeClaudeMessagesForDisplay(transcriptMessages)),
    [transcriptMessages],
  );
  const hasMessageHistory = displayMessages.length > 0;
  const centerCompose =
    showStartScreen &&
    !hasPendingHookCards &&
    !hasMessageHistory &&
    !running &&
    !isThinking;
  const showAddressAll = Boolean(
    isReviewTab &&
      running &&
      !isThinking &&
      messages.length > 0,
  );
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);
  const { isAtBottom, scrollToBottom, virtuosoRef, scrollProps } = useVirtuosoScrollState({
    isActive: isActive && !interactiveMode,
    persistKey: `claude-tmux-${stateKey}`,
    environmentId,
    stickToBottomOnActivation: true,
  });
  const queueLength = useClaudeTmuxStore(
    useCallback(
      (state) => state.messageQueue.get(storeKey)?.length ?? 0,
      [storeKey],
    ),
  );

  const setEffortLevel = useClaudeTmuxStore((s) => s.setEffortLevel);
  const selectedEffort = useClaudeTmuxStore(
    useCallback(
      (state) => state.effortLevels.get(storeKey) ?? DEFAULT_EFFORT,
      [storeKey],
    ),
  );
  const selectedModelObj = useMemo(
    () => getTmuxModel(selectedModel, availableModels),
    [selectedModel, availableModels],
  );
  const effortOptions = useMemo(
    () => supportedEffortLevels(selectedModelObj),
    [selectedModelObj],
  );
  // Claude Code silently downgrades unsupported levels, so mirror that in the
  // UI when e.g. an "xhigh" preference meets a model without xhigh support.
  const effectiveEffort =
    effortOptions.length > 0 && !effortOptions.includes(selectedEffort)
      ? fallbackEffort(effortOptions)
      : selectedEffort;
  const settingsSwitching =
    modelSwitching || effortSwitching || fastModeSwitching || modeSwitching;
  const applyFastMode = useCallback((enabled: boolean | null) => {
    fastModeMutationVersionRef.current += 1;
    setFastModeEnabled(enabled);
  }, []);

  useLayoutEffect(() => {
    migrateLegacyClaudeTmuxState(tabId, stateKey, environmentId);
  }, [environmentId, stateKey, tabId]);

  useEffect(() => {
    if (!initialLaunchReasoningEffort) return;
    const supported: ClaudeEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
    if (supported.includes(initialLaunchReasoningEffort as ClaudeEffortLevel)) {
      setEffortLevel(storeKey, initialLaunchReasoningEffort as ClaudeEffortLevel);
    }
  }, [initialLaunchReasoningEffort, setEffortLevel, storeKey]);

  const acknowledgeInitialLaunchOptions = useCallback(() => {
    if (!initialLaunchOptionsPendingRef.current) return;
    initialLaunchOptionsPendingRef.current = false;
    clearTabInitialAgentOptions(tabId, environmentId);
  }, [clearTabInitialAgentOptions, environmentId, tabId]);

  useEffect(() => {
    if (hasStarted) {
      acknowledgeInitialLaunchOptions();
      return;
    }
    const preferredModel = initialLaunchModelPendingRef.current
      ? initialLaunchModel
      : persistedClaudeModel;
    setSelectedModel(
      resolveTmuxModelPreference(preferredModel, availableModels),
    );
    // `availableModels` can never be empty — `tmuxModelList` substitutes the
    // bundled fallback list — so its length cannot signal "the live catalog has
    // not arrived yet". A one-shot model that exists only in the SDK catalog
    // would resolve to DEFAULT_MODEL against the fallback list, and consuming it
    // there is unrecoverable: the next run (with the real catalog) prefers
    // `persistedClaudeModel` and silently overwrites the user's choice. So hold
    // the pending flag until either the model is honourable or the live catalog
    // has actually landed.
    if (
      initialLaunchModelPendingRef.current
      && initialLaunchModel
      && sdkModels.length === 0
      && !tmuxModelIsAvailable(initialLaunchModel, availableModels)
    ) {
      return;
    }
    initialLaunchModelPendingRef.current = false;
    acknowledgeInitialLaunchOptions();
  }, [
    acknowledgeInitialLaunchOptions,
    availableModels,
    hasStarted,
    initialLaunchModel,
    persistedClaudeModel,
    sdkModels,
  ]);

  const persistSelectedModel = useCallback(
    async (modelId: string) => {
      const currentConfig = useConfigStore.getState().config;
      if (currentConfig.global.claudeModel === modelId) return;

      const nextGlobal = {
        ...currentConfig.global,
        claudeModel: modelId,
      };
      setConfig({ ...currentConfig, global: nextGlobal });

      try {
        const updatedConfig = await updateGlobalConfig(nextGlobal);
        if (useConfigStore.getState().config.global.claudeModel === modelId) {
          setConfig(updatedConfig);
        }
      } catch (e) {
        console.error("[ClaudeTmuxChatTab] Failed to persist Claude model default:", e);
        if (useConfigStore.getState().config.global.claudeModel === modelId) {
          setConfig(currentConfig);
          setError("Failed to save Claude model default");
        }
      }
    },
    [setConfig],
  );

  // 0. Reconnect to any already-running backend session and replay the full
  // transcript. backend events are only delivered to mounted listeners, so a
  // tmux tab hidden behind another environment can miss transcript updates.
  useEffect(() => {
    let cancelled = false;
    setBackendHydrated(false);

    const hydrate = async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const permissionModeVersion = permissionModeEventVersionRef.current;
          const fastModeMutationVersion = fastModeMutationVersionRef.current;
          const tabStateBeforeAttempt =
            useClaudeTmuxStore.getState().tabs.get(storeKey);
          const status = await getStatus(tabId, environmentId);
          if (cancelled) return;

          let lines: Awaited<ReturnType<typeof getTranscript>> = [];
          let hooks: TmuxPendingHook[] = [];
          if (
            status &&
            status.environment_id === environmentId &&
            status.session_id
          ) {
            [lines, hooks] = await Promise.all([
              getTranscript(tabId, environmentId),
              getPendingHooks(tabId, environmentId),
            ]);
            if (cancelled) return;
          }

          const liveStateChanged =
            useClaudeTmuxStore.getState().tabs.get(storeKey) !==
              tabStateBeforeAttempt ||
            permissionModeEventVersionRef.current !== permissionModeVersion ||
            fastModeMutationVersionRef.current !== fastModeMutationVersion;
          if (liveStateChanged) {
            if (refreshRequestId > 0) {
              throw new Error("Claude tmux session changed while refreshing; try again");
            }
            if (attempt < 2) continue;
            throw new Error("Claude tmux session changed while refreshing; try again");
          }

          if (status && status.environment_id === environmentId) {
            startedRef.current = Boolean(status.running);
            if (status.running) autoStartAttemptedRef.current = true;
            setRunning(storeKey, status.running, {
              environmentId: status.environment_id,
              sessionId: status.session_id,
              resumed: status.resumed,
              busy: status.busy,
              busyStartedAt: status.busy_started_at,
              observation: status.observation,
            });
            setPlanMode(status.permission_mode === "plan");
            setFastModeEnabled(status.fast_mode);

            if (status.session_id) {
              replaceTranscript(storeKey, lines);
              for (const line of lines) {
                if (
                  line.type === "permission-mode" &&
                  typeof line.permissionMode === "string"
                ) {
                  setPlanMode(line.permissionMode === "plan");
                }
              }
              const hooksToRender = hooks.filter(
                (hook) => !shouldAutoAllowPermissionHook(hook),
              );
              replacePendingHooks(
                storeKey,
                pendingSnapshotFromHooks(hooksToRender, status.info_events),
              );
              for (const hook of hooks) {
                if (shouldAutoAllowPermissionHook(hook)) {
                  void autoAllowPermissionHook(tabId, environmentId, hook.id, hook.payload).catch((e) => {
                    if (!cancelled) {
                      addPendingPermission(
                        storeKey,
                        payloadToPermission(hook.id, hook.payload, hookTiming(hook)),
                      );
                      setError(String(e));
                    }
                  });
                }
              }
            } else {
              replaceTranscript(storeKey, []);
              replacePendingHooks(storeKey, pendingSnapshotFromHooks([]));
            }
          } else if (refreshRequestId > 0) {
            startedRef.current = false;
            setRunning(storeKey, false, {
              environmentId,
              sessionId: null,
              resumed: false,
            });
            setTabBusy(storeKey, false);
            replaceTranscript(storeKey, []);
            replacePendingHooks(storeKey, pendingSnapshotFromHooks([]));
          }

          if (refreshRequestId > 0) setError(null);
          return;
        }
      } catch (e) {
        // A missing backend session is not fatal; the auto-start path below
        // still handles new tabs with an initial prompt.
        console.debug("[ClaudeTmuxChatTab] tmux hydrate failed", e);
        if (refreshRequestId > 0) {
          const message = e instanceof Error ? e.message : String(e);
          setError(`Failed to refresh Claude tmux tab: ${message}`);
        }
      } finally {
        if (!cancelled) setBackendHydrated(true);
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [
    tabId,
    environmentId,
    storeKey,
    setRunning,
    setTabBusy,
    setObservation,
    addPendingPermission,
    refreshRequestId,
    replaceTranscript,
    replacePendingHooks,
  ]);

  // Rehydrate the authoritative backend-owned catalog even when no Claude
  // native tab has ever mounted for this environment.
  useEffect(() => {
    if (!backendHydrated) return;
    const requestGeneration =
      (claudeCatalogRequestGenerations.get(environmentId) ?? 0) + 1;
    claudeCatalogRequestGenerations.set(environmentId, requestGeneration);

    void getClaudeModelCatalog(environmentId, refreshRequestId > 0)
      .then((catalog) => {
        if (
          claudeCatalogRequestGenerations.get(environmentId)
          !== requestGeneration
        ) {
          return;
        }
        setModelCatalog(catalog);
        // New-environment controls are host-scoped and cannot read an
        // environment-specific catalogue. A fallback response is useful for
        // this environment only and must not replace the host last-known-good.
        if (catalog.source !== "fallback") {
          setModels(catalog.models);
        }
      })
      .catch((catalogError) => {
        if (
          claudeCatalogRequestGenerations.get(environmentId)
          === requestGeneration
        ) {
          console.debug(
            "[ClaudeTmuxChatTab] Claude model catalog unavailable; using bundled fallback",
            catalogError,
          );
        }
      });
  }, [
    backendHydrated,
    environmentId,
    refreshRequestId,
    setModelCatalog,
    setModels,
  ]);

  // 1. Subscribe to backend events (one listener for the whole tab).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    subscribe((ev: TmuxEvent) => {
      // Every event the tmux backend emits is tab-scoped — ignore events for
      // other tabs even when they happen to live in the same workspace.
      if (ev.tab_id !== tabId || ev.environment_id !== environmentId) return;

      switch (ev.kind) {
        case "started":
          startedRef.current = true;
          autoStartAttemptedRef.current = true;
          setRunning(storeKey, true, {
            environmentId: ev.environment_id,
            sessionId: ev.session_id,
            observationGeneration: ev.observation_generation,
            resumed: ev.resumed,
          });
          applyFastMode(ev.fast_mode);
          return;
        case "initial-prompt-sent":
          if (ev.environment_id === environmentId) {
            // Initial prompts are submitted by the backend, so they do not go
            // through the compose submit path that flips busy optimistically.
            setTabBusy(storeKey, true);
            clearTabInitialPrompt(tabId, environmentId);
          }
          return;
        case "permission-mode-changed":
          permissionModeEventVersionRef.current += 1;
          setPlanMode(ev.permission_mode === "plan");
          return;
        case "fast-mode-changed":
          applyFastMode(ev.fast_mode);
          return;
        case "observation":
          setObservation(storeKey, ev.observation);
          return;
        case "stopped":
          startedRef.current = false;
          permissionModeEventVersionRef.current += 1;
          setRunning(storeKey, false, { sessionId: null });
          setPlanMode(false);
          // No claude process means no in-flight turn.
          setTabBusy(storeKey, false);
          return;
        case "transcript-line":
          if (ev.line.type === "permission-mode" && typeof ev.line.permissionMode === "string") {
            permissionModeEventVersionRef.current += 1;
            setPlanMode(ev.line.permissionMode === "plan");
          }
          applyTranscriptLine(storeKey, ev.line);
          break;
        case "hook": {
          const timing = {
            requestedAt: ev.requested_at,
            expiresAt: ev.expires_at,
          };
          // Drive the "Claude is thinking…" indicator from the same hook
          // events Claude Code emits for the agent lifecycle. We rely on
          // UserPromptSubmit/Stop here rather than transcript content so
          // tool-call turns (no final text) still clear the spinner.
          if (ev.event_kind === "UserPromptSubmit") {
            setTabBusy(storeKey, true);
          } else if (ev.event_kind === "Stop") {
            setTabBusy(storeKey, false);
          }
          if (ev.event_kind === "PreToolUse") {
            const toolName = hookToolName(ev.payload);
            if (toolName === "AskUserQuestion") {
              addPendingQuestion(storeKey, payloadToQuestion(ev.event_id, ev.payload, timing));
            } else if (toolName === "ExitPlanMode") {
              addPendingPlan(storeKey, payloadToPlan(ev.event_id, ev.payload, timing));
            } else {
              addPendingApproval(storeKey, payloadToApproval(ev.event_id, ev.payload, timing));
            }
          } else if (ev.event_kind === "PermissionRequest") {
            if (isQuestionPermissionPayload(ev.payload)) {
              void autoAllowPermissionHook(tabId, environmentId, ev.event_id, ev.payload).catch((e) => {
                addPendingPermission(
                  storeKey,
                  payloadToPermission(ev.event_id, ev.payload, timing),
                );
                setError(String(e));
              });
              removePendingPermission(storeKey, ev.event_id);
            } else {
              addPendingPermission(storeKey, payloadToPermission(ev.event_id, ev.payload, timing));
            }
          } else if (ev.event_kind === "Elicitation") {
            addPendingElicitation(storeKey, payloadToElicitation(ev.event_id, ev.payload, timing));
          } else if (ev.event_kind === "Notification" || ev.event_kind === "Stop") {
            const payload = ev.payload && typeof ev.payload === "object"
              ? ev.payload as Record<string, unknown>
              : undefined;
            pushInfoEvent(storeKey, {
              id: ev.event_id,
              kind: ev.event_kind,
              message: typeof payload?.message === "string"
                ? payload.message
                : ev.event_kind === "Stop"
                  ? "Claude finished responding"
                  : "Claude sent a notification",
              receivedAt: new Date(ev.requested_at ?? Date.now()).toISOString(),
            });
          }
          break;
        }
        case "hook-timed-out":
          if (ev.event_kind === "PreToolUse") {
            removePendingApproval(storeKey, ev.event_id);
            removePendingQuestion(storeKey, ev.event_id);
            removePendingPlan(storeKey, ev.event_id);
          } else if (ev.event_kind === "PermissionRequest") {
            removePendingPermission(storeKey, ev.event_id);
          } else if (ev.event_kind === "Elicitation") {
            removePendingElicitation(storeKey, ev.event_id);
          }
          break;
        case "warning":
          setError(ev.message);
          break;
      }
    })
      .then((u) => {
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [
    tabId,
    storeKey,
    setRunning,
    applyTranscriptLine,
    addPendingApproval,
    removePendingApproval,
    addPendingQuestion,
    removePendingQuestion,
    addPendingPlan,
    removePendingPlan,
    addPendingPermission,
    removePendingPermission,
    addPendingElicitation,
    removePendingElicitation,
    pushInfoEvent,
    setTabBusy,
    setObservation,
    clearTabInitialPrompt,
    environmentId,
    applyFastMode,
  ]);

  // Common "start the tmux session" path used by both auto-start (initial
  // prompt present) and the explicit "Start fresh" / "Resume" buttons.
  const launchSession = useCallback(
    (resumeSessionId?: string, replaceExisting = false) => {
      if (startedRef.current) return;
      startedRef.current = true;
      startSession(tabId, environmentId, {
        initialPrompt,
        model: selectedModel,
        effort: effortOptions.length > 0 ? effectiveEffort : undefined,
        fastMode:
          selectedModelObj.supportsFastMode === true && fastModeEnabled === true,
        resumeSessionId,
        replaceExisting,
      })
        .catch((e) => {
          // Re-arm so the user can retry from the start screen.
          startedRef.current = false;
          setError(String(e));
        });
    },
    [
      tabId,
      environmentId,
      initialPrompt,
      selectedModel,
      effortOptions,
      effectiveEffort,
      selectedModelObj.supportsFastMode,
      fastModeEnabled,
    ],
  );

  // 2. Auto-start when the tab was created with an initial prompt. Otherwise
  //    we wait for the user to click Start or Resume so they get a chance to
  //    pick a previous session before any new claude process is spawned.
  useEffect(() => {
    if (!backendHydrated) return;
    if (!hasInitialPrompt) return;
    if (autoStartAttemptedRef.current) return;
    if (startedRef.current) return;
    if (running) return;
    autoStartAttemptedRef.current = true;
    launchSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendHydrated, hasInitialPrompt, tabId, running]);

  const submitPrompt = async (
    text: string,
    attachments: TmuxAttachment[],
    clearDraftOnSuccess: boolean,
  ): Promise<boolean> => {
    // `isThinking` covers the post-HTTP window where Claude is still
    // processing but `sending` has already reset; without it a user could
    // submit a second message before the first turn finishes.
    if (
      (!text && attachments.length === 0) ||
      sending ||
      isThinking ||
      settingsSwitching
    ) {
      return false;
    }
    setSending(true);
    setError(null);
    // Optimistically flip the "Claude is thinking…" indicator on submit so
    // the user gets instant feedback; the UserPromptSubmit hook will confirm
    // it shortly after, and the Stop hook (handled in the subscription
    // above) clears it when the turn ends.
    setTabBusy(storeKey, true);
    try {
      if (text && !resumedSession && messages.length === 0) {
        const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
        if (environment && isDefaultTimestampEnvironmentName(environment.name)) {
          try {
            await renameEnvironmentFromPrompt(environmentId, text);
          } catch (e) {
            console.warn("[ClaudeTmuxChatTab] Failed to rename environment from prompt:", e);
          }
        }
      }
      const prompt = buildTmuxPromptWithAttachments(text, attachments, containerId);
      await submitToTmux(tabId, prompt, environmentId);
      if (clearDraftOnSuccess) {
        useClaudeTmuxStore.getState().setDraftText(storeKey, "");
      }
      return true;
    } catch (e) {
      setError(String(e));
      // The submit failed before claude saw it — there's no Stop coming.
      setTabBusy(storeKey, false);
      return false;
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = async (
    text: string,
    attachments: TmuxAttachment[] = [],
  ) => {
    return submitPrompt(text, attachments, true);
  };

  submitPromptRef.current = submitPrompt;

  const handleQueue = useCallback(
    async (text: string, attachments: TmuxAttachment[]) => {
      setError(null);
      try {
        await enqueueAgentPrompt<TmuxQueuedMessage>("claude-tmux", storeKey, {
          id: createUuid(),
          text,
          attachments,
        });
      } catch (error) {
        setError(
          `Failed to queue prompt: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
        throw error;
      }
    },
    [storeKey],
  );

  /**
   * Queued prompts are drained by the backend.
   *
   * The dispatcher used to live here, behind a `mountedRef`: nothing sent the
   * next queued prompt unless this component was mounted, connected and
   * re-rendering, so a reload or a switch to another environment stranded the
   * queue and could abandon an outstanding claim until its lease expired.
   * `PromptQueueDrainer` now owns claim → submit → acknowledge server-side, and
   * this tab renders the queue and its `dispatchError` from the snapshot.
   */
  const promoteNextQueuedPromptToDraft = useCallback(async () => {
    const store = useClaudeTmuxStore.getState();
    const hasCurrentDraft =
      store.getDraftText(storeKey).trim().length > 0 ||
      store.getAttachments(storeKey).length > 0;
    if (hasCurrentDraft) return;

    const head = store.getQueuedMessages(storeKey)[0];
    if (!head) return;
    const nextMessage = await removeAgentPrompt<TmuxQueuedMessage>(
      "claude-tmux",
      storeKey,
      head.id,
    );
    if (!nextMessage) return;

    store.setDraftText(storeKey, nextMessage.text);
    store.setDraftMentions(storeKey, []);
    store.clearAttachments(storeKey);
    for (const attachment of nextMessage.attachments) {
      store.addAttachment(storeKey, attachment);
    }
  }, [storeKey]);

  const handleAddressAll = async () => {
    await submitPrompt(ADDRESS_ALL_REVIEW_PROMPT, [], false);
  };

  const handleInterrupt = async () => {
    if (!running || settingsSwitching) return;
    setError(null);
    try {
      await interruptSession(tabId, environmentId);
      await promoteNextQueuedPromptToDraft().catch((error) => {
        console.error("[ClaudeTmuxChatTab] Failed to promote queued prompt:", error);
      });
      setTabBusy(storeKey, false);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleApproval = async (
    eventId: string,
    decision: "approve" | "block",
  ) => {
    try {
      await answerPreToolUse(tabId, eventId, decision, undefined, environmentId);
      removePendingApproval(storeKey, eventId);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleQuestionAnswer = async (
    question: TmuxPendingQuestion,
    answers: string[][],
  ): Promise<boolean> => {
    try {
      await replyHook(
        tabId,
        "PreToolUse",
        question.eventId,
        preToolAllow({
          ...question.toolInput,
          questions: question.questions,
          answers: questionAnswersToRecord(question.questions, answers),
        }),
        environmentId,
      );
      removePendingQuestion(storeKey, question.eventId);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  };

  const handleQuestionReject = async (question: TmuxPendingQuestion) => {
    try {
      await replyHook(
        tabId,
        "PreToolUse",
        question.eventId,
        preToolDeny("User declined to answer the question."),
        environmentId,
      );
      removePendingQuestion(storeKey, question.eventId);
    } catch (e) {
      setError(String(e));
    }
  };

  const handlePlanResponse = async (
    plan: TmuxPendingPlan,
    approved: boolean,
    feedback?: string,
  ) => {
    try {
      await replyHook(
        tabId,
        "PreToolUse",
        plan.eventId,
        approved
          ? preToolAllow({ ...plan.toolInput })
          : preToolDeny(feedback?.trim() || "User requested changes to the plan."),
        environmentId,
      );
      removePendingPlan(storeKey, plan.eventId);
    } catch (e) {
      setError(String(e));
    }
  };

  const handlePermissionResponse = async (
    permission: TmuxPendingPermission,
    allow: boolean,
    updatedPermissions?: unknown[],
  ) => {
    try {
      await replyHook(
        tabId,
        "PermissionRequest",
        permission.eventId,
        permissionRequestResponse(permission, allow, updatedPermissions),
        environmentId,
      );
      removePendingPermission(storeKey, permission.eventId);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleElicitationResponse = async (
    elicitation: TmuxPendingElicitation,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, string>,
  ) => {
    try {
      await replyHook(
        tabId,
        "Elicitation",
        elicitation.eventId,
        elicitationResponse(action, content),
        environmentId,
      );
      removePendingElicitation(storeKey, elicitation.eventId);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleSelectPromptOption = async (
    observation: TmuxAgentObservation,
    prompt: TmuxSelectionPrompt,
    optionIndex: number,
  ): Promise<boolean> => {
    if (!prompt.options[optionIndex] || promptControlBusyRef.current) return false;
    if (!observation.generation) {
      setError("Selection prompt has no backend generation");
      return false;
    }
    promptControlBusyRef.current = true;
    setError(null);
    try {
      await answerSelectionPrompt(tabId, environmentId, {
        expectedGeneration: observation.generation,
        expectedRevision: observation.revision,
        expectedPromptFingerprint: tmuxSelectionPromptFingerprint(prompt),
        optionIndex,
      });
      clearSelectionPrompt(storeKey, prompt);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      promptControlBusyRef.current = false;
    }
  };

  const handleSelectionPromptAnswers = async (
    observation: TmuxAgentObservation,
    prompt: TmuxSelectionPrompt,
    answers: string[][],
  ): Promise<boolean> => {
    const selectedValue = answers[0]?.[0];
    const selectedOption = prompt.options.find(
      (option) => selectionPromptOptionValue(option) === selectedValue,
    );
    if (!selectedOption) return false;

    return handleSelectPromptOption(observation, prompt, selectedOption.optionIndex);
  };

  const handleResume = (sessionId: string) => {
    setResumeDialogOpen(false);
    launchSession(sessionId, true);
  };

  // Claude Code silently downgrades an unsupported effort level, so when a
  // model change makes the stored preference invalid we snap the stored
  // preference back to the default rather than letting UI and TUI drift.
  const clampEffortToModel = useCallback(
    (modelId: string) => {
      const levels = supportedEffortLevels(getTmuxModel(modelId, availableModels));
      const current =
        useClaudeTmuxStore.getState().effortLevels.get(storeKey) ?? DEFAULT_EFFORT;
      if (levels.length > 0 && !levels.includes(current)) {
        setEffortLevel(storeKey, fallbackEffort(levels));
      }
    },
    [availableModels, storeKey, setEffortLevel],
  );

  const handleSelectModel = async (modelId: string) => {
    if (modelId === selectedModel || settingsSwitching) return;
    const nextSupportsFastMode = getTmuxModel(modelId, availableModels).supportsFastMode === true;

    if (!hasStarted || !running) {
      setSelectedModel(modelId);
      clampEffortToModel(modelId);
      if (!nextSupportsFastMode) applyFastMode(false);
      void persistSelectedModel(modelId);
      return;
    }

    if (sending || isThinking) return;

    setModelSwitching(true);
    setError(null);
    try {
      if (fastModeEnabled === true && !nextSupportsFastMode) {
        await switchFastMode(tabId, false, environmentId);
        applyFastMode(false);
      }
      await switchModel(tabId, modelId, environmentId);
      setSelectedModel(modelId);
      clampEffortToModel(modelId);
      void persistSelectedModel(modelId);
    } catch (e) {
      setError(String(e));
    } finally {
      setModelSwitching(false);
    }
  };

  const handleSelectEffort = async (effort: ClaudeEffortLevel) => {
    if (effort === effectiveEffort || settingsSwitching) return;

    if (!hasStarted || !running) {
      setEffortLevel(storeKey, effort);
      return;
    }

    if (sending || isThinking) return;

    setEffortSwitching(true);
    setError(null);
    try {
      await switchEffort(tabId, effort, environmentId);
      setEffortLevel(storeKey, effort);
    } catch (e) {
      setError(String(e));
    } finally {
      setEffortSwitching(false);
    }
  };

  const handleSelectFastMode = async (enabled: boolean) => {
    if (
      enabled === fastModeEnabled ||
      selectedModelObj.supportsFastMode !== true ||
      settingsSwitching
    ) {
      return;
    }

    if (!hasStarted || !running) {
      applyFastMode(enabled);
      return;
    }

    if (sending || isThinking) return;

    setFastModeSwitching(true);
    setError(null);
    try {
      await switchFastMode(tabId, enabled, environmentId);
      applyFastMode(enabled);
    } catch (e) {
      setError(String(e));
    } finally {
      setFastModeSwitching(false);
    }
  };

  const handleSelectPlanMode = async (enabled: boolean) => {
    if (
      enabled === planMode ||
      !running ||
      sending ||
      isThinking ||
      modelSwitching ||
      effortSwitching ||
      fastModeSwitching ||
      modeSwitching
    ) {
      return;
    }

    setModeSwitching(true);
    setError(null);
    try {
      const permissionMode = await switchPlanMode(tabId, enabled, environmentId);
      permissionModeEventVersionRef.current += 1;
      setPlanMode(permissionMode === "plan");
    } catch (e) {
      setError(String(e));
    } finally {
      setModeSwitching(false);
    }
  };

  // Tick once a second while the spinner is visible so the elapsed counter
  // updates. Mirrors the native tab's behavior.
  useEffect(() => {
    if (!isThinking || busyStartedAt === null) {
      setElapsedSeconds(null);
      return;
    }
    const update = () =>
      setElapsedSeconds(Math.floor((Date.now() - busyStartedAt) / 1000));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [isThinking, busyStartedAt]);

  return (
    <div className="@container flex flex-col h-full bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border text-xs shrink-0">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              running ? "bg-emerald-500" : "bg-zinc-500",
            )}
          />
          <span>Claude (tmux)</span>
          {tabState?.sessionId && (
            <span className="font-mono opacity-60">
              {tabState.sessionId.slice(0, 8)}
            </span>
          )}
          {resumedSession && (
            <span
              className="text-[10px] uppercase tracking-wide text-amber-400/80"
              title="This tab resumed a previously-recorded Claude session"
            >
              resumed
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={cn(
              "px-1.5 py-0.5 rounded transition-colors flex items-center gap-1",
              interactiveMode
                ? "text-foreground bg-muted/40 hover:bg-muted/60"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
              (!running || settingsSwitching) && "opacity-50 cursor-not-allowed",
            )}
            onClick={() => {
              if (running && !settingsSwitching) setInteractiveMode((v) => !v);
            }}
            disabled={!running || settingsSwitching}
            title={
              interactiveMode
                ? "Switch back to the native tmux transcript view"
                : "Attach an interactive terminal to this tmux session"
            }
          >
            <TerminalIcon className="w-3 h-3" />
            {interactiveMode ? "Native" : "Terminal"}
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={handleInterrupt}
            disabled={!running || settingsSwitching}
            title="Interrupt the current Claude turn without closing tmux"
          >
            Interrupt
          </button>
        </div>
      </div>

      {/* Inline error bar */}
      {error && (
        <div className="px-3 py-1.5 text-xs text-red-400 bg-red-950/30 border-b border-red-900/40 shrink-0">
          {error}
        </div>
      )}

      {interactiveMode ? (
        <ClaudeTmuxInteractiveTerminal
          tabId={tabId}
          environmentId={environmentId}
          containerId={containerId}
          worktreePath={worktreePath}
          isActive={isActive}
          className="flex-1"
        />
      ) : (
        <div className="@container relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
              centerCompose && "pointer-events-none scale-[0.995] opacity-0",
            )}
          >
            {/* Messages */}
            <VirtualizedMessageList
              messages={displayMessages}
              computeItemKey={(_index, message) => message.id}
              resolvePreviousMessage={findPreviousNativeMessage}
              renderMessage={(_index, message, previousMessage) => (
                <NativeMessage
                  message={message}
                  previousMessage={previousMessage}
                  assistantLabel="Claude"
                  containerId={containerId}
                  agentExpansionScope={environmentId}
                  resolveModelLabel={resolveModelLabel}
                />
              )}
              emptyState={
                !centerCompose && !hasPendingHookCards ? (
                  showStartScreen ? (
                    <StartScreen
                      onStartFresh={() => launchSession(undefined, true)}
                      onPickResume={() => setResumeDialogOpen(true)}
                      selectedModel={selectedModelObj.name}
                      effortLabel={
                        effortOptions.length > 0
                          ? EFFORT_LABELS[effectiveEffort]
                          : null
                      }
                      planMode={planMode}
                    />
                  ) : (
                    <div className="text-xs text-muted-foreground italic py-8 text-center">
                      {running
                        ? "Waiting for Claude..."
                        : "Starting Claude under tmux..."}
                    </div>
                  )
                ) : undefined
              }
              footer={
              /*
                `space-y-3` supplies the gap that the shared BlockingPromptCard
                deliberately dropped: in the native tabs the compose dock spaces
                these cards, but this footer stacks them itself.
              */
              <div className="max-w-3xl mx-auto min-w-0 px-2 @sm:px-4 py-3 space-y-3">
                {pendingApprovals.map((a) => (
                  <ApprovalCard
                    key={a.eventId}
                    approval={a}
                    onApprove={() => handleApproval(a.eventId, "approve")}
                    onDeny={() => handleApproval(a.eventId, "block")}
                  />
                ))}

                {pendingQuestions.map((q) => (
                  <ClaudeQuestionCard
                    key={q.eventId}
                    question={{
                      id: q.eventId,
                      sessionId: tabState?.sessionId ?? tabId,
                      questions: q.questions,
                      toolUseId: q.eventId,
                      expiresAt: q.expiresAt,
                    }}
                    onSubmitAnswers={(answers) => handleQuestionAnswer(q, answers)}
                    onDismiss={() => handleQuestionReject(q)}
                    // Cleared by claudeTmuxStore when the question resolves.
                    draftKey={tmuxQuestionDraftKey(storeKey, q.eventId)}
                  />
                ))}

                {pendingPlans.map((p) => (
                  <TmuxPlanCard
                    key={p.eventId}
                    plan={p}
                    sessionKey={storeKey}
                    onRespond={(approved, feedback) =>
                      handlePlanResponse(p, approved, feedback)
                    }
                  />
                ))}

                {pendingPermissions.map((p) => (
                  <TmuxPermissionCard
                    key={p.eventId}
                    permission={p}
                    onRespond={(allow, updatedPermissions) =>
                      handlePermissionResponse(p, allow, updatedPermissions)
                    }
                  />
                ))}

                {pendingElicitations.map((e) => (
                  <TmuxElicitationCard
                    key={e.eventId}
                    elicitation={e}
                    sessionKey={storeKey}
                    onRespond={(action, content) =>
                      handleElicitationResponse(e, action, content)
                    }
                  />
                ))}

                {visibleSelectionPrompt && tabState && (
                  <ClaudeQuestionCard
                    key={selectionPromptKey(visibleSelectionPrompt)}
                    question={selectionPromptToQuestion(visibleSelectionPrompt, storeKey)}
                    initialAnswers={[selectionPromptInitialAnswer(visibleSelectionPrompt)]}
                    allowCustomAnswer={false}
                    allowOptionDeselect={false}
                    hideDismiss
                    onSubmitAnswers={(answers) =>
                      handleSelectionPromptAnswers(tabState.observation, visibleSelectionPrompt, answers)
                    }
                  />
                )}

                {/* Claude's thinking indicator matches the native tab. It is shown only
                    while running so a freshly mounted tab without a session does not
                    flash a misleading busy state. */}
                {isThinking && running && (
                  <div className="py-2">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <AgentThinkingIndicator agentName="Claude" />
                      {elapsedSeconds !== null && elapsedSeconds > 0 && (
                        <span className="text-xs text-muted-foreground/50">
                          {formatElapsed(elapsedSeconds)}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <div className="h-32" aria-hidden="true" />
              </div>
              }
              scrollProps={scrollProps}
              virtuosoRef={virtuosoRef}
              find={{
                isActive: ownsGlobalShortcuts && !interactiveMode,
                getSearchText: getNativeMessageSearchText,
              }}
            />

          </div>

          {/* Compose bar — stays "busy" for the full turn (HTTP submit + Claude
              processing) so a user can't queue a second message before the
              previous one finishes. Mirrors the spinner condition above. */}
          <NativeComposeDock
            centered={centerCompose}
            topAccessory={
              !isAtBottom ? (
                <button
                  type="button"
                  onClick={scrollToBottom}
                  className="flex items-center gap-1.5 rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 shadow-sm transition-colors hover:bg-zinc-700"
                  aria-label="Scroll to bottom of conversation"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                  <span>Scroll down</span>
                </button>
              ) : null
            }
            actions={
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => launchSession(undefined, true)}
                  className="rounded-full text-muted-foreground transition-colors hover:text-foreground"
                  aria-hidden={!centerCompose}
                  tabIndex={centerCompose ? 0 : -1}
                >
                  <Sparkles className="mr-2 h-4 w-4" />
                  Start fresh
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setResumeDialogOpen(true)}
                  className="rounded-full text-muted-foreground transition-colors hover:text-foreground"
                  aria-hidden={!centerCompose}
                  tabIndex={centerCompose ? 0 : -1}
                >
                  <History className="mr-2 h-4 w-4" />
                  Resume previous session...
                </Button>
              </div>
            }
          >
            <TmuxComposeBar
              sessionKey={storeKey}
              environmentId={environmentId}
              containerId={containerId}
              worktreePath={worktreePath}
              disabled={!running}
              busy={isThinking}
              submitting={sending || settingsSwitching}
              autoFocus={isActive}
              onSubmit={handleSubmit}
              onQueue={handleQueue}
              onQueueError={setError}
              queueLength={queueLength}
              showAddressAll={showAddressAll}
              onAddressAll={handleAddressAll}
              onInterrupt={handleInterrupt}
              models={availableModels}
              selectedModel={selectedModel}
              onSelectModel={(modelId) => {
                void handleSelectModel(modelId);
              }}
              selectedEffort={effectiveEffort}
              effortOptions={effortOptions}
              onSelectEffort={(level) => {
                void handleSelectEffort(level);
              }}
              fastModeEnabled={fastModeEnabled}
              fastModeAvailable={selectedModelObj.supportsFastMode === true}
              onSelectFastMode={(enabled) => {
                void handleSelectFastMode(enabled);
              }}
              planMode={planMode}
              onTogglePlanMode={(enabled) => {
                void handleSelectPlanMode(enabled);
              }}
              modelDisabled={
                (hasStarted && !running) ||
                sending ||
                isThinking ||
                settingsSwitching
              }
              modelSwitching={modelSwitching}
              effortSwitching={effortSwitching}
              planLocked={
                !running || sending || isThinking || settingsSwitching
              }
              layout={centerCompose ? "centered" : "bottom"}
            />
          </NativeComposeDock>
        </div>
      )}

      <ResumeTmuxSessionDialog
        open={resumeDialogOpen}
        onOpenChange={setResumeDialogOpen}
        environmentId={environmentId}
        onResume={handleResume}
      />
    </div>
  );
}

// ─── Start screen ────────────────────────────────────────────────────────────
