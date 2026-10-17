import { describe, expect, test } from "bun:test";
import {
  REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS,
  type ReviewerRecord,
} from "@orkestrator/protocol/review-fanout";
import { ProviderUnreachableError } from "./agent-provider-contract.js";
import { ProviderUnavailableError, type BuildPipelineProvider } from "./build-pipeline-provider.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import { ManualTime } from "./recurring-test-support.js";
import { ReviewFanoutRunner, type ReviewFanoutHost } from "./review-fanout.js";
import { ElapsedPollGate } from "./workflow-poll-gate.js";

/** A running reviewer whose bridge can be taken down and brought back. */
function harness(options: { interactionsUnreachable?: boolean } = {}) {
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
  const bridge = { down: true as boolean, failure: undefined as Error | undefined };
  const created: BuildPipelineProvider[] = [];
  const unavailable: BuildPipelineProvider[] = [];
  const abandoned: string[] = [];
  const sent: string[] = [];
  const makeProvider = () => {
    const provider = {
      async status() {
        if (bridge.failure) throw bridge.failure;
        if (bridge.down) throw new ProviderUnreachableError("claude bridge is not reachable");
        return "running";
      },
      async messages() {
        return [];
      },
      async structured() {
        return null;
      },
      async abort() {},
      async send(_sessionId: string, prompt: string) {
        sent.push(prompt);
      },
    } as unknown as BuildPipelineProvider;
    created.push(provider);
    return provider;
  };
  let current = makeProvider();
  const time = new ManualTime(0);
  const gate = new ElapsedPollGate(1_000, { now: time.now });
  const host: ReviewFanoutHost = {
    workflowId: "workflow-1",
    targetBranch: "main",
    label: "test review",
    sessionKeyFor: () => "review-session-key",
    sessionLabelFor: () => "Reviewer",
    provider: async () => current,
    async providerUnavailable(_selection, provider) {
      unavailable.push(provider);
      if (provider === current) current = makeProvider();
    },
    executionPolicy: async () => {
      throw new Error("not dispatched here");
    },
    async save() {},
    async assertFence() {},
    async resolveUnattendedInteractions() {
      if (options.interactionsUnreachable && bridge.down) {
        throw new ProviderUnavailableError("claude bridge is unavailable");
      }
    },
    async abandonSession(_selection, providerSessionId) {
      abandoned.push(providerSessionId);
    },
    progress: new MultiReviewProgressTracker(),
    pollGate: {
      count: (scope) => gate.count(scope, "periodic"),
      exhausted: (scope, count, limit) => gate.exhausted(scope, count, limit),
      clear: (scope) => gate.clear(scope),
    },
  };
  return {
    reviewer,
    runner: new ReviewFanoutRunner(host),
    bridge,
    time,
    created,
    unavailable,
    abandoned,
    sent,
  };
}

describe("reviewer whose bridge cannot be reached", () => {
  test("keeps its session and request, and asks the host to reconnect that provider", async () => {
    const { reviewer, runner, bridge, time, created, unavailable, abandoned, sent } = harness();
    expect(await runner.advanceReviewers([reviewer])).toEqual({ kind: "working" });
    expect(reviewer).toMatchObject({
      status: "running",
      providerSessionId: "review-session",
      requestId: "review-request",
      dispatchState: "sent",
      idleResultPolls: 1,
    });
    expect(reviewer.error).toBeUndefined();
    expect(unavailable).toEqual([created[0]!]);

    // The reconnected bridge answers: the turn is observed again and the
    // unreachable polls stop counting against it.
    bridge.down = false;
    time.jump(1_000);
    await runner.advanceReviewers([reviewer]);
    expect(reviewer.status).toBe("running");
    expect(reviewer.idleResultPolls).toBeUndefined();
    expect(created).toHaveLength(2);
    expect(abandoned).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("fails closed once its bridge stays unreachable past the idle bound", async () => {
    const { reviewer, runner, time, abandoned, sent } = harness();
    for (let poll = 0; poll < REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS; poll += 1) {
      await runner.advanceReviewers([reviewer]);
      time.jump(1_000);
    }
    expect(reviewer.status).toBe("failed");
    expect(reviewer.error).toBe(
      "The reviewer's claude bridge stayed unreachable: claude bridge is not reachable",
    );
    expect(abandoned).toEqual(["review-session"]);
    expect(sent).toEqual([]);
  });

  test("treats an unreachable bridge while resolving interactions the same way", async () => {
    const { reviewer, runner, unavailable } = harness({ interactionsUnreachable: true });
    await runner.advanceReviewers([reviewer]);
    expect(reviewer.status).toBe("running");
    expect(reviewer.idleResultPolls).toBe(1);
    expect(unavailable).toHaveLength(1);
  });

  test("still fails at once on an error that is not a transport fault", async () => {
    const { reviewer, runner, bridge, unavailable } = harness();
    bridge.failure = new Error("status read broke");
    await runner.advanceReviewers([reviewer]);
    expect(reviewer.status).toBe("failed");
    expect(reviewer.error).toBe("status read broke");
    expect(unavailable).toEqual([]);
  });
});
