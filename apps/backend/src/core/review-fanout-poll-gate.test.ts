import { describe, expect, test } from "bun:test";
import {
  REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS,
  type ReviewerRecord,
} from "@orkestrator/protocol/review-fanout";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import { ManualTime } from "./recurring-test-support.js";
import { ReviewFanoutRunner, type ReviewFanoutHost } from "./review-fanout.js";
import { ElapsedPollGate, type PollTrigger } from "./workflow-poll-gate.js";

/** A reviewer whose turn went idle without a structured report. */
function harness(trigger: () => PollTrigger, time: ManualTime) {
  const reviewer: ReviewerRecord = {
    id: "reviewer-1",
    agent: "claude",
    model: "default",
    status: "running",
    sessionKey: "review-session-key",
    providerSessionId: "review-session",
    requestId: "review-request",
    dispatchState: "sent",
    resultTransport: "structured-output-v1",
  };
  let status: "idle" | "running" = "idle";
  const provider = {
    async status() {
      return status;
    },
    async messages() {
      return [];
    },
    async structured() {
      return null;
    },
    async abort() {},
  } as unknown as BuildPipelineProvider;
  const gate = new ElapsedPollGate(1_000, { now: time.now });
  const host: ReviewFanoutHost = {
    workflowId: "workflow-1",
    targetBranch: "main",
    label: "test review",
    sessionKeyFor: () => "review-session-key",
    sessionLabelFor: () => "Reviewer",
    provider: async () => provider,
    executionPolicy: async () => {
      throw new Error("not dispatched here");
    },
    async save() {},
    async assertFence() {},
    async resolveUnattendedInteractions() {},
    async abandonSession() {},
    progress: new MultiReviewProgressTracker(),
    pollGate: {
      count: (scope) => gate.count(scope, trigger()),
      exhausted: (scope, count, limit) => gate.exhausted(scope, count, limit),
      clear: (scope) => gate.clear(scope),
    },
  };
  return {
    reviewer,
    runner: new ReviewFanoutRunner(host),
    setStatus: (next: typeof status) => {
      status = next;
    },
  };
}

describe("reviewer idle-result grace under wakeups", () => {
  test("a burst of wakeup passes counts once; cadence polls still exhaust the grace", async () => {
    const time = new ManualTime(0);
    let trigger: PollTrigger = "wake";
    const { reviewer, runner } = harness(() => trigger, time);
    for (let index = 0; index < 10; index += 1) await runner.advanceReviewers([reviewer]);
    expect(reviewer.idleResultPolls).toBe(1);
    expect(reviewer.status).toBe("running");

    trigger = "periodic";
    for (let poll = 1; poll < REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS; poll += 1) {
      time.jump(1_000);
      await runner.advanceReviewers([reviewer]);
    }
    expect(reviewer.status).toBe("failed");
    expect(reviewer.error).toContain("idle without returning");
  });

  test("a slowed cadence ends the grace after the duration it stands for", async () => {
    const time = new ManualTime(0);
    const { reviewer, runner } = harness(() => "periodic", time);
    await runner.advanceReviewers([reviewer]);
    time.jump(10_000);
    await runner.advanceReviewers([reviewer]);
    // Two polls ten seconds apart: the five-poll (≈5 s) grace has elapsed.
    expect(reviewer.status).toBe("failed");
  });

  test("running progress restarts the elapsed idle grace", async () => {
    const time = new ManualTime(0);
    const { reviewer, runner, setStatus } = harness(() => "periodic", time);
    await runner.advanceReviewers([reviewer]);
    expect(reviewer.idleResultPolls).toBe(1);
    setStatus("running");
    await runner.advanceReviewers([reviewer]);
    expect(reviewer.idleResultPolls).toBeUndefined();
    time.jump(10_000);
    setStatus("idle");
    await runner.advanceReviewers([reviewer]);
    await runner.advanceReviewers([reviewer]);
    expect(reviewer.status).toBe("running");
    expect(reviewer.idleResultPolls).toBe(2);
  });
});
