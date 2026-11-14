import { afterEach, describe, expect, test } from "bun:test";

import { isTicketTombstone, type TicketSnapshot } from "@orkestrator/protocol/ticket-sync";

import {
  cleanupFleets,
  COMMAND_ID,
  fleet,
  LEAF_ID,
  type Fleet,
} from "./node-ticket-sync-test-support.js";

/**
 * A ticket's `updatedAt` across machines: a leaf's copy shows the command
 * node's times, a leaf's change comes back with the board's time, and peers
 * that predate `updatedAt` are tolerated (`node-ticket-sync-test-support.ts`).
 */

afterEach(cleanupFleets);

const OLD = "2026-01-01T00:00:00.000Z";

/** The command node's snapshot of one ticket, as it would send it. */
async function snapshotOf(f: Fleet, id: string): Promise<{ epoch: string; item: TicketSnapshot }> {
  const batch = await f.command.ticketSync.ticketSyncChangesSince(
    f.commandProject.id,
    0,
    undefined,
  );
  const item = batch.items.find((candidate) => candidate.id === id);
  if (!item || isTicketTombstone(item)) throw new Error("no snapshot");
  return { epoch: batch.epoch, item };
}

/** Applies hand-made snapshots to the leaf, as an older or newer command node would send them. */
async function applyToLeaf(f: Fleet, epoch: string, items: TicketSnapshot[]): Promise<void> {
  await f.leaf.ticketSync.applyTicketSync({
    controllerId: COMMAND_ID,
    projectId: f.leafProject.id,
    sourceProjectId: f.commandProject.id,
    epoch,
    items,
    cursor: Math.max(...items.map((item) => item.seq)),
  });
}

describe("ticket updatedAt across machines", () => {
  test("a leaf's copy shows the command node's created and updated times", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Ship it", "");
    await f.sync.sync(LEAF_ID);
    expect(await f.leafTicket(ticket.id)).toMatchObject({
      createdAt: ticket.createdAt,
      updatedAt: ticket.createdAt,
    });

    const edited = await f.command.kanban.updateKanbanTask(ticket.id, { status: "review" });
    await f.sync.sync(LEAF_ID);
    expect((await f.leafTicket(ticket.id))?.updatedAt).toBe(edited.updatedAt!);
    expect((await f.leafTicket(ticket.id))?.createdAt).toBe(ticket.createdAt);
  });

  test("a change to only the board's build link still reaches the copy's time", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Build", "");
    await f.sync.sync(LEAF_ID);
    // Seen the old time first, so the next sync must carry a new one.
    const { epoch, item } = await snapshotOf(f, ticket.id);
    await applyToLeaf(f, epoch, [{ ...item, updatedAt: OLD }]);
    expect((await f.leafTicket(ticket.id))?.updatedAt).toBe(OLD);

    const linked = await f.command.kanban.updateKanbanTask(ticket.id, {
      buildPipelineId: "pipeline-1",
    });
    const result = await f.sync.sync(LEAF_ID);
    expect(result.sent).toBeGreaterThan(0);
    expect((await f.leafTicket(ticket.id))?.updatedAt).toBe(linked.updatedAt!);
  });

  test("a leaf's edit refreshes the board's time and the copy then matches it", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Edit me", "");
    await f.sync.sync(LEAF_ID);
    const { epoch, item } = await snapshotOf(f, ticket.id);
    await applyToLeaf(f, epoch, [{ ...item, updatedAt: OLD }]);

    await f.leaf.kanban.updateKanbanTask(ticket.id, { title: "Edited on the leaf" });
    await f.sync.sync(LEAF_ID);
    const board = (await f.commandTicket(ticket.id))!;
    expect(board.title).toBe("Edited on the leaf");
    expect(Date.parse(board.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(ticket.createdAt));
    expect((await f.leafTicket(ticket.id))?.updatedAt).toBe(board.updatedAt!);
  });

  test("a ticket made on the leaf keeps its times on the command node", async () => {
    const f = await fleet();
    await f.sync.sync(LEAF_ID);
    const created = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "From the leaf", "");
    expect(created.updatedAt).toBe(created.createdAt);
    await f.sync.sync(LEAF_ID);
    expect(await f.commandTicket(created.id)).toMatchObject({
      createdAt: created.createdAt,
      updatedAt: created.createdAt,
    });
  });

  test("a leaf's creation without updatedAt uses its creation time", async () => {
    const f = await fleet();
    await f.sync.sync(LEAF_ID);
    const created = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "Older leaf", "");
    // As a leaf that predates `updatedAt` queues it.
    const outbox = await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0);
    const items = outbox.items.map((queued) => {
      if (queued.op.kind !== "create") return queued;
      const { updatedAt: _none, ...ticket } = queued.op.ticket;
      return { ...queued, op: { ...queued.op, ticket } };
    });
    await f.command.ticketSync.applyTicketSyncOps({
      nodeId: LEAF_ID,
      epoch: outbox.epoch,
      items,
    });
    expect((await f.commandTicket(created.id))?.updatedAt).toBe(created.createdAt);
  });

  test("an older command node's snapshot without updatedAt is tolerated", async () => {
    const f = await fleet();
    const existing = await f.command.kanban.addKanbanTask(f.commandProject.id, "Seen", "");
    await f.sync.sync(LEAF_ID);
    const seen = await snapshotOf(f, existing.id);
    await applyToLeaf(f, seen.epoch, [{ ...seen.item, updatedAt: OLD }]);

    const { updatedAt: _a, ...unchanged } = seen.item;
    await applyToLeaf(f, seen.epoch, [{ ...unchanged, seq: unchanged.seq + 1 }]);
    // Nothing on the copy changed: it keeps the time it had.
    expect((await f.leafTicket(existing.id))?.updatedAt).toBe(OLD);

    await applyToLeaf(f, seen.epoch, [
      { ...unchanged, seq: unchanged.seq + 2, title: "Renamed on an older node" },
    ]);
    const renamed = (await f.leafTicket(existing.id))!;
    expect(renamed.title).toBe("Renamed on an older node");
    expect(Date.parse(renamed.updatedAt!)).toBeGreaterThan(Date.parse(OLD));
  });

  test("a new copy from an older command node reads as updated when created", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Older board", "");
    const { epoch, item } = await snapshotOf(f, ticket.id);
    const { updatedAt: _none, ...older } = item;
    await applyToLeaf(f, epoch, [{ ...older, createdAt: OLD }]);
    expect(await f.leafTicket(ticket.id)).toMatchObject({ createdAt: OLD, updatedAt: OLD });
  });
});
