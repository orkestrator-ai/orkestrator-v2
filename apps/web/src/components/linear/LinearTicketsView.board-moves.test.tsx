/**
 * The Linear tab's board: reordering cards in Linear's board order and moving
 * several selected cards at once. Single-card lane moves are covered in
 * `LinearTicketsView.test.tsx`.
 */
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
import {
  dragLinearCard,
  dragLinearCardBeside,
  layOutLinearBoard,
} from "./linear-board-drag-test-support";
import type {
  LinearBoardLink,
  LinearBoardOptions,
  LinearConnectionStatus,
  LinearIssueDetail,
  LinearIssueListItem,
} from "@/types/linear";
import { appCommandStore } from "@/test/app-command-store";

const realBackendSnapshot = { ...realBackend };

const issue = (
  id: string,
  identifier: string,
  title: string,
  sortOrder: number,
  status = "Todo",
): LinearIssueListItem => ({
  id,
  identifier,
  title,
  status,
  statusType: status === "Todo" ? "unstarted" : "started",
  sortOrder,
  updatedAt: "2026-06-28T12:00:00.000Z",
  teamKey: "ENG",
});

const issues: LinearIssueListItem[] = [
  issue("issue-a", "ENG-1", "Alpha ticket", 1),
  issue("issue-b", "ENG-2", "Bravo ticket", 2),
  issue("issue-c", "ENG-3", "Charlie ticket", 3),
];

const detailOf = (
  item: LinearIssueListItem,
  fields: Partial<LinearIssueDetail> = {},
): LinearIssueDetail => ({
  ...item,
  description: "",
  labels: [],
  comments: [],
  ...fields,
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
const updateLinearIssueMock = mock(
  async (
    _projectId: string,
    issueId: string,
    _fields: { stateId?: string; sortOrder?: number },
  ): Promise<LinearIssueDetail> => detailOf(issues.find((item) => item.id === issueId)!),
);
const getLinearBoardOptionsMock = mock(async (_projectId: string): Promise<LinearBoardOptions> => ({
  teamId: "team-1",
  states: [
    { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
    { id: "s-review", name: "In Review", type: "started", position: 3 },
  ],
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getLinearConnection: mock(connected),
  getLinearIssues: getLinearIssuesMock,
  getLinearIssue: mock(async (issueId: string) =>
    detailOf(issues.find((item) => item.id === issueId)!),
  ),
  getLinearBoardLink: mock(async () => boardLink),
  getLinearBoardOptions: getLinearBoardOptionsMock,
  updateLinearIssue: updateLinearIssueMock,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function showBoard() {
  renderInAppCommandScope(
    <LinearTicketsViewContent
      projectId="project-1"
      buildPipeline={{
        startBuildFromLinearIssue: mock(async () => undefined),
        navigateToPipeline: mock(async () => undefined),
      }}
    />,
  );
  expect(await screen.findByText("Alpha ticket")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  await screen.findByRole("region", { name: "In Review lane" });
}

/** Runs a drag with the board laid out, as a browser would. */
async function withLayout(drag: () => Promise<void>) {
  const restore = layOutLinearBoard();
  try {
    await drag();
  } finally {
    restore();
  }
}

const titlesIn = (lane: string) =>
  within(screen.getByRole("region", { name: `${lane} lane` }))
    .queryAllByText(/ ticket$/)
    .map((element) => element.textContent);

const card = (title: string) =>
  screen.getByText(title).closest("[data-testid='linear-board-card']") as HTMLElement;

describe("LinearTicketsView board moves", () => {
  beforeEach(() => {
    cleanup();
    getLinearIssuesMock.mockReset();
    getLinearIssuesMock.mockResolvedValue(issues);
    updateLinearIssueMock.mockReset();
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    appCommandStore(projectStore).setState({ projects: [] });
    appCommandStore(linearViewPreferencesStore).setState({ projects: {} });
  });

  test("dropping a card above another reorders it in Linear's board order", async () => {
    const move = deferred<LinearIssueDetail>();
    updateLinearIssueMock.mockImplementation(() => move.promise);
    await showBoard();

    await withLayout(() => dragLinearCardBeside("Charlie ticket", "Alpha ticket", "before"));
    // Shown in its new place before Linear answers.
    expect(titlesIn("Todo")).toEqual(["Charlie ticket", "Alpha ticket", "Bravo ticket"]);
    expect(updateLinearIssueMock).toHaveBeenCalledWith("project-1", "issue-c", { sortOrder: 0 });

    await act(async () => {
      move.resolve(detailOf(issues[2]!, { sortOrder: 0 }));
      await move.promise;
    });
    expect(titlesIn("Todo")).toEqual(["Charlie ticket", "Alpha ticket", "Bravo ticket"]);
    // A reorder is quiet; only a lane change is announced.
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("a reorder Linear refuses puts the card back and says why", async () => {
    updateLinearIssueMock.mockImplementation(async () => {
      throw new Error("Linear refused");
    });
    await showBoard();

    await withLayout(() => dragLinearCardBeside("Alpha ticket", "Bravo ticket", "after"));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Could not reorder ENG-1", {
        description: "Linear refused",
      }),
    );
    expect(titlesIn("Todo")).toEqual(["Alpha ticket", "Bravo ticket", "Charlie ticket"]);
  });

  test("a card dropped beside one in another lane moves state and place in one update", async () => {
    getLinearIssuesMock.mockResolvedValue([
      ...issues,
      issue("issue-x", "ENG-9", "X-ray ticket", 10, "In Review"),
    ]);
    updateLinearIssueMock.mockImplementation(async (_projectId, issueId, fields) =>
      detailOf(
        issues.find((item) => item.id === issueId)!,
        {
          status: "In Review",
          statusType: "started",
          sortOrder: fields.sortOrder,
        },
      ),
    );
    await showBoard();

    await withLayout(() => dragLinearCardBeside("Bravo ticket", "X-ray ticket", "before"));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("ENG-2 moved to In Review"));
    expect(updateLinearIssueMock).toHaveBeenCalledWith("project-1", "issue-b", {
      stateId: "s-review",
      sortOrder: 9,
    });
    expect(titlesIn("In Review")).toEqual(["Bravo ticket", "X-ray ticket"]);
  });

  test("under another ticket order a drop beside a card only changes its lane", async () => {
    getLinearIssuesMock.mockResolvedValue([
      ...issues,
      issue("issue-x", "ENG-9", "X-ray ticket", 10, "In Review"),
    ]);
    updateLinearIssueMock.mockImplementation(async (_projectId, issueId) =>
      detailOf(
        issues.find((item) => item.id === issueId)!,
        {
          status: "In Review",
          statusType: "started",
        },
      ),
    );
    await showBoard();
    fireEvent.click(screen.getByRole("combobox", { name: "Order Linear tickets by" }));
    fireEvent.click(await screen.findByRole("option", { name: "Created date" }));

    await withLayout(() => dragLinearCardBeside("Bravo ticket", "X-ray ticket", "before"));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    expect(updateLinearIssueMock).toHaveBeenCalledWith("project-1", "issue-b", {
      stateId: "s-review",
    });
  });

  test("selected cards move together, and one Linear refuses is put back alone", async () => {
    updateLinearIssueMock.mockImplementation(async (_projectId, issueId) => {
      if (issueId === "issue-c") throw new Error("No access");
      return detailOf(
        issues.find((item) => item.id === issueId)!,
        {
          status: "In Review",
          statusType: "started",
        },
      );
    });
    await showBoard();

    fireEvent.click(card("Alpha ticket"), { metaKey: true });
    fireEvent.click(card("Charlie ticket"), { metaKey: true });
    expect(screen.getByTestId("linear-board-selection").textContent).toContain("2 issues selected");
    await withLayout(() => dragLinearCard("Alpha ticket", "In Review"));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(updateLinearIssueMock).toHaveBeenCalledTimes(2);
    expect(updateLinearIssueMock).toHaveBeenCalledWith("project-1", "issue-a", {
      stateId: "s-review",
    });
    expect(updateLinearIssueMock).toHaveBeenCalledWith("project-1", "issue-c", {
      stateId: "s-review",
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("1 issue moved to In Review");
    expect(toastErrorMock).toHaveBeenCalledWith("Could not move ENG-3 to In Review", {
      description: "No access",
    });
    expect(titlesIn("In Review")).toEqual(["Alpha ticket"]);
    expect(titlesIn("Todo")).toEqual(["Bravo ticket", "Charlie ticket"]);
    expect(screen.queryByTestId("linear-board-selection") === null).toBe(true);
  });
});
