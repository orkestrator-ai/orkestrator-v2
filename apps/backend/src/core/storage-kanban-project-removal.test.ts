import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { createProject } from "./storage.js";
import type { StorageService } from "./storage.js";
import { StorageFiles } from "./storage-files.js";
import type { KanbanSyncStore } from "./storage-kanban-sync.js";
import type { StorageRepositories } from "./storage-repositories.js";
import type { FeaturePlan, ProjectNotes } from "./storage-shared.js";
import {
  readStoredValue,
  storageFilesContain,
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
