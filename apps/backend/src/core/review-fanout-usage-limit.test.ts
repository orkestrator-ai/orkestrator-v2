import { describe, expect, mock, test } from "bun:test";
import type { UsageLimitStopVerdict } from "@orkestrator/protocol/agent-account-auto-switch";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import { ProviderSessionFailedError } from "./agent-provider-contract.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import { ReviewFanoutRunner, type ReviewFanoutHost } from "./review-fanout.js";
import { reportFor } from "./build-pipeline-review-fanout-test-support.js";

const LIMIT = "You've hit your usage limit.";

/** A sent reviewer, on a shared branch runner, whose turn ended on a limit error. */
function harness(verdict: UsageLimitStopVerdict, overrides: Partial<ReviewerRecord> = {}) {
  const reviewer: ReviewerRecord = {
    id: "reviewer-1",
    agent: "codex",
    model: "default",
    status: "running",
    sessionKey: "review-session-key",
    providerSessionId: "review-session",
    requestId: "review-request",
    dispatchState: "sent",
    resultTransport: "structured-output-v1",
    ...overrides,
  };
  const bridge = {
    failed: true,
    accepted: new Set(["review-request"]),
    structured: null as unknown,
  };
  const usageLimitStop = mock(async () => verdict);
  const provider = {
    usageLimitStop,
    async status() {
      if (bridge.failed) throw new ProviderSessionFailedError("codex", LIMIT);
      return "idle";
    },
    async messages() {
      return [];
    },
    async structured() {
      return bridge.structured;
    },
    async abort() {},
    async send() {},
    async dispatchStatus(_sessionId: string, requestId: string) {
      return bridge.accepted.has(requestId) ? "pending" : "unknown";
    },
  } as unknown as BuildPipelineProvider;
  const providerUnavailable = mock(async () => undefined);
  const host: ReviewFanoutHost = {
    workflowId: "workflow-1",
    environmentId: "env-1",
    targetBranch: "main",
    label: "test review",
    sessionKeyFor: () => "review-session-key",
    sessionLabelFor: () => "Reviewer",
    provider: async () => provider,
    providerUnavailable,
    executionPolicy: async () => {
      throw new Error("not dispatched here");
    },
    async save() {},
    async assertFence() {},
    async resolveUnattendedInteractions() {},
    async abandonSession() {},
    progress: new MultiReviewProgressTracker(),
  };
  return {
    reviewer,
    runner: new ReviewFanoutRunner(host),
    bridge,
    usageLimitStop,
    providerUnavailable,
  };
}

// A Multi Review's and a build pipeline's reviewers both run on this runner, as
// a graph run's agent nodes do through their own host.
describe("a reviewer the weekly limit stopped", () => {
  test("continues in the same session under a new request, on a reconnected bridge", async () => {
    const { reviewer, runner, usageLimitStop, providerUnavailable } = harness("resend");
    await runner.advanceReviewers([reviewer]);
    expect(usageLimitStop).toHaveBeenCalledWith({
      environmentId: "env-1",
      requestId: "review-request",
      error: expect.stringContaining(LIMIT),
      resends: 0,
    });
    expect(reviewer).toMatchObject({
      status: "running",
      providerSessionId: "review-session",
      dispatchState: "prepared",
      usageLimitResends: 1,
    });
    expect(reviewer.requestId).not.toBe("review-request");
    expect(reviewer.error).toBeUndefined();
    expect(reviewer.continuationPrompt).toContain("weekly usage limit ran out");
    expect(reviewer.continuationPrompt).toContain("Do not start over");
    expect(providerUnavailable).toHaveBeenCalledTimes(1);
  });

  test("hands the count on, so the budget can end a chain of refusals", async () => {
    const { reviewer, runner, usageLimitStop } = harness("stop", { usageLimitResends: 3 });
    await runner.advanceReviewers([reviewer]);
    expect(usageLimitStop).toHaveBeenCalledWith(expect.objectContaining({ resends: 3 }));
    expect(reviewer.status).toBe("failed");
    expect(reviewer.error).toContain(LIMIT);
  });

  test("waits without failing or sending while the verdict is pending", async () => {
    const { reviewer, runner, providerUnavailable } = harness("wait");
    await runner.advanceReviewers([reviewer]);
    expect(reviewer).toMatchObject({
      status: "running",
      requestId: "review-request",
      dispatchState: "sent",
    });
    expect(reviewer.usageLimitResends).toBeUndefined();
    expect(providerUnavailable).not.toHaveBeenCalled();
  });

  test("fails as before when the verdict is to stay stopped", async () => {
    const { reviewer, runner } = harness("stop");
    await runner.advanceReviewers([reviewer]);
    expect(reviewer.status).toBe("failed");
    expect(reviewer.error).toContain(LIMIT);
    expect(reviewer.usageLimitResends).toBeUndefined();
  });

  test("keeps a result it already submitted rather than running the work again", async () => {
    const { reviewer, runner, bridge } = harness("resend");
    bridge.structured = {
      ok: true,
      provider: "codex",
      requestId: "review-request",
      value: reportFor("Survived the limit"),
    };
    await runner.advanceReviewers([reviewer]);
    expect(reviewer.status).toBe("completed");
    expect(reviewer.usageLimitResends).toBeUndefined();
    expect(reviewer.requestId).toBe("review-request");
  });

  test("a host that names no environment fails as before", async () => {
    const { reviewer, usageLimitStop } = harness("resend");
    const provider = {
      usageLimitStop,
      async status() {
        throw new ProviderSessionFailedError("codex", LIMIT);
      },
      async messages() {
        return [];
      },
      async structured() {
        return null;
      },
    } as unknown as BuildPipelineProvider;
    const runner = new ReviewFanoutRunner({
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
    });
    await runner.advanceReviewers([reviewer]);
    expect(usageLimitStop).not.toHaveBeenCalled();
    expect(reviewer.status).toBe("failed");
  });
});
