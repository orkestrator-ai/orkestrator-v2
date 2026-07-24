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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

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

  test("records project and detail loading errors and clears loading state", async () => {
    getGitHubIssuesMock.mockRejectedValueOnce("repository unavailable");
    getGitHubIssueMock.mockRejectedValueOnce({});

    await useGitHubIssuesStore.getState().loadIssues("project-1");
    await useGitHubIssuesStore.getState().loadIssue("project-1", 42);

    const state = useGitHubIssuesStore.getState();
    expect(state.loadingProjects.has("project-1")).toBe(false);
    expect(state.loadingDetails.has(githubIssueDetailKey("project-1", 42))).toBe(false);
    expect(state.projectErrors.get("project-1")).toBe("repository unavailable");
    expect(state.detailErrors.get(githubIssueDetailKey("project-1", 42))).toBe(
      "Could not load this GitHub issue.",
    );
  });

  test("ignores stale list and detail reads after a successful edit", async () => {
    await useGitHubIssuesStore.getState().loadIssues("project-1");
    await useGitHubIssuesStore.getState().loadIssue("project-1", 42);
    const staleList = deferred<GitHubIssuesSnapshot>();
    const staleDetail = deferred<GitHubIssueDetail>();
    getGitHubIssuesMock.mockImplementationOnce(() => staleList.promise);
    getGitHubIssueMock.mockImplementationOnce(() => staleDetail.promise);

    const listRequest = useGitHubIssuesStore.getState().loadIssues("project-1");
    const detailRequest = useGitHubIssuesStore.getState().loadIssue("project-1", 42);
    await useGitHubIssuesStore.getState().saveIssue("project-1", 42, {
      title: "Updated title",
      body: "Updated body",
    });
    staleList.resolve(snapshot);
    staleDetail.resolve(detail);
    await Promise.all([listRequest, detailRequest]);

    const state = useGitHubIssuesStore.getState();
    expect(state.snapshots.get("project-1")?.issues[0]?.title).toBe("Updated title");
    expect(
      state.details.get(githubIssueDetailKey("project-1", 42))?.title,
    ).toBe("Updated title");
    expect(state.loadingProjects.has("project-1")).toBe(false);
    expect(state.loadingDetails.has(githubIssueDetailKey("project-1", 42))).toBe(false);
  });

  test("ignores stale reads after closing an issue", async () => {
    await useGitHubIssuesStore.getState().loadIssues("project-1");
    await useGitHubIssuesStore.getState().loadIssue("project-1", 42);
    const staleList = deferred<GitHubIssuesSnapshot>();
    const staleDetail = deferred<GitHubIssueDetail>();
    getGitHubIssuesMock.mockImplementationOnce(() => staleList.promise);
    getGitHubIssueMock.mockImplementationOnce(() => staleDetail.promise);

    const listRequest = useGitHubIssuesStore.getState().loadIssues("project-1");
    const detailRequest = useGitHubIssuesStore.getState().loadIssue("project-1", 42);
    await useGitHubIssuesStore.getState().closeIssue("project-1", 42);
    staleList.resolve(snapshot);
    staleDetail.resolve(detail);
    await Promise.all([listRequest, detailRequest]);

    const state = useGitHubIssuesStore.getState();
    expect(state.snapshots.get("project-1")?.issues).toEqual([]);
    expect(state.details.has(githubIssueDetailKey("project-1", 42))).toBe(false);
  });

  test("reports edit, close, add-comment, and edit-comment failures without losing detail state", async () => {
    await useGitHubIssuesStore.getState().loadIssues("project-1");
    await useGitHubIssuesStore.getState().loadIssue("project-1", 42);
    updateGitHubIssueMock.mockRejectedValueOnce(new Error("edit rejected"));
    closeGitHubIssueMock.mockRejectedValueOnce(new Error("close rejected"));
    addGitHubIssueCommentMock.mockRejectedValueOnce(new Error("post rejected"));
    updateGitHubIssueCommentMock.mockRejectedValueOnce(new Error("comment stale"));

    await expect(
      useGitHubIssuesStore.getState().saveIssue("project-1", 42, {
        title: "Draft",
        body: "Draft body",
      }),
    ).rejects.toThrow("edit rejected");
    await expect(
      useGitHubIssuesStore.getState().closeIssue("project-1", 42),
    ).rejects.toThrow("close rejected");
    await expect(
      useGitHubIssuesStore.getState().addComment("project-1", 42, "Draft comment"),
    ).rejects.toThrow("post rejected");
    await expect(
      useGitHubIssuesStore.getState().editComment("project-1", 42, 9001, "Draft edit"),
    ).rejects.toThrow("comment stale");

    const state = useGitHubIssuesStore.getState();
    expect(state.details.get(githubIssueDetailKey("project-1", 42))).toEqual(detail);
    expect(state.mutationErrors.get("edit:project-1:42")).toBe("edit rejected");
    expect(state.mutationErrors.get("close:project-1:42")).toBe("close rejected");
    expect(state.mutationErrors.get("comment-add:project-1:42")).toBe("post rejected");
    expect(state.mutationErrors.get("comment-edit:project-1:9001")).toBe("comment stale");

    useGitHubIssuesStore.getState().clearMutationError("edit:project-1:42");
    expect(
      useGitHubIssuesStore.getState().mutationErrors.has("edit:project-1:42"),
    ).toBe(false);
  });

  test("guards duplicate mutations for the same issue or comment", async () => {
    const pendingStatus = deferred<GitHubIssue & { status: "todo" }>();
    const pendingClose = deferred<GitHubIssue & { state: "closed" }>();
    const pendingEdit = deferred<GitHubIssue>();
    const pendingAdd = deferred<GitHubIssueComment>();
    const pendingCommentEdit = deferred<GitHubIssueComment>();
    updateGitHubIssueStatusMock.mockImplementationOnce(() => pendingStatus.promise);
    closeGitHubIssueMock.mockImplementationOnce(() => pendingClose.promise);
    updateGitHubIssueMock.mockImplementationOnce(() => pendingEdit.promise);
    addGitHubIssueCommentMock.mockImplementationOnce(() => pendingAdd.promise);
    updateGitHubIssueCommentMock.mockImplementationOnce(() => pendingCommentEdit.promise);

    const firstStatus = useGitHubIssuesStore
      .getState()
      .changeStatus("project-1", 42, "todo");
    await useGitHubIssuesStore.getState().changeStatus("project-1", 42, "review");
    pendingStatus.resolve({ ...issue, status: "todo" });
    await firstStatus;

    const firstClose = useGitHubIssuesStore.getState().closeIssue("project-1", 42);
    await useGitHubIssuesStore.getState().closeIssue("project-1", 42);
    pendingClose.resolve({ ...issue, state: "closed" });
    await firstClose;

    const firstEdit = useGitHubIssuesStore.getState().saveIssue("project-1", 42, {
      title: "First",
      body: "First",
    });
    await expect(
      useGitHubIssuesStore.getState().saveIssue("project-1", 42, {
        title: "Second",
        body: "Second",
      }),
    ).rejects.toThrow("already being saved");
    pendingEdit.resolve({ ...issue, title: "First", body: "First" });
    await firstEdit;

    const firstAdd = useGitHubIssuesStore.getState().addComment("project-1", 42, "First");
    await expect(
      useGitHubIssuesStore.getState().addComment("project-1", 42, "Second"),
    ).rejects.toThrow("already being posted");
    pendingAdd.resolve(comment);
    await firstAdd;

    const firstCommentEdit = useGitHubIssuesStore
      .getState()
      .editComment("project-1", 42, comment.id, "First");
    await expect(
      useGitHubIssuesStore
        .getState()
        .editComment("project-1", 42, comment.id, "Second"),
    ).rejects.toThrow("already being saved");
    pendingCommentEdit.resolve({ ...comment, body: "First" });
    await firstCommentEdit;

    expect(updateGitHubIssueStatusMock).toHaveBeenCalledTimes(1);
    expect(closeGitHubIssueMock).toHaveBeenCalledTimes(1);
    expect(updateGitHubIssueMock).toHaveBeenCalledTimes(1);
    expect(addGitHubIssueCommentMock).toHaveBeenCalledTimes(1);
    expect(updateGitHubIssueCommentMock).toHaveBeenCalledTimes(1);
  });

  test("clears only the requested project's state and invalidates its pending reads", async () => {
    const pendingList = deferred<GitHubIssuesSnapshot>();
    const pendingDetail = deferred<GitHubIssueDetail>();
    getGitHubIssuesMock.mockImplementationOnce(() => pendingList.promise);
    getGitHubIssueMock.mockImplementationOnce(() => pendingDetail.promise);
    useGitHubIssuesStore.setState({
      snapshots: new Map([["project-2", snapshot]]),
      details: new Map([[githubIssueDetailKey("project-2", 42), detail]]),
      projectErrors: new Map([["project-1", "old error"]]),
      detailErrors: new Map([[githubIssueDetailKey("project-1", 42), "old error"]]),
      mutations: new Set(["edit:project-1:42", "edit:project-2:42"]),
      mutationErrors: new Map([
        ["edit:project-1:42", "old error"],
        ["edit:project-2:42", "keep"],
      ]),
    });

    const listRequest = useGitHubIssuesStore.getState().loadIssues("project-1");
    const detailRequest = useGitHubIssuesStore.getState().loadIssue("project-1", 42);
    useGitHubIssuesStore.getState().clearProject("project-1");
    pendingList.resolve(snapshot);
    pendingDetail.resolve(detail);
    await Promise.all([listRequest, detailRequest]);

    const state = useGitHubIssuesStore.getState();
    expect(state.snapshots.has("project-1")).toBe(false);
    expect(state.details.has(githubIssueDetailKey("project-1", 42))).toBe(false);
    expect(state.snapshots.has("project-2")).toBe(true);
    expect(state.details.has(githubIssueDetailKey("project-2", 42))).toBe(true);
    expect(state.mutations).toEqual(new Set(["edit:project-2:42"]));
    expect(state.mutationErrors).toEqual(
      new Map([["edit:project-2:42", "keep"]]),
    );
  });
});
