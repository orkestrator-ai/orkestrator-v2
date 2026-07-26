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
  /** Present on successful turns requested with Agent SDK `outputFormat`. */
  structured_output?: unknown;
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
}

/** Session state */
export interface SessionState {
  id: string;
  title?: string;
  /** Whether a title generation request is already in flight */
  titleGenerationPending?: boolean;
  messages: NormalizedMessage[];
  status: "idle" | "running" | "error";
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
}

/** Plan approval request from Claude (when ExitPlanMode is called) */
export interface PlanApprovalRequest {
  id: string;
  sessionId: string;
  toolUseId?: string;
}

/** SSE event types */
export type SSEEventType =
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
 * hold no message with `messageId` must refetch rather than guess: the REST
 * transcript stays the source of truth.
 */
export interface MessagePatchEventData {
  messageId: string;
  /** Final length of the parts array after applying this patch. */
  partCount: number;
  changedParts: { index: number; part: NormalizedPart }[];
  timestamp: string;
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
