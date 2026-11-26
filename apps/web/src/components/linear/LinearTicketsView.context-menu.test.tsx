/**
 * The Linear tab's right-click menu on a ticket (board card or list row):
 * Open, Build… and Delete…. The board's own menu placement is covered in
 * `LinearIssueBoard.test.tsx`.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import * as realBackend from "@/lib/backend";
import {
  mockToastError as toastErrorMock,
  mockToastSuccess as toastSuccessMock,
} from "../../../../../tests/mocks/sonner";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { projectStore } from "@/stores/projectStore";
import { linearViewPreferencesStore } from "@/stores/linearViewPreferencesStore";
import type {
  LinearBoardLink,
  LinearConnectionStatus,
  LinearIssueDetail,
  LinearIssueListItem,
} from "@/types/linear";
import { appCommandStore } from "@/test/app-command-store";
import { appCommandScope } from "@/lib/node-scope-slots";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { forgetLinearBoardSnapshot } from "./linear-board-refresh";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";

const realBackendSnapshot = { ...realBackend };

const issue = (id: string, identifier: string, title: string): LinearIssueListItem => ({
  id,
  identifier,
  title,
  status: "Todo",
  statusType: "unstarted",
  updatedAt: "2026-06-28T12:00:00.000Z",
  teamKey: "ENG",
});

const issues: LinearIssueListItem[] = [
  issue("issue-a", "ENG-1", "Alpha ticket"),
  issue("issue-b", "ENG-2", "Bravo ticket"),
];

const detailOf = (item: LinearIssueListItem): LinearIssueDetail => ({
  ...item,
  description: "Details",
  labels: [],
  comments: [],
});

const boardLink: LinearBoardLink = {
  key: "repo:github.com/acme/web",
  teamId: "team-eng",
  teamKey: "ENG",
  updatedAt: "2026-11-11T10:00:00.000Z",
};

const connected = async (): Promise<LinearConnectionStatus> => ({
  connected: true,
  hasToken: true,
  viewer: { id: "viewer-1", name: "Ada" },
});
const getLinearIssuesMock = mock(async (_projectId?: string): Promise<LinearIssueListItem[]> => []);
const getLinearIssueMock = mock(async (issueId: string, _projectId?: string) =>
  detailOf(issues.find((item) => item.id === issueId)!),
);
const getLinearBoardLinkMock = mock(async (): Promise<LinearBoardLink | null> => boardLink);
const deleteLinearIssueMock = mock(async (_projectId: string, _issueId: string) => undefined);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getLinearConnection: mock(connected),
  getLinearIssues: getLinearIssuesMock,
  getLinearIssue: getLinearIssueMock,
  getLinearBoardLink: getLinearBoardLinkMock,
  getLinearBoardOptions: mock(async () => ({
    teamId: "team-1",
    states: [{ id: "s-todo", name: "Todo", type: "unstarted", position: 1 }],
  })),
  getLinearIssueFiles: async () => [],
  deleteLinearIssue: deleteLinearIssueMock,
  getLinearNodeConnections: mock(async () => []),
  getComposeDraft: mock(async () => null),
  saveComposeDraft: mock(async () => undefined),
  deleteComposeDraft: mock(async () => undefined),
  getCachedOpenCodeModelCatalog: mock(async () => null),
}));

const { LinearTicketsViewContent } = await import("./LinearTicketsView");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const startBuildFromLinearIssueMock = mock(async () => undefined);

async function showTickets(view: "list" | "board") {
  renderInAppCommandScope(
    <LinearTicketsViewContent
      projectId="project-1"
      buildPipeline={{
        startBuildFromLinearIssue: startBuildFromLinearIssueMock,
        navigateToPipeline: mock(async () => undefined),
      }}
    />,
  );
  expect(await screen.findByText("Alpha ticket")).toBeTruthy();
  if (view === "board") {
    fireEvent.click(screen.getByRole("radio", { name: "Board" }));
    await screen.findByRole("region", { name: "Todo lane" });
  }
}

async function openMenu(title: string) {
  fireEvent.contextMenu(screen.getByText(title));
  return await waitFor(() => {
    const menu = document.querySelector<HTMLElement>('[data-testid="ticket-context-menu"]');
    expect(menu).toBeTruthy();
    return menu!;
  });
}

describe("LinearTicketsView right-click menu", () => {
  beforeEach(() => {
    cleanup();
    forgetLinearBoardSnapshot(appCommandScope());
    getLinearIssuesMock.mockReset();
    getLinearIssuesMock.mockResolvedValue(issues);
    getLinearIssueMock.mockClear();
    getLinearBoardLinkMock.mockReset();
    getLinearBoardLinkMock.mockResolvedValue(boardLink);
    deleteLinearIssueMock.mockReset();
    deleteLinearIssueMock.mockResolvedValue(undefined);
    startBuildFromLinearIssueMock.mockClear();
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    appCommandStore(projectStore).setState({ projects: [] });
    appCommandStore(linearViewPreferencesStore).setState({ projects: {} });
  });

  test("Open on a board card opens the issue", async () => {
    await showTickets("board");
    const menu = await openMenu("Alpha ticket");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open" }));
    expect(await screen.findByRole("button", { name: "Back to Linear tickets" })).toBeTruthy();
    expect(getLinearIssueMock).toHaveBeenCalledWith("issue-a", "project-1");
  });

  test("Delete… on a board card asks, moves the issue to Linear's trash and drops the card", async () => {
    await showTickets("board");
    const menu = await openMenu("Bravo ticket");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete…" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete ENG-2?")).toBeTruthy();
    expect(within(dialog).getByText(/restored in Linear for 30 days/)).toBeTruthy();
    expect(deleteLinearIssueMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete ticket" }));

    await waitFor(() => expect(deleteLinearIssueMock).toHaveBeenCalledWith("project-1", "issue-b"));
    await waitFor(() => expect(screen.queryByText("Bravo ticket") === null).toBe(true));
    expect(screen.getByText("Alpha ticket")).toBeTruthy();
    expect(toastSuccessMock).toHaveBeenCalledWith("ENG-2 moved to Linear's trash");
    await waitFor(() => expect(screen.queryByRole("alertdialog") === null).toBe(true));
  });

  test("a delete Linear refuses keeps the ticket and says why", async () => {
    deleteLinearIssueMock.mockRejectedValue(new Error("Not allowed"));
    await showTickets("list");
    const menu = await openMenu("Alpha ticket");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete ticket" }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Could not delete ENG-1", {
        description: "Not allowed",
      }),
    );
    // The question stays open to try again, and the row is still listed.
    expect(within(screen.getByRole("alertdialog")).getByText("Alpha ticket")).toBeTruthy();
    expect(screen.getAllByText("Alpha ticket")).toHaveLength(2);
  });

  test("a node from before board links offers no Delete", async () => {
    // Its tickets list unscoped, and a delete there could reach any board.
    getLinearBoardLinkMock.mockRejectedValue(
      new Error(unknownBackendCommandMessage("get_linear_board_link")),
    );
    await showTickets("list");
    const menu = await openMenu("Alpha ticket");
    expect(within(menu).getByRole("menuitem", { name: "Open" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: /Delete/ }) === null).toBe(true);
  });

  test("Build… on a list row reads the issue and opens the launcher over the list", async () => {
    await showTickets("list");
    const menu = await openMenu("Alpha ticket");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Build…" }));

    const launcher = await screen.findByRole("dialog");
    expect(getLinearIssueMock).toHaveBeenCalledWith("issue-a", "project-1");
    // The list stays: the issue detail did not open.
    expect(screen.queryByRole("button", { name: "Back to Linear tickets" }) === null).toBe(true);
    fireEvent.click(within(launcher).getByRole("button", { name: /Start build/ }));

    await waitFor(() => expect(startBuildFromLinearIssueMock).toHaveBeenCalledTimes(1));
    const [detail, projectId] = startBuildFromLinearIssueMock.mock.calls[0] as unknown as [
      LinearIssueDetail,
      string,
    ];
    expect(detail.id).toBe("issue-a");
    expect(projectId).toBe("project-1");
  });

  test("Build… is off while the issue's build runs", async () => {
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map([
        [
          "pipeline-1",
          buildPipelineFixture({
            id: "pipeline-1",
            taskId: "linear:issue-a",
            projectId: "project-1",
            phase: "building",
            source: {
              type: "linear",
              issueId: "issue-a",
              issueIdentifier: "ENG-1",
              issueUrl: "https://linear.app/acme/issue/ENG-1",
            },
          }),
        ],
      ]),
      buildEnvironmentIds: new Set(),
    });
    await showTickets("list");
    const menu = await openMenu("Alpha ticket");
    const build = within(menu).getByRole("menuitem", { name: /Build…/ });
    expect(build.hasAttribute("data-disabled")).toBe(true);
    expect(build.textContent).toContain("A build of this ticket is still running");
  });
});
