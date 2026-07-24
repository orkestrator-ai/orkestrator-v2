import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import {
  githubIssueDetailKey,
  useGitHubIssuesStore,
} from "@/stores/githubIssuesStore";
import type { GitHubIssueDetail, GitHubRepository } from "@/types/github";
import type { EnvironmentType } from "@/types";
import type { GitHubIssueBuildInput } from "@/hooks/useBuildPipeline";
import { GitHubIssueDetailContent } from "./GitHubIssueDetail";

const repository: GitHubRepository = {
  owner: "acme",
  name: "widget",
  fullName: "acme/widget",
  htmlUrl: "https://github.com/acme/widget",
};

const detail: GitHubIssueDetail = {
  id: 101,
  number: 42,
  title: "Ship GitHub issues",
  body: "Original issue body",
  htmlUrl: "https://github.com/acme/widget/issues/42",
  state: "open",
  locked: false,
  author: { login: "ada" },
  assignees: [{ login: "grace" }],
  labels: [{ name: "enhancement", color: "84b6eb" }],
  commentsCount: 2,
  createdAt: "2026-07-20T10:00:00.000Z",
  updatedAt: "2026-07-24T10:00:00.000Z",
  status: "todo",
  comments: [
    {
      id: 9001,
      body: "Editable comment",
      htmlUrl: "https://github.com/acme/widget/issues/42#issuecomment-9001",
      author: { login: "ada" },
      createdAt: "2026-07-24T11:00:00.000Z",
      updatedAt: "2026-07-24T11:00:00.000Z",
      isEdited: false,
      canEdit: true,
    },
    {
      id: 9002,
      body: "Someone else's comment",
      htmlUrl: "https://github.com/acme/widget/issues/42#issuecomment-9002",
      author: { login: "octocat" },
      createdAt: "2026-07-24T11:05:00.000Z",
      updatedAt: "2026-07-24T11:05:00.000Z",
      isEdited: false,
      canEdit: false,
    },
  ],
};

const loadIssueMock = mock(async () => undefined);
const saveIssueMock = mock(async () => detail);
const closeIssueMock = mock(async () => undefined);
const changeStatusMock = mock(async () => undefined);
const addCommentMock = mock(async () => detail.comments[0]!);
const editCommentMock = mock(async () => detail.comments[0]!);
const startBuildMock = mock(
  async (
    _issue: GitHubIssueBuildInput,
    _projectId: string,
    _environmentType: EnvironmentType,
  ) => undefined,
);
const navigateToPipelineMock = mock(async () => undefined);
const originalGitHubStoreState = useGitHubIssuesStore.getState();

afterAll(() => {
  useGitHubIssuesStore.setState(originalGitHubStoreState, true);
});

describe("GitHubIssueDetail", () => {
  beforeEach(() => {
    cleanup();
    loadIssueMock.mockClear();
    saveIssueMock.mockReset();
    saveIssueMock.mockResolvedValue(detail);
    closeIssueMock.mockReset();
    closeIssueMock.mockResolvedValue(undefined);
    changeStatusMock.mockReset();
    changeStatusMock.mockResolvedValue(undefined);
    addCommentMock.mockReset();
    addCommentMock.mockResolvedValue(detail.comments[0]!);
    editCommentMock.mockReset();
    editCommentMock.mockResolvedValue(detail.comments[0]!);
    startBuildMock.mockReset();
    startBuildMock.mockResolvedValue(undefined);
    navigateToPipelineMock.mockClear();
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    useGitHubIssuesStore.setState({
      ...originalGitHubStoreState,
      details: new Map([[githubIssueDetailKey("project-1", 42), detail]]),
      snapshots: new Map(),
      loadingProjects: new Set(),
      loadingDetails: new Set(),
      projectErrors: new Map(),
      detailErrors: new Map(),
      mutations: new Set(),
      mutationErrors: new Map(),
      loadIssue: loadIssueMock,
      saveIssue: saveIssueMock,
      closeIssue: closeIssueMock,
      changeStatus: changeStatusMock,
      addComment: addCommentMock,
      editComment: editCommentMock,
    });
  });

  function renderDetail() {
    return render(
      <GitHubIssueDetailContent
        projectId="project-1"
        repository={repository}
        issueNumber={42}
        summary={detail}
        onBack={() => {}}
        onClosed={() => {}}
        buildPipeline={{
          startBuildFromGitHubIssue: startBuildMock,
          navigateToPipeline: navigateToPipelineMock,
        }}
      />,
    );
  }

  test("preserves issue and comment drafts when GitHub rejects mutations", async () => {
    saveIssueMock.mockRejectedValueOnce(new Error("Title update was rejected"));
    addCommentMock.mockRejectedValueOnce(new Error("Comment permission denied"));
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Edit issue" }));
    const title = screen.getByRole("textbox", { name: "Issue title" });
    fireEvent.change(title, { target: { value: "Draft title remains" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Title update was rejected")).toBeTruthy();
    expect((title as HTMLInputElement).value).toBe("Draft title remains");

    const newComment = screen.getByRole("textbox", { name: "Add GitHub comment" });
    fireEvent.change(newComment, { target: { value: "Unsaved discussion draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(await screen.findByText("Comment permission denied")).toBeTruthy();
    expect((newComment as HTMLTextAreaElement).value).toBe(
      "Unsaved discussion draft",
    );
  });

  test("only offers comment editing when the backend grants permission", () => {
    renderDetail();

    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
    expect(screen.getByText("Someone else's comment")).toBeTruthy();
  });

  test("starts a local build with the complete current issue snapshot", async () => {
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Build Local" }));

    await waitFor(() => {
      expect(startBuildMock).toHaveBeenCalledTimes(1);
    });
    const buildCall = startBuildMock.mock.calls[0];
    expect(buildCall).toBeDefined();
    expect(buildCall![1]).toBe("project-1");
    expect(buildCall![2]).toBe("local");
    expect(buildCall![0]).toMatchObject({
      repositoryOwner: "acme",
      repositoryName: "widget",
      number: 42,
      title: "Ship GitHub issues",
      body: "Original issue body",
      labels: ["enhancement"],
      status: "todo",
      authorLogin: "ada",
      assigneeLogins: ["grace"],
    });
    expect(buildCall![0].comments).toHaveLength(2);
  });
});
