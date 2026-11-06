/**
 * Live check of the worktree watcher on this host's real file-system events
 * (docs/todo/transcripts-and-observation/0048-recurring-work-qualification.md,
 * task 7): single saves, bursts past the helper's per-flush cap and the
 * watcher's overflow threshold, and the failures that send its owner back to
 * polling.
 *
 * It drives the backend's own `startWorktreeWatcher` with its default plan and
 * Git metadata resolution. On macOS the watches go through a `WatchHost` this
 * script owns, running the same helper program as the backend's shared host,
 * so the helper's pid is the one this script spawned and the only process it
 * ever signals. Everything happens in a temporary Git repository that is
 * deleted at the end. Output is counts and milliseconds only.
 *
 *   bun scripts/worktree-watcher-live.ts [--saves 20] [--bursts 1000,5000,20000] [--out <file>]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { watchDirectory, WatchHost, WATCH_HOST_PROGRAM } from "../apps/backend/src/core/watch-host";
import {
  startWorktreeWatcher,
  WATCH_SETTLE_MS,
  type WorktreeChangeHint,
  type WorktreeWatcher,
} from "../apps/backend/src/core/worktree-watcher";
import { worktreeWatchPlanIo } from "../apps/backend/src/core/worktree-watch-plan";

interface Options {
  saves: number;
  bursts: number[];
  out?: string;
}

interface Hint {
  at: number;
  hint: WorktreeChangeHint | undefined;
}

export interface BurstResult {
  files: number;
  writeMs: number;
  hints: number;
  overflowHints: number;
  /** Hints that named paths; the rest said "unknown paths". */
  hintsWithPaths: number;
  /** From the last write to the last hint. Negative when no hint followed it. */
  lastHintAfterLastWriteMs: number;
  /** Whether a hint settled after the last write, so no final change was lost. */
  finalCovered: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { saves: 20, bursts: [1_000, 5_000, 20_000] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--saves" && value) options.saves = Number(value);
    else if (argv[index] === "--bursts" && value) options.bursts = value.split(",").map(Number);
    else if (argv[index] === "--out" && value) options.out = path.resolve(value);
    else continue;
    index += 1;
  }
  return options;
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}

/** Summarises the hints a burst produced, relative to its last write. */
export function summariseBurst(
  files: number,
  writeStartedAt: number,
  lastWriteAt: number,
  hints: readonly Hint[],
): BurstResult {
  const lastHint = hints.at(-1);
  return {
    files,
    writeMs: lastWriteAt - writeStartedAt,
    hints: hints.length,
    overflowHints: hints.filter((entry) => entry.hint?.overflow === true).length,
    hintsWithPaths: hints.filter((entry) => entry.hint?.paths !== undefined).length,
    lastHintAfterLastWriteMs: lastHint ? lastHint.at - lastWriteAt : -1,
    finalCovered: hints.some((entry) => entry.at >= lastWriteAt),
  };
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<number> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
  return Date.now() - started;
}

/** Waits until no hint has arrived for `quietMs`. */
async function waitQuiet(hints: readonly Hint[], quietMs: number, timeoutMs: number) {
  const started = Date.now();
  for (;;) {
    const last = hints.at(-1)?.at ?? started;
    if (Date.now() - Math.max(last, started) >= quietMs) return;
    if (Date.now() - started > timeoutMs) throw new Error("hints never went quiet");
    await sleep(50);
  }
}

class Probe {
  readonly hints: Hint[] = [];
  readonly errors: Array<{ at: number; code: string }> = [];
  coveredAt: number | null = null;
  readonly watcher: WorktreeWatcher;

  constructor(
    worktreePath: string,
    startWatch: Parameters<typeof startWorktreeWatcher>[0]["startWatch"],
  ) {
    this.watcher = startWorktreeWatcher({
      worktreePath,
      comparisonRef: "main",
      // The backend's default plan and Git resolution, not the test doubles'
      // (an injected `startWatch` would otherwise turn the plan off).
      plan: worktreeWatchPlanIo,
      startWatch,
      onChange: (hint) => this.hints.push({ at: Date.now(), hint }),
      onCoverageChange: () => {
        this.coveredAt = Date.now();
      },
      onError: (error) =>
        this.errors.push({
          at: Date.now(),
          code: String((error as NodeJS.ErrnoException)?.code ?? "unknown"),
        }),
    });
  }
}

async function writeBurst(root: string, label: string, files: number): Promise<number> {
  const directory = path.join(root, "burst", label);
  const perDirectory = 500;
  for (let start = 0; start < files; start += perDirectory) {
    await mkdir(path.join(directory, `d${start / perDirectory}`), { recursive: true });
  }
  const batch = 256;
  for (let start = 0; start < files; start += batch) {
    await Promise.all(
      Array.from({ length: Math.min(batch, files - start) }, (_, offset) => {
        const index = start + offset;
        return writeFile(
          path.join(directory, `d${Math.floor(index / perDirectory)}`, `f${index}.txt`),
          `${index}\n`,
        );
      }),
    );
  }
  return Date.now();
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = mkdtempSync(path.join(os.tmpdir(), "ork-watcher-live-"));
  const worktree = path.join(root, "repo");
  mkdirSync(worktree);
  const helpers: ChildProcess[] = [];
  const darwin = process.platform === "darwin";
  // The backend's helper program, spawned the way the backend spawns it, but
  // recorded here so a kill names only this script's own child.
  const host = new WatchHost(() => {
    const child = spawn(process.execPath, ["-e", WATCH_HOST_PROGRAM], {
      cwd: "/",
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    helpers.push(child);
    return child;
  });
  const startWatch = darwin
    ? (
        target: string,
        listener: (e: string, f: string | null) => void,
        o: { recursive: boolean },
      ) => host.watch(target, listener, o)
    : (
        target: string,
        listener: (e: string, f: string | null) => void,
        o: { recursive: boolean },
      ) => watchDirectory(target, listener, o);
  const report: Record<string, unknown> = {
    host: { platform: process.platform, release: os.release(), arch: process.arch },
    bun: Bun.version,
    settleMs: WATCH_SETTLE_MS,
  };
  try {
    git(worktree, "init", "--quiet", "--initial-branch=main");
    git(worktree, "config", "user.email", "watcher-live@example.invalid");
    git(worktree, "config", "user.name", "watcher-live");
    writeFileSync(path.join(worktree, "README.md"), "fixture\n");
    git(worktree, "add", "README.md");
    git(worktree, "commit", "--quiet", "-m", "fixture");

    const probe = new Probe(worktree, startWatch);
    report.qualifiedMs = await waitFor(() => probe.coveredAt !== null, 30_000, "coverage");
    await waitQuiet(probe.hints, 1_000, 30_000);

    // Single saves: from the write to the first hint naming the file.
    const saves: number[] = [];
    for (let index = 0; index < options.saves; index += 1) {
      const name = `save-${index}.txt`;
      const from = probe.hints.length;
      const writtenAt = Date.now();
      writeFileSync(path.join(worktree, name), `${index}\n`);
      await waitFor(
        () => probe.hints.slice(from).some((entry) => entry.hint?.paths?.includes(name) === true),
        10_000,
        `hint for save ${index}`,
      );
      const hint = probe.hints.slice(from).find((entry) => entry.hint?.paths?.includes(name));
      saves.push(hint!.at - writtenAt);
      await sleep(200 + Math.floor(Math.random() * 400));
    }
    report.saves = {
      count: saves.length,
      p50Ms: percentile(saves, 0.5),
      p95Ms: percentile(saves, 0.95),
      maxMs: Math.max(...saves),
    };

    // Bursts: every hint after the burst began, until hints go quiet.
    const bursts: BurstResult[] = [];
    for (const files of options.bursts) {
      await waitQuiet(probe.hints, 1_000, 30_000);
      const from = probe.hints.length;
      const startedAt = Date.now();
      const lastWriteAt = await writeBurst(worktree, `b${files}`, files);
      await waitQuiet(probe.hints, 3_000, 120_000);
      bursts.push(summariseBurst(files, startedAt, lastWriteAt, probe.hints.slice(from)));
    }
    report.bursts = bursts;

    // A Git operation rewriting the index and a ref: a metadata hint.
    {
      await waitQuiet(probe.hints, 1_000, 30_000);
      const from = probe.hints.length;
      const startedAt = Date.now();
      git(worktree, "add", "-A");
      git(worktree, "commit", "--quiet", "-m", "burst");
      const doneAt = Date.now();
      await waitQuiet(probe.hints, 2_000, 60_000);
      report.commitAll = summariseBurst(0, startedAt, doneAt, probe.hints.slice(from));
    }
    report.errorsBeforeFailure = probe.errors.length;

    if (darwin) {
      // Failure 1: the helper dies. Every watch reports an error at once.
      const helper = helpers.at(-1)!;
      const killedAt = Date.now();
      helper.kill("SIGKILL");
      await waitFor(() => probe.errors.length > 0, 10_000, "helper-loss error");
      report.helperLoss = {
        errorMs: probe.errors[0]!.at - killedAt,
        code: probe.errors[0]!.code,
        watchingAfter: probe.watcher.watching,
      };
      // The owner's retry: a new watcher spawns a new helper and covers again.
      const retried = new Probe(worktree, startWatch);
      const retryQualifiedMs = await waitFor(() => retried.coveredAt !== null, 30_000, "retry");
      await waitQuiet(retried.hints, 1_000, 30_000);
      const from = retried.hints.length;
      const writtenAt = Date.now();
      writeFileSync(path.join(worktree, "after-retry.txt"), "retry\n");
      await waitFor(
        () =>
          retried.hints.slice(from).some((entry) => entry.hint?.paths?.includes("after-retry.txt")),
        10_000,
        "hint after retry",
      );
      report.helperRetry = {
        helpersSpawned: helpers.length,
        qualifiedMs: retryQualifiedMs,
        saveHintMs: retried.hints.at(-1)!.at - writtenAt,
      };

      // Failure 2: the watched root is removed. Record what the platform does.
      const rootErrorsBefore = retried.errors.length;
      const hintsBefore = retried.hints.length;
      const removedAt = Date.now();
      rmSync(worktree, { recursive: true, force: true });
      await sleep(3_000);
      report.rootRemoved = {
        errors: retried.errors.slice(rootErrorsBefore).map((entry) => ({
          code: entry.code,
          ms: entry.at - removedAt,
        })),
        hints: retried.hints.length - hintsBefore,
        watchingAfter: retried.watcher.watching,
      };
      // The same path made again (a recreated checkout): does the old watch
      // still report it?
      mkdirSync(worktree);
      await sleep(500);
      const recreatedFrom = retried.hints.length;
      const recreatedAt = Date.now();
      writeFileSync(path.join(worktree, "recreated.txt"), "again\n");
      await sleep(3_000);
      const recreatedHint = retried.hints.slice(recreatedFrom).at(0);
      report.rootRecreated = {
        hints: retried.hints.length - recreatedFrom,
        firstHintMs: recreatedHint ? recreatedHint.at - recreatedAt : null,
        watchingAfter: retried.watcher.watching,
      };
      retried.watcher.close();

      // Failure 3: a path that does not exist cannot be watched.
      const missing = new Probe(path.join(root, "missing"), startWatch);
      await sleep(1_000);
      report.missingRoot = {
        watching: missing.watcher.watching,
        errors: missing.errors.map((entry) => entry.code),
      };
      missing.watcher.close();
    }
    probe.watcher.close();
  } finally {
    host.stop();
    rmSync(root, { recursive: true, force: true });
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, json);
  }
  process.stdout.write(json);
}

if (import.meta.main) {
  await main();
}
