import { afterEach, describe, expect, test } from "bun:test";

import { createProject } from "../storage.js";
import { storageInternals } from "../storage-test-support.js";
import {
  cleanupFleets,
  COMMAND_ID,
  fleet,
  LEAF_ID,
  REPO,
  type Fleet,
} from "./node-ticket-sync-test-support.js";

/**
 * Removing a project deletes this machine's rows of its board (to-do 5820,
 * retired). Over sync that is not a deletion of the shared board: nothing is
 * queued for the command node, the command node's tickets stay, and a
 * re-added copy of the repository syncs them again.
 */

afterEach(cleanupFleets);

describe("removing a synced project", () => {
  test("on a leaf, deletes only the leaf's copies, and a re-added project syncs them again", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Shared", "Board");
    expect((await f.sync.sync(LEAF_ID)).state).toBe("in-sync");
    expect(await f.leafTicket(ticket.id)).not.toBeNull();

    await f.leaf.removeProject(f.leafProject.id);
    expect(await f.leafTicket(ticket.id)).toBeNull();
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toEqual([]);

    await f.sync.sync(LEAF_ID);
    expect(await f.commandTicket(ticket.id)).toMatchObject({ title: "Shared" });

    // The same repository added again is a new project here.
    const again = await f.leaf.addProject(createProject(REPO));
    expect((await f.sync.sync(LEAF_ID)).state).toBe("in-sync");
    expect(await f.leafTicket(ticket.id)).toMatchObject({
      projectId: again.id,
      title: "Shared",
      sync: { replica: { controllerId: COMMAND_ID, sourceProjectId: f.commandProject.id } },
    });
  });

  test("on the command node, deletes its board and leaves the leaf's project alone", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Board", "");
    await f.sync.sync(LEAF_ID);
    expect(await f.leafTicket(ticket.id)).not.toBeNull();
    expect(
      (await f.command.ticketSync.getTicketSyncOverview(f.commandProject.id)).peers,
    ).toHaveLength(1);

    await f.command.removeProject(f.commandProject.id);
    expect(await f.commandTicket(ticket.id)).toBeNull();
    const after = await f.command.ticketSync.getTicketSyncOverview(f.commandProject.id);
    expect(after).toMatchObject({ latestSeq: 0, peers: [], conflicts: [] });

    // The leaf's project is its own machine's to remove.
    await f.sync.sync(LEAF_ID);
    expect(await f.leaf.getProject(f.leafProject.id)).not.toBeNull();
    expect(await f.leafTicket(ticket.id)).not.toBeNull();
  });
});

const OTHER_REPO = "https://github.com/acme/other.git";

/** A second synced board, so the leaf has changes for a project that stays. */
async function withSecondBoard(f: Fleet) {
  const commandOther = await f.command.addProject(createProject(OTHER_REPO));
  const leafOther = await f.leaf.addProject(createProject(OTHER_REPO));
  const gone = await f.command.kanban.addKanbanTask(
    f.commandProject.id,
    "On the removed board",
    "",
  );
  const stays = await f.command.kanban.addKanbanTask(commandOther.id, "On the other board", "");
  expect((await f.sync.sync(LEAF_ID)).state).toBe("in-sync");
  expect(await f.leafTicket(gone.id)).not.toBeNull();
  expect(await f.leafTicket(stays.id)).not.toBeNull();
  return { commandOther, leafOther, gone, stays };
}

describe("leaf changes for a command node project that was removed (to-do 8111 task 2)", () => {
  test("are dropped, the leaf's other changes apply, and the leaf keeps its copies as its own", async () => {
    const f = await fleet();
    const { leafOther, gone, stays } = await withSecondBoard(f);
    // Queued in this order: the removed board's change first.
    await f.leaf.kanban.updateKanbanTask(gone.id, { title: "Edited after removal" });
    await f.leaf.kanban.updateKanbanTask(stays.id, { title: "Other board, edited" });
    await f.command.removeProject(f.commandProject.id);

    const result = await f.sync.sync(LEAF_ID);

    expect(result).toMatchObject({ state: "in-sync", dropped: 1 });
    expect((await f.commandTicket(stays.id))?.title).toBe("Other board, edited");
    expect(await f.commandTicket(gone.id)).toBeNull();
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toEqual([]);
    // The copy keeps what it says on the leaf and stops syncing.
    const copy = (await f.leafTicket(gone.id))!;
    expect(copy).toMatchObject({ projectId: f.leafProject.id, title: "Edited after removal" });
    expect(copy.sync?.replica).toBeUndefined();
    const leafLines = await f.leaf.ticketSync.getTicketSyncLeafOverview(f.leafProject.id);
    expect(leafLines.links).toEqual([]);
    // The other board's copies still sync.
    expect((await f.leafTicket(stays.id))?.sync?.replica).toMatchObject({
      controllerId: COMMAND_ID,
    });
    const otherLines = await f.leaf.ticketSync.getTicketSyncLeafOverview(leafOther.id);
    expect(otherLines.links).toHaveLength(1);
    // Later edits to the released copy are not queued for the command node.
    await f.leaf.kanban.updateKanbanTask(gone.id, { title: "Mine now" });
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toEqual([]);
    expect((await f.sync.sync(LEAF_ID)).state).toBe("in-sync");
  });

  test("another command node's copies of a project with the same id stay synced", async () => {
    const f = await fleet();
    await f.leaf.ticketSync.applyTicketSync({
      controllerId: "bk_other_command",
      projectId: f.leafProject.id,
      sourceProjectId: f.commandProject.id,
      epoch: "other-epoch",
      cursor: 1,
      items: [
        {
          id: "other-copy",
          seq: 1,
          revs: { title: 1, content: 1, status: 1 },
          title: "Other command node's copy",
          description: "",
          acceptanceCriteria: "",
          status: "backlog",
          comments: [],
          images: [],
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    });
    const epoch = (await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).epoch ?? "none";
    await f.leaf.ticketSync.ackTicketSyncOutbox(COMMAND_ID, epoch, 0, [f.commandProject.id]);
    expect((await f.leafTicket("other-copy"))?.sync?.replica).toMatchObject({
      controllerId: "bk_other_command",
      sourceProjectId: f.commandProject.id,
    });
  });

  test("stay queued, in order, when the command node cannot read its projects store", async () => {
    const f = await fleet();
    const { gone, stays } = await withSecondBoard(f);
    await f.leaf.kanban.updateKanbanTask(gone.id, { title: "Edited after removal" });
    await f.leaf.kanban.updateKanbanTask(stays.id, { title: "Other board, edited" });
    await f.command.removeProject(f.commandProject.id);
    const strict = f.command.loadProjectIdsForCleanup.bind(f.command);
    f.command.loadProjectIdsForCleanup = async () => {
      throw new Error("Project store is missing or invalid; cleanup refused");
    };

    const result = await f.sync.sync(LEAF_ID);

    expect(result.state).toBe("error");
    expect(result.dropped).toBeUndefined();
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toHaveLength(2);
    expect((await f.commandTicket(stays.id))?.title).toBe("On the other board");
    expect((await f.leafTicket(gone.id))?.sync?.replica).toBeDefined();

    // Readable again: the next sync settles both.
    f.command.loadProjectIdsForCleanup = strict;
    expect(await f.sync.sync(LEAF_ID)).toMatchObject({ state: "in-sync", dropped: 1 });
    expect((await f.commandTicket(stays.id))?.title).toBe("Other board, edited");
  });

  test("for a project still being removed are neither applied nor acknowledged, nor is anything after them", async () => {
    const f = await fleet();
    const { gone, stays } = await withSecondBoard(f);
    await f.leaf.kanban.updateKanbanTask(gone.id, { title: "Edited during removal" });
    await f.leaf.kanban.updateKanbanTask(stays.id, { title: "Other board, edited" });
    const kanban = storageInternals(f.command).repos.kanban;
    kanban.fenceProjectContent(f.commandProject.id);

    const result = await f.sync.sync(LEAF_ID);

    expect(result.state).toBe("error");
    expect((await f.leaf.ticketSync.collectTicketSyncOutbox(COMMAND_ID, 0)).items).toHaveLength(2);
    expect((await f.commandTicket(stays.id))?.title).toBe("On the other board");

    // A removal that failed and kept the project lets them through.
    kanban.releaseProjectContentFence(f.commandProject.id);
    expect((await f.sync.sync(LEAF_ID)).state).toBe("in-sync");
    expect((await f.commandTicket(gone.id))?.title).toBe("Edited during removal");
    expect((await f.commandTicket(stays.id))?.title).toBe("Other board, edited");
  });

  test("from a pre-contract leaf are dropped too, and its acknowledgement carries only the keys it accepts", async () => {
    const f = await fleet({ domains: null });
    const { gone, stays } = await withSecondBoard(f);
    await f.leaf.kanban.updateKanbanTask(gone.id, { title: "Edited after removal" });
    await f.leaf.kanban.updateKanbanTask(stays.id, { title: "Other board, edited" });
    await f.command.removeProject(f.commandProject.id);

    expect(await f.sync.sync(LEAF_ID)).toMatchObject({ state: "in-sync", dropped: 1 });
    expect((await f.commandTicket(stays.id))?.title).toBe("Other board, edited");
    const acks = f.requests.filter(({ command }) => command === "ack_ticket_sync_outbox");
    expect(acks.length).toBeGreaterThan(0);
    for (const { args } of acks) {
      expect(Object.keys(args).sort()).toEqual(["controllerId", "epoch", "upTo"]);
    }
    // Such a leaf is not told, so its copy still names the removed board.
    expect((await f.leafTicket(gone.id))?.sync?.replica).toBeDefined();
  });
});
