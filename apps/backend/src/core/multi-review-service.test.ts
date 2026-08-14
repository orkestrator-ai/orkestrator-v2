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
  constructor(private readonly returnStructured = true) {}
  async createSession(_phase: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts", _label: string, _options?: ProviderCreateSessionOptions) {
    this.sessions += 1;
    return `session-${this.sessions}`;
  }
  async send(_sessionId: string, prompt: string, options: ProviderSendOptions) {
    this.sends.set(options.requestId, { prompt, options });
  }
  async status(): Promise<ProviderStatus> { return "idle"; }
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
  async abort(): Promise<void> {}
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
