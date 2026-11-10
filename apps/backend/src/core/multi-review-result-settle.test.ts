/**
 * Todo 7557: a consolidated result sometimes waited a whole observation pass
 * (3 s plus jitter) before the review reached `ready`.
 *
 * The model submits its result through a tool call inside its turn, so the
 * acceptance and its `result-accepted` wake always land before the turn can
 * end. The pass that wake starts can find the turn still running, and the
 * turn's end raises no wake of its own: workflow sessions are not native agent
 * sessions, so the activity sweep that raises `provider-transition` never
 * observes them. These tests run the keyed driver with an observation interval
 * far longer than their wait, so only the settle cadence can finish the step.
 */
import { expect, jest, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type {
  BuildPipelineProvider,
  ProviderSendOptions,
  ProviderStatus,
} from "./build-pipeline-provider.js";
import { ProviderUnreachableError } from "./agent-provider-contract.js";
import { testGeneratedReviewPackage } from "./build-pipeline-test-fixtures.js";
import { MultiReviewService, type MultiReviewServiceOptions } from "./multi-review-service.js";
import { parseReviewPackageReference } from "./review-package.js";
import { ManualTime, settleKeyedWork } from "./recurring-test-support.js";
import { StorageService } from "./storage.js";
import { WorkflowResultService } from "./workflow-result-service.js";

jest.setTimeout(30_000);

const HEAD = "1".repeat(40);
const ENVIRONMENT_ID = "env-result-settle";
const SCOPE = { environmentId: ENVIRONMENT_ID, projectId: "project-1" };
/** Far longer than any wait below: a pass on this cadence fails the test. */
const OBSERVATION_MS = 60_000;

const cleanReport: StructuredReviewReport = {
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
  riskProfile: {
    changeTypes: ["feature"],
    riskAreas: [],
    overallRisk: "medium",
    reasoning: "Changed",
  },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready" },
  summaryOfChange: "Change",
  reviewSummary: "Clean",
};

/** A loopback provider whose turns run until the test ends them. */
class Provider {
  readonly agent = "codex" as const;
  private sessionCount = 0;
  /** Sessions whose current turn is still running. */
  readonly running = new Set<string>();
  /** Session of each sent request. */
  readonly sessionOf = new Map<string, string>();
  /** Status reads per session, so a test can tell a pass has read one. */
  readonly statusReads = new Map<string, number>();

  async createSession() {
    this.sessionCount += 1;
    return `session-${this.sessionCount}`;
  }
  registerSession() {}
  async prepareDispatch() {}
  async send(sessionId: string, _prompt: string, options: ProviderSendOptions) {
    this.sessionOf.set(options.requestId, sessionId);
    this.running.add(sessionId);
  }
  async dispatchStatus(_sessionId: string, requestId: string) {
    return this.sessionOf.has(requestId) ? ("dispatched" as const) : ("unknown" as const);
  }
  readonly overrides = new Map<string, ProviderStatus>();
  readonly usagePending = new Set<string>();
  readonly unreachable = new Set<string>();

  async status(sessionId: string): Promise<ProviderStatus> {
    this.statusReads.set(sessionId, (this.statusReads.get(sessionId) ?? 0) + 1);
    if (this.unreachable.has(sessionId))
      throw new ProviderUnreachableError("Bridge temporarily unreachable");
    return this.overrides.get(sessionId) ?? (this.running.has(sessionId) ? "running" : "idle");
  }
  async observeSession(sessionId: string) {
    return {
      status: await this.status(sessionId),
      contextUsage: { usedTokens: 1, sessionTokens: 1 },
      usagePending: this.usagePending.has(sessionId),
    };
  }
  async messages() {
    return [];
  }
  async transcriptSnapshot() {
    return { messages: [], sourceToken: "rev-1", complete: true };
  }
  async structured() {
    return null;
  }
  async abort() {}
  reads(sessionId: string): number {
    return this.statusReads.get(sessionId) ?? 0;
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Multi Review state");
    await Bun.sleep(5);
  }
}

async function setup(reviewerCount = 1) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-result-settle-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: ENVIRONMENT_ID,
    projectId: "project-1",
    name: "review",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/review",
    setupScriptsComplete: true,
  });
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === "verify_review_package") return { valid: true } as T;
    if (command === "generate_review_package") return testGeneratedReviewPackage(args!) as T;
    if (command === "get_environment_uncommitted_paths") {
      return { head: HEAD, paths: [], fingerprint: "a".repeat(64) } as T;
    }
    throw new Error(`unexpected command ${command}`);
  };
  const provider = new Provider();
  const workflowResults = new WorkflowResultService(dataDir);
  const createService = (options: Partial<MultiReviewServiceOptions> = {}) =>
    new MultiReviewService(storage, invoke, {
      autoAdvance: false,
      provider: async () => provider as unknown as BuildPipelineProvider,
      workflowResults,
      resolveAgentToolConnection: () => ({ url: "http://127.0.0.1:1234/mcp", token: "test" }),
      ...options,
    });
  const timestamp = new Date().toISOString();
  const workflow: MultiReviewWorkflow = {
    version: 1,
    controller: "backend",
    id: randomUUID(),
    environmentId: ENVIRONMENT_ID,
    projectId: "project-1",
    targetBranch: "main",
    autoFix: false,
    reviewers: Array.from({ length: reviewerCount }, (_, index) => ({
      id: `reviewer-${index + 1}`,
      agent: "codex",
      model: "default",
      status: "pending",
    })),
    fixModel: { agent: "codex", model: "default" },
    reviewWorktreeSnapshot: {
      status: "clean",
      head: HEAD,
      paths: [],
      fingerprint: "a".repeat(64),
      capturedAt: timestamp,
    },
    reviewPackage: parseReviewPackageReference(
      testGeneratedReviewPackage({
        packageId: "review-package-settle",
        round: 1,
        targetBranch: "main",
      }),
      { id: "review-package-settle", round: 1, targetBranch: "main" },
    ),
    phase: "reviewing",
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 0,
  };
  await storage.createMultiReviewWorkflowIfNoActive(workflow.id, ENVIRONMENT_ID, 1, workflow);
  const snapshot = async () =>
    (await storage.getMultiReviewWorkflow(workflow.id))!.snapshot as MultiReviewWorkflow;
  return {
    provider,
    workflowResults,
    createService,
    workflowId: workflow.id,
    snapshot,
    cleanup: async () => {
      workflowResults.closeStorage();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** The keyed driver, woken by acceptances exactly as `index.ts` wires it. */
function keyedService(env: Awaited<ReturnType<typeof setup>>) {
  const service = env.createService({
    autoAdvance: true,
    keyedScheduling: true,
    pollIntervalMs: 20,
    observationIntervalMs: OBSERVATION_MS,
    discoveryIntervalMs: OBSERVATION_MS,
  });
  const unsubscribe = env.workflowResults.onAccepted((event) =>
    service.wakeEnvironment(event.environmentId, "result-accepted"),
  );
  return { service, unsubscribe };
}

/**
 * Submits `resultKey`'s result while its session is running, waits for the
 * pass the acceptance wakes to read the turn still running, then ends the
 * turn the way a provider does: with no wake at all.
 */
async function acceptThenEndTurnSilently(
  env: Awaited<ReturnType<typeof setup>>,
  resultKey: string,
): Promise<void> {
  const sessionId = env.provider.sessionOf.get(resultKey)!;
  expect(env.provider.running.has(sessionId)).toBe(true);
  const readsBefore = env.provider.reads(sessionId);
  const submitted = await env.workflowResults.submit(SCOPE, resultKey, cleanReport);
  expect(submitted.ok).toBe(true);
  await waitUntil(() => env.provider.reads(sessionId) > readsBefore);
  env.provider.running.delete(sessionId);
}

test("a consolidated result accepted mid-turn reaches ready without waiting for the observation pass", async () => {
  const env = await setup();
  // Reach consolidation by explicit passes; only the step under test is supervised.
  const driver = env.createService();
  try {
    await waitUntil(async () => {
      await driver.advanceNow(env.workflowId);
      return (await env.snapshot()).reviewers[0]?.dispatchState === "sent";
    });
    const reviewerKey = (await env.snapshot()).reviewers[0]!.requestId!;
    await env.workflowResults.submit(SCOPE, reviewerKey, cleanReport);
    env.provider.running.delete(env.provider.sessionOf.get(reviewerKey)!);
    await waitUntil(async () => {
      await driver.advanceNow(env.workflowId);
      const current = await env.snapshot();
      return (
        current.activeRequest?.kind === "consolidate" && current.activeRequest.state === "sent"
      );
    });
  } finally {
    await driver.shutdown();
  }
  const consolidationKey = (await env.snapshot()).activeRequest!.requestId;
  expect((await env.snapshot()).activeRequest?.resultTransport).toBe("tool-v1");
  const consolidationSession = env.provider.sessionOf.get(consolidationKey)!;

  const { service, unsubscribe } = keyedService(env);
  try {
    await service.init();
    // Discovery's first pass observes the running turn and rests for 60 s.
    await waitUntil(() => env.provider.reads(consolidationSession) > 0);
    const startedAt = Date.now();
    await acceptThenEndTurnSilently(env, consolidationKey);
    await waitUntil(async () => (await env.snapshot()).phase === "ready", 3_000);
    // Well inside the ≤ 3 s budget; the old path waited the observation interval.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect((await env.workflowResults.status(SCOPE, consolidationKey))?.lifecycle).toBe("consumed");
  } finally {
    unsubscribe();
    await service.shutdown();
    await env.cleanup();
  }
});

test("a reviewer result accepted mid-turn starts consolidation without waiting for the observation pass", async () => {
  const env = await setup();
  const driver = env.createService();
  try {
    await waitUntil(async () => {
      await driver.advanceNow(env.workflowId);
      return (await env.snapshot()).reviewers[0]?.dispatchState === "sent";
    });
  } finally {
    await driver.shutdown();
  }
  const reviewerKey = (await env.snapshot()).reviewers[0]!.requestId!;
  const reviewerSession = env.provider.sessionOf.get(reviewerKey)!;

  const { service, unsubscribe } = keyedService(env);
  try {
    await service.init();
    await waitUntil(() => env.provider.reads(reviewerSession) > 0);
    await acceptThenEndTurnSilently(env, reviewerKey);
    await waitUntil(async () => (await env.snapshot()).phase === "consolidating", 3_000);
    expect((await env.snapshot()).reviewers[0]?.status).toBe("completed");
  } finally {
    unsubscribe();
    await service.shutdown();
    await env.cleanup();
  }
});

/** Dispatch with explicit passes before giving timer ownership to the keyed driver. */
async function dispatchReviewers(env: Awaited<ReturnType<typeof setup>>) {
  const driver = env.createService();
  try {
    await waitUntil(async () => {
      await driver.advanceNow(env.workflowId);
      return (await env.snapshot()).reviewers.every(
        (reviewer) => reviewer.dispatchState === "sent",
      );
    });
  } finally {
    await driver.shutdown();
  }
}

function controlledService(env: Awaited<ReturnType<typeof setup>>, time: ManualTime) {
  const service = env.createService({
    autoAdvance: true,
    keyedScheduling: true,
    pollIntervalMs: 20,
    observationIntervalMs: 3_000,
    discoveryIntervalMs: OBSERVATION_MS,
    schedulerClock: { now: time.now, timers: time.timerFactory },
  });
  const unsubscribe = env.workflowResults.onAccepted((event) =>
    service.wakeEnvironment(event.environmentId, "result-accepted"),
  );
  return { service, unsubscribe };
}

test("an acceptance wake enters settle cadence then returns to observation cadence", async () => {
  const env = await setup();
  await dispatchReviewers(env);
  const reviewerKey = (await env.snapshot()).reviewers[0]!.requestId!;
  const session = env.provider.sessionOf.get(reviewerKey)!;
  const time = new ManualTime(Date.now());
  const wallClock = spyOn(Date, "now").mockImplementation(time.now);
  const { service, unsubscribe } = controlledService(env, time);
  try {
    await service.init();
    await settleKeyedWork(time, [service]);
    const beforeWake = env.provider.reads(session);
    await env.workflowResults.submit(SCOPE, reviewerKey, cleanReport);
    await settleKeyedWork(time, [service]);
    expect(env.provider.reads(session)).toBeGreaterThan(beforeWake);
    const afterWake = env.provider.reads(session);
    await time.advance(250);
    await settleKeyedWork(time, [service]);
    expect(env.provider.reads(session)).toBeGreaterThan(afterWake);
    // The receipt uses wall time; cross its exact acceptance-window boundary.
    const acceptedAt = Date.parse(
      (await env.workflowResults.status(SCOPE, reviewerKey))!.receipt!.acceptedAt,
    );
    time.jump(acceptedAt + 3_000 - time.now());
    await settleKeyedWork(time, [service]);
    const afterWindow = env.provider.reads(session);
    await time.advance(2_999);
    await settleKeyedWork(time, [service]);
    expect(env.provider.reads(session)).toBe(afterWindow);
    await time.advance(1_001); // 3 s plus at most 1 s of stable spread
    await settleKeyedWork(time, [service]);
    expect(env.provider.reads(session)).toBeGreaterThan(afterWindow);
    expect((await env.snapshot()).reviewers[0]?.status).toBe("running");
  } finally {
    unsubscribe();
    await service.shutdown();
    wallClock.mockRestore();
    await env.cleanup();
  }
});

for (const interruption of ["blocked", "unreachable", "usage-pending"] as const) {
  test(`settle polling preserves another reviewer's ${interruption} grace`, async () => {
    const env = await setup(2);
    await dispatchReviewers(env);
    const reviewers = (await env.snapshot()).reviewers;
    const firstKey = reviewers[0]!.requestId!;
    const secondKey = reviewers[1]!.requestId!;
    const secondSession = env.provider.sessionOf.get(secondKey)!;
    const time = new ManualTime(Date.now());
    const wallClock = spyOn(Date, "now").mockImplementation(time.now);
    const { service, unsubscribe } = controlledService(env, time);
    try {
      await service.init();
      await settleKeyedWork(time, [service]);
      // A submits but keeps running throughout the accelerated observations.
      await env.workflowResults.submit(SCOPE, firstKey, cleanReport);
      if (interruption === "usage-pending") {
        await env.workflowResults.submit(SCOPE, secondKey, cleanReport);
        env.provider.running.delete(secondSession);
        env.provider.usagePending.add(secondSession);
      } else if (interruption === "blocked") {
        env.provider.overrides.set(secondSession, "blocked");
      } else {
        env.provider.unreachable.add(secondSession);
      }
      await settleKeyedWork(time, [service]);
      const reads = env.provider.reads(secondSession);
      for (let pass = 0; pass < 10; pass += 1) {
        await time.advance(250);
        await settleKeyedWork(time, [service]);
      }
      expect(env.provider.reads(secondSession)).toBeGreaterThanOrEqual(reads + 10);
      const second = (await env.snapshot()).reviewers[1]!;
      expect(second.status).toBe("running");
      expect(second.usageFinalizationPolls ?? 0).toBeLessThanOrEqual(1);
      expect(second.idleResultPolls ?? 0).toBeLessThanOrEqual(1);
      // Recovery before the ordinary grace expires still consumes B's result.
      env.provider.overrides.delete(secondSession);
      env.provider.unreachable.delete(secondSession);
      env.provider.usagePending.delete(secondSession);
      env.provider.running.delete(secondSession);
      if (interruption !== "usage-pending") {
        await env.workflowResults.submit(SCOPE, secondKey, cleanReport);
      }
      await time.advance(250);
      await settleKeyedWork(time, [service]);
      expect((await env.snapshot()).reviewers[1]?.status).toBe("completed");
    } finally {
      unsubscribe();
      await service.shutdown();
      wallClock.mockRestore();
      await env.cleanup();
    }
  });
}
