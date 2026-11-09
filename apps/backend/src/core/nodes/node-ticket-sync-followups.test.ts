import { afterEach, describe, expect, test } from "bun:test";

import type {
  TicketSyncLeafStatus,
  TicketSyncImageRef,
  TicketSyncStatusResult,
} from "@orkestrator/protocol/ticket-sync";

import { mergeSnapshotImages } from "../storage-kanban-sync.js";
import { readStoredValue, seedStore } from "../storage-test-support.js";
import { createProject } from "../storage.js";
import type { KanbanImage } from "../storage-shared.js";
import { readKanbanImageData } from "../ticket-sync-images.js";
import {
  cleanupFleets,
  COMMAND_ID,
  fleet,
  LEAF_ID,
  REPO,
  type Fleet,
} from "./node-ticket-sync-test-support.js";

/**
 * To-do 3800 tasks 2 to 6: sharing a leaf's older tickets, images on synced
 * tickets, the conflict list and the "synced from" mark, a second copy of a
 * repository on one leaf, and column order. Two real stores over the
 * in-process link of `node-ticket-sync-test-support.ts`.
 */

afterEach(cleanupFleets);

const IMAGE_BYTES = Buffer.from("not really a webp, but bytes all the same").toString("base64");

async function leafCommand<T>(f: Fleet, name: string, args: Record<string, unknown>): Promise<T> {
  const handler = f.handlers.get(name);
  if (!handler) throw new Error(`No handler for ${name}`);
  return (await handler(args, f.leafContext)) as T;
}

async function boardCommand<T>(f: Fleet, name: string, args: Record<string, unknown>): Promise<T> {
  const handler = f.handlers.get(name);
  if (!handler) throw new Error(`No handler for ${name}`);
  return (await handler(args, f.commandContext)) as T;
}

function leafStatus(f: Fleet, projectId = f.leafProject.id) {
  return leafCommand<TicketSyncLeafStatus>(f, "get_ticket_sync_leaf_status", { projectId });
}

async function attachImage(
  storage: Fleet["command"],
  taskId: string,
  requestId = "image-1",
): Promise<KanbanImage> {
  const { image } = await storage.kanban.addNormalizedKanbanImageForRequest(
    taskId,
    "screenshot.png",
    IMAGE_BYTES,
    requestId,
  );
  return image;
}

describe("sharing a leaf's tickets from before sync (task 2)", () => {
  test("they stay on the leaf until the user shares them, then go up under their own ids", async () => {
    const f = await fleet();
    // Made before the command node first synced this project.
    const older = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "From before sync", "Old");
    await f.leaf.kanban.addKanbanComment(older.id, "a note");
    const board = await f.command.kanban.addKanbanTask(f.commandProject.id, "On the board", "");
    await f.sync.sync(LEAF_ID);
    expect(await f.commandTicket(older.id)).toBeNull();
    expect(await leafStatus(f)).toMatchObject({
      controllers: [{ controllerId: COMMAND_ID, nodeName: "Command", pending: 0 }],
      unshared: 1,
    });

    const shared = await leafCommand<{ shared: number }>(f, "share_tickets_with_command_node", {
      projectId: f.leafProject.id,
      taskIds: [older.id, board.id],
    });
    // The board's own ticket is already a copy; only the older one is sent.
    expect(shared).toEqual({ shared: 1 });
    expect((await f.leafTicket(older.id))?.sync?.replica).toMatchObject({
      controllerId: COMMAND_ID,
      pendingCreate: true,
    });
    await f.sync.sync(LEAF_ID);
    expect(await f.commandTicket(older.id)).toMatchObject({
      title: "From before sync",
      description: "Old",
      comments: [expect.objectContaining({ text: "a note" })],
    });
    // Confirmed: a copy like any other, and nothing is left to share.
    expect((await f.leafTicket(older.id))?.sync?.replica?.pendingCreate).toBeUndefined();
    expect((await leafStatus(f)).unshared).toBe(0);
    // Sharing again sends nothing twice.
    expect(
      await leafCommand(f, "share_tickets_with_command_node", { projectId: f.leafProject.id }),
    ).toEqual({ shared: 0 });
    expect(await f.command.kanban.getKanbanTasks(f.commandProject.id)).toHaveLength(2);
  });

  test("Share all sends every older ticket; a board no command node syncs has nothing to share with", async () => {
    const f = await fleet();
    const first = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "One", "");
    const second = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "Two", "");
    await expect(
      leafCommand(f, "share_tickets_with_command_node", { projectId: f.leafProject.id }),
    ).rejects.toThrow("not synced with a command node");
    expect(await leafStatus(f)).toMatchObject({ controllers: [], unshared: 0 });

    await f.sync.sync(LEAF_ID);
    expect(
      await leafCommand(f, "share_tickets_with_command_node", { projectId: f.leafProject.id }),
    ).toEqual({ shared: 2 });
    await f.sync.sync(LEAF_ID);
    expect((await f.commandTicket(first.id))?.title).toBe("One");
    expect((await f.commandTicket(second.id))?.title).toBe("Two");
  });
});

describe("images on synced tickets (task 3)", () => {
  test("an image attached on the command node shows on the leaf, delivered when the leaf asks", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "With a picture", "");
    const image = await attachImage(f.command, ticket.id);
    await f.sync.sync(LEAF_ID);
    expect((await f.leafTicket(ticket.id))?.images).toEqual([
      expect.objectContaining({ id: image.id, filename: "screenshot.png", nodeId: COMMAND_ID }),
    ]);
    // The leaf never reaches the command node: it asks, and the next collection delivers.
    expect(await readKanbanImageData(f.leafContext, image.id)).toBe(IMAGE_BYTES);
    expect(f.received).toContain("put_ticket_image");
    // Kept on the leaf, so a second read does not cross the link.
    const puts = f.received.filter((name) => name === "put_ticket_image").length;
    expect(await readKanbanImageData(f.leafContext, image.id)).toBe(IMAGE_BYTES);
    expect(f.received.filter((name) => name === "put_ticket_image")).toHaveLength(puts);
  });

  test("an image attached on a leaf's copy goes up as a reference; the command node reads it from the leaf once", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Leaf picture", "");
    await f.sync.sync(LEAF_ID);
    const image = await attachImage(f.leaf, ticket.id);
    const queued = await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0);
    expect(queued.items.map((item) => item.op.kind)).toEqual(["add-image"]);
    await f.sync.sync(LEAF_ID);
    expect((await f.commandTicket(ticket.id))?.images).toEqual([
      expect.objectContaining({ id: image.id, nodeId: LEAF_ID, nodeName: "Leaf machine" }),
    ]);
    expect(await readKanbanImageData(f.commandContext, image.id)).toBe(IMAGE_BYTES);
    expect(await readKanbanImageData(f.commandContext, image.id)).toBe(IMAGE_BYTES);
    expect(f.received.filter((name) => name === "read_ticket_image")).toHaveLength(1);
    // The leaf's image stays its own when the board lists it back.
    await f.sync.sync(LEAF_ID);
    const copy = (await f.leafTicket(ticket.id))!;
    expect(copy.images).toEqual([expect.objectContaining({ id: image.id, synced: true })]);
    expect(copy.images[0]!.nodeId).toBeUndefined();
  });

  test("a new leaf ticket takes its images up with it", async () => {
    const f = await fleet();
    await f.sync.sync(LEAF_ID);
    const ticket = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "New with image", "");
    const image = await attachImage(f.leaf, ticket.id);
    await f.sync.sync(LEAF_ID);
    expect((await f.commandTicket(ticket.id))?.images).toEqual([
      expect.objectContaining({ id: image.id, nodeId: LEAF_ID }),
    ]);
  });

  test("removing an image on either machine removes it from both", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Two pictures", "");
    const fromCommand = await attachImage(f.command, ticket.id, "command-image");
    await f.sync.sync(LEAF_ID);
    const fromLeaf = await attachImage(f.leaf, ticket.id, "leaf-image");
    await f.sync.sync(LEAF_ID);
    await f.sync.sync(LEAF_ID);
    expect((await f.commandTicket(ticket.id))?.images.map((image) => image.id)).toEqual([
      fromCommand.id,
      fromLeaf.id,
    ]);

    await f.leaf.kanban.deleteKanbanImage(ticket.id, fromCommand.id);
    await f.sync.sync(LEAF_ID);
    expect((await f.commandTicket(ticket.id))?.images.map((image) => image.id)).toEqual([
      fromLeaf.id,
    ]);
    await expect(f.command.kanban.getKanbanImageData(fromCommand.id)).rejects.toThrow();

    await f.command.kanban.deleteKanbanImage(ticket.id, fromLeaf.id);
    await f.sync.sync(LEAF_ID);
    expect((await f.leafTicket(ticket.id))?.images).toEqual([]);
    await expect(f.leaf.kanban.getKanbanImageData(fromLeaf.id)).rejects.toThrow();
  });

  test("an image whose machine is not connected is reported unavailable", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Offline picture", "");
    await f.sync.sync(LEAF_ID);
    const image = await attachImage(f.leaf, ticket.id);
    await f.sync.sync(LEAF_ID);
    f.link.connected = false;
    await expect(readKanbanImageData(f.commandContext, image.id)).rejects.toThrow(
      "This image is on Leaf machine, which is not connected.",
    );
  });

  test("a leaf asking for an image the command node no longer has gets an answer, not a hang", async () => {
    const f = await fleet({ imageTimeoutMs: 5_000 });
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Lost picture", "");
    const image = await attachImage(f.command, ticket.id);
    await f.sync.sync(LEAF_ID);
    await f.command.kanban.deleteKanbanImage(ticket.id, image.id);
    // The leaf still lists it until its next sync; the command node answers "none".
    const started = Date.now();
    await expect(readKanbanImageData(f.leafContext, image.id)).rejects.toThrow(
      "This image is on Command",
    );
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("a command node that did not declare images is never sent image changes", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Older board", "");
    await f.sync.sync(LEAF_ID);
    // An older command node collects without features.
    await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0, 100, []);
    const image = await attachImage(f.leaf, ticket.id);
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toEqual([]);
    // Its snapshots carry no images, so the leaf keeps its own.
    const { images: _images, ...older } = (
      await f.command.ticketSync.ticketSyncChangesSince(f.commandProject.id, 0, undefined)
    ).items[0] as { images?: unknown };
    expect(_images).toBeUndefined();
    expect(older).toMatchObject({ id: ticket.id });
    await f.leaf.kanban.updateKanbanTask(ticket.id, { title: "Still here" });
    expect((await f.leafTicket(ticket.id))?.images.map((entry) => entry.id)).toEqual([image.id]);
  });

  test("a snapshot keeps an own image still queued or never sent, and drops one the board removed", () => {
    const own = (id: string, synced?: true): KanbanImage => ({
      id,
      filename: `${id}.png`,
      createdAt: "2026-11-09T00:00:00.000Z",
      ...(synced ? { synced } : {}),
    });
    const ref: TicketSyncImageRef = {
      id: "board",
      filename: "board.png",
      createdAt: "2026-11-09T00:00:00.000Z",
      nodeId: COMMAND_ID,
    };
    const current: KanbanImage[] = [
      own("queued"),
      own("never-sent"),
      own("removed-there", true),
      { ...ref, id: "stale-ref" },
    ];
    const merged = mergeSnapshotImages(
      current,
      [ref],
      { addedImages: new Set(["queued"]), removedImages: new Set() },
      COMMAND_ID,
    );
    expect(merged.images.map((image) => image.id)).toEqual(["board", "queued", "never-sent"]);
    expect(merged.removed.sort()).toEqual(["removed-there", "stale-ref"]);
    // An older command node sends no list: nothing changes.
    expect(
      mergeSnapshotImages(
        current,
        undefined,
        { addedImages: new Set(), removedImages: new Set() },
        COMMAND_ID,
      ),
    ).toEqual({ images: current, removed: [] });
  });
});

describe("the conflict list and the synced-from mark (task 4)", () => {
  async function conflicted(f: Fleet) {
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Original", "");
    await f.sync.sync(LEAF_ID);
    f.link.connected = false;
    await f.leaf.kanban.updateKanbanTask(ticket.id, { title: "Leaf title" });
    await f.command.kanban.updateKanbanTask(ticket.id, { title: "Command title" });
    f.link.connected = true;
    expect((await f.sync.sync(LEAF_ID)).conflicts).toBe(1);
    return ticket;
  }

  test("each conflict has an id, and dismissing it clears the list but keeps the ticket's comment", async () => {
    const f = await fleet();
    const ticket = await conflicted(f);
    const status = await f.sync.status(f.commandProject.id);
    expect(status.conflictCount).toBe(1);
    const [conflict] = status.conflicts;
    expect(conflict).toMatchObject({ ticketId: ticket.id, field: "title" });
    expect(conflict!.id).toEqual(expect.any(String));

    expect(
      await boardCommand(f, "dismiss_ticket_sync_conflicts", {
        projectId: f.commandProject.id,
        ids: ["not-a-conflict"],
      }),
    ).toEqual({ dismissed: 0, remaining: 1 });
    expect(
      await boardCommand(f, "dismiss_ticket_sync_conflicts", {
        projectId: f.commandProject.id,
        ids: [conflict!.id],
      }),
    ).toEqual({ dismissed: 1, remaining: 0 });
    const after = await boardCommand<TicketSyncStatusResult>(f, "get_ticket_sync_status", {
      projectId: f.commandProject.id,
    });
    expect(after).toMatchObject({ conflicts: [], conflictCount: 0 });
    expect((await f.commandTicket(ticket.id))?.comments.at(-1)?.text).toContain("Sync conflict");
  });

  test("Dismiss all clears every conflict of the project, including records without an id", async () => {
    const f = await fleet();
    await conflicted(f);
    await conflicted(f);
    // A record written before conflicts had ids gets a stable one from its content.
    const stored = readStoredValue<{ conflicts: Array<{ id?: string }> }>(
      f.command.getDataDir(),
      "kanban-sync.json",
    );
    delete stored.conflicts[0]!.id;
    seedStore(f.command.getDataDir(), "kanban-sync.json", stored);
    const legacyId = (await f.command.ticketSync.getTicketSyncOverview(f.commandProject.id))
      .conflicts[0]!.id;
    expect(legacyId).toMatch(/^legacy-/);
    expect(
      (await f.command.ticketSync.getTicketSyncOverview(f.commandProject.id)).conflicts[0]!.id,
    ).toBe(legacyId);
    expect(
      await boardCommand(f, "dismiss_ticket_sync_conflicts", {
        projectId: f.commandProject.id,
        ids: [legacyId],
      }),
    ).toEqual({ dismissed: 1, remaining: 1 });
    await conflicted(f);
    expect(
      await boardCommand(f, "dismiss_ticket_sync_conflicts", { projectId: f.commandProject.id }),
    ).toEqual({ dismissed: 2, remaining: 0 });
  });

  test("a leaf board names the command node its copies come from", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "A copy", "");
    await f.sync.sync(LEAF_ID);
    f.link.connected = false;
    await f.leaf.kanban.updateKanbanTask(ticket.id, { title: "Waiting" });
    const status = await leafStatus(f);
    expect(status.controllers).toEqual([
      expect.objectContaining({
        controllerId: COMMAND_ID,
        nodeName: "Command",
        sourceProjectId: f.commandProject.id,
        pending: 1,
        lastSyncedAt: expect.any(String),
      }),
    ]);
    expect((await f.leafTicket(ticket.id))?.sync?.replica?.controllerId).toBe(COMMAND_ID);
  });
});

describe("a second copy of a repository on one leaf (task 5)", () => {
  test("only the first copy syncs, and both boards say which one does", async () => {
    const f = await fleet();
    // Another clone of the same repository (a different URL spelling, same identity).
    const second = await f.leaf.addProject(createProject(REPO.replace(/\.git$/, "")));
    const own = await f.leaf.kanban.addKanbanTask(second.id, "Second copy's own", "");
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Board ticket", "");
    await f.sync.sync(LEAF_ID);

    const status = await f.sync.status(f.commandProject.id);
    expect(status.nodes).toEqual([
      expect.objectContaining({
        nodeId: LEAF_ID,
        projectId: f.leafProject.id,
        projectName: f.leafProject.name,
        otherCopies: 1,
      }),
    ]);
    expect((await f.leafTicket(ticket.id))?.projectId).toBe(f.leafProject.id);
    expect(await f.leaf.kanban.getKanbanTasks(second.id)).toEqual([
      expect.objectContaining({ id: own.id }),
    ]);
    expect(await leafStatus(f, second.id)).toEqual({
      projectId: second.id,
      controllers: [],
      unshared: 0,
      syncedCopy: {
        projectId: f.leafProject.id,
        projectName: f.leafProject.name,
        nodeName: "Command",
      },
    });
    expect(await f.commandTicket(own.id)).toBeNull();
  });
});

describe("column order (task 6)", () => {
  test("order within a column stays on each machine and never conflicts", async () => {
    const f = await fleet();
    const first = await f.command.kanban.addKanbanTask(f.commandProject.id, "First", "");
    const second = await f.command.kanban.addKanbanTask(f.commandProject.id, "Second", "");
    await f.sync.sync(LEAF_ID);
    const cursor = (await f.leaf.ticketSync.getTicketSyncCursor(COMMAND_ID, f.leafProject.id))
      .cursor;

    // A drag on the leaf queues nothing for the command node.
    await f.leaf.kanban.updateKanbanTask(second.id, { order: -1 });
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toEqual([]);
    // A drag on the command node is not a change to send.
    await f.command.kanban.updateKanbanTask(first.id, { order: 10 });
    const changes = await f.command.ticketSync.ticketSyncChangesSince(
      f.commandProject.id,
      cursor,
      (await f.leaf.ticketSync.getTicketSyncCursor(COMMAND_ID, f.leafProject.id)).epoch,
    );
    expect(changes.items).toEqual([]);

    // A real change to the ticket keeps the leaf's own order.
    await f.command.kanban.updateKanbanTask(second.id, { title: "Second, renamed" });
    const result = await f.sync.sync(LEAF_ID);
    expect(result.conflicts).toBe(0);
    expect(await f.leafTicket(second.id)).toMatchObject({ title: "Second, renamed", order: -1 });
    expect((await f.commandTicket(second.id))?.order).not.toBe(-1);
  });
});
