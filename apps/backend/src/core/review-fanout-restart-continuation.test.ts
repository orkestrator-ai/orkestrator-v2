import { describe, expect, test } from "bun:test";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import { ProviderSessionFailedError } from "./agent-provider-contract.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import { ReviewFanoutRunner, type ReviewFanoutHost } from "./review-fanout.js";
import { reportFor } from "./build-pipeline-review-fanout-test-support.js";

const RESTARTED =
  "Codex restarted before this turn finished, so its work stopped partway. Send a message to continue.";

/** A sent Codex reviewer whose bridge reports the turn's fate on demand. */
function harness(transport: ReviewerRecord["resultTransport"] = "structured-output-v1") {
  const reviewer: ReviewerRecord = {
    id: "reviewer-1",
    agent: "codex",
    model: "default",
    status: "running",
    sessionKey: "review-session-key",
    providerSessionId: "review-session",
    requestId: "review-request",
    dispatchState: "sent",
    resultTransport: transport,
    ...(transport === "tool-v1" ? { resultSubmission: "preparing" as const } : {}),
  };
  const bridge = {
    turn: "restarted" as "restarted" | "failed" | "running" | "idle",
    /** The request a restart notice names; unset as on a bridge that predates it. */
    interrupted: undefined as string | undefined,
    /** Request ids the bridge's dispatch journal holds. */
    accepted: new Set<string>(["review-request"]),
    /** What the provider's structured-output slot holds for any request. */
    structured: null as unknown,
    /** Accepted tool-transport results, by request id. */
    toolResults: new Map<string, unknown>(),
  };
  const sent: Array<{ prompt: string; requestId?: string }> = [];
  const closed: string[] = [];
  const abandoned: string[] = [];
  const provider = {
    async status() {
      if (bridge.turn === "restarted") {
        throw new ProviderSessionFailedError("codex", RESTARTED, {
          interruption: "restart",
          interruptedRequestId: bridge.interrupted,
        });
      }
      if (bridge.turn === "failed") {
        throw new ProviderSessionFailedError("codex", "usage limit reached");
      }
      return bridge.turn;
    },
    async messages() {
      return [];
    },
    async structured() {
      return bridge.structured;
    },
    async abort() {},
    async send(_sessionId: string, prompt: string, options: { requestId?: string }) {
      sent.push({ prompt, requestId: options.requestId });
      if (options.requestId) bridge.accepted.add(options.requestId);
    },
    async dispatchStatus(_sessionId: string, requestId: string) {
      return bridge.accepted.has(requestId) ? "pending" : "unknown";
    },
  } as unknown as BuildPipelineProvider;
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
    async abandonSession(_selection, providerSessionId) {
      abandoned.push(providerSessionId);
    },
    progress: new MultiReviewProgressTracker(),
    ...(transport === "tool-v1"
      ? {
          async prepareResult() {},
          async projectResult() {
            return "preparing" as const;
          },
          async readResult<T>(requestId: string) {
            return (bridge.toolResults.get(requestId) ?? null) as T | null;
          },
          async closeResult(requestId: string) {
            closed.push(requestId);
          },
        }
      : {}),
  };
  return { reviewer, runner: new ReviewFanoutRunner(host), bridge, sent, closed, abandoned };
}

const accepted = (requestId: string) => ({
  ok: true,
  provider: "codex",
  requestId,
  value: reportFor("Survived the restart"),
});

describe("a reviewer whose turn a provider restart cut short", () => {
  test("continues the review once in the same session instead of failing", async () => {
    const { reviewer, runner, bridge, sent, abandoned } = harness();
    // The interrupted structured-output turn records a provider failure, not a report.
    bridge.structured = {
      ok: false,
      provider: "codex",
      requestId: "review-request",
      error: { code: "provider_error", message: RESTARTED, retryable: true },
    };

    await runner.advanceReviewers([reviewer]);
    expect(reviewer).toMatchObject({
      status: "running",
      providerSessionId: "review-session",
      dispatchState: "prepared",
      restartContinuationSent: true,
    });
    expect(reviewer.requestId).not.toBe("review-request");
    expect(reviewer.error).toBeUndefined();
    expect(reviewer.continuationPrompt).toContain("stopped partway");
    expect(reviewer.continuationPrompt).toContain("Do not start over");
    expect(abandoned).toEqual([]);

    // The next pass sends it in the same session, under the new request id.
    const continuationRequestId = reviewer.requestId;
    bridge.turn = "running";
    await runner.advanceReviewers([reviewer]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ requestId: continuationRequestId });
    expect(sent[0]!.prompt).toContain("Continue the review from where it stopped");
    expect(reviewer).toMatchObject({ dispatchState: "sent", status: "running" });
    expect(reviewer.continuationPrompt).toBeUndefined();

    bridge.turn = "idle";
    bridge.structured = accepted(continuationRequestId!);
    await runner.advanceReviewers([reviewer]);
    expect(reviewer.status).toBe("completed");
    expect(reviewer.report?.reviewSummary).toBe("Survived the restart");
  });

  // 0112: status is per session, so until the continuation's turn starts the
  // bridge still reports the restart that cut the original turn short.
  test("waits out the notice about the turn its continuation replaced", async () => {
    const { reviewer, runner, bridge, sent } = harness();
    bridge.interrupted = "review-request";
    bridge.structured = {
      ok: false,
      provider: "codex",
      requestId: "review-request",
      error: { code: "provider_error", message: RESTARTED, retryable: true },
    };
    await runner.advanceReviewers([reviewer]);
    const continuationRequestId = reviewer.requestId!;
    expect(reviewer.restartContinuationSent).toBe(true);
    await runner.advanceReviewers([reviewer]);
    expect(sent).toHaveLength(1);
    expect(reviewer.dispatchState).toBe("sent");

    // Sent, not started: the notice still names the original request.
    bridge.structured = null;
    for (let pass = 0; pass < 3; pass += 1) await runner.advanceReviewers([reviewer]);
    expect(reviewer).toMatchObject({ status: "running", requestId: continuationRequestId });
    expect(reviewer.error).toBeUndefined();

    bridge.turn = "idle";
    bridge.structured = accepted(continuationRequestId);
    await runner.advanceReviewers([reviewer]);
    expect(reviewer.status).toBe("completed");
    expect(sent).toHaveLength(1);
  });

  test("fails closed on a stale name once the bridge no longer holds the continuation", async () => {
    // A Claude bridge killed before it rewrote its turn-in-flight mark
    // restores the original request's name; the restarted bridge has lost the
    // continuation it was running.
    const { reviewer, runner, bridge, sent } = harness();
    reviewer.restartContinuationSent = true;
    bridge.interrupted = "an-earlier-request";
    bridge.accepted.clear();

    await runner.advanceReviewers([reviewer]);
    expect(reviewer.status).toBe("failed");
    expect(reviewer.error).toBe(`The reviewer session failed: ${RESTARTED}`);
    expect(sent).toEqual([]);
  });

  test("fails closed when the notice names the continuation itself", async () => {
    const { reviewer, runner, bridge, sent } = harness();
    reviewer.restartContinuationSent = true;
    bridge.interrupted = "review-request";

    await runner.advanceReviewers([reviewer]);
    expect(reviewer.status).toBe("failed");
    expect(reviewer.error).toBe(`The reviewer session failed: ${RESTARTED}`);
    expect(sent).toEqual([]);
  });

  test("fails closed when a second restart cuts the continuation short", async () => {
    const { reviewer, runner, sent } = harness();
    reviewer.restartContinuationSent = true;

    await runner.advanceReviewers([reviewer]);
    expect(reviewer.status).toBe("failed");
    expect(reviewer.error).toBe(`The reviewer session failed: ${RESTARTED}`);
    expect(reviewer.requestId).toBe("review-request");
    expect(sent).toEqual([]);
  });

  test("accepts a report the reviewer submitted before the restart", async () => {
    const { reviewer, runner, bridge, sent, closed } = harness("tool-v1");
    bridge.toolResults.set("review-request", accepted("review-request"));

    await runner.advanceReviewers([reviewer]);
    expect(reviewer.status).toBe("completed");
    expect(reviewer.restartContinuationSent).toBeUndefined();
    expect(closed).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("retires the tool result slot and names the tool in the continuation", async () => {
    const { reviewer, runner, closed } = harness("tool-v1");

    await runner.advanceReviewers([reviewer]);
    expect(closed).toEqual(["review-request"]);
    expect(reviewer).toMatchObject({
      resultSubmission: "preparing",
      restartContinuationSent: true,
    });
    expect(reviewer.continuationPrompt).toContain("submit_review_report");
    expect(reviewer.continuationPrompt).toContain("The earlier resultKey is closed.");
    // The continuation is its own budget; the result reminder is still unspent.
    expect(reviewer.resultReminderSent).toBeUndefined();
  });

  test("still fails at once on an ordinary turn failure", async () => {
    const { reviewer, runner, bridge, sent } = harness();
    bridge.turn = "failed";

    await runner.advanceReviewers([reviewer]);
    expect(reviewer.status).toBe("failed");
    expect(reviewer.error).toBe("The reviewer session failed: usage limit reached");
    expect(reviewer.restartContinuationSent).toBeUndefined();
    expect(sent).toEqual([]);
  });
});
