import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./service.js";
import { seedStore, readStoredValue, storageInternals } from "./test-support.js";

async function fixture(run: (storage: StorageService, dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "kanban-delete-idle-"));
  const storage = new StorageService(dir);
  await storage.init();
  try {
    await run(storage, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const ticket = {
  id: "ticket",
  projectId: "project",
  title: "Ticket",
  description: "",
  acceptanceCriteria: "",
  status: "backlog",
  comments: [],
  images: [],
  createdAt: new Date(0).toISOString(),
  order: 0,
};

test("guarded deletion protects remote links and current work after an idle read", () =>
  fixture(async (storage, dir) => {
    await seedStore(dir, "kanban.json", [ticket]);
    expect((await storage.kanban.getKanbanTasks("project"))[0]?.status).toBe("backlog");
    // Deterministic interleaving: work is attached after the coordinator's idle read.
    for (const links of [
      { status: "in-progress", environmentId: "env" },
      { status: "review", sync: { work: { nodeId: "leaf", buildPipelineId: "remote" } } },
      { status: "backlog", buildPipelineId: "setup" },
    ]) {
      await seedStore(dir, "kanban.json", [{ ...ticket, ...links }]);
      const before = await readStoredValue(dir, "kanban-sync.json");
      await expect(storage.kanban.deleteKanbanTask("ticket", "project")).rejects.toThrow(
        "work attached",
      );
      expect(await storage.kanban.getKanbanTask("ticket")).not.toBeNull();
      expect(await readStoredValue(dir, "kanban-sync.json")).toEqual(before);
    }
  }));

test("pipeline reservations protect unlinked backlog and done tickets until terminal", () =>
  fixture(async (storage, dir) => {
    for (const phase of ["creating-environment", "starting-environment", "building"]) {
      await seedStore(dir, "kanban.json", [
        { ...ticket, status: phase === "building" ? "done" : "backlog" },
      ]);
      await seedStore(dir, "build-pipelines.json", {
        pipeline: { id: "pipeline", projectId: "project", snapshot: { taskId: "ticket", phase } },
      });
      await expect(storage.kanban.deleteKanbanTask("ticket", "project")).rejects.toThrow(
        "active build pipeline",
      );
    }
    await seedStore(dir, "build-pipelines.json", {
      pipeline: {
        id: "pipeline",
        projectId: "project",
        snapshot: { taskId: "ticket", phase: "complete" },
      },
    });
    await seedStore(dir, "kanban.json", [
      { ...ticket, status: "done", buildPipelineId: "pipeline", environmentId: "old" },
    ]);
    await expect(storage.kanban.deleteKanbanTask("ticket", "other")).rejects.toThrow(
      "not found in project",
    );
    await storage.kanban.deleteKanbanTask("ticket", "project");
    expect(await storage.kanban.getKanbanTask("ticket")).toBeNull();
    await expect(
      storageInternals(storage).repos.kanban.assertKanbanBuildNotDeleted("ticket"),
    ).rejects.toThrow("deleted ticket");
    await expect(
      storage.saveBuildPipeline(
        "late",
        "project",
        "",
        1,
        {
          id: "late",
          taskId: "ticket",
          phase: "creating-environment",
        },
        0,
      ),
    ).rejects.toThrow("deleted ticket");
    await expect(storage.kanban.deleteKanbanTask("ticket", "project")).rejects.toThrow("not found");
  }));

test("guarded deletion waits for concurrent pipeline admission before checking the reservation", () =>
  fixture(async (storage, dir) => {
    seedStore(dir, "kanban.json", [ticket]);
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admission = storageInternals(storage).context.serialize(
      path.join(dir, "build-pipelines.json"),
      "build pipeline storage",
      async () => {
        entered();
        await barrier;
        seedStore(dir, "build-pipelines.json", {
          pipeline: {
            id: "pipeline",
            projectId: "project",
            snapshot: {
              taskId: "ticket",
              phase: "creating-environment",
            },
          },
        });
      },
    );
    await ready;
    const deletion = storage.kanban.deleteKanbanTask("ticket", "project");
    // Install the rejection handler before allowing the concurrent operation to finish.
    const refused = deletion.then(
      () => null,
      (error) => error,
    );
    release();
    await admission;
    expect(String(await refused)).toContain("active build pipeline");
    expect(await storage.kanban.getKanbanTask("ticket")).not.toBeNull();
  }));
