import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import * as realBackend from "@/lib/backend";
import {
  mockToastError as toastErrorMock,
  mockToastSuccess as toastSuccessMock,
} from "../../../../../tests/mocks/sonner";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { projectStore } from "@/stores/projectStore";
import { linearViewPreferencesStore } from "@/stores/linearViewPreferencesStore";
import { dragLinearCard, layOutLinearBoard } from "./linear-board-drag-test-support";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import type {
  LinearBoardLink,
  LinearBoardOptions,
  LinearConnectionStatus,
  LinearIssueDetail,
  LinearIssueListItem,
  LinearNodeConnection,
  LinearTeam,
} from "@/types/linear";
import { appCommandStore } from "@/test/app-command-store";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";

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
const getLinearIssuesMock = mock(async (_projectId?: string): Promise<LinearIssueListItem[]> => []);
const boardLink: LinearBoardLink = {
  key: "repo:github.com/acme/web",
  teamId: "team-eng",
  teamKey: "ENG",
  teamName: "Engineering",
  linearProjectId: "lp-web",
  linearProjectName: "Website",
  updatedAt: "2026-11-11T10:00:00.000Z",
};
const linearTeams: LinearTeam[] = [
  {
    id: "team-eng",
    key: "ENG",
    name: "Engineering",
    projects: [
      { id: "lp-web", name: "Website" },
      { id: "lp-api", name: "API" },
    ],
  },
  { id: "team-ops", key: "OPS", name: "Operations", projects: [] },
];
const getLinearBoardLinkMock = mock(
  async (_projectId: string, _machine?: unknown): Promise<LinearBoardLink | null> => boardLink,
);
const setLinearBoardLinkMock = mock(
  async (
    _projectId: string,
    teamId: string,
    linearProjectId?: string,
  ): Promise<LinearBoardLink> => ({
    key: "repo:github.com/acme/web",
    teamId,
    teamKey: teamId === "team-ops" ? "OPS" : "ENG",
    ...(linearProjectId ? { linearProjectId, linearProjectName: "API" } : {}),
    updatedAt: "2026-11-11T11:00:00.000Z",
  }),
);
const clearLinearBoardLinkMock = mock(async (_projectId: string) => ({ cleared: true }));
const getLinearTeamsMock = mock(async (): Promise<LinearTeam[]> => linearTeams);
const updateLinearIssueMock = mock(
  async (
    _projectId: string,
    _issueId: string,
    _fields: { stateId?: string },
  ): Promise<LinearIssueDetail> => issueDetail,
);
const getLinearBoardOptionsMock = mock(async (_projectId: string): Promise<LinearBoardOptions> => ({
  teamId: "team-1",
  states: [],
}));
const getLinearNodeConnectionsMock = mock(async (): Promise<LinearNodeConnection[]> => []);
const copyLinearConnectionFromNodeMock = mock(
  async (_nodeId: string): Promise<LinearConnectionStatus> => ({
    connected: true,
    hasToken: true,
    viewer: { id: "viewer-1", name: "Ada" },
  }),
);
const disconnectLinearMock = mock(async (): Promise<LinearConnectionStatus> => ({
  connected: false,
  hasToken: false,
}));
const getLinearIssueMock = mock(
  async (_issueId: string): Promise<LinearIssueDetail> => issueDetail,
);
const postLinearIssueCommentMock = mock(async () => ({
  id: "comment-2",
  body: "New note from Orkestrator",
  createdAt: "2026-06-28T12:10:00.000Z",
  authorName: "Ada",
}));
const openInBrowserMock = mock(async () => undefined);
const getComposeDraftMock = mock(
  async (_draftKey: string) => null as Awaited<ReturnType<typeof realBackend.getComposeDraft>>,
);
const saveComposeDraftMock = mock(
  async (
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
  }),
);
const deleteComposeDraftMock = mock(async (_draftKey: string) => undefined);
const getCachedOpenCodeModelCatalogMock = mock(async () => null);
const retryCompletionCommentMock = mock(async (pipelineId: string) => {
  const current = appCommandStore(buildPipelineStore).getState().pipelines.get(pipelineId)!;
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
  getLinearBoardLink: getLinearBoardLinkMock,
  setLinearBoardLink: setLinearBoardLinkMock,
  clearLinearBoardLink: clearLinearBoardLinkMock,
  getLinearTeams: getLinearTeamsMock,
  getLinearBoardOptions: getLinearBoardOptionsMock,
  updateLinearIssue: updateLinearIssueMock,
  getLinearNodeConnections: getLinearNodeConnectionsMock,
  copyLinearConnectionFromNode: copyLinearConnectionFromNodeMock,
  disconnectLinear: disconnectLinearMock,
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
  comments: [
    {
      id: "comment-1",
      body: "Initial Linear comment",
      createdAt: "2026-06-28T12:01:00.000Z",
      authorName: "Grace",
    },
  ],
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

const statusHeadings = () =>
  screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);

// Each status filter chip wraps a checkbox in a label rendering "<status><count>".
const statusChips = () =>
  screen.getAllByRole("checkbox").map((checkbox) => checkbox.closest("label")?.textContent ?? "");

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
    getLinearBoardLinkMock.mockReset();
    getLinearBoardLinkMock.mockResolvedValue(boardLink);
    setLinearBoardLinkMock.mockClear();
    clearLinearBoardLinkMock.mockClear();
    getLinearTeamsMock.mockReset();
    getLinearTeamsMock.mockResolvedValue(linearTeams);
    getLinearNodeConnectionsMock.mockReset();
    getLinearNodeConnectionsMock.mockResolvedValue([]);
    copyLinearConnectionFromNodeMock.mockClear();
    disconnectLinearMock.mockClear();
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
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    appCommandStore(projectStore).setState({ projects: [] });
    appCommandStore(linearViewPreferencesStore).setState({ projects: {} });
    updateLinearIssueMock.mockReset();
    getLinearBoardOptionsMock.mockReset();
    getLinearBoardOptionsMock.mockResolvedValue({
      teamId: "team-1",
      states: [
        { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
        { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
        { id: "s-review", name: "In Review", type: "started", position: 3 },
        { id: "s-done", name: "Done", type: "completed", position: 4 },
      ],
    });
  });

  function renderLinearTicketsView() {
    return renderInAppCommandScope(
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
      expect(screen.queryByText("Polish dashboard") === null).toBe(true);
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

  test("orders tickets within each status by priority, created date, or updated date", async () => {
    const sortableIssues: LinearIssueListItem[] = [
      {
        id: "issue-low",
        identifier: "ENG-LOW",
        title: "Low ticket",
        status: "Todo",
        priority: 4,
        prioritySortOrder: 30,
        priorityLabel: "Low",
        createdAt: "2026-06-28T12:00:00.000Z",
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "issue-urgent",
        identifier: "ENG-URGENT",
        title: "Urgent ticket",
        status: "Todo",
        priorityLabel: "Urgent",
        prioritySortOrder: 10,
        createdAt: "2026-06-20T12:00:00.000Z",
        updatedAt: "2026-06-21T12:00:00.000Z",
      },
      {
        id: "issue-high",
        identifier: "ENG-HIGH",
        title: "High ticket",
        status: "Todo",
        priority: 2,
        priorityLabel: "High",
        prioritySortOrder: 20,
        createdAt: "2026-06-30T12:00:00.000Z",
        updatedAt: "2026-06-25T12:00:00.000Z",
      },
      {
        id: "issue-unprioritized",
        identifier: "ENG-NONE",
        title: "Unprioritized ticket",
        status: "Todo",
        priority: 0,
        priorityLabel: "No priority",
        updatedAt: "2026-07-01T12:00:00.000Z",
      },
    ];
    getLinearIssuesMock.mockResolvedValue(sortableIssues);
    const visibleTitles = () =>
      screen.getAllByText(/ ticket$/).map((element) => element.textContent);

    renderLinearTicketsView();

    await screen.findByText("Urgent ticket");
    fireEvent.click(screen.getByRole("combobox", { name: "Order Linear tickets by" }));
    fireEvent.click(await screen.findByRole("option", { name: "Priority" }));
    await waitFor(() => {
      expect(visibleTitles()).toEqual([
        "Urgent ticket",
        "High ticket",
        "Low ticket",
        "Unprioritized ticket",
      ]);
    });

    fireEvent.click(screen.getByRole("combobox", { name: "Order Linear tickets by" }));
    fireEvent.click(await screen.findByRole("option", { name: "Created date" }));
    await waitFor(() => {
      expect(visibleTitles()).toEqual([
        "High ticket",
        "Low ticket",
        "Urgent ticket",
        "Unprioritized ticket",
      ]);
    });

    fireEvent.click(screen.getByRole("combobox", { name: "Order Linear tickets by" }));
    fireEvent.click(await screen.findByRole("option", { name: "Updated date" }));
    await waitFor(() => {
      expect(visibleTitles()).toEqual([
        "Unprioritized ticket",
        "Low ticket",
        "High ticket",
        "Urgent ticket",
      ]);
    });
  });

  test("uses Linear manual order by default and prioritySortOrder as the priority tie-breaker", async () => {
    getLinearIssuesMock.mockResolvedValue([
      {
        id: "issue-a",
        identifier: "ENG-A",
        title: "Alpha ticket",
        status: "Todo",
        priority: 2,
        prioritySortOrder: 30,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "issue-b",
        identifier: "ENG-B",
        title: "Beta ticket",
        status: "Todo",
        priority: 2,
        prioritySortOrder: 10,
        updatedAt: "2026-06-29T12:00:00.000Z",
      },
      {
        id: "issue-c",
        identifier: "ENG-C",
        title: "Gamma ticket",
        status: "Todo",
        priority: 2,
        prioritySortOrder: 20,
        updatedAt: "2026-06-28T12:00:00.000Z",
      },
    ]);
    const visibleTitles = () =>
      screen.getAllByText(/ ticket$/).map((element) => element.textContent);

    renderLinearTicketsView();

    await screen.findByText("Alpha ticket");
    expect(screen.getByRole("combobox", { name: "Order Linear tickets by" }).textContent).toContain(
      "Linear board",
    );
    expect(visibleTitles()).toEqual(["Alpha ticket", "Beta ticket", "Gamma ticket"]);

    fireEvent.click(screen.getByRole("combobox", { name: "Order Linear tickets by" }));
    fireEvent.click(await screen.findByRole("option", { name: "Priority" }));
    await waitFor(() => {
      expect(visibleTitles()).toEqual(["Beta ticket", "Gamma ticket", "Alpha ticket"]);
    });
  });

  test("orders status groups by Linear workflow type and position", async () => {
    getLinearIssuesMock.mockResolvedValue([
      {
        id: "done",
        identifier: "ENG-5",
        title: "Done issue",
        status: "Done",
        statusType: "completed",
        statusPosition: 0,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "review",
        identifier: "ENG-4",
        title: "Review issue",
        status: "Review",
        statusType: "started",
        statusPosition: 2,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "backlog",
        identifier: "ENG-1",
        title: "Backlog issue",
        status: "Backlog",
        statusType: "backlog",
        statusPosition: 0,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "progress",
        identifier: "ENG-3",
        title: "Progress issue",
        status: "In Progress",
        statusType: "started",
        statusPosition: 1,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "todo",
        identifier: "ENG-2",
        title: "Todo issue",
        status: "Todo",
        statusType: "unstarted",
        statusPosition: 0,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
    ]);

    renderLinearTicketsView();

    await screen.findByText("Backlog issue");
    expect(statusHeadings()).toEqual(["Backlog", "Todo", "In Progress", "Review", "Done"]);
  });

  test("derives status order from every issue so the ticket order cannot reorder sections", async () => {
    // "Todo" exists on two teams with different workflow positions. The first
    // issue in the group changes when the ticket order changes, so section order
    // must be derived from the status name across all issues, not from whichever
    // issue happens to sort first.
    getLinearIssuesMock.mockResolvedValue([
      {
        id: "todo-low",
        identifier: "ENG-1",
        title: "Todo low ticket",
        status: "Todo",
        statusType: "unstarted",
        statusPosition: 0,
        priority: 4,
        priorityLabel: "Low",
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "ready",
        identifier: "OPS-1",
        title: "Ready ticket",
        status: "Ready",
        statusType: "unstarted",
        statusPosition: 1,
        priority: 3,
        priorityLabel: "Medium",
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "todo-urgent",
        identifier: "OPS-2",
        title: "Todo urgent ticket",
        status: "Todo",
        statusType: "unstarted",
        statusPosition: 3,
        priority: 1,
        priorityLabel: "Urgent",
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
    ]);
    const visibleTitles = () =>
      screen.getAllByText(/ ticket$/).map((element) => element.textContent);

    renderLinearTicketsView();

    await screen.findByText("Todo low ticket");
    expect(statusHeadings()).toEqual(["Todo", "Ready"]);
    // The filter chips must agree with the section order.
    expect(statusChips()).toEqual(["Todo2", "Ready1"]);
    expect(visibleTitles()).toEqual(["Todo low ticket", "Todo urgent ticket", "Ready ticket"]);

    fireEvent.click(screen.getByRole("combobox", { name: "Order Linear tickets by" }));
    fireEvent.click(await screen.findByRole("option", { name: "Priority" }));
    await waitFor(() => {
      expect(visibleTitles()).toEqual(["Todo urgent ticket", "Todo low ticket", "Ready ticket"]);
    });
    expect(statusHeadings()).toEqual(["Todo", "Ready"]);
    expect(statusChips()).toEqual(["Todo2", "Ready1"]);
  });

  test("collapses a status name spanning teams to its earliest workflow type", async () => {
    getLinearIssuesMock.mockResolvedValue([
      {
        id: "todo-started",
        identifier: "ENG-1",
        title: "Todo started issue",
        status: "Todo",
        statusType: "started",
        statusPosition: 3,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "doing",
        identifier: "OPS-1",
        title: "Doing issue",
        status: "Doing",
        statusType: "started",
        statusPosition: 0,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "todo-unstarted",
        identifier: "OPS-2",
        title: "Todo unstarted issue",
        status: "Todo",
        statusType: "unstarted",
        statusPosition: 6,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
    ]);

    renderLinearTicketsView();

    // Taking only the first-seen state would rank Todo as "started" at position
    // 3 and sort it after Doing.
    await screen.findByText("Doing issue");
    expect(statusHeadings()).toEqual(["Todo", "Doing"]);
  });

  test("orders statuses with an unknown or missing workflow type last", async () => {
    getLinearIssuesMock.mockResolvedValue([
      {
        id: "mystery",
        identifier: "ENG-1",
        title: "Mystery issue",
        status: "Mystery",
        statusPosition: 0,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "frozen",
        identifier: "ENG-2",
        title: "Frozen issue",
        status: "Frozen",
        statusType: "hibernating",
        statusPosition: 1,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "todo",
        identifier: "ENG-3",
        title: "Todo issue",
        status: "Todo",
        statusType: "unstarted",
        statusPosition: 5,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
    ]);

    renderLinearTicketsView();

    await screen.findByText("Todo issue");
    expect(statusHeadings()).toEqual(["Todo", "Mystery", "Frozen"]);
  });

  test("orders statuses without a position after positioned statuses of the same type", async () => {
    getLinearIssuesMock.mockResolvedValue([
      {
        id: "later",
        identifier: "ENG-1",
        title: "Later issue",
        status: "Later",
        statusType: "unstarted",
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "sooner",
        identifier: "ENG-2",
        title: "Sooner issue",
        status: "Sooner",
        statusType: "unstarted",
        statusPosition: 4,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "anytime",
        identifier: "ENG-3",
        title: "Anytime issue",
        status: "Anytime",
        statusType: "unstarted",
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
    ]);

    renderLinearTicketsView();

    // Positioned states lead; the rest fall back to the status name.
    await screen.findByText("Sooner issue");
    expect(statusHeadings()).toEqual(["Sooner", "Anytime", "Later"]);
  });

  test("ranks a ticket with prioritySortOrder above an equal-priority ticket without one", async () => {
    getLinearIssuesMock.mockResolvedValue([
      {
        id: "issue-without",
        identifier: "ENG-1",
        title: "Without order ticket",
        status: "Todo",
        priority: 2,
        priorityLabel: "High",
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "issue-with",
        identifier: "ENG-2",
        title: "With order ticket",
        status: "Todo",
        priority: 2,
        priorityLabel: "High",
        prioritySortOrder: 7,
        updatedAt: "2026-06-29T12:00:00.000Z",
      },
    ]);
    const visibleTitles = () =>
      screen.getAllByText(/ ticket$/).map((element) => element.textContent);

    renderLinearTicketsView();

    await screen.findByText("Without order ticket");
    expect(visibleTitles()).toEqual(["Without order ticket", "With order ticket"]);

    fireEvent.click(screen.getByRole("combobox", { name: "Order Linear tickets by" }));
    fireEvent.click(await screen.findByRole("option", { name: "Priority" }));
    await waitFor(() => {
      expect(visibleTitles()).toEqual(["With order ticket", "Without order ticket"]);
    });
  });

  test("opens the shared build launcher and starts a configured Linear-backed build", async () => {
    appCommandStore(projectStore).setState({
      projects: [
        {
          id: "project-1",
          name: "Project One",
          gitUrl: "https://example.test/project-one.git",
          localPath: "/work/project-one",
          addedAt: "2026-08-11T00:00:00.000Z",
          order: 0,
        },
      ],
    });
    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));

    expect(await screen.findByText("Build Linear support")).toBeTruthy();
    expect(screen.getAllByText("Grace").length).toBeGreaterThan(0);
    expect(screen.getByText("Integrations")).toBeTruthy();
    expect(screen.getByText("Initial Linear comment")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^build/i }));

    expect(await screen.findByRole("heading", { name: "Configure build" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Where it runs" })).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "Build steps" })).getAllByRole("listitem"),
    ).toHaveLength(8);
    expect(screen.getByRole("combobox", { name: "Build step model" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Reviewer 1 step model" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Reviewer 2 step model" })).toBeTruthy();
    expect(
      screen.getByRole("combobox", {
        name: "Review preparation & consolidation step model",
      }),
    ).toBeTruthy();
    const includeComments = screen.getByRole("checkbox", {
      name: "Include 1 comment in build context",
    }) as HTMLButtonElement;
    expect(includeComments.getAttribute("data-state")).toBe("checked");
    fireEvent.click(includeComments);
    fireEvent.click(screen.getByRole("radio", { name: /^Local/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start build" }));

    await waitFor(() => {
      expect(startBuildFromLinearIssueMock).toHaveBeenCalledWith(
        issueDetail,
        "project-1",
        "local",
        expect.objectContaining({
          includeComments: false,
          deliveryPolicy: "open-pr",
          steps: expect.objectContaining({
            build: expect.objectContaining({
              agent: expect.any(String),
              model: expect.any(String),
            }),
            review: expect.objectContaining({
              agent: expect.any(String),
              model: expect.any(String),
            }),
          }),
          reviewers: expect.arrayContaining([
            expect.objectContaining({ agent: expect.any(String) }),
          ]),
          reviewPreparation: expect.objectContaining({
            agent: expect.any(String),
          }),
        }),
      );
    });
    // A local worktree has no firewall, so the launcher sends no network access.
    const localCall = startBuildFromLinearIssueMock.mock.calls.at(-1) as unknown as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(localCall[3].networkAccessMode).toBeUndefined();
  });

  test("starts a container build with the network access chosen in the launcher", async () => {
    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));
    await screen.findByText("Build Linear support");
    fireEvent.click(screen.getByRole("button", { name: /^build/i }));

    expect(await screen.findByRole("heading", { name: "Configure build" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /^Container/ }));
    fireEvent.click(screen.getByRole("radio", { name: /^Full access/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start build" }));

    await waitFor(() => {
      expect(startBuildFromLinearIssueMock).toHaveBeenCalledWith(
        issueDetail,
        "project-1",
        "containerized",
        expect.objectContaining({ networkAccessMode: "full" }),
      );
    });
  });

  test("redirects an open launcher when a build becomes active in the background", async () => {
    renderLinearTicketsView();
    fireEvent.click(await screen.findByText("Add Linear integration"));
    await screen.findByText("Build Linear support");
    fireEvent.click(screen.getByRole("button", { name: /^build/i }));

    const startButton = (await screen.findByRole("button", {
      name: "Start build",
    })) as HTMLButtonElement;
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
      appCommandStore(buildPipelineStore).getState().replacePipeline(activePipeline);
    });

    await waitFor(() => expect(startButton.disabled).toBe(false));
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(form?.getAttribute("aria-busy")).toBe("false");

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
      expect(postLinearIssueCommentMock).toHaveBeenCalledWith(
        "issue-1",
        "New note from Orkestrator",
        "project-1",
      );
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
      issueId === "issue-2" ? issue2Detail : issueDetail,
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

    await waitFor(() =>
      expect(deleteComposeDraftMock).toHaveBeenCalledWith(
        "linear-comment:project-1:issue-1",
        expect.any(Number),
      ),
    );
    expect((screen.getByLabelText("Add Linear comment") as HTMLTextAreaElement).value).toBe(
      "Keep this second-ticket draft",
    );
    expect(screen.queryByText("Comment for the first ticket") === null).toBe(true);
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
    const submittedDraftDeletesBeforeResolution = deleteComposeDraftMock.mock.calls.filter(
      ([draftKey]) => draftKey === "linear-comment:project-1:issue-1",
    ).length;

    pendingComment.resolve({
      id: "comment-late-same-ticket",
      body: "First submitted comment",
      createdAt: "2026-06-28T12:15:00.000Z",
      authorName: "Ada",
    });

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Linear comment added"));
    expect((screen.getByLabelText("Add Linear comment") as HTMLTextAreaElement).value).toBe(
      "New draft for the same ticket",
    );
    expect(
      deleteComposeDraftMock.mock.calls.filter(
        ([draftKey]) => draftKey === "linear-comment:project-1:issue-1",
      ),
    ).toHaveLength(submittedDraftDeletesBeforeResolution);
  });

  test("restores a persisted Linear comment draft for the selected ticket", async () => {
    getComposeDraftMock.mockImplementation(async (draftKey) =>
      draftKey === "linear-comment:project-1:issue-1"
        ? {
            draftKey,
            ownerType: "project",
            ownerId: "project-1",
            value: "Recovered Linear comment",
            revision: 2,
            updatedAt: "2026-07-28T00:00:00.000Z",
          }
        : null,
    );
    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));

    await waitFor(() =>
      expect((screen.getByLabelText("Add Linear comment") as HTMLTextAreaElement).value).toBe(
        "Recovered Linear comment",
      ),
    );
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
    await waitFor(() =>
      expect(saveComposeDraftMock).toHaveBeenCalledWith(
        "linear-comment:project-1:issue-1",
        "project",
        "project-1",
        "Draft that should survive",
        expect.any(Number),
      ),
    );
  });

  test("puts the Build button in the ticket header beside Open", async () => {
    let resolveDetail: (detail: LinearIssueDetail) => void = () => undefined;
    getLinearIssueMock.mockImplementationOnce(
      () =>
        new Promise<LinearIssueDetail>((resolve) => {
          resolveDetail = resolve;
        }),
    );
    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));

    // The header shows Build while the ticket is still loading, but it cannot
    // launch a build until the details it builds from have arrived.
    const buildButton = await screen.findByRole("button", { name: /^build/i });
    expect((buildButton as HTMLButtonElement).disabled).toBe(true);

    resolveDetail(issueDetail);
    expect(await screen.findByText("Build Linear support")).toBeTruthy();
    await waitFor(() => expect((buildButton as HTMLButtonElement).disabled).toBe(false));

    const openButton = screen.getByRole("button", { name: "Open" });
    expect(openButton.parentElement).toBe(buildButton.parentElement);
    expect(screen.getAllByRole("button", { name: /^build/i })).toHaveLength(1);
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
      issueId === "issue-1" ? firstDetail.promise : secondDetail.promise,
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

    expect(screen.queryByText("Build Linear support") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^build/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Start build" }));
    await waitFor(() => {
      expect(startBuildFromLinearIssueMock).toHaveBeenCalledWith(
        issue2Detail,
        "project-1",
        "containerized",
        expect.objectContaining({
          includeComments: true,
          steps: expect.any(Object),
          reviewers: expect.any(Array),
          reviewPreparation: expect.any(Object),
        }),
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
    expect(screen.queryByText("Connect a Linear workspace before loading tickets.") === null).toBe(
      true,
    );
  });

  test("uses the active Linear pipeline when the same issue has older completed runs", async () => {
    const store = appCommandStore(buildPipelineStore).getState();
    const oldPipelineId = "linear-old";
    store.replacePipeline(
      buildPipelineFixture({
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
      }),
    );

    const activePipelineId = "linear-active";
    store.replacePipeline(
      buildPipelineFixture({
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
      }),
    );

    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));
    expect(await screen.findByText("Build Linear support")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /view build/i }));

    await waitFor(() => {
      expect(navigateToPipelineMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: activePipelineId,
          phase: "building",
          environmentId: "env-active",
        }),
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
    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(
        buildPipelineFixture({
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
        }),
      );

    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));
    expect(await screen.findByText("Linear comment failed: Linear unavailable")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /retry comment/i }));

    await waitFor(() => {
      expect(
        appCommandStore(buildPipelineStore).getState().pipelines.get(pipelineId)
          ?.completionCommentStatus,
      ).toBeUndefined();
    });
  });

  test("keeps Linear completion retries single-flight and recovers after rejection", async () => {
    const pipelineId = "linear-completion-retry";
    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(
        buildPipelineFixture({
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
        }),
      );
    const pending = deferred<Awaited<ReturnType<typeof retryCompletionCommentMock>>>();
    retryCompletionCommentMock.mockImplementationOnce(() => pending.promise);
    renderLinearTicketsView();
    fireEvent.click(await screen.findByText("Add Linear integration"));
    const button = (await screen.findByRole("button", {
      name: /retry comment/i,
    })) as HTMLButtonElement;

    fireEvent.click(button);
    fireEvent.click(button);
    expect(retryCompletionCommentMock).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);

    pending.reject(new Error("still offline"));
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to retry Linear completion comment", {
      description: "still offline",
    });

    fireEvent.click(button);
    await waitFor(() => expect(retryCompletionCommentMock).toHaveBeenCalledTimes(2));
  });

  test("an unlinked project shows the board picker and lists only the board it links", async () => {
    getLinearBoardLinkMock.mockResolvedValue(null);
    renderLinearTicketsView();

    expect(await screen.findByText("Link a Linear board")).toBeTruthy();
    expect(screen.getByText("No Linear board linked")).toBeTruthy();
    expect(getLinearIssuesMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Add Linear integration") === null).toBe(true);

    fireEvent.click(await screen.findByRole("combobox", { name: "Linear team" }));
    fireEvent.click(await screen.findByRole("option", { name: "ENG · Engineering" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Linear project" }));
    fireEvent.click(await screen.findByRole("option", { name: "API" }));
    // The backend answers the new link from now on.
    getLinearBoardLinkMock.mockResolvedValue({ ...boardLink, linearProjectId: "lp-api" });
    fireEvent.click(screen.getByRole("button", { name: /link board/i }));

    await waitFor(() => {
      expect(setLinearBoardLinkMock).toHaveBeenCalledWith("project-1", "team-eng", "lp-api");
      expect(getLinearIssuesMock).toHaveBeenCalledWith("project-1");
    });
    expect(await screen.findByText("Add Linear integration")).toBeTruthy();
  });

  test("shows the refusal when another project already has that board", async () => {
    getLinearBoardLinkMock.mockResolvedValue(null);
    setLinearBoardLinkMock.mockRejectedValueOnce(
      new Error("ENG is already the Linear board of Other project"),
    );
    renderLinearTicketsView();

    fireEvent.click(await screen.findByRole("combobox", { name: "Linear team" }));
    fireEvent.click(await screen.findByRole("option", { name: "ENG · Engineering" }));
    fireEvent.click(screen.getByRole("button", { name: /link board/i }));

    expect(
      await screen.findByText("ENG is already the Linear board of Other project"),
    ).toBeTruthy();
    expect(screen.getByText("Link a Linear board")).toBeTruthy();
  });

  test("a linked project names its board, scopes reads to it, and can unlink it", async () => {
    renderLinearTicketsView();

    expect(await screen.findByText("ENG / Website")).toBeTruthy();
    await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledWith("project-1"));
    fireEvent.click(await screen.findByText("Add Linear integration"));
    await waitFor(() => expect(getLinearIssueMock).toHaveBeenCalledWith("issue-1", "project-1"));
    fireEvent.click(screen.getByRole("button", { name: "Back to Linear tickets" }));

    fireEvent.click(await screen.findByRole("button", { name: "Unlink" }));
    expect(await screen.findByText(/every machine with this repository/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unlink board" }));

    await waitFor(() => expect(clearLinearBoardLinkMock).toHaveBeenCalledWith("project-1"));
    expect(await screen.findByText("Link a Linear board")).toBeTruthy();
  });

  test("Change board preselects the current board and Cancel keeps it", async () => {
    renderLinearTicketsView();

    fireEvent.click(await screen.findByRole("button", { name: "Change board" }));
    expect(await screen.findByText("Change Linear board")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Linear project" }).textContent).toContain(
      "Website",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Add Linear integration")).toBeTruthy();
    expect(setLinearBoardLinkMock).not.toHaveBeenCalled();
  });

  test("a node from before board links lists every issue, as it did", async () => {
    getLinearBoardLinkMock.mockRejectedValue(
      new Error(unknownBackendCommandMessage("get_linear_board_link")),
    );
    renderLinearTicketsView();

    expect(await screen.findByText("Add Linear integration")).toBeTruthy();
    expect(getLinearIssuesMock).toHaveBeenCalledWith(undefined);
    expect(screen.queryByText("Link a Linear board") === null).toBe(true);
  });

  test("offers a connected machine's Linear key on a command node that has none", async () => {
    getLinearConnectionMock.mockResolvedValueOnce({ connected: false, hasToken: false });
    getLinearNodeConnectionsMock.mockResolvedValue([
      {
        nodeId: "node-laptop",
        nodeName: "Laptop",
        connected: true,
        viewerName: "Ada",
        keyFingerprint: "0123456789abcdef",
      },
      { nodeId: "node-ci", nodeName: "CI box", connected: false },
    ]);
    renderLinearTicketsView();

    expect(await screen.findByText("Laptop")).toBeTruthy();
    expect(screen.getByText("(as Ada)")).toBeTruthy();
    expect(screen.queryByText("CI box") === null).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Use the Linear connection from Laptop here" }),
    );

    await waitFor(() => {
      expect(copyLinearConnectionFromNodeMock).toHaveBeenCalledWith("node-laptop");
      expect(toastSuccessMock).toHaveBeenCalledWith("Linear connected");
    });
    expect(await screen.findByText("Add Linear integration")).toBeTruthy();
  });

  test("disconnect says it disconnects every machine with the same key", async () => {
    renderLinearTicketsView();

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/every other machine that holds the same key/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect everywhere" }));

    await waitFor(() => {
      expect(disconnectLinearMock).toHaveBeenCalledTimes(1);
      expect(toastSuccessMock).toHaveBeenCalledWith("Linear disconnected");
    });
  });

  test("after Disconnect everywhere, no machine's revoked key is offered here", async () => {
    renderLinearTicketsView();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    // After the disconnect this node is not connected; the backend reports the
    // leaves that held the revoked key as disconnected until they sync.
    getLinearConnectionMock.mockResolvedValue({ connected: false, hasToken: false });
    getLinearNodeConnectionsMock.mockResolvedValue([
      { nodeId: "node-laptop", nodeName: "Laptop", connected: false },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect everywhere" }));

    await waitFor(() => expect(getLinearNodeConnectionsMock).toHaveBeenCalled());
    await waitFor(() => expect(disconnectLinearMock).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("button", { name: "Use the Linear connection from Laptop here" }) === null,
    ).toBe(true);
    expect(copyLinearConnectionFromNodeMock).not.toHaveBeenCalled();
  });

  describe("board view", () => {
    function openLanesMenu() {
      const trigger = screen.getByRole("button", { name: "Choose board lanes" });
      trigger.focus();
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    }

    test("shows a lane per workflow state, empty ones included, in Linear's order", async () => {
      renderLinearTicketsView();
      expect(await screen.findByText("Add Linear integration")).toBeTruthy();

      fireEvent.click(screen.getByRole("radio", { name: "Board" }));

      const board = await screen.findByTestId("linear-board");
      const lanes = within(board)
        .getAllByRole("region")
        .map((lane) => lane.getAttribute("aria-label"));
      expect(lanes).toEqual(["Backlog lane", "Todo lane", "In Review lane", "Done lane"]);
      const todo = within(board).getByRole("region", { name: "Todo lane" });
      expect(within(todo).getByText("Add Linear integration")).toBeTruthy();
      const review = within(board).getByRole("region", { name: "In Review lane" });
      expect(within(review).getByText("No issues")).toBeTruthy();
      expect(getLinearBoardOptionsMock).toHaveBeenCalledWith("project-1");
    });

    test("hides and shows lanes, and remembers the view and the hidden lanes", async () => {
      const first = renderLinearTicketsView();
      expect(await screen.findByText("Add Linear integration")).toBeTruthy();
      fireEvent.click(screen.getByRole("radio", { name: "Board" }));
      await screen.findByTestId("linear-board");

      openLanesMenu();
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Backlog/ }));
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Done/ }));
      // The menu stays open for several switches; close it before reading the board.
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu") === null).toBe(true));

      await waitFor(() => {
        expect(screen.queryByRole("region", { name: "Backlog lane" }) === null).toBe(true);
        expect(screen.queryByRole("region", { name: "Done lane" }) === null).toBe(true);
      });
      expect(screen.getByRole("region", { name: "Todo lane" })).toBeTruthy();
      expect(
        appCommandStore(linearViewPreferencesStore).getState().projects["project-1"],
      ).toMatchObject({ view: "board", hiddenLanes: ["Backlog", "Done"] });

      // A new mount (switching tabs and back) keeps the board and the hidden lanes.
      first.unmount();
      renderLinearTicketsView();
      expect(await screen.findByRole("region", { name: "Todo lane" })).toBeTruthy();
      expect(screen.queryByRole("region", { name: "Done lane" }) === null).toBe(true);

      openLanesMenu();
      fireEvent.click(await screen.findByRole("menuitem", { name: "Show all lanes" }));
      await waitFor(() => expect(screen.queryByRole("menu") === null).toBe(true));
      expect(await screen.findByRole("region", { name: "Done lane" })).toBeTruthy();
    });

    test("says so when every lane is hidden", async () => {
      appCommandStore(linearViewPreferencesStore).setState({
        projects: {
          "project-1": {
            view: "board",
            hiddenLanes: ["Backlog", "Todo", "In Review", "Done"],
            updatedAt: 1,
          },
        },
      });
      renderLinearTicketsView();

      expect(await screen.findByText("Every lane is hidden")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Show all lanes" }));
      expect(await screen.findByRole("region", { name: "Todo lane" })).toBeTruthy();
    });

    test("opens an issue from its card", async () => {
      renderLinearTicketsView();
      expect(await screen.findByText("Add Linear integration")).toBeTruthy();
      fireEvent.click(screen.getByRole("radio", { name: "Board" }));

      const todo = await screen.findByRole("region", { name: "Todo lane" });
      fireEvent.click(within(todo).getByText("Add Linear integration"));
      await waitFor(() => expect(getLinearIssueMock).toHaveBeenCalled());
      expect(getLinearIssueMock.mock.calls[0]?.[0]).toBe("issue-1");
    });

    test("falls back to lanes from the issues when the board's states cannot be read", async () => {
      getLinearBoardOptionsMock.mockRejectedValue(new Error("unknown command"));
      renderLinearTicketsView();
      expect(await screen.findByText("Add Linear integration")).toBeTruthy();
      fireEvent.click(screen.getByRole("radio", { name: "Board" }));

      const board = await screen.findByTestId("linear-board");
      expect(
        within(board)
          .getAllByRole("region")
          .map((lane) => lane.getAttribute("aria-label")),
        // These issues carry no state type, so the lanes sort by name, as the
        // list's sections do.
      ).toEqual(["Done lane", "Todo lane"]);
    });

    test("dragging a card to another lane moves the issue to that state in Linear", async () => {
      updateLinearIssueMock.mockImplementation(async () => ({
        ...issueDetail,
        status: "In Review",
        statusType: "started",
        statusPosition: 3,
      }));
      renderLinearTicketsView();
      expect(await screen.findByText("Add Linear integration")).toBeTruthy();
      fireEvent.click(screen.getByRole("radio", { name: "Board" }));
      await screen.findByRole("region", { name: "In Review lane" });

      const restore = layOutLinearBoard();
      try {
        await dragLinearCard("Add Linear integration", "In Review");
      } finally {
        restore();
      }

      await waitFor(() => {
        expect(updateLinearIssueMock).toHaveBeenCalledWith("project-1", "issue-1", {
          stateId: "s-review",
        });
        expect(toastSuccessMock).toHaveBeenCalledWith("ENG-123 moved to In Review");
      });
      const review = screen.getByRole("region", { name: "In Review lane" });
      expect(within(review).getByText("Add Linear integration")).toBeTruthy();
      const todo = screen.getByRole("region", { name: "Todo lane" });
      expect(within(todo).queryByText("Add Linear integration") === null).toBe(true);
    });

    async function openBoardAndDrag(title: string, lane: string) {
      const restore = layOutLinearBoard();
      try {
        await dragLinearCard(title, lane);
      } finally {
        restore();
      }
    }

    async function showBoard() {
      renderLinearTicketsView();
      expect(await screen.findByText("Add Linear integration")).toBeTruthy();
      fireEvent.click(screen.getByRole("radio", { name: "Board" }));
      await screen.findByRole("region", { name: "In Review lane" });
    }

    const laneOf = (title: string) =>
      screen.getByText(title).closest("section[aria-label$=' lane']")?.getAttribute("aria-label");

    test("a card cannot be moved again until its move settles", async () => {
      const first = deferred<LinearIssueDetail>();
      updateLinearIssueMock.mockImplementation(() => first.promise);
      await showBoard();

      await openBoardAndDrag("Add Linear integration", "In Review");
      expect(laneOf("Add Linear integration")).toBe("In Review lane");
      // Held mid-move: the card cannot be picked up, while the others can.
      const card = (title: string) =>
        screen.getByText(title).closest("[data-testid='linear-board-card']")!;
      expect(card("Add Linear integration").getAttribute("aria-roledescription")).toBeNull();
      expect(card("Polish dashboard").getAttribute("aria-roledescription")).toBe("draggable");
      expect(updateLinearIssueMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        first.resolve({ ...issueDetail, status: "In Review", statusType: "started" });
        await first.promise;
      });
      expect(laneOf("Add Linear integration")).toBe("In Review lane");
      await waitFor(() =>
        expect(card("Add Linear integration").getAttribute("aria-roledescription")).toBe(
          "draggable",
        ),
      );

      // Settled: it can move again.
      updateLinearIssueMock.mockImplementation(async () => ({
        ...issueDetail,
        status: "Done",
        statusType: "completed",
      }));
      await openBoardAndDrag("Add Linear integration", "Done");
      await waitFor(() => expect(laneOf("Add Linear integration")).toBe("Done lane"));
      expect(updateLinearIssueMock).toHaveBeenCalledTimes(2);
    });

    test("a failed move after a successful one puts the card back where the first left it", async () => {
      updateLinearIssueMock.mockImplementationOnce(async () => ({
        ...issueDetail,
        status: "In Review",
        statusType: "started",
      }));
      await showBoard();
      await openBoardAndDrag("Add Linear integration", "In Review");
      await waitFor(() =>
        expect(toastSuccessMock).toHaveBeenCalledWith("ENG-123 moved to In Review"),
      );

      updateLinearIssueMock.mockImplementationOnce(async () => {
        throw new Error("Linear refused");
      });
      await openBoardAndDrag("Add Linear integration", "Done");
      await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
      expect(laneOf("Add Linear integration")).toBe("In Review lane");
    });

    test("a refresh that lands during a failing move wins over the rollback", async () => {
      const move = deferred<LinearIssueDetail>();
      updateLinearIssueMock.mockImplementation(() => move.promise);
      await showBoard();
      await openBoardAndDrag("Add Linear integration", "In Review");

      // Linear applied the move although its answer will fail; a refresh reads it.
      getLinearIssuesMock.mockResolvedValue([
        { ...issues[0]!, status: "In Review", updatedAt: "2026-06-29T12:00:00.000Z" },
        issues[1]!,
      ]);
      fireEvent.click(screen.getByRole("button", { name: /^Refresh$/ }));
      await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(laneOf("Add Linear integration")).toBe("In Review lane"));

      await act(async () => {
        move.reject(new Error("The connection dropped"));
        await move.promise.catch(() => undefined);
      });
      await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
      expect(laneOf("Add Linear integration")).toBe("In Review lane");
    });

    test("a move's answer does not overwrite a newer read of the issue", async () => {
      const move = deferred<LinearIssueDetail>();
      updateLinearIssueMock.mockImplementation(() => move.promise);
      await showBoard();
      await openBoardAndDrag("Add Linear integration", "In Review");

      // Someone moved it on to Done after this move; a refresh reads that.
      getLinearIssuesMock.mockResolvedValue([
        { ...issues[0]!, status: "Done", updatedAt: "2026-06-30T12:00:00.000Z" },
        issues[1]!,
      ]);
      fireEvent.click(screen.getByRole("button", { name: /^Refresh$/ }));
      await waitFor(() => expect(laneOf("Add Linear integration")).toBe("Done lane"));

      await act(async () => {
        move.resolve({
          ...issueDetail,
          status: "In Review",
          statusType: "started",
          updatedAt: "2026-06-29T12:00:00.000Z",
        });
        await move.promise;
      });
      expect(laneOf("Add Linear integration")).toBe("Done lane");
    });

    test("a move Linear refuses puts the card back and says why", async () => {
      updateLinearIssueMock.mockImplementation(async () => {
        throw new Error("Linear issue ENG-123 is not on this project's Linear board (ENG).");
      });
      renderLinearTicketsView();
      expect(await screen.findByText("Add Linear integration")).toBeTruthy();
      fireEvent.click(screen.getByRole("radio", { name: "Board" }));
      await screen.findByRole("region", { name: "In Review lane" });

      const restore = layOutLinearBoard();
      try {
        await dragLinearCard("Add Linear integration", "In Review");
      } finally {
        restore();
      }

      await waitFor(() =>
        expect(toastErrorMock).toHaveBeenCalledWith("Could not move ENG-123 to In Review", {
          description: "Linear issue ENG-123 is not on this project's Linear board (ENG).",
        }),
      );
      const todo = screen.getByRole("region", { name: "Todo lane" });
      expect(within(todo).getByText("Add Linear integration")).toBeTruthy();
    });
  });
});
