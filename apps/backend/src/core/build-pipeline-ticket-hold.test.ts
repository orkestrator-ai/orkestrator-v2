import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ticketHeldByBuild, ticketsHeldByBuilds } from "./build-pipeline-ticket-hold.js";
import { BUILD_PIPELINE_BUILD_STARTED_COMMENT } from "./build-pipeline-kanban-lifecycle.js";
import { lifecycleMachine, PR_URL } from "./build-pipeline-kanban-transitions-test-support.js";
import { startBuilding, startInput, withService } from "./build-pipeline-service-test-support.js";
import { StorageService } from "./storage.js";

const kanban = (taskId: string) => ({ taskId, source: { type: "kanban" as const, taskId } });

const record = (snapshot: unknown) => ({ snapshot }) as Parameters<typeof ticketHeldByBuild>[0];

describe("which tickets a build holds", () => {
  test("an unfinished build holds the Kanban ticket it reports to", () => {
    for (const phase of ["creating-environment", "building", "reviewing", "paused"]) {
      expect(ticketHeldByBuild(record({ phase, source: { type: "kanban", taskId: "t" } }))).toBe(
        "t",
      );
    }
  });

  test("an ended build, or one with no Kanban ticket, holds nothing", () => {
    for (const phase of ["complete", "failed"]) {
      expect(
        ticketHeldByBuild(record({ phase, source: { type: "kanban", taskId: "t" } })),
      ).toBeUndefined();
    }
    expect(
      ticketHeldByBuild(record({ phase: "building", source: { type: "linear", issueId: "t" } })),
    ).toBeUndefined();
    expect(ticketHeldByBuild(record({ phase: "building", taskId: "t" }))).toBeUndefined();
    expect(ticketHeldByBuild(record(null))).toBeUndefined();
    expect(
      ticketsHeldByBuilds([
        record({ phase: "building", source: { type: "kanban", taskId: "a" } }),
        record({ phase: "failed", source: { type: "kanban", taskId: "b" } }),
      ]),
    ).toEqual(new Set(["a"]));
  });
});

describe("the board while a build holds a ticket", () => {
  const dirs: string[] = [];
  const stores: StorageService[] = [];
  afterEach(async () => {
    for (const storage of stores.splice(0)) storage.close?.();
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  async function building() {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "ork-ticket-hold-"));
    dirs.push(dir);
    const storage = new StorageService(dir);
    await storage.init();
    stores.push(storage);
    const life = await lifecycleMachine(storage, "env-1", "project-1");
    const id = (await storage.kanban.addKanbanTask("project-1", "Ticket", "Body")).id;
    const pipeline = life.pipeline(id);
    await storage.saveBuildPipeline(pipeline.id, "project-1", "env-1", 1, pipeline);
    await life.started(pipeline);
    return { storage, life, pipeline, id, read: () => storage.kanban.getKanbanTask(id) };
  }

  test("keeps the column but applies the rest of an edit", async () => {
    const { storage, id, read } = await building();
    const updated = await storage.kanban.updateKanbanTask(id, {
      status: "backlog",
      title: "Renamed",
    });
    expect(updated).toMatchObject({ status: "in-progress", title: "Renamed" });
    expect(await read()).toMatchObject({ status: "in-progress", title: "Renamed" });
    await storage.kanban.addKanbanComment(id, "Still editable");
    expect((await read())?.comments.map((comment) => comment.text)).toContain("Still editable");
  });

  test("lets the build's own lifecycle move it", async () => {
    const { life, pipeline, read } = await building();
    await life.prDetected(pipeline, "open");
    expect((await read())?.status).toBe("review");
  });

  test("leaves a closed pull request undecided until the build ends", async () => {
    const { storage, life, pipeline, id, read } = await building();
    await life.prDetected(pipeline, "open");
    expect(await storage.kanban.returnKanbanTaskForClosedPullRequest(id, PR_URL)).toBe(false);
    expect((await read())?.prClosedReturnUrl).toBeUndefined();
    await life.ended(pipeline, "complete");
    expect(await storage.kanban.returnKanbanTaskForClosedPullRequest(id, PR_URL)).toBe(true);
    expect((await read())?.status).toBe("backlog");
  });

  test("still holds a paused build's ticket", async () => {
    const { storage, pipeline, id, read } = await building();
    await storage.saveBuildPipeline(pipeline.id, "project-1", "env-1", 1, {
      ...pipeline,
      phase: "paused",
    });
    await storage.kanban.updateKanbanTask(id, { status: "done" });
    expect((await read())?.status).toBe("in-progress");
  });

  test("gives the column back once the build ends", async () => {
    const { storage, life, pipeline, id, read } = await building();
    await life.ended(pipeline, "failed");
    expect((await read())?.status).toBe("backlog");
    await storage.kanban.updateKanbanTask(id, { status: "review" });
    expect((await read())?.status).toBe("review");
  });
});

describe("a build started from a ticket", () => {
  test("moves it to In progress at admission, before its environment exists", async () => {
    await withService(
      async (service, storage, _provider, invocations) => {
        const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body");
        await service.start(startInput({ ...kanban(task.id), existingEnvironmentId: undefined }));
        const moved = invocations.findIndex(
          (call) => call.command === "update_kanban_task" && call.args.status === "in-progress",
        );
        const created = invocations.findIndex((call) => call.command === "create_environment");
        expect(moved).toBeGreaterThanOrEqual(0);
        expect(moved).toBeLessThan(created);
        const ticket = await storage.kanban.getKanbanTask(task.id);
        expect(ticket?.status).toBe("in-progress");
        // The comment still marks the build stage starting.
        expect(ticket?.comments.map((comment) => comment.text)).not.toContain(
          BUILD_PIPELINE_BUILD_STARTED_COMMENT,
        );
      },
      { realKanban: true },
    );
  });

  test("a provisioning failure returns an admitted ticket to Backlog", async () => {
    await withService(
      async (service, storage, _provider, invocations, controls) => {
        const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body");
        controls.failCommands.add("create_environment");
        await expect(
          service.start(startInput({ ...kanban(task.id), existingEnvironmentId: undefined })),
        ).rejects.toThrow("create_environment failed");
        expect(
          invocations
            .filter((call) => call.command === "update_kanban_task" && call.args.status)
            .map((call) => call.args.status),
        ).toEqual(["in-progress", "backlog"]);
        expect((await storage.kanban.getKanbanTask(task.id))?.status).toBe("backlog");
      },
      { realKanban: true },
    );
  });

  test("a cancellation orders its Backlog write after a delayed admission move", async () => {
    await withService(
      async (service, storage) => {
        const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body");
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const update = storage.kanban.updateKanbanTask.bind(storage.kanban);
        const delayed = spyOn(storage.kanban, "updateKanbanTask").mockImplementationOnce(
          async (...args) => {
            entered.resolve();
            await release.promise;
            return update(...args);
          },
        );
        const starting = service.start(
          startInput({ ...kanban(task.id), existingEnvironmentId: undefined }),
        );
        // The start response can reject if cancellation wins the next pass.
        const settled = starting.catch(() => undefined);
        try {
          await entered.promise;
          const [reservation] = await storage.listAllBuildPipelines();
          const cancelled = service.cancel(reservation!.id);
          release.resolve();
          expect((await cancelled).phase).toBe("failed");
          await settled;
          expect((await storage.kanban.getKanbanTask(task.id))?.status).toBe("backlog");
        } finally {
          release.resolve();
          await settled;
          delayed.mockRestore();
        }
      },
      { realKanban: true },
    );
  });

  test("keeps it In progress through a hand move until the build is cancelled", async () => {
    await withService(
      async (service, storage) => {
        const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body");
        const { started } = await startBuilding(service, storage, kanban(task.id));
        await storage.kanban.updateKanbanTask(task.id, { status: "backlog" });
        expect((await storage.kanban.getKanbanTask(task.id))?.status).toBe("in-progress");
        await service.cancel(started.id);
        expect((await storage.kanban.getKanbanTask(task.id))?.status).toBe("backlog");
      },
      { realKanban: true },
    );
  });
});
