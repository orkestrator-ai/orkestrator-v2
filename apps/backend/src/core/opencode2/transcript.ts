/**
 * OpenCode 2.x history rows as the shared normalized transcript rows
 * (docs/todo/agent-engines/0008-opencode-v2.md, build plan phase 4, preview).
 *
 * The preview needs a readable tab, not the full projection: one row per
 * user input and one per assistant message (a 2.x assistant message is one
 * model response, AGENTS.md invariant 14), with text, reasoning and tool
 * calls. Idle rows are run boundaries and are dropped. Every other row kind
 * (synthetic, shell, compaction, switches) and every content kind this does
 * not name is dropped too rather than guessed at: a newer server must degrade,
 * never throw.
 *
 * Not covered yet (phase 4 proper): tool output bodies, diffs, sub-agents,
 * history paging, usage and the terminal error of a failed run.
 */
import type { OpenCode2AssistantMessage, OpenCode2Message } from "./types.js";
import { isOpenCode2UserMessage } from "./types.js";

/** Longest tool input kept inline on a card. */
const MAX_TOOL_ARGS_BYTES = 16 * 1024;
const UNKNOWN_CREATED_AT = "1970-01-01T00:00:00.000Z";

function isoTime(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : UNKNOWN_CREATED_AT;
}

function isAssistant(message: OpenCode2Message): message is OpenCode2AssistantMessage {
  return message.type === "assistant" && Array.isArray((message as { content?: unknown }).content);
}

function boundedToolArgs(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  try {
    return JSON.stringify(input).length <= MAX_TOOL_ARGS_BYTES
      ? (input as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** One 2.x row as a normalized transcript row, or null for a row the tab does not show. */
export function normalizeOpenCode2Message(
  message: OpenCode2Message,
): Record<string, unknown> | null {
  const createdAt = isoTime(message.time?.created);
  if (isOpenCode2UserMessage(message)) {
    return {
      id: message.id,
      role: "user",
      content: message.text,
      parts: [{ type: "text", content: message.text }],
      createdAt,
    };
  }
  if (!isAssistant(message)) return null;
  const parts: Record<string, unknown>[] = [];
  let content = "";
  for (const part of message.content.slice(0, 2_048)) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", content: part.text });
      content += part.text;
    } else if (part.type === "reasoning" && typeof part.text === "string") {
      if (part.text.trim()) parts.push({ type: "thinking", content: part.text });
    } else if (part.type === "tool" && typeof part.name === "string") {
      const status = part.state?.status;
      const toolArgs = boundedToolArgs(part.state?.input);
      parts.push({
        type: "tool-invocation",
        content: part.name,
        toolName: part.name,
        ...(toolArgs ? { toolArgs } : {}),
        ...(status === "completed"
          ? { toolState: "success" }
          : status === "error"
            ? { toolState: "failure" }
            : status === "running" || status === "streaming"
              ? { toolState: "pending" }
              : {}),
      });
    }
  }
  const model = message.model;
  return {
    id: message.id,
    role: "assistant",
    content,
    parts,
    createdAt,
    ...(model?.providerID && model.id ? { modelId: `${model.providerID}/${model.id}` } : {}),
  };
}

/** Oldest first in, oldest first out; rows the tab does not show are dropped. */
export function normalizeOpenCode2Transcript(
  messages: readonly OpenCode2Message[],
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const message of messages) {
    const row = normalizeOpenCode2Message(message);
    if (row) rows.push(row);
  }
  return rows;
}
