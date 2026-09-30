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
function harness(
  trigger: () => PollTrigger,
  time: ManualTime,
  options: { toolTransport?: boolean; finalText?: string } = {},
) {
  const reviewer: ReviewerRecord = {
    id: "reviewer-1",
    agent: "claude",
    model: "default",
    status: "running",
    sessionKey: "review-session-key",
    providerSessionId: "review-session",
    requestId: "review-request",
    dispatchState: "sent",
    resultTransport: options.toolTransport ? "tool-v1" : "structured-output-v1",
  };
  let status: "idle" | "running" = "idle";
  const sent: Array<{ sessionId: string; prompt: string; requestId?: string }> = [];
  const closed: string[] = [];
  const provider = {
    async status() {
      return status;
    },
    async messages() {
      return options.finalText === undefined
        ? []
        : [{ role: "assistant", parts: [{ type: "text", content: options.finalText }] }];
    },
    async structured() {
      return null;
    },
    async abort() {},
    async send(sessionId: string, prompt: string, options: { requestId?: string }) {
      sent.push({ sessionId, prompt, requestId: options.requestId });
    },
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
    ...(options.toolTransport
      ? {
          projectResult: async () => "preparing" as const,
          readResult: async () => null,
          prepareResult: async () => {},
          closeResult: async (requestId: string) => {
            closed.push(requestId);
          },
        }
      : {}),
    pollGate: {
      count: (scope) => gate.count(scope, trigger()),
      exhausted: (scope, count, limit) => gate.exhausted(scope, count, limit),
      clear: (scope) => gate.clear(scope),
    },
  };
  return {
    reviewer,
    runner: new ReviewFanoutRunner(host),
    sent,
    closed,
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

  test("a tool-transport reviewer that pasted its report is reminded once, then failed with that explanation", async () => {
    const time = new ManualTime(0);
    const { reviewer, runner, sent, closed } = harness(() => "periodic", time, {
      toolTransport: true,
      finalText: '{"issues":[]}',
    });
    await runner.advanceReviewers([reviewer]);
    time.jump(10_000);
    await runner.advanceReviewers([reviewer]);
    // The grace is spent, but the analysis is done: one reminder turn in the
    // same session, under a fresh result slot.
    expect(reviewer.status).toBe("running");
    expect(reviewer.resultReminderSent).toBe(true);
    expect(reviewer.dispatchState).toBe("prepared");
    expect(reviewer.requestId).not.toBe("review-request");
    expect(reviewer.idleResultPolls).toBeUndefined();
    expect(closed).toEqual(["review-request"]);

    await runner.advanceReviewers([reviewer]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.sessionId).toBe("review-session");
    expect(sent[0]?.requestId).toBe(reviewer.requestId);
    expect(sent[0]?.prompt).toContain("You wrote the structured report as reply text.");
    expect(sent[0]?.prompt).toContain(JSON.stringify(reviewer.requestId));
    expect(reviewer.dispatchState).toBe("sent");
    expect(reviewer.continuationPrompt).toBeUndefined();

    // The reminder turn also ends without a result; the reminder is spent.
    time.jump(10_000);
    await runner.advanceReviewers([reviewer]);
    time.jump(10_000);
    await runner.advanceReviewers([reviewer]);
    expect(sent).toHaveLength(1);
    expect(reviewer.status).toBe("failed");
    expect(reviewer.error).toBe(
      "The reviewer replied with its structured report as text instead of calling submit_review_report",
    );
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
