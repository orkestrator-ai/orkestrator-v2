import { afterEach, describe, expect, test, spyOn, mock } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope, renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { DndContext } from "@dnd-kit/core";
import type { TicketSyncStatusResult } from "@orkestrator/protocol/ticket-sync";
import type { KanbanTask } from "@/stores/kanbanStore";
import { KanbanCard } from "./KanbanCard";
import * as backend from "@/lib/backend";
import { useTicketSyncLeafStatus, useTicketSyncStatus, TicketSyncStrip } from "./TicketSyncStrip";

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

describe("the conflict list (to-do 3800 task 4)", () => {
  const conflict = (id: string, ticketId: string, value: string) => ({
    id,
    at: "2026-11-09T10:00:00.000Z",
    ticketId,
    projectId: "p1",
    fromNodeId: "b",
    fromNodeName: "VPS",
    field: "title" as const,
    reason: "stale-revision" as const,
    value,
  });

  test("opens from the sync line, opens a ticket and dismisses one or all", async () => {
    const opened: string[] = [];
    const dismissed: Array<string[] | undefined> = [];
    renderInAppCommandScope(
      <TicketSyncStrip
        status={{
          ...status(
            [{ nodeId: "b", nodeName: "VPS", state: "in-sync", latestSeq: 4, cursor: 4 }],
            [conflict("c1", "t1", "Leaf title"), conflict("c2", "gone", "Other")],
          ),
          conflictCount: 7,
        }}
        ticketTitles={new Map([["t1", "Fix the parser"]])}
        onOpenTicket={(id) => opened.push(id)}
        onDismissConflicts={async (ids) => {
          dismissed.push(ids);
        }}
      />,
    );
    const trigger = screen.getByTestId("ticket-sync-conflicts");
    expect(trigger.textContent).toBe("7 sync conflicts");
    fireEvent.click(trigger);
    const rows = await screen.findAllByTestId("ticket-sync-conflict");
    // Newest first; a ticket no longer on the board cannot be opened.
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("A deleted ticket"),
      expect.stringContaining("Fix the parser"),
    ]);
    expect(rows[1]!.textContent).toContain("Their version: Leaf title");
    expect(screen.getByText("Showing the latest 2 of 7.")).toBeTruthy();
    const dismissButtons = screen.getAllByRole("button", { name: "Dismiss" });
    fireEvent.click(dismissButtons[1]!);
    await waitFor(() => expect(dismissed).toEqual([["c1"]]));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
    await waitFor(() => expect(dismissed).toEqual([["c1"], undefined]));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(opened).toEqual(["t1"]);
  });
});

describe("a leaf board's sync line (to-do 3800 tasks 2, 4 and 5)", () => {
  const leaf = {
    projectId: "p1",
    controllers: [
      {
        controllerId: "bk_command",
        nodeName: "Studio",
        sourceProjectId: "p-command",
        pending: 2,
      },
    ],
    unshared: 3,
  };

  test("names the command node and offers Share for older tickets", async () => {
    let shares = 0;
    renderInAppCommandScope(
      <TicketSyncStrip
        status={status([])}
        leafStatus={leaf}
        onShareAll={async () => {
          shares += 1;
        }}
      />,
    );
    expect(screen.getByTestId("ticket-sync-leaf").textContent).toContain(
      "Tickets synced from Studio· 2 changes waiting",
    );
    fireEvent.click(screen.getByRole("button", { name: "Share 3 older tickets with Studio" }));
    await waitFor(() => expect(shares).toBe(1));
  });

  test("on a second copy of the repository, says which copy syncs", () => {
    renderInAppCommandScope(
      <TicketSyncStrip
        status={null}
        leafStatus={{
          projectId: "p2",
          controllers: [],
          unshared: 0,
          syncedCopy: { projectId: "p1", projectName: "repo", nodeName: "Studio" },
        }}
      />,
    );
    expect(screen.getByTestId("ticket-sync-other-copy").textContent).toBe(
      "This board is not synced: repo is this machine's copy of the repository that syncs with Studio.",
    );
    expect(screen.queryByRole("button") === null).toBe(true);
  });

  test("the command node's line says which copy on a leaf syncs", () => {
    renderInAppCommandScope(
      <TicketSyncStrip
        status={status([
          {
            nodeId: "b",
            nodeName: "VPS",
            state: "in-sync",
            latestSeq: 4,
            cursor: 4,
            projectName: "repo",
            otherCopies: 1,
          },
        ])}
      />,
    );
    expect(screen.getByTestId("ticket-sync-node").title).toBe(
      "VPS has every ticket on this board. It syncs with its project repo. Its other copy of this repository keeps its own board.",
    );
  });

  test("the hook reads the leaf status, and is empty on a board no command node syncs", async () => {
    const read = spyOn(backend, "getTicketSyncLeafStatus").mockResolvedValue(leaf);
    const { result, rerender } = renderHookInAppCommandScope(
      ({ revision }) => useTicketSyncLeafStatus("p1", revision),
      { initialProps: { revision: 1 } },
    );
    await waitFor(() => expect(result.current?.controllers).toHaveLength(1));
    read.mockResolvedValue({ projectId: "p1", controllers: [], unshared: 0 });
    rerender({ revision: 2 });
    await waitFor(() => expect(result.current).toBeNull());
  });
});

describe("KanbanCard on a leaf board (to-do 3800 tasks 2 and 4)", () => {
  const task: KanbanTask = {
    id: "t2",
    projectId: "p1",
    title: "Copied ticket",
    description: "",
    acceptanceCriteria: "",
    status: "backlog",
    comments: [],
    images: [],
    createdAt: "2026-11-09T10:00:00.000Z",
    order: 0,
  };
  const replica = {
    seq: 0,
    revs: {},
    replica: { controllerId: "bk_command", sourceProjectId: "p-command", seq: 3, revs: {} },
  };

  test("a copy is marked with the command node it comes from", () => {
    renderInAppCommandScope(
      <DndContext>
        <KanbanCard task={{ ...task, sync: replica }} syncedFrom="Studio" onClick={() => {}} />
      </DndContext>,
    );
    const mark = screen.getByTestId("kanban-card-synced-from");
    expect(mark.textContent).toBe("Studio");
    expect(mark.title).toContain("A copy of a ticket on Studio's board");
  });

  test("a ticket still waiting for the command node, or made here, has no mark", () => {
    renderInAppCommandScope(
      <DndContext>
        <KanbanCard
          task={{
            ...task,
            sync: { ...replica, replica: { ...replica.replica, pendingCreate: true } },
          }}
          syncedFrom="Studio"
          onClick={() => {}}
        />
        <KanbanCard task={{ ...task, id: "t3" }} syncedFrom="Studio" onClick={() => {}} />
      </DndContext>,
    );
    expect(screen.queryByTestId("kanban-card-synced-from") === null).toBe(true);
  });
});
