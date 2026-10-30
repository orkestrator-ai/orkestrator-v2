import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeTicketContent,
  parseTicketMarkdown,
  ticketMarkdown,
  type AcceptanceCriterion,
} from "@orkestrator/protocol/ticket-sections";
import type { KanbanTask } from "./storage-shared.js";
import type { CommandHandler } from "./commands-context.js";
import type { RegistryDependencies } from "./commands-registry-types.js";
import { registerKanbanCommands } from "./commands-registry-kanban.js";
import { StorageService } from "./storage.js";
import { readStoredValue, seedStore } from "./storage-test-support.js";

/**
 * The ticket dialog's round trip on rows written before sections existed
 * (todo 0742, task 6). The rows are hand-made in the shapes legacy tickets
 * take; each step goes through `update_kanban_task`, the command the dialog's
 * save calls, with the payload the dialog sends.
 */

const commands = new Map<string, CommandHandler>();
registerKanbanCommands((name, handler) => commands.set(name, handler), {} as RegistryDependencies);

const CREATED_AT = "2026-01-01T00:00:00.000Z";

const LEGACY_TEXT: Record<string, { description: string; acceptanceCriteria: string }> = {
  "bold lead-ins and label lines": {
    description:
      "**Problem:** the redirect loops.\n\nContext: seen on mobile.\nSteps:\n1. sign out\n2. reload\n",
    acceptanceCriteria: "- [x] Has a test\n- [ ] Redirects once\n  - on mobile too\n",
  },
  "alias headings and criteria in both fields": {
    description: "Fix it.\n\n## Background\n\nWhy.\n\n## Done when\n\n- Alias criterion",
    acceptanceCriteria: "- [x] Field criterion",
  },
  "criteria only in the description": {
    description: "Summary\n\n## Acceptance Criteria\n\n- [x] In description",
    acceptanceCriteria: "",
  },
  "CRLF line endings": {
    description: "Line one\r\nLine two\r\n\r\n## Notes\r\n\r\nA note\r\n",
    acceptanceCriteria: "- [x] Crlf one\r\n- Crlf two\r\n",
  },
  "code fences, subheadings and numbered criteria": {
    description: "Run:\n\n```md\n## Not a heading\n```\n\n### Sub\n\nText  \n",
    acceptanceCriteria: "1. First\n2. [x] Second\n\nParagraph after",
  },
  "paragraph criteria": {
    description: "",
    acceptanceCriteria: "Given a user\nThen they land.\n\nAnd it is fast.",
  },
  "custom, repeated and delivery headings": {
    description:
      "S\n\n## Rollout plan\n\nStep\n\n## Context\n\nA\n\n## Context\n\nB\n\n## Delivery\n\nPolicy: ship-it\nnow",
    acceptanceCriteria: "* [X] Upper X\n+ plus item",
  },
};

const LEGACY_ROWS = Object.entries(LEGACY_TEXT).map(([title, text], index) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  projectId: "project-1",
  title,
  ...text,
  status: "backlog",
  comments: [],
  images: [],
  createdAt: CREATED_AT,
  order: index,
}));

type LegacyRow = (typeof LEGACY_ROWS)[number];

async function withLegacyRows(
  run: (context: {
    storage: StorageService;
    stored: (id: string) => Record<string, unknown> | undefined;
    update: (args: Record<string, unknown>) => Promise<KanbanTask>;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "kanban-legacy-round-trip-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    seedStore(dataDir, "kanban.json", LEGACY_ROWS);
    await run({
      storage,
      stored: (id) =>
        readStoredValue<Array<Record<string, unknown>>>(dataDir, "kanban.json")?.find(
          (row) => row.id === id,
        ),
      update: async (args) =>
        (await commands.get("update_kanban_task")!(args, { storage } as never)) as KanbanTask,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function readRow(storage: StorageService, row: LegacyRow): Promise<KanbanTask> {
  const task = await storage.kanban.getKanbanTask(row.id);
  if (!task) throw new Error(`missing ${row.title}`);
  return task;
}

describe.each(LEGACY_ROWS.map((row) => [row.title, row] as const))(
  "legacy ticket with %s",
  (_title, row) => {
    test("opens with its text unchanged and an editor text that saves nothing", async () => {
      await withLegacyRows(async ({ storage, stored }) => {
        const task = await readRow(storage, row);
        expect(task.description).toBe(row.description);
        expect(task.acceptanceCriteria).toBe(row.acceptanceCriteria);
        expect(stored(row.id)).toEqual(row);
        // The dialog derives its content as `ticketContentOf` does.
        expect(normalizeTicketContent(task, { now: task.createdAt }).sections).toEqual(
          task.sections!,
        );
        // The editor text parses back to the same sections, so opening and
        // saving it untouched loses nothing (and the dialog sends nothing).
        const editorText = ticketMarkdown(task.sections!);
        expect(
          parseTicketMarkdown(editorText, {
            previousCriteria: task.sections!.acceptanceCriteria ?? [],
          }),
        ).toEqual(task.sections!);
      });
    });

    test("a title-only save leaves the stored text byte for byte", async () => {
      await withLegacyRows(async ({ stored, update }) => {
        await update({ taskId: row.id, title: `${row.title} (renamed)` });
        expect(stored(row.id)).toEqual({ ...row, title: `${row.title} (renamed)` });
      });
    });

    test("a section edit keeps the ids and ticks of unchanged criteria", async () => {
      await withLegacyRows(async ({ storage, update }) => {
        const before = (await readRow(storage, row)).sections!.acceptanceCriteria ?? [];
        const editorText = ticketMarkdown((await readRow(storage, row)).sections!);
        const edited = await update({
          taskId: row.id,
          markdown: `Edited summary line.\n\n${editorText}`,
        });
        expect(edited.sections!.acceptanceCriteria ?? []).toEqual(before);
        expect(edited.sections!.summary?.startsWith("Edited summary line.")).toBe(true);
        expect(await readRow(storage, row)).toEqual(edited);
      });
    });
  },
);

describe("legacy ticket edits", () => {
  const row = LEGACY_ROWS[0]!;

  test("a hand tick keeps its creation date, and a changed criterion loses its tick", async () => {
    await withLegacyRows(async ({ storage, update }) => {
      const read = await readRow(storage, row);
      expect(read.sections!.acceptanceCriteria).toEqual([
        {
          id: "ac-1",
          text: "Has a test",
          check: {
            status: "passed",
            evidence: "Ticked by hand in the ticket text.",
            checkedAt: CREATED_AT,
            source: "manual",
          },
        },
        { id: "ac-2", text: "Redirects once\n- on mobile too" },
      ]);
      const edited = await update({
        taskId: row.id,
        markdown: ticketMarkdown(read.sections!)
          .replace("- Has a test", "- Has a regression test")
          .replace("- Redirects once", "- [x] Redirects once"),
      });
      const criteria = edited.sections!.acceptanceCriteria as AcceptanceCriterion[];
      expect(criteria.map(({ id, text }) => ({ id, text }))).toEqual([
        { id: "ac-3", text: "Has a regression test" },
        { id: "ac-2", text: "Redirects once\n- on mobile too" },
      ]);
      expect(criteria[0]!.check).toBeUndefined();
      // A box ticked in this edit is a manual pass dated now, not at creation.
      expect(criteria[1]!.check).toMatchObject({ status: "passed", source: "manual" });
      expect(criteria[1]!.check!.checkedAt).not.toBe(CREATED_AT);
      expect(edited.description).toBe(
        "**Problem:** the redirect loops.\n\nContext: seen on mobile.\nSteps:\n1. sign out\n2. reload",
      );
    });
  });

  test("a status move then a title save still leaves the text alone", async () => {
    await withLegacyRows(async ({ stored, update }) => {
      await update({ taskId: row.id, status: "review" });
      await update({ taskId: row.id, title: "Renamed" });
      expect(stored(row.id)).toMatchObject({
        description: row.description,
        acceptanceCriteria: row.acceptanceCriteria,
      });
      expect(stored(row.id)).not.toHaveProperty("sections");
    });
  });
});
