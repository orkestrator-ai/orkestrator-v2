import { beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  useBuildPipelineStore,
  type BuildPipelineSource,
} from "@/stores/buildPipelineStore";
import { GitHubCompletionCommentStatus } from "./GitHubCompletionCommentStatus";

function seedFailedPipeline(source: BuildPipelineSource): string {
  const id = useBuildPipelineStore.getState().createPipeline({
    taskId: source.type === "github" ? "github:acme/widget#42" : "linear:ENG-42",
    projectId: "project-1",
    environmentType: "local",
    agentType: "codex",
    taskTitle: "Build source issue",
    taskSnapshot: {
      title: "Build source issue",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    source,
  });
  useBuildPipelineStore.getState().setPhase(id, "complete");
  useBuildPipelineStore.getState().setCompletionCommentStatus(id, "failed", {
    error: "GitHub unavailable",
  });
  return id;
}

describe("GitHubCompletionCommentStatus", () => {
  beforeEach(() => {
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("retries a failed GitHub completion comment from the build UI", () => {
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

    const updated = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
    expect(updated.completionCommentStatus).toBeUndefined();
    expect(updated.completionCommentError).toBeUndefined();
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
