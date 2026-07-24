import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import { mockToastError as toastErrorMock } from "../../../../../tests/mocks/sonner";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores";
import type { Environment } from "@/types";

const realBackendSnapshot = { ...realBackend };
const getEnvironmentMock = mock(async (): Promise<Environment | null> => null);
const postGitHubCompletionCommentMock = mock<(
  pipelineId: string,
  projectId: string,
  repositoryOwner: string,
  repositoryName: string,
  issueNumber: number,
  body: string,
) => Promise<{
  status: "posted" | "already-posted";
  commentId: string;
  postedAt: string;
}>>(async () => ({
  status: "posted" as const,
  commentId: "9001",
  postedAt: "2026-07-24T12:00:00.000Z",
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getEnvironment: getEnvironmentMock,
  postGitHubCompletionComment: postGitHubCompletionCommentMock,
}));

const {
  createGitHubCompletionComment,
  GitHubPipelineCompletionMonitor,
} = await import("./GitHubPipelineCompletionMonitor");

const environment: Environment = {
  id: "env-github",
  projectId: "project-1",
  name: "github-build",
  branch: "github-build",
  containerId: null,
  status: "running",
  prUrl: "https://github.com/acme/widget/pull/50",
  prState: "open",
  hasMergeConflicts: false,
  createdAt: "2026-07-24T10:00:00.000Z",
  networkAccessMode: "full",
  order: 0,
  environmentType: "local",
};

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

function seedGitHubPipeline(
  phase: "complete" | "failed" = "complete",
  issueNumber = 42,
): string {
  const id = useBuildPipelineStore.getState().createPipeline({
    taskId: `github:acme/widget#${issueNumber}`,
    projectId: "project-1",
    environmentType: "local",
    agentType: "codex",
    taskTitle: "#42: Add GitHub builds",
    taskSnapshot: {
      title: "#42: Add GitHub builds",
      description: "Build this issue",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    source: {
      type: "github",
      repositoryOwner: "acme",
      repositoryName: "widget",
      issueNumber,
      issueUrl: `https://github.com/acme/widget/issues/${issueNumber}`,
      status: "Review",
    },
  });
  useBuildPipelineStore.getState().setPipelineEnvironment(id, environment.id);
  useBuildPipelineStore.getState().setPhase(id, phase);
  return id;
}

describe("GitHubPipelineCompletionMonitor", () => {
  beforeEach(() => {
    postGitHubCompletionCommentMock.mockReset();
    postGitHubCompletionCommentMock.mockResolvedValue({
      status: "posted",
      commentId: "9001",
      postedAt: "2026-07-24T12:00:00.000Z",
    });
    toastErrorMock.mockClear();
    getEnvironmentMock.mockReset();
    getEnvironmentMock.mockResolvedValue(null);
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    useEnvironmentStore.setState({ environments: [environment] });
  });

  test("posts once with result and pull request context", async () => {
    const pipelineId = seedGitHubPipeline();

    render(<GitHubPipelineCompletionMonitor />);

    await waitFor(() => {
      expect(postGitHubCompletionCommentMock).toHaveBeenCalledTimes(1);
    });
    expect(postGitHubCompletionCommentMock.mock.calls[0]?.slice(0, 5)).toEqual([
      pipelineId,
      "project-1",
      "acme",
      "widget",
      42,
    ]);
    const body = postGitHubCompletionCommentMock.mock.calls[0]?.[5] as string;
    expect(body).toContain("Result: Complete");
    expect(body).toContain("Pull request: https://github.com/acme/widget/pull/50");

    await waitFor(() => {
      expect(
        useBuildPipelineStore.getState().pipelines.get(pipelineId)?.completionCommentStatus,
      ).toBe("posted");
    });
  });

  test("posts every newly completed GitHub pipeline during the same render", async () => {
    const firstId = seedGitHubPipeline("complete", 42);
    const secondId = seedGitHubPipeline("failed", 43);

    render(<GitHubPipelineCompletionMonitor />);

    await waitFor(() => {
      expect(postGitHubCompletionCommentMock).toHaveBeenCalledTimes(2);
      expect(
        useBuildPipelineStore.getState().pipelines.get(firstId)
          ?.completionCommentStatus,
      ).toBe("posted");
      expect(
        useBuildPipelineStore.getState().pipelines.get(secondId)
          ?.completionCommentStatus,
      ).toBe("posted");
    });
    expect(
      postGitHubCompletionCommentMock.mock.calls.map((call) => call[4]).sort(),
    ).toEqual([42, 43]);
  });

  test("does not repost pipelines with persisted posting, posted, or failed state", async () => {
    const postingId = seedGitHubPipeline("complete", 42);
    const postedId = seedGitHubPipeline("complete", 43);
    const failedId = seedGitHubPipeline("failed", 44);
    useBuildPipelineStore
      .getState()
      .setCompletionCommentStatus(postingId, "posting");
    useBuildPipelineStore
      .getState()
      .setCompletionCommentStatus(postedId, "posted", {
        commentId: "accepted",
        postedAt: "2026-07-24T12:00:00.000Z",
      });
    useBuildPipelineStore
      .getState()
      .setCompletionCommentStatus(failedId, "failed", {
        error: "retry explicitly",
      });

    const { unmount } = render(<GitHubPipelineCompletionMonitor />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    unmount();
    render(<GitHubPipelineCompletionMonitor />);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(postGitHubCompletionCommentMock).not.toHaveBeenCalled();
  });

  test("does not handle Linear pipelines", async () => {
    const id = useBuildPipelineStore.getState().createPipeline({
      taskId: "linear-1",
      projectId: "project-1",
      environmentType: "local",
      agentType: "codex",
      taskTitle: "ENG-1",
      taskSnapshot: {
        title: "ENG-1",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      source: { type: "linear", issueId: "linear-1", issueIdentifier: "ENG-1" },
    });
    useBuildPipelineStore.getState().setPhase(id, "complete");

    render(<GitHubPipelineCompletionMonitor />);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(postGitHubCompletionCommentMock).not.toHaveBeenCalled();
  });

  test("rehydrates the environment before formatting so an existing PR is included", async () => {
    seedGitHubPipeline();
    useEnvironmentStore.setState({ environments: [] });
    getEnvironmentMock.mockResolvedValue(environment);

    render(<GitHubPipelineCompletionMonitor />);

    await waitFor(() => {
      expect(postGitHubCompletionCommentMock).toHaveBeenCalledTimes(1);
    });
    expect(getEnvironmentMock).toHaveBeenCalledWith("env-github");
    expect(postGitHubCompletionCommentMock.mock.calls[0]?.[5]).toContain(
      "Pull request: https://github.com/acme/widget/pull/50",
    );
  });

  test("preserves a failure for explicit retry, then posts after it is cleared", async () => {
    const pipelineId = seedGitHubPipeline("failed");
    postGitHubCompletionCommentMock.mockRejectedValue(new Error("GitHub unavailable"));
    render(<GitHubPipelineCompletionMonitor />);

    await waitFor(() => {
      expect(
        useBuildPipelineStore.getState().pipelines.get(pipelineId)?.completionCommentStatus,
      ).toBe("failed");
    });
    expect(postGitHubCompletionCommentMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalled();

    postGitHubCompletionCommentMock.mockResolvedValueOnce({
      status: "already-posted",
      commentId: "9002",
      postedAt: "2026-07-24T12:01:00.000Z",
    });
    act(() => useBuildPipelineStore.getState().clearCompletionCommentStatus(pipelineId));

    await waitFor(() => {
      expect(postGitHubCompletionCommentMock).toHaveBeenCalledTimes(2);
      expect(
        useBuildPipelineStore.getState().pipelines.get(pipelineId)?.completionCommentId,
      ).toBe("9002");
    });
  });

  test("formats failed build outcome without changing issue state", async () => {
    const pipelineId = seedGitHubPipeline("failed");
    const pipeline = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;

    await expect(createGitHubCompletionComment(pipeline)).resolves.toContain("Result: Failed");
  });

  test("formats verification and failure context when available", async () => {
    const pipelineId = seedGitHubPipeline("failed");
    useBuildPipelineStore.setState((state) => {
      const pipelines = new Map(state.pipelines);
      pipelines.set(pipelineId, {
        ...pipelines.get(pipelineId)!,
        verificationResult: "fail",
        verificationFeedback: "Unit test failed",
        error: "Build command exited with 1",
      });
      return { pipelines };
    });
    const pipeline = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;

    const body = await createGitHubCompletionComment(pipeline);
    expect(body).toContain("Verification: Failed");
    expect(body).toContain("Error: Build command exited with 1");
    expect(body).toContain("Latest verification feedback:\nUnit test failed");
  });
});
