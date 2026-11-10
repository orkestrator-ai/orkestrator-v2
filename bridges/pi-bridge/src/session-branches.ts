/**
 * The other branches of one Pi session file, so a rewind's abandoned turns can
 * be switched back to.
 *
 * Pi keeps every branch in the same JSONL tree; the bridge renders only the
 * active one. A rewind replaces the rendered rows with the kept branch, so no
 * row a client holds names an entry of the branch it left. This lists the
 * tree's leaves by their Pi entry ids — the ids `POST /session/:id/branches/:entryId`
 * takes — each described by the prompt that starts it.
 */
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  NATIVE_AGENT_BRANCH_LIST_LIMITS,
  type NativeAgentSessionBranchList,
} from "@orkestrator/protocol/native-agent";
import { ensureSession } from "./agent-session.js";
import { readContentText } from "./history-target.js";
import type { SessionState } from "./state.js";

/** Leaves listed per read, newest first. A tree can hold many more. */
export const MAX_LISTED_BRANCHES = NATIVE_AGENT_BRANCH_LIST_LIMITS.branches;

/** Characters of a branch's starting prompt shown in the picker. */
export const MAX_BRANCH_PROMPT_CHARS = NATIVE_AGENT_BRANCH_LIST_LIMITS.promptChars;

export type SessionBranchList = NativeAgentSessionBranchList;

/** Entry types that carry conversation content worth switching back to. */
function isConversationEntry(entry: SessionEntry): boolean {
  return entry.type === "message" || entry.type === "custom_message";
}

function promptText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return undefined;
  const text = readContentText((entry.message as { content?: unknown }).content)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_BRANCH_PROMPT_CHARS
    ? `${text.slice(0, MAX_BRANCH_PROMPT_CHARS - 1)}…`
    : text;
}

/**
 * Every leaf of the tree that is not on the active branch and holds
 * conversation the active branch does not.
 *
 * A leaf on the active path is the active branch itself (or an ancestor of a
 * rewound leaf, which cannot be a leaf). A leaf that diverges only by
 * bookkeeping entries (a label, a model change) has nothing to switch back to.
 */
export function listSessionBranches(
  manager: Pick<SessionManager, "getEntries" | "getLeafId">,
): SessionBranchList {
  const entries = manager.getEntries();
  const byId = new Map<string, SessionEntry>();
  const hasChildren = new Set<string>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
    if (entry.parentId) hasChildren.add(entry.parentId);
  }
  const activeEntryId = manager.getLeafId();
  const activePath = new Set<string>();
  for (
    let cursor = activeEntryId ? byId.get(activeEntryId) : undefined;
    cursor;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  ) {
    if (activePath.has(cursor.id)) break;
    activePath.add(cursor.id);
  }

  // Newest first; entries appended in the same millisecond keep file order.
  const leaves = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !hasChildren.has(entry.id) && !activePath.has(entry.id))
    .sort(
      (left, right) =>
        right.entry.timestamp.localeCompare(left.entry.timestamp) || right.index - left.index,
    )
    .map(({ entry }) => entry);

  const branches: SessionBranchList["branches"] = [];
  let truncated = false;
  for (const leaf of leaves) {
    // Walk to the root: `own` holds what the active branch does not share,
    // newest first; `depth` counts the whole path.
    const own: SessionEntry[] = [];
    const seen = new Set<string>();
    let depth = 0;
    let newestPrompt: string | undefined;
    for (
      let cursor: SessionEntry | undefined = leaf;
      cursor && !seen.has(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
    ) {
      seen.add(cursor.id);
      depth += 1;
      if (!activePath.has(cursor.id)) own.push(cursor);
      newestPrompt ??= promptText(cursor);
    }
    if (!own.some(isConversationEntry)) continue;
    if (branches.length >= MAX_LISTED_BRANCHES) {
      truncated = true;
      break;
    }
    const firstOwnPrompt = own
      .slice()
      .reverse()
      .map(promptText)
      .find((text) => text !== undefined);
    branches.push({
      entryId: leaf.id,
      prompt: firstOwnPrompt ?? newestPrompt ?? "",
      entries: depth,
      updatedAt: leaf.timestamp,
    });
  }
  return { activeEntryId, branches, truncated };
}

/**
 * The branch list for one bridge session, read from the live `SessionManager`
 * so a branch a rewind just left is included.
 */
export async function readSessionBranches(state: SessionState): Promise<SessionBranchList> {
  const session = await ensureSession(state);
  return listSessionBranches(session.sessionManager);
}
