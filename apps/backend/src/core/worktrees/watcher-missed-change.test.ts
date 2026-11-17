import { afterEach, expect, test } from "bun:test";
import {
  installControlledTimeout,
  type ControlledTimeout,
} from "../../../../../tests/helpers/controlled-timeout.js";
import { eventSink } from "../backend-emit.js";
import { SharedWatcherRegistry } from "../change-tracking/shared-physical-work.js";
import {
  DIFF_POLL_INTERVAL_MS,
  DIFF_SAFETY_NET_INTERVAL_MS,
  DiffStatsService,
} from "../diff-stats-service.js";
import { ManualTime } from "../recurring-test-support.js";
import { RecurringWorkMetrics } from "../recurring-work-metrics.js";
import type { WatchHandle } from "../watch-host.js";
import {
  startWorktreeWatcher,
  WATCH_DISTRUST_MS,
  type StartWatch,
  type WorktreeChangeHint,
  type WorktreeWatcher,
} from "./watcher.js";

/**
 * A safety scan that finds a change no hint announced (#2305). On a Mac
 * whose `fseventsd` has stopped delivering, a watcher receives nothing at all,
 * and its owner waited out the two-minute safety scan for every change. The
 * watcher now withdraws qualified coverage, so its owner polls, unless an
 * event shows it was only late, and earns it back by delivering again.
 */

/** The grace is the one timer at this delay; the settle window stays real. */
const GRACE_MS = 37;

const opened: WorktreeWatcher[] = [];
let grace: ControlledTimeout | undefined;
afterEach(() => {
  for (const watcher of opened.splice(0)) watcher.close();
  grace?.restore();
  grace = undefined;
});

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}

function mainCheckout() {
  grace = installControlledTimeout(GRACE_MS, { label: "missed-change grace" });
  let emit: (eventType: string, filename: string | null) => void = () => undefined;
  const failures = new Map<string, (error: Error) => void>();
  const start: StartWatch = (target, listener) => {
    emit = listener;
    const handle: WatchHandle = {
      on: (_event, onError) => {
        failures.set(target, onError);
        return handle;
      },
      close: () => undefined,
    };
    return handle;
  };
  let clock = 1_000;
  const hints: WorktreeChangeHint[] = [];
  // Whether the watcher was qualified when it told its owner "anything may
  // have changed": the owner starts its scan inside that call.
  const unknownChangeQualified: Array<boolean | undefined> = [];
  let coverageChanges = 0;
  let misses = 0;
  let current: WorktreeWatcher | undefined;
  const watcher = startWorktreeWatcher({
    worktreePath: "/wt",
    settleMs: 20,
    missGraceMs: GRACE_MS,
    distrustMs: 60_000,
    now: () => clock,
    startWatch: start,
    resolveGitPaths: async () => ({ gitDir: "/wt/.git", commonDir: "/wt/.git", linked: false }),
    onChange: (hint) => {
      if (hint) hints.push(hint);
      else unknownChangeQualified.push(current?.qualified);
    },
    onCoverageChange: () => {
      coverageChanges += 1;
    },
    onMissedChange: () => {
      misses += 1;
    },
  });
  current = watcher;
  opened.push(watcher);
  return {
    watcher,
    hints,
    unknownChangeQualified,
    emit: (filename: string | null) => emit("change", filename),
    /** The recursive root watch reports a directory below it it cannot read. */
    unreadable: (where: string) =>
      failures.get("/wt")?.(
        Object.assign(new Error(`EACCES: permission denied, watch '${where}'`), {
          code: "EPERM",
          path: where,
        }),
      ),
    advance: (ms: number) => {
      clock += ms;
    },
    coverageChanges: () => coverageChanges,
    misses: () => misses,
  };
}

test("a missed change no event explains withdraws coverage until the watcher delivers again", async () => {
  const context = mainCheckout();
  await until(() => context.watcher.qualified === true);
  expect(context.coverageChanges()).toBe(1);

  context.watcher.unannouncedChange?.();
  // Still trusted during the grace: the change may be settling.
  expect(context.watcher.qualified).toBe(true);
  expect(grace!.advance()).toBe(1);
  expect(context.misses()).toBe(1);
  expect(context.watcher.qualified).toBe(false);
  expect(context.watcher.watching).toBe(true);
  expect(context.coverageChanges()).toBe(2);

  // An event before the distrust window ends is still a hint, but not trust.
  context.advance(30_000);
  context.emit("src/a.ts");
  await until(() => context.hints.length === 1);
  expect(context.hints[0]?.paths).toEqual(["src/a.ts"]);
  expect(context.watcher.qualified).toBe(false);

  // The first event after it restores coverage.
  context.advance(30_000);
  context.emit("src/b.ts");
  expect(context.watcher.qualified).toBe(true);
  expect(context.coverageChanges()).toBe(3);
  await until(() => context.hints.length === 2);
  // The owner heard "anything may have changed" once, and the watcher already
  // counted as qualified then, so the scan it started is a trusted baseline.
  expect(context.unknownChangeQualified).toEqual([true]);
});

test("an unreadable directory found while distrusted keeps coverage withdrawn when trust returns", async () => {
  const context = mainCheckout();
  await until(() => context.watcher.qualified === true);
  context.watcher.unannouncedChange?.();
  expect(grace!.advance()).toBe(1);
  expect(context.watcher.qualified).toBe(false);
  expect(context.coverageChanges()).toBe(2);

  // An unreadable directory withdraws coverage for good, distrusted or not.
  context.unreadable("/wt/output/data");
  expect(context.watcher.watching).toBe(true);
  expect(context.coverageChanges()).toBe(3);

  // Trust returns, but coverage does not: the owner is still told anything may
  // have changed (the events went unannounced) and is not told coverage moved.
  context.advance(60_000);
  context.emit("src/b.ts");
  expect(context.watcher.qualified).toBe(false);
  expect(context.coverageChanges()).toBe(3);
  expect(context.unknownChangeQualified).toEqual([false]);
  await until(() => context.hints.length === 1);

  // Its misses prove nothing about delivery any more.
  context.watcher.unannouncedChange?.();
  expect(grace!.pendingCount()).toBe(0);
  expect(context.misses()).toBe(1);
});

// Distrust starts only from an owner's report. A watcher nobody reports a miss
// to (every test in worktree-watcher-real.test.ts) keeps the coverage it had
// before #2305 however late, sparse or absent its events are.
test("without a reported miss, late or absent events never withdraw coverage", async () => {
  const context = mainCheckout();
  await until(() => context.watcher.qualified === true);
  expect(context.coverageChanges()).toBe(1);

  // Silence for longer than the distrust window, then one late event.
  context.advance(10 * 60_000);
  expect(context.watcher.qualified).toBe(true);
  context.emit("src/late.ts");
  await until(() => context.hints.length === 1);
  context.advance(10 * 60_000);
  expect(context.watcher.qualified).toBe(true);

  expect(grace!.pendingCount()).toBe(0);
  expect(context.misses()).toBe(0);
  expect(context.coverageChanges()).toBe(1);
  expect(context.hints.map((hint) => hint.paths)).toEqual([["src/late.ts"]]);
});

test("a poll that finds a change before any event restarts the distrust", async () => {
  const context = mainCheckout();
  await until(() => context.watcher.qualified === true);
  context.watcher.unannouncedChange?.();
  expect(grace!.advance()).toBe(1);
  expect(context.watcher.qualified).toBe(false);

  // 50 s in, the owner's poll finds another change no event announced: the
  // late events of a saturated fseventsd must not earn trust back.
  context.advance(50_000);
  context.watcher.unannouncedChange?.();
  expect(grace!.advance()).toBe(1);
  // Reported once per spell of distrust, not per poll.
  expect(context.misses()).toBe(1);
  expect(context.coverageChanges()).toBe(2);

  // 60 s after the first miss, but only 10 s after the latest: still polling.
  context.advance(10_000);
  context.emit("src/late.ts");
  expect(context.watcher.qualified).toBe(false);
  await until(() => context.hints.length === 1);

  // A poll's change an event explains within the grace is forgiven.
  context.watcher.unannouncedChange?.();
  context.emit("src/seen.ts");
  expect(grace!.advance()).toBe(1);
  await until(() => context.hints.length === 2);

  // 60 s after the latest unforgiven miss, the first event restores coverage.
  context.advance(50_000);
  context.emit("src/b.ts");
  expect(context.watcher.qualified).toBe(true);
  expect(context.coverageChanges()).toBe(3);
});

test("a watcher not yet covering the tree ignores a change its owner found", async () => {
  const context = mainCheckout();
  // Git's paths are still being resolved, so nothing is covered yet.
  expect(context.watcher.qualified).toBe(false);
  context.watcher.unannouncedChange?.();
  expect(grace!.pendingCount()).toBe(0);
  await until(() => context.watcher.qualified === true);
  expect(context.misses()).toBe(0);
});

test("an event within the grace forgives the suspected miss", async () => {
  const context = mainCheckout();
  await until(() => context.watcher.qualified === true);
  context.watcher.unannouncedChange?.();
  context.emit(".git/objects/ab/cdef");
  expect(grace!.advance()).toBe(1);
  expect(context.misses()).toBe(0);
  expect(context.watcher.qualified).toBe(true);
  expect(context.coverageChanges()).toBe(1);
});

test("a burst still settling when the scan reports the change forgives it", async () => {
  const context = mainCheckout();
  await until(() => context.watcher.qualified === true);
  context.emit("src/a.ts");
  context.watcher.unannouncedChange?.();
  // Nothing to wait for: the settling burst is the watcher's own answer.
  expect(grace!.pendingCount()).toBe(0);
  await until(() => context.hints.length === 1);
  expect(context.misses()).toBe(0);
  expect(context.watcher.qualified).toBe(true);
});

test("closing during the grace decides nothing", async () => {
  const context = mainCheckout();
  await until(() => context.watcher.qualified === true);
  context.watcher.unannouncedChange?.();
  expect(grace!.pendingCount()).toBe(1);
  context.watcher.close();
  expect(grace!.pendingCount()).toBe(0);
  expect(context.misses()).toBe(0);
  expect(context.coverageChanges()).toBe(1);
});

/**
 * The real watcher behind the shared registry inside the real scan owner, on
 * one manual clock: a miss moves the entry from the safety scan to polling and
 * back, and a file tree cached under the earlier qualified coverage is not
 * served again once trust returns on an event no view cares about.
 */
function scanOwnerWithRealWatcher() {
  grace = installControlledTimeout(GRACE_MS, { label: "missed-change grace" });
  const time = new ManualTime(1_000_000);
  let emit: (eventType: string, filename: string | null) => void = () => undefined;
  const start: StartWatch = (_target, listener) => {
    emit = listener;
    const handle: WatchHandle = { on: () => handle, close: () => undefined };
    return handle;
  };
  const registry = new SharedWatcherRegistry((options) =>
    startWorktreeWatcher({
      ...options,
      settleMs: 20,
      missGraceMs: GRACE_MS,
      distrustMs: WATCH_DISTRUST_MS,
      now: time.now,
      startWatch: start,
      resolveGitPaths: async () => ({ gitDir: "/wt/.git", commonDir: "/wt/.git", linked: false }),
    }),
  );
  const intervals: number[] = [];
  const warnings: string[] = [];
  let files = ["old.txt"];
  let tree = ["old.txt"];
  let walks = 0;
  const service = new DiffStatsService({
    scan: async () => ({
      stats: {
        additions: files.length,
        deletions: 0,
        filesChanged: files.length,
        truncated: false,
      },
      changes: files.map((path) => ({ path, status: "M", additions: 1, deletions: 0 })),
    }),
    walkTree: async () => {
      walks += 1;
      return tree.map((name) => ({ name, path: name, isDirectory: false }));
    },
    emit: eventSink(() => undefined),
    startWatcher: registry.startWatcher,
    onWarning: (warning) => warnings.push(warning.event),
    metrics: new RecurringWorkMetrics({ enabled: false }),
    localScanMinGapMs: 0,
    now: () => new Date(time.now()).toISOString(),
    monotonicNow: time.now,
    schedule: (callback, intervalMs) => {
      intervals.push(intervalMs);
      return time.setInterval(callback, intervalMs);
    },
    cancel: (timer) => time.clear(timer),
    delay: (callback, delayMs) => time.setTimeout(callback, delayMs),
    cancelDelay: (timer) => time.clear(timer),
  });
  services.push(service);
  const lookup = { worktreePath: "/wt" };
  return {
    time,
    service,
    intervals,
    warnings,
    emit: (filename: string) => emit("change", filename),
    readTree: async () => (await service.readTree({ lookup })).tree as Array<{ name: string }>,
    setFiles: (next: string[]) => {
      files = next;
    },
    setTree: (next: string[]) => {
      tree = next;
    },
    walks: () => walks,
  };
}

const services: DiffStatsService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.shutdown();
});

test("trust regained on an ignored event reconciles the views cached before the miss", async () => {
  const owner = scanOwnerWithRealWatcher();
  owner.service.track({
    environmentId: "env-local",
    kind: "local",
    worktreePath: "/wt",
    comparisonRef: "main",
  });
  await until(() => owner.intervals.at(-1) === DIFF_SAFETY_NET_INTERVAL_MS);

  // A safety scan under qualified coverage; the next one finds a change no
  // event announced.
  await owner.time.advance(DIFF_SAFETY_NET_INTERVAL_MS);
  owner.setFiles(["old.txt", "missed.ts"]);
  await owner.time.advance(DIFF_SAFETY_NET_INTERVAL_MS);

  // The Files panel walks the tree during the grace, still under qualified
  // coverage, so the walk is cached as covered by this watcher.
  expect((await owner.readTree()).map((entry) => entry.name)).toEqual(["old.txt"]);
  expect(owner.walks()).toBe(1);

  // After the grace the watcher withdraws coverage and the entry polls.
  expect(grace!.advance()).toBe(1);
  expect(owner.warnings).toContain("scan.watcher-missed-change");
  expect(owner.service.isWatching("env-local")).toBe(true);
  expect(owner.intervals.at(-1)).toBe(DIFF_POLL_INTERVAL_MS);

  // While distrusted, a Git-invisible file appears without any event, and the
  // quiet polls give the watcher no further miss.
  owner.setTree(["old.txt", "ignored-generated.txt"]);
  await owner.time.advance(WATCH_DISTRUST_MS + 1);
  expect(grace!.pendingCount()).toBe(0);
  expect(owner.intervals.at(-1)).toBe(DIFF_POLL_INTERVAL_MS);

  // Trust returns on a Git object write, which no view cares about. The tree
  // cached under the earlier coverage must not count as valid again.
  owner.emit(".git/objects/ab/cdef");
  expect(owner.intervals.at(-1)).toBe(DIFF_SAFETY_NET_INTERVAL_MS);
  await owner.time.advance(0);
  expect((await owner.readTree()).map((entry) => entry.name)).toEqual([
    "old.txt",
    "ignored-generated.txt",
  ]);
  expect(owner.walks()).toBe(2);

  // The scan that reconciled the views ran under restored coverage, so it is
  // the baseline the next safety scan compares with: a change missed after
  // recovery demotes the watcher again rather than being absorbed.
  owner.setFiles(["old.txt", "missed.ts", "missed-after-recovery.ts"]);
  await owner.time.advance(DIFF_SAFETY_NET_INTERVAL_MS);
  expect(grace!.advance()).toBe(1);
  expect(owner.warnings.filter((event) => event === "scan.watcher-missed-change")).toHaveLength(2);
  expect(owner.intervals.at(-1)).toBe(DIFF_POLL_INTERVAL_MS);
});
