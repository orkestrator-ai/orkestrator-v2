import {
  CURSOR_JSONL_SOURCE_PREFIX,
  MAX_CURSOR_CHILD_PARTS,
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
import { findToolPart } from "./acp-tools.js";

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
  if (hasNativeNestedChildren(owner, child.toolUseId, child.agentId)) return false;

  const next = parseCursorChildTranscriptParts(
    contents,
    child.toolUseId,
    child.agentId,
    owner.id,
    childState,
  );
  const existing = owner.parts.filter((part) => isCursorJsonlPart(part, child.agentId));
  if (cursorJsonlPartsEqual(existing, next)) return false;

  owner.parts = [
    ...owner.parts.filter((candidate) => !isCursorJsonlPart(candidate, child.agentId)),
  ];
  const parentIndex = owner.parts.indexOf(parent);
  const insertAt = parentIndex >= 0 ? parentIndex + 1 : owner.parts.length;
  owner.parts.splice(insertAt, 0, ...next);
  state.revision += 1;
  boundTranscript(state);
  schedulePersist();
  return true;
}

function hasNativeNestedChildren(
  owner: BridgeMessage,
  parentToolUseId: string,
  agentId: string,
): boolean {
  return owner.parts.some((part) =>
    part.type === "tool-invocation"
    && part.parentTaskUseId === parentToolUseId
    && !isCursorJsonlPart(part, agentId),
  );
}

function cursorJsonlPartsEqual(
  left: BridgeMessagePart[],
  right: Array<BridgeTextPart | BridgeToolPart>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((part, index) => {
    const other = right[index];
    if (!other) return false;
    if (part.type !== other.type
      || part.sourcePartId !== other.sourcePartId
      || part.content !== other.content) {
      return false;
    }
    if (part.type === "tool-invocation" && other.type === "tool-invocation") {
      return part.toolState === other.toolState
        && part.toolName === other.toolName
        && part.toolError === other.toolError;
    }
    return true;
  });
}
