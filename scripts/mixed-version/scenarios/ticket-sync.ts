/**
 * ticket-sync across versions (plan item 1010's pilot): a ticket made on the
 * command node's board reaches the leaf's copy of the project under the same
 * id, a change made on the leaf comes back, and the board reports the leaf in
 * sync. A leaf without ticket sync is reported as needing an update and is
 * sent nothing (the v0 adapter's path).
 */
import { until, type PeerNode } from "../harness.ts";
import { defineScenario } from "../scenario.ts";

type Ticket = { id: string; title: string };
type NodeState = { nodeId: string; state: string; message?: string };

async function tickets(node: PeerNode, projectId: string): Promise<Ticket[]> {
  const answer = await node.invoke<Ticket[] | { tasks?: Ticket[] }>("get_kanban_tasks", {
    projectId,
  });
  return Array.isArray(answer) ? answer : (answer.tasks ?? []);
}

export default defineScenario({
  domain: "ticket-sync",
  title: "Board changes both ways between the command node and a leaf",
  requires: {
    command: ["sync_node_tickets", "get_ticket_sync_status", "add_kanban_task", "get_kanban_tasks"],
    leaf: ["get_kanban_tasks", "update_kanban_task"],
  },
  async run(ctx) {
    const { command, leaf, fixtures } = ctx;
    const board = await fixtures.project(command);
    const copy = await fixtures.project(leaf);
    const syncs =
      leaf.build.kind === "current" ||
      ((leaf.hello.capabilities?.["ticket-sync"] ?? 0) >= 1 && leaf.has("apply_ticket_sync"));
    const marker = `ts-${Date.now().toString(36)}`;
    const created = await command.invoke<Ticket>("add_kanban_task", {
      projectId: board.projectId,
      title: `Made on the command node ${marker}`,
      description: "Mixed-version qualification ticket.",
    });
    const sync = async () =>
      (
        await command.invoke<{ nodes: NodeState[] }>("sync_node_tickets", { nodeId: leaf.id })
      ).nodes.find((entry) => entry.nodeId === leaf.id);
    const first = await sync();
    ctx.note("sync after a ticket on the command node", {
      leafSyncs: syncs,
      state: first?.state,
    });

    if (!syncs) {
      const status = await command.invoke<{ nodes: NodeState[] }>("get_ticket_sync_status", {
        projectId: board.projectId,
      });
      const row = status.nodes.find((entry) => entry.nodeId === leaf.id);
      ctx.check(
        "TS-01",
        "the board reports the older leaf as needing an update",
        row?.state === "update-required" && first?.state === "update-required",
        `${row?.state} / ${first?.state}`,
      );
      ctx.check(
        "TS-02",
        "the older leaf was sent no ticket",
        !(await tickets(leaf, copy.projectId)).some((ticket) => ticket.id === created.id),
      );
      return;
    }

    const arrived = await until(
      "the ticket on the leaf",
      async () => {
        await sync();
        return tickets(leaf, copy.projectId);
      },
      (list) => list.some((ticket) => ticket.id === created.id),
      60_000,
    ).catch(() => [] as Ticket[]);
    ctx.check(
      "TS-01",
      "the leaf's board has the command node's ticket under the same id",
      arrived.some((ticket) => ticket.id === created.id && ticket.title.includes(marker)),
    );

    await leaf.invoke("update_kanban_task", {
      taskId: created.id,
      title: `Edited on the leaf ${marker}`,
    });
    const back = await until(
      "the leaf's change on the command node",
      async () => {
        await sync();
        return tickets(command, board.projectId);
      },
      (list) =>
        list.some((ticket) => ticket.id === created.id && ticket.title.startsWith("Edited")),
      60_000,
    ).catch(() => [] as Ticket[]);
    ctx.check(
      "TS-02",
      "the leaf's change came back to the command node's board (outbox collected)",
      back.some(
        (ticket) => ticket.id === created.id && ticket.title === `Edited on the leaf ${marker}`,
      ),
    );

    const status = await until(
      "the board's sync line",
      async () =>
        (
          await command.invoke<{ nodes: NodeState[] }>("get_ticket_sync_status", {
            projectId: board.projectId,
          })
        ).nodes.find((entry) => entry.nodeId === leaf.id),
      (row) => row?.state === "in-sync",
      30_000,
    ).catch(() => undefined);
    ctx.check("TS-03", "the board reports the leaf in sync", status?.state === "in-sync");

    const expected = ctx.expectedAdapter("ticket-sync");
    const v0 = await ctx.adapterCallsSince("ticket-sync", 0);
    if (expected !== null && v0 !== null) {
      ctx.check(
        "TS-04",
        expected === 0
          ? "the command node synced the pre-contract leaf through the ticket-sync v0 adapter"
          : "the command node used ticket-sync v1 (no v0 adapter call)",
        expected === 0 ? v0 > 0 : v0 === 0,
        `v0 calls ${v0}`,
      );
    }
  },
});
