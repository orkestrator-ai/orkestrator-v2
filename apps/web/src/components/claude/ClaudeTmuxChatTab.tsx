// Claude tmux mode chat tab.
//
// Drives the `claude` CLI under tmux on the host or in a container, and
// surfaces a chat UI by reading the JSONL transcript and listening to
// Claude Code hooks. No Agent SDK required.
//
// Visual parity with the native tabs is achieved by normalizing transcript
// messages into the shared native message model before rendering.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  History,
  Plus,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useMediaQuery, useVirtuosoScrollState } from "@/hooks";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { NativeComposeDock } from "@/components/chat/NativeComposeDock";
import { NativeModelPicker } from "@/components/chat/NativeModelPicker";
import { BlockingPromptCard } from "@/components/chat/BlockingPromptCard";
import { AgentThinkingIndicator } from "@/components/chat/AgentThinkingIndicator";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { getNativeMessageSearchText } from "@/components/chat/native-message-search";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { ClaudeQuestionCard } from "@/components/claude/ClaudeQuestionCard";
import { ClaudeTmuxInteractiveTerminal } from "@/components/claude/ClaudeTmuxInteractiveTerminal";
import { ResumeTmuxSessionDialog } from "@/components/claude/ResumeTmuxSessionDialog";
import { formatElapsed } from "@/lib/format-elapsed";
import { createUuid } from "@/lib/uuid";
import { isDefaultTimestampEnvironmentName } from "@/lib/environment-name";
import { SlashCommandMenu } from "@/components/chat/SlashCommandMenu";
import {
  parseSlashCommands,
  type SlashCommand,
} from "@/lib/chat/slash-commands";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import { useFileMentions } from "@/hooks/useFileMentions";
import { useFileSearch } from "@/hooks/useFileSearch";
import {
  useNativeComposeBarPaste,
  type PastedImageAttachment,
} from "@/hooks/useNativeComposeBarPaste";
import {
  answerPreToolUse,
  capturePane,
  getPendingHooks,
  getStatus,
  getTranscript,
  interruptSession,
  replyHook,
  sendKeys,
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
import { escapePathForTerminalInput } from "@/lib/terminal-paste";
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
  type TmuxPendingApproval,
  type TmuxPendingElicitation,
  type TmuxPendingPermission,
  type TmuxPendingPlan,
  type TmuxPendingQuestion,
  type TmuxAttachment,
  type TmuxQueuedMessage,
} from "@/stores/claudeTmuxStore";
import { normalizeClaudeMessage } from "@/lib/chat/native-message-adapters";
import { resolveCatalogModelLabel } from "@/lib/chat/model-label";
import { pinActiveNativeAgentParts } from "@/lib/chat/native-agent-pinning";
import {
  applyTmuxAgentUsageSummaries,
  parseTmuxAgentUsageSummaries,
} from "@/lib/claude-tmux-usage";
import type { ClaudeEffortLevel, ClaudeModel } from "@/lib/claude-client";
import { useClaudeStore } from "@/stores/claudeStore";
import {
  tmuxElicitationDraftKey,
  tmuxPlanDraftKey,
  tmuxQuestionDraftKey,
  usePromptDraftField,
} from "@/stores/promptDraftStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useConfigStore } from "@/stores/configStore";
import {
  acknowledgeAgentPromptClaim,
  claimAgentPromptQueueHead,
  enqueueAgentPrompt,
  moveAgentPrompt,
  rejectAgentPromptClaim,
  removeAgentPrompt,
} from "@/lib/prompt-queue-sources";
import { composerOccupiedError } from "@/lib/prompt-queue-errors";
import {
  getClaudeModelCatalog,
  renameEnvironmentFromPrompt,
  updateGlobalConfig,
} from "@/lib/backend";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { getClaudeTmuxCapturePolling } from "@/lib/claude-tmux-polling";
import { serializeClaudeQuestionAnswer } from "@orkestrator/protocol/agent-interactions";
import type { ClaudeTmuxData } from "@/types/paneLayout";
import type { FileCandidate, FileMention } from "@/types";

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

/**
 * Fallback model list for tmux mode, mirroring what the Claude Agent SDK's
 * `supportedModels()` reports for the current Claude Code release. When a
 * Claude native (bridge) tab has fetched the live SDK model list, we prefer
 * that — see `useClaudeStore` in the component. Users can also type
 * `/model …` in the Claude TUI to override at runtime.
 */
const TMUX_FALLBACK_MODELS: ClaudeModel[] = [
  {
    id: "default",
    name: "Default (recommended)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    supportsFastMode: true,
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "opus[1m]",
    name: "Opus (1M context)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    supportsFastMode: true,
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-fable-5[1m]",
    name: "Fable",
    description:
      "Fable 5 · Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "sonnet",
    name: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "haiku",
    name: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];
const DEFAULT_MODEL = "default";

/**
 * Model ids we persisted before switching to SDK-style ids/aliases. Mapped so
 * an old saved preference still resolves to a sensible current model.
 */
const LEGACY_TMUX_MODEL_ALIASES: Record<string, string> = {
  "claude-fable-5": "default",
  "claude-opus-5": "default",
  "claude-opus-5[1m]": "opus[1m]",
  "claude-opus-4-8": "default",
  "claude-opus-4-7": "default",
  "claude-opus-4-6": "default",
  "claude-sonnet-5": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "claude-haiku-4-5": "haiku",
  "claude-haiku-4-5-20251001": "haiku",
};

const EFFORT_LABELS: Record<ClaudeEffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};
const EFFORT_DESCRIPTIONS: Record<ClaudeEffortLevel, string> = {
  low: "Minimal thinking, fastest responses",
  medium: "Moderate thinking for everyday tasks",
  high: "Deep reasoning for complex problems",
  xhigh: "Deeper reasoning for the hardest problems",
  max: "Maximum effort (select models only)",
};
const DEFAULT_EFFORT: ClaudeEffortLevel = "high";
/**
 * First cooldown before a queue head that failed to send is retried. Doubles
 * per consecutive failure on the same head, capped at 30s.
 */
const PAUSED_QUEUE_HEAD_BASE_DELAY_MS = 500;

function resolveTmuxModelPreference(
  modelId: string | undefined,
  models: ClaudeModel[],
): string {
  const normalized = modelId
    ? (LEGACY_TMUX_MODEL_ALIASES[modelId] ?? modelId)
    : undefined;
  return models.some((model) => model.id === normalized)
    ? normalized!
    : DEFAULT_MODEL;
}

/** Whether `modelId` is one this catalog can actually honour. */
function tmuxModelIsAvailable(modelId: string, models: ClaudeModel[]): boolean {
  const normalized = LEGACY_TMUX_MODEL_ALIASES[modelId] ?? modelId;
  return models.some((model) => model.id === normalized);
}

function getTmuxModel(id: string, models: ClaudeModel[]): ClaudeModel {
  return (
    models.find((m) => m.id === id) ??
    models.find((m) => m.id === DEFAULT_MODEL) ??
    models[0] ??
    TMUX_FALLBACK_MODELS[0]!
  );
}

function supportedEffortLevels(model: ClaudeModel): ClaudeEffortLevel[] {
  if (!model.supportsEffort && !model.supportedEffortLevels?.length) return [];
  return model.supportedEffortLevels?.length
    ? model.supportedEffortLevels
    : (["low", "medium", "high"] as ClaudeEffortLevel[]);
}

/**
 * The level to fall back to when the stored preference isn't supported by the
 * selected model. Usually `DEFAULT_EFFORT`, but the SDK owns each model's
 * level list, so don't assume "high" is always present. Callers must ensure
 * `options` is non-empty.
 */
function fallbackEffort(options: ClaudeEffortLevel[]): ClaudeEffortLevel {
  return options.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : options[0]!;
}

/**
 * Latest tmux catalog request per environment.
 *
 * Discovery belongs to the backend/environment lifecycle, not the mounted tab.
 * Keeping the generation outside React lets a successful request finish after
 * unmount while preventing an older response from replacing a newer refresh.
 */
const claudeCatalogRequestGenerations = new Map<string, number>();

/**
 * Prefer the live model list the Claude bridge fetched from the Agent SDK
 * (shared via the claude store) over the static fallback. The "default"
 * sentinel is guaranteed to be present either way.
 */
function tmuxModelList(sdkModels: ClaudeModel[]): ClaudeModel[] {
  if (sdkModels.length === 0) return TMUX_FALLBACK_MODELS;
  return sdkModels.some((m) => m.id === DEFAULT_MODEL)
    ? sdkModels
    : [TMUX_FALLBACK_MODELS[0]!, ...sdkModels];
}

interface TmuxSelectionPrompt {
  question: string | null;
  options: TmuxSelectionOption[];
  selectedOptionIndex: number;
  inputMode: "navigate" | "number";
}

interface TmuxSelectionOption {
  number: number;
  label: string;
  optionIndex: number;
  selected: boolean;
}

/**
 * Claude Code's built-in slash commands. In tmux mode we ship a fixed list
 * (no SDK to enumerate) and forward the literal command text to the TUI on
 * submit, where Claude Code dispatches it just like a user typed it.
 *
 * Custom user / project commands aren't included here — they're still
 * usable by typing them manually.
 */
const TMUX_BUILTIN_SLASH_COMMANDS: SlashCommand[] = parseSlashCommands([
  "/help - Get help with using Claude Code",
  "/config - Open settings (theme, model, etc.)",
  "/clear - Clear conversation context",
  "/compact - Manually compact the conversation",
  "/usage - View usage and quota information",
  "/cost - Show token usage and cost for the session",
  "/model - Switch the active model",
  "/login - Log in to Claude",
  "/logout - Log out of Claude",
  "/status - Show current session status",
  "/memory - Edit memory / CLAUDE.md files",
  "/permissions - Manage tool permissions",
  "/mcp - Manage MCP servers",
  "/agents - Manage subagents",
  "/hooks - Manage hooks",
  "/doctor - Diagnose installation issues",
  "/bug - Report a bug",
  "/release-notes - View release notes",
  "/fast - Toggle fast mode (Opus with faster output)",
]);

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
  const setTabBusy = useClaudeTmuxStore((s) => s.setBusy);
  const clearTabInitialPrompt = usePaneLayoutStore((s) => s.clearTabInitialPrompt);
  const clearTabInitialAgentOptions = usePaneLayoutStore((s) => s.clearTabInitialAgentOptions);
  const setConfig = useConfigStore((s) => s.setConfig);
  const persistedClaudeModel = useConfigStore((s) => s.config.global.claudeModel);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTui, setShowTui] = useState(false);
  const [interactiveMode, setInteractiveMode] = useState(false);
  const [tuiSnapshot, setTuiSnapshot] = useState<string>("");
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
  const [promptControlBusy, setPromptControlBusy] = useState(false);
  const [backendHydrated, setBackendHydrated] = useState(false);
  const startedRef = useRef(false);
  const permissionModeEventVersionRef = useRef(0);
  const fastModeMutationVersionRef = useRef(0);
  const isProcessingQueueRef = useRef(false);
  /**
   * Head this tab has stopped retrying, and for how many consecutive failures.
   *
   * A restored head is byte-identical to the one that just failed, so an
   * unconditional re-drive would spin against an unavailable session. The pause
   * is released on a backoff rather than held until the head changes: a send
   * that failed once must still drain when the session recovers.
   */
  const pausedQueueHeadRef = useRef<{ id: string; attempts: number } | null>(null);
  const pausedQueueHeadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pauseQueueHeadRef = useRef<(headId: string) => void>(() => {});
  const queueMountedRef = useRef(true);
  const claimSettlementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingClaimSettlementRef = useRef<{
    operation: "acknowledge" | "reject";
    claim: { entry: TmuxQueuedMessage; claimToken: string };
  } | null>(null);
  const retryClaimSettlementRef = useRef<
    (
      operation: "acknowledge" | "reject",
      claim: { entry: TmuxQueuedMessage; claimToken: string },
      attempt: number,
      reported: boolean,
    ) => Promise<boolean>
  >(async () => false);
  const processQueueRef = useRef<() => void>(() => {});
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
  const selectionPrompt = useMemo(
    () => parseTmuxSelectionPrompt(tuiSnapshot),
    [tuiSnapshot],
  );
  const resumedSession = tabState?.resumed ?? false;
  const hasStarted = startedRef.current || running;
  const showStartScreen = !hasStarted && !hasInitialPrompt;
  const hasPendingHookCards =
    pendingApprovals.length +
      pendingQuestions.length +
      pendingPlans.length +
      pendingPermissions.length +
      pendingElicitations.length >
    0;
  const visibleSelectionPrompt = hasPendingHookCards ? null : selectionPrompt;
  const agentUsageSummaries = useMemo(
    () => parseTmuxAgentUsageSummaries(tuiSnapshot),
    [tuiSnapshot],
  );
  const transcriptMessages = useMemo(
    () =>
      applyTmuxAgentUsageSummaries(
        compactConsecutiveAssistantMessages(messages),
        agentUsageSummaries,
      ),
    [messages, agentUsageSummaries],
  );
  const displayMessages = useMemo(
    () => pinActiveNativeAgentParts(transcriptMessages.map(normalizeClaudeMessage)),
    [transcriptMessages],
  );
  const hasMessageHistory = displayMessages.length > 0;
  const centerCompose =
    showStartScreen &&
    !showTui &&
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
  const queueHeadId = useClaudeTmuxStore(
    useCallback(
      (state) => state.messageQueue.get(storeKey)?.[0]?.id,
      [storeKey],
    ),
  );
  const isQueueBlockedByDraft = useClaudeTmuxStore(
    useCallback(
      (state) =>
        (state.draftText.get(storeKey)?.trim().length ?? 0) > 0 ||
        (state.attachments.get(storeKey)?.length ?? 0) > 0,
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
            setRunning(storeKey, status.running, {
              environmentId: status.environment_id,
              sessionId: status.session_id,
              resumed: status.resumed,
            });
            setTabBusy(storeKey, status.busy);
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
              replacePendingHooks(storeKey, pendingSnapshotFromHooks(hooksToRender));
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
          setRunning(storeKey, true, {
            environmentId: ev.environment_id,
            sessionId: ev.session_id,
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
        case "stopped":
          startedRef.current = false;
          permissionModeEventVersionRef.current += 1;
          setRunning(storeKey, false, { sessionId: null });
          setPlanMode(false);
          applyFastMode(false);
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
    setTabBusy,
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
    if (startedRef.current) return;
    if (running) return;
    launchSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendHydrated, hasInitialPrompt, tabId, running]);

  // 3. Raw TUI snapshot polling. The snapshot powers both the optional debug
  //    pane and the interactive controls for Claude Code's in-TUI prompts.
  useEffect(() => {
    const polling = getClaudeTmuxCapturePolling(showTui, running);
    if (!polling.enabled) {
      setTuiSnapshot("");
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const snap = await capturePane(tabId, environmentId);
        if (!cancelled) setTuiSnapshot(snap);
      } catch (e) {
        if (!cancelled) setTuiSnapshot(`(capture failed: ${String(e)})`);
      }
    };
    void tick();
    // 500ms keeps the visible TUI responsive; when the pane is hidden the
    // capture only feeds prompt detection, which tolerates a slower 3s poll —
    // per-second `tmux capture-pane` across every background environment adds
    // up. The poll itself must stay: in-TUI prompts are still detected while
    // the pane is hidden, just up to 3s later.
    const id = setInterval(tick, polling.intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [showTui, running, tabId, environmentId]);

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

  const clearPausedQueueHead = useCallback(() => {
    pausedQueueHeadRef.current = null;
    if (pausedQueueHeadTimerRef.current) {
      clearTimeout(pausedQueueHeadTimerRef.current);
      pausedQueueHeadTimerRef.current = null;
    }
  }, []);

  /**
   * Stop retrying one head for a bounded cooldown, then drain again.
   *
   * Without the cooldown a sender that keeps refusing would be re-claimed as
   * fast as the backend can answer; without the automatic release the queue
   * would stay stalled behind a prompt whose only problem was transient.
   */
  const pauseQueueHead = useCallback((headId: string) => {
    const previous = pausedQueueHeadRef.current;
    const attempts = previous?.id === headId ? previous.attempts + 1 : 1;
    pausedQueueHeadRef.current = { id: headId, attempts };
    if (pausedQueueHeadTimerRef.current) {
      clearTimeout(pausedQueueHeadTimerRef.current);
    }
    pausedQueueHeadTimerRef.current = setTimeout(() => {
      pausedQueueHeadTimerRef.current = null;
      if (pausedQueueHeadRef.current?.id !== headId || !queueMountedRef.current) {
        return;
      }
      if (pendingClaimSettlementRef.current) {
        // A settlement retry still owns the durable claim, so resuming would
        // race it for the same message. Wait again rather than returning: the
        // cooldown is the only thing that will restart this head.
        pauseQueueHeadRef.current(headId);
        return;
      }
      pausedQueueHeadRef.current = null;
      processQueueRef.current();
    }, Math.min(PAUSED_QUEUE_HEAD_BASE_DELAY_MS * (2 ** (attempts - 1)), 30_000));
  }, []);
  pauseQueueHeadRef.current = pauseQueueHead;

  retryClaimSettlementRef.current = async (
    operation,
    claim,
    attempt,
    reported,
  ) => {
    pendingClaimSettlementRef.current = { operation, claim };
    // Set this before the reject call applies its authoritative snapshot.
    // Zustand subscribers can render synchronously during that application;
    // the guard must already be visible when their queue effect runs.
    if (operation === "reject") {
      pauseQueueHead(claim.entry.id);
    }
    try {
      if (operation === "acknowledge") {
        await acknowledgeAgentPromptClaim<TmuxQueuedMessage>(
          "claude-tmux",
          storeKey,
          claim.claimToken,
        );
      } else {
        await rejectAgentPromptClaim<TmuxQueuedMessage>(
          "claude-tmux",
          storeKey,
          claim.claimToken,
        );
      }
      pendingClaimSettlementRef.current = null;
      if (operation === "acknowledge") {
        // The head advanced, so the cooldown taken for an earlier failure on
        // this tab no longer describes anything.
        clearPausedQueueHead();
      } else if (queueMountedRef.current) {
        setError("Failed to send queued prompt. It was returned to the queue.");
      }
      return true;
    } catch (settlementError) {
      if (!reported) {
        const detail =
          settlementError instanceof Error
            ? settlementError.message
            : "Unknown error";
        setError(
          operation === "acknowledge"
            ? `Queued prompt was sent, but its queue claim could not be acknowledged yet: ${detail}`
            : `Failed to send queued prompt and return it to the queue yet: ${detail}`,
        );
      }
      if (!queueMountedRef.current) {
        // Leave the durable claim alone. Copying the prompt back into this
        // tab's draft would duplicate it: the backend lease still holds the
        // same message and re-heads it when the lease expires.
        pendingClaimSettlementRef.current = null;
        return false;
      }

      const delay = Math.min(250 * (2 ** attempt), 30_000);
      claimSettlementTimerRef.current = setTimeout(() => {
        claimSettlementTimerRef.current = null;
        void retryClaimSettlementRef.current(
          operation,
          claim,
          attempt + 1,
          true,
        ).then((settled) => {
          if (settled && operation === "acknowledge") {
            processQueueRef.current();
          }
        });
      }, delay);
      return false;
    }
  };

  const processQueue = useCallback(() => {
    if (isProcessingQueueRef.current) return;
    if (
      !backendHydrated ||
      !running ||
      sending ||
      isThinking ||
      settingsSwitching
    ) {
      return;
    }

    const tmuxState = useClaudeTmuxStore.getState();
    const currentHeadId = tmuxState.getQueuedMessages(storeKey)[0]?.id ?? null;
    const paused = pausedQueueHeadRef.current;
    if (paused) {
      // Still cooling down on the head that failed; its timer will re-drive.
      if (paused.id === currentHeadId) return;
      // A different head means the queue moved on under us, so the cooldown
      // and its retry count no longer apply.
      clearPausedQueueHead();
    }
    if (
      tmuxState.getDraftText(storeKey).trim().length > 0 ||
      tmuxState.getAttachments(storeKey).length > 0
    ) {
      return;
    }

    isProcessingQueueRef.current = true;
    const headBeforeClaimId = tmuxState.getQueuedMessages(storeKey)[0]?.id;
    let claimedPrompt: {
      entry: TmuxQueuedMessage;
      claimToken: string;
    } | null = null;
    void claimAgentPromptQueueHead<TmuxQueuedMessage>("claude-tmux", storeKey)
      .then((nextClaim) => {
        if (!nextClaim) return;
        claimedPrompt = nextClaim;
        return submitPromptRef.current?.(
          nextClaim.entry.text,
          nextClaim.entry.attachments,
          false,
        );
      })
      .then(async (sent) => {
        if (!claimedPrompt) return;
        if (sent === true) {
          await retryClaimSettlementRef.current(
            "acknowledge",
            claimedPrompt,
            0,
            false,
          );
          return;
        }

        await retryClaimSettlementRef.current(
          "reject",
          claimedPrompt,
          0,
          false,
        );
      })
      .catch((e) => {
        if (headBeforeClaimId) pauseQueueHead(headBeforeClaimId);
        setError(
          `Failed to send queued prompt: ${
            e instanceof Error ? e.message : "Unknown error"
          }`,
        );
        setTabBusy(storeKey, false);
      })
      .finally(() => {
        isProcessingQueueRef.current = false;
        const headAfterClaimId = useClaudeTmuxStore
          .getState()
          .getQueuedMessages(storeKey)[0]?.id;
        if (!claimedPrompt && headAfterClaimId !== headBeforeClaimId) {
          processQueueRef.current();
        }
      });
  }, [
    backendHydrated,
    clearPausedQueueHead,
    isThinking,
    settingsSwitching,
    pauseQueueHead,
    running,
    sending,
    setTabBusy,
    storeKey,
  ]);

  useEffect(() => {
    processQueueRef.current = processQueue;
  }, [processQueue]);

  useEffect(() => {
    queueMountedRef.current = true;
    return () => {
      queueMountedRef.current = false;
      /*
       * Drop this tab's timers and forget any unsettled claim, but never touch
       * the prompt itself. The backend still owns it under a lease and re-heads
       * it when that lease expires, so restoring it locally as well would put
       * the same prompt in both the composer and the queue and send it twice.
       */
      if (claimSettlementTimerRef.current) {
        clearTimeout(claimSettlementTimerRef.current);
        claimSettlementTimerRef.current = null;
      }
      if (pausedQueueHeadTimerRef.current) {
        clearTimeout(pausedQueueHeadTimerRef.current);
        pausedQueueHeadTimerRef.current = null;
      }
      pendingClaimSettlementRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (queueLength > 0 && !isQueueBlockedByDraft) {
      processQueue();
    }
  }, [isQueueBlockedByDraft, processQueue, queueHeadId, queueLength, isThinking]);

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

  const handlePromptKeys = async (keys: string[]) => {
    if (keys.length === 0 || promptControlBusy) return;
    setPromptControlBusy(true);
    setError(null);
    try {
      await sendKeys(tabId, keys, environmentId);
      const snap = await capturePane(tabId, environmentId);
      setTuiSnapshot(snap);
    } catch (e) {
      setError(String(e));
    } finally {
      setPromptControlBusy(false);
    }
  };

  const handleSelectPromptOption = async (
    prompt: TmuxSelectionPrompt,
    optionIndex: number,
  ) => {
    const option = prompt.options[optionIndex];
    if (!option) return;

    await handlePromptKeys(selectionPromptSubmitKeys(prompt, optionIndex));
  };

  const handleSelectionPromptAnswers = async (
    prompt: TmuxSelectionPrompt,
    answers: string[][],
  ): Promise<boolean> => {
    const selectedValue = answers[0]?.[0];
    const selectedOption = prompt.options.find(
      (option) => selectionPromptOptionValue(option) === selectedValue,
    );
    if (!selectedOption) return false;

    await handleSelectPromptOption(prompt, selectedOption.optionIndex);
    return true;
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
            className={cn(
              "px-1.5 py-0.5 rounded hover:bg-muted/50 transition-colors flex items-center gap-1",
              showTui
                ? "text-foreground bg-muted/40"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setShowTui((v) => !v)}
            title="Toggle a live text snapshot of the underlying tmux pane"
          >
            <TerminalIcon className="w-3 h-3" />
            {showTui ? "Hide TUI" : "Show TUI"}
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
          {/* Raw TUI panel (debug) */}
          {showTui && (
            <div className="border-b border-border bg-black p-2 shrink-0">
              <div className="text-[10px] uppercase tracking-wide text-amber-400 mb-1">
                Raw tmux pane (refreshing)
              </div>
              <pre className="text-[11px] font-mono whitespace-pre-wrap max-h-72 overflow-auto text-zinc-200">
                {tuiSnapshot || "(empty)"}
              </pre>
            </div>
          )}

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

                {visibleSelectionPrompt && (
                  <ClaudeQuestionCard
                    key={selectionPromptKey(visibleSelectionPrompt)}
                    question={selectionPromptToQuestion(visibleSelectionPrompt, storeKey)}
                    initialAnswers={[selectionPromptInitialAnswer(visibleSelectionPrompt)]}
                    allowCustomAnswer={false}
                    allowOptionDeselect={false}
                    hideDismiss
                    onSubmitAnswers={(answers) =>
                      handleSelectionPromptAnswers(visibleSelectionPrompt, answers)
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

interface StartScreenProps {
  onStartFresh: () => void;
  onPickResume: () => void;
  selectedModel: string;
  effortLabel: string | null;
  planMode: boolean;
}

/**
 * Shown when a fresh tab opens without an `initialPrompt`. Gives the user the
 * choice to start a new claude session or to resume a previously-recorded
 * one — mirrors the Claude Native tab's behavior.
 */
function StartScreen({
  onStartFresh,
  onPickResume,
  selectedModel,
  effortLabel,
  planMode,
}: StartScreenProps) {
  return (
    <div className="flex flex-col items-center text-center py-10 px-4 gap-4">
      <div className="space-y-1">
        <h2 className="text-base font-medium">Start a Claude session</h2>
        <p className="text-xs text-muted-foreground">
          Each tab runs its own claude under tmux. Pick a previous session to
          continue where you left off, or start a fresh conversation.
        </p>
        <p className="text-[11px] text-muted-foreground/70">
          Will launch with <span className="font-mono">{selectedModel}</span>
          {effortLabel ? ` at ${effortLabel} effort` : ""}
          {planMode ? " in plan mode" : ""}.
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={onStartFresh}
          className="gap-1.5"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Start fresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onPickResume}
          className="gap-1.5"
        >
          <History className="w-3.5 h-3.5" />
          Resume previous session…
        </Button>
      </div>
    </div>
  );
}

// ─── Structured hook cards ──────────────────────────────────────────────────

function TmuxPlanCard({
  plan,
  sessionKey,
  onRespond,
}: {
  plan: TmuxPendingPlan;
  sessionKey: string;
  onRespond: (approved: boolean, feedback?: string) => Promise<void> | void;
}) {
  // The feedback draft survives the tab unmounting (environment switches) by
  // living in the prompt-draft store; claudeTmuxStore clears it when the plan
  // request resolves or is withdrawn.
  const draftKey = tmuxPlanDraftKey(sessionKey, plan.eventId);
  const [showFeedback, setShowFeedback] = usePromptDraftField<boolean>(
    draftKey,
    "showFeedback",
    () => false,
  );
  const [feedback, setFeedback] = usePromptDraftField<string>(
    draftKey,
    "feedback",
    () => "",
  );
  const [submitting, setSubmitting] = useState(false);
  const respond = async (approved: boolean, nextFeedback?: string) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onRespond(approved, nextFeedback);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <BlockingPromptCard
      title="Plan ready for review"
      expiresAt={plan.expiresAt}
      state={submitting ? "submitting" : "pending"}
      aria-label="Claude plan ready for review"
      arrivalAnnouncement="Claude is waiting for a plan decision."
      className="mb-3"
    >
      <div className="px-3 py-3">
      {plan.planFilePath && (
        <div className="text-xs font-mono text-muted-foreground mb-2 break-all">
          {plan.planFilePath}
        </div>
      )}
      {plan.plan && (
        <MessageMarkdown
          content={plan.plan}
          className="max-h-80 overflow-auto rounded border border-border/70 bg-background/60 p-3"
        />
      )}
      {plan.allowedPrompts.length > 0 && (
        <div className="mt-2 text-xs text-muted-foreground">
          Requests {plan.allowedPrompts.length} plan-scoped permission prompt(s).
        </div>
      )}
      {showFeedback && (
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="What should Claude change?"
          className="mt-3 w-full min-h-20 resize-none rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none"
        />
      )}
      <div className="flex justify-end gap-2 mt-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            showFeedback ? void respond(false, feedback) : setShowFeedback(true)
          }
          disabled={submitting}
        >
          Request changes
        </Button>
        <Button size="sm" onClick={() => void respond(true)} disabled={submitting}>
          Approve plan
        </Button>
      </div>
      </div>
    </BlockingPromptCard>
  );
}

function TmuxPermissionCard({
  permission,
  onRespond,
}: {
  permission: TmuxPendingPermission;
  onRespond: (allow: boolean, updatedPermissions?: unknown[]) => Promise<void> | void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const respond = async (allow: boolean, updatedPermissions?: unknown[]) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onRespond(allow, updatedPermissions);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <BlockingPromptCard
      title="Claude needs permission"
      expiresAt={permission.expiresAt}
      state={submitting ? "submitting" : "pending"}
      aria-label="Claude needs permission"
      arrivalAnnouncement="Claude is waiting for a permission decision."
      className="mb-3"
    >
      <div className="px-3 py-3">
      <div className="text-sm font-mono text-amber-100 mb-2">
        {permission.toolName}
      </div>
      <ApprovalToolInput
        toolName={permission.toolName}
        toolInput={permission.toolInput}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => void respond(false)} disabled={submitting}>
          Deny
        </Button>
        {permission.permissionSuggestions.map((suggestion, index) => (
          <Button
            key={index}
            variant="outline"
            size="sm"
            onClick={() => void respond(true, [suggestion])}
            disabled={submitting}
          >
            Always allow
          </Button>
        ))}
        <Button size="sm" onClick={() => void respond(true)} disabled={submitting}>
          Allow
        </Button>
      </div>
      </div>
    </BlockingPromptCard>
  );
}

function TmuxElicitationCard({
  elicitation,
  sessionKey,
  onRespond,
}: {
  elicitation: TmuxPendingElicitation;
  sessionKey: string;
  onRespond: (
    action: "accept" | "decline" | "cancel",
    content?: Record<string, string>,
  ) => Promise<void> | void;
}) {
  const fields = useMemo(
    () => elicitationSchemaFields(elicitation.requestedSchema),
    [elicitation.requestedSchema],
  );
  // Typed field values survive the tab unmounting; claudeTmuxStore clears the
  // draft when the elicitation resolves or is withdrawn.
  const [values, setValues] = usePromptDraftField<Record<string, string>>(
    tmuxElicitationDraftKey(sessionKey, elicitation.eventId),
    "values",
    () => ({}),
  );
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // A draft created by an older renderer may contain a value whose schema now
  // marks it secret. Scrub that legacy copy as soon as the card mounts; current
  // secret edits never enter the draft store in the first place.
  useEffect(() => {
    const sensitiveKeys = fields
      .filter((field) => field.sensitive)
      .map((field) => field.key);
    if (!sensitiveKeys.some((key) => Object.hasOwn(values, key))) return;
    setValues((previous) => {
      const next = { ...previous };
      for (const key of sensitiveKeys) delete next[key];
      return next;
    });
  }, [fields, setValues, values]);
  const resolvedValues = {
    ...Object.fromEntries(
      Object.entries(values).filter(([key]) =>
        !fields.some((field) => field.key === key && field.sensitive)),
    ),
    ...secretValues,
  };
  const respond = async (
    action: "accept" | "decline" | "cancel",
    content?: Record<string, string>,
  ) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onRespond(action, content);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BlockingPromptCard
      title="MCP server requested input"
      description={elicitation.message}
      meta={elicitation.mcpServerName}
      expiresAt={elicitation.expiresAt}
      state={submitting ? "submitting" : "pending"}
      aria-label="Claude MCP input request"
      arrivalAnnouncement="Claude is waiting for MCP input."
      className="mb-3"
    >
      <div className="px-3 py-3">
      <div className="text-sm font-medium mb-1">{elicitation.mcpServerName}</div>
      {elicitation.url && (
        <div className="mb-3 text-xs font-mono break-all rounded border border-border bg-background/60 px-2 py-1.5">
          {elicitation.url}
        </div>
      )}
      {fields.length > 0 && (
        <div className="space-y-2 mb-3">
          {fields.map((field) => (
            <label key={field.key} className="block text-xs">
              <span className="mb-1 block text-muted-foreground">{field.label}</span>
              <input
                value={(field.sensitive ? secretValues : values)[field.key] ?? ""}
                onChange={(e) => {
                  const setter = field.sensitive ? setSecretValues : setValues;
                  setter((prev) => ({ ...prev, [field.key]: e.target.value }));
                }}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none"
                type={field.sensitive ? "password" : "text"}
              />
              {field.sensitive && (
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Secret input stays only in this card and is lost if you leave it.
                </span>
              )}
            </label>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void respond("cancel")} disabled={submitting}>
          Cancel
        </Button>
        <Button variant="outline" size="sm" onClick={() => void respond("decline")} disabled={submitting}>
          Decline
        </Button>
        <Button size="sm" onClick={() => void respond("accept", resolvedValues)} disabled={submitting}>
          Submit
        </Button>
      </div>
      </div>
    </BlockingPromptCard>
  );
}

// ─── In-TUI selection prompt controls ───────────────────────────────────────

const SELECTION_PROMPT_HINT =
  /Enter\s+to\s+(?:select|confirm)|Tab\/Arrow\s+keys\s+to\s+navigate|Esc\s+to\s+cancel/i;

export function parseTmuxSelectionPrompt(
  snapshot: string,
): TmuxSelectionPrompt | null {
  if (!SELECTION_PROMPT_HINT.test(snapshot)) return null;

  const lines = snapshot.split(/\r?\n/).map((line) => stripAnsi(line).trimEnd());
  const hintIndex = findLastIndex(lines, (line) =>
    SELECTION_PROMPT_HINT.test(line),
  );
  if (hintIndex < 0) return null;

  let blockEnd = hintIndex;
  while (blockEnd > 0 && lines[blockEnd - 1]?.trim() === "") {
    blockEnd -= 1;
  }

  let blockStart = blockEnd;
  let sawOption = false;
  while (blockStart > 0) {
    const line = lines[blockStart - 1] ?? "";
    if (parseTmuxSelectionOptionLine(line)) {
      sawOption = true;
      blockStart -= 1;
      continue;
    }
    if (sawOption && /^\s+\S/.test(line)) {
      blockStart -= 1;
      continue;
    }
    break;
  }

  const options: TmuxSelectionOption[] = [];
  let selectedOptionIndex = -1;

  for (const line of lines.slice(blockStart, blockEnd)) {
    const parsed = parseTmuxSelectionOptionLine(line);
    if (!parsed) {
      const continuation = line.trim();
      const previous = options[options.length - 1];
      if (continuation && previous) {
        previous.label = `${previous.label} ${continuation}`;
      }
      continue;
    }

    const { prefix, number, label } = parsed;

    const selected = /[>›❯▸➜→]/.test(prefix);
    const optionIndex = options.length;
    if (selected) selectedOptionIndex = optionIndex;
    options.push({ number, label, optionIndex, selected });
  }

  if (options.length === 0) return null;
  const hintLine = lines[hintIndex] ?? "";
  const hasNavigationHint =
    /(?:Tab\/Arrow|Arrow\s+keys?|[↑↓].*navigate|navigate)/i.test(hintLine);
  return {
    question: parseTmuxSelectionQuestion(lines, blockStart),
    options,
    selectedOptionIndex: selectedOptionIndex >= 0 ? selectedOptionIndex : 0,
    inputMode:
      /Enter\s+to\s+confirm/i.test(hintLine) && !hasNavigationHint
        ? "number"
        : "navigate",
  };
}

function selectionPromptNavigationKeys(
  prompt: TmuxSelectionPrompt,
  optionIndex: number,
): string[] {
  const delta = optionIndex - prompt.selectedOptionIndex;
  const navKey = delta > 0 ? "Down" : "Up";
  return [...Array.from({ length: Math.abs(delta) }, () => navKey), "Enter"];
}

function selectionPromptSubmitKeys(
  prompt: TmuxSelectionPrompt,
  optionIndex: number,
): string[] {
  const option = prompt.options[optionIndex];
  if (!option) return [];
  if (prompt.inputMode === "number") {
    return option.number.toString().split("");
  }
  if (optionIndex === prompt.selectedOptionIndex) {
    return ["Enter"];
  }
  return selectionPromptNavigationKeys(prompt, optionIndex);
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i]!)) return i;
  }
  return -1;
}

function parseTmuxSelectionOptionLine(
  line: string,
): { prefix: string; number: number; label: string } | null {
  const match = line.match(/^(\s*(?:[>›❯▸➜→]\s*)?)(\d+)\.\s+(.+?)\s*$/);
  if (!match) return null;

  const prefix = match[1] ?? "";
  const number = Number.parseInt(match[2] ?? "", 10);
  const label = (match[3] ?? "").trim();
  if (!Number.isFinite(number) || !label) return null;

  return { prefix, number, label };
}

function parseTmuxSelectionQuestion(
  lines: string[],
  optionBlockStart: number,
): string | null {
  let questionEnd = optionBlockStart;
  while (questionEnd > 0 && lines[questionEnd - 1]?.trim() === "") {
    questionEnd -= 1;
  }

  let questionStart = questionEnd;
  while (questionStart > 0 && lines[questionStart - 1]?.trim() !== "") {
    questionStart -= 1;
  }

  if (isBareContextPointer(lines.slice(questionStart, questionEnd))) {
    questionStart = expandTmuxSelectionQuestionStart(lines, questionStart);
  }
  while (
    questionStart < questionEnd &&
    isTmuxSelectionPromptBoundaryLine(lines[questionStart]?.trim() ?? "")
  ) {
    questionStart += 1;
  }

  const question = lines
    .slice(questionStart, questionEnd)
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return question.length > 0 ? question : null;
}

function isBareContextPointer(lines: string[]): boolean {
  const text = lines.map((line) => line.trim()).filter(Boolean).join(" ");
  return /^https?:\/\/\S+$/i.test(text);
}

function expandTmuxSelectionQuestionStart(
  lines: string[],
  questionStart: number,
): number {
  let expandedStart = questionStart;
  let cursor = questionStart;

  while (cursor > 0) {
    let previousEnd = cursor;
    while (previousEnd > 0 && lines[previousEnd - 1]?.trim() === "") {
      previousEnd -= 1;
    }
    if (previousEnd <= 0) break;

    let previousStart = previousEnd;
    while (previousStart > 0 && lines[previousStart - 1]?.trim() !== "") {
      previousStart -= 1;
    }

    const rawParagraph = lines
      .slice(previousStart, previousEnd)
      .map((line) => line.trim())
      .filter(Boolean);
    const boundaryIndex = findLastIndex(
      rawParagraph,
      isTmuxSelectionPromptBoundaryLine,
    );
    const paragraph =
      boundaryIndex >= 0 ? rawParagraph.slice(boundaryIndex + 1) : rawParagraph;
    if (!isTmuxSelectionPromptContextParagraph(paragraph)) break;

    expandedStart =
      boundaryIndex >= 0 ? previousStart + boundaryIndex + 1 : previousStart;
    cursor = expandedStart;
    if (boundaryIndex >= 0) break;
  }

  return expandedStart;
}

function isTmuxSelectionPromptContextParagraph(lines: string[]): boolean {
  if (lines.length === 0) return false;
  const text = lines.join(" ");
  if (lines.every(isTmuxSelectionPromptBoundaryLine)) return false;
  if (/^\[[^\]]+\]/.test(text)) return false;
  if (/^[^@\s]+@[^$#]+[$#]\s*$/.test(text)) return false;
  if (lines.every((line) => /^\d+\.\s+/.test(line))) return false;
  return true;
}

function isTmuxSelectionPromptBoundaryLine(line: string): boolean {
  return /^-{6,}$/.test(line);
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function pendingSnapshotFromHooks(hooks: TmuxPendingHook[]) {
  const approvals: TmuxPendingApproval[] = [];
  const questions: TmuxPendingQuestion[] = [];
  const plans: TmuxPendingPlan[] = [];
  const permissions: TmuxPendingPermission[] = [];
  const elicitations: TmuxPendingElicitation[] = [];

  for (const hook of hooks) {
    const timing = hookTiming(hook);
    if (hook.kind === "PreToolUse") {
      const toolName = hookToolName(hook.payload);
      if (toolName === "AskUserQuestion") {
        questions.push(payloadToQuestion(hook.id, hook.payload, timing));
      } else if (toolName === "ExitPlanMode") {
        plans.push(payloadToPlan(hook.id, hook.payload, timing));
      } else {
        approvals.push(payloadToApproval(hook.id, hook.payload, timing));
      }
    } else if (hook.kind === "PermissionRequest") {
      permissions.push(payloadToPermission(hook.id, hook.payload, timing));
    } else if (hook.kind === "Elicitation") {
      elicitations.push(payloadToElicitation(hook.id, hook.payload, timing));
    }
  }

  return { approvals, questions, plans, permissions, elicitations };
}

function hookTiming(hook: TmuxPendingHook): {
  requestedAt?: number;
  expiresAt?: number;
} {
  return {
    ...(hook.requestedAt !== undefined ? { requestedAt: hook.requestedAt } : {}),
    ...(hook.expiresAt !== undefined ? { expiresAt: hook.expiresAt } : {}),
  };
}

function shouldAutoAllowPermissionHook(hook: TmuxPendingHook): boolean {
  return hook.kind === "PermissionRequest" && isQuestionPermissionPayload(hook.payload);
}

function isQuestionPermissionPayload(payload: unknown): boolean {
  return hookToolName(payload) === "AskUserQuestion";
}

async function autoAllowPermissionHook(
  tabId: string,
  environmentId: string,
  eventId: string,
  payload: unknown,
): Promise<void> {
  const permission = payloadToPermission(eventId, payload);
  await replyHook(
    tabId,
    "PermissionRequest",
    eventId,
    permissionRequestResponse(permission, true),
    environmentId,
  );
}

function selectionPromptToQuestion(
  prompt: TmuxSelectionPrompt,
  tabId: string,
) {
  return {
    id: selectionPromptKey(prompt),
    sessionId: tabId,
    toolUseId: selectionPromptKey(prompt),
    questions: [
      {
        question: prompt.question ?? "Choose an option",
        header: "Claude is asking for a choice",
        options: prompt.options.map((option) => ({
          label: option.label,
          value: selectionPromptOptionValue(option),
        })),
        multiSelect: false,
      },
    ],
  };
}

function selectionPromptInitialAnswer(prompt: TmuxSelectionPrompt): string[] {
  const selected = prompt.options[prompt.selectedOptionIndex];
  return selected ? [selectionPromptOptionValue(selected)] : [];
}

function selectionPromptOptionValue(option: TmuxSelectionOption): string {
  return `${option.optionIndex}:${option.number}:${option.label}`;
}

function selectionPromptKey(prompt: TmuxSelectionPrompt): string {
  return [
    "tmux-selection",
    prompt.inputMode,
    prompt.selectedOptionIndex,
    prompt.question ?? "",
    ...prompt.options.map((option) => `${option.number}:${option.label}`),
  ].join("|");
}

function hookToolName(payload: unknown): string | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const value = p.tool_name ?? p.toolName;
  return typeof value === "string" ? value : null;
}

function questionAnswersToRecord(
  questions: TmuxPendingQuestion["questions"],
  answers: string[][],
): Record<string, string> {
  const mapped: Record<string, string> = {};
  questions.forEach((question, index) => {
    mapped[question.question] = serializeClaudeQuestionAnswer(
      answers[index] ?? [],
      question.multiSelect === true,
    );
  });
  return mapped;
}

function preToolAllow(updatedInput: Record<string, unknown>) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  };
}

function preToolDeny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function permissionRequestResponse(
  permission: TmuxPendingPermission,
  allow: boolean,
  updatedPermissions?: unknown[],
) {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: allow
        ? {
            behavior: "allow",
            updatedInput: permission.toolInput,
            ...(updatedPermissions ? { updatedPermissions } : {}),
          }
        : {
            behavior: "deny",
            message: "Permission denied by user.",
          },
    },
  };
}

function elicitationResponse(
  action: "accept" | "decline" | "cancel",
  content?: Record<string, string>,
) {
  return {
    hookSpecificOutput: {
      hookEventName: "Elicitation",
      action,
      ...(action === "accept" ? { content: content ?? {} } : {}),
    },
  };
}

function elicitationSchemaFields(schema: Record<string, unknown> | null): Array<{
  key: string;
  label: string;
  sensitive: boolean;
}> {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") return [];
  return Object.entries(properties as Record<string, unknown>).map(([key, raw]) => {
    const field = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const title = typeof field.title === "string" ? field.title : key;
    const format = typeof field.format === "string" ? field.format : "";
    const sensitiveMarker = `${key} ${title} ${format}`;
    return {
      key,
      label: title,
      sensitive:
        field.writeOnly === true
        || field.sensitive === true
        || /password|passphrase|secret|token|credential|api[\s_-]*key|private[\s_-]*key/i
          .test(sensitiveMarker),
    };
  });
}

function tmuxFileMentionPath(
  relativePath: string,
  containerId?: string,
  worktreePath?: string,
): string | null {
  if (relativePath.startsWith("/")) {
    return escapePathForTerminalInput(relativePath);
  }

  const normalizedPath = relativePath.replace(/^\/+/, "");
  if (!normalizedPath) return null;

  const basePath = containerId
    ? "/workspace"
    : worktreePath?.replace(/\/+$/, "");
  if (!basePath) return normalizedPath;

  return escapePathForTerminalInput(`${basePath}/${normalizedPath}`);
}

function serializeTmuxFileMentions(
  text: string,
  mentions: FileMention[],
  containerId?: string,
  worktreePath?: string,
): string {
  if (!text.includes("@") || mentions.length === 0) return text;

  let result = text;
  const sortedMentions = [...mentions].sort(
    (a, b) => b.relativePath.length - a.relativePath.length,
  );

  for (const mention of sortedMentions) {
    const mentionPath = tmuxFileMentionPath(
      mention.relativePath,
      containerId,
      worktreePath,
    );
    if (!mentionPath) continue;
    result = result.replace(
      new RegExp(`@${escapeRegExp(mention.relativePath)}(?=\\s|$)`, "g"),
      mentionPath,
    );
  }

  return result;
}

function buildTmuxPromptWithAttachments(
  text: string,
  attachments: TmuxAttachment[],
  containerId?: string,
): string {
  if (attachments.length === 0) return text;

  const attachmentList = attachments
    .map((attachment) => {
      const attachmentPath = containerId
        ? attachment.path
        : escapePathForTerminalInput(attachment.path);
      return `- ${attachment.name}: ${attachmentPath}`;
    })
    .join("\n");
  const attachmentText =
    `Attached images have been saved in the workspace. Use these image paths as task context:\n${attachmentList}`;

  return text ? `${text}\n\n${attachmentText}` : attachmentText;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Compose bar ─────────────────────────────────────────────────────────────

const EMPTY_TMUX_ATTACHMENTS: TmuxAttachment[] = [];
const EMPTY_TMUX_MENTIONS: FileMention[] = [];
const EMPTY_TMUX_QUEUE: TmuxQueuedMessage[] = [];

interface TmuxComposeBarProps {
  sessionKey: string;
  containerId?: string;
  worktreePath?: string;
  disabled: boolean;
  busy: boolean;
  submitting: boolean;
  autoFocus?: boolean;
  onSubmit: (text: string, attachments: TmuxAttachment[]) => Promise<boolean> | boolean | void;
  onQueue?: (text: string, attachments: TmuxAttachment[]) => Promise<void> | void;
  onQueueError?: (message: string) => void;
  queueLength?: number;
  showAddressAll?: boolean;
  onAddressAll?: () => void;
  onInterrupt: () => void;
  models: ClaudeModel[];
  selectedModel: string;
  onSelectModel: (id: string) => void;
  selectedEffort: ClaudeEffortLevel;
  effortOptions: ClaudeEffortLevel[];
  onSelectEffort: (level: ClaudeEffortLevel) => void;
  fastModeEnabled: boolean | null;
  fastModeAvailable: boolean;
  onSelectFastMode: (enabled: boolean) => void;
  planMode: boolean;
  onTogglePlanMode: (v: boolean) => void;
  modelDisabled: boolean;
  modelSwitching: boolean;
  effortSwitching: boolean;
  planLocked: boolean;
  layout?: "bottom" | "centered";
}

function TmuxComposeBar({
  sessionKey,
  containerId,
  worktreePath,
  disabled,
  busy,
  submitting,
  autoFocus,
  onSubmit,
  onQueue,
  onQueueError,
  queueLength = 0,
  showAddressAll = false,
  onAddressAll,
  onInterrupt,
  models,
  selectedModel,
  onSelectModel,
  selectedEffort,
  effortOptions,
  onSelectEffort,
  fastModeEnabled,
  fastModeAvailable,
  onSelectFastMode,
  planMode,
  onTogglePlanMode,
  modelDisabled,
  modelSwitching,
  effortSwitching,
  planLocked,
  layout = "bottom",
}: TmuxComposeBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const prevFileMentionMenuOpen = useRef(false);
  const pendingCursorPositionRef = useRef<number | null>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const [queueSubmitting, setQueueSubmitting] = useState(false);
  const queueSubmittingRef = useRef(false);
  const value = useClaudeTmuxStore((state) => state.draftText.get(sessionKey) ?? "");
  const fileMentions = useClaudeTmuxStore(
    useCallback(
      (state) => state.draftMentions.get(sessionKey) ?? EMPTY_TMUX_MENTIONS,
      [sessionKey],
    ),
  );
  const attachments = useClaudeTmuxStore(
    useCallback(
      (state) => state.attachments.get(sessionKey) ?? EMPTY_TMUX_ATTACHMENTS,
      [sessionKey],
    ),
  );
  const queuedMessages = useClaudeTmuxStore(
    useCallback(
      (state) => state.messageQueue.get(sessionKey) ?? EMPTY_TMUX_QUEUE,
      [sessionKey],
    ),
  );
  const setValue = useClaudeTmuxStore((state) => state.setDraftText);
  const setFileMentions = useClaudeTmuxStore((state) => state.setDraftMentions);
  const addAttachmentToStore = useClaudeTmuxStore((state) => state.addAttachment);
  const removeAttachmentFromStore = useClaudeTmuxStore((state) => state.removeAttachment);
  const clearAttachments = useClaudeTmuxStore((state) => state.clearAttachments);
  const modelObj = useMemo(
    () => getTmuxModel(selectedModel, models),
    [selectedModel, models],
  );

  // Slash command menu state. The list is static (claude builtins) — see
  // TMUX_BUILTIN_SLASH_COMMANDS at the top of the file.
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const { searchFiles, error: fileSearchError, refresh: refreshFileTree } =
    useFileSearch(containerId, worktreePath, false);
  const {
    isMenuOpen: fileMentionMenuOpen,
    selectedIndex: fileMentionSelectedIndex,
    filteredFiles,
    handleCursorChange: detectFileMention,
    handleKeyDown: handleFileMentionKeyDown,
    closeMenu: closeFileMentionMenu,
  } = useFileMentions({ searchFiles });

  const filteredSlashCommands = useMemo(() => {
    if (!value.startsWith("/")) return [];
    // Filter on everything between "/" and the first space (or end).
    const spaceIdx = value.indexOf(" ");
    const filter = (spaceIdx === -1 ? value.slice(1) : value.slice(1, spaceIdx))
      .toLowerCase();
    return TMUX_BUILTIN_SLASH_COMMANDS.filter((cmd) =>
      cmd.name.slice(1).toLowerCase().includes(filter),
    );
  }, [value]);

  // Open/close the menu based on whether the input *currently* looks like
  // the start of a slash command (no space yet → still typing the command
  // name; space typed → user has moved on to arguments, hide the menu).
  useEffect(() => {
    if (fileMentionMenuOpen) {
      setSlashMenuOpen(false);
    }
  }, [fileMentionMenuOpen]);

  useEffect(() => {
    if (fileSearchError) {
      console.debug("[ClaudeTmuxChatTab] Failed to load files for @mentions", fileSearchError);
    }
  }, [fileSearchError]);

  useEffect(() => {
    const wasOpen = prevFileMentionMenuOpen.current;
    prevFileMentionMenuOpen.current = fileMentionMenuOpen;
    if (!wasOpen && fileMentionMenuOpen) {
      refreshFileTree();
    }
  }, [fileMentionMenuOpen, refreshFileTree]);

  useLayoutEffect(() => {
    const cursorPosition = pendingCursorPositionRef.current;
    const textarea = textareaRef.current;
    if (cursorPosition === null || !textarea) return;

    textarea.focus();
    textarea.setSelectionRange(cursorPosition, cursorPosition);
    pendingCursorPositionRef.current = null;
  }, [value]);

  useEffect(() => {
    if (!value.startsWith("/")) {
      setSlashMenuOpen(false);
      return;
    }
    const hasSpace = value.indexOf(" ") !== -1;
    if (hasSpace) {
      setSlashMenuOpen(false);
      return;
    }
    setSlashMenuOpen(true);
    setSlashSelectedIndex((prev) =>
      prev < filteredSlashCommands.length ? prev : 0,
    );
  }, [value, filteredSlashCommands.length]);

  // Auto-grow textarea, bounded.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 12 * 20 + 16)}px`;
  }, [value]);

  const selectSlashCommand = (command: SlashCommand) => {
    // Drop the user back in the input after the command + a space so they
    // can type any arguments (e.g. `/model opus`) before pressing Enter.
    setValue(sessionKey, command.name + " ");
    setSlashMenuOpen(false);
    textareaRef.current?.focus();
  };

  const updateFileMentionDetection = (position: number, currentValue: string) => {
    detectFileMention(position, currentValue);
  };

  const selectFileMention = (file: FileCandidate) => {
    const textarea = textareaRef.current;
    const cursorPosition = textarea?.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPosition);
    const atMatch = textBeforeCursor.match(/@([^\s@]*)$/);
    const atStart = atMatch ? textBeforeCursor.length - atMatch[0].length : cursorPosition;
    const insertedText = `@${file.relativePath} `;
    const nextValue =
      value.slice(0, atStart) + insertedText + value.slice(cursorPosition);

    pendingCursorPositionRef.current = atStart + insertedText.length;
    setValue(sessionKey, nextValue);
    const nextMentions = (() => {
      const current = useClaudeTmuxStore.getState().getDraftMentions(sessionKey);
      if (current.some((mention) => mention.relativePath === file.relativePath)) {
        return current;
      }
      return [
        ...current,
        {
          id: createUuid(),
          filename: file.filename,
          relativePath: file.relativePath,
        },
      ];
    })();
    setFileMentions(sessionKey, nextMentions);
    closeFileMentionMenu();
  };

  const addAttachment = useCallback((attachment: PastedImageAttachment) => {
    addAttachmentToStore(sessionKey, attachment);
  }, [addAttachmentToStore, sessionKey]);

  const removeAttachment = useCallback((id: string) => {
    removeAttachmentFromStore(sessionKey, id);
  }, [removeAttachmentFromStore, sessionKey]);

  useNativeComposeBarPaste({
    inputContainerRef,
    containerId: containerId ?? null,
    worktreePath,
    onAttach: addAttachment,
    logLabel: "ClaudeTmuxComposeBar",
  });

  const handleSubmit = async () => {
    if (submitting || queueSubmittingRef.current || disabled) return;
    const serializedText = serializeTmuxFileMentions(
      value.trim(),
      fileMentions,
      containerId,
      worktreePath,
    );
    if (!serializedText && attachments.length === 0) return;

    if (busy) {
      if (!onQueue) return;
      queueSubmittingRef.current = true;
      setQueueSubmitting(true);
      try {
        await onQueue(serializedText, attachments);
        setValue(sessionKey, "");
        setFileMentions(sessionKey, []);
        clearAttachments(sessionKey);
      } catch {
        // The parent reports the backend error. Keep the draft intact so the
        // user can retry without reconstructing the prompt or attachments.
      } finally {
        queueSubmittingRef.current = false;
        setQueueSubmitting(false);
      }
      return;
    }

    const result = await onSubmit(serializedText, attachments);
    if (result !== false) {
      setValue(sessionKey, "");
      setFileMentions(sessionKey, []);
      clearAttachments(sessionKey);
    }
  };

  const handleQueuedMessageClick = useCallback(
    async (message: TmuxQueuedMessage) => {
      // Editing loads the prompt into the composer, so anything already there
      // would be destroyed. This used to return silently, which read as the
      // click simply not working.
      if (value.trim() || attachments.length > 0) {
        throw composerOccupiedError();
      }
      try {
        const removed = await removeAgentPrompt<TmuxQueuedMessage>(
          "claude-tmux",
          sessionKey,
          message.id,
        );
        if (!removed) return;
        setValue(sessionKey, removed.text);
        setFileMentions(sessionKey, []);
        clearAttachments(sessionKey);
        for (const attachment of removed.attachments) {
          addAttachmentToStore(sessionKey, attachment);
        }
        setQueueDialogOpen(false);
      } catch (error) {
        onQueueError?.(
          `Failed to edit queued prompt: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
      }
    },
    [
      addAttachmentToStore,
      attachments.length,
      clearAttachments,
      onQueueError,
      sessionKey,
      setFileMentions,
      setValue,
      value,
    ],
  );

  const handleMoveQueuedMessage = useCallback(
    async (fromIndex: number, toIndex: number) => {
      const message = queuedMessages[fromIndex];
      if (!message || Math.abs(toIndex - fromIndex) !== 1) return;
      try {
        await moveAgentPrompt(
          "claude-tmux",
          sessionKey,
          message.id,
          toIndex < fromIndex ? "up" : "down",
        );
      } catch (error) {
        onQueueError?.(
          `Failed to move queued prompt: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
      }
    },
    [onQueueError, queuedMessages, sessionKey],
  );

  const handleRemoveQueuedMessage = useCallback(
    async (messageId: string) => {
      try {
        await removeAgentPrompt("claude-tmux", sessionKey, messageId);
      } catch (error) {
        onQueueError?.(
          `Failed to remove queued prompt: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
      }
    },
    [onQueueError, sessionKey],
  );

  return (
    <div
      className={cn(
        "mx-auto w-[calc(100%_-_0.75rem)] shrink-0 rounded-2xl border border-border/70 bg-zinc-900/90 p-3 shadow-xl shadow-black/20 sm:w-[min(calc(100%_-_2rem),56rem)]",
        layout === "bottom" ? "mb-4 mt-2" : "my-0",
      )}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="relative group flex items-center gap-1.5 px-2 py-1 rounded bg-muted/50 border border-border text-xs"
            >
              <img
                src={attachment.previewUrl}
                alt={attachment.name}
                className="w-6 h-6 object-cover rounded"
              />
              <span className="max-w-[120px] truncate">{attachment.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
                className="ml-1 p-0.5 rounded-full hover:bg-muted"
                title="Remove attachment"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative" ref={inputContainerRef}>
        {fileMentionMenuOpen && (
          <FileMentionMenu
            files={filteredFiles}
            selectedIndex={fileMentionSelectedIndex}
            onSelect={selectFileMention}
            onClose={closeFileMentionMenu}
          />
        )}

        {slashMenuOpen && filteredSlashCommands.length > 0 && (
          <SlashCommandMenu
            commands={filteredSlashCommands}
            selectedIndex={slashSelectedIndex}
            onSelect={selectSlashCommand}
            onClose={() => setSlashMenuOpen(false)}
          />
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            const nextValue = e.target.value;
            setValue(sessionKey, nextValue);
            const currentMentions = useClaudeTmuxStore
              .getState()
              .getDraftMentions(sessionKey);
            setFileMentions(
              sessionKey,
              currentMentions.filter((mention) =>
                nextValue.includes(`@${mention.relativePath}`),
              ),
            );
            updateFileMentionDetection(e.target.selectionStart, nextValue);
          }}
          onClick={(e) => {
            updateFileMentionDetection(e.currentTarget.selectionStart, e.currentTarget.value);
          }}
          onKeyUp={(e) => {
            if (
              e.key === "ArrowLeft" ||
              e.key === "ArrowRight" ||
              e.key === "Home" ||
              e.key === "End" ||
              e.key === "Backspace" ||
              e.key === "Delete"
            ) {
              updateFileMentionDetection(e.currentTarget.selectionStart, e.currentTarget.value);
            }
          }}
          onKeyDown={(e) => {
            if (fileMentionMenuOpen) {
              const handled = handleFileMentionKeyDown(e, selectFileMention);
              if (handled) return;
            }

            // Slash-command menu takes keyboard priority while open.
            if (slashMenuOpen && filteredSlashCommands.length > 0) {
              switch (e.key) {
                case "ArrowDown":
                  e.preventDefault();
                  setSlashSelectedIndex((prev) =>
                    prev < filteredSlashCommands.length - 1 ? prev + 1 : prev,
                  );
                  return;
                case "ArrowUp":
                  e.preventDefault();
                  setSlashSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
                  return;
                case "Tab": {
                  const cmd = filteredSlashCommands[slashSelectedIndex];
                  if (cmd) {
                    e.preventDefault();
                    selectSlashCommand(cmd);
                  }
                  return;
                }
                case "Enter": {
                  // Enter selects the highlighted command (no submit yet —
                  // user may want to add arguments before sending).
                  if (e.shiftKey || e.metaKey || e.ctrlKey) break;
                  const cmd = filteredSlashCommands[slashSelectedIndex];
                  if (cmd) {
                    e.preventDefault();
                    selectSlashCommand(cmd);
                    return;
                  }
                  break;
                }
                case "Escape":
                  e.preventDefault();
                  setSlashMenuOpen(false);
                  return;
              }
            }

            // Enter submits; Shift+Enter (and Cmd/Ctrl+Enter, for muscle
            // memory) inserts a newline.
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.metaKey &&
              !e.ctrlKey
            ) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={
            disabled
              ? "Session not running"
              : "Ask Claude anything… (@ to mention, / for commands)"
          }
          disabled={disabled || submitting || queueSubmitting}
          rows={2}
          autoFocus={autoFocus && !isMobile}
          className={cn(
            "w-full resize-none bg-transparent text-sm leading-5",
            "px-1 py-1 focus:outline-none placeholder:text-muted-foreground/60",
            "disabled:opacity-60",
          )}
          style={{ minHeight: 28, maxHeight: 12 * 20 + 16 }}
        />
      </div>

      <div className="flex min-w-0 items-center gap-1 overflow-x-auto pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button"
          disabled
          className="p-1.5 rounded text-muted-foreground/40 cursor-not-allowed"
          title="Paste an image into the input to attach it"
        >
          <Plus className="w-4 h-4" />
        </button>

        {/* The combined picker is selectable before launch and sends the same
            model/effort commands to the running tmux pane after launch. */}
        <NativeModelPicker
          models={models.map((model) => ({
            id: model.id,
            label: model.name,
            description: model.description,
          }))}
          selectedModelId={selectedModel}
          selectedModelLabel={modelObj.name}
          onModelChange={onSelectModel}
          reasoningOptions={effortOptions.map((level) => ({
            id: level,
            label: EFFORT_LABELS[level],
            description: EFFORT_DESCRIPTIONS[level],
            annotation: level === DEFAULT_EFFORT ? "default" : undefined,
          }))}
          selectedReasoningId={selectedEffort}
          selectedReasoningLabel={effortOptions.length > 0 ? EFFORT_LABELS[selectedEffort] : undefined}
          onReasoningChange={(level) => onSelectEffort(level as ClaudeEffortLevel)}
          fastModeEnabled={fastModeEnabled}
          fastModeAvailable={fastModeAvailable}
          onFastModeChange={onSelectFastMode}
          disabled={modelDisabled}
          title={
            modelSwitching
              ? "Switching Claude model"
              : effortSwitching
                ? "Switching effort level"
                : modelDisabled
                  ? "Wait for Claude to finish before changing model settings"
                  : disabled
                    ? "Select model settings for the next tmux launch"
                    : "Switch model settings for this tmux session"
          }
        />

        {/* Plan / Build mode */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={planLocked}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-60"
              title={
                planLocked
                  ? "Wait for the Claude session to be idle before changing modes"
                  : "Switch the running Claude session between build and plan mode"
              }
            >
              <ChevronDown className="w-3 h-3" />
              <span>{planMode ? "Plan" : "Build"}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => onTogglePlanMode(false)}>
              <div className="w-4 h-4 shrink-0 mr-2">
                {!planMode && <Check className="w-4 h-4 text-primary" />}
              </div>
              Build
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTogglePlanMode(true)}>
              <div className="w-4 h-4 shrink-0 mr-2">
                {planMode && <Check className="w-4 h-4 text-primary" />}
              </div>
              Plan
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1" />

        {showAddressAll && !busy && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => onAddressAll?.()}
            disabled={disabled || submitting}
            className="h-7 rounded-full px-3 text-xs"
            title="Send the review follow-up prompt"
          >
            Address all
          </Button>
        )}

        {queueLength > 0 && (
          <button
            type="button"
            onClick={() => setQueueDialogOpen(true)}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground bg-muted/50 hover:bg-muted transition-colors"
            title="View queued prompts"
          >
            <span>+{queueLength} queued</span>
          </button>
        )}

        {/* Send / Stop button */}
        <Button
          size="sm"
          onClick={busy && !value.trim() && attachments.length === 0 ? onInterrupt : handleSubmit}
          disabled={
            disabled ||
            submitting ||
            queueSubmitting ||
            (!busy && !value.trim() && attachments.length === 0)
          }
          className="h-7 w-7 p-0 rounded-full"
          title={
            busy
              ? value.trim() || attachments.length > 0
                ? "Add to queue"
                : "Interrupt current response"
              : "Send (↵)"
          }
        >
          {busy && !value.trim() && attachments.length === 0 ? (
            <Square className="w-3.5 h-3.5" />
          ) : (
            <ArrowUp className="w-4 h-4" />
          )}
        </Button>
      </div>

      <Dialog open={queueDialogOpen} onOpenChange={setQueueDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Queued Prompts</DialogTitle>
            <DialogDescription>
              Review pending prompts. Click one to edit it, or reorder and remove items.
            </DialogDescription>
          </DialogHeader>

          {queuedMessages.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Queue is empty.
            </div>
          ) : (
            <ScrollArea className="max-h-[380px] pr-3">
              <div className="space-y-2">
                {queuedMessages.map((message, index) => (
                  <div
                    key={message.id}
                    className="rounded-md border border-border bg-muted/20 p-3"
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 shrink-0 text-xs font-medium text-muted-foreground">
                        #{index + 1}
                      </div>

                      <div className="min-w-0 flex-1">
                        <p
                          className="-mx-1 cursor-pointer rounded px-1 text-sm whitespace-pre-wrap break-words line-clamp-4 transition-colors hover:bg-muted/50"
                          onClick={() => handleQueuedMessageClick(message)}
                          title="Click to edit this message"
                        >
                          {message.text}
                        </p>
                        {message.attachments.length > 0 && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {message.attachments.length} attachment
                            {message.attachments.length === 1 ? "" : "s"}
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-col gap-1">
                        <button
                          type="button"
                          onClick={() => handleMoveQueuedMessage(index, index - 1)}
                          disabled={index === 0}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Move up"
                        >
                          <ChevronUp className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveQueuedMessage(index, index + 1)}
                          disabled={index === queuedMessages.length - 1}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Move down"
                        >
                          <ChevronDown className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveQueuedMessage(message.id)}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                          title="Remove queued prompt"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Approval card (only fires when claude permission flow somehow surfaces) ─

function ApprovalCard({
  approval,
  onApprove,
  onDeny,
}: {
  approval: {
    eventId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    expiresAt?: number;
  };
  onApprove: () => Promise<void> | void;
  onDeny: () => Promise<void> | void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const respond = async (action: () => Promise<void> | void) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await action();
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <BlockingPromptCard
      title="Claude wants to use a tool"
      expiresAt={approval.expiresAt}
      state={submitting ? "submitting" : "pending"}
      aria-label={`Claude wants to use ${approval.toolName}`}
      arrivalAnnouncement="Claude is waiting for a tool decision."
      className="mb-3"
    >
      <div className="px-3 py-3">
      <div className="text-sm font-mono text-amber-200 mb-2">
        {approval.toolName}
      </div>
      <ApprovalToolInput
        toolName={approval.toolName}
        toolInput={approval.toolInput}
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void respond(onApprove)}
          disabled={submitting}
          className="flex-1 px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium"
        >
          Allow
        </button>
        <button
          type="button"
          onClick={() => void respond(onDeny)}
          disabled={submitting}
          className="flex-1 px-3 py-1.5 rounded bg-red-800 hover:bg-red-700 text-white text-sm font-medium"
        >
          Deny
        </button>
      </div>
      </div>
    </BlockingPromptCard>
  );
}

/**
 * Renders tool input as labeled fields rather than raw JSON. We special-case
 * the common Claude tools (Bash, Edit, Write, Read) since their args have
 * conventional shapes; unknown tools fall back to a key/value table.
 */
function ApprovalToolInput({
  toolName,
  toolInput,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
}) {
  const command =
    typeof toolInput.command === "string" ? toolInput.command : null;
  const description =
    typeof toolInput.description === "string" ? toolInput.description : null;
  const filePath =
    typeof toolInput.file_path === "string" ? toolInput.file_path : null;

  // Bash → command + optional description.
  if (toolName === "Bash" && command) {
    return (
      <div className="mb-3 space-y-2">
        {description && (
          <div className="text-xs text-amber-100/80">{description}</div>
        )}
        <pre className="text-xs bg-zinc-950 border border-zinc-800 rounded px-2 py-1 whitespace-pre-wrap break-all font-mono">
          $ {command}
        </pre>
      </div>
    );
  }

  // File-oriented tools → show path + a short content preview if present.
  if (filePath) {
    const preview =
      (typeof toolInput.new_string === "string" && toolInput.new_string) ||
      (typeof toolInput.content === "string" && toolInput.content) ||
      null;
    return (
      <div className="mb-3 space-y-2">
        <div className="text-xs font-mono text-amber-100/90 break-all">
          {filePath}
        </div>
        {preview && (
          <pre className="text-xs bg-zinc-950 border border-zinc-800 rounded px-2 py-1 whitespace-pre-wrap break-all font-mono max-h-40 overflow-auto">
            {preview}
          </pre>
        )}
      </div>
    );
  }

  // Fallback: render keys/values without dumping a single blob of JSON.
  const entries = Object.entries(toolInput);
  if (entries.length === 0) {
    return <div className="mb-3 text-xs text-muted-foreground">(no args)</div>;
  }
  return (
    <div className="mb-3 space-y-1">
      {entries.map(([key, value]) => (
        <div key={key} className="text-xs">
          <span className="font-mono text-amber-300/80">{key}:</span>{" "}
          <span className="font-mono text-amber-100/90 break-all whitespace-pre-wrap">
            {typeof value === "string" ? value : JSON.stringify(value)}
          </span>
        </div>
      ))}
    </div>
  );
}
