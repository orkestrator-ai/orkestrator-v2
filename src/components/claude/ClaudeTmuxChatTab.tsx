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
  History,
  Loader2,
  Plus,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
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
  startSession,
  stopSession,
  submit as submitToTmux,
  subscribe,
  type TmuxEvent,
} from "@/lib/claude-tmux-client";
import {
  payloadToApproval,
  payloadToInfoEvent,
  useClaudeTmuxStore,
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  // Auto-start unless the user is presented with a choice (no initial prompt
  // and there are prior sessions to resume — they should pick first).
  const hasInitialPrompt = Boolean(initialPrompt?.trim());

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
          // SubagentStop fires when a Task-tool subagent finishes; we treat
          // it as the same end-of-turn signal so subagent-only turns still
          // clear the spinner.
          if (ev.event_kind === "UserPromptSubmit") {
            setTabBusy(tabId, true);
          } else if (
            ev.event_kind === "Stop" ||
            ev.event_kind === "SubagentStop"
          ) {
            setTabBusy(tabId, false);
          }
          if (ev.event_kind === "PreToolUse") {
            addPendingApproval(
              tabId,
              payloadToApproval(ev.event_id, ev.payload),
            );
          } else if (
            // Lifecycle hooks are consumed for busy-state only; surfacing
            // them as visible "info" rows is noise.
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
    if (!hasInitialPrompt) return;
    if (startedRef.current) return;
    launchSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasInitialPrompt, tabId]);

  // 3. Auto-scroll to bottom on new content.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [
    tabState?.messages.length,
    tabState?.pendingApprovals.length,
    tabState?.infoEvents.length,
  ]);

  // 4. Raw TUI snapshot polling (debug view).
  useEffect(() => {
    if (!showTui) return;
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
    const id = setInterval(tick, 500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [showTui, tabId]);

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

  const handleResume = (sessionId: string) => {
    setResumeDialogOpen(false);
    launchSession(sessionId);
  };

  const messages = tabState?.messages ?? [];
  const pendingApprovals = tabState?.pendingApprovals ?? [];
  const infoEvents = tabState?.infoEvents ?? [];
  const running = tabState?.running ?? false;
  const resumedSession = tabState?.resumed ?? false;
  const isThinking = tabState?.busy ?? false;
  const busyStartedAt = tabState?.busyStartedAt ?? null;
  const hasStarted = startedRef.current || running;
  const showStartScreen = !hasStarted && !hasInitialPrompt;

  // Tick once a second while the spinner is visible so the elapsed counter
  // updates. Mirrors the native tab's behavior.
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);
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
          {messages.length === 0 && pendingApprovals.length === 0 && (
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

          {messages.map((m, idx) => (
            <ClaudeMessage
              key={m.id}
              message={m}
              previousMessage={messages[idx - 1] ?? null}
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
