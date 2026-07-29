import { describe, expect, test } from "bun:test";
import {
  BUILD_PIPELINE_VERSION,
  isActiveBuildPhase,
  isBuildPipeline,
  isStartBuildPipelineInput,
  type BuildPipeline,
} from "./build-pipeline.js";

function snapshot(): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "environment-1",
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
  };
}

describe("build pipeline protocol", () => {
  test("accepts a backend-owned snapshot and exposes the current version", () => {
    expect(BUILD_PIPELINE_VERSION).toBe(2);
    expect(isBuildPipeline(snapshot())).toBe(true);
  });

  test("rejects a client-authored or malformed snapshot", () => {
    const { controller: _controller, ...clientAuthored } = snapshot();
    expect(isBuildPipeline(clientAuthored)).toBe(false);
    expect(isBuildPipeline({ ...snapshot(), currentSessionIndex: 0 })).toBe(false);
  });

  test("classifies only nonterminal, nonpaused phases as active", () => {
    expect(isActiveBuildPhase("building")).toBe(true);
    expect(isActiveBuildPhase("paused")).toBe(false);
    expect(isActiveBuildPhase("complete")).toBe(false);
    expect(isActiveBuildPhase("failed")).toBe(false);
  });

  test("validates bounded start requests at the gateway boundary", () => {
    const pipeline = snapshot();
    const input = {
      taskId: pipeline.taskId,
      projectId: pipeline.projectId,
      taskTitle: pipeline.taskTitle,
      taskSnapshot: pipeline.taskSnapshot,
      environmentType: pipeline.environmentType,
      agentType: pipeline.agentType,
      maxIterations: 3,
    };
    expect(isStartBuildPipelineInput(input)).toBe(true);
    expect(isStartBuildPipelineInput({ ...input, maxIterations: 11 })).toBe(false);
    expect(isStartBuildPipelineInput({
      ...input,
      taskSnapshot: { ...input.taskSnapshot, images: [{ filename: 7, data: "" }] },
    })).toBe(false);
  });
});
