// Claude tmux mode chat tab.
//
// Drives the `claude` CLI under tmux on the host or in a container, and
// surfaces a chat UI by reading the JSONL transcript and listening to
// Claude Code hooks. No Agent SDK required.
//
// Visual parity with the native Claude tab is achieved by reusing the
// `<ClaudeMessage>` renderer; we only build a slim compose bar of our own
// that matches the native styling and adds model / plan-mode controls.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  History,
  Loader2,
  Plus,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ClaudeMessage } from "@/components/claude/ClaudeMessage";
import { ResumeTmuxSessionDialog } from "@/components/claude/ResumeTmuxSessionDialog";
import { formatElapsed } from "@/lib/format-elapsed";
import {
  parseSlashCommands,
  SlashCommandMenu,
  type SlashCommand,
} from "@/components/claude/SlashCommandMenu";
import {
  answerPreToolUse,
  capturePane,
  getPendingHooks,
  getStatus,
  getTranscript,
  replyHook,
  sendKeys,
  startSession,
  stopSession,
  submit as submitToTmux,
  subscribe,
  type TmuxPendingHook,
  type TmuxEvent,
} from "@/lib/claude-tmux-client";
import {
  payloadToApproval,
  payloadToElicitation,
  payloadToInfoEvent,
  payloadToPermission,
  payloadToPlan,
  payloadToQuestion,
  compactConsecutiveAssistantMessages,
  useClaudeTmuxStore,
  type TmuxPendingApproval,
  type TmuxPendingElicitation,
  type TmuxPendingPermission,
  type TmuxPendingPlan,
  type TmuxPendingQuestion,
} from "@/stores/claudeTmuxStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { ClaudeTmuxData } from "@/types/paneLayout";

interface Props {
  tabId: string;
  data: ClaudeTmuxData;
  isActive: boolean;
  initialPrompt?: string;
}

/**
 * Hardcoded model list for tmux mode. There's no SDK to enumerate available
 * models, so we ship a small, stable set. Users can also type `/model …` in
 * the Claude TUI to override at runtime.
 */
const TMUX_MODELS: Array<{ id: string; name: string; description?: string }> = [
  {
    id: "claude-opus-4-7",
    name: "Opus 4.7",
    description: "Most capable; slowest",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Sonnet 4.6",
    description: "Balanced speed and capability (default)",
  },
  {
    id: "claude-haiku-4-5",
    name: "Haiku 4.5",
    description: "Fastest; lightweight tasks",
  },
];
const DEFAULT_MODEL = "claude-sonnet-4-6";

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

export function ClaudeTmuxChatTab({ tabId, data, isActive, initialPrompt }: Props) {
  const { environmentId, containerId } = data;

  const tabState = useClaudeTmuxStore((s) => s.tabs.get(tabId));
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
  const pushInfoEvent = useClaudeTmuxStore((s) => s.pushInfoEvent);
  const dismissInfoEvent = useClaudeTmuxStore((s) => s.dismissInfoEvent);
  const setTabBusy = useClaudeTmuxStore((s) => s.setBusy);
  const clearTabInitialPrompt = usePaneLayoutStore((s) => s.clearTabInitialPrompt);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTui, setShowTui] = useState(false);
  const [tuiSnapshot, setTuiSnapshot] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [planMode, setPlanMode] = useState(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [promptControlBusy, setPromptControlBusy] = useState(false);
  const [backendHydrated, setBackendHydrated] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  // Auto-start unless the user is presented with a choice (no initial prompt
  // and there are prior sessions to resume — they should pick first).
  const hasInitialPrompt = Boolean(initialPrompt?.trim());
  const messages = tabState?.messages ?? [];
  const pendingApprovals = tabState?.pendingApprovals ?? [];
  const pendingQuestions = tabState?.pendingQuestions ?? [];
  const pendingPlans = tabState?.pendingPlans ?? [];
  const pendingPermissions = tabState?.pendingPermissions ?? [];
  const pendingElicitations = tabState?.pendingElicitations ?? [];
  const infoEvents = tabState?.infoEvents ?? [];
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
  const displayMessages = useMemo(
    () => compactConsecutiveAssistantMessages(messages),
    [messages],
  );
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);

  // 0. Reconnect to any already-running backend session and replay the full
  // transcript. Tauri events are only delivered to mounted listeners, so a
  // tmux tab hidden behind another environment can miss transcript updates.
  useEffect(() => {
    let cancelled = false;
    setBackendHydrated(false);

    const hydrate = async () => {
      try {
        const status = await getStatus(tabId);
        if (cancelled) return;

        if (status) {
          startedRef.current = Boolean(status.running);
          setRunning(tabId, status.running, {
            environmentId: status.environment_id,
            sessionId: status.session_id,
            resumed: status.resumed,
          });
          setTabBusy(tabId, status.busy);

          if (status.session_id) {
            const lines = await getTranscript(tabId);
            if (cancelled) return;
            for (const line of lines) {
              applyTranscriptLine(tabId, line);
            }
            const hooks = await getPendingHooks(tabId);
            if (cancelled) return;
            replacePendingHooks(tabId, pendingSnapshotFromHooks(hooks));
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
    setRunning,
    setTabBusy,
    applyTranscriptLine,
    replacePendingHooks,
  ]);

  // 1. Subscribe to backend events (one listener for the whole tab).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    subscribe((ev: TmuxEvent) => {
      // Every event the tmux backend emits is tab-scoped — ignore events for
      // other tabs even when they happen to live in the same workspace.
      if (ev.kind !== "warning" && ev.tab_id !== tabId) return;
      if (ev.kind === "warning" && ev.tab_id !== tabId) return;

      switch (ev.kind) {
        case "started":
          setRunning(tabId, true, {
            environmentId: ev.environment_id,
            sessionId: ev.session_id,
            resumed: ev.resumed,
          });
          return;
        case "stopped":
          setRunning(tabId, false, { sessionId: null });
          // No claude process means no in-flight turn.
          setTabBusy(tabId, false);
          return;
        case "transcript-line":
          applyTranscriptLine(tabId, ev.line);
          break;
        case "hook":
          // Drive the "Claude is thinking…" indicator from the same hook
          // events Claude Code emits for the agent lifecycle. We rely on
          // UserPromptSubmit/Stop here rather than transcript content so
          // tool-call turns (no final text) still clear the spinner.
          if (ev.event_kind === "UserPromptSubmit") {
            setTabBusy(tabId, true);
          } else if (ev.event_kind === "Stop") {
            setTabBusy(tabId, false);
          }
          if (ev.event_kind === "PreToolUse") {
            const toolName = hookToolName(ev.payload);
            if (toolName === "AskUserQuestion") {
              addPendingQuestion(tabId, payloadToQuestion(ev.event_id, ev.payload));
            } else if (toolName === "ExitPlanMode") {
              addPendingPlan(tabId, payloadToPlan(ev.event_id, ev.payload));
            } else {
              addPendingApproval(tabId, payloadToApproval(ev.event_id, ev.payload));
            }
          } else if (ev.event_kind === "PermissionRequest") {
            addPendingPermission(tabId, payloadToPermission(ev.event_id, ev.payload));
          } else if (ev.event_kind === "Elicitation") {
            addPendingElicitation(tabId, payloadToElicitation(ev.event_id, ev.payload));
          } else if (
            // PostToolUse fires after every tool call, and lifecycle hooks are
            // consumed for busy-state only; surfacing them as visible info rows
            // is noise.
            ev.event_kind !== "PostToolUse" &&
            ev.event_kind !== "UserPromptSubmit" &&
            ev.event_kind !== "Stop" &&
            ev.event_kind !== "SubagentStop"
          ) {
            pushInfoEvent(
              tabId,
              payloadToInfoEvent(ev.event_id, ev.event_kind, ev.payload),
            );
          }
          break;
        case "hook-timed-out":
          if (ev.event_kind === "PreToolUse") {
            removePendingApproval(tabId, ev.event_id);
            removePendingQuestion(tabId, ev.event_id);
            removePendingPlan(tabId, ev.event_id);
          } else if (ev.event_kind === "PermissionRequest") {
            removePendingPermission(tabId, ev.event_id);
          } else if (ev.event_kind === "Elicitation") {
            removePendingElicitation(tabId, ev.event_id);
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
  ]);

  // Common "start the tmux session" path used by both auto-start (initial
  // prompt present) and the explicit "Start fresh" / "Resume" buttons.
  const launchSession = useCallback(
    (resumeSessionId?: string) => {
      if (startedRef.current) return;
      startedRef.current = true;
      startSession(tabId, environmentId, {
        initialPrompt,
        model: selectedModel,
        planMode,
        resumeSessionId,
      })
        .then(() => {
          if (initialPrompt?.trim()) {
            clearTabInitialPrompt(tabId, environmentId);
          }
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
      planMode,
      clearTabInitialPrompt,
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

  // 3. Auto-scroll to bottom on new content.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [
    tabState?.messages.length,
    tabState?.pendingApprovals.length,
    tabState?.infoEvents.length,
  ]);

  // 4. Raw TUI snapshot polling. The snapshot powers both the optional debug
  //    pane and the interactive controls for Claude Code's in-TUI prompts.
  useEffect(() => {
    if (!showTui && !running) {
      setTuiSnapshot("");
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const snap = await capturePane(tabId);
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
  }, [showTui, running, tabId]);

  const handleSubmit = async () => {
    const text = draft.trim();
    // `isThinking` covers the post-HTTP window where Claude is still
    // processing but `sending` has already reset; without it a user could
    // submit a second message before the first turn finishes.
    if (!text || sending || isThinking) return;
    setSending(true);
    setError(null);
    // Optimistically flip the "Claude is thinking…" indicator on submit so
    // the user gets instant feedback; the UserPromptSubmit hook will confirm
    // it shortly after, and the Stop hook (handled in the subscription
    // above) clears it when the turn ends.
    setTabBusy(tabId, true);
    try {
      await submitToTmux(tabId, text);
      setDraft("");
    } catch (e) {
      setError(String(e));
      // The submit failed before claude saw it — there's no Stop coming.
      setTabBusy(tabId, false);
    } finally {
      setSending(false);
    }
  };

  const handleApproval = async (
    eventId: string,
    decision: "approve" | "block",
  ) => {
    try {
      await answerPreToolUse(tabId, eventId, decision);
    } catch (e) {
      setError(String(e));
    } finally {
      removePendingApproval(tabId, eventId);
    }
  };

  const handleQuestionAnswer = async (
    question: TmuxPendingQuestion,
    answers: Record<string, string>,
  ) => {
    try {
      await replyHook(
        tabId,
        "PreToolUse",
        question.eventId,
        preToolAllow({
          ...question.toolInput,
          questions: question.questions,
          answers,
        }),
      );
      removePendingQuestion(tabId, question.eventId);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleQuestionReject = async (question: TmuxPendingQuestion) => {
    try {
      await replyHook(
        tabId,
        "PreToolUse",
        question.eventId,
        preToolDeny("User declined to answer the question."),
      );
      removePendingQuestion(tabId, question.eventId);
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
      );
      removePendingPlan(tabId, plan.eventId);
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
      );
      removePendingPermission(tabId, permission.eventId);
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
      );
      removePendingElicitation(tabId, elicitation.eventId);
    } catch (e) {
      setError(String(e));
    }
  };

  const handlePromptKeys = async (keys: string[]) => {
    if (keys.length === 0 || promptControlBusy) return;
    setPromptControlBusy(true);
    setError(null);
    try {
      await sendKeys(tabId, keys);
      const snap = await capturePane(tabId);
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

    if (prompt.inputMode === "number") {
      const digits = String(option.number).split("");
      await handlePromptKeys([...digits, "Enter"]);
      return;
    }

    const delta = optionIndex - prompt.selectedOptionIndex;
    const navKey = delta > 0 ? "Down" : "Up";
    const keys: string[] = Array.from({ length: Math.abs(delta) }, () => navKey);
    keys.push("Enter");
    await handlePromptKeys(keys);
  };

  const handleResume = (sessionId: string) => {
    setResumeDialogOpen(false);
    launchSession(sessionId);
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
              "px-1.5 py-0.5 rounded hover:bg-muted/50 transition-colors flex items-center gap-1",
              showTui
                ? "text-foreground bg-muted/40"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setShowTui((v) => !v)}
            title="Toggle a live view of the underlying tmux pane (debug)"
          >
            <TerminalIcon className="w-3 h-3" />
            {showTui ? "Hide TUI" : "Show TUI"}
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => stopSession(tabId)}
            disabled={!running}
          >
            Stop
          </button>
        </div>
      </div>

      {/* Inline error / info bar */}
      {error && (
        <div className="px-3 py-1.5 text-xs text-red-400 bg-red-950/30 border-b border-red-900/40 shrink-0">
          {error}
        </div>
      )}
      {infoEvents.length > 0 && (
        <div className="px-3 py-1 border-b border-border/60 space-y-0.5 shrink-0">
          {infoEvents.slice(-3).map((ev) => (
            <div
              key={ev.id}
              className="flex items-center justify-between text-[11px] text-muted-foreground"
            >
              <span className="truncate">
                <span className="opacity-60">[{ev.kind}]</span> {ev.message}
              </span>
              <button
                type="button"
                onClick={() => dismissInfoEvent(tabId, ev.id)}
                className="ml-2 opacity-50 hover:opacity-100"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

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
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto min-w-0 px-2 @sm:px-4 py-3">
          {messages.length === 0 && !hasPendingHookCards && (
            showStartScreen ? (
              <StartScreen
                onStartFresh={() => launchSession()}
                onPickResume={() => setResumeDialogOpen(true)}
                selectedModel={modelObj(selectedModel).name}
                planMode={planMode}
              />
            ) : (
              <div className="text-xs text-muted-foreground italic py-8 text-center">
                {running
                  ? "Waiting for Claude…"
                  : "Starting Claude under tmux…"}
              </div>
            )
          )}

          {displayMessages.map((m, idx) => (
            <ClaudeMessage
              key={m.id}
              message={m}
              previousMessage={displayMessages[idx - 1] ?? null}
              isStreaming={running}
              containerId={containerId}
            />
          ))}

          {pendingApprovals.map((a) => (
            <ApprovalCard
              key={a.eventId}
              approval={a}
              onApprove={() => handleApproval(a.eventId, "approve")}
              onDeny={() => handleApproval(a.eventId, "block")}
            />
          ))}

          {pendingQuestions.map((q) => (
            <TmuxQuestionCard
              key={q.eventId}
              question={q}
              onSubmit={(answers) => handleQuestionAnswer(q, answers)}
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

          {selectionPrompt && (
            <TmuxSelectionPromptCard
              prompt={selectionPrompt}
              busy={promptControlBusy}
              onSelectOption={(optionIndex) =>
                handleSelectPromptOption(selectionPrompt, optionIndex)
              }
              onSendKeys={handlePromptKeys}
            />
          )}
        </div>
      </div>

      {/* "Claude is thinking…" indicator — matches the native tab so the UI
          looks the same between modes. Shown only while running so a freshly
          mounted tab without a session doesn't flash a misleading spinner. */}
      {isThinking && running && (
        <div className="shrink-0 px-2 @sm:px-4 py-2 border-t border-border/40">
          <div className="max-w-3xl mx-auto min-w-0">
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
        </div>
      )}

      {/* Compose bar — stays "busy" for the full turn (HTTP submit + Claude
          processing) so a user can't queue a second message before the
          previous one finishes. Mirrors the spinner condition above. */}
      <TmuxComposeBar
        value={draft}
        setValue={setDraft}
        disabled={!running}
        busy={sending || isThinking}
        autoFocus={isActive}
        onSubmit={handleSubmit}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        planMode={planMode}
        onTogglePlanMode={setPlanMode}
        settingsLocked={hasStarted}
      />

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

function TmuxQuestionCard({
  question,
  onSubmit,
  onDismiss,
}: {
  question: TmuxPendingQuestion;
  onSubmit: (answers: Record<string, string>) => void;
  onDismiss: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});

  const setAnswer = (questionText: string, label: string, multi: boolean) => {
    setAnswers((prev) => {
      const current = prev[questionText] ?? [];
      if (!multi) return { ...prev, [questionText]: [label] };
      return current.includes(label)
        ? { ...prev, [questionText]: current.filter((x) => x !== label) }
        : { ...prev, [questionText]: [...current, label] };
    });
  };

  const ready = question.questions.every((q) => (answers[q.question] ?? []).length > 0);
  const submit = () => {
    const mapped: Record<string, string> = {};
    for (const q of question.questions) {
      mapped[q.question] = (answers[q.question] ?? []).join(", ");
    }
    onSubmit(mapped);
  };

  return (
    <div className="rounded-lg border border-blue-700/60 bg-blue-950/20 px-3 py-3 mb-3">
      <div className="text-xs uppercase tracking-wide text-blue-300 mb-2">
        Claude has a question
      </div>
      <div className="space-y-4">
        {question.questions.map((q) => {
          const selected = answers[q.question] ?? [];
          const options = q.options ?? [];
          return (
            <div key={q.question} className="space-y-2">
              <div className="text-sm font-medium text-foreground">
                {q.header || q.question}
              </div>
              {q.header && (
                <div className="text-sm text-muted-foreground">{q.question}</div>
              )}
              <div className="space-y-1">
                {options.length === 0 && (
                  <input
                    value={selected[0] ?? ""}
                    onChange={(e) =>
                      setAnswers((prev) => ({
                        ...prev,
                        [q.question]: e.target.value.trim()
                          ? [e.target.value]
                          : [],
                      }))
                    }
                    className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none"
                  />
                )}
                {options.map((option) => {
                  const isSelected = selected.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() =>
                        setAnswer(q.question, option.label, q.multiSelect ?? false)
                      }
                      className={cn(
                        "w-full min-w-0 rounded border px-2.5 py-2 text-left text-sm transition-colors",
                        "flex items-start gap-2",
                        isSelected
                          ? "border-blue-500/70 bg-blue-500/15 text-blue-50"
                          : "border-border/70 bg-background/50 hover:bg-muted/60",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block break-words">{option.label}</span>
                        {option.description && (
                          <span className="block text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        )}
                      </span>
                      {isSelected && <Check className="h-4 w-4 shrink-0 text-blue-300" />}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
        <Button size="sm" onClick={submit} disabled={!ready}>
          Submit
        </Button>
      </div>
    </div>
  );
}

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
  return {
    question: parseTmuxSelectionQuestion(lines, blockStart),
    options,
    selectedOptionIndex: selectedOptionIndex >= 0 ? selectedOptionIndex : 0,
    inputMode: /Enter\s+to\s+confirm/i.test(hintLine) ? "number" : "navigate",
  };
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

function TmuxSelectionPromptCard({
  prompt,
  busy,
  onSelectOption,
  onSendKeys,
}: {
  prompt: TmuxSelectionPrompt;
  busy: boolean;
  onSelectOption: (optionIndex: number) => void;
  onSendKeys: (keys: string[]) => void;
}) {
  const [localSelectedOptionIndex, setLocalSelectedOptionIndex] = useState(
    prompt.selectedOptionIndex,
  );

  useEffect(() => {
    setLocalSelectedOptionIndex(prompt.selectedOptionIndex);
  }, [prompt.inputMode, prompt.options.length]);

  const selectedOptionIndex =
    prompt.inputMode === "number"
      ? localSelectedOptionIndex
      : prompt.selectedOptionIndex;

  const moveSelection = (delta: -1 | 1) => {
    if (prompt.inputMode === "number") {
      setLocalSelectedOptionIndex((current) =>
        Math.min(Math.max(current + delta, 0), prompt.options.length - 1),
      );
      return;
    }
    onSendKeys([delta < 0 ? "Up" : "Down"]);
  };

  return (
    <div className="rounded-lg border border-blue-700/60 bg-blue-950/20 px-3 py-3 mb-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs uppercase tracking-wide text-blue-300">
          Claude is asking for a choice
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            className="h-7 w-7 p-0"
            title="Move selection up"
            onClick={() => moveSelection(-1)}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            className="h-7 w-7 p-0"
            title="Move selection down"
            onClick={() => moveSelection(1)}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            className="h-7 w-7 p-0"
            title="Select highlighted option"
            onClick={() => onSelectOption(selectedOptionIndex)}
          >
            <CornerDownLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            className="h-7 w-7 p-0"
            title="Cancel prompt"
            onClick={() => onSendKeys(["Escape"])}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {prompt.question && (
        <div className="mb-3 whitespace-pre-wrap text-sm text-foreground">
          {prompt.question}
        </div>
      )}

      <div className="space-y-1">
        {prompt.options.map((option) => {
          const selected =
            option.optionIndex === selectedOptionIndex ||
            (prompt.inputMode === "navigate" && option.selected);
          return (
            <button
              type="button"
              key={`${option.number}-${option.label}`}
              disabled={busy}
              onClick={() => onSelectOption(option.optionIndex)}
              className={cn(
                "w-full min-w-0 rounded border px-2.5 py-2 text-left text-sm transition-colors",
                "flex items-start gap-2",
                selected
                  ? "border-blue-500/70 bg-blue-500/15 text-blue-50"
                  : "border-border/70 bg-background/50 hover:bg-muted/60",
              )}
            >
              <span className="font-mono text-xs text-muted-foreground pt-0.5">
                {option.number}.
              </span>
              <span className="min-w-0 flex-1 break-words">{option.label}</span>
              {selected && <Check className="h-4 w-4 shrink-0 text-blue-300" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function hookToolName(payload: unknown): string | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const value = p.tool_name ?? p.toolName;
  return typeof value === "string" ? value : null;
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

function modelObj(id: string) {
  return TMUX_MODELS.find((m) => m.id === id) ?? TMUX_MODELS[1]!;
}

// ─── Compose bar ─────────────────────────────────────────────────────────────

interface TmuxComposeBarProps {
  value: string;
  setValue: (v: string) => void;
  disabled: boolean;
  busy: boolean;
  autoFocus?: boolean;
  onSubmit: () => void;
  selectedModel: string;
  onSelectModel: (id: string) => void;
  planMode: boolean;
  onTogglePlanMode: (v: boolean) => void;
  settingsLocked: boolean;
}

function TmuxComposeBar({
  value,
  setValue,
  disabled,
  busy,
  autoFocus,
  onSubmit,
  selectedModel,
  onSelectModel,
  planMode,
  onTogglePlanMode,
  settingsLocked,
}: TmuxComposeBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelObj = useMemo(
    () => TMUX_MODELS.find((m) => m.id === selectedModel) ?? TMUX_MODELS[1]!,
    [selectedModel],
  );

  // Slash command menu state. The list is static (claude builtins) — see
  // TMUX_BUILTIN_SLASH_COMMANDS at the top of the file.
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);

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
    setValue(command.name + " ");
    setSlashMenuOpen(false);
    textareaRef.current?.focus();
  };

  return (
    <div className="shrink-0 border-t border-border bg-background p-3">
      <div className="relative">
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
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
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
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={
            disabled
              ? "Session not running"
              : "Ask Claude anything… (Shift+Enter for newline; / for commands)"
          }
          disabled={disabled || busy}
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
        {/* Attach (placeholder for parity — no-op for v1) */}
        <button
          type="button"
          disabled
          className="p-1.5 rounded text-muted-foreground/40 cursor-not-allowed"
          title="Attachments not yet supported in tmux mode"
        >
          <Plus className="w-4 h-4" />
        </button>

        {/* Model picker — selectable before launch even while compose is
            disabled, so users can pre-pick from the start screen. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={settingsLocked}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-60"
              title={
                settingsLocked
                  ? "Model is fixed for this tmux session"
                  : "Select the model for the next tmux launch"
              }
            >
              <ChevronDown className="w-3 h-3" />
              <span className="max-w-[200px] truncate">{modelObj.name}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[240px]">
            {TMUX_MODELS.map((m) => {
              const selected = m.id === selectedModel;
              return (
                <DropdownMenuItem
                  key={m.id}
                  onClick={() => onSelectModel(m.id)}
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
              disabled={settingsLocked}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-60"
              title={
                settingsLocked
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

        <div className="flex-1" />

        {/* Send / Stop button */}
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={disabled || busy || !value.trim()}
          className="h-7 w-7 p-0 rounded-full"
          title="Send (↵)"
        >
          {busy ? (
            <Square className="w-3.5 h-3.5" />
          ) : (
            <ArrowUp className="w-4 h-4" />
          )}
        </Button>
      </div>
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
