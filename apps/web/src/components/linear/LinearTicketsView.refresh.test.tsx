import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
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
} from "./linear-board-refresh";

// The tab's background refresh: a reopened board paints what it last read at
// once, then reads Linear again and redraws the tickets that changed.

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
  getLinearConnection: getLinearConnectionMock,
  getLinearIssues: getLinearIssuesMock,
  getLinearBoardLink: getLinearBoardLinkMock,
  getLinearBoardOptions: getLinearBoardOptionsMock,
  getLinearNodeConnections: getLinearNodeConnectionsMock,
  getComposeDraft: getComposeDraftMock,
  getCachedOpenCodeModelCatalog: getCachedOpenCodeModelCatalogMock,
}));

const { LinearTicketsViewContent } = await import("./LinearTicketsView");

const reviewIssue: LinearIssueListItem = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Record a relationship",
  status: "In Review",
  updatedAt: "2026-11-17T10:00:00.000Z",
  issueLabels: [{ id: "l-feature", name: "Feature", color: "#4ea7fc" }],
};
const todoIssue: LinearIssueListItem = {
  id: "issue-2",
  identifier: "ENG-2",
  title: "Book calls",
  status: "Todo",
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

function renderView() {
  return renderInAppCommandScope(
    <LinearTicketsViewContent
      projectId="project-1"
      buildPipeline={{
        startBuildFromLinearIssue: async () => undefined,
        navigateToPipeline: async () => undefined,
      }}
    />,
  );
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
    getLinearBoardLinkMock.mockClear();
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
  });

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
