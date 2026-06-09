// Claude tmux mode chat tab.
//
// Drives the `claude` CLI under tmux on the host or in a container, and
// surfaces a chat UI by reading the JSONL transcript and listening to
// Claude Code hooks. No Agent SDK required.
//
// Visual parity with the native Claude tab is achieved by reusing the
// `<ClaudeMessage>` renderer; we only build a slim compose bar of our own
// that matches the native styling and adds model / plan-mode controls.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  History,
  Loader2,
  Plus,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useVirtuosoScrollState } from "@/hooks";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
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
import { ClaudeMessage } from "@/components/claude/ClaudeMessage";
import { ClaudeQuestionCard } from "@/components/claude/ClaudeQuestionCard";
import { ClaudeTmuxInteractiveTerminal } from "@/components/claude/ClaudeTmuxInteractiveTerminal";
import { ResumeTmuxSessionDialog } from "@/components/claude/ResumeTmuxSessionDialog";
import { formatElapsed } from "@/lib/format-elapsed";
import {
  parseSlashCommands,
  SlashCommandMenu,
  type SlashCommand,
} from "@/components/claude/SlashCommandMenu";
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
  switchModel,
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
  useClaudeTmuxStore,
  type TmuxPendingApproval,
  type TmuxPendingElicitation,
  type TmuxPendingPermission,
  type TmuxPendingPlan,
  type TmuxPendingQuestion,
  type TmuxAttachment,
  type TmuxQueuedMessage,
} from "@/stores/claudeTmuxStore";
import { collapseTaskToolUpdates } from "@/lib/task-tool-snapshots";
import type { ClaudeEffortLevel, ClaudeModel } from "@/lib/claude-client";
import { useClaudeStore } from "@/stores/claudeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useConfigStore } from "@/stores/configStore";
import { renameEnvironmentFromPrompt, updateGlobalConfig } from "@/lib/tauri";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import type { ClaudeTmuxData } from "@/types/paneLayout";
import type { FileCandidate, FileMention } from "@/types";

interface Props {
  tabId: string;
  data: ClaudeTmuxData;
  isActive: boolean;
  initialPrompt?: string;
  isReviewTab?: boolean;
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
    description: "Opus 4.8 with 1M context · Best for everyday, complex tasks",
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
    description: "Sonnet 4.6 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
  },
  {
    id: "sonnet[1m]",
    name: "Sonnet (1M context)",
    description: "Sonnet 4.6 with 1M context · Draws from usage credits",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
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
  "claude-opus-4-7": "default",
  "claude-opus-4-6": "default",
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

function selectedModelForLaunch(modelId: string): string | undefined {
  return modelId === "default" ? undefined : modelId;
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
 * Prefer the live model list the Claude bridge fetched from the Agent SDK
 * (shared via the claude store) over the static fallback. The launch-only
 * "default" sentinel is guaranteed to be present either way.
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
  initialPrompt,
  isReviewTab = false,
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
  const storeKey = scopedTabState ? stateKey : shouldUseLegacyTabState ? tabId : stateKey;
  const setRunning = useClaudeTmuxStore((s) => s.setRunning);
  const applyTranscriptLine = useClaudeTmuxStore((s) => s.applyTranscriptLine);
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
  const addToQueue = useClaudeTmuxStore((s) => s.addToQueue);
  const removeFromQueue = useClaudeTmuxStore((s) => s.removeFromQueue);
  const clearTabInitialPrompt = usePaneLayoutStore((s) => s.clearTabInitialPrompt);
  const setConfig = useConfigStore((s) => s.setConfig);
  const persistedClaudeModel = useConfigStore((s) => s.config.global.claudeModel);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTui, setShowTui] = useState(false);
  const [interactiveMode, setInteractiveMode] = useState(false);
  const [tuiSnapshot, setTuiSnapshot] = useState<string>("");
  const sdkModels = useClaudeStore((s) => s.models);
  const availableModels = useMemo(() => tmuxModelList(sdkModels), [sdkModels]);
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    resolveTmuxModelPreference(
      useConfigStore.getState().config.global.claudeModel,
      tmuxModelList(useClaudeStore.getState().models),
    ),
  );
  const [modelSwitching, setModelSwitching] = useState(false);
  const [effortSwitching, setEffortSwitching] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [promptControlBusy, setPromptControlBusy] = useState(false);
  const [backendHydrated, setBackendHydrated] = useState(false);
  const startedRef = useRef(false);
  const isProcessingQueueRef = useRef(false);
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
  const displayMessages = useMemo(
    () => collapseTaskToolUpdates(compactConsecutiveAssistantMessages(messages)),
    [messages],
  );
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
  });
  const queueLength = useClaudeTmuxStore(
    useCallback(
      (state) => state.messageQueue.get(storeKey)?.length ?? 0,
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

  useEffect(() => {
    if (hasStarted) return;
    setSelectedModel(
      resolveTmuxModelPreference(persistedClaudeModel, availableModels),
    );
  }, [hasStarted, persistedClaudeModel, availableModels]);

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
  // transcript. Tauri events are only delivered to mounted listeners, so a
  // tmux tab hidden behind another environment can miss transcript updates.
  useEffect(() => {
    let cancelled = false;
    setBackendHydrated(false);

    const hydrate = async () => {
      try {
        const status = await getStatus(tabId, environmentId);
        if (cancelled) return;

        if (status && status.environment_id === environmentId) {
          startedRef.current = Boolean(status.running);
          setRunning(storeKey, status.running, {
            environmentId: status.environment_id,
            sessionId: status.session_id,
            resumed: status.resumed,
          });
          setTabBusy(storeKey, status.busy);

          if (status.session_id) {
            const lines = await getTranscript(tabId, environmentId);
            if (cancelled) return;
            for (const line of lines) {
              applyTranscriptLine(storeKey, line);
            }
            const hooks = await getPendingHooks(tabId, environmentId);
            if (cancelled) return;
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
                      payloadToPermission(hook.id, hook.payload),
                    );
                    setError(String(e));
                  }
                });
              }
            }
          }
        }
      } catch (e) {
        // A missing backend session is not fatal; the auto-start path below
        // still handles new tabs with an initial prompt.
        console.debug("[ClaudeTmuxChatTab] tmux hydrate failed", e);
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
    applyTranscriptLine,
    addPendingPermission,
    replacePendingHooks,
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
          setRunning(storeKey, true, {
            environmentId: ev.environment_id,
            sessionId: ev.session_id,
            resumed: ev.resumed,
          });
          return;
        case "initial-prompt-sent":
          if (ev.environment_id === environmentId) {
            clearTabInitialPrompt(tabId, environmentId);
          }
          return;
        case "stopped":
          setRunning(storeKey, false, { sessionId: null });
          // No claude process means no in-flight turn.
          setTabBusy(storeKey, false);
          return;
        case "transcript-line":
          applyTranscriptLine(storeKey, ev.line);
          break;
        case "hook":
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
              addPendingQuestion(storeKey, payloadToQuestion(ev.event_id, ev.payload));
            } else if (toolName === "ExitPlanMode") {
              addPendingPlan(storeKey, payloadToPlan(ev.event_id, ev.payload));
            } else {
              addPendingApproval(storeKey, payloadToApproval(ev.event_id, ev.payload));
            }
          } else if (ev.event_kind === "PermissionRequest") {
            if (isQuestionPermissionPayload(ev.payload)) {
              void autoAllowPermissionHook(tabId, environmentId, ev.event_id, ev.payload).catch((e) => {
                addPendingPermission(
                  storeKey,
                  payloadToPermission(ev.event_id, ev.payload),
                );
                setError(String(e));
              });
              removePendingPermission(storeKey, ev.event_id);
            } else {
              addPendingPermission(storeKey, payloadToPermission(ev.event_id, ev.payload));
            }
          } else if (ev.event_kind === "Elicitation") {
            addPendingElicitation(storeKey, payloadToElicitation(ev.event_id, ev.payload));
          }
          break;
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
  ]);

  // Common "start the tmux session" path used by both auto-start (initial
  // prompt present) and the explicit "Start fresh" / "Resume" buttons.
  const launchSession = useCallback(
    (resumeSessionId?: string) => {
      if (startedRef.current) return;
      startedRef.current = true;
      startSession(tabId, environmentId, {
        initialPrompt,
        model: selectedModelForLaunch(selectedModel),
        effort: effortOptions.length > 0 ? effectiveEffort : undefined,
        planMode,
        resumeSessionId,
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
      planMode,
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
    if (!showTui && !running) {
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
    const id = setInterval(tick, showTui ? 500 : 1000);
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
      modelSwitching ||
      effortSwitching
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
        if (environment && /^\d{8}-\d{6}$/.test(environment.name)) {
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
    (text: string, attachments: TmuxAttachment[]) => {
      addToQueue(storeKey, {
        id: crypto.randomUUID(),
        text,
        attachments,
      });
    },
    [addToQueue, storeKey],
  );

  const processQueue = useCallback(() => {
    if (isProcessingQueueRef.current) return;
    if (
      !backendHydrated ||
      !running ||
      sending ||
      isThinking ||
      modelSwitching ||
      effortSwitching
    ) {
      return;
    }

    const tmuxState = useClaudeTmuxStore.getState();
    if (
      tmuxState.getDraftText(storeKey).trim().length > 0 ||
      tmuxState.getAttachments(storeKey).length > 0
    ) {
      return;
    }

    const nextMessage = removeFromQueue(storeKey);
    if (!nextMessage) return;

    isProcessingQueueRef.current = true;
    const sendPromise = submitPromptRef.current?.(
      nextMessage.text,
      nextMessage.attachments,
      false,
    );

    if (!sendPromise) {
      isProcessingQueueRef.current = false;
      return;
    }

    sendPromise
      .then((sent) => {
        if (!sent) {
          setError((current) => current ?? "Failed to send queued prompt");
        }
      })
      .catch((e) => {
        setError(
          `Failed to send queued prompt: ${
            e instanceof Error ? e.message : "Unknown error"
          }`,
        );
        setTabBusy(storeKey, false);
      })
      .finally(() => {
        isProcessingQueueRef.current = false;
      });
  }, [
    backendHydrated,
    isThinking,
    modelSwitching,
    effortSwitching,
    removeFromQueue,
    running,
    sending,
    setTabBusy,
    storeKey,
  ]);

  useEffect(() => {
    if (queueLength > 0 && !isQueueBlockedByDraft) {
      processQueue();
    }
  }, [isQueueBlockedByDraft, processQueue, queueLength, isThinking]);

  const promoteNextQueuedPromptToDraft = useCallback(() => {
    const store = useClaudeTmuxStore.getState();
    const hasCurrentDraft =
      store.getDraftText(storeKey).trim().length > 0 ||
      store.getAttachments(storeKey).length > 0;
    if (hasCurrentDraft) return;

    const nextMessage = store.removeFromQueue(storeKey);
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
    if (!running) return;
    setError(null);
    try {
      await interruptSession(tabId, environmentId);
      promoteNextQueuedPromptToDraft();
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
    } catch (e) {
      setError(String(e));
    } finally {
      removePendingApproval(storeKey, eventId);
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
    launchSession(sessionId);
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
    if (modelId === selectedModel || modelSwitching || effortSwitching) return;

    if (modelId === "default" && hasStarted && running) {
      setError("Claude Code's default model can only be selected before launch.");
      return;
    }

    if (!hasStarted || !running) {
      setSelectedModel(modelId);
      clampEffortToModel(modelId);
      void persistSelectedModel(modelId);
      return;
    }

    if (sending || isThinking) return;

    setModelSwitching(true);
    setError(null);
    try {
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
    if (effort === effectiveEffort || effortSwitching || modelSwitching) return;

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
              !running && "opacity-50 cursor-not-allowed",
            )}
            onClick={() => {
              if (running) setInteractiveMode((v) => !v);
            }}
            disabled={!running}
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
            disabled={!running}
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
        <>
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

          {/* Messages */}
          <VirtualizedMessageList
            messages={displayMessages}
            computeItemKey={(_index, message) => message.id}
            renderMessage={(_index, message, previousMessage) => (
              <ClaudeMessage
                message={message}
                previousMessage={previousMessage}
                isStreaming={running}
                containerId={containerId}
              />
            )}
            emptyState={
              !hasPendingHookCards ? (
                showStartScreen ? (
                  <StartScreen
                    onStartFresh={() => launchSession()}
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
              <div className="max-w-3xl mx-auto min-w-0 px-2 @sm:px-4 py-3">
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
                    }}
                    onSubmitAnswers={(answers) => handleQuestionAnswer(q, answers)}
                    onDismiss={() => handleQuestionReject(q)}
                  />
                ))}

                {pendingPlans.map((p) => (
                  <TmuxPlanCard
                    key={p.eventId}
                    plan={p}
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

                {/* "Claude is thinking…" indicator — matches the native tab so the UI
                    looks the same between modes. Shown only while running so a freshly
                    mounted tab without a session doesn't flash a misleading spinner. */}
                {isThinking && running && (
                  <div className="py-2">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span className="text-xs">Claude is thinking...</span>
                      {elapsedSeconds !== null && elapsedSeconds > 0 && (
                        <span className="text-xs text-muted-foreground/50">
                          {formatElapsed(elapsedSeconds)}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            }
            scrollProps={scrollProps}
            virtuosoRef={virtuosoRef}
          />

          {!isAtBottom && (
            <div className="flex justify-end px-4 py-1">
              <button
                type="button"
                onClick={scrollToBottom}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 shadow-sm transition-colors"
                aria-label="Scroll to bottom of conversation"
              >
                <ArrowDown className="w-3.5 h-3.5" />
                <span>Scroll down</span>
              </button>
            </div>
          )}

          {/* Compose bar — stays "busy" for the full turn (HTTP submit + Claude
              processing) so a user can't queue a second message before the
              previous one finishes. Mirrors the spinner condition above. */}
          <TmuxComposeBar
            sessionKey={storeKey}
            containerId={containerId}
            worktreePath={worktreePath}
            disabled={!running}
            busy={isThinking}
            submitting={sending || modelSwitching || effortSwitching}
            autoFocus={isActive}
            onSubmit={handleSubmit}
            onQueue={handleQueue}
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
            planMode={planMode}
            onTogglePlanMode={setPlanMode}
            modelDisabled={
              (hasStarted && !running) ||
              sending ||
              isThinking ||
              modelSwitching ||
              effortSwitching
            }
            modelSwitching={modelSwitching}
            effortSwitching={effortSwitching}
            planLocked={hasStarted}
            defaultModelDisabled={hasStarted && running}
          />
        </>
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
  onRespond,
}: {
  plan: TmuxPendingPlan;
  onRespond: (approved: boolean, feedback?: string) => void;
}) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  return (
    <div className="rounded-lg border border-amber-700/60 bg-amber-950/20 px-3 py-3 mb-3">
      <div className="text-xs uppercase tracking-wide text-amber-300 mb-2">
        Plan ready for review
      </div>
      {plan.planFilePath && (
        <div className="text-xs font-mono text-muted-foreground mb-2 break-all">
          {plan.planFilePath}
        </div>
      )}
      {plan.plan && (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border border-border/70 bg-background/60 p-3 text-sm">
          {plan.plan}
        </pre>
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
            showFeedback ? onRespond(false, feedback) : setShowFeedback(true)
          }
        >
          Request changes
        </Button>
        <Button size="sm" onClick={() => onRespond(true)}>
          Approve plan
        </Button>
      </div>
    </div>
  );
}

function TmuxPermissionCard({
  permission,
  onRespond,
}: {
  permission: TmuxPendingPermission;
  onRespond: (allow: boolean, updatedPermissions?: unknown[]) => void;
}) {
  return (
    <div className="rounded-lg border border-amber-700/60 bg-amber-950/20 px-3 py-3 mb-3">
      <div className="text-xs uppercase tracking-wide text-amber-300 mb-2">
        Claude needs permission
      </div>
      <div className="text-sm font-mono text-amber-100 mb-2">
        {permission.toolName}
      </div>
      <ApprovalToolInput
        toolName={permission.toolName}
        toolInput={permission.toolInput}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => onRespond(false)}>
          Deny
        </Button>
        {permission.permissionSuggestions.map((suggestion, index) => (
          <Button
            key={index}
            variant="outline"
            size="sm"
            onClick={() => onRespond(true, [suggestion])}
          >
            Always allow
          </Button>
        ))}
        <Button size="sm" onClick={() => onRespond(true)}>
          Allow
        </Button>
      </div>
    </div>
  );
}

function TmuxElicitationCard({
  elicitation,
  onRespond,
}: {
  elicitation: TmuxPendingElicitation;
  onRespond: (
    action: "accept" | "decline" | "cancel",
    content?: Record<string, string>,
  ) => void;
}) {
  const fields = elicitationSchemaFields(elicitation.requestedSchema);
  const [values, setValues] = useState<Record<string, string>>({});

  return (
    <div className="rounded-lg border border-purple-700/60 bg-purple-950/20 px-3 py-3 mb-3">
      <div className="text-xs uppercase tracking-wide text-purple-300 mb-2">
        MCP server requested input
      </div>
      <div className="text-sm font-medium mb-1">{elicitation.mcpServerName}</div>
      <div className="text-sm text-muted-foreground mb-3">
        {elicitation.message}
      </div>
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
                value={values[field.key] ?? ""}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                }
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none"
                type={field.sensitive ? "password" : "text"}
              />
            </label>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => onRespond("cancel")}>
          Cancel
        </Button>
        <Button variant="outline" size="sm" onClick={() => onRespond("decline")}>
          Decline
        </Button>
        <Button size="sm" onClick={() => onRespond("accept", values)}>
          Submit
        </Button>
      </div>
    </div>
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
    if (hook.kind === "PreToolUse") {
      const toolName = hookToolName(hook.payload);
      if (toolName === "AskUserQuestion") {
        questions.push(payloadToQuestion(hook.id, hook.payload));
      } else if (toolName === "ExitPlanMode") {
        plans.push(payloadToPlan(hook.id, hook.payload));
      } else {
        approvals.push(payloadToApproval(hook.id, hook.payload));
      }
    } else if (hook.kind === "PermissionRequest") {
      permissions.push(payloadToPermission(hook.id, hook.payload));
    } else if (hook.kind === "Elicitation") {
      elicitations.push(payloadToElicitation(hook.id, hook.payload));
    }
  }

  return { approvals, questions, plans, permissions, elicitations };
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
    mapped[question.question] = (answers[index] ?? []).join(", ");
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
    return {
      key,
      label: title,
      sensitive:
        format.toLowerCase().includes("password") ||
        key.toLowerCase().includes("password") ||
        key.toLowerCase().includes("token"),
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
  onQueue?: (text: string, attachments: TmuxAttachment[]) => void;
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
  planMode: boolean;
  onTogglePlanMode: (v: boolean) => void;
  modelDisabled: boolean;
  modelSwitching: boolean;
  effortSwitching: boolean;
  planLocked: boolean;
  defaultModelDisabled: boolean;
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
  planMode,
  onTogglePlanMode,
  modelDisabled,
  modelSwitching,
  effortSwitching,
  planLocked,
  defaultModelDisabled,
}: TmuxComposeBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const prevFileMentionMenuOpen = useRef(false);
  const pendingCursorPositionRef = useRef<number | null>(null);
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
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
  const removeQueueItem = useClaudeTmuxStore((state) => state.removeQueueItem);
  const moveQueueItem = useClaudeTmuxStore((state) => state.moveQueueItem);
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
          id: crypto.randomUUID(),
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
    if (submitting || disabled) return;
    const serializedText = serializeTmuxFileMentions(
      value.trim(),
      fileMentions,
      containerId,
      worktreePath,
    );
    if (!serializedText && attachments.length === 0) return;

    if (busy) {
      onQueue?.(serializedText, attachments);
      setValue(sessionKey, "");
      setFileMentions(sessionKey, []);
      clearAttachments(sessionKey);
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
    (message: TmuxQueuedMessage) => {
      if (value.trim() || attachments.length > 0) return;
      removeQueueItem(sessionKey, message.id);
      setValue(sessionKey, message.text);
      setFileMentions(sessionKey, []);
      clearAttachments(sessionKey);
      for (const attachment of message.attachments) {
        addAttachmentToStore(sessionKey, attachment);
      }
      setQueueDialogOpen(false);
    },
    [
      addAttachmentToStore,
      attachments.length,
      clearAttachments,
      removeQueueItem,
      sessionKey,
      setFileMentions,
      setValue,
      value,
    ],
  );

  const handleMoveQueuedMessage = useCallback(
    (fromIndex: number, toIndex: number) => {
      moveQueueItem(sessionKey, fromIndex, toIndex);
    },
    [moveQueueItem, sessionKey],
  );

  const handleRemoveQueuedMessage = useCallback(
    (messageId: string) => {
      removeQueueItem(sessionKey, messageId);
    },
    [removeQueueItem, sessionKey],
  );

  return (
    <div className="shrink-0 border-t border-border bg-background p-3">
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
          disabled={disabled || submitting}
          rows={2}
          autoFocus={autoFocus}
          className={cn(
            "w-full resize-none bg-transparent text-sm leading-5",
            "px-1 py-1 focus:outline-none placeholder:text-muted-foreground/60",
            "disabled:opacity-60",
          )}
          style={{ minHeight: 28, maxHeight: 12 * 20 + 16 }}
        />
      </div>

      <div className="flex items-center gap-1 pt-1">
        <button
          type="button"
          disabled
          className="p-1.5 rounded text-muted-foreground/40 cursor-not-allowed"
          title="Paste an image into the input to attach it"
        >
          <Plus className="w-4 h-4" />
        </button>

        {/* Model picker — selectable before launch even while compose is
            disabled, and after launch it sends Claude Code's /model command
            into the running tmux pane. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={modelDisabled}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-60"
              title={
                modelSwitching
                  ? "Switching Claude model"
                  : modelDisabled
                    ? "Wait for Claude to finish before changing the model"
                    : disabled
                      ? "Select the model for the next tmux launch"
                      : "Switch the model for this tmux session"
              }
            >
              <ChevronDown className="w-3 h-3" />
              <span className="max-w-[200px] truncate">{modelObj.name}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[400px] overflow-y-auto min-w-[240px]">
            {models.map((m) => {
              const selected = m.id === selectedModel;
              const optionDisabled = defaultModelDisabled && m.id === "default";
              return (
                <DropdownMenuItem
                  key={m.id}
                  disabled={optionDisabled}
                  onClick={() => {
                    if (!optionDisabled) onSelectModel(m.id);
                  }}
                  className="flex items-start gap-2 py-2"
                >
                  <div className="w-4 h-4 flex-shrink-0 mt-0.5">
                    {selected && <Check className="w-4 h-4 text-primary" />}
                  </div>
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium truncate">
                      {m.name}
                    </span>
                    {m.description && (
                      <span className="text-xs text-muted-foreground line-clamp-2">
                        {m.description}
                      </span>
                    )}
                  </div>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Plan / Build mode */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={planLocked}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-60"
              title={
                planLocked
                  ? "Plan mode is fixed for this tmux session"
                  : "Select the launch mode for the next tmux session"
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

        {/* Reasoning effort — pre-launch it sets the `--effort` launch flag,
            after launch it sends Claude Code's /effort command into the
            running tmux pane. Hidden for models without effort support. */}
        {effortOptions.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                disabled={modelDisabled}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-60"
                title={
                  effortSwitching
                    ? "Switching effort level"
                    : modelDisabled
                      ? "Wait for Claude to finish before changing the effort level"
                      : disabled
                        ? "Select the reasoning effort for the next tmux launch"
                        : "Switch the reasoning effort for this tmux session"
                }
              >
                <ChevronDown className="w-3 h-3" />
                <span>{EFFORT_LABELS[selectedEffort]}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[280px]">
              {effortOptions.map((level) => (
                <DropdownMenuItem
                  key={level}
                  onClick={() => onSelectEffort(level)}
                  className="flex items-start gap-2 py-2"
                >
                  <div className="w-4 h-4 shrink-0 mt-0.5">
                    {selectedEffort === level && (
                      <Check className="w-4 h-4 text-primary" />
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium">
                      {EFFORT_LABELS[level]}
                      {level === DEFAULT_EFFORT ? " (default)" : ""}
                    </span>
                    <span className="text-xs text-muted-foreground line-clamp-2">
                      {EFFORT_DESCRIPTIONS[level]}
                    </span>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

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
  };
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="rounded-lg border-2 border-amber-700/60 bg-amber-950/20 px-3 py-3 mb-3">
      <div className="text-xs uppercase tracking-wide text-amber-400 mb-2">
        Claude wants to use a tool
      </div>
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
          onClick={onApprove}
          className="flex-1 px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium"
        >
          Allow
        </button>
        <button
          type="button"
          onClick={onDeny}
          className="flex-1 px-3 py-1.5 rounded bg-red-800 hover:bg-red-700 text-white text-sm font-medium"
        >
          Deny
        </button>
      </div>
    </div>
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
