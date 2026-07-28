import { describe, expect, test } from "bun:test";
import {
  PR_MONITOR_CHANGED_EVENT,
  PR_MONITOR_MODE_TIMEOUTS_MS,
} from "@orkestrator/protocol/pr-monitor";
import {
  PR_CLOSED_COMMENT,
  PR_MERGED_COMMENT,
  PrMonitorService,
  type PrDetection,
  type PrMonitorTarget,
} from "../../../apps/backend/src/core/pr-monitor";

interface HarnessTask {
  taskId: string;
  status: string | null;
  prUrl: string | null;
  prState: "open" | "merged" | "closed" | null;
  prMergeCommented: boolean;
  comments: string[];
}

function createHarness() {
  const emitted: Array<{ event: string; payload: any }> = [];
  const warnings: Array<{ message: string; error: unknown }> = [];
  const clock = { value: 1_000_000 };
  let nextTimerId = 1;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();

  let detect: (target: PrMonitorTarget) => Promise<PrDetection | null> = async () => null;
  let persistError: Error | null = null;
  let taskLookupError: Error | null = null;
  let task: HarnessTask | null = null;

  const calls = {
    detect: [] as PrMonitorTarget[],
    persist: [] as Array<{ environmentId: string; detection: PrDetection }>,
    clear: [] as string[],
    review: [] as string[],
    comments: [] as Array<{ taskId: string; text: string }>,
    metadata: [] as Array<{ taskId: string; updates: Record<string, unknown> }>,
  };

  const service = new PrMonitorService({
    emit: (event, payload) => emitted.push({ event, payload }),
    onWarning: (message, error) => warnings.push({ message, error }),
    now: () => new Date(clock.value).toISOString(),
    monotonicNow: () => clock.value,
    schedule: (callback, delayMs) => {
      const id = nextTimerId++;
      timers.set(id, { callback, delayMs });
      return id;
    },
    cancel: (timer) => {
      timers.delete(timer as number);
    },
    effects: {
      detect: (target) => {
        calls.detect.push(target);
        return detect(target);
      },
      persistPr: async (environmentId, detection) => {
        if (persistError) {
          const error = persistError;
          persistError = null;
          throw error;
        }
        calls.persist.push({ environmentId, detection });
      },
      clearPr: async (environmentId) => {
        calls.clear.push(environmentId);
      },
      findTaskForEnvironment: async () => {
        if (taskLookupError) {
          const error = taskLookupError;
          taskLookupError = null;
          throw error;
        }
        if (!task) return null;
        const snapshot = task;
        return {
          taskId: snapshot.taskId,
          status: snapshot.status,
          prUrl: snapshot.prUrl,
          prState: snapshot.prState,
          prMergeCommented: snapshot.prMergeCommented,
          hasCommentText: (text: string) => snapshot.comments.includes(text),
        };
      },
      moveTaskToReview: async (taskId) => {
        calls.review.push(taskId);
        if (task) task.status = "review";
      },
      addTaskComment: async (taskId, text) => {
        calls.comments.push({ taskId, text });
        task?.comments.push(text);
      },
      updateTaskPrMetadata: async (taskId, updates) => {
        calls.metadata.push({ taskId, updates: updates as Record<string, unknown> });
        if (task) {
          if (typeof updates.prUrl === "string") task.prUrl = updates.prUrl;
          if (
            updates.prState === "open"
            || updates.prState === "merged"
            || updates.prState === "closed"
          ) {
            task.prState = updates.prState;
          }
          if (updates.prMergeCommented === true) task.prMergeCommented = true;
        }
      },
    },
  });

  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };

  return {
    service,
    emitted,
    warnings,
    calls,
    clock,
    setDetect: (fn: typeof detect) => { detect = fn; },
    failPersistOnce: (error: Error) => { persistError = error; },
    failTaskLookupOnce: (error: Error) => { taskLookupError = error; },
    setTask: (value: HarnessTask | null) => { task = value; },
    getTask: () => task,
    pendingDelays: () => [...timers.values()].map((timer) => timer.delayMs),
    /** Fires the oldest pending timer and lets the async check settle. */
    fireNext: async () => {
      const next = [...timers.entries()][0];
      if (!next) throw new Error("no pending timer to fire");
      timers.delete(next[0]);
      next[1].callback();
      await flush();
    },
    flush,
    stateEvents: () => emitted
      .filter((e) => e.event === PR_MONITOR_CHANGED_EVENT && !e.payload.removed)
      .map((e) => e.payload),
    removalEvents: () => emitted
      .filter((e) => e.event === PR_MONITOR_CHANGED_EVENT && e.payload.removed === true)
      .map((e) => e.payload),
    transitions: () => emitted
      .filter((e) => e.event === PR_MONITOR_CHANGED_EVENT && e.payload.transition)
      .map((e) => e.payload.transition),
  };
}

function target(overrides: Partial<PrMonitorTarget> = {}): PrMonitorTarget {
  return {
    environmentId: "env-1",
    branch: "feature/pr-monitor",
    kind: "local",
    worktreePath: "/tmp/worktree",
    ready: true,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    ...overrides,
  };
}

function openPr(overrides: Partial<PrMonitorTarget> = {}): PrMonitorTarget {
  return target({
    prUrl: "https://github.com/org/repo/pull/1",
    prState: "open",
    hasMergeConflicts: false,
    ...overrides,
  });
}

function detection(overrides: Partial<PrDetection> = {}): PrDetection {
  return {
    url: "https://github.com/org/repo/pull/1",
    state: "open",
    hasMergeConflicts: false,
    ...overrides,
  };
}

function inProgressTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
  return {
    taskId: "task-1",
    status: "in-progress",
    prUrl: null,
    prState: null,
    prMergeCommented: false,
    comments: [],
    ...overrides,
  };
}

describe("PrMonitorService", () => {
  test("sync tracks environments with a PR at the normal interval and skips those without", async () => {
    const harness = createHarness();
    harness.setDetect(async () => detection());

    harness.service.sync([openPr(), target({ environmentId: "env-2" })]);

    expect(harness.service.trackedIds()).toEqual(["env-1"]);
    // Reconciliation is not a user action: the first check is interval-delayed.
    expect(harness.pendingDelays()).toEqual([20_000]);

    await harness.fireNext();
    expect(harness.calls.detect).toHaveLength(1);
    // The stored reading matched the detection, so nothing was persisted...
    expect(harness.calls.persist).toHaveLength(0);
    // ...and the next check was rescheduled at the same cadence.
    expect(harness.pendingDelays()).toEqual([20_000]);
  });

  test("sync holds the last reading for an unready environment without polling it", () => {
    const harness = createHarness();
    harness.service.sync([openPr({ ready: false })]);

    expect(harness.service.trackedIds()).toEqual(["env-1"]);
    expect(harness.pendingDelays()).toEqual([]);
    expect(harness.service.snapshot()[0]).toMatchObject({
      environmentId: "env-1",
      prState: "open",
    });
  });

  test("sync untracks environments that no longer exist and announces the removal", () => {
    const harness = createHarness();
    harness.service.sync([openPr()]);
    harness.service.sync([]);

    expect(harness.service.trackedIds()).toEqual([]);
    expect(harness.removalEvents()).toEqual([{ environmentId: "env-1", removed: true }]);
  });

  test("create-pending polls fast, transitions to normal on detection, and stores the PR on the task", async () => {
    const harness = createHarness();
    harness.setTask(inProgressTask());
    harness.service.requestMode(target(), "create-pending");

    // A mode request is a user action: the first check is immediate.
    expect(harness.pendingDelays()).toEqual([0]);
    await harness.fireNext();
    // No PR yet: still create-pending at its fast cadence.
    expect(harness.pendingDelays()).toEqual([5_000]);

    harness.setDetect(async () => detection({ url: "https://github.com/org/repo/pull/3" }));
    await harness.fireNext();

    expect(harness.calls.persist).toEqual([{
      environmentId: "env-1",
      detection: detection({ url: "https://github.com/org/repo/pull/3" }),
    }]);
    expect(harness.getTask()?.prUrl).toBe("https://github.com/org/repo/pull/3");
    expect(harness.service.snapshot()[0]).toMatchObject({ mode: "normal", prState: "open" });
    expect(harness.pendingDelays()).toEqual([20_000]);
    expect(harness.transitions()).toEqual([{
      url: "https://github.com/org/repo/pull/3",
      state: "open",
      previousState: null,
    }]);
  });

  test("merge-pending reverts to normal after its timeout", async () => {
    const harness = createHarness();
    harness.setDetect(async () => detection());
    harness.service.requestMode(openPr(), "merge-pending");
    await harness.fireNext();
    expect(harness.pendingDelays()).toEqual([1_000]);

    harness.clock.value += (PR_MONITOR_MODE_TIMEOUTS_MS["merge-pending"] ?? 0) + 1;
    await harness.fireNext();

    expect(harness.service.snapshot()[0]?.mode).toBe("normal");
    expect(harness.pendingDelays()).toEqual([20_000]);
  });

  test("create-pending that never finds a PR is retired after its timeout", async () => {
    const harness = createHarness();
    harness.service.requestMode(target(), "create-pending");
    await harness.fireNext();

    harness.clock.value += (PR_MONITOR_MODE_TIMEOUTS_MS["create-pending"] ?? 0) + 1;
    await harness.fireNext();

    expect(harness.service.trackedIds()).toEqual([]);
    expect(harness.removalEvents()).toEqual([{ environmentId: "env-1", removed: true }]);
    // The expiry consumed the wake without running a detection.
    expect(harness.calls.detect).toHaveLength(1);
  });

  test("consecutive errors back the interval off exponentially and cap at five minutes", async () => {
    const harness = createHarness();
    harness.setDetect(async () => { throw new Error("gh unavailable"); });
    harness.service.sync([openPr()]);

    const observed: number[] = [];
    for (let i = 0; i < 6; i++) {
      await harness.fireNext();
      observed.push(harness.pendingDelays()[0]!);
    }
    expect(observed).toEqual([40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
    expect(harness.service.snapshot()[0]?.consecutiveErrors).toBe(6);

    // A successful detection resets the backoff.
    harness.setDetect(async () => detection());
    await harness.fireNext();
    expect(harness.service.snapshot()[0]?.consecutiveErrors).toBe(0);
    expect(harness.pendingDelays()).toEqual([20_000]);
  });

  test("a merged detection persists, reconciles the kanban task once, and announces once", async () => {
    const harness = createHarness();
    harness.setTask(inProgressTask());
    harness.setDetect(async () => detection({ state: "merged" }));
    harness.service.sync([openPr()]);

    await harness.fireNext();

    expect(harness.calls.persist).toEqual([{
      environmentId: "env-1",
      detection: detection({ state: "merged" }),
    }]);
    expect(harness.calls.review).toEqual(["task-1"]);
    expect(harness.calls.comments).toEqual([{ taskId: "task-1", text: PR_MERGED_COMMENT }]);
    expect(harness.calls.metadata).toEqual([
      {
        taskId: "task-1",
        updates: {
          prUrl: "https://github.com/org/repo/pull/1",
          prState: "merged",
          prMergeCommented: true,
        },
      },
    ]);
    expect(harness.transitions()).toEqual([{
      url: "https://github.com/org/repo/pull/1",
      state: "merged",
      previousState: "open",
    }]);

    // The next check confirms the same merged state: no repeated side effects,
    // no second transition.
    await harness.fireNext();
    expect(harness.calls.review).toHaveLength(1);
    expect(harness.calls.comments).toHaveLength(1);
    expect(harness.calls.metadata).toHaveLength(1);
    expect(harness.transitions()).toHaveLength(1);
  });

  test("announces a confirmed merge once while failed persistence is retried", async () => {
    const harness = createHarness();
    harness.setDetect(async () => detection({ state: "merged" }));
    harness.failPersistOnce(new Error("persistence unavailable"));
    harness.service.sync([openPr()]);

    await harness.fireNext();
    expect(harness.transitions()).toHaveLength(1);
    expect(harness.calls.persist).toHaveLength(0);
    expect(harness.service.snapshot()[0]?.consecutiveErrors).toBe(1);

    await harness.fireNext();
    expect(harness.calls.persist).toHaveLength(1);
    expect(harness.transitions()).toHaveLength(1);
    expect(harness.service.snapshot()[0]).toMatchObject({
      prState: "merged",
      consecutiveErrors: 0,
    });
  });

  test("clears pending persistence when detection converges to the stored state", async () => {
    const harness = createHarness();
    let hasMergeConflicts = true;
    harness.setDetect(async () => detection({ hasMergeConflicts }));
    harness.failPersistOnce(new Error("persistence unavailable"));
    harness.service.sync([openPr()]);

    await harness.fireNext();
    hasMergeConflicts = false;
    await harness.fireNext();

    harness.service.sync([target()]);
    expect(harness.service.trackedIds()).toEqual([]);
  });

  test("clears pending persistence after a missing PR is durably removed", async () => {
    const harness = createHarness();
    let exists = true;
    harness.setDetect(async () => exists
      ? detection({ hasMergeConflicts: true })
      : null);
    harness.failPersistOnce(new Error("persistence unavailable"));
    harness.service.sync([openPr()]);

    await harness.fireNext();
    exists = false;
    await harness.fireNext();

    expect(harness.calls.clear).toEqual(["env-1"]);
    expect(harness.service.trackedIds()).toEqual([]);
  });

  test("a restart does not repost the comment when prMergeCommented is already set", async () => {
    // A fresh service instance simulates a backend restart: the in-memory
    // progress is gone and only the persisted metadata remains.
    const harness = createHarness();
    harness.setTask(inProgressTask({
      status: "review",
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "merged",
      prMergeCommented: true,
      comments: [PR_MERGED_COMMENT],
    }));
    harness.setDetect(async () => detection({ state: "merged" }));
    harness.service.sync([openPr({ prState: "merged" })]);

    await harness.fireNext();

    expect(harness.calls.review).toHaveLength(0);
    expect(harness.calls.comments).toHaveLength(0);
    expect(harness.calls.metadata).toHaveLength(0);
  });

  test("an existing comment without the flag skips the comment but completes the metadata", async () => {
    const harness = createHarness();
    harness.setTask(inProgressTask({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "closed",
      comments: [PR_CLOSED_COMMENT],
    }));
    harness.setDetect(async () => detection({ state: "closed" }));
    harness.service.sync([openPr()]);

    await harness.fireNext();

    // Closed PRs never move the task.
    expect(harness.calls.review).toHaveLength(0);
    expect(harness.calls.comments).toHaveLength(0);
    expect(harness.calls.metadata).toEqual([
      {
        taskId: "task-1",
        updates: {
          prUrl: "https://github.com/org/repo/pull/1",
          prState: "closed",
          prMergeCommented: true,
        },
      },
    ]);
  });

  test("a failed reconciliation step retries on the next detection without repeating earlier steps", async () => {
    const harness = createHarness();
    const task = inProgressTask();
    harness.setTask(task);
    harness.setDetect(async () => detection({ state: "merged" }));
    harness.service.sync([openPr()]);

    // First pass: the metadata write fails after the move and comment landed.
    const original = harness.calls.metadata;
    let failMetadata = true;
    const service = harness.service as unknown as {
      options: { effects: { updateTaskPrMetadata: (taskId: string, updates: object) => Promise<void> } };
    };
    const realUpdate = service.options.effects.updateTaskPrMetadata;
    service.options.effects.updateTaskPrMetadata = async (taskId, updates) => {
      if (failMetadata) {
        failMetadata = false;
        throw new Error("metadata write failed");
      }
      return realUpdate(taskId, updates);
    };

    await harness.fireNext();
    expect(harness.calls.review).toHaveLength(1);
    expect(harness.calls.comments).toHaveLength(1);
    expect(original).toHaveLength(0);
    expect(harness.warnings.some((w) => w.message.includes("reconcile"))).toBe(true);

    await harness.fireNext();
    expect(harness.calls.review).toHaveLength(1);
    expect(harness.calls.comments).toHaveLength(1);
    expect(original).toEqual([
      {
        taskId: "task-1",
        updates: {
          prUrl: "https://github.com/org/repo/pull/1",
          prState: "merged",
          prMergeCommented: true,
        },
      },
    ]);
  });

  test("a replacement PR is reconciled even when the task has a terminal flag for the old PR", async () => {
    const harness = createHarness();
    harness.setTask(inProgressTask({
      status: "review",
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "merged",
      prMergeCommented: true,
      comments: [PR_MERGED_COMMENT],
    }));
    harness.setDetect(async () => detection({
      url: "https://github.com/org/repo/pull/2",
      state: "merged",
    }));
    harness.service.sync([openPr()]);

    await harness.fireNext();

    expect(harness.calls.comments).toEqual([
      { taskId: "task-1", text: PR_MERGED_COMMENT },
    ]);
    expect(harness.calls.metadata).toEqual([{
      taskId: "task-1",
      updates: {
        prUrl: "https://github.com/org/repo/pull/2",
        prState: "merged",
        prMergeCommented: true,
      },
    }]);
  });

  test("a discovered PR remains tracked and retries when its first persistence attempt fails", async () => {
    const harness = createHarness();
    harness.setDetect(async () => detection());
    harness.failPersistOnce(new Error("storage unavailable"));
    harness.service.probe(target());

    await harness.fireNext();

    expect(harness.service.trackedIds()).toEqual(["env-1"]);
    expect(harness.service.snapshot()[0]).toMatchObject({
      mode: "normal",
      prUrl: null,
      consecutiveErrors: 1,
    });
    expect(harness.pendingDelays()).toEqual([40_000]);

    await harness.fireNext();

    expect(harness.calls.persist).toHaveLength(1);
    expect(harness.service.snapshot()[0]).toMatchObject({
      mode: "normal",
      prUrl: "https://github.com/org/repo/pull/1",
      consecutiveErrors: 0,
    });
  });

  test("a failed provisional persistence is retired if the PR disappears before retry", async () => {
    const harness = createHarness();
    let exists = true;
    harness.setDetect(async () => exists ? detection() : null);
    harness.failPersistOnce(new Error("storage unavailable"));
    harness.service.probe(target());

    await harness.fireNext();
    expect(harness.service.trackedIds()).toEqual(["env-1"]);

    exists = false;
    await harness.fireNext();

    expect(harness.service.trackedIds()).toEqual([]);
    expect(harness.calls.persist).toHaveLength(0);
  });

  test("create-pending stays pending until a discovered PR is durably stored", async () => {
    const harness = createHarness();
    harness.setDetect(async () => detection());
    harness.failPersistOnce(new Error("storage unavailable"));
    harness.service.requestMode(target(), "create-pending");

    await harness.fireNext();

    expect(harness.service.snapshot()[0]).toMatchObject({
      mode: "create-pending",
      prUrl: null,
      consecutiveErrors: 1,
    });
    expect(harness.pendingDelays()).toEqual([10_000]);

    await harness.fireNext();

    expect(harness.service.snapshot()[0]).toMatchObject({
      mode: "normal",
      prUrl: "https://github.com/org/repo/pull/1",
      consecutiveErrors: 0,
    });
  });

  test("create-pending retries linking the discovered PR to its task", async () => {
    const harness = createHarness();
    harness.setTask(inProgressTask());
    harness.setDetect(async () => detection());
    harness.failTaskLookupOnce(new Error("task storage unavailable"));
    harness.service.requestMode(target(), "create-pending");

    await harness.fireNext();
    expect(harness.service.snapshot()[0]?.mode).toBe("create-pending");
    expect(harness.calls.metadata).toHaveLength(0);

    await harness.fireNext();
    expect(harness.service.snapshot()[0]?.mode).toBe("normal");
    expect(harness.calls.metadata).toEqual([{
      taskId: "task-1",
      updates: {
        prUrl: "https://github.com/org/repo/pull/1",
        prState: "open",
      },
    }]);
  });

  test("merge-pending remains durable until a terminal PR state is persisted", async () => {
    const harness = createHarness();
    harness.setDetect(async () => detection({ state: "merged" }));
    harness.failPersistOnce(new Error("storage unavailable"));
    harness.service.requestMode(openPr(), "merge-pending");

    await harness.fireNext();
    expect(harness.service.snapshot()[0]).toMatchObject({
      mode: "merge-pending",
      prState: "open",
    });

    await harness.fireNext();
    expect(harness.service.snapshot()[0]).toMatchObject({
      mode: "normal",
      prState: "merged",
    });
  });

  test("not-found clears an open PR and retires the entry, but preserves a terminal reading", async () => {
    const harness = createHarness();
    harness.setDetect(async () => null);
    harness.service.sync([openPr()]);

    await harness.fireNext();
    expect(harness.calls.clear).toEqual(["env-1"]);
    expect(harness.service.trackedIds()).toEqual([]);
    expect(harness.removalEvents()).toHaveLength(1);

    // Terminal states survive the branch deletion that follows a merge.
    harness.service.sync([openPr({ environmentId: "env-2", prState: "merged" })]);
    await harness.fireNext();
    expect(harness.calls.clear).toEqual(["env-1"]);
    expect(harness.service.trackedIds()).toEqual(["env-2"]);
    expect(harness.service.snapshot()[0]?.prState).toBe("merged");
  });

  test("probe discovers an agent-created PR and promotes it into the monitored set", async () => {
    const harness = createHarness();
    harness.setDetect(async () => detection());
    harness.service.probe(target());

    expect(harness.pendingDelays()).toEqual([0]);
    await harness.fireNext();

    expect(harness.calls.persist).toHaveLength(1);
    expect(harness.service.trackedIds()).toEqual(["env-1"]);
    expect(harness.pendingDelays()).toEqual([20_000]);
    expect(harness.transitions()).toEqual([{
      url: "https://github.com/org/repo/pull/1",
      state: "open",
      previousState: null,
    }]);
  });

  test("a probe that finds nothing vanishes without a trace", async () => {
    const harness = createHarness();
    harness.setDetect(async () => null);
    harness.service.probe(target());

    await harness.fireNext();

    expect(harness.service.trackedIds()).toEqual([]);
    expect(harness.emitted).toEqual([]);
  });

  test("probe of a monitored environment runs an immediate check instead of duplicating the entry", async () => {
    const harness = createHarness();
    harness.setDetect(async () => detection());
    harness.service.sync([openPr()]);
    expect(harness.pendingDelays()).toEqual([20_000]);

    harness.service.probe(openPr());
    expect(harness.pendingDelays()).toEqual([0]);
    await harness.fireNext();
    expect(harness.service.trackedIds()).toEqual(["env-1"]);
  });

  test("a check requested while detection is in flight runs immediately after it settles", async () => {
    const harness = createHarness();
    let resolveFirst!: (value: PrDetection | null) => void;
    let detections = 0;
    harness.setDetect(async () => {
      detections += 1;
      if (detections === 1) {
        return await new Promise<PrDetection | null>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return detection();
    });
    harness.service.sync([openPr()]);

    await harness.fireNext();
    expect(detections).toBe(1);

    harness.service.requestCheck("env-1");
    await harness.fireNext();
    expect(detections).toBe(1);

    resolveFirst(detection());
    await harness.flush();
    expect(harness.pendingDelays()).toEqual([0]);

    await harness.fireNext();
    expect(detections).toBe(2);
  });

  test("a stale in-flight result cannot mutate an entry that was untracked and recreated", async () => {
    const harness = createHarness();
    let resolveDetection!: (value: PrDetection | null) => void;
    harness.setDetect(async () => await new Promise<PrDetection | null>((resolve) => {
      resolveDetection = resolve;
    }));
    harness.service.sync([openPr()]);

    await harness.fireNext();
    harness.service.untrack("env-1");
    harness.service.sync([openPr({
      prUrl: "https://github.com/org/repo/pull/2",
      prState: "open",
    })]);

    resolveDetection(detection({ state: "merged" }));
    await harness.flush();

    expect(harness.calls.persist).toHaveLength(0);
    expect(harness.service.snapshot()).toEqual([
      expect.objectContaining({
        prUrl: "https://github.com/org/repo/pull/2",
        prState: "open",
      }),
    ]);
  });

  test("throwing event and warning sinks do not stop scheduling", async () => {
    const harness = createHarness();
    const internals = harness.service as unknown as {
      options: {
        emit: () => never;
        onWarning: () => never;
      };
    };
    internals.options.emit = () => {
      throw new Error("event sink failed");
    };
    internals.options.onWarning = () => {
      throw new Error("logger failed");
    };
    harness.setDetect(async () => {
      throw new Error("gh unavailable");
    });

    expect(() => harness.service.sync([openPr()])).not.toThrow();
    await harness.fireNext();

    expect(harness.service.trackedIds()).toEqual(["env-1"]);
    expect(harness.pendingDelays()).toEqual([40_000]);
  });

  test("pause stops the timers but keeps the snapshot; untrack announces removal", () => {
    const harness = createHarness();
    harness.service.sync([openPr()]);

    harness.service.pause("env-1");
    expect(harness.pendingDelays()).toEqual([]);
    expect(harness.service.snapshot()).toHaveLength(1);

    harness.service.untrack("env-1");
    expect(harness.service.snapshot()).toHaveLength(0);
    expect(harness.removalEvents()).toHaveLength(1);
  });

  test("a paused entry resumes polling when sync sees the environment ready again", () => {
    const harness = createHarness();
    harness.service.sync([openPr()]);
    harness.service.pause("env-1");

    harness.service.sync([openPr()]);
    expect(harness.pendingDelays()).toEqual([20_000]);
  });

  test("requestCheck is a no-op for unmonitored or paused environments", () => {
    const harness = createHarness();
    harness.service.requestCheck("env-unknown");
    expect(harness.pendingDelays()).toEqual([]);

    harness.service.sync([openPr()]);
    harness.service.pause("env-1");
    harness.service.requestCheck("env-1");
    expect(harness.pendingDelays()).toEqual([]);
  });

  test("shutdown cancels every timer and clears the set", () => {
    const harness = createHarness();
    harness.service.sync([openPr(), openPr({ environmentId: "env-2" })]);
    harness.service.shutdown();
    expect(harness.pendingDelays()).toEqual([]);
    expect(harness.service.trackedIds()).toEqual([]);
  });

  test("uneventful checks do not emit; snapshot still reflects the latest check time", async () => {
    const harness = createHarness();
    harness.setDetect(async () => detection());
    harness.service.sync([openPr()]);
    const eventsAfterTracking = harness.stateEvents().length;

    await harness.fireNext();
    await harness.fireNext();

    expect(harness.stateEvents()).toHaveLength(eventsAfterTracking);
    expect(harness.service.snapshot()[0]?.lastCheckAt).toBe(new Date(harness.clock.value).toISOString());
  });
});
