import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { STORAGE_DATABASE_FILE } from "./storage-database.js";
import { StorageFiles } from "./storage-files.js";
import { NoStoredProjectsError } from "./storage-kanban-removed-projects.js";
import type { KanbanSyncStore } from "./storage-kanban-sync.js";
import type { FeaturePlan, ProjectNotes } from "./storage-shared.js";
import { createProject, type StorageService } from "./storage.js";
import {
  deleteStoredValue,
  readStoredValue,
  seedStore,
  seedUnreadableStore,
  storageFilesContain,
  storageInternals,
  withTemporaryStorage,
} from "./storage-test-support.js";

/**
 * The startup sweep for rows that projects removed before project removal
 * deleted their content left behind (#2328): it deletes them,
 * leaves every other project's rows as stored, and deletes nothing when the
 * projects store cannot be read completely or holds no project.
 */

const IMAGE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
).toString("base64");

async function seedProject(storage: StorageService, name: string, marker: string) {
  const project = await storage.addProject(createProject(`https://github.com/acme/${name}.git`));
  await storage.kanban.createKanbanLabel(project.id, { name: `label-${marker}` });
  const ticket = await storage.kanban.addKanbanTask(project.id, `Ticket ${marker}`, marker, {
    labels: [`label-${marker}`],
  });
  await storage.kanban.addKanbanComment(ticket.id, `comment ${marker}`);
  const withImage = await storage.kanban.addKanbanImage(ticket.id, "shot.png", IMAGE);
  // A deleted ticket leaves a delivery record naming the project.
  const deleted = await storage.kanban.addKanbanTask(project.id, `Deleted ${marker}`, "");
  await storage.kanban.deleteKanbanTask(deleted.id);
  await storage.kanban.saveProjectNotes(project.id, `notes ${marker}`);
  const plan = await storage.kanban.createFeaturePlan(project.id);
  await storage.kanban.appendFeaturePlanMessage(plan.id, "user", `plan ${marker}`);
  // A leaf copy of a command node's board.
  await storage.ticketSync.applyTicketSync({
    controllerId: "bk_command",
    projectId: project.id,
    sourceProjectId: `source-${name}`,
    epoch: "epoch-1",
    cursor: 1,
    items: [snapshot(`copy-${name}`, 1)],
  });
  return { project, ticket, deleted, imageId: withImage.images[0]!.id, plan };
}

/** What removing a project did before 5820: only its row went. */
function dropProjectRowOnly(storage: StorageService, projectId: string): void {
  const { context } = storageInternals(storage);
  context.updateStoreRow(new StorageFiles(context.dataDir).projectsFile(), projectId, () => ({
    result: undefined,
    delete: true,
  }));
}

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

function corruptRow(dataDir: string, store: string, key: string): void {
  const db = new Database(path.join(dataDir, STORAGE_DATABASE_FILE));
  try {
    db.query("UPDATE store_rows SET value = '{ torn' WHERE store = ? AND key = ?").run(store, key);
    db.query("UPDATE stores SET revision = revision + 1 WHERE name = ?").run(store);
  } finally {
    db.close();
  }
}

async function saveCompletionComments(storage: StorageService, pipelineId: string) {
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

async function completionComments(storage: StorageService, pipelineId: string) {
  return [
    await storage.kanban.getLinearCompletionComment(pipelineId),
    await storage.kanban.getGitHubCompletionComment(pipelineId),
  ];
}

function deliveryRecordCount(dataDir: string): number {
  const directory = `${new StorageFiles(dataDir).kanbanFile()}.delivery`;
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry)).length;
}

describe("removed-project sweep", () => {
  test("no-orphan owner reads stay constant across many rows", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const project = await storage.addProject(createProject("https://github.com/acme/live.git"));
      const files = new StorageFiles(dataDir);
      const rows = Array.from({ length: 100 }, (_, i) => ({
        id: `row-${i}`,
        projectId: project.id,
        pipelineId: "live-pipeline",
      }));
      seedStore(dataDir, path.basename(files.projectNotesFile()), rows);
      seedStore(dataDir, path.basename(files.featurePlansFile()), rows);
      seedStore(dataDir, path.basename(files.linearCompletionCommentsFile()), rows);
      seedStore(dataDir, path.basename(files.githubCompletionCommentsFile()), rows);
      const { repos } = storageInternals(storage);
      const projects = spyOn(
        repos.projects as unknown as { projectIdsForCleanupNow: () => ReadonlySet<string> },
        "projectIdsForCleanupNow",
      );
      const pipelines = spyOn(repos.buildPipelines, "pipelineIdsForCleanupNow").mockReturnValue(
        new Set(["live-pipeline"]),
      );
      try {
        expect((await storage.sweepRemovedProjectContent()).skipped).toEqual([]);
        expect(projects).toHaveBeenCalledTimes(5);
        expect(pipelines).toHaveBeenCalledTimes(2);
      } finally {
        projects.mockRestore();
        pipelines.mockRestore();
      }
    });
  });

  test("deletes what an earlier removal left, and no other project's rows", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const files = new StorageFiles(dataDir);
      const gone = await seedProject(storage, "gone", "secret-gone-8111");
      const kept = await seedProject(storage, "kept", "kept-8111");
      expect(deliveryRecordCount(dataDir)).toBe(2);
      dropProjectRowOnly(storage, gone.project.id);
      expect(await storage.getProject(gone.project.id)).toBeNull();
      expect(storageFilesContain(dataDir, "secret-gone-8111")).toBe(true);

      const result = await storage.sweepRemovedProjectContent();

      expect(result).toMatchObject({
        projects: 1,
        tickets: 2,
        deliveryRecords: 1,
        labelCatalogues: 1,
        notes: 1,
        featurePlans: 1,
        skipped: [],
      });
      expect(await storage.kanban.getKanbanTasks(gone.project.id)).toEqual([]);
      expect(await storage.kanban.getKanbanTask(gone.ticket.id)).toBeNull();
      expect(existsSync(files.kanbanImageFile(gone.imageId))).toBe(false);
      expect(
        await storage.kanban.getDeletedKanbanDeliveryPolicy(gone.deleted.id, gone.project.id),
      ).toBeUndefined();
      expect(await storage.kanban.getKanbanLabels(gone.project.id)).toEqual([]);
      expect((await storage.kanban.getProjectNotes(gone.project.id)).content).toBe("");
      expect(await storage.kanban.getFeaturePlan(gone.plan.id)).toBeNull();
      const sync = readStoredValue<KanbanSyncStore>(dataDir, "kanban-sync.json")!;
      expect(Object.values(sync.replicas).map((link) => link.projectId)).toEqual([kept.project.id]);
      // No deletion was queued for the command node.
      expect(sync.outbox["bk_command"]?.items ?? []).toEqual([]);
      expect(storageFilesContain(dataDir, "secret-gone-8111")).toBe(false);

      // The other project's rows are as they were.
      const tickets = await storage.kanban.getKanbanTasks(kept.project.id);
      expect(tickets.map((ticket) => ticket.id).sort()).toEqual(
        [kept.ticket.id, "copy-kept"].sort(),
      );
      const own = tickets.find((ticket) => ticket.id === kept.ticket.id)!;
      expect(own.comments.map((comment) => comment.text)).toEqual(["comment kept-8111"]);
      expect(own.labels).toEqual(["label-kept-8111"]);
      expect(existsSync(files.kanbanImageFile(kept.imageId))).toBe(true);
      expect(
        await storage.kanban.getDeletedKanbanDeliveryPolicy(kept.deleted.id, kept.project.id),
      ).toBeDefined();
      expect(deliveryRecordCount(dataDir)).toBe(1);
      expect(
        (await storage.kanban.getKanbanLabels(kept.project.id)).map((label) => label.name),
      ).toEqual(["label-kept-8111"]);
      expect((await storage.kanban.getProjectNotes(kept.project.id)).content).toBe(
        "notes kept-8111",
      );
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

  test("a second pass finds nothing and writes nothing", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const gone = await seedProject(storage, "gone", "gone-again-8111");
      await seedProject(storage, "kept", "kept-again-8111");
      dropProjectRowOnly(storage, gone.project.id);
      await storage.sweepRemovedProjectContent();
      const db = new Database(path.join(dataDir, STORAGE_DATABASE_FILE), { readonly: true });
      const revisions = () =>
        db.query("SELECT name, revision FROM stores ORDER BY name").all() as unknown[];
      try {
        const before = revisions();
        const again = await storage.sweepRemovedProjectContent();
        expect(again).toMatchObject({
          projects: 0,
          tickets: 0,
          deliveryRecords: 0,
          labelCatalogues: 0,
          notes: 0,
          featurePlans: 0,
          completionComments: 0,
          skipped: [],
        });
        expect(revisions()).toEqual(before);
      } finally {
        db.close();
      }
    });
  });

  test("deletes the completion comment records of pipelines that are gone, and only those", async () => {
    await withTemporaryStorage(async (storage) => {
      const project = await storage.addProject(createProject("https://github.com/acme/app.git"));
      await storage.saveBuildPipeline("p-live", project.id, "", 1, { id: "p-live" });
      await saveCompletionComments(storage, "p-live");
      await saveCompletionComments(storage, "p-deleted-before-5820");

      const result = await storage.sweepRemovedProjectContent();

      expect(result.completionComments).toBe(2);
      expect(await completionComments(storage, "p-deleted-before-5820")).toEqual([null, null]);
      expect((await completionComments(storage, "p-live")).every(Boolean)).toBe(true);
    });
  });

  test("keeps completion comment records when the pipeline store is missing or unreadable", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const project = await storage.addProject(createProject("https://github.com/acme/app.git"));
      await saveCompletionComments(storage, "p-unknown");
      // No pipeline was ever stored: the store is absent, not empty.
      let result = await storage.sweepRemovedProjectContent();
      expect(result.skipped).toEqual(["linear-completion-comments", "github-completion-comments"]);
      expect((await completionComments(storage, "p-unknown")).every(Boolean)).toBe(true);

      await storage.saveBuildPipeline("p-live", project.id, "", 1, { id: "p-live" });
      corruptRow(dataDir, "build-pipelines", "p-live");
      result = await storage.sweepRemovedProjectContent();
      expect(result.skipped).toEqual(["linear-completion-comments", "github-completion-comments"]);
      expect((await completionComments(storage, "p-unknown")).every(Boolean)).toBe(true);
    });
  });
});

describe("removed-project sweep guards", () => {
  /** Two projects, one already removed the old way, and what each holds. */
  async function leftovers(storage: StorageService) {
    const gone = await seedProject(storage, "gone", "guarded-gone-8111");
    const kept = await seedProject(storage, "kept", "guarded-kept-8111");
    dropProjectRowOnly(storage, gone.project.id);
    return { gone, kept };
  }

  async function expectEverythingKept(
    storage: StorageService,
    dataDir: string,
    seeded: Awaited<ReturnType<typeof leftovers>>,
  ) {
    for (const { project, ticket, imageId, plan } of [seeded.gone, seeded.kept]) {
      expect(await storage.kanban.getKanbanTask(ticket.id)).not.toBeNull();
      expect(existsSync(new StorageFiles(dataDir).kanbanImageFile(imageId))).toBe(true);
      expect(await storage.kanban.getKanbanLabels(project.id)).toHaveLength(1);
      expect((await storage.kanban.getProjectNotes(project.id)).content).not.toBe("");
      expect(await storage.kanban.getFeaturePlan(plan.id)).not.toBeNull();
    }
    expect(deliveryRecordCount(dataDir)).toBe(2);
    const sync = readStoredValue<KanbanSyncStore>(dataDir, "kanban-sync.json")!;
    expect(Object.keys(sync.replicas)).toHaveLength(2);
  }

  test("an unreadable projects store refuses the sweep", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const seeded = await leftovers(storage);
      seedUnreadableStore(dataDir, "projects.json");
      await expect(storage.sweepRemovedProjectContent()).rejects.toThrow("unreadable");
      await expectEverythingKept(storage, dataDir, seeded);
    });
  });

  test("an unreadable project row refuses the sweep", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const seeded = await leftovers(storage);
      corruptRow(dataDir, "projects", seeded.kept.project.id);
      await expect(storage.sweepRemovedProjectContent()).rejects.toThrow();
      await expectEverythingKept(storage, dataDir, seeded);
    });
  });

  test("a project row without an id refuses the sweep", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const seeded = await leftovers(storage);
      seedStore(dataDir, "projects.json", [seeded.kept.project, { name: "no id" }]);
      await expect(storage.sweepRemovedProjectContent()).rejects.toThrow("cleanup refused");
      await expectEverythingKept(storage, dataDir, seeded);
    });
  });

  test("an empty projects store refuses the sweep", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const seeded = await leftovers(storage);
      seedStore(dataDir, "projects.json", []);
      await expect(storage.sweepRemovedProjectContent()).rejects.toThrow(NoStoredProjectsError);
      await expectEverythingKept(storage, dataDir, seeded);
    });
  });

  test("a missing projects store refuses the sweep", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const seeded = await leftovers(storage);
      deleteStoredValue(dataDir, "projects.json");
      await expect(storage.sweepRemovedProjectContent()).rejects.toThrow(NoStoredProjectsError);
      await expectEverythingKept(storage, dataDir, seeded);
    });
  });

  test("an unreadable ticket store skips that step and the others still run", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const { gone, kept } = await leftovers(storage);
      corruptRow(dataDir, "kanban", kept.ticket.id);
      const result = await storage.sweepRemovedProjectContent();
      expect(result.skipped).toEqual(["tickets"]);
      expect(result.labelCatalogues).toBe(1);
      // Its catalogue went; the label names still on its tickets stay with them.
      expect(
        readStoredValue<Array<{ projectId: string }>>(dataDir, "kanban-labels.json")?.map(
          (row) => row.projectId,
        ),
      ).toEqual([kept.project.id]);
      expect((await storage.kanban.getProjectNotes(gone.project.id)).content).toBe("");
      // The ticket rows were not rewritten from a partial read.
      const db = new Database(path.join(dataDir, STORAGE_DATABASE_FILE), { readonly: true });
      try {
        const rows = db
          .query("SELECT key FROM store_rows WHERE store = 'kanban' ORDER BY key")
          .all() as Array<{ key: string }>;
        expect(rows.map((row) => row.key)).toContain(gone.ticket.id);
        expect(rows.map((row) => row.key)).toContain(kept.ticket.id);
      } finally {
        db.close();
      }
    });
  });

  test("a project added after the scan keeps a label created for it", async () => {
    await withTemporaryStorage(async (storage) => {
      await storage.addProject(createProject("https://github.com/acme/kept.git"));
      const labels = new StorageFiles(storageInternals(storage).context.dataDir).kanbanLabelsFile();
      // A label row whose project is not stored when the sweep reads, but is
      // by the time its row is deleted.
      const late = createProject("https://github.com/acme/late.git");
      storageInternals(storage).context.updateStoreRow(labels, late.id, () => ({
        result: undefined,
        value: { projectId: late.id, labels: [{ name: "late", createdAt: "2026-11-16" }] },
      }));
      const { repos } = storageInternals(storage);
      let reads = 0;
      const result = await repos.kanban.sweepRemovedProjectRows(
        () => {
          reads += 1;
          // The labels step's scan is the second read; the row's own check comes after it.
          return new Set(reads <= 2 ? [] : [late.id]);
        },
        () => new Set(),
      );
      expect(result.labelCatalogues).toBe(0);
      expect(await storage.kanban.getKanbanLabels(late.id)).toHaveLength(1);
    });
  });
});
