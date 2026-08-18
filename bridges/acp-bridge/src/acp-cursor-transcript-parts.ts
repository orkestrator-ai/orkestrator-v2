import {
  CURSOR_JSONL_SOURCE_PREFIX,
  MAX_CURSOR_CHILD_PARTS,
  MAX_CURSOR_CHILD_PROMPT_BYTES,
  MAX_CURSOR_CHILD_PROMPT_RECORDS,
  MAX_MESSAGE_TEXT_BYTES,
  MAX_TOOL_ID_BYTES,
  MAX_TOOL_NAME_BYTES,
  MAX_TOOL_TITLE_BYTES,
  isObject,
  type BridgeMessage,
  type BridgeMessagePart,
  type BridgeTextPart,
  type BridgeToolPart,
  type SessionState,
} from "./acp-context.js";
import { schedulePersist } from "./acp-persist-writer.js";
import { boundTranscript, boundedToolArguments, truncateUtf8 } from "./acp-transcript.js";
import { findToolPart, recordCursorTaskPrompt } from "./acp-tools.js";

/**
 * How the child stands at the moment of a projection:
 * - `live` — still running, so its trailing tools are still in flight.
 * - `ended` — the transcript carried a terminal record, so everything it
 *   started also finished.
 * - `abandoned` — no terminal record, but the child is gone (the bridge
 *   restarted, or the parent stopped tracking it). Whatever it was inside when
 *   it died never produced a result and must not be shown as successful.
 */
export type CursorChildTranscriptState = "live" | "ended" | "abandoned";

export function cursorJsonlSourcePrefix(agentId: string): string {
  return `${CURSOR_JSONL_SOURCE_PREFIX}${agentId}:`;
}

export function isCursorJsonlPart(part: BridgeMessagePart, agentId?: string): boolean {
  const prefix = agentId ? cursorJsonlSourcePrefix(agentId) : CURSOR_JSONL_SOURCE_PREFIX;
  return part.sourcePartId.startsWith(prefix);
}

/**
 * Cursor child JSONL is a stream of `user` / `assistant` / `turn_ended`
 * records. Assistant `content` is `text` and `tool_use` parts (`name` +
 * `input`). There is no tool id and no tool result, so this projects the
 * child's visible activity into the parent Task card — not a full result log.
 */
export function parseCursorChildTranscriptParts(
  contents: string,
  parentToolUseId: string,
  agentId: string,
  sourceMessageId: string,
  childState: CursorChildTranscriptState,
): Array<BridgeTextPart | BridgeToolPart> {
  const prefix = cursorJsonlSourcePrefix(agentId);
  const records: Array<{ parts: Array<BridgeTextPart | BridgeToolPart> }> = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isObject(parsed)) continue;
      const role = parsed.role === "assistant" || parsed.type === "assistant";
      if (!role) continue;
      const message = isObject(parsed.message) ? parsed.message : parsed;
      const recordParts: Array<BridgeTextPart | BridgeToolPart> = [];
      if (typeof message.content === "string" && message.content.trim()) {
        recordParts.push({
          type: "text",
          content: truncateUtf8(message.content.trim(), MAX_MESSAGE_TEXT_BYTES),
          sourcePartId: `${prefix}${records.length}:0`,
          sourceMessageId,
          parentTaskUseId: parentToolUseId,
        });
      }
      const content = Array.isArray(message.content) ? message.content : [];
      for (const item of content) {
        if (!isObject(item)) continue;
        if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
          recordParts.push({
            type: "text",
            content: truncateUtf8(item.text.trim(), MAX_MESSAGE_TEXT_BYTES),
            sourcePartId: `${prefix}${records.length}:${recordParts.length}`,
            sourceMessageId,
            parentTaskUseId: parentToolUseId,
          });
          continue;
        }
        if (item.type !== "tool_use" || typeof item.name !== "string" || !item.name.trim()) {
          continue;
        }
        const toolName = truncateUtf8(item.name.trim(), MAX_TOOL_NAME_BYTES);
        const toolUseId = truncateUtf8(
          `${agentId}:${records.length}:${recordParts.length}`,
          MAX_TOOL_ID_BYTES,
        );
        const toolArgs = isObject(item.input) ? boundedToolArguments(item.input) : undefined;
        recordParts.push({
          type: "tool-invocation",
          content: toolName,
          sourcePartId: `${prefix}${records.length}:${recordParts.length}`,
          sourceMessageId,
          toolUseId,
          toolName,
          toolTitle: truncateUtf8(toolName, MAX_TOOL_TITLE_BYTES),
          parentTaskUseId: parentToolUseId,
          ...(toolArgs ? { toolArgs } : {}),
          toolState: "success",
        });
      }
      if (recordParts.length > 0) records.push({ parts: recordParts });
    } catch {
      // A tail read can start mid-line.
    }
  }

  // Everything before the trailing record provably completed: the child moved
  // on. Only the trailing record's tools are open, so only they can still be
  // in flight or lost with the child.
  if (childState !== "ended") {
    const last = records.at(-1);
    if (last) {
      for (const part of last.parts) {
        if (part.type !== "tool-invocation") continue;
        part.toolState = childState === "live" ? "pending" : "failure";
        if (childState === "abandoned") {
          part.toolError = "The sub-agent ended before this tool reported a result";
        }
      }
    }
  }

  const flattened = records.flatMap((record) => record.parts);
  return flattened.length <= MAX_CURSOR_CHILD_PARTS
    ? flattened
    : flattened.slice(-MAX_CURSOR_CHILD_PARTS);
}

export function syncCursorChildTranscriptParts(
  state: SessionState,
  child: { toolUseId: string; agentId: string },
  contents: string,
  childState: CursorChildTranscriptState,
): boolean {
  const found = findToolPart(state, child.toolUseId);
  if (!found) return false;
  const { owner, part: parent } = found;
  if (hasNativeNestedChildren(owner, child.toolUseId)) return false;

  let changed = recoverCursorChildPrompt(parent, contents);
  const next = parseCursorChildTranscriptParts(
    contents,
    child.toolUseId,
    child.agentId,
    owner.id,
    childState,
  );
  // Keyed on the launch, not the agent: when an inferred binding is superseded
  // by the `agentId` Cursor finally reports, the superseded child's parts must
  // leave with it rather than sit alongside the real ones forever.
  const existing = owner.parts.filter((part) => isCursorJsonlChildPart(part, child.toolUseId));
  if (!cursorJsonlPartsEqual(existing, next)) {
    owner.parts = owner.parts.filter(
      (candidate) => !isCursorJsonlChildPart(candidate, child.toolUseId),
    );
    const parentIndex = owner.parts.indexOf(parent);
    const insertAt = parentIndex >= 0 ? parentIndex + 1 : owner.parts.length;
    owner.parts.splice(insertAt, 0, ...next);
    changed = true;
  }
  if (!changed) return false;
  state.revision += 1;
  boundTranscript(state);
  schedulePersist();
  return true;
}

function isCursorJsonlChildPart(part: BridgeMessagePart, parentToolUseId: string): boolean {
  // A projection is only ever a text or tool part; `file` has no parent link.
  return (
    part.type !== "file" && isCursorJsonlPart(part) && part.parentTaskUseId === parentToolUseId
  );
}

function hasNativeNestedChildren(owner: BridgeMessage, parentToolUseId: string): boolean {
  return owner.parts.some(
    (part) =>
      part.type === "tool-invocation" &&
      part.parentTaskUseId === parentToolUseId &&
      !isCursorJsonlPart(part),
  );
}

/**
 * Label a Task card from the child's own first user record when Cursor has not
 * named it.
 *
 * A foreground launch arrives as a bare `{ _toolName: "task" }`, so until the
 * child ends the card has no description and no prompt — it reads as an
 * anonymous "Subagent task" for however long the child runs. The child's
 * transcript opens with the prompt it was given, which is the same text
 * `cursor/task` would eventually carry, so it stands in until the real one
 * arrives and replaces it.
 */
function recoverCursorChildPrompt(parent: BridgeToolPart, contents: string): boolean {
  const existing = parent.toolArgs?.prompt;
  if (typeof existing === "string" && existing.trim()) return false;
  const prompt = cursorChildTranscriptPrompt(contents);
  if (!prompt) return false;
  return recordCursorTaskPrompt(parent, prompt);
}

export function cursorChildTranscriptPrompt(contents: string): string | undefined {
  const lines = contents.split("\n");
  const limit = Math.min(lines.length, MAX_CURSOR_CHILD_PROMPT_RECORDS);
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A tail read can start mid-line, and the head of a rotated file may be
      // gone entirely. Either way there is simply no prompt to recover.
      continue;
    }
    if (!isObject(parsed)) continue;
    if (parsed.role !== "user" && parsed.type !== "user") continue;
    const message = isObject(parsed.message) ? parsed.message : parsed;
    const text = userRecordText(message.content);
    if (!text) continue;
    return truncateUtf8(text, MAX_CURSOR_CHILD_PROMPT_BYTES);
  }
  return undefined;
}

function userRecordText(content: unknown): string | undefined {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
            .join("")
        : "";
  // Cursor wraps the spawn prompt in `<user_query>` and prefixes a
  // `<timestamp>` envelope. Neither belongs on a card.
  const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(raw)?.[1];
  const text = (query ?? raw.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "")).trim();
  return text || undefined;
}

function cursorJsonlPartsEqual(
  left: BridgeMessagePart[],
  right: Array<BridgeTextPart | BridgeToolPart>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((part, index) => {
    const other = right[index];
    if (!other) return false;
    if (
      part.type !== other.type ||
      part.sourcePartId !== other.sourcePartId ||
      part.content !== other.content
    ) {
      return false;
    }
    if (part.type === "tool-invocation" && other.type === "tool-invocation") {
      return (
        part.toolState === other.toolState &&
        part.toolName === other.toolName &&
        part.toolError === other.toolError
      );
    }
    return true;
  });
}
