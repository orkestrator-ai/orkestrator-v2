import { beforeEach, describe, expect, test } from "bun:test";
import {
  hydrateBuildPipeline,
  hydrateBuildPipelinesForProject,
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
});
