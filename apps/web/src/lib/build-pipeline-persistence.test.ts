import { beforeEach, describe, expect, test } from "bun:test";
import {
  hydrateBuildPipeline,
  hydrateBuildPipelinesForProject,
  LEGACY_BUILD_PIPELINE_STORAGE_KEY,
  migrateLegacyBuildPipelines,
} from "./build-pipeline-persistence";
import {
  BUILD_PIPELINE_VERSION,
  useBuildPipelineStore,
  type BuildPipeline,
} from "@/stores/buildPipelineStore";
import type { PersistedBuildPipeline } from "@/types";

function snapshot(id = "pipeline-1"): BuildPipeline {
  return {
    id,
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "env-1",
    environmentType: "local",
    agentType: "codex",
    phase: "building",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-07-29T00:00:00.000Z",
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 0,
    controller: "backend",
  };
}

function record(
  pipeline: BuildPipeline,
  revision: number,
): PersistedBuildPipeline<BuildPipeline> {
  return {
    version: BUILD_PIPELINE_VERSION,
    id: pipeline.id,
    projectId: pipeline.projectId,
    environmentId: pipeline.environmentId,
    snapshot: pipeline,
    revision,
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("build pipeline read model", () => {
  beforeEach(() => {
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("hydrates an authoritative backend snapshot", async () => {
    const restored = await hydrateBuildPipeline(
      "pipeline-1",
      async () => record(snapshot(), 7),
    );
    expect(restored).toMatchObject({
      id: "pipeline-1",
      backendRevision: 7,
      controller: "backend",
    });
  });

  test("hydrates every project pipeline", async () => {
    const restored = await hydrateBuildPipelinesForProject(
      "project-1",
      async () => [record(snapshot("one"), 1), record(snapshot("two"), 2)],
    );
    expect(restored.map((pipeline) => pipeline.id)).toEqual(["one", "two"]);
  });

  test("rejects malformed record metadata and mismatched snapshots", async () => {
    const valid = record(snapshot(), 1);
    const invalidRecords = [
      { ...valid, version: BUILD_PIPELINE_VERSION + 1 },
      { ...valid, revision: 0 },
      { ...valid, revision: Number.NaN },
      { ...valid, updatedAt: "not-a-date" },
      { ...valid, id: "different-id" },
      { ...valid, projectId: "different-project" },
      { ...valid, environmentId: "different-environment" },
      { ...valid, snapshot: { ...snapshot(), controller: "renderer" } as never },
    ];

    for (const invalid of invalidRecords) {
      useBuildPipelineStore.setState({
        pipelines: new Map(),
        buildEnvironmentIds: new Set(),
      });
      expect(
        await hydrateBuildPipeline("pipeline-1", async () => invalid),
      ).toBeNull();
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    }
  });

  test("keeps a newer local revision when a stale point read completes", async () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...snapshot(),
      phase: "reviewing",
      backendRevision: 9,
    });

    const restored = await hydrateBuildPipeline(
      "pipeline-1",
      async () => record({ ...snapshot(), phase: "building" }, 4),
    );

    expect(restored?.phase).toBe("reviewing");
    expect(restored?.backendRevision).toBe(9);
  });

  test("does not resurrect a pipeline deleted during a slow project hydration", async () => {
    const listing = deferred<Array<PersistedBuildPipeline<BuildPipeline>>>();
    const projectHydration = hydrateBuildPipelinesForProject(
      "project-1",
      async () => listing.promise,
    );

    expect(
      await hydrateBuildPipeline("pipeline-1", async () => null),
    ).toBeNull();
    useBuildPipelineStore.getState().removePipeline("pipeline-1");
    listing.resolve([record(snapshot(), 3)]);

    expect(await projectHydration).toEqual([]);
    expect(useBuildPipelineStore.getState().pipelines.has("pipeline-1")).toBe(false);
  });

  test("ignores an older project response that finishes after a newer response", async () => {
    const older = deferred<Array<PersistedBuildPipeline<BuildPipeline>>>();
    const first = hydrateBuildPipelinesForProject(
      "project-1",
      async () => older.promise,
    );
    const second = await hydrateBuildPipelinesForProject(
      "project-1",
      async () => [record({ ...snapshot("new"), phase: "reviewing" }, 7)],
    );

    older.resolve([record({ ...snapshot("old"), phase: "building" }, 1)]);
    const staleResult = await first;

    expect(second.map(({ id }) => id)).toEqual(["new"]);
    expect(staleResult.map(({ id }) => id)).toEqual(["new"]);
    expect(useBuildPipelineStore.getState().pipelines.has("old")).toBe(false);
  });

  test("a superseded point read cannot remove a newer point-read result", async () => {
    const older = deferred<PersistedBuildPipeline<BuildPipeline> | null>();
    const first = hydrateBuildPipeline("pipeline-1", async () => older.promise);
    const second = await hydrateBuildPipeline(
      "pipeline-1",
      async () => record({ ...snapshot(), phase: "verifying" }, 8),
    );

    older.resolve(null);
    const staleResult = await first;

    expect(second?.phase).toBe("verifying");
    expect(staleResult?.phase).toBe("verifying");
    expect(useBuildPipelineStore.getState().pipelines.get("pipeline-1")?.phase)
      .toBe("verifying");
  });
});

describe("legacy build pipeline migration", () => {
  function legacySnapshot(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const {
      backendRevision: _backendRevision,
      controller: _controller,
      ...legacy
    } = snapshot();
    return { ...legacy, ...overrides };
  }

  function storageWith(value: unknown) {
    const values = new Map<string, string>();
    if (value !== undefined) {
      values.set(LEGACY_BUILD_PIPELINE_STORAGE_KEY, JSON.stringify(value));
    }
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
  }

  test("imports valid legacy snapshots through the backend and removes the key", async () => {
    const legacy = legacySnapshot();
    const storage = storageWith({
      version: 1,
      state: { pipelines: [["pipeline-1", legacy]] },
    });
    const imports: Array<{ projectId: string; snapshots: unknown[] }> = [];

    const result = await migrateLegacyBuildPipelines(
      storage,
      async (projectId, snapshots) => {
        imports.push({ projectId, snapshots });
        return { importedIds: ["pipeline-1"], skipped: 0 };
      },
      async () => record(snapshot(), 1),
    );

    expect(imports).toEqual([{
      projectId: "project-1",
      snapshots: [legacy],
    }]);
    expect(result).toEqual({ importedIds: ["pipeline-1"], skipped: 0 });
    expect(storage.getItem(LEGACY_BUILD_PIPELINE_STORAGE_KEY)).toBeNull();
    expect(useBuildPipelineStore.getState().pipelines.has("pipeline-1")).toBe(true);
  });

  test("groups imports by project and counts malformed entries", async () => {
    const storage = storageWith({
      version: 1,
      state: {
        pipelines: [
          ["pipeline-1", legacySnapshot()],
          ["pipeline-2", legacySnapshot({
            id: "pipeline-2",
            projectId: "project-2",
          })],
          ["wrong-id", legacySnapshot()],
          ["missing-project", legacySnapshot({
            id: "missing-project",
            projectId: "",
          })],
          null,
        ],
      },
    });
    const projects: string[] = [];

    const result = await migrateLegacyBuildPipelines(
      storage,
      async (projectId, snapshots) => {
        projects.push(projectId);
        return {
          importedIds: snapshots.map((entry) =>
            (entry as { id: string }).id),
          skipped: 0,
        };
      },
      async (id) => record(snapshot(id), 1),
    );

    expect(projects).toEqual(["project-1", "project-2"]);
    expect(result.importedIds).toEqual(["pipeline-1", "pipeline-2"]);
    expect(result.skipped).toBe(3);
  });

  test("retains the legacy key when the backend import fails", async () => {
    const storage = storageWith({
      version: 1,
      state: { pipelines: [["pipeline-1", legacySnapshot()]] },
    });

    await expect(migrateLegacyBuildPipelines(
      storage,
      async () => {
        throw new Error("backend unavailable");
      },
    )).rejects.toThrow("backend unavailable");
    expect(storage.getItem(LEGACY_BUILD_PIPELINE_STORAGE_KEY)).not.toBeNull();
  });

  test("does not consume a future or invalid legacy schema version", async () => {
    for (const version of [2, -1, "one"]) {
      const storage = storageWith({
        version,
        state: { pipelines: [["pipeline-1", legacySnapshot()]] },
      });
      const result = await migrateLegacyBuildPipelines(storage);

      expect(result.importedIds).toEqual([]);
      expect(result.skipped).toBe(1);
      expect(storage.getItem(LEGACY_BUILD_PIPELINE_STORAGE_KEY)).not.toBeNull();
    }
  });

  test("discards irrecoverably malformed JSON without throwing", async () => {
    const values = new Map([[LEGACY_BUILD_PIPELINE_STORAGE_KEY, "{broken"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => {
        values.delete(key);
      },
    };

    expect(await migrateLegacyBuildPipelines(storage)).toEqual({
      importedIds: [],
      skipped: 1,
    });
    expect(values.has(LEGACY_BUILD_PIPELINE_STORAGE_KEY)).toBe(false);
  });

  test("handles absent and inaccessible storage", async () => {
    expect(await migrateLegacyBuildPipelines(undefined)).toEqual({
      importedIds: [],
      skipped: 0,
    });
    expect(await migrateLegacyBuildPipelines({
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    })).toEqual({ importedIds: [], skipped: 0 });
  });
});
