import { expect, test } from "bun:test";
import {
  PrMonitorService,
  type PrDetection,
  type PrMonitorDetectionOptions,
  type PrMonitorTarget,
} from "../src/core/pr-monitor";
import { DEFAULT_PR_MONITOR_POLICY } from "../src/core/pr-monitor-policy";

/**
 * Quiet-PR backoff (to-do 1202 task 9, BG-6): an open PR whose reading has
 * not moved for `quietAfterMs`, with no pending checks and no auto-merge, is
 * polled at the quiet cadence; any activity or wake returns it to 20 s.
 */

const QUIET = DEFAULT_PR_MONITOR_POLICY.quietIntervalMs;
const PR = "https://github.com/org/repo/pull/1";

function harness(initial: Partial<PrMonitorTarget> = {}) {
  const clock = { value: 1_000_000 };
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  let nextTimer = 1;
  const options: PrMonitorDetectionOptions[] = [];
  let reading: Partial<PrDetection> = {};
  const service = new PrMonitorService({
    emit: () => undefined,
    now: () => new Date(clock.value).toISOString(),
    monotonicNow: () => clock.value,
    random: () => 0,
    schedule: (callback, delayMs) => {
      const id = nextTimer++;
      timers.set(id, { callback, delayMs });
      return id;
    },
    cancel: (timer) => {
      timers.delete(timer as number);
    },
    effects: {
      detect: async (_target, detectOptions) => {
        options.push(detectOptions);
        const checkSummary = { passed: 1, total: 1, pending: 0 };
        return {
          url: PR,
          state: "open",
          hasMergeConflicts: false,
          headSha: "a".repeat(40),
          updatedAt: "2026-11-03T00:00:00Z",
          autoMergeRequested: false,
          checkSummary: detectOptions.includeCheckSummary ? checkSummary : null,
          checkSummaryStatus: detectOptions.includeCheckSummary ? "succeeded" : "skipped",
          ...reading,
        };
      },
      persistPr: async () => undefined,
      clearPr: async () => undefined,
      findTaskForEnvironment: async () => null,
      moveTaskToReview: async () => undefined,
      addTaskComment: async () => undefined,
      updateTaskPrMetadata: async () => undefined,
    },
  });
  const target: PrMonitorTarget = {
    environmentId: "env-1",
    branch: "feature",
    kind: "local",
    worktreePath: "/tmp/worktree",
    ready: true,
    prUrl: PR,
    prState: "open",
    hasMergeConflicts: false,
    ...initial,
  };
  service.sync([target]);
  const flush = async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  };
  return {
    service,
    clock,
    options,
    target,
    setReading: (value: Partial<PrDetection>) => {
      reading = value;
    },
    pendingDelay: () => [...timers.values()][0]?.delayMs,
    /** Advances the clock by the pending delay and runs the check. */
    fire: async () => {
      const [id, timer] = [...timers.entries()][0]!;
      timers.delete(id);
      clock.value += timer.delayMs;
      timer.callback();
      await flush();
    },
    /** Polls until the PR has been unchanged for the quiet threshold. */
    settle: async function (this: void) {
      const start = clock.value;
      while (clock.value - start <= DEFAULT_PR_MONITOR_POLICY.quietAfterMs + 20_000) {
        const [id, timer] = [...timers.entries()][0]!;
        timers.delete(id);
        clock.value += timer.delayMs;
        timer.callback();
        await flush();
      }
    },
    flush,
  };
}

test("an unchanged open PR drops to the quiet cadence after the quiet threshold", async () => {
  const monitor = harness();
  await monitor.fire();
  expect(monitor.pendingDelay()).toBe(20_000);
  await monitor.settle();
  expect(monitor.pendingDelay()).toBe(QUIET);
});

test("a background poll may share a reading; a wake or pending intent asks fresh", async () => {
  const monitor = harness();
  await monitor.fire();
  expect(monitor.options.at(-1)?.fresh).toBeUndefined();
  monitor.service.requestCheck("env-1", "interactive");
  await monitor.fire();
  expect(monitor.options.at(-1)?.fresh).toBe(true);
  monitor.service.requestMode(monitor.target, "merge-pending");
  await monitor.fire();
  expect(monitor.options.at(-1)?.fresh).toBe(true);
});

test("a new updatedAt brings a quiet PR back to the normal cadence", async () => {
  const monitor = harness();
  await monitor.settle();
  expect(monitor.pendingDelay()).toBe(QUIET);
  monitor.setReading({ updatedAt: "2026-11-03T05:00:00Z" });
  await monitor.fire();
  expect(monitor.pendingDelay()).toBe(20_000);
});

test("pending checks keep the normal cadence however long nothing else moves", async () => {
  const monitor = harness();
  monitor.setReading({
    checkSummary: { passed: 0, total: 1, pending: 1 },
    checkSummaryStatus: "succeeded",
  });
  await monitor.settle();
  expect(monitor.pendingDelay()).toBe(20_000);
});

test("a failed rollup is not proof that nothing is pending", async () => {
  const monitor = harness();
  monitor.setReading({ checkSummary: null, checkSummaryStatus: "failed" });
  await monitor.settle();
  expect(monitor.pendingDelay()).toBe(20_000);
});

test("auto-merge, Orkestrator's or GitHub's, keeps the normal cadence", async () => {
  const orkestrator = harness({ autoMerge: true });
  await orkestrator.settle();
  expect(orkestrator.pendingDelay()).toBe(20_000);

  const github = harness();
  github.setReading({ autoMergeRequested: true });
  await github.settle();
  expect(github.pendingDelay()).toBe(20_000);

  const unknown = harness();
  unknown.setReading({ autoMergeRequested: undefined });
  await unknown.settle();
  expect(unknown.pendingDelay()).toBe(20_000);
});

test("turning auto-merge on leaves the quiet wait at once", async () => {
  const monitor = harness();
  await monitor.settle();
  expect(monitor.pendingDelay()).toBe(QUIET);
  monitor.service.sync([{ ...monitor.target, autoMerge: true }]);
  expect(monitor.pendingDelay()).toBe(20_000);
});

test("unknown mergeability keeps the normal cadence", async () => {
  const monitor = harness({ hasMergeConflicts: null });
  monitor.setReading({ hasMergeConflicts: null });
  await monitor.settle();
  expect(monitor.pendingDelay()).toBe(20_000);
});

test("a wake resets the quiet clock", async () => {
  const monitor = harness();
  await monitor.settle();
  monitor.service.requestCheck("env-1", "completion");
  expect(monitor.pendingDelay()).toBe(0);
  await monitor.fire();
  expect(monitor.pendingDelay()).toBe(20_000);
});

test("a change seen in a shared reading re-reads a quiet PR at once, as a background check", async () => {
  const monitor = harness();
  await monitor.settle();
  expect(monitor.pendingDelay()).toBe(QUIET);
  monitor.service.noteSharedActivity("env-1");
  expect(monitor.pendingDelay()).toBe(0);
  monitor.setReading({ updatedAt: "2026-11-03T06:00:00Z" });
  await monitor.fire();
  expect(monitor.options.at(-1)?.fresh).toBeUndefined();
  expect(monitor.pendingDelay()).toBe(20_000);
});

test("a shared-reading change leaves an entry on the normal cadence alone", async () => {
  const monitor = harness();
  await monitor.fire();
  monitor.service.noteSharedActivity("env-1");
  expect(monitor.pendingDelay()).toBe(20_000);
});

test("sync replacement clears quiet knowledge before reading the new PR", async () => {
  const monitor = harness();
  await monitor.settle();
  expect(monitor.pendingDelay()).toBe(QUIET);
  const replacement = "https://github.com/org/repo/pull/2";
  monitor.service.sync([{ ...monitor.target, prUrl: replacement }]);
  expect(monitor.pendingDelay()).toBe(20_000);
  monitor.setReading({
    url: replacement,
    updatedAt: undefined,
    autoMergeRequested: undefined,
    checkSummary: null,
    checkSummaryStatus: "skipped",
  });
  await monitor.settle();
  expect(monitor.pendingDelay()).toBe(20_000);
  // A successful rollup alone does not supply GitHub auto-merge knowledge.
  monitor.setReading({ url: replacement, autoMergeRequested: undefined });
  await monitor.settle();
  expect(monitor.pendingDelay()).toBe(20_000);
  monitor.setReading({ url: replacement, autoMergeRequested: false });
  await monitor.settle();
  expect(monitor.pendingDelay()).toBe(QUIET);
});
