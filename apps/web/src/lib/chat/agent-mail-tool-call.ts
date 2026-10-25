import {
  AGENT_MAIL_PLACEMENTS,
  ORKESTRATOR_MCP_SERVER_NAME,
  agentMailTranscriptTool,
  AGENT_MAIL_TRUST_CLASSES,
  type AgentMailPlacement,
  type AgentMailTranscriptTool,
  type AgentMailTrust,
  type MailActor,
} from "@orkestrator/protocol/agent-mail";
import type { NativeMessagePart } from "./native-message-types";

/**
 * A mail tool call in a transcript, as the message it sent or read.
 *
 * `send_message` and `reply_message` carry the message in their arguments, so
 * they render before the result arrives. `read_message` (and a coordinator's
 * `get_message`) carry it in the result, which the backend defers behind a
 * detail reference; until it loads the call has no body.
 */
export interface AgentMailToolCall {
  tool: AgentMailTranscriptTool;
  direction: "out" | "in";
  messageId?: string;
  subject?: string;
  body?: string;
  /** The recipient: the address the tool resolved, or the one the agent wrote. */
  to?: { environmentId: string; tabId?: string };
  from?: MailActor;
  trust?: AgentMailTrust;
  placement?: AgentMailPlacement;
}

type ToolPart = Pick<
  Extract<NativeMessagePart, { type: "tool-invocation" }>,
  "toolName" | "toolTitle" | "toolArgs" | "toolOutput" | "toolError" | "toolState" | "mcpServerName"
>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Providers wrap an MCP result differently; find the tool's own JSON object. */
function unwrapResult(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 3) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (record(item) && item.type === "text" && typeof item.text === "string") {
        const parsed = parseJson(item.text);
        const unwrapped = parsed === undefined ? null : unwrapResult(parsed, depth + 1);
        if (unwrapped) return unwrapped;
      }
    }
    return null;
  }
  if (!record(value)) return null;
  if (record(value.structuredContent)) return value.structuredContent;
  if (Array.isArray(value.content)) return unwrapResult(value.content, depth + 1);
  return value;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function resultMessage(output: string | undefined): Record<string, unknown> | null {
  if (!output) return null;
  const parsed = parseJson(output);
  const result = parsed === undefined ? null : unwrapResult(parsed);
  if (!result) return null;
  if (record(result.message)) return result.message;
  return typeof result.id === "string" && record(result.from) ? result : null;
}

function mailActor(value: unknown): MailActor | undefined {
  if (!record(value)) return undefined;
  switch (value.kind) {
    case "user":
    case "external":
      return { kind: value.kind };
    case "tab":
    case "coordinator":
      return typeof value.environmentId === "string" && typeof value.tabId === "string"
        ? (value as MailActor)
        : undefined;
    case "system":
      return typeof value.projectId === "string" ? (value as MailActor) : undefined;
    case "node":
      return typeof value.nodeId === "string" &&
        typeof value.nodeName === "string" &&
        typeof value.environmentId === "string" &&
        typeof value.tabId === "string"
        ? (value as MailActor)
        : undefined;
    default:
      return undefined;
  }
}

function trust(value: unknown): AgentMailTrust | undefined {
  return AGENT_MAIL_TRUST_CLASSES.find((candidate) => candidate === value);
}

function placement(value: unknown): AgentMailPlacement | undefined {
  return AGENT_MAIL_PLACEMENTS.find((candidate) => candidate === value);
}

/** Whether a tool row is an Orkestrator mail call this transcript draws as a message. */
export function agentMailToolCall(part: ToolPart): AgentMailToolCall | null {
  if (part.toolState === "failure" || part.toolError) return null;
  if (part.mcpServerName && part.mcpServerName !== ORKESTRATOR_MCP_SERVER_NAME) return null;
  const tool = agentMailTranscriptTool(part.toolName, part.toolTitle);
  const args = part.toolArgs;
  if (!tool || !record(args)) return null;
  const message = resultMessage(part.toolOutput);
  const messageId = text(message?.id);
  const resolvedTo =
    message && typeof message.toEnvironmentId === "string" && typeof message.toTabId === "string"
      ? { environmentId: message.toEnvironmentId, tabId: message.toTabId }
      : undefined;
  if (tool === "send_message" || tool === "reply_message") {
    const body = text(args.body);
    if (!body) return null;
    const toEnvironmentId = text(args.toEnvironmentId);
    if (tool === "send_message" && !toEnvironmentId) return null;
    if (tool === "reply_message" && !text(args.messageId)) return null;
    const toTabId = text(args.toTabId);
    return {
      tool,
      direction: "out",
      body,
      ...(text(args.subject) ? { subject: text(args.subject) } : {}),
      ...(messageId ? { messageId } : {}),
      ...(resolvedTo
        ? { to: resolvedTo }
        : toEnvironmentId
          ? { to: { environmentId: toEnvironmentId, ...(toTabId ? { tabId: toTabId } : {}) } }
          : {}),
      ...(mailActor(message?.from) ? { from: mailActor(message?.from) } : {}),
      ...(placement(message?.placement) ? { placement: placement(message?.placement) } : {}),
    };
  }
  if (!text(args.messageId)) return null;
  return {
    tool,
    direction: "in",
    messageId: messageId ?? text(args.messageId),
    ...(typeof message?.body === "string" ? { body: message.body } : {}),
    ...(text(message?.subject) ? { subject: text(message?.subject) } : {}),
    ...(resolvedTo ? { to: resolvedTo } : {}),
    ...(mailActor(message?.from) ? { from: mailActor(message?.from) } : {}),
    ...(trust(message?.trust) ? { trust: trust(message?.trust) } : {}),
    ...(placement(message?.placement) ? { placement: placement(message?.placement) } : {}),
  };
}
