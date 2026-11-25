import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { configureLogger, resetLogger, type LogRecord } from "@orkestrator/protocol/logger";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { lifecycleMachine } from "./build-pipeline/kanban-transitions-test-support.js";
import { withService, startInput, mutateStored } from "./build-pipeline/service-test-support.js";
import { IntegrationLocks } from "./integration-locks.js";
import { LinearCompletionComments } from "./linear-completion-comments.js";
import { LINEAR_WRITE_RETRY_MS } from "./linear-write-drain.js";
import { StorageService } from "./storage/service.js";

/**
 * A Linear-sourced build's completion comment, against real storage and a
 * faked Linear (docs/architecture/tickets.md, "Completion comments on Linear
 * issues").
 */

const API_KEY = "lin_api_test_key";
const originalFetch = globalThis.fetch;
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetLogger();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** One Linear issue's comments; `down` answers every request with an error. */
function fakeLinear(before: (query: string) => void | Promise<void> = () => {}) {
  const state = { comments: [] as string[], down: false };
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(API_KEY);
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const answer = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    await before(query);
    if (state.down) return answer({ errors: [{ message: "Linear is down" }] });
    if (query.includes("query OrkestratorLinearCompletionComments")) {
      return answer({
        data: {
          issue: {
            comments: {
              nodes: state.comments.map((body, index) => ({ id: `comment-${index + 1}`, body })),
              pageInfo: { hasNextPage: false },
            },
          },
        },
      });
    }
    if (query.includes("mutation OrkestratorLinearCompletionComment")) {
      expect(variables.issueId).toBe("issue-1");
      state.comments.push(String(variables.body));
      return answer({
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: `comment-${state.comments.length}`,
              createdAt: "2026-11-25T12:00:00.000Z",
            },
          },
        },
      });
    }
    throw new Error(`Unexpected Linear operation ${query}`);
  }) as unknown as typeof fetch;
  return state;
}

function clock() {
  let now = Date.parse("2026-11-25T12:00:00Z");
  const timers: Array<{ callback: () => void; at: number }> = [];
  return {
    now: () => now,
    schedule: (callback: () => void, delayMs: number) => {
      const timer = { callback, at: now + delayMs };
      timers.push(timer);
      return timer;
    },
    cancel: (timer: unknown) => {
      const index = timers.indexOf(timer as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
    pending: () => timers.length,
    advance(ms: number) {
      now += ms;
      for (const timer of timers.splice(0)) {
        if (timer.at <= now) timer.callback();
        else timers.push(timer);
      }
    },
  };
}

/** A machine whose builds end through the real recovery, its queue and the real command's core. */
async function machine(options: { connected: boolean }) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "ork-linear-comments-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const storage = new StorageService(dir);
  await storage.init();
  await storage.addProject({
    id: "project-1",
    name: "Web",
    gitUrl: "https://github.com/acme/web.git",
    localPath: null,
    addedAt: new Date(0).toISOString(),
    order: 0,
  });
  cleanups.push(() => storage.close());
  if (options.connected) await storage.kanban.saveLinearAuth(API_KEY);
  const locks = new IntegrationLocks();
  const time = clock();
  const queue = new LinearCompletionComments(locks, time);
  cleanups.push(() => queue.shutdown());
  const life = await lifecycleMachine(storage, "env-1", "project-1", {
    writeLinearComment: (pipeline, comment) => queue.submit(storage, pipeline, comment),
    restoreLinearComment: (pipeline, comment) => queue.restore(storage, pipeline, comment),
  });
  queue.onPosted((comment) => life.recovery.noteLinearCommentPosted(comment));
  const pipeline = life.pipeline("ENG-1", {
    source: {
      type: "linear",
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
    } as BuildPipeline["source"],
  });
  await storage.saveBuildPipeline(pipeline.id, "project-1", "env-1", 1, pipeline);
  const stored = async () =>
    (await storage.getBuildPipeline(pipeline.id))?.snapshot as BuildPipeline | undefined;
  return { storage, locks, queue, life, pipeline, time, stored };
}

describe("a Linear-sourced build's completion comment", () => {
  test("is posted as the build completes", async () => {
    const linear = fakeLinear();
    const { storage, queue, life, pipeline, stored } = await machine({ connected: true });
    await life.ended(pipeline, "complete");
    await queue.idle();
    expect(linear.comments).toEqual([expect.stringContaining("✅ Orkestrator build completed")]);
    expect(await stored()).toMatchObject({ completionCommentStatus: "posted" });
    expect(await storage.linear.listLinearPendingComments()).toEqual([]);
  });

  test("is posted for a completion that follows a failure, once each", async () => {
    const linear = fakeLinear();
    const { life, pipeline, queue } = await machine({ connected: true });
    pipeline.error = "tests failed";
    await life.ended(pipeline, "failed");
    await queue.idle();
    await life.ended(pipeline, "complete");
    await queue.idle();
    expect(linear.comments).toEqual([
      expect.stringContaining("❌ Orkestrator build failed"),
      expect.stringContaining("✅ Orkestrator build completed"),
    ]);
    // Reconciled again, and ending each way again, adds nothing.
    await life.ended(pipeline, "complete");
    await life.ended(pipeline, "failed");
    expect(linear.comments).toHaveLength(2);
  });

  test("a completion recorded without an ending is not taken for this one", async () => {
    const linear = fakeLinear();
    const { storage, life, pipeline } = await machine({ connected: true });
    // As a version before comments were kept per ending recorded a failure.
    await storage.kanban.saveLinearCompletionComment({
      pipelineId: pipeline.id,
      issueId: "issue-1",
      status: "posted",
      commentId: "old-comment",
    });
    await life.ended(pipeline, "complete");
    expect(linear.comments).toHaveLength(1);
  });

  test("is retried with backoff after a Linear failure, and the build then says it was posted", async () => {
    const records: LogRecord[] = [];
    configureLogger({
      sink: (output) => {
        if (output.record) records.push(output.record);
      },
    });
    const linear = fakeLinear();
    linear.down = true;
    const { storage, queue, life, pipeline, time, stored } = await machine({ connected: true });
    await life.ended(pipeline, "complete");
    await queue.idle();
    expect(await stored()).toMatchObject({
      completionCommentStatus: "failed",
      completionCommentError: "Linear is down. The comment is queued and will be retried.",
    });
    time.advance(LINEAR_WRITE_RETRY_MS);
    await queue.idle();
    const [pending] = await storage.linear.listLinearPendingComments();
    expect(pending).toMatchObject({ attempts: 2, lastError: "Linear is down" });
    expect(Date.parse(pending!.nextAttemptAt) - time.now()).toBe(2 * LINEAR_WRITE_RETRY_MS);

    linear.down = false;
    time.advance(2 * LINEAR_WRITE_RETRY_MS);
    await queue.idle();
    expect(linear.comments).toHaveLength(1);
    expect(await storage.linear.listLinearPendingComments()).toEqual([]);
    expect(await stored()).toMatchObject({
      completionCommentStatus: "posted",
      completionCommentId: "comment-1",
    });
    expect(time.pending()).toBe(0);
    expect(JSON.stringify(records)).not.toContain(API_KEY);
    // The comment's text is never logged.
    expect(JSON.stringify(records)).not.toContain("Orkestrator build completed");
  });

  test("outlives the pipeline and its environment, and a restart", async () => {
    const linear = fakeLinear();
    linear.down = true;
    const { storage, locks, queue, life, pipeline, time } = await machine({ connected: true });
    await life.ended(pipeline, "complete");
    await queue.idle();
    queue.shutdown();
    await storage.deleteBuildPipelinesByEnvironment("env-1");
    await storage.removeEnvironment("env-1");

    linear.down = false;
    const next = new LinearCompletionComments(locks, {
      ...time,
      now: () => time.now() + LINEAR_WRITE_RETRY_MS,
    });
    cleanups.push(() => next.shutdown());
    next.onPosted((comment) => life.recovery.noteLinearCommentPosted(comment));
    next.start(storage);
    await next.idle();
    expect(linear.comments).toHaveLength(1);
    expect(await storage.linear.listLinearPendingComments()).toEqual([]);
  });

  test("waits on a machine without a key, without calling Linear, and lands once it is connected", async () => {
    const linear = fakeLinear();
    const { storage, queue, life, pipeline, stored } = await machine({ connected: false });
    await life.ended(pipeline, "complete");
    await queue.idle();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect((await stored())?.completionCommentError).toBe(
      "Linear is not connected on this machine. The comment is queued until this machine or its command node can post it.",
    );
    expect(await storage.linear.listLinearPendingComments()).toHaveLength(1);

    await storage.kanban.saveLinearAuth(API_KEY);
    queue.requestDrain();
    await queue.idle();
    expect(linear.comments).toHaveLength(1);
    expect(await stored()).toMatchObject({ completionCommentStatus: "posted" });
  });

  test("a later ending replaces a comment still queued for an earlier one", async () => {
    fakeLinear();
    const { storage, life, pipeline } = await machine({ connected: false });
    pipeline.error = "tests failed";
    await life.ended(pipeline, "failed");
    await life.ended(pipeline, "complete");
    expect(await storage.linear.listLinearPendingComments()).toMatchObject([
      { pipelineId: pipeline.id, outcome: "complete" },
    ]);
  });

  test("a build running again is not marked posted by its previous ending's comment", async () => {
    fakeLinear();
    const { storage, life, pipeline, stored } = await machine({ connected: false });
    await life.ended(pipeline, "failed");
    pipeline.phase = "building";
    delete pipeline.completionCommentStatus;
    await storage.saveBuildPipeline(pipeline.id, "project-1", "env-1", 1, pipeline);
    await life.recovery.noteLinearCommentPosted({
      pipelineId: pipeline.id,
      outcome: "failed",
      commentId: "comment-1",
    });
    expect((await stored())?.completionCommentStatus).toBeUndefined();
  });

  test("goes with its project when the project is removed", async () => {
    fakeLinear();
    const { storage, life, pipeline } = await machine({ connected: false });

    await life.ended(pipeline, "complete");
    expect(await storage.linear.listLinearPendingComments()).toHaveLength(1);
    await storage.removeEnvironment("env-1");
    await storage.removeProject("project-1");
    expect(await storage.linear.listLinearPendingComments()).toEqual([]);
  });

  test("a successful completion supersedes the queued failure", async () => {
    const linear = fakeLinear();
    const { storage, queue, life, pipeline, time, stored } = await machine({ connected: true });
    linear.down = true;
    await life.ended(pipeline, "failed");
    await queue.idle();
    linear.down = false;
    await life.ended(pipeline, "complete");
    time.advance(LINEAR_WRITE_RETRY_MS);
    await queue.idle();
    expect(linear.comments).toEqual([expect.stringContaining("✅ Orkestrator build completed")]);
    expect(await storage.linear.listLinearPendingComments()).toEqual([]);
    expect(await stored()).toMatchObject({ completionCommentStatus: "posted" });
  });

  test("recovery adopts a successful legacy plain-marker comment from a posting snapshot", async () => {
    const linear = fakeLinear();
    const { life, pipeline, queue, stored } = await machine({ connected: true });
    linear.comments.push(
      `✅ Orkestrator build completed for **Ticket**.\n\n<!-- orkestrator-linear-run:${pipeline.id} -->`,
    );
    pipeline.phase = "complete";
    pipeline.completionCommentStatus = "posting";
    await life.recovery.reconcileTerminalState(pipeline);
    await queue.idle();
    expect(linear.comments).toHaveLength(1);
    expect(await stored()).toMatchObject({
      completionCommentStatus: "posted",
      completionCommentId: "comment-1",
    });
  });

  test("startup restores a pre-upgrade failed comment and delivers it without a manual retry", async () => {
    const linear = fakeLinear();
    const queue = new LinearCompletionComments(new IntegrationLocks());
    cleanups.push(() => queue.shutdown());
    let restoreStorage: StorageService;
    await withService(
      async (service, storage) => {
        restoreStorage = storage;
        await storage.addProject({
          id: "project-1",
          name: "Web",
          gitUrl: "https://github.com/acme/web.git",
          localPath: null,
          addedAt: new Date(0).toISOString(),
          order: 0,
        });
        const started = await service.start(startInput());
        await mutateStored(storage, started.id, (pipeline) => {
          pipeline.phase = "complete";
          pipeline.source = { type: "linear", issueId: "issue-1", issueIdentifier: "ENG-1" };
          pipeline.completionCommentStatus = "failed";
          pipeline.completionCommentError = "Linear is not connected on this machine";
        });
        queue.onPosted((comment) => service.noteLinearCommentPosted(comment));
        await service.init();
        expect(await storage.linear.listLinearPendingComments()).toMatchObject([
          { pipelineId: started.id, outcome: "complete" },
        ]);
        await storage.kanban.saveLinearAuth(API_KEY);
        queue.start(storage);
        await queue.idle();
        expect(linear.comments).toHaveLength(1);
        expect((await storage.getBuildPipeline(started.id))?.snapshot).toMatchObject({
          completionCommentStatus: "posted",
          completionCommentId: "comment-1",
        });
        queue.shutdown();
      },
      {
        restoreLinearComment: (pipeline, comment) =>
          queue.restore(restoreStorage, pipeline, comment),
      },
    );
  });

  test("disconnect during the first lookup leaves the next comment available for the relay", async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const linear = fakeLinear(async (query) => {
      if (query.includes("query OrkestratorLinearCompletionComments")) {
        reached.resolve();
        await release.promise;
      }
    });
    const { storage, queue, life, pipeline } = await machine({ connected: false });
    await life.ended(pipeline, "complete");
    const second = life.pipeline("ENG-2", { source: pipeline.source });
    await life.ended(second, "complete");
    await queue.idle();
    await storage.kanban.saveLinearAuth(API_KEY);
    queue.requestDrain();
    await reached.promise;
    await storage.kanban.clearLinearAuth();
    release.resolve();
    await queue.idle();
    expect(linear.comments).toEqual([]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(await storage.linear.listLinearPendingComments()).toContainEqual(
      expect.objectContaining({ pipelineId: second.id, attempts: 0 }),
    );
  });

  test("a Kanban build never reaches the queue", async () => {
    const { storage, queue, pipeline } = await machine({ connected: false });
    expect(
      queue.submit(
        storage,
        { ...pipeline, source: { type: "kanban", taskId: "task-1" } },
        { outcome: "complete", body: "Done" },
      ),
    ).rejects.toThrow("could not be queued");
    expect(await storage.linear.listLinearPendingComments()).toEqual([]);
  });
});
