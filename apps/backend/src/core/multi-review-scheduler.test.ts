import { describe, expect, spyOn, test } from "bun:test";
import { WorkflowDueScheduler, stableJitterMs } from "./multi-review-scheduler.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await sleep(2);
  }
}

describe("due-time workflow scheduler", () => {
  test("a slow pass never triggers a catch-up pass", async () => {
    const starts: number[] = [];
    let active = false;
    const scheduler = new WorkflowDueScheduler({
      run: async () => {
        active = true;
        starts.push(Date.now());
        await sleep(60);
        active = false;
      },
      // Due 10 ms after completion; the pass itself takes 60 ms.
      nextDueAt: async () => Date.now() + 10,
      discover: async () => ["w1"],
      reconcileIntervalMs: 60_000,
      maxConcurrent: 4,
    });
    scheduler.start();
    await waitFor(() => starts.length >= 3);
    await scheduler.stop();
    expect(active).toBe(false);
    for (let index = 1; index < starts.length; index++) {
      // Each start follows the previous one's completion plus the delay.
      expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(65);
    }
  });

  test("many wakes during one pass cause at most one rerun", async () => {
    let runs = 0;
    const gate: { release?: () => void } = {};
    const scheduler = new WorkflowDueScheduler({
      run: async () => {
        runs += 1;
        if (runs === 1) await new Promise<void>((resolve) => (gate.release = resolve));
      },
      nextDueAt: async () => undefined,
      discover: async () => ["w1"],
      reconcileIntervalMs: 60_000,
      maxConcurrent: 4,
    });
    scheduler.start();
    await waitFor(() => runs === 1 && gate.release !== undefined);
    for (let wake = 0; wake < 10; wake++) scheduler.wake("w1");
    gate.release!();
    await waitFor(() => runs === 2);
    await sleep(30);
    await scheduler.stop();
    expect(runs).toBe(2);
  });

  test("reconciliation discovers workflows and forgets finished ones", async () => {
    let supervised = ["w1", "w2"];
    const runs = new Map<string, number>();
    const scheduler = new WorkflowDueScheduler({
      run: async (workflowId) => {
        runs.set(workflowId, (runs.get(workflowId) ?? 0) + 1);
      },
      nextDueAt: async (workflowId) =>
        supervised.includes(workflowId) ? Date.now() + 5 : undefined,
      discover: async () => supervised,
      reconcileIntervalMs: 20,
      maxConcurrent: 4,
    });
    scheduler.start();
    await waitFor(() => (runs.get("w1") ?? 0) > 0 && (runs.get("w2") ?? 0) > 0);
    supervised = ["w1"];
    await sleep(60);
    const w2Runs = runs.get("w2")!;
    await sleep(60);
    await scheduler.stop();
    expect(runs.get("w2")).toBe(w2Runs);
    expect(scheduler.scheduledCount).toBe(0);
  });

  test("the concurrency cap is shared fairly across due workflows", async () => {
    let active = 0;
    let maxActive = 0;
    const completed = new Set<string>();
    const ids = Array.from({ length: 10 }, (_, index) => `w${index}`);
    const scheduler = new WorkflowDueScheduler({
      run: async (workflowId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(10);
        active -= 1;
        completed.add(workflowId);
      },
      nextDueAt: async () => undefined,
      discover: async () => ids,
      reconcileIntervalMs: 60_000,
      maxConcurrent: 3,
    });
    scheduler.start();
    await waitFor(() => completed.size === ids.length);
    await scheduler.stop();
    expect(maxActive).toBe(3);
  });

  test("a due workflow waits without spinning while the only slot is occupied", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started: string[] = [];
    const timer = spyOn(globalThis, "setTimeout");
    const scheduler = new WorkflowDueScheduler({
      run: async (workflowId) => {
        started.push(workflowId);
        if (workflowId === "first") await gate;
      },
      nextDueAt: async () => undefined,
      discover: async () => ["first", "second"],
      reconcileIntervalMs: 60_000,
      maxConcurrent: 1,
    });
    try {
      scheduler.start();
      await waitFor(() => started.length === 1);
      const zeroTimers = () => timer.mock.calls.filter((call) => call[1] === 0).length;
      const before = zeroTimers();
      await sleep(30);
      expect(started).toEqual(["first"]);
      expect(zeroTimers() - before).toBeLessThanOrEqual(1);
      release();
      await waitFor(() => started.length === 2);
      expect(started).toEqual(["first", "second"]);
    } finally {
      release();
      await scheduler.stop();
      timer.mockRestore();
    }
  });

  for (const signal of ["wake", "reschedule"] as const) {
    test(`${signal} during discover survives stale scan cleanup`, async () => {
      let finishDiscover!: (ids: string[]) => void;
      const discovering = new Promise<string[]>((resolve) => (finishDiscover = resolve));
      let discoveringStarted = false;
      let nextDueReads = 0;
      const started: string[] = [];
      const scheduler = new WorkflowDueScheduler({
        run: async (workflowId) => {
          started.push(workflowId);
        },
        nextDueAt: async () => (nextDueReads++ === 0 ? Date.now() : undefined),
        discover: async () => {
          discoveringStarted = true;
          return discovering;
        },
        reconcileIntervalMs: 60_000,
        maxConcurrent: 1,
      });
      try {
        scheduler.start();
        await waitFor(() => discoveringStarted);
        if (signal === "wake") scheduler.wake("new");
        else await scheduler.reschedule("new");
        finishDiscover([]);
        await waitFor(() => started.includes("new"));
      } finally {
        finishDiscover([]);
        await scheduler.stop();
      }
    });
  }

  test("jitter is stable and bounded", () => {
    expect(stableJitterMs("workflow-a", 1_000)).toBe(stableJitterMs("workflow-a", 1_000));
    for (const id of ["a", "b", "c", "workflow-with-a-long-identifier"]) {
      const jitter = stableJitterMs(id, 1_000);
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(1_000);
    }
    expect(stableJitterMs("a", 0)).toBe(0);
  });
});
