import { describe, expect, test } from "bun:test";

import { sweepRemovedProjectContentAtStartup } from "./removed-project-content-sweep.js";
import {
  NoStoredProjectsError,
  type RemovedProjectSweepResult,
} from "./storage-kanban-removed-projects.js";
import { createProject } from "./storage.js";
import { withTemporaryStorage } from "./storage-test-support.js";

const NOTHING: RemovedProjectSweepResult = {
  projects: 0,
  tickets: 0,
  deliveryRecords: 0,
  labelCatalogues: 0,
  notes: 0,
  featurePlans: 0,
  completionComments: 0,
  skipped: [],
};

describe("sweepRemovedProjectContentAtStartup", () => {
  test("runs the sweep once", async () => {
    let calls = 0;
    await sweepRemovedProjectContentAtStartup({
      sweepRemovedProjectContent: async () => {
        calls += 1;
        return { ...NOTHING, projects: 1, tickets: 3 };
      },
    });
    expect(calls).toBe(1);
  });

  test("never rejects when the sweep is refused", async () => {
    await expect(
      sweepRemovedProjectContentAtStartup({
        sweepRemovedProjectContent: async () => {
          throw new Error("Project store is missing or invalid; cleanup refused");
        },
      }),
    ).resolves.toBeUndefined();
  });

  test("never rejects when no project is stored", async () => {
    await expect(
      sweepRemovedProjectContentAtStartup({
        sweepRemovedProjectContent: async () => {
          throw new NoStoredProjectsError();
        },
      }),
    ).resolves.toBeUndefined();
  });

  test("leaves a machine with no project as it is", async () => {
    await withTemporaryStorage(async (storage) => {
      await sweepRemovedProjectContentAtStartup(storage);
      const project = await storage.addProject(createProject("https://github.com/acme/app.git"));
      const ticket = await storage.kanban.addKanbanTask(project.id, "Ticket", "");
      await sweepRemovedProjectContentAtStartup(storage);
      expect(await storage.kanban.getKanbanTask(ticket.id)).not.toBeNull();
    });
  });
});
