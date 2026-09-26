/**
 * Revisions for the backend-owned worktree snapshots behind the Files panel.
 *
 * The backend keeps one read owner per environment target for two separate
 * views of a worktree:
 *
 * - the **file list**: the changed files against the comparison ref (path,
 *   original path, status, additions/deletions, truncation), shared with the
 *   diff-statistics scan. Its revision advances whenever that semantic list
 *   changes, even when the aggregate counts are identical (two edits that
 *   swap which files changed can leave `filesChanged`/`additions` alone).
 * - the **file tree**: bounded workspace membership. Empty folders and ignored
 *   files change the tree without changing Git status, so it has its own
 *   revision.
 *
 * Neither revision is a content revision. An edit that leaves a file's
 * path, status and line counts unchanged does not advance the file-list
 * revision, and nothing here tells an open editor its buffer is stale. Open
 * editors keep their own load-on-open behaviour; a content invalidation would
 * need a per-path content digest and is deliberately not implied.
 *
 * The per-environment revisions are announced as a keyed view (see
 * `view-sync.ts`): {@link WORKTREE_SNAPSHOT_CHANGED_EVENT} carries one
 * environment's state stamped with the owner `generation` and a contiguous
 * `revision`, and {@link WORKTREE_SNAPSHOT_REVISIONS_COMMAND} returns the
 * authoritative snapshot, conditionally with `knownGeneration`/`knownRevision`.
 * Events are invalidations: they carry revisions, never file lists or trees,
 * which clients re-read with the existing file-list and tree commands.
 *
 * All fields are additive. Legacy backends do not know the command (the
 * client keeps polling) and do not attach {@link WorktreeReadStamp}s.
 */

import {
  hasValidOptionalViewStamp,
  isViewGeneration,
  type ViewGeneration,
  type ViewSnapshotOutcome,
} from "./view-sync.js";

/** Event carrying a {@link WorktreeSnapshotEvent}. */
export const WORKTREE_SNAPSHOT_CHANGED_EVENT = "worktree-snapshot-changed";

/** Snapshot command for the keyed revision view; see the module comment. */
export const WORKTREE_SNAPSHOT_REVISIONS_COMMAND = "get_worktree_snapshot_revisions";

/**
 * - `current`: the last scan succeeded.
 * - `stale`: the last scan failed; the retained file list is the last good one.
 * - `failed`: the last scan failed and no good result exists for this target.
 */
export const WORKTREE_SNAPSHOT_FRESHNESS = ["current", "stale", "failed"] as const;
export type WorktreeSnapshotFreshness = (typeof WORKTREE_SNAPSHOT_FRESHNESS)[number];

/**
 * How current the remote-tracking baseline behind a file list is. Only
 * container targets report it today (the container fetch policy); it is absent
 * for local worktrees and from older backends.
 *
 * - `not-required`: the baseline is an immutable commit present in the clone,
 *   so no fetch can change the comparison.
 * - `current`: the last fetch of the comparison ref succeeded and nothing known
 *   (a merge, an explicit refresh) has invalidated it since.
 * - `stale`: the last fetch failed or was invalidated since. The local diff is
 *   still exact against the refs the clone holds, which may be behind.
 * - `unknown`: no fetch has completed for this clone and ref yet.
 *
 * `lastSuccessAt` (wall clock) lets a client show the age without the backend
 * republishing on a timer. `failure` is a finite, sanitized category.
 */
export const WORKTREE_REMOTE_FRESHNESS_STATES = [
  "not-required",
  "current",
  "stale",
  "unknown",
] as const;
export type WorktreeRemoteFreshnessState = (typeof WORKTREE_REMOTE_FRESHNESS_STATES)[number];

export const WORKTREE_REMOTE_FETCH_FAILURES = [
  "auth",
  "network",
  "missing-ref",
  "no-remote",
  "timeout",
  "unavailable",
  "capacity",
  "error",
] as const;
export type WorktreeRemoteFetchFailure = (typeof WORKTREE_REMOTE_FETCH_FAILURES)[number];

export interface WorktreeRemoteFreshness {
  state: WorktreeRemoteFreshnessState;
  lastSuccessAt?: string;
  failure?: WorktreeRemoteFetchFailure;
}

/** One environment's snapshot revisions. */
export interface WorktreeSnapshotState {
  environmentId: string;
  /**
   * Target lineage within the owner generation. Changes when the environment
   * is retargeted (comparison ref, worktree path or container replaced) or
   * re-tracked; revisions of different target generations are unrelated.
   */
  targetGeneration: number;
  /** The ref the file list is measured against. */
  comparisonRef: string;
  /** Advances on every semantic file-list change; `0` before the first scan. */
  fileListRevision: number;
  /** Advances on every tree membership change the owner observed; `0` before a walk. */
  treeRevision: number;
  freshness: WorktreeSnapshotFreshness;
  /**
   * True when a qualified watcher covers the worktree and its Git metadata,
   * so changes are announced promptly. False for containers and after watcher
   * failure: clients must keep polling for freshness.
   */
  watched: boolean;
  /** Remote-tracking freshness of the comparison base; see {@link WorktreeRemoteFreshness}. */
  remote?: WorktreeRemoteFreshness;
}

export interface WorktreeSnapshotRevisionFields {
  generation?: ViewGeneration;
  revision?: number;
}

export interface WorktreeSnapshotChange
  extends WorktreeSnapshotState, WorktreeSnapshotRevisionFields {}

/** The environment is no longer tracked; drop its revisions. */
export interface WorktreeSnapshotRemoval extends WorktreeSnapshotRevisionFields {
  environmentId: string;
  removed: true;
}

export type WorktreeSnapshotEvent = WorktreeSnapshotChange | WorktreeSnapshotRemoval;

export interface WorktreeSnapshotRevisionsSnapshot extends WorktreeSnapshotRevisionFields {
  entries: WorktreeSnapshotState[];
}

export type WorktreeSnapshotRevisionsOutcome =
  ViewSnapshotOutcome<WorktreeSnapshotRevisionsSnapshot>;

/**
 * Attached as `view` to file-list and tree responses served by a tracked
 * target's read owner. `revision` is the file-list or tree revision of the
 * body in that response. Absent for reads no owner tracks (committed-only
 * lists, untracked worktrees) and from legacy backends.
 */
export interface WorktreeReadStamp {
  generation: ViewGeneration;
  environmentId: string;
  targetGeneration: number;
  revision: number;
  freshness: WorktreeSnapshotFreshness;
  watched: boolean;
}

export function isWorktreeSnapshotFreshness(value: unknown): value is WorktreeSnapshotFreshness {
  return (
    typeof value === "string" && (WORKTREE_SNAPSHOT_FRESHNESS as readonly string[]).includes(value)
  );
}

export function isWorktreeSnapshotState(value: unknown): value is WorktreeSnapshotState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonBlankString(candidate.environmentId) &&
    isPositiveInteger(candidate.targetGeneration) &&
    isNonBlankString(candidate.comparisonRef) &&
    isCount(candidate.fileListRevision) &&
    isCount(candidate.treeRevision) &&
    isWorktreeSnapshotFreshness(candidate.freshness) &&
    typeof candidate.watched === "boolean" &&
    (candidate.remote === undefined || isWorktreeRemoteFreshness(candidate.remote))
  );
}

export function isWorktreeRemoteFreshness(value: unknown): value is WorktreeRemoteFreshness {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.state === "string" &&
    (WORKTREE_REMOTE_FRESHNESS_STATES as readonly string[]).includes(candidate.state) &&
    (candidate.lastSuccessAt === undefined || isNonBlankString(candidate.lastSuccessAt)) &&
    (candidate.failure === undefined ||
      (typeof candidate.failure === "string" &&
        (WORKTREE_REMOTE_FETCH_FAILURES as readonly string[]).includes(candidate.failure)))
  );
}

export function isWorktreeSnapshotChange(value: unknown): value is WorktreeSnapshotChange {
  return (
    isWorktreeSnapshotState(value) &&
    (value as unknown as Record<string, unknown>).removed === undefined &&
    hasValidOptionalViewStamp(value, "event")
  );
}

export function isWorktreeSnapshotRemoval(value: unknown): value is WorktreeSnapshotRemoval {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.removed === true &&
    isNonBlankString(candidate.environmentId) &&
    hasValidOptionalViewStamp(candidate, "event")
  );
}

export function isWorktreeSnapshotEvent(value: unknown): value is WorktreeSnapshotEvent {
  return isWorktreeSnapshotChange(value) || isWorktreeSnapshotRemoval(value);
}

export function isWorktreeSnapshotRevisionsSnapshot(
  value: unknown,
): value is WorktreeSnapshotRevisionsSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const entries = (value as Record<string, unknown>).entries;
  return (
    Array.isArray(entries) &&
    entries.every(isWorktreeSnapshotState) &&
    hasValidOptionalViewStamp(value, "snapshot")
  );
}

export function isWorktreeReadStamp(value: unknown): value is WorktreeReadStamp {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isViewGeneration(candidate.generation) &&
    isNonBlankString(candidate.environmentId) &&
    isPositiveInteger(candidate.targetGeneration) &&
    isCount(candidate.revision) &&
    isWorktreeSnapshotFreshness(candidate.freshness) &&
    typeof candidate.watched === "boolean"
  );
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
