import { beforeEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
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

const invokeMock = invoke as ReturnType<typeof mock>;

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

function record(pipeline: BuildPipeline, revision: number): PersistedBuildPipeline<BuildPipeline> {
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
    invokeMock.mockReset();
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("hydrates an authoritative backend snapshot", async () => {
    const restored = await hydrateBuildPipeline("pipeline-1", async () => record(snapshot(), 7));
    expect(restored).toMatchObject({
      id: "pipeline-1",
      backendRevision: 7,
      controller: "backend",
    });
  });

  test("hydrates every project pipeline", async () => {
    const restored = await hydrateBuildPipelinesForProject("project-1", async () => [
      record(snapshot("one"), 1),
      record(snapshot("two"), 2),
    ]);
    expect(restored.map((pipeline) => pipeline.id)).toEqual(["one", "two"]);
  });

  test("uses revision and session cursors for an unchanged production point read", async () => {
    const local = {
      ...snapshot(),
      currentSessionIndex: 0,
      sessions: [
        {
          phase: "build" as const,
          iteration: 0,
          sessionKey: "session-1",
          sdkSessionId: "sdk-1",
          status: "idle" as const,
          startedAt: "2026-07-29T00:00:00.000Z",
          label: "Build",
          messages: [{ id: "message-1" }],
          messageRevision: 4,
        },
      ],
      backendRevision: 7,
    };
    useBuildPipelineStore.getState().replacePipeline(local);
    invokeMock.mockResolvedValueOnce({ unchanged: true, revision: 7 });

    const restored = await hydrateBuildPipeline("pipeline-1");

    expect(restored).toBe(local);
    expect(invokeMock).toHaveBeenCalledWith("get_build_pipeline", {
      pipelineId: "pipeline-1",
      knownRevision: 7,
      knownSessions: {
        "session-1": { revision: 4, count: 1 },
      },
    });
  });

  test("merges production tail patches and preserves omitted unchanged messages", async () => {
    const unchangedMessages = [{ id: "unchanged-message" }];
    const patchedMessages = [{ id: "old-1" }, { id: "old-2" }];
    const local = {
      ...snapshot(),
      currentSessionIndex: 1,
      sessions: [
        {
          phase: "build" as const,
          iteration: 0,
          sessionKey: "unchanged-session",
          sdkSessionId: "sdk-unchanged",
          status: "idle" as const,
          startedAt: "2026-07-29T00:00:00.000Z",
          label: "Unchanged",
          messages: unchangedMessages,
          messageRevision: 2,
        },
        {
          phase: "review" as const,
          iteration: 0,
          sessionKey: "patched-session",
          sdkSessionId: "sdk-patched",
          status: "running" as const,
          startedAt: "2026-07-29T00:00:00.000Z",
          label: "Patched",
          messages: patchedMessages,
          messageRevision: 3,
        },
      ],
      backendRevision: 7,
    };
    useBuildPipelineStore.getState().replacePipeline(local);
    const remote = {
      ...local,
      phase: "reviewing" as const,
      backendRevision: 0,
      sessions: local.sessions.map(({ messages: _messages, ...session }) => session),
    };
    invokeMock.mockResolvedValueOnce({
      unchanged: false,
      record: record(remote, 8),
      messagePatches: [
        {
          sessionKey: "patched-session",
          baseRevision: 3,
          baseCount: 2,
          startIndex: 1,
          revision: 4,
          messages: [{ id: "new-2" }, { id: "new-3" }],
        },
      ],
    });

    const restored = await hydrateBuildPipeline("pipeline-1");

    expect(restored?.sessions[0]?.messages).toBe(unchangedMessages);
    expect(restored?.sessions[1]?.messages).toEqual([
      { id: "old-1" },
      { id: "new-2" },
      { id: "new-3" },
    ]);
    expect(restored?.sessions[1]?.messageRevision).toBe(4);
    expect(restored?.backendRevision).toBe(8);
  });

  test("falls back to a full production read when a tail patch cannot apply", async () => {
    const local = {
      ...snapshot(),
      currentSessionIndex: 0,
      sessions: [
        {
          phase: "build" as const,
          iteration: 0,
          sessionKey: "session-1",
          sdkSessionId: "sdk-1",
          status: "idle" as const,
          startedAt: "2026-07-29T00:00:00.000Z",
          label: "Build",
          messages: [{ id: "old" }],
          messageRevision: 5,
        },
      ],
      backendRevision: 7,
    };
    useBuildPipelineStore.getState().replacePipeline(local);
    const remote = {
      ...local,
      backendRevision: 0,
      sessions: local.sessions.map(({ messages: _messages, ...session }) => session),
    };
    const full = record(
      {
        ...local,
        phase: "verifying",
        backendRevision: 0,
        sessions: [
          {
            ...local.sessions[0]!,
            messages: [{ id: "authoritative" }],
            messageRevision: 6,
          },
        ],
      },
      8,
    );
    invokeMock
      .mockResolvedValueOnce({
        unchanged: false,
        record: record(remote, 8),
        messagePatches: [
          {
            sessionKey: "session-1",
            baseRevision: 4,
            baseCount: 1,
            startIndex: 1,
            revision: 6,
            messages: [{ id: "cannot-apply" }],
          },
        ],
      })
      .mockResolvedValueOnce(full);

    const restored = await hydrateBuildPipeline("pipeline-1");

    expect(restored?.phase).toBe("verifying");
    expect(restored?.sessions[0]?.messages).toEqual([{ id: "authoritative" }]);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_build_pipeline", {
      pipelineId: "pipeline-1",
    });
  });

  test("reuses unchanged production list entries and exposes deleted ids", async () => {
    const unchanged = { ...snapshot("unchanged"), backendRevision: 4 };
    const changedLocal = { ...snapshot("changed"), backendRevision: 2 };
    const deleted = { ...snapshot("deleted"), backendRevision: 3 };
    useBuildPipelineStore.getState().replacePipeline(unchanged);
    useBuildPipelineStore.getState().replacePipeline(changedLocal);
    useBuildPipelineStore.getState().replacePipeline(deleted);
    invokeMock.mockResolvedValueOnce({
      ids: ["unchanged", "changed"],
      records: [
        record(
          {
            ...snapshot("changed"),
            phase: "reviewing",
          },
          5,
        ),
      ],
    });

    const restored = await hydrateBuildPipelinesForProject("project-1");

    expect(restored.map(({ id }) => id).sort()).toEqual(["changed", "unchanged"]);
    expect(restored.find(({ id }) => id === "unchanged")).toBe(unchanged);
    expect(restored.some(({ id }) => id === "deleted")).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("list_build_pipelines", {
      projectId: "project-1",
      knownRevisions: {
        unchanged: 4,
        changed: 2,
        deleted: 3,
      },
    });
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
      expect(await hydrateBuildPipeline("pipeline-1", async () => invalid)).toBeNull();
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    }
  });

  test("keeps a newer local revision when a stale point read completes", async () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...snapshot(),
      phase: "reviewing",
      backendRevision: 9,
    });

    const restored = await hydrateBuildPipeline("pipeline-1", async () =>
      record({ ...snapshot(), phase: "building" }, 4),
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

    expect(await hydrateBuildPipeline("pipeline-1", async () => null)).toBeNull();
    useBuildPipelineStore.getState().removePipeline("pipeline-1");
    listing.resolve([record(snapshot(), 3)]);

    expect(await projectHydration).toEqual([]);
    expect(useBuildPipelineStore.getState().pipelines.has("pipeline-1")).toBe(false);
  });

  test("ignores an older project response that finishes after a newer response", async () => {
    const older = deferred<Array<PersistedBuildPipeline<BuildPipeline>>>();
    const first = hydrateBuildPipelinesForProject("project-1", async () => older.promise);
    const second = await hydrateBuildPipelinesForProject("project-1", async () => [
      record({ ...snapshot("new"), phase: "reviewing" }, 7),
    ]);

    older.resolve([record({ ...snapshot("old"), phase: "building" }, 1)]);
    const staleResult = await first;

    expect(second.map(({ id }) => id)).toEqual(["new"]);
    expect(staleResult.map(({ id }) => id)).toEqual(["new"]);
    expect(useBuildPipelineStore.getState().pipelines.has("old")).toBe(false);
  });

  test("a superseded point read cannot remove a newer point-read result", async () => {
    const older = deferred<PersistedBuildPipeline<BuildPipeline> | null>();
    const first = hydrateBuildPipeline("pipeline-1", async () => older.promise);
    const second = await hydrateBuildPipeline("pipeline-1", async () =>
      record({ ...snapshot(), phase: "verifying" }, 8),
    );

    older.resolve(null);
    const staleResult = await first;

    expect(second?.phase).toBe("verifying");
    expect(staleResult?.phase).toBe("verifying");
    expect(useBuildPipelineStore.getState().pipelines.get("pipeline-1")?.phase).toBe("verifying");
  });
});

describe("legacy build pipeline migration", () => {
  function legacySnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const { backendRevision: _backendRevision, controller: _controller, ...legacy } = snapshot();
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

    expect(imports).toEqual([
      {
        projectId: "project-1",
        snapshots: [legacy],
      },
    ]);
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
          [
            "pipeline-2",
            legacySnapshot({
              id: "pipeline-2",
              projectId: "project-2",
            }),
          ],
          ["wrong-id", legacySnapshot()],
          [
            "missing-project",
            legacySnapshot({
              id: "missing-project",
              projectId: "",
            }),
          ],
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
          importedIds: snapshots.map((entry) => (entry as { id: string }).id),
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

    await expect(
      migrateLegacyBuildPipelines(storage, async () => {
        throw new Error("backend unavailable");
      }),
    ).rejects.toThrow("backend unavailable");
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
    expect(
      await migrateLegacyBuildPipelines({
        getItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toEqual({ importedIds: [], skipped: 0 });
  });
});

describe("structured review normalization on hydrate", () => {
  beforeEach(() => {
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  const legacyReport = {
    reviewScope: {
      targetBranch: "main",
      baseRef: "base",
      commit: { sha: "head", subject: "feat: build" },
      filesReviewed: [],
      filesSkipped: [],
      filesLeftUncommitted: [],
      commandsRun: [],
      commandsNotRun: [],
      limitations: [],
    },
    whatChanged: {
      overview: "o",
      before: "b",
      after: "a",
      keyCodeChanges: [],
      userImpact: "u",
    },
    riskProfile: {
      changeTypes: ["feature"],
      riskAreas: [],
      overallRisk: "low",
      reasoning: "r",
    },
    // The legacy shape the parser is asked to upgrade: no notRun field, which
    // the current contract requires and the backfill derives.
    testResults: { total: 3, passed: 2, failed: 0, failures: [] },
    strengths: [],
    issues: [],
    testCoverageGaps: [],
    verdict: { ready: "yes", reasoning: "r" },
    summaryOfChange: "s",
    reviewSummary: "r",
  };

  test("upgrades a legacy structured review so the snapshot still validates", async () => {
    const stored = {
      ...snapshot(),
      structuredReview: legacyReport,
    } as unknown as BuildPipeline;

    const hydrated = await hydrateBuildPipeline("pipeline-1", async () => record(stored, 4));

    // Without normalization the guard rejects the legacy report and the whole
    // pipeline silently disappears from the UI with no error anywhere.
    expect(hydrated).not.toBeNull();
    expect(hydrated?.structuredReview?.testResults.notRun).toBe(1);
  });

  test("passes through a snapshot that carries no review at all", async () => {
    const hydrated = await hydrateBuildPipeline("pipeline-1", async () => record(snapshot(), 2));

    expect(hydrated?.structuredReview).toBeUndefined();
    expect(hydrated?.backendRevision).toBe(2);
  });

  test("drops a review that cannot be repaired rather than guessing", async () => {
    const stored = {
      ...snapshot(),
      structuredReview: { issues: "not-a-report" },
    } as unknown as BuildPipeline;

    // The unrepaired value fails isBuildPipeline, so the record is treated as
    // unusable. Installing it half-parsed would put an invalid report on screen.
    expect(await hydrateBuildPipeline("pipeline-1", async () => record(stored, 3))).toBeNull();
  });
});

describe("hydration generation bookkeeping", () => {
  beforeEach(() => {
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("keeps deletion markers effective across many distinct pipelines", async () => {
    // The marker maps are bounded, and an evicted deletion marker re-opens the
    // resurrect-a-deleted-pipeline case the markers exist to prevent. Prove the
    // most recent deletion still wins after a burst of unrelated hydrations.
    const listResult = deferred<Array<ReturnType<typeof record>>>();
    const projectHydration = hydrateBuildPipelinesForProject("project-1", () => listResult.promise);

    for (let index = 0; index < 50; index += 1) {
      await hydrateBuildPipeline(`filler-${index}`, async () =>
        record({ ...snapshot(`filler-${index}`) }, 1),
      );
    }
    expect(await hydrateBuildPipeline("pipeline-1", async () => null)).toBeNull();

    listResult.resolve([record(snapshot("pipeline-1"), 1)]);
    const restored = await projectHydration;

    expect(restored.map((pipeline) => pipeline.id)).not.toContain("pipeline-1");
    expect(useBuildPipelineStore.getState().pipelines.has("pipeline-1")).toBe(false);
  });
});
