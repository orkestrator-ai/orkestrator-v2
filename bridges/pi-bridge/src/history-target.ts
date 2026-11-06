/**
 * Where a fork or a rewind cuts a Pi session's tree, from the transcript
 * message the user picked.
 */
import type { AgentSession, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { isObject, nonBlank, type SessionState } from "./state.js";

/**
 * A fork or rewind named a message this session cannot place on its active
 * branch. The route answers 409; a fork never falls back to another message.
 */
export class HistoryTargetError extends Error {
  override readonly name = "HistoryTargetError";

  constructor() {
    super("That message cannot be forked or rewound in this Pi session");
  }
}

/** Where a fork or rewind cuts Pi's tree: before a prompt, or at the end of a response. */
export type HistoryTarget = { entryId: string; position: "before" | "at" };

/** Entries Pi persists that no transcript row shows. A response's cut moves past them. */
const UNRENDERED_ENTRY_TYPES = new Set([
  "custom",
  "custom_message",
  "label",
  "session_info",
  "usage",
  "context_edit",
]);

/** Bound both persisted ids and the transient messages awaiting Pi's append. */
export const MAX_HISTORY_TARGETS = 1_024;

/** Remember a row's message only until Pi appends it after message_end. */
export function rememberHistoryMessage(state: SessionState, rowId: string, message: object): void {
  const pending = (state.historyMessages ??= new Map());
  pending.set(rowId, message);
  while (pending.size > MAX_HISTORY_TARGETS) pending.delete(pending.keys().next().value!);
}

/**
 * Convert transient message identities to durable Pi entry ids. Called at the
 * next SDK frame, before detach/persistence, and on target lookup. No ordinal
 * matching: local exchanges and never-sent prompts have no Pi entry at all.
 */
export function captureHistoryEntries(state: SessionState, manager: SessionManager): void {
  const pending = state.historyMessages;
  if (!pending?.size) return;
  const byMessage = new Map<object, string>();
  for (const entry of manager.getBranch()) {
    if (entry.type === "message") byMessage.set(entry.message, entry.id);
  }
  const ids = (state.historyEntries ??= new Map());
  for (const [rowId, message] of Array.from(pending)) {
    const entryId = byMessage.get(message);
    if (!entryId) continue;
    ids.set(rowId, entryId);
    pending.delete(rowId);
  }
  while (ids.size > MAX_HISTORY_TARGETS) ids.delete(ids.keys().next().value!);
}

/**
 * Resolve only a stable Pi id on the active branch. A replayed row already
 * uses that id; a live row keeps its published id and has a separate mapping.
 * Unknown/evicted mappings are refused rather than guessing a destructive cut.
 */
export function resolveHistoryTarget(
  state: SessionState,
  session: AgentSession,
  messageId: string,
): HistoryTarget | undefined {
  const requested = messageId.trim();
  if (!requested) return undefined;
  captureHistoryEntries(state, session.sessionManager);
  const branch = session.sessionManager.getBranch();
  const entryId = state.historyEntries?.get(requested) ?? requested;
  const entry = branch.find((candidate) => candidate.id === entryId);
  return entry ? targetForEntry(branch, entry) : undefined;
}

function isUserEntry(entry: SessionEntry): boolean {
  return entry.type === "message" && entry.message.role === "user";
}

/**
 * A prompt is cut before itself. Anything else is kept with the tool results
 * and unrendered entries that follow it, so a fork at a response that called
 * tools does not end on calls without their results.
 */
function targetForEntry(branch: SessionEntry[], entry: SessionEntry): HistoryTarget {
  if (isUserEntry(entry)) return { entryId: entry.id, position: "before" };
  let end = branch.indexOf(entry);
  while (end >= 0 && end + 1 < branch.length) {
    const next = branch[end + 1]!;
    const follows =
      (next.type === "message" && next.message.role === "toolResult") ||
      UNRENDERED_ENTRY_TYPES.has(next.type);
    if (!follows) break;
    end += 1;
  }
  return { entryId: (end >= 0 ? branch[end]! : entry).id, position: "at" };
}

export function lastUserTarget(session: AgentSession): HistoryTarget | undefined {
  const entry = session.sessionManager.getBranch().filter(isUserEntry).at(-1);
  return entry ? { entryId: entry.id, position: "before" } : undefined;
}

/** Record the leaf Pi just moved to, so a reopened session file returns to it. */
export function rememberHistoryLeaf(state: SessionState, manager: SessionManager): void {
  state.historyLeaf = { entryId: manager.getLeafId(), entries: manager.getEntryCount() };
}

/**
 * Put a freshly opened session back on the leaf a rewind or branch switch
 * chose. Once anything was appended (the count moved) the file's own leaf is
 * the right one, and the record is dropped.
 */
export function restoreHistoryLeaf(state: SessionState, manager: SessionManager): void {
  const leaf = state.historyLeaf;
  if (!leaf) return;
  if (manager.getEntryCount() !== leaf.entries) {
    state.historyLeaf = undefined;
    return;
  }
  if (manager.getLeafId() === leaf.entryId) return;
  if (leaf.entryId === null) manager.resetLeaf();
  else if (manager.getEntry(leaf.entryId)) manager.branch(leaf.entryId);
  else state.historyLeaf = undefined;
}

/** The text of a Pi message's content, string or text blocks. */
export function readContentText(content: unknown): string {
  if (nonBlank(content)) return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const block of content) {
    if (nonBlank(block)) chunks.push(block);
    else if (isObject(block) && block.type === "text" && nonBlank(block.text))
      chunks.push(block.text);
  }
  return chunks.join("\n");
}
