/**
 * The persisted starting point of a read-only workspace guard.
 *
 * A turn that must not change the workspace (a reviewer, a consolidator, a
 * graph node with read or no workspace access) records what Git could see
 * before it was dispatched: HEAD and the set of uncommitted paths `git status`
 * reports. The backend compares the live worktree with it when the turn
 * submits its result and again when the workflow consumes that result
 * (`apps/backend/src/core/workspace-read-only-guard.ts`).
 *
 * The record is storage-shaped and bounded so a workflow snapshot that carries
 * it stays valid and small. Scope is exactly Git's: ignored files, `.git/`
 * internals and paths outside the worktree are not part of it, so no caller
 * may describe a passing guard as proof the workspace was untouched.
 */

/** Paths a baseline may name. A larger uncommitted set cannot be guarded. */
export const WORKSPACE_GIT_BASELINE_MAX_PATHS = 10_000;
/** Characters in one path, matching the review snapshot bound. */
export const WORKSPACE_GIT_BASELINE_MAX_PATH_CHARS = 4_096;

export interface WorkspaceGitBaseline {
  /** Full commit SHA the worktree was on. */
  head: string;
  /** Git-visible uncommitted paths (tracked changes, untracked not ignored). */
  paths: string[];
  /** When the baseline was observed, ISO 8601. */
  capturedAt: string;
}

export function isWorkspaceGitBaseline(value: unknown): value is WorkspaceGitBaseline {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => key === "head" || key === "paths" || key === "capturedAt") &&
    typeof record.head === "string" &&
    /^[0-9a-f]{40,64}$/i.test(record.head) &&
    Array.isArray(record.paths) &&
    record.paths.length <= WORKSPACE_GIT_BASELINE_MAX_PATHS &&
    record.paths.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= WORKSPACE_GIT_BASELINE_MAX_PATH_CHARS,
    ) &&
    // `Date.parse` coerces, so the string check cannot be left to the cast.
    typeof record.capturedAt === "string" &&
    Number.isFinite(Date.parse(record.capturedAt))
  );
}
