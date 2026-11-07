// Claude tmux mode client: thin wrapper around Electron invoke + event listeners.
// Commands are scoped by `(environmentId, tabId)` so first tabs named
// "default" in different environments never share a Claude session.

import { commandBackendClient, type BackendClient } from "@/lib/backend/client";
import { listen, type UnlistenFn } from "@/lib/native/events";
import { claudeTmux } from "@/lib/node-scope/domains/claude-tmux";
import type { AgentInteractionHold } from "@orkestrator/protocol/agent-interactions";
import type { TaskListSnapshot } from "@orkestrator/protocol/task-list";
import type { TmuxAgentObservation } from "@orkestrator/protocol/tmux-observation";

/** Channel emitted by the Rust `claude_tmux` module. */
export const CLAUDE_TMUX_EVENT = "claude-tmux:event";

/** Envelope discriminated by `kind`. Matches `claude_tmux::session::TmuxEvent`. */
export type TmuxEvent =
  | {
      kind: "observation";
      tab_id: string;
      environment_id: string;
      session_id: string;
      observation: TmuxAgentObservation;
    }
  | {
      kind: "started";
      tab_id: string;
      environment_id: string;
      session_id: string;
      observation_generation?: string;
      resumed: boolean;
      fast_mode: boolean | null;
    }
  | {
      kind: "initial-prompt-sent";
      tab_id: string;
      environment_id: string;
      session_id: string;
    }
  | {
      kind: "permission-mode-changed";
      tab_id: string;
      environment_id: string;
      session_id: string;
      permission_mode: string;
    }
  | {
      kind: "fast-mode-changed";
      tab_id: string;
      environment_id: string;
      session_id: string;
      fast_mode: boolean;
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
      requested_at?: number;
      expires_at?: number;
      /**
       * Pause state of a blocking hook's countdown. A pause or resume moves the
       * deadline and re-emits the same hook, so a listener updates the card it
       * already shows. Absent from an older backend.
       */
      hold?: TmuxHookHold;
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
  | "StopFailure"
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
    /** Provider-confirmed model recorded by Claude Code in the transcript. */
    model?: string;
  };
  content?: Array<TranscriptContent> | string;
  /**
   * Task list state after each task tool call this line completed, keyed by
   * `tool_use_id`, stamped on by the backend that reads the transcript. Not part
   * of Claude's JSONL — the renderer must never derive this itself, so that
   * tmux and Native Mode agree.
   */
  taskSnapshots?: Record<string, TaskListSnapshot>;
  /**
   * Diff sides (path and payload sides, never counts) of each tool call this
   * line started, keyed by tool use id, stamped on by the backend that reads
   * the transcript. The renderer never interprets provider tool inputs itself.
   */
  toolDiffs?: Record<string, { filePath?: string; before?: string; after?: string }>;
  [key: string]: unknown;
}

/** A bounded stretch of the transcript, oldest line first. */
export interface TranscriptPage {
  lines: TranscriptLine[];
  /** Asks for the page before this one; null when this one reaches the start. */
  earlierCursor: string | null;
  /** The cursor no longer names a place in this session's transcript. */
  expired?: boolean;
  /** The session's mode. Absent from a backend that predates paging. */
  permissionMode?: string;
}

/**
 * Whether a tmux prompt's countdown can be paused. The hook script owns the
 * deadline; `hook-outdated` is a prompt from a script, or a Claude Code
 * process, that predates pausing.
 */
export type TmuxHookHold = AgentInteractionHold | { available: false; reason: "hook-outdated" };

export interface TmuxPendingHook {
  id: string;
  kind: HookEventKind | string;
  payload: unknown;
  requestedAt?: number;
  expiresAt?: number;
  hold?: TmuxHookHold;
}

/** `settled`: the prompt was answered or expired meanwhile. */
export type TmuxHookHoldResult = "applied" | "unchanged" | "unavailable" | "settled";

export interface TmuxHookHoldOutcome {
  result: TmuxHookHoldResult;
  /** The prompt as it stands after the request, when it is still waiting. */
  hook?: TmuxPendingHook;
}

export type TranscriptContent =
  | { type: "text"; text: string }
  /**
   * `signature` is present on every thinking block. When the CLI's thinking
   * display is "omitted" it is the *only* thing present: `thinking` is an empty
   * string and the reasoning stays sealed in the signature, so there is nothing
   * to render. The tmux launcher asks for "summarized" to avoid that shape.
   */
  | { type: "thinking"; thinking: string; signature?: string }
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
  busy_started_at: number | null;
  permission_mode: string;
  fast_mode: boolean | null;
  observation: TmuxAgentObservation;
  info_events?: Array<{
    id: string;
    kind: HookEventKind;
    message: string;
    receivedAt: string;
  }>;
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
//
// Every command goes through the `claude-tmux` domain client of one node
// (plan item 7002): results decoded with the protocol schemas, and the
// envelope for a node that advertises the domain. The interfaces above are
// this module's views of the same shapes (event kinds narrowed).
//
// `createClaudeTmuxClient(client, events)` is one node's client (plan item
// 4007): its commands on `client` and its `claude-tmux:event` stream from
// `events`. The named exports are the window's command scope, the shim;
// a tab calls its own node through `claudeTmuxClientFor(scope)`
// (`@/lib/claude-tmux-scope`).

/** One node's `claude-tmux:event` stream: `onEvent` gets each payload; resolves to the unlisten. */
export type TmuxEventSource = (onEvent: (event: TmuxEvent) => void) => Promise<UnlistenFn>;

/** The tmux commands and event stream of `client`'s node. */
export function createClaudeTmuxClient(client: BackendClient, events: TmuxEventSource) {
  const tmux = () => claudeTmux(client);

  async function startSession(
    tabId: string,
    environmentId: string,
    options?: {
      initialPrompt?: string;
      model?: string;
      effort?: string;
      fastMode?: boolean;
      resumeSessionId?: string;
      replaceExisting?: boolean;
    },
  ): Promise<TmuxStatus> {
    return (await tmux().claude_tmux_start({
      tabId,
      environmentId,
      initialPrompt: options?.initialPrompt,
      model: options?.model,
      effort: options?.effort,
      fastMode: options?.fastMode,
      resumeSessionId: options?.resumeSessionId,
      replaceExisting: options?.replaceExisting,
    })) as TmuxStatus;
  }

  async function stopSession(tabId: string, environmentId: string): Promise<void> {
    await tmux().claude_tmux_stop({ tabId, environmentId });
  }

  async function interruptSession(tabId: string, environmentId: string): Promise<void> {
    await tmux().claude_tmux_interrupt({ tabId, environmentId });
  }

  async function getStatus(tabId: string, environmentId: string): Promise<TmuxStatus | null> {
    return (await tmux().claude_tmux_status({ tabId, environmentId })) as TmuxStatus | null;
  }

  /**
   * One page of the tab's transcript: its tail, or the page before `before`.
   * A backend that predates paging ignores `page` and answers the whole file as
   * an array, which is a page with nothing before it.
   */
  async function getTranscriptPage(
    tabId: string,
    environmentId: string,
    before?: string,
    sessionId?: string,
  ): Promise<TranscriptPage> {
    const result = (await tmux().claude_tmux_transcript({
      tabId,
      environmentId,
      page: { ...(before === undefined ? {} : { before }), ...(sessionId ? { sessionId } : {}) },
    })) as TranscriptLine[] | TranscriptPage;
    return Array.isArray(result) ? { lines: result, earlierCursor: null } : result;
  }

  /**
   * The tab's task list as the backend holds it, whatever part of the transcript
   * is loaded. The authoritative rehydration path for a tab that was not mounted
   * while tasks changed.
   */
  async function getTaskList(tabId: string, environmentId: string): Promise<TaskListSnapshot> {
    return (await tmux().claude_tmux_tasks({ tabId, environmentId })) as TaskListSnapshot;
  }

  async function getPendingHooks(tabId: string, environmentId: string): Promise<TmuxPendingHook[]> {
    return (await tmux().claude_tmux_pending_hooks({ tabId, environmentId })) as TmuxPendingHook[];
  }

  async function submit(tabId: string, text: string, environmentId: string): Promise<void> {
    await tmux().claude_tmux_submit({ tabId, environmentId, text });
  }

  async function switchModel(tabId: string, model: string, environmentId: string): Promise<void> {
    await tmux().claude_tmux_switch_model({ tabId, environmentId, model });
  }

  async function switchEffort(tabId: string, effort: string, environmentId: string): Promise<void> {
    await tmux().claude_tmux_switch_effort({ tabId, environmentId, effort });
  }

  async function switchFastMode(
    tabId: string,
    fastMode: boolean,
    environmentId: string,
  ): Promise<void> {
    await tmux().claude_tmux_switch_fast_mode({ tabId, environmentId, fastMode });
  }

  async function switchPlanMode(
    tabId: string,
    planMode: boolean,
    environmentId: string,
  ): Promise<string> {
    return tmux().claude_tmux_switch_plan_mode({ tabId, environmentId, planMode });
  }

  async function sendText(tabId: string, text: string, environmentId: string): Promise<void> {
    await tmux().claude_tmux_send_text({ tabId, environmentId, text });
  }

  async function sendKeys(tabId: string, keys: string[], environmentId: string): Promise<void> {
    await tmux().claude_tmux_send_keys({ tabId, environmentId, keys });
  }

  async function answerSelectionPrompt(
    tabId: string,
    environmentId: string,
    input: {
      expectedGeneration: string;
      expectedRevision: number;
      expectedPromptFingerprint: string;
      optionIndex: number;
    },
  ): Promise<void> {
    await tmux().claude_tmux_answer_selection_prompt({ tabId, environmentId, ...input });
  }

  async function resize(
    tabId: string,
    cols: number,
    rows: number,
    environmentId: string,
  ): Promise<void> {
    await tmux().claude_tmux_resize({ tabId, environmentId, cols, rows });
  }

  async function createInteractiveTerminal(
    tabId: string,
    cols: number,
    rows: number,
    environmentId: string,
  ): Promise<string> {
    return tmux().claude_tmux_create_interactive_terminal({ tabId, environmentId, cols, rows });
  }

  async function startInteractiveTerminal(terminalSessionId: string): Promise<void> {
    await tmux().claude_tmux_start_interactive_terminal({ terminalSessionId });
  }

  async function writeInteractiveTerminal(terminalSessionId: string, data: string): Promise<void> {
    await tmux().claude_tmux_write_interactive_terminal({ terminalSessionId, data });
  }

  async function resizeInteractiveTerminal(
    terminalSessionId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    await tmux().claude_tmux_resize_interactive_terminal({ terminalSessionId, cols, rows });
  }

  async function detachInteractiveTerminal(terminalSessionId: string): Promise<void> {
    await tmux().claude_tmux_detach_interactive_terminal({ terminalSessionId });
  }

  /**
   * Resolve a PreToolUse hook decision.
   * - "approve": tool is allowed (Claude skips its own permission prompt)
   * - "block":   tool is denied with `reason` shown to Claude
   */
  async function answerPreToolUse(
    tabId: string,
    eventId: string,
    decision: "approve" | "block",
    reason?: string,
    environmentId?: string,
  ): Promise<void> {
    await tmux().claude_tmux_answer_pre_tool_use({
      tabId,
      // Required by every handler; an older caller that omitted it was refused.
      environmentId: environmentId as string,
      eventId,
      decision,
      reason,
    });
  }

  /** Pause (`held`) or resume a blocking hook's countdown, where the hook script enforces it. */
  async function holdHook(
    tabId: string,
    eventKind: HookEventKind,
    eventId: string,
    held: boolean,
    environmentId?: string,
  ): Promise<TmuxHookHoldOutcome> {
    return (await tmux().claude_tmux_hold_hook({
      tabId,
      environmentId: environmentId as string,
      eventKind,
      eventId,
      held,
    })) as TmuxHookHoldOutcome;
  }

  /** Raw escape hatch for replying to any hook with arbitrary JSON. */
  async function replyHook(
    tabId: string,
    eventKind: HookEventKind,
    eventId: string,
    response: unknown,
    environmentId?: string,
  ): Promise<void> {
    await tmux().claude_tmux_reply_hook({
      tabId,
      environmentId: environmentId as string,
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
  async function listPreviousSessions(environmentId: string): Promise<PreviousSession[]> {
    return (await tmux().claude_tmux_list_previous_sessions({
      environmentId,
    })) as PreviousSession[];
  }

  /**
   * Subscribe to all of this node's tmux events. Filter by `tab_id` (or
   * `environment_id`) in the handler. Returns an unlisten function — call it
   * on unmount.
   */
  async function subscribe(onEvent: (event: TmuxEvent) => void): Promise<UnlistenFn> {
    return events(onEvent);
  }

  return {
    startSession,
    stopSession,
    interruptSession,
    getStatus,
    getTranscriptPage,
    getTaskList,
    getPendingHooks,
    submit,
    switchModel,
    switchEffort,
    switchFastMode,
    switchPlanMode,
    sendText,
    sendKeys,
    answerSelectionPrompt,
    resize,
    createInteractiveTerminal,
    startInteractiveTerminal,
    writeInteractiveTerminal,
    resizeInteractiveTerminal,
    detachInteractiveTerminal,
    answerPreToolUse,
    holdHook,
    replyHook,
    listPreviousSessions,
    subscribe,
  };
}

export type ClaudeTmuxClient = ReturnType<typeof createClaudeTmuxClient>;

// ── Event subscription ───────────────────────────────────────────────────────

/** The window's own event stream: the command scope's. */
const windowTmuxEvents: TmuxEventSource = (onEvent) =>
  listen<TmuxEvent>(CLAUDE_TMUX_EVENT, (event) => {
    onEvent(event.payload);
  });

/** The command scope's client: the deprecated shim; a tab uses `claudeTmuxClientFor(scope)`. */
export const {
  startSession,
  stopSession,
  interruptSession,
  getStatus,
  getTranscriptPage,
  getTaskList,
  getPendingHooks,
  submit,
  switchModel,
  switchEffort,
  switchFastMode,
  switchPlanMode,
  sendText,
  sendKeys,
  answerSelectionPrompt,
  resize,
  createInteractiveTerminal,
  startInteractiveTerminal,
  writeInteractiveTerminal,
  resizeInteractiveTerminal,
  detachInteractiveTerminal,
  answerPreToolUse,
  holdHook,
  replyHook,
  listPreviousSessions,
  subscribe,
} = createClaudeTmuxClient(commandBackendClient, windowTmuxEvents);
