// The background tasks a session snapshot puts on the wire.
//
// `GET /session/:id` is the resource the backend polls every two seconds for
// every open tab, and `backgroundTasks` is its one field that grows with the
// session: up to `MAX_TERMINAL_BACKGROUND_TASKS` settled tasks plus every live
// one, each carrying the agent's prompt, the shell command, an output tail and
// the SDK's summaries. A long session that delegated repeatedly pushed that
// past the backend's read cap, and the tab failed with "claude session state
// read is oversized" on every poll. The in-memory record keeps everything; this
// is only the view that is served.

import type { BackgroundTaskSnapshot } from "../types/index.js";

/** Statuses from which a background task can still be doing work. */
export const LIVE_BACKGROUND_TASK_STATUSES = new Set<BackgroundTaskSnapshot["status"]>([
  "pending",
  "running",
  "paused",
]);

/**
 * Longest free-text field served. The backend keeps no more than this of any
 * of them (`BACKGROUND_TASK_TEXT_MAX_LENGTH` in its `claude-runtime.ts`), so
 * the cut changes nothing it shows.
 */
export const SNAPSHOT_TASK_TEXT_MAX_CHARS = 4_096;
/** Longest description served; the backend keeps the same. */
export const SNAPSHOT_TASK_DESCRIPTION_MAX_CHARS = 1_000;
/** Longest error a task reduced to its outline keeps. */
const OUTLINE_ERROR_MAX_CHARS = 255;

/**
 * Encoded size the whole `backgroundTasks` map aims to stay within.
 *
 * Generous for any ordinary session: a few dozen tasks with full detail fit.
 * Past it the oldest settled tasks lose their detail, and only past what even
 * outlines fit their place; live tasks are always served, because they decide
 * whether the session's work is finished.
 */
export const SNAPSHOT_BACKGROUND_TASKS_MAX_BYTES = 256 * 1024;

/** The fields that make a task large; an outline omits them. */
const DETAIL_FIELDS = ["prompt", "command", "outputTail", "summary", "progressSummary"] as const;

function headText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  // Trim first, as the backend does, so the cut keeps exactly what it shows.
  const text = value.trim();
  return text.length <= max ? text : text.slice(0, max);
}

function tailText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  return text.length <= max ? text : text.slice(-max);
}

/** One task with every free-text field cut to what the backend keeps. */
function cappedTask(task: BackgroundTaskSnapshot): BackgroundTaskSnapshot {
  const capped: BackgroundTaskSnapshot = { ...task };
  const set = <K extends keyof BackgroundTaskSnapshot>(
    key: K,
    value: BackgroundTaskSnapshot[K],
  ) => {
    if (value === undefined) delete capped[key];
    else capped[key] = value;
  };
  set("description", headText(task.description, SNAPSHOT_TASK_DESCRIPTION_MAX_CHARS));
  set("error", headText(task.error, SNAPSHOT_TASK_TEXT_MAX_CHARS));
  set("summary", headText(task.summary, SNAPSHOT_TASK_TEXT_MAX_CHARS));
  set("prompt", headText(task.prompt, SNAPSHOT_TASK_TEXT_MAX_CHARS));
  set("command", headText(task.command, SNAPSHOT_TASK_TEXT_MAX_CHARS));
  // A tail is the end of the output, so a cut keeps the end.
  set("outputTail", tailText(task.outputTail, SNAPSHOT_TASK_TEXT_MAX_CHARS));
  set("progressSummary", headText(task.progressSummary, SNAPSHOT_TASK_TEXT_MAX_CHARS));
  return capped;
}

/** A task's identity, lifecycle and short description, without its detail. */
function outlineTask(task: BackgroundTaskSnapshot): BackgroundTaskSnapshot {
  const outline: BackgroundTaskSnapshot = { ...task };
  for (const field of DETAIL_FIELDS) delete outline[field];
  if (outline.error !== undefined) outline.error = headText(outline.error, OUTLINE_ERROR_MAX_CHARS);
  return outline;
}

/** Encoded size of one `"id":{…},` member. */
function entryBytes(id: string, task: BackgroundTaskSnapshot): number {
  return (
    Buffer.byteLength(JSON.stringify(id), "utf8") + Buffer.byteLength(JSON.stringify(task)) + 2
  );
}

function recency(task: BackgroundTaskSnapshot): number {
  return task.endedAt ?? task.startedAt ?? 0;
}

/**
 * The `backgroundTasks` map a session snapshot serves.
 *
 * Every field is first cut to what the backend keeps. If the map is still over
 * `maxBytes`, every task is listed as an outline (live first, then settled
 * newest first), and detail is then restored in that order while it fits. A
 * live task is always served. A settled task that does not fit even as an
 * outline is left out, the same way `boundBackgroundTaskHistory` already drops
 * the oldest settled tasks past its count. Entries keep their original order.
 */
export function backgroundTasksForSnapshot(
  tasks: Record<string, BackgroundTaskSnapshot> | undefined,
  maxBytes: number = SNAPSHOT_BACKGROUND_TASKS_MAX_BYTES,
): Record<string, BackgroundTaskSnapshot> {
  if (!tasks) return {};
  const entries = Object.entries(tasks).map(([id, task], index) => ({
    id,
    index,
    live: LIVE_BACKGROUND_TASK_STATUSES.has(task.status),
    task: cappedTask(task),
  }));
  let total = 2;
  for (const entry of entries) total += entryBytes(entry.id, entry.task);
  if (total <= maxBytes) return Object.fromEntries(entries.map(({ id, task }) => [id, task]));

  const byPriority = [...entries].sort(
    (left, right) =>
      Number(right.live) - Number(left.live) ||
      recency(right.task) - recency(left.task) ||
      right.index - left.index,
  );
  // Listing a task matters more than its detail: admit outlines first, so a
  // few large recent tasks cannot crowd older ones out of the list entirely.
  const admitted = new Map<string, BackgroundTaskSnapshot>();
  const outlineBytes = new Map<string, number>();
  let used = 2;
  for (const { id, live, task } of byPriority) {
    const outline = outlineTask(task);
    const bytes = entryBytes(id, outline);
    if (!live && used + bytes > maxBytes) continue;
    admitted.set(id, outline);
    outlineBytes.set(id, bytes);
    used += bytes;
  }
  // Then give back detail in the same order while it fits.
  for (const { id, task } of byPriority) {
    const outlined = outlineBytes.get(id);
    if (outlined === undefined) continue;
    const extra = entryBytes(id, task) - outlined;
    if (used + extra > maxBytes) continue;
    admitted.set(id, task);
    used += extra;
  }
  return Object.fromEntries(
    entries.filter(({ id }) => admitted.has(id)).map(({ id }) => [id, admitted.get(id)!]),
  );
}
