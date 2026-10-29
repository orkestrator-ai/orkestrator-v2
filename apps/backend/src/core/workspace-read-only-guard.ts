/**
 * A post-hoc guard for agent turns that must not change the workspace.
 *
 * Provider sandboxes enforce read-only access unevenly: Claude and Codex
 * enforce it, OpenCode and Cursor only configure it, Grok treats it as advice.
 * This guard is the backstop that works the same on every provider and on
 * local worktrees and containers alike, because it observes the environment
 * through the backend's own `get_environment_uncommitted_paths` command:
 *
 * 1. **Before dispatch**, {@link WorkspaceReadOnlyGuard.capture} records HEAD
 *    and the Git-visible uncommitted paths. A state it cannot observe throws
 *    {@link WorkspaceBaselineUnavailableError}: a turn that can never be
 *    certified is not worth dispatching, so the guard fails closed.
 * 2. **At submit time**, an acceptance check built by
 *    {@link readOnlyAcceptanceCheck} compares the live worktree with the
 *    baseline and hands the model a correctable `worktree_changed` error, so it
 *    can put the tree back within its own turn.
 * 3. **When the result is consumed**, {@link WorkspaceReadOnlyGuard.certify}
 *    compares again and throws {@link WorkspaceReadOnlyViolationError}. The
 *    owner fails the turn. Nothing is reset: the worktree and the change it
 *    names are the evidence.
 *
 * Guards detect; they do not prevent. Scope is exactly what `git status
 * --porcelain` reports plus HEAD: tracked paths and untracked paths Git does
 * not ignore. Ignored files, `.git/` internals and paths outside the worktree
 * are invisible here, and so is an edit to a path that was already
 * uncommitted when the baseline was taken. Callers must not claim more.
 *
 * The comparison is against the baseline path set, not against cleanliness, so
 * uncommitted work an earlier stage left behind survives the guarded turn
 * instead of failing it.
 */
import {
  WORKSPACE_GIT_BASELINE_MAX_PATHS,
  WORKSPACE_GIT_BASELINE_MAX_PATH_CHARS,
  type WorkspaceGitBaseline,
} from "@orkestrator/protocol/workspace-guard";
import type { WorkflowResultError } from "@orkestrator/protocol/workflow-results";
import type { ObservedWorktreeSnapshot, ReviewWorktreeSnapshot } from "./build-pipeline-prompts.js";
import { probeReviewWorktree, type ReviewWorktreeProbeInvoker } from "./review-worktree-probe.js";
import type {
  WorkflowResultAcceptanceCheck,
  WorkflowResultAttempt,
} from "./workflow-result-service.js";

/** Observes one environment's worktree. Retries, if any, are the probe's own. */
export type WorkspaceSnapshotProbe = (environmentId: string) => Promise<ReviewWorktreeSnapshot>;

/**
 * The default probe: the backend command every environment kind answers, with
 * the bounded immediate retries `probeReviewWorktree` applies.
 */
export function commandWorkspaceProbe(
  invoke: ReviewWorktreeProbeInvoker,
  attempts?: number,
): WorkspaceSnapshotProbe {
  return (environmentId) => probeReviewWorktree(invoke, environmentId, attempts);
}

/** The part of a baseline the comparison reads; a persisted record has more. */
export type WorkspaceBaselineState = Pick<WorkspaceGitBaseline, "head" | "paths">;

export type WorkspaceChange =
  | { kind: "unchanged" }
  /** The turn's starting state was never recorded, so nothing can be compared. */
  | { kind: "unrecorded" }
  /** The current state could not be observed. */
  | { kind: "unknown"; reason: string }
  | { kind: "head"; before: string; after: string }
  | { kind: "added"; paths: string[] }
  | { kind: "removed"; paths: string[] };

/** Names the guarded turn in the text a person or the model reads. */
export interface ReadOnlyGuardSubject {
  /** Capitalised stage name for a person-facing error: "Review", "Verification". */
  stage: string;
  /** What the turn was doing, in running text: "review", "validation". */
  activity: string;
}

/** The workspace could not be observed before dispatch. The turn must not run. */
export class WorkspaceBaselineUnavailableError extends Error {
  constructor(
    readonly subject: ReadOnlyGuardSubject,
    readonly reason: string,
  ) {
    super(
      `${subject.stage} cannot start because the backend could not establish the environment Git state: ${reason}`,
    );
    this.name = "WorkspaceBaselineUnavailableError";
  }
}

/** A guarded turn changed what Git can see, or its state could not be judged. */
export class WorkspaceReadOnlyViolationError extends Error {
  constructor(
    readonly subject: ReadOnlyGuardSubject,
    readonly change: Exclude<WorkspaceChange, { kind: "unchanged" }>,
  ) {
    super(readOnlyViolationMessage(subject, change) ?? `${subject.stage} cannot be certified`);
    this.name = "WorkspaceReadOnlyViolationError";
  }
}

/**
 * The persisted baseline for an observed snapshot. Throws when the uncommitted
 * set is too large to record, which the caller treats like an unobservable
 * state: fail before dispatch.
 */
export function workspaceBaselineFromSnapshot(
  subject: ReadOnlyGuardSubject,
  snapshot: ObservedWorktreeSnapshot,
  capturedAt: string = new Date().toISOString(),
): WorkspaceGitBaseline {
  const paths = snapshot.status === "dirty" ? [...snapshot.paths] : [];
  if (paths.length > WORKSPACE_GIT_BASELINE_MAX_PATHS) {
    throw new WorkspaceBaselineUnavailableError(
      subject,
      `more than ${WORKSPACE_GIT_BASELINE_MAX_PATHS} uncommitted paths`,
    );
  }
  if (
    paths.some((path) => path.length === 0 || path.length > WORKSPACE_GIT_BASELINE_MAX_PATH_CHARS)
  ) {
    throw new WorkspaceBaselineUnavailableError(
      subject,
      "an uncommitted path is too long to record",
    );
  }
  return { head: snapshot.head, paths, capturedAt };
}

/** Compares the live worktree with a baseline. A null baseline is `unrecorded`. */
export function compareWorkspace(
  baseline: WorkspaceBaselineState | null,
  current: ReviewWorktreeSnapshot,
): WorkspaceChange {
  if (!baseline) return { kind: "unrecorded" };
  if (current.status === "unknown") return { kind: "unknown", reason: current.reason };
  if (current.head !== baseline.head) {
    return { kind: "head", before: baseline.head, after: current.head };
  }
  const before = new Set(baseline.paths);
  const currentPaths = current.status === "dirty" ? current.paths : [];
  const after = new Set(currentPaths);
  const added = currentPaths.filter((path) => !before.has(path));
  if (added.length) return { kind: "added", paths: added };
  // Removal matters as much as addition: deleting a path an earlier stage left
  // uncommitted destroys work that no commit is holding.
  const removed = baseline.paths.filter((path) => !after.has(path));
  if (removed.length) return { kind: "removed", paths: removed };
  return { kind: "unchanged" };
}

/** Paths named in a person-facing error, which is a one-line header banner. */
const MAX_ERROR_PATHS = 5;
/** Paths named to the model, enough to clean up every ordinary mistake. */
const MAX_REFUSAL_PATHS = 50;

function pathCount(count: number, singular: string, plural: string): string {
  return `${count} uncommitted ${count === 1 ? singular : plural}`;
}

function inlinePaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_ERROR_PATHS);
  const omitted = paths.length - shown.length;
  return `${shown.join(", ")}${omitted > 0 ? ` and ${omitted} more` : ""}`;
}

/**
 * Path text comes from the repository, so it is untrusted: fence it as code
 * rather than letting a crafted filename render as prompt markup.
 */
function listedPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_REFUSAL_PATHS);
  const omitted = paths.length - shown.length;
  return [
    ...shown.map((path) => `- \`${path.replaceAll("`", "'")}\``),
    ...(omitted > 0 ? [`- …and ${omitted} more.`] : []),
  ].join("\n");
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The person-facing error for a change, or null when the turn can be
 * certified. Names the paths: a count alone sends the user hunting through the
 * worktree for files a symlink or tool left behind.
 */
export function readOnlyViolationMessage(
  subject: ReadOnlyGuardSubject,
  change: WorkspaceChange,
): string | null {
  const { stage, activity } = subject;
  switch (change.kind) {
    case "unchanged":
      return null;
    case "unrecorded":
      return `${stage} cannot be certified because its starting Git state was not recorded`;
    case "unknown":
      return `${stage} cannot be certified because the backend could not verify Git state after ${activity}: ${change.reason}`;
    case "head":
      return `${stage} cannot be certified because ${activity} changed the environment HEAD`;
    case "added":
      return `${stage} cannot be certified because ${activity} left ${pathCount(change.paths.length, "path that was", "paths that were")} not there when it started: ${inlinePaths(change.paths)}`;
    case "removed":
      return `${stage} cannot be certified because ${activity} removed ${pathCount(change.paths.length, "path that was", "paths that were")} there when it started: ${inlinePaths(change.paths)}`;
  }
}

/**
 * The tool error that lets the model repair a change before its result is
 * accepted, or null to let the result through.
 *
 * States the backend cannot judge (no baseline, a failed probe) are not
 * refused here: the model cannot fix them, and the owner still decides them
 * when it consumes the result.
 */
export function readOnlyViolationRefusal(
  subject: ReadOnlyGuardSubject,
  change: WorkspaceChange,
): WorkflowResultError | null {
  const { activity } = subject;
  const retry = `Then submit your result again. Do not commit, stash, reset or delete the uncommitted work that was already there to make the tree look clean.`;
  switch (change.kind) {
    case "unchanged":
    case "unrecorded":
    case "unknown":
      return null;
    case "head":
      return {
        code: "worktree_changed",
        nextAction: "correct",
        message: `This checkout's HEAD moved from \`${change.before}\` to \`${change.after}\` during ${activity}, so the result cannot be accepted. ${capitalised(activity)} must not commit, check out or reset. Put HEAD back on \`${change.before}\` without discarding any work. ${retry}`,
      };
    case "added":
      return {
        code: "worktree_changed",
        nextAction: "correct",
        message: `${capitalised(activity)} left ${pathCount(change.paths.length, "path", "paths")} in this checkout that ${change.paths.length === 1 ? "was" : "were"} not there when it started, so the result cannot be accepted:\n${listedPaths(change.paths)}\nRemove what ${activity} created, including anything written through a symlink that resolves into this checkout, until \`git status --porcelain --untracked-files=all\` no longer lists ${change.paths.length === 1 ? "it" : "them"}. ${retry}`,
      };
    case "removed":
      return {
        code: "worktree_changed",
        nextAction: "correct",
        message: `${capitalised(activity)} removed ${pathCount(change.paths.length, "path", "paths")} that ${change.paths.length === 1 ? "was" : "were"} in this checkout when it started, so the result cannot be accepted:\n${listedPaths(change.paths)}\nRestore ${change.paths.length === 1 ? "it" : "them"} exactly as ${change.paths.length === 1 ? "it was" : "they were"}. ${retry} If you cannot restore ${change.paths.length === 1 ? "it" : "them"}, say so in your final message.`,
      };
  }
}

/** The three moments of a guarded turn, over one probe. */
export class WorkspaceReadOnlyGuard {
  constructor(private readonly probe: WorkspaceSnapshotProbe) {}

  /**
   * Before dispatch: the baseline to persist with the turn, and the snapshot
   * it came from (a prompt may quote it). Throws
   * {@link WorkspaceBaselineUnavailableError} when the state is unobservable.
   */
  async capture(
    environmentId: string,
    subject: ReadOnlyGuardSubject,
  ): Promise<{ baseline: WorkspaceGitBaseline; snapshot: ObservedWorktreeSnapshot }> {
    const snapshot = await this.probe(environmentId);
    if (snapshot.status === "unknown") {
      throw new WorkspaceBaselineUnavailableError(subject, snapshot.reason);
    }
    return { baseline: workspaceBaselineFromSnapshot(subject, snapshot), snapshot };
  }

  /** The live change against a baseline. No probe is spent without one. */
  async compare(
    environmentId: string,
    baseline: WorkspaceBaselineState | null,
  ): Promise<WorkspaceChange> {
    if (!baseline) return { kind: "unrecorded" };
    return compareWorkspace(baseline, await this.probe(environmentId));
  }

  /** At submit time: the correctable refusal, or null to accept. */
  async refusal(
    environmentId: string,
    baseline: WorkspaceBaselineState | null,
    subject: ReadOnlyGuardSubject,
  ): Promise<WorkflowResultError | null> {
    if (!baseline) return null;
    return readOnlyViolationRefusal(subject, await this.compare(environmentId, baseline));
  }

  /**
   * When the result is consumed: throws {@link WorkspaceReadOnlyViolationError}
   * unless the worktree still matches. `repairableOnly` throws only for a
   * change the model could have repaired (HEAD, added or removed paths), so an
   * owner explaining a missing result does not replace its own error with an
   * unavailable comparison.
   */
  async certify(
    environmentId: string,
    baseline: WorkspaceBaselineState | null,
    subject: ReadOnlyGuardSubject,
    options: { repairableOnly?: boolean } = {},
  ): Promise<void> {
    const change = await this.compare(environmentId, baseline);
    if (change.kind === "unchanged") return;
    if (options.repairableOnly && !readOnlyViolationRefusal(subject, change)) return;
    throw new WorkspaceReadOnlyViolationError(subject, change);
  }
}

/** A guarded turn an owner recognises as its own. */
export interface ReadOnlyGuardedAttempt {
  environmentId: string;
  /** Null for a turn recorded before the guard existed: nothing to refuse. */
  baseline: WorkspaceBaselineState | null;
  subject: ReadOnlyGuardSubject;
}

/**
 * An acceptance check for `WorkflowResultService.addAcceptanceCheck`.
 *
 * `resolve` maps an attempt to the guarded turn the owner is waiting on, or
 * null for an attempt it does not own (another workflow's, a stale key, a
 * turn that is not guarded). Several owners may register checks for the same
 * result kind; each one skips what it does not own.
 */
export function readOnlyAcceptanceCheck(
  guard: WorkspaceReadOnlyGuard,
  resolve: (attempt: WorkflowResultAttempt) => Promise<ReadOnlyGuardedAttempt | null>,
): WorkflowResultAcceptanceCheck {
  return async (attempt) => {
    const owned = await resolve(attempt);
    if (!owned) return null;
    return guard.refusal(owned.environmentId, owned.baseline, owned.subject);
  };
}
