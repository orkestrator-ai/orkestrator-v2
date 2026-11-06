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

/**
 * The Pi entry a transcript message names, and which side of it to cut.
 *
 * A live row's id is minted by this bridge, not by Pi: Pi appends the entry
 * only after its listeners have seen `message_end`. So an id is resolved, in
 * order, as a Pi entry id (a replayed row, or a branch entry), as a prompt row
 * (matched to the active branch's user entries from the newest, so a trimmed
 * transcript front cannot shift it), or as a response row through the Pi
 * message it was built from (`responseMessages`), which is the very object
 * Pi's entry holds. A response row whose message is no longer known resolves
 * only when it ends its turn, as the cut before the next prompt.
 *
 * Only the active branch counts: Pi's own `getUserMessagesForForking` lists
 * every branch in the file, so after one rewind its positions no longer match
 * the transcript's.
 */
export function resolveHistoryTarget(
  state: SessionState,
  session: AgentSession,
  messageId: string,
): HistoryTarget | undefined {
  const requested = messageId.trim();
  if (!requested) return undefined;
  const branch = session.sessionManager.getBranch();
  const named = branch.find((entry) => entry.id === requested);
  if (named) return targetForEntry(branch, named);

  const index = state.messages.findIndex((message) => message.id === requested);
  const row = state.messages[index];
  if (!row) return undefined;
  if (row.role === "user") return promptTarget(state, branch, index);

  const message = state.responseMessages?.get(requested);
  const built = message
    ? branch.find((entry) => entry.type === "message" && entry.message === message)
    : undefined;
  if (built) return targetForEntry(branch, built);

  // Only the end of a turn has an exact cut without the row's own entry.
  const rest = state.messages.slice(index + 1);
  const next = rest.findIndex((candidate) => candidate.role === "user");
  if (rest.slice(0, next < 0 ? undefined : next).some((later) => later.role === "assistant")) {
    return undefined;
  }
  if (next < 0) {
    const leaf = session.sessionManager.getLeafId();
    return leaf ? { entryId: leaf, position: "at" } : undefined;
  }
  return promptTarget(state, branch, index + 1 + next);
}

function isUserEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.role === "user" &&
    readContentText(entry.message.content).length > 0
  );
}

/** The user entry for the prompt row at `rowIndex`, counted from the newest. */
function promptTarget(
  state: SessionState,
  branch: SessionEntry[],
  rowIndex: number,
): HistoryTarget | undefined {
  const fromNewest = state.messages
    .slice(rowIndex + 1)
    .filter((message) => message.role === "user").length;
  const prompts = branch.filter(isUserEntry);
  const entry = prompts[prompts.length - 1 - fromNewest];
  return entry ? { entryId: entry.id, position: "before" } : undefined;
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
