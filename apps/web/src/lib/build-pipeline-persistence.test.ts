import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  hydrateBuildPipeline,
  hydrateBuildPipelinesForProject,
  persistBuildPipelineNow,
  startBuildPipelinePersistence,
} from "./build-pipeline-persistence";
import {
  BUILD_PIPELINE_VERSION,
  useBuildPipelineStore,
  type BuildPipeline,
} from "@/stores/buildPipelineStore";
import type { PersistedBuildPipeline } from "@/types";

const PROJECT_ID = "project-1";

function pipeline(overrides: Partial<BuildPipeline> = {}): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: PROJECT_ID,
    environmentId: "env-1",
    environmentType: "local",
    agentType: "codex",
    phase: "building",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    backendRevision: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    ...overrides,
  };
}

function persisted(
  snapshot: BuildPipeline,
  revision: number,
): PersistedBuildPipeline<BuildPipeline> {
  return {
    version: BUILD_PIPELINE_VERSION,
    id: snapshot.id,
    projectId: snapshot.projectId,
    environmentId: snapshot.environmentId,
    snapshot,
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision,
  };
}

function seed(...pipelines: BuildPipeline[]): void {
  useBuildPipelineStore.setState({
    pipelines: new Map(pipelines.map((entry) => [entry.id, entry])),
    buildEnvironmentIds: new Set(
      pipelines.map((entry) => entry.environmentId).filter(Boolean),
    ),
  });
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  useBuildPipelineStore.setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
  });
});

describe("hydrateBuildPipeline", () => {
  test("adopts the backend snapshot and stamps its revision", async () => {
    const restored = await hydrateBuildPipeline(
      "pipeline-1",
      async () => persisted(pipeline({ phase: "reviewing" }), 7),
    );

    expect(restored).toMatchObject({ phase: "reviewing", backendRevision: 7 });
    expect(useBuildPipelineStore.getState().pipelines.get("pipeline-1"))
      .toMatchObject({ phase: "reviewing", backendRevision: 7 });
  });

  test("keeps a local snapshot that has already seen a newer revision", async () => {
    seed(pipeline({ phase: "verifying", backendRevision: 9 }));

    const restored = await hydrateBuildPipeline(
      "pipeline-1",
      async () => persisted(pipeline({ phase: "building" }), 4),
    );

    expect(restored).toMatchObject({ phase: "verifying", backendRevision: 9 });
  });

  test("drops a snapshot whose id does not match the record", async () => {
    const restored = await hydrateBuildPipeline(
      "pipeline-1",
      async () => ({
        ...persisted(pipeline(), 3),
        snapshot: pipeline({ id: "someone-else" }),
      }),
    );

    expect(restored).toBeNull();
    expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
  });

  test("drops a structurally invalid snapshot rather than applying half of it", async () => {
    const restored = await hydrateBuildPipeline(
      "pipeline-1",
      async () => ({
        ...persisted(pipeline(), 3),
        snapshot: { id: "pipeline-1", phase: "not-a-phase" } as unknown as BuildPipeline,
      }),
    );

    expect(restored).toBeNull();
    expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
  });

  test("returns null when the backend has no record", async () => {
    expect(await hydrateBuildPipeline("pipeline-1", async () => null)).toBeNull();
  });
});

describe("hydrateBuildPipelinesForProject", () => {
  test("restores every pipeline belonging to the project", async () => {
    const restored = await hydrateBuildPipelinesForProject(PROJECT_ID, async () => [
      persisted(pipeline({ id: "pipeline-1" }), 1),
      persisted(pipeline({ id: "pipeline-2", environmentId: "env-2" }), 2),
    ]);

    expect(restored.map((entry) => entry.id)).toEqual(["pipeline-1", "pipeline-2"]);
    expect(useBuildPipelineStore.getState().buildEnvironmentIds)
      .toEqual(new Set(["env-1", "env-2"]));
  });

  test("ignores records belonging to another project", async () => {
    const restored = await hydrateBuildPipelinesForProject(PROJECT_ID, async () => [
      { ...persisted(pipeline({ id: "foreign" }), 1), projectId: "project-2" },
    ]);

    expect(restored).toEqual([]);
    expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
  });

  test("releases a completion-comment lease stranded by a dead client", async () => {
    const restored = await hydrateBuildPipelinesForProject(PROJECT_ID, async () => [
      persisted(pipeline({
        completionCommentStatus: "posting",
        completionCommentError: "half-written",
      }), 3),
    ]);

    expect(restored[0]?.completionCommentStatus).toBeUndefined();
    expect(restored[0]?.completionCommentError).toBeUndefined();
  });

  test("preserves a terminal completion-comment result", async () => {
    const restored = await hydrateBuildPipelinesForProject(PROJECT_ID, async () => [
      persisted(pipeline({ completionCommentStatus: "posted", completionCommentId: "c1" }), 3),
    ]);

    expect(restored[0]).toMatchObject({
      completionCommentStatus: "posted",
      completionCommentId: "c1",
    });
  });
});

describe("persistBuildPipelineNow", () => {
  test("writes with the local revision as the compare-and-swap expectation", async () => {
    seed(pipeline({ backendRevision: 4 }));
    const save = mock(async (
      ..._args: unknown[]
    ) => persisted(pipeline({ backendRevision: 4 }), 5));

    await persistBuildPipelineNow("pipeline-1", { save: save as never });

    expect(save.mock.calls[0]?.[5]).toBe(4);
    expect(useBuildPipelineStore.getState().pipelines.get("pipeline-1")?.backendRevision)
      .toBe(5);
  });

  test("adopts the backend winner on a revision conflict instead of retrying", async () => {
    seed(pipeline({ phase: "building", backendRevision: 2 }));
    const save = mock(async () => {
      throw new Error("Build pipeline revision conflict");
    });
    const load = mock(async () => persisted(pipeline({ phase: "creating-pr" }), 6));

    const result = await persistBuildPipelineNow("pipeline-1", {
      save: save as never,
      load: load as never,
    });

    expect(result).toMatchObject({ phase: "creating-pr", backendRevision: 6 });
  });

  test("propagates a non-conflict failure so the caller does not assume durability", async () => {
    seed(pipeline());
    const save = mock(async () => {
      throw new Error("disk is full");
    });

    await expect(
      persistBuildPipelineNow("pipeline-1", { save: save as never }),
    ).rejects.toThrow("disk is full");
  });

  test("throws for a pipeline this client does not hold", async () => {
    await expect(persistBuildPipelineNow("missing")).rejects.toThrow("not found");
  });
});

describe("startBuildPipelinePersistence", () => {
  test("mirrors a transition to the backend after the debounce", async () => {
    const save = mock(async (..._args: unknown[]) => persisted(pipeline(), 1));
    const stop = startBuildPipelinePersistence({ debounceMs: 5, save: save as never });
    try {
      seed(pipeline());
      await tick(40);

      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]?.[3]).toBe(BUILD_PIPELINE_VERSION);
    } finally {
      stop();
    }
  });

  test("coalesces a burst of transitions into one write", async () => {
    const save = mock(async (..._args: unknown[]) => persisted(pipeline(), 1));
    const stop = startBuildPipelinePersistence({ debounceMs: 20, save: save as never });
    try {
      seed(pipeline({ phase: "building" }));
      useBuildPipelineStore.getState().setPhase("pipeline-1", "reviewing");
      useBuildPipelineStore.getState().setPhase("pipeline-1", "verifying");
      await tick(80);

      expect(save).toHaveBeenCalledTimes(1);
      expect((save.mock.calls[0]?.[4] as BuildPipeline).phase).toBe("verifying");
    } finally {
      stop();
    }
  });

  test("deletes the backend record when a persisted pipeline is dropped", async () => {
    const remove = mock(async () => {});
    const stop = startBuildPipelinePersistence({
      debounceMs: 5,
      save: mock(async () => persisted(pipeline(), 1)) as never,
      remove,
    });
    try {
      seed(pipeline({ backendRevision: 3 }));
      await tick(30);
      useBuildPipelineStore.getState().removePipeline("pipeline-1");
      await tick(30);

      expect(remove).toHaveBeenCalledWith("pipeline-1");
    } finally {
      stop();
    }
  });

  test("does not delete a pipeline the backend never stored", async () => {
    const remove = mock(async () => {});
    const stop = startBuildPipelinePersistence({
      debounceMs: 500,
      save: mock(async () => persisted(pipeline(), 1)) as never,
      remove,
    });
    try {
      seed(pipeline({ backendRevision: 0 }));
      useBuildPipelineStore.getState().removePipeline("pipeline-1");
      await tick(30);

      expect(remove).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  test("adopts the backend winner when a mirrored write conflicts", async () => {
    const save = mock(async () => {
      throw new Error("Build pipeline revision conflict");
    });
    const load = mock(async () => persisted(pipeline({ phase: "complete" }), 11));
    const stop = startBuildPipelinePersistence({
      debounceMs: 5,
      save: save as never,
      load: load as never,
    });
    try {
      seed(pipeline({ phase: "building", backendRevision: 1 }));
      await tick(60);

      expect(useBuildPipelineStore.getState().pipelines.get("pipeline-1"))
        .toMatchObject({ phase: "complete", backendRevision: 11 });
    } finally {
      stop();
    }
  });

  test("stops mirroring once detached", async () => {
    const save = mock(async () => persisted(pipeline(), 1));
    const stop = startBuildPipelinePersistence({ debounceMs: 5, save: save as never });
    stop();

    seed(pipeline());
    await tick(40);

    expect(save).not.toHaveBeenCalled();
  });
});
