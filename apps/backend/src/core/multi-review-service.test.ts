import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type {
  MultiReviewModelSelection,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type {
  BuildPipelineProvider,
  ProviderCreateSessionOptions,
  ProviderSendOptions,
  ProviderStatus,
} from "./build-pipeline-provider.js";
import { AmbiguousPromptDispatchError } from "./build-pipeline-provider.js";
import { StorageService } from "./storage.js";
import { MultiReviewService } from "./multi-review-service.js";

const cleanReport: StructuredReviewReport = {
  reviewScope: { targetBranch: "main", baseRef: "origin/main...HEAD", commit: null,
    filesReviewed: ["src/a.ts"], filesSkipped: [], filesLeftUncommitted: [], commandsRun: [],
    commandsNotRun: [], limitations: [] },
  whatChanged: { overview: "Change", before: "Before", after: "After", keyCodeChanges: [], userImpact: "Impact" },
  riskProfile: { changeTypes: ["feature"], riskAreas: [], overallRisk: "medium", reasoning: "Changed" },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [], issues: [], testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready" },
  summaryOfChange: "Change", reviewSummary: "Clean",
};

const consolidatedReport: StructuredReviewReport = {
  ...cleanReport,
  issues: [{ severity: "P1", confidence: 92, category: "correctness", title: "Broken branch",
    file: "src/a.ts", line: 10, symbol: "run", description: "Wrong branch", evidence: "Returns false",
    suggestion: "Correct it", verification: "Add a regression test" }],
  testCoverageGaps: [{ file: "src/a.test.ts", untestedBehavior: "Failure branch" }],
  verdict: { ready: "with-fixes", reasoning: "One fix remains" },
  reviewSummary: "One consolidated issue and one coverage gap.",
};

class Provider implements BuildPipelineProvider {
  readonly agent = "claude" as const;
  readonly sends = new Map<string, { prompt: string; options: ProviderSendOptions }>();
  readonly aborted: string[] = [];
  /** Per-session status, overriding `statusValue`; keeps tests pass-count independent. */
  readonly statusOverrides = new Map<string, ProviderStatus>();
  sessions = 0;
  statusValue: ProviderStatus = "idle";
  statusCalls = 0;
  abortError: Error | null = null;
  ambiguousFixOnce = false;
  fixSends = 0;
  fixComplete = true;
  /** Throws from `createSession` once this many sessions already exist. */
  failCreateSessionAfter: number | null = null;
  private statusGate: Promise<void> | null = null;
  private releaseStatusGate: (() => void) | null = null;
  constructor(private readonly returnStructured = true) {}
  async createSession(_phase: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts", _label: string, _options?: ProviderCreateSessionOptions) {
    if (this.failCreateSessionAfter !== null && this.sessions >= this.failCreateSessionAfter) {
      throw new Error("claude bridge authentication is unavailable");
    }
    this.sessions += 1;
    return `session-${this.sessions}`;
  }
  async send(_sessionId: string, prompt: string, options: ProviderSendOptions) {
    this.sends.set(options.requestId, { prompt, options });
    if (prompt.includes("<structured-review-findings-json>")) {
      this.fixSends += 1;
      if (this.ambiguousFixOnce) {
        this.ambiguousFixOnce = false;
        throw new AmbiguousPromptDispatchError("response lost after acceptance");
      }
    }
  }
  async status(sessionId: string): Promise<ProviderStatus> {
    this.statusCalls += 1;
    if (this.statusGate) await this.statusGate;
    return this.statusOverrides.get(sessionId) ?? this.statusValue;
  }
  async messages(): Promise<unknown[]> { return []; }
  async structured<T>(_sessionId: string, requestId: string): Promise<StructuredOutputResult<T> | null> {
    if (!this.returnStructured) return null;
    const sent = this.sends.get(requestId)!;
    const value = sent.prompt.includes("<multi-review-reports-json>")
      ? consolidatedReport
      : sent.prompt.includes("<structured-review-findings-json>")
        ? { complete: this.fixComplete,
            summary: this.fixComplete ? "Addressed every finding" : "Two findings remain unresolved",
            filesChanged: ["src/a.ts", "src/a.test.ts"],
            commandsRun: [], notes: [],
            // An incomplete result is only valid alongside a failed validation
            // or an explicit limitation.
            limitations: this.fixComplete ? [] : ["Two findings need product input"] }
        : cleanReport;
    return { ok: true, provider: "claude", requestId, value: value as T };
  }
  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
    if (this.abortError) throw this.abortError;
  }

  blockStatus(): () => void {
    this.statusGate = new Promise<void>((resolve) => {
      this.releaseStatusGate = resolve;
    });
    return () => {
      this.releaseStatusGate?.();
      this.releaseStatusGate = null;
      this.statusGate = null;
    };
  }
}

async function withService(
  environmentId: string,
  provider: Provider,
  run: (context: {
    service: MultiReviewService;
    storage: StorageService;
    start: (reviewers?: MultiReviewModelSelection[]) => Promise<MultiReviewWorkflow>;
    snapshot: (workflowId: string) => Promise<MultiReviewWorkflow | undefined>;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), `ork-multi-review-${environmentId}-`));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: environmentId, projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: async () => provider,
  });
  try {
    await run({
      service,
      storage,
      start: (reviewers = [{ agent: "claude", model: "opus" }]) => service.start({
        environmentId, projectId: "project-1", targetBranch: "main",
        reviewers, fixModel: { agent: "claude", model: "opus" },
      }),
      snapshot: async (workflowId) =>
        (await storage.getMultiReviewWorkflow(workflowId))?.snapshot as MultiReviewWorkflow | undefined,
    });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Multi Review state");
    await Bun.sleep(10);
  }
}

test("MultiReviewService owns fan-out, consolidation, and the explicit fix turn", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider();
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await service.start({
    environmentId: "env-1", projectId: "project-1", targetBranch: "main",
    reviewers: [
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ],
    fixModel: { agent: "claude", model: "opus" },
  });

  for (let attempt = 0; attempt < 8; attempt++) {
    await service.advanceNow(started.id);
    const current = await storage.getMultiReviewWorkflow(started.id);
    if ((current?.snapshot as { phase?: string })?.phase === "ready") break;
  }
  const ready = await storage.getMultiReviewWorkflow(started.id);
  expect(ready?.snapshot).toMatchObject({
    phase: "ready",
    consolidatedReport: { issues: [{ title: "Broken branch" }], testCoverageGaps: [{ file: "src/a.test.ts" }] },
  });
  expect(provider.sessions).toBe(3);

  await service.address(started.id);
  for (let attempt = 0; attempt < 4; attempt++) await service.advanceNow(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "completed",
    fixResult: { complete: true, summary: "Addressed every finding" },
  });
  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService fails an idle reviewer that never returns structured output", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-idle-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-idle", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider(false);
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await service.start({
    environmentId: "env-idle", projectId: "project-1", targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });

  for (let attempt = 0; attempt < 7; attempt++) await service.advanceNow(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "failed",
    reviewers: [{ status: "failed", error: expect.stringContaining("structured report") }],
  });

  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService reconciles an ambiguously accepted fix without sending it twice", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-ambiguous-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-ambiguous", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider();
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await service.start({
    environmentId: "env-ambiguous", projectId: "project-1", targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await service.advanceNow(started.id);
    const current = await storage.getMultiReviewWorkflow(started.id);
    if ((current?.snapshot as { phase?: string })?.phase === "ready") break;
  }
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot)
    .toMatchObject({ phase: "ready" });

  provider.ambiguousFixOnce = true;
  await service.address(started.id);
  await service.advanceNow(started.id);
  await waitUntil(async () => ((await storage.getMultiReviewWorkflow(started.id))?.snapshot as { phase?: string })?.phase === "completed");

  expect(provider.fixSends).toBe(1);
  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService persists cancellation until an aborting fix provider actually stops", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-cancel-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-cancel", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider();
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await service.start({
    environmentId: "env-cancel", projectId: "project-1", targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  for (let attempt = 0; attempt < 4; attempt += 1) await service.advanceNow(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot)
    .toMatchObject({ phase: "ready" });

  const statusCallsBeforeFix = provider.statusCalls;
  provider.statusValue = "running";
  provider.abortError = new Error("abort unavailable");
  await service.address(started.id);
  await waitUntil(() => provider.statusCalls > statusCallsBeforeFix);

  expect((await service.cancel(started.id)).phase).toBe("cancelling");
  await service.advanceNow(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "cancelling",
    error: expect.stringContaining("abort unavailable"),
  });

  provider.statusValue = "idle";
  await service.advanceNow(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "cancelled",
    reviewers: [{ status: "completed" }],
    fixSession: { status: "cancelled" },
  });
  const replacement = await service.start({
    environmentId: "env-cancel", projectId: "project-1", targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  expect(replacement.id).not.toBe(started.id);
  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService coalesces repeated advances while a provider call is blocked", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-coalesce-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-coalesce", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider();
  provider.statusValue = "running";
  const release = provider.blockStatus();
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: async () => provider,
  });
  await service.start({
    environmentId: "env-coalesce", projectId: "project-1", targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  await waitUntil(() => provider.statusCalls === 1);

  const first = service.advanceNow((await storage.listMultiReviewWorkflows("env-coalesce"))[0]!.id);
  const second = service.advanceNow((await storage.listMultiReviewWorkflows("env-coalesce"))[0]!.id);
  const third = service.advanceNow((await storage.listMultiReviewWorkflows("env-coalesce"))[0]!.id);
  expect(second).toBe(first);
  expect(third).toBe(first);
  release();
  await first;
  expect(provider.statusCalls).toBe(2);

  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService renews its lease while a provider call is blocked", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-lease-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-lease", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider();
  provider.statusValue = "running";
  const release = provider.blockStatus();
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    pollIntervalMs: 50,
    controllerLeaseMs: 2_000,
    controllerRenewMs: 100,
    provider: async () => provider,
  });
  await service.init();
  const started = await service.start({
    environmentId: "env-lease", projectId: "project-1", targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  await waitUntil(() => provider.statusCalls === 1);
  await Bun.sleep(2_200);

  const competing = await storage.claimMultiReviewController(started.id, "competing-owner", 2_000);
  expect(competing.granted).toBe(false);
  let shutdownFinished = false;
  const shutdown = service.shutdown().then(() => {
    shutdownFinished = true;
  });
  await Bun.sleep(20);
  expect(shutdownFinished).toBe(false);
  release();
  await shutdown;
  expect(shutdownFinished).toBe(true);
  await fs.rm(dataDir, { recursive: true, force: true });
}, 8_000);

test("MultiReviewService atomically admits only one active workflow per environment", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-start-race-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-race", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider();
  provider.statusValue = "running";
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const input = {
    environmentId: "env-race", projectId: "project-1", targetBranch: "main",
    reviewers: [{ agent: "claude" as const, model: "opus" }],
    fixModel: { agent: "claude" as const, model: "opus" },
  };
  const outcomes = await Promise.allSettled([service.start(input), service.start(input)]);

  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  expect(await storage.listMultiReviewWorkflows("env-race")).toHaveLength(1);
  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService fails the reviewer that raised the error, not one already running", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  // Reviewer 1 gets its session; reviewer 2 cannot open one.
  provider.failCreateSessionAfter = 1;
  await withService("env-attribution", provider, async ({ service, start, snapshot }) => {
    const started = await start([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    await service.advanceNow(started.id);

    const current = await snapshot(started.id);
    expect(current?.phase).toBe("failed");
    expect(current?.reviewers[0]).toMatchObject({ model: "opus", status: "running" });
    expect(current?.reviewers[0]?.error).toBeUndefined();
    expect(current?.reviewers[1]).toMatchObject({
      model: "sonnet",
      status: "failed",
      error: expect.stringContaining("bridge authentication is unavailable"),
    });
  });
});

test("MultiReviewService fails a reviewer whose provider session errors or disappears", async () => {
  for (const [environmentId, status, message] of [
    ["env-reviewer-error", "error", "The reviewer session failed"],
    ["env-reviewer-missing", "missing", "The reviewer session no longer exists"],
  ] as const) {
    const provider = new Provider();
    provider.statusOverrides.set("session-1", status);
    await withService(environmentId, provider, async ({ service, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);

      const current = await snapshot(started.id);
      expect(current?.phase).toBe("failed");
      expect(current?.error).toBe(message);
      expect(current?.reviewers[0]).toMatchObject({ status: "failed", error: message });
    });
  }
});

test("MultiReviewService bounds a blocked reviewer and clears the count once it progresses", async () => {
  const provider = new Provider();
  provider.statusValue = "blocked";
  await withService("env-blocked", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await service.advanceNow(started.id);

    // A provider with no interaction surface can never be unblocked from here,
    // but a single blocked poll must not fail the reviewer either.
    const blocked = await snapshot(started.id);
    expect(blocked?.phase).toBe("reviewing");
    expect(blocked?.reviewers[0]?.status).toBe("running");
    expect(blocked?.reviewers[0]?.idleResultPolls).toBeGreaterThanOrEqual(1);

    provider.statusValue = "running";
    await service.advanceNow(started.id);
    expect((await snapshot(started.id))?.reviewers[0]?.idleResultPolls).toBeUndefined();

    provider.statusValue = "blocked";
    for (let attempt = 0; attempt < 6; attempt++) await service.advanceNow(started.id);
    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.reviewers[0]).toMatchObject({
      status: "failed",
      error: "The reviewer stayed blocked without a resolvable interaction",
    });
  });
});

test("MultiReviewService bounds a blocked fix model", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-2", "blocked");
  await withService("env-blocked-fix", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    for (let attempt = 0; attempt < 8; attempt++) await service.advanceNow(started.id);

    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.error).toBe("The fix model stayed blocked without a resolvable interaction");
  });
});

test("MultiReviewService retries a failed reviewer without stranding its provider session", async () => {
  const provider = new Provider(false);
  await withService("env-retry-reviewer", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    for (let attempt = 0; attempt < 7; attempt++) await service.advanceNow(started.id);
    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.reviewers[0]).toMatchObject({ status: "failed", providerSessionId: "session-1" });

    const retried = await service.retry(started.id);
    expect(provider.aborted).toEqual(["session-1"]);
    expect(retried.phase).toBe("reviewing");
    expect(retried.error).toBeUndefined();
    expect(retried.reviewers[0]?.status).toBe("pending");
    expect(retried.reviewers[0]?.providerSessionId).toBeUndefined();
    expect(retried.reviewers[0]?.requestId).toBeUndefined();
    expect(retried.reviewers[0]?.idleResultPolls).toBeUndefined();
    expect(retried.reviewers[0]?.error).toBeUndefined();

    // The retry runs against a brand new session rather than the abandoned one.
    await waitUntil(async () => (await snapshot(started.id))?.reviewers[0]?.providerSessionId === "session-2");
  });
});

test("MultiReviewService retries an incomplete fix turn from the consolidated report", async () => {
  const provider = new Provider();
  provider.fixComplete = false;
  await withService("env-retry-fix", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    for (let attempt = 0; attempt < 4; attempt++) {
      await service.advanceNow(started.id);
      if ((await snapshot(started.id))?.phase === "ready") break;
    }
    await service.address(started.id);
    for (let attempt = 0; attempt < 4; attempt++) await service.advanceNow(started.id);

    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.fixSession?.status).toBe("failed");
    expect(failed?.error).toContain("could not address every finding");

    const retried = await service.retry(started.id);
    expect(retried.phase).toBe("ready");
    expect(retried.fixSession?.status).toBe("idle");
    expect(retried.activeRequest).toBeUndefined();
    expect(retried.error).toBeUndefined();
    expect(retried.consolidatedReport).toBeDefined();
    // The consolidated session is reused for the next attempt, never abandoned.
    expect(provider.aborted).toEqual([]);
  });
});

test("MultiReviewService retries a failed consolidation with a fresh fix session", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-2", "error");
  await withService("env-retry-consolidate", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    for (let attempt = 0; attempt < 4; attempt++) await service.advanceNow(started.id);

    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.error).toBe("The consolidation session failed");
    expect(failed?.fixSession).toMatchObject({ providerSessionId: "session-2", status: "failed" });

    provider.statusOverrides.delete("session-2");
    const retried = await service.retry(started.id);
    expect(retried.phase).toBe("consolidating");
    expect(retried.fixSession).toBeUndefined();
    expect(retried.activeRequest).toBeUndefined();
    expect(provider.aborted).toEqual(["session-2"]);

    await waitUntil(async () => (await snapshot(started.id))?.phase === "ready");
    expect((await snapshot(started.id))?.fixSession?.providerSessionId).toBe("session-3");
  });
});

test("MultiReviewService leaves a workflow that is not failed untouched on retry", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService("env-retry-noop", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await service.advanceNow(started.id);

    const retried = await service.retry(started.id);
    expect(retried.phase).toBe("reviewing");
    expect(retried.reviewers[0]?.status).toBe("running");
    expect(retried.reviewers[0]?.providerSessionId).toBe("session-1");
    expect(provider.aborted).toEqual([]);
    expect((await snapshot(started.id))?.reviewers[0]?.providerSessionId).toBe("session-1");
  });
});
