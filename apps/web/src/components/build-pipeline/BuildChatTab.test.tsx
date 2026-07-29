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
const sendMessageMock = mock(async (pipelineId: string, text: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  pendingUserMessages: [
    { id: "queued-1", text, createdAt: "2026-07-29T00:02:00.000Z" },
  ],
  backendRevision: 12,
}));
const retryReviewMock = mock(async (pipelineId: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "reviewing" as const,
  backendRevision: 13,
}));
const getBuildPipelineMock = mock(async (_pipelineId: string) => null as unknown);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  pauseBuildPipeline: pauseBuildPipelineMock,
  resumeBuildPipeline: resumeBuildPipelineMock,
  cancelBuildPipeline: cancelBuildPipelineMock,
  sendBuildPipelineMessage: sendMessageMock,
  retryBuildPipelineReview: retryReviewMock,
  getBuildPipeline: getBuildPipelineMock,
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
    sendMessageMock.mockClear();
    retryReviewMock.mockClear();
    getBuildPipelineMock.mockClear();
    getBuildPipelineMock.mockImplementation(async () => null);
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

describe("BuildChatTab rehydration", () => {
  beforeEach(() => {
    cleanup();
    getBuildPipelineMock.mockClear();
    getBuildPipelineMock.mockImplementation(async () => null);
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("fetches the authoritative snapshot when the store has none", async () => {
    // App hydrates pipelines once per project. If that never ran for this
    // project or failed, the tab would otherwise sit on its loading state
    // forever with no way back — the rehydrate-on-mount invariant.
    getBuildPipelineMock.mockImplementation(async () => ({
      version: 2,
      id: pipeline.id,
      projectId: pipeline.projectId,
      environmentId: pipeline.environmentId,
      snapshot: pipeline,
      revision: 8,
      updatedAt: "2026-07-29T00:00:00.000Z",
    }));

    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: pipeline.id,
      taskId: "task-1",
      isLocal: true,
    }} />);

    expect(screen.getByText("Loading build pipeline…")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("Backend-owned build")).toBeTruthy();
    });
    expect(getBuildPipelineMock).toHaveBeenCalledWith(pipeline.id);
  });

  test("does not refetch in a loop when the pipeline genuinely does not exist", async () => {
    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: "missing",
      taskId: "task-1",
      isLocal: true,
    }} />);

    await waitFor(() => expect(getBuildPipelineMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getBuildPipelineMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loading build pipeline…")).toBeTruthy();
  });

  test("does not fetch when the store already has the snapshot", async () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });

    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: pipeline.id,
      taskId: "task-1",
      isLocal: true,
    }} />);

    expect(screen.getByText("Backend-owned build")).toBeTruthy();
    expect(getBuildPipelineMock).not.toHaveBeenCalled();
  });
});

describe("BuildChatTab stage following", () => {
  function renderWith(next: BuildPipeline) {
    useBuildPipelineStore.setState({
      pipelines: new Map([[next.id, next]]),
      buildEnvironmentIds: new Set([next.environmentId]),
    });
  }

  beforeEach(() => {
    cleanup();
    renderWith(pipeline);
  });

  test("follows the pipeline to each new stage until the user picks one", async () => {
    const building: BuildPipeline = {
      ...pipeline,
      phase: "building",
      sessions: [pipeline.sessions[0]!],
      currentSessionIndex: 0,
    };
    renderWith(building);
    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: pipeline.id,
      taskId: "task-1",
      isLocal: true,
    }} />);
    expect(screen.getByText("Implementation complete")).toBeTruthy();

    // The backend advances to the verification stage.
    renderWith({ ...pipeline, phase: "verifying" });

    await waitFor(() => {
      expect(screen.getByText("All criteria pass")).toBeTruthy();
    });
  });

  test("holds a stage the user selected even as the pipeline advances", async () => {
    renderWith({ ...pipeline, phase: "verifying" });
    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: pipeline.id,
      taskId: "task-1",
      isLocal: true,
    }} />);
    await waitFor(() => expect(screen.getByText("All criteria pass")).toBeTruthy());

    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() =>
      expect(screen.getByText("Implementation complete")).toBeTruthy());

    // A new snapshot arrives; the explicit choice must survive it.
    renderWith({ ...pipeline, phase: "complete", backendRevision: 20 });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByText("Implementation complete")).toBeTruthy();
  });

  test("resumes following when the selected stage leaves the snapshot", async () => {
    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: pipeline.id,
      taskId: "task-1",
      isLocal: true,
    }} />);
    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() =>
      expect(screen.getByText("Implementation complete")).toBeTruthy());

    // A retry replaced the session list; the pinned id no longer exists, so
    // holding it would leave the transcript permanently blank.
    renderWith({
      ...pipeline,
      sessions: [pipeline.sessions[1]!],
      currentSessionIndex: 0,
      backendRevision: 30,
    });

    await waitFor(() => expect(screen.getByText("All criteria pass")).toBeTruthy());
  });
});

describe("BuildChatTab agent messaging", () => {
  const running: BuildPipeline = { ...pipeline, phase: "building" };

  beforeEach(() => {
    cleanup();
    sendMessageMock.mockClear();
    retryReviewMock.mockClear();
    useBuildPipelineStore.setState({
      pipelines: new Map([[running.id, running]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
  });

  function renderTab() {
    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: running.id,
      taskId: "task-1",
      isLocal: true,
    }} />);
  }

  test("queues a message through the backend and clears the box", async () => {
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "  also update the README  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith(
        running.id,
        "also update the README",
      ));
    await waitFor(() => expect(box.value).toBe(""));
    // The authoritative reply is installed, so the queue depth is visible.
    await waitFor(() =>
      expect(screen.getByText(/1 message queued/)).toBeTruthy());
  });

  test("submits on Enter and inserts a newline on Shift+Enter", async () => {
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent");

    fireEvent.change(box, { target: { value: "ship it" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(sendMessageMock).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith(running.id, "ship it"));
  });

  test("keeps the draft when the backend refuses the message", async () => {
    sendMessageMock.mockImplementationOnce(async () => {
      throw new Error("queue is full");
    });
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "do not lose me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalled());
    // Losing the user's typing on a transient failure is worse than the failure.
    expect(box.value).toBe("do not lose me");
  });

  test("refuses to send an empty or whitespace-only message", () => {
    renderTab();
    const button = screen.getByRole("button", {
      name: "Send message",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(
      screen.getByLabelText("Send a message to the agent"),
      { target: { value: "   " } },
    );
    expect(button.disabled).toBe(true);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("hides the compose box once the build has finished", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    renderTab();

    expect(screen.queryByLabelText("Send a message to the agent")).toBeNull();
  });

  test("restarts the review through the backend", async () => {
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /Retry Review/ }));

    await waitFor(() => expect(retryReviewMock).toHaveBeenCalledWith(running.id));
    await waitFor(() =>
      expect(useBuildPipelineStore.getState().pipelines.get(running.id)?.phase)
        .toBe("reviewing"));
  });

  test("does not offer a review retry before the first stage exists", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([[running.id, {
        ...running,
        sessions: [],
        currentSessionIndex: -1,
      }]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    renderTab();

    expect(screen.queryByRole("button", { name: /Retry Review/ })).toBeNull();
  });
});
