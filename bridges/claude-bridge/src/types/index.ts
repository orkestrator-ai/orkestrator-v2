import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";
// Type definitions for Claude Bridge Server
import type { RecentlyRevisedRows } from "@orkestrator/protocol/node/revised-rows";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { TranscriptWindowMetadata } from "@orkestrator/protocol/node/transcript-window";

import type { TaskListSnapshot, TaskRegistry } from "@orkestrator/protocol/task-list";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import type { AgentInteractionHold } from "@orkestrator/protocol/agent-interactions";
import type { NativeAgentContextCategory } from "@orkestrator/protocol/native-agent";

export type {
  JsonSchema,
  StructuredOutputFailure,
  StructuredOutputFailureCode,
  StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";

export type {
  TaskListSnapshot,
  TaskSnapshotItem,
  TaskSnapshotStatus,
} from "@orkestrator/protocol/task-list";

// ============================================================================
// Claude Agent SDK Message Types
// These types represent messages from the Claude Agent SDK streaming interface
// ============================================================================

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";

/**
 * Which top-level SDK message types the prompt loop accounts for.
 *
 * A `Record` over the SDK's own union rather than a list, so a Claude Agent SDK
 * release that adds a message type **fails this typecheck** instead of the
 * message arriving as an unexplained gap. `true` means the dispatch has a
 * branch that does something with it; `false` means known, deliberately not
 * consumed yet, and recorded as drift so the gap is visible rather than
 * invisible.
 *
 * The union has thirty-odd members but only eleven `type` values, because most
 * variants are `system` subtypes. That is why the `system` branch does its own
 * subtype dispatch and this table cannot stand in for it.
 */
export const HANDLED_SDK_MESSAGE_TYPES: Record<SDKMessage["type"], boolean> = {
  assistant: true,
  user: true,
  result: true,
  system: true,
  stream_event: true,
  rate_limit_event: true,
  prompt_suggestion: true,
  // A live sub-line on the tool row it names, folded onto that row by the
  // backend projection.
  tool_progress: true,
  // A one-line summary of a completed tool call, shown as a status row.
  tool_use_summary: true,
  // Clears the bridge transcript and says so, because the model no longer has
  // the history the old messages showed.
  conversation_reset: true,
  // Sign-in state changing mid-session is a visible, actionable notice.
  auth_status: true,
};

export function isHandledSdkMessageType(type: unknown): boolean {
  // Own keys only: `in` also finds `constructor` and the rest of the prototype.
  return typeof type === "string" && Object.hasOwn(HANDLED_SDK_MESSAGE_TYPES, type);
}

/**
 * Top-level frames the CLI puts on the SDK stream that the public `SDKMessage`
 * union does not name (they are `@internal` in the CLI's own schemas), so
 * {@link HANDLED_SDK_MESSAGE_TYPES} cannot key on them. Each one here has been
 * read and deliberately needs nothing from the bridge; anything else outside
 * the union is still counted as drift.
 */
const KNOWN_INTERNAL_SDK_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  // The fate of a uuid-stamped inbound message: queued, started, then
  // completed / cancelled / discarded / refused. The CLI emits it for every
  // prompt and steer because the bridge stamps each with a client uuid. The
  // bridge already learns the same outcomes from the turn's result (which
  // echoes that uuid) and its own interrupt and teardown paths; `refused`
  // applies only to cross-session peer messages, which this bridge never sends.
  "command_lifecycle",
]);

export function isKnownInternalSdkMessageType(type: unknown): boolean {
  return typeof type === "string" && KNOWN_INTERNAL_SDK_MESSAGE_TYPES.has(type);
}

/** Every `subtype` the SDK can put on a `type: "system"` message. */
export type SdkSystemSubtype = Extract<SDKMessage, { type: "system" }>["subtype"];

/**
 * What the prompt loop does with a `system` subtype once it has run its branch.
 *
 * - `handled`: a branch turns it into transcript rows or session state. No
 *   health notice: the handling is the record, and a notice would only repeat
 *   it (the task lifecycle subtypes used to be counted twice this way).
 * - `handled+notice`: a branch handles it and a provider notice is kept too,
 *   because the count itself is diagnostic (retries, refusals).
 * - `notice`: nothing consumes it yet. Recorded as a provider notice so the gap
 *   is visible in the health panel rather than silent.
 * - `ignored`: high-frequency inventory with nothing to show. Recorded, it
 *   drowned every real notice (thousands of hook frames a day).
 */
export type SystemSubtypeDisposition = "handled" | "handled+notice" | "notice" | "ignored";

/**
 * The `system` counterpart of {@link HANDLED_SDK_MESSAGE_TYPES}.
 *
 * Keyed on the SDK's own union for the same reason: an SDK release that adds a
 * subtype fails this typecheck, so someone decides what it means instead of it
 * landing in the health panel by default. A subtype that arrives at runtime
 * without an entry (an SDK newer than these types) is counted as drift.
 */
export const SYSTEM_SUBTYPE_DISPOSITIONS: Record<SdkSystemSubtype, SystemSubtypeDisposition> = {
  init: "handled",
  commands_changed: "handled",
  local_command_output: "handled",
  task_started: "handled",
  task_progress: "handled",
  task_updated: "handled",
  task_notification: "handled",
  background_tasks_changed: "handled",
  // Drives the live thinking-token estimate on the session snapshot.
  thinking_tokens: "handled",
  // Drives the session activity (compacting), a failed-compaction row, and
  // plan-mode reconciliation.
  status: "handled",
  // Graded by outcome in its own branch: only a failure is worth a notice.
  hook_response: "handled",
  informational: "handled",
  permission_denied: "handled",
  memory_recall: "handled",
  api_retry: "handled+notice",
  hook_started: "ignored",
  hook_progress: "ignored",
  // The compaction row comes from the PostCompact hook, which also carries the
  // trigger; the boundary itself stays countable.
  compact_boundary: "notice",
  control_request_progress: "notice",
  model_refusal_fallback: "notice",
  model_refusal_no_fallback: "notice",
  mirror_error: "notice",
  plugin_install: "notice",
  session_state_changed: "notice",
  worker_shutting_down: "notice",
  notification: "notice",
  files_persisted: "notice",
  elicitation_complete: "notice",
};

/** The disposition for a runtime subtype, or `undefined` when the SDK is newer than this table. */
export function systemSubtypeDisposition(subtype: unknown): SystemSubtypeDisposition | undefined {
  if (typeof subtype !== "string" || !Object.hasOwn(SYSTEM_SUBTYPE_DISPOSITIONS, subtype)) {
    return undefined;
  }
  return SYSTEM_SUBTYPE_DISPOSITIONS[subtype as SdkSystemSubtype];
}

/** Base SDK message with common fields */
export interface SdkMessageBase {
  type: string;
  subtype?: string;
  uuid?: string;
}

/** SDK system message with optional subtype */
export interface SdkSystemMessage extends SdkMessageBase {
  type: "system";
  subtype?: "init" | "compact_boundary" | "clear" | string;
}

/** Compact boundary system message from /compact command */
export interface SdkCompactBoundaryMessage extends SdkSystemMessage {
  subtype: "compact_boundary";
  compact_metadata?: {
    pre_tokens?: number;
    post_tokens?: number;
    trigger?: string;
  };
}

/** SDK result message when query completes */
export interface SdkResultMessage extends SdkMessageBase {
  type: "result";
  subtype?:
    | "success"
    | "error_max_turns"
    | "error_during_execution"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries"
    | string;
  result?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  ttft_ms?: number;
  errors?: string[];
  startup_failure_reason?: import("@anthropic-ai/claude-agent-sdk").SDKStartupFailureReason;
  terminal_reason?: import("@anthropic-ai/claude-agent-sdk").TerminalReason;
  usage?: Record<string, unknown>;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
      contextWindow?: number;
    }
  >;
  permission_denials?: unknown[];
  /** Present on successful turns requested with Agent SDK `outputFormat`. */
  structured_output?: unknown;
  /**
   * Transcript uuid of the user message that opened this turn.
   *
   * The authoritative link between the locally generated id the bridge handed
   * the client and the record a fork or file rewind must address.
   */
  user_message_uuid?: string;
  /**
   * Client uuids of every user message this turn consumed, including sends
   * folded into it. Absent on a turn the CLI started itself, such as the
   * answer to a replayed background-task notification.
   */
  user_message_uuids?: string[];
  /** How many results this process wrote before this one; absent from older producers. */
  result_index?: number;
  /** User sends waiting in the provider queue; absent on older producers. */
  queued_turn_count?: number;
}

/** Type guard for compact boundary message */
export function isSdkCompactBoundaryMessage(
  message: SdkMessageBase,
): message is SdkCompactBoundaryMessage {
  return message.type === "system" && message.subtype === "compact_boundary";
}

/** Type guard for result message */
export function isSdkResultMessage(message: SdkMessageBase): message is SdkResultMessage {
  return message.type === "result";
}

// ============================================================================
// Application Types
// ============================================================================

/** Diff metadata for edit tool operations */
export interface ToolDiffMetadata {
  filePath?: string;
  additions?: number;
  deletions?: number;
  before?: string;
  after?: string;
  diff?: string;
}

/** Normalized message part */
export interface NormalizedPart {
  type:
    | "text"
    | "thinking"
    | "tool-invocation"
    | "tool-result"
    | "file"
    | "compaction"
    | "retry"
    | "image"
    | "status"
    | "progress";
  content: string;
  /** When this content block first arrived from the SDK. */
  createdAt?: string;
  /**
   * When this tool's result arrived, for a call that launched a long-running
   * child (a subagent, or anything else presented as an agent card).
   *
   * Taken from the message carrying the result when the provider supplied a
   * timestamp. Older emitters fall back to one clock shared by the result and
   * its transcript materialization, so a replay preserves the same relative
   * position even when it cannot preserve the original absolute time. See
   * `settledAt` on the protocol's background-task summary for the same idea on
   * the snapshot side.
   */
  settledAt?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: ToolDiffMetadata;
  /**
   * What a Bash call changed in the worktree, measured around the command
   * because its input cannot say (see `command-changes.ts`).
   */
  commandChanges?: MeasuredWorkspaceChange;
  /**
   * The permission layer refused this call (a deny rule, auto mode's
   * classifier, `dontAsk`), as opposed to the tool running and failing.
   * `source` is the SDK's decision-reason discriminator, e.g. `rule`.
   */
  toolDenied?: { reason?: string; source?: string };
  /** Tool use ID for tracking tool invocations across messages */
  toolUseId?: string;
  /** Parent Task tool use ID - used to group child tools under their parent Task */
  parentTaskUseId?: string;
  /** Internal: Message UUID for tracking thinking parts across streaming updates */
  sourcePartId?: string;
  /** Whether this tool is from an MCP server */
  isMcpTool?: boolean;
  /** The MCP server name if this is an MCP tool */
  mcpServerName?: string;
  /**
   * State of the whole session task list immediately after this tool call, for
   * task tools (TaskCreate/TaskUpdate/TaskGet/TaskList). Those tools each act on
   * a single task, so their own args and output describe only that task; this is
   * what lets the renderer show the resulting list. Absent when the call's
   * output could not be parsed, which tells the renderer to show the raw call
   * rather than a list it cannot vouch for.
   */
  taskSnapshot?: TaskListSnapshot;
  /** Context occupancy before a compaction, on a `compaction` part. */
  compactedTokensBefore?: number;
  /** Attempt number on a `retry` part. */
  retryAttempt?: number;
  /** Where an `image` part came from. */
  imageSource?: "attachment" | "generated" | "viewed";
  /** How long the tool a `progress` part describes has been running. */
  elapsedMs?: number;
  /** Severity of a `status` row. */
  severity?: "info" | "warning" | "error";
  /** Readable summary of a token count, shown beside a compaction boundary. */
  tokenCountText?: string;
  /** Resolvable location of an `image` part's bytes. */
  fileUrl?: string;
  /** Original attachment name when the readable path is a staged one. */
  filename?: string;
}

/** Normalized message format */
export interface NormalizedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: NormalizedPart[];
  createdAt: string;
  /** Model observed on the provider's assistant response. */
  modelId?: string;
  /**
   * UUID of the record this message occupies in the SDK's persisted transcript.
   *
   * The only id that a fork boundary or a file rewind may be resolved against.
   * Live messages carry a locally generated `id` (`msg-…`), which exists
   * nowhere on disk, so without this the bridge would have to *guess* which
   * transcript record the user pointed at — and both consumers of that answer
   * (`forkSession({ upToMessageId })` and `rewindFiles()`) act destructively on
   * it. Absent means "not resolvable"; callers must fail rather than guess.
   */
  sdkUuid?: string;
  /**
   * How many frames have been published for this message, starting at 1 for
   * the full frame. Present only on assistant messages the streaming path
   * publishes incrementally.
   *
   * This is what makes a `message.patched` gap detectable: a recipient applies
   * a patch only when it is the immediate successor of the revision it holds,
   * and otherwise refetches. It is carried on the message (rather than only on
   * the event) so the REST transcript is a valid base for the next patch —
   * without that, a client that recovered by refetching could never rejoin the
   * patch stream.
   */
  revision?: number;
}

export interface ClaudeQueryControl {
  interrupt?: () => Promise<{ still_queued: string[]; cancelled?: string[] } | undefined>;
  pushInput?: (
    message: import("@anthropic-ai/claude-agent-sdk").SDKUserMessage,
  ) => boolean | "capacity-exceeded";
  setPermissionMode?: (mode: PermissionMode) => Promise<void>;
  setModel?: (model?: string) => Promise<void>;
  setMaxThinkingTokens?: (
    tokens: number | null,
    display?: "summarized" | "omitted" | null,
  ) => Promise<void>;
  applyFlagSettings?: (settings: Record<string, unknown>) => Promise<void>;
  /**
   * The CLI's `get_settings` answer. Not in the SDK's declarations, so it is
   * feature-detected and its response validated at runtime; the bridge reads
   * only the runtime-resolved `applied` block (see `ultracode.ts`).
   */
  getSettings?: () => Promise<unknown>;
  supportedCommands?: () => Promise<import("@anthropic-ai/claude-agent-sdk").SlashCommand[]>;
  initializationResult?: () => Promise<unknown>;
  reloadSkills?: () => Promise<{ skills: import("@anthropic-ai/claude-agent-sdk").SlashCommand[] }>;
  reloadPlugins?: () => Promise<unknown>;
  mcpServerStatus?: () => Promise<import("@anthropic-ai/claude-agent-sdk").McpServerStatus[]>;
  reconnectMcpServer?: (name: string) => Promise<void>;
  toggleMcpServer?: (name: string, enabled: boolean) => Promise<void>;
  accountInfo?: () => Promise<import("@anthropic-ai/claude-agent-sdk").AccountInfo>;
  stopTask?: (taskId: string) => Promise<void>;
  setMcpServers?: (
    servers: Record<string, import("@anthropic-ai/claude-agent-sdk").McpServerConfig>,
  ) => Promise<unknown>;
  backgroundTasks?: (toolUseId?: string) => Promise<boolean>;
  getContextUsage?: (options?: { detail?: "summary" | "full" }) => Promise<unknown>;
  /**
   * Structured data behind Claude Code's `/usage` screen.
   *
   * The Agent SDK deliberately marks this control request experimental, so the
   * bridge feature-detects it and validates the unknown response at runtime.
   */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (options?: {
    skipBehaviors?: boolean;
  }) => Promise<unknown>;
  rewindFiles?: (userMessageId: string, options?: { dryRun?: boolean }) => Promise<unknown>;
  close?: () => void | Promise<void>;
}

/**
 * Provenance of a session's command inventory.
 *
 * - `live`: `supportedCommands()` on the session's own turn query.
 * - `replacement`: a `system/commands_changed` push, a full replacement.
 * - `probe`: a control-only discovery CLI configured like the session's turns.
 *   Provisional: it cannot see MCP-prompt commands or per-turn options.
 * - `init`: names from the turn's `init` frame only (no descriptions, hints
 *   or aliases). A cold fallback that any later read supersedes.
 */
export interface ClaudeCommandInventoryState {
  authority: "live" | "replacement" | "probe" | "init";
  /** Bounded SDK rows the catalogue was derived from; absent for init names. */
  sdkCommands?: import("@anthropic-ai/claude-agent-sdk").SlashCommand[];
  /** Advances whenever the inventory is replaced with different content. */
  revision: number;
  truncated: boolean;
  /** The last attempt to refresh this inventory failed; it is retained only. */
  refreshFailed?: boolean;
  /** Discovery configuration a probe answer was computed for. */
  probeFingerprint?: string;
  /**
   * Terminal-bound names the probed CLI version reported on an earlier turn
   * (`claude-terminal-commands.ts`). Used only until this session's own init
   * frame arrives.
   */
  rememberedTerminalSlashCommands?: string[];
}

/** A provider-reported activity within a running turn. */
export type SessionTurnActivity = "compacting";

/** Session state */
/** A turn-time sign-in notice; see {@link SessionState.authNotice}. */
export interface SessionAuthNotice {
  state: "needs-auth" | "expired";
  message: string;
  /** Distinguishes a new occurrence from one the user already dismissed. */
  occurrenceId: string;
}

export interface SessionState {
  id: string;
  executionPolicy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy;
  title?: string;
  /** Whether a title generation request is already in flight */
  titleGenerationPending?: boolean;
  messages: NormalizedMessage[];
  status: "idle" | "running" | "error";
  /** Backend-authoritative ISO timestamp for the active user turn. */
  turnStartedAt?: string;
  abortController?: AbortController;
  createdAt: Date;
  lastActivity: Date;
  error?: string;
  /**
   * Set beside `status: "error"` when a bridge restart cut the last turn short:
   * the rollout is intact and a new prompt continues it. Cleared when the next
   * turn starts. See `session-manager-turn-interruption.ts`.
   */
  interruption?: "restart";
  /**
   * The dispatch request id of the turn `interruption` cut short, when known.
   * Status is per session, so this lets a workflow tell the notice from a newer
   * request whose turn has not started yet. Cleared with `interruption`.
   */
  interruptedRequestId?: string;
  /**
   * The dispatch request id of the latest turn the SDK took, written into the
   * turn-in-flight mark so a later process can name the request a restart cut.
   */
  turnInFlightRequestId?: string;
  /** The request id the mark on disk names, so a new turn knows to rewrite it. */
  turnInFlightMarkRequestId?: string;
  /**
   * Whether this process believes the preferences file holds a turn-in-flight
   * mark for the session, so the mark is written and cleared once per edge.
   */
  turnInFlightMarked?: boolean;
  /** Presence alone does not mean a restored mark belongs to this bridge. */
  turnInFlightMarkOwned?: boolean;
  /** SDK session ID returned from Claude Agent SDK - used for resume */
  sdkSessionId?: string;
  /** Session initialization data (MCP servers, plugins, etc.) */
  initData?: SessionInitData;
  /** Last init's plugin errors, so unchanged load failures do not reissue advisories each turn. */
  pluginErrorSignatures?: string[];
  /**
   * Ultracode requested for the live turn. The CLI can decline the request.
   */
  ultracode?: boolean;
  /** Ultracode actually applied by the CLI, when known. */
  ultracodeApplied?: boolean;
  /** Last bounded MCP inventory, retained while no turn query is attached. */
  mcpInventory?: import("@orkestrator/protocol/native-agent").NativeAgentMcpServer[];
  /**
   * Last bounded slash-command catalogue, retained for the same reason as
   * `mcpInventory`.
   *
   * Without it, a read that cannot use the turn query falls through to
   * `createProbe()`, which spawns a whole Claude CLI process. Projections run
   * on every turn boundary, so that is a process spawn per turn to answer a
   * question whose answer almost never changes.
   */
  commandInventory?: import("@orkestrator/protocol/native-agent").NativeAgentSlashCommand[];
  /**
   * Where {@link commandInventory} came from and how fresh it is. Owned by
   * `session-manager-commands.ts`; updated by live reads, `commands_changed`
   * pushes and init frames whether or not anybody is subscribed.
   */
  commandInventoryState?: ClaudeCommandInventoryState;
  /**
   * The per-turn inputs of the last real query that change which commands the
   * CLI can see, so a cold discovery probe reproduces them rather than a
   * default configuration.
   */
  commandDiscoveryInputs?: { readOnly: boolean; includeLocalSettings: boolean };
  /**
   * Which saved MCP configuration the most recent query started with, and
   * when. Runtime-only: after a restart no query has started yet, and the
   * next one records its own. Served by `/session/:id/runtime-health`.
   * `staleServers` names servers the configuration dropped that the running
   * CLI could not unload; their tools are refused until it ends.
   */
  mcpConfigRevision?: import("../services/mcp-config.js").McpConfigRevision & {
    queryStartedAt: string;
    staleServers?: string[];
  };
  /** Skill names the last explicit `reloadSkills()` reported. */
  commandSkillNames?: string[];
  /** Last completed schema-constrained turn, authoritative across UI remounts. */
  structuredOutput?: StructuredOutputResult;
  /** Request id of the structured turn currently running or last completed. */
  structuredOutputRequestId?: string;
  /**
   * Session task list state, replayed from Task tool calls. Lives on the session
   * rather than the turn because the task list outlives an individual turn, and
   * is the authoritative copy `GET /session/:id/tasks` serves.
   */
  taskRegistry?: TaskRegistry;
  /** True once the persisted SDK transcript has been normalized on demand. */
  persistedMessagesLoaded?: boolean;
  /**
   * Transcript content revision: advances whenever anything serialized from
   * {@link messages} changes, so `GET /:id/transcript` can answer a matching
   * token without walking the history.
   *
   * Not the per-message {@link NormalizedMessage.revision} (an SSE patch
   * counter), the turn generation, or any status/usage revision. Owned by
   * `transcript-revision.ts`: write it only through `markTranscriptChanged` /
   * `resetTranscriptEpoch`. Runtime-only; a restarted bridge has a new
   * transcript generation, so no token outlives the process that issued it.
   */
  transcriptRevision?: number;
  /**
   * History epoch: replaced whenever {@link messages} is replaced wholesale
   * (hydration, eviction, a conversation reset) rather than appended to or
   * edited in place. Readers treat positions from different epochs as
   * unrelated. Same ownership rules as {@link transcriptRevision}.
   */
  transcriptEpoch?: number;
  /**
   * Epoch millis of the last read or hydration of this session's state.
   *
   * Drives idle transcript eviction. Deliberately separate from
   * `lastActivity`: that field is user-facing and rewritten from on-disk
   * metadata by every reconcile, so it says when the *session* last changed,
   * not when anyone in this process last looked at it.
   */
  lastAccessedAt?: number;
  /**
   * What this bridge saw and did not understand, and what Claude reported.
   *
   * Runtime-only and not persisted: drift describes a process that is gone once
   * the bridge restarts, and reporting a dead process's counters against a live
   * one would be worse than reporting nothing. Optional so the three
   * construction sites and every test fixture stay valid; read it through
   * `sessionHealth`, which creates one on first use.
   */
  health?: RuntimeHealthRecorder;
  /**
   * Protocol capabilities the CLI advertised on `system/init`.
   *
   * An open set the SDK documents as "ignore unknown values; check each
   * capability for exactly the behaviour you use". Held so feature detection
   * reads what this CLI said rather than inferring it from a version number.
   */
  sdkCapabilities?: string[];
  /**
   * Epoch millis at which the most recent turn in this process stopped
   * streaming.
   *
   * Streamed assistant messages carry `revision` counters that a reconnecting
   * SSE client resumes `message.patched` from, and hydration from disk cannot
   * reproduce them. That only matters while a client could still be resuming,
   * so this timestamp bounds how long the transcript stays pinned for it.
   */
  lastStreamedRevisionAt?: number;
  /** Latest provider-reported context, token, cost, and rate-limit snapshot. */
  usage?: SessionUsageSnapshot;
  /**
   * The provider's running totals as of the last result message.
   *
   * A result's `total_cost_usd` and `modelUsage` are cumulative, not per turn:
   * across the results of one `query()`, and since Claude Code 2.1.277 across a
   * resume too. Each result is turned into a per-turn delta against this. When
   * a bridge attaches without the in-memory baseline, the first turn is
   * bootstrapped from completed stream calls instead of charging the saved
   * transcript as new work.
   */
  claudeUsageBaseline?: ClaudeCumulativeUsage;
  /** Monotonic lower bound from completed model calls in the query still running. */
  inProgressUsage?: SessionUsageSnapshot;
  /** Prevents an older released query from overwriting a newer turn's live meter. */
  inProgressUsageGeneration?: number;
  /** Predicted next prompt emitted by the SDK after a completed turn. */
  promptSuggestion?: string;
  /**
   * A sign-in problem met during a turn: Claude's `auth_status` failing or
   * re-authenticating, or a turn refused with `authentication_failed`. Served
   * on `GET /session/:id` and shown as the tab's `auth` notice. Cleared once a
   * model answers or Claude reports the authentication finished.
   */
  authNotice?: SessionAuthNotice;
  /**
   * What the CLI reports doing inside the running turn when the transcript
   * shows nothing (a `system/status` frame). Cleared when the turn ends.
   */
  activity?: SessionTurnActivity;
  /**
   * Live estimate of the current thinking block's tokens (`system/thinking_tokens`).
   * Approximate progress for the running indicator, never billed usage.
   * Cleared when the model's answer arrives and when the turn ends.
   */
  thinkingTokens?: number;
  /**
   * Whether the UI plan-mode toggle is on for this session.
   *
   * Owned here (and mirrored to durable per-session preferences) rather than
   * in renderer state: plan mode decides whether the next prompt runs with
   * `plan` or `bypassPermissions`, so a renderer-only value silently reset to
   * "off" by an app restart would widen what the agent is allowed to do.
   * Absent means "never set", which callers must treat as off.
   */
  planMode?: boolean;
  /**
   * Recently accepted idempotent prompt request ids.
   *
   * Mirrored to the durable session preferences file. This is deliberately a
   * bounded set: it protects one-shot launch dispatch without turning session
   * metadata into an unbounded transcript.
   */
  dispatchedRequestIds?: Set<string>;
  /**
   * The ids `dispatchedRequestIds` held when this process restored the session
   * from disk, after a restart or a same-process close. Without an in-memory
   * outcome record, the bridge cannot tell whether their turns ran.
   */
  restoredDispatchedRequestIds?: ReadonlySet<string>;
  /**
   * `dispatchedRequestIds` holds every request id this session ever claimed,
   * in this process and every earlier one (see the preferences field of the
   * same name). True only for a session created with no durable journal on
   * disk, or restored from one that says so; false for good once the bound
   * drops an id. Only then is a missing id provably never sent.
   */
  dispatchJournalComplete?: boolean;
  /**
   * Local transcript rows that are not in the SDK rollout, such as an idle
   * `/steer` exchange. Eviction and restart rehydrate from disk and then merge
   * these back so the pair does not vanish.
   */
  localTranscript?: NormalizedMessage[];
  /**
   * The durable request-id journal existed but could not be trusted.
   *
   * Stable-id prompts must remain blocked in this state: treating an unknown
   * journal as empty could replay destructive launch work after a restart.
   */
  dispatchJournalUnavailable?: boolean;
  /** Live background/subagent tasks keyed by provider task id. */
  backgroundTasks?: Record<string, BackgroundTaskSnapshot>;
  /**
   * Claude has returned the turn result, but its SDK input must remain open
   * because at least one background task is still live.
   *
   * This is authoritative bridge state rather than a renderer inference: a
   * tab can be unmounted when the result arrives and must rehydrate the same
   * explanation and controls from GET /session/:id later.
   */
  completionBlockedByBackgroundTasks?: boolean;
  /**
   * Provider rate-limit windows, held independently of {@link usage}.
   *
   * `rate_limit_event` arrives mid-turn, long before the first `result` builds
   * a usage snapshot, so hanging these off `usage` dropped every window the
   * first turn reported.
   */
  rateLimits?: SessionRateLimitWindow[];
  /**
   * True while a destructive file rewind is restoring the working tree.
   *
   * A rewind is not a turn, so `status` stays `idle` throughout; without a
   * separate flag a prompt accepted a millisecond later would run against files
   * that are being rewritten underneath it.
   */
  rewindInProgress?: boolean;
  /** True after durable deletion has claimed the session and before removal. */
  deleting?: boolean;
  /**
   * Rows this process changed most recently. A late update can land on a row
   * newer ones have pushed out of the live transcript window; the transcript
   * route sends those rows alongside the window so a reader refreshes them.
   */
  revisedRows?: RecentlyRevisedRows;
  /** Single in-flight persisted transcript read shared by mounts and prompts. */
  persistedHydration?: Promise<
    | {
        messages: NormalizedMessage[];
        taskRegistry: TaskRegistry;
      }
    | undefined
  >;
  /** Control for the currently executing (or most recently completed) turn. */
  queryControl?: ClaudeQueryControl;
  /**
   * The one Claude CLI this session runs, while it is alive.
   *
   * A turn that ends while that process still owns background work leaves it
   * running, and the next prompt is written into it rather than into a second
   * process resumed from the same rollout. See `session-manager-runtime.ts`.
   */
  claudeRuntime?: import("../services/session-manager-runtime.js").ClaudeRuntime;
  /**
   * The session CLI's control once its input is closed and it is shutting down
   * (`drainClaudeRuntime`).
   *
   * Any control request issued until the process exits races that exit and is
   * rejected by the SDK with "Query closed before response received". Marking
   * the control lets
   * read-only catalogue calls skip a request that cannot be answered and serve
   * a cached answer instead; writes still attempt it, because a caller asking
   * to change state deserves the real error.
   */
  queryControlDraining?: ClaudeQueryControl;
  /**
   * Re-evaluate whether the current streaming prompt may close its input.
   *
   * A Claude result is not terminal while background agents are live. The
   * callback is installed only for the active turn and ends that turn once it
   * has a result and no live background task remains; the CLI stays warm.
   */
  finishTurnInputIfSettled?: () => void;
  /**
   * Control that owns each live background task.
   *
   * There is one process per session (`claudeRuntime`), so every entry names
   * its control; the map is what keeps that control from being closed while a
   * task still runs after its turn released the foreground.
   */
  backgroundTaskControls?: Map<string, ClaudeQueryControl>;
  /**
   * Built-in Bash calls whose tool result has not arrived yet.
   *
   * These are deliberately not exposed as background tasks: a foreground
   * command is only a candidate until its provider-authored result says it was
   * backgrounded. Retaining the owning control here prevents a result frame
   * that races ahead of that evidence from closing the CLI's stdin.
   */
  backgroundTaskCandidates?: Map<string, ClaudeQueryControl>;
  /**
   * Recent Bash commands and unmatched results by tool-use id.
   *
   * No task message names a shell task's command, and a background
   * subagent's tool calls never reach this stream, so this is what lets a
   * task the CLI registers for one of those calls say what it runs. Bounded.
   */
  shellCommands?: Map<
    string,
    { command?: string; outputTail?: string; error?: string; completed?: boolean }
  >;
  /** Dispatches whose released query is awaiting a background-task continuation. */
  retainedContinuationRequestIds?: Set<string>;
  /**
   * Tasks the level signal dropped before their terminal edge explained why.
   *
   * The SDK leaves the order of `background_tasks_changed` and
   * `task_notification` for one transition unspecified. Through Agent SDK
   * 0.3.284 the level came first; 0.3.292 (still in 0.3.309) documents a
   * finishing task leaving the level *after* its edge. When the level does come first, the task
   * leaves the live set with no outcome attached. Parking the
   * snapshot here keeps liveness honest — the task is gone from
   * {@link backgroundTasks}, so no stale running indicator can wedge — while
   * still letting the edge settle it with its original description and start
   * time instead of a fabricated one.
   */
  settlingBackgroundTasks?: Map<
    string,
    { task: BackgroundTaskSnapshot; owner: ClaudeQueryControl }
  >;
  /**
   * Generation of the most recently started turn.
   *
   * A released turn can be superseded by a follow-up while background work it
   * started is still running. Only the latest generation may reclaim the
   * foreground; an older one publishing `running` would take abort ownership
   * away from the turn the user is actually waiting on.
   */
  latestTurnGeneration?: number;
  /**
   * The turn generation a user stop (`POST /session/:id/abort`) asked to
   * interrupt. The CLI reports a stop that lands before any text streamed as
   * an aborted `error_during_execution` result; for this turn that result is
   * the stop the user asked for, not a failure.
   */
  interruptRequestedGeneration?: number;
  /**
   * At-most-once journal for `/steer`. Survives a bridge restart via session
   * preferences so a retried request id cannot be pushed twice.
   */
  steerJournal?: Map<string, ClaudeSteerJournalEntry>;
  /**
   * Close the pre-steer assistant row so later deltas start a fresh message
   * below the steered instruction, matching Codex and Pi.
   */
  splitAssistantAfterSteer?: () => void;
}

export interface ClaudeSteerJournalEntry {
  requestId: string;
  inputDigest: string;
  expectedRunId: string;
  state: "prepared" | "dispatched" | "absent" | "unknown" | "capacity-exceeded";
  createdAt: number;
}

export interface SessionRateLimitWindow {
  label: string;
  usedPercent?: number;
  resetsAt?: string;
}

/**
 * Outcome of a background-task stop request.
 *
 * Discriminated so the HTTP layer can tell "there is nothing by that name"
 * (404) from "the task exists but no live control channel can reach it" (409);
 * a single boolean collapsed both into a misleading 404.
 */
export type StopBackgroundTaskResult =
  | { ok: true }
  | {
      ok: false;
      reason: "session_not_found" | "task_not_found" | "no_control_channel";
      message: string;
    };

/** Running provider totals carried by a Claude result message. */
export interface ClaudeCumulativeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SessionUsageSnapshot {
  usedTokens: number;
  /** Context-window capacity, when Claude reports it. */
  totalTokens?: number;
  /** Context-window utilization, present only with `totalTokens`. */
  percentUsed?: number;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  lastTurnTokens?: number;
  sessionTokens?: number;
  costUsd?: number;
  durationMs?: number;
  apiDurationMs?: number;
  linesAdded?: number;
  linesRemoved?: number;
  credits?: {
    hasCredits?: boolean;
    balance?: string;
  };
  estimated?: boolean;
  source: "claude";
  updatedAt: string;
  permissionDenials?: number;
  permissionDenialDetails?: Array<{
    toolName: string;
    toolUseId?: string;
    reason?: string;
  }>;
  turns?: Array<{
    turnId: string;
    /** When this turn was finalized, ISO-8601; what dates recorded usage. */
    at?: string;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    durationMs?: number;
    apiDurationMs?: number;
    ttftMs?: number;
    numTurns?: number;
    modelId?: string;
  }>;
  contextCategories?: NativeAgentContextCategory[];
  rateLimits?: SessionRateLimitWindow[];
}

export interface BackgroundTaskSnapshot {
  id: string;
  /** Originating Task/Agent tool call, when supplied by the Agent SDK. */
  toolUseId?: string;
  description?: string;
  status: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
  isBackgrounded?: boolean;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  /** The one-line report the SDK's terminal `task_notification` carried. */
  summary?: string;
  /** Where the CLI wrote the task's full output, from `task_notification`. */
  outputFile?: string;
  /** Latest usage the SDK reported for the task (progress or terminal edge). */
  usage?: BackgroundTaskUsage;
  /**
   * Agent type of a subagent task (`general-purpose`, a custom agent's name),
   * or `main-session` for a backgrounded main session. From the
   * `background_tasks_changed` level (Agent SDK 0.3.296+) or a `SubagentStart`
   * hook; absent for shell and other non-agent tasks.
   */
  subagentType?: string;
  /**
   * The CLI's task kind: `local_bash`, `local_agent`, `local_workflow`,
   * `remote_agent`, `mcp_task`, … From `task_started` or the level.
   */
  taskType?: string;
  /**
   * The subagent task whose agent launched this one. Absent when the main
   * thread launched it, or the launcher is not itself a tracked task.
   */
  parentTaskId?: string;
  /** The prompt an agent or workflow task was started with. */
  prompt?: string;
  /**
   * The command a shell task runs. The CLI does not put it on any task
   * message, so it is captured by the Bash `PreToolUse` hook; this is the
   * only record of it for a command a background subagent ran.
   */
  command?: string;
  /** Tail of a shell task's output, from its `PostToolUse` hook. */
  outputTail?: string;
  /** The workflow script's `meta.name`, for a `local_workflow` task. */
  workflowName?: string;
  /** Housekeeping the CLI asks hosts to keep out of the transcript. */
  ambient?: boolean;
  /** The tool the task's agent most recently ran, from `task_progress`. */
  lastToolName?: string;
  /** The live one-line status `task_progress` reports for the task. */
  progressSummary?: string;
  /** Total time the task spent paused, from `task_updated`. */
  pausedMs?: number;
  /**
   * Why the task ended other than by completing, failing or being stopped.
   * `resume_cleanup` is the CLI's resume scan settling a task from an earlier
   * process that this session has no record of; see `resumeOrphanScanOutcome`.
   */
  endReason?: "worker_restart" | "resume_cleanup";
}

export interface BackgroundTaskUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/** Effort level for controlling how much thinking/reasoning Claude applies */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Model info */
export interface ModelInfo {
  id: string;
  resolvedModel?: string;
  name: string;
  description?: string;
  supportsFastMode?: boolean;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
  supportsAdaptiveThinking?: boolean;
  supportsAutoMode?: boolean;
}

/** Question option for AskUserQuestion tool */
export interface QuestionOption {
  label: string;
  description?: string;
  /** Markdown/ASCII preview (`toolConfig.askUserQuestion.previewFormat`). */
  preview?: string;
}

/** Question info structure */
export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** Question request from Claude */
export interface QuestionRequest {
  id: string;
  sessionId: string;
  questions: QuestionInfo[];
  toolUseId?: string;
  /** When the bridge parked it; the backend's `createdAt`. */
  requestedAt: number;
  /**
   * Absolute time when the bridge will deny the unanswered request; the
   * pause ceiling while the user has paused it.
   */
  expiresAt: number;
  hold?: AgentInteractionHold;
}

/** Plan approval request from Claude (when ExitPlanMode is called) */
export interface PlanApprovalRequest {
  id: string;
  sessionId: string;
  toolUseId?: string;
  /** Markdown plan Claude is asking the user to approve. */
  plan?: string;
  /** The plan exceeded the interaction transport limit and cannot be approved safely. */
  planTruncated?: boolean;
  /** When the bridge parked it; the backend's `createdAt`. */
  requestedAt: number;
  /**
   * Absolute time when the bridge will deny the unanswered request; the
   * pause ceiling while the user has paused it.
   */
  expiresAt: number;
  hold?: AgentInteractionHold;
}

/**
 * Everything else the bridge holds for the user: an MCP server's elicitation,
 * or a tool call waiting for approval under the `ask` execution policy.
 * Served by `GET /session/:id/interactions`, answered through
 * `POST /session/:id/interactions/:interactionId`.
 */
export type ClaudeInteractionRequest = ClaudeElicitationRequest | ClaudeToolApprovalRequest;

interface ClaudeInteractionRequestBase {
  id: string;
  sessionId: string;
  toolUseId?: string;
  requestedAt: number;
  /**
   * Absolute time when the bridge settles the unanswered request: an
   * elicitation is cancelled, a tool call denied. The pause ceiling while the
   * user has paused it.
   */
  expiresAt: number;
  hold?: AgentInteractionHold;
}

export interface ClaudeElicitationRequest extends ClaudeInteractionRequestBase {
  kind: "mcp-form" | "mcp-url";
  /** The MCP server's name as configured: untrusted display text. */
  serverName: string;
  message: string;
  /** The server's permission-display header, when it sent one. */
  title?: string;
  /** `mcp-form` only: the JSON Schema the answer must satisfy. */
  schema?: Record<string, unknown>;
  /** `mcp-url` only. */
  url?: string;
  elicitationId?: string;
}

export interface ClaudeToolApprovalRequest extends ClaudeInteractionRequestBase {
  kind: "command-approval" | "file-approval" | "permission";
  toolName: string;
  /** The prompt sentence the CLI composed, e.g. "Claude wants to read foo.txt". */
  title?: string;
  description?: string;
  /** Why the CLI asked. */
  reason?: string;
  blockedPath?: string;
  /** For an `mcp__*` tool, the server that serves it. */
  mcpServer?: string;
  /** `command-approval` only. */
  command?: string;
  /** `file-approval` only. */
  paths?: string[];
  /** `permission` only: the tool input as bounded JSON. */
  input?: string;
}

/** The values an MCP form answer may carry, as MCP defines them. */
export type ClaudeElicitationContent = Record<string, string | number | boolean | string[]>;

/** The user's answer to a {@link ClaudeInteractionRequest}. */
export type ClaudeInteractionResponse =
  | { action: "accept"; content?: ClaudeElicitationContent }
  | { action: "decline" }
  | { action: "cancel" };

/**
 * How a parked request ended: the user's answer, its deadline, or the turn or
 * session that raised it going away.
 */
export type ClaudeInteractionOutcome =
  | ClaudeInteractionResponse
  | { action: "timeout"; message: string }
  | { action: "withdrawn" };

/** SSE event types */
export type SSEEventType =
  | "replay.required"
  | "session.updated"
  | "session.idle"
  | "session.error"
  | "session.init"
  | "session.title-updated"
  | "session.structured-output"
  | "message.updated"
  | "message.patched"
  | "question.asked"
  | "question.answered"
  | "plan.enter-requested"
  | "plan.exit-requested"
  | "plan.approval-requested"
  | "plan.approval-responded"
  | "interaction.requested"
  | "interaction.resolved"
  | "system.compact";

/** MCP server status from SDK init message */
export interface McpServerRuntimeStatus {
  name: string;
  status: "connected" | "connecting" | "failed" | "needs-auth" | "disabled" | "unknown";
  scope?: NativeAgentMcpServer["scope"];
  transport?: "stdio" | "sse" | "http";
  error?: string;
  tools?: string[];
}

/** Plugin status from SDK init message */
export interface PluginRuntimeStatus {
  name: string;
  path?: string;
  status: "loaded" | "failed";
  error?: string;
}

/** Session initialization data (from SDK init message) */
export interface SessionInitData {
  mcpServers: McpServerRuntimeStatus[];
  plugins: PluginRuntimeStatus[];
  slashCommands?: string[];
  /**
   * Subset of `slashCommands` the SDK tags as bound to the local terminal
   * (`SDKSystemMessage.terminal_slash_commands`). Absent on older CLIs.
   */
  terminalSlashCommands?: string[];
  skills?: string[];
  apiKeySource?: string;
  agents?: Array<{
    name: string;
    description?: string;
    model?: string;
    color?: string;
  }>;
}

/**
 * Payload of a `message.patched` event: the parts of an assistant message that
 * changed since the last frame, addressed by their index.
 *
 * A streaming turn publishes a snapshot roughly ten times a second. Sending the
 * whole message each time is O(turn size) per frame — every tool's full output
 * and every written file, re-serialized for the rest of the turn — so once a
 * subscriber has seen the message in full, later frames carry only the deltas.
 *
 * `partCount` is authoritative for the array length so that a shrink (a
 * finalized message replacing what streamed) is representable. Recipients that
 * hold no message with `messageId`, or whose copy is not at `revision - 1`,
 * must refetch rather than guess: the REST transcript stays the source of
 * truth.
 */
export interface MessagePatchEventData {
  messageId: string;
  /** Final length of the parts array after applying this patch. */
  partCount: number;
  changedParts: { index: number; part: NormalizedPart }[];
  createdAt: string;
  /**
   * Revision this patch produces. Applying it is only valid against a copy at
   * `revision - 1`; anything else means frames were missed (a reconnect, or a
   * refetch that landed out of order) and the recipient must refetch. Without
   * this, a patch addressed by index would be applied to a stale base and the
   * missed parts would never be re-sent.
   */
  revision: number;
}

/** SSE event */
export interface SSEEvent {
  type: SSEEventType;
  sessionId?: string;
  data?: unknown;
}

/** Permission mode for Claude Agent SDK */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

/** Prompt options */
export interface PromptOptions {
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  /**
   * The session's chosen approval mode. Differs from `permissionMode` on a
   * plan or read-only turn, and decides who approves tools once a plan is
   * accepted.
   */
  approvalMode?: PermissionMode;
  /** Restrict this turn to inspection without enabling Claude's plan workflow. */
  readOnly?: boolean;
  /** When true, enables Claude Code fast mode (Opus 4.6 priority service tier). */
  fastMode?: boolean;
  /** Named top-level agent/profile discovered from the SDK. */
  agent?: string;
  /** Include `.claude/settings.local.json` for native-settings fidelity. */
  includeLocalSettings?: boolean;
  /** Opt into provider-generated follow-up prompt suggestions. */
  promptSuggestions?: boolean;
  /** JSON Schema passed to the Agent SDK's structured-output option. */
  outputSchema?: JsonSchema;
  /** Stable caller id used to reconcile an async structured turn. */
  requestId?: string;
  agentMcp?: { url: string; token: string; design?: boolean; artifacts?: { token: string } };
  parameterValues?: Record<string, string | boolean>;
  attachments?: Array<{
    type: "file" | "image";
    path: string;
    dataUrl?: string;
    filename?: string;
  }>;
  /**
   * Text sent to the SDK in place of the display prompt. Set only for a
   * selected command, whose canonical spelling may differ from what was typed
   * (an alias, a different case); the transcript keeps the typed text.
   */
  providerPrompt?: string;
  /** Internal flag: set when sendPrompt is called as an automatic re-prompt
   *  (e.g. after plan rejection). Prevents infinite recursion and marks the
   *  message as system-generated so it doesn't appear as user-typed. */
  _isReprompt?: boolean;
}

/** API responses */
export interface CreateSessionResponse {
  sessionId: string;
  title?: string;
}

export interface SessionListResponse {
  sessions: Array<{
    id: string;
    title?: string;
    status: "idle" | "running" | "error";
    createdAt: string;
    lastActivity: string;
    /** Transcript size, for the resume picker's trailing detail. */
    messageCount?: number;
  }>;
}

export interface MessagesResponse {
  messages: NormalizedMessage[];
  /** Absent on responses from a bridge predating the byte-aware ceiling. */
  messageWindow?: TranscriptWindowMetadata;
}

export interface ModelsResponse {
  models: ModelInfo[];
  source: "sdk" | "fallback";
  fetchedAt: string;
  sdkVersion?: string;
  cliVersion?: string;
}

export interface HealthResponse {
  status: "ok";
  version: string;
}

/**
 * This session's drift and notice recorder, created on first use.
 *
 * A session that never sees an unrecognised message never allocates one, which
 * is the common case: this is called from the SDK message loop.
 */
export function sessionHealth(session: SessionState): RuntimeHealthRecorder {
  session.health ??= new RuntimeHealthRecorder();
  return session.health;
}
