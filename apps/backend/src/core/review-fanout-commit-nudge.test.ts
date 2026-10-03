import { describe, expect, test } from "bun:test";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import {
  REVIEW_RESULT_COMMIT_NUDGE_MS,
  ReviewFanoutRunner,
  type ReviewFanoutHost,
} from "./review-fanout.js";

const DIGEST = "d".repeat(64);

/** A tool-transport reviewer whose turn is still running and holds a validated report. */
function harness(
  options: {
    held?: { digest: string; ageMs: number };
    steer?: "supported" | "unsupported" | "absent" | "throws";
    activeState?: "running" | "idle";
  } = {},
) {
  const reviewer: ReviewerRecord = {
    id: "reviewer-1",
    agent: "cursor",
    model: "default",
    status: "running",
    sessionKey: "review-session-key",
    providerSessionId: "review-session",
    requestId: "review-request",
    dispatchState: "sent",
    resultTransport: "tool-v1",
  };
  const steers: Array<Record<string, unknown>> = [];
  const steerMode = options.steer ?? "supported";
  const provider = {
    async status() {
      return "running";
    },
    async messages() {
      return [];
    },
    async structured() {
      return null;
    },
    async abort() {},
    ...(steerMode === "absent"
      ? {}
      : {
          async steerSupported() {
            if (steerMode === "throws") throw new Error("bridge unavailable");
            return steerMode === "supported";
          },
          async activeSteerRun() {
            return { state: options.activeState ?? "running", runId: "run-1" };
          },
          async performSessionAction(_sessionId: string, action: Record<string, unknown>) {
            steers.push(action);
            return { outcome: "applied" };
          },
        }),
  } as unknown as BuildPipelineProvider;
  const nudged = new Set<string>();
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
    projectResult: async () => "preparing",
    readResult: () => Promise.resolve(null),
    heldResult: () => options.held,
    claimResultNudge: (requestId) => {
      if (nudged.has(requestId)) return false;
      nudged.add(requestId);
      return true;
    },
  };
  return { reviewer, host, runner: new ReviewFanoutRunner(host), steers };
}

describe("committing a validated report that was never submitted", () => {
  test("steers the live turn to commit by digest once the report has been held long enough", async () => {
    const { reviewer, runner, steers } = harness({
      held: { digest: DIGEST, ageMs: REVIEW_RESULT_COMMIT_NUDGE_MS },
    });
    await runner.advanceReviewers([reviewer]);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatchObject({ kind: "steer", expectedRunId: "run-1" });
    const text = String(steers[0]!.text);
    expect(text).toContain("submit_review_report");
    expect(text).toContain(JSON.stringify("review-request"));
    expect(text).toContain(JSON.stringify(DIGEST));
    expect(text).toContain("leave `result` out");
    expect(reviewer.status).toBe("running");
  });

  test("nudges a slot at most once across separately constructed supervisor passes", async () => {
    const { reviewer, host, runner, steers } = harness({
      held: { digest: DIGEST, ageMs: REVIEW_RESULT_COMMIT_NUDGE_MS * 3 },
    });
    await runner.advanceReviewers([reviewer]);
    await new ReviewFanoutRunner({ ...host }).advanceReviewers([reviewer]);
    await new ReviewFanoutRunner({ ...host }).advanceReviewers([reviewer]);
    expect(steers).toHaveLength(1);
  });

  test("leaves a recently validated report alone", async () => {
    const { reviewer, runner, steers } = harness({
      held: { digest: DIGEST, ageMs: REVIEW_RESULT_COMMIT_NUDGE_MS - 1 },
    });
    await runner.advanceReviewers([reviewer]);
    expect(steers).toHaveLength(0);
  });

  test("does nothing when no validated report is held", async () => {
    const { reviewer, runner, steers } = harness({});
    await runner.advanceReviewers([reviewer]);
    expect(steers).toHaveLength(0);
  });

  test("does nothing for a reviewer that does not use the result tool", async () => {
    const { reviewer, runner, steers } = harness({
      held: { digest: DIGEST, ageMs: REVIEW_RESULT_COMMIT_NUDGE_MS },
    });
    reviewer.resultTransport = "structured-output-v1";
    await runner.advanceReviewers([reviewer]);
    expect(steers).toHaveLength(0);
  });

  test.each([
    ["a provider without a steer surface", { steer: "absent" }],
    ["a bridge that cannot steer", { steer: "unsupported" }],
    ["a bridge whose steer check fails", { steer: "throws" }],
    ["a turn that is no longer running", { activeState: "idle" }],
  ] as const)("is a quiet no-op for %s", async (_name, extra) => {
    const { reviewer, runner, steers } = harness({
      held: { digest: DIGEST, ageMs: REVIEW_RESULT_COMMIT_NUDGE_MS },
      ...extra,
    });
    await runner.advanceReviewers([reviewer]);
    expect(steers).toHaveLength(0);
    expect(reviewer.status).toBe("running");
  });
});
