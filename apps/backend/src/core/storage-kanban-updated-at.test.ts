import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StorageService } from "./storage.js";
import type { KanbanTask } from "./storage-shared.js";
import { readStoredValue, seedStore } from "./storage-test-support.js";

/**
 * A ticket's `updatedAt`: set to its creation time, refreshed by every change
 * to its content or state, left alone by a move within its column, and read
 * as `createdAt` on rows stored before it existed.
 */

const OLD = "2026-01-01T00:00:00.000Z";
const PROJECT = "project-1";

function row(id: string, overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id,
    projectId: PROJECT,
    title: `Ticket ${id}`,
    description: "Text",
    acceptanceCriteria: "- It works",
    status: "backlog",
    comments: [],
    images: [],
    createdAt: OLD,
    updatedAt: OLD,
    order: 0,
    ...overrides,
  };
}

async function withStorage(
  rows: KanbanTask[] | null,
  run: (storage: StorageService, stored: (id: string) => KanbanTask | undefined) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "kanban-updated-at-"));
  if (rows) seedStore(dataDir, "kanban.json", rows);
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    await run(storage, (id) =>
      readStoredValue<KanbanTask[]>(dataDir, "kanban.json")?.find((task) => task.id === id),
    );
  } finally {
    storage.close?.();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Fails unless `value` is a readable timestamp later than `OLD`. */
function expectRefreshed(value: string | undefined): void {
  expect(value).toBeDefined();
  expect(Date.parse(value!)).toBeGreaterThan(Date.parse(OLD));
}

describe("kanban ticket updatedAt", () => {
  test("a new ticket is stored with updatedAt equal to createdAt", async () => {
    await withStorage(null, async ({ kanban }, stored) => {
      const task = await kanban.addKanbanTask(PROJECT, "New", "Body");
      expect(task.updatedAt).toBe(task.createdAt);
      expect(stored(task.id)?.updatedAt).toBe(task.createdAt);
      expect((await kanban.getKanbanTask(task.id))?.updatedAt).toBe(task.createdAt);
    });
  });

  test("an edit to the title or text refreshes it", async () => {
    await withStorage([row("a"), row("b")], async ({ kanban }, stored) => {
      const titled = await kanban.updateKanbanTask("a", { title: "Renamed" });
      expectRefreshed(titled.updatedAt);
      expect(stored("a")?.updatedAt).toBe(titled.updatedAt);
      expect(titled.createdAt).toBe(OLD);

      const edited = await kanban.updateKanbanTask("b", { description: "New text" });
      expectRefreshed(edited.updatedAt);
    });
  });

  test("a status change refreshes it, a move within the column does not", async () => {
    await withStorage([row("a"), row("b", { order: 1 })], async ({ kanban }, stored) => {
      const reordered = await kanban.updateKanbanTask("b", { order: 0 });
      expect(reordered.updatedAt).toBe(OLD);
      expect(stored("b")?.updatedAt).toBe(OLD);

      const moved = await kanban.updateKanbanTask("a", { status: "in-progress" });
      expectRefreshed(moved.updatedAt);
    });
  });

  test("labels, comments, build and pull request links refresh it", async () => {
    await withStorage(
      [row("label"), row("comment"), row("build"), row("pr")],
      async ({ kanban }) => {
        expectRefreshed((await kanban.setKanbanTaskLabel("label", "Bug", true)).updatedAt);
        expectRefreshed((await kanban.addKanbanComment("comment", "Note")).updatedAt);
        expectRefreshed(
          (await kanban.updateKanbanTask("build", { buildPipelineId: "pipeline-1" })).updatedAt,
        );
        expectRefreshed(
          (
            await kanban.updateKanbanTask("pr", {
              prUrl: "https://github.com/acme/repo/pull/1",
              prState: "open",
            })
          ).updatedAt,
        );
      },
    );
  });

  test("bookkeeping that changes nothing on the ticket leaves it alone", async () => {
    await withStorage(
      [row("a", { prUrl: "https://github.com/acme/repo/pull/1" })],
      async ({ kanban }) => {
        const marked = await kanban.updateKanbanTask("a", { prMergeCommented: true });
        expect(marked.updatedAt).toBe(OLD);
      },
    );
  });

  test("a ticket stored before updatedAt existed reads as updated when created", async () => {
    const { updatedAt: _none, ...legacy } = row("legacy");
    const invalid = row("invalid", { updatedAt: "not a date" });
    await withStorage([legacy as KanbanTask, invalid], async ({ kanban }, stored) => {
      const tasks = await kanban.getKanbanTasks(PROJECT);
      expect(tasks.map((task) => task.updatedAt)).toEqual([OLD, OLD]);
      // Read-time only: nothing is written back until the ticket changes.
      expect(stored("legacy")?.updatedAt).toBeUndefined();
      expectRefreshed((await kanban.updateKanbanTask("legacy", { title: "Edited" })).updatedAt);
    });
  });
});
