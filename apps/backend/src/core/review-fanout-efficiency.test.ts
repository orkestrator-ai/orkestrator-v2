import { describe, expect, test } from "bun:test";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  AmbiguousPromptDispatchError,
  ProviderDispatchPreparationError,
  type BuildPipelineProvider,
  type ProviderSendOptions,
} from "./build-pipeline-provider.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import { RecordingEfficiencyObserver } from "./multi-review-efficiency.js";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import {
  ReviewFanoutRunner,
  ReviewSnapshotChangedError,
  type ReviewFanoutHost,
} from "./review-fanout.js";

const policy = resolveNativeAgentExecutionPolicy(
  { environmentType: "local", networkAccessMode: "full" },
  "looped-review",
);

const report: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: ["src/a.ts"],
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
    userImpact: "Impact",
  },
  riskProfile: { changeTypes: ["feature"], riskAreas: [], overallRisk: "low", reasoning: "Small" },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready" },
  summaryOfChange: "Change",
  reviewSummary: "Clean",
};

class FenceError extends Error {
  constructor() {
    super("fence lost");
    this.name = "TestFenceError";
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeProvider {
  readonly agent: "claude" | "codex";
  statusValue: "running" | "idle" = "running";
  createCalls: number[] = [];
  activeCreates = 0;
  maxActiveCreates = 0;
  createGate: Promise<void> | null = null;
  messagesCalls = 0;
  messagesOptions: Array<{ limit?: number } | undefined> = [];
  messagesError: Error | null = null;
  messagesValue: () => unknown[] = () => [{ text: `tail ${this.messagesCalls}` }];
  sendImpl: (sessionId: string, options: ProviderSendOptions) => Promise<void> = async () => {};
  readonly sends: string[] = [];
  contextUsage: { usedTokens: number; sessionTokens?: number } | undefined = {
    usedTokens: 1,
    sessionTokens: 1,
  };
  usageFromMessages?: (messages: readonly unknown[]) => {
    usedTokens: number;
    sessionTokens?: number;
  };
  usageMessageLimit?: number;
  private sessions = 0;

  constructor(agent: "claude" | "codex" = "claude") {
    this.agent = agent;
  }

  async createSession(_phase: string, label: string) {
    this.createCalls.push(Number(/(\d+)$/.exec(label)?.[1] ?? "0"));
    this.activeCreates += 1;
    this.maxActiveCreates = Math.max(this.maxActiveCreates, this.activeCreates);
    try {
      if (this.createGate) await this.createGate;
    } finally {
      this.activeCreates -= 1;
    }
    this.sessions += 1;
    return `${this.agent}-session-${this.sessions}`;
  }

  async send(sessionId: string, _prompt: string, options: ProviderSendOptions) {
    await this.sendImpl(sessionId, options);
    this.sends.push(sessionId);
  }

  async status() {
    return this.statusValue;
  }

  async observeSession() {
    return {
      status: this.statusValue,
      ...(this.contextUsage ? { contextUsage: this.contextUsage } : {}),
    };
  }

  async messages(_sessionId: string, options?: { limit?: number }) {
    this.messagesCalls += 1;
    this.messagesOptions.push(options);
    if (this.messagesError) throw this.messagesError;
    return this.messagesValue();
  }

  async structured<T>(_sessionId: string, requestId: string): Promise<StructuredOutputResult<T>> {
    return { ok: true, provider: this.agent, requestId, value: report as T };
  }

  async abort() {}
}

function pendingReviewer(index: number, agent: "claude" | "codex" = "claude"): ReviewerRecord {
  return { id: `reviewer-${index + 1}`, agent, model: "model", status: "pending" };
}

function sentReviewer(index: number): ReviewerRecord {
  return {
    id: `reviewer-${index + 1}`,
    agent: "claude",
    model: "model",
    status: "running",
    sessionKey: `key-${index + 1}`,
    providerSessionId: `running-session-${index + 1}`,
    requestId: `request-${index + 1}`,
    dispatchState: "sent",
    resultTransport: "structured-output-v1",
    startedAt: new Date().toISOString(),
  };
}

function harness(
  reviewers: ReviewerRecord[],
  options: {
    providers?: Record<string, FakeProvider>;
    clock?: { now: number };
    concurrency?: ReviewFanoutHost["concurrency"];
  } = {},
) {
  const providers = options.providers ?? { claude: new FakeProvider() };
  const clock = options.clock ?? { now: 1_000_000 };
  const tracker = new MultiReviewProgressTracker(60_000, () => clock.now);
  const saves: ReviewerRecord[][] = [];
  let activeSaves = 0;
  let overlappingSaves = 0;
  let fenceBudget = Number.POSITIVE_INFINITY;
  let beforeAdmission = 0;
  let admissionError: Error | null = null;
  const abandoned: string[] = [];
  const efficiency = new RecordingEfficiencyObserver();
  const host: ReviewFanoutHost = {
    workflowId: "workflow-1",
    targetBranch: "main",
    label: "Test review",
    reviewerMode: "plan",
    sessionKeyFor: (reviewer) => `key-${reviewer.id}`,
    sessionLabelFor: (_reviewer, index) => `Reviewer ${index + 1}`,
    provider: async (selection) => providers[selection.agent]! as unknown as BuildPipelineProvider,
    executionPolicy: async () => policy,
    async save() {
      activeSaves += 1;
      if (activeSaves > 1) overlappingSaves += 1;
      await flush();
      saves.push(structuredClone(reviewers));
      activeSaves -= 1;
    },
    async assertFence() {
      fenceBudget -= 1;
      if (fenceBudget < 0) throw new FenceError();
    },
    async beforeAdmission() {
      beforeAdmission += 1;
      if (admissionError) throw admissionError;
    },
    reviewerPrompt: async (index, count) => `Review the package. Reviewer ${index + 1}/${count}.`,
    resolveUnattendedInteractions: async () => {},
    abandonSession: async (_selection, sessionId) => {
      abandoned.push(sessionId);
    },
    captureReviewerUsage: true,
    progress: tracker,
    concurrency: options.concurrency,
    efficiency,
  };
  return {
    host,
    runner: () => new ReviewFanoutRunner(host),
    providers,
    clock,
    saves,
    efficiency,
    abandoned,
    overlappingSaves: () => overlappingSaves,
    beforeAdmissionCalls: () => beforeAdmission,
    failAdmission(error: Error) {
      admissionError = error;
    },
    loseFenceAfter(checks: number) {
      fenceBudget = checks;
    },
  };
}

describe("lazy reviewer transcript observation", () => {
  test("ten passes inside the probe interval read the transcript once", async () => {
    const reviewers = [sentReviewer(0)];
    const h = harness(reviewers);
    const provider = h.providers.claude!;

    for (let pass = 0; pass < 10; pass++) {
      await h.runner().advanceReviewers(reviewers);
      h.clock.now += 1_000;
    }
    expect(provider.messagesCalls).toBe(1);
    expect(provider.messagesOptions[0]).toEqual({ limit: 1 });
    expect(h.efficiency.count("transcript.probe_throttled")).toBe(9);
    expect(h.efficiency.count("transcript.provider_read_started")).toBe(1);

    h.clock.now += 60_000;
    await h.runner().advanceReviewers(reviewers);
    expect(provider.messagesCalls).toBe(2);
  });

  test("a failed probe is swallowed and retried only after the interval", async () => {
    const reviewers = [sentReviewer(0)];
    const h = harness(reviewers);
    const provider = h.providers.claude!;
    provider.messagesError = new Error("bridge unavailable");

    for (let pass = 0; pass < 5; pass++) {
      await expect(h.runner().advanceReviewers(reviewers)).resolves.toEqual({
        kind: "working",
      });
    }
    expect(provider.messagesCalls).toBe(1);
    expect(reviewers[0]!.status).toBe("running");

    h.clock.now += 60_000;
    await h.runner().advanceReviewers(reviewers);
    expect(provider.messagesCalls).toBe(2);
  });

  test("message-derived usage shares the one due read instead of reading every pass", async () => {
    const reviewers = [sentReviewer(0)];
    const h = harness(reviewers);
    const provider = h.providers.claude!;
    provider.contextUsage = undefined;
    provider.usageMessageLimit = 64;
    provider.usageFromMessages = () => ({ usedTokens: 1, sessionTokens: 4_321 });

    await h.runner().advanceReviewers(reviewers);
    await h.runner().advanceReviewers(reviewers);
    await h.runner().advanceReviewers(reviewers);

    // One read shaped for usage (64 messages) served the progress tail too.
    expect(provider.messagesCalls).toBe(1);
    expect(provider.messagesOptions).toEqual([{ limit: 64 }]);
    expect(reviewers[0]!.tokenCount).toBe(4_321);
    expect(h.efficiency.count("transcript.provider_read_started")).toBe(1);
  });

  test("a replaced session starts a fresh probe clock", async () => {
    const reviewers = [sentReviewer(0)];
    const h = harness(reviewers);
    const provider = h.providers.claude!;
    await h.runner().advanceReviewers(reviewers);
    expect(provider.messagesCalls).toBe(1);

    reviewers[0]!.providerSessionId = "replacement-session";
    delete reviewers[0]!.progressDigest;
    await h.runner().advanceReviewers(reviewers);
    expect(provider.messagesCalls).toBe(2);
  });
});

describe("observation checkpoints", () => {
  test("progress on several reviewers produces one observational write per pass", async () => {
    const reviewers = [sentReviewer(0), sentReviewer(1), sentReviewer(2)];
    const h = harness(reviewers);

    await h.runner().advanceReviewers(reviewers);
    expect(h.saves).toHaveLength(1);
    expect(h.efficiency.count("workflow.save_observation")).toBe(1);
    expect(h.efficiency.count("workflow.observation_staged")).toBeGreaterThanOrEqual(3);
    // The single write carries every reviewer's new baseline.
    expect(h.saves[0]!.every((reviewer) => reviewer.progressDigest !== undefined)).toBe(true);

    // Nothing changed on a throttled pass, so nothing is written.
    h.clock.now += 1_000;
    await h.runner().advanceReviewers(reviewers);
    expect(h.saves).toHaveLength(1);
  });
});

describe("bounded concurrent admission", () => {
  test("session setup overlaps up to the admission cap, in configured order", async () => {
    const reviewers = Array.from({ length: 6 }, (_, index) => pendingReviewer(index));
    const h = harness(reviewers);
    const provider = h.providers.claude!;
    const gate = deferred();
    provider.createGate = gate.promise;

    const pass = h.runner().advanceReviewers(reviewers);
    for (let tick = 0; tick < 10; tick++) await flush();
    expect(provider.activeCreates).toBe(4);
    expect(provider.createCalls).toEqual([1, 2, 3, 4]);
    gate.resolve();
    await pass;

    expect(provider.maxActiveCreates).toBe(4);
    expect(provider.createCalls).toEqual([1, 2, 3, 4, 5, 6]);
    expect(provider.sends).toHaveLength(6);
    expect(reviewers.every((reviewer) => reviewer.dispatchState === "sent")).toBe(true);
    expect(h.overlappingSaves()).toBe(0);
  });

  test("a per-provider cap bounds one provider even when the pool allows more", async () => {
    const reviewers = Array.from({ length: 8 }, (_, index) =>
      pendingReviewer(index, index % 2 === 0 ? "claude" : "codex"),
    );
    const providers = { claude: new FakeProvider("claude"), codex: new FakeProvider("codex") };
    const h = harness(reviewers, {
      providers,
      concurrency: { admission: 8, provider: 2 },
    });
    const gate = deferred();
    providers.claude.createGate = gate.promise;
    providers.codex.createGate = gate.promise;

    const pass = h.runner().advanceReviewers(reviewers);
    for (let tick = 0; tick < 10; tick++) await flush();
    expect(providers.claude.activeCreates).toBe(2);
    expect(providers.codex.activeCreates).toBe(2);
    gate.resolve();
    await pass;
    expect(providers.claude.maxActiveCreates).toBe(2);
    expect(providers.codex.maxActiveCreates).toBe(2);
  });

  test("32 reviewers stay within the default bounds and all dispatch once", async () => {
    const reviewers = Array.from({ length: 32 }, (_, index) => pendingReviewer(index));
    const h = harness(reviewers);
    const provider = h.providers.claude!;

    await h.runner().advanceReviewers(reviewers);
    expect(provider.maxActiveCreates).toBeLessThanOrEqual(4);
    expect(provider.sends).toHaveLength(32);
    expect(new Set(provider.sends).size).toBe(32);
    expect(h.overlappingSaves()).toBe(0);
  });

  test("each reviewer's dispatching state is durable before its own send", async () => {
    const reviewers = Array.from({ length: 5 }, (_, index) => pendingReviewer(index));
    const h = harness(reviewers);
    const provider = h.providers.claude!;
    const violations: string[] = [];
    provider.sendImpl = async (sessionId) => {
      const latest = h.saves.at(-1) ?? [];
      const saved = latest.find((reviewer) => reviewer.providerSessionId === sessionId);
      if (saved?.dispatchState !== "dispatching") violations.push(sessionId);
    };

    await h.runner().advanceReviewers(reviewers);
    expect(violations).toEqual([]);
    expect(h.saves.at(-1)!.every((reviewer) => reviewer.dispatchState === "sent")).toBe(true);
  });

  test("a retryable setup failure leaves only that reviewer prepared", async () => {
    const reviewers = [pendingReviewer(0), pendingReviewer(1), pendingReviewer(2)];
    const h = harness(reviewers);
    const provider = h.providers.claude!;
    provider.sendImpl = async (sessionId) => {
      if (sessionId === "claude-session-1") {
        throw new ProviderDispatchPreparationError("mcp registration failed");
      }
    };

    await expect(h.runner().advanceReviewers(reviewers)).resolves.toEqual({ kind: "working" });
    expect(reviewers[0]).toMatchObject({ status: "running", dispatchState: "prepared" });
    expect(reviewers[1]!.dispatchState).toBe("sent");
    expect(reviewers[2]!.dispatchState).toBe("sent");
    expect(h.efficiency.count("reviewer.task", { outcome: "retryable" })).toBe(1);
  });

  test("an ambiguous dispatch parks one reviewer and never resends it", async () => {
    const reviewers = [pendingReviewer(0), pendingReviewer(1)];
    const h = harness(reviewers);
    const provider = h.providers.claude!;
    provider.sendImpl = async (sessionId) => {
      if (sessionId === "claude-session-1") throw new AmbiguousPromptDispatchError("lost ack");
    };

    await h.runner().advanceReviewers(reviewers);
    expect(reviewers[0]!.dispatchState).toBe("dispatching");
    expect(reviewers[1]!.dispatchState).toBe("sent");
    const requestId = reviewers[0]!.requestId;

    provider.sendImpl = async () => {};
    await h.runner().advanceReviewers(reviewers);
    // Reconciled to sent under the same request id; no second prompt.
    expect(reviewers[0]!.dispatchState).toBe("sent");
    expect(reviewers[0]!.requestId).toBe(requestId);
    expect(provider.sends.filter((session) => session === "claude-session-1")).toHaveLength(0);
  });
});

describe("evidence admission and workflow-fatal faults", () => {
  test("one evidence check admits the whole wave; observation passes skip it", async () => {
    const reviewers = Array.from({ length: 8 }, (_, index) => pendingReviewer(index));
    const h = harness(reviewers);

    await h.runner().advanceReviewers(reviewers);
    expect(h.beforeAdmissionCalls()).toBe(1);

    await h.runner().advanceReviewers(reviewers);
    expect(h.beforeAdmissionCalls()).toBe(1);
  });

  test("an evidence failure dispatches nothing and is rethrown", async () => {
    const reviewers = [pendingReviewer(0), pendingReviewer(1)];
    const h = harness(reviewers);
    h.failAdmission(new ReviewSnapshotChangedError("package changed"));

    await expect(h.runner().advanceReviewers(reviewers)).rejects.toThrow("package changed");
    expect(h.providers.claude!.createCalls).toEqual([]);
    expect(h.providers.claude!.sends).toEqual([]);
  });

  test("a snapshot fault during observation abandons every live reviewer", async () => {
    const reviewers = [sentReviewer(0), sentReviewer(1)];
    const h = harness(reviewers);
    h.host.resolveUnattendedInteractions = async (_provider, sessionId) => {
      if (sessionId === "running-session-1") throw new ReviewSnapshotChangedError("drift");
    };

    await expect(h.runner().advanceReviewers(reviewers)).rejects.toThrow("drift");
    expect(h.abandoned.sort()).toEqual(["running-session-1", "running-session-2"]);
  });

  test("a lost fence stops new admissions and propagates", async () => {
    const reviewers = Array.from({ length: 12 }, (_, index) => pendingReviewer(index));
    const h = harness(reviewers, { concurrency: { admission: 2 } });
    h.loseFenceAfter(3);

    await expect(h.runner().advanceReviewers(reviewers)).rejects.toThrow("fence lost");
    // Only the first wave had started; nothing past it was admitted.
    expect(h.providers.claude!.createCalls.length).toBeLessThanOrEqual(2);
    expect(h.providers.claude!.sends).toEqual([]);
  });
});
