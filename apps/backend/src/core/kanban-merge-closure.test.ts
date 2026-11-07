import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  kanbanTaskAwaitsMergeClosure,
  mergedPullRequestOnTicket,
  pendingMergeClosures,
  PR_CLOSED_COMMENT,
  PR_MERGED_COMMENT,
} from "./kanban-merge-closure.js";
import type { KanbanTask } from "./storage-shared.js";
import { StorageService } from "./storage.js";

const PR1 = "https://github.com/org/repo/pull/1";
const PR2 = "https://github.com/org/repo/pull/2";

function task(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    projectId: "p1",
    title: "Ticket",
    description: "",
    acceptanceCriteria: "",
    status: "backlog",
    comments: [],
    images: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    order: 0,
    ...overrides,
  };
}

const comment = (text: string) => ({ id: text, text, createdAt: "2026-01-01T00:00:00.000Z" });

describe("mergedPullRequestOnTicket", () => {
  test("reads the linked pull request when there is one", () => {
    expect(mergedPullRequestOnTicket(task({ prUrl: PR1, prState: "merged" }))).toBe(PR1);
    expect(mergedPullRequestOnTicket(task({ prUrl: PR1, prState: "open" }))).toBeNull();
    // A linked open PR wins over an older merged comment.
    expect(
      mergedPullRequestOnTicket(
        task({
          prUrl: PR2,
          prState: "open",
          comments: [comment(`${PR_MERGED_COMMENT}: ${PR1}`)],
        }),
      ),
    ).toBeNull();
  });

  test("falls back to the monitor's latest pull-request comment", () => {
    expect(
      mergedPullRequestOnTicket(task({ comments: [comment(`${PR_MERGED_COMMENT}: ${PR1}`)] })),
    ).toBe(PR1);
    expect(
      mergedPullRequestOnTicket(
        task({
          comments: [comment(`${PR_MERGED_COMMENT}: ${PR1}`), comment(`🔗 PR raised: ${PR2}`)],
        }),
      ),
    ).toBeNull();
    expect(
      mergedPullRequestOnTicket(task({ comments: [comment(`${PR_CLOSED_COMMENT}: ${PR1}`)] })),
    ).toBeNull();
    expect(
      mergedPullRequestOnTicket(task({ comments: [comment("PR merged, thanks")] })),
    ).toBeNull();
  });
});

describe("kanbanTaskAwaitsMergeClosure", () => {
  test("closes once per pull request", () => {
    expect(kanbanTaskAwaitsMergeClosure({ status: "backlog" }, PR1)).toBe(true);
    expect(kanbanTaskAwaitsMergeClosure({ status: "done" }, PR1)).toBe(true);
    expect(kanbanTaskAwaitsMergeClosure({ status: "backlog", prMergeDoneUrl: PR1 }, PR1)).toBe(
      false,
    );
    expect(kanbanTaskAwaitsMergeClosure({ status: "backlog", prMergeDoneUrl: PR1 }, PR2)).toBe(
      true,
    );
  });
});

describe("pendingMergeClosures", () => {
  test("names recorded merges not yet applied, skipping tickets being built again", () => {
    expect(
      pendingMergeClosures([
        task({ id: "backlog", prUrl: PR1, prState: "merged" }),
        task({ id: "review", status: "review", prUrl: PR1, prState: "merged" }),
        task({ id: "commented", comments: [comment(`${PR_MERGED_COMMENT}: ${PR2}`)] }),
        task({ id: "building", status: "in-progress", prUrl: PR1, prState: "merged" }),
        task({ id: "done", status: "done", prUrl: PR1, prState: "merged" }),
        task({ id: "reopened", prUrl: PR1, prState: "merged", prMergeDoneUrl: PR1 }),
        task({ id: "open", prUrl: PR1, prState: "open" }),
      ]),
    ).toEqual([
      { taskId: "backlog", prUrl: PR1 },
      { taskId: "review", prUrl: PR1 },
      { taskId: "commented", prUrl: PR2 },
      { taskId: "done", prUrl: PR1 },
    ]);
  });
});

describe("closeKanbanTasksForMergedPullRequests", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function storage(): Promise<StorageService> {
    const dir = await mkdtemp(join(tmpdir(), "orkestrator-merge-closure-"));
    dirs.push(dir);
    const service = new StorageService(dir);
    await service.init();
    return service;
  }

  test("moves a named ticket to done at the end of the column, once", async () => {
    const store = await storage();
    const finished = await store.kanban.addKanbanTask("p1", "Finished", "");
    await store.kanban.updateKanbanTask(finished.id, { status: "done" });
    const merged = await store.kanban.addKanbanTask("p1", "Merged", "");

    expect(
      await store.kanban.closeKanbanTasksForMergedPullRequests([{ taskId: merged.id, prUrl: PR1 }]),
    ).toEqual([merged.id]);
    const closed = await store.kanban.getKanbanTask(merged.id);
    expect(closed).toMatchObject({ status: "done", prMergeDoneUrl: PR1, order: 1 });

    // Reopened by the user: the same merge never closes it again.
    await store.kanban.updateKanbanTask(merged.id, { status: "backlog" });
    expect(
      await store.kanban.closeKanbanTasksForMergedPullRequests([{ taskId: merged.id, prUrl: PR1 }]),
    ).toEqual([]);
    expect((await store.kanban.getKanbanTask(merged.id))?.status).toBe("backlog");
    // A missing ticket is skipped.
    expect(
      await store.kanban.closeKanbanTasksForMergedPullRequests([{ taskId: "gone", prUrl: PR1 }]),
    ).toEqual([]);
  });

  test("marks an already-done merge without reordering, and preserves a later reopen", async () => {
    const store = await storage();
    const ticket = await store.kanban.addKanbanTask("p1", "Done", "");
    await store.kanban.updateKanbanTask(ticket.id, {
      status: "done",
      prUrl: PR1,
      prState: "merged",
    });
    const before = await store.kanban.getKanbanTask(ticket.id);
    expect(await store.kanban.closeKanbanTasksForMergedPullRequests()).toEqual([]);
    expect(await store.kanban.getKanbanTask(ticket.id)).toMatchObject({
      status: "done",
      order: before!.order,
      prMergeDoneUrl: PR1,
    });
    await store.kanban.updateKanbanTask(ticket.id, { status: "review" });
    expect(await store.kanban.closeKanbanTasksForMergedPullRequests()).toEqual([]);
    expect(await store.kanban.getKanbanTask(ticket.id)).toMatchObject({
      status: "review",
      prMergeDoneUrl: PR1,
    });
  });

  test("without names, sweeps every board for recorded merges", async () => {
    const store = await storage();
    const linked = await store.kanban.addKanbanTask("p1", "Linked", "");
    await store.kanban.updateKanbanTask(linked.id, { prUrl: PR1, prState: "merged" });
    const commented = await store.kanban.addKanbanTask("p2", "Commented", "");
    await store.kanban.addKanbanComment(commented.id, `${PR_MERGED_COMMENT}: ${PR2}`);
    const untouched = await store.kanban.addKanbanTask("p1", "Untouched", "");

    expect((await store.kanban.closeKanbanTasksForMergedPullRequests()).sort()).toEqual(
      [linked.id, commented.id].sort(),
    );
    expect((await store.kanban.getKanbanTask(linked.id))?.status).toBe("done");
    expect(await store.kanban.getKanbanTask(commented.id)).toMatchObject({
      status: "done",
      prMergeDoneUrl: PR2,
    });
    expect((await store.kanban.getKanbanTask(untouched.id))?.status).toBe("backlog");
    // Idempotent: a second start finds nothing left.
    expect(await store.kanban.closeKanbanTasksForMergedPullRequests()).toEqual([]);
  });
});
