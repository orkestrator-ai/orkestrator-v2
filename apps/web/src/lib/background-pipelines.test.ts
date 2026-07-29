import { describe, expect, test } from "bun:test";
import { getBackgroundProcessingEnvironments } from "./background-pipelines";
import type { Environment } from "@/types";
import type { BuildPipeline } from "@/stores/buildPipelineStore";
import type { LoopedReviewWorkflow } from "@/stores/loopedReviewStore";

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

describe("getBackgroundProcessingEnvironments signals", () => {
  const second: Environment = { ...environment, id: "env-2", order: 1 };
  const environments = [environment, second];
  const none = new Map<string, BuildPipeline>();

  /**
   * Each of these arrives in its own positional slot. With eleven parameters an
   * argument passed into the wrong slot still typechecks — both sides are
   * iterables of strings — and the only thing that catches it is asserting each
   * slot independently.
   */
  test.each([
    ["pendingNativeLaunch", 4],
    ["pendingInitialPrompt", 5],
    ["loadingNativeSession", 6],
    ["queuedAgentPrompt", 7],
    ["pendingSetup", 8],
    ["durablePendingAgentLaunch", 10],
  ])("mounts an off-screen environment for %s work", (_name, position) => {
    const args: unknown[] = [none, environments, null];
    for (let index = 3; index <= 10; index += 1) {
      args[index] = index === 3 ? new Set<string>() : [];
    }
    args[position] = [second.id];

    const result = (
      getBackgroundProcessingEnvironments as unknown as
        (...values: unknown[]) => Environment[]
    )(...args);

    expect(result.map((env) => env.id)).toEqual([second.id]);
  });

  test("ignores blank environment ids in every signal", () => {
    const result = getBackgroundProcessingEnvironments(
      none,
      environments,
      null,
      new Set(),
      [""],
      [""],
      [""],
      [""],
      [""],
      [],
      [""],
    );

    expect(result).toEqual([]);
  });

  // Only the id, environmentId and phase are read; the rest of the workflow
  // record is irrelevant here and would be noise in every case below.
  const workflowFixture = (
    overrides: Partial<LoopedReviewWorkflow> = {},
  ): LoopedReviewWorkflow => ({
    id: "workflow-1",
    environmentId: second.id,
    phase: "reviewing",
    ...overrides,
  } as unknown as LoopedReviewWorkflow);

  test("mounts a looped review that is still running and drops terminal ones", () => {
    const workflow = workflowFixture;

    expect(getBackgroundProcessingEnvironments(
      none,
      environments,
      null,
      new Set(),
      [], [], [], [], [],
      [workflow({})],
    ).map((env) => env.id)).toEqual([second.id]);

    // A finished workflow has nothing left to drive, so keeping its environment
    // mounted is pure cost.
    for (const phase of ["completed", "cancelled"] as const) {
      expect(getBackgroundProcessingEnvironments(
        none,
        environments,
        null,
        new Set(),
        [], [], [], [], [],
        [workflow({ phase })],
      )).toEqual([]);
    }
  });

  test("ignores a looped review with no environment", () => {
    expect(getBackgroundProcessingEnvironments(
      none,
      environments,
      null,
      new Set(),
      [], [], [], [], [],
      [workflowFixture({ environmentId: "" })],
    )).toEqual([]);
  });

  test("returns environments in store order when several need mounting", () => {
    const result = getBackgroundProcessingEnvironments(
      none,
      environments,
      null,
      new Set([second.id]),
      [environment.id],
    );

    expect(result.map((env) => env.id)).toEqual([environment.id, second.id]);
  });
});
