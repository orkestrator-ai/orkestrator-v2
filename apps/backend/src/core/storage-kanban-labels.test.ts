import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TICKET_LABEL_LIMITS } from "@orkestrator/protocol/ticket-labels";
import { StorageService } from "./storage.js";
import { parseKanbanLabelInput } from "./storage-kanban-labels.js";

async function withStorage<T>(
  run: (storage: StorageService, dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-kanban-labels-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    return await run(storage, dataDir);
  } finally {
    storage.close?.();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("ticket label catalogue", () => {
  test("creates once per name ignoring case, and a repeat updates colour and description", async () => {
    await withStorage(async ({ kanban }) => {
      const first = await kanban.createKanbanLabel(
        "project-1",
        parseKanbanLabelInput({ name: "Bug", color: "#FF0000" }),
      );
      expect(first).toMatchObject({ created: true, label: { name: "Bug", color: "#ff0000" } });
      const again = await kanban.createKanbanLabel(
        "project-1",
        parseKanbanLabelInput({ name: "bug", description: "Something broke" }),
      );
      expect(again).toMatchObject({
        created: false,
        label: { name: "Bug", color: "#ff0000", description: "Something broke" },
      });
      await kanban.createKanbanLabel("project-2", parseKanbanLabelInput({ name: "other" }));
      expect((await kanban.getKanbanLabels("project-1")).map((label) => label.name)).toEqual([
        "Bug",
      ]);
    });
  });

  test("a label a ticket already carries keeps that spelling in the catalogue", async () => {
    await withStorage(async ({ kanban }) => {
      await kanban.addKanbanTask("project-1", "Ticket", "", { labels: ["UI"] });
      const { label } = await kanban.createKanbanLabel(
        "project-1",
        parseKanbanLabelInput({ name: "ui" }),
      );
      expect(label.name).toBe("UI");
      expect(await kanban.getKanbanLabels("project-1")).toMatchObject([
        { name: "UI", ticketCount: 1 },
      ]);
    });
  });

  test.each(["", "  \t "])(
    "explicit description %j clears metadata; omission preserves it",
    async (description) => {
      await withStorage(async ({ kanban }) => {
        await kanban.createKanbanLabel("project-1", { name: "Bug", description: "Old" });
        await kanban.createKanbanLabel("project-1", parseKanbanLabelInput({ name: "bug" }));
        expect(await kanban.getKanbanLabels("project-1")).toMatchObject([{ description: "Old" }]);
        await kanban.createKanbanLabel(
          "project-1",
          parseKanbanLabelInput({ name: "BUG", description }),
        );
        const [label] = await kanban.getKanbanLabels("project-1");
        expect(label?.description).toBeUndefined();
      });
    },
  );

  test("catalogue capacity refuses a new name but permits an existing name's metadata update", async () => {
    await withStorage(async ({ kanban }) => {
      for (let i = 0; i < TICKET_LABEL_LIMITS.maxCatalogue; i++) {
        await kanban.createKanbanLabel("project-1", { name: "label-" + i });
      }
      await expect(kanban.createKanbanLabel("project-1", { name: "overflow" })).rejects.toThrow(
        "at most 200",
      );
      expect(
        await kanban.createKanbanLabel("project-1", { name: "LABEL-0", color: "#ff0000" }),
      ).toMatchObject({
        created: false,
        label: { name: "label-0", color: "#ff0000" },
      });
      expect(await kanban.getKanbanLabels("project-1")).toHaveLength(
        TICKET_LABEL_LIMITS.maxCatalogue,
      );
    });
  });

  test("concurrent label changes through two handles preserve independent writes and one catalogue entry", async () => {
    await withStorage(async (first, dataDir) => {
      const second = new StorageService(dataDir);
      await second.init();
      try {
        const ticket = await first.kanban.addKanbanTask("project-1", "Ticket", "");
        await Promise.all([
          first.kanban.setKanbanTaskLabel(ticket.id, "bug", true),
          second.kanban.setKanbanTaskLabel(ticket.id, "ui", true),
        ]);
        expect((await second.kanban.getKanbanTask(ticket.id))?.labels).toEqual(["bug", "ui"]);
        const results = await Promise.all([
          first.kanban.createKanbanLabel("project-1", { name: "Shared", color: "#ff0000" }),
          second.kanban.createKanbanLabel("project-1", { name: "SHARED", description: "Details" }),
        ]);
        expect(results.map((result) => result.created).sort()).toEqual([false, true]);
        expect(
          (await first.kanban.getKanbanLabels("project-1")).filter((label) => label.createdAt),
        ).toMatchObject([{ name: "Shared", color: "#ff0000", description: "Details" }]);
        await Promise.all([
          first.kanban.createKanbanLabel("project-1", { name: "shared", color: "#00ff00" }),
          second.kanban.createKanbanLabel("project-1", { name: "Shared", description: "Updated" }),
        ]);
        expect(await second.kanban.getKanbanLabels("project-1")).toContainEqual(
          expect.objectContaining({ name: "Shared", color: "#00ff00", description: "Updated" }),
        );
      } finally {
        second.close();
      }
    });
  });

  test("refuses invalid input", () => {
    expect(() => parseKanbanLabelInput({ name: "" })).toThrow("must not be empty");
    expect(() => parseKanbanLabelInput({ name: "x", color: "red" })).toThrow("#rrggbb");
    expect(() =>
      parseKanbanLabelInput({
        name: "x",
        description: "d".repeat(TICKET_LABEL_LIMITS.maxDescriptionLength + 1),
      }),
    ).toThrow("at most");
  });
});

describe("labels on tickets", () => {
  test("add and remove one label, keeping the catalogue's spelling", async () => {
    await withStorage(async ({ kanban }) => {
      await kanban.createKanbanLabel("project-1", parseKanbanLabelInput({ name: "Needs design" }));
      const task = await kanban.addKanbanTask("project-1", "Ticket", "");
      expect(task.labels).toBeUndefined();
      const added = await kanban.setKanbanTaskLabel(task.id, "needs DESIGN", true, "project-1");
      expect(added.labels).toEqual(["Needs design"]);
      const unchanged = await kanban.setKanbanTaskLabel(task.id, "Needs design", true);
      expect(unchanged.labels).toEqual(["Needs design"]);
      const removed = await kanban.setKanbanTaskLabel(task.id, "NEEDS design", false);
      expect(removed.labels).toBeUndefined();
      await expect(kanban.setKanbanTaskLabel(task.id, "x", true, "project-2")).rejects.toThrow(
        "not found",
      );
    });
  });

  test("a ticket holds at most the limit, and update replaces or clears its labels", async () => {
    await withStorage(async ({ kanban }) => {
      const full = Array.from({ length: TICKET_LABEL_LIMITS.maxPerTicket }, (_, i) => `l${i}`);
      const task = await kanban.addKanbanTask("project-1", "Ticket", "", { labels: full });
      await expect(kanban.setKanbanTaskLabel(task.id, "one more", true)).rejects.toThrow("at most");
      expect((await kanban.updateKanbanTask(task.id, { labels: ["only"] })).labels).toEqual([
        "only",
      ]);
      expect((await kanban.updateKanbanTask(task.id, { labels: [] })).labels).toBeUndefined();
    });
  });

  test("replacement preserves spelling from the only ticket using an uncatalogued label", async () => {
    await withStorage(async ({ kanban }) => {
      const task = await kanban.addKanbanTask("project-1", "Ticket", "", { labels: ["bug"] });
      expect((await kanban.updateKanbanTask(task.id, { labels: ["BUG", "ui"] })).labels).toEqual([
        "bug",
        "ui",
      ]);
    });
  });

  test("a replayed create must carry the same labels", async () => {
    await withStorage(async ({ kanban }) => {
      const first = await kanban.addKanbanTask("project-1", "Ticket", "", {
        requestId: "r1",
        labels: ["bug"],
      });
      const replay = await kanban.addKanbanTask("project-1", "Ticket", "", {
        requestId: "r1",
        labels: ["Bug"],
      });
      expect(replay.id).toBe(first.id);
      await expect(
        kanban.addKanbanTask("project-1", "Ticket", "", { requestId: "r1", labels: ["ui"] }),
      ).rejects.toThrow("different arguments");
    });
  });
});
