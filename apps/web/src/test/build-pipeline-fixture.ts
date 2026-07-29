import type { BuildPipeline } from "@/stores/buildPipelineStore";

export function buildPipelineFixture(
  overrides: Partial<BuildPipeline> = {},
): BuildPipeline {
  const id = overrides.id ?? "pipeline-1";
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
    backendRevision: 1,
    controller: "backend",
    ...overrides,
  };
}
