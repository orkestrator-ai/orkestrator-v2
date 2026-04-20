import { describe, test, expect } from "bun:test";
import { getBackgroundProcessingEnvironments } from "./background-pipelines";
import type { BuildPipeline } from "@/stores/buildPipelineStore";
import type { Environment } from "@/types";

function makeEnv(id: string, projectId = "proj-1"): Environment {
  return {
    id,
    projectId,
    name: `env-${id}`,
    containerId: `container-${id}`,
    status: "running",
    prUrl: null,
    createdAt: new Date().toISOString(),
  } as Environment;
}

function makePipeline(
  id: string,
  environmentId: string,
  phase: BuildPipeline["phase"] = "building",
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
    createdAt: new Date().toISOString(),
    taskTitle: `Task ${id}`,
    taskSnapshot: { title: `Task ${id}`, description: "", acceptanceCriteria: "", comments: [], images: [] },
  } as BuildPipeline;
}

describe("getBackgroundProcessingEnvironments", () => {
  test("returns empty array when there are no pipelines", () => {
    const result = getBackgroundProcessingEnvironments(
      new Map(),
      [makeEnv("e1")],
      "e1",
      [makeEnv("e1")],
    );
    expect(result).toEqual([]);
  });

  test("returns empty array when all pipelines are complete", () => {
    const pipelines = new Map([
      ["p1", makePipeline("p1", "e1", "complete")],
    ]);
    const result = getBackgroundProcessingEnvironments(
      pipelines,
      [makeEnv("e1")],
      null,
      [],
    );
    expect(result).toEqual([]);
  });

  test("returns empty array when all pipelines are failed", () => {
    const pipelines = new Map([
      ["p1", makePipeline("p1", "e1", "failed")],
    ]);
    const result = getBackgroundProcessingEnvironments(
      pipelines,
      [makeEnv("e1")],
      null,
      [],
    );
    expect(result).toEqual([]);
  });

  test("excludes pipelines with empty environmentId", () => {
    const pipelines = new Map([
      ["p1", makePipeline("p1", "", "building")],
    ]);
    const result = getBackgroundProcessingEnvironments(
      pipelines,
      [makeEnv("e1")],
      null,
      [],
    );
    expect(result).toEqual([]);
  });

  test("returns environments with active pipelines when not visible", () => {
    const env1 = makeEnv("e1");
    const pipelines = new Map([
      ["p1", makePipeline("p1", "e1", "building")],
    ]);
    // No selected environment → nothing visible → e1 should be background
    const result = getBackgroundProcessingEnvironments(
      pipelines,
      [env1],
      null,
      [],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("e1");
  });

  test("excludes environments already visible in the main content", () => {
    const env1 = makeEnv("e1", "proj-1");
    const pipelines = new Map([
      ["p1", makePipeline("p1", "e1", "building")],
    ]);
    // e1 is in projectEnvironments and selectedEnvironmentId is set → visible
    const result = getBackgroundProcessingEnvironments(
      pipelines,
      [env1],
      "e1",
      [env1],
    );
    expect(result).toEqual([]);
  });

  test("returns pipeline env from a different project when user views another project", () => {
    const envA = makeEnv("eA", "proj-A");
    const envB = makeEnv("eB", "proj-B");
    const pipelines = new Map([
      ["p1", makePipeline("p1", "eA", "reviewing")],
    ]);
    // User is viewing proj-B; envB is the visible project env
    const result = getBackgroundProcessingEnvironments(
      pipelines,
      [envA, envB],
      "eB",
      [envB],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("eA");
  });

  test("handles multiple active pipelines across different environments", () => {
    const env1 = makeEnv("e1", "proj-1");
    const env2 = makeEnv("e2", "proj-2");
    const env3 = makeEnv("e3", "proj-1");
    const pipelines = new Map([
      ["p1", makePipeline("p1", "e1", "building")],
      ["p2", makePipeline("p2", "e2", "verifying")],
      ["p3", makePipeline("p3", "e3", "complete")], // complete — excluded
    ]);
    // User views proj-1, e1 is visible via projectEnvironments
    const result = getBackgroundProcessingEnvironments(
      pipelines,
      [env1, env2, env3],
      "e1",
      [env1, env3],
    );
    // e1 is visible (in projectEnvironments), e3's pipeline is complete → only e2
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("e2");
  });

  test("when no environment is selected, all active pipeline envs are background", () => {
    const env1 = makeEnv("e1");
    const env2 = makeEnv("e2");
    const pipelines = new Map([
      ["p1", makePipeline("p1", "e1", "building")],
      ["p2", makePipeline("p2", "e2", "creating-pr")],
    ]);
    // No selectedEnvironmentId → kanban or welcome view → nothing visible
    const result = getBackgroundProcessingEnvironments(
      pipelines,
      [env1, env2],
      null,
      [],
    );
    expect(result).toHaveLength(2);
    const ids = result.map((e) => e.id).sort();
    expect(ids).toEqual(["e1", "e2"]);
  });

  test("all active phase values are included", () => {
    const activePhases: BuildPipeline["phase"][] = [
      "creating-environment",
      "starting-environment",
      "waiting-for-setup",
      "building",
      "reviewing",
      "addressing",
      "verifying",
      "fixing",
      "creating-pr",
      "resolving-conflicts",
    ];
    for (const phase of activePhases) {
      const env = makeEnv("e1");
      const pipelines = new Map([
        ["p1", makePipeline("p1", "e1", phase)],
      ]);
      const result = getBackgroundProcessingEnvironments(pipelines, [env], null, []);
      expect(result).toHaveLength(1);
    }
  });

  test("environment not in environments list is not returned even if pipeline references it", () => {
    const pipelines = new Map([
      ["p1", makePipeline("p1", "e-orphan", "building")],
    ]);
    const result = getBackgroundProcessingEnvironments(
      pipelines,
      [makeEnv("e-other")],
      null,
      [],
    );
    expect(result).toEqual([]);
  });

  test("returns setup-running environments even without active pipelines", () => {
    const env = makeEnv("e1");

    const result = getBackgroundProcessingEnvironments(
      new Map(),
      [env],
      null,
      [],
      new Set(["e1"]),
    );

    expect(result).toEqual([env]);
  });

  test("excludes setup-running environments already visible in the main content", () => {
    const env = makeEnv("e1");

    const result = getBackgroundProcessingEnvironments(
      new Map(),
      [env],
      "e1",
      [env],
      new Set(["e1"]),
    );

    expect(result).toEqual([]);
  });

  test("treats paused pipelines as background processing candidates", () => {
    const env = makeEnv("e1");
    const pipelines = new Map([
      ["p1", makePipeline("p1", "e1", "paused")],
    ]);

    const result = getBackgroundProcessingEnvironments(
      pipelines,
      [env],
      null,
      [],
    );

    expect(result).toEqual([env]);
  });

  test("returns the union of pipeline and setup-running environments without duplicates", () => {
    const env1 = makeEnv("e1");
    const env2 = makeEnv("e2");
    const pipelines = new Map([
      ["p1", makePipeline("p1", "e1", "building")],
    ]);

    const result = getBackgroundProcessingEnvironments(
      pipelines,
      [env1, env2],
      null,
      [],
      new Set(["e1", "e2"]),
    );

    const ids = result.map((env) => env.id).sort();
    expect(ids).toEqual(["e1", "e2"]);
  });
});
