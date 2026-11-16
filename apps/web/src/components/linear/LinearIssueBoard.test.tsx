import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { LinearIssueListItem } from "@/types/linear";
import { LinearIssueBoard } from "./LinearIssueBoard";
import type { LinearLane } from "./linear-issue-order";
import { dragLinearCard, layOutLinearBoard } from "./linear-board-drag-test-support";

const issue = (id: string, title: string, status: string): LinearIssueListItem => ({
  id,
  identifier: id.toUpperCase(),
  title,
  status,
  updatedAt: "2026-11-11T00:00:00Z",
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
  const onMoveIssue = mock((_issue: LinearIssueListItem, _to: LinearLane) => undefined);
  const onSelectIssue = mock((_id: string) => undefined);
  render(
    <LinearIssueBoard
      lanes={lanes(options.withStates ?? true)}
      hidden={new Set()}
      onShowAll={() => undefined}
      onSelectIssue={onSelectIssue}
      pipelinePhase={() => undefined}
      onMoveIssue={options.onMove === false ? undefined : onMoveIssue}
    />,
  );
  restore = layOutLinearBoard();
  return { onMoveIssue, onSelectIssue };
}

describe("LinearIssueBoard dragging", () => {
  test("a card dropped on another lane asks to move the issue to that lane's state", async () => {
    const { onMoveIssue, onSelectIssue } = renderBoard();
    await dragLinearCard("Header", "In Review");
    expect(onMoveIssue).toHaveBeenCalledTimes(1);
    const [moved, to] = onMoveIssue.mock.calls[0]!;
    expect(moved.id).toBe("eng-1");
    expect(to).toMatchObject({ status: "In Review", stateId: "s-review" });
    // The click that ends the drag (sent by `dragLinearCard`) does not open the issue.
    expect(onSelectIssue).not.toHaveBeenCalled();
  });

  test("a card dropped back on its own lane moves nothing", async () => {
    const { onMoveIssue } = renderBoard();
    await dragLinearCard("Header", "Todo");
    expect(onMoveIssue).not.toHaveBeenCalled();
  });

  test("cards do not drag when the board's states are unknown or moves are off", async () => {
    const unknown = renderBoard({ withStates: false });
    await dragLinearCard("Header", "In Review");
    expect(unknown.onMoveIssue).not.toHaveBeenCalled();
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
