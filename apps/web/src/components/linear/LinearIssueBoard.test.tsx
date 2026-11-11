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
