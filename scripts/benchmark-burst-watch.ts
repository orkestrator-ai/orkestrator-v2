/**
 * Whether a file burst written into many worktrees at once reaches each one's
 * worktree watcher, and how late (#2305).
 *
 * The busy driver (`scripts/recurring-live-ab-busy.ts`) writes `--files`
 * one-line files into every environment at once, waits for the backend to
 * rescan each, then removes them. On macOS its rescans ran out at 60 s from
 * round 2 on. This runs the same writes against `--count` Git repositories, each
 * under the backend's real `startWorktreeWatcher` (and so the macOS watch
 * helper, `watch-host.ts`), with no backend, and reports per round and per
 * repository:
 *
 * - `events`: named events the helper delivered for the repository;
 *   `unnamed`: events without a path (the helper's overflow); `lost`: the
 *   helper's "events lost" flags (to-do 7551).
 * - `hints`: settled hints the watcher reported; `coveredMs`: from the end of
 *   that repository's writes (or its removal) to the first hint reported after
 *   it, or `null` when none came within `--wait-ms`. A hint after the last write
 *   is what makes the owner's next scan count every file.
 *
 * Content-free: it records counts and times only. `--parent` must be on a
 * volume that delivers events (not macOS's system temporary directory).
 *
 *   bun scripts/benchmark-burst-watch.ts [--count=10] [--files=2500] [--rounds=5]
 *     [--wait-ms=60000] [--gap-ms=5000] [--parent=output/benchmarks] [--json]
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { watchDirectory } from "../apps/backend/src/core/watch-host";
import {
  startWorktreeWatcher,
  type WorktreeWatcher,
} from "../apps/backend/src/core/worktrees/watcher";
import { worktreeWatchPlanIo } from "../apps/backend/src/core/worktrees/watch-plan";

function arg(name: string, fallback: string): string {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} is ${min} to ${max}`);
  }
  return value;
}

const count = integer("count", 10, 1, 50);
const files = integer("files", 2_500, 1, 50_000);
const rounds = integer("rounds", 5, 1, 100);
const waitMs = integer("wait-ms", 60_000, 1_000, 600_000);
const gapMs = integer("gap-ms", 5_000, 0, 600_000);
const parent = path.resolve(arg("parent", path.join(import.meta.dir, "../output/benchmarks")));
const asJson = process.argv.includes("--json");

interface Tally {
  events: number;
  unnamed: number;
  lost: number;
  hints: number[];
}

interface PhaseResult {
  events: number;
  unnamed: number;
  lost: number;
  hints: number;
  coveredMs: number | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const git = (cwd: string, args: string[]) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", ...args],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
};

mkdirSync(parent, { recursive: true });
const root = realpathSync(mkdtempSync(path.join(parent, "burst-watch-")));
const watchers: WorktreeWatcher[] = [];
try {
  const tallies: Tally[] = [];
  const repositories = Array.from({ length: count }, (_, index) => {
    const repository = path.join(root, `repo-${index}`);
    mkdirSync(repository, { recursive: true });
    git(repository, ["init", "-q"]);
    writeFileSync(path.join(repository, "README.md"), "bench\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-q", "-m", "init"]);
    return repository;
  });

  const established: Promise<void>[] = [];
  repositories.forEach((repository, index) => {
    const tally: Tally = { events: 0, unnamed: 0, lost: 0, hints: [] };
    tallies.push(tally);
    let markReady!: () => void;
    established.push(new Promise<void>((resolve) => (markReady = resolve)));
    const watcher = startWorktreeWatcher({
      worktreePath: repository,
      plan: worktreeWatchPlanIo,
      startWatch: (target, listener, options) => {
        const handle = watchDirectory(
          target,
          (eventType, filename) => {
            if (filename === null) tally.unnamed += 1;
            else tally.events += 1;
            listener(eventType, filename);
          },
          options,
        );
        const onEventsLost = handle.onEventsLost?.bind(handle);
        if (onEventsLost) {
          handle.onEventsLost = (inner) =>
            onEventsLost(() => {
              tally.lost += 1;
              inner();
            });
        }
        return handle;
      },
      onChange: () => tally.hints.push(performance.now()),
      onCoverageChange: () => markReady(),
      onError: (error) => {
        throw error;
      },
    });
    watchers.push(watcher);
    void index;
  });
  const startedAt = performance.now();
  const ready = await Promise.race([
    Promise.all(established).then(() => true),
    sleep(waitMs).then(() => false),
  ]);
  const establishedMs = ready ? Math.round(performance.now() - startedAt) : null;
  // The hint each watch sends once it is established is not part of a round.
  await sleep(2_000);

  const snapshot = () => tallies.map((tally) => ({ ...tally, hints: tally.hints.length }));
  /** Waits until every repository has a hint after its end time, or the wait runs out. */
  const measure = async (endedAt: number[], before: ReturnType<typeof snapshot>) => {
    const deadline = performance.now() + waitMs;
    const covered = () =>
      tallies.every((tally, index) => tally.hints.some((at) => at >= endedAt[index]!));
    while (!covered() && performance.now() < deadline) await sleep(50);
    // Late events of this phase still count toward it.
    await sleep(1_000);
    return tallies.map((tally, index): PhaseResult => {
      const first = tally.hints.find((at) => at >= endedAt[index]!);
      return {
        events: tally.events - before[index]!.events,
        unnamed: tally.unnamed - before[index]!.unnamed,
        lost: tally.lost - before[index]!.lost,
        hints: tally.hints.length - before[index]!.hints,
        coveredMs:
          first === undefined || first - endedAt[index]! > waitMs
            ? null
            : Math.round(first - endedAt[index]!),
      };
    });
  };

  const results: Array<{ round: number; write: PhaseResult[]; remove: PhaseResult[] }> = [];
  for (let round = 1; round <= rounds; round += 1) {
    const relative = path.join("busy-burst", `round-${round}`);
    let before = snapshot();
    const writeEnded: number[] = [];
    for (const repository of repositories) {
      const directory = path.join(repository, relative);
      mkdirSync(directory, { recursive: true });
      for (let index = 0; index < files; index += 1) {
        writeFileSync(path.join(directory, `f-${index}.txt`), "busy\n");
      }
      writeEnded.push(performance.now());
    }
    const write = await measure(writeEnded, before);
    before = snapshot();
    const removeEnded: number[] = [];
    for (const repository of repositories) {
      rmSync(path.join(repository, relative), { recursive: true, force: true });
      removeEnded.push(performance.now());
    }
    const remove = await measure(removeEnded, before);
    results.push({ round, write, remove });
    if (!asJson) {
      const line = (phase: PhaseResult[]) =>
        phase.map((entry) => (entry.coveredMs === null ? "x" : String(entry.coveredMs))).join(",");
      console.log(
        `round ${round}: write covered [${line(write)}] events ${write.map((e) => e.events).join(",")} unnamed ${write.map((e) => e.unnamed).join(",")} lost ${write.map((e) => e.lost).join(",")}`,
      );
      console.log(
        `round ${round}: remove covered [${line(remove)}] events ${remove.map((e) => e.events).join(",")} unnamed ${remove.map((e) => e.unnamed).join(",")} lost ${remove.map((e) => e.lost).join(",")}`,
      );
    }
    if (round < rounds) await sleep(gapMs);
  }

  const phases = results.flatMap((entry) => [...entry.write, ...entry.remove]);
  const summary = {
    platform: process.platform,
    bun: Bun.version,
    repositories: count,
    files,
    rounds,
    waitMs,
    establishedMs,
    writeTimeouts: results.reduce(
      (sum, entry) => sum + entry.write.filter((item) => item.coveredMs === null).length,
      0,
    ),
    removeTimeouts: results.reduce(
      (sum, entry) => sum + entry.remove.filter((item) => item.coveredMs === null).length,
      0,
    ),
    coveredMaxMs: Math.max(0, ...phases.map((item) => item.coveredMs ?? 0)),
  };
  if (asJson) console.log(JSON.stringify({ summary, results }));
  else console.table(summary);
} finally {
  for (const watcher of watchers) watcher.close();
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
