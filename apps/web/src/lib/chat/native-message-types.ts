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
export type NativeAgentState = "active" | "finished" | "failed";
export type NativeBackgroundTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "paused";

export interface NativeBackgroundTask {
  id: string;
  description?: string;
  /** Absent when recovered from transcript tool results rather than a snapshot. */
  status?: NativeBackgroundTaskStatus;
}

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
  /** Opaque backend-owned reference for heavy output/diff fields. */
  detailRef?: string;
  /** Original attachment name when the readable path uses a staged/generated name. */
  filename?: string;
  /** Provider timestamp for when this individual message part first arrived. */
  createdAt?: string;
  sourcePartId?: string;
  sourceMessageId?: string;
  fileUrl?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: NativeToolState;
  /**
   * Lifecycle of an agent spawned by this tool.
   *
   * This is deliberately separate from `toolState`: background-agent tools
   * can return successfully as soon as the child launches, while the child is
   * still active.
   */
  agentState?: NativeAgentState;
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
  /** Background task represented or acted on by this tool row. */
  backgroundTask?: NativeBackgroundTask;
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
  /** All activity emitted by this agent, including reasoning and final text. */
  childTools: NativeMessagePart[];
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
  /** Provider/backend-observed model that produced this assistant message. */
  modelId?: string;
  turnId?: string;
  /** Typed Codex plan-review marker used by the shared presentation slot. */
  planReview?: boolean;
}
