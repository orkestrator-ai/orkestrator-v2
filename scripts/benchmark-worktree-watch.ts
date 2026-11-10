/**
 * Worktree watcher benchmark (docs/architecture/git-scan-caches.md).
 *
 * Builds the named workload, then runs `startWorktreeWatcher` against it and
 * reports what the watch holds and how much of an install reaches it. Run one
 * mode per process, so that one mode's watches cannot affect the other's counts.
 * Results are local measurements, not guarantees.
 *
 * Workload `watch-nm-4k`: a linked worktree with 164 tracked directories, an
 * ignored top-level `node_modules` of 4,000 package directories and a nested
 * `packages/app/node_modules` of 400, five files in each. The install writes 500
 * new directories of four files into the top-level `node_modules`.
 *
 * `--mode=before` watches the whole root, which is what every worktree did before
 * this plan. `--mode=after` is what runs now. `--mode=split` forces the Linux
 * plan (a non-recursive root and a recursive watch per other child) on any
 * platform, which is how macOS would avoid callbacks from `node_modules`. On
 * Linux the inotify watch count is read from `/proc/self/fdinfo`. `--host` starts
 * watches through `watchDirectory`, which is what the backend does: on macOS they
 * run in the helper process (`watch-host.ts`) and callbacks are the events that
 * cross back from it. `--parent` must
 * be on a volume that delivers events (not macOS's system temporary directory).
 *
 *   bun scripts/benchmark-worktree-watch.ts --mode=after [--parent=output/benchmarks] [--json]
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { observeCommandInvocations } from "../apps/backend/src/core/shell";
import { watchDirectory } from "../apps/backend/src/core/watch-host";
import { worktreeWatchPlanIo } from "../apps/backend/src/core/worktree-watch-plan";
import { startWorktreeWatcher } from "../apps/backend/src/core/worktree-watcher";

function arg(name: string, fallback: string): string {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

const mode = arg("mode", "after");
if (mode !== "before" && mode !== "after" && mode !== "split")
  throw new Error(`unknown --mode=${mode}`);
const parent = path.resolve(arg("parent", path.join(import.meta.dir, "../output/benchmarks")));
const deliveryDeadlineMs = Number(arg("deadline-ms", "120000"));
const asJson = process.argv.includes("--json");
const throughHost = process.argv.includes("--host");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=b@e", "-c", "user.name=b", ...args], { cwd });
}

function fill(base: string, directories: number, files: number): void {
  for (let index = 0; index < directories; index += 1) {
    const directory = path.join(base, `scope-${index % 50}`, `pkg-${index}`);
    mkdirSync(directory, { recursive: true });
    for (let file = 0; file < files; file += 1) {
      writeFileSync(path.join(directory, `f${file}.js`), "x");
    }
  }
}

function inotifyWatches(): number | null {
  if (process.platform !== "linux") return null;
  let total = 0;
  for (const fd of readdirSync("/proc/self/fdinfo")) {
    try {
      total += readFileSync(`/proc/self/fdinfo/${fd}`, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("inotify wd:")).length;
    } catch {
      // The descriptor closed while this read it.
    }
  }
  return total;
}

mkdirSync(parent, { recursive: true });
const root = realpathSync(mkdtempSync(path.join(parent, "watch-nm-4k-")));
try {
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fill(path.join(repo, "src"), 40, 5);
  fill(path.join(repo, "packages/app/src"), 40, 5);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "initial");
  const worktree = path.join(root, "worktree");
  git(repo, "worktree", "add", "-q", worktree, "-b", "feature");
  fill(path.join(worktree, "node_modules"), 4_000, 5);
  fill(path.join(worktree, "packages/app/node_modules"), 400, 5);

  let gitProcesses = 0;
  const stopObserving = observeCommandInvocations("git", () => {
    gitProcesses += 1;
  });
  let callbacks = 0;
  // Time spent in the watcher's own listener, on this thread.
  let listenerMs = 0;
  const timed =
    (listener: (eventType: string, name: string | null) => void) =>
    (eventType: string, name: string | null) => {
      callbacks += 1;
      const at = performance.now();
      listener(eventType, name);
      listenerMs += performance.now() - at;
    };
  let watches = 0;
  let hints = 0;
  let overflows = 0;
  const seen = new Set<string>();
  const inotifyBefore = inotifyWatches();
  const startedAt = performance.now();
  const watcher = startWorktreeWatcher({
    worktreePath: worktree,
    comparisonRef: "main",
    plan: mode === "before" ? null : worktreeWatchPlanIo,
    ...(mode === "split" ? { perDirectoryWatches: true } : {}),
    startWatch: (target, listener, options) => {
      watches += 1;
      if (throughHost) {
        return watchDirectory(target, timed(listener), options);
      }
      const forward = timed(listener);
      return watch(target, { recursive: options.recursive, persistent: false }, (eventType, name) =>
        forward(eventType, name ?? null),
      );
    },
    onChange: (hint) => {
      hints += 1;
      if (hint?.overflow) overflows += 1;
      for (const name of hint?.paths ?? []) seen.add(name);
    },
  });
  const startCallMs = performance.now() - startedAt;

  const until = async (condition: () => boolean, label: string) => {
    const deadline = Date.now() + deliveryDeadlineMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await sleep(25);
    }
  };
  await until(() => watcher.qualified === true, "coverage");
  const coveredMs = performance.now() - startedAt;

  // Distinct writes until one is reported: the watch is live from here on. Each
  // write waits up to 2 s, polled every 25 ms, so the first write's delay is a
  // delivery time (event plus the settle) rather than a multiple of the wait.
  const writeUntilSeen = async (name: string) => {
    const deadline = Date.now() + deliveryDeadlineMs;
    const firstAt = performance.now();
    for (let attempt = 1; ; attempt += 1) {
      const relative = `src/${name}-${attempt}.txt`;
      writeFileSync(path.join(worktree, relative), "x");
      const waitUntil = Date.now() + 2_000;
      while (Date.now() < waitUntil) {
        if ([...seen].some((entry) => entry.startsWith(`src/${name}-`))) {
          return { attempts: attempt, ms: Math.round(performance.now() - firstAt) };
        }
        await sleep(25);
      }
      if (Date.now() > deadline) throw new Error(`no event for ${name}`);
    }
  };
  const live = await writeUntilSeen("live");
  await sleep(1_000);
  const inotifyAfterStart = inotifyWatches();
  const quiet = { callbacks, hints, gitProcesses, listenerMs };

  const installAt = performance.now();
  fill(path.join(worktree, "node_modules/new-install"), 500, 4);
  const installMs = performance.now() - installAt;
  // Delivered in order, so the sentinel's arrival means the install's has too.
  const sentinel = await writeUntilSeen("sentinel");
  await sleep(1_000);

  const closeAt = performance.now();
  watcher.close();
  const closeMs = performance.now() - closeAt;
  stopObserving();

  const result = {
    workload: "watch-nm-4k",
    mode,
    host: throughHost,
    platform: process.platform,
    bun: Bun.version,
    watchHandles: watches,
    inotifyWatches: inotifyAfterStart === null ? null : inotifyAfterStart - (inotifyBefore ?? 0),
    startCallMs: Math.round(startCallMs),
    qualifiedMs: Math.round(coveredMs),
    closeMs: Math.round(closeMs),
    installMs: Math.round(installMs),
    installCallbacks: callbacks - quiet.callbacks,
    installListenerMs: Number((listenerMs - quiet.listenerMs).toFixed(1)),
    installHints: hints - quiet.hints,
    overflows,
    planGitProcesses: quiet.gitProcesses,
    firstWriteAttempts: live.attempts,
    firstWriteSeenMs: live.ms,
    sentinelAttempts: sentinel.attempts,
    sentinelSeenMs: sentinel.ms,
  };
  if (asJson) console.log(JSON.stringify(result));
  else console.table(result);
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
