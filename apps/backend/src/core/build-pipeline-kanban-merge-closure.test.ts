import { describe, expect, spyOn, test } from "bun:test";
import type { StorageService } from "./storage.js";
import {
  mutateStored,
  startBuilding,
  withService,
  pipeline,
} from "./build-pipeline-service-test-support.js";

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

test("a merge after terminal reads but before the status write stays done", async () => {
  await withService(
    async (service, storage) => {
      const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body");
      const { started } = await startBuilding(service, storage, kanban(task.id));
      const original = storage.kanban.updateKanbanTask.bind(storage.kanban);
      let resume!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((resolve) => (resume = resolve));
      const entered = new Promise<void>((resolve) => (reached = resolve));
      const write = spyOn(storage.kanban, "updateKanbanTask").mockImplementation(
        async (...args) => {
          reached();
          await gate;
          return original(...args);
        },
      );
      const ending = service.cancel(started.id);
      try {
        await entered;
        await storage.kanban.closeKanbanTasksForMergedPullRequests([
          { taskId: task.id, prUrl: PR_URL },
        ]);
        resume();
        await ending;
        expect(await storage.kanban.getKanbanTask(task.id)).toMatchObject({
          status: "done",
          prMergeDoneUrl: PR_URL,
        });
      } finally {
        resume();
        await ending;
        write.mockRestore();
      }
    },
    { realKanban: true },
  );
});

test("a failed merge closure is recorded and completion reconciliation retries it", async () => {
  await withService(
    async (service, storage) => {
      const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body");
      const { started } = await startBuilding(service, storage, kanban(task.id));
      await markShipped(storage, started.id);
      await storage.updateEnvironment("env-1", { prUrl: PR_URL, prState: "merged" });
      const close = spyOn(
        storage.kanban,
        "closeKanbanTasksForMergedPullRequests",
      ).mockRejectedValueOnce(new Error("closure unavailable"));
      try {
        await service.cancel(started.id);
        expect(await pipeline(storage, started.id)).toMatchObject({
          completionCommentStatus: "failed",
          completionCommentError: "closure unavailable",
        });
        expect((await storage.kanban.getKanbanTask(task.id))?.status).toBe("in-progress");
        const retried = await service.retryCompletionComment(started.id);
        expect(retried.completionCommentStatus).toBe("posted");
        expect(await storage.kanban.getKanbanTask(task.id)).toMatchObject({
          status: "done",
          prMergeDoneUrl: PR_URL,
        });
      } finally {
        close.mockRestore();
      }
    },
    { realKanban: true },
  );
});

test("deleting a pipeline with a pending code rewind still closes its merged ticket", async () => {
  await withService(
    async (service, storage) => {
      const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body");
      const { started } = await startBuilding(service, storage, kanban(task.id));
      await markShipped(storage, started.id);
      await storage.updateEnvironment("env-1", { prUrl: PR_URL, prState: "merged" });
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.rewinds = [
          {
            id: "rewind-1",
            at: new Date().toISOString(),
            fromPhase: "building",
            fromIteration: 0,
            iteration: 0,
            step: { kind: "session", phase: "build" },
            supersededSessions: 0,
            code: {
              from: "a".repeat(40),
              to: "b".repeat(40),
              droppedCommits: 1,
              backupRef: "refs/orkestrator/test",
              pending: true,
            },
          },
        ];
      });
      await service.remove(started.id);
      expect(await storage.getBuildPipeline(started.id)).toBeNull();
      expect(await storage.kanban.getKanbanTask(task.id)).toMatchObject({
        status: "done",
        prMergeDoneUrl: PR_URL,
      });
    },
    { realKanban: true },
  );
});
