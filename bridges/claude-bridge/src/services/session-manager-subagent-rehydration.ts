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
 *
 * A fork started from inside a subagent is the exception to "everything in the
 * file is the subagent's own". The CLI writes the parent subagent's whole
 * conversation into the fork's transcript ahead of the fork's first prompt
 * (from the root it writes only a reference instead), and that copy includes
 * the parent's launch calls for the fork's siblings without their results.
 * Read as the fork's output, each became a second, forever-pending launch card
 * (to-do 8303, retired). Only what follows the fork's own prompt is the fork's.
 */
import { normalizeBackendModelId } from "@orkestrator/protocol/model-id";
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
  listSubagents: (sessionId: string, options?: { dir?: string }) => Promise<string[]>;
  getSubagentMessages: (
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

/**
 * Marker opening the prompt the CLI gives a fork (`buildChildMessage`): a user
 * record whose text starts with it ends the history the fork inherited.
 * Verified against Claude Code 2.1.319.
 */
const FORK_PROMPT_MARKER = "<fork-boilerplate>";

function isForkPrompt(record: SubagentRecord): boolean {
  if (record.type !== "user") return false;
  const content = (record.message as { content?: unknown } | null | undefined)?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.startsWith(FORK_PROMPT_MARKER),
    )
  );
}

/**
 * The records a subagent produced itself.
 *
 * Everything up to and including a fork's prompt is the parent's history,
 * copied in as context: the parent's text, its calls (a sibling fork's launch
 * among them, with no result yet), and a clone of the call that started this
 * fork. None of it is this subagent's output. A subagent that is not a fork
 * has no such prompt and keeps every record.
 */
export function ownSubagentRecords<TRecord extends SubagentRecord>(
  records: readonly TRecord[],
): readonly TRecord[] {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (isForkPrompt(records[index]!)) return records.slice(index + 1);
  }
  return records;
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
 * Label the call with the model its subagent's responses reported, as the live
 * stream does. The rollout's copy of the call cannot say: its `model` argument
 * is only what was asked for, and usually absent.
 */
function labelSubagentModel(
  row: NormalizedMessage,
  parent: string,
  records: readonly SubagentRecord[],
): void {
  const index = row.parts.findIndex((part) => part.toolUseId === parent);
  if (index < 0 || row.parts[index]!.subagentModelId) return;
  for (let at = records.length - 1; at >= 0; at -= 1) {
    const record = records[at]!;
    if (record.type !== "assistant") continue;
    const subagentModelId = normalizeBackendModelId(
      (record.message as { model?: unknown } | null | undefined)?.model,
    );
    if (subagentModelId) {
      row.parts[index] = { ...row.parts[index]!, subagentModelId };
      return;
    }
  }
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
    if (parent) pending.push({ parent, records: [...ownSubagentRecords(records)] });
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
      labelSubagentModel(row, entry.parent, entry.records);
      // A row that already holds this call's subagent output (a live session)
      // keeps what it has.
      if (row.parts.some((part) => part.parentTaskUseId === entry.parent)) continue;
      // A call the transcript already holds belongs to the row holding it. A
      // copy of it here (history a fork inherited in a shape the filter above
      // does not recognise) would be a second card for one call, and one whose
      // result the copy never carried, so it would read as running forever.
      const parts = subagentParts(entry.records, row.createdAt).filter(
        (part) => !part.toolUseId || !rows.has(part.toolUseId),
      );
      row.parts.push(...parts);
      for (const part of parts) {
        if (part.toolUseId) rows.set(part.toolUseId, row);
      }
    }
    if (unplaced.length === pending.length) break;
    pending = unplaced;
  }
}
