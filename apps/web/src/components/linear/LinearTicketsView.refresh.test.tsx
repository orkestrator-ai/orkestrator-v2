import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { dragLinearCard, layOutLinearBoard } from "./linear-board-drag-test-support";
import * as realConnectDialog from "./LinearConnectDialog";
import * as realBackend from "@/lib/backend";
import { appCommandStore } from "@/test/app-command-store";
import { appCommandScope } from "@/lib/node-scope-slots";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { linearViewPreferencesStore } from "@/stores/linearViewPreferencesStore";
import type { BackendId } from "@orkestrator/protocol/federation";
import type {
  LinearBoardLink,
  LinearBoardOptions,
  LinearConnectionStatus,
  LinearIssueListItem,
} from "@/types/linear";
import {
  LINEAR_FOCUS_REFRESH_INTERVAL_MS,
  forgetLinearBoardSnapshot,
  readLinearBoardSnapshot,
} from "./linear-board-refresh";

// The tab's background refresh: a reopened board paints what it last read at
// once, then reads Linear again and redraws the tickets that changed.

const realConnectDialogSnapshot = { ...realConnectDialog };
mock.module("./LinearConnectDialog", () => ({
  ...realConnectDialogSnapshot,
  LinearConnectDialog: ({
    onConnected,
  }: {
    onConnected: (status: LinearConnectionStatus) => void;
  }) => (
    <button onClick={() => onConnected({ connected: false, hasToken: false })}>
      Test disconnected connection
    </button>
  ),
}));
const clearLinearBoardLinkMock = mock(async (_projectId: string) => undefined);
const updateLinearIssueMock = mock(async () => ({ id: "issue-2", status: "In Review" }));
const realBackendSnapshot = { ...realBackend };

const connected: LinearConnectionStatus = {
  connected: true,
  hasToken: true,
  viewer: { id: "viewer-1", name: "Ada" },
};
const boardLink: LinearBoardLink = {
  key: "repo:github.com/acme/web",
  teamId: "team-eng",
  teamKey: "ENG",
  teamName: "Engineering",
  updatedAt: "2026-11-11T10:00:00.000Z",
};

const getLinearConnectionMock = mock(async (): Promise<LinearConnectionStatus> => connected);
const getLinearIssuesMock = mock(async (_projectId?: string): Promise<LinearIssueListItem[]> => []);
const getLinearBoardLinkMock = mock(async (_projectId: string) => boardLink);
const getLinearBoardOptionsMock = mock(async (_projectId: string): Promise<LinearBoardOptions> => ({
  teamId: "team-eng",
  states: [
    { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
    { id: "s-review", name: "In Review", type: "started", position: 2 },
  ],
}));
const getLinearNodeConnectionsMock = mock(async () => []);
const getComposeDraftMock = mock(async (_draftKey: string) => null);
const getCachedOpenCodeModelCatalogMock = mock(async () => null);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  clearLinearBoardLink: clearLinearBoardLinkMock,
  updateLinearIssue: updateLinearIssueMock,
  getLinearConnection: getLinearConnectionMock,
  getLinearIssues: getLinearIssuesMock,
  getLinearBoardLink: getLinearBoardLinkMock,
  getLinearBoardOptions: getLinearBoardOptionsMock,
  getLinearNodeConnections: getLinearNodeConnectionsMock,
  getLinearTeams: async () => [],
  getComposeDraft: getComposeDraftMock,
  getCachedOpenCodeModelCatalog: getCachedOpenCodeModelCatalogMock,
}));

const { LinearTicketsViewContent } = await import("./LinearTicketsView");

const reviewIssue: LinearIssueListItem = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Record a relationship",
  status: "In Review",
  sortOrder: 1,
  updatedAt: "2026-11-17T10:00:00.000Z",
  issueLabels: [{ id: "l-feature", name: "Feature", color: "#4ea7fc" }],
};
const todoIssue: LinearIssueListItem = {
  id: "issue-2",
  identifier: "ENG-2",
  title: "Book calls",
  status: "Todo",
  sortOrder: 2,
  updatedAt: "2026-11-17T09:00:00.000Z",
};
const mergedReviewIssue: LinearIssueListItem = {
  ...reviewIssue,
  updatedAt: "2026-11-17T11:00:00.000Z",
  issueLabels: [...reviewIssue.issueLabels!, { id: "l-merged", name: "merged", color: "#5e6ad2" }],
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

function view(projectId = "project-1") {
  return (
    <LinearTicketsViewContent
      projectId={projectId}
      buildPipeline={{
        startBuildFromLinearIssue: async () => undefined,
        navigateToPipeline: async () => undefined,
      }}
    />
  );
}

function renderView() {
  return renderInAppCommandScope(view());
}
function returnToNode() {
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
}
function spinning() {
  return screen.getByRole("button", { name: "Refresh" }).querySelector(".animate-spin") !== null;
}

function cardLabels(title: string): string[] {
  const card = screen.getByText(title).closest<HTMLElement>("[data-testid='linear-board-card']");
  if (!card) throw new Error(`No board card for ${title}`);
  return within(card)
    .queryAllByTestId("linear-card-label")
    .map((label) => label.getAttribute("title") ?? "");
}

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("./LinearConnectDialog", () => realConnectDialogSnapshot);
});

describe("LinearTicketsView background refresh", () => {
  beforeEach(() => {
    cleanup();
    forgetLinearBoardSnapshot(appCommandScope());
    getWindowScope().select(null);
    appCommandStore(linearViewPreferencesStore).setState({
      projects: {
        "project-1": { view: "board", hiddenLanes: [], updatedAt: 1 },
      },
    });
    getLinearConnectionMock.mockReset();
    getLinearConnectionMock.mockResolvedValue(connected);
    getLinearIssuesMock.mockReset();
    getLinearIssuesMock.mockResolvedValue([reviewIssue, todoIssue]);
    getLinearBoardLinkMock.mockReset();
    getLinearBoardLinkMock.mockResolvedValue(boardLink);
    clearLinearBoardLinkMock.mockClear();
    updateLinearIssueMock.mockClear();
    getLinearBoardOptionsMock.mockClear();
    getLinearNodeConnectionsMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    getWindowScope().select(null);
  });

  test("a reopened board paints at once, then shows the labels Linear now has", async () => {
    const first = renderView();
    await screen.findByText("Record a relationship");
    expect(cardLabels("Record a relationship")).toEqual(["Feature"]);
    first.unmount();

    // Linear changed while the tab was closed; its answer is still on the way.
    const fresh = deferred<LinearIssueListItem[]>();
    getLinearIssuesMock.mockImplementationOnce(() => fresh.promise);
    renderView();

    // The remembered board is on screen before Linear answers: no spinner panel.
    expect(screen.getByText("Record a relationship")).toBeTruthy();
    expect(screen.getByText("Book calls")).toBeTruthy();
    expect(screen.queryByText(/Loading Linear tickets/i) === null).toBe(true);
    expect(cardLabels("Record a relationship")).toEqual(["Feature"]);
    await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      fresh.resolve([mergedReviewIssue, todoIssue]);
      await fresh.promise;
    });
    await waitFor(() => expect(cardLabels("Record a relationship")).toEqual(["Feature", "merged"]));
    expect(screen.getByText("Book calls")).toBeTruthy();
    await waitFor(() => expect(spinning()).toBe(false));
  });

  test("a failed background read keeps the board instead of an error", async () => {
    const first = renderView();
    await screen.findByText("Record a relationship");
    first.unmount();

    getLinearIssuesMock.mockRejectedValueOnce(new Error("Linear returned HTTP 503"));
    renderView();
    await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Record a relationship")).toBeTruthy();
    expect(screen.queryByText(/Linear returned HTTP 503/) === null).toBe(true);
    expect(spinning()).toBe(false);
  });

  test("a relinked board stays whole on failure and switches identity, tickets and lanes together on success", async () => {
    const first = renderView();
    await screen.findByText(reviewIssue.title);
    first.unmount();
    const next = deferred<LinearIssueListItem[]>();
    const boardB = { ...boardLink, teamId: "team-b", teamKey: "B", teamName: "Board B" };
    getLinearBoardLinkMock.mockResolvedValue(boardB);
    getLinearIssuesMock.mockImplementationOnce(() => next.promise);
    const reopened = renderView();
    await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(2));
    expect(spinning()).toBe(true);
    expect(screen.queryByText("B", { exact: true }) === null).toBe(true);
    expect(screen.getByRole("region", { name: "In Review lane" })).toBeTruthy();
    expect(readLinearBoardSnapshot(appCommandScope(), "project-1")?.boardLink).toEqual(boardLink);
    await act(async () => {
      next.reject(new Error("B unavailable"));
      await next.promise.catch(() => {});
    });
    expect(spinning()).toBe(false);
    reopened.unmount();
    const success = deferred<LinearIssueListItem[]>();
    getLinearIssuesMock.mockImplementationOnce(() => success.promise);
    getLinearBoardOptionsMock.mockResolvedValueOnce({
      teamId: "team-b",
      states: [{ id: "b", name: "Board B lane", type: "started", position: 1 }],
    });
    renderView();
    expect(screen.getByText(reviewIssue.title)).toBeTruthy();
    expect(screen.queryByText("B", { exact: true }) === null).toBe(true);
    expect(screen.getByRole("region", { name: "In Review lane" })).toBeTruthy();
    await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(3));
    await act(async () => {
      success.resolve([{ ...todoIssue, title: "B ticket" }]);
      await success.promise;
    });
    await screen.findByText("B ticket");
    expect(screen.getByText("B", { exact: true })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Board B lane lane" })).toBeTruthy();
    expect(readLinearBoardSnapshot(appCommandScope(), "project-1")?.boardLink).toEqual(boardB);
    expect(screen.queryByText(reviewIssue.title) === null).toBe(true);
    expect(spinning()).toBe(false);
  });

  test("switching projects isolates caches and old pending responses, and shows new-project errors", async () => {
    const mounted = renderView();
    await screen.findByText(reviewIssue.title);
    const old = deferred<LinearIssueListItem[]>();
    getLinearIssuesMock.mockImplementationOnce(() => old.promise);
    returnToNode();
    await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(2));
    getLinearIssuesMock.mockRejectedValueOnce(new Error("Project B unavailable"));
    mounted.rerender(view("project-2"));
    expect(screen.queryByText(reviewIssue.title) === null).toBe(true);
    await screen.findByText("Project B unavailable");
    await act(async () => {
      old.resolve([mergedReviewIssue]);
      await old.promise;
    });
    expect(readLinearBoardSnapshot(appCommandScope(), "project-2")).toBeUndefined();
    expect(readLinearBoardSnapshot(appCommandScope(), "project-1")?.issues).toEqual([
      reviewIssue,
      todoIssue,
    ]);
    expect(screen.queryByText(reviewIssue.title) === null).toBe(true);
    mounted.rerender(view());
    expect(screen.getByText(reviewIssue.title)).toBeTruthy();
  });

  for (const cancellation of ["unlink", "disconnect"] as const) {
    test(`a pending background read clears its spinner on ${cancellation} and cannot restore tickets`, async () => {
      const first = renderView();
      await screen.findByText(reviewIssue.title);
      first.unmount();
      const pending = deferred<LinearIssueListItem[]>();
      getLinearIssuesMock.mockImplementationOnce(() => pending.promise);
      renderView();
      await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(2));
      expect(spinning()).toBe(true);
      if (cancellation === "unlink") {
        fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
        fireEvent.click(screen.getByRole("button", { name: "Unlink board" }));
        await screen.findByText("No Linear board linked");
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Test disconnected connection" }));
        await screen.findByText("Linear is not connected");
      }
      expect(spinning()).toBe(false);
      await act(async () => {
        pending.resolve([mergedReviewIssue]);
        await pending.promise;
      });
      expect(spinning()).toBe(false);
      expect(screen.queryByText(reviewIssue.title) === null).toBe(true);
    });
  }

  for (const settleMoveFirst of [false, true]) {
    test(`a background read cannot undo a ${settleMoveFirst ? "settled" : "pending"} move`, async () => {
      const move = deferred<{ id: string; status: string }>();
      updateLinearIssueMock.mockImplementationOnce(() => move.promise);
      renderView();
      await screen.findByText(todoIssue.title);
      const pending = deferred<LinearIssueListItem[]>();
      getLinearIssuesMock.mockImplementationOnce(() => pending.promise);
      returnToNode();
      await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(2));
      const restore = layOutLinearBoard();
      try {
        await dragLinearCard(todoIssue.title, "In Review");
      } finally {
        restore();
      }
      await waitFor(() => expect(updateLinearIssueMock).toHaveBeenCalledTimes(1));
      if (settleMoveFirst)
        await act(async () => {
          move.resolve({ id: todoIssue.id, status: "In Review" });
          await move.promise;
        });
      await act(async () => {
        pending.resolve([reviewIssue, todoIssue]);
        await pending.promise;
      });
      expect(
        within(screen.getByRole("region", { name: "In Review lane" })).getByText(todoIssue.title),
      ).toBeTruthy();
      expect(spinning()).toBe(false);
      if (!settleMoveFirst)
        await act(async () => {
          move.resolve({ id: todoIssue.id, status: "In Review" });
          await move.promise;
        });
      expect(
        within(screen.getByRole("region", { name: "In Review lane" })).getByText(todoIssue.title),
      ).toBeTruthy();
    });
  }

  test("refreshes when its node is shown again", async () => {
    renderView();
    await screen.findByText("Record a relationship");
    expect(getLinearIssuesMock).toHaveBeenCalledTimes(1);

    getLinearIssuesMock.mockResolvedValue([mergedReviewIssue, todoIssue]);
    const windowScope = getWindowScope();
    act(() => {
      windowScope.select({
        nodeId: "bk_other-node" as BackendId,
        projectId: "remote-project",
        environmentId: null,
      });
    });
    expect(getLinearIssuesMock).toHaveBeenCalledTimes(1);

    act(() => {
      windowScope.select({
        nodeId: appCommandScope().nodeId,
        projectId: "project-1",
        environmentId: null,
      });
    });
    await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(cardLabels("Record a relationship")).toEqual(["Feature", "merged"]));
  });

  test("refreshes when the window regains focus", async () => {
    const now = spyOn(Date, "now");
    let clock = 5_000_000;
    now.mockImplementation(() => clock);
    try {
      renderView();
      await screen.findByText("Record a relationship");
      expect(getLinearIssuesMock).toHaveBeenCalledTimes(1);

      getLinearIssuesMock.mockResolvedValue([mergedReviewIssue, todoIssue]);
      clock += LINEAR_FOCUS_REFRESH_INTERVAL_MS;
      act(() => {
        fireEvent.focus(window);
      });
      await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(cardLabels("Record a relationship")).toEqual(["Feature", "merged"]),
      );
    } finally {
      now.mockRestore();
    }
  });
});
