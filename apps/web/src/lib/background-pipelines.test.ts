import { describe, expect, test } from "bun:test";
import { getBackgroundProcessingEnvironments } from "./background-pipelines";
import type { Environment } from "@/types";
import type { BuildPipeline } from "@/stores/buildPipelineStore";

const environment: Environment = {
  id: "env-1",
  projectId: "project-1",
  name: "env",
  branch: "env",
  containerId: null,
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-07-29T00:00:00.000Z",
  networkAccessMode: "full",
  order: 0,
  environmentType: "local",
};

describe("getBackgroundProcessingEnvironments", () => {
  test("does not mount an environment merely because a pipeline is active", () => {
    const pipelines = new Map<string, BuildPipeline>([["pipeline-1", {
      id: "pipeline-1",
      taskId: "task-1",
      projectId: "project-1",
      environmentId: environment.id,
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
      backendRevision: 1,
      controller: "backend",
    }]]);
    expect(getBackgroundProcessingEnvironments(
      pipelines,
      [environment],
      null,
    )).toEqual([]);
  });

  test("still mounts frontend-owned setup work", () => {
    expect(getBackgroundProcessingEnvironments(
      new Map(),
      [environment],
      null,
      new Set([environment.id]),
    )).toEqual([environment]);
  });

  test("does not duplicate the visible environment", () => {
    expect(getBackgroundProcessingEnvironments(
      new Map(),
      [environment],
      environment.id,
      new Set([environment.id]),
    )).toEqual([]);
  });
});
