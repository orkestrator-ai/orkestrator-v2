/**
 * `claude-tmux` commands (plan item 7002): a Claude Code session hosted in a
 * tmux pane per `(environmentId, tabId)`: start and stop, prompts and keys,
 * mode switches, hook answers, the transcript and task list, and the
 * interactive terminal attached to the pane.
 *
 * Argument schemas declare every key the handler reads and decode tolerantly
 * (§11.4). A key the handler required with `asString`/`asBoolean` is
 * `Schema.String`/`Schema.Boolean` (same "Expected tabId to be a string"
 * text); a key it reads leniently or checks with its own message (positive
 * dimensions, non-negative revisions, `held`) stays `optionalKey(Unknown)`.
 * `environmentId` comes first: every handler checks it before `tabId`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { claudeTmuxDomain } from "./domain.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

/** `TmuxAgentObservation` (`@orkestrator/protocol/tmux-observation`). */
export const TmuxAgentObservationSchema = Schema.Struct({
  generation: Schema.optionalKey(Schema.String),
  revision: Schema.Finite,
  observedAt: Schema.String,
  usage: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      role: Schema.optionalKey(Schema.String),
      toolUseCount: Schema.optionalKey(Schema.Finite),
      tokenCount: Schema.Finite,
      tokenCountText: Schema.String,
    }),
  ),
  prompt: Schema.NullOr(
    Schema.Struct({
      question: Schema.NullOr(Schema.String),
      options: Schema.Array(
        Schema.Struct({
          number: Schema.Finite,
          label: Schema.String,
          optionIndex: Schema.Finite,
          selected: Schema.Boolean,
        }),
      ),
      selectedOptionIndex: Schema.NullOr(Schema.Finite),
      inputMode: Schema.Literals(["navigate", "number"]),
    }),
  ),
}).annotate({ identifier: "TmuxAgentObservation" });

/** A tmux tab's session as the backend holds it (`TmuxStatus`, `tmux-hooks.ts`). */
export const TmuxStatusSchema = Schema.Struct({
  tab_id: Schema.String,
  environment_id: Schema.String,
  session_id: Schema.NullOr(Schema.String),
  tmux_session: Schema.String,
  running: Schema.Boolean,
  transcript_path: Schema.NullOr(Schema.String),
  resumed: Schema.Boolean,
  busy: Schema.Boolean,
  busy_started_at: Schema.NullOr(Schema.Finite),
  permission_mode: Schema.String,
  fast_mode: Schema.NullOr(Schema.Boolean),
  observation: TmuxAgentObservationSchema,
  info_events: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        kind: Schema.String,
        message: Schema.String,
        receivedAt: Schema.String,
      }),
    ),
  ),
}).annotate({ identifier: "TmuxStatus" });

/**
 * One record of Claude Code's JSONL transcript, with the backend's stamps
 * (`taskSnapshots`, `toolDiffs`). The format is Claude's, not ours, so the
 * record is kept whole: an object whose keys are not narrowed here.
 */
export const ClaudeTranscriptLineSchema = Schema.Record(Schema.String, Schema.Unknown).annotate({
  identifier: "ClaudeTranscriptLine",
});

/** A bounded stretch of the transcript, oldest line first. */
export const TmuxTranscriptPageSchema = Schema.Struct({
  lines: Schema.Array(ClaudeTranscriptLineSchema),
  earlierCursor: Schema.NullOr(Schema.String),
  expired: Schema.optionalKey(Schema.Boolean),
  permissionMode: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "TmuxTranscriptPage" });

/** `TaskListSnapshot` (`@orkestrator/protocol/task-list`). */
export const TaskListSnapshotSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      subject: Schema.String,
      status: Schema.Literals(["pending", "in_progress", "completed"]),
    }),
  ),
  changedTaskId: Schema.optionalKey(Schema.String),
  complete: Schema.Boolean,
  truncated: Schema.optionalKey(Schema.Finite),
}).annotate({ identifier: "TaskListSnapshot" });

/** Whether a waiting hook's countdown can be paused (`TmuxHookHold`). */
export const TmuxHookHoldSchema = Schema.Struct({
  available: Schema.Boolean,
  heldAt: Schema.optionalKey(Schema.Finite),
  reason: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "TmuxHookHold" });

/** A blocking hook waiting for an answer. `payload` is the hook's own JSON. */
export const TmuxPendingHookSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  payload: Schema.Unknown,
  requestedAt: Schema.optionalKey(Schema.Finite),
  expiresAt: Schema.optionalKey(Schema.Finite),
  hold: Schema.optionalKey(TmuxHookHoldSchema),
}).annotate({ identifier: "TmuxPendingHook" });

/** A recorded session the user can resume. */
export const PreviousTmuxSessionSchema = Schema.Struct({
  session_id: Schema.String,
  title: Schema.NullOr(Schema.String),
  last_activity_unix: Schema.Finite,
  message_count: Schema.Finite,
  transcript_path: Schema.String,
}).annotate({ identifier: "PreviousTmuxSession" });

const tab = { environmentId: Schema.String, tabId: Schema.String };
const tabArgs = Schema.Struct(tab);
const interactiveArgs = Schema.Struct({ terminalSessionId: Schema.String });

/** Re-arms or stops the per-container Claude state polls. Backend-internal. */
export const reconcileClaudeStatePollingCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "reconcile_claude_state_polling",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({}),
  result: Schema.Void,
  critical: [],
});

// --- Session lifecycle ---

export const claudeTmuxStartCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_start",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...tab,
    initialPrompt: optionalUnknown,
    model: optionalUnknown,
    effort: optionalUnknown,
    fastMode: optionalUnknown,
    resumeSessionId: optionalUnknown,
    replaceExisting: optionalUnknown,
  }),
  result: TmuxStatusSchema,
  critical: [],
});

export const claudeTmuxStopCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_stop",
  since: 1,
  access: "workspace",
  read: false,
  args: tabArgs,
  result: Schema.Void,
  critical: [],
});

export const claudeTmuxInterruptCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_interrupt",
  since: 1,
  access: "workspace",
  read: false,
  args: tabArgs,
  result: Schema.Void,
  critical: [],
});

/** The tab's session, or `null` when none is registered. */
export const claudeTmuxStatusCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_status",
  since: 1,
  access: "workspace",
  read: false,
  // livenessMaxAgeMs: a background reader takes the poll loop's recent
  // `has-session` answer instead of probing (a finite number, else ignored).
  args: Schema.Struct({ ...tab, livenessMaxAgeMs: optionalUnknown }),
  result: Schema.NullOr(TmuxStatusSchema),
  critical: [],
});

/** Kills tmux sessions no pane layout references any more. Backend-internal. */
export const claudeTmuxReconcileOrphansCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_reconcile_orphans",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({}),
  result: Schema.Struct({ reaped: Schema.Finite, skipped: Schema.Boolean }),
  critical: [],
});

export const claudeTmuxListPreviousSessionsCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_list_previous_sessions",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Schema.String }),
  result: Schema.Array(PreviousTmuxSessionSchema),
  critical: [],
});

// --- Transcript and tasks ---

/**
 * One page of the transcript (`page: { before?, sessionId? }`), or, without
 * `page`, the whole file as an array (a client that predates paging; see the
 * compatibility register).
 */
export const claudeTmuxTranscriptCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_transcript",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...tab, page: optionalUnknown }),
  result: Schema.Union([Schema.Array(ClaudeTranscriptLineSchema), TmuxTranscriptPageSchema]),
  critical: [],
});

export const claudeTmuxTasksCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_tasks",
  since: 1,
  access: "workspace",
  read: false,
  args: tabArgs,
  result: TaskListSnapshotSchema,
  critical: [],
});

export const claudeTmuxPendingHooksCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_pending_hooks",
  since: 1,
  access: "workspace",
  read: false,
  args: tabArgs,
  result: Schema.Array(TmuxPendingHookSchema),
  critical: [],
});

// --- Input ---

export const claudeTmuxSubmitCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_submit",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...tab, text: Schema.String }),
  result: Schema.Void,
  critical: [],
});

/** A queued prompt's dispatch, serialised with teardown. Backend-internal (the prompt queue). */
export const claudeTmuxSubmitQueuedCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_submit_queued",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ ...tab, text: Schema.String }),
  result: Schema.Void,
  critical: [],
});

export const claudeTmuxSendTextCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_send_text",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...tab, text: Schema.String }),
  result: Schema.Void,
  critical: [],
});

export const claudeTmuxSendKeysCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_send_keys",
  since: 1,
  access: "workspace",
  read: false,
  // Non-string entries are dropped, and a non-array sends nothing.
  args: Schema.Struct({ ...tab, keys: optionalUnknown }),
  result: Schema.Void,
  critical: [],
});

/** Picks an option of the pane's selection prompt, only while it is still the prompt shown. */
export const claudeTmuxAnswerSelectionPromptCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_answer_selection_prompt",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...tab,
    expectedGeneration: Schema.String,
    // Non-negative integers, checked by the handler with its own text.
    expectedRevision: optionalUnknown,
    expectedPromptFingerprint: Schema.String,
    optionIndex: optionalUnknown,
  }),
  result: Schema.Void,
  // The expected prompt: a receiver ignoring it would press the option on
  // whatever prompt the pane shows now.
  critical: ["expectedGeneration", "expectedRevision", "expectedPromptFingerprint"],
});

export const claudeTmuxResizeCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_resize",
  since: 1,
  access: "workspace",
  read: false,
  // Positive numbers, checked by the handler with its own text.
  args: Schema.Struct({ ...tab, cols: optionalUnknown, rows: optionalUnknown }),
  result: Schema.Void,
  critical: [],
});

// --- Mode switches ---

export const claudeTmuxSwitchModelCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_switch_model",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...tab, model: Schema.String }),
  result: Schema.Void,
  critical: [],
});

export const claudeTmuxSwitchEffortCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_switch_effort",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...tab, effort: Schema.String }),
  result: Schema.Void,
  critical: [],
});

export const claudeTmuxSwitchFastModeCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_switch_fast_mode",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...tab, fastMode: Schema.Boolean }),
  result: Schema.Void,
  critical: [],
});

/** Answers the permission mode the session ended in. */
export const claudeTmuxSwitchPlanModeCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_switch_plan_mode",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...tab, planMode: Schema.Boolean }),
  result: Schema.String,
  critical: [],
});

// --- Hooks ---

export const claudeTmuxAnswerPreToolUseCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_answer_pre_tool_use",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...tab,
    eventId: Schema.String,
    decision: Schema.String,
    reason: optionalUnknown,
  }),
  result: Schema.Void,
  critical: [],
});

/** Answers any hook with the caller's JSON. */
export const claudeTmuxReplyHookCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_reply_hook",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...tab,
    eventKind: Schema.String,
    eventId: Schema.String,
    response: optionalUnknown,
  }),
  result: Schema.Void,
  critical: [],
});

/** Pauses (`held`) or resumes a blocking hook's countdown. */
export const claudeTmuxHoldHookCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_hold_hook",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    // A boolean, checked by the handler ("held must be a boolean").
    held: optionalUnknown,
    ...tab,
    eventKind: Schema.String,
    eventId: Schema.String,
  }),
  result: Schema.Struct({
    result: Schema.Literals(["applied", "unchanged", "unavailable", "settled"]),
    hook: Schema.optionalKey(TmuxPendingHookSchema),
  }),
  critical: [],
});

// --- Interactive terminal on the pane ---

/**
 * How long an interactive terminal created with `leased: true` keeps
 * capturing after its last renewal (to-do 7745, retired). A page reload, a closed
 * window, a renderer crash or a cut link never sends a detach, so without a
 * lease the backend captured the pane for nobody until the environment's
 * tmux cleanup or a restart.
 */
export const CLAUDE_TMUX_INTERACTIVE_LEASE_MS = 45_000;
/** How often an attached client renews its interactive terminal's lease. */
export const CLAUDE_TMUX_INTERACTIVE_RENEW_MS = 15_000;

/**
 * Opens a PTY attached to the tab's tmux pane; answers its session id.
 * `leased: true` announces that the client renews the terminal with
 * `claude_tmux_renew_interactive_terminal`; only such a terminal is detached
 * when its lease lapses, so an older client keeps detach-on-unmount alone.
 */
export const claudeTmuxCreateInteractiveTerminalCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_create_interactive_terminal",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...tab,
    cols: optionalUnknown,
    rows: optionalUnknown,
    leased: Schema.optionalKey(Schema.Boolean),
  }),
  result: Schema.String,
  critical: [],
});

export const claudeTmuxStartInteractiveTerminalCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_start_interactive_terminal",
  since: 1,
  access: "workspace",
  read: false,
  args: interactiveArgs,
  result: Schema.Void,
  critical: [],
});

export const claudeTmuxWriteInteractiveTerminalCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_write_interactive_terminal",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ terminalSessionId: Schema.String, data: Schema.String }),
  result: Schema.Void,
  critical: [],
  hotPath: true,
});

export const claudeTmuxResizeInteractiveTerminalCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_resize_interactive_terminal",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    terminalSessionId: Schema.String,
    cols: optionalUnknown,
    rows: optionalUnknown,
  }),
  result: Schema.Void,
  critical: [],
  hotPath: true,
});

export const claudeTmuxDetachInteractiveTerminalCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_detach_interactive_terminal",
  since: 1,
  access: "workspace",
  read: false,
  args: interactiveArgs,
  result: Schema.Void,
  critical: [],
});

/**
 * Keeps an interactive terminal's capture loop alive for another
 * {@link CLAUDE_TMUX_INTERACTIVE_LEASE_MS}. `renewed: false` means the
 * backend no longer holds the terminal (its lease lapsed while the client was
 * asleep or throttled, or the environment's tmux was cleaned up), so the
 * client creates a new one.
 */
export const claudeTmuxRenewInteractiveTerminalCommand = defineCommand({
  domain: claudeTmuxDomain,
  name: "claude_tmux_renew_interactive_terminal",
  since: 1,
  access: "workspace",
  read: false,
  args: interactiveArgs,
  result: Schema.Struct({ renewed: Schema.Boolean }),
  critical: [],
});

/** Every `claude-tmux` command definition. */
export const CLAUDE_TMUX_COMMANDS = [
  reconcileClaudeStatePollingCommand,
  claudeTmuxStartCommand,
  claudeTmuxStopCommand,
  claudeTmuxInterruptCommand,
  claudeTmuxStatusCommand,
  claudeTmuxReconcileOrphansCommand,
  claudeTmuxListPreviousSessionsCommand,
  claudeTmuxTranscriptCommand,
  claudeTmuxTasksCommand,
  claudeTmuxPendingHooksCommand,
  claudeTmuxSubmitCommand,
  claudeTmuxSubmitQueuedCommand,
  claudeTmuxSendTextCommand,
  claudeTmuxSendKeysCommand,
  claudeTmuxAnswerSelectionPromptCommand,
  claudeTmuxResizeCommand,
  claudeTmuxSwitchModelCommand,
  claudeTmuxSwitchEffortCommand,
  claudeTmuxSwitchFastModeCommand,
  claudeTmuxSwitchPlanModeCommand,
  claudeTmuxAnswerPreToolUseCommand,
  claudeTmuxReplyHookCommand,
  claudeTmuxHoldHookCommand,
  claudeTmuxCreateInteractiveTerminalCommand,
  claudeTmuxStartInteractiveTerminalCommand,
  claudeTmuxWriteInteractiveTerminalCommand,
  claudeTmuxResizeInteractiveTerminalCommand,
  claudeTmuxDetachInteractiveTerminalCommand,
  claudeTmuxRenewInteractiveTerminalCommand,
] as const;
