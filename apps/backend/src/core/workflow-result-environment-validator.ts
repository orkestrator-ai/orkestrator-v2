/**
 * Git-backed environment checks for graph output values (plan P1.3, report
 * §5.3): the parts of the built-in `workspace-commit` and `file-list-paths`
 * validators that need the environment's repository.
 *
 * - `workspace@1`: `headRef` exists and is reachable from `branch`
 *   (`refs/heads/<branch>`), and `baseRef`, when set, exists and is an
 *   ancestor of `headRef`.
 * - `file-list@1`: every path resolves inside the worktree, which means Git
 *   accepts it as a pathspec there: it does not lead through a symbolic link.
 *   The path need not exist (a fix may list the files it deleted); the pure
 *   check has already refused absolute paths, `..` and backslashes.
 *
 * Every command runs through the backend's own environment Git port
 * (`createPipelineEnvironmentGit`), so local worktrees and containers behave
 * the same. Reads only. A repository that cannot be read at all throws, which
 * the service turns into a refusal that spends no correction (fail closed).
 * Issues carry paths and codes, never file contents.
 */
import type { WorkflowResultValidationIssue } from "@orkestrator/protocol/workflow-results";
import type { EnvironmentGit } from "./build-pipeline-code-rewind.js";
import type {
  WorkflowResultEnvironmentRequest,
  WorkflowResultEnvironmentValidator,
} from "./workflow-result-registry.js";

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_ISSUES = 32;
/** Pathspec bytes per `git check-ignore` call. */
const PATH_BATCH_BYTES = 16 * 1024;
/** Git calls one file list may spend locating the paths that fail. */
const MAX_PATH_PROBES = 128;

function issue(path: string, code: string, message: string): WorkflowResultValidationIssue {
  return { path: path.slice(0, 256), code, message: message.slice(0, 512) };
}

function exitCode(error: unknown): number | null {
  const code = (error as { exitCode?: unknown } | null)?.exitCode;
  return typeof code === "number" ? code : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Git exits 1 for "no" and 128 for a ref it cannot resolve; anything else is unavailability. */
function isRefusal(error: unknown): boolean {
  const code = exitCode(error);
  return code === 1 || code === 128;
}

async function resolveCommit(
  git: EnvironmentGit,
  environmentId: string,
  ref: string,
): Promise<string | null> {
  try {
    const resolved = (
      await git(environmentId, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    )
      .trim()
      .toLowerCase();
    return SHA_PATTERN.test(resolved) ? resolved : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw error;
  }
}

async function mergeBase(
  git: EnvironmentGit,
  environmentId: string,
  left: string,
  right: string,
): Promise<string | null> {
  try {
    const base = (await git(environmentId, ["merge-base", left, right])).trim().toLowerCase();
    return SHA_PATTERN.test(base) ? base : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw error;
  }
}

/** The repository answers at all; otherwise every later "no" would be a guess. */
async function assertReadable(git: EnvironmentGit, environmentId: string): Promise<void> {
  const head = (await git(environmentId, ["rev-parse", "--verify", "HEAD^{commit}"]))
    .trim()
    .toLowerCase();
  if (!SHA_PATTERN.test(head)) throw new Error("The environment repository is not readable");
}

async function checkWorkspaceCommit(
  git: EnvironmentGit,
  environmentId: string,
  value: unknown,
): Promise<WorkflowResultValidationIssue[]> {
  if (!record(value)) return [];
  const { branch, headRef, baseRef } = value;
  if (typeof branch !== "string" || typeof headRef !== "string") return [];
  await assertReadable(git, environmentId);
  const issues: WorkflowResultValidationIssue[] = [];
  const head = await resolveCommit(git, environmentId, headRef.toLowerCase());
  if (!head)
    issues.push(
      issue(
        "$.headRef",
        "unknown_commit",
        "The commit does not exist in the environment's repository.",
      ),
    );
  const tip = await resolveCommit(git, environmentId, `refs/heads/${branch}`);
  if (!tip)
    issues.push(
      issue(
        "$.branch",
        "unknown_branch",
        "The branch does not exist in the environment's repository.",
      ),
    );
  if (head && tip && (await mergeBase(git, environmentId, head, tip)) !== head)
    issues.push(
      issue("$.headRef", "not_reachable", "The commit is not reachable from the branch."),
    );
  if (typeof baseRef === "string") {
    const base = await resolveCommit(git, environmentId, baseRef.toLowerCase());
    if (!base) {
      issues.push(
        issue(
          "$.baseRef",
          "unknown_commit",
          "The commit does not exist in the environment's repository.",
        ),
      );
    } else if (head && (await mergeBase(git, environmentId, base, head)) !== base) {
      issues.push(
        issue("$.baseRef", "not_ancestor", "The base commit is not an ancestor of headRef."),
      );
    }
  }
  return issues;
}

/** Batches of indexes whose `./`-anchored pathspecs stay within the byte bound. */
function pathBatches(paths: readonly string[]): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let bytes = 0;
  paths.forEach((path, index) => {
    const size = Buffer.byteLength(path, "utf8") + 3;
    if (current.length > 0 && bytes + size > PATH_BATCH_BYTES) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(index);
    bytes += size;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

async function checkFileListPaths(
  git: EnvironmentGit,
  environmentId: string,
  value: unknown,
): Promise<WorkflowResultValidationIssue[]> {
  if (!record(value) || !Array.isArray(value.files)) return [];
  const paths = value.files.map((entry) =>
    record(entry) && typeof entry.path === "string" ? entry.path : null,
  );
  const indexes = paths.flatMap((path, index) => (path === null ? [] : [index]));
  if (indexes.length === 0) return [];
  await assertReadable(git, environmentId);
  let probes = 0;
  const failing: number[] = [];
  let exhausted = false;
  // Exit 0 (some paths ignored) and 1 (none) both mean Git accepted every
  // pathspec; 128 means at least one does not resolve inside the worktree.
  const accepted = async (batch: readonly number[]): Promise<boolean> => {
    probes++;
    try {
      // `./` anchors each path at the worktree root and disables pathspec magic.
      await git(environmentId, [
        "check-ignore",
        "--no-index",
        "--",
        ...batch.map((index) => `./${paths[index]!}`),
      ]);
      return true;
    } catch (error) {
      if (exitCode(error) === 1) return true;
      if (exitCode(error) === 128) return false;
      throw error;
    }
  };
  const locate = async (batch: readonly number[]): Promise<void> => {
    if (failing.length >= MAX_ISSUES) return;
    if (batch.length === 1) {
      failing.push(batch[0]!);
      return;
    }
    const middle = Math.ceil(batch.length / 2);
    for (const half of [batch.slice(0, middle), batch.slice(middle)]) {
      if (probes >= MAX_PATH_PROBES) {
        exhausted = true;
        return;
      }
      if (!(await accepted(half))) await locate(half);
    }
  };
  for (const batch of pathBatches(indexes.map((index) => paths[index]!)).map((positions) =>
    positions.map((position) => indexes[position]!),
  )) {
    if (probes >= MAX_PATH_PROBES) {
      exhausted = true;
      break;
    }
    if (!(await accepted(batch))) await locate(batch);
    if (failing.length >= MAX_ISSUES) break;
  }
  const issues = failing
    .sort((left, right) => left - right)
    .map((index) =>
      issue(
        `$.files[${index}].path`,
        "outside_worktree",
        "The path does not resolve inside the environment's worktree (it leads through a symbolic link).",
      ),
    );
  if (exhausted && issues.length < MAX_ISSUES) {
    issues.push(
      issue(
        "$.files",
        "outside_worktree",
        "Some paths do not resolve inside the environment's worktree; list only files inside it.",
      ),
    );
  }
  return issues.slice(0, MAX_ISSUES);
}

/**
 * The environment validator the backend installs on its workflow result
 * service, over the environment Git port.
 */
export function gitEnvironmentValidator(git: EnvironmentGit): WorkflowResultEnvironmentValidator {
  return async ({ attempt, validator, value }: WorkflowResultEnvironmentRequest) => {
    if (validator === "workspace-commit")
      return checkWorkspaceCommit(git, attempt.environmentId, value);
    return checkFileListPaths(git, attempt.environmentId, value);
  };
}
