/**
 * Service-level coverage for the Multi Review efficiency work: evidence
 * permits across service lifetimes, conditional reviewer transcripts, and
 * content-free measurement. The broad behavioural suite lives in
 * `multi-review-service.test.ts`.
 */
import { expect, jest, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  ProviderDispatchPreparationError,
  type BuildPipelineProvider,
  type ProviderSendOptions,
} from "./build-pipeline-provider.js";
import { testGeneratedReviewPackage } from "./build-pipeline-test-fixtures.js";
import { syntheticReport } from "./multi-review-efficiency-fixtures.js";
import { RecordingEfficiencyObserver } from "./multi-review-efficiency.js";
import { MultiReviewService, type MultiReviewServiceOptions } from "./multi-review-service.js";
import { parseReviewPackageReference } from "./review-package.js";
import { StorageService } from "./storage.js";
import { PROGRESS_TRANSCRIPT_WINDOW_MESSAGES } from "./transcript-progress.js";

jest.setTimeout(30_000);

const HEAD = "1".repeat(40);
const SECRET = "sk-live-SECRET-PROMPT-CONTENT";

class Provider {
  readonly agent = "claude" as const;
  sessions = 0;
  running = true;
  failSendFor = new Set<string>();
  readonly sends: string[] = [];
  readonly prompts = new Map<string, string>();
  transcriptRevision = 1;
  readonly snapshotCalls: Array<{
    knownSourceToken?: string;
    limit: number;
    representation?: "summary";
  }> = [];
  messageCalls = 0;

  async createSession() {
    this.sessions += 1;
    return `session-${this.sessions}`;
  }
  async prepareDispatch() {}
  async send(sessionId: string, prompt: string, options: ProviderSendOptions) {
    if (this.failSendFor.has(sessionId)) {
      throw new ProviderDispatchPreparationError("broker setup failed");
    }
    this.sends.push(sessionId);
    this.prompts.set(options.requestId, prompt);
  }
  async status() {
    return this.running ? ("running" as const) : ("idle" as const);
  }
  async observeSession() {
    return { status: await this.status(), contextUsage: { usedTokens: 1, sessionTokens: 1 } };
  }
  async messages() {
    this.messageCalls += 1;
    return [{ role: "assistant", content: SECRET }];
  }
  async transcriptSnapshot(
    _sessionId: string,
    options: {
      limit: number;
      targetBytes: number;
      knownSourceToken?: string;
      representation?: "summary";
    },
  ) {
    this.snapshotCalls.push({
      knownSourceToken: options.knownSourceToken,
      limit: options.limit,
      ...(options.representation ? { representation: options.representation } : {}),
    });
    const token = `rev-${this.transcriptRevision}`;
    if (options.knownSourceToken === token) return { unchanged: true as const, sourceToken: token };
    return {
      messages: [{ role: "assistant", content: `progress ${this.transcriptRevision}` }],
      sourceToken: token,
      complete: true,
    };
  }
  async structured<T>(_sessionId: string, requestId: string): Promise<StructuredOutputResult<T>> {
    const report = syntheticReport(1, 0);
    if (this.prompts.get(requestId)?.includes("<multi-review-reports-json>")) {
      // A consolidation must cite the backend-issued source IDs it merges.
      report.issues = report.issues.map((issue) => ({
        ...issue,
        reviewSourceIds: ["reviewer-1/issue-1", "reviewer-2/issue-1"],
      }));
      report.testCoverageGaps = [];
    }
    return { ok: true, provider: "claude", requestId, value: report as T };
  }
  async abort() {}
}

async function setup(reviewerCount: number) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-efficiency-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  const environmentId = "env-efficiency";
  await storage.addEnvironment({
    id: environmentId,
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
  const commands: string[] = [];
  const controls = { failVerifications: 0 };
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    commands.push(command);
    if (command === "verify_looped_review_package") {
      if (controls.failVerifications > 0) {
        controls.failVerifications -= 1;
        throw new Error("package read failed");
      }
      return { valid: true } as T;
    }
    if (command === "generate_looped_review_package") return testGeneratedReviewPackage(args!) as T;
    if (command === "get_environment_uncommitted_paths") {
      return { head: HEAD, paths: [], fingerprint: "a".repeat(64) } as T;
    }
    throw new Error(`unexpected command ${command}`);
  };
  const provider = new Provider();
  const efficiency = new RecordingEfficiencyObserver();
  const createService = (options: Partial<MultiReviewServiceOptions> = {}) =>
    new MultiReviewService(storage, invoke, {
      autoAdvance: false,
      provider: async () => provider as unknown as BuildPipelineProvider,
      efficiency,
      ...options,
    });
  const timestamp = new Date().toISOString();
  const workflow: MultiReviewWorkflow = {
    version: 1,
    controller: "backend",
    id: randomUUID(),
    environmentId,
    projectId: "project-1",
    targetBranch: "main",
    autoFix: false,
    reviewInstruction: `Focus on ${SECRET}`,
    reviewers: Array.from({ length: reviewerCount }, (_, index) => ({
      id: `reviewer-${index + 1}`,
      agent: "claude" as const,
      model: "opus",
      status: "pending" as const,
    })),
    fixModel: { agent: "claude", model: "opus" },
    reviewWorktreeSnapshot: {
      status: "clean",
      head: HEAD,
      paths: [],
      fingerprint: "a".repeat(64),
      capturedAt: timestamp,
    },
    reviewPackage: parseReviewPackageReference(
      testGeneratedReviewPackage({
        packageId: "review-package-eff",
        round: 1,
        targetBranch: "main",
      }),
      { id: "review-package-eff", round: 1, targetBranch: "main" },
    ),
    phase: "reviewing",
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 0,
  };
  await storage.createMultiReviewWorkflowIfNoActive(workflow.id, environmentId, 1, workflow);
  const snapshot = async () =>
    (await storage.getMultiReviewWorkflow(workflow.id))!.snapshot as MultiReviewWorkflow;
  return {
    storage,
    provider,
    commands,
    controls,
    efficiency,
    createService,
    workflowId: workflow.id,
    snapshot,
    verifications: () =>
      commands.filter((command) => command === "verify_looped_review_package").length,
    cleanup: () => fs.rm(dataDir, { recursive: true, force: true }),
  };
}

test("an evidence permit survives a retrying pass but never a service restart", async () => {
  const env = await setup(2);
  try {
    env.provider.failSendFor.add("session-1");
    const first = env.createService();
    await first.advanceNow(env.workflowId);
    expect(env.verifications()).toBe(1);
    expect((await env.snapshot()).reviewers[0]?.dispatchState).toBe("prepared");

    // The retrying reviewer re-uses the live permit instead of re-hashing.
    await first.advanceNow(env.workflowId);
    expect(env.verifications()).toBe(1);
    expect(env.efficiency.count("evidence.permit_reuse")).toBeGreaterThanOrEqual(1);
    await first.shutdown();

    // A new process trusts nothing it did not verify itself.
    env.provider.failSendFor.clear();
    const second = env.createService();
    await second.advanceNow(env.workflowId);
    expect(env.verifications()).toBe(2);
    expect(
      (await env.snapshot()).reviewers.every((reviewer) => reviewer.dispatchState === "sent"),
    ).toBe(true);
    await second.shutdown();
  } finally {
    await env.cleanup();
  }
});

test("a transient admission verification failure fails the workflow before any dispatch", async () => {
  const env = await setup(3);
  try {
    env.controls.failVerifications = 1;
    const service = env.createService();
    await service.advanceNow(env.workflowId);
    // Admission is verified once for the whole generation, so a failed check
    // is workflow-fatal: no reviewer session is opened on unverified evidence.
    const failed = await env.snapshot();
    expect(failed.phase).toBe("failed");
    expect(failed.error).toContain("package read failed");
    expect(env.provider.sessions).toBe(0);
    expect(env.provider.sends).toEqual([]);
    expect(failed.reviewers.some((reviewer) => reviewer.providerSessionId !== undefined)).toBe(
      false,
    );

    // The failed check left no permit behind: the retry verifies afresh.
    await service.retry(env.workflowId);
    await service.advanceNow(env.workflowId);
    expect(env.verifications()).toBe(2);
    expect(
      (await env.snapshot()).reviewers.every((reviewer) => reviewer.dispatchState === "sent"),
    ).toBe(true);
    await service.shutdown();
  } finally {
    await env.cleanup();
  }
});

test("the rollback gate restores per-reviewer verification", async () => {
  const env = await setup(3);
  try {
    const service = env.createService({ evidencePermits: false });
    await service.advanceNow(env.workflowId);
    expect(env.verifications()).toBe(3);
    await service.shutdown();
  } finally {
    await env.cleanup();
  }
});

test("reviewer transcripts are conditional and scoped to the reviewer's session", async () => {
  const env = await setup(1);
  try {
    const service = env.createService();
    await service.advanceNow(env.workflowId);

    const first = await service.reviewerTranscript(env.workflowId, "reviewer-1");
    expect(first).toMatchObject({ transcript: "snapshot", status: "running" });
    expect(first.messages).toHaveLength(1);
    expect(first.sourceToken).toBeString();

    const unchanged = await service.reviewerTranscript(
      env.workflowId,
      "reviewer-1",
      first.sourceToken,
    );
    expect(unchanged).toMatchObject({ transcript: "unchanged", messages: [], status: "running" });
    expect(unchanged.sourceToken).toBe(first.sourceToken);

    env.provider.transcriptRevision += 1;
    const moved = await service.reviewerTranscript(
      env.workflowId,
      "reviewer-1",
      unchanged.sourceToken,
    );
    expect(moved.transcript).toBe("snapshot");
    expect(moved.messages).toEqual([{ role: "assistant", content: "progress 2" }]);
    expect(env.efficiency.count("transcript.ui_unchanged")).toBe(1);
    await service.shutdown();
  } finally {
    await env.cleanup();
  }
});

test("reviewer progress probes are conditional and never read the legacy transcript", async () => {
  const env = await setup(2);
  try {
    // Every pass is a due probe, so the conditional path is exercised each time.
    const service = env.createService({ progressProbeIntervalMs: 0 });
    for (let pass = 0; pass < 4; pass++) await service.advanceNow(env.workflowId);

    const probes = env.provider.snapshotCalls.filter(
      (call) => call.limit === PROGRESS_TRANSCRIPT_WINDOW_MESSAGES,
    );
    expect(probes.length).toBeGreaterThanOrEqual(4);
    expect(probes.every((call) => call.representation === "summary")).toBe(true);
    expect(probes.some((call) => call.knownSourceToken !== undefined)).toBe(true);
    expect(env.efficiency.count("transcript.progress_unchanged")).toBeGreaterThanOrEqual(2);
    expect(env.efficiency.count("transcript.progress_fallback")).toBe(0);
    // No legacy whole-history read backs any of it.
    expect(env.provider.messageCalls).toBe(0);
    const snapshot = await env.snapshot();
    expect(snapshot.reviewers.every((reviewer) => reviewer.status === "running")).toBe(true);
    expect(
      snapshot.reviewers.every((reviewer) => /^[0-9a-f]{64}$/.test(reviewer.progressDigest ?? "")),
    ).toBe(true);

    // Movement is progress: the stall clock resets for the moved reviewers.
    const before = snapshot.reviewers.map((reviewer) => reviewer.progressAt);
    await Bun.sleep(5);
    env.provider.transcriptRevision += 1;
    await service.advanceNow(env.workflowId);
    const moved = (await env.snapshot()).reviewers.map((reviewer) => reviewer.progressAt);
    expect(moved.some((progressAt, index) => progressAt !== before[index])).toBe(true);
    await service.shutdown();
  } finally {
    await env.cleanup();
  }
});

test("recorded measurements carry no prompt, transcript or identifier content", async () => {
  const env = await setup(2);
  try {
    const service = env.createService();
    await service.advanceNow(env.workflowId);
    await service.reviewerTranscript(env.workflowId, "reviewer-1");
    env.provider.running = false;
    for (let pass = 0; pass < 6; pass++) await service.advanceNow(env.workflowId);
    expect((await env.snapshot()).phase).toBe("ready");
    await service.shutdown();

    expect(env.efficiency.events.length).toBeGreaterThan(10);
    const serialized = JSON.stringify(env.efficiency.events);
    for (const forbidden of [SECRET, env.workflowId, "session-1", "reviewer-1", "env-efficiency"]) {
      expect(serialized).not.toContain(forbidden);
    }
  } finally {
    await env.cleanup();
  }
});
