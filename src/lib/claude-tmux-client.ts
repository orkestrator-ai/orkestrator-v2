// Claude tmux mode client: thin wrapper around Tauri invoke + event listeners.
// All commands are keyed by `tabId` (each tab = one claude session).
// `environmentId` is only needed to resolve the backend on first start.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Channel emitted by the Rust `claude_tmux` module. */
export const CLAUDE_TMUX_EVENT = "claude-tmux:event";

/** Envelope discriminated by `kind`. Matches `claude_tmux::session::TmuxEvent`. */
export type TmuxEvent =
  | {
      kind: "started";
      tab_id: string;
      environment_id: string;
      session_id: string;
      resumed: boolean;
    }
  | {
      kind: "initial-prompt-sent";
      tab_id: string;
      environment_id: string;
      session_id: string;
    }
  | {
      kind: "transcript-line";
      tab_id: string;
      environment_id: string;
      session_id: string;
      line: TranscriptLine;
    }
  | {
      kind: "hook";
      tab_id: string;
      environment_id: string;
      session_id: string;
      event_id: string;
      event_kind: HookEventKind;
      payload: unknown;
    }
  | {
      kind: "hook-timed-out";
      tab_id: string;
      environment_id: string;
      session_id: string;
      event_kind: HookEventKind;
      event_id: string;
    }
  | {
      kind: "stopped";
      tab_id: string;
      environment_id: string;
    }
  | {
      kind: "warning";
      tab_id: string;
      environment_id: string;
      message: string;
    };

export type HookEventKind =
  | "PreToolUse"
  | "PermissionRequest"
  | "Elicitation"
  | "ElicitationResult"
  | "UserPromptExpansion"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStop"
  | "Notification"
  | "SessionStart";

/**
 * Subset of fields we care about from the Claude Code JSONL transcript.
 * The format is not under our control, so we keep the original line on the
 * `_raw` field as an escape hatch.
 */
export interface TranscriptLine {
  type?: "user" | "assistant" | "system" | string;
  subtype?: string;
  sessionId?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: "user" | "assistant" | "system";
    content?: Array<TranscriptContent> | string;
  };
  content?: Array<TranscriptContent> | string;
  [key: string]: unknown;
}

export interface TmuxPendingHook {
  id: string;
  kind: HookEventKind | string;
  payload: unknown;
}

export type TranscriptContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input?: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content?: string | Array<{ type: string; text?: string }>;
      is_error?: boolean;
    };

export interface TmuxStatus {
  tab_id: string;
  environment_id: string;
  session_id: string | null;
  tmux_session: string;
  running: boolean;
  transcript_path: string | null;
  resumed: boolean;
  busy: boolean;
}

/** Metadata about a previously-recorded session the user could resume. */
export interface PreviousSession {
  session_id: string;
  title: string | null;
  last_activity_unix: number;
  message_count: number;
  transcript_path: string;
}

// ── Commands ─────────────────────────────────────────────────────────────────

export async function startSession(
  tabId: string,
  environmentId: string,
  options?: {
    initialPrompt?: string;
    model?: string;
    planMode?: boolean;
    resumeSessionId?: string;
  },
): Promise<TmuxStatus> {
  return invoke<TmuxStatus>("claude_tmux_start", {
    tabId,
    environmentId,
    initialPrompt: options?.initialPrompt,
    model: options?.model,
    planMode: options?.planMode,
    resumeSessionId: options?.resumeSessionId,
  });
}

export async function stopSession(tabId: string): Promise<void> {
  await invoke("claude_tmux_stop", { tabId });
}

export async function interruptSession(tabId: string): Promise<void> {
  await invoke("claude_tmux_interrupt", { tabId });
}

export async function getStatus(tabId: string): Promise<TmuxStatus | null> {
  return invoke<TmuxStatus | null>("claude_tmux_status", { tabId });
}

export async function getTranscript(tabId: string): Promise<TranscriptLine[]> {
  return invoke<TranscriptLine[]>("claude_tmux_transcript", { tabId });
}

export async function getPendingHooks(tabId: string): Promise<TmuxPendingHook[]> {
  return invoke<TmuxPendingHook[]>("claude_tmux_pending_hooks", { tabId });
}

export async function submit(tabId: string, text: string): Promise<void> {
  await invoke("claude_tmux_submit", { tabId, text });
}

export async function sendText(tabId: string, text: string): Promise<void> {
  await invoke("claude_tmux_send_text", { tabId, text });
}

export async function sendKeys(tabId: string, keys: string[]): Promise<void> {
  await invoke("claude_tmux_send_keys", { tabId, keys });
}

export async function capturePane(tabId: string): Promise<string> {
  return invoke<string>("claude_tmux_capture_pane", { tabId });
}

export async function resize(
  tabId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke("claude_tmux_resize", { tabId, cols, rows });
}

export async function createInteractiveTerminal(
  tabId: string,
  cols: number,
  rows: number,
): Promise<string> {
  return invoke<string>("claude_tmux_create_interactive_terminal", {
    tabId,
    cols,
    rows,
  });
}

export async function startInteractiveTerminal(
  terminalSessionId: string,
): Promise<void> {
  await invoke("claude_tmux_start_interactive_terminal", { terminalSessionId });
}

export async function writeInteractiveTerminal(
  terminalSessionId: string,
  data: string,
): Promise<void> {
  await invoke("claude_tmux_write_interactive_terminal", {
    terminalSessionId,
    data,
  });
}

export async function resizeInteractiveTerminal(
  terminalSessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke("claude_tmux_resize_interactive_terminal", {
    terminalSessionId,
    cols,
    rows,
  });
}

export async function detachInteractiveTerminal(
  terminalSessionId: string,
): Promise<void> {
  await invoke("claude_tmux_detach_interactive_terminal", { terminalSessionId });
}

/**
 * Resolve a PreToolUse hook decision.
 * - "approve": tool is allowed (Claude skips its own permission prompt)
 * - "block":   tool is denied with `reason` shown to Claude
 */
export async function answerPreToolUse(
  tabId: string,
  eventId: string,
  decision: "approve" | "block",
  reason?: string,
): Promise<void> {
  await invoke("claude_tmux_answer_pre_tool_use", {
    tabId,
    eventId,
    decision,
    reason,
  });
}

/** Raw escape hatch for replying to any hook with arbitrary JSON. */
export async function replyHook(
  tabId: string,
  eventKind: HookEventKind,
  eventId: string,
  response: unknown,
): Promise<void> {
  await invoke("claude_tmux_reply_hook", {
    tabId,
    eventKind,
    eventId,
    response,
  });
}

/**
 * List previous Claude Code sessions recorded for this workspace's JSONL
 * project dir. Newest first. Use to populate a resume-session picker before
 * the user has sent any prompt.
 */
export async function listPreviousSessions(
  environmentId: string,
): Promise<PreviousSession[]> {
  return invoke<PreviousSession[]>("claude_tmux_list_previous_sessions", {
    environmentId,
  });
}

// ── Event subscription ───────────────────────────────────────────────────────

/**
 * Subscribe to all tmux events. Filter by `tab_id` (or `environment_id`) in
 * the handler. Returns an unlisten function — call it on unmount.
 */
export async function subscribe(
  onEvent: (event: TmuxEvent) => void,
): Promise<UnlistenFn> {
  return listen<TmuxEvent>(CLAUDE_TMUX_EVENT, (event) => {
    onEvent(event.payload);
  });
}
