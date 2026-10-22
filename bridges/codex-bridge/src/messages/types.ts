/**
 * Orkestrator's normalized message model — the stable contract the browser sees.
 *
 * Deliberately *not* the app-server protocol shape. Keeping this layer means:
 *   - the UI is insulated from app-server protocol churn (it is experimental),
 *   - both engines can produce identical messages,
 *   - subagent activity from two different sources can be merged in one place,
 *   - recovery and deduplication have somewhere to live.
 */
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";

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
  type:
    | "text"
    | "thinking"
    | "tool-invocation"
    | "tool-result"
    | "file"
    | "subagent"
    | "compaction"
    | "image"
    | "status"
    | "progress"
    | "async-question";
  content: string;
  asyncQuestion?: {
    itemId: string;
    questions: Array<{ id: string; title: string; options: string[] }>;
  };
  /**
   * Original attachment name, when `content` holds a staged path whose basename
   * is not what the user picked. The renderer titles the row with this.
   */
  filename?: string;
  /**
   * When this item first appeared in the turn. Used by the renderer to timestamp
   * transcript sections independently of the prompt that started the turn.
   */
  createdAt?: string;
  fileUrl?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: ToolState;
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: ToolDiffMetadata;
  /**
   * How long a finished tool call ran: app-server's own measurement when it
   * reports one, otherwise the gap between its start and completion events.
   * Absent while the call runs and whenever neither is known.
   */
  toolDurationMs?: number;
  /**
   * What a shell command changed in its worktree, measured around it (see
   * `sessions/command-changes.ts`). Set only on `bash` rows that changed
   * something; the renderer shows it as the row's +N −M badge.
   */
  commandChanges?: MeasuredWorkspaceChange;
  subagentId?: string;
  subagentName?: string;
  subagentRole?: string;
  subagentPrompt?: string;
  subagentActions?: NormalizedPart[];
  subagentActionCount?: number;
  /** The model the child ran on, when the provider names one. */
  subagentModelId?: string;
  /** The reasoning effort the child ran with, when the provider names one. */
  subagentReasoningEffort?: string;
  /** Context occupancy before a compaction boundary. */
  compactedTokensBefore?: number;
  /** Where an `image` part came from. */
  imageSource?: "attachment" | "generated" | "viewed";
  /** Severity of a `status` row. */
  severity?: "info" | "warning" | "error";
  /** The call a `progress` sub-line describes. */
  toolUseId?: string;
  /** How long that call has been running. */
  elapsedMs?: number;
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
  /** Rendered diff per completed `fileChange` item, turn-scoped; see `diff-budget.ts`. */
  cache: Map<string, ToolDiffMetadata>;
}

export function createMessageId(): string {
  return `msg-${crypto.randomUUID()}`;
}

export function createSessionId(): string {
  return `session-${crypto.randomUUID()}`;
}
