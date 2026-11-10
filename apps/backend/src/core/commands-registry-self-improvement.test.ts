import { describe, expect, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import { kanbanBoard } from "./commands-registry-self-improvement.js";
import { withTemporaryStorage } from "./storage-test-support.js";

describe("the self-improvement board over Kanban storage", () => {
  test("files, labels, comments and moves tickets on its own project only", async () => {
    await withTemporaryStorage(async (storage) => {
      const context = { storage } as unknown as CommandContext;
      const board = kanbanBoard(context, "p1");
      const other = await storage.kanban.addKanbanTask("p2", "Another project's ticket", "");

      await board.ensureLabels([
        { name: "insight", color: "#7C3AED", description: "conversations" },
        { name: "improvement", color: "#0EA5E9", description: "diagnostics" },
      ]);
      await board.ensureLabels([{ name: "insight", color: "#7C3AED", description: "again" }]);
      expect(
        (await storage.kanban.getKanbanLabels("p1")).map((label) => label.name).sort(),
      ).toEqual(["improvement", "insight"]);

      const input = {
        title: "[insight] Agents keep reaching for npm",
        description: "Theme `insight:use-mise-not-npm`.",
        criteria: "No reminders needed.",
        label: "insight",
        requestId: "self-improvement-d1-abc",
      };
      const id = await board.create(input);
      // The same request id replays rather than filing a second ticket.
      expect(await board.create(input)).toBe(id);
      const task = await storage.kanban.getKanbanTask(id);
      expect(task).toMatchObject({ projectId: "p1", status: "backlog", labels: ["insight"] });
      expect(task?.acceptanceCriteria).toContain("No reminders needed.");

      await storage.kanban.updateKanbanTask(id, { status: "done" }, "p1");
      expect(await board.get(id)).toMatchObject({ id, status: "done" });
      await board.comment(id, "Self-improvement: the fix did not change the rate.", "verdict-1");
      // A retry under the same id posts nothing, even with other numbers in the text.
      await board.comment(id, "Self-improvement: the fix did not change the rate.", "verdict-1");
      await board.comment(id, "Self-improvement: other numbers.", "verdict-1");
      await board.moveToBacklog(id);
      const moved = await storage.kanban.getKanbanTask(id);
      expect(moved?.status).toBe("backlog");
      expect(moved?.comments).toHaveLength(1);
      expect(moved?.comments?.at(-1)?.text).toContain("did not change the rate");

      expect(board.projectId).toBe("p1");
      expect(await board.get(other.id)).toBeNull();
      // Another project's ticket is not on this board, but it is not deleted either.
      expect(await board.locate!(other.id)).toBe("p2");
      expect(await kanbanBoard(context, "p2").get(other.id)).toMatchObject({ id: other.id });
      expect(await board.get("missing")).toBeNull();
      expect(await board.locate!("missing")).toBeNull();
      expect((await board.list()).map((ticket) => ticket.id)).toEqual([id]);
    });
  });
});
