import { afterEach, expect, test } from "bun:test";
import {
  installControlledTimeout,
  type ControlledTimeout,
} from "../../../../tests/helpers/controlled-timeout.js";
import type { WatchHandle } from "./watch-host.js";
import {
  startWorktreeWatcher,
  type StartWatch,
  type WorktreeChangeHint,
  type WorktreeWatcher,
} from "./worktree-watcher.js";

/**
 * A safety scan that finds a change no hint announced (to-do 8171). On a Mac
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
  const start: StartWatch = (_target, listener) => {
    emit = listener;
    const handle: WatchHandle = { on: () => handle, close: () => undefined };
    return handle;
  };
  let clock = 1_000;
  const hints: WorktreeChangeHint[] = [];
  let coverageChanges = 0;
  let misses = 0;
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
    },
    onCoverageChange: () => {
      coverageChanges += 1;
    },
    onMissedChange: () => {
      misses += 1;
    },
  });
  opened.push(watcher);
  return {
    watcher,
    hints,
    emit: (filename: string | null) => emit("change", filename),
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
