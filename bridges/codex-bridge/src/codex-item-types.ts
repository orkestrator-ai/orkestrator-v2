/**
 * The thread-item vocabulary the bridge renders.
 *
 * These were previously imported as types from `@openai/codex-sdk`. That package
 * is gone — the bridge talks to `codex app-server` over JSON-RPC and never
 * spawns `codex exec` for a turn — but the *shapes* are still the right internal
 * model, so they are declared here instead.
 *
 * Keeping snake_case discriminants is deliberate. `app-server/item-adapter.ts`
 * converts app-server's camelCase protocol into these, which is what keeps the
 * renderer, the sub-agent reconciler and their tests independent of protocol
 * churn — app-server is still marked experimental.
 */

/** Reasoning effort accepted by the CLI. Open-ended: the CLI adds tiers. */
export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type CommandExecutionStatus = "in_progress" | "completed" | "failed";

export interface CommandExecutionItem {
  id: string;
  type: "command_execution";
  /** The command line executed by the agent. */
  command: string;
  /** Aggregated stdout and stderr captured while the command was running. */
  aggregated_output: string;
  /** Set when the command exits; omitted while still running. */
  exit_code?: number;
  status: CommandExecutionStatus;
}

export type PatchChangeKind = "add" | "delete" | "update";

export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
}

export type PatchApplyStatus = "completed" | "failed";

export interface FileChangeItem {
  id: string;
  type: "file_change";
  changes: FileUpdateChange[];
  status: PatchApplyStatus;
}

export type McpToolCallStatus = "in_progress" | "completed" | "failed";

export interface McpToolCallItem {
  id: string;
  type: "mcp_tool_call";
  /** Name of the MCP server handling the request. */
  server: string;
  tool: string;
  arguments: unknown;
  result?: {
    content: unknown[];
    structured_content?: unknown;
    _meta?: unknown;
  };
  error?: { message: string };
  status: McpToolCallStatus;
}

export interface DynamicToolCallItem {
  id: string;
  type: "dynamic_tool_call";
  namespace?: string;
  tool: string;
  arguments: unknown;
  content_items: unknown[];
  status: McpToolCallStatus;
}

export interface AgentMessageItem {
  id: string;
  type: "agent_message";
  /** Either natural-language text or JSON when structured output is requested. */
  text: string;
}

export interface ReasoningItem {
  id: string;
  type: "reasoning";
  text: string;
}

export interface WebSearchItem {
  id: string;
  type: "web_search";
  query: string;
}

export interface ErrorItem {
  id: string;
  type: "error";
  message: string;
}

export interface TodoItem {
  text: string;
  completed: boolean;
}

export interface TodoListItem {
  id: string;
  type: "todo_list";
  items: TodoItem[];
}

/** Canonical union of rendered thread items. */
export type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | DynamicToolCallItem
  | WebSearchItem
  | TodoListItem
  | ErrorItem;

/** One element of a user turn's input. */
export type UserInput =
  | { type: "text"; text: string }
  | { type: "local_image"; path: string };

/** A whole user turn: bare text, or a list of inputs when there are attachments. */
export type Input = string | UserInput[];
