import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import {
  githubIssueDetailKey,
  useGitHubIssuesStore,
} from "@/stores/githubIssuesStore";
import type { GitHubIssueDetail, GitHubRepository } from "@/types/github";
import type { EnvironmentType } from "@/types";
import type { GitHubIssueBuildInput } from "@/hooks/useBuildPipeline";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import * as realBackend from "@/lib/backend";

const realBackendSnapshot = { ...realBackend };
const openInBrowserMock = mock(async () => undefined);
const getComposeDraftMock = mock(async (_draftKey: string) => null as Awaited<
  ReturnType<typeof realBackend.getComposeDraft>
>);
const saveComposeDraftMock = mock(async (
  draftKey: string,
  ownerType: "environment" | "project",
  ownerId: string,
  value: unknown,
) => ({
  draftKey,
  ownerType,
  ownerId,
  value,
  revision: 1,
  updatedAt: "2026-07-28T00:00:00.000Z",
}));
const deleteComposeDraftMock = mock(async (_draftKey: string) => undefined);
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
  openInBrowser: openInBrowserMock,
  getComposeDraft: getComposeDraftMock,
  saveComposeDraft: saveComposeDraftMock,
  deleteComposeDraft: deleteComposeDraftMock,
  retryBuildPipelineCompletionComment: retryCompletionCommentMock,
}));

const { GitHubIssueDetailContent } = await import("./GitHubIssueDetail");

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
const startBuildMock = mock<
  (
    issue: GitHubIssueBuildInput,
    projectId: string,
    environmentType: EnvironmentType,
  ) => Promise<string | undefined>
>(
  async (
    _issue: GitHubIssueBuildInput,
    _projectId: string,
    _environmentType: EnvironmentType,
  ) => "pipeline-new",
);
const navigateToPipelineMock = mock(async () => undefined);
const originalGitHubStoreState = useGitHubIssuesStore.getState();

afterAll(() => {
  cleanup();
  useGitHubIssuesStore.setState(originalGitHubStoreState, true);
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("GitHubIssueDetail", () => {
  afterEach(cleanup);

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
    startBuildMock.mockResolvedValue("pipeline-new");
    navigateToPipelineMock.mockClear();
    openInBrowserMock.mockClear();
    getComposeDraftMock.mockReset();
    getComposeDraftMock.mockResolvedValue(null);
    saveComposeDraftMock.mockReset();
    saveComposeDraftMock.mockImplementation(async (draftKey, ownerType, ownerId, value) => ({
      draftKey,
      ownerType,
      ownerId,
      value,
      revision: 1,
      updatedAt: "2026-07-28T00:00:00.000Z",
    }));
    deleteComposeDraftMock.mockReset();
    deleteComposeDraftMock.mockResolvedValue(undefined);
    retryCompletionCommentMock.mockClear();
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

  function renderDetail({
    onBack = () => {},
    onClosed = () => {},
  }: {
    onBack?: () => void;
    onClosed?: () => void;
  } = {}) {
    return render(
      <GitHubIssueDetailContent
        projectId="project-1"
        repository={repository}
        issueNumber={42}
        summary={detail}
        onBack={onBack}
        onClosed={onClosed}
        buildPipeline={{
          startBuildFromGitHubIssue: startBuildMock,
          navigateToPipeline: navigateToPipelineMock,
        }}
      />,
    );
  }

  function seedIssuePipeline(
    phase: "creating-environment" | "building" | "complete" | "failed",
    environmentId?: string,
  ) {
    const pipelineId = `pipeline-${phase}-${environmentId ?? "pending"}`;
    useBuildPipelineStore.getState().replacePipeline(buildPipelineFixture({
      id: pipelineId,
      taskId: "github:acme/widget#42",
      environmentId: environmentId ?? "",
      phase,
      taskTitle: "#42: Ship GitHub issues",
      taskSnapshot: {
        title: detail.title,
        description: detail.body,
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      source: {
        type: "github",
        repositoryOwner: "acme",
        repositoryName: "widget",
        issueNumber: 42,
        issueUrl: detail.htmlUrl,
        status: "Todo",
      },
    }));
    return pipelineId;
  }

  test("preserves issue and comment drafts when GitHub rejects mutations", async () => {
    saveIssueMock.mockRejectedValueOnce(new Error("Title update was rejected"));
    addCommentMock.mockRejectedValueOnce(new Error("Comment permission denied"));
    const view = renderDetail();

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
    view.unmount();
    await waitFor(() => expect(saveComposeDraftMock).toHaveBeenCalledWith(
      "github-comment:project-1:acme%2Fwidget%2342",
      "project",
      "project-1",
      "Unsaved discussion draft",
      expect.any(Number),
    ));
  });

  test("initializes editing from fresh detail rather than a stale list summary", async () => {
    render(
      <GitHubIssueDetailContent
        projectId="project-1"
        repository={repository}
        issueNumber={42}
        summary={{
          ...detail,
          title: "Stale list title",
          body: "Stale list body",
        }}
        onBack={() => {}}
        onClosed={() => {}}
        buildPipeline={{
          startBuildFromGitHubIssue: startBuildMock,
          navigateToPipeline: navigateToPipelineMock,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit issue" }));

    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "Issue title" }) as HTMLInputElement).value)
        .toBe(detail.title);
      expect((screen.getByRole("textbox", { name: "Issue body" }) as HTMLTextAreaElement).value)
        .toBe(detail.body);
    });
  });

  test("restores a persisted new-comment draft", async () => {
    getComposeDraftMock.mockImplementation(async (draftKey) => (
      draftKey === "github-comment:project-1:acme%2Fwidget%2342"
        ? {
            draftKey,
            ownerType: "project",
            ownerId: "project-1",
            value: "Recovered GitHub comment",
            revision: 2,
            updatedAt: "2026-07-28T00:00:00.000Z",
          }
        : null
    ));

    renderDetail();

    await waitFor(() => expect((
      screen.getByRole("textbox", { name: "Add GitHub comment" }) as HTMLTextAreaElement
    ).value).toBe("Recovered GitHub comment"));
  });

  test("only offers comment editing when the backend grants permission", () => {
    renderDetail();

    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
    expect(screen.getByText("Someone else's comment")).toBeTruthy();
  });

  test("saves issue edits and clears a successful new-comment draft", async () => {
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Edit issue" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Updated title" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Issue body" }), {
      target: { value: "Updated body" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(saveIssueMock).toHaveBeenCalledWith("project-1", 42, {
        title: "Updated title",
        body: "Updated body",
      });
    });

    const newComment = screen.getByRole("textbox", {
      name: "Add GitHub comment",
    }) as HTMLTextAreaElement;
    fireEvent.change(newComment, { target: { value: "A new decision" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => {
      expect(addCommentMock).toHaveBeenCalledWith(
        "project-1",
        42,
        "A new decision",
      );
      expect(newComment.value).toBe("");
      expect(deleteComposeDraftMock).toHaveBeenCalledWith(
        "github-comment:project-1:acme%2Fwidget%2342",
        expect.any(Number),
      );
    });
  });

  test("edits a permitted comment and preserves the draft after a stale failure", async () => {
    editCommentMock.mockRejectedValueOnce(new Error("Comment was deleted"));
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const draft = screen.getByRole("textbox", {
      name: "Edit comment by ada",
    }) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "Revised comment" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));

    expect(await screen.findByText("Comment was deleted")).toBeTruthy();
    expect(draft.value).toBe("Revised comment");

    editCommentMock.mockResolvedValueOnce({
      ...detail.comments[0]!,
      body: "Revised comment",
      isEdited: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => {
      expect(editCommentMock).toHaveBeenLastCalledWith(
        "project-1",
        42,
        9001,
        "Revised comment",
      );
    });
  });

  test("changes status, opens GitHub, and closes with explicit confirmation", async () => {
    const onClosed = mock(() => undefined);
    renderDetail({ onClosed });

    fireEvent.click(screen.getByRole("combobox", { name: "Issue status" }));
    fireEvent.click(await screen.findByRole("option", { name: "Review" }));
    await waitFor(() => {
      expect(changeStatusMock).toHaveBeenCalledWith("project-1", 42, "review");
    });

    fireEvent.click(screen.getByRole("button", { name: /Open on GitHub/ }));
    expect(openInBrowserMock).toHaveBeenCalledWith(detail.htmlUrl);

    fireEvent.click(screen.getByRole("button", { name: "Close Issue" }));
    expect(screen.getByText("Close issue #42?")).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Close Issue" }).at(-1)!,
    );

    await waitFor(() => {
      expect(closeIssueMock).toHaveBeenCalledWith("project-1", 42);
      expect(onClosed).toHaveBeenCalledTimes(1);
    });
  });

  test("keeps the close confirmation open with an actionable failure", async () => {
    closeIssueMock.mockRejectedValueOnce(new Error("Issue changed on GitHub"));
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Close Issue" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Close Issue" }).at(-1)!,
    );

    expect(await screen.findByText("Issue changed on GitHub")).toBeTruthy();
    expect(screen.getByText("Close issue #42?")).toBeTruthy();
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

  test("starts a container build and shows an existing active build", async () => {
    const activeId = seedIssuePipeline("building", "env-active");
    renderDetail();

    expect(
      screen.getByText("A build is already active for this issue."),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Build Container" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /View Build/ }));
    await waitFor(() => {
      expect(navigateToPipelineMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: activeId, environmentId: "env-active" }),
      );
    });
  });

  test("shows the phase while an existing build is still creating its environment", () => {
    seedIssuePipeline("creating-environment");
    renderDetail();

    expect(screen.getByText("Build phase: creating-environment")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /View Build/ }),
    ).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Build Container" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("starts a container build when no pipeline exists", async () => {
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Build Container" }));

    await waitFor(() => {
      expect(startBuildMock).toHaveBeenCalledWith(
        expect.objectContaining({ number: 42 }),
        "project-1",
        "containerized",
      );
    });
  });

  test("shows an actionable error when build startup returns no pipeline", async () => {
    startBuildMock.mockResolvedValueOnce(undefined);
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Build Local" }));

    expect(
      await screen.findByText(
        "The build pipeline could not be started. Review the error details and try again.",
      ),
    ).toBeTruthy();
  });

  test("keeps retry controls visible for every failed completion comment", async () => {
    const olderId = seedIssuePipeline("failed", "env-old");
    const older = useBuildPipelineStore.getState().pipelines.get(olderId)!;
    useBuildPipelineStore.getState().replacePipeline({
      ...older,
      completionCommentStatus: "failed",
      completionCommentError: "first failure",
      backendRevision: older.backendRevision + 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newerId = seedIssuePipeline("complete", "env-new");
    const newer = useBuildPipelineStore.getState().pipelines.get(newerId)!;
    useBuildPipelineStore.getState().replacePipeline({
      ...newer,
      completionCommentStatus: "failed",
      completionCommentError: "second failure",
      backendRevision: newer.backendRevision + 1,
    });

    renderDetail();

    expect(screen.getByText(/first failure/)).toBeTruthy();
    expect(screen.getByText(/second failure/)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: `Retry completion comment for build ${olderId}`,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: `Retry completion comment for build ${newerId}`,
      }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: `Retry completion comment for build ${olderId}`,
      }),
    );
    await waitFor(() => {
      expect(
        useBuildPipelineStore.getState().pipelines.get(olderId)
          ?.completionCommentStatus,
      ).toBeUndefined();
      expect(
        useBuildPipelineStore.getState().pipelines.get(newerId)
          ?.completionCommentStatus,
      ).toBe("failed");
    });
  });
});
