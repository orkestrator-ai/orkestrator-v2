import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  hydrateBuildPipeline,
  hydrateBuildPipelinesForProject,
  LEGACY_BUILD_PIPELINE_STORAGE_KEY,
  migrateLegacyBuildPipelines,
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

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await tick(5);
  }
}

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

  test("keeps an unsaved local transition at the same backend revision", async () => {
    const save = mock(async (
      _id: string,
      _projectId: string,
      _environmentId: string,
      _version: number,
      snapshot: BuildPipeline,
    ) => persisted(snapshot, 6));
    const stop = startBuildPipelinePersistence({
      debounceMs: 10_000,
      save: save as never,
    });
    try {
      seed(pipeline({ phase: "verifying", backendRevision: 5 }));

      const restored = await hydrateBuildPipeline(
        "pipeline-1",
        async () => persisted(pipeline({ phase: "building" }), 5),
      );

      expect(restored).toMatchObject({ phase: "verifying", backendRevision: 5 });
    } finally {
      stop();
      await tick(10);
    }
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

  test("rejects past and future snapshot schema versions", async () => {
    for (const version of [BUILD_PIPELINE_VERSION - 1, BUILD_PIPELINE_VERSION + 1]) {
      const restored = await hydrateBuildPipeline(
        "pipeline-1",
        async () => ({ ...persisted(pipeline(), 3), version }),
      );

      expect(restored).toBeNull();
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    }
  });

  test("rejects invalid record metadata and environment mismatches", async () => {
    for (const record of [
      { ...persisted(pipeline(), 3), revision: Number.NaN },
      { ...persisted(pipeline(), 3), revision: 0 },
      { ...persisted(pipeline(), 3), updatedAt: "not-a-date" },
      { ...persisted(pipeline(), 3), environmentId: "another-env" },
    ]) {
      const restored = await hydrateBuildPipeline(
        "pipeline-1",
        async () => record,
      );

      expect(restored).toBeNull();
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    }
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

  test("restores a pipeline that never reached an environment", async () => {
    // The crash window this exists for: a pipeline created, then the client
    // died before its environment existed. It is keyed only by project, so
    // nothing about it can be recovered from the environment list.
    const stranded = pipeline({
      id: "pipeline-stranded",
      environmentId: "",
      phase: "creating-environment",
    });

    const restored = await hydrateBuildPipelinesForProject(
      PROJECT_ID,
      async () => [persisted(stranded, 1)],
    );

    expect(restored.map((entry) => entry.id)).toEqual(["pipeline-stranded"]);
    expect(useBuildPipelineStore.getState().pipelines.get("pipeline-stranded")?.phase)
      .toBe("creating-environment");
    // A blank environment id must not be added to the derived set.
    expect(useBuildPipelineStore.getState().buildEnvironmentIds.has("")).toBe(false);
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

  test("keeps dirty equal-revision and locally newer pipelines during project hydration", async () => {
    const save = mock(async (
      _id: string,
      _projectId: string,
      _environmentId: string,
      _version: number,
      snapshot: BuildPipeline,
    ) => persisted(snapshot, snapshot.backendRevision + 1));
    const stop = startBuildPipelinePersistence({
      debounceMs: 10_000,
      save: save as never,
    });
    try {
      seed(
        pipeline({ id: "pipeline-1", phase: "verifying", backendRevision: 5 }),
        pipeline({
          id: "pipeline-newer",
          environmentId: "env-newer",
          phase: "creating-pr",
          backendRevision: 9,
        }),
      );

      const restored = await hydrateBuildPipelinesForProject(PROJECT_ID, async () => [
        persisted(pipeline({ id: "pipeline-1", phase: "building" }), 5),
        persisted(pipeline({
          id: "pipeline-newer",
          environmentId: "env-newer",
          phase: "reviewing",
        }), 8),
      ]);

      expect(restored).toEqual([
        expect.objectContaining({ id: "pipeline-1", phase: "verifying", backendRevision: 5 }),
        expect.objectContaining({
          id: "pipeline-newer",
          phase: "creating-pr",
          backendRevision: 9,
        }),
      ]);
    } finally {
      stop();
      await tick(10);
    }
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

  test("propagates a conflict when the backend winner is invalid", async () => {
    seed(pipeline({ backendRevision: 2 }));
    const save = mock(async () => {
      throw new Error("Build pipeline revision conflict");
    });
    const load = mock(async () => ({
      ...persisted(pipeline({ phase: "creating-pr" }), 6),
      version: BUILD_PIPELINE_VERSION + 1,
    }));

    await expect(
      persistBuildPipelineNow("pipeline-1", {
        save: save as never,
        load: load as never,
      }),
    ).rejects.toThrow("revision conflict");
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

  test("retries a transient mirrored write without requiring another transition", async () => {
    let calls = 0;
    const save = mock(async (..._args: unknown[]) => {
      calls += 1;
      if (calls === 1) throw new Error("disk temporarily unavailable");
      return persisted(pipeline(), 1);
    });
    const stop = startBuildPipelinePersistence({
      debounceMs: 5,
      retryMs: 5,
      maxRetryMs: 10,
      save: save as never,
    });
    try {
      seed(pipeline({ phase: "reviewing" }));

      await waitForCondition(() => save.mock.calls.length >= 2);

      expect(save).toHaveBeenCalledTimes(2);
      expect(useBuildPipelineStore.getState().pipelines.get("pipeline-1")?.backendRevision)
        .toBe(1);
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

  test("seeds pipelines that predate the subscription so a restart cannot strand one", async () => {
    // A pipeline restored from localStorage, or created before the mirror
    // started, has no transition left to observe — only this pass writes it.
    seed(pipeline());
    const save = mock(async () => persisted(pipeline(), 1));
    const stop = startBuildPipelinePersistence({ debounceMs: 5, save: save as never });
    try {
      await tick(40);
      expect(save).toHaveBeenCalledTimes(1);
      expect((save.mock.calls[0] as unknown as unknown[])[0]).toBe("pipeline-1");
    } finally {
      stop();
    }
  });

  test("flushes an outstanding write when the page is hidden", async () => {
    // The debounce would otherwise lose a transition to a closing window.
    const save = mock(async () => persisted(pipeline(), 1));
    const stop = startBuildPipelinePersistence({ debounceMs: 10_000, save: save as never });
    try {
      seed(pipeline({ phase: "reviewing" }));
      await tick(5);
      expect(save).not.toHaveBeenCalled();

      window.dispatchEvent(new Event("pagehide"));
      await tick(20);

      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  test("flushes an outstanding write on detach rather than dropping it", async () => {
    const save = mock(async () => persisted(pipeline(), 1));
    const stop = startBuildPipelinePersistence({ debounceMs: 10_000, save: save as never });
    seed(pipeline({ phase: "reviewing" }));
    await tick(5);
    expect(save).not.toHaveBeenCalled();

    stop();
    await tick(20);

    expect(save).toHaveBeenCalledTimes(1);
  });

  test("stops listening for pagehide after detach", async () => {
    const save = mock(async () => persisted(pipeline(), 1));
    const stop = startBuildPipelinePersistence({ debounceMs: 10_000, save: save as never });
    stop();
    await tick(20);
    save.mockClear();

    window.dispatchEvent(new Event("pagehide"));
    await tick(20);

    expect(save).not.toHaveBeenCalled();
  });
});

describe("migrateLegacyBuildPipelines", () => {
  function legacyEntry(overrides: Record<string, unknown> = {}) {
    const { backendRevision: _drop, ...legacy } = pipeline();
    return { ...legacy, ...overrides };
  }

  function legacyStorage(value: unknown) {
    const store = new Map<string, string>();
    if (value !== undefined) {
      store.set(LEGACY_BUILD_PIPELINE_STORAGE_KEY, JSON.stringify(value));
    }
    return {
      store,
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => { store.delete(key); },
    };
  }

  test("adopts a pipeline left behind by a pre-backend build", () => {
    const storage = legacyStorage({
      state: { pipelines: [["pipeline-1", legacyEntry({ phase: "building" })]] },
      version: 1,
    });

    const adopted = migrateLegacyBuildPipelines(storage);

    expect(adopted.map((entry) => entry.id)).toEqual(["pipeline-1"]);
    const restored = useBuildPipelineStore.getState().pipelines.get("pipeline-1");
    expect(restored?.phase).toBe("building");
    // The backend has never seen it, so the first save must find no prior record.
    expect(restored?.backendRevision).toBe(0);
    expect(useBuildPipelineStore.getState().buildEnvironmentIds.has("env-1")).toBe(true);
  });

  test("removes the legacy key so the migration runs exactly once", () => {
    const storage = legacyStorage({
      state: { pipelines: [["pipeline-1", legacyEntry()]] },
      version: 1,
    });

    migrateLegacyBuildPipelines(storage);

    expect(storage.getItem(LEGACY_BUILD_PIPELINE_STORAGE_KEY)).toBeNull();
    expect(migrateLegacyBuildPipelines(storage)).toEqual([]);
  });

  test("clears a posting lease left by a client that died mid-post", () => {
    const storage = legacyStorage({
      state: {
        pipelines: [["pipeline-1", legacyEntry({
          phase: "complete",
          completionCommentStatus: "posting",
          completionCommentError: "half-written",
        })]],
      },
      version: 1,
    });

    migrateLegacyBuildPipelines(storage);

    const restored = useBuildPipelineStore.getState().pipelines.get("pipeline-1");
    expect(restored?.completionCommentStatus).toBeUndefined();
    expect(restored?.completionCommentError).toBeUndefined();
  });

  test("never overwrites a pipeline the backend already restored", () => {
    // Hydration can win the race; the backend copy is by definition newer.
    seed(pipeline({ phase: "complete", backendRevision: 9 }));
    const storage = legacyStorage({
      state: { pipelines: [["pipeline-1", legacyEntry({ phase: "building" })]] },
      version: 1,
    });

    expect(migrateLegacyBuildPipelines(storage)).toEqual([]);
    expect(useBuildPipelineStore.getState().pipelines.get("pipeline-1")?.phase).toBe("complete");
  });

  test("skips malformed entries while retaining the valid ones", () => {
    const storage = legacyStorage({
      state: {
        pipelines: [
          null,
          ["missing-pipeline"],
          [42, legacyEntry()],
          ["empty", null],
          ["mismatched-id", legacyEntry({ id: "other" })],
          ["broken", legacyEntry({ id: "broken", phase: "teleporting" })],
          ["pipeline-1", legacyEntry()],
        ],
      },
      version: 1,
    });

    migrateLegacyBuildPipelines(storage);

    expect([...useBuildPipelineStore.getState().pipelines.keys()]).toEqual(["pipeline-1"]);
  });

  test("does nothing when there is no legacy entry", () => {
    expect(migrateLegacyBuildPipelines(legacyStorage(undefined))).toEqual([]);
    expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
  });

  test("survives an unparseable legacy entry", () => {
    const store = new Map([[LEGACY_BUILD_PIPELINE_STORAGE_KEY, "{not json"]]);
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => { store.delete(key); },
    };

    expect(() => migrateLegacyBuildPipelines(storage)).not.toThrow();
    expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
  });

  test("survives storage that throws, as blocked or private-mode storage does", () => {
    const storage = {
      getItem: () => { throw new Error("access denied"); },
      removeItem: () => { throw new Error("access denied"); },
    };

    expect(migrateLegacyBuildPipelines(storage)).toEqual([]);
  });

  test("does nothing when no storage is available at all", () => {
    expect(migrateLegacyBuildPipelines(undefined)).toEqual([]);
  });
});
