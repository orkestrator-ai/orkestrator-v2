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

export interface OpenCode2Session {
  id: string;
  projectID?: string;
  parentID?: string;
  agent?: string;
  model?: OpenCode2ModelRef;
  cost?: number;
  metadata?: Record<string, unknown>;
  time?: { created?: number; updated?: number };
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

export interface OpenCode2ToolContent {
  type: "tool";
  id: string;
  name: string;
  state?: { status: "streaming" | "running" | "completed" | "error"; input?: unknown };
}

export interface OpenCode2AssistantMessage extends MessageBase {
  type: "assistant";
  agent?: string;
  model?: OpenCode2ModelRef;
  content: Array<OpenCode2TextContent | OpenCode2ReasoningContent | OpenCode2ToolContent>;
  finish?: string;
}

/** Appended when a run settles: the snapshot's run boundary. */
export interface OpenCode2IdleMessage extends MessageBase {
  type: "idle";
  outcome: OpenCode2RunOutcome;
}

/** Any other row kind (synthetic, system, shell, compaction, switches, …). */
export interface OpenCode2OtherMessage extends MessageBase {
  type: string;
}

export type OpenCode2Message =
  OpenCode2UserMessage | OpenCode2AssistantMessage | OpenCode2IdleMessage | OpenCode2OtherMessage;

export interface OpenCode2PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  message?: string;
}

export interface OpenCode2Form {
  id: string;
  sessionID: string;
  title: string;
  fields: unknown;
}

export function isOpenCode2UserMessage(message: OpenCode2Message): message is OpenCode2UserMessage {
  return message.type === "user" && typeof (message as { text?: unknown }).text === "string";
}

export function isOpenCode2IdleMessage(message: OpenCode2Message): message is OpenCode2IdleMessage {
  return message.type === "idle";
}
