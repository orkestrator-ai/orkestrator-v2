import { describe, expect, test } from "bun:test";
import {
  PUSH_CHANGED_EVENT,
  formatWorkflowPushKey,
  parseWorkflowPushKey,
  type PushChangedPayload,
  type PushStamp,
  type WorkflowPushKey,
} from "@orkestrator/protocol/push-events";
import { ManualClock, flushMicrotasks } from "@orkestrator/protocol/testing/manual-clock";
import {
  WORKFLOW_OBSERVE_ERROR_MS,
  WorkflowPushTopic,
  workflowChangedParts,
  type WorkflowPushSummary,
} from "./workflow-push-topic.js";
import { createWorkflowSummaryReader } from "./workflow-push-summary.js";
import { BackendPush } from "./index.js";

const PIPELINE = formatWorkflowPushKey({ kind: "build-pipeline", id: "pipe-1" });
const REVIEW = formatWorkflowPushKey({ kind: "multi-review", id: "review-1" });

function changed(resource: string, id: string, extra: Record<string, unknown> = {}) {
  return { resource, id, revision: 1, ...extra };
}

function harness() {
  const clock = new ManualClock();
  const records = new Map<string, WorkflowPushSummary>([
    [PIPELINE, { revision: 1, status: "build", terminal: false }],
    [REVIEW, { revision: 4, status: "reviewing", terminal: false }],
  ]);
  const reads: string[] = [];
  let failNext = 0;
  const published: Array<{ key: string; stamp: PushStamp; parts: readonly string[] }> = [];
  const topic = new WorkflowPushTopic({
    timers: clock,
    readSummary: async (key: WorkflowPushKey) => {
      const id = formatWorkflowPushKey(key);
      reads.push(id);
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("storage unavailable");
      }
      return records.get(id) ?? null;
    },
    publish: (key, stamp, parts) => published.push({ key, stamp, parts }),
  });
  const settle = async (ms = 0) => {
    await clock.advanceAsync(ms);
    await flushMicrotasks();
  };
  return {
    clock,
    topic,
    records,
    reads,
    published,
    settle,
    failReads: (count: number) => {
      failNext = count;
    },
  };
}

describe("workflow push keys", () => {
  test("parse only known kinds with one plain id", () => {
    expect(parseWorkflowPushKey("build-pipeline/abc-1")).toEqual({
      kind: "build-pipeline",
      id: "abc-1",
    });
    expect(parseWorkflowPushKey("graph-run/run_1")).toEqual({ kind: "graph-run", id: "run_1" });
    expect(parseWorkflowPushKey("pipeline/abc")).toBeNull();
    expect(parseWorkflowPushKey("multi-review/")).toBeNull();
    expect(parseWorkflowPushKey("multi-review/a/b")).toBeNull();
    expect(parseWorkflowPushKey("multi-review/a b")).toBeNull();
    expect(parseWorkflowPushKey(`multi-review/${"x".repeat(257)}`)).toBeNull();
  });
});

describe("workflowChangedParts", () => {
  const base = { revision: 1, status: "build", terminal: false };
  test("names what moved", () => {
    expect(workflowChangedParts(base, base)).toEqual([]);
    expect(workflowChangedParts(base, { ...base, revision: 2 })).toEqual(["progress"]);
    expect(workflowChangedParts(base, { ...base, revision: 2, status: "review" })).toEqual([
      "status",
      "progress",
    ]);
    expect(workflowChangedParts(base, { revision: 2, status: "complete", terminal: true })).toEqual(
      ["status", "progress", "result"],
    );
    expect(workflowChangedParts(base, null)).toEqual(["status", "progress", "result"]);
    expect(workflowChangedParts(null, null)).toEqual([]);
  });
});

describe("WorkflowPushTopic", () => {
  test("resolve answers the stamp for a known run and missing for an unknown one", async () => {
    const { topic, reads } = harness();
    topic.retain(PIPELINE);
    const answer = await topic.resolve(PIPELINE);
    expect(answer).toMatchObject({ status: "ok", revision: 0 });
    expect(reads).toEqual([PIPELINE]);
    // A baseline makes a second resolve free: events keep it current.
    await topic.resolve(PIPELINE);
    expect(reads).toEqual([PIPELINE]);

    const unknown = formatWorkflowPushKey({ kind: "build-pipeline", id: "nope" });
    topic.retain(unknown);
    expect(await topic.resolve(unknown)).toEqual({ status: "missing" });
    // Not retained (released while the set was answered): missing, no read.
    expect(await topic.resolve(REVIEW)).toEqual({ status: "missing" });
    expect(await topic.resolve("pipeline/x")).toEqual({ status: "denied" });
  });

  test("a resource change for a subscribed run publishes the parts that moved", async () => {
    const { topic, records, published, settle } = harness();
    topic.retain(PIPELINE);
    const answer = await topic.resolve(PIPELINE);
    const generation = answer.status === "ok" ? answer.generation : "";

    records.set(PIPELINE, { revision: 2, status: "build", terminal: false });
    topic.observeEvent("resource-changed", changed("build-pipeline", "pipe-1"));
    await settle();
    expect(published).toEqual([
      { key: PIPELINE, stamp: { generation, revision: 1 }, parts: ["progress"] },
    ]);

    records.set(PIPELINE, { revision: 3, status: "complete", terminal: true });
    topic.observeEvent("resource-changed", changed("build-pipeline", "pipe-1"));
    await settle();
    expect(published.at(-1)).toEqual({
      key: PIPELINE,
      stamp: { generation, revision: 2 },
      parts: ["status", "progress", "result"],
    });
    expect(topic.metrics()).toMatchObject({ observers: 1, changes: 2, wakes: 2 });
  });

  test("an unchanged record, another kind or an unsubscribed run publishes nothing", async () => {
    const { topic, reads, published, settle } = harness();
    topic.retain(PIPELINE);
    await topic.resolve(PIPELINE);
    topic.observeEvent("resource-changed", changed("build-pipeline", "pipe-1"));
    // Same id under another kind, and a run nobody subscribes to: no read.
    topic.observeEvent("resource-changed", changed("multi-review", "pipe-1"));
    topic.observeEvent("resource-changed", changed("build-pipeline", "pipe-2"));
    topic.observeEvent("native-agent-session-activity", changed("build-pipeline", "pipe-1"));
    await settle();
    expect(reads).toEqual([PIPELINE, PIPELINE]);
    expect(published).toEqual([]);
  });

  test("a burst of changes joins the read in flight and reads once more", async () => {
    const { topic, records, reads, published, settle } = harness();
    topic.retain(REVIEW);
    await topic.resolve(REVIEW);
    for (let revision = 5; revision < 10; revision += 1) {
      records.set(REVIEW, { revision, status: "reviewing", terminal: false });
      topic.observeEvent("resource-changed", changed("multi-review", "review-1"));
    }
    await settle();
    // The mount read, the first wake's read, and one more for the rest.
    expect(reads.length).toBe(3);
    expect(published.map((entry) => entry.stamp.revision)).toEqual([1, 2]);
  });

  test("a deleted run announces everything, then resolves missing", async () => {
    const { topic, records, published, settle } = harness();
    topic.retain(REVIEW);
    await topic.resolve(REVIEW);
    records.delete(REVIEW);
    topic.observeEvent("resource-changed", changed("multi-review", "review-1", { deleted: true }));
    await settle();
    expect(published.at(-1)?.parts).toEqual(["status", "progress", "result"]);
    expect(await topic.resolve(REVIEW)).toEqual({ status: "missing" });
  });

  test("a failed read is retried with backoff and a failed first read fails the resolve", async () => {
    const { topic, records, reads, published, settle, failReads } = harness();
    topic.retain(PIPELINE);
    failReads(1);
    await expect(topic.resolve(PIPELINE)).rejects.toThrow("Workflow summary read failed");
    await settle(WORKFLOW_OBSERVE_ERROR_MS);
    expect(reads).toHaveLength(2);
    // The retry set the baseline; the next change publishes.
    failReads(1);
    records.set(PIPELINE, { revision: 2, status: "review", terminal: false });
    topic.observeEvent("resource-changed", changed("build-pipeline", "pipe-1"));
    await settle();
    expect(published).toEqual([]);
    expect(topic.metrics().readFailures).toBe(2);
    await settle(WORKFLOW_OBSERVE_ERROR_MS);
    expect(published).toHaveLength(1);
    expect(published[0]?.parts).toEqual(["status", "progress"]);
  });

  test("release stops retries and forgets the run; a new retain is a new generation", async () => {
    const { topic, reads, settle, failReads } = harness();
    topic.retain(PIPELINE);
    const first = await topic.resolve(PIPELINE);
    failReads(10);
    topic.observeEvent("resource-changed", changed("build-pipeline", "pipe-1"));
    await settle();
    const before = reads.length;
    topic.release(PIPELINE);
    await settle(60_000);
    expect(reads.length).toBe(before);
    expect(topic.metrics().observers).toBe(0);
    failReads(0);
    topic.retain(PIPELINE);
    const second = await topic.resolve(PIPELINE);
    expect(second.status === "ok" && first.status === "ok" && second.generation).not.toBe(
      first.status === "ok" && first.generation,
    );
    topic.dispose();
  });
});

describe("createWorkflowSummaryReader", () => {
  const storage = {
    getBuildPipeline: async (id: string) =>
      id === "p" ? { revision: 3, snapshot: { phase: "failed" } } : null,
    getMultiReviewWorkflow: async (id: string) =>
      id === "m" ? { revision: 7, snapshot: { phase: "consolidating" } } : null,
    graphRuns: {
      getGraphRun: async (id: string) => {
        if (id === "gone") throw Object.assign(new Error("gone"), { code: "run-not-found" });
        return null;
      },
    },
  };
  const read = createWorkflowSummaryReader(storage);

  test("reads revision, phase and whether the phase ends the run", async () => {
    expect(await read({ kind: "build-pipeline", id: "p" })).toEqual({
      revision: 3,
      status: "failed",
      terminal: true,
    });
    expect(await read({ kind: "multi-review", id: "m" })).toEqual({
      revision: 7,
      status: "consolidating",
      terminal: false,
    });
    expect(await read({ kind: "build-pipeline", id: "x" })).toBeNull();
    expect(await read({ kind: "graph-run", id: "not a run id" })).toBeNull();
  });
});

describe("BackendPush workflow topic end to end", () => {
  test("two viewers of one pipeline get one frame per save and no traffic while quiet", async () => {
    const clock = new ManualClock();
    let summary: WorkflowPushSummary = { revision: 1, status: "build", terminal: false };
    let reads = 0;
    const push = new BackendPush({
      hub: { timers: clock, now: () => clock.now() },
      sessionExists: async () => true,
      nativeAgents: () => undefined,
      workflows: {
        readSummary: async (key) => {
          reads += 1;
          return key.id === "pipe-1" ? summary : null;
        },
      },
    });
    const frames: Array<{ viewer: string; payload: PushChangedPayload }> = [];
    const open = (viewer: string) =>
      push.openConnection("owner", {
        write: (event, payload) => {
          if (event === PUSH_CHANGED_EVENT) {
            frames.push({ viewer, payload: payload as PushChangedPayload });
          }
          return true;
        },
        backpressured: () => false,
      });
    const a = open("a");
    const b = open("b");
    const subscriptions = [
      { topic: "workflow", key: PIPELINE },
      { topic: "workflow", key: "build-pipeline/unknown" },
    ];
    const answerA = await push.setSubscriptions("owner", {
      streamId: a,
      setRevision: 1,
      subscriptions,
    });
    await push.setSubscriptions("owner", { streamId: b, setRevision: 1, subscriptions });
    expect(answerA.status === "applied" && answerA.subscriptions.map((s) => s.status)).toEqual([
      "ok",
      "missing",
    ]);
    const quietReads = reads;
    // Quiet: no poller, so a minute costs nothing.
    await clock.advanceAsync(60_000);
    expect(reads).toBe(quietReads);
    expect(frames).toEqual([]);

    summary = { revision: 2, status: "complete", terminal: true };
    push.observeEvent("resource-changed", changed("build-pipeline", "pipe-1"));
    await flushMicrotasks();
    await clock.advanceAsync(100);
    expect(reads).toBe(quietReads + 1);
    expect(frames.map((frame) => frame.viewer).sort()).toEqual(["a", "b"]);
    expect(frames[0]?.payload.changes).toEqual([
      expect.objectContaining({ topic: "workflow", key: PIPELINE, revision: 1 }),
    ]);
    expect(frames[0]?.payload.changes[0]?.parts).toEqual(["status", "progress", "result"]);
    expect(push.metrics().topics.workflow).toMatchObject({ observers: 1, changes: 1 });

    // The last viewer leaving releases the run.
    await push.setSubscriptions("owner", { streamId: a, setRevision: 2, subscriptions: [] });
    push.closeConnection(b);
    expect(push.metrics().topics.workflow?.observers).toBe(0);
    push.dispose();
  });
});
