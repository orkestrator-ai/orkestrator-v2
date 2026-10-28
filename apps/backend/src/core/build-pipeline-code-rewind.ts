/**
 * "Rewind code to here": resets a build pipeline's worktree to the commit a
 * step started from, then restarts the pipeline from that step.
 *
 * A plain restart keeps the code. This is the separate, explicit action: the
 * renderer first reads a preview naming every commit the reset drops, and the
 * confirmed request carries the HEAD that preview saw, so a branch that moved
 * in between is refused rather than reset blind.
 *
 * Safety rules, all enforced here rather than in the renderer:
 * - the pipeline must not be running a step (pause it first), so no agent or
 *   validation command writes to the worktree during the reset;
 * - the worktree must have no uncommitted changes, because a hard reset would
 *   destroy them and nothing could bring them back;
 * - the target must be an ancestor of HEAD;
 * - the old tip is kept at a ref under `refs/orkestrator/`, so the dropped
 *   commits stay recoverable;
 * - when the upstream branch already has commits the reset drops, the next
 *   Ship is told to force-push with lease instead of a plain push.
 */
import {
  MAX_CODE_REWIND_COMMIT_SUBJECT_LENGTH,
  MAX_CODE_REWIND_PREVIEW_COMMITS,
  isActiveBuildPhase,
  isSupersededPipelineSession,
  type BuildPipeline,
  type PipelineCodeRewind,
  type PipelineSession,
} from "@orkestrator/protocol/build-pipeline";

/** Runs `git` with `args` in the environment's worktree and returns stdout. */
export type EnvironmentGit = (environmentId: string, args: string[]) => Promise<string>;

const COMMIT_ID = /^[0-9a-f]{40,64}$/i;

/**
 * Why the pipeline's state forbids a code rewind to `session` right now, or
 * undefined when it allows one. The worktree itself is checked separately.
 */
export function codeRewindStateBlocker(
  pipeline: Pick<BuildPipeline, "phase" | "validationRun" | "sessions">,
  session: Pick<PipelineSession, "headAtStart">,
): string | undefined {
  if (!session.headAtStart) {
    return "This step's starting commit was not recorded, so its code cannot be rewound.";
  }
  if (isActiveBuildPhase(pipeline.phase)) {
    return "Pause the pipeline first: a running step could write to the worktree during the reset.";
  }
  if (pipeline.sessions.some((entry) => entry.status === "running")) {
    return "Stopping every agent must be confirmed before rewinding code.";
  }
  if (
    pipeline.validationRun &&
    (pipeline.validationRun.status === "planned" || pipeline.validationRun.status === "running")
  ) {
    return "Validation checks are still running. Pause the pipeline first.";
  }
  return undefined;
}

/** The ref that keeps the pre-rewind tip reachable. */
export function codeRewindBackupRef(pipelineId: string, rewindId: string): string {
  const component = (value: string) =>
    value
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 80) || "pipeline";
  return `refs/orkestrator/build-pipeline-rewinds/${component(pipelineId)}/${component(rewindId)}`;
}

export interface CodeRewindInspection {
  commits: { sha: string; subject: string }[];
  commitCount: number;
  upstream?: { ref: string; droppedCommits: number };
}

function count(output: string): number {
  const value = Number.parseInt(output.trim(), 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Git returned an unusable commit count.");
  }
  return value;
}

/**
 * Reads what resetting HEAD to `target` would drop. Throws an error written
 * for the user when the target is missing or not an ancestor of HEAD.
 */
export async function inspectCodeRewind(
  git: EnvironmentGit,
  environmentId: string,
  target: string,
): Promise<CodeRewindInspection> {
  if (!COMMIT_ID.test(target)) {
    throw new Error("This step's recorded starting commit is not a commit ID.");
  }
  let aheadOutput: string;
  try {
    aheadOutput = await git(environmentId, ["rev-list", "--count", `HEAD..${target}`]);
  } catch {
    throw new Error(
      `The commit this step started from (${target.slice(0, 12)}) is no longer in the repository.`,
    );
  }
  const ahead = count(aheadOutput);
  if (ahead > 0) {
    throw new Error(
      `The branch no longer contains the commit this step started from (${target.slice(0, 12)}); its history was rewritten.`,
    );
  }
  const commitCount = count(await git(environmentId, ["rev-list", "--count", `${target}..HEAD`]));
  const log = await git(environmentId, [
    "log",
    "--no-color",
    `--max-count=${MAX_CODE_REWIND_PREVIEW_COMMITS}`,
    "--format=%H%x1f%s",
    `${target}..HEAD`,
  ]);
  const commits = log
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = "", ...subject] = line.split("\u001f");
      const text = subject.join(" ").trim();
      return {
        sha,
        subject:
          text.length <= MAX_CODE_REWIND_COMMIT_SUBJECT_LENGTH
            ? text
            : `${text.slice(0, MAX_CODE_REWIND_COMMIT_SUBJECT_LENGTH - 1)}…`,
      };
    })
    .filter((commit) => COMMIT_ID.test(commit.sha));
  let upstream: CodeRewindInspection["upstream"];
  let ref: string | undefined;
  try {
    ref = (
      await git(environmentId, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    ).trim();
  } catch {
    // No upstream: nothing was pushed from this branch, or it was never set.
  }
  if (ref) {
    upstream = {
      ref: ref.slice(0, 256),
      droppedCommits: count(
        await git(environmentId, ["rev-list", "--count", `${target}..@{upstream}`]),
      ),
    };
  }
  return { commits, commitCount, ...(upstream ? { upstream } : {}) };
}

/**
 * Keeps `from` reachable at `backupRef`, then moves the branch and worktree to
 * `to` after verifying HEAD and cleanliness through the reset runner. The caller
 * holds the environment reservation and has durably saved this intent. A retry
 * recognizes the already-applied reset by its target and matching backup.
 */
export async function resetWorktreeToCommit(
  git: EnvironmentGit,
  environmentId: string,
  reset: { from: string; to: string; backupRef: string },
): Promise<void> {
  const head = (await git(environmentId, ["rev-parse", "HEAD"])).trim();
  if ((await git(environmentId, ["status", "--porcelain", "--untracked-files=all"])).trim()) {
    throw new Error("The worktree has uncommitted changes. Commit or discard them first.");
  }
  if (head === reset.to && head !== reset.from) {
    // A crash after reset but before the final save: prove this intent's backup.
    const backup = (await git(environmentId, ["rev-parse", reset.backupRef])).trim();
    if (backup !== reset.from) throw new Error("The pending rewind's backup does not match.");
    return;
  }
  if (head !== reset.from) {
    throw new Error(
      "The branch moved since the rewind was previewed. Review the commits it drops again.",
    );
  }
  // Creating a new ref is idempotent, but never replace an unrelated backup.
  let backup: string | undefined;
  try {
    backup = (await git(environmentId, ["rev-parse", reset.backupRef])).trim();
  } catch {
    /* Not created yet. */
  }
  if (backup && backup !== reset.from)
    throw new Error("The pending rewind's backup does not match.");
  if (!backup) await git(environmentId, ["update-ref", reset.backupRef, head, ""]);
  // Refuse a writer that changed HEAD or files during backup creation as well.
  if ((await git(environmentId, ["rev-parse", "HEAD"])).trim() !== head) {
    throw new Error("The branch moved since the rewind was previewed.");
  }
  if ((await git(environmentId, ["status", "--porcelain", "--untracked-files=all"])).trim()) {
    throw new Error("The worktree has uncommitted changes. Commit or discard them first.");
  }
  await git(environmentId, ["reset", "--hard", reset.to]);
}

/**
 * The upstream a Ship must force-push to, when the newest code rewind dropped
 * commits the upstream already had and no live Ship has completed since.
 */
export function forcePushUpstream(
  pipeline: Pick<BuildPipeline, "rewinds" | "sessions">,
): string | undefined {
  const rewind = (pipeline.rewinds ?? []).findLast((entry) => entry.code !== undefined);
  const code = rewind?.code;
  if (!rewind || !code?.upstream || !code.upstreamCommitsDropped) return undefined;
  const shippedSince = pipeline.sessions.some(
    (session) =>
      session.phase === "pr" &&
      !isSupersededPipelineSession(session) &&
      session.status === "idle" &&
      session.skipped !== true &&
      Date.parse(session.startedAt) >= Date.parse(rewind.at),
  );
  return shippedSince ? undefined : code.upstream;
}

/** Builds reset metadata to journal before changing Git. */
export function codeRewindRecord(
  reset: { from: string; to: string; backupRef: string },
  inspection: CodeRewindInspection,
): PipelineCodeRewind {
  return {
    from: reset.from,
    to: reset.to,
    droppedCommits: inspection.commitCount,
    backupRef: reset.backupRef,
    ...(inspection.upstream
      ? {
          upstream: inspection.upstream.ref,
          upstreamCommitsDropped: inspection.upstream.droppedCommits,
        }
      : {}),
  };
}
