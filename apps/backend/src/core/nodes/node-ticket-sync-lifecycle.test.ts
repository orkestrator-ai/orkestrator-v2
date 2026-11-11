import { afterEach, describe, expect, test } from "bun:test";

import {
  BUILD_ENVIRONMENT_DELETED_COMMENT,
  settleTicketsOfDeletedEnvironment,
} from "../build-pipeline-kanban-environment-deleted.js";
import { lifecycleMachine, PR_URL } from "../build-pipeline-kanban-transitions-test-support.js";
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
    await board();
    await f.command.kanban.updateKanbanTask(ticket.id, { status: "in-progress" });
    await f.sync.sync(LEAF_ID);
    expect(await f.leaf.kanban.returnKanbanTaskForClosedPullRequest(ticket.id, PR_URL)).toBe(false);
    expect((await board())?.status).toBe("in-progress");
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
