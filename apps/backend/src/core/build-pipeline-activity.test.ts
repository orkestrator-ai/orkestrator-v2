/**
 * Pipe branches in the sidebar: the environment's `build-pipeline` activity
 * source follows its pipelines, on a real store.
 */
import { afterEach, describe, expect, test } from "bun:test";
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
    const observer = new BuildPipelineActivity(storage, { debounceMs: 0 });
    await observer.start();

    await save(storage, pipeline("p1", "e1", "verifying"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await observer.settled();
    expect((await activity(storage, "e1")).aggregate).toBe("working");
    observer.stop();
  });
});
