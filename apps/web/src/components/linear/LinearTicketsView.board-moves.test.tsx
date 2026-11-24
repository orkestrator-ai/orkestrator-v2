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
  getLinearIssueFiles: async () => [],
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
      sortOrder: 1,
    });
    expect(updateLinearIssueMock).toHaveBeenCalledWith("project-1", "issue-c", {
      stateId: "s-review",
      sortOrder: 2,
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("1 issue moved to In Review");
    expect(toastErrorMock).toHaveBeenCalledWith("Could not move ENG-3 to In Review", {
      description: "No access",
    });
    expect(titlesIn("In Review")).toEqual(["Alpha ticket"]);
    expect(titlesIn("Todo")).toEqual(["Bravo ticket", "Charlie ticket"]);
    expect(screen.queryByTestId("linear-board-selection") === null).toBe(true);
  });

  for (const middle of [1, 1 + Number.EPSILON]) {
    test(`persists the rendered reorder when neighbours have positions 1 and ${middle}`, async () => {
      const stored = issues.map((item, index) => ({ ...item, sortOrder: [1, middle, 2][index]! }));
      getLinearIssuesMock.mockImplementation(async () => stored.map((item) => ({ ...item })));
      updateLinearIssueMock.mockImplementation(async (_projectId, id, fields) => {
        const item = stored.find((candidate) => candidate.id === id)!;
        Object.assign(item, fields);
        return detailOf(item);
      });
      await showBoard();
      await withLayout(() => dragLinearCardBeside("Charlie ticket", "Bravo ticket", "before"));
      await waitFor(() => expect(updateLinearIssueMock).toHaveBeenCalledTimes(3));
      expect(titlesIn("Todo")).toEqual(["Alpha ticket", "Charlie ticket", "Bravo ticket"]);
      fireEvent.click(screen.getByRole("button", { name: /^Refresh$/ }));
      await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(2));
      expect(titlesIn("Todo")).toEqual(["Alpha ticket", "Charlie ticket", "Bravo ticket"]);
    });
  }

  test("mixed source lanes keep carried order in an empty lane through out-of-order answers and reload", async () => {
    const stored = [
      { ...issues[0]!, sortOrder: 20 },
      { ...issues[1]!, status: "In Review", sortOrder: 1 },
    ];
    getLinearIssuesMock.mockImplementation(async () => stored.map((item) => ({ ...item })));
    getLinearBoardOptionsMock.mockResolvedValueOnce({
      teamId: "team-1",
      states: [
        { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
        { id: "s-review", name: "In Review", type: "started", position: 2 },
        { id: "s-done", name: "Done", type: "completed", position: 3 },
      ],
    });
    const pending = stored.map(() => deferred<LinearIssueDetail>());
    updateLinearIssueMock.mockImplementation(
      (_projectId, id) => pending[stored.findIndex((item) => item.id === id)]!.promise,
    );
    await showBoard();
    fireEvent.click(card("Alpha ticket"), { metaKey: true });
    fireEvent.click(card("Bravo ticket"), { metaKey: true });
    await withLayout(() => dragLinearCard("Alpha ticket", "Done"));
    expect(titlesIn("Done")).toEqual(["Alpha ticket", "Bravo ticket"]);
    for (const index of [1, 0]) {
      Object.assign(stored[index]!, { status: "Done", sortOrder: index + 1 });
      await act(async () => {
        pending[index]!.resolve(detailOf(stored[index]!));
        await pending[index]!.promise;
      });
      expect(titlesIn("Done")).toEqual(["Alpha ticket", "Bravo ticket"]);
    }
    fireEvent.click(screen.getByRole("button", { name: /^Refresh$/ }));
    await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(2));
    expect(titlesIn("Done")).toEqual(["Alpha ticket", "Bravo ticket"]);
  });

  test("seven selected cards stay locked through a four-worker queue with out-of-order failures", async () => {
    const items = [
      issues[0]!,
      ...Array.from({ length: 6 }, (_, i) =>
        issue(`bulk-${i}`, `ENG-${i + 2}`, `Bulk ${i} ticket`, i + 2),
      ),
    ];
    const pending = items.map(() => deferred<LinearIssueDetail>());
    let active = 0;
    let peak = 0;
    getLinearIssuesMock.mockResolvedValue(items);
    updateLinearIssueMock.mockImplementation(async (_projectId, id) => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await pending[items.findIndex((item) => item.id === id)]!.promise;
      } finally {
        active--;
      }
    });
    await showBoard();
    for (const item of items) fireEvent.click(card(item.title), { metaKey: true });
    await withLayout(() => dragLinearCard("Alpha ticket", "In Review"));
    expect(updateLinearIssueMock).toHaveBeenCalledTimes(4);
    for (const item of items)
      expect(card(item.title).getAttribute("aria-roledescription")).toBeNull();
    const settled = new Set<number>();
    for (const index of [2, 0, 3, 5, 1, 6, 4]) {
      await act(async () => {
        if (index === 2 || index === 5) pending[index]!.reject(new Error("No access"));
        else
          pending[index]!.resolve(
            detailOf(items[index]!, { status: "In Review", sortOrder: index + 1 }),
          );
        await pending[index]!.promise.catch(() => undefined);
      });
      expect(card(items[index]!.title).getAttribute("aria-roledescription")).toBe("draggable");
      settled.add(index);
      for (const [id, item] of items.entries()) {
        if (!settled.has(id)) {
          expect(card(item.title).getAttribute("aria-roledescription")).toBeNull();
        }
      }
    }
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(updateLinearIssueMock).toHaveBeenCalledTimes(7);
    expect(titlesIn("Todo")).toEqual(["Bulk 1 ticket", "Bulk 4 ticket"]);
    expect(titlesIn("In Review")).toHaveLength(5);
    expect(toastSuccessMock).toHaveBeenCalledWith("5 issues moved to In Review");
    expect(toastErrorMock).toHaveBeenCalledWith("Could not move ENG-3, ENG-6 to In Review", {
      description: "No access",
    });
  });

  test("a newer list reload wins over a failed move rollback", async () => {
    const pending = deferred<LinearIssueDetail>();
    updateLinearIssueMock.mockImplementation(() => pending.promise);
    await showBoard();
    await withLayout(() => dragLinearCard("Alpha ticket", "In Review"));
    getLinearIssuesMock.mockResolvedValue(
      issues.map((item) =>
        item.id === "issue-a"
          ? { ...item, status: "In Review", sortOrder: 1, updatedAt: "2026-11-17T12:00:00Z" }
          : item,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Refresh$/ }));
    await waitFor(() => expect(getLinearIssuesMock).toHaveBeenCalledTimes(2));
    expect(titlesIn("In Review")).toEqual(["Alpha ticket"]);
    await act(async () => {
      pending.reject(new Error("Answer lost"));
      await pending.promise.catch(() => undefined);
    });
    expect(titlesIn("In Review")).toEqual(["Alpha ticket"]);
    expect(card("Alpha ticket").getAttribute("aria-roledescription")).toBe("draggable");
    expect(toastErrorMock).toHaveBeenCalled();
  });
});
