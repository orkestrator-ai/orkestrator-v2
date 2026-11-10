import { afterEach, describe, expect, test } from "bun:test";

import {
  TICKET_SYNC_LIMITS,
  TICKET_SYNC_OUTBOX_READY_EVENT,
} from "@orkestrator/protocol/ticket-sync";

import { seedStore, readStoredValue } from "../storage-test-support.js";
import { emptyKanbanSyncStore, journalTicketOp } from "../storage-kanban-sync.js";
import { createProject } from "../storage.js";
import { cleanupFleets, COMMAND_ID, fleet, LEAF_ID } from "./node-ticket-sync-test-support.js";

/**
 * Kanban sync between a command node and a leaf, each a real storage service
 * in its own data directory, over an in-process link that runs the leaf's real
 * sync commands (`node-ticket-sync-test-support.ts`). The to-do 3800
 * follow-ups are in `node-ticket-sync-followups.test.ts`.
 */

afterEach(cleanupFleets);

describe("command node to leaf", () => {
  test("a command node ticket reaches the leaf under the same id, and edits and deletion follow", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(
      f.commandProject.id,
      "Ship it",
      "Do the thing",
      {
        acceptanceCriteria: "- It works",
      },
    );
    expect((await f.sync.sync(LEAF_ID)).state).toBe("in-sync");
    const copy = await f.leafTicket(ticket.id);
    expect(copy).toMatchObject({
      id: ticket.id,
      projectId: f.leafProject.id,
      title: "Ship it",
      description: "Do the thing",
      status: "backlog",
    });
    expect(copy?.sync?.replica).toMatchObject({
      controllerId: COMMAND_ID,
      sourceProjectId: f.commandProject.id,
    });

    await f.command.kanban.updateKanbanTask(ticket.id, { title: "Ship it now", status: "review" });
    await f.command.kanban.addKanbanComment(ticket.id, "Looks good");
    await f.sync.sync(LEAF_ID);
    expect(await f.leafTicket(ticket.id)).toMatchObject({
      title: "Ship it now",
      status: "review",
      comments: [expect.objectContaining({ text: "Looks good" })],
    });
    // Applying the command node's snapshot queues nothing back up.
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toEqual([]);

    await f.command.kanban.deleteKanbanTask(ticket.id);
    await f.sync.sync(LEAF_ID);
    expect(await f.leafTicket(ticket.id)).toBeNull();
    const status = await f.sync.status(f.commandProject.id);
    expect(status.nodes).toEqual([expect.objectContaining({ nodeId: LEAF_ID, state: "in-sync" })]);
  });

  test("a leaf just attached, its projects not read yet, syncs as soon as they are", async () => {
    // Live over two dev:test profiles the first sync after attach waited for
    // the 60 s reconcile: the read found no projects, so nothing paired and
    // nothing retried (to-do 3800 task 1).
    let pending = true;
    const f = await fleet({ summaryPending: () => pending, retryDelayMs: 5 });
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Early", "");
    const first = await f.sync.sync(LEAF_ID);
    expect(first).toMatchObject({ state: "in-sync", waiting: true, sent: 0 });
    expect(f.received).toEqual([]);
    pending = false;
    const deadline = Date.now() + 2_000;
    while (!(await f.leafTicket(ticket.id)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await f.leafTicket(ticket.id))?.title).toBe("Early");
  });

  test("a leaf that reconnects after a gap catches up from its cursor, not the whole board", async () => {
    const f = await fleet();
    for (let index = 0; index < 5; index += 1) {
      await f.command.kanban.addKanbanTask(f.commandProject.id, `Ticket ${index}`, "");
    }
    expect((await f.sync.sync(LEAF_ID)).sent).toBe(5);
    f.link.connected = false;
    const offline = await f.sync.sync(LEAF_ID);
    expect(offline.state).toBe("offline");
    expect(offline.message).toContain("reach it when it reconnects");
    const later = await f.command.kanban.addKanbanTask(f.commandProject.id, "Later", "");
    const tickets = await f.command.kanban.getKanbanTasks(f.commandProject.id);
    await f.command.kanban.updateKanbanTask(tickets[0]!.id, { status: "done" });
    expect((await f.sync.status(f.commandProject.id)).nodes[0]?.state).toBe("offline");
    f.link.connected = true;
    expect((await f.sync.status(f.commandProject.id)).nodes[0]?.state).toBe("behind");
    const caughtUp = await f.sync.sync(LEAF_ID);
    expect(caughtUp.sent).toBe(2);
    expect(await f.leafTicket(later.id)).toMatchObject({ title: "Later" });
    expect(await f.leafTicket(tickets[0]!.id)).toMatchObject({ status: "done" });
    expect((await f.leaf.kanban.getKanbanTasks(f.leafProject.id)).length).toBe(6);
  });

  test("a cursor from another epoch is a full resync that removes copies the board no longer has", async () => {
    const f = await fleet();
    const kept = await f.command.kanban.addKanbanTask(f.commandProject.id, "Kept", "");
    await f.sync.sync(LEAF_ID);
    // A copy the board has never heard of, as after the command node's data was replaced.
    await f.leaf.ticketSync.applyTicketSync({
      controllerId: COMMAND_ID,
      projectId: f.leafProject.id,
      sourceProjectId: f.commandProject.id,
      epoch: "another-epoch",
      cursor: 999,
      items: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          seq: 999,
          revs: {},
          title: "Stale",
          description: "",
          acceptanceCriteria: "",
          status: "backlog",
          comments: [],
          createdAt: new Date().toISOString(),
        },
      ],
    });
    await f.sync.sync(LEAF_ID);
    const titles = (await f.leaf.kanban.getKanbanTasks(f.leafProject.id)).map((task) => task.title);
    expect(titles).toEqual(["Kept"]);
    expect(await f.leafTicket(kept.id)).not.toBeNull();
  });
});

describe("leaf to command node", () => {
  test("edits to a copy on the leaf go up through its outbox and come back stamped", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Build", "");
    await f.sync.sync(LEAF_ID);
    await f.leaf.kanban.updateKanbanTask(ticket.id, { status: "in-progress", title: "Build v2" });
    await f.leaf.kanban.addKanbanComment(ticket.id, "Started on the leaf");
    const queued = await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0);
    expect(queued.items.map((item) => item.op.kind)).toEqual([
      "set-title",
      "set-status",
      "add-comment",
    ]);
    const result = await f.sync.sync(LEAF_ID);
    expect(result).toMatchObject({ state: "in-sync", applied: 3, conflicts: 0 });
    expect(await f.commandTicket(ticket.id)).toMatchObject({
      title: "Build v2",
      status: "in-progress",
      comments: [expect.objectContaining({ text: "Started on the leaf" })],
    });
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toEqual([]);
    // A second edit from the leaf, before or after the snapshot, is not a conflict with its first.
    await f.leaf.kanban.updateKanbanTask(ticket.id, { title: "Build v3" });
    expect((await f.sync.sync(LEAF_ID)).conflicts).toBe(0);
    expect((await f.commandTicket(ticket.id))?.title).toBe("Build v3");
  });

  test("a ticket created on the leaf after sync began is adopted under its own id", async () => {
    const f = await fleet();
    const before = await f.leaf.kanban.addKanbanTask(
      f.leafProject.id,
      "Leaf only, from before",
      "",
    );
    await f.sync.sync(LEAF_ID);
    const created = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "Made on the leaf", "Body");
    expect(created.sync?.replica?.pendingCreate).toBe(true);
    await f.sync.sync(LEAF_ID);
    expect(await f.commandTicket(created.id)).toMatchObject({
      projectId: f.commandProject.id,
      title: "Made on the leaf",
      description: "Body",
    });
    const copy = await f.leafTicket(created.id);
    expect(copy?.sync?.replica?.pendingCreate).toBeUndefined();
    expect(copy?.sync?.replica?.seq).toBeGreaterThan(0);
    // Tickets from before sync stay on the leaf (not adopted).
    expect(await f.commandTicket(before.id)).toBeNull();
  });

  test("criteria results and work on the leaf merge without conflicts and show where the work runs", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Verify me", "", {
      acceptanceCriteria: "- First\n- Second",
    });
    await f.sync.sync(LEAF_ID);
    const copy = (await f.leafTicket(ticket.id))!;
    const first = copy.sections!.acceptanceCriteria![0]!;
    await f.leaf.kanban.recordKanbanCriteriaChecks(ticket.id, [
      {
        id: first.id,
        text: first.text,
        check: {
          status: "passed",
          evidence: "test ran",
          checkedAt: new Date().toISOString(),
          source: "verify",
        },
      },
    ]);
    await f.leaf.kanban.updateKanbanTask(ticket.id, {
      buildPipelineId: "pipeline-1",
      environmentId: "environment-1",
    });
    // Meanwhile the command node edits the title: criteria results are not text, so no conflict.
    await f.command.kanban.updateKanbanTask(ticket.id, { title: "Verify me (renamed)" });
    const result = await f.sync.sync(LEAF_ID);
    expect(result.conflicts).toBe(0);
    const board = (await f.commandTicket(ticket.id))!;
    expect(board.sections?.acceptanceCriteria?.[0]?.check?.status).toBe("passed");
    expect(board.sync?.work).toMatchObject({
      nodeId: LEAF_ID,
      nodeName: "Leaf machine",
      buildPipelineId: "pipeline-1",
      environmentId: "environment-1",
    });
    expect((await f.leafTicket(ticket.id))?.title).toBe("Verify me (renamed)");
    expect((await f.leafTicket(ticket.id))?.sync?.work?.nodeId).toBe(LEAF_ID);
  });

  test("a leaf announces queued changes for the command node to collect", async () => {
    const f = await fleet();
    await f.command.kanban.addKanbanTask(f.commandProject.id, "Seen", "");
    await f.sync.sync(LEAF_ID);
    expect(await f.leaf.ticketSync.ticketSyncOutboxControllers()).toEqual([]);
    const ticket = (await f.leaf.kanban.getKanbanTasks(f.leafProject.id))[0]!;
    await f.leaf.kanban.updateKanbanTask(ticket.id, { status: "done" });
    expect(await f.leaf.ticketSync.ticketSyncOutboxControllers()).toEqual([COMMAND_ID]);
    f.sync.handleNodeEvent(TICKET_SYNC_OUTBOX_READY_EVENT, { controllerId: COMMAND_ID }, LEAF_ID);
    for (
      let round = 0;
      round < 50 && (await f.commandTicket(ticket.id))?.status !== "done";
      round++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await f.commandTicket(ticket.id))?.status).toBe("done");
  });
});

describe("disconnection", () => {
  test("changes made on a disconnected leaf are kept in order and applied once on reconnect", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Offline work", "");
    await f.sync.sync(LEAF_ID);
    f.link.connected = false;
    for (const status of ["in-progress", "review", "in-progress"] as const) {
      await f.leaf.kanban.updateKanbanTask(ticket.id, { status });
    }
    await f.leaf.kanban.addKanbanComment(ticket.id, "first");
    await f.leaf.kanban.addKanbanComment(ticket.id, "second");
    const removed = await f.leaf.kanban.addKanbanComment(ticket.id, "never mind");
    await f.leaf.kanban.deleteKanbanComment(ticket.id, removed.comments.at(-1)!.id);
    // Every operation remains immutable until acknowledgement.
    const queued = (await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items;
    expect(queued.map((item) => item.op.kind)).toEqual([
      "set-status",
      "set-status",
      "set-status",
      "add-comment",
      "add-comment",
      "add-comment",
      "delete-comment",
    ]);
    expect((await f.sync.sync(LEAF_ID)).state).toBe("offline");

    f.link.connected = true;
    // The leaf applies the acknowledgement but the answer is lost: a retry must not duplicate.
    f.failNext.add("ack_ticket_sync_outbox");
    expect((await f.sync.sync(LEAF_ID)).state).toBe("error");
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toEqual([]);
    await f.sync.sync(LEAF_ID);
    const board = (await f.commandTicket(ticket.id))!;
    expect(board.status).toBe("in-progress");
    expect(board.comments.map((comment) => comment.text)).toEqual(["first", "second"]);
  });

  test("a lost acknowledgement is collected again and applied only once", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Once", "");
    await f.sync.sync(LEAF_ID);
    await f.leaf.kanban.addKanbanComment(ticket.id, "only once");
    // The ack never reaches the leaf, so the same items are collected again.
    const original = f.link.invoke.bind(f.link);
    let dropAck = true;
    f.link.invoke = async <T>(name: string, args?: Record<string, unknown>) => {
      if (name === "ack_ticket_sync_outbox" && dropAck) {
        dropAck = false;
        throw new Error("connection lost");
      }
      return original<T>(name, args);
    };
    expect((await f.sync.sync(LEAF_ID)).state).toBe("error");
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toHaveLength(1);
    await f.sync.sync(LEAF_ID);
    expect((await f.commandTicket(ticket.id))?.comments.map((comment) => comment.text)).toEqual([
      "only once",
    ]);
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toEqual([]);
  });
});

describe("conflicts and tombstones", () => {
  test("a field changed on both sides keeps the command node's value and records the leaf's", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Original", "");
    await f.sync.sync(LEAF_ID);
    f.link.connected = false;
    await f.leaf.kanban.updateKanbanTask(ticket.id, { title: "Leaf title", status: "review" });
    await f.command.kanban.updateKanbanTask(ticket.id, { title: "Command title" });
    f.link.connected = true;
    const result = await f.sync.sync(LEAF_ID);
    expect(result.conflicts).toBe(1);
    const board = (await f.commandTicket(ticket.id))!;
    expect(board.title).toBe("Command title");
    // The status changed only on the leaf, so it is applied.
    expect(board.status).toBe("review");
    expect(board.comments.at(-1)?.text).toContain("Sync conflict: Leaf machine changed the title");
    expect(board.comments.at(-1)?.text).toContain("Leaf title");
    const status = await f.sync.status(f.commandProject.id);
    expect(status.conflicts).toEqual([
      expect.objectContaining({
        ticketId: ticket.id,
        field: "title",
        reason: "stale-revision",
        fromNodeId: LEAF_ID,
        value: "Leaf title",
      }),
    ]);
    // The leaf converges on the command node's version, comment included.
    const copy = (await f.leafTicket(ticket.id))!;
    expect(copy.title).toBe("Command title");
    expect(copy.status).toBe("review");
    expect(copy.comments.at(-1)?.text).toContain("Sync conflict");
  });

  test("a ticket deleted on the command node while the leaf was offline stays deleted", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Doomed", "");
    await f.sync.sync(LEAF_ID);
    f.link.connected = false;
    await f.leaf.kanban.updateKanbanTask(ticket.id, { title: "Edited offline" });
    await f.command.kanban.deleteKanbanTask(ticket.id);
    f.link.connected = true;
    const result = await f.sync.sync(LEAF_ID);
    expect(result.conflicts).toBe(1);
    expect(await f.commandTicket(ticket.id)).toBeNull();
    expect(await f.leafTicket(ticket.id)).toBeNull();
    expect((await f.sync.status(f.commandProject.id)).conflicts).toEqual([
      expect.objectContaining({ ticketId: ticket.id, reason: "ticket-deleted" }),
    ]);
    // Another round brings nothing back.
    await f.sync.sync(LEAF_ID);
    expect(await f.leafTicket(ticket.id)).toBeNull();
    expect(await f.commandTicket(ticket.id)).toBeNull();
  });

  test("a ticket deleted on the leaf is deleted on the command node, and an old snapshot cannot revive it", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Remove me", "");
    await f.sync.sync(LEAF_ID);
    await f.leaf.kanban.deleteKanbanTask(ticket.id);
    // A snapshot sent before the leaf's deletion was collected does not bring it back.
    const stale = await f.command.ticketSync.ticketSyncChangesSince(
      f.commandProject.id,
      0,
      undefined,
    );
    await f.leaf.ticketSync.applyTicketSync({
      controllerId: COMMAND_ID,
      projectId: f.leafProject.id,
      sourceProjectId: f.commandProject.id,
      epoch: stale.epoch,
      items: stale.items,
      cursor: stale.cursor,
    });
    expect(await f.leafTicket(ticket.id)).toBeNull();
    await f.sync.sync(LEAF_ID);
    expect(await f.commandTicket(ticket.id)).toBeNull();
    expect(await f.leafTicket(ticket.id)).toBeNull();
  });
});

describe("labels", () => {
  test("labels sync both ways with the content", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Labelled", "", {
      labels: ["bug"],
    });
    await f.sync.sync(LEAF_ID);
    expect((await f.leafTicket(ticket.id))?.labels).toEqual(["bug"]);

    await f.leaf.kanban.setKanbanTaskLabel(ticket.id, "ui", true);
    const queued = await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0);
    expect(queued.items.map((item) => item.op.kind)).toEqual(["set-content"]);
    expect((await f.sync.sync(LEAF_ID)).conflicts).toBe(0);
    expect((await f.commandTicket(ticket.id))?.labels).toEqual(["bug", "ui"]);

    await f.command.kanban.updateKanbanTask(ticket.id, { labels: [] });
    await f.sync.sync(LEAF_ID);
    expect((await f.leafTicket(ticket.id))?.labels).toBeUndefined();
  });

  test("an older command snapshot without labels preserves labels already on a replica", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Kept", "Old", {
      labels: ["bug"],
    });
    await f.sync.sync(LEAF_ID);
    await f.command.kanban.updateKanbanTask(ticket.id, { description: "New" });
    const batch = await f.command.ticketSync.ticketSyncChangesSince(
      f.commandProject.id,
      0,
      undefined,
    );
    const items = batch.items.map((item) => {
      if ("deleted" in item) return item;
      const { labels: _labels, ...older } = item;
      return older;
    });
    await f.leaf.ticketSync.applyTicketSync({
      controllerId: COMMAND_ID,
      projectId: f.leafProject.id,
      sourceProjectId: f.commandProject.id,
      epoch: batch.epoch,
      items,
      cursor: batch.cursor,
    });
    expect(await f.leafTicket(ticket.id)).toMatchObject({ description: "New", labels: ["bug"] });
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toEqual([]);
  });

  test.each(["command", "leaf"] as const)(
    "concurrent text and label edits conflict as shared content (%s changes labels)",
    async (labelWriter) => {
      const f = await fleet();
      const ticket = await f.command.kanban.addKanbanTask(
        f.commandProject.id,
        "Conflict",
        "Original",
        { labels: ["bug"] },
      );
      await f.sync.sync(LEAF_ID);
      f.link.connected = false;
      if (labelWriter === "command") {
        await f.command.kanban.setKanbanTaskLabel(ticket.id, "ui", true);
        await f.leaf.kanban.updateKanbanTask(ticket.id, { description: "Leaf text" });
      } else {
        await f.command.kanban.updateKanbanTask(ticket.id, { description: "Command text" });
        await f.leaf.kanban.setKanbanTaskLabel(ticket.id, "ui", true);
      }
      f.link.connected = true;
      expect((await f.sync.sync(LEAF_ID)).conflicts).toBe(1);
      const expected =
        labelWriter === "command"
          ? { description: "Original", labels: ["bug", "ui"] }
          : { description: "Command text", labels: ["bug"] };
      expect(await f.commandTicket(ticket.id)).toMatchObject(expected);
      expect(await f.leafTicket(ticket.id)).toMatchObject(expected);
      expect((await f.sync.status(f.commandProject.id)).conflicts).toEqual([
        expect.objectContaining({
          ticketId: ticket.id,
          field: "content",
          reason: "stale-revision",
          fromNodeId: LEAF_ID,
        }),
      ]);
      expect((await f.commandTicket(ticket.id))?.comments.at(-1)?.text).toContain("Sync conflict");
      expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toEqual([]);
      expect((await f.sync.sync(LEAF_ID)).conflicts).toBe(0);
    },
  );

  test("content from a node that predates labels leaves the labels alone", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Kept", "Old", {
      labels: ["bug"],
    });
    const result = await f.command.ticketSync.applyTicketSyncOps({
      nodeId: LEAF_ID,
      epoch: "older-leaf",
      items: [
        {
          seq: 1,
          ticketId: ticket.id,
          sourceProjectId: f.commandProject.id,
          createdAt: new Date().toISOString(),
          // An older leaf's content has no labels field.
          op: {
            kind: "set-content",
            value: { description: "New", acceptanceCriteria: "" },
            baseRev: (await f.commandTicket(ticket.id))?.sync?.revs.content ?? 0,
          },
          bytes: 100,
        },
      ],
    });
    expect(result.conflicts).toEqual([]);
    expect(await f.commandTicket(ticket.id)).toMatchObject({
      description: "New",
      labels: ["bug"],
    });
  });
});

describe("ticket-sync domain client (plan item 1010)", () => {
  test("a leaf with the domain syncs without the capability, and every call carries the envelope", async () => {
    const f = await fleet({ capability: false, domains: { "ticket-sync": { min: 1, max: 1 } } });
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Contract", "");
    const result = await f.sync.sync(LEAF_ID);
    expect(result.state).toBe("in-sync");
    expect((await f.leafTicket(ticket.id))?.title).toBe("Contract");
    expect(f.envelopes.length).toBeGreaterThan(0);
    for (const { envelope } of f.envelopes) {
      expect(envelope).toMatchObject({ domain: "ticket-sync", version: 1 });
    }
    expect((await f.sync.status(f.commandProject.id)).nodes[0]).toMatchObject({
      state: "in-sync",
    });
  });

  test("a pre-contract leaf with the capability gets today's body, with no envelope", async () => {
    const f = await fleet();
    await f.command.kanban.addKanbanTask(f.commandProject.id, "Legacy", "");
    expect((await f.sync.sync(LEAF_ID)).state).toBe("in-sync");
    expect(f.envelopes.every(({ envelope }) => envelope === undefined)).toBe(true);
  });

  test("a leaf whose range has no version in common is reported as needing an update", async () => {
    const f = await fleet({ domains: { "ticket-sync": { min: 2, max: 3 } } });
    expect((await f.sync.sync(LEAF_ID)).state).toBe("update-required");
    expect(f.received).toEqual([]);
  });
});

describe("older leaves", () => {
  test("a leaf without ticket-sync is reported as needing an update and is never called", async () => {
    const f = await fleet({ capability: false });
    await f.command.kanban.addKanbanTask(f.commandProject.id, "Not for old leaves", "");
    const result = await f.sync.sync(LEAF_ID);
    expect(result.state).toBe("update-required");
    expect(result.message).toContain("Update that machine");
    expect(f.received).toEqual([]);
    const status = await f.sync.status(f.commandProject.id);
    expect(status.nodes[0]).toMatchObject({ state: "update-required" });
  });

  test("a detached command node's copies become the leaf's own tickets", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Keep me", "");
    await f.sync.sync(LEAF_ID);
    await f.leaf.ticketSync.forgetTicketSyncController(COMMAND_ID);
    const copy = (await f.leafTicket(ticket.id))!;
    expect(copy.title).toBe("Keep me");
    expect(copy.sync?.replica).toBeUndefined();
    await f.leaf.kanban.updateKanbanTask(ticket.id, { title: "Mine now" });
    expect(await f.leaf.ticketSync.ticketSyncOutboxControllers()).toEqual([]);
    // New leaf tickets are no longer sent anywhere.
    const fresh = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "Fresh", "");
    expect(fresh.sync?.replica).toBeUndefined();
  });
});

describe("outbox collection interleavings", () => {
  for (const action of ["edit", "delete", "delete-comment"] as const) {
    for (const appliedBefore of [false, true]) {
      test(`${action} after collection, applied before mutation: ${appliedBefore}`, async () => {
        const f = await fleet();
        await f.sync.sync(LEAF_ID);
        const task = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "A", "");
        const comment = await f.leaf.kanban.addKanbanComment(task.id, "temporary");
        const batch = await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0);
        const apply = () =>
          f.command.ticketSync.applyTicketSyncOps({
            nodeId: LEAF_ID,
            nodeName: "Leaf",
            epoch: batch.epoch!,
            items: batch.items,
          });
        if (appliedBefore) await apply();
        if (action === "edit")
          await f.leaf.kanban.updateKanbanTask(task.id, { title: "B", status: "review" });
        if (action === "delete") await f.leaf.kanban.deleteKanbanTask(task.id);
        if (action === "delete-comment")
          await f.leaf.kanban.deleteKanbanComment(task.id, comment.comments.at(-1)!.id);
        if (!appliedBefore) await apply();
        await f.leaf.ticketSync.ackTicketSyncOutbox(
          COMMAND_ID,
          batch.epoch!,
          batch.items.at(-1)!.seq,
        );
        expect((await f.sync.sync(LEAF_ID)).state).toBe("in-sync");
        const board = await f.commandTicket(task.id);
        if (action === "delete") expect(board).toBeNull();
        if (action === "edit") expect(board).toMatchObject({ title: "B", status: "review" });
        if (action === "delete-comment") expect(board?.comments).toEqual([]);
        const copy = await f.leafTicket(task.id);
        if (board)
          expect(copy).toMatchObject({
            title: board.title,
            status: board.status,
            comments: board.comments,
          });
        else expect(copy).toBeNull();
      });
    }
  }

  test("unknown project entries and everything after them remain queued", async () => {
    const f = await fleet();
    await f.sync.sync(LEAF_ID);
    const a = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "known", "");
    await f.leaf.kanban.addKanbanTask(f.leafProject.id, "unknown", "");
    await f.leaf.kanban.addKanbanTask(f.leafProject.id, "later", "");
    const invoke = f.link.invoke.bind(f.link);
    f.link.invoke = async <T>(name: string, args?: Record<string, unknown>): Promise<T> => {
      const result = await invoke<any>(name, args);
      if (name === "collect_ticket_sync_outbox" && result.items[1])
        result.items[1].sourceProjectId = "removed-project";
      return result;
    };
    expect((await f.sync.sync(LEAF_ID)).state).toBe("error");
    expect(await f.commandTicket(a.id)).not.toBeNull();
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toHaveLength(2);
    f.link.invoke = invoke;
    expect((await f.sync.sync(LEAF_ID)).state).toBe("in-sync");
  });

  test("oversized writes are refused atomically and later valid tickets sync", async () => {
    const f = await fleet();
    await f.sync.sync(LEAF_ID);
    for (const [storage, project] of [
      [f.command, f.commandProject],
      [f.leaf, f.leafProject],
    ] as const) {
      await expect(
        storage.kanban.addKanbanTask(project.id, "x".repeat(2001), ""),
      ).rejects.toThrow();
      const task = await storage.kanban.addKanbanTask(project.id, "valid", "");
      const before = await storage.kanban.getKanbanTask(task.id);
      await expect(
        storage.kanban.updateKanbanTask(task.id, { title: "x".repeat(2001) }),
      ).rejects.toThrow();
      expect(await storage.kanban.getKanbanTask(task.id)).toEqual(before);
      await expect(
        storage.kanban.updateKanbanTask(task.id, { description: "x".repeat(200001) }),
      ).rejects.toThrow();
      await expect(storage.kanban.addKanbanComment(task.id, "x".repeat(200001))).rejects.toThrow();
      expect(await storage.kanban.getKanbanTask(task.id)).toEqual(before);
    }
    expect((await f.sync.sync(LEAF_ID)).state).toBe("in-sync");
    expect(await f.command.kanban.getKanbanTasks(f.commandProject.id)).toHaveLength(2);
  });
});

test("immutable create and later edit enforce the byte boundary without changing the queue", () => {
  const store = emptyKanbanSyncStore();
  const op = {
    kind: "create" as const,
    ticket: {
      title: "A",
      status: "backlog" as const,
      description: "",
      acceptanceCriteria: "",
      comments: [],
      createdAt: "now",
    },
  };
  journalTicketOp(store, COMMAND_ID, "t", "p", op, "now");
  store.outbox[COMMAND_ID]!.items[0]!.bytes = TICKET_SYNC_LIMITS.maxOutboxBytes;
  const before = structuredClone(store);
  expect(() =>
    journalTicketOp(
      store,
      COMMAND_ID,
      "t",
      "p",
      { kind: "set-title", value: "B", baseRev: 0 },
      "now",
    ),
  ).toThrow();
  expect(store).toEqual(before);
});

for (const collision of ["project", "controller"] as const) {
  test(`snapshot ${collision} collision refuses without advancing the cursor`, async () => {
    const f = await fleet();
    const task = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "existing", "");
    const project =
      collision === "project"
        ? await f.leaf.addProject(createProject("https://github.com/acme/other.git"))
        : f.leafProject;
    if (collision === "controller") await f.sync.sync(LEAF_ID);
    const input = {
      controllerId: collision === "controller" ? "other-controller" : COMMAND_ID,
      projectId: project.id,
      sourceProjectId: f.commandProject.id,
      epoch: "epoch",
      cursor: 1,
      items: [{ id: task.id, seq: 1, deleted: true as const, deletedAt: "now" }],
    };
    // Give the existing row another controller when testing that ownership fence.
    if (collision === "controller") {
      await f.leaf.ticketSync.applyTicketSync({
        ...input,
        controllerId: COMMAND_ID,
        items: [{ ...task, seq: 1, revs: {} }],
      });
    }
    const beforeCursor = await f.leaf.ticketSync.getTicketSyncCursor(
      input.controllerId,
      project.id,
    );
    await expect(f.leaf.ticketSync.applyTicketSync(input)).rejects.toThrow("belongs to another");
    expect(await f.leaf.ticketSync.getTicketSyncCursor(input.controllerId, project.id)).toEqual(
      beforeCursor,
    );
    expect(await f.leafTicket(task.id)).not.toBeNull();
  });
}

test("full outbox refuses an edit without committing board or outbox", async () => {
  const f = await fleet();
  await f.sync.sync(LEAF_ID);
  const task = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "A", "");
  const store = readStoredValue<any>(f.leaf.getDataDir(), "kanban-sync.json");
  store.outbox[COMMAND_ID].items[0].bytes = TICKET_SYNC_LIMITS.maxOutboxBytes;
  seedStore(f.leaf.getDataDir(), "kanban-sync.json", store);
  const before = await f.leafTicket(task.id);
  await expect(f.leaf.kanban.updateKanbanTask(task.id, { title: "B" })).rejects.toThrow(
    "too many ticket changes",
  );
  expect(await f.leafTicket(task.id)).toEqual(before);
  expect(readStoredValue(f.leaf.getDataDir(), "kanban-sync.json")).toEqual(store);
});

describe("merge closure identity across machines", () => {
  for (const source of ["leaf", "command"] as const) {
    for (const alreadyDone of [false, true]) {
      test(`${source} merge (${alreadyDone ? "already done" : "open"}) survives a reopen on the other machine`, async () => {
        const f = await fleet();
        const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Merged", "");
        if (alreadyDone) await f.command.kanban.updateKanbanTask(ticket.id, { status: "done" });
        await f.sync.sync(LEAF_ID);
        const origin = source === "leaf" ? f.leaf : f.command;
        const other = source === "leaf" ? f.command : f.leaf;
        const prUrl = "https://github.com/acme/repo/pull/1";
        await origin.kanban.addKanbanComment(ticket.id, `🎉 PR merged: ${prUrl}`);
        await origin.kanban.closeKanbanTasksForMergedPullRequests([{ taskId: ticket.id, prUrl }]);
        await f.sync.sync(LEAF_ID);
        expect(await other.kanban.getKanbanTask(ticket.id)).toMatchObject({
          status: "done",
          prMergeDoneUrl: prUrl,
        });
        await other.kanban.updateKanbanTask(ticket.id, { status: "backlog" });
        expect(await other.kanban.closeKanbanTasksForMergedPullRequests()).toEqual([]);
        await f.sync.sync(LEAF_ID);
        for (const node of [origin, other]) {
          expect(await node.kanban.closeKanbanTasksForMergedPullRequests()).toEqual([]);
          expect(await node.kanban.getKanbanTask(ticket.id)).toMatchObject({
            status: "backlog",
            prMergeDoneUrl: prUrl,
          });
        }
      });
    }
  }

  test("a new leaf ticket carries its marker in creation and preserves it through edits", async () => {
    const f = await fleet();
    await f.sync.sync(LEAF_ID);
    const ticket = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "New", "");
    const prUrl = "https://github.com/acme/repo/pull/2";
    await f.leaf.kanban.closeKanbanTasksForMergedPullRequests([{ taskId: ticket.id, prUrl }]);
    await f.leaf.kanban.updateKanbanTask(ticket.id, { status: "review" });
    await f.sync.sync(LEAF_ID);
    expect(await f.commandTicket(ticket.id)).toMatchObject({
      status: "review",
      prMergeDoneUrl: prUrl,
    });
  });
});
