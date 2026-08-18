/**
 * Backend-owned environment diff statistics.
 *
 * The counts behind each environment's diff badge used to be computed in every
 * connected renderer: N clients each shelled out to git on a timer for the same
 * answer, and the sidebar and the Files panel each asked separately for the
 * environment they were both looking at. The backend now owns one computation
 * per environment and announces the result here.
 *
 * Unlike `resource-events`, this payload carries the aggregate rather than only
 * an identifier. The aggregate is three integers and it is the entire reason a
 * client subscribes, so making every client refetch it would reintroduce the
 * fan-out this channel exists to remove. Clients that need the per-file detail
 * still refetch, and are served from the same cached scan.
 */

/** SSE/IPC event name carrying an {@link EnvironmentDiffStatsEvent}. */
export const DIFF_STATS_CHANGED_EVENT = "environment-diff-stats-changed";

export interface EnvironmentDiffStats {
  additions: number;
  deletions: number;
  filesChanged: number;
  /**
   * True when the untracked scan stopped before reading every file.
   *
   * A worktree can contain more untracked files than are worth opening on a
   * change signal. Surfacing the cap rather than silently reporting a smaller
   * number keeps a truncated count from reading as an exact one.
   */
  truncated: boolean;
}

export interface EnvironmentDiffStatsChange {
  environmentId: string;
  /** The git ref the counts were measured against. */
  comparisonRef: string;
  stats: EnvironmentDiffStats;
  /** ISO timestamp of the scan that produced these counts. */
  computedAt: string;
}

/**
 * Incremental invalidation emitted when previously published counts stop being
 * valid, for example while an environment is being retargeted to a new
 * comparison ref. A removal is deliberately distinct from zero counts: zero is
 * a measured result, while removal means there is no current result to show.
 */
export interface EnvironmentDiffStatsRemoval {
  environmentId: string;
  /** The comparison ref for which a replacement scan is being attempted. */
  comparisonRef: string;
  /** ISO timestamp at which the previous result became invalid. */
  computedAt: string;
  removed: true;
}

export type EnvironmentDiffStatsEvent = EnvironmentDiffStatsChange | EnvironmentDiffStatsRemoval;

/** Full snapshot returned by the `get_environment_diff_stats` command. */
export interface EnvironmentDiffStatsSnapshot {
  entries: EnvironmentDiffStatsChange[];
}

export const EMPTY_DIFF_STATS: EnvironmentDiffStats = {
  additions: 0,
  deletions: 0,
  filesChanged: 0,
  truncated: false,
};

export function isEnvironmentDiffStats(value: unknown): value is EnvironmentDiffStats {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isCount(candidate.additions) &&
    isCount(candidate.deletions) &&
    isCount(candidate.filesChanged) &&
    typeof candidate.truncated === "boolean"
  );
}

export function isEnvironmentDiffStatsChange(value: unknown): value is EnvironmentDiffStatsChange {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonBlankString(candidate.environmentId) &&
    isNonBlankString(candidate.comparisonRef) &&
    isIsoTimestamp(candidate.computedAt) &&
    isEnvironmentDiffStats(candidate.stats)
  );
}

export function isEnvironmentDiffStatsRemoval(
  value: unknown,
): value is EnvironmentDiffStatsRemoval {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.removed === true &&
    isNonBlankString(candidate.environmentId) &&
    isNonBlankString(candidate.comparisonRef) &&
    isIsoTimestamp(candidate.computedAt)
  );
}

export function isEnvironmentDiffStatsEvent(value: unknown): value is EnvironmentDiffStatsEvent {
  return isEnvironmentDiffStatsChange(value) || isEnvironmentDiffStatsRemoval(value);
}

export function isEnvironmentDiffStatsSnapshot(
  value: unknown,
): value is EnvironmentDiffStatsSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const entries = (value as Record<string, unknown>).entries;
  return Array.isArray(entries) && entries.every(isEnvironmentDiffStatsChange);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

/** Last-resort baseline when a repository has no branch configured at all. */
export const FALLBACK_COMPARISON_REF = "main";

interface BaselineRepositoryConfig {
  prBaseBranch?: string;
  defaultBranch?: string;
}

/**
 * Resolves the git ref an environment's changes are measured against.
 *
 * Lives in the protocol package because the backend computes the counts and the
 * frontend labels them: two copies of this chain drifted once already, and the
 * symptom - a badge measured against a different ref than the panel it opens -
 * is invisible until someone compares the numbers.
 *
 * The commit recorded at creation wins because it is exact and immutable. The
 * configured PR base branch is next, since that is the branch the work is
 * destined for. `defaultBranch` is the fallback rather than a literal "main": a
 * repository on `master` or `trunk` would otherwise be measured against a ref
 * that does not exist, and because diff stats are best-effort the failure is
 * silent - the counts simply never appear.
 */
export function resolveComparisonRef(
  createdFromCommit: string | undefined | null,
  repositoryConfig: BaselineRepositoryConfig | undefined | null,
): string {
  return (
    normaliseRef(createdFromCommit) ||
    normaliseRef(repositoryConfig?.prBaseBranch) ||
    normaliseRef(repositoryConfig?.defaultBranch) ||
    FALLBACK_COMPARISON_REF
  );
}

function normaliseRef(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
