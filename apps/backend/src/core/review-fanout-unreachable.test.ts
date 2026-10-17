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
import { reportFor } from "./build-pipeline-review-fanout-test-support.js";
import { ElapsedPollGate } from "./workflow-poll-gate.js";

/** A running reviewer whose bridge can be taken down and brought back. */
function harness(options: { interactionsUnreachable?: boolean; interactionFailure?: Error } = {}) {
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
  const bridge = {
    down: true as boolean,
    failure: undefined as Error | undefined,
    resolutionFailure: undefined as Error | undefined,
    status: "running" as "running" | "idle",
    result: false,
  };
  const created: BuildPipelineProvider[] = [];
  const unavailable: BuildPipelineProvider[] = [];
  const abandoned: string[] = [];
  const sent: string[] = [];
  const makeProvider = () => {
    const provider = {
      async status() {
        if (bridge.failure) throw bridge.failure;
        if (bridge.down) throw new ProviderUnreachableError("claude bridge is not reachable");
        return bridge.status;
      },
      async messages() {
        return [];
      },
      async structured() {
        return bridge.result
          ? {
              ok: true,
              provider: reviewer.agent,
              requestId: reviewer.requestId,
              value: reportFor("Recovered"),
            }
          : null;
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
    provider: async () => {
      if (bridge.resolutionFailure) throw bridge.resolutionFailure;
      return current;
    },
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
      if (options.interactionFailure) throw options.interactionFailure;
      if (options.interactionsUnreachable && bridge.down) {
        throw new ProviderUnreachableError("claude bridge is unavailable");
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
      "The reviewer's claude provider stayed unreachable: claude bridge is not reachable",
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

test("malformed interaction payloads fail promptly without reconnecting", async () => {
  const { reviewer, runner, unavailable, abandoned } = harness({
    interactionFailure: new ProviderUnavailableError("Malformed approval payload"),
  });
  await runner.advanceReviewers([reviewer]);
  expect(reviewer.status).toBe("failed");
  expect(reviewer.error).toBe("Malformed approval payload");
  expect(unavailable).toEqual([]);
  expect(abandoned).toEqual(["review-session"]);
});

test("reconnection startup backoff preserves the live turn until recovery", async () => {
  const { reviewer, runner, bridge, time, abandoned, sent } = harness();
  await runner.advanceReviewers([reviewer]);
  bridge.resolutionFailure = Object.assign(new Error("Bridge startup is pending"), {
    retryable: true,
  });
  time.jump(1_000);
  await runner.advanceReviewers([reviewer]);
  expect(reviewer).toMatchObject({ status: "running", dispatchState: "sent", idleResultPolls: 2 });
  expect(abandoned).toEqual([]);
  bridge.resolutionFailure = undefined;
  bridge.down = false;
  time.jump(1_000);
  await runner.advanceReviewers([reviewer]);
  expect(reviewer.idleResultPolls).toBeUndefined();
  expect(reviewer.providerSessionId).toBe("review-session");
  expect(reviewer.requestId).toBe("review-request");
  expect(sent).toEqual([]);
});

test.each(["sent", "dispatching"] as const)(
  "reconnection startup failures exhaust the bound for %s without resending",
  async (dispatchState) => {
    const { reviewer, runner, bridge, time, abandoned, sent } = harness();
    reviewer.dispatchState = dispatchState;
    bridge.resolutionFailure = Object.assign(new Error("Bridge startup is pending"), {
      retryable: true,
    });
    for (let poll = 0; poll < REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS; poll += 1) {
      await runner.advanceReviewers([reviewer]);
      time.jump(1_000);
    }
    expect(reviewer.status).toBe("failed");
    expect(reviewer.error).toContain("claude provider stayed unreachable");
    expect(abandoned).toEqual(["review-session"]);
    expect(sent).toEqual([]);
  },
);

test("permanent reconnect configuration failures are terminal", async () => {
  const { reviewer, runner, bridge, unavailable } = harness();
  bridge.resolutionFailure = new Error("Bridge authentication is unavailable");
  await runner.advanceReviewers([reviewer]);
  expect(reviewer.status).toBe("failed");
  expect(reviewer.error).toBe("Bridge authentication is unavailable");
  expect(unavailable).toEqual([]);
});

test("OpenCode outage failures use provider-neutral wording", async () => {
  const { reviewer, runner, bridge, time } = harness();
  reviewer.agent = "opencode";
  bridge.failure = new ProviderUnreachableError("Connection refused");
  for (let poll = 0; poll < REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS; poll += 1) {
    await runner.advanceReviewers([reviewer]);
    time.jump(1_000);
  }
  expect(reviewer.error).toBe(
    "The reviewer's opencode provider stayed unreachable: Connection refused",
  );
});

test("accepts a report from a turn that finished during an outage", async () => {
  const { reviewer, runner, bridge, time, abandoned, sent } = harness();
  await runner.advanceReviewers([reviewer]);
  expect(reviewer.idleResultPolls).toBe(1);
  bridge.down = false;
  bridge.status = "idle";
  bridge.result = true;
  time.jump(1_000);
  await runner.advanceReviewers([reviewer]);
  expect(reviewer.status).toBe("completed");
  expect(reviewer.report?.reviewSummary).toBe("Recovered");
  expect(reviewer.idleResultPolls).toBeUndefined();
  expect(abandoned).toEqual([]);
  expect(sent).toEqual([]);
});

test("a turn finished without a report during an outage gets one bounded reminder", async () => {
  const { reviewer, runner, bridge, time, abandoned, sent } = harness();
  reviewer.resultTransport = "tool-v1";
  await runner.advanceReviewers([reviewer]);
  bridge.down = false;
  bridge.status = "idle";
  for (let poll = 1; poll < REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS; poll += 1) {
    time.jump(1_000);
    await runner.advanceReviewers([reviewer]);
  }
  expect(reviewer).toMatchObject({
    status: "running",
    resultReminderSent: true,
    dispatchState: "prepared",
  });
  expect(reviewer.requestId).not.toBe("review-request");
  expect(reviewer.providerSessionId).toBe("review-session");
  expect(reviewer.continuationPrompt).toBeDefined();
  expect(reviewer.idleResultPolls).toBeUndefined();
  expect(abandoned).toEqual([]);
  expect(sent).toEqual([]);
});
