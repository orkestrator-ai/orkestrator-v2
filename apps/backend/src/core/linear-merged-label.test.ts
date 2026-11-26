import { configureLogger, resetLogger, type LogRecord } from "@orkestrator/protocol/logger";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { lifecycleMachine } from "./build-pipeline/kanban-transitions-test-support.js";
import type { CommandContext } from "./commands/context.js";
import { EnvironmentLifecycleTaskTracker } from "./environments/lifecycle-tasks.js";
import { LinearMergedLabels } from "./linear-merged-label.js";
import {
  LINEAR_WRITE_MAX_RETRY_MS,
  LINEAR_WRITE_RETRY_MS,
  LINEAR_WRITE_TIMEOUT_MS,
  linearWriteRetryDelay,
} from "./linear-write-drain.js";
import { PrMonitorRuntime } from "./git/pr-monitor-runtime.js";
import { StorageService } from "./storage/service.js";

/**
 * The `merged` label on a Linear-sourced build's issue
 * (docs/architecture/tickets.md, "Merged builds label their issue"), against
 * real storage and a faked Linear GraphQL API. No test reaches Linear: every
 * `fetch` is answered by `fakeLinear`, which fails on an unknown operation.
 */

const PR_URL = "https://github.com/acme/web/pull/12";
const API_KEY = "lin_api_test_key";
const originalFetch = globalThis.fetch;
const dirs: string[] = [];
const stores: StorageService[] = [];
const queues: LinearMergedLabels[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetLogger();
  for (const queue of queues.splice(0)) queue.shutdown();
  for (const storage of stores.splice(0)) storage.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

type Label = { id: string; name: string; isGroup?: boolean; teamId?: string };
type Request = { operation: string; variables: Record<string, unknown> };

/**
 * A Linear workspace: one issue on team `team-1` with its labels, and every
 * label in the workspace. Mutations change it the way Linear would;
 * `failNext` makes the next requests answer with a GraphQL error.
 */
function fakeLinear(state: { issueLabels: string[]; labels: Label[] }) {
  let failOperation: string | undefined;
  let loseOperation: string | undefined;
  const requests: Request[] = [];
  let failures = 0;
  const failNext = (count: number) => {
    failures = count;
  };
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(API_KEY);
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "";
    requests.push({ operation, variables: body.variables });
    const reply = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const answer = (data: unknown) => reply({ data });
    if (failures > 0) {
      failures -= 1;
      return reply({ errors: [{ message: "Linear is down" }] });
    }
    const label = (id: string) => state.labels.find((entry) => entry.id === id);
    if (operation === failOperation) {
      failOperation = undefined;
      return reply({ errors: [{ message: "stage failed" }] });
    }
    switch (operation) {
      case "OrkestratorLinearIssueLabels":
        return answer({
          issue: {
            id: "issue-uuid-1",
            team: { id: "team-1" },
            labels: {
              nodes: state.issueLabels.map((id) => ({ id, name: label(id)?.name ?? id })),
            },
          },
        });
      case "OrkestratorLinearLabelsByName": {
        const name = String(body.variables.name).toLowerCase();
        const matches = state.labels.filter((entry) => entry.name.toLowerCase() === name);
        const start = Number(body.variables.after ?? 0);
        return answer({
          issueLabels: {
            pageInfo: { hasNextPage: matches.length > start + 50, endCursor: String(start + 50) },
            nodes: matches.slice(start, start + 50).map((entry) => ({
              id: entry.id,
              name: entry.name,
              isGroup: entry.isGroup === true,
              team: entry.teamId ? { id: entry.teamId } : null,
            })),
          },
        });
      }
      case "OrkestratorLinearLabelCreate": {
        const created = {
          id: `label-created-${state.labels.length}`,
          name: String(body.variables.name),
          teamId: String(body.variables.teamId),
        };
        state.labels.push(created);
        if (operation === loseOperation) {
          loseOperation = undefined;
          throw new Error("response lost");
        }
        return answer({ issueLabelCreate: { success: true, issueLabel: { id: created.id } } });
      }
      case "OrkestratorLinearIssueAddLabel":
        expect(body.variables.id).toBe("issue-uuid-1");
        state.issueLabels.push(String(body.variables.labelId));
        if (operation === loseOperation) {
          loseOperation = undefined;
          throw new Error("response lost");
        }
        return answer({ issueAddLabel: { success: true } });
      default:
        throw new Error(`Unexpected Linear operation ${operation}`);
    }
  }) as unknown as typeof fetch;
  return {
    requests,
    failNext,
    failAt: (operation: string) => {
      failOperation = operation;
    },
    loseAt: (operation: string) => {
      loseOperation = operation;
    },
    mutations: () => requests.filter((r) => /Create|Add/.test(r.operation)),
  };
}

/** A manual clock and timer, so retries run when the test says. */
function clock() {
  let now = Date.parse("2026-11-16T12:00:00Z");
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
    /** Moves time forward and fires every timer now due. */
    advance(ms: number) {
      now += ms;
      for (const timer of timers.splice(0)) {
        if (timer.at <= now) timer.callback();
        else timers.push(timer);
      }
    },
  };
}

async function machine(source: BuildPipeline["source"], options: { connected?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "ork-linear-merged-"));
  dirs.push(dir);
  const storage = new StorageService(dir);
  await storage.init();
  stores.push(storage);
  if (options.connected !== false) {
    await storage.kanban.saveLinearAuth(API_KEY);
  }
  const time = clock();
  const queue = new LinearMergedLabels({
    now: time.now,
    schedule: time.schedule,
    cancel: time.cancel,
  });
  queues.push(queue);
  const merged: Array<{ pipelineId: string; prUrl: string }> = [];
  const life = await lifecycleMachine(storage, "env-1", "project-1", {
    onPullRequestMerged: (pipeline, prUrl) => {
      merged.push({ pipelineId: pipeline.id, prUrl });
      queue.recordPipelineMerge(storage, pipeline, prUrl);
    },
  });
  const pipeline = life.pipeline("ENG-12", {
    source,
    shippedPullRequestUrl: PR_URL,
    sessions: [{ phase: "pr", label: "PR Session", status: "idle" } as never],
  });
  await storage.saveBuildPipeline(pipeline.id, "project-1", "env-1", 1, pipeline);
  return { storage, queue, life, pipeline, time, merged };
}

const LINEAR: BuildPipeline["source"] = {
  type: "linear",
  issueId: "issue-uuid-1",
  issueIdentifier: "ENG-12",
} as BuildPipeline["source"];

describe("a Linear-sourced build whose pull request merges", () => {
  test("adds the existing `merged` label, matched case-insensitively, keeping the issue's labels", async () => {
    const linear = fakeLinear({
      issueLabels: ["label-bug"],
      labels: [
        { id: "label-bug", name: "Bug", teamId: "team-1" },
        { id: "label-merged", name: "Merged" },
      ],
    });
    const { storage, queue } = await machine(LINEAR);
    await storage.updateEnvironment("env-1", { prUrl: PR_URL, prState: "merged" });

    await queue.recordEnvironmentMergeById(storage, "env-1", PR_URL);
    await queue.idle();

    expect(linear.mutations()).toEqual([
      {
        operation: "OrkestratorLinearIssueAddLabel",
        variables: { id: "issue-uuid-1", labelId: "label-merged" },
      },
    ]);
    const [record] = await storage.linear.listLinearMergedLabels();
    expect(record).toMatchObject({
      status: "applied",
      outcome: "added",
      issueId: "issue-uuid-1",
      issueIdentifier: "ENG-12",
      prUrl: PR_URL,
    });
  });

  test("prefers the issue's team label over a workspace one, and ignores other teams' labels", async () => {
    const linear = fakeLinear({
      issueLabels: [],
      labels: [
        { id: "label-other-team", name: "merged", teamId: "team-2" },
        { id: "label-workspace", name: "MERGED" },
        { id: "label-group", name: "merged", isGroup: true, teamId: "team-1" },
        { id: "label-team", name: "merged", teamId: "team-1" },
      ],
    });
    const { storage, queue } = await machine(LINEAR);
    await queue.recordEnvironmentMerge(storage, { id: "env-1", projectId: "project-1" }, PR_URL);
    await queue.idle();
    expect(linear.mutations().map((request) => request.variables.labelId)).toEqual(["label-team"]);
  });

  test("creates a team `merged` label when neither the team nor the workspace has one", async () => {
    const state = {
      issueLabels: ["label-bug"],
      labels: [
        { id: "label-bug", name: "Bug", teamId: "team-1" },
        { id: "label-other-team", name: "merged", teamId: "team-2" },
      ] as Label[],
    };
    const linear = fakeLinear(state);
    const { storage, queue } = await machine(LINEAR);
    await queue.recordEnvironmentMerge(storage, { id: "env-1", projectId: "project-1" }, PR_URL);
    await queue.idle();

    expect(linear.mutations().map((request) => request.operation)).toEqual([
      "OrkestratorLinearLabelCreate",
      "OrkestratorLinearIssueAddLabel",
    ]);
    expect(linear.mutations()[0]!.variables).toEqual({ name: "merged", teamId: "team-1" });
    expect(state.issueLabels).toEqual(["label-bug", "label-created-2"]);
    expect((await storage.linear.listLinearMergedLabels())[0]).toMatchObject({
      status: "applied",
      outcome: "created",
    });
  });

  test("does nothing in Linear when the issue already has the label", async () => {
    const linear = fakeLinear({
      issueLabels: ["label-merged"],
      labels: [{ id: "label-merged", name: "merged", teamId: "team-1" }],
    });
    const { storage, queue } = await machine(LINEAR);
    await queue.recordEnvironmentMerge(storage, { id: "env-1", projectId: "project-1" }, PR_URL);
    await queue.idle();
    expect(linear.mutations()).toEqual([]);
    expect((await storage.linear.listLinearMergedLabels())[0]?.outcome).toBe("already-present");
  });

  test("labels once per pull request, however many writers report the merge", async () => {
    const linear = fakeLinear({
      issueLabels: [],
      labels: [{ id: "label-merged", name: "merged" }],
    });
    const { storage, queue, life, pipeline } = await machine(LINEAR);
    await storage.updateEnvironment("env-1", { prUrl: PR_URL, prState: "merged" });
    // The build finds it merged, the monitor confirms it, and the startup sweep reads it.
    await life.prDetected(pipeline, "merged", PR_URL);
    await queue.recordEnvironmentMergeById(storage, "env-1", PR_URL);
    queue.sweepOnce(storage);
    await queue.idle();
    await Bun.sleep(0);
    await queue.idle();
    expect(linear.mutations()).toHaveLength(1);
    expect(await storage.linear.listLinearMergedLabels()).toHaveLength(1);
  });

  test("the build finding its pull request merged queues the label itself", async () => {
    const linear = fakeLinear({
      issueLabels: [],
      labels: [{ id: "label-merged", name: "merged" }],
    });
    const { queue, life, pipeline, merged } = await machine(LINEAR);
    await life.prDetected(pipeline, "merged", PR_URL);
    await queue.idle();
    expect(merged).toEqual([{ pipelineId: pipeline.id, prUrl: PR_URL }]);
    expect(linear.mutations()).toHaveLength(1);
  });

  test("the startup sweep queues a merge recorded while nothing was watching", async () => {
    const linear = fakeLinear({
      issueLabels: [],
      labels: [{ id: "label-merged", name: "merged" }],
    });
    const { storage, queue } = await machine(LINEAR);
    await storage.updateEnvironment("env-1", { prUrl: PR_URL, prState: "merged" });
    queue.sweepOnce(storage);
    await Bun.sleep(0);
    await queue.idle();
    expect(linear.mutations()).toHaveLength(1);
  });
});

describe("builds and pull requests that do not touch Linear labels", () => {
  for (const [name, source] of [
    ["a Kanban ticket", { type: "kanban", taskId: "task-1" }],
    [
      "a GitHub issue",
      { type: "github", repositoryOwner: "acme", repositoryName: "web", issueNumber: 4 },
    ],
  ] as const) {
    test(`a build from ${name} queues nothing when its pull request merges`, async () => {
      const linear = fakeLinear({ issueLabels: [], labels: [] });
      const { storage, queue, life, pipeline } = await machine(
        source as unknown as BuildPipeline["source"],
      );
      if (source.type === "kanban") {
        const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body");
        pipeline.source = { type: "kanban", taskId: task.id } as BuildPipeline["source"];
      }
      await storage.updateEnvironment("env-1", { prUrl: PR_URL, prState: "merged" });
      await life.prDetected(pipeline, "merged", PR_URL);
      await queue.recordEnvironmentMergeById(storage, "env-1", PR_URL);
      queue.sweepOnce(storage);
      await Bun.sleep(0);
      await queue.idle();
      expect(await storage.linear.listLinearMergedLabels()).toEqual([]);
      expect(linear.requests).toEqual([]);
    });
  }

  test("a Linear-sourced pull request closed without merging queues nothing", async () => {
    const linear = fakeLinear({
      issueLabels: [],
      labels: [{ id: "label-merged", name: "merged" }],
    });
    const { storage, queue, life, pipeline, merged } = await machine(LINEAR);
    await storage.updateEnvironment("env-1", { prUrl: PR_URL, prState: "closed" });
    await life.prDetected(pipeline, "closed", PR_URL);
    queue.sweepOnce(storage);
    await Bun.sleep(0);
    await queue.idle();
    expect(merged).toEqual([]);
    expect(await storage.linear.listLinearMergedLabels()).toEqual([]);
    expect(linear.requests).toEqual([]);
  });

  test("the PR monitor reports merges to the queue and never closed pull requests", async () => {
    const recordEnvironmentMergeById = mock(async () => undefined);
    const sweepOnce = mock(() => undefined);
    const monitor = new PrMonitorRuntime({
      mergeObserver: { recordEnvironmentMergeById, sweepOnce },
    });
    const storage = {
      loadEnvironments: async () => [],
      getEnvironment: async () => null,
      listAllBuildPipelines: async () => [],
      linear: {},
    } as unknown as StorageService;
    const context = {
      storage,
      emit: () => undefined,
      appRoot: "",
      resourceRoot: "",
      environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    } as unknown as CommandContext;
    try {
      await monitor.sync(context);
      await monitor.sync(context);
      expect(sweepOnce).toHaveBeenCalledTimes(2);
      monitor.resumeTerminalEffects("env-1", { url: PR_URL, state: "closed" });
      expect(recordEnvironmentMergeById).not.toHaveBeenCalled();
      monitor.resumeTerminalEffects("env-1", { url: PR_URL, state: "merged" });
      expect(recordEnvironmentMergeById).toHaveBeenCalledWith(storage, "env-1", PR_URL);
    } finally {
      monitor.shutdown();
    }
  });
});

describe("Linear failures", () => {
  test("are logged with a reason and retried with backoff until the label lands", async () => {
    const records: LogRecord[] = [];
    configureLogger({
      sink: (output) => {
        if (output.record) records.push(output.record);
      },
    });
    const state = { issueLabels: [] as string[], labels: [{ id: "label-merged", name: "merged" }] };
    const linear = fakeLinear(state);
    const { storage, queue, time } = await machine(LINEAR);

    linear.failNext(2);
    await queue.recordEnvironmentMerge(storage, { id: "env-1", projectId: "project-1" }, PR_URL);
    await queue.idle();
    let [record] = await storage.linear.listLinearMergedLabels();
    expect(record).toMatchObject({ status: "pending", attempts: 1, lastError: "Linear is down" });
    expect(Date.parse(record!.nextAttemptAt) - time.now()).toBe(LINEAR_WRITE_RETRY_MS);
    const failure = records.find((entry) => entry.event === "merged-label.failed");
    expect(failure?.fields).toMatchObject({ reason: "Linear is down", attempts: 1 });
    expect(JSON.stringify(records)).not.toContain(API_KEY);

    // Not before it is due.
    time.advance(LINEAR_WRITE_RETRY_MS - 1);
    await queue.idle();
    expect((await storage.linear.listLinearMergedLabels())[0]?.attempts).toBe(1);

    time.advance(1);
    await queue.idle();
    [record] = await storage.linear.listLinearMergedLabels();
    expect(record).toMatchObject({ status: "pending", attempts: 2 });
    expect(Date.parse(record!.nextAttemptAt) - time.now()).toBe(2 * LINEAR_WRITE_RETRY_MS);

    time.advance(2 * LINEAR_WRITE_RETRY_MS);
    await queue.idle();
    [record] = await storage.linear.listLinearMergedLabels();
    expect(record).toMatchObject({ status: "applied", outcome: "added" });
    expect(record?.lastError).toBeUndefined();
    expect(state.issueLabels).toEqual(["label-merged"]);
    expect(time.pending()).toBe(0);
  });

  test("never hold up merge handling or environment deletion, and land after the pipelines are gone", async () => {
    const state = { issueLabels: [] as string[], labels: [{ id: "label-merged", name: "merged" }] };
    fakeLinear(state);
    const answering = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    // Linear does not answer until the test releases it.
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      await held;
      return answering(...args);
    }) as typeof fetch;
    const { storage, queue } = await machine(LINEAR);
    await storage.updateEnvironment("env-1", { prUrl: PR_URL, prState: "merged" });

    // Deletion's step: resolves with Linear still unanswered.
    await queue.recordEnvironmentMerge(storage, { id: "env-1", projectId: "project-1" }, PR_URL);
    await storage.deleteBuildPipelinesByEnvironment("env-1");
    await storage.removeEnvironment("env-1");
    expect((await storage.linear.listLinearMergedLabels())[0]?.status).toBe("pending");

    release();
    await queue.idle();
    expect((await storage.linear.listLinearMergedLabels())[0]?.status).toBe("applied");
    expect(state.issueLabels).toEqual(["label-merged"]);
    expect(calls).toBeGreaterThan(0);
  });

  test("a failure to read or queue is logged and never thrown at the merge writer", async () => {
    const records: LogRecord[] = [];
    configureLogger({
      sink: (output) => {
        if (output.record) records.push(output.record);
      },
    });
    const queue = new LinearMergedLabels();
    queues.push(queue);
    const broken = {
      getEnvironment: async () => ({ id: "env-1", projectId: "project-1" }),
      listBuildPipelinesForEnvironment: async () => {
        throw new Error("store unreadable");
      },
      listAllBuildPipelines: async () => [],
      kanban: { getLinearAuth: async () => null },
      linear: {
        listLinearMergedLabels: async () => [],
        enqueueLinearMergedLabel: () => {
          throw new Error("store full");
        },
        settleLinearMergedLabel: () => false,
        deferLinearMergedLabel: () => false,
      },
    } as unknown as Parameters<LinearMergedLabels["recordEnvironmentMerge"]>[0];
    await queue.recordEnvironmentMergeById(broken, "env-1", PR_URL);
    queue.recordPipelineMerge(
      broken,
      {
        id: "p1",
        projectId: "project-1",
        source: LINEAR,
        shippedPullRequestUrl: PR_URL,
        sessions: [{ phase: "pr" } as never],
      },
      PR_URL,
    );
    await queue.idle();
    expect(records.filter((entry) => entry.event === "merged-label.record-failed")).toHaveLength(2);
  });

  test("a machine without a Linear connection keeps the label pending without calling Linear", async () => {
    const linear = fakeLinear({ issueLabels: [], labels: [] });
    const { storage, queue } = await machine(LINEAR, { connected: false });
    await queue.recordEnvironmentMerge(storage, { id: "env-1", projectId: "project-1" }, PR_URL);
    await queue.idle();
    expect(linear.requests).toEqual([]);
    const [waiting] = await storage.linear.listLinearMergedLabels();
    expect(waiting).toMatchObject({
      status: "pending",
      attempts: 0,
      nextAttemptAt: waiting?.createdAt,
      lastError: "Linear is not connected on this machine",
    });
    expect(waiting?.claim).toBeUndefined();
  });

  test("a pending label survives a restart and lands from the next process's sweep", async () => {
    const linear = fakeLinear({
      issueLabels: [],
      labels: [{ id: "label-merged", name: "merged" }],
    });
    const { storage, queue, time } = await machine(LINEAR);
    linear.failNext(1);
    await queue.recordEnvironmentMerge(storage, { id: "env-1", projectId: "project-1" }, PR_URL);
    await queue.idle();
    queue.shutdown();

    const next = new LinearMergedLabels({
      now: () => time.now() + LINEAR_WRITE_RETRY_MS,
      schedule: time.schedule,
      cancel: time.cancel,
    });
    queues.push(next);
    next.sweepOnce(storage);
    await Bun.sleep(0);
    await next.idle();
    expect((await storage.linear.listLinearMergedLabels())[0]?.status).toBe("applied");
  });

  test("the retry delay doubles from a minute and stops at an hour", () => {
    expect(linearWriteRetryDelay(1)).toBe(LINEAR_WRITE_RETRY_MS);
    expect(linearWriteRetryDelay(3)).toBe(4 * LINEAR_WRITE_RETRY_MS);
    expect(linearWriteRetryDelay(50)).toBe(LINEAR_WRITE_MAX_RETRY_MS);
  });
});

describe("merged label recovery regressions", () => {
  for (const kind of ["new", "in-progress", "commit-only", "different-pr"]) {
    test(`does not attribute an older environment merge to a ${kind} build`, async () => {
      const api = fakeLinear({ issueLabels: [], labels: [] });
      const { storage, queue, pipeline } = await machine(LINEAR);
      if (kind === "different-pr") pipeline.shippedPullRequestUrl = `${PR_URL}0`;
      else {
        delete pipeline.shippedPullRequestUrl;
        pipeline.sessions = kind === "in-progress" ? [{ phase: "build" } as never] : [];
        if (kind === "commit-only") pipeline.delivery = { policy: "commit-only" } as never;
      }
      await storage.saveBuildPipeline(pipeline.id, "project-1", "env-1", 1, pipeline);
      await storage.updateEnvironment("env-1", { prState: "merged", prUrl: PR_URL });
      queue.sweepOnce(storage);
      await queue.idle();
      await queue.recordEnvironmentMergeById(storage, "env-1", PR_URL);
      queue.recordPipelineMerge(storage, pipeline, PR_URL);
      await queue.idle();
      expect(await storage.linear.listLinearMergedLabels()).toEqual([]);
      expect(api.requests).toEqual([]);
    });
  }

  for (const method of [
    "listLinearMergedLabels",
    "deferLinearMergedLabel",
    "settleLinearMergedLabel",
  ] as const) {
    test(`recovers after ${method} fails once, with no new merge`, async () => {
      const api = fakeLinear({ issueLabels: [], labels: [{ id: "merged", name: "merged" }] });
      const { storage, queue, pipeline, time } = await machine(LINEAR);
      const original = storage.linear[method].bind(storage.linear);
      let failed = false;
      // Keep the real persistence operation after the single injected storage fault.
      const spy = mock((...args: unknown[]) => {
        if (!failed) {
          failed = true;
          throw new Error("storage unavailable");
        }
        return (original as (...args: unknown[]) => unknown)(...args);
      });
      Object.defineProperty(storage.linear, method, { value: spy, configurable: true });
      if (method === "deferLinearMergedLabel") api.failNext(1);
      queue.recordPipelineMerge(storage, pipeline, PR_URL);
      await queue.idle();
      time.advance(LINEAR_WRITE_RETRY_MS);
      await queue.idle();
      expect((await storage.linear.listLinearMergedLabels())[0]?.status).toBe("applied");
      expect(time.pending()).toBe(0);
    });
  }

  for (const bodyOnly of [false, true]) {
    test(`a stalled ${bodyOnly ? "response body" : "request"} times out and the next issue progresses`, async () => {
      const { storage, time } = await machine(LINEAR);
      let signal: AbortSignal | undefined;
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        if (bodyOnly)
          return { ok: true, status: 200, json: () => new Promise(() => {}) } as Response;
        return await new Promise<Response>(() => {});
      }) as typeof fetch;
      const queue = new LinearMergedLabels({
        now: time.now,
        schedule: time.schedule,
        cancel: time.cancel,
      });
      queues.push(queue);
      for (const id of ["stalled", "later"])
        storage.linear.enqueueLinearMergedLabel(
          {
            issueId: id,
            pipelineId: id,
            projectId: "project-1",
            prUrl: PR_URL,
          },
          new Date(time.now()),
        );
      // The second job uses the same real client with a responsive fake after timeout.
      queue.sweepOnce(storage);
      await Bun.sleep(0);
      expect(signal).toBeDefined();
      fakeLinear({ issueLabels: [], labels: [{ id: "merged", name: "merged" }] });
      time.advance(LINEAR_WRITE_TIMEOUT_MS);
      await queue.idle();
      expect(signal?.aborted).toBe(true);
      const records = await storage.linear.listLinearMergedLabels();
      expect(records.find((r) => r.issueId === "stalled")).toMatchObject({
        status: "pending",
        attempts: 1,
      });
      expect(records.find((r) => r.issueId === "later")?.status).toBe("applied");
      expect(time.pending()).toBe(1);
      time.advance(LINEAR_WRITE_RETRY_MS);
      await queue.idle();
      expect(
        (await storage.linear.listLinearMergedLabels()).every((r) => r.status === "applied"),
      ).toBe(true);
    });
  }

  test("the startup sweep continues after a broken environment and retries it later", async () => {
    const api = fakeLinear({ issueLabels: [], labels: [{ id: "merged", name: "merged" }] });
    const { storage, queue, pipeline } = await machine(LINEAR);
    await storage.updateEnvironment("env-1", { prState: "merged", prUrl: PR_URL });
    const environment = (await storage.getEnvironment("env-1"))!;
    await storage.addEnvironment({ ...environment, id: "broken-env" });
    await storage.saveBuildPipeline("broken", "project-1", "broken-env", 1, {
      ...pipeline,
      id: "broken",
      environmentId: "broken-env",
    });
    const records = await storage.listAllBuildPipelines();
    storage.listAllBuildPipelines = async () => records.sort((a) => (a.id === "broken" ? -1 : 1));
    const read = storage.getEnvironment.bind(storage);
    storage.getEnvironment = async (id) => {
      if (id === "broken-env") throw new Error("broken environment");
      return read(id);
    };
    queue.sweepOnce(storage);
    await queue.idle();
    expect(api.mutations()).toHaveLength(1);
    // A second scan is admitted because the first was incomplete.
    const list = mock(storage.listAllBuildPipelines.bind(storage));
    storage.listAllBuildPipelines = list;
    queue.sweepOnce(storage);
    await queue.idle();
    expect(list).toHaveBeenCalledTimes(1);
  });

  test("finds a team label after fifty other-team matches", async () => {
    const labels = Array.from({ length: 50 }, (_, n) => ({
      id: `other-${n}`,
      name: "merged",
      teamId: `other-${n}`,
    }));
    const api = fakeLinear({
      issueLabels: [],
      labels: [...labels, { id: "ours", name: "Merged", teamId: "team-1" }],
    });
    const { storage, queue, pipeline } = await machine(LINEAR);
    queue.recordPipelineMerge(storage, pipeline, PR_URL);
    await queue.idle();
    expect(
      api.requests.filter((r) => r.operation === "OrkestratorLinearLabelsByName"),
    ).toHaveLength(2);
    expect(api.mutations()).toEqual([
      {
        operation: "OrkestratorLinearIssueAddLabel",
        variables: { id: "issue-uuid-1", labelId: "ours" },
      },
    ]);
  });

  for (const stage of ["OrkestratorLinearLabelCreate", "OrkestratorLinearIssueAddLabel"]) {
    for (const lost of [false, true]) {
      test(`recovers when ${stage} ${lost ? "succeeds but loses its response" : "fails"}`, async () => {
        const state = { issueLabels: [] as string[], labels: [] as Label[] };
        const api = fakeLinear(state);
        if (lost) api.loseAt(stage);
        else api.failAt(stage);
        const { storage, queue, pipeline, time } = await machine(LINEAR);
        queue.recordPipelineMerge(storage, pipeline, PR_URL);
        await queue.idle();
        expect((await storage.linear.listLinearMergedLabels())[0]?.status).toBe("pending");
        time.advance(LINEAR_WRITE_RETRY_MS);
        await queue.idle();
        expect((await storage.linear.listLinearMergedLabels())[0]?.status).toBe("applied");
        expect(state.labels).toHaveLength(1);
        expect(state.issueLabels).toHaveLength(1);
      });
    }
  }
});
