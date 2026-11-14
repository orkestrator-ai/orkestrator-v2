import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
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
const LATER = "2026-02-01T00:00:00.000Z";
const LATEST = "2026-03-01T00:00:00.000Z";
const PROJECT = "project-1";
const IMAGE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
).toString("base64");

// Tests that pin the clock to tell two changes apart restore it.
afterEach(() => setSystemTime());

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

  test("deleting a comment, and adding or removing an image, refresh it", async () => {
    const comment = { id: "comment-1", text: "Old note", createdAt: OLD };
    await withStorage(
      [row("comment", { comments: [comment] }), row("image")],
      async ({ kanban }, stored) => {
        const uncommented = await kanban.deleteKanbanComment("comment", comment.id);
        expectRefreshed(uncommented.updatedAt);
        expect(stored("comment")?.updatedAt).toBe(uncommented.updatedAt);

        setSystemTime(new Date(LATER));
        const withImage = await kanban.addKanbanImage("image", "pixel.svg", IMAGE);
        expect(withImage.updatedAt).toBe(LATER);
        expect(stored("image")?.updatedAt).toBe(LATER);

        setSystemTime(new Date(LATEST));
        const withoutImage = await kanban.deleteKanbanImage("image", withImage.images[0]!.id);
        expect(withoutImage.updatedAt).toBe(LATEST);
        expect(stored("image")?.updatedAt).toBe(LATEST);
      },
    );
  });

  test("structured criteria, their results and the delivery section refresh it", async () => {
    await withStorage([row("criteria"), row("delivery")], async ({ kanban }, stored) => {
      setSystemTime(new Date(LATER));
      const structured = await kanban.updateKanbanTask("criteria", {
        sections: { acceptanceCriteria: [{ id: "ac-1", text: "Works" }] },
      });
      expect(structured.updatedAt).toBe(LATER);
      const criterion = structured.sections?.acceptanceCriteria?.[0];
      expect(criterion?.text).toBe("Works");

      setSystemTime(new Date(LATEST));
      const checked = await kanban.recordKanbanCriteriaChecks("criteria", [
        {
          id: criterion!.id,
          text: "Works",
          check: { status: "passed", evidence: "test passes", source: "verify", checkedAt: LATEST },
        },
      ]);
      expect(checked?.sections?.acceptanceCriteria?.[0]?.check?.status).toBe("passed");
      expect(checked?.updatedAt).toBe(LATEST);
      expect(stored("criteria")?.updatedAt).toBe(LATEST);

      const delivered = await kanban.updateKanbanTask("delivery", {
        sections: { delivery: { note: "Ship on Friday" } },
      });
      expect(delivered.updatedAt).toBe(LATEST);
      expect(stored("delivery")?.updatedAt).toBe(LATEST);
    });
  });

  test("environment and remote-work links refresh it", async () => {
    await withStorage(
      [row("environment"), row("remote")],
      async ({ kanban, ticketSync }, stored) => {
        const linked = await kanban.updateKanbanTask("environment", { environmentId: "env-1" });
        expectRefreshed(linked.updatedAt);
        expect(stored("environment")?.updatedAt).toBe(linked.updatedAt);

        const remote = await ticketSync.recordTicketRemoteWork("remote", {
          nodeId: "leaf-1",
          environmentId: "env-2",
          updatedAt: OLD,
        });
        expectRefreshed(remote.updatedAt);
        expect(stored("remote")?.updatedAt).toBe(remote.updatedAt);
      },
    );
  });

  test("a change to only a board ticket's links moves its seq, not its revisions", async () => {
    const { sync: _none, ...unsynced } = row("legacy");
    await withStorage([unsynced as KanbanTask], async ({ kanban }, stored) => {
      const ticket = await kanban.addKanbanTask(PROJECT, "Synced", "");
      const before = stored(ticket.id)?.sync;
      expect(before).toBeDefined();

      await kanban.updateKanbanTask(ticket.id, { buildPipelineId: "pipeline-1" });
      const after = stored(ticket.id)?.sync;
      expect(after?.seq).toBeGreaterThan(before!.seq);
      expect(after?.revs).toEqual(before!.revs);

      // A row with no sync record yet gets one, so a later leaf sees the change.
      expect(stored("legacy")?.sync).toBeUndefined();
      await kanban.updateKanbanTask("legacy", { prUrl: "https://github.com/acme/repo/pull/2" });
      const created = stored("legacy")?.sync;
      expect(created?.seq).toBeGreaterThan(after!.seq);
      expect(created?.revs).toEqual({});
    });
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
