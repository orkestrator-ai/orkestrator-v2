/**
 * Reruns a validation round's failing Bun test files on a throwaway checkout
 * of the merge base, so a failure that also happens there is labelled
 * pre-existing from evidence rather than guessed at.
 *
 * Before this, `pre-existing` came only from the target branch's CI or from
 * another pipeline on the same base. A repository whose CI was green on the
 * merge base, or whose CI does not run the failing suite, left every failure
 * that was already broken there `undetermined`, and readers spent the round
 * reproducing it by hand or left the change unverified.
 *
 * The rerun is bounded (files, per-file time, total time), runs only test
 * files the branch did not change and that exist on the merge base, and never
 * touches the reviewed worktree: the checkout is a detached `git worktree`
 * under a temporary directory, created with hooks disabled and removed
 * afterwards. A failure is `failed-on-merge-base` only when the same test, by
 * normalized title, failed there; any other outcome is either
 * `passed-on-merge-base` (context only) or no evidence at all. Nothing here is
 * fatal: every problem becomes a triage limitation.
 */
import path from "node:path";
import {
  MAX_TRIAGE_LIMITATIONS,
  MAX_TRIAGE_TEXT_LENGTH,
  normalizeValidationTestName,
  type TriagedValidationFailure,
  type ValidationFailureTriage,
} from "@orkestrator/protocol/validation-failure-triage";

/** Most test files one triage reruns on the merge base. */
export const MAX_MERGE_BASE_RERUN_FILES = 8;
/** The whole rerun, checkout and install included. */
export const MERGE_BASE_RERUN_BUDGET_MS = 300_000;
const CHECKOUT_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 180_000;
const TEST_FILE_TIMEOUT_MS = 90_000;
const CLEANUP_TIMEOUT_MS = 60_000;
/** Below this much budget a step is not started. */
const MIN_STEP_MS = 5_000;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface MergeBaseRerunResult {
  exitCode: number | null;
  /** stdout with stderr folded in (`2>&1`). */
  output: string;
  timedOut: boolean;
}

/**
 * Runs `bash -lc <script> merge-base-rerun ...args` from the reviewed
 * worktree, the way validation ran its commands, so `bun` and `git` resolve
 * to the same tools. Must resolve, not reject, on a non-zero exit.
 */
export type MergeBaseRerunExec = (
  script: string,
  args: string[],
  timeoutMs: number,
) => Promise<MergeBaseRerunResult>;

export interface RerunFailuresOnMergeBaseOptions {
  triage: ValidationFailureTriage;
  changedFiles: readonly string[];
  exec: MergeBaseRerunExec;
  /**
   * The directory to create the checkout in. Must not exist yet; it is
   * removed afterwards whatever happens. Never inside the reviewed worktree.
   */
  checkoutDir: string;
  budgetMs?: number;
  now?: () => number;
}

const CHECKOUT_SCRIPT =
  'git -c core.hooksPath=/dev/null worktree add --detach --quiet "$1" "$2" 2>&1';
const LIST_SCRIPT = 'dir="$1"; shift; git -C "$dir" ls-files -- "$@" 2>&1';
/**
 * Resolves Bun from the reviewed worktree, where its version manager's
 * configuration is trusted, and then works in the checkout with that binary
 * first on PATH. A version-manager shim run inside the temporary checkout
 * would read an untrusted configuration there instead. `bun --cwd <dir> test`
 * is not an option: Bun then runs the package's `test` script, which in a
 * package that has one is its whole suite.
 */
const WITH_BUN =
  "bun_bin=$(bun -e 'process.stdout.write(process.execPath)') || exit 127; " +
  'PATH="$(dirname "$bun_bin"):$PATH"; export PATH; cd "$1" || exit 1; ';
const INSTALL_SCRIPT = `${WITH_BUN}exec "$bun_bin" install --frozen-lockfile --ignore-scripts 2>&1`;
// `./` keeps Bun reading the argument as a path rather than a name filter.
const TEST_SCRIPT = `${WITH_BUN}exec "$bun_bin" test "./$2" 2>&1`;
// Only the directory this module created: `git worktree remove` first, so Git
// forgets it, then `rm -rf` for anything it left (an install's node_modules).
const CLEANUP_SCRIPT =
  'git worktree remove --force "$1" >/dev/null 2>&1; rm -rf -- "$1"; git worktree prune >/dev/null 2>&1; true';

function isSafeRepositoryPath(file: string): boolean {
  return (
    file.length > 0 &&
    !file.startsWith("/") &&
    !file.includes("\n") &&
    !file.includes("\0") &&
    !file.split("/").some((part) => part === ".." || part === "." || part === "")
  );
}

/** Directories from the file's own up to the repository root (`""`). */
function ancestorDirectories(file: string): string[] {
  const parts = file.split("/").slice(0, -1);
  const directories: string[] = [];
  for (let length = parts.length; length >= 0; length -= 1) {
    directories.push(parts.slice(0, length).join("/"));
  }
  return directories;
}

function inDirectory(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

/** The titles a Bun run reported as failing, normalized. */
export function bunFailedTestNames(output: string): Set<string> {
  const names = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.replace(ANSI, "").replace(/\r$/, "");
    const match = /^\(fail\) (.+)$/.exec(line);
    if (match) names.add(normalizeValidationTestName(match[1]!));
  }
  return names;
}

/** Whether a Bun run got as far as reporting results at all. */
function bunReportedResults(output: string): boolean {
  const text = output.replace(ANSI, "");
  return /^\s*\d+ pass$/m.test(text) || /^\s*\d+ fail$/m.test(text);
}

function clip(text: string): string {
  return text.length <= MAX_TRIAGE_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_TRIAGE_TEXT_LENGTH - 1)}…`;
}

function isRerunCandidate(failure: TriagedValidationFailure, changed: Set<string>): boolean {
  return (
    failure.runner === "bun" &&
    failure.file !== null &&
    isSafeRepositoryPath(failure.file) &&
    !changed.has(failure.file) &&
    // Already shown to fail on the merge base; a rerun adds nothing.
    !failure.reasons.includes("failed-on-target-ci") &&
    !failure.reasons.includes("failed-on-same-base")
  );
}

/**
 * Returns the triage with `failed-on-merge-base` (verdict `unrelated`) or
 * `passed-on-merge-base` (verdict unchanged) added to each failure the rerun
 * reached, and a limitation for anything it could not do.
 */
export async function rerunFailuresOnMergeBase(
  options: RerunFailuresOnMergeBaseOptions,
): Promise<ValidationFailureTriage> {
  const { triage, exec, checkoutDir } = options;
  const mergeBase = triage.mergeBase;
  if (!mergeBase) return triage;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? MERGE_BASE_RERUN_BUDGET_MS);
  const remaining = (cap: number) => Math.min(cap, deadline - now());
  const changed = new Set(options.changedFiles);

  // Open failures first: a label that unblocks is worth more than one that
  // only renames an `unrelated` verdict. Then by file, in triage order.
  const byFile = new Map<string, TriagedValidationFailure[]>();
  const failures = triage.commands.flatMap((command) => command.failures);
  const ordered = [
    ...failures.filter((failure) => failure.verdict !== "unrelated"),
    ...failures.filter((failure) => failure.verdict === "unrelated"),
  ];
  for (const failure of ordered) {
    if (!isRerunCandidate(failure, changed)) continue;
    const list = byFile.get(failure.file!) ?? [];
    list.push(failure);
    byFile.set(failure.file!, list);
  }
  if (byFile.size === 0) return triage;

  const limitations: string[] = [];
  const files = [...byFile.keys()];
  const selected = files.slice(0, MAX_MERGE_BASE_RERUN_FILES);
  if (files.length > selected.length) {
    limitations.push(
      `${files.length - selected.length} failing test files were not rerun on the merge base (limit ${MAX_MERGE_BASE_RERUN_FILES})`,
    );
  }
  /** Per failing test: what the merge base said about it. */
  const outcome = new Map<TriagedValidationFailure, "failed" | "passed">();

  try {
    const checkout = await exec(
      CHECKOUT_SCRIPT,
      [checkoutDir, mergeBase],
      remaining(CHECKOUT_TIMEOUT_MS),
    );
    if (checkout.exitCode !== 0) {
      limitations.push("The merge base could not be checked out, so no failure was rerun there");
      return finish();
    }

    // Which of the files and the configuration around them exist there.
    const queried = new Set<string>();
    for (const file of selected) {
      queried.add(file);
      for (const directory of ancestorDirectories(file)) {
        for (const name of ["bunfig.toml", "package.json", "bun.lock", "bun.lockb"]) {
          queried.add(inDirectory(directory, name));
        }
      }
    }
    const listing = await exec(LIST_SCRIPT, [checkoutDir, ...queried], remaining(30_000));
    if (listing.exitCode !== 0) {
      limitations.push("The merge base checkout could not be read, so no failure was rerun there");
      return finish();
    }
    const present = new Set(
      listing.output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const lockDirectory = (file: string) =>
      ancestorDirectories(file).find(
        (directory) =>
          present.has(inDirectory(directory, "bun.lock")) ||
          present.has(inDirectory(directory, "bun.lockb")),
      );
    // Bun reads bunfig.toml (its preloads) from its working directory, so a
    // test runs where its nearest bunfig.toml is, else its nearest package.
    // Neither search leaves the project its lockfile belongs to: a
    // standalone package nested in a workspace has its own configuration.
    const testDirectory = (file: string) => {
      const lock = lockDirectory(file) ?? "";
      const own = ancestorDirectories(file);
      const project = own.slice(0, own.indexOf(lock) + 1);
      return (
        project.find((directory) => present.has(inDirectory(directory, "bunfig.toml"))) ??
        project.find((directory) => present.has(inDirectory(directory, "package.json"))) ??
        lock
      );
    };

    const runnable = selected.filter(
      (file) => present.has(file) && lockDirectory(file) !== undefined,
    );
    if (runnable.length === 0) {
      if (selected.some((file) => present.has(file))) {
        limitations.push("The merge base has no Bun lockfile, so no failure was rerun there");
      }
      return finish();
    }

    const installed = new Map<string, boolean>();
    for (const file of runnable) {
      const lock = lockDirectory(file)!;
      if (!installed.has(lock)) {
        if (remaining(INSTALL_TIMEOUT_MS) < MIN_STEP_MS) break;
        const install = await exec(
          INSTALL_SCRIPT,
          [path.posix.join(checkoutDir, lock)],
          remaining(INSTALL_TIMEOUT_MS),
        );
        installed.set(lock, install.exitCode === 0);
        if (install.exitCode !== 0) {
          limitations.push(
            clip(
              `Dependencies could not be installed on the merge base${lock ? ` in ${lock}` : ""}${install.timedOut ? " in time" : ""}, so its failures were not rerun there`,
            ),
          );
        }
      }
      if (!installed.get(lock)) continue;
      if (remaining(TEST_FILE_TIMEOUT_MS) < MIN_STEP_MS) {
        limitations.push("The merge-base rerun ran out of time before every failing test file ran");
        break;
      }
      const directory = testDirectory(file);
      const relative = directory ? file.slice(directory.length + 1) : file;
      const run = await exec(
        TEST_SCRIPT,
        [path.posix.join(checkoutDir, directory), relative],
        remaining(TEST_FILE_TIMEOUT_MS),
      );
      if (run.timedOut) {
        limitations.push(clip(`${file} did not finish on the merge base in time`));
        continue;
      }
      // A file that failed to load reported no results: that is not evidence
      // that any of its tests fail there.
      if (run.exitCode !== 0 && !bunReportedResults(run.output)) {
        limitations.push(clip(`${file} could not run on the merge base`));
        continue;
      }
      const failedThere = run.exitCode === 0 ? new Set<string>() : bunFailedTestNames(run.output);
      for (const failure of byFile.get(file) ?? []) {
        outcome.set(
          failure,
          failedThere.has(normalizeValidationTestName(failure.name)) ? "failed" : "passed",
        );
      }
    }
  } catch {
    limitations.push("The merge-base rerun could not run");
  } finally {
    // Also after a failed or timed-out checkout, which can leave a partial
    // directory and a registered worktree behind.
    await exec(CLEANUP_SCRIPT, [checkoutDir], CLEANUP_TIMEOUT_MS).catch(() => undefined);
  }
  return finish();

  function finish(): ValidationFailureTriage {
    return {
      ...triage,
      commands: triage.commands.map((command) => ({
        ...command,
        failures: command.failures.map((failure) => {
          const result = outcome.get(failure);
          if (result === "failed") {
            return {
              ...failure,
              verdict: "unrelated" as const,
              reasons: [...failure.reasons, "failed-on-merge-base" as const],
            };
          }
          if (result === "passed") {
            return { ...failure, reasons: [...failure.reasons, "passed-on-merge-base" as const] };
          }
          return failure;
        }),
      })),
      limitations: [...triage.limitations, ...new Set(limitations)].slice(
        0,
        MAX_TRIAGE_LIMITATIONS,
      ),
    };
  }
}
