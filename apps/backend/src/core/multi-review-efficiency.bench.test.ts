/**
 * Deterministic Multi Review control-plane benchmark.
 *
 * Measures what the fan-out costs around the model work — evidence
 * verifications, provider calls, transcript reads, workflow writes, controller
 * fence checks, storage row and whole-store access, dispatch skew,
 * consolidation input — with fake providers, a temporary store, synthetic
 * reports and no real source or transcript content.
 *
 * Counting happens only through the fake provider, the command invoker and
 * storage and database spies. The harness therefore runs unchanged against
 * older code (back to the SQLite store), which is how the efficiency work's
 * before/after baselines were produced. The budgets
 * it checks, and why they were chosen, are in
 * `docs/architecture/review-preparation.md` ("Fan-out budgets and benchmark").
 * Reproduce with:
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
import { describe, expect, jest, spyOn, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
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
import { storageDatabase } from "./storage-test-support.js";

jest.setTimeout(120_000);

const REPORT_ONLY = process.env.MULTI_REVIEW_BENCH_REPORT_ONLY === "1";
const OUTPUT_PATH = process.env.MULTI_REVIEW_BENCH_OUT;
const REVIEW_HEAD = "1".repeat(40);

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Bounds a slow setup's wait for its peers, so a serial regression fails instead of hanging. */
const PEER_DISPATCH_LIMIT_MS = 5_000;

interface BenchOptions {
  reviewers: number;
  agents: Array<"claude" | "codex">;
  setupDelayMs: number;
  sendDelayMs: number;
  statusDelayMs: number;
  /** Reviewer index whose session creation is `slowSetupMs` instead. */
  slowReviewer?: number;
  slowSetupMs?: number;
  /** The slow setup also waits until every other reviewer has been dispatched. */
  slowSetupAwaitsPeers?: boolean;
  issuesPerReport: number;
  runningPasses: number;
  packageBytes: number;
  /** Finished workflows already in the store: the retained review history. */
  retainedWorkflows?: number;
}

interface SharedBenchState {
  activeCreates: number;
  maxActiveCreates: number;
  /** Turns dispatched so far, across providers. */
  dispatched: number;
  onDispatch?: () => void;
  /** Turns already dispatched when the slow reviewer's setup returned. */
  dispatchedDuringSlowSetup?: number;
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
    private readonly shared: SharedBenchState,
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
      if (reviewerIndex === this.options.slowReviewer) {
        await Promise.all([
          sleep(this.options.slowSetupMs ?? this.options.setupDelayMs),
          this.options.slowSetupAwaitsPeers ? this.peersDispatched() : undefined,
        ]);
        this.shared.dispatchedDuringSlowSetup = this.shared.dispatched;
      } else {
        await sleep(this.options.setupDelayMs);
      }
    } finally {
      this.shared.activeCreates -= 1;
    }
    this.sessions += 1;
    const id = `${this.agent}-session-${this.sessions}-${randomUUID()}`;
    this.sessionReviewer.set(id, reviewerIndex);
    return id;
  }

  /** Resolves once every other reviewer has been dispatched, or at the limit. */
  private peersDispatched(): Promise<void> {
    const peers = this.options.reviewers - 1;
    return new Promise((resolve) => {
      const limit = setTimeout(resolve, PEER_DISPATCH_LIMIT_MS);
      const check = () => {
        if (this.shared.dispatched < peers) return;
        clearTimeout(limit);
        this.shared.onDispatch = undefined;
        resolve();
      };
      this.shared.onDispatch = check;
      check();
    });
  }

  async prepareDispatch() {}

  async send(_sessionId: string, prompt: string, options: ProviderSendOptions) {
    this.sends += 1;
    await sleep(this.options.sendDelayMs);
    this.sentAt.push(performance.now());
    this.prompts.set(options.requestId, prompt);
    this.shared.dispatched += 1;
    this.shared.onDispatch?.();
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
  /** Turns dispatched while the slow reviewer was still being created. */
  dispatchedDuringSlowSetup: number | null;
  runningPasses: number;
  statusCalls: number;
  transcriptReads: number;
  workflowSaves: number;
  savesPerRunningPass: number;
  retainedWorkflows: number;
  /** Controller fence checks, total and per running pass. */
  fenceChecks: number;
  fenceChecksPerRunningPass: number;
  /** Multi Review store access: whole-store reads and writes, single-row reads and writes. */
  wholeStoreReads: number;
  wholeStoreReadsPerRunningPass: number;
  wholeStoreWrites: number;
  rowReads: number;
  rowWrites: number;
  /** Multi Review mutation-lease acquisitions (two SQLite write transactions each). */
  leaseAcquires: number;
  leaseAcquiresPerRunningPass: number;
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

  // Finished workflows a long-lived environment retains: each fence check must
  // cost the same whether there are none or many.
  const retainedTimestamp = new Date(0).toISOString();
  for (let index = 0; index < (options.retainedWorkflows ?? 0); index++) {
    const id = randomUUID();
    const retained: MultiReviewWorkflow = {
      version: 1,
      controller: "backend",
      id,
      environmentId,
      projectId: "project-1",
      targetBranch: "main",
      autoFix: false,
      reviewers: Array.from({ length: 8 }, (_, reviewer) => ({
        id: randomUUID(),
        agent: "claude" as const,
        model: "bench-model",
        status: "completed" as const,
        report: syntheticReport(options.issuesPerReport, reviewer),
      })),
      fixModel: { agent: "claude", model: "bench-fix" },
      phase: "completed",
      createdAt: retainedTimestamp,
      updatedAt: retainedTimestamp,
      backendRevision: 0,
    };
    await storage.saveMultiReviewWorkflow(id, environmentId, 1, retained);
  }

  // Storage spies: logical saves and fence checks, and how the Multi Review
  // store is reached underneath them.
  const counts = {
    workflowSaves: 0,
    fenceChecks: 0,
    wholeStoreReads: 0,
    wholeStoreWrites: 0,
    rowReads: 0,
    rowWrites: 0,
    leaseAcquires: 0,
  };
  const originalSave = storage.saveMultiReviewWorkflow.bind(storage);
  storage.saveMultiReviewWorkflow = async (...args) => {
    counts.workflowSaves += 1;
    return originalSave(...args);
  };
  const originalValidate = storage.validateMultiReviewController.bind(storage);
  storage.validateMultiReviewController = async (...args) => {
    counts.fenceChecks += 1;
    return originalValidate(...args);
  };
  const database = storageDatabase(storage) as unknown as Record<string, unknown>;
  const spy = (
    method: string,
    matches: (target: unknown) => boolean,
    count: keyof typeof counts,
  ) => {
    const original = (database[method] as (...args: unknown[]) => unknown).bind(database);
    database[method] = (...args: unknown[]) => {
      if (matches(args[0])) counts[count] += 1;
      return original(...args);
    };
  };
  const multiReviewStore = (store: unknown) => store === "multi-reviews";
  spy("readStore", multiReviewStore, "wholeStoreReads");
  spy("writeStore", multiReviewStore, "wholeStoreWrites");
  spy("readStoreRow", multiReviewStore, "rowReads");
  spy("updateStoreRow", multiReviewStore, "rowWrites");
  spy("acquireLease", (name) => name === "multi-reviews.json", "leaseAcquires");

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

  const shared: SharedBenchState = { activeCreates: 0, maxActiveCreates: 0, dispatched: 0 };
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
      ...counts,
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
    const perRunningPass = (count: keyof typeof counts) =>
      Number(((counts[count] - beforeRunning[count]) / options.runningPasses).toFixed(2));
    const running = {
      saves: perRunningPass("workflowSaves"),
      fenceChecks: perRunningPass("fenceChecks"),
      wholeStoreReads: perRunningPass("wholeStoreReads"),
      leaseAcquires: perRunningPass("leaseAcquires"),
    };

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
      dispatchedDuringSlowSetup: shared.dispatchedDuringSlowSetup ?? null,
      runningPasses: options.runningPasses,
      statusCalls: runningStatus,
      transcriptReads: runningReads,
      workflowSaves: counts.workflowSaves,
      savesPerRunningPass: running.saves,
      retainedWorkflows: options.retainedWorkflows ?? 0,
      fenceChecks: counts.fenceChecks,
      fenceChecksPerRunningPass: running.fenceChecks,
      wholeStoreReads: counts.wholeStoreReads,
      wholeStoreReadsPerRunningPass: running.wholeStoreReads,
      wholeStoreWrites: counts.wholeStoreWrites,
      rowReads: counts.rowReads,
      rowWrites: counts.rowWrites,
      leaseAcquires: counts.leaseAcquires,
      leaseAcquiresPerRunningPass: running.leaseAcquires,
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

/**
 * A fence check reads one committed row and takes no lease, so a running pass
 * reads no whole store and takes the same leases at any panel size or history:
 * the controller claim and the observational flush.
 */
function expectFenceChecksCostOneRow(result: BenchResult): void {
  expect(result.fenceChecksPerRunningPass).toBeGreaterThan(0);
  expect(result.wholeStoreReadsPerRunningPass).toBe(0);
  expect(result.leaseAcquiresPerRunningPass).toBeLessThanOrEqual(2);
}

describe("Multi Review control-plane benchmark", () => {
  for (const reviewers of [1, 2, 4, 8, 16, 32]) {
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
      expectFenceChecksCostOneRow(result);
      // Setup overlaps within the default cap of four.
      expect(result.maxConcurrentSetup).toBe(Math.min(reviewers, 4));
    });
  }

  test("retained review history does not change a running pass's storage work", async () => {
    const fresh = await runBenchmark({ ...BASE, reviewers: 8, agents: ["claude"] });
    const retained = await runBenchmark({
      ...BASE,
      reviewers: 8,
      agents: ["claude"],
      retainedWorkflows: 50,
    });
    results.push(retained);
    if (REPORT_ONLY) return;
    expectFenceChecksCostOneRow(retained);
    expect(retained.fenceChecksPerRunningPass).toBe(fresh.fenceChecksPerRunningPass);
    expect(retained.leaseAcquiresPerRunningPass).toBe(fresh.leaseAcquiresPerRunningPass);
  });

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
      // Report-only runs keep the plain 250 ms setup so older builds stay comparable.
      slowSetupAwaitsPeers: !REPORT_ONLY,
    });
    results.push(result);
    if (REPORT_ONLY) return;
    // Serially every later reviewer would wait for the slow setup. Concurrently
    // the other three are dispatched while it is still being created, which the
    // slow setup waits for instead of racing a wall-clock bound (flake 0171).
    expect(result.dispatchedDuringSlowSetup).toBe(3);
  });

  test("records the benchmark table", async () => {
    if (OUTPUT_PATH) await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`);
    expect(results.length).toBeGreaterThan(0);
  });
});

// Observe SQLite results rather than the logical readStoreRow call: a keyed
// API can still hide a whole-store load on a cold or invalidated cache.
test.each([0, 50])(
  "keyed storage fetches only its row with %i retained workflows",
  async (retained) => {
    if (REPORT_ONLY) return;
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-storage-bench-"));
    const writer = new StorageService(dataDir);
    const reader = new StorageService(dataDir);
    try {
      await writer.init();
      await writer.addEnvironment({
        id: "env-1",
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
      });
      const snapshot = (id: string, phase: "reviewing" | "completed"): MultiReviewWorkflow => ({
        version: 1,
        controller: "backend",
        id,
        environmentId: "env-1",
        projectId: "project-1",
        targetBranch: "main",
        reviewers: [],
        fixModel: { agent: "claude", model: "bench" },
        phase,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        backendRevision: 0,
      });
      for (let index = 0; index < retained; index++) {
        await writer.saveMultiReviewWorkflow(`retained-${index}`, "env-1", 1, {
          ...snapshot(`retained-${index}`, "completed"),
          reviewers: [
            {
              id: "reviewer",
              agent: "claude",
              model: "bench",
              status: "completed",
              report: syntheticReport(20, index),
            },
          ],
        });
      }
      await writer.saveMultiReviewWorkflow("active", "env-1", 1, snapshot("active", "reviewing"));
      const first = await writer.claimMultiReviewController("active", "owner-1", 60_000);
      await reader.init();
      const database = storageDatabase(reader);
      const sqlite = database.db;
      const query = sqlite.query.bind(sqlite);
      let rowsFetched = 0;
      let bytesFetched = 0;
      const observe = spyOn(sqlite, "query").mockImplementation(function <
        Result,
        Params extends SQLQueryBindings | SQLQueryBindings[],
      >(sql: string) {
        const statement = query<Result, Params>(sql);
        if (!/^\s*SELECT\b/i.test(sql) || !/\bFROM\s+store_rows\b/i.test(sql)) return statement;
        return new Proxy(statement, {
          get(target, property) {
            if (property !== "get" && property !== "all") {
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return (...bindings: unknown[]) => {
              const result = Reflect.apply(target[property], target, bindings) as unknown;
              if (bindings[0] === "multi-reviews") {
                for (const row of Array.isArray(result) ? result : result ? [result] : []) {
                  rowsFetched += 1;
                  if (typeof row.value === "string") bytesFetched += Buffer.byteLength(row.value);
                }
              }
              return result;
            };
          },
        });
      });
      const expectedBytes = (storage: StorageService) => {
        const db = storageDatabase(storage);
        return db.rows("multi-reviews").entry("active")!.bytes;
      };
      const expectOneRow = async (operation: () => Promise<unknown>) => {
        const bytes = expectedBytes(writer);
        rowsFetched = 0;
        bytesFetched = 0;
        await operation();
        expect(rowsFetched).toBe(1);
        expect(bytesFetched).toBe(bytes);
      };
      try {
        // This reader has never read Multi Review history.
        await expectOneRow(async () => {
          expect(await reader.validateMultiReviewController("active", "owner-1", first.token)).toBe(
            true,
          );
        });
        // Populate the old whole-store cache, then invalidate it from a separate
        // connection. Neither the fence nor subsequent mutations may reload it.
        database.readStore("multi-reviews");
        await writer.releaseMultiReviewController("active", "owner-1", first.token);
        await expectOneRow(async () => {
          expect(await reader.validateMultiReviewController("active", "owner-1", first.token)).toBe(
            false,
          );
        });
        const next = await writer.claimMultiReviewController("active", "owner-2", 60_000);
        await expectOneRow(() => reader.claimMultiReviewController("active", "owner-2", 60_000));
        await expectOneRow(() =>
          reader.saveMultiReviewWorkflow(
            "active",
            "env-1",
            1,
            { ...snapshot("active", "reviewing"), phase: "consolidating" },
            1,
            { ownerId: "owner-2", token: next.token },
          ),
        );
        await expectOneRow(() => reader.getMultiReviewWorkflow("active"));
        await expectOneRow(() =>
          reader.releaseMultiReviewController("active", "owner-2", next.token),
        );
        expect((await writer.getMultiReviewWorkflow("active"))?.revision).toBe(2);
        expect(await writer.listMultiReviewWorkflows("env-1")).toHaveLength(retained + 1);
        await expectOneRow(() => reader.deleteMultiReviewWorkflow("active"));
        expect(await writer.getMultiReviewWorkflow("active")).toBeNull();
      } finally {
        observe.mockRestore();
      }
    } finally {
      reader.close();
      writer.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  },
);
