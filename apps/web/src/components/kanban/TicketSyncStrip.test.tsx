import { afterEach, describe, expect, test, spyOn, mock } from "bun:test";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope, renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { DndContext } from "@dnd-kit/core";
import type { TicketSyncStatusResult } from "@orkestrator/protocol/ticket-sync";
import type { KanbanTask } from "@/stores/kanbanStore";
import { KanbanCard } from "./KanbanCard";
import * as backend from "@/lib/backend";
import { useTicketSyncStatus, TicketSyncStrip } from "./TicketSyncStrip";

afterEach(() => {
  cleanup();
  mock.restore();
});

function status(
  nodes: TicketSyncStatusResult["nodes"],
  conflicts: TicketSyncStatusResult["conflicts"] = [],
) {
  return { projectId: "p1", nodes, conflicts };
}

describe("TicketSyncStrip", () => {
  test("shows nothing for a board no other machine shares, or an older backend", () => {
    const { container } = renderInAppCommandScope(<TicketSyncStrip status={null} />);
    expect(container.textContent).toBe("");
    renderInAppCommandScope(<TicketSyncStrip status={status([])} />);
    expect(screen.queryByTestId("ticket-sync-strip") === null).toBe(true);
  });

  test("names each machine with its state, and counts conflicts", () => {
    renderInAppCommandScope(
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
    renderInAppCommandScope(
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
    renderInAppCommandScope(
      <DndContext>
        <KanbanCard task={task} onClick={() => {}} />
      </DndContext>,
    );
    expect(screen.queryByTestId("kanban-card-runs-on") === null).toBe(true);
  });
});

test("status failure is visible while the last machine state remains readable", () => {
  renderInAppCommandScope(
    <TicketSyncStrip
      status={{
        ...status([{ nodeId: "a", nodeName: "Mini", state: "in-sync", latestSeq: 4, cursor: 4 }]),
        error: "Ticket sync status is unavailable. Retrying…",
      }}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("unavailable");
  expect(screen.getByTestId("ticket-sync-node").textContent).toBe("Mini");
});

for (const missing of [false, true]) {
  test(`status fetch failure; command missing: ${missing}`, async () => {
    spyOn(backend, "getTicketSyncStatus").mockRejectedValue(
      new Error(missing ? "Unknown backend command: get_ticket_sync_status" : "disk failure"),
    );
    const { result } = renderHookInAppCommandScope(() => useTicketSyncStatus("p1", 1));
    if (missing) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(result.current).toBeNull();
    } else await waitFor(() => expect(result.current?.error).toContain("unavailable"));
  });
}

test("a status refresh failure retains the last nodes and recovery clears the error", async () => {
  const read = spyOn(backend, "getTicketSyncStatus").mockResolvedValue(
    status([{ nodeId: "a", nodeName: "Mini", state: "in-sync", latestSeq: 4, cursor: 4 }]),
  );
  const { result, rerender } = renderHookInAppCommandScope(
    ({ revision }) => useTicketSyncStatus("p1", revision),
    {
      initialProps: { revision: 1 },
    },
  );
  await waitFor(() => expect(result.current?.nodes).toHaveLength(1));
  read.mockRejectedValue(new Error("offline"));
  rerender({ revision: 2 });
  await waitFor(() => expect(result.current?.error).toContain("unavailable"));
  expect(result.current?.nodes).toHaveLength(1);
  read.mockResolvedValue(status([]));
  rerender({ revision: 3 });
  await waitFor(() => expect(result.current?.error).toBeUndefined());
});
