import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandHandler } from "./commands-context.js";
import type { RegistryDependencies } from "./commands-registry-types.js";
import { registerKanbanCommands } from "./commands-registry-kanban.js";
import { withTemporaryStorage } from "./storage-test-support.js";
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

test("terminal status updates preserve done under storage's lease, while users can reopen", async () => {
  await withTemporaryStorage(async (storage) => {
    const task = await storage.kanban.addKanbanTask("project-1", "Done", "");
    const prUrl = "https://github.com/acme/repo/pull/1";
    await storage.kanban.closeKanbanTasksForMergedPullRequests([{ taskId: task.id, prUrl }]);
    const update = commands.get("update_kanban_task")!;
    await update({ taskId: task.id, status: "backlog", preserveDoneStatus: true }, {
      storage,
    } as never);
    expect(await storage.kanban.getKanbanTask(task.id)).toMatchObject({
      status: "done",
      prMergeDoneUrl: prUrl,
    });
    await update({ taskId: task.id, status: "backlog" }, { storage } as never);
    expect(await storage.kanban.getKanbanTask(task.id)).toMatchObject({
      status: "backlog",
      prMergeDoneUrl: prUrl,
    });
  });
});

describe("Kanban label command validation", () => {
  test.each([
    ["get_kanban_labels", {}, "projectId"],
    ["get_kanban_labels", { projectId: "p", extra: true }, "extra"],
    ["get_kanban_labels", { projectId: " " }, "projectId"],
    ["create_kanban_label", { projectId: "p", name: "bug", extra: true }, "extra"],
    ["create_kanban_label", { name: "bug" }, "projectId"],
    ["create_kanban_label", { projectId: "p", name: " " }, "empty"],
    ["create_kanban_label", { projectId: "p", name: "bug", color: "red" }, "#rrggbb"],
    ["create_kanban_label", { projectId: "p", name: "bug", description: 1 }, "description"],
    ["set_kanban_task_label", { taskId: "t", name: "bug", extra: true }, "extra"],
    ["set_kanban_task_label", { taskId: "t", name: "bug", present: "false" }, "boolean"],
    ["set_kanban_task_label", { taskId: "t", name: "bug", present: null }, "boolean"],
    ["set_kanban_task_label", { name: "bug" }, "taskId"],
    ["set_kanban_task_label", { taskId: "t", name: "" }, "name"],
    ["set_kanban_task_label", { taskId: "t", name: "bug", projectId: "" }, "projectId"],
  ] as const)("refuses invalid %s input before storage: %j", async (name, input, message) => {
    await expect(
      Promise.resolve().then(() =>
        commands.get(name)!(input, { storage: { kanban: {} } } as never),
      ),
    ).rejects.toThrow(message);
  });

  test("label commands persist metadata and default present to true, while false removes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kanban-label-command-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    const context = { storage } as never;
    try {
      const task = await storage.kanban.addKanbanTask("p", "Ticket", "");
      expect(
        await commands.get("create_kanban_label")!(
          { projectId: "p", name: " Needs  design ", color: "#AABBCC", description: "Details" },
          context,
        ),
      ).toMatchObject({ created: true, label: { name: "Needs design", color: "#aabbcc" } });
      expect(
        await commands.get("set_kanban_task_label")!(
          { taskId: task.id, name: "needs design", projectId: "p" },
          context,
        ),
      ).toMatchObject({ labels: ["Needs design"] });
      expect(await commands.get("get_kanban_labels")!({ projectId: "p" }, context)).toMatchObject([
        { name: "Needs design", description: "Details", ticketCount: 1 },
      ]);
      await commands.get("set_kanban_task_label")!(
        { taskId: task.id, name: "NEEDS DESIGN", present: false, projectId: "p" },
        context,
      );
      expect((await storage.kanban.getKanbanTask(task.id))?.labels).toBeUndefined();
      await expect(
        Promise.resolve().then(() =>
          commands.get("set_kanban_task_label")!(
            { taskId: task.id, name: "bug", projectId: "other" },
            context,
          ),
        ),
      ).rejects.toThrow("not found");
    } finally {
      storage.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
