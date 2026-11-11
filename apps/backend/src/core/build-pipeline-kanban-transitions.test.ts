import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BUILD_ENVIRONMENT_DELETED_COMMENT,
  settleTicketsOfDeletedEnvironment,
} from "./build-pipeline-kanban-environment-deleted.js";
import { BUILD_PIPELINE_BUILD_STARTED_COMMENT } from "./build-pipeline-kanban-lifecycle.js";
import {
  delivery,
  lifecycleMachine,
  PR_URL,
  type LifecycleMachine,
} from "./build-pipeline-kanban-transitions-test-support.js";
import { StorageService } from "./storage.js";

const PR_B_URL = "https://github.com/acme/repo/pull/8";

/**
 * The ticket state machine for a build (docs/architecture/tickets.md,
 * "Build lifecycle"), driven through the real recovery and storage on one
 * machine. The same transitions on a leaf, reaching the command node's
 * board, are in `nodes/node-ticket-sync-lifecycle.test.ts`.
 */

const dirs: string[] = [];
const stores: StorageService[] = [];

afterEach(async () => {
  for (const storage of stores.splice(0)) storage.close?.();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function machine(): Promise<{
  storage: StorageService;
  life: LifecycleMachine;
  ticket: () => Promise<string>;
  read: (id: string) => ReturnType<StorageService["kanban"]["getKanbanTask"]>;
}> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "ork-ticket-lifecycle-"));
  dirs.push(dir);
  const storage = new StorageService(dir);
  await storage.init();
  stores.push(storage);
  const life = await lifecycleMachine(storage, "env-1", "project-1");
  return {
    storage,
    life,
    ticket: async () => (await storage.kanban.addKanbanTask("project-1", "Ticket", "Body")).id,
    read: (id) => storage.kanban.getKanbanTask(id),
  };
}

describe("Backlog → In progress → Review → Done", () => {
  test("a build moves its ticket through every column, and the merge closes it", async () => {
    const { storage, life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    expect((await read(id))?.status).toBe("backlog");

    await life.started(pipeline);
    expect(await read(id)).toMatchObject({ status: "in-progress", lifecycleStatus: "in-progress" });
    expect((await read(id))?.comments.map((c) => c.text)).toContain(
      BUILD_PIPELINE_BUILD_STARTED_COMMENT,
    );

    await life.prDetected(pipeline, "open");
    expect(await read(id)).toMatchObject({ status: "review", prUrl: PR_URL, prState: "open" });

    await life.ended(pipeline, "complete");
    expect((await read(id))?.status).toBe("review");

    // The PR monitor sees the merge.
    await storage.kanban.closeKanbanTasksForMergedPullRequests([{ taskId: id, prUrl: PR_URL }]);
    expect(await read(id)).toMatchObject({ status: "done", prMergeDoneUrl: PR_URL });
  });

  for (const policy of ["commit-only", "push-no-pr"] as const) {
    test(`a ${policy} build that finishes moves its ticket to review`, async () => {
      const { life, ticket, read } = await machine();
      const id = await ticket();
      const pipeline = life.pipeline(id, { delivery: delivery(policy) });
      await life.started(pipeline);
      await life.ended(pipeline, "complete");
      expect((await read(id))?.status).toBe("review");
    });
  }

  test("a failed or cancelled build sends its ticket back to the backlog", async () => {
    const { life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await life.started(pipeline);
    await life.ended(pipeline, "failed");
    expect(await read(id)).toMatchObject({ status: "backlog", lifecycleStatus: "backlog" });
  });

  test("a restart moves a backlog ticket back to in progress", async () => {
    const { life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await life.started(pipeline);
    await life.ended(pipeline, "failed");
    pipeline.phase = "building";
    await life.recovery.updateKanbanLifecycle(
      pipeline,
      { status: "in-progress" },
      {
        requireTicket: true,
      },
    );
    expect((await read(id))?.status).toBe("in-progress");
  });
});

describe("a merged pull request", () => {
  test("found again after the merge closed the ticket leaves it done (the stuck Review ticket)", async () => {
    const { storage, life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    // The PR monitor sees the merge first and closes the ticket.
    await storage.kanban.closeKanbanTasksForMergedPullRequests([{ taskId: id, prUrl: PR_URL }]);
    // Conflict resolution (or a Ship retry) then finds the same pull request merged.
    await life.prDetected(pipeline, "merged");
    await life.ended(pipeline, "complete");
    expect(await read(id)).toMatchObject({
      status: "done",
      prMergeDoneUrl: PR_URL,
      prState: "merged",
    });
  });

  test("found merged by Ship closes the ticket itself", async () => {
    const { life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await life.started(pipeline);
    await life.prDetected(pipeline, "merged");
    expect(await read(id)).toMatchObject({ status: "done", prMergeDoneUrl: PR_URL });
  });

  test("a done ticket is never reopened by a later build start, restart or ending", async () => {
    const { storage, life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await life.started(pipeline);
    await storage.kanban.closeKanbanTasksForMergedPullRequests([{ taskId: id, prUrl: PR_URL }]);
    await life.started(life.pipeline(id, { id: "pipeline-again" }));
    await life.recovery.updateKanbanLifecycle(
      pipeline,
      { status: "in-progress" },
      {
        requireTicket: true,
      },
    );
    await life.ended(pipeline, "failed");
    expect((await read(id))?.status).toBe("done");
  });
});

describe("a pull request closed without merging", () => {
  test("sends a ticket the build put in review back to the backlog", async () => {
    const { storage, life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    await life.ended(pipeline, "complete");
    expect(await storage.kanban.returnKanbanTaskForClosedPullRequest(id, PR_URL)).toBe(true);
    expect(await read(id)).toMatchObject({ status: "backlog", lifecycleStatus: "backlog" });
  });

  test("leaves a ticket the user moved by hand since the build where it is", async () => {
    const { storage, life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    await storage.kanban.updateKanbanTask(id, { status: "in-progress" });
    expect(await storage.kanban.returnKanbanTaskForClosedPullRequest(id, PR_URL)).toBe(false);
    expect((await read(id))?.status).toBe("in-progress");
  });

  test("leaves a ticket the user moved away and back to its build's column", async () => {
    const { storage, life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    await storage.kanban.updateKanbanTask(id, { status: "backlog" });
    await storage.kanban.updateKanbanTask(id, { status: "review" });
    expect(await storage.kanban.returnKanbanTaskForClosedPullRequest(id, PR_URL)).toBe(false);
    expect((await read(id))?.status).toBe("review");
  });

  test("of an older build leaves the ticket of a newer build where it is", async () => {
    const { storage, life, ticket, read } = await machine();
    const newer = await lifecycleMachine(storage, "env-2", "project-1");
    const id = await ticket();
    const first = life.pipeline(id);
    await life.started(first);
    await life.prDetected(first, "open");
    await life.ended(first, "failed");
    // A second build of the same ticket, in another environment.
    const second = newer.pipeline(id, { id: `pipeline-${id}-2`, environmentId: "env-2" });
    await newer.started(second);
    // In progress with no pull request of its own yet.
    expect(await storage.kanban.returnKanbanTaskForClosedPullRequest(id, PR_URL)).toBe(false);
    expect((await read(id))?.status).toBe("in-progress");
    await newer.prDetected(second, "open", PR_B_URL);
    expect((await read(id))?.status).toBe("review");
    // The first build's pull request closing, through the monitor of its
    // environment, is not the newer build's to act on.
    expect(await storage.kanban.returnKanbanTaskForClosedPullRequest(id, PR_URL)).toBe(false);
    expect((await read(id))?.status).toBe("review");
    // The newer build's own pull request closing still returns it.
    expect(await storage.kanban.returnKanbanTaskForClosedPullRequest(id, PR_B_URL)).toBe(true);
    expect((await read(id))?.status).toBe("backlog");
  });

  test("found by the build itself returns the ticket, once, before the monitor sees it", async () => {
    const { storage, life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    // A conflict resolution re-detects the pull request, now closed: the
    // closed link is recorded and the ticket returns in the same step.
    await life.prDetected(pipeline, "closed");
    expect(await read(id)).toMatchObject({
      status: "backlog",
      prUrl: PR_URL,
      prState: "closed",
      prClosedReturnUrl: PR_URL,
    });
    // The user picks it up again; the monitor's observation of the same
    // closure (or a replay after a restart) keeps that move.
    await storage.kanban.updateKanbanTask(id, { status: "review" });
    expect(await storage.kanban.returnKanbanTaskForClosedPullRequest(id, PR_URL)).toBe(false);
    expect((await read(id))?.status).toBe("review");
  });

  test("and a build that then completes sends the ticket to the backlog, not review", async () => {
    const { storage, life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    await life.prDetected(pipeline, "closed");
    await life.ended(pipeline, "complete");
    expect((await read(id))?.status).toBe("backlog");
    expect(await storage.kanban.returnKanbanTaskForClosedPullRequest(id, PR_URL)).toBe(false);
  });

  test("never touches a done ticket, or one no build has moved", async () => {
    const { storage, ticket, read } = await machine();
    const untouched = await ticket();
    await storage.kanban.updateKanbanTask(untouched, { status: "review" });
    expect(await storage.kanban.returnKanbanTaskForClosedPullRequest(untouched, PR_URL)).toBe(
      false,
    );
    const done = await ticket();
    await storage.kanban.updateKanbanTask(done, { status: "done" });
    expect(await storage.kanban.returnKanbanTaskForClosedPullRequest(done, PR_URL)).toBe(false);
    expect((await read(untouched))?.status).toBe("review");
    expect((await read(done))?.status).toBe("done");
  });
});

describe("a manual move", () => {
  test("is kept until the next lifecycle event, which then moves the ticket", async () => {
    const { storage, life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await life.started(pipeline);
    await storage.kanban.updateKanbanTask(id, { status: "backlog" });
    expect((await read(id))?.status).toBe("backlog");
    // The hand move clears the lifecycle's claim on the column.
    expect((await read(id))?.lifecycleStatus).toBeUndefined();
    await life.prDetected(pipeline, "open");
    expect(await read(id)).toMatchObject({ status: "review", lifecycleStatus: "review" });
  });

  test("cannot forge the lifecycle marker", async () => {
    const { storage, ticket, read } = await machine();
    const id = await ticket();
    await storage.kanban.updateKanbanTask(id, {
      status: "review",
      lifecycleStatus: "review",
    } as never);
    expect((await read(id))?.lifecycleStatus).toBeUndefined();
  });
});

describe("an environment deleted with its build", () => {
  test("sends the ticket of an unfinished build back to the backlog, saying why", async () => {
    const { storage, life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await storage.kanban.updateKanbanTask(id, { buildPipelineId: pipeline.id });
    await saveRecord(storage, pipeline);
    await life.started(pipeline);
    await settleTicketsOfDeletedEnvironment(storage, (await storage.getEnvironment("env-1"))!);
    const after = await read(id);
    expect(after?.status).toBe("backlog");
    expect(after?.comments.map((c) => c.text)).toContain(BUILD_ENVIRONMENT_DELETED_COMMENT);
  });

  test("closes the ticket when the environment's pull request merged", async () => {
    const { storage, life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await saveRecord(storage, pipeline);
    await life.started(pipeline);
    await storage.updateEnvironment("env-1", { prUrl: PR_URL, prState: "merged" });
    await settleTicketsOfDeletedEnvironment(storage, (await storage.getEnvironment("env-1"))!);
    expect(await read(id)).toMatchObject({ status: "done", prMergeDoneUrl: PR_URL });
  });

  test("leaves the ticket of a finished build in review", async () => {
    const { storage, life, ticket, read } = await machine();
    const id = await ticket();
    const pipeline = life.pipeline(id);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    await life.ended(pipeline, "complete");
    await saveRecord(storage, pipeline);
    await settleTicketsOfDeletedEnvironment(storage, (await storage.getEnvironment("env-1"))!);
    expect((await read(id))?.status).toBe("review");
  });
});

async function saveRecord(
  storage: StorageService,
  pipeline: ReturnType<LifecycleMachine["pipeline"]>,
): Promise<void> {
  await storage.saveBuildPipeline(
    pipeline.id,
    pipeline.projectId,
    pipeline.environmentId,
    1,
    pipeline,
  );
}
