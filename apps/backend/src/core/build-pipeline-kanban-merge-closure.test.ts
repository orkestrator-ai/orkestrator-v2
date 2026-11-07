import { describe, expect, test } from "bun:test";
import type { StorageService } from "./storage.js";
import { mutateStored, startBuilding, withService } from "./build-pipeline-service-test-support.js";

const PR_URL = "https://github.com/acme/repo/pull/1";

const kanban = (taskId: string) => ({ taskId, source: { type: "kanban" as const, taskId } });

/** Records that this pipeline's Ship opened a pull request (`pipelineReachedPullRequestStage`). */
async function markShipped(storage: StorageService, pipelineId: string): Promise<void> {
  await mutateStored(storage, pipelineId, (snapshot) => {
    snapshot.sessions.push({
      ...snapshot.sessions[0]!,
      phase: "pr",
      label: "PR Session",
      status: "idle",
    });
  });
}

describe("a build that ends after its pull request merged", () => {
  test("closes its ticket instead of moving it back to backlog", async () => {
    await withService(
      async (service, storage) => {
        const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body");
        const { started } = await startBuilding(service, storage, kanban(task.id));
        await markShipped(storage, started.id);
        await storage.updateEnvironment("env-1", { prUrl: PR_URL, prState: "merged" });

        await service.cancel(started.id);

        expect(await storage.kanban.getKanbanTask(task.id)).toMatchObject({
          status: "done",
          prMergeDoneUrl: PR_URL,
        });
      },
      { realKanban: true },
    );
  });

  test("leaves a ticket the merge closed and the user reopened where it is on a later end", async () => {
    await withService(
      async (service, storage) => {
        const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body");
        const { started } = await startBuilding(service, storage, kanban(task.id));
        await markShipped(storage, started.id);
        await storage.updateEnvironment("env-1", { prUrl: PR_URL, prState: "merged" });
        await storage.kanban.updateKanbanTask(task.id, {
          status: "review",
          prMergeDoneUrl: PR_URL,
        });

        await service.cancel(started.id);

        expect((await storage.kanban.getKanbanTask(task.id))?.status).toBe("review");
      },
      { realKanban: true },
    );
  });
});

describe("a build that ends without a merged pull request", () => {
  test("still moves its ticket back to backlog", async () => {
    await withService(
      async (service, storage) => {
        const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body");
        const { started } = await startBuilding(service, storage, kanban(task.id));
        expect((await storage.kanban.getKanbanTask(task.id))?.status).toBe("in-progress");

        await service.cancel(started.id);

        expect((await storage.kanban.getKanbanTask(task.id))?.status).toBe("backlog");
      },
      { realKanban: true },
    );
  });

  test("never reopens a ticket that is already done", async () => {
    await withService(
      async (service, storage) => {
        const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body");
        const { started } = await startBuilding(service, storage, kanban(task.id));
        await storage.kanban.updateKanbanTask(task.id, { status: "done" });

        await service.cancel(started.id);

        expect((await storage.kanban.getKanbanTask(task.id))?.status).toBe("done");
      },
      { realKanban: true },
    );
  });
});
