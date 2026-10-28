import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandHandler } from "./commands-context.js";
import type { RegistryDependencies } from "./commands-registry-types.js";
import { registerKanbanCommands } from "./commands-registry-kanban.js";
import { StorageService } from "./storage.js";

const commands = new Map<string, CommandHandler>();
registerKanbanCommands((name, handler) => commands.set(name, handler), {} as RegistryDependencies);
const check = {
  status: "passed",
  evidence: "Checked",
  checkedAt: "2026-10-28T00:00:00Z",
  source: "verify",
} as const;
const entry = { id: "ac-1", text: "Criterion", check };

describe("Kanban content commands", () => {
  test.each([
    ["unknown argument", { taskId: "task", checks: [], extra: true }],
    ["oversized array", { taskId: "task", checks: Array(101).fill(entry) }],
    ["missing array", { taskId: "task" }],
    ["null item", { taskId: "task", checks: [null] }],
    ["unknown item field", { taskId: "task", checks: [{ ...entry, extra: true }] }],
    [
      "unknown check field",
      { taskId: "task", checks: [{ ...entry, check: { ...check, extra: true } }] },
    ],
    ["blank id", { taskId: "task", checks: [{ ...entry, id: " " }] }],
    ["invalid text", { taskId: "task", checks: [{ ...entry, text: 1 }] }],
    [
      "invalid status",
      { taskId: "task", checks: [{ ...entry, check: { ...check, status: "maybe" } }] },
    ],
    ["missing evidence", { taskId: "task", checks: [{ ...entry, check: { status: "passed" } }] }],
    [
      "oversized evidence",
      { taskId: "task", checks: [{ ...entry, check: { ...check, evidence: "x".repeat(2001) } }] },
    ],
  ])("rejects %s before writing storage", async (_name, args) => {
    await expect(
      Promise.resolve().then(() =>
        commands.get("record_kanban_criteria_checks")!(args, {} as never),
      ),
    ).rejects.toThrow();
  });

  test("markdown-only create persists content, and a valid check writes back", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kanban-command-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    try {
      const task = (await commands.get("add_kanban_task")!(
        {
          projectId: "project-1",
          title: "T",
          markdown: "Summary\n\n## Acceptance criteria\n\n- Criterion",
        },
        { storage } as never,
      )) as Awaited<ReturnType<typeof storage.kanban.addKanbanTask>>;
      expect(task.description).toBe("Summary");
      expect(task.acceptanceCriteria).toBe("- Criterion");
      expect(task.sections).toEqual({
        summary: "Summary",
        acceptanceCriteria: [{ id: "ac-1", text: "Criterion" }],
      });
      await commands.get("record_kanban_criteria_checks")!({ taskId: task.id, checks: [entry] }, {
        storage,
      } as never);
      expect(
        (await storage.kanban.getKanbanTask(task.id))?.sections?.acceptanceCriteria?.[0]?.check,
      ).toEqual(check);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
