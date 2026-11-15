import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createProject, StorageService } from "./storage.js";
import { StorageFiles } from "./storage-files.js";
import type { KanbanSyncStore } from "./storage-kanban-sync.js";
import type { StorageRepositories } from "./storage-repositories.js";
import { fenceProjectContent } from "./storage-kanban-project-removal.js";
import type { FeaturePlan, ProjectNotes } from "./storage-shared.js";
import {
  readStoredValue,
  storageFilesContain,
  storageInternals,
  withTemporaryStorage,
} from "./storage-test-support.js";

/**
 * Removing a project deletes its tickets, their images, its labels, notes
 * and feature plans, and its pipelines' completion comment records (to-do
 * 5820, retired), and leaves every other project's as stored.
 */

const IMAGE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
).toString("base64");

function repositories(storage: StorageService): StorageRepositories {
  return (storage as unknown as { repos: StorageRepositories }).repos;
}

async function seedProject(storage: StorageService, name: string, marker: string) {
  const project = await storage.addProject(createProject(`https://github.com/acme/${name}.git`));
  await storage.kanban.createKanbanLabel(project.id, { name: `label-${marker}` });
  const ticket = await storage.kanban.addKanbanTask(project.id, `Ticket ${marker}`, marker, {
    labels: [`label-${marker}`],
  });
  await storage.kanban.addKanbanComment(ticket.id, `comment ${marker}`);
  const withImage = await storage.kanban.addKanbanImage(ticket.id, "shot.png", IMAGE);
  await storage.kanban.saveProjectNotes(project.id, `notes ${marker}`);
  const plan = await storage.kanban.createFeaturePlan(project.id);
  await storage.kanban.appendFeaturePlanMessage(plan.id, "user", `plan ${marker}`);
  return { project, ticket, imageId: withImage.images[0]!.id, plan };
}

describe("project removal", () => {
  test("deletes the project's tickets, images, labels, notes and plans, and no other's", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const files = new StorageFiles(dataDir);
      const removed = await seedProject(storage, "gone", "secret-gone-5820");
      const kept = await seedProject(storage, "kept", "kept-5820");
      expect(existsSync(files.kanbanImageFile(removed.imageId))).toBe(true);
      expect(storageFilesContain(dataDir, "secret-gone-5820")).toBe(true);

      await storage.removeProject(removed.project.id);

      expect(await storage.kanban.getKanbanTasks(removed.project.id)).toEqual([]);
      expect(await storage.kanban.getKanbanTask(removed.ticket.id)).toBeNull();
      expect(existsSync(files.kanbanImageFile(removed.imageId))).toBe(false);
      expect(await storage.kanban.getKanbanLabels(removed.project.id)).toEqual([]);
      expect((await storage.kanban.getProjectNotes(removed.project.id)).content).toBe("");
      expect(await storage.kanban.getFeaturePlans(removed.project.id)).toEqual([]);
      expect(await storage.kanban.getFeaturePlan(removed.plan.id)).toBeNull();
      // The deleted text is gone from the database file and its WAL too.
      expect(storageFilesContain(dataDir, "secret-gone-5820")).toBe(false);

      // The other project's are as they were.
      const tickets = await storage.kanban.getKanbanTasks(kept.project.id);
      expect(tickets.map((ticket) => ticket.id)).toEqual([kept.ticket.id]);
      expect(tickets[0]!.comments.map((comment) => comment.text)).toEqual(["comment kept-5820"]);
      expect(tickets[0]!.labels).toEqual(["label-kept-5820"]);
      expect(existsSync(files.kanbanImageFile(kept.imageId))).toBe(true);
      expect(await storage.kanban.getKanbanImageData(kept.imageId)).toBeString();
      expect(
        (await storage.kanban.getKanbanLabels(kept.project.id)).map((label) => label.name),
      ).toEqual(["label-kept-5820"]);
      expect((await storage.kanban.getProjectNotes(kept.project.id)).content).toBe(
        "notes kept-5820",
      );
      expect(
        (await storage.kanban.getFeaturePlans(kept.project.id)).map((plan) => plan.id),
      ).toEqual([kept.plan.id]);
      expect(
        readStoredValue<ProjectNotes[]>(dataDir, "project-notes.json")?.map(
          (note) => note.projectId,
        ),
      ).toEqual([kept.project.id]);
      expect(
        readStoredValue<FeaturePlan[]>(dataDir, "feature-plans.json")?.map(
          (plan) => plan.projectId,
        ),
      ).toEqual([kept.project.id]);
    });
  });

  test("queues no sync deletion and forgets only the removed project's sync records", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const gone = await storage.addProject(createProject("https://github.com/acme/gone.git"));
      const kept = await storage.addProject(createProject("https://github.com/acme/kept.git"));
      // A leaf copy of a command node's board in each project.
      await storage.ticketSync.applyTicketSync({
        controllerId: "bk_command",
        projectId: gone.id,
        sourceProjectId: "source-gone",
        epoch: "epoch-1",
        cursor: 1,
        items: [snapshot("ticket-gone", 1)],
      });
      await storage.ticketSync.applyTicketSync({
        controllerId: "bk_command",
        projectId: kept.id,
        sourceProjectId: "source-kept",
        epoch: "epoch-1",
        cursor: 2,
        items: [snapshot("ticket-kept", 2)],
      });
      const before = readStoredValue<KanbanSyncStore>(dataDir, "kanban-sync.json")!;
      expect(Object.keys(before.replicas)).toHaveLength(2);

      await storage.removeProject(gone.id);

      const after = readStoredValue<KanbanSyncStore>(dataDir, "kanban-sync.json")!;
      expect(Object.values(after.replicas).map((link) => link.projectId)).toEqual([kept.id]);
      // Removing a project here is not a deletion of the shared board.
      expect(after.outbox["bk_command"]?.items ?? []).toEqual([]);
      expect(Object.keys(after.tombstones)).toEqual([]);
      expect(await storage.kanban.getKanbanTask("ticket-gone")).toBeNull();
      expect(await storage.kanban.getKanbanTask("ticket-kept")).not.toBeNull();
    });
  });

  test("a pipeline's completion comment records go with it, and with its project", async () => {
    await withTemporaryStorage(async (storage) => {
      const project = await storage.addProject(createProject("https://github.com/acme/app.git"));
      for (const [id, projectId] of [
        ["e1", project.id],
        ["e2", project.id],
        ["e3", "other-project"],
      ] as const) {
        await storage.addEnvironment({
          id,
          projectId,
          name: id,
          branch: "main",
          containerId: null,
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: new Date(0).toISOString(),
          networkAccessMode: "restricted",
          order: 0,
          environmentType: "local",
        });
      }
      await storage.saveBuildPipeline("p-env", project.id, "e1", 1, { id: "p-env" });
      await storage.saveBuildPipeline("p-one", project.id, "e2", 1, { id: "p-one" });
      await storage.saveBuildPipeline("p-left", project.id, "", 1, { id: "p-left" });
      await storage.saveBuildPipeline("p-other", "other-project", "e3", 1, { id: "p-other" });
      for (const pipelineId of ["p-env", "p-one", "p-left", "p-other"]) {
        await storage.kanban.saveLinearCompletionComment({
          pipelineId,
          issueId: "issue",
          status: "posted",
          commentId: `linear-${pipelineId}`,
        });
        await storage.kanban.saveGitHubCompletionComment({
          pipelineId,
          repositoryOwner: "acme",
          repositoryName: "app",
          issueNumber: 1,
          status: "posted",
          commentId: `github-${pipelineId}`,
        });
      }
      const records = async (pipelineId: string) => [
        await storage.kanban.getLinearCompletionComment(pipelineId),
        await storage.kanban.getGitHubCompletionComment(pipelineId),
      ];

      await storage.deleteBuildPipelinesByEnvironment("e1");
      expect(await records("p-env")).toEqual([null, null]);
      await storage.deleteBuildPipeline("p-one");
      expect(await records("p-one")).toEqual([null, null]);
      expect((await records("p-left")).every(Boolean)).toBe(true);

      // A pipeline still listed for the project when it goes takes its records.
      await storage.removeProject(project.id);
      expect(await records("p-left")).toEqual([null, null]);
      expect((await records("p-other")).every(Boolean)).toBe(true);
      expect(await repositories(storage).kanban.deleteCompletionCommentsForPipelines([])).toBe(0);
    });
  });

  test("a retry after a removal that already deleted the content is harmless", async () => {
    await withTemporaryStorage(async (storage) => {
      const project = await storage.addProject(createProject("https://github.com/acme/app.git"));
      await storage.kanban.addKanbanTask(project.id, "Ticket", "");
      await repositories(storage).kanban.deleteProjectContent(project.id);
      await storage.removeProject(project.id);
      expect(await storage.getProject(project.id)).toBeNull();
      await expect(repositories(storage).kanban.deleteProjectContent(" ")).rejects.toThrow(
        "must not be blank",
      );
    });
  });
});

describe("project removal under concurrent writes and failures", () => {
  test("writes racing a removal are refused or deleted, and a re-added project syncs again", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const project = await storage.addProject(createProject("https://github.com/acme/race.git"));
      const leafCopy = {
        controllerId: "bk_command",
        projectId: project.id,
        sourceProjectId: "source-race",
        epoch: "epoch-1",
        cursor: 1,
        items: [snapshot("ticket-race", 1)],
      };
      // Queued on the Kanban lease before the removal, so it either lands
      // before the delete takes that lease or meets the fence.
      const early = storage.kanban.addKanbanTask(project.id, "Early", "racing-early-5820");
      const removal = storage.removeProject(project.id);
      // The fence is written before removeProject first yields.
      const racing = await Promise.allSettled([
        storage.kanban.addKanbanTask(project.id, "Late", "racing-late-5820"),
        storage.ticketSync.applyTicketSync(leafCopy),
        storage.kanban.createKanbanLabel(project.id, { name: "racing-label" }),
        storage.kanban.saveProjectNotes(project.id, "racing notes"),
        storage.kanban.createFeaturePlan(project.id),
      ]);
      for (const outcome of racing) {
        expect(outcome.status).toBe("rejected");
        expect(String((outcome as PromiseRejectedResult).reason)).toContain(
          "Project is being removed",
        );
      }
      await Promise.allSettled([early]);
      await removal;

      expect(await storage.getProject(project.id)).toBeNull();
      expect(await storage.kanban.getKanbanTasks(project.id)).toEqual([]);
      expect(await storage.kanban.getKanbanLabels(project.id)).toEqual([]);
      expect((await storage.kanban.getProjectNotes(project.id)).content).toBe("");
      expect(await storage.kanban.getFeaturePlans(project.id)).toEqual([]);
      const sync = readStoredValue<KanbanSyncStore>(dataDir, "kanban-sync.json");
      expect(Object.values(sync?.replicas ?? {}).map((link) => link.projectId)).not.toContain(
        project.id,
      );
      // The fence outlives the removal: a late write still cannot land.
      await expect(storage.ticketSync.applyTicketSync(leafCopy)).rejects.toThrow(
        "Project is being removed",
      );
      expect(storageFilesContain(dataDir, "racing-early-5820")).toBe(false);

      // A re-added copy of the repository is a new project and pairs again.
      const readded = await storage.addProject(createProject("https://github.com/acme/race.git"));
      await storage.ticketSync.applyTicketSync({ ...leafCopy, projectId: readded.id });
      expect((await storage.kanban.getKanbanTasks(readded.id)).map((task) => task.id)).toEqual([
        "ticket-race",
      ]);
    });
  });

  test("a command node keeps a leaf's changes for a project being removed queued, in order", async () => {
    await withTemporaryStorage(async (storage) => {
      const kept = await storage.addProject(createProject("https://github.com/acme/kept.git"));
      const going = await storage.addProject(createProject("https://github.com/acme/going.git"));
      const keptTicket = await storage.kanban.addKanbanTask(kept.id, "Kept", "");
      const goingTicket = await storage.kanban.addKanbanTask(going.id, "Going", "");
      fenceProjectContent(storageInternals(storage).context, going.id);
      const titleRev = async (ticketId: string) =>
        (await storage.kanban.getKanbanTask(ticketId))?.sync?.revs.title ?? 0;
      const rename = async (seq: number, ticketId: string, projectId: string, value: string) => ({
        seq,
        ticketId,
        sourceProjectId: projectId,
        createdAt: new Date().toISOString(),
        op: { kind: "set-title" as const, value, baseRev: await titleRev(ticketId) },
        bytes: 100,
      });
      const result = await storage.ticketSync.applyTicketSyncOps({
        nodeId: "bk_leaf",
        epoch: "leaf-epoch",
        items: [
          await rename(1, keptTicket.id, kept.id, "Kept, renamed"),
          await rename(2, goingTicket.id, going.id, "Going, renamed"),
          await rename(3, keptTicket.id, kept.id, "Kept, again"),
        ],
      });
      expect(result.appliedSeq).toBe(1);
      expect((await storage.kanban.getKanbanTask(keptTicket.id))?.title).toBe("Kept, renamed");
      expect((await storage.kanban.getKanbanTask(goingTicket.id))?.title).toBe("Going");
    });
  });

  test("an image file that cannot be unlinked fails the removal, keeps the project, and a retry after a restart removes it", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const files = new StorageFiles(dataDir);
      const removed = await seedProject(storage, "gone", "secret-image-5820");
      const kept = await seedProject(storage, "kept", "kept-image-5820");
      const imageFile = files.kanbanImageFile(removed.imageId);
      // A non-empty directory where the file was: every unlink attempt fails.
      rmSync(imageFile);
      mkdirSync(imageFile);
      writeFileSync(path.join(imageFile, "bytes"), "image bytes");

      await expect(storage.removeProject(removed.project.id)).rejects.toThrow(
        "Could not delete 1 ticket image file(s)",
      );
      // The project stays, with its content already gone, and stays usable.
      expect(await storage.getProject(removed.project.id)).not.toBeNull();
      expect(await storage.kanban.getKanbanTask(removed.ticket.id)).toBeNull();
      const replacement = await storage.kanban.addKanbanTask(removed.project.id, "After", "");
      expect(replacement.projectId).toBe(removed.project.id);
      expect(
        Object.keys(
          readStoredValue<Record<string, unknown>>(dataDir, "kanban-image-deletions.json") ?? {},
        ),
      ).toEqual([removed.imageId]);

      // Filesystem access comes back, the bytes still there, and the backend
      // restarts before the retry.
      rmSync(imageFile, { recursive: true });
      writeFileSync(imageFile, "image bytes");
      const reopened = new StorageService(dataDir);
      await reopened.init();
      try {
        await reopened.removeProject(removed.project.id);
        expect(await reopened.getProject(removed.project.id)).toBeNull();
        expect(existsSync(imageFile)).toBe(false);
        expect(
          Object.keys(
            readStoredValue<Record<string, unknown>>(dataDir, "kanban-image-deletions.json") ?? {},
          ),
        ).toEqual([]);
        expect(existsSync(files.kanbanImageFile(kept.imageId))).toBe(true);
        expect(await reopened.kanban.getKanbanImageData(kept.imageId)).toBeString();
      } finally {
        reopened.close();
      }
    });
  });

  test("the delivery records of the project's deleted tickets go with it, and no other's", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const gone = await storage.addProject(createProject("https://github.com/acme/gone.git"));
      const kept = await storage.addProject(createProject("https://github.com/acme/kept.git"));
      const goneTicket = await storage.kanban.addKanbanTask(gone.id, "Gone", "");
      const keptTicket = await storage.kanban.addKanbanTask(kept.id, "Kept", "");
      await storage.kanban.deleteKanbanTask(goneTicket.id);
      await storage.kanban.deleteKanbanTask(keptTicket.id);
      expect(
        await storage.kanban.getDeletedKanbanDeliveryPolicy(goneTicket.id, gone.id),
      ).toBeDefined();
      const directory = `${new StorageFiles(dataDir).kanbanFile()}.delivery`;
      expect(readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toHaveLength(2);

      await storage.removeProject(gone.id);

      expect(
        await storage.kanban.getDeletedKanbanDeliveryPolicy(goneTicket.id, gone.id),
      ).toBeUndefined();
      expect(readdirSync(directory)).toHaveLength(1);
      expect(
        await storage.kanban.getDeletedKanbanDeliveryPolicy(keptTicket.id, kept.id),
      ).toBeDefined();
    });
  });

  test("environment deletion removes the records of a linked pipeline whose row is gone, not another environment's", async () => {
    await withTemporaryStorage(async (storage) => {
      const project = await storage.addProject(createProject("https://github.com/acme/app.git"));
      for (const id of ["e1", "e2"]) {
        await storage.addEnvironment({
          id,
          projectId: project.id,
          name: id,
          branch: "main",
          containerId: null,
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: new Date(0).toISOString(),
          networkAccessMode: "restricted",
          order: 0,
          environmentType: "local",
        });
      }
      // A pipeline owned by another environment keeps its records.
      await storage.saveBuildPipeline("p-foreign", project.id, "e2", 1, { id: "p-foreign" });
      for (const pipelineId of ["p-absent", "p-foreign"]) {
        await storage.kanban.saveLinearCompletionComment({
          pipelineId,
          issueId: "issue",
          status: "posted",
          commentId: `linear-${pipelineId}`,
        });
        await storage.kanban.saveGitHubCompletionComment({
          pipelineId,
          repositoryOwner: "acme",
          repositoryName: "app",
          issueNumber: 1,
          status: "posted",
          commentId: `github-${pipelineId}`,
        });
      }
      const records = async (pipelineId: string) => [
        await storage.kanban.getLinearCompletionComment(pipelineId),
        await storage.kanban.getGitHubCompletionComment(pipelineId),
      ];

      // "p-absent" has no row (already deleted, or a retry after a failure).
      await storage.deleteBuildPipelinesByEnvironment("e1", "p-absent");
      expect(await records("p-absent")).toEqual([null, null]);
      await storage.deleteBuildPipelinesByEnvironment("e1", "p-foreign");
      expect((await records("p-foreign")).every(Boolean)).toBe(true);
    });
  });
});

function snapshot(id: string, seq: number) {
  const at = "2026-11-01T00:00:00.000Z";
  return {
    id,
    seq,
    revs: { title: seq, content: seq, status: seq },
    title: `Copy ${id}`,
    description: "",
    acceptanceCriteria: "",
    status: "backlog" as const,
    comments: [],
    images: [],
    createdAt: at,
    updatedAt: at,
  };
}
