/**
 * The slice of OpenCode 2.x's wire shapes the 2.x provider reads, from the
 * pinned release's `packages/protocol/openapi.json` (2.2.6). Fields the
 * provider does not read are left out; unknown variants stay representable so
 * a newer server degrades instead of throwing (the server is a pinned
 * dependency, but a message row from a newer minor must not crash a read).
 */

export type OpenCode2InboxDelivery = "steer" | "queue";
export type OpenCode2PermissionDecision = "once" | "always" | "reject";
export type OpenCode2RunOutcome = "succeeded" | "failed" | "interrupted";

export interface OpenCode2Info {
  version: string;
  pid?: number;
  urls?: string[];
}

export interface OpenCode2ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** `TokenUsage.Info`: cumulative on a session, per response on an assistant row. */
export interface OpenCode2TokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/** `Session.StructuredError`. */
export interface OpenCode2StructuredError {
  type?: string;
  message?: string;
  status?: number;
}

export interface OpenCode2Session {
  id: string;
  projectID?: string;
  parentID?: string;
  agent?: string;
  model?: OpenCode2ModelRef;
  cost?: number;
  tokens?: OpenCode2TokenUsage;
  /** The latest settled run's outcome. */
  outcome?: OpenCode2RunOutcome;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { created?: number; updated?: number; busy?: number; idle?: number };
}

export interface OpenCode2FileInput {
  uri: string;
  name?: string;
  description?: string;
}

export interface OpenCode2UserInput {
  text: string;
  files?: OpenCode2FileInput[];
}

interface MessageBase {
  id: string;
  time: { created: number; streamed?: number; completed?: number };
  metadata?: Record<string, unknown>;
}

export interface OpenCode2UserMessage extends MessageBase {
  type: "user";
  text: string;
}

export interface OpenCode2TextContent {
  type: "text";
  text: string;
}

export interface OpenCode2ReasoningContent {
  type: "reasoning";
  text: string;
}

/** `Tool.Content`: what a settled tool call returned to the model. */
export type OpenCode2ToolResultContent =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name?: string | null };

export interface OpenCode2ToolState {
  status: "streaming" | "running" | "completed" | "error";
  /** A partial JSON string while `streaming`, the decoded input after. */
  input?: unknown;
  content?: OpenCode2ToolResultContent[];
  metadata?: Record<string, unknown>;
  error?: OpenCode2StructuredError;
}

export interface OpenCode2ToolContent {
  type: "tool";
  id: string;
  name: string;
  executed?: boolean;
  state?: OpenCode2ToolState;
  time?: { created?: number; ran?: number; completed?: number };
}

export interface OpenCode2AssistantMessage extends MessageBase {
  type: "assistant";
  agent?: string;
  model?: OpenCode2ModelRef;
  content: Array<OpenCode2TextContent | OpenCode2ReasoningContent | OpenCode2ToolContent>;
  finish?: string;
  cost?: number;
  tokens?: OpenCode2TokenUsage;
  error?: OpenCode2StructuredError;
  retry?: { attempt?: number; at?: number; error?: OpenCode2StructuredError };
}

/** Appended when a run settles: the snapshot's run boundary. */
export interface OpenCode2IdleMessage extends MessageBase {
  type: "idle";
  outcome: OpenCode2RunOutcome;
  error?: OpenCode2StructuredError;
}

/** Any other row kind (synthetic, system, shell, compaction, switches, …). */
export interface OpenCode2OtherMessage extends MessageBase {
  type: string;
}

export type OpenCode2Message =
  OpenCode2UserMessage | OpenCode2AssistantMessage | OpenCode2IdleMessage | OpenCode2OtherMessage;

/** A pending inbox entry (`GET /api/session/:id/inbox`). */
export interface OpenCode2InboxItem {
  id: string;
  type: string;
  delivery?: OpenCode2InboxDelivery;
  payload?: { text?: string; metadata?: Record<string, unknown> };
}

export interface OpenCode2PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  /** Patterns an `always` reply would save; never used (owner decision 1, 2026-11-09). */
  save?: string[];
  /** Tool-specific detail, e.g. `{ files: [FileDiff] }` for an edit. */
  metadata?: Record<string, unknown>;
  source?: { type: "tool"; messageID: string; id: string };
  message?: string;
}

export interface OpenCode2Form {
  id: string;
  sessionID: string;
  title: string;
  /** `{ kind: "question", tool }` for the question tool. */
  metadata?: Record<string, unknown>;
  /** `Form.Fields`, validated by `forms.ts` (a newer server's field kind degrades). */
  fields: unknown;
}

export function isOpenCode2UserMessage(message: OpenCode2Message): message is OpenCode2UserMessage {
  return message.type === "user" && typeof (message as { text?: unknown }).text === "string";
}

export function isOpenCode2IdleMessage(message: OpenCode2Message): message is OpenCode2IdleMessage {
  return message.type === "idle";
}
