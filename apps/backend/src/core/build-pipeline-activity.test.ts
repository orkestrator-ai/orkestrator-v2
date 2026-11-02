/**
 * Pipe branches in the sidebar: the environment's `build-pipeline` activity
 * source follows its pipelines, on a real store.
 */
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildPhase, BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { BuildPipelineActivity } from "./build-pipeline-activity.js";
import { StorageService } from "./storage.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function store() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-activity-"));
  const storage = new StorageService(root);
  await storage.init();
  for (const id of ["e1", "e2"]) {
    await storage.addEnvironment({
      id,
      projectId: "proj-1",
      name: id,
      branch: "main",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
    });
  }
  cleanups.push(async () => {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return storage;
}

function pipeline(
  id: string,
  environmentId: string,
  phase: BuildPhase,
  overrides: Partial<BuildPipeline> = {},
): BuildPipeline {
  return {
    id,
    taskId: `task-${id}`,
    projectId: "proj-1",
    environmentId,
    environmentType: "local",
    agentType: "claude",
    phase,
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-10-31T00:00:00.000Z",
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 1,
    controller: "backend",
    ...overrides,
  };
}

async function save(storage: StorageService, snapshot: BuildPipeline) {
  await storage.saveBuildPipeline(
    snapshot.id,
    snapshot.projectId,
    snapshot.environmentId,
    2,
    snapshot,
  );
}

/** Timers that never fire: the tests observe explicitly. */
const NO_TIMERS = { setTimeout: () => 0, clearTimeout: () => undefined };

class ManualTimers {
  now = 0;
  private nextId = 0;
  readonly pending = new Map<number, { callback: () => void; due: number }>();

  setTimeout = (callback: () => void, ms: number): number => {
    const id = ++this.nextId;
    this.pending.set(id, { callback, due: this.now + ms });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  async advance(ms: number, observer: BuildPipelineActivity): Promise<void> {
    this.now += ms;
    for (const [id, timer] of Array.from(this.pending)) {
      if (timer.due > this.now) continue;
      this.pending.delete(id);
      timer.callback();
    }
    await observer.settled();
  }
}

function watched(storage: StorageService) {
  const timers = new ManualTimers();
  const observer = new BuildPipelineActivity(storage, { timers });
  cleanups.unshift(async () => observer.stop());
  return { observer, timers };
}

async function activity(storage: StorageService, environmentId: string) {
  const environment = (await storage.getEnvironment(environmentId))!;
  return {
    source: environment.agentActivitySources?.["build-pipeline"]?.state,
    aggregate: environment.agentActivityState ?? "idle",
  };
}

describe("build pipeline activity", () => {
  test("a pipeline with agents in flight paints its environment working until it finishes", async () => {
    const storage = await store();
    const observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
    await observer.start();

    await save(storage, pipeline("p1", "e1", "fixing"));
    await observer.observe("p1");
    expect(await activity(storage, "e1")).toEqual({ source: "working", aggregate: "working" });
    expect(await activity(storage, "e2")).toEqual({ source: undefined, aggregate: "idle" });

    await save(storage, pipeline("p1", "e1", "complete"));
    await observer.observe("p1");
    expect(await activity(storage, "e1")).toEqual({ source: "idle", aggregate: "idle" });
    observer.stop();
  });

  test("setup phases and stall warnings are not working", async () => {
    const storage = await store();
    const observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
    await observer.start();

    await save(storage, pipeline("p1", "e1", "waiting-for-setup"));
    await observer.observe("p1");
    expect((await activity(storage, "e1")).aggregate).toBe("idle");

    await save(
      storage,
      pipeline("p1", "e1", "building", {
        stallWarning: { sessionId: "s1", detectedAt: "2026-10-31T00:00:00.000Z" },
      }),
    );
    await observer.observe("p1");
    expect((await activity(storage, "e1")).aggregate).toBe("idle");
    observer.stop();
  });

  test("a deleted pipeline releases the environment it ran in", async () => {
    const storage = await store();
    const observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
    await observer.start();

    await save(storage, pipeline("p1", "e1", "reviewing"));
    await observer.observe("p1");
    expect((await activity(storage, "e1")).source).toBe("working");

    await storage.deleteBuildPipeline("p1");
    await observer.observe("p1");
    expect((await activity(storage, "e1")).source).toBe("idle");
    observer.stop();
  });

  test("start restores working pipelines and clears a source a crash left working", async () => {
    const storage = await store();
    await save(storage, pipeline("p1", "e1", "building"));
    await storage.setEnvironmentAgentActivity(
      "e2",
      "working",
      new Date().toISOString(),
      "build-pipeline",
    );

    const observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
    await observer.start();
    expect((await activity(storage, "e1")).aggregate).toBe("working");
    expect((await activity(storage, "e2")).aggregate).toBe("idle");
    observer.stop();
  });

  test("pipeline saves are observed through resource changes", async () => {
    const storage = await store();
    const { observer, timers } = watched(storage);
    await observer.start();

    await save(storage, pipeline("p1", "e1", "verifying"));
    await timers.advance(500, observer);
    expect((await activity(storage, "e1")).aggregate).toBe("working");
    observer.stop();
  });

  for (const transition of ["delete", "complete"] as const) {
    for (const failure of [
      "getBuildPipeline",
      "getEnvironment",
      "setEnvironmentAgentActivity",
    ] as const) {
      test(`${transition} retries a failed ${failure} automatically`, async () => {
        const storage = await store();
        await save(storage, pipeline("p1", "e1", "building"));
        const { observer, timers } = watched(storage);
        await observer.start();
        const warning = spyOn(console, "warn").mockImplementation(() => undefined);
        const failing = spyOn(storage, failure).mockRejectedValueOnce(
          new Error("disk unavailable"),
        );
        try {
          if (transition === "delete") await storage.deleteBuildPipeline("p1");
          else await save(storage, pipeline("p1", "e1", "complete"));
          await timers.advance(500, observer);
          expect((await activity(storage, "e1")).source).toBe("working");
          expect(warning).toHaveBeenCalledWith(
            "[build-pipeline] Could not update the sidebar for pipeline p1:",
            "disk unavailable",
          );
          failing.mockRestore();
          await timers.advance(999, observer);
          expect((await activity(storage, "e1")).source).toBe("working");
          await timers.advance(1, observer);
          expect((await activity(storage, "e1")).source).toBe("idle");
        } finally {
          failing.mockRestore();
          warning.mockRestore();
        }
      });
    }
  }

  test("retries back off to a bounded delay and stop cancels recovery", async () => {
    const storage = await store();
    const { observer, timers } = watched(storage);
    await observer.start();
    const failing = spyOn(storage, "listAllBuildPipelines").mockRejectedValue(new Error("offline"));
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(observer.reconcile()).rejects.toThrow("offline");
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        expect([...timers.pending.values()].some((timer) => timer.due === timers.now + delay)).toBe(
          true,
        );
        await timers.advance(delay, observer);
      }
      observer.stop();
      expect(timers.pending.size).toBe(0);
      const calls = failing.mock.calls.length;
      await timers.advance(60_000, observer);
      expect(failing).toHaveBeenCalledTimes(calls);
    } finally {
      failing.mockRestore();
      warning.mockRestore();
    }
  });

  test("failed startup reconciliation recovers without restarting the observer", async () => {
    const storage = await store();
    await save(storage, pipeline("p1", "e1", "building"));
    const { observer, timers } = watched(storage);
    const failing = spyOn(storage, "loadEnvironments").mockRejectedValueOnce(new Error("offline"));
    try {
      await expect(observer.start()).rejects.toThrow("offline");
      await timers.advance(1_000, observer);
      expect((await activity(storage, "e1")).source).toBe("working");
    } finally {
      failing.mockRestore();
    }
  });

  test("shared-directory observers refresh external changes and periodically converge", async () => {
    const first = await store();
    const second = new StorageService(first.getDataDir());
    await second.init();
    cleanups.unshift(async () => second.close());
    await save(first, pipeline("p1", "e1", "building"));
    await save(second, pipeline("p2", "e1", "reviewing"));
    const one = watched(first);
    const two = watched(second);
    await one.observer.start();
    await two.observer.start();
    await save(first, pipeline("p1", "e1", "complete"));
    await one.timers.advance(500, one.observer);
    expect((await activity(second, "e1")).source).toBe("working");
    await save(second, pipeline("p2", "e1", "complete"));
    await two.timers.advance(500, two.observer);
    expect((await activity(first, "e1")).source).toBe("idle");

    // A stale activity write (for example an in-flight write from a third
    // backend) is repaired even without another pipeline event.
    await first.setEnvironmentAgentActivity(
      "e1",
      "working",
      new Date().toISOString(),
      "build-pipeline",
    );
    await one.timers.advance(30_000, one.observer);
    expect((await activity(second, "e1")).source).toBe("idle");
    await two.timers.advance(30_000, two.observer);
    expect((await activity(first, "e1")).source).toBe("idle");
  });

  test("periodic reconciliation notices pipeline changes made only by another storage instance", async () => {
    const storage = await store();
    const writer = new StorageService(storage.getDataDir());
    await writer.init();
    cleanups.unshift(async () => writer.close());
    const { observer, timers } = watched(storage);
    await observer.start();
    await save(writer, pipeline("p1", "e1", "building"));
    await timers.advance(30_000, observer);
    expect((await activity(storage, "e1")).source).toBe("working");
    await writer.deleteBuildPipeline("p1");
    await timers.advance(30_000, observer);
    expect((await activity(storage, "e1")).source).toBe("idle");
  });

  for (const transition of ["complete", "delete"] as const) {
    test(`${transition} keeps the environment working while another pipeline runs`, async () => {
      const storage = await store();
      await save(storage, pipeline("p1", "e1", "building"));
      await save(storage, pipeline("p2", "e1", "fixing"));
      const { observer, timers } = watched(storage);
      await observer.start();
      if (transition === "delete") await storage.deleteBuildPipeline("p1");
      else await save(storage, pipeline("p1", "e1", "complete"));
      await timers.advance(500, observer);
      expect((await activity(storage, "e1")).source).toBe("working");
      await storage.deleteBuildPipeline("p2");
      await timers.advance(500, observer);
      expect((await activity(storage, "e1")).source).toBe("idle");
    });
  }

  test("moving a working pipeline releases its old environment", async () => {
    const storage = await store();
    await save(storage, pipeline("p1", "e1", "building"));
    const { observer, timers } = watched(storage);
    await observer.start();
    await save(storage, pipeline("p1", "e2", "building"));
    await timers.advance(500, observer);
    expect((await activity(storage, "e1")).source).toBe("idle");
    expect((await activity(storage, "e2")).source).toBe("working");
  });

  test("a failed release during a move retries the old environment and still marks the new one", async () => {
    const storage = await store();
    await save(storage, pipeline("p1", "e1", "building"));
    const { observer, timers } = watched(storage);
    await observer.start();
    const failing = spyOn(storage, "setEnvironmentAgentActivity").mockRejectedValueOnce(
      new Error("offline"),
    );
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await save(storage, pipeline("p1", "e2", "building"));
      await timers.advance(500, observer);
      expect((await activity(storage, "e1")).source).toBe("working");
      expect((await activity(storage, "e2")).source).toBe("working");
      await timers.advance(1_000, observer);
      expect((await activity(storage, "e1")).source).toBe("idle");
      expect((await activity(storage, "e2")).source).toBe("working");
    } finally {
      failing.mockRestore();
      warning.mockRestore();
    }
  });

  test("a burst coalesces to the latest snapshot and stop cancels pending observations", async () => {
    const storage = await store();
    const { observer, timers } = watched(storage);
    await observer.start();
    const observed = spyOn(observer, "observe");
    try {
      await save(storage, pipeline("p1", "e1", "building"));
      await save(storage, pipeline("p1", "e1", "fixing"));
      await save(storage, pipeline("p1", "e1", "complete"));
      await timers.advance(499, observer);
      expect(observed).not.toHaveBeenCalled();
      await timers.advance(1, observer);
      expect(observed).toHaveBeenCalledTimes(1);
      expect((await activity(storage, "e1")).aggregate).toBe("idle");
      await save(storage, pipeline("p1", "e1", "building"));
      observer.stop();
      expect(timers.pending.size).toBe(0);
      await timers.advance(30_000, observer);
      await save(storage, pipeline("p1", "e1", "fixing"));
      expect(timers.pending.size).toBe(0);
      expect(observed).toHaveBeenCalledTimes(1);
    } finally {
      observed.mockRestore();
    }
  });
});

/** What the environment's bell says, or `null` when nothing rang. */
async function bell(storage: StorageService, environmentId: string) {
  const environment = (await storage.getEnvironment(environmentId))!;
  return environment.hasUnreadWork === true ? (environment.unreadReason ?? null) : null;
}

const STALL = { stallWarning: { sessionId: "s1", detectedAt: "2026-10-31T00:00:00.000Z" } };

describe("what a pipeline's end rings", () => {
  async function ended(end: BuildPipeline) {
    const storage = await store();
    const observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
    await observer.start();
    await save(storage, pipeline("p1", "e1", "building"));
    await observer.observe("p1");
    expect(await activity(storage, "e1")).toEqual({ source: "working", aggregate: "working" });
    await save(storage, end);
    await observer.observe("p1");
    expect((await activity(storage, "e1")).source).toBe("idle");
    observer.stop();
    return bell(storage, "e1");
  }

  test("a completed pipeline still rings that the work finished", async () => {
    expect(await ended(pipeline("p1", "e1", "complete"))).toBe("agent_finished");
  });

  test("a failed pipeline rings a failure", async () => {
    expect(
      await ended(pipeline("p1", "e1", "failed", { error: "Build stage exited with an error" })),
    ).toBe("agent_failed");
  });

  for (const error of [
    "Build cancelled",
    "Build cancelled, but stopping every agent could not be confirmed: offline",
  ]) {
    test(`a cancel rings nothing (${error.slice(0, 24)}…)`, async () => {
      expect(await ended(pipeline("p1", "e1", "failed", { error }))).toBeNull();
    });
  }

  for (const pauseCause of ["requested", "supervisor"] as const) {
    test(`a ${pauseCause} pause rings nothing`, async () => {
      expect(
        await ended(
          pipeline("p1", "e1", "paused", { pausedFromPhase: "fixing", pauseCause, error: "x" }),
        ),
      ).toBeNull();
    });
  }

  test("deleting a working pipeline rings nothing", async () => {
    const storage = await store();
    const observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
    await observer.start();
    await save(storage, pipeline("p1", "e1", "reviewing"));
    await observer.observe("p1");
    await storage.deleteBuildPipeline("p1");
    await observer.observe("p1");
    expect((await activity(storage, "e1")).source).toBe("idle");
    expect(await bell(storage, "e1")).toBeNull();
    observer.stop();
  });

  test("a stall never rings, and the stalled pipeline's real end rings once", async () => {
    for (const [end, expected] of [
      [pipeline("p1", "e1", "complete"), "agent_finished"],
      [pipeline("p1", "e1", "failed", { error: "Fix stage failed" }), "agent_failed"],
      [pipeline("p1", "e1", "failed", { error: "Build cancelled" }), null],
      [pipeline("p1", "e1", "paused", { pausedFromPhase: "building" }), null],
    ] as const) {
      const storage = await store();
      const observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
      await observer.start();
      await save(storage, pipeline("p1", "e1", "building"));
      await observer.observe("p1");
      await save(storage, pipeline("p1", "e1", "building", STALL));
      await observer.observe("p1");
      expect((await activity(storage, "e1")).source).toBe("idle");
      expect(await bell(storage, "e1")).toBeNull();

      await save(storage, end);
      await observer.observe("p1");
      expect(await bell(storage, "e1")).toBe(expected);
      // Later observations of the same end, and a reconcile, do not ring again.
      await observer.observe("p1");
      await observer.reconcile();
      const environment = (await storage.getEnvironment("e1"))!;
      expect(environment.agentAttentionKeys?.length ?? 0).toBe(expected === null ? 0 : 1);
      observer.stop();
    }
  });

  test("a stalled success preserves another session's unread failure and deduplicates", async () => {
    const storage = await store();
    const observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
    await save(storage, pipeline("p1", "e1", "building", STALL));
    await observer.start();
    await storage.recordEnvironmentSessionCompletion(
      "e1",
      new Date().toISOString(),
      "agent_failed",
      "other",
    );
    await save(storage, pipeline("p1", "e1", "complete"));
    await observer.observe("p1");
    expect(await bell(storage, "e1")).toBe("agent_failed");
    const completedAt = (await storage.getEnvironment("e1"))!.agentSessionCompletedAt;
    await observer.reconcile();
    expect((await storage.getEnvironment("e1"))!.agentSessionCompletedAt).toBe(completedAt);
    expect((await storage.getEnvironment("e1"))!.agentAttentionKeys).toHaveLength(2);
    observer.stop();
  });

  for (const phases of [
    ["failed", "complete"],
    ["complete", "failed"],
  ] as const) {
    test(`mixed stalled endings preserve failure (${phases.join(", ")})`, async () => {
      const storage = await store();
      const observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
      for (const id of ["p1", "p2"]) await save(storage, pipeline(id, "e1", "building", STALL));
      await observer.start();
      for (const [index, phase] of phases.entries()) {
        await save(
          storage,
          pipeline(`p${index + 1}`, "e1", phase, {
            error: phase === "failed" ? "Failure" : undefined,
          }),
        );
      }
      await observer.reconcile();
      expect(await bell(storage, "e1")).toBe("agent_failed");
      expect((await storage.getEnvironment("e1"))!.agentAttentionKeys).toHaveLength(2);
      observer.stop();
    });
  }

  for (const phase of ["complete", "failed"] as const) {
    for (const restart of [false, true]) {
      test(`old ${phase} metadata cannot ring a later cancellation (restart=${restart})`, async () => {
        const storage = await store();
        let observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
        try {
          setSystemTime(new Date("2026-11-02T00:00:00Z"));
          const old = pipeline("p0", "e1", phase, {
            error: phase === "failed" ? "Old failure" : undefined,
          });
          await save(storage, old);
          const endedAt = (await storage.getBuildPipeline("p0"))!.activityEndedAt;
          await observer.start();
          setSystemTime(new Date("2026-11-02T00:01:00Z"));
          await save(storage, pipeline("p1", "e1", "building"));
          await observer.observe("p1");
          setSystemTime(new Date("2026-11-02T00:02:00Z"));
          await save(storage, { ...old, completionCommentStatus: "posted" });
          expect((await storage.getBuildPipeline("p0"))!.activityEndedAt).toBe(endedAt);
          await save(storage, pipeline("p1", "e1", "failed", { error: "Build cancelled" }));
          if (restart) {
            observer.stop();
            observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
            await observer.start();
          } else await observer.observe("p1");
          expect(await bell(storage, "e1")).toBeNull();
        } finally {
          observer.stop();
          setSystemTime();
        }
      });
    }
  }

  test("a stall that clears rings only for the pipeline's end", async () => {
    const storage = await store();
    const observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
    await observer.start();
    await save(storage, pipeline("p1", "e1", "building"));
    await observer.observe("p1");
    await save(storage, pipeline("p1", "e1", "building", STALL));
    await observer.observe("p1");
    await save(storage, pipeline("p1", "e1", "reviewing"));
    await observer.observe("p1");
    expect((await activity(storage, "e1")).source).toBe("working");
    expect(await bell(storage, "e1")).toBeNull();
    await save(storage, pipeline("p1", "e1", "failed", { error: "Review stage failed" }));
    await observer.observe("p1");
    expect(await bell(storage, "e1")).toBe("agent_failed");
    expect((await storage.getEnvironment("e1"))!.agentAttentionKeys ?? []).toEqual([]);
    observer.stop();
  });

  test("a failure while a sibling pipeline works rings when the source ends", async () => {
    const storage = await store();
    const observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
    await save(storage, pipeline("p1", "e1", "building"));
    await save(storage, pipeline("p2", "e1", "fixing"));
    await observer.start();
    await save(storage, pipeline("p1", "e1", "failed", { error: "Build stage failed" }));
    await observer.observe("p1");
    expect((await activity(storage, "e1")).source).toBe("working");
    expect(await bell(storage, "e1")).toBeNull();
    await save(storage, pipeline("p2", "e1", "complete"));
    await observer.observe("p2");
    expect(await bell(storage, "e1")).toBe("agent_failed");
    observer.stop();
  });

  test("an end this process watched counts even when its save predates the working write", async () => {
    const storage = await store();
    // The activity write's clock runs ahead of the store's timestamps, as
    // when a pipeline ends between the read and the write that went working.
    const observer = new BuildPipelineActivity(storage, {
      timers: NO_TIMERS,
      clock: () => new Date(Date.now() + 60_000),
    });
    await observer.start();
    await save(storage, pipeline("p1", "e1", "building"));
    await observer.observe("p1");
    await save(storage, pipeline("p1", "e1", "failed", { error: "Build stage failed" }));
    await observer.observe("p1");
    expect(await bell(storage, "e1")).toBe("agent_failed");
    observer.stop();
  });

  test("an old pipeline's end does not colour a later one", async () => {
    const storage = await store();
    await save(storage, pipeline("p0", "e1", "failed", { error: "Old failure" }));
    const observer = new BuildPipelineActivity(storage, {
      timers: NO_TIMERS,
      clock: () => new Date(Date.now() + 60_000),
    });
    await observer.start();
    await save(storage, pipeline("p1", "e1", "building"));
    await observer.observe("p1");
    await save(storage, pipeline("p1", "e1", "failed", { error: "Build cancelled" }));
    await observer.observe("p1");
    expect((await activity(storage, "e1")).source).toBe("idle");
    expect(await bell(storage, "e1")).toBeNull();
    observer.stop();
  });

  for (const [end, expected] of [
    [pipeline("p1", "e1", "failed", { error: "Build stage failed" }), "agent_failed"],
    [pipeline("p1", "e1", "complete"), "agent_finished"],
    [pipeline("p1", "e1", "failed", { error: "Build cancelled" }), null],
  ] as const) {
    test(`after a restart the stored record decides (${end.phase}: ${expected})`, async () => {
      const storage = await store();
      await storage.setEnvironmentAgentActivity(
        "e1",
        "working",
        new Date(Date.now() - 1_000).toISOString(),
        "build-pipeline",
      );
      await save(storage, end);
      const observer = new BuildPipelineActivity(storage, { timers: NO_TIMERS });
      await observer.start();
      expect((await activity(storage, "e1")).source).toBe("idle");
      expect(await bell(storage, "e1")).toBe(expected);
      observer.stop();
    });
  }
});
