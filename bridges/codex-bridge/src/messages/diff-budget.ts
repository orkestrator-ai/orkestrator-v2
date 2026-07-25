/**
 * Memory budget for file-change diff state.
 *
 * This is the largest in-memory consumer in the bridge, and the least obvious.
 * `ToolDiffMetadata` carries `before` and `after` — **entire file contents** — and
 * the render state keeps two collections of them per thread:
 *
 *   baselines: path  → full content after the last turn touched it
 *   cache:     item  → { before, after, diff } for one file_change item
 *
 * A session that edits 40 files of 40KB, several times each, therefore holds tens
 * of megabytes. With `codex exec` this was survivable because the whole bridge
 * session was thrown away relatively often; with a long-lived app-server thread it
 * simply grows.
 *
 * The fix is not to stop caching — baselines are what make a second edit to the
 * same file diff against the previous turn rather than against git HEAD. The fix
 * is to bound it, and to stop storing full contents for files where nobody will
 * look at a side-by-side view anyway.
 */
import type { FileChangeDiffContext, ToolDiffMetadata } from "./types.js";

/**
 * Above this, `before`/`after` are dropped and only the unified diff is kept.
 *
 * The diff is what the UI renders by default; before/after exist for
 * side-by-side. For a 5MB minified bundle the side-by-side view is useless
 * anyway, so paying 10MB of RSS for it is a bad trade.
 */
export const MAX_INLINE_FILE_BYTES = 256 * 1024;

/** Above this a diff is summarised rather than stored in full. */
export const MAX_DIFF_BYTES = 1024 * 1024;

/** Baselines are one entry per distinct file the thread has touched. */
export const MAX_BASELINE_ENTRIES = 128;
export const MAX_BASELINE_BYTES = 32 * 1024 * 1024;

/** The per-turn cache; cleared between turns, so this is a within-turn cap. */
export const MAX_DIFF_CACHE_ENTRIES = 256;

export const TRUNCATED_NOTICE = "\n… content omitted (file too large to keep in memory)";

function byteLength(value: string | undefined): number {
  return value === undefined ? 0 : Buffer.byteLength(value, "utf8");
}

/**
 * Drops oversized `before`/`after` before they are stored.
 *
 * Returns metadata that is always safe to keep: counts and the diff survive, so
 * the transcript still shows what changed and by how much.
 */
export function applyDiffBudget(metadata: ToolDiffMetadata): ToolDiffMetadata {
  const beforeBytes = byteLength(metadata.before);
  const afterBytes = byteLength(metadata.after);
  const tooLarge = beforeBytes > MAX_INLINE_FILE_BYTES || afterBytes > MAX_INLINE_FILE_BYTES;

  let diff = metadata.diff;
  if (diff !== undefined && byteLength(diff) > MAX_DIFF_BYTES) {
    // Keep the head: the first hunks are the ones a reviewer reads.
    diff = `${diff.slice(0, MAX_DIFF_BYTES)}${TRUNCATED_NOTICE}`;
  }

  if (!tooLarge) return { ...metadata, diff };

  return {
    filePath: metadata.filePath,
    additions: metadata.additions,
    deletions: metadata.deletions,
    diff,
    // `before`/`after` deliberately omitted rather than truncated: a half file
    // rendered in a side-by-side view is worse than no side-by-side view.
  };
}

/** True when this content is small enough to be worth keeping as a baseline. */
export function isBaselineWorthKeeping(content: string | undefined): boolean {
  return byteLength(content) <= MAX_INLINE_FILE_BYTES;
}

function totalBaselineBytes(baselines: Map<string, string | undefined>): number {
  let total = 0;
  for (const value of baselines.values()) total += byteLength(value);
  return total;
}

/**
 * Evicts oldest-first until the baseline map is inside budget.
 *
 * Eviction is safe: a missing baseline just means the next diff for that file is
 * taken against git HEAD instead of the previous turn — the pre-baseline
 * behaviour, and still a correct diff.
 */
export function pruneBaselines(baselines: Map<string, string | undefined>): number {
  let evicted = 0;
  while (baselines.size > MAX_BASELINE_ENTRIES) {
    const oldest = baselines.keys().next().value;
    if (oldest === undefined) break;
    baselines.delete(oldest);
    evicted += 1;
  }
  // Byte budget is checked after the entry budget so the cheap check runs first.
  if (totalBaselineBytes(baselines) <= MAX_BASELINE_BYTES) return evicted;
  for (const key of [...baselines.keys()]) {
    if (totalBaselineBytes(baselines) <= MAX_BASELINE_BYTES) break;
    baselines.delete(key);
    evicted += 1;
  }
  return evicted;
}

export function pruneDiffCache(cache: Map<string, ToolDiffMetadata>): number {
  let evicted = 0;
  while (cache.size > MAX_DIFF_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
    evicted += 1;
  }
  return evicted;
}

/**
 * Marks a baseline as recently used so eviction is LRU rather than FIFO.
 *
 * A file edited repeatedly across a long session should outlive one touched once
 * at the start, and `Map` iterates in insertion order — so re-inserting is what
 * makes "oldest key" mean "least recently used".
 */
export function touchBaseline(
  baselines: Map<string, string | undefined>,
  path: string,
): void {
  if (!baselines.has(path)) return;
  const value = baselines.get(path);
  baselines.delete(path);
  baselines.set(path, value);
}

/**
 * Starts a new turn.
 *
 * The per-item cache is turn-scoped, so it is cleared. Baselines are **kept**:
 * dropping them would make every turn diff against git HEAD, so turn 3 would
 * re-display the changes made in turns 1 and 2.
 */
export function beginTurn(context: FileChangeDiffContext): void {
  context.cache.clear();
  pruneBaselines(context.baselines);
}

export interface DiffBudgetStats {
  baselineEntries: number;
  baselineBytes: number;
  cacheEntries: number;
}

export function describeDiffBudget(context: FileChangeDiffContext): DiffBudgetStats {
  return {
    baselineEntries: context.baselines.size,
    baselineBytes: totalBaselineBytes(context.baselines),
    cacheEntries: context.cache.size,
  };
}
