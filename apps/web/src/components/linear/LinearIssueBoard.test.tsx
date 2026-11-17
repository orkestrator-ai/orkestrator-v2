import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { LinearIssueListItem } from "@/types/linear";
import { LinearIssueBoard, type LinearBoardMove } from "./LinearIssueBoard";
import type { LinearLane } from "./linear-issue-order";
import {
  dragLinearCard,
  dragLinearCardBeside,
  holdLinearCardBeside,
  layOutLinearBoard,
} from "./linear-board-drag-test-support";

const issue = (
  id: string,
  title: string,
  status: string,
  extra: Partial<LinearIssueListItem> = {},
): LinearIssueListItem => ({
  id,
  identifier: id.toUpperCase(),
  title,
  status,
  updatedAt: "2026-11-11T00:00:00Z",
  ...extra,
});

const lanes = (withStates: boolean): LinearLane[] => [
  {
    status: "Todo",
    type: "unstarted",
    ...(withStates ? { stateId: "s-todo" } : {}),
    issues: [issue("eng-1", "Header", "Todo")],
  },
  {
    status: "In Review",
    type: "started",
    ...(withStates ? { stateId: "s-review" } : {}),
    issues: [],
  },
];

let restore: (() => void) | null = null;
// A file run before this one in the same process may leave its last render.
beforeEach(() => cleanup());
afterEach(() => {
  restore?.();
  restore = null;
  cleanup();
});

function renderBoard(options: { withStates?: boolean; onMove?: boolean } = {}) {
  const onMoveIssues = mock((_move: LinearBoardMove) => undefined);
  const onSelectIssue = mock((_id: string) => undefined);
  render(
    <LinearIssueBoard
      lanes={lanes(options.withStates ?? true)}
      hidden={new Set()}
      onShowAll={() => undefined}
      onSelectIssue={onSelectIssue}
      pipelinePhase={() => undefined}
      onMoveIssues={options.onMove === false ? undefined : onMoveIssues}
    />,
  );
  restore = layOutLinearBoard();
  return { onMoveIssues, onSelectIssue };
}

describe("LinearIssueBoard dragging", () => {
  test("a card dropped on another lane asks to move the issue to that lane's state", async () => {
    const { onMoveIssues, onSelectIssue } = renderBoard();
    await dragLinearCard("Header", "In Review");
    expect(onMoveIssues).toHaveBeenCalledTimes(1);
    const [{ issues: moved, to, sortOrders }] = onMoveIssues.mock.calls[0]!;
    expect(moved.map((candidate) => candidate.id)).toEqual(["eng-1"]);
    expect(to).toMatchObject({ status: "In Review", stateId: "s-review" });
    expect(sortOrders.size).toBe(0);
    // The click that ends the drag (sent by `dragLinearCard`) does not open the issue.
    expect(onSelectIssue).not.toHaveBeenCalled();
  });

  test("a card dropped back on its own lane moves nothing", async () => {
    const { onMoveIssues } = renderBoard();
    await dragLinearCard("Header", "Todo");
    expect(onMoveIssues).not.toHaveBeenCalled();
  });

  test("cards do not drag when the board's states are unknown or moves are off", async () => {
    const unknown = renderBoard({ withStates: false });
    await dragLinearCard("Header", "In Review");
    expect(unknown.onMoveIssues).not.toHaveBeenCalled();
    cleanup();
    restore?.();

    renderBoard({ onMove: false });
    const card = screen.getByText("Header").closest("[data-testid='linear-board-card']");
    expect(card?.getAttribute("aria-roledescription")).toBeNull();
  });

  test("a click still opens the issue", () => {
    const { onSelectIssue } = renderBoard();
    fireEvent.click(screen.getByText("Header"));
    expect(onSelectIssue).toHaveBeenCalledWith("eng-1");
  });
});

/** Two lanes in Linear's board order: Todo holds A, B, C; In Review holds X, Y. */
const orderedLanes = (): LinearLane[] => [
  {
    status: "Todo",
    type: "unstarted",
    stateId: "s-todo",
    issues: [
      issue("a", "Alpha", "Todo", { sortOrder: 1 }),
      issue("b", "Bravo", "Todo", { sortOrder: 2 }),
      issue("c", "Charlie", "Todo", { sortOrder: 3 }),
    ],
  },
  {
    status: "In Review",
    type: "started",
    stateId: "s-review",
    issues: [
      issue("x", "X-ray", "In Review", { sortOrder: 10 }),
      issue("y", "Yankee", "In Review", { sortOrder: 20 }),
    ],
  },
];

function renderOrderedBoard(options: { reorderable?: boolean; moving?: ReadonlySet<string> } = {}) {
  const onMoveIssues = mock((_move: LinearBoardMove) => undefined);
  const onSelectIssue = mock((_id: string) => undefined);
  render(
    <LinearIssueBoard
      lanes={orderedLanes()}
      hidden={new Set()}
      onShowAll={() => undefined}
      onSelectIssue={onSelectIssue}
      pipelinePhase={() => undefined}
      onMoveIssues={onMoveIssues}
      reorderable={options.reorderable ?? true}
      {...(options.moving ? { movingIssueIds: options.moving } : {})}
    />,
  );
  restore = layOutLinearBoard();
  return { onMoveIssues, onSelectIssue };
}

/** The one move the board asked for, in a comparable shape. */
function onlyMove(onMoveIssues: ReturnType<typeof renderOrderedBoard>["onMoveIssues"]) {
  expect(onMoveIssues).toHaveBeenCalledTimes(1);
  const [{ issues, to, sortOrders }] = onMoveIssues.mock.calls[0]!;
  return {
    issues: issues.map((candidate) => candidate.id),
    to: to.status,
    sortOrders: Object.fromEntries(sortOrders),
  };
}

const card = (title: string) =>
  screen.getByText(title).closest("[data-testid='linear-board-card']") as HTMLElement;

describe("LinearIssueBoard reordering", () => {
  test("a card dropped above another in its lane takes a place before it", async () => {
    const { onMoveIssues } = renderOrderedBoard();
    await dragLinearCardBeside("Charlie", "Alpha", "before");
    expect(onlyMove(onMoveIssues)).toEqual({ issues: ["c"], to: "Todo", sortOrders: { c: 0 } });
  });

  test("a card dropped below another lands between it and the next", async () => {
    const { onMoveIssues } = renderOrderedBoard();
    await dragLinearCardBeside("Alpha", "Bravo", "after");
    expect(onlyMove(onMoveIssues)).toEqual({ issues: ["a"], to: "Todo", sortOrders: { a: 2.5 } });
  });

  test("a card dropped where it already sits moves nothing", async () => {
    const { onMoveIssues } = renderOrderedBoard();
    await dragLinearCardBeside("Alpha", "Bravo", "before");
    await dragLinearCardBeside("Bravo", "Bravo", "after");
    expect(onMoveIssues).not.toHaveBeenCalled();
  });

  test("a card dropped beside one in another lane changes lane at that place", async () => {
    const { onMoveIssues } = renderOrderedBoard();
    await dragLinearCardBeside("Alpha", "Yankee", "before");
    expect(onlyMove(onMoveIssues)).toEqual({
      issues: ["a"],
      to: "In Review",
      sortOrders: { a: 15 },
    });
  });

  test("a card dropped below a lane's cards goes to its end", async () => {
    const { onMoveIssues } = renderOrderedBoard();
    await dragLinearCard("Alpha", "In Review");
    expect(onlyMove(onMoveIssues)).toEqual({
      issues: ["a"],
      to: "In Review",
      sortOrders: { a: 21 },
    });
  });

  test("while held, a line shows where the card will land", async () => {
    renderOrderedBoard();
    const letGo = await holdLinearCardBeside("Charlie", "Alpha", "before");
    const indicators = screen.getAllByTestId("linear-board-drop-indicator");
    expect(indicators).toHaveLength(1);
    expect(indicators[0]!.getAttribute("data-placement")).toBe("before");
    expect(card("Alpha").parentElement?.contains(indicators[0]!)).toBe(true);
    await letGo();
    expect(screen.queryAllByTestId("linear-board-drop-indicator")).toHaveLength(0);
  });

  test("under another ticket order a drop only changes lane", async () => {
    const { onMoveIssues } = renderOrderedBoard({ reorderable: false });
    await dragLinearCardBeside("Charlie", "Alpha", "before");
    expect(onMoveIssues).not.toHaveBeenCalled();

    const letGo = await holdLinearCardBeside("Alpha", "Yankee", "before");
    expect(screen.queryAllByTestId("linear-board-drop-indicator")).toHaveLength(0);
    await letGo();
    expect(onlyMove(onMoveIssues)).toEqual({ issues: ["a"], to: "In Review", sortOrders: {} });
  });
});

describe("LinearIssueBoard selecting several cards", () => {
  test("Cmd- or Ctrl-click toggles cards without opening them", () => {
    const { onSelectIssue } = renderOrderedBoard();
    fireEvent.click(card("Alpha"), { metaKey: true });
    fireEvent.click(card("Charlie"), { ctrlKey: true });
    expect(onSelectIssue).not.toHaveBeenCalled();
    expect(card("Alpha").getAttribute("data-selected")).toBe("true");
    expect(card("Bravo").getAttribute("data-selected")).toBeNull();
    expect(card("Charlie").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("linear-board-selection").textContent).toContain("2 issues selected");

    fireEvent.click(card("Alpha"), { metaKey: true });
    expect(card("Alpha").getAttribute("data-selected")).toBeNull();
    expect(screen.getByTestId("linear-board-selection").textContent).toContain("1 issue selected");
  });

  test("Shift-click selects the run of cards from the last one picked", () => {
    renderOrderedBoard();
    fireEvent.click(card("Alpha"), { metaKey: true });
    fireEvent.click(card("Charlie"), { shiftKey: true });
    for (const title of ["Alpha", "Bravo", "Charlie"]) {
      expect(card(title).getAttribute("data-selected")).toBe("true");
    }
    expect(card("X-ray").getAttribute("data-selected")).toBeNull();
  });

  test("a plain click opens the issue and clears the selection; so do Escape and Clear", () => {
    const { onSelectIssue } = renderOrderedBoard();
    fireEvent.click(card("Alpha"), { metaKey: true });
    fireEvent.click(card("Bravo"));
    expect(onSelectIssue).toHaveBeenCalledWith("b");
    expect(card("Alpha").getAttribute("data-selected")).toBeNull();

    fireEvent.click(card("Alpha"), { metaKey: true });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(card("Alpha").getAttribute("data-selected")).toBeNull();

    fireEvent.click(card("Alpha"), { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByTestId("linear-board-selection") === null).toBe(true);
  });

  test("dragging a selected card carries the whole selection, in board order", async () => {
    const { onMoveIssues } = renderOrderedBoard();
    fireEvent.click(card("Charlie"), { metaKey: true });
    fireEvent.click(card("Alpha"), { metaKey: true });

    const letGo = await holdLinearCardBeside("Charlie", "Yankee", "before");
    expect(screen.getByTestId("linear-board-drag-count").textContent).toBe("2");
    await letGo();

    expect(onlyMove(onMoveIssues)).toEqual({
      issues: ["a", "c"],
      to: "In Review",
      sortOrders: { a: 10 + 10 / 3, c: 10 + 20 / 3 },
    });
    // The selection is spent once it has moved.
    expect(screen.queryByTestId("linear-board-selection") === null).toBe(true);
  });

  test("selected cards from several lanes all land together", async () => {
    const { onMoveIssues } = renderOrderedBoard();
    fireEvent.click(card("Bravo"), { metaKey: true });
    fireEvent.click(card("X-ray"), { metaKey: true });
    await dragLinearCardBeside("X-ray", "Alpha", "before");
    expect(onlyMove(onMoveIssues)).toEqual({
      issues: ["b", "x"],
      to: "Todo",
      sortOrders: { b: -1, x: 0 },
    });
  });

  test("dragging a card outside the selection moves only that card", async () => {
    const { onMoveIssues } = renderOrderedBoard();
    fireEvent.click(card("Alpha"), { metaKey: true });
    await dragLinearCard("Bravo", "In Review");
    expect(onlyMove(onMoveIssues).issues).toEqual(["b"]);
    expect(card("Alpha").getAttribute("data-selected")).toBeNull();
  });

  test("a card whose move is in flight cannot be selected", () => {
    renderOrderedBoard({ moving: new Set(["a"]) });
    fireEvent.click(card("Alpha"), { metaKey: true });
    expect(card("Alpha").getAttribute("data-selected")).toBeNull();
  });
});

describe("LinearIssueBoard card labels", () => {
  const labelled = (
    id: string,
    title: string,
    issueLabels: LinearIssueListItem["issueLabels"],
  ): LinearIssueListItem => ({ ...issue(id, title, "Todo"), issueLabels });

  function renderCards(issues: LinearIssueListItem[]) {
    render(
      <LinearIssueBoard
        lanes={[{ status: "Todo", type: "unstarted", stateId: "s-todo", issues }]}
        hidden={new Set()}
        onShowAll={() => undefined}
        onSelectIssue={() => undefined}
        pipelinePhase={() => undefined}
      />,
    );
  }

  const cardOf = (title: string) =>
    screen.getByText(title).closest("[data-testid='linear-board-card']") as HTMLElement;

  test("a card shows each label's name in its Linear colour", () => {
    renderCards([
      labelled("eng-1", "Labelled", [
        { id: "l-bug", name: "Bug", color: "#eb5757" },
        { id: "l-ui", name: "Frontend", color: "#4ea7fc" },
      ]),
    ]);
    const chips = Array.from(
      cardOf("Labelled").querySelectorAll("[data-testid='linear-card-label']"),
    );
    expect(chips.map((chip) => chip.textContent)).toEqual(["Bug", "Frontend"]);
    const dots = chips.map(
      (chip) => chip.querySelector("[data-testid='linear-card-label-dot']") as HTMLElement,
    );
    expect(dots[0]!.style.backgroundColor).toBe("#eb5757");
    expect(dots[1]!.style.backgroundColor).toBe("#4ea7fc");
    expect(chips[0]!.getAttribute("title")).toBe("Bug");
  });

  test("a card with no labels shows no label row", () => {
    renderCards([labelled("eng-2", "Plain", []), issue("eng-3", "Older backend", "Todo")]);
    expect(cardOf("Plain").querySelector("[data-testid='linear-card-labels']") === null).toBe(true);
    expect(
      cardOf("Older backend").querySelector("[data-testid='linear-card-labels']") === null,
    ).toBe(true);
  });

  test("a card with many labels names the first four and folds the rest into +N", () => {
    const names = ["Bug", "Frontend", "Backend", "P1", "Design", "merged"];
    renderCards([
      labelled(
        "eng-4",
        "Busy",
        names.map((name, index) => ({ id: `l-${index}`, name, color: "#888888" })),
      ),
    ]);
    const card = cardOf("Busy");
    const chips = Array.from(card.querySelectorAll("[data-testid='linear-card-label']"));
    expect(chips.map((chip) => chip.textContent)).toEqual(["Bug", "Frontend", "Backend", "P1"]);
    const more = card.querySelector("[data-testid='linear-card-labels-more']");
    expect(more?.textContent).toBe("+2");
    expect(more?.getAttribute("title")).toBe("Design, merged");
  });

  test("thirty labels have an accurate overflow count and all remaining names", () => {
    const names = Array.from({ length: 30 }, (_, n) => `Label ${n + 1}`);
    renderCards([
      labelled(
        "eng-30",
        "Thirty labels",
        names.map((name) => ({ name })),
      ),
    ]);
    const more = cardOf("Thirty labels").querySelector("[data-testid='linear-card-labels-more']");
    expect(more?.textContent).toBe("+26");
    expect(more?.getAttribute("title")).toBe(names.slice(4).join(", "));
  });

  test("a label without a usable colour gets the neutral dot, never an arbitrary style", () => {
    renderCards([
      labelled("eng-5", "Odd colours", [
        { name: "No colour" },
        { name: "Injected", color: "red; background: url(x)" },
      ]),
    ]);
    const dots = Array.from(
      cardOf("Odd colours").querySelectorAll("[data-testid='linear-card-label-dot']"),
    ) as HTMLElement[];
    expect(dots.map((dot) => dot.style.backgroundColor)).toEqual(["", ""]);
    expect(dots.every((dot) => dot.className.includes("bg-muted-foreground"))).toBe(true);
  });
});
