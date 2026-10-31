/**
 * Resetting a workflow's worktree to an earlier commit: the pieces the Build
 * Pipeline's "Rewind code to here" (`build-pipeline-code-rewind.ts`) and a
 * graph run's code rewind (`graph-run-rewind.ts`, item 210) share.
 *
 * - {@link inspectCodeRewind} reads what a reset would drop (the preview) and
 *   refuses a target that is missing or not an ancestor of HEAD;
 * - {@link resetWorktreeToCommit} keeps the old tip at a backup ref under
 *   `refs/orkestrator/`, re-checks HEAD and cleanliness, and resets; a retry
 *   recognises an already-applied reset by its target and matching backup;
 * - {@link codeRewindRefComponent} makes any id a valid ref path component;
 * - {@link readWorktreeForRewind} reads HEAD and the uncommitted paths;
 * - {@link withWorkspaceCodeRewindReservation} holds the environment's
 *   exclusive mutation fence while a journaled reset commits, and
 *   {@link assertNoOtherWorkflowWriting} refuses while another pipeline or
 *   graph run may still write to the worktree.
 *
 * Callers journal the intent (with the upstream facts a later push needs)
 * before the reset, so a crash in between is finished, not lost.
 */
import {
  MAX_CODE_REWIND_COMMIT_SUBJECT_LENGTH,
  MAX_CODE_REWIND_PREVIEW_COMMITS,
  isActiveBuildPhase,
  isBuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import { isGraphRunTerminal } from "@orkestrator/protocol/graphs/run";
import type { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import { retryGitWithoutFsmonitorOnTimeout } from "./git-fsmonitor.js";
import type { Environment, PersistedBuildPipeline } from "./models.js";
import type { GraphRunsStorage } from "./storage-graph-runs.js";

/** Runs `git` with `args` in the environment's worktree and returns stdout. */
export type EnvironmentGit = (environmentId: string, args: string[]) => Promise<string>;

/**
 * `git status --porcelain --untracked-files=all` in the environment's worktree,
 * retried once without the fsmonitor daemon after a timeout.
 */
export function readWorktreeStatus(git: EnvironmentGit, environmentId: string): Promise<string> {
  return retryGitWithoutFsmonitorOnTimeout(
    ["status", "--porcelain", "--untracked-files=all"],
    (args) => git(environmentId, args),
  );
}

const COMMIT_ID = /^[0-9a-f]{40,64}$/i;

/** `value` as one valid ref path component (at most 80 characters), or `fallback`. */
export function codeRewindRefComponent(value: string, fallback: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 80) || fallback
  );
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
  if ((await readWorktreeStatus(git, environmentId)).trim()) {
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
  if ((await readWorktreeStatus(git, environmentId)).trim()) {
    throw new Error("The worktree has uncommitted changes. Commit or discard them first.");
  }
  await git(environmentId, ["reset", "--hard", reset.to]);
}

/** HEAD and the uncommitted paths (at most `maxPaths`) of the environment's worktree. */
export async function readWorktreeForRewind(
  git: EnvironmentGit,
  environmentId: string,
  maxPaths: number,
): Promise<{ head: string; paths: string[]; dirty: boolean }> {
  const head = (await git(environmentId, ["rev-parse", "HEAD"])).trim();
  const status = await readWorktreeStatus(git, environmentId);
  const lines = status.split("\n").filter((line) => line.trim().length > 0);
  return {
    head,
    dirty: lines.length > 0,
    // `XY path` (a rename: `XY old -> new`); the path is evidence, never content.
    paths: lines.slice(0, maxPaths).map((line) => line.slice(3).trim().slice(0, 512)),
  };
}

/**
 * Runs a journaled reset under the environment's exclusive mutation fence:
 * no file write, worker start or agent submission reaches the worktree, and a
 * move or replacement cannot start, until `run` settles. `assertQuiet`
 * refuses (throws) when another workflow may still write to the worktree.
 */
export async function withWorkspaceCodeRewindReservation<T>(input: {
  fence: Pick<EnvironmentMutationFence, "withExclusiveMutation" | "bindMovePaths">;
  storage: { getEnvironment(id: string): Promise<Environment | null> };
  environmentId: string;
  assertQuiet: () => Promise<void>;
  run: () => Promise<T>;
}): Promise<T> {
  const { fence, environmentId } = input;
  return fence.withExclusiveMutation(environmentId, [], async () => {
    // Resolve the path only after moves/replacements are excluded. A write
    // already in flight on that path makes binding refuse the reservation.
    const environment = await input.storage.getEnvironment(environmentId);
    if (!environment) throw new Error("Environment not found");
    fence.bindMovePaths(environmentId, environment.worktreePath ? [environment.worktreePath] : []);
    await input.assertQuiet();
    return input.run();
  });
}

const ADMITTED_GRAPH_STATES = new Set(["admitting", "running", "awaiting-human"]);

/**
 * Throws when a build pipeline or graph run other than `self` may still
 * write to the environment's worktree: a pipeline in an active phase or with
 * a running session, or a graph run that is not finished and has an
 * admitted activation. Storage without graph runs checks pipelines only.
 */
export async function assertNoOtherWorkflowWriting(
  storage: {
    listAllBuildPipelines(): Promise<PersistedBuildPipeline[]>;
    graphRuns?: Pick<GraphRunsStorage, "listGraphRuns">;
  },
  environmentId: string,
  self: { pipelineId?: string; graphRunId?: string },
): Promise<void> {
  for (const record of await storage.listAllBuildPipelines()) {
    const sibling = record.snapshot;
    if (
      record.id !== self.pipelineId &&
      isBuildPipeline(sibling) &&
      sibling.environmentId === environmentId &&
      (isActiveBuildPhase(sibling.phase) ||
        sibling.sessions.some((session) => session.status === "running"))
    ) {
      throw new Error(
        "Another pipeline may write to this environment. Pause it before rewinding code.",
      );
    }
  }
  for (const run of (await storage.graphRuns?.listGraphRuns(environmentId)) ?? []) {
    if (
      run.id !== self.graphRunId &&
      !isGraphRunTerminal(run.status) &&
      run.activations.some((activation) => ADMITTED_GRAPH_STATES.has(activation.state))
    ) {
      throw new Error(
        "A graph run may write to this environment. Pause it and let its running nodes stop before rewinding code.",
      );
    }
  }
}
