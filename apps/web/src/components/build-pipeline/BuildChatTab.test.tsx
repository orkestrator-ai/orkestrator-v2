import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BuildChatTab } from "./BuildChatTab";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";

const pipeline: BuildPipeline = {
  id: "pipeline-1",
  taskId: "task-1",
  projectId: "project-1",
  environmentId: "env-1",
  environmentType: "local",
  agentType: "codex",
  phase: "complete",
  sessions: [
    {
      phase: "build",
      iteration: 0,
      sessionKey: "build-key",
      sdkSessionId: "build-session",
      status: "idle",
      startedAt: "2026-07-29T00:00:00.000Z",
      label: "Build Session",
      messages: [{
        id: "answer-1",
        role: "assistant",
        parts: [{ type: "text", content: "Implementation complete" }],
      }],
    },
    {
      phase: "verify",
      iteration: 0,
      sessionKey: "verify-key",
      sdkSessionId: "verify-session",
      status: "idle",
      startedAt: "2026-07-29T00:01:00.000Z",
      label: "Verification Session",
      messages: [{
        info: { id: "answer-2", role: "assistant" },
        parts: [{ type: "text", text: "All criteria pass" }],
      }],
    },
  ],
  currentSessionIndex: 1,
  iteration: 0,
  maxIterations: 3,
  createdAt: "2026-07-29T00:00:00.000Z",
  taskTitle: "Backend-owned build",
  taskSnapshot: {
    title: "Backend-owned build",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    images: [],
  },
  backendRevision: 8,
  controller: "backend",
};

describe("BuildChatTab backend projection", () => {
  beforeEach(() => {
    cleanup();
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set([pipeline.environmentId]),
    });
  });

  test("renders the same backend sessions and transcripts for every client", () => {
    render(<BuildChatTab data={{
      pipelineId: pipeline.id,
      environmentId: pipeline.environmentId,
      taskId: pipeline.taskId,
      isLocal: true,
    }} />);

    expect(screen.getByText("Backend-owned build")).toBeTruthy();
    expect(screen.getByText("All criteria pass")).toBeTruthy();
    fireEvent.click(screen.getByText("Build Session"));
    expect(screen.getByText("Implementation complete")).toBeTruthy();
  });
});
