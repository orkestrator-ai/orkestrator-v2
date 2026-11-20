import { afterEach, describe, expect, test } from "bun:test";

import {
  BUILD_ENVIRONMENT_DELETED_COMMENT,
  settleTicketsOfDeletedEnvironment,
} from "../build-pipeline/kanban-environment-deleted.js";
import { lifecycleMachine, PR_URL } from "../build-pipeline/kanban-transitions-test-support.js";
import { cleanupFleets, fleet, LEAF_ID, type Fleet } from "./node-ticket-sync-test-support.js";

/**
 * A build that runs on a leaf, for a ticket of the command node's board (the
 * coordinator's `create_ticket nodeId` + `start_build_pipeline nodeId`): the
 * real lifecycle writes the leaf's copy, and the command node's board, which
 * is the one the user looks at, follows every column through the leaf's
 * outbox. Two real storage services over the in-process link
 * (`node-ticket-sync-test-support.ts`).
 */

afterEach(cleanupFleets);

async function leafBuild(f: Fleet) {
  const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Remote", "Body");
  await f.sync.sync(LEAF_ID);
  const life = await lifecycleMachine(f.leaf, "leaf-env", f.leafProject.id);
  const pipeline = life.pipeline(ticket.id);
  const board = async () => {
    await f.sync.sync(LEAF_ID);
    return f.commandTicket(ticket.id);
  };
  return { ticket, life, pipeline, board };
}

describe("a build on a leaf moves the command node's ticket", () => {
  test("through In progress, Review and Done", async () => {
    const f = await fleet();
    const { ticket, life, pipeline, board } = await leafBuild(f);

    await life.started(pipeline);
    expect((await board())?.status).toBe("in-progress");

    await life.prDetected(pipeline, "open");
    await life.ended(pipeline, "complete");
    const reviewed = await board();
    expect(reviewed?.status).toBe("review");
    expect(reviewed?.sync?.work).toMatchObject({ nodeId: LEAF_ID, prUrl: PR_URL });

    // The leaf's PR monitor sees the merge.
    await f.leaf.kanban.closeKanbanTasksForMergedPullRequests([
      { taskId: ticket.id, prUrl: PR_URL },
    ]);
    expect(await board()).toMatchObject({ status: "done", prMergeDoneUrl: PR_URL });
    expect((await f.sync.sync(LEAF_ID)).conflicts).toBe(0);
  });

  test("and a pull request found again after the merge does not reopen it", async () => {
    const f = await fleet();
    const { ticket, life, pipeline, board } = await leafBuild(f);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    await f.leaf.kanban.closeKanbanTasksForMergedPullRequests([
      { taskId: ticket.id, prUrl: PR_URL },
    ]);
    await life.prDetected(pipeline, "merged");
    await life.ended(pipeline, "complete");
    expect((await board())?.status).toBe("done");
    expect((await f.leafTicket(ticket.id))?.status).toBe("done");
  });

  test("back to the backlog when the build fails", async () => {
    const f = await fleet();
    const { life, pipeline, board } = await leafBuild(f);
    await life.started(pipeline);
    expect((await board())?.status).toBe("in-progress");
    await life.ended(pipeline, "failed");
    expect((await board())?.status).toBe("backlog");
  });

  test("back to the backlog when its pull request closes without merging", async () => {
    const f = await fleet();
    const { ticket, life, pipeline, board } = await leafBuild(f);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    await life.ended(pipeline, "complete");
    expect((await board())?.status).toBe("review");
    await f.leaf.kanban.returnKanbanTaskForClosedPullRequest(ticket.id, PR_URL);
    expect((await board())?.status).toBe("backlog");
  });

  test("but a move the user made on the command node is respected when the pull request closes", async () => {
    const f = await fleet();
    const { ticket, life, pipeline, board } = await leafBuild(f);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    // A hand move waits for the build to end (`build-pipeline/ticket-hold.ts`).
    await life.ended(pipeline, "complete");
    await board();
    await f.command.kanban.updateKanbanTask(ticket.id, { status: "in-progress" });
    await f.sync.sync(LEAF_ID);
    expect(await f.leaf.kanban.returnKanbanTaskForClosedPullRequest(ticket.id, PR_URL)).toBe(false);
    expect((await board())?.status).toBe("in-progress");
  });

  test("but a ticket moved away and back on the command node stays where the user put it", async () => {
    const f = await fleet();
    const { ticket, life, pipeline, board } = await leafBuild(f);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    // A hand move waits for the build to end (`build-pipeline/ticket-hold.ts`).
    await life.ended(pipeline, "complete");
    // The leaf's own move, seen back from the command node, is still the build's.
    expect((await board())?.status).toBe("review");
    expect((await f.leafTicket(ticket.id))?.lifecycleStatus).toBe("review");
    await f.command.kanban.updateKanbanTask(ticket.id, { status: "backlog" });
    await f.sync.sync(LEAF_ID);
    await f.command.kanban.updateKanbanTask(ticket.id, { status: "review" });
    await f.sync.sync(LEAF_ID);
    expect(await f.leaf.kanban.returnKanbanTaskForClosedPullRequest(ticket.id, PR_URL)).toBe(false);
    expect((await board())?.status).toBe("review");
  });

  test("even when the leaf pulls only after the ticket is back in its column", async () => {
    const f = await fleet();
    const { ticket, life, pipeline, board } = await leafBuild(f);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    // A hand move waits for the build to end (`build-pipeline/ticket-hold.ts`).
    await life.ended(pipeline, "complete");
    await board();
    await f.command.kanban.updateKanbanTask(ticket.id, { status: "backlog" });
    await f.command.kanban.updateKanbanTask(ticket.id, { status: "review" });
    await f.sync.sync(LEAF_ID);
    expect((await f.leafTicket(ticket.id))?.lifecycleStatus).toBeUndefined();
    expect(await f.leaf.kanban.returnKanbanTaskForClosedPullRequest(ticket.id, PR_URL)).toBe(false);
    expect((await board())?.status).toBe("review");
  });

  test("and a ticket moved away and back on the leaf stays where the user put it", async () => {
    const f = await fleet();
    const { ticket, life, pipeline, board } = await leafBuild(f);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    // A hand move waits for the build to end (`build-pipeline/ticket-hold.ts`).
    await life.ended(pipeline, "complete");
    await board();
    await f.leaf.kanban.updateKanbanTask(ticket.id, { status: "backlog" });
    await f.leaf.kanban.updateKanbanTask(ticket.id, { status: "review" });
    await board();
    expect(await f.leaf.kanban.returnKanbanTaskForClosedPullRequest(ticket.id, PR_URL)).toBe(false);
    expect((await board())?.status).toBe("review");
  });

  test("back to the backlog when the leaf deletes the environment mid-build", async () => {
    const f = await fleet();
    const { life, pipeline, board } = await leafBuild(f);
    await f.leaf.saveBuildPipeline(pipeline.id, pipeline.projectId, "leaf-env", 1, pipeline);
    await life.started(pipeline);
    expect((await board())?.status).toBe("in-progress");
    await settleTicketsOfDeletedEnvironment(f.leaf, (await f.leaf.getEnvironment("leaf-env"))!);
    const after = await board();
    expect(after?.status).toBe("backlog");
    expect(after?.comments.map((comment) => comment.text)).toContain(
      BUILD_ENVIRONMENT_DELETED_COMMENT,
    );
  });
});

describe("a build holds its ticket's column across machines", () => {
  test("a move on the command node while the leaf builds returns to the build's column", async () => {
    const f = await fleet();
    const { ticket, life, pipeline, board } = await leafBuild(f);
    await f.leaf.saveBuildPipeline(pipeline.id, pipeline.projectId, "leaf-env", 1, pipeline);
    await life.started(pipeline);
    expect((await board())?.status).toBe("in-progress");

    await f.command.kanban.updateKanbanTask(ticket.id, { status: "backlog", title: "Renamed" });
    // The leaf keeps its column and sends it back; the edit itself stays.
    await f.sync.sync(LEAF_ID);
    expect((await f.leafTicket(ticket.id))?.status).toBe("in-progress");
    expect(await board()).toMatchObject({ status: "in-progress", title: "Renamed" });
    expect((await f.sync.sync(LEAF_ID)).conflicts).toBe(0);

    // Once the build ends, the column is the user's again.
    await life.ended(pipeline, "failed");
    expect((await board())?.status).toBe("backlog");
    await f.command.kanban.updateKanbanTask(ticket.id, { status: "review" });
    await f.sync.sync(LEAF_ID);
    expect((await f.leafTicket(ticket.id))?.status).toBe("review");
  });

  test.each([false, true])(
    "keeps PR ownership after a command move (returned before sync: %s)",
    async (movesBack) => {
      const f = await fleet();
      const { ticket, life, pipeline, board } = await leafBuild(f);
      await f.leaf.saveBuildPipeline(pipeline.id, pipeline.projectId, "leaf-env", 1, pipeline);
      await life.started(pipeline);
      await life.prDetected(pipeline, "open");
      expect((await board())?.status).toBe("review");

      const moved = await f.command.kanban.updateKanbanTask(ticket.id, { status: "backlog" });
      if (movesBack) await f.command.kanban.updateKanbanTask(ticket.id, { status: "review" });
      await board();
      const restored = await board();
      expect(restored?.status).toBe("review");
      if (!movesBack) {
        expect(moved.sync?.revs.status).toBeNumber();
        expect(restored?.sync?.rejectedStatusRevision).toBe(moved.sync?.revs.status);
      }
      expect(await f.leafTicket(ticket.id)).toMatchObject({
        lifecycleStatus: "review",
        lifecyclePrUrl: PR_URL,
      });
      await life.ended(pipeline, "complete");
      expect(await f.leaf.kanban.returnKanbanTaskForClosedPullRequest(ticket.id, PR_URL)).toBe(
        true,
      );
      expect((await board())?.status).toBe("backlog");
    },
  );

  test.each([false, true])(
    "distinguishes a corrective echo from a hand move after release (hand move: %s)",
    async (handMoveAfterRelease) => {
      const f = await fleet();
      const { ticket, life, pipeline, board } = await leafBuild(f);
      await f.leaf.saveBuildPipeline(pipeline.id, pipeline.projectId, "leaf-env", 1, pipeline);
      await life.started(pipeline);
      await life.prDetected(pipeline, "open");
      await board();

      await f.command.kanban.updateKanbanTask(ticket.id, { status: "backlog" });
      // This pull queues the correction. The next sync carries it back.
      expect((await board())?.status).toBe("backlog");
      await life.ended(pipeline, "complete");
      if (handMoveAfterRelease) {
        await f.command.kanban.updateKanbanTask(ticket.id, { status: "review" });
      }
      expect((await board())?.status).toBe("review");
      expect((await f.leafTicket(ticket.id))?.lifecyclePrUrl).toBe(
        handMoveAfterRelease ? undefined : PR_URL,
      );
      expect(await f.leaf.kanban.returnKanbanTaskForClosedPullRequest(ticket.id, PR_URL)).toBe(
        !handMoveAfterRelease,
      );
    },
  );

  test.each(["command", "leaf"] as const)(
    "a merge on the %s reaches Done on both boards despite active builds",
    async (origin) => {
      const f = await fleet();
      const { ticket, life, pipeline, board } = await leafBuild(f);
      const local = await lifecycleMachine(f.command, "command-env", f.commandProject.id);
      const localPipeline = local.pipeline(ticket.id);
      await f.command.saveBuildPipeline(
        localPipeline.id,
        localPipeline.projectId,
        "command-env",
        1,
        localPipeline,
      );
      await local.started(localPipeline);
      await f.leaf.saveBuildPipeline(pipeline.id, pipeline.projectId, "leaf-env", 1, pipeline);
      await board();
      await life.prDetected(pipeline, "open");

      const merge = [{ taskId: ticket.id, prUrl: PR_URL }];
      await f[origin].kanban.closeKanbanTasksForMergedPullRequests(merge);
      await board();
      expect(await board()).toMatchObject({ status: "done", prMergeDoneUrl: PR_URL });
      expect(await f.leafTicket(ticket.id)).toMatchObject({
        status: "done",
        prMergeDoneUrl: PR_URL,
      });
      expect(await f.leaf.kanban.closeKanbanTasksForMergedPullRequests(merge)).toEqual([]);
      expect(await f.command.kanban.closeKanbanTasksForMergedPullRequests(merge)).toEqual([]);
    },
  );

  test("competing builds converge to the command node's column and stop sending corrections", async () => {
    const f = await fleet();
    const { ticket, life, pipeline, board } = await leafBuild(f);
    const local = await lifecycleMachine(f.command, "command-env", f.commandProject.id);
    const localPipeline = local.pipeline(ticket.id);
    await f.command.saveBuildPipeline(
      localPipeline.id,
      localPipeline.projectId,
      "command-env",
      1,
      localPipeline,
    );
    await local.started(localPipeline);
    await f.leaf.saveBuildPipeline(pipeline.id, pipeline.projectId, "leaf-env", 1, pipeline);
    await board();
    await life.prDetected(pipeline, "open");
    expect((await f.leafTicket(ticket.id))?.status).toBe("review");

    const settled = await board();
    expect(settled?.status).toBe("in-progress");
    expect((await f.leafTicket(ticket.id))?.status).toBe("in-progress");
    for (let round = 0; round < 3; round += 1) {
      expect((await board())?.sync?.seq).toBe(settled?.sync?.seq);
    }
  });

  test("a move on a leaf while the command node builds returns to the build's column", async () => {
    const f = await fleet();
    const ticket = await f.command.kanban.addKanbanTask(f.commandProject.id, "Local", "Body");
    await f.sync.sync(LEAF_ID);
    const life = await lifecycleMachine(f.command, "command-env", f.commandProject.id);
    const pipeline = life.pipeline(ticket.id);
    await f.command.saveBuildPipeline(pipeline.id, pipeline.projectId, "command-env", 1, pipeline);
    await life.started(pipeline);
    await f.sync.sync(LEAF_ID);
    expect((await f.leafTicket(ticket.id))?.status).toBe("in-progress");

    await f.leaf.kanban.updateKanbanTask(ticket.id, { status: "backlog" });
    await f.sync.sync(LEAF_ID);
    expect((await f.commandTicket(ticket.id))?.status).toBe("in-progress");
    await f.sync.sync(LEAF_ID);
    expect((await f.leafTicket(ticket.id))?.status).toBe("in-progress");
  });
});

test("the command node's startup sweep closes a ticket whose leaf reported only a merged pull request", async () => {
  const f = await fleet();
  const { ticket, life, pipeline } = await leafBuild(f);
  await life.started(pipeline);
  await life.prDetected(pipeline, "open");
  await life.ended(pipeline, "complete");
  // An older leaf recorded the merge on its copy but never moved it.
  await f.leaf.kanban.updateKanbanTask(ticket.id, { prState: "merged" });
  await f.sync.sync(LEAF_ID);
  expect((await f.commandTicket(ticket.id))?.sync?.work?.prState).toBe("merged");
  expect(await f.command.kanban.closeKanbanTasksForMergedPullRequests()).toEqual([ticket.id]);
  await f.sync.sync(LEAF_ID);
  expect((await f.leafTicket(ticket.id))?.status).toBe("done");
});
