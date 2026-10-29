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

import {
  hasValidOptionalViewStamp,
  type ViewGeneration,
  type ViewSnapshotOutcome,
} from "./view-sync.js";

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

/**
 * Optional owner ordering carried by current backends (see `view-sync.ts`).
 *
 * `generation` identifies one lifetime of the backend diff-stats service and
 * `revision` increases by one per announced change or removal within it. Both
 * are absent from legacy backends and from snapshot entries.
 */
export interface EnvironmentDiffStatsRevisionFields {
  generation?: ViewGeneration;
  revision?: number;
}

export interface EnvironmentDiffStatsChange extends EnvironmentDiffStatsRevisionFields {
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
export interface EnvironmentDiffStatsRemoval extends EnvironmentDiffStatsRevisionFields {
  environmentId: string;
  /** The comparison ref for which a replacement scan is being attempted. */
  comparisonRef: string;
  /** ISO timestamp at which the previous result became invalid. */
  computedAt: string;
  removed: true;
}

export type EnvironmentDiffStatsEvent = EnvironmentDiffStatsChange | EnvironmentDiffStatsRemoval;

/**
 * Full snapshot returned by the `get_environment_diff_stats` command.
 *
 * On a current backend the top-level `generation`/`revision` identify the
 * captured state: every announced change or removal up to `revision` is
 * reflected in `entries`, and none after it.
 */
export interface EnvironmentDiffStatsSnapshot extends EnvironmentDiffStatsRevisionFields {
  entries: EnvironmentDiffStatsChange[];
}

/**
 * Answer to `get_environment_diff_stats` called with `knownGeneration` and
 * `knownRevision`. Legacy backends ignore those arguments and return a plain
 * {@link EnvironmentDiffStatsSnapshot}.
 */
export type EnvironmentDiffStatsSnapshotOutcome = ViewSnapshotOutcome<EnvironmentDiffStatsSnapshot>;

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
    isEnvironmentDiffStats(candidate.stats) &&
    hasValidOptionalViewStamp(candidate, "event")
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
    isIsoTimestamp(candidate.computedAt) &&
    hasValidOptionalViewStamp(candidate, "event")
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
  return (
    Array.isArray(entries) &&
    entries.every(isEnvironmentDiffStatsChange) &&
    hasValidOptionalViewStamp(value, "snapshot")
  );
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
 * The environment's baseline commit ({@link environmentBaselineCommit}) wins
 * because it is exact and immutable. The
 * configured PR base branch is next, since that is the branch the work is
 * destined for. `defaultBranch` is the fallback rather than a literal "main": a
 * repository on `master` or `trunk` would otherwise be measured against a ref
 * that does not exist, and because diff stats are best-effort the failure is
 * silent - the counts simply never appear.
 */
export function resolveComparisonRef(
  baselineCommit: string | undefined | null,
  repositoryConfig: BaselineRepositoryConfig | undefined | null,
): string {
  return (
    normaliseRef(baselineCommit) ||
    normaliseRef(repositoryConfig?.prBaseBranch) ||
    normaliseRef(repositoryConfig?.defaultBranch) ||
    FALLBACK_COMPARISON_REF
  );
}

/**
 * A newer start point for an environment's changes, found after its branch took
 * in later history from the branch it targets (a merge of, rebase onto or reset
 * to a newer `origin/main`).
 *
 * `createdFromCommit` names the creation commit this was derived from. Every
 * path that recreates a checkout replaces `createdFromCommit`, so a record whose
 * source no longer matches describes a checkout that is gone and is ignored
 * rather than having to be cleared at each of those paths.
 */
export interface EnvironmentDiffBaseline {
  createdFromCommit: string;
  commit: string;
}

/**
 * A commit the user chose to measure an environment's changes from, in place of
 * the automatic baseline. Typically the tip of the target branch after merging
 * it in, so the Changes panel shows only what this branch adds on top of it.
 *
 * `commit` is a full SHA so the comparison stays put when the branch it was
 * picked from moves. `ref` and `subject` are kept for display only.
 */
export interface EnvironmentDiffBaseOverride {
  /** Full ref the commit was picked from, e.g. `refs/remotes/origin/main`. */
  ref: string;
  commit: string;
  /** The commit's subject when it was picked. */
  subject?: string;
}

/** A branch offered as the source of a diff base override. */
export interface DiffBaseBranch {
  /** Full ref, e.g. `refs/heads/main` or `refs/remotes/origin/main`. */
  ref: string;
  /** Short name, e.g. `main` or `origin/main`. */
  name: string;
  kind: "local" | "remote";
}

/** A commit offered as a diff base, newest first along the branch's first parents. */
export interface DiffBaseCommit {
  commit: string;
  subject: string;
  author: string;
  /** Committer date, ISO 8601. */
  committedAt: string;
}

/** `refs/heads/main` → `main`, `refs/remotes/origin/main` → `origin/main`. */
export function shortDiffBaseRefName(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes)\//, "");
}

export const MAX_DIFF_BASE_SUBJECT_LENGTH = 500;
const MAX_DIFF_BASE_REF_LENGTH = 1_024;

/**
 * Validates a stored or submitted override, normalising its commit and subject.
 * Throws on anything that is not a full SHA picked from a branch ref.
 */
export function parseEnvironmentDiffBaseOverride(value: unknown): EnvironmentDiffBaseOverride {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid environment diff base override");
  }
  const record = value as { ref?: unknown; commit?: unknown; subject?: unknown };
  const commit = typeof record.commit === "string" ? record.commit.trim() : "";
  const ref = typeof record.ref === "string" ? record.ref.trim() : "";
  if (
    !/^[0-9a-f]{40}$/i.test(commit) ||
    ref.length > MAX_DIFF_BASE_REF_LENGTH ||
    !/^refs\/(?:heads|remotes)\/[^\x00-\x20\x7f]+$/.test(ref)
  ) {
    throw new Error("Invalid environment diff base override");
  }
  const subject =
    typeof record.subject === "string"
      ? record.subject.trim().slice(0, MAX_DIFF_BASE_SUBJECT_LENGTH)
      : "";
  return { ref, commit: commit.toLowerCase(), ...(subject ? { subject } : {}) };
}

interface BaselineEnvironment {
  createdFromCommit?: string | null;
  diffBaseline?: EnvironmentDiffBaseline | null;
  diffBaseOverride?: EnvironmentDiffBaseOverride | null;
}

/**
 * The commit an environment's changes are measured from: the commit the user
 * picked ({@link EnvironmentDiffBaseOverride}), else where its branch now leaves
 * the branch it targets, else the commit it was created from.
 *
 * Measuring from the creation commit alone counts every commit the branch later
 * took in from its target as the environment's own work. A worker launched from
 * a checkout 14 commits behind `origin/main` that then merges `origin/main`
 * would otherwise show those 14 commits in its Changes panel.
 */
export function environmentBaselineCommit(
  environment: BaselineEnvironment | undefined | null,
): string | undefined {
  // A base the user picked wins over every automatic rule.
  const override = normaliseRef(environment?.diffBaseOverride?.commit);
  if (override) return override;
  const createdFromCommit = normaliseRef(environment?.createdFromCommit);
  if (!createdFromCommit) return undefined;
  const baseline = environment?.diffBaseline;
  if (
    baseline &&
    normaliseRef(baseline.createdFromCommit)?.toLowerCase() === createdFromCommit.toLowerCase()
  ) {
    return normaliseRef(baseline.commit) ?? createdFromCommit;
  }
  return createdFromCommit;
}

function normaliseRef(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
