/**
 * What extra recursive watches cost one process (to-do 5060, task 3).
 *
 * Bun keeps every directory watch of a process in one FSEvents stream on macOS,
 * and each `fs.watch` or `close()` rebuilds it (`watch-host.ts`). This measures
 * what a split watch plan would add per worktree there:
 *
 * - **Start and close.** `--count` recursive watches on sibling directories are
 *   started in one process, each call timed on the JavaScript thread; one file
 *   is written in each directory and its event's delay reported; then all are
 *   closed, each call timed.
 * - **Churn.** A watch that is already live gets a numbered file every 10 ms
 *   while the `--count` watches are started and closed `--churn` more times.
 *   `steadyLost` counts the numbered files never reported, against
 *   `controlLost` for the same writes with no churn.
 *
 * - **`--host`.** Every watch goes through the backend's helper process
 *   (`WatchHost`) instead of this process's own `fs.watch`. The live watch then
 *   also records the helper's "events lost" flags (to-do 7551), and
 *   `steadyUncovered` counts the lost files that no flag arrived for within a
 *   second of the write: the changes an owner would still learn of only at its
 *   next event or safety scan.
 *
 * Linux has no shared stream, so there it is a control. Results are local
 * measurements, not guarantees. `--parent` must be on a volume that delivers
 * events (not macOS's system temporary directory).
 *
 *   bun scripts/benchmark-recursive-watch-stall.ts --count=20 [--churn=10] [--host] [--parent=output/benchmarks] [--json]
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { WatchHost } from "../apps/backend/src/core/watch-host";

interface Watch {
  close(): void;
}

function arg(name: string, fallback: string): string {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

const count = Number(arg("count", "20"));
if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error("--count is 1 to 500");
const churnRounds = Number(arg("churn", "10"));
if (!Number.isInteger(churnRounds) || churnRounds < 0 || churnRounds > 100) {
  throw new Error("--churn is 0 to 100");
}
const parent = path.resolve(arg("parent", path.join(import.meta.dir, "../output/benchmarks")));
const deliveryDeadlineMs = Number(arg("deadline-ms", "30000"));
const asJson = process.argv.includes("--json");
const throughHost = process.argv.includes("--host");
const host = throughHost ? new WatchHost() : null;

/** Opens a recursive watch here or in the helper; `onLost` hears the helper's flag. */
function open(
  directory: string,
  listener: (name: string | null) => void,
  onLost?: () => void,
): Watch {
  if (host) {
    const handle = host.watch(directory, (_type, name) => listener(name), { recursive: true });
    if (onLost) handle.onEventsLost?.(onLost);
    return handle;
  }
  return watch(directory, { recursive: true, persistent: false }, (_type, name) =>
    listener(name === null ? null : String(name)),
  );
}

/** One flag can only cover writes made before it, and only soon before it. */
const FLAG_COVERS_MS = 1_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const round = (value: number) => Math.round(value);

mkdirSync(parent, { recursive: true });
const root = realpathSync(mkdtempSync(path.join(parent, "watch-stall-")));
const watchers = new Set<Watch>();
try {
  const directories = Array.from({ length: count }, (_, index) => {
    const directory = path.join(root, `entry-${index}`);
    mkdirSync(path.join(directory, "nested"), { recursive: true });
    writeFileSync(path.join(directory, "nested", "seed.txt"), "x");
    return directory;
  });

  const seenAt = new Map<number, number>();
  const startAll = () => {
    const times: number[] = [];
    const opened = directories.map((directory, index) => {
      const at = performance.now();
      const watcher = open(directory, (name) => {
        if (String(name ?? "").includes("probe") && !seenAt.has(index)) {
          seenAt.set(index, performance.now());
        }
      });
      times.push(performance.now() - at);
      watchers.add(watcher);
      return watcher;
    });
    return { opened, times };
  };
  const closeAll = (opened: Watch[]) =>
    opened.map((watcher) => {
      const at = performance.now();
      watcher.close();
      watchers.delete(watcher);
      return performance.now() - at;
    });

  // 1. Start, deliver, close.
  const started = startAll();
  await sleep(1_000);
  const writtenAt = new Map<number, number>();
  directories.forEach((directory, index) => {
    writtenAt.set(index, performance.now());
    writeFileSync(path.join(directory, "nested", "probe.txt"), "y");
  });
  const deadline = Date.now() + deliveryDeadlineMs;
  while (seenAt.size < count && Date.now() < deadline) await sleep(10);
  const delivery = [...seenAt]
    .map(([index, at]) => at - writtenAt.get(index)!)
    .sort((left, right) => left - right);
  const closeTimes = closeAll(started.opened);

  // 2. A live watch written to, first alone, then while the others churn.
  const steady = path.join(root, "steady");
  mkdirSync(steady);
  const steadySeen = new Set<string>();
  const lostFlags: number[] = [];
  const steadyWatcher = open(
    steady,
    (name) => {
      if (name) steadySeen.add(name);
    },
    () => lostFlags.push(performance.now()),
  );
  watchers.add(steadyWatcher);
  await sleep(1_000);
  const writeSteady = async (prefix: string, during: () => Promise<void>) => {
    let written = 0;
    const writtenAt: number[] = [];
    const flagsBefore = lostFlags.length;
    const timer = setInterval(() => {
      writtenAt.push(performance.now());
      writeFileSync(path.join(steady, `${prefix}-${written}.txt`), "x");
      written += 1;
    }, 10);
    await during();
    clearInterval(timer);
    // Time for the last writes to be reported.
    await sleep(3_000);
    const flags = lostFlags.slice(flagsBefore);
    let lost = 0;
    let uncovered = 0;
    for (let index = 0; index < written; index += 1) {
      if (steadySeen.has(`${prefix}-${index}.txt`)) continue;
      lost += 1;
      const at = writtenAt[index]!;
      if (!flags.some((flag) => flag >= at && flag - at <= FLAG_COVERS_MS)) uncovered += 1;
    }
    return { written, lost, uncovered, flags: flags.length };
  };
  const churnMs = churnRounds * 200;
  const control = await writeSteady("control", () => sleep(churnMs));
  const churnStart: number[] = [];
  const churnClose: number[] = [];
  const churn = await writeSteady("churn", async () => {
    for (let index = 0; index < churnRounds; index += 1) {
      const opened = startAll();
      churnStart.push(opened.times.reduce((sum, value) => sum + value, 0));
      await sleep(100);
      churnClose.push(closeAll(opened.opened).reduce((sum, value) => sum + value, 0));
      await sleep(100);
    }
  });

  const result = {
    platform: process.platform,
    bun: Bun.version,
    through: host ? "helper" : "process",
    watches: count,
    startTotalMs: round(started.times.reduce((sum, value) => sum + value, 0)),
    startLongestMs: round(Math.max(...started.times)),
    closeTotalMs: round(closeTimes.reduce((sum, value) => sum + value, 0)),
    closeLongestMs: round(Math.max(...closeTimes)),
    delivered: seenAt.size,
    deliveryP50Ms: delivery.length ? round(delivery[Math.floor(delivery.length / 2)]!) : null,
    deliveryMaxMs: delivery.length ? round(delivery[delivery.length - 1]!) : null,
    churnRounds,
    churnStartMaxMs: churnStart.length ? round(Math.max(...churnStart)) : null,
    churnCloseMaxMs: churnClose.length ? round(Math.max(...churnClose)) : null,
    controlWritten: control.written,
    controlLost: control.lost,
    steadyWritten: churn.written,
    steadyLost: churn.lost,
    ...(host
      ? {
          controlLostFlags: control.flags,
          steadyLostFlags: churn.flags,
          steadyUncovered: churn.uncovered,
        }
      : {}),
  };
  if (asJson) console.log(JSON.stringify(result));
  else console.table(result);
} finally {
  for (const watcher of watchers) watcher.close();
  host?.stop();
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
