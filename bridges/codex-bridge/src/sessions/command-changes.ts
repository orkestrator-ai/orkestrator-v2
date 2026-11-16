/**
 * Line-change badges for shell commands: which calls to measure, where the
 * measurements live, and how they are laid back onto a transcript.
 *
 * The measuring itself is `@orkestrator/protocol/node/workspace-change-probe`. Codex
 * reports a command only once it is running — app-server has no hook that
 * holds one, and approvals are off in normal operation — so every window is
 * opened in the probe's baseline mode: the runtime primes a snapshot before
 * each turn is dispatched, and a command is charged with whatever changed
 * between the latest snapshot and the one taken when it completed.
 *
 * No Codex transcript records the measurement, so it is journalled per thread
 * next to the bridge's other sidecar state and overlaid again on hydration.
 * Rows are matched by tool call id: app-server's command item id is the
 * rollout's `call_id`, which hydration carries as `toolUseId`.
 */
import { readdir, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexBridgeStateDir } from "../bridge-state-dir.js";
import {
  CommandChangeJournal,
  hasMeasuredChanges,
  readCommandChangeJournalFile,
} from "@orkestrator/protocol/node/command-change-journal";
import { isFileEditToolName, type MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import type { WorkspaceChangeProbe } from "@orkestrator/protocol/node/workspace-change-probe";
import type { EngineItem } from "../engine/types.js";
import type { NormalizedMessage, NormalizedPart } from "../messages/types.js";

/** The probe surface the runtime drives; tests substitute a fake. */
export type CommandChangeProbe = Pick<
  WorkspaceChangeProbe,
  "begin" | "note" | "endObservation" | "discard" | "prime"
>;

/**
 * Journal instances kept open. One per thread is the contract (appends are
 * serialized per instance), and a thread's instance is reused for its life;
 * past this many threads the least recently used one is dropped. A dropped
 * instance's queued appends still complete — only its serialization with a
 * successor instance is lost, which costs at most an interleaved line.
 */
export const MAX_OPEN_COMMAND_CHANGE_JOURNALS = 256;

const journals = new Map<string, CommandChangeJournal>();

/** Thread ids are UUIDs; anything else is folded to a safe file name. */
function journalFileName(threadId: string): string | undefined {
  const safe = threadId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  if (!safe || safe === "." || safe === "..") return undefined;
  return `${safe}.jsonl`;
}

export function commandChangeJournalPath(codexHome: string, threadId: string): string | undefined {
  const fileName = journalFileName(threadId);
  return fileName ? join(codexBridgeStateDir(codexHome), "command-changes", fileName) : undefined;
}

export function commandChangeJournalFor(
  codexHome: string,
  threadId: string,
): CommandChangeJournal | undefined {
  const path = commandChangeJournalPath(codexHome, threadId);
  if (!path) return undefined;
  let journal = journals.get(path);
  if (journal) {
    journals.delete(path);
  } else {
    journal = new CommandChangeJournal(path);
    while (journals.size >= MAX_OPEN_COMMAND_CHANGE_JOURNALS) {
      const oldest = journals.keys().next().value;
      if (oldest === undefined) break;
      journals.delete(oldest);
    }
  }
  journals.set(path, journal);
  return journal;
}

/** Every journalled measurement for one thread; empty when there are none. */
export async function readCommandChanges(
  codexHome: string,
  threadId: string,
): Promise<Map<string, MeasuredWorkspaceChange>> {
  const journal = commandChangeJournalFor(codexHome, threadId);
  if (!journal) return new Map();
  return journal.read().catch(() => new Map<string, MeasuredWorkspaceChange>());
}

/** Login journals adopted per bridge start; the rest wait for the next start. */
export const MAX_ADOPTED_COMMAND_CHANGE_JOURNALS = 4_096;

/** Suffix a merged login journal is renamed to, so a later start skips it. */
const ADOPTED_JOURNAL_SUFFIX = ".adopted";

/**
 * Part of the one-time upgrade at bridge start (`login-state-adoption.ts`):
 * the per-thread journals a bridge before the shared state directory wrote
 * into this login's own `command-changes` directory. Each is merged under the
 * shared journal (`CommandChangeJournal.adoptOlder`): its records go before
 * the shared ones, so at the entry limit they are the ones dropped, and a call
 * id the shared journal holds keeps the shared value. The merged journal is
 * published atomically.
 *
 * A source file is renamed `<name>.jsonl.adopted` only once its merge has
 * been published, so a start that reaches the per-start limit leaves only the
 * unmerged files for the next one. A file that cannot be read, or whose merge
 * cannot be published, stays in place for the next start; once a start
 * merges every file left, the directory is renamed `command-changes.adopted`
 * and never read again. A rerun after a crash adds nothing twice, since the
 * ids it merged are then held. Returns the number of journals merged, and
 * rejects after merging the rest when any journal failed.
 */
export async function adoptLoginCommandChanges(
  codexHome: string,
  source: string,
  limit = MAX_ADOPTED_COMMAND_CHANGE_JOURNALS,
): Promise<number> {
  const target = join(codexBridgeStateDir(codexHome), "command-changes");
  if (source === target) return 0;
  let names: string[];
  try {
    names = (await readdir(source)).filter((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const batch = names.slice(0, limit);
  let merged = 0;
  let failed = 0;
  let firstError: unknown;
  for (const name of batch) {
    // A file name is a folded thread id, which folds to itself.
    const threadId = name.slice(0, -".jsonl".length);
    const journal = commandChangeJournalFor(codexHome, threadId);
    const path = join(source, name);
    try {
      if (journal) {
        const legacy = await readCommandChangeJournalFile(path);
        if (legacy.size > 0) await journal.adoptOlder(legacy);
      }
      // Retired only once its merge is published; a file no thread id names
      // has nothing to merge and is retired with the rest.
      await rename(path, `${path}${ADOPTED_JOURNAL_SUFFIX}`);
      merged += 1;
    } catch (error) {
      failed += 1;
      firstError ??= error;
    }
  }
  if (failed > 0) {
    throw new Error(
      `${failed} login command-change journal(s) could not be adopted and stay for the next start`,
      { cause: firstError },
    );
  }
  if (batch.length === names.length) await rename(source, `${source}.adopted`);
  return merged;
}

/** Journal one measurement. Never rejects; a lost record costs a badge. */
export function recordCommandChanges(
  codexHome: string,
  threadId: string,
  toolUseId: string,
  change: MeasuredWorkspaceChange,
): Promise<void> {
  if (!hasMeasuredChanges(change)) return Promise.resolve();
  return (
    commandChangeJournalFor(codexHome, threadId)?.append(toolUseId, change) ?? Promise.resolve()
  );
}

/**
 * How an item takes part in measurement.
 *
 * - `measure`: the agent's own shell command.
 * - `note`: a call that edits files by other means (a patch, an edit tool), so
 *   a command overlapping it is flagged approximate, and so the baseline moves
 *   past its edit rather than charging it to the next command.
 * - `undefined`: neither. A user's own shell command is skipped because it can
 *   run between turns, where the baseline is older than the turn's; a write to
 *   an already-running process is skipped because its effects cannot be told
 *   apart from the process's own.
 */
export function commandChangeRole(item: EngineItem): "measure" | "note" | undefined {
  switch (item.type) {
    case "command_execution":
      return item.source === undefined ||
        item.source === "agent" ||
        item.source === "unifiedExecStartup"
        ? "measure"
        : undefined;
    case "file_change":
      return "note";
    case "dynamic_tool_call":
    case "mcp_tool_call":
      return isFileEditToolName(item.tool) ? "note" : undefined;
    default:
      return undefined;
  }
}

/**
 * The directory to measure an item in: the command's own when app-server
 * reported an absolute one, otherwise the thread's.
 */
export function commandChangeCwd(item: EngineItem, fallback: string): string {
  if (item.type !== "command_execution" || !item.cwd) return fallback;
  if (item.cwd.startsWith("file://")) {
    try {
      return fileURLToPath(item.cwd);
    } catch {
      return fallback;
    }
  }
  return isAbsolute(item.cwd) ? item.cwd : fallback;
}

/**
 * True for a command app-server settled without running it — a declined
 * approval, or one that failed to spawn. Such a call reports no exit code.
 */
export function commandDidNotRun(item: EngineItem): boolean {
  return (
    item.type === "command_execution" && item.status === "failed" && item.exit_code === undefined
  );
}

/** Set `commandChanges` on a call's tool rows, replacing each changed part. */
export function withCommandChanges(
  parts: NormalizedPart[],
  toolUseId: string,
  change: MeasuredWorkspaceChange | undefined,
): NormalizedPart[] {
  if (!change || !hasMeasuredChanges(change)) return parts;
  let changed = false;
  const next = parts.map((part) => {
    if (part.type !== "tool-invocation" || part.toolUseId !== toolUseId) return part;
    if (part.commandChanges === change) return part;
    changed = true;
    return { ...part, commandChanges: change };
  });
  return changed ? next : parts;
}

/**
 * Lay journalled measurements onto a transcript's tool rows, nested sub-agent
 * rows included. Parts are replaced rather than mutated, because the live
 * publisher tells a changed part from an unchanged one by identity.
 *
 * Returns the messages that changed.
 */
export function overlayCommandChanges(
  messages: NormalizedMessage[],
  changes: ReadonlyMap<string, MeasuredWorkspaceChange>,
): NormalizedMessage[] {
  if (changes.size === 0) return [];
  const changed: NormalizedMessage[] = [];
  for (const message of messages) {
    const parts = overlayParts(message.parts, changes);
    if (parts === message.parts) continue;
    message.parts = parts;
    changed.push(message);
  }
  return changed;
}

function overlayParts(
  parts: NormalizedPart[],
  changes: ReadonlyMap<string, MeasuredWorkspaceChange>,
): NormalizedPart[] {
  let next: NormalizedPart[] | undefined;
  for (const [index, part] of parts.entries()) {
    let replacement = part;
    const change =
      part.type === "tool-invocation" && part.toolUseId ? changes.get(part.toolUseId) : undefined;
    if (change && hasMeasuredChanges(change) && part.commandChanges !== change) {
      replacement = { ...replacement, commandChanges: change };
    }
    if (part.subagentActions?.length) {
      const actions = overlayParts(part.subagentActions, changes);
      if (actions !== part.subagentActions) {
        replacement = { ...replacement, subagentActions: actions };
      }
    }
    if (replacement !== part) {
      next ??= parts.slice();
      next[index] = replacement;
    }
  }
  return next ?? parts;
}

/**
 * A fork's rollout copies its parent's calls, ids and all, but the parent's
 * measurements live in the parent's journal. Lay the ones for rows the fork
 * kept onto its transcript, and copy them into the fork's own journal so they
 * survive the fork's later reloads without its parent.
 */
export async function inheritCommandChanges(
  codexHome: string,
  parentThreadId: string,
  forkThreadId: string,
  messages: NormalizedMessage[],
): Promise<void> {
  const inherited = await readCommandChanges(codexHome, parentThreadId);
  if (inherited.size === 0) return;
  const kept = new Map<string, MeasuredWorkspaceChange>();
  const collect = (parts: NormalizedPart[]) => {
    for (const part of parts) {
      const change = part.toolUseId ? inherited.get(part.toolUseId) : undefined;
      if (change && part.type === "tool-invocation") kept.set(part.toolUseId!, change);
      if (part.subagentActions?.length) collect(part.subagentActions);
    }
  };
  for (const message of messages) collect(message.parts);
  if (kept.size === 0) return;
  overlayCommandChanges(messages, kept);
  const journal = commandChangeJournalFor(codexHome, forkThreadId);
  // Appends never reject, and a read of this journal waits for them.
  for (const [id, change] of kept) void journal?.append(id, change);
}
