import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { eventSink } from "../src/core/backend-emit.js";
import {
  lifecycleMachine,
  PR_URL,
  type LifecycleMachine,
} from "../src/core/build-pipeline-kanban-transitions-test-support.js";
import { findKanbanTaskForEnvironment } from "../src/core/commands-pr-monitor.js";
import { PR_CLOSED_COMMENT, PrMonitorService, type PrDetection } from "../src/core/pr-monitor";
import { StorageService } from "../src/core/storage.js";

/**
 * A pull request that closes without merging sends its build's ticket back
 * to the backlog (docs/architecture/tickets.md, "Build lifecycle"). The
 * monitor runs here over a real storage service, with the same ticket
 * effects `pr-monitor-runtime.ts` wires: the store decides each closed pull
 * request once, only for the build that raised it, and never for a ticket
 * the user moved by hand since (`kanban-merge-closure.ts`). The rest of the
 * monitor's ticket effects are covered in `pr-monitor-service.test.ts`.
 */

const PR_B_URL = "https://github.com/acme/repo/pull/8";

const dirs: string[] = [];
const stores: StorageService[] = [];

afterEach(async () => {
  for (const storage of stores.splice(0)) storage.close?.();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function closed(url = PR_URL): PrDetection {
  return {
    url,
    state: "closed",
    hasMergeConflicts: false,
    checkSummary: null,
    checkSummaryStatus: "skipped",
  };
}

/** A monitor whose ticket effects are the runtime's, over `storage`. */
function monitor(storage: StorageService): PrMonitorService {
  return new PrMonitorService({
    emit: eventSink(() => undefined),
    onWarning: () => undefined,
    now: () => new Date(0).toISOString(),
    monotonicNow: () => 0,
    random: () => 0,
    schedule: () => 1,
    cancel: () => undefined,
    effects: {
      detect: async () => closed(),
      persistPr: async () => undefined,
      clearPr: async () => undefined,
      findTaskForEnvironment: (environmentId) =>
        findKanbanTaskForEnvironment(storage, environmentId),
      closeTaskForMerge: async (taskId, prUrl) => {
        await storage.kanban.closeKanbanTasksForMergedPullRequests([{ taskId, prUrl }]);
      },
      returnTaskForClosedPr: async (taskId, prUrl) => {
        await storage.kanban.returnKanbanTaskForClosedPullRequest(taskId, prUrl);
      },
      addTaskComment: async (taskId, text) => {
        await storage.kanban.addKanbanComment(taskId, text);
      },
      updateTaskPrMetadata: async (taskId, updates) => {
        await storage.kanban.updateKanbanTask(taskId, updates);
      },
    },
  });
}

function target(environmentId: string, prUrl = PR_URL) {
  return {
    environmentId,
    branch: "feature",
    kind: "local" as const,
    worktreePath: "/tmp/worktree",
    ready: true,
    prUrl,
    prState: "open" as const,
    hasMergeConflicts: false,
  };
}

async function machine(): Promise<{
  storage: StorageService;
  life: LifecycleMachine;
  /** A ticket whose build (saved, so the monitor can find it) raised `PR_URL` and finished. */
  builtTicket: () => Promise<string>;
  read: (id: string) => ReturnType<StorageService["kanban"]["getKanbanTask"]>;
}> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "ork-pr-monitor-closed-"));
  dirs.push(dir);
  const storage = new StorageService(dir);
  await storage.init();
  stores.push(storage);
  const life = await lifecycleMachine(storage, "env-1", "project-1");
  return {
    storage,
    life,
    builtTicket: async () => {
      const id = (await storage.kanban.addKanbanTask("project-1", "Ticket", "Body")).id;
      const pipeline = life.pipeline(id);
      await storage.saveBuildPipeline(pipeline.id, "project-1", "env-1", 1, pipeline);
      await life.started(pipeline);
      await life.prDetected(pipeline, "open");
      await life.ended(pipeline, "complete");
      return id;
    },
    read: (id) => storage.kanban.getKanbanTask(id),
  };
}

describe("a closed pull request", () => {
  test("sends its build's ticket back to the backlog once, and a replay keeps a later move", async () => {
    const { storage, builtTicket, read } = await machine();
    const id = await builtTicket();
    const service = monitor(storage);
    await service.reconcileTerminal(target("env-1"), closed());
    const after = await read(id);
    expect(after).toMatchObject({ status: "backlog", prUrl: PR_URL, prState: "closed" });
    expect(after?.comments.map((comment) => comment.text)).toContain(
      `${PR_CLOSED_COMMENT}: ${PR_URL}`,
    );

    // The user picks it up again; a restarted monitor observing the same
    // closure must not undo that.
    await storage.kanban.updateKanbanTask(id, { status: "review" });
    await monitor(storage).reconcileTerminal(target("env-1"), closed());
    expect((await read(id))?.status).toBe("review");
  });

  test("still returns the ticket when its closed link was recorded before the monitor saw it", async () => {
    const { storage, builtTicket, read } = await machine();
    const id = await builtTicket();
    // Another writer recorded the closed link without moving the ticket.
    await storage.kanban.updateKanbanTask(id, { prUrl: PR_URL, prState: "closed" });
    expect((await read(id))?.status).toBe("review");
    await monitor(storage).reconcileTerminal(target("env-1"), closed());
    expect((await read(id))?.status).toBe("backlog");
  });

  test("found first by the build's conflict resolution leaves nothing for the monitor to redo", async () => {
    const { storage, life, read } = await machine();
    const id = (await storage.kanban.addKanbanTask("project-1", "Ticket", "Body")).id;
    const pipeline = life.pipeline(id);
    await storage.saveBuildPipeline(pipeline.id, "project-1", "env-1", 1, pipeline);
    await life.started(pipeline);
    await life.prDetected(pipeline, "open");
    await life.prDetected(pipeline, "closed");
    expect((await read(id))?.status).toBe("backlog");
    await storage.kanban.updateKanbanTask(id, { status: "in-progress" });
    await monitor(storage).reconcileTerminal(target("env-1"), closed());
    expect((await read(id))?.status).toBe("in-progress");
  });

  test("of an older build leaves the ticket a newer build put in review", async () => {
    const { storage, builtTicket, read } = await machine();
    const id = await builtTicket();
    // A second build of the same ticket in another environment raises PR B.
    const newer = await lifecycleMachine(storage, "env-2", "project-1");
    const second = newer.pipeline(id, { id: `pipeline-${id}-2`, environmentId: "env-2" });
    await storage.saveBuildPipeline(second.id, "project-1", "env-2", 1, second);
    await newer.started(second);
    await newer.prDetected(second, "open", PR_B_URL);
    expect((await read(id))?.status).toBe("review");

    // The first environment's monitor finds the ticket through its saved
    // pipeline and sees PR A close.
    await monitor(storage).reconcileTerminal(target("env-1"), closed());
    expect((await read(id))?.status).toBe("review");

    // PR B closing is the newer build's own.
    await monitor(storage).reconcileTerminal(target("env-2", PR_B_URL), closed(PR_B_URL));
    expect((await read(id))?.status).toBe("backlog");
  });
});
