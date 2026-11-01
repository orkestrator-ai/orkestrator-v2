/**
 * Waiting graph runs in the sidebar (item 208): the environment's
 * `graph-run` activity and one attention mark per wait, on a real store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import { humanActivation, humanRun } from "./graph-node-human-test-support.js";
import {
  GraphRunAttention,
  graphAttentionErrorReason,
  graphRunAttentionKey,
  graphRunCompletionOutcome,
  graphRunEnvironmentActivity,
  type GraphRunWaitOpened,
} from "./graph-run-attention.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import { StorageService } from "./storage.js";

const T1 = "2026-10-29T12:00:00.000Z";
const T2 = "2026-10-29T12:05:00.000Z";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function store(dataDir?: string) {
  const root = dataDir ?? (await fs.mkdtemp(path.join(tmpdir(), "orkestrator-graph-attention-")));
  const storage = new StorageService(root);
  await storage.init();
  if (!dataDir) await storage.addEnvironment(graphEnvironmentFixture());
  cleanups.push(async () => {
    storage.close();
    if (!dataDir) await fs.rm(root, { recursive: true, force: true });
  });
  return { storage, root };
}

/** Timers that never fire: the tests observe explicitly. */
const NO_TIMERS = { setTimeout: () => 0, clearTimeout: () => undefined };

describe("graph run attention", () => {
  test("environment activity: working beats waiting; paused with nothing in flight is idle", () => {
    const waiting = humanRun("e1", "p1", { activations: [humanActivation("first", T1)] });
    expect(graphRunEnvironmentActivity([waiting])).toBe("waiting");
    expect(
      graphRunEnvironmentActivity([waiting, humanRun("e1", "p1", { status: "running" })]),
    ).toBe("working");
    expect(graphRunEnvironmentActivity([humanRun("e1", "p1", { status: "paused" })])).toBe("idle");
    expect(
      graphRunEnvironmentActivity([
        humanRun("e1", "p1", { status: "paused", activations: [humanActivation("first", T1)] }),
      ]),
    ).toBe("waiting");
    expect(graphRunEnvironmentActivity([humanRun("e1", "p1", { status: "complete" })])).toBe(
      "idle",
    );
  });

  test("each wait lights the badge once, and the sidebar shows the run waiting", async () => {
    const { storage } = await store();
    const attention = new GraphRunAttention(storage, { timers: NO_TIMERS });
    const opened: GraphRunWaitOpened[] = [];
    attention.onWaitOpened((event) => opened.push(event));
    const first = humanActivation("first", T1);
    let run: GraphRun = await storage.graphRuns.createGraphRun(
      humanRun("e1", "p1", { activations: [first] }),
    );

    await attention.observeRun(run.id);
    let environment = (await storage.getEnvironment("e1"))!;
    expect(environment.agentActivitySources?.["graph-run"]?.state).toBe("waiting");
    expect(environment.agentActivityState).toBe("waiting");
    expect(environment.hasUnreadWork).toBe(true);
    expect(environment.unreadReason).toBe("agent_question");
    expect(environment.agentAttentionKeys).toContain(graphRunAttentionKey(run.id, first.human!.id));
    expect(opened).toEqual([
      expect.objectContaining({
        runId: run.id,
        environmentId: "e1",
        interactions: [expect.objectContaining({ kind: "human", waitId: first.human!.id })],
      }),
    ]);

    // The user reads the badge; the same wait observed again never re-lights it.
    await storage.setEnvironmentUnread("e1", false);
    await attention.observeRun(run.id);
    await attention.reconcile();
    environment = (await storage.getEnvironment("e1"))!;
    expect(environment.hasUnreadWork).toBe(false);
    expect(opened).toHaveLength(1);

    // A second wait is new.
    const second = humanActivation("second", T2);
    run = await storage.graphRuns.saveGraphRun(
      { ...run, activations: [first, second] },
      run.revision,
    );
    await attention.observeRun(run.id);
    expect((await storage.getEnvironment("e1"))!.hasUnreadWork).toBe(true);
    expect(opened.map((event) => event.interactions.map((entry) => entry.nodeId))).toEqual([
      ["first"],
      ["second"],
    ]);

    // Answered and finished: the sidebar goes idle.
    run = await storage.graphRuns.saveGraphRun(
      {
        ...run,
        status: "complete",
        finishedAt: T2,
        activations: [
          humanActivation("first", T1, { answered: true }),
          humanActivation("second", T2, { answered: true }),
        ],
      },
      run.revision,
    );
    await attention.observeRun(run.id);
    expect((await storage.getEnvironment("e1"))!.agentActivitySources?.["graph-run"]?.state).toBe(
      "idle",
    );
  });

  test("after a restart, reconciling restores a waiting run without lighting its wait twice", async () => {
    const { storage, root } = await store();
    const first = humanActivation("first", T1);
    const run = await storage.graphRuns.createGraphRun(
      humanRun("e1", "p1", { activations: [first] }),
    );
    await new GraphRunAttention(storage, { timers: NO_TIMERS }).observeRun(run.id);
    await storage.setEnvironmentUnread("e1", false);
    // A stale source the previous process left behind is corrected too.
    await storage.setEnvironmentAgentActivity("e1", "idle", new Date().toISOString(), "graph-run");

    const restarted = (await store(root)).storage;
    const attention = new GraphRunAttention(restarted, { timers: NO_TIMERS });
    const opened: GraphRunWaitOpened[] = [];
    attention.onWaitOpened((event) => opened.push(event));
    await attention.start();
    attention.stop();
    const environment = (await restarted.getEnvironment("e1"))!;
    expect(environment.agentActivitySources?.["graph-run"]?.state).toBe("waiting");
    expect(environment.hasUnreadWork).toBe(false);
    expect(opened).toEqual([]);
  });
});

describe("what a graph run's end rings", () => {
  async function runningRun() {
    const { storage } = await store();
    const attention = new GraphRunAttention(storage, { timers: NO_TIMERS });
    const run = await storage.graphRuns.createGraphRun(
      humanRun("e1", "p1", { status: "running", activations: [] }),
    );
    await attention.observeRun(run.id);
    expect((await storage.getEnvironment("e1"))!.agentActivityState).toBe("working");
    return { storage, attention, run };
  }

  test.each([
    ["failed", true, "agent_failed"],
    ["complete", true, "agent_finished"],
    ["cancelled", false, undefined],
    ["paused", false, undefined],
  ] as const)("a %s run", async (status, unread, reason) => {
    const { storage, attention, run } = await runningRun();
    await storage.graphRuns.saveGraphRun(
      {
        ...run,
        status,
        ...(status === "paused" ? {} : { finishedAt: new Date().toISOString() }),
      },
      run.revision,
    );
    await attention.observeRun(run.id);
    const environment = (await storage.getEnvironment("e1"))!;
    expect(environment.agentActivityState).toBe("idle");
    expect(environment.hasUnreadWork ?? false).toBe(unread);
    expect(environment.unreadReason).toBe(reason);
  });

  test("a failure rings while a sibling source keeps the environment working", async () => {
    const { storage, attention, run } = await runningRun();
    await storage.setEnvironmentAgentActivity(
      "e1",
      "working",
      new Date().toISOString(),
      "native-agent",
    );
    await storage.graphRuns.saveGraphRun(
      { ...run, status: "failed", finishedAt: new Date().toISOString() },
      run.revision,
    );
    await attention.observeRun(run.id);
    const environment = (await storage.getEnvironment("e1"))!;
    expect(environment.agentActivityState).toBe("working");
    expect(environment.unreadReason).toBe("agent_failed");

    // The sibling's end cannot say what ended, so the failure stays what it reads.
    await storage.setEnvironmentAgentActivity(
      "e1",
      "idle",
      new Date().toISOString(),
      "native-agent",
    );
    expect((await storage.getEnvironment("e1"))!.unreadReason).toBe("agent_failed");
  });

  test("a cancelled run does not swallow a sibling's wait for input", async () => {
    const { storage, attention, run } = await runningRun();
    await storage.setEnvironmentAgentActivity(
      "e1",
      "waiting",
      new Date().toISOString(),
      "native-agent",
    );
    await storage.graphRuns.saveGraphRun(
      { ...run, status: "cancelled", finishedAt: new Date().toISOString() },
      run.revision,
    );
    await attention.observeRun(run.id);
    expect(await storage.getEnvironment("e1")).toMatchObject({
      agentActivityState: "waiting",
      hasUnreadWork: true,
      unreadReason: "agent_waiting",
    });
  });

  test("only runs that ended since the source started working decide", () => {
    const ended = (status: "failed" | "complete" | "cancelled", finishedAt: string) =>
      humanRun("e1", "p1", { status, finishedAt });
    expect(graphRunCompletionOutcome([ended("failed", T1), ended("complete", T2)], T2)).toBe(
      undefined,
    );
    expect(graphRunCompletionOutcome([ended("failed", T2), ended("complete", T2)], T1)).toBe(
      "failed",
    );
    expect(graphRunCompletionOutcome([ended("cancelled", T2), ended("complete", T2)], T1)).toBe(
      undefined,
    );
    expect(graphRunCompletionOutcome([ended("cancelled", T2)], T1)).toBe("none");
    expect(graphRunCompletionOutcome([], T1)).toBe("none");
  });
});

describe("graph run attention logs", () => {
  test("a failure is logged by code or name, never by message", () => {
    const secret = "prompt text that must not reach a log";
    expect(
      graphAttentionErrorReason(Object.assign(new Error(secret), { code: "run-not-found" })),
    ).toBe("run-not-found");
    expect(graphAttentionErrorReason(new TypeError(secret))).toBe("TypeError");
    expect(graphAttentionErrorReason(Object.assign(new Error(secret), { code: secret }))).toBe(
      "Error",
    );
    expect(graphAttentionErrorReason(secret)).toBe("error");
    expect(graphAttentionErrorReason(null)).toBe("error");
  });
});
