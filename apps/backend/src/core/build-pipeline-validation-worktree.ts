/**
 * What a validation turn did to the environment worktree, judged against the
 * baseline recorded when the turn started.
 *
 * Two callers need the same answer for different audiences. The supervisor
 * certifies the stage after the turn and turns a change into the pipeline's
 * error, which a person reads. The workflow result service asks before it
 * accepts the stage's result, while the model can still put the worktree back,
 * and turns a change into a correctable tool error.
 */
import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import type { WorkflowResultError } from "@orkestrator/protocol/workflow-results";
import type { ReviewWorktreeSnapshot } from "./build-pipeline-prompts.js";

export type ValidationWorktreeChange =
  | { kind: "unchanged" }
  /** The turn's starting state was never recorded, so nothing can be compared. */
  | { kind: "unrecorded" }
  /** The current state could not be observed. */
  | { kind: "unknown"; reason: string }
  | { kind: "head"; before: string; after: string }
  | { kind: "added"; paths: string[] }
  | { kind: "removed"; paths: string[] };

type ValidationBaseline = Pick<
  PipelineSession,
  "validationHeadAtStart" | "validationWorktreeStatusAtStart" | "validationUncommittedPathsAtStart"
>;

/**
 * The HEAD and path set a validation turn started from, or null when they
 * were not recorded.
 */
function baselineOf(session: ValidationBaseline): { head: string; paths: string[] } | null {
  // A snapshot written before the path list existed still carries a status, and
  // "clean" pins the baseline to the empty set without it. "dirty" does not,
  // so that one case still fails closed rather than guessing.
  const paths =
    session.validationUncommittedPathsAtStart ??
    (session.validationWorktreeStatusAtStart === "clean" ? [] : undefined);
  return session.validationHeadAtStart && paths
    ? { head: session.validationHeadAtStart, paths }
    : null;
}

/** Whether there is anything to compare, so a caller can skip the probe. */
export function hasValidationBaseline(session: ValidationBaseline): boolean {
  return baselineOf(session) !== null;
}

/**
 * Scope is exactly what `git status --porcelain` reports plus HEAD: tracked
 * paths, and untracked paths Git does not ignore. It deliberately does *not*
 * cover ignored files, anything under `.git/`, or paths outside the worktree —
 * writes there are invisible to this check, so the disclosure the launcher
 * shows and the prompts' own instructions have to claim no more than this.
 *
 * The comparison is against the baseline path set, not against cleanliness, so
 * uncommitted work the build stage left behind survives review instead of
 * failing the pipeline after the fact.
 */
export function compareValidationWorktree(
  session: ValidationBaseline,
  current: ReviewWorktreeSnapshot,
): ValidationWorktreeChange {
  const baseline = baselineOf(session);
  if (!baseline) return { kind: "unrecorded" };
  if (current.status === "unknown") return { kind: "unknown", reason: current.reason };
  if (current.head !== baseline.head) {
    return { kind: "head", before: baseline.head, after: current.head };
  }
  const baselinePaths = baseline.paths;
  const before = new Set(baselinePaths);
  const currentPaths = current.status === "dirty" ? current.paths : [];
  const after = new Set(currentPaths);
  const added = currentPaths.filter((path) => !before.has(path));
  if (added.length) return { kind: "added", paths: added };
  // Removal matters as much as addition: deleting a path the build stage left
  // uncommitted destroys work that no commit is holding.
  const removed = baselinePaths.filter((path) => !after.has(path));
  if (removed.length) return { kind: "removed", paths: removed };
  return { kind: "unchanged" };
}

/** Paths named in the pipeline error, which is a one-line header banner. */
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

/**
 * The pipeline error for a change, or null when the stage can be certified.
 * Names the paths: a count alone sends the user hunting through the worktree
 * for files a symlink or tool left behind.
 */
export function validationWorktreeError(
  stage: string,
  change: ValidationWorktreeChange,
): string | null {
  switch (change.kind) {
    case "unchanged":
      return null;
    case "unrecorded":
      return `${stage} cannot be certified because its starting Git state was not recorded`;
    case "unknown":
      return `${stage} cannot be certified because the backend could not verify Git state after validation: ${change.reason}`;
    case "head":
      return `${stage} cannot be certified because validation changed the environment HEAD`;
    case "added":
      return `${stage} cannot be certified because validation left ${pathCount(change.paths.length, "path that was", "paths that were")} not there when it started: ${inlinePaths(change.paths)}`;
    case "removed":
      return `${stage} cannot be certified because validation removed ${pathCount(change.paths.length, "path that was", "paths that were")} there when it started: ${inlinePaths(change.paths)}`;
  }
}

/**
 * The tool error that lets the model repair a change before its result is
 * accepted, or null to let the result through.
 *
 * States the backend cannot judge (no baseline, a failed probe) are not
 * refused here: the model cannot fix them, and the supervisor still decides
 * them when it reads the result.
 */
export function validationWorktreeRefusal(
  change: ValidationWorktreeChange,
): WorkflowResultError | null {
  const retry =
    "Then validate and submit your result again. Do not commit, stash, reset or delete the build's own uncommitted work to make the tree look clean.";
  switch (change.kind) {
    case "unchanged":
    case "unrecorded":
    case "unknown":
      return null;
    case "head":
      return {
        code: "worktree_changed",
        nextAction: "correct",
        message: `This checkout's HEAD moved from \`${change.before}\` to \`${change.after}\` during validation, so the result cannot be accepted. Validation must not commit, check out or reset. Put HEAD back on \`${change.before}\` without discarding any work. ${retry}`,
      };
    case "added":
      return {
        code: "worktree_changed",
        nextAction: "correct",
        message: `Validation left ${pathCount(change.paths.length, "path", "paths")} in this checkout that ${change.paths.length === 1 ? "was" : "were"} not there when the stage started, so the result cannot be accepted:\n${listedPaths(change.paths)}\nRemove what validation created, including anything written through a symlink that resolves into this checkout, until \`git status --porcelain --untracked-files=all\` no longer lists ${change.paths.length === 1 ? "it" : "them"}. ${retry}`,
      };
    case "removed":
      return {
        code: "worktree_changed",
        nextAction: "correct",
        message: `Validation removed ${pathCount(change.paths.length, "path", "paths")} that ${change.paths.length === 1 ? "was" : "were"} in this checkout when the stage started, so the result cannot be accepted:\n${listedPaths(change.paths)}\nRestore ${change.paths.length === 1 ? "it" : "them"} exactly as ${change.paths.length === 1 ? "it was" : "they were"}. ${retry} If you cannot restore ${change.paths.length === 1 ? "it" : "them"}, say so in your final message.`,
      };
  }
}
