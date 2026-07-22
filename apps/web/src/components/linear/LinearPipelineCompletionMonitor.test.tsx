import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import { mockToastError as toastErrorMock } from "../../../../../tests/mocks/sonner";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores";
import type { Environment } from "@/types";

const realBackendSnapshot = { ...realBackend };

const postLinearCompletionCommentMock = mock<(
  pipelineId: string,
  issueId: string,
  body: string,
) => Promise<{ status: "posted"; commentId: string; postedAt: string }>>(async () => ({
  status: "posted" as const,
  commentId: "comment-1",
  postedAt: "2026-06-28T12:00:00.000Z",
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  postLinearCompletionComment: postLinearCompletionCommentMock,
}));

const { LinearPipelineCompletionMonitor } = await import("./LinearPipelineCompletionMonitor");

const environment: Environment = {
  id: "env-1",
  projectId: "project-1",
  name: "Build env",
  branch: "linear-build",
  containerId: null,
  status: "running",
  prUrl: "https://github.com/acme/repo/pull/1",
  prState: "open",
  hasMergeConflicts: false,
  createdAt: "2026-06-28T12:00:00.000Z",
  networkAccessMode: "full",
  order: 0,
  environmentType: "local",
};

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

function seedLinearPipeline(phase: "complete" | "failed" = "complete"): string {
  const id = useBuildPipelineStore.getState().createPipeline({
    taskId: "issue-1",
    projectId: "project-1",
    environmentType: "local",
    agentType: "codex",
    taskTitle: "ENG-123: Ship Linear integration",
    taskSnapshot: {
      title: "ENG-123: Ship Linear integration",
      description: "Build Linear support",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    source: {
      type: "linear",
      issueId: "issue-1",
      issueIdentifier: "ENG-123",
      issueUrl: "https://linear.app/acme/issue/ENG-123",
    },
  });
  useBuildPipelineStore.getState().setPipelineEnvironment(id, "env-1");
  useBuildPipelineStore.getState().setPhase(id, phase);
  return id;
}

describe("LinearPipelineCompletionMonitor", () => {
  beforeEach(() => {
    postLinearCompletionCommentMock.mockReset();
    postLinearCompletionCommentMock.mockResolvedValue({
      status: "posted",
      commentId: "comment-1",
      postedAt: "2026-06-28T12:00:00.000Z",
    });
    toastErrorMock.mockClear();
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    useEnvironmentStore.setState({
      environments: [environment],
    });
  });

  test("posts a Linear completion comment once for a completed Linear pipeline", async () => {
    const pipelineId = seedLinearPipeline("complete");

    render(<LinearPipelineCompletionMonitor />);

    await waitFor(() => {
      expect(postLinearCompletionCommentMock).toHaveBeenCalledTimes(1);
    });
    expect(postLinearCompletionCommentMock.mock.calls[0]?.[0]).toBe(pipelineId);
    expect(postLinearCompletionCommentMock.mock.calls[0]?.[1]).toBe("issue-1");
    expect(postLinearCompletionCommentMock.mock.calls[0]?.[2]).toContain("Result: Complete");
    expect(postLinearCompletionCommentMock.mock.calls[0]?.[2]).toContain("Pull request: https://github.com/acme/repo/pull/1");

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
      expect(pipeline.completionCommentStatus).toBe("posted");
      expect(pipeline.completionCommentId).toBe("comment-1");
    });
  });

  test("surfaces a failed Linear comment without automatically retrying", async () => {
    const pipelineId = seedLinearPipeline("failed");
    postLinearCompletionCommentMock.mockRejectedValue(new Error("Linear unavailable"));

    render(<LinearPipelineCompletionMonitor />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
      expect(pipeline.completionCommentStatus).toBe("failed");
      expect(pipeline.completionCommentError).toBe("Linear unavailable");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(postLinearCompletionCommentMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(useBuildPipelineStore.getState().pipelines.get(pipelineId)?.phase).toBe("failed");
  });

  test("retries a failed Linear completion comment after the status is cleared", async () => {
    const pipelineId = seedLinearPipeline("complete");
    postLinearCompletionCommentMock.mockRejectedValue(new Error("Linear unavailable"));

    render(<LinearPipelineCompletionMonitor />);

    await waitFor(() => {
      expect(useBuildPipelineStore.getState().pipelines.get(pipelineId)?.completionCommentStatus).toBe("failed");
    });
    expect(postLinearCompletionCommentMock).toHaveBeenCalledTimes(1);

    postLinearCompletionCommentMock.mockResolvedValueOnce({
      status: "posted",
      commentId: "comment-2",
      postedAt: "2026-06-28T12:05:00.000Z",
    });

    act(() => {
      useBuildPipelineStore.getState().clearCompletionCommentStatus(pipelineId);
    });

    await waitFor(() => {
      expect(postLinearCompletionCommentMock).toHaveBeenCalledTimes(2);
      expect(useBuildPipelineStore.getState().pipelines.get(pipelineId)?.completionCommentStatus).toBe("posted");
      expect(useBuildPipelineStore.getState().pipelines.get(pipelineId)?.completionCommentId).toBe("comment-2");
    });
  });
});
