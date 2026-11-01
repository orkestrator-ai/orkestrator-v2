import { describe, expect, test } from "bun:test";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import { ProviderDispatchPreparationError } from "./build-pipeline-provider.js";
import { ReviewFanoutRunner, type ReviewFanoutHost } from "./review-fanout.js";

const policy = resolveNativeAgentExecutionPolicy(
  { environmentType: "local", networkAccessMode: "full" },
  "automated-review",
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
  const abandoned: string[] = [];
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
    async abandonSession(_reviewer, sessionId) {
      abandoned.push(sessionId);
    },
    progress: new MultiReviewProgressTracker(),
  };
  return {
    host,
    provider,
    reviewer,
    sends,
    attached,
    saves,
    abandoned,
    policyReads: () => policyReads,
    rejectPolicy(value: boolean) {
      rejectPolicy = value;
    },
  };
}

describe("review fan-out dispatch preparation", () => {
  test("reverts the dispatch transition when its owning save throws and retries once", async () => {
    const h = harness("build");
    const save = h.host.save;
    const failure = new Error("owning save lost its fence after applying the transition");
    failure.name = "TestFenceError";
    let fail = true;
    h.host.save = async () => {
      expect(h.reviewer.dispatchState).not.toBe("prepared");
      if (fail) {
        expect(h.reviewer.dispatchState).toBe("dispatching");
        throw failure;
      }
      await save();
    };
    const runner = new ReviewFanoutRunner(h.host);
    await expect(runner.advanceReviewers([h.reviewer])).rejects.toBe(failure);
    expect(h.reviewer).toMatchObject({ status: "running", dispatchState: "prepared" });
    expect(h.saves).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
    expect(h.abandoned).toHaveLength(0);

    fail = false;
    await runner.advanceReviewers([h.reviewer]);
    await runner.advanceReviewers([h.reviewer]);
    expect(h.reviewer.dispatchState).toBe("sent");
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.options.requestId).toBe("review-request");
    expect(h.saves.slice(0, 2).map((saved) => saved.dispatchState)).toEqual([
      "dispatching",
      "sent",
    ]);
  });

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
    expect(testHarness.saves).toHaveLength(1);
    expect(testHarness.reviewer.error).toContain("policy is temporarily unavailable");

    testHarness.rejectPolicy(false);
    await expect(runner.advanceReviewers([testHarness.reviewer])).resolves.toEqual({
      kind: "working",
    });
    expect(testHarness.sends).toHaveLength(1);
    expect(testHarness.sends[0]?.options.reviewShellPolicy).toEqual(policy);
    expect(testHarness.reviewer.dispatchState).toBe("sent");
    expect(testHarness.saves.slice(1, 3).map((saved) => saved.dispatchState)).toEqual([
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
  test.each(["unknown", "throws", "unsupported"] as const)(
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
      expect(h.reviewer.startFailed).toBe(true);
      expect(h.reviewer.error).toContain("acceptance could not be confirmed");
      expect(h.reviewer.resultReminderSent).toBeUndefined();
      expect(h.sends).toHaveLength(0);
    },
  );

  test("a lost request fails at once without spending another turn", async () => {
    const h = harness("build");
    h.reviewer.dispatchState = "dispatching";
    h.provider.dispatchStatus = async () => "lost";
    h.provider.structured = async () => null;
    await new ReviewFanoutRunner(h.host).advanceReviewers([h.reviewer]);
    expect(h.reviewer).toMatchObject({
      status: "failed",
      requestId: "review-request",
      dispatchState: "dispatching",
    });
    expect(h.reviewer.startFailed).toBe(true);
    expect(h.reviewer.error).toContain("lost in a provider restart");
    expect(h.abandoned).toEqual(["review-session"]);
    expect(h.sends).toHaveLength(0);
  });

  test("an absent request is re-sent once under the same id on the next pass", async () => {
    const h = harness("build");
    h.reviewer.dispatchState = "dispatching";
    h.reviewer.continuationPrompt = "Continue the review";
    let reads = 0;
    h.provider.dispatchStatus = async () => {
      reads += 1;
      return "absent";
    };
    h.provider.structured = async () => null;
    const runner = new ReviewFanoutRunner(h.host);
    // Proof of non-delivery: back to `prepared`, nothing sent yet, so the next
    // pass re-runs admission before it sends.
    await runner.advanceReviewers([h.reviewer]);
    expect(h.reviewer).toMatchObject({
      status: "running",
      requestId: "review-request",
      dispatchState: "prepared",
      continuationPrompt: "Continue the review",
    });
    expect(h.sends).toHaveLength(0);
    await runner.advanceReviewers([h.reviewer]);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.options.requestId).toBe("review-request");
    expect(h.reviewer).toMatchObject({ dispatchState: "sent" });
    expect(reads).toBe(1);
  });

  test("a result for the exact request outranks an absent answer", async () => {
    const h = harness("build");
    h.reviewer.dispatchState = "dispatching";
    h.provider.dispatchStatus = async () => "absent";
    h.provider.structured = async <T>() =>
      ({
        ok: true,
        provider: "opencode",
        requestId: "review-request",
        value: {},
      }) as StructuredOutputResult<T>;
    h.provider.status = async () => "running";
    await new ReviewFanoutRunner(h.host).advanceReviewers([h.reviewer]);
    expect(h.reviewer).toMatchObject({ status: "running", dispatchState: "sent" });
    expect(h.sends).toHaveLength(0);
  });

  test.each(["unknown", "lost"] as const)(
    "a structured result for the exact request proves a %s dispatch ran",
    async (acceptance) => {
      const h = harness("build");
      h.reviewer.dispatchState = "dispatching";
      h.provider.dispatchStatus = async () => acceptance;
      let resultRequest = "an-earlier-request";
      h.provider.structured = async <T>() =>
        ({
          ok: true,
          provider: "opencode",
          requestId: resultRequest,
          value: {},
        }) as StructuredOutputResult<T>;
      h.provider.status = async () => "running";
      const runner = new ReviewFanoutRunner(h.host);
      // Another request's result proves nothing about this one.
      await runner.advanceReviewers([h.reviewer]);
      expect(h.reviewer.status).toBe(acceptance === "lost" ? "failed" : "running");
      if (acceptance === "lost") return;
      expect(h.reviewer.dispatchState).toBe("dispatching");

      resultRequest = "review-request";
      await runner.advanceReviewers([h.reviewer]);
      expect(h.reviewer).toMatchObject({ status: "running", dispatchState: "sent" });
      expect(h.sends).toHaveLength(0);
    },
  );

  test.each(["lost", "unknown"] as const)(
    "a matching structured result on the first poll promotes a %s dispatch",
    async (acceptance) => {
      const h = harness("build");
      h.reviewer.dispatchState = "dispatching";
      h.provider.dispatchStatus = async () => acceptance;
      h.provider.structured = async <T>() =>
        ({
          ok: true,
          provider: "opencode",
          requestId: "review-request",
          value: {},
        }) as StructuredOutputResult<T>;
      const runner = new ReviewFanoutRunner(h.host);
      await runner.advanceReviewers([h.reviewer]);
      expect(h.reviewer).toMatchObject({
        status: "running",
        requestId: "review-request",
        dispatchState: "sent",
      });
      expect(h.abandoned).toHaveLength(0);
      expect(h.sends).toHaveLength(0);
      expect(h.saves.some((saved) => saved.dispatchState === "sent")).toBe(true);

      await runner.advanceReviewers([h.reviewer]);
      expect(h.reviewer).toMatchObject({ status: "running", dispatchState: "sent" });
      expect(h.abandoned).toHaveLength(0);
      expect(h.sends).toHaveLength(0);
    },
  );

  test("a submitted tool result proves a dispatch the provider retired", async () => {
    const h = harness("build");
    h.reviewer.dispatchState = "dispatching";
    h.reviewer.resultTransport = "tool-v1";
    h.provider.dispatchStatus = async () => "lost";
    const read: string[] = [];
    h.host.readResult = async <T>(requestId: string) => {
      read.push(requestId);
      return { ok: true, requestId, value: {} } as T;
    };
    h.provider.status = async () => "running";
    await new ReviewFanoutRunner(h.host).advanceReviewers([h.reviewer]);
    expect(read[0]).toBe("review-request");
    expect(h.reviewer).toMatchObject({ status: "running", dispatchState: "sent" });
    expect(h.sends).toHaveLength(0);
  });

  test.each(["dispatched", "pending"] as const)(
    "%s promotes the same request and clears the uncertainty poll budget",
    async (acceptance) => {
      const h = harness("build");
      h.reviewer.dispatchState = "dispatching";
      h.reviewer.continuationPrompt = "Continue";
      h.reviewer.idleResultPolls = 10;
      h.provider.dispatchStatus = async () => acceptance;
      await new ReviewFanoutRunner(h.host).advanceReviewers([h.reviewer]);
      expect(h.reviewer).toMatchObject({
        requestId: "review-request",
        dispatchState: "sent",
        status: "running",
      });
      expect(h.reviewer.continuationPrompt).toBeUndefined();
      expect(h.reviewer.idleResultPolls).toBeUndefined();
      expect(h.sends).toHaveLength(0);
    },
  );
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

test("legacy sent records retain proof of startup when their session fails", async () => {
  const h = harness("build");
  h.reviewer.dispatchState = "sent";
  delete h.reviewer.agentStarted;
  h.provider.status = async () => "error";
  await new ReviewFanoutRunner(h.host).advanceReviewers([h.reviewer]);
  expect(h.reviewer.status).toBe("failed");
  expect(h.reviewer).toMatchObject({ agentStarted: true });
  expect(h.reviewer.startFailed).toBeUndefined();
});
