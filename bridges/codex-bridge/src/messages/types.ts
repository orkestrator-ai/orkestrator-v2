/**
 * Orkestrator's normalized message model — the stable contract the browser sees.
 *
 * Deliberately *not* the app-server protocol shape. Keeping this layer means:
 *   - the UI is insulated from app-server protocol churn (it is experimental),
 *   - both engines can produce identical messages,
 *   - subagent activity from two different sources can be merged in one place,
 *   - recovery and deduplication have somewhere to live.
 */
import type { BaselineMap } from "./diff-budget.js";

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
  /**
   * Original attachment name, when `content` holds a staged path whose basename
   * is not what the user picked. The renderer titles the row with this.
   */
  filename?: string;
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
  /** Model confirmed by app-server or the persisted turn context. */
  modelId?: string;
  planReview?: boolean;
  /** Native turn boundary used for lossless "fork from here". */
  turnId?: string;
  /** Monotonic per-message publication revision used by sparse SSE patches. */
  revision?: number;
}

export interface MessagePatchEventData {
  messageId: string;
  partCount: number;
  changedParts: { index: number; part: NormalizedPart }[];
  /** Authoritative flat message body after applying the patch. */
  content: string;
  createdAt: string;
  turnId?: string;
  /** Valid only when the local message is at `revision - 1`. */
  revision: number;
}

export interface FileChangeDiffContext {
  /** Byte-counting map so budget checks stay O(1); see `diff-budget.ts`. */
  baselines: BaselineMap;
  cache: Map<string, ToolDiffMetadata>;
}

export function createMessageId(): string {
  return `msg-${crypto.randomUUID()}`;
}

export function createSessionId(): string {
  return `session-${crypto.randomUUID()}`;
}
