/**
 * The Linear tab's right-click menu on a ticket (board card or list row):
 * Open, Build… and Delete…. The board's own menu placement is covered in
 * `LinearIssueBoard.test.tsx`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
import type {
  LinearBoardLink,
  LinearConnectionStatus,
  LinearIssueDetail,
  LinearIssueListItem,
} from "@/types/linear";
import { appCommandStore } from "@/test/app-command-store";
import { appCommandScope } from "@/lib/node-scope-slots";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { BackendId } from "@orkestrator/protocol/federation";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { forgetLinearBoardSnapshot, readLinearBoardSnapshot } from "./linear-board-refresh";
import * as buildMachines from "@/components/build/build-machines";
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
const getIssue = async (issueId: string, _projectId?: string) =>
  detailOf(issues.find((item) => item.id === issueId)!);
const getLinearIssueMock = mock(getIssue);
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

async function openDelete(title: string) {
  const menu = await openMenu(title);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete…" }));
  return screen.findByRole("alertdialog");
}

describe("LinearTicketsView right-click menu", () => {
  beforeEach(() => {
    cleanup();
    getWindowScope().select(null);
    forgetLinearBoardSnapshot(appCommandScope());
    getLinearIssuesMock.mockReset();
    getLinearIssuesMock.mockResolvedValue(issues);
    getLinearIssueMock.mockReset();
    getLinearIssueMock.mockImplementation(getIssue);
    getLinearBoardLinkMock.mockReset();
    getLinearBoardLinkMock.mockResolvedValue(boardLink);
    deleteLinearIssueMock.mockReset();
    deleteLinearIssueMock.mockResolvedValue(undefined);
    startBuildFromLinearIssueMock.mockReset();
    startBuildFromLinearIssueMock.mockResolvedValue(undefined);
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    appCommandStore(projectStore).setState({ projects: [] });
    appCommandStore(linearViewPreferencesStore).setState({ projects: {} });
  });

  afterEach(cleanup);

  test("Open on a board card opens the issue", async () => {
    await showTickets("board");
    const menu = await openMenu("Alpha ticket");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open" }));
    expect(await screen.findByRole("button", { name: "Back to Linear tickets" })).toBeTruthy();
    expect(getLinearIssueMock).toHaveBeenCalledWith("issue-a", "project-1");
  });

  test("Delete… on a board card asks, moves the issue to Linear's trash and drops the card", async () => {
    deleteLinearIssueMock.mockImplementation(async () => {
      getLinearIssuesMock.mockResolvedValue([issues[0]!]);
    });
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

  test("reconciles the trashed parent and child and ignores a pre-delete refresh", async () => {
    const child = issue("child", "ENG-3", "Alpha sub-issue");
    const original = [...issues, child];
    const stale = Promise.withResolvers<LinearIssueListItem[]>();
    getLinearIssuesMock.mockResolvedValueOnce(original).mockImplementationOnce(() => stale.promise);
    getLinearIssuesMock.mockResolvedValue([issues[1]!]);
    await showTickets("board");
    await screen.findByText(child.title);
    act(() => {
      getWindowScope().select({
        nodeId: "bk_other" as BackendId,
        projectId: "other",
        environmentId: null,
      });
      getWindowScope().select({
        nodeId: appCommandScope().nodeId,
        projectId: "project-1",
        environmentId: null,
      });
    });
    await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(2));

    const dialog = await openDelete("Alpha ticket");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete ticket" }));
    await waitFor(() => {
      expect(screen.queryByText("Alpha ticket") === null).toBe(true);
      expect(screen.queryByText(child.title) === null).toBe(true);
      expect(readLinearBoardSnapshot(appCommandScope(), "project-1")?.issues).toEqual([issues[1]!]);
    });
    await act(async () => stale.resolve(original));
    expect(screen.getByText("Bravo ticket")).toBeTruthy();
    expect(screen.queryByText("Alpha ticket") === null).toBe(true);
    expect(screen.queryByText(child.title) === null).toBe(true);
    expect(readLinearBoardSnapshot(appCommandScope(), "project-1")?.issues).toEqual([issues[1]!]);
    expect(
      screen.getByRole("button", { name: "Refresh" }).querySelector(".animate-spin") === null,
    ).toBe(true);
  });

  test("deletes the open detail and keeps confirmation modal while the request settles", async () => {
    const pending = Promise.withResolvers<undefined>();
    deleteLinearIssueMock.mockReturnValue(pending.promise);
    await showTickets("list");
    fireEvent.click(screen.getByText("Alpha ticket"));
    await screen.findByText("Details");
    fireEvent.click(screen.getByRole("button", { name: "Delete ticket" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete ticket" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    fireEvent.click(confirm);
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(cancel.hasAttribute("disabled")).toBe(true);
    fireEvent.click(cancel);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    expect(deleteLinearIssueMock).toHaveBeenCalledTimes(1);
    getLinearIssuesMock.mockResolvedValue([issues[1]!]);
    await act(async () => pending.resolve(undefined));
    await screen.findByText("Bravo ticket");
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Back to Linear tickets" }) === null).toBe(true);
    expect(screen.queryByText("Alpha ticket") === null).toBe(true);
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
    expect(within(launcher).getByText("Configure build for Alpha ticket")).toBeTruthy();
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

  test.each(["success", "failure"] as const)(
    "ignores a stale Build detail %s after opening another issue",
    async (outcome) => {
      const pending = Promise.withResolvers<LinearIssueDetail>();
      getLinearIssueMock.mockReturnValueOnce(pending.promise);
      await showTickets("list");
      const menu = await openMenu("Alpha ticket");
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Build…" }));
      expect(await screen.findByText("Loading ticket for build…")).toBeTruthy();
      fireEvent.click(screen.getByText("Bravo ticket"));
      const back = await screen.findByRole("button", { name: "Back to Linear tickets" });
      await act(async () => {
        if (outcome === "success") pending.resolve(detailOf(issues[0]!));
        else pending.reject(new Error("stale load"));
      });
      fireEvent.click(back);
      expect(screen.queryByRole("dialog") === null).toBe(true);
      expect(toastErrorMock).not.toHaveBeenCalled();
      const fresh = await openMenu("Alpha ticket");
      fireEvent.click(within(fresh).getByRole("menuitem", { name: "Build…" }));
      expect(
        await screen.findByRole("dialog", { name: "Configure build for Alpha ticket" }),
      ).toBeTruthy();
    },
  );

  test("indicates a pending detail load and releases the menu when it fails", async () => {
    const pending = Promise.withResolvers<LinearIssueDetail>();
    getLinearIssueMock.mockReturnValueOnce(pending.promise);
    await showTickets("list");
    const first = await openMenu("Alpha ticket");
    fireEvent.click(within(first).getByRole("menuitem", { name: "Build…" }));
    const second = await openMenu("Bravo ticket");
    const build = within(second).getByRole("menuitem", { name: /Build…/ });
    expect(build.hasAttribute("data-disabled")).toBe(true);
    expect(build.textContent).toContain("Loading ENG-1 for build");
    await act(async () => pending.reject(new Error("Detail unavailable")));
    expect(toastErrorMock).toHaveBeenCalledWith("Could not load ENG-1 to build it", {
      description: "Detail unavailable",
    });
    expect(build.hasAttribute("data-disabled")).toBe(false);
    expect(screen.queryByText("Loading ticket for build…") === null).toBe(true);
  });

  test("reports another build is starting only while the launch is pending", async () => {
    const pending = Promise.withResolvers<undefined>();
    startBuildFromLinearIssueMock.mockReturnValue(pending.promise);
    await showTickets("list");
    const first = await openMenu("Alpha ticket");
    fireEvent.click(within(first).getByRole("menuitem", { name: "Build…" }));
    const launcher = await screen.findByRole("dialog");
    fireEvent.click(within(launcher).getByRole("button", { name: /Start build/ }));
    await waitFor(() => expect(startBuildFromLinearIssueMock).toHaveBeenCalledTimes(1));
    const second = await openMenu("Bravo ticket");
    expect(
      within(second).getByRole("menuitem", { name: /Another build is starting/ }),
    ).toBeTruthy();
    await act(async () => pending.resolve(undefined));
  });

  test("waits for build status when another machine cannot be read", async () => {
    const machines = spyOn(buildMachines, "useBuildLaunchMachines").mockReturnValue([
      {
        key: "builder",
        machine: "builder",
        nodeId: "builder",
        name: "Builder",
        projectId: "remote-project",
        current: false,
        available: false,
        hasCheckout: true,
      },
    ]);
    try {
      await showTickets("list");
      const menu = await openMenu("Alpha ticket");
      const build = within(menu).getByRole("menuitem", { name: /Waiting for build status/ });
      expect(build.hasAttribute("data-disabled")).toBe(true);
    } finally {
      cleanup();
      machines.mockRestore();
    }
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
