import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import {
  mockToastError as toastErrorMock,
  mockToastSuccess as toastSuccessMock,
} from "../../../../../tests/mocks/sonner";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import type { LinearConnectionStatus, LinearIssueDetail, LinearIssueListItem } from "@/types/linear";

const realBackendSnapshot = { ...realBackend };

const connectLinearMock = mock(async (): Promise<LinearConnectionStatus> => ({
  connected: true,
  hasToken: true,
  viewer: { id: "viewer-1", name: "Ada" },
}));
const getLinearConnectionMock = mock(async (): Promise<LinearConnectionStatus> => ({
  connected: true,
  hasToken: true,
  viewer: { id: "viewer-1", name: "Ada" },
}));
const getLinearIssuesMock = mock(async (): Promise<LinearIssueListItem[]> => []);
const getLinearIssueMock = mock(async (_issueId: string): Promise<LinearIssueDetail> => issueDetail);
const postLinearIssueCommentMock = mock(async () => ({
  id: "comment-2",
  body: "New note from Orkestrator",
  createdAt: "2026-06-28T12:10:00.000Z",
  authorName: "Ada",
}));
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
const getCachedOpenCodeModelCatalogMock = mock(async () => null);
const retryCompletionCommentMock = mock(async (pipelineId: string) => {
  const current = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
  return {
    ...current,
    completionCommentStatus: undefined,
    completionCommentError: undefined,
    backendRevision: current.backendRevision + 1,
  };
});
const startBuildFromLinearIssueMock = mock(async () => undefined);
const navigateToPipelineMock = mock(async () => undefined);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  connectLinear: connectLinearMock,
  getLinearConnection: getLinearConnectionMock,
  getLinearIssues: getLinearIssuesMock,
  getLinearIssue: getLinearIssueMock,
  postLinearIssueComment: postLinearIssueCommentMock,
  openInBrowser: openInBrowserMock,
  getComposeDraft: getComposeDraftMock,
  saveComposeDraft: saveComposeDraftMock,
  deleteComposeDraft: deleteComposeDraftMock,
  getCachedOpenCodeModelCatalog: getCachedOpenCodeModelCatalogMock,
  retryBuildPipelineCompletionComment: retryCompletionCommentMock,
}));

const { LinearTicketsViewContent } = await import("./LinearTicketsView");

const issues: LinearIssueListItem[] = [
  {
    id: "issue-1",
    identifier: "ENG-123",
    title: "Add Linear integration",
    status: "Todo",
    updatedAt: "2026-06-28T12:00:00.000Z",
    teamKey: "ENG",
  },
  {
    id: "issue-2",
    identifier: "ENG-124",
    title: "Polish dashboard",
    status: "Done",
    updatedAt: "2026-06-27T12:00:00.000Z",
    teamKey: "ENG",
  },
];

const issueDetail: LinearIssueDetail = {
  ...issues[0]!,
  description: "Build Linear support",
  createdAt: "2026-06-20T12:00:00.000Z",
  url: "https://linear.app/acme/issue/ENG-123",
  assigneeName: "Ada",
  priorityLabel: "High",
  creatorName: "Grace",
  projectName: "Integrations",
  cycleName: "Cycle 1",
  labels: ["linear", "pipeline"],
  comments: [{
    id: "comment-1",
    body: "Initial Linear comment",
    createdAt: "2026-06-28T12:01:00.000Z",
    authorName: "Grace",
  }],
};

const issue2Detail: LinearIssueDetail = {
  ...issues[1]!,
  description: "Polish dashboard details",
  createdAt: "2026-06-21T12:00:00.000Z",
  url: "https://linear.app/acme/issue/ENG-124",
  assigneeName: "Grace",
  priorityLabel: "Medium",
  creatorName: "Ada",
  projectName: "Dashboard",
  cycleName: "Cycle 2",
  labels: ["polish"],
  comments: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("LinearTicketsView", () => {
  beforeEach(() => {
    cleanup();
    connectLinearMock.mockClear();
    getLinearConnectionMock.mockReset();
    getLinearConnectionMock.mockResolvedValue({
      connected: true,
      hasToken: true,
      viewer: { id: "viewer-1", name: "Ada" },
    });
    getLinearIssuesMock.mockReset();
    getLinearIssuesMock.mockResolvedValue(issues);
    getLinearIssueMock.mockReset();
    getLinearIssueMock.mockResolvedValue(issueDetail);
    postLinearIssueCommentMock.mockReset();
    postLinearIssueCommentMock.mockResolvedValue({
      id: "comment-2",
      body: "New note from Orkestrator",
      createdAt: "2026-06-28T12:10:00.000Z",
      authorName: "Ada",
    });
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
    getCachedOpenCodeModelCatalogMock.mockReset();
    getCachedOpenCodeModelCatalogMock.mockResolvedValue(null);
    retryCompletionCommentMock.mockClear();
    startBuildFromLinearIssueMock.mockClear();
    navigateToPipelineMock.mockClear();
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  function renderLinearTicketsView() {
    return render(
      <LinearTicketsViewContent
        projectId="project-1"
        buildPipeline={{
          startBuildFromLinearIssue: startBuildFromLinearIssueMock,
          navigateToPipeline: navigateToPipelineMock,
        }}
      />,
    );
  }

  test("shows a connect state and can start Linear connection setup", async () => {
    getLinearConnectionMock.mockResolvedValueOnce({
      connected: false,
      hasToken: false,
    });

    renderLinearTicketsView();

    expect(await screen.findByText("Linear is not connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /connect linear/i }));
    fireEvent.change(screen.getByPlaceholderText("lin_api_..."), {
      target: { value: "lin_api_secret" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /^connect$/i }).at(-1)!);

    await waitFor(() => {
      expect(connectLinearMock).toHaveBeenCalledWith("lin_api_secret");
      expect(toastSuccessMock).toHaveBeenCalledWith("Linear connected");
    });
  });

  test("loads tickets and filters by one or more Linear statuses", async () => {
    renderLinearTicketsView();

    expect(await screen.findByText("Add Linear integration")).toBeTruthy();
    expect(screen.getByText("Polish dashboard")).toBeTruthy();

    fireEvent.click(screen.getAllByText("Todo")[0]!);

    await waitFor(() => {
      expect(screen.getByText("Add Linear integration")).toBeTruthy();
      expect(screen.queryByText("Polish dashboard")).toBeNull();
    });

    fireEvent.click(screen.getByText("Clear"));
    await waitFor(() => {
      expect(screen.getByText("Polish dashboard")).toBeTruthy();
    });
  });

  test("preserves the backend issue order within a status group", async () => {
    // Backend order (by manual sortOrder) is intentionally neither alphabetical
    // nor updatedAt-descending, so a re-sort in the component would be visible.
    const orderedIssues: LinearIssueListItem[] = [
      {
        id: "issue-c",
        identifier: "ENG-30",
        title: "Gamma ticket",
        status: "Todo",
        updatedAt: "2026-06-10T12:00:00.000Z",
        teamKey: "ENG",
        sortOrder: 1,
      },
      {
        id: "issue-a",
        identifier: "ENG-10",
        title: "Alpha ticket",
        status: "Todo",
        updatedAt: "2026-06-28T12:00:00.000Z",
        teamKey: "ENG",
        sortOrder: 2,
      },
      {
        id: "issue-b",
        identifier: "ENG-20",
        title: "Beta ticket",
        status: "Todo",
        updatedAt: "2026-06-20T12:00:00.000Z",
        teamKey: "ENG",
        sortOrder: 3,
      },
    ];
    getLinearIssuesMock.mockResolvedValue(orderedIssues);

    renderLinearTicketsView();

    await screen.findByText("Gamma ticket");
    const titles = screen.getAllByText(/ ticket$/).map((element) => element.textContent);
    expect(titles).toEqual(["Gamma ticket", "Alpha ticket", "Beta ticket"]);
  });

  test("opens the shared build launcher and starts a configured Linear-backed build", async () => {
    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));

    expect(await screen.findByText("Build Linear support")).toBeTruthy();
    expect(screen.getAllByText("Grace").length).toBeGreaterThan(0);
    expect(screen.getByText("Integrations")).toBeTruthy();
    expect(screen.getByText("Initial Linear comment")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^build/i }));

    expect(await screen.findByRole("heading", { name: "Configure build" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Build environment" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "All steps agent" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", {
      name: /Use one configuration for every step/,
    }));
    expect(screen.getByRole("radiogroup", { name: "Review agent" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /^Local/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start build" }));

    await waitFor(() => {
      expect(startBuildFromLinearIssueMock).toHaveBeenCalledWith(
        issueDetail,
        "project-1",
        "local",
        {
          steps: expect.objectContaining({
            build: expect.objectContaining({ agent: expect.any(String), model: expect.any(String) }),
            review: expect.objectContaining({ agent: expect.any(String), model: expect.any(String) }),
          }),
        },
      );
    });
  });

  test("blocks an open launcher when a build becomes active in the background", async () => {
    renderLinearTicketsView();
    fireEvent.click(await screen.findByText("Add Linear integration"));
    await screen.findByText("Build Linear support");
    fireEvent.click(screen.getByRole("button", { name: /^build/i }));

    const startButton = await screen.findByRole("button", {
      name: "Start build",
    }) as HTMLButtonElement;
    const form = startButton.closest("form");
    expect(form).not.toBeNull();
    expect(startButton.disabled).toBe(false);

    const activePipeline = buildPipelineFixture({
      id: "linear-background-build",
      taskId: "issue-1",
      environmentId: "env-background-build",
      phase: "building",
      source: {
        type: "linear",
        issueId: "issue-1",
        issueIdentifier: "ENG-123",
      },
    });
    act(() => {
      useBuildPipelineStore.getState().replacePipeline(activePipeline);
    });

    await waitFor(() => expect(startButton.disabled).toBe(true));

    // A programmatic submit bypasses the disabled button and exercises the
    // confirmation-time store guard against a stale event ordering.
    fireEvent.submit(form!);
    await waitFor(() => {
      expect(navigateToPipelineMock).toHaveBeenCalledWith(activePipeline);
    });
    expect(startBuildFromLinearIssueMock).not.toHaveBeenCalled();
  });

  test("posts a new Linear comment from ticket details", async () => {
    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));
    expect(await screen.findByText("Initial Linear comment")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Add Linear comment"), {
      target: { value: "New note from Orkestrator" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^comment$/i }));

    await waitFor(() => {
      expect(postLinearIssueCommentMock).toHaveBeenCalledWith("issue-1", "New note from Orkestrator");
      expect(screen.getByText("New note from Orkestrator")).toBeTruthy();
      expect(toastSuccessMock).toHaveBeenCalledWith("Linear comment added");
      expect(deleteComposeDraftMock).toHaveBeenCalledWith(
        "linear-comment:project-1:issue-1",
        expect.any(Number),
      );
    });
  });

  test("does not clear a newly selected ticket draft when an older comment finishes", async () => {
    const pendingComment = deferred<Awaited<ReturnType<typeof postLinearIssueCommentMock>>>();
    postLinearIssueCommentMock.mockImplementationOnce(() => pendingComment.promise);
    getLinearIssueMock.mockImplementation(async (issueId) =>
      issueId === "issue-2" ? issue2Detail : issueDetail
    );
    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));
    await screen.findByText("Initial Linear comment");
    fireEvent.change(screen.getByLabelText("Add Linear comment"), {
      target: { value: "Comment for the first ticket" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^comment$/i }));
    await waitFor(() => expect(postLinearIssueCommentMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Back to Linear tickets" }));
    fireEvent.click(await screen.findByText("Polish dashboard"));
    await screen.findByText("Polish dashboard details");
    fireEvent.change(screen.getByLabelText("Add Linear comment"), {
      target: { value: "Keep this second-ticket draft" },
    });

    pendingComment.resolve({
      id: "comment-late",
      body: "Comment for the first ticket",
      createdAt: "2026-06-28T12:10:00.000Z",
      authorName: "Ada",
    });

    await waitFor(() => expect(deleteComposeDraftMock).toHaveBeenCalledWith(
      "linear-comment:project-1:issue-1",
      expect.any(Number),
    ));
    expect((screen.getByLabelText("Add Linear comment") as HTMLTextAreaElement).value)
      .toBe("Keep this second-ticket draft");
    expect(screen.queryByText("Comment for the first ticket")).toBeNull();
  });

  test("does not clear a newer draft after returning to the submitted ticket", async () => {
    const pendingComment = deferred<Awaited<ReturnType<typeof postLinearIssueCommentMock>>>();
    postLinearIssueCommentMock.mockImplementationOnce(() => pendingComment.promise);
    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));
    await screen.findByText("Initial Linear comment");
    fireEvent.change(screen.getByLabelText("Add Linear comment"), {
      target: { value: "First submitted comment" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^comment$/i }));
    await waitFor(() => expect(postLinearIssueCommentMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Back to Linear tickets" }));
    fireEvent.click(await screen.findByText("Add Linear integration"));
    await screen.findByText("Initial Linear comment");
    fireEvent.change(screen.getByLabelText("Add Linear comment"), {
      target: { value: "New draft for the same ticket" },
    });
    const submittedDraftDeletesBeforeResolution =
      deleteComposeDraftMock.mock.calls.filter(
        ([draftKey]) => draftKey === "linear-comment:project-1:issue-1",
      ).length;

    pendingComment.resolve({
      id: "comment-late-same-ticket",
      body: "First submitted comment",
      createdAt: "2026-06-28T12:15:00.000Z",
      authorName: "Ada",
    });

    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith("Linear comment added"),
    );
    expect((screen.getByLabelText("Add Linear comment") as HTMLTextAreaElement).value)
      .toBe("New draft for the same ticket");
    expect(
      deleteComposeDraftMock.mock.calls.filter(
        ([draftKey]) => draftKey === "linear-comment:project-1:issue-1",
      ),
    ).toHaveLength(submittedDraftDeletesBeforeResolution);
  });

  test("restores a persisted Linear comment draft for the selected ticket", async () => {
    getComposeDraftMock.mockImplementation(async (draftKey) => (
      draftKey === "linear-comment:project-1:issue-1"
        ? {
            draftKey,
            ownerType: "project",
            ownerId: "project-1",
            value: "Recovered Linear comment",
            revision: 2,
            updatedAt: "2026-07-28T00:00:00.000Z",
          }
        : null
    ));
    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));

    await waitFor(() => expect((
      screen.getByLabelText("Add Linear comment") as HTMLTextAreaElement
    ).value).toBe("Recovered Linear comment"));
  });

  test("surfaces an error and keeps the draft when posting a comment fails", async () => {
    postLinearIssueCommentMock.mockRejectedValueOnce(new Error("Linear rejected the comment"));
    const view = renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));
    expect(await screen.findByText("Initial Linear comment")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Add Linear comment"), {
      target: { value: "Draft that should survive" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^comment$/i }));

    await waitFor(() => {
      expect(screen.getByText("Linear rejected the comment")).toBeTruthy();
    });
    expect(toastSuccessMock).not.toHaveBeenCalledWith("Linear comment added");
    expect((screen.getByLabelText("Add Linear comment") as HTMLTextAreaElement).value).toBe(
      "Draft that should survive",
    );
    view.unmount();
    await waitFor(() => expect(saveComposeDraftMock).toHaveBeenCalledWith(
      "linear-comment:project-1:issue-1",
      "project",
      "project-1",
      "Draft that should survive",
      expect.any(Number),
    ));
  });

  test("shows an empty state when the ticket has no comments", async () => {
    getLinearIssueMock.mockResolvedValue({ ...issueDetail, comments: [] });
    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));

    expect(await screen.findByText("Build Linear support")).toBeTruthy();
    expect(screen.getByText("No comments")).toBeTruthy();
  });

  test("ignores stale detail responses after switching tickets", async () => {
    const firstDetail = deferred<LinearIssueDetail>();
    const secondDetail = deferred<LinearIssueDetail>();
    getLinearIssueMock.mockImplementation((issueId: string) =>
      issueId === "issue-1" ? firstDetail.promise : secondDetail.promise
    );

    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));
    fireEvent.click(screen.getByRole("button", { name: /back to linear tickets/i }));
    fireEvent.click(await screen.findByText("Polish dashboard"));

    secondDetail.resolve(issue2Detail);
    expect(await screen.findByText("Polish dashboard details")).toBeTruthy();

    firstDetail.resolve(issueDetail);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText("Build Linear support")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^build/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Start build" }));
    await waitFor(() => {
      expect(startBuildFromLinearIssueMock).toHaveBeenCalledWith(
        issue2Detail,
        "project-1",
        "containerized",
        { steps: expect.any(Object) },
      );
    });
  });

  test("keeps connected tickets visible when an older connection check resolves later", async () => {
    const staleConnection = deferred<LinearConnectionStatus>();
    getLinearConnectionMock.mockImplementationOnce(() => staleConnection.promise);
    getLinearConnectionMock.mockResolvedValue({
      connected: true,
      hasToken: true,
      viewer: { id: "viewer-1", name: "Ada" },
    });
    connectLinearMock.mockResolvedValueOnce({
      connected: true,
      hasToken: true,
      viewer: { id: "viewer-1", name: "Ada" },
    });

    renderLinearTicketsView();

    fireEvent.click(await screen.findByRole("button", { name: /connect linear/i }));
    fireEvent.change(screen.getByPlaceholderText("lin_api_..."), {
      target: { value: "lin_api_secret" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /^connect$/i }).at(-1)!);

    expect(await screen.findByText("Add Linear integration")).toBeTruthy();

    staleConnection.resolve({
      connected: false,
      hasToken: false,
      error: "Not connected",
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Add Linear integration")).toBeTruthy();
    expect(screen.queryByText("Connect a Linear workspace before loading tickets.")).toBeNull();
  });

  test("uses the active Linear pipeline when the same issue has older completed runs", async () => {
    const store = useBuildPipelineStore.getState();
    const oldPipelineId = "linear-old";
    store.replacePipeline(buildPipelineFixture({
      id: oldPipelineId,
      taskId: "issue-1",
      environmentId: "env-old",
      phase: "complete",
      taskTitle: "ENG-123: Add Linear integration",
      taskSnapshot: {
        title: "ENG-123: Add Linear integration",
        description: "Build Linear support",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      source: {
        type: "linear",
        issueId: "issue-1",
        issueIdentifier: "ENG-123",
      },
    }));

    const activePipelineId = "linear-active";
    store.replacePipeline(buildPipelineFixture({
      id: activePipelineId,
      taskId: "issue-1",
      environmentId: "env-active",
      phase: "building",
      taskTitle: "ENG-123: Add Linear integration",
      taskSnapshot: {
        title: "ENG-123: Add Linear integration",
        description: "Build Linear support",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      source: {
        type: "linear",
        issueId: "issue-1",
        issueIdentifier: "ENG-123",
      },
    }));

    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));
    expect(await screen.findByText("Build Linear support")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /view build/i }));

    await waitFor(() => {
      expect(navigateToPipelineMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: activePipelineId, phase: "building", environmentId: "env-active" }),
      );
    });
  });

  test("shows a recoverable detail load error", async () => {
    getLinearIssueMock
      .mockRejectedValueOnce(new Error("Linear detail unavailable"))
      .mockResolvedValueOnce(issueDetail);

    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));
    expect(await screen.findByText("Linear detail unavailable")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      expect(screen.getByText("Build Linear support")).toBeTruthy();
    });
  });

  test("clears failed completion comment state when retrying from ticket details", async () => {
    const pipelineId = "linear-completion-failed";
    useBuildPipelineStore.getState().replacePipeline(buildPipelineFixture({
      id: pipelineId,
      taskId: "issue-1",
      phase: "complete",
      taskTitle: "ENG-123: Add Linear integration",
      taskSnapshot: {
        title: "ENG-123: Add Linear integration",
        description: "Build Linear support",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      source: {
        type: "linear",
        issueId: "issue-1",
        issueIdentifier: "ENG-123",
      },
      completionCommentStatus: "failed",
      completionCommentError: "Linear unavailable",
    }));

    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));
    expect(await screen.findByText("Linear comment failed: Linear unavailable")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /retry comment/i }));

    await waitFor(() => {
      expect(
        useBuildPipelineStore.getState().pipelines.get(pipelineId)
          ?.completionCommentStatus,
      ).toBeUndefined();
    });
  });

  test("keeps Linear completion retries single-flight and recovers after rejection", async () => {
    const pipelineId = "linear-completion-retry";
    useBuildPipelineStore.getState().replacePipeline(buildPipelineFixture({
      id: pipelineId,
      taskId: "issue-1",
      phase: "complete",
      taskTitle: "ENG-123: Add Linear integration",
      source: {
        type: "linear",
        issueId: "issue-1",
        issueIdentifier: "ENG-123",
      },
      completionCommentStatus: "failed",
      completionCommentError: "Linear unavailable",
    }));
    const pending = deferred<Awaited<
      ReturnType<typeof retryCompletionCommentMock>
    >>();
    retryCompletionCommentMock.mockImplementationOnce(() => pending.promise);
    renderLinearTicketsView();
    fireEvent.click(await screen.findByText("Add Linear integration"));
    const button = await screen.findByRole("button", {
      name: /retry comment/i,
    }) as HTMLButtonElement;

    fireEvent.click(button);
    fireEvent.click(button);
    expect(retryCompletionCommentMock).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);

    pending.reject(new Error("still offline"));
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Failed to retry Linear completion comment",
      { description: "still offline" },
    );

    fireEvent.click(button);
    await waitFor(() =>
      expect(retryCompletionCommentMock).toHaveBeenCalledTimes(2));
  });
});
