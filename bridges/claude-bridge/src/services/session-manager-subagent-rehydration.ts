/**
 * Subagent detail for a session read back from its rollout.
 *
 * A live turn renders a subagent's thinking, text and tool calls inside the
 * row holding the call that started it (`session-manager-prompt-stream.ts`).
 * The CLI writes those frames to the subagent's own transcript
 * (`<sessionId>/subagents/agent-<agentId>.jsonl`), not to the session's, so a
 * reload used to show only the call and its result. This reads each subagent
 * with the SDK's `getSubagentMessages`, which stamps every message with the
 * call that started it (`parent_tool_use_id`, from the subagent's sidecar),
 * and appends the same parts the live stream would have, under the same
 * per-call bound.
 */
import type { NormalizedMessage, NormalizedPart } from "../types/index.js";
import {
  buildMessageParts,
  parseMessageContent,
  ToolTracker,
  type OrderedPartEntry,
} from "./session-manager-messages.js";

/**
 * Parts kept per call: the live stream's `MAX_SUBAGENT_PARTS_PER_CALL`,
 * restated rather than imported because the prompt stream imports the
 * persistence module that calls this one. A test pins the two together.
 */
export const MAX_REHYDRATED_PARTS_PER_CALL = 128;
/** Subagents read per hydration; a session with more keeps the rest as calls only. */
export const MAX_REHYDRATED_SUBAGENTS = 64;
/** Nesting depth followed: a subagent's call can start another subagent. */
const MAX_SUBAGENT_DEPTH = 4;

interface SubagentRecord {
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
}

export interface SubagentTranscriptReader {
  listSubagents?: (sessionId: string, options?: { dir?: string }) => Promise<string[]>;
  getSubagentMessages?: (
    sessionId: string,
    agentId: string,
    options?: { dir?: string },
  ) => Promise<SubagentRecord[]>;
}

/** The row holding each tool call, by tool use id. */
function rowsByToolUse(messages: readonly NormalizedMessage[]): Map<string, NormalizedMessage> {
  const rows = new Map<string, NormalizedMessage>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.toolUseId) rows.set(part.toolUseId, message);
    }
  }
  return rows;
}

/** The parts a live turn shows for one subagent, oldest first, bounded. */
function subagentParts(records: readonly SubagentRecord[], createdAt: string): NormalizedPart[] {
  const tracker = new ToolTracker();
  const ordered: OrderedPartEntry[] = [];
  for (const record of records) {
    if (record.type !== "user" && record.type !== "assistant") continue;
    // User records carry the tool results the tracker folds into each call;
    // their text is the parent's prompt to the subagent, already on the call.
    const parsed = parseMessageContent(record, tracker, undefined, undefined, undefined, createdAt);
    if (record.type === "assistant") ordered.push(...parsed.orderedParts);
  }
  return buildMessageParts(ordered, tracker).slice(-MAX_REHYDRATED_PARTS_PER_CALL);
}

/**
 * Appends each subagent's parts to the row holding the call that started it.
 * Never throws: a reload without subagent detail is the old behaviour, not a
 * failed hydration.
 */
export async function rehydrateSubagentParts(
  sdk: SubagentTranscriptReader,
  sdkSessionId: string,
  dir: string,
  messages: readonly NormalizedMessage[],
): Promise<void> {
  if (typeof sdk.listSubagents !== "function" || typeof sdk.getSubagentMessages !== "function") {
    return;
  }
  const agentIds = (await sdk.listSubagents(sdkSessionId, { dir }).catch(() => [])).slice(
    0,
    MAX_REHYDRATED_SUBAGENTS,
  );
  if (agentIds.length === 0) return;
  const rows = rowsByToolUse(messages);
  let pending: Array<{ parent: string; records: SubagentRecord[] }> = [];
  for (const agentId of agentIds) {
    const records = await sdk.getSubagentMessages(sdkSessionId, agentId, { dir }).catch(() => []);
    const parent = records.find((record) => record.parent_tool_use_id)?.parent_tool_use_id;
    if (parent) pending.push({ parent, records });
  }
  // A nested subagent's call lives in its parent's parts, so place parents first.
  for (let depth = 0; depth < MAX_SUBAGENT_DEPTH && pending.length > 0; depth += 1) {
    const unplaced: typeof pending = [];
    for (const entry of pending) {
      const row = rows.get(entry.parent);
      if (!row) {
        unplaced.push(entry);
        continue;
      }
      // A row that already holds this call's subagent output (a live session)
      // keeps what it has.
      if (row.parts.some((part) => part.parentTaskUseId === entry.parent)) continue;
      const parts = subagentParts(entry.records, row.createdAt);
      row.parts.push(...parts);
      for (const part of parts) {
        if (part.toolUseId) rows.set(part.toolUseId, row);
      }
    }
    if (unplaced.length === pending.length) break;
    pending = unplaced;
  }
}
