import { useState } from "react";
import {
  LinearIssueBoard,
  type LinearBoardMove,
} from "../../apps/web/src/components/linear/LinearIssueBoard";
import { buildLinearLanes } from "../../apps/web/src/components/linear/linear-issue-order";
import type { LinearIssueListItem } from "../../apps/web/src/types/linear";

const initial: LinearIssueListItem[] = Array.from({ length: 32 }, (_, index) => ({
  id: `card-${index}`,
  identifier: `ENG-${index}`,
  title: `Ticket ${index}`,
  status: "Todo",
  sortOrder: index + 1,
  updatedAt: "2026-11-17T00:00:00Z",
}));
const states = [{ id: "todo", name: "Todo", type: "unstarted", position: 0 }];

/** Real board, real sensor and scroll geometry, local deterministic persistence. */
export function LinearBoardDragFixture() {
  const [issues, setIssues] = useState<LinearIssueListItem[]>(() => {
    const stored = localStorage.getItem("linear-drag-fixture");
    return stored ? JSON.parse(stored) : initial;
  });
  const [lastMove, setLastMove] = useState("");
  const move = ({ sortOrders }: LinearBoardMove) => {
    setLastMove(JSON.stringify(Object.fromEntries(sortOrders)));
    setIssues((current) => {
      const next = current.map((issue) => ({
        ...issue,
        sortOrder: sortOrders.get(issue.id) ?? issue.sortOrder,
      }));
      localStorage.setItem("linear-drag-fixture", JSON.stringify(next));
      return next;
    });
  };
  return (
    <main className="bg-background text-foreground flex flex-col" style={{ height: 560 }}>
      <h1 className="px-6 pt-4 font-semibold">Linear board placement</h1>
      <LinearIssueBoard
        lanes={buildLinearLanes(issues, states, "manual")}
        hidden={new Set()}
        onShowAll={() => undefined}
        onSelectIssue={() => undefined}
        pipelinePhase={() => undefined}
        onMoveIssues={move}
        reorderable
      />
      <output data-testid="last-move">{lastMove}</output>
    </main>
  );
}
