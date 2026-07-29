import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import * as realBackend from "@/lib/backend";

const realBackendSnapshot = { ...realBackend };
const pauseBuildPipelineMock = mock(async (pipelineId: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "paused" as const,
  backendRevision: 9,
}));
const resumeBuildPipelineMock = mock(async (pipelineId: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "building" as const,
  backendRevision: 10,
}));
const cancelBuildPipelineMock = mock(async (pipelineId: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "failed" as const,
  error: "Build cancelled",
  backendRevision: 11,
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  pauseBuildPipeline: pauseBuildPipelineMock,
  resumeBuildPipeline: resumeBuildPipelineMock,
  cancelBuildPipeline: cancelBuildPipelineMock,
}));

const { BuildChatTab } = await import("./BuildChatTab");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

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
    pauseBuildPipelineMock.mockClear();
    resumeBuildPipelineMock.mockClear();
    cancelBuildPipelineMock.mockClear();
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

  test("renders loading and empty-stage states from incomplete snapshots", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    const { rerender } = render(<BuildChatTab data={{
      pipelineId: "missing",
      environmentId: "env-1",
      taskId: "task-1",
      isLocal: true,
    }} />);
    expect(screen.getByText("Loading build pipeline…")).toBeTruthy();

    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      id: "empty",
      phase: "building",
      sessions: [],
      currentSessionIndex: -1,
      backendRevision: 9,
    });
    rerender(<BuildChatTab data={{
      pipelineId: "empty",
      environmentId: "env-1",
      taskId: "task-1",
      isLocal: true,
    }} />);
    expect(screen.getByText("The backend is preparing the first stage.")).toBeTruthy();
    expect(screen.getByText("Waiting for the backend to start a build stage.")).toBeTruthy();
  });

  test("ignores malformed transcript entries and renders terminal errors", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      id: "malformed",
      phase: "failed",
      error: "Verification crashed",
      sessions: [{
        ...pipeline.sessions[0]!,
        status: "error",
        messages: [null, 42, {}, { content: [] }] as unknown[],
      }],
      currentSessionIndex: 0,
      backendRevision: 9,
    });
    render(<BuildChatTab data={{
      pipelineId: "malformed",
      environmentId: "env-1",
      taskId: "task-1",
      isLocal: true,
    }} />);

    expect(screen.getByText("Verification crashed")).toBeTruthy();
    expect(screen.getByText("No text transcript was produced for this stage.")).toBeTruthy();
  });

  test("runs pause, resume, and cancel controls against authoritative backend snapshots", async () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "building",
      backendRevision: 9,
    });
    const data = {
      pipelineId: pipeline.id,
      environmentId: pipeline.environmentId,
      taskId: pipeline.taskId,
      isLocal: true,
    };
    render(<BuildChatTab data={data} />);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(pauseBuildPipelineMock).toHaveBeenCalledWith(pipeline.id));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resumeBuildPipelineMock).toHaveBeenCalledWith(pipeline.id));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelBuildPipelineMock).toHaveBeenCalledWith(pipeline.id));
    await waitFor(() => expect(screen.getByText("Build cancelled")).toBeTruthy());
  });

  test("re-enables a control when the backend rejects it", async () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "building",
      backendRevision: 9,
    });
    pauseBuildPipelineMock.mockRejectedValueOnce(new Error("pause unavailable"));
    render(<BuildChatTab data={{
      pipelineId: pipeline.id,
      environmentId: pipeline.environmentId,
      taskId: pipeline.taskId,
      isLocal: true,
    }} />);

    const pause = screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement;
    fireEvent.click(pause);
    await waitFor(() => expect(pauseBuildPipelineMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pause.disabled).toBe(false));
    expect(useBuildPipelineStore.getState().pipelines.get(pipeline.id)?.phase).toBe(
      "building",
    );
  });

  test("surfaces persisted GitHub completion-comment recovery in the build tab", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      source: {
        type: "github",
        repositoryOwner: "acme",
        repositoryName: "widget",
        issueNumber: 42,
        issueUrl: "https://github.com/acme/widget/issues/42",
        status: "closed",
      },
      completionCommentStatus: "failed",
      completionCommentError: "GitHub unavailable",
      backendRevision: 9,
    });
    render(<BuildChatTab data={{
      pipelineId: pipeline.id,
      environmentId: pipeline.environmentId,
      taskId: pipeline.taskId,
      isLocal: true,
    }} />);

    expect(screen.getByText(/GitHub completion comment failed/)).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "Retry GitHub completion comment",
    })).toBeTruthy();
  });
});
