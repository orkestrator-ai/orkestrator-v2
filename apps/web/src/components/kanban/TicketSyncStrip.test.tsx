import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import type { TicketSyncStatusResult } from "@orkestrator/protocol/ticket-sync";
import type { KanbanTask } from "@/stores/kanbanStore";
import { KanbanCard } from "./KanbanCard";
import { TicketSyncStrip } from "./TicketSyncStrip";

afterEach(() => cleanup());

function status(
  nodes: TicketSyncStatusResult["nodes"],
  conflicts: TicketSyncStatusResult["conflicts"] = [],
) {
  return { projectId: "p1", nodes, conflicts };
}

describe("TicketSyncStrip", () => {
  test("shows nothing for a board no other machine shares, or an older backend", () => {
    const { container } = render(<TicketSyncStrip status={null} />);
    expect(container.textContent).toBe("");
    render(<TicketSyncStrip status={status([])} />);
    expect(screen.queryByTestId("ticket-sync-strip")).toBeNull();
  });

  test("names each machine with its state, and counts conflicts", () => {
    render(
      <TicketSyncStrip
        status={status(
          [
            { nodeId: "a", nodeName: "Mini", state: "in-sync", latestSeq: 4, cursor: 4 },
            {
              nodeId: "b",
              nodeName: "VPS",
              state: "offline",
              latestSeq: 4,
              cursor: 2,
              message:
                "VPS is not connected. Ticket changes wait here and reach it when it reconnects.",
            },
            {
              nodeId: "c",
              nodeName: "Old box",
              state: "update-required",
              latestSeq: 4,
              cursor: 0,
              message: "Old box runs an older Orkestrator that cannot sync tickets.",
            },
          ],
          [
            {
              at: "2026-11-03T10:00:00.000Z",
              ticketId: "t1",
              projectId: "p1",
              fromNodeId: "b",
              fromNodeName: "VPS",
              field: "title",
              reason: "stale-revision",
              value: "Leaf title",
            },
          ],
        )}
      />,
    );
    const nodes = screen.getAllByTestId("ticket-sync-node");
    expect(nodes.map((node) => [node.textContent, node.dataset.state])).toEqual([
      ["Mini", "in-sync"],
      ["VPS· offline", "offline"],
      ["Old box· update needed", "update-required"],
    ]);
    expect(nodes[1]!.title).toContain("reach it when it reconnects");
    expect(screen.getByTestId("ticket-sync-conflicts").textContent).toBe("1 sync conflict");
  });
});

describe("KanbanCard on another machine", () => {
  const task: KanbanTask = {
    id: "t1",
    projectId: "p1",
    title: "Fix the parser",
    description: "",
    acceptanceCriteria: "",
    status: "in-progress",
    comments: [],
    images: [],
    createdAt: "2026-11-03T10:00:00.000Z",
    order: 0,
  };

  test("says which machine its build runs on", () => {
    render(
      <DndContext>
        <KanbanCard
          task={{
            ...task,
            sync: {
              seq: 3,
              revs: {},
              work: {
                nodeId: "b",
                nodeName: "Build box",
                buildPipelineId: "pipeline-1",
                updatedAt: "2026-11-03T10:00:00.000Z",
              },
            },
          }}
          onClick={() => {}}
        />
      </DndContext>,
    );
    const chip = screen.getByTestId("kanban-card-runs-on");
    expect(chip.textContent).toBe("Build box");
    expect(chip.title).toBe("Its build runs on Build box");
  });

  test("shows no machine for local work", () => {
    render(
      <DndContext>
        <KanbanCard task={task} onClick={() => {}} />
      </DndContext>,
    );
    expect(screen.queryByTestId("kanban-card-runs-on")).toBeNull();
  });
});
