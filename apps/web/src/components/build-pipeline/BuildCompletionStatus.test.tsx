import {
  afterAll,
  afterEach,
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
import {
  useBuildPipelineStore,
  type BuildPipelineSource,
} from "@/stores/buildPipelineStore";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import * as realBackend from "@/lib/backend";

const realBackendSnapshot = { ...realBackend };
const retryCompletionCommentMock = mock(async (pipelineId: string) => {
  const current = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
  return {
    ...current,
    completionCommentStatus: undefined,
    completionCommentError: undefined,
    backendRevision: current.backendRevision + 1,
  };
});
const retryInteractionFailureMock = mock(async (pipelineId: string) => {
  const current = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
  return {
    ...current,
    phase: "building" as const,
    failureContext: undefined,
    error: undefined,
    backendRevision: current.backendRevision + 1,
  };
});
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  retryBuildPipelineCompletionComment: retryCompletionCommentMock,
  retryBuildPipelineInteractionFailure: retryInteractionFailureMock,
}));
const { BuildCompletionStatus } = await import("./BuildCompletionStatus");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});
afterEach(cleanup);

function seedFailedPipeline(
  source: BuildPipelineSource,
  overrides: { completionCommentError?: string; phase?: "complete" | "failed" } = {},
): string {
  const id = `${source.type}-pipeline`;
  useBuildPipelineStore.getState().replacePipeline(buildPipelineFixture({
    id,
    taskId: `${source.type}:task`,
    taskTitle: "Build source issue",
    source,
    phase: overrides.phase ?? "complete",
    completionCommentStatus: "failed",
    completionCommentError: overrides.completionCommentError ?? "GitHub unavailable",
  }));
  return id;
}

describe("BuildCompletionStatus", () => {
  beforeEach(() => {
    retryCompletionCommentMock.mockReset();
    retryInteractionFailureMock.mockClear();
    retryCompletionCommentMock.mockImplementation(async (pipelineId: string) => {
      const current = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
      return {
        ...current,
        completionCommentStatus: undefined,
        completionCommentError: undefined,
        backendRevision: current.backendRevision + 1,
      };
    });
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("surfaces an authorization denial and retries the failed phase", async () => {
    const pipeline = buildPipelineFixture({
      id: "authorization-failure",
      phase: "failed",
      error: "Unexpected authorization",
      failureContext: {
        phase: "building",
        kind: "interactive-request",
        sessionId: "build-1",
        requestId: "permission-1",
      },
    });
    useBuildPipelineStore.getState().replacePipeline(pipeline);

    render(<BuildCompletionStatus pipeline={pipeline} />);
    expect(screen.getByText("Unexpected authorization")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry failed build phase" }));

    await waitFor(() => {
      expect(retryInteractionFailureMock).toHaveBeenCalledWith(pipeline.id);
      expect(useBuildPipelineStore.getState().pipelines.get(pipeline.id)?.phase)
        .toBe("building");
    });
  });

  test("shows the durable auto-decline count as a muted completion summary", () => {
    const pipeline = buildPipelineFixture({
      id: "auto-declines",
      phase: "complete",
      autoDeclineCount: 3,
    });
    render(<BuildCompletionStatus pipeline={pipeline} />);
    expect(screen.getByText(/3 unattended input requests were auto-declined/))
      .toBeTruthy();
  });

  test("retries a failed GitHub completion comment from the build UI", async () => {
    const pipelineId = seedFailedPipeline({
      type: "github",
      repositoryOwner: "acme",
      repositoryName: "widget",
      issueNumber: 42,
      issueUrl: "https://github.com/acme/widget/issues/42",
      status: "Review",
    });
    const pipeline = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;

    render(<BuildCompletionStatus pipeline={pipeline} />);

    expect(screen.getByText(/GitHub completion comment failed/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry GitHub completion comment" }),
    );

    await waitFor(() => {
      const updated = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
      expect(updated.completionCommentStatus).toBeUndefined();
      expect(updated.completionCommentError).toBeUndefined();
    });
  });

  // Every source has a terminal hand-off the backend can fail at, and it never
  // retries any of them. A source without a surface here is a build whose
  // failure is invisible: for kanban that is a card stranded in the wrong
  // column, which is harder to notice than a missing comment, not easier.
  test.each([
    [
      "linear",
      { type: "linear", issueId: "issue-42", issueIdentifier: "ENG-42" } as const,
      /Linear completion comment failed/,
      "Retry Linear completion comment",
    ],
    [
      "kanban",
      { type: "kanban", taskId: "task-1" } as const,
      /Updating the task board failed/,
      "Retry the task board update",
    ],
  ])("retries a failed %s hand-off from the build UI", async (
    _name,
    source,
    label,
    retryLabel,
  ) => {
    const pipelineId = seedFailedPipeline(source);
    const pipeline = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;

    render(<BuildCompletionStatus pipeline={pipeline} />);

    expect(screen.getByText(label)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: retryLabel }));

    await waitFor(() => {
      expect(
        useBuildPipelineStore.getState().pipelines.get(pipelineId)
          ?.completionCommentStatus,
      ).toBeUndefined();
    });
  });

  test("renders nothing for a pipeline that has no source", () => {
    useBuildPipelineStore.getState().replacePipeline(buildPipelineFixture({
      id: "sourceless",
      phase: "failed",
      completionCommentStatus: "failed",
    }));
    const pipeline = useBuildPipelineStore.getState().pipelines.get("sourceless")!;
    const { container } = render(
      <BuildCompletionStatus pipeline={pipeline} />,
    );

    expect(container.childElementCount).toBe(0);
  });

  test("renders nothing while the hand-off has not failed", () => {
    useBuildPipelineStore.getState().replacePipeline(buildPipelineFixture({
      id: "posting",
      phase: "complete",
      source: { type: "kanban", taskId: "task-1" },
      completionCommentStatus: "posting",
    }));
    const pipeline = useBuildPipelineStore.getState().pipelines.get("posting")!;
    const { container } = render(
      <BuildCompletionStatus pipeline={pipeline} />,
    );

    expect(container.childElementCount).toBe(0);
  });

  test("falls back to a per-source message when the backend recorded no error", () => {
    const pipelineId = seedFailedPipeline(
      { type: "kanban", taskId: "task-1" },
      { completionCommentError: undefined },
    );
    useBuildPipelineStore.getState().replacePipeline({
      ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
      completionCommentError: undefined,
      backendRevision: 99,
    });
    const pipeline = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;

    render(<BuildCompletionStatus pipeline={pipeline} />);

    expect(
      screen.getByText(/The task could not be moved to its final column\./),
    ).toBeTruthy();
  });

  test("keeps retry single-flight while the request is pending", async () => {
    const pipelineId = seedFailedPipeline({
      type: "github",
      repositoryOwner: "acme",
      repositoryName: "widget",
      issueNumber: 42,
      issueUrl: "https://github.com/acme/widget/issues/42",
      status: "Review",
    });
    const pipeline = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
    type RetryResult = Awaited<ReturnType<typeof retryCompletionCommentMock>>;
    let resolveRetry!: (value: RetryResult) => void;
    retryCompletionCommentMock.mockImplementationOnce(() =>
      new Promise((resolve) => {
        resolveRetry = resolve;
      }));
    render(<BuildCompletionStatus pipeline={pipeline} />);
    const button = screen.getByRole("button", {
      name: "Retry GitHub completion comment",
    }) as HTMLButtonElement;

    fireEvent.click(button);
    fireEvent.click(button);

    expect(retryCompletionCommentMock).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Retrying…")).toBeTruthy();
    resolveRetry({
      ...pipeline,
      completionCommentStatus: undefined,
      completionCommentError: undefined,
      backendRevision: pipeline.backendRevision + 1,
    });
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  test("handles a rejected retry and permits another attempt", async () => {
    const pipelineId = seedFailedPipeline({
      type: "github",
      repositoryOwner: "acme",
      repositoryName: "widget",
      issueNumber: 42,
      issueUrl: "https://github.com/acme/widget/issues/42",
      status: "Review",
    });
    const pipeline = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
    retryCompletionCommentMock.mockRejectedValueOnce(new Error("still offline"));
    render(<BuildCompletionStatus pipeline={pipeline} />);
    const button = screen.getByRole("button", {
      name: "Retry GitHub completion comment",
    }) as HTMLButtonElement;

    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(
      useBuildPipelineStore.getState().pipelines.get(pipelineId)
        ?.completionCommentStatus,
    ).toBe("failed");

    fireEvent.click(button);
    await waitFor(() => expect(retryCompletionCommentMock).toHaveBeenCalledTimes(2));
  });
});
