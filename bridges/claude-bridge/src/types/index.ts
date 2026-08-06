// Type definitions for Claude Bridge Server
import type {
  JsonSchema,
  StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";

import type { TaskListSnapshot, TaskRegistry } from "@orkestrator/protocol/task-list";

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
  subtype?: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | "error_max_structured_output_retries" | string;
  result?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  errors?: string[];
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
    contextWindow?: number;
  }>;
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
}

/** Type guard for compact boundary message */
export function isSdkCompactBoundaryMessage(
  message: SdkMessageBase
): message is SdkCompactBoundaryMessage {
  return message.type === "system" && message.subtype === "compact_boundary";
}

/** Type guard for result message */
export function isSdkResultMessage(
  message: SdkMessageBase
): message is SdkResultMessage {
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
  type: "text" | "thinking" | "tool-invocation" | "tool-result" | "file";
  content?: string;
  /** When this content block first arrived from the SDK. */
  timestamp?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: ToolDiffMetadata;
  /** Tool use ID for tracking tool invocations across messages */
  toolUseId?: string;
  /** Parent Task tool use ID - used to group child tools under their parent Task */
  parentTaskUseId?: string;
  /** Internal: Message UUID for tracking thinking parts across streaming updates */
  _messageUuid?: string;
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
}

/** Normalized message format */
export interface NormalizedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: NormalizedPart[];
  timestamp: string;
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
  stopTask?: (taskId: string) => Promise<void>;
  backgroundTasks?: (toolUseId?: string) => Promise<boolean>;
  getContextUsage?: () => Promise<unknown>;
  /**
   * Structured data behind Claude Code's `/usage` screen.
   *
   * The Agent SDK deliberately marks this control request experimental, so the
   * bridge feature-detects it and validates the unknown response at runtime.
   */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
  rewindFiles?: (
    userMessageId: string,
    options?: { dryRun?: boolean },
  ) => Promise<unknown>;
  close?: () => void | Promise<void>;
}

/** Session state */
export interface SessionState {
  id: string;
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
  /** SDK session ID returned from Claude Agent SDK - used for resume */
  sdkSessionId?: string;
  /** Session initialization data (MCP servers, plugins, etc.) */
  initData?: SessionInitData;
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
   * Epoch millis of the last read or hydration of this session's state.
   *
   * Drives idle transcript eviction. Deliberately separate from
   * `lastActivity`: that field is user-facing and rewritten from on-disk
   * metadata by every reconcile, so it says when the *session* last changed,
   * not when anyone in this process last looked at it.
   */
  lastAccessedAt?: number;
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
  /** Predicted next prompt emitted by the SDK after a completed turn. */
  promptSuggestion?: string;
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
  /** Single in-flight persisted transcript read shared by mounts and prompts. */
  persistedHydration?: Promise<{
    messages: NormalizedMessage[];
    taskRegistry: TaskRegistry;
  } | undefined>;
  /** Control for the currently executing (or most recently completed) turn. */
  queryControl?: ClaudeQueryControl;
  /**
   * Re-evaluate whether the current streaming prompt may close its input.
   *
   * A Claude result is not terminal while background agents are live. The
   * callback is installed only for the active turn and closes stdin once that
   * turn has a result and no live background task remains.
   */
  finishTurnInputIfSettled?: () => void;
  /**
   * Control that owns each live background task.
   *
   * A follow-up turn installs a new `queryControl`; these per-task handles keep
   * older provider processes addressable until their tasks settle.
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

export interface SessionUsageSnapshot {
  usedTokens: number;
  totalTokens: number;
  percentUsed: number;
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
  estimated?: boolean;
  source: "claude";
  updatedAt: string;
  permissionDenials?: number;
  contextCategories?: Array<{ name: string; tokens: number; color?: string }>;
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
  /** Absolute time when the bridge will deny the unanswered request. */
  expiresAt: number;
}

/** Plan approval request from Claude (when ExitPlanMode is called) */
export interface PlanApprovalRequest {
  id: string;
  sessionId: string;
  toolUseId?: string;
  /** Absolute time when the bridge will deny the unanswered request. */
  expiresAt: number;
}

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
  | "system.compact"
  | "system.message";

/** MCP server status from SDK init message */
export interface McpServerRuntimeStatus {
  name: string;
  status: "connected" | "failed";
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
  timestamp: string;
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
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

/** Prompt options */
export interface PromptOptions {
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
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
  attachments?: Array<{
    type: "file" | "image";
    path: string;
    dataUrl?: string;
    filename?: string;
  }>;
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
  }>;
}

export interface MessagesResponse {
  messages: NormalizedMessage[];
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
