/**
 * Orkestrator's normalized message model — the stable contract the browser sees.
 *
 * Deliberately *not* the app-server protocol shape. Keeping this layer means:
 *   - the UI is insulated from app-server protocol churn (it is experimental),
 *   - both engines can produce identical messages,
 *   - subagent activity from two different sources can be merged in one place,
 *   - recovery and deduplication have somewhere to live.
 */
export type ToolState = "success" | "failure" | "pending";
export type MessageRole = "user" | "assistant" | "system";

export interface ToolDiffMetadata {
  filePath?: string;
  additions?: number;
  deletions?: number;
  before?: string;
  after?: string;
  diff?: string;
}

export interface NormalizedPart {
  type: "text" | "thinking" | "tool-invocation" | "tool-result" | "file" | "subagent";
  content: string;
  fileUrl?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: ToolState;
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: ToolDiffMetadata;
  subagentId?: string;
  subagentName?: string;
  subagentRole?: string;
  subagentPrompt?: string;
  subagentActions?: NormalizedPart[];
  subagentActionCount?: number;
}

export interface NormalizedMessage {
  id: string;
  role: MessageRole;
  content: string;
  parts: NormalizedPart[];
  createdAt: string;
  planReview?: boolean;
}

export interface FileChangeDiffContext {
  baselines: Map<string, string | undefined>;
  cache: Map<string, ToolDiffMetadata>;
}

export function createMessageId(): string {
  return `msg-${crypto.randomUUID()}`;
}

export function createSessionId(): string {
  return `session-${crypto.randomUUID()}`;
}
