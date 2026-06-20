/**
 * Shared message model used by native-mode chat UIs.
 *
 * Agent clients should normalize their provider-specific events/messages into
 * this shape before rendering. Renderer components should depend on this file,
 * not on Claude/OpenCode/Codex SDK payloads.
 */

export interface NativeToolDiffMetadata {
  filePath?: string;
  additions?: number;
  deletions?: number;
  before?: string;
  after?: string;
  diff?: string;
}

export type NativeToolState = "success" | "failure" | "pending";

export interface NativeBasePart {
  content: string;
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
  toolUseId?: string;
  parentTaskUseId?: string;
  isMcpTool?: boolean;
  mcpServerName?: string;
  subagentId?: string;
  subagentName?: string;
  subagentRole?: string;
  subagentDescription?: string;
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

export type NativeMessagePart =
  | NativeTextPart
  | NativeThinkingPart
  | NativeFilePart
  | NativeToolInvocationPart
  | NativeToolResultPart
  | NativeSubagentPart
  | NativeToolGroupPart
  | NativeTaskGroupPart;

export interface NativeMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: NativeMessagePart[];
  createdAt: string;
}
