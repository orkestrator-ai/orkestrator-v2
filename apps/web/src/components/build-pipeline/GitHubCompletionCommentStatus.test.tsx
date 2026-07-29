import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  retryBuildPipelineCompletionComment: retryCompletionCommentMock,
}));
const { GitHubCompletionCommentStatus } = await import(
  "./GitHubCompletionCommentStatus"
);

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

function seedFailedPipeline(source: BuildPipelineSource): string {
  const id = source.type === "github" ? "github-pipeline" : "linear-pipeline";
  useBuildPipelineStore.getState().replacePipeline(buildPipelineFixture({
    id,
    taskId: source.type === "github" ? "github:acme/widget#42" : "linear:ENG-42",
    taskTitle: "Build source issue",
    source,
    phase: "complete",
    completionCommentStatus: "failed",
    completionCommentError: "GitHub unavailable",
  }));
  return id;
}

describe("GitHubCompletionCommentStatus", () => {
  beforeEach(() => {
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
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

    render(<GitHubCompletionCommentStatus pipeline={pipeline} />);

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

  test("does not alter the Linear completion UI path", () => {
    const pipelineId = seedFailedPipeline({
      type: "linear",
      issueId: "issue-42",
      issueIdentifier: "ENG-42",
    });
    const pipeline = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
    const { container } = render(
      <GitHubCompletionCommentStatus pipeline={pipeline} />,
    );

    expect(container.childElementCount).toBe(0);
    expect(
      useBuildPipelineStore.getState().pipelines.get(pipelineId)
        ?.completionCommentStatus,
    ).toBe("failed");
  });
});
