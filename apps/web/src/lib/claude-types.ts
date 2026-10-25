// Claude transcript, model and question shapes shared by the renderer.
//
// Claude Native is driven by the backend and rendered through the shared
// native-agent projection; these types remain for the surfaces that still
// speak Claude's wire shape directly: Claude Tmux, the build-pipeline
// transcript normalizer and the Claude model catalogue.

import type { ClaudeModelCatalogEntry } from "@/types";
import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";
import type { TmuxHookHold } from "@/lib/claude-tmux-client";

/** Diff metadata for edit tool operations */
export interface ToolDiffMetadata {
  filePath?: string;
  additions?: number;
  deletions?: number;
  before?: string;
  after?: string;
  diff?: string;
}

/** Claude bridge parts use the provider-neutral renderer wire shape. */
export type ClaudeMessagePart = NativeMessagePart;

export interface ClaudeBackgroundTask {
  id: string;
  /** Originating Task/Agent tool call, when supplied by the Agent SDK. */
  toolUseId?: string;
  description?: string;
  status: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
  isBackgrounded?: boolean;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  summary?: string;
  outputFile?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
}

export type ClaudeMessage = NativeMessage & {
  /**
   * Frames the bridge has published for this message, starting at 1. Present
   * only on assistant messages from a streaming turn.
   */
  revision?: number;
  /** Provider transcript identity used for fork and rewind operations. */
  sdkUuid?: string;
};

/** Effort level for controlling Claude's thinking depth */
export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeModel extends ClaudeModelCatalogEntry {
  supportedEffortLevels?: ClaudeEffortLevel[];
}

/** Question option for AskUserQuestion tool */
export interface QuestionOption {
  label: string;
  description?: string;
  value?: string;
}

/** Question info structure */
export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** Question request from Claude */
export interface ClaudeQuestionRequest {
  id: string;
  sessionId: string;
  questions: QuestionInfo[];
  toolUseId?: string;
  /** Absolute time when the unanswered request expires. */
  expiresAt?: number;
  /** Pause state of the countdown, for a tmux hook that publishes one. */
  hold?: TmuxHookHold;
}
