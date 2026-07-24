import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realBackend from "@/lib/backend";
import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueDetail,
  GitHubIssuesSnapshot,
} from "@/types/github";

const realBackendSnapshot = { ...realBackend };

const issue: GitHubIssue = {
  id: 101,
  number: 42,
  title: "Ship GitHub issues",
  body: "Build the workflow",
  htmlUrl: "https://github.com/acme/widget/issues/42",
  state: "open",
  locked: false,
  author: { login: "ada" },
  assignees: [{ login: "grace" }],
  labels: [{ name: "enhancement", color: "84b6eb" }],
  commentsCount: 0,
  createdAt: "2026-07-20T10:00:00.000Z",
  updatedAt: "2026-07-24T10:00:00.000Z",
  status: "backlog",
};

const snapshot: GitHubIssuesSnapshot = {
  repository: {
    owner: "acme",
    name: "widget",
    fullName: "acme/widget",
    htmlUrl: "https://github.com/acme/widget",
  },
  viewer: { login: "ada" },
  issues: [issue],
};

const comment: GitHubIssueComment = {
  id: 9001,
  body: "A useful note",
  htmlUrl: "https://github.com/acme/widget/issues/42#issuecomment-9001",
  author: { login: "ada" },
  createdAt: "2026-07-24T11:00:00.000Z",
  updatedAt: "2026-07-24T11:00:00.000Z",
  isEdited: false,
  canEdit: true,
};

const detail: GitHubIssueDetail = { ...issue, comments: [] };

const getGitHubIssuesMock = mock(async () => snapshot);
const getGitHubIssueMock = mock(async () => detail);
const updateGitHubIssueStatusMock = mock(async () => ({
  ...issue,
  status: "todo" as const,
  labels: [
    ...issue.labels,
    { name: "ork:todo", color: "1d76db" },
  ],
}));
const updateGitHubIssueMock = mock(async () => ({
  ...issue,
  title: "Updated title",
  body: "Updated body",
}));
const closeGitHubIssueMock = mock(async () => ({
  ...issue,
  state: "closed" as const,
}));
const addGitHubIssueCommentMock = mock(async () => comment);
const updateGitHubIssueCommentMock = mock(async () => ({
  ...comment,
  body: "Edited note",
  isEdited: true,
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getGitHubIssues: getGitHubIssuesMock,
  getGitHubIssue: getGitHubIssueMock,
  updateGitHubIssueStatus: updateGitHubIssueStatusMock,
  updateGitHubIssue: updateGitHubIssueMock,
  closeGitHubIssue: closeGitHubIssueMock,
  addGitHubIssueComment: addGitHubIssueCommentMock,
  updateGitHubIssueComment: updateGitHubIssueCommentMock,
}));

const { githubIssueDetailKey, useGitHubIssuesStore } = await import(
  "./githubIssuesStore"
);

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("githubIssuesStore", () => {
  beforeEach(() => {
    getGitHubIssuesMock.mockReset();
    getGitHubIssuesMock.mockResolvedValue(snapshot);
    getGitHubIssueMock.mockReset();
    getGitHubIssueMock.mockResolvedValue(detail);
    updateGitHubIssueStatusMock.mockReset();
    updateGitHubIssueStatusMock.mockResolvedValue({
      ...issue,
      status: "todo",
      labels: [...issue.labels, { name: "ork:todo", color: "1d76db" }],
    });
    updateGitHubIssueMock.mockReset();
    updateGitHubIssueMock.mockResolvedValue({
      ...issue,
      title: "Updated title",
      body: "Updated body",
    });
    closeGitHubIssueMock.mockReset();
    closeGitHubIssueMock.mockResolvedValue({ ...issue, state: "closed" });
    addGitHubIssueCommentMock.mockReset();
    addGitHubIssueCommentMock.mockResolvedValue(comment);
    updateGitHubIssueCommentMock.mockReset();
    updateGitHubIssueCommentMock.mockResolvedValue({
      ...comment,
      body: "Edited note",
      isEdited: true,
    });
    useGitHubIssuesStore.setState({
      snapshots: new Map(),
      details: new Map(),
      loadingProjects: new Set(),
      loadingDetails: new Set(),
      projectErrors: new Map(),
      detailErrors: new Map(),
      mutations: new Set(),
      mutationErrors: new Map(),
    });
  });

  test("loads a repository-scoped snapshot and issue discussion", async () => {
    await useGitHubIssuesStore.getState().loadIssues("project-1");
    await useGitHubIssuesStore.getState().loadIssue("project-1", 42);

    expect(getGitHubIssuesMock).toHaveBeenCalledWith("project-1");
    expect(getGitHubIssueMock).toHaveBeenCalledWith("project-1", 42);
    expect(
      useGitHubIssuesStore.getState().snapshots.get("project-1")?.repository.fullName,
    ).toBe("acme/widget");
    expect(
      useGitHubIssuesStore
        .getState()
        .details.get(githubIssueDetailKey("project-1", 42))?.number,
    ).toBe(42);
  });

  test("updates status from the authoritative response and reloads after failure", async () => {
    await useGitHubIssuesStore.getState().loadIssues("project-1");
    await useGitHubIssuesStore.getState().changeStatus("project-1", 42, "todo");

    expect(updateGitHubIssueStatusMock).toHaveBeenCalledWith(
      "project-1",
      42,
      "todo",
    );
    expect(
      useGitHubIssuesStore.getState().snapshots.get("project-1")?.issues[0]?.status,
    ).toBe("todo");

    updateGitHubIssueStatusMock.mockRejectedValueOnce(
      new Error("GitHub rejected the label update"),
    );
    getGitHubIssuesMock.mockResolvedValueOnce(snapshot);

    await expect(
      useGitHubIssuesStore.getState().changeStatus("project-1", 42, "review"),
    ).rejects.toThrow("GitHub rejected the label update");

    expect(getGitHubIssuesMock).toHaveBeenCalledTimes(2);
    expect(
      useGitHubIssuesStore.getState().snapshots.get("project-1")?.issues[0]?.status,
    ).toBe("backlog");
    expect(
      useGitHubIssuesStore
        .getState()
        .mutationErrors.get("status:project-1:42"),
    ).toContain("GitHub rejected");
  });

  test("keeps list and detail state current after edits and comments", async () => {
    await useGitHubIssuesStore.getState().loadIssues("project-1");
    await useGitHubIssuesStore.getState().loadIssue("project-1", 42);

    await useGitHubIssuesStore.getState().saveIssue("project-1", 42, {
      title: "Updated title",
      body: "Updated body",
    });
    await useGitHubIssuesStore
      .getState()
      .addComment("project-1", 42, "A useful note");
    await useGitHubIssuesStore
      .getState()
      .editComment("project-1", 42, comment.id, "Edited note");

    const state = useGitHubIssuesStore.getState();
    expect(state.snapshots.get("project-1")?.issues[0]?.title).toBe(
      "Updated title",
    );
    const currentDetail = state.details.get(
      githubIssueDetailKey("project-1", 42),
    );
    expect(currentDetail?.title).toBe("Updated title");
    expect(currentDetail?.commentsCount).toBe(1);
    expect(currentDetail?.comments[0]?.body).toBe("Edited note");
  });

  test("removes a successfully closed issue from the open snapshot", async () => {
    await useGitHubIssuesStore.getState().loadIssues("project-1");
    await useGitHubIssuesStore.getState().closeIssue("project-1", 42);

    expect(closeGitHubIssueMock).toHaveBeenCalledWith("project-1", 42);
    expect(
      useGitHubIssuesStore.getState().snapshots.get("project-1")?.issues,
    ).toEqual([]);
  });
});
