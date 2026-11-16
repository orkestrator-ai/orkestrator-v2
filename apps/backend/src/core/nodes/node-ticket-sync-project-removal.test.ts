import { afterEach, describe, expect, test } from "bun:test";

import { createProject } from "../storage.js";
import {
  cleanupFleets,
  COMMAND_ID,
  fleet,
  LEAF_ID,
  REPO,
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
