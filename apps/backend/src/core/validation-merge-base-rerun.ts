import { createHash } from "node:crypto";
import path from "node:path";
import {
  MAX_TRIAGE_LIMITATIONS,
  MAX_TRIAGE_TEXT_LENGTH,
  normalizeValidationTestName,
  type TriagedValidationFailure,
  type ValidationFailureTriage,
} from "@orkestrator/protocol/validation-failure-triage";
import { bunFailureFingerprint } from "./validation-bun-diagnostics.js";
import type { MergeBaseRerunExec, MergeBaseRerunResult } from "./validation-merge-base-process.js";
import {
  BUILD_SCRIPT,
  parseMergeBaseTestSetup,
  SETUP_SCRIPT,
  type MergeBaseTestSetup,
} from "./validation-merge-base-setup.js";

export const MAX_MERGE_BASE_RERUN_FILES = 8;
export const MERGE_BASE_RERUN_BUDGET_MS = 300_000;
const CHECKOUT_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 180_000;
const TEST_FILE_TIMEOUT_MS = 90_000;
const CLEANUP_TIMEOUT_MS = 60_000;
const MIN_STEP_MS = 5_000;
const OUT_OF_TIME = "The merge-base rerun ran out of time before every failing test file ran";
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

interface Candidate {
  failure: TriagedValidationFailure;
  command: string;
}

export interface RerunFailuresOnMergeBaseOptions {
  triage: ValidationFailureTriage;
  changedFiles: readonly string[];
  fingerprints?: ReadonlyMap<TriagedValidationFailure, string>;
  exec: MergeBaseRerunExec;
  /** A unique, absent path outside the reviewed worktree. */
  checkoutDir: string;
  budgetMs?: number;
  now?: () => number;
}

const CHECKOUT_SCRIPT = `
  git -c core.hooksPath=/dev/null worktree add --detach --quiet "$1" "$2" &&
    git -C "$1" rev-parse --verify 'HEAD^{commit}'
`;
const LIST_SCRIPT =
  'git -C "$1" ls-files -z -- "*.test.*" "*.spec.*" ":(glob)**/package.json" ":(glob)**/bun.lock" ":(glob)**/bun.lockb"';
const INSTALL_SCRIPT =
  'cd "$1" && exec "$ORKESTRATOR_BASELINE_BUN" install --frozen-lockfile --ignore-scripts 2>&1';
const TEST_SCRIPT = `
  cd "$1" || exit 1
  file="$2"; shift 2
  test -f "./$file" && test ! -L "./$file" || exit 2
  unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CODEX_SESSION_ID CODEX_THREAD_ID BUN_TEST_QUIET
  export NO_COLOR=1 FORCE_COLOR=0
  config=/dev/null
  if [ -f bunfig.toml ] && [ ! -L bunfig.toml ]; then config=./bunfig.toml; fi
  exec "$ORKESTRATOR_BASELINE_BUN" test "./$file" --config="$config" --parallel=1 "$@" 2>&1
`;
const CLEANUP_SCRIPT = `
  set -o pipefail
  git -c core.hooksPath=/dev/null worktree remove --force "$1" >/dev/null 2>&1 || true
  git worktree list --porcelain -z |
    "$ORKESTRATOR_BASELINE_BUN" --no-env-file --config=/dev/null -e '
      const path = require("node:path");
      const fs = require("node:fs");
      const target = process.argv[1], parent = path.dirname(target);
      const canonical = path.join(fs.realpathSync(parent), path.basename(target));
      if ((await Bun.stdin.text()).split("\\0").some(field =>
        field === "worktree " + target || field === "worktree " + canonical
      )) process.exit(1);
    ' "$1" || exit 1
  rm -rf -- "$1" && test ! -e "$1" && test ! -L "$1"
`;

function isSafeRepositoryPath(file: string): boolean {
  return (
    !file.startsWith("/") &&
    !/[\r\n\0]/.test(file) &&
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
    file.split("/").every((part) => part && part !== ".." && part !== ".")
  );
}

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

type BunObservation = { kind: "pass" | "skip" | "todo" } | { kind: "fail"; fingerprint?: string };

function parseBunResults(
  run: MergeBaseRerunResult,
  file: string,
): Map<string, BunObservation> | null {
  if (run.truncated || (run.exitCode !== 0 && run.exitCode !== 1)) return null;
  const output = run.output.replace(ANSI, "").trimEnd();
  const lines = output.split(/\r?\n/);
  if (
    !lines[0]?.startsWith("bun test v") ||
    !/^Ran \d+ tests? across 1 file\. \[[^\]]+\]$/.test(lines.at(-1) ?? "") ||
    /Unhandled error between tests|^\s*[1-9]\d* errors?$/m.test(output)
  )
    return null;

  const observations = new Map<string, BunObservation>();
  let fileHeader = false;
  let grouped = false;
  let groupClosed = false;
  let summary = false;
  const counts = { pass: 0, fail: 0, skip: 0, todo: 0 };
  const totals = new Map<string, number>();
  let diagnostic: string[] = [];
  for (const line of lines) {
    const header = /^(::group::)?((?!::)\S.*\.[cm]?[jt]sx?:)$/.exec(line);
    if (header) {
      if (fileHeader || summary || header[2]!.replace(/^\.\//, "") !== `${file}:`) return null;
      fileHeader = true;
      grouped = Boolean(header[1]);
      diagnostic = [];
      continue;
    }
    if (
      grouped &&
      line === "::endgroup::" &&
      !diagnostic.some((entry) => /^error: \S/.test(entry))
    ) {
      if (groupClosed || summary) return null;
      groupClosed = true;
      continue;
    }
    const count = /^\s*(\d+) (pass|fail|skip|todo)$/.exec(line);
    if (count) {
      const kind = count[2]!;
      if (!fileHeader || (grouped && !groupClosed) || totals.has(kind)) return null;
      totals.set(kind, Number(count[1]));
      summary = true;
      continue;
    }
    const result = /^\((pass|fail|skip|todo)\) (.+)$/.exec(line);
    if (!result) {
      diagnostic.push(line);
      continue;
    }
    if (!fileHeader || groupClosed || summary) return null;
    const kind = result[1] as keyof typeof counts;
    const title = normalizeValidationTestName(result[2]!);
    if (observations.has(title)) return null;
    counts[kind]++;
    observations.set(
      title,
      kind === "fail"
        ? { kind, fingerprint: bunFailureFingerprint(diagnostic, hashDiagnostic, grouped) }
        : { kind },
    );
    diagnostic = [];
  }
  if (
    !fileHeader ||
    !totals.has("pass") ||
    !totals.has("fail") ||
    (run.exitCode === 0) !== (counts.fail === 0) ||
    Object.entries(counts).some(([kind, count]) => (totals.get(kind) ?? 0) !== count) ||
    Number(/^Ran (\d+)/.exec(lines.at(-1)!)?.[1]) !== observations.size
  )
    return null;
  return observations;
}

function hashDiagnostic(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function clip(text: string): string {
  return text.length <= MAX_TRIAGE_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_TRIAGE_TEXT_LENGTH - 1)}…`;
}

/** Finite diagnostics keep arbitrary subprocess output and credentials out of packages. */
function diagnosticFor(result: MergeBaseRerunResult): string {
  if (!result.quiescent && result.quiescent !== undefined) return "process termination unconfirmed";
  if (result.timedOut) return "timed out";
  if (result.truncated) return "output limit exceeded";
  const text = `${result.stderr ?? ""}\n${result.output}`;
  for (const [pattern, message] of [
    [/command not found|ENOENT/i, "required executable or file missing"],
    [/frozen lockfile|lockfile had changes/i, "frozen lockfile mismatch"],
    [
      /could not resolve|cannot find (?:module|package)|module not found/i,
      "module or preload unresolved",
    ],
    [/unhandled error between tests|^\s*[1-9]\d* errors?$/im, "error outside any test"],
    [/permission denied|EACCES|EPERM/i, "permission denied"],
    [/ENOSPC|no space left/i, "insufficient disk space"],
    [
      /ENETUNREACH|ECONNREFUSED|ETIMEDOUT|certificate|registry.*(?:error|failed)/i,
      "dependency network or registry error",
    ],
    [/invalid reference|not a valid object|unknown revision/i, "Git commit unavailable"],
  ] as const) {
    if (pattern.test(text)) return message;
  }
  return result.exitCode === 0 ? "no complete result" : `exit ${result.exitCode ?? "unknown"}`;
}

function candidates(
  triage: ValidationFailureTriage,
  changedFiles: readonly string[],
): Map<string, Candidate[]> {
  const changed = new Set(changedFiles);
  const byFile = new Map<string, Candidate[]>();
  const candidates = triage.commands.flatMap(({ command, failures }) =>
    failures.map((failure) => ({ failure, command })),
  );
  const ordered = [
    ...candidates.filter(({ failure }) => failure.verdict !== "unrelated"),
    ...candidates.filter(({ failure }) => failure.verdict === "unrelated"),
  ];
  for (const candidate of ordered) {
    const { failure } = candidate;
    if (
      failure.runner !== "bun" ||
      !failure.file ||
      !isSafeRepositoryPath(failure.file) ||
      changed.has(failure.file) ||
      failure.reasons.includes("failed-on-target-ci") ||
      failure.reasons.includes("failed-on-same-base")
    )
      continue;
    const list = byFile.get(failure.file) ?? [];
    list.push(candidate);
    byFile.set(failure.file, list);
  }
  return byFile;
}

function hasComparablePreloads(command: string, setup: MergeBaseTestSetup): boolean {
  const direct = /(?:^|\s)bun test(?:\s|$)/.exec(command);
  if (!direct) return true;
  const args = command.slice(direct.index + direct[0].length);
  const flags = [...args.matchAll(/(?:^|\s)--preload(?=$|[=\s])/g)];
  const preloads = [
    ...args.matchAll(/(?:^|\s)--preload(?:=|\s+)(?:"([\w./-]+)"|'([\w./-]+)'|([\w./-]+))(?=$|\s)/g),
  ].map((match) => match[1] ?? match[2] ?? match[3]);
  return (
    flags.length === preloads.length &&
    preloads.length === setup.preloads.length &&
    preloads.every((value, index) => value === setup.preloads[index])
  );
}

export function needsMergeBaseRerun(
  triage: ValidationFailureTriage,
  changed: readonly string[],
): boolean {
  return triage.mergeBase !== null && candidates(triage, changed).size > 0;
}

export async function rerunFailuresOnMergeBase(
  options: RerunFailuresOnMergeBaseOptions,
): Promise<ValidationFailureTriage> {
  const { triage, exec, checkoutDir } = options;
  const mergeBase = triage.mergeBase;
  if (!mergeBase) return triage;
  const byFile = candidates(triage, options.changedFiles);
  if (byFile.size === 0) return triage;
  const now = options.now ?? (() => performance.now());
  const deadline = now() + (options.budgetMs ?? MERGE_BASE_RERUN_BUDGET_MS);
  const remaining = (cap: number) => Math.min(cap, Math.floor(deadline - now()));
  const limitations: string[] = [];
  const outcomes = new Map<TriagedValidationFailure, "failed" | "passed">();
  let startedCheckout = false;
  let quiescent = true;
  const step: MergeBaseRerunExec = async (script, args, timeoutMs) => {
    if (timeoutMs < MIN_STEP_MS) throw new Error(OUT_OF_TIME);
    quiescent = false;
    const result = await exec(script, args, timeoutMs);
    quiescent = result.quiescent !== false;
    return result;
  };
  const ok = (result: MergeBaseRerunResult) =>
    quiescent && result.exitCode === 0 && !result.timedOut && !result.truncated;
  const note = (message: string, result?: MergeBaseRerunResult) =>
    limitations.push(clip(result ? `${message} (${diagnosticFor(result)})` : message));

  try {
    await run();
  } catch (error) {
    note(
      error instanceof Error && error.message === OUT_OF_TIME
        ? OUT_OF_TIME
        : "The merge-base rerun could not run",
    );
  } finally {
    if (startedCheckout && quiescent) {
      const cleanup = await exec(CLEANUP_SCRIPT, [checkoutDir], CLEANUP_TIMEOUT_MS).catch(
        () => null,
      );
      if (!cleanup || !ok(cleanup) || cleanup.quiescent === false) {
        note(
          `Temporary merge-base worktree cleanup could not be verified at ${checkoutDir}`,
          cleanup ?? undefined,
        );
      }
    } else if (startedCheckout) {
      note(
        `Temporary merge-base worktree cleanup was withheld at ${checkoutDir} because the last step may still be running`,
      );
    }
  }
  return {
    ...triage,
    commands: triage.commands.map((command) => ({
      ...command,
      failures: command.failures.map((failure) => {
        const result = outcomes.get(failure);
        if (result === "failed") {
          return {
            ...failure,
            verdict: "unrelated",
            reasons: [...failure.reasons, "failed-on-merge-base"],
          };
        }
        if (result === "passed") {
          return { ...failure, reasons: [...failure.reasons, "passed-on-merge-base"] };
        }
        return failure;
      }),
    })),
    // Keep final cleanup and budget limitations under the same transport cap.
    limitations: [...new Set([...triage.limitations, ...limitations])].slice(
      -MAX_TRIAGE_LIMITATIONS,
    ),
  };

  async function run(): Promise<void> {
    if (remaining(CHECKOUT_TIMEOUT_MS) < MIN_STEP_MS) {
      note(OUT_OF_TIME);
      return;
    }
    startedCheckout = true;
    const checkout = await step(
      CHECKOUT_SCRIPT,
      [checkoutDir, mergeBase!],
      remaining(CHECKOUT_TIMEOUT_MS),
    );
    if (!ok(checkout)) {
      note("The expected merge base could not be checked out", checkout);
      return;
    }
    if (checkout.output.trim() !== mergeBase) {
      note("The temporary checkout did not resolve to the pinned merge base");
      return;
    }
    const listing = await step(LIST_SCRIPT, [checkoutDir], remaining(30_000));
    if (!ok(listing) || (listing.output && !listing.output.endsWith("\0"))) {
      note("The merge-base tracked files could not be read completely", listing);
      return;
    }
    const present = new Set(listing.output.split("\0"));
    const installed = new Map<string, boolean>();
    const setups = new Map<string, MergeBaseTestSetup | null>();
    const eligible: Array<{
      file: string;
      lock: string;
      directory: string;
      setup: MergeBaseTestSetup;
    }> = [];
    let unavailable = 0;
    for (const file of byFile.keys()) {
      const dirs = ancestorDirectories(file);
      const lockIndex = dirs.findIndex(
        (dir) =>
          present.has(inDirectory(dir, "bun.lock")) || present.has(inDirectory(dir, "bun.lockb")),
      );
      const directory = dirs
        .slice(0, lockIndex + 1)
        .find((dir) => present.has(inDirectory(dir, "package.json")));
      if (!present.has(file) || lockIndex === -1 || directory === undefined) {
        unavailable++;
        continue;
      }
      const lock = dirs[lockIndex]!;
      if (!setups.has(directory)) {
        const setup = await step(SETUP_SCRIPT, [checkoutDir, directory], remaining(10_000));
        setups.set(directory, ok(setup) ? parseMergeBaseTestSetup(setup.output) : null);
        if (!setups.get(directory))
          note(
            `Bun test setup is unsupported or unavailable in ${directory || "the repository root"}`,
            setup,
          );
        if (!quiescent) return;
      }
      const setup = setups.get(directory);
      if (!setup) continue;
      const comparable = byFile
        .get(file)!
        .filter(({ command }) => hasComparablePreloads(command, setup));
      if (comparable.length !== byFile.get(file)!.length) {
        note(
          `The recorded Bun preload arguments differ from the supported baseline setup for ${file}`,
        );
      }
      if (comparable.length > 0) {
        byFile.set(file, comparable);
        eligible.push({ file, lock, directory, setup });
      }
    }
    if (unavailable)
      note(
        `${unavailable} failing test files lack a tracked test, Bun lockfile or package on the merge base`,
      );
    if (eligible.length > MAX_MERGE_BASE_RERUN_FILES) {
      note(
        `${eligible.length - MAX_MERGE_BASE_RERUN_FILES} eligible test files were not rerun on the merge base (limit ${MAX_MERGE_BASE_RERUN_FILES})`,
      );
    }
    const built = new Map<string, boolean>();
    for (const { file, lock, directory, setup } of eligible.slice(0, MAX_MERGE_BASE_RERUN_FILES)) {
      if (!installed.has(lock)) {
        const install = await step(
          INSTALL_SCRIPT,
          [path.posix.join(checkoutDir, lock)],
          remaining(INSTALL_TIMEOUT_MS),
        );
        installed.set(lock, ok(install));
        if (!ok(install))
          note(
            `Dependencies could not be installed on the merge base in ${lock || "the repository root"}`,
            install,
          );
        if (!quiescent) return;
      }
      if (!installed.get(lock)) continue;
      const cwd = path.posix.join(checkoutDir, directory);
      if (setup.build !== null && !built.has(directory)) {
        const build = await step(
          BUILD_SCRIPT,
          [checkoutDir, cwd, setup.build],
          remaining(INSTALL_TIMEOUT_MS),
        );
        built.set(directory, ok(build));
        if (!ok(build))
          note(
            `Build prerequisites could not run on the merge base in ${directory || "the repository root"}`,
            build,
          );
        if (!quiescent) return;
      }
      if (built.get(directory) === false) continue;
      const relative = directory ? file.slice(directory.length + 1) : file;
      const run = await step(
        TEST_SCRIPT,
        [cwd, relative, ...setup.preloads.flatMap((preload) => ["--preload", preload])],
        remaining(TEST_FILE_TIMEOUT_MS),
      );
      const observations = quiescent && !run.timedOut ? parseBunResults(run, relative) : null;
      if (!observations) {
        note(`No complete Bun results for ${file} on the merge base`, run);
        if (!quiescent) return;
        continue;
      }
      let missing = 0;
      let mismatched = 0;
      for (const { failure } of byFile.get(file) ?? []) {
        const result = observations.get(normalizeValidationTestName(failure.name));
        if (result?.kind === "pass") outcomes.set(failure, "passed");
        else if (result?.kind === "fail") {
          if (result.fingerprint && result.fingerprint === options.fingerprints?.get(failure))
            outcomes.set(failure, "failed");
          else mismatched++;
        } else missing++;
      }
      if (missing)
        note(`${missing} selected tests in ${file} were skipped or unreported on the merge base`);
      if (mismatched)
        note(
          `${mismatched} selected failures in ${file} lacked matching failure diagnostics on the merge base`,
        );
    }
  }
}
