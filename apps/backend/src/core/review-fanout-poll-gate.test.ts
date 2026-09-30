import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReviewerRecord,
  REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS,
  type ReviewerRecord,
} from "@orkestrator/protocol/review-fanout";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { WorkflowResultSubmissionState } from "@orkestrator/protocol/workflow-results";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import { ManualTime } from "./recurring-test-support.js";
import { ReviewFanoutRunner, type ReviewFanoutHost } from "./review-fanout.js";
import { ElapsedPollGate, type PollTrigger } from "./workflow-poll-gate.js";
import { WorkflowResultService } from "./workflow-result-service.js";

const scope = { environmentId: "env-1", projectId: "project-1" };
const report: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: [],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "Change",
    before: "Before",
    after: "After",
    keyCodeChanges: [],
    userImpact: "None",
  },
  riskProfile: { changeTypes: [], riskAreas: [], overallRisk: "low", reasoning: "Low risk" },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready" },
  summaryOfChange: "Change",
  reviewSummary: "No issues",
};

/** A reviewer whose turn went idle without a structured report. */
function harness(
  trigger: () => PollTrigger,
  time: ManualTime,
  options: {
    toolTransport?: boolean;
    finalText?: string;
    submission?: WorkflowResultSubmissionState;
    results?: WorkflowResultService;
    restored?: ReviewerRecord;
  } = {},
) {
  const reviewer: ReviewerRecord = options.restored ?? {
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
  const consumed: string[] = [];
  const saves: string[] = [];
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
    async save() {
      saves.push(JSON.stringify(reviewer));
    },
    async assertFence() {},
    async resolveUnattendedInteractions() {},
    async abandonSession() {},
    progress: new MultiReviewProgressTracker(),
    ...(options.toolTransport
      ? {
          projectResult: async (requestId: string) =>
            options.results
              ? options.results.projection(requestId)
              : (options.submission ?? "preparing"),
          readResult: <T>(requestId: string) =>
            options.results ? options.results.structured<T>(requestId) : Promise.resolve(null),
          prepareResult: async (
            selection: { agent: ReviewerRecord["agent"] },
            requestId: string,
          ) => {
            await options.results?.prepare({
              resultKey: requestId,
              kind: "review-report",
              ...scope,
              provider: selection.agent,
            });
          },
          consumeResult: async (requestId: string) => {
            await options.results?.consume(requestId);
            consumed.push(requestId);
          },
          closeResult: async (requestId: string) => {
            await options.results?.close(requestId, "superseded");
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
    consumed,
    saves,
    setStatus: (next: typeof status) => {
      status = next;
    },
  };
}

describe("reviewer idle-result grace under wakeups", () => {
  test.each(["preparing", "correcting"] as const)(
    "a reminder supersedes a retained schema repair and consumes its fresh result (%s)",
    async (submission) => {
      const dataDir = await mkdtemp(join(tmpdir(), "ork-review-reminder-"));
      try {
        const results = new WorkflowResultService(dataDir);
        await results.prepare({
          resultKey: "review-request",
          kind: "review-report",
          ...scope,
          provider: "claude",
        });
        if (submission === "correcting") {
          expect(await results.submit(scope, "review-request", {})).toMatchObject({ ok: false });
        }
        const time = new ManualTime(0);
        const { reviewer, runner, sent, closed, consumed } = harness(() => "periodic", time, {
          toolTransport: true,
          finalText: '{"issues":[]}',
          results,
        });
        reviewer.schemaRepairPrompt = "Stale schema repair instructions";
        reviewer.schemaRepairAttempts = 1;
        await runner.advanceReviewers([reviewer]);
        time.jump(10_000);
        await runner.advanceReviewers([reviewer]);
        expect(reviewer).toMatchObject({
          status: "running",
          dispatchState: "prepared",
          resultReminderSent: true,
          schemaRepairAttempts: 1,
        });
        expect(reviewer.schemaRepairPrompt).toBeUndefined();
        expect(closed).toEqual(["review-request"]);
        const resultKey = reviewer.requestId!;
        expect(resultKey).not.toBe("review-request");
        await runner.advanceReviewers([reviewer]);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ sessionId: "review-session", requestId: resultKey });
        expect(sent[0]!.prompt).toContain("Your analysis is already done");
        expect(sent[0]!.prompt).not.toContain("Stale schema repair instructions");
        expect(sent[0]!.prompt).toContain(JSON.stringify(resultKey));
        expect(sent[0]!.prompt).toContain(
          submission === "correcting"
            ? "Your last submission was rejected."
            : "You wrote the structured report as reply text.",
        );
        expect(await results.submit(scope, "review-request", report)).toMatchObject({
          ok: false,
          error: { code: "attempt_closed" },
        });
        expect(await results.submit(scope, resultKey, report)).toMatchObject({ ok: true });
        expect(await runner.advanceReviewers([reviewer])).toEqual({
          kind: "ready",
          reports: [reviewer],
        });
        expect(reviewer.status).toBe("completed");
        expect(reviewer.report?.reviewSummary).toBe(report.reviewSummary);
        expect(reviewer.resultSubmission).toBeUndefined();
        expect(consumed).toEqual([resultKey]);
        expect(await results.status(scope, resultKey)).toMatchObject({ lifecycle: "consumed" });
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  test.each(["received", "needs-attention"] as const)(
    "does not queue a reminder for a %s slot with an unreadable result",
    async (submission) => {
      const time = new ManualTime(0);
      const { reviewer, runner, sent, closed } = harness(() => "periodic", time, {
        toolTransport: true,
        submission,
      });
      await runner.advanceReviewers([reviewer]);
      time.jump(10_000);
      await runner.advanceReviewers([reviewer]);
      expect(reviewer.status).toBe("failed");
      expect(reviewer.resultReminderSent).toBeUndefined();
      expect(reviewer.requestId).toBe("review-request");
      expect(sent).toHaveLength(0);
      expect(closed).toHaveLength(0);
    },
  );

  test("does not queue a reminder without a provider session", async () => {
    const time = new ManualTime(0);
    const { reviewer, runner, sent, closed } = harness(() => "periodic", time, {
      toolTransport: true,
    });
    delete reviewer.providerSessionId;
    reviewer.idleResultPolls = REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS;
    await runner.advanceReviewers([reviewer]);
    expect(reviewer.resultReminderSent).toBeUndefined();
    expect(reviewer.requestId).toBe("review-request");
    expect(sent).toHaveLength(0);
    expect(closed).toHaveLength(0);
  });

  test.each(["prepared", "dispatching", "sent"] as const)(
    "a persisted %s reminder dispatches at most once across runner restarts",
    async (dispatchState) => {
      const time = new ManualTime(0);
      const initial = harness(() => "periodic", time, { toolTransport: true });
      await initial.runner.advanceReviewers([initial.reviewer]);
      time.jump(10_000);
      await initial.runner.advanceReviewers([initial.reviewer]);
      const requestId = initial.reviewer.requestId;
      const queued = JSON.parse(initial.saves.at(-1)!);
      expect(isReviewerRecord(queued)).toBe(true);
      if (dispatchState !== "prepared") {
        await initial.runner.advanceReviewers([initial.reviewer]);
      }
      // The dispatching snapshot is saved before send and can survive a lost
      // acknowledgement. Reconciliation must never send that request again.
      const saved =
        dispatchState === "prepared"
          ? queued
          : JSON.parse(
              initial.saves.findLast((saved) => JSON.parse(saved).dispatchState === dispatchState)!,
            );
      expect(isReviewerRecord(saved)).toBe(true);
      const restarted = harness(() => "periodic", time, { toolTransport: true, restored: saved });
      await restarted.runner.advanceReviewers([restarted.reviewer]);
      expect([...initial.sent, ...restarted.sent]).toHaveLength(1);
      expect(restarted.reviewer.requestId).toBe(requestId);
      expect(restarted.reviewer.resultReminderSent).toBe(true);
      const reloaded = JSON.parse(restarted.saves.at(-1)!);
      const again = harness(() => "periodic", time, { toolTransport: true, restored: reloaded });
      for (let poll = 0; poll < REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS; poll += 1) {
        time.jump(10_000);
        await again.runner.advanceReviewers([again.reviewer]);
      }
      expect(again.reviewer.status).toBe("failed");
      expect(again.reviewer.requestId).toBe(requestId);
      expect(again.sent).toHaveLength(0);
      expect(again.closed).toHaveLength(0);
    },
  );
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
    expect(reviewer.resultReminderSent).toBeUndefined();
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
