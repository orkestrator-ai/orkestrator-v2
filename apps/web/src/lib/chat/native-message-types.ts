/**
 * Shared message model used by native-mode chat UIs.
 *
 * Agent clients should normalize their provider-specific events/messages into
 * this shape before rendering. Renderer components should depend on this file,
 * not on Claude/OpenCode/Codex SDK payloads.
 */

import type { TaskListSnapshot } from "@orkestrator/protocol/task-list";

export interface NativeToolDiffMetadata {
  filePath?: string;
  additions?: number;
  deletions?: number;
  before?: string;
  after?: string;
  diff?: string;
}

export type NativeToolState = "success" | "failure" | "pending";

/**
 * A point-in-time view of the agent's task list.
 *
 * Providers whose task tools mutate a single task per call (Claude's
 * TaskCreate/TaskUpdate) have their backend replay those calls and supply the
 * resulting list here, so the renderer never reconstructs it — see
 * `@orkestrator/protocol/task-list`, the one implementation.
 */
export type { TaskListSnapshot, TaskSnapshotItem } from "@orkestrator/protocol/task-list";

export interface NativeBasePart {
  content: string;
  /** Provider timestamp for when this individual message part first arrived. */
  createdAt?: string;
  sourcePartId?: string;
  sourceMessageId?: string;
  fileUrl?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: NativeToolState;
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: NativeToolDiffMetadata;
  toolUseCount?: number;
  tokenCount?: number;
  tokenCountText?: string;
  /** Hint for agent rows when a provider can report tokens but not child activity. */
  agentUsageDisplay?: "token-only";
  toolUseId?: string;
  parentTaskUseId?: string;
  isMcpTool?: boolean;
  mcpServerName?: string;
  /** Task list state immediately after this tool call, for task tools. */
  taskSnapshot?: TaskListSnapshot;
  subagentId?: string;
  subagentName?: string;
  subagentRole?: string;
  subagentPrompt?: string;
  subagentActions?: NativeMessagePart[];
  subagentActionCount?: number;
}

export interface NativeTextPart extends NativeBasePart {
  type: "text";
}

export interface NativeThinkingPart extends NativeBasePart {
  type: "thinking";
}

export interface NativeFilePart extends NativeBasePart {
  type: "file";
}

export interface NativeToolInvocationPart extends NativeBasePart {
  type: "tool-invocation";
}

export interface NativeToolResultPart extends NativeBasePart {
  type: "tool-result";
}

export interface NativeSubagentPart extends NativeBasePart {
  type: "subagent";
}

export interface NativeToolGroupPart extends NativeBasePart {
  type: "tool-group";
  parts: NativeMessagePart[];
}

export interface NativeTaskGroupPart extends NativeBasePart {
  type: "task-group";
  task: NativeToolInvocationPart;
  childTools: NativeToolInvocationPart[];
}

export type NativeAgentActivityPart = NativeSubagentPart | NativeTaskGroupPart;

export interface NativeAgentGroupPart extends NativeBasePart {
  type: "agent-group";
  parts: NativeAgentActivityPart[];
}

export type NativeMessagePart =
  | NativeTextPart
  | NativeThinkingPart
  | NativeFilePart
  | NativeToolInvocationPart
  | NativeToolResultPart
  | NativeSubagentPart
  | NativeAgentGroupPart
  | NativeToolGroupPart
  | NativeTaskGroupPart;

export interface NativeMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: NativeMessagePart[];
  createdAt: string;
}
