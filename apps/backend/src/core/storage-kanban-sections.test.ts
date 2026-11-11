import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { StorageService } from "./storage.js";
import { readStoredValue, seedStore } from "./storage-test-support.js";

async function withStorage<T>(
  run: (storage: StorageService, dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-kanban-sections-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    return await run(storage, dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const LEGACY_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "project-1",
  title: "Legacy",
  description: "Fix the redirect.\n\n## Background\n\nSeen on mobile.",
  acceptanceCriteria: "Given a signed-out user\nThen they land on /login.\n\n- [x] Has a test",
  status: "backlog",
  comments: [],
  images: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  order: 0,
};

const VERIFY_PASS = {
  status: "passed" as const,
  evidence: "bun test redirect.test.ts",
  checkedAt: "2026-10-28T00:00:00.000Z",
  source: "verify" as const,
  pipelineId: "pipeline-1",
};

describe("delivery policy changes", () => {
  test("announces a changed policy from any writer, and nothing else", async () => {
    await withStorage(async ({ kanban }) => {
      const seen: Array<[string, string, string | undefined]> = [];
      kanban.onDeliveryPolicyChange((taskId, projectId, policy) => {
        seen.push([taskId, projectId, policy]);
      });
      const task = await kanban.addKanbanTask("project-1", "Ticket", "Body");

      await kanban.updateKanbanTask(task.id, { title: "Renamed" });
      expect(seen).toEqual([]);

      await kanban.updateKanbanTask(task.id, { sections: { delivery: { policy: "push-no-pr" } } });
      expect(seen).toEqual([[task.id, "project-1", "push-no-pr"]]);

      await kanban.updateKanbanTask(task.id, { sections: { delivery: { policy: "push-no-pr" } } });
      expect(seen).toHaveLength(1);

      await kanban.updateKanbanTask(task.id, {
        markdown: "Body\n\n## Delivery\n\nPolicy: commit-only",
      });
      expect(seen.at(-1)).toEqual([task.id, "project-1", "commit-only"]);

      await kanban.updateKanbanTask(task.id, { markdown: "Body" });
      expect(seen.at(-1)).toEqual([task.id, "project-1", undefined]);
    });
  });
});

describe("Kanban ticket sections", () => {
  test("a legacy row reads with derived sections and is not rewritten", async () => {
    await withStorage(async (storage, dataDir) => {
      seedStore(dataDir, "kanban.json", [LEGACY_ROW]);
      const [task] = await storage.kanban.getKanbanTasks("project-1");
      expect(task).toMatchObject({
        kind: "feature",
        description: LEGACY_ROW.description,
        acceptanceCriteria: LEGACY_ROW.acceptanceCriteria,
        sections: {
          summary: "Fix the redirect.",
          context: "Seen on mobile.",
          acceptanceCriteria: [
            { id: "ac-1", text: "Given a signed-out user\nThen they land on /login." },
            {
              id: "ac-2",
              text: "Has a test",
              check: { status: "passed", source: "manual", checkedAt: LEGACY_ROW.createdAt },
            },
          ],
        },
      });
      expect(await storage.kanban.getKanbanTasks("project-1")).toEqual([task!]);
      const stored = readStoredValue<Array<Record<string, unknown>>>(dataDir, "kanban.json");
      expect(stored?.[0]).toEqual(LEGACY_ROW);
    });
  });

  test("reading a legacy row is counted; a current row is not", async () => {
    await withStorage(async (storage, dataDir) => {
      const id = "kanban.legacy-row-derived";
      const count = () => compatibilityPathUsage.snapshot().paths[id]?.count ?? 0;
      const current = await storage.kanban.addKanbanTask("project-1", "Current", "Body");
      const before = count();
      await storage.kanban.getKanbanTasks("project-1");
      expect(count()).toBe(before);
      const rows = readStoredValue<Array<Record<string, unknown>>>(dataDir, "kanban.json") ?? [];
      seedStore(dataDir, "kanban.json", [...rows, LEGACY_ROW]);
      const read = await storage.kanban.getKanbanTasks("project-1");
      expect(read.map((task) => task.id).sort()).toEqual([current.id, LEGACY_ROW.id].sort());
      expect(count()).toBe(before + 1);
    });
  });

  test("a status move on a legacy row leaves its text alone", async () => {
    await withStorage(async (storage, dataDir) => {
      seedStore(dataDir, "kanban.json", [LEGACY_ROW]);
      const moved = await storage.kanban.updateKanbanTask(LEGACY_ROW.id, { status: "review" });
      expect(moved.description).toBe(LEGACY_ROW.description);
      expect(moved.acceptanceCriteria).toBe(LEGACY_ROW.acceptanceCriteria);
    });
  });

  test("creates a work brief from sections and renders the text mirrors", async () => {
    await withStorage(async (storage) => {
      const task = await storage.kanban.addKanbanTask("project-1", "Brief", "", {
        kind: "work-brief",
        sections: {
          problem: "Delivery policy conflicts.",
          acceptanceCriteria: ["Policy is a field"],
          checks: ["mise run lint"],
          delivery: { policy: "push-no-pr" },
        },
      });
      expect(task.kind).toBe("work-brief");
      expect(task.description).toBe(
        "## Problem\n\nDelivery policy conflicts.\n\n## Checks\n\n- mise run lint\n\n## Delivery\n\nPolicy: push-no-pr",
      );
      expect(task.acceptanceCriteria).toBe("- Policy is a field");
      expect(task.sections?.acceptanceCriteria).toEqual([
        { id: "ac-1", text: "Policy is a field" },
      ]);
    });
  });

  test("markdown-only creation retains parsed content in storage", async () => {
    await withStorage(async (storage, dataDir) => {
      const task = await storage.kanban.addKanbanTask("project-1", "T", undefined, {
        markdown: "Summary text\n\n## Acceptance criteria\n\n- Kept criterion",
      });
      expect(task.description).toBe("Summary text");
      expect(task.acceptanceCriteria).toBe("- Kept criterion");
      expect(task.sections).toEqual({
        summary: "Summary text",
        acceptanceCriteria: [{ id: "ac-1", text: "Kept criterion" }],
      });
      expect(
        readStoredValue<Array<Record<string, unknown>>>(dataDir, "kanban.json")?.[0],
      ).toMatchObject(task);
      expect(await storage.kanban.getKanbanTask(task.id)).toEqual(task);
    });
  });

  test("explicit text overrides on Markdown creation remain intentional", async () => {
    await withStorage(async (storage) => {
      const task = await storage.kanban.addKanbanTask("project-1", "T", "", {
        markdown: "Summary\n\n## Acceptance criteria\n\n- Original",
        acceptanceCriteria: "",
      });
      expect(task.description).toBe("");
      expect(task.acceptanceCriteria).toBe("");
      expect(task.sections).toEqual({});
    });
  });

  test("a markdown edit keeps the Verify result of an unchanged criterion only", async () => {
    await withStorage(async (storage) => {
      const created = await storage.kanban.addKanbanTask("project-1", "T", "", {
        sections: { acceptanceCriteria: ["Keeps", "Changes"] },
      });
      await storage.kanban.recordKanbanCriteriaChecks(created.id, [
        { id: "ac-1", text: "Keeps", check: VERIFY_PASS },
        { id: "ac-2", text: "Changes", check: VERIFY_PASS },
        { id: "ac-9", text: "Unknown", check: VERIFY_PASS },
      ]);
      const edited = await storage.kanban.updateKanbanTask(created.id, {
        markdown: "Now with a summary.\n\n## Acceptance criteria\n\n- Keeps\n- Changed",
      });
      expect(edited.sections).toEqual({
        summary: "Now with a summary.",
        acceptanceCriteria: [
          { id: "ac-1", text: "Keeps", check: VERIFY_PASS },
          { id: "ac-3", text: "Changed" },
        ],
      });
    });
  });

  test("results for criteria edited since the pipeline started are dropped", async () => {
    await withStorage(async (storage) => {
      const created = await storage.kanban.addKanbanTask("project-1", "T", "", {
        sections: { acceptanceCriteria: ["Current text"] },
      });
      const unchanged = await storage.kanban.recordKanbanCriteriaChecks(created.id, [
        { id: "ac-1", text: "Old text", check: VERIFY_PASS },
      ]);
      expect(unchanged?.sections?.acceptanceCriteria).toEqual([
        { id: "ac-1", text: "Current text" },
      ]);
      expect(await storage.kanban.recordKanbanCriteriaChecks("missing", [])).toBeNull();
    });
  });

  test("an older writer's text-only edit rebuilds sections and keeps unchanged results", async () => {
    await withStorage(async (storage, dataDir) => {
      const created = await storage.kanban.addKanbanTask("project-1", "T", "", {
        sections: { summary: "Old", acceptanceCriteria: ["Stays"] },
      });
      await storage.kanban.recordKanbanCriteriaChecks(created.id, [
        { id: "ac-1", text: "Stays", check: VERIFY_PASS },
      ]);
      const rows = readStoredValue<Array<Record<string, unknown>>>(dataDir, "kanban.json")!;
      // An older backend knows only the text fields and writes them in place.
      seedStore(dataDir, "kanban.json", [{ ...rows[0], description: "## Problem\n\nNew" }]);
      const task = await storage.kanban.getKanbanTask(created.id);
      expect(task?.sections).toEqual({
        problem: "New",
        acceptanceCriteria: [{ id: "ac-1", text: "Stays", check: VERIFY_PASS }],
      });
    });
  });

  test("requestId replays match on the rendered content and kind", async () => {
    await withStorage(async (storage) => {
      const input = {
        requestId: "same",
        kind: "work-brief" as const,
        sections: { summary: "S" },
      };
      const first = await storage.kanban.addKanbanTask("project-1", "T", "", input);
      const replay = await storage.kanban.addKanbanTask("project-1", "T", "", input);
      expect(replay.id).toBe(first.id);
      await expect(
        storage.kanban.addKanbanTask("project-1", "T", "", { ...input, kind: "feature" }),
      ).rejects.toThrow("already used with different arguments");
    });
  });
});

test("launch policy writes do not notify the previous build and deletion retains the newest choice", async () => {
  await withStorage(async (storage, dataDir) => {
    const seen: string[] = [];
    storage.kanban.onDeliveryPolicyChange(() => seen.push("changed"));
    const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body");
    const { saveTicketDeliveryPolicy } = await import("./build-pipeline-launch.js");
    await saveTicketDeliveryPolicy(storage, task, "push-no-pr");
    expect(seen).toEqual([]);
    await storage.kanban.updateKanbanTask(task.id, {
      sections: { delivery: { policy: "commit-only" } },
    });
    expect(seen).toEqual(["changed"]);
    await storage.kanban.deleteKanbanTask(task.id);
    const reopened = new StorageService(dataDir);
    expect(await reopened.kanban.getDeletedKanbanDeliveryPolicy(task.id, "project-1")).toBe(
      "commit-only",
    );
    expect(
      await reopened.kanban.getDeletedKanbanDeliveryPolicy(task.id, "other-project"),
    ).toBeUndefined();
  });
});
