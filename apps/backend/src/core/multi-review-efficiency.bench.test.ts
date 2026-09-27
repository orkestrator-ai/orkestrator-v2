/**
 * Deterministic Multi Review control-plane benchmark.
 *
 * Measures what the fan-out costs around the model work — evidence
 * verifications, provider calls, transcript reads, workflow writes, backup
 * rotations, dispatch skew, consolidation input — with fake providers, a
 * temporary store, synthetic reports and no real source or transcript content.
 *
 * Counting happens only through the fake provider, the command invoker and
 * storage spies. The harness therefore runs unchanged against the code before
 * the efficiency work, which is how `docs/improvements/multi-review/plan/
 * baseline.md` was produced. Reproduce with:
 *
 *   MULTI_REVIEW_BENCH_OUT=/tmp/multi-review-bench.json \
 *     mise run test:logged -- --name multi-review-bench -- \
 *     bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
 *     ./src/core/multi-review-efficiency.bench.test.ts --parallel=1
 *
 * `MULTI_REVIEW_BENCH_OUT` writes the content-free result table as JSON. The
 * default run is CI-sized and asserts the structural gates; set
 * `MULTI_REVIEW_BENCH_REPORT_ONLY=1` to measure an older build without them.
 */
import { describe, expect, jest, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type {
  BuildPipelineProvider,
  ProviderCreateSessionOptions,
  ProviderSendOptions,
} from "./build-pipeline-provider.js";
import { testGeneratedReviewPackage } from "./build-pipeline-test-fixtures.js";
import { syntheticReport } from "./multi-review-efficiency-fixtures.js";
import { parseReviewPackageReference } from "./review-package.js";
import { MultiReviewService } from "./multi-review-service.js";
import { StorageService } from "./storage.js";

jest.setTimeout(120_000);

const REPORT_ONLY = process.env.MULTI_REVIEW_BENCH_REPORT_ONLY === "1";
const OUTPUT_PATH = process.env.MULTI_REVIEW_BENCH_OUT;
const REVIEW_HEAD = "1".repeat(40);

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

interface BenchOptions {
  reviewers: number;
  agents: Array<"claude" | "codex">;
  setupDelayMs: number;
  sendDelayMs: number;
  statusDelayMs: number;
  /** Reviewer index whose session creation is `slowSetupMs` instead. */
  slowReviewer?: number;
  slowSetupMs?: number;
  issuesPerReport: number;
  runningPasses: number;
  packageBytes: number;
}

class BenchProvider implements BuildPipelineProvider {
  creates = 0;
  activeCreates = 0;
  maxActiveCreates = 0;
  sends = 0;
  statusCalls = 0;
  messagesCalls = 0;
  structuredCalls = 0;
  sessions = 0;
  running = true;
  tokens = 1_000;
  readonly sentAt: number[] = [];
  readonly prompts = new Map<string, string>();
  readonly sessionReviewer = new Map<string, number>();

  constructor(
    readonly agent: "claude" | "codex",
    private readonly options: BenchOptions,
    private readonly shared: { activeCreates: number; maxActiveCreates: number },
  ) {}

  async createSession(_phase: string, label: string, _options?: ProviderCreateSessionOptions) {
    this.creates += 1;
    this.shared.activeCreates += 1;
    this.shared.maxActiveCreates = Math.max(
      this.shared.maxActiveCreates,
      this.shared.activeCreates,
    );
    const reviewerIndex = Number(/Reviewer (\d+)/.exec(label)?.[1] ?? "0") - 1;
    try {
      await sleep(
        reviewerIndex === this.options.slowReviewer
          ? (this.options.slowSetupMs ?? this.options.setupDelayMs)
          : this.options.setupDelayMs,
      );
    } finally {
      this.shared.activeCreates -= 1;
    }
    this.sessions += 1;
    const id = `${this.agent}-session-${this.sessions}-${randomUUID()}`;
    this.sessionReviewer.set(id, reviewerIndex);
    return id;
  }

  async prepareDispatch() {}

  async send(_sessionId: string, prompt: string, options: ProviderSendOptions) {
    this.sends += 1;
    await sleep(this.options.sendDelayMs);
    this.sentAt.push(performance.now());
    this.prompts.set(options.requestId, prompt);
  }

  async status(_sessionId?: string) {
    this.statusCalls += 1;
    await sleep(this.options.statusDelayMs);
    return this.running ? ("running" as const) : ("idle" as const);
  }

  async observeSession(sessionId: string) {
    const status = await this.status(sessionId);
    this.tokens += 7;
    return { status, contextUsage: { usedTokens: this.tokens, sessionTokens: this.tokens } };
  }

  async messages(): Promise<unknown[]> {
    this.messagesCalls += 1;
    // The tail changes on every read, as a busy reviewer's transcript does.
    return [{ role: "assistant", content: `progress ${this.messagesCalls}` }];
  }

  async structured<T>(sessionId: string, requestId: string): Promise<StructuredOutputResult<T>> {
    this.structuredCalls += 1;
    const reviewerIndex = this.sessionReviewer.get(sessionId) ?? 0;
    const prompt = this.prompts.get(requestId) ?? "";
    if (prompt.includes("<multi-review-reports-json>")) {
      const sourceIds = Array.from(
        prompt.matchAll(/reviewer-\d+\/issue-\d+/g),
        (match) => match[0],
      ).slice(0, 1);
      const report = syntheticReport(1, 0);
      report.issues = report.issues.map((issue) => ({ ...issue, reviewSourceIds: sourceIds }));
      report.testCoverageGaps = [];
      return { ok: true, provider: this.agent, requestId, value: report as T };
    }
    return {
      ok: true,
      provider: this.agent,
      requestId,
      value: syntheticReport(this.options.issuesPerReport, reviewerIndex) as T,
    };
  }

  async abort() {}
}

interface BenchResult {
  reviewers: number;
  agents: string;
  verifyCalls: number;
  evidenceBytesVerified: number;
  admissionMs: number;
  dispatchSkewMs: number;
  maxConcurrentSetup: number;
  runningPasses: number;
  statusCalls: number;
  transcriptReads: number;
  workflowSaves: number;
  savesPerRunningPass: number;
  backupRotations: number;
  leaseWrites: number;
  leaseWritesWithBackup: number;
  consolidationPromptBytes: number;
  totalMs: number;
}

async function runBenchmark(options: BenchOptions): Promise<BenchResult> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-bench-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  const environmentId = `env-bench-${randomUUID()}`;
  await storage.addEnvironment({
    id: environmentId,
    projectId: "project-1",
    name: "bench",
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

  // Storage spies: logical saves, and physical sensitive writes by backup mode.
  let workflowSaves = 0;
  let backupRotations = 0;
  let leaseWrites = 0;
  let leaseWritesWithBackup = 0;
  let inLeaseWrite = false;
  const originalSave = storage.saveMultiReviewWorkflow.bind(storage);
  storage.saveMultiReviewWorkflow = async (...args) => {
    workflowSaves += 1;
    return originalSave(...args);
  };
  for (const method of ["claimMultiReviewController", "releaseMultiReviewController"] as const) {
    const original = (storage[method] as (...args: unknown[]) => Promise<unknown>).bind(storage);
    (storage as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      inLeaseWrite = true;
      try {
        return await original(...args);
      } finally {
        inLeaseWrite = false;
      }
    };
  }
  const internals = storage as unknown as {
    saveSensitiveJson: (
      file: string,
      value: unknown,
      options?: { backup?: boolean },
    ) => Promise<void>;
  };
  const originalSensitive = internals.saveSensitiveJson.bind(storage);
  internals.saveSensitiveJson = async (file, value, saveOptions) => {
    if (file.endsWith("multi-reviews.json")) {
      if (saveOptions?.backup !== false) backupRotations += 1;
      if (inLeaseWrite) {
        leaseWrites += 1;
        if (saveOptions?.backup !== false) leaseWritesWithBackup += 1;
      }
    }
    return originalSensitive(file, value, saveOptions);
  };

  let verifyCalls = 0;
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === "verify_looped_review_package") {
      verifyCalls += 1;
      return { valid: true } as T;
    }
    if (command === "generate_looped_review_package") {
      return testGeneratedReviewPackage(args!) as T;
    }
    if (command === "get_environment_uncommitted_paths") {
      return { head: REVIEW_HEAD, paths: [], fingerprint: "a".repeat(64) } as T;
    }
    throw new Error(`unexpected command ${command}`);
  };

  const shared = { activeCreates: 0, maxActiveCreates: 0 };
  const providers = new Map(
    Array.from(new Set(options.agents)).map((agent) => [
      agent,
      new BenchProvider(agent, options, shared),
    ]),
  );
  const service = new MultiReviewService(storage, invoke, {
    autoAdvance: false,
    provider: async (_workflow, selection) => providers.get(selection.agent as "claude")!,
  });

  const reviewPackage = parseReviewPackageReference(
    {
      ...testGeneratedReviewPackage({
        packageId: "review-package-bench",
        round: 1,
        targetBranch: "main",
      }),
      bytes: options.packageBytes,
    },
    { id: "review-package-bench", round: 1, targetBranch: "main" },
  );
  const timestamp = new Date().toISOString();
  const workflow: MultiReviewWorkflow = {
    version: 1,
    controller: "backend",
    id: randomUUID(),
    environmentId,
    projectId: "project-1",
    targetBranch: "main",
    autoFix: false,
    reviewers: Array.from({ length: options.reviewers }, (_, index) => ({
      id: randomUUID(),
      agent: options.agents[index % options.agents.length]!,
      model: `bench-model-${index % 3}`,
      status: "pending" as const,
    })),
    fixModel: { agent: "claude", model: "bench-fix" },
    reviewWorktreeSnapshot: {
      status: "clean",
      head: REVIEW_HEAD,
      paths: [],
      fingerprint: "a".repeat(64),
      capturedAt: timestamp,
    },
    reviewPackage,
    phase: "reviewing",
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 0,
  };
  const created = await storage.createMultiReviewWorkflowIfNoActive(
    workflow.id,
    environmentId,
    1,
    workflow,
  );
  expect(created).not.toBeNull();

  const started = performance.now();
  try {
    // Admission: every reviewer is created and dispatched.
    const admissionStarted = performance.now();
    for (let pass = 0; pass < 4; pass++) {
      await service.advanceNow(workflow.id);
      const snapshot = (await storage.getMultiReviewWorkflow(workflow.id))!
        .snapshot as MultiReviewWorkflow;
      if (snapshot.reviewers.every((reviewer) => reviewer.dispatchState === "sent")) break;
    }
    const admissionMs = performance.now() - admissionStarted;
    const sentAt = Array.from(providers.values()).flatMap((provider) => provider.sentAt);
    const dispatchSkewMs = sentAt.length > 1 ? Math.max(...sentAt) - Math.min(...sentAt) : 0;

    // Running observation inside one progress-probe interval.
    const allProviders = Array.from(providers.values());
    const beforeRunning = {
      status: allProviders.reduce((total, provider) => total + provider.statusCalls, 0),
      messages: allProviders.reduce((total, provider) => total + provider.messagesCalls, 0),
      saves: workflowSaves,
    };
    for (let pass = 0; pass < options.runningPasses; pass++) {
      await service.advanceNow(workflow.id);
    }
    const runningStatus =
      allProviders.reduce((total, provider) => total + provider.statusCalls, 0) -
      beforeRunning.status;
    const runningReads =
      allProviders.reduce((total, provider) => total + provider.messagesCalls, 0) -
      beforeRunning.messages;
    const runningSaves = workflowSaves - beforeRunning.saves;

    // Settlement and consolidation.
    for (const provider of allProviders) provider.running = false;
    for (let pass = 0; pass < 12; pass++) {
      await service.advanceNow(workflow.id);
      const snapshot = (await storage.getMultiReviewWorkflow(workflow.id))!
        .snapshot as MultiReviewWorkflow;
      if (snapshot.phase === "ready" || snapshot.phase === "failed") break;
    }
    const final = (await storage.getMultiReviewWorkflow(workflow.id))!
      .snapshot as MultiReviewWorkflow;
    expect(final.error ?? final.phase).toBe("ready");
    const consolidationPrompt = allProviders
      .flatMap((provider) => Array.from(provider.prompts.values()))
      .find((prompt) => prompt.includes("<multi-review-reports-json>"));

    return {
      reviewers: options.reviewers,
      agents: Array.from(new Set(options.agents)).join("+"),
      verifyCalls,
      evidenceBytesVerified: verifyCalls * options.packageBytes,
      admissionMs: Math.round(admissionMs),
      dispatchSkewMs: Math.round(dispatchSkewMs),
      maxConcurrentSetup: shared.maxActiveCreates,
      runningPasses: options.runningPasses,
      statusCalls: runningStatus,
      transcriptReads: runningReads,
      workflowSaves,
      savesPerRunningPass: Number((runningSaves / options.runningPasses).toFixed(2)),
      backupRotations,
      leaseWrites,
      leaseWritesWithBackup,
      consolidationPromptBytes: Buffer.byteLength(consolidationPrompt ?? "", "utf8"),
      totalMs: Math.round(performance.now() - started),
    };
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const BASE: Omit<BenchOptions, "reviewers" | "agents"> = {
  setupDelayMs: 20,
  sendDelayMs: 2,
  statusDelayMs: 1,
  issuesPerReport: 6,
  runningPasses: 10,
  packageBytes: 64 * 1024 * 1024,
};

const results: BenchResult[] = [];

describe("Multi Review control-plane benchmark", () => {
  for (const reviewers of [1, 2, 4, 8, 32]) {
    test(`${reviewers} reviewer(s), one provider`, async () => {
      const result = await runBenchmark({ ...BASE, reviewers, agents: ["claude"] });
      results.push(result);
      if (REPORT_ONLY) return;
      // One verification admits the wave and one precedes consolidation,
      // independent of the reviewer count.
      expect(result.verifyCalls).toBe(2);
      // Ten passes inside the 60 s probe interval: at most the first probe of
      // each session reads its transcript; throttled passes read nothing.
      expect(result.transcriptReads).toBeLessThanOrEqual(reviewers);
      // At most one observational checkpoint per running pass.
      expect(result.savesPerRunningPass).toBeLessThanOrEqual(1);
      // Lease writes never rotate workflow backups.
      expect(result.leaseWritesWithBackup).toBe(0);
      // Setup overlaps within the default cap of four.
      expect(result.maxConcurrentSetup).toBe(Math.min(reviewers, 4));
    });
  }

  test("8 reviewers across two providers", async () => {
    const result = await runBenchmark({ ...BASE, reviewers: 8, agents: ["claude", "codex"] });
    results.push(result);
    if (REPORT_ONLY) return;
    expect(result.verifyCalls).toBe(2);
    expect(result.maxConcurrentSetup).toBeLessThanOrEqual(4);
  });

  test("one slow reviewer does not serialize the rest of the panel", async () => {
    const result = await runBenchmark({
      ...BASE,
      reviewers: 4,
      agents: ["claude"],
      slowReviewer: 0,
      slowSetupMs: 250,
    });
    results.push(result);
    if (REPORT_ONLY) return;
    // Serially the slow setup would delay every later reviewer by 250 ms.
    // Concurrently the others are admitted while it is still being created.
    expect(result.admissionMs).toBeLessThan(250 + 3 * BASE.setupDelayMs);
  });

  test("records the benchmark table", async () => {
    if (OUTPUT_PATH) await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`);
    expect(results.length).toBeGreaterThan(0);
  });
});
