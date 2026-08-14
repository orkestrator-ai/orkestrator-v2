import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
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
  sessions = 0;
  statusValue: ProviderStatus = "idle";
  statusCalls = 0;
  abortError: Error | null = null;
  ambiguousFixOnce = false;
  fixSends = 0;
  private statusGate: Promise<void> | null = null;
  private releaseStatusGate: (() => void) | null = null;
  constructor(private readonly returnStructured = true) {}
  async createSession(_phase: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts", _label: string, _options?: ProviderCreateSessionOptions) {
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
  async status(): Promise<ProviderStatus> {
    this.statusCalls += 1;
    if (this.statusGate) await this.statusGate;
    return this.statusValue;
  }
  async messages(): Promise<unknown[]> { return []; }
  async structured<T>(_sessionId: string, requestId: string): Promise<StructuredOutputResult<T> | null> {
    if (!this.returnStructured) return null;
    const sent = this.sends.get(requestId)!;
    const value = sent.prompt.includes("<multi-review-reports-json>")
      ? consolidatedReport
      : sent.prompt.includes("<structured-review-findings-json>")
        ? { complete: true, summary: "Addressed every finding", filesChanged: ["src/a.ts", "src/a.test.ts"],
            commandsRun: [], notes: [], limitations: [] }
        : cleanReport;
    return { ok: true, provider: "claude", requestId, value: value as T };
  }
  async abort(): Promise<void> {
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
