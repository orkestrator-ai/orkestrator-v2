import { describe, expect, test } from "bun:test";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import { ProviderDispatchPreparationError } from "./build-pipeline-provider.js";
import { ReviewFanoutRunner, type ReviewFanoutHost } from "./review-fanout.js";

const policy = resolveNativeAgentExecutionPolicy(
  { environmentType: "local", networkAccessMode: "full" },
  "looped-review",
);

function preparedReviewer(): ReviewerRecord {
  return {
    id: "reviewer-1",
    agent: "opencode",
    model: "default",
    status: "running",
    sessionKey: "review-session-key",
    providerSessionId: "review-session",
    requestId: "review-request",
    dispatchState: "prepared",
    resultTransport: "structured-output-v1",
  };
}

function harness(
  reviewerMode: "plan" | "build",
  sendImpl?: (sessionId: string, options: Record<string, unknown>) => Promise<void>,
) {
  const sends: Array<{ sessionId: string; options: Record<string, unknown> }> = [];
  const attached: Array<{ sessionId: string; options?: Record<string, unknown> }> = [];
  const saves: ReviewerRecord[] = [];
  const provider = {
    async createSession() {
      return "unused";
    },
    async prepareDispatch(sessionId: string, options?: Record<string, unknown>) {
      attached.push({ sessionId, options });
    },
    async send(sessionId: string, _prompt: string, options: Record<string, unknown>) {
      sends.push({ sessionId, options });
      await sendImpl?.(sessionId, options);
    },
    async status() {
      return "running" as const;
    },
    async messages() {
      return [];
    },
  } as unknown as BuildPipelineProvider;
  let policyReads = 0;
  let rejectPolicy = false;
  const reviewer = preparedReviewer();
  const host: ReviewFanoutHost = {
    workflowId: "workflow-1",
    targetBranch: "main",
    label: "test review",
    reviewerMode,
    sessionKeyFor: () => "review-session-key",
    sessionLabelFor: () => "Reviewer",
    async provider() {
      return provider;
    },
    async executionPolicy() {
      policyReads += 1;
      if (rejectPolicy) throw new Error("storage unavailable");
      return policy;
    },
    async save() {
      saves.push(structuredClone(reviewer));
    },
    async assertFence() {},
    async reviewerPrompt() {
      return "Inspect the immutable review package";
    },
    async resolveUnattendedInteractions() {},
    async abandonSession() {},
    progress: new MultiReviewProgressTracker(),
  };
  return {
    host,
    provider,
    reviewer,
    sends,
    attached,
    saves,
    policyReads: () => policyReads,
    rejectPolicy(value: boolean) {
      rejectPolicy = value;
    },
  };
}

describe("review fan-out dispatch preparation", () => {
  test("keeps a reviewer prepared when policy resolution fails before send", async () => {
    const testHarness = harness("plan");
    testHarness.rejectPolicy(true);
    const runner = new ReviewFanoutRunner(testHarness.host);

    await expect(runner.advanceReviewers([testHarness.reviewer])).resolves.toEqual({
      kind: "working",
    });
    expect(testHarness.sends).toHaveLength(0);
    expect(testHarness.reviewer).toMatchObject({
      status: "running",
      dispatchState: "prepared",
    });
    expect(testHarness.saves).toHaveLength(0);

    testHarness.rejectPolicy(false);
    await expect(runner.advanceReviewers([testHarness.reviewer])).resolves.toEqual({
      kind: "working",
    });
    expect(testHarness.sends).toHaveLength(1);
    expect(testHarness.sends[0]?.options.reviewShellPolicy).toEqual(policy);
    expect(testHarness.reviewer.dispatchState).toBe("sent");
    expect(testHarness.saves.slice(0, 2).map((saved) => saved.dispatchState)).toEqual([
      "dispatching",
      "sent",
    ]);
  });

  test("resets a pre-prompt setup failure so the same request can dispatch once", async () => {
    let fail = true;
    const testHarness = harness("plan", async () => {
      if (fail) throw new ProviderDispatchPreparationError("mcp add failed");
    });
    testHarness.host.agentMcp = async () => ({
      url: "http://127.0.0.1:43123/mcp",
      token: "broker-token",
      workflowResultCapability: "signed-attempt-capability",
    });
    testHarness.reviewer.resultTransport = "tool-v1";
    const runner = new ReviewFanoutRunner(testHarness.host);

    await expect(runner.advanceReviewers([testHarness.reviewer])).resolves.toEqual({
      kind: "working",
    });
    expect(testHarness.sends).toHaveLength(1);
    expect(testHarness.reviewer).toMatchObject({
      status: "running",
      dispatchState: "prepared",
    });
    expect(testHarness.attached[0]?.options).toMatchObject({
      agentMcp: {
        url: "http://127.0.0.1:43123/mcp",
        token: "broker-token",
        workflowResultCapability: "signed-attempt-capability",
      },
      workflowResultTool: "submit_review_report",
    });

    fail = false;
    await expect(runner.advanceReviewers([testHarness.reviewer])).resolves.toEqual({
      kind: "working",
    });
    expect(testHarness.sends).toHaveLength(2);
    expect(testHarness.reviewer.dispatchState).toBe("sent");
    // The prompt names the attempt, so a bridge gating tools itself (Grok,
    // Pi) can let this reviewer's own result tools through a read-only turn.
    expect(testHarness.sends[1]?.options).toMatchObject({
      workflowResultTool: "submit_review_report",
      workflowResultKey: testHarness.reviewer.requestId,
    });
  });

  test("does not resolve or supply review shell policy in build mode", async () => {
    const testHarness = harness("build");
    testHarness.rejectPolicy(true);

    await expect(
      new ReviewFanoutRunner(testHarness.host).advanceReviewers([testHarness.reviewer]),
    ).resolves.toEqual({ kind: "working" });
    expect(testHarness.policyReads()).toBe(0);
    expect(testHarness.sends).toHaveLength(1);
    expect(testHarness.sends[0]?.options.reviewShellPolicy).toBeUndefined();
    expect(testHarness.sends[0]?.options.readOnly).toBeUndefined();
  });
});

describe("recovered reviewer dispatch", () => {
  test.each(["unknown", "lost", "throws", "unsupported"] as const)(
    "parks %s acceptance without spending another turn",
    async (acceptance) => {
      const h = harness("build");
      h.reviewer.dispatchState = "dispatching";
      h.reviewer.continuationPrompt = "Continue the interrupted review";
      h.reviewer.restartContinuationSent = true;
      h.provider.dispatchStatus =
        acceptance === "unsupported"
          ? undefined
          : async () => {
              if (acceptance === "throws") throw new Error("journal unavailable");
              return acceptance;
            };
      h.provider.status = async () => {
        throw new Error("must not observe the superseded turn");
      };
      const runner = new ReviewFanoutRunner(h.host);
      await runner.advanceReviewers([h.reviewer]);
      expect(h.reviewer).toMatchObject({
        status: "running",
        dispatchState: "dispatching",
        continuationPrompt: "Continue the interrupted review",
      });
      for (let pass = 0; pass < 30 && h.reviewer.status === "running"; pass++)
        await runner.advanceReviewers([h.reviewer]);
      expect(h.reviewer.status).toBe("failed");
      expect(h.reviewer.error).toContain("acceptance could not be confirmed");
      expect(h.reviewer.resultReminderSent).toBeUndefined();
      expect(h.sends).toHaveLength(0);
    },
  );

  test("acceptance promotes the same request and clears the uncertainty poll budget", async () => {
    const h = harness("build");
    h.reviewer.dispatchState = "dispatching";
    h.reviewer.continuationPrompt = "Continue";
    h.reviewer.idleResultPolls = 10;
    h.provider.dispatchStatus = async () => "dispatched";
    await new ReviewFanoutRunner(h.host).advanceReviewers([h.reviewer]);
    expect(h.reviewer).toMatchObject({
      requestId: "review-request",
      dispatchState: "sent",
      status: "running",
    });
    expect(h.reviewer.continuationPrompt).toBeUndefined();
    expect(h.reviewer.idleResultPolls).toBeUndefined();
    expect(h.sends).toHaveLength(0);
  });
});

test("a sent continuation ignores a superseded restart until its own turn settles", async () => {
  const h = harness("build");
  h.reviewer.dispatchState = "sent";
  h.reviewer.restartContinuationSent = true;
  h.provider.observeSession = async () => ({
    status: "error",
    interruption: "restart",
    turnSettled: false,
  });
  h.provider.structured = async () => {
    throw new Error("must not read the old turn result");
  };
  await new ReviewFanoutRunner(h.host).advanceReviewers([h.reviewer]);
  expect(h.reviewer).toMatchObject({
    status: "running",
    requestId: "review-request",
    restartContinuationSent: true,
  });
  expect(h.sends).toHaveLength(0);
});
