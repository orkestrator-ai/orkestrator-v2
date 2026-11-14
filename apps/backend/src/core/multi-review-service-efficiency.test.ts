/**
 * Service-level coverage for the Multi Review efficiency work: evidence
 * permits across service lifetimes, one snapshot drift check per admission
 * pass, conditional reviewer transcripts, and content-free measurement. The broad behavioural suite lives in
 * `multi-review-service-part-*.test.ts`.
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
import { ManualTime, settleKeyedWork } from "./recurring-test-support.js";

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
  registerSession(_sessionId: string) {}
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

async function setup(reviewerCount: number, options: { snapshotMode?: boolean } = {}) {
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
  const controls = {
    failVerifications: 0,
    /** The live worktree's uncommitted paths; the pinned baseline is clean. */
    worktreePaths: [] as string[],
    /** Answer the worktree probe with an unusable result ("could not look"). */
    worktreeUnreadable: false,
  };
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    commands.push(command);
    if (command === "verify_review_package") {
      if (controls.failVerifications > 0) {
        controls.failVerifications -= 1;
        throw new Error("package read failed");
      }
      return { valid: true } as T;
    }
    if (command === "generate_review_package") return testGeneratedReviewPackage(args!) as T;
    if (command === "get_environment_uncommitted_paths") {
      if (controls.worktreeUnreadable) return { status: "unknown" } as T;
      return { head: HEAD, paths: [...controls.worktreePaths], fingerprint: "a".repeat(64) } as T;
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
    ...(options.snapshotMode
      ? {}
      : {
          reviewPackage: parseReviewPackageReference(
            testGeneratedReviewPackage({
              packageId: "review-package-eff",
              round: 1,
              targetBranch: "main",
            }),
            { id: "review-package-eff", round: 1, targetBranch: "main" },
          ),
        }),
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
    verifications: () => commands.filter((command) => command === "verify_review_package").length,
    worktreeProbes: () =>
      commands.filter((command) => command === "get_environment_uncommitted_paths").length,
    reviewerPrompts: () =>
      [...provider.prompts.values()].filter((prompt) =>
        prompt.includes("You are independent reviewer"),
      ),
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

test("a rejected dispatch target is shared by reviewers without failing an observing peer", async () => {
  const env = await setup(3);
  const service = env.createService();
  try {
    await service.advanceNow(env.workflowId);
    const workflow = await env.snapshot();
    // Two reviewers need dispatch; the third is already running and only observes.
    for (const reviewer of workflow.reviewers.slice(0, 2)) {
      reviewer.dispatchState = "prepared";
      reviewer.agentStarted = false;
    }
    await env.storage.saveMultiReviewWorkflow(workflow.id, workflow.environmentId, 1, workflow);
    const originalRead = env.storage.getEnvironment.bind(env.storage);
    let failNextRead = false;
    let rejectedReads = 0;
    const register = jest.spyOn(env.provider, "registerSession").mockImplementation((id) => {
      // Registration happens after session persistence and before dispatch.
      if (id === "session-1") failNextRead = true;
    });
    const read = jest.spyOn(env.storage, "getEnvironment").mockImplementation(async (id) => {
      if (failNextRead) {
        failNextRead = false;
        rejectedReads += 1;
        throw new Error("dispatch target unavailable");
      }
      return originalRead(id);
    });
    try {
      await service.advanceNow(env.workflowId);
      const failed = await env.snapshot();
      expect(rejectedReads).toBe(1);
      expect(failed.phase).toBe("reviewing");
      expect(failed.error).toBeUndefined();
      for (const reviewer of failed.reviewers.slice(0, 2)) {
        expect(reviewer.status).toBe("failed");
        expect(reviewer.error).toContain("dispatch target unavailable");
        expect(reviewer.dispatchState).toBe("prepared");
        expect(reviewer.agentStarted).toBe(false);
      }
      expect(failed.reviewers[2]?.status).toBe("running");
      expect(failed.reviewers[2]?.dispatchState).toBe("sent");
      expect(env.provider.sends).toEqual(["session-1", "session-2", "session-3"]);
    } finally {
      read.mockRestore();
      register.mockRestore();
    }
  } finally {
    await service.shutdown();
    await env.cleanup();
  }
});

test("snapshot mode checks the worktree once per admission pass, not once per reviewer", async () => {
  const env = await setup(3, { snapshotMode: true });
  try {
    env.provider.failSendFor.add("session-1");
    const service = env.createService();
    await service.advanceNow(env.workflowId);
    // Three reviewer prompts were built from one probe (each probe is two
    // `git status` captures in the environment), not one probe per reviewer.
    expect(env.worktreeProbes()).toBe(1);
    expect(env.provider.sends).toEqual(["session-2", "session-3"]);
    expect((await env.snapshot()).reviewers[0]?.dispatchState).toBe("prepared");

    // The retrying reviewer is admitted by the next pass, which checks again
    // and sees the change made after the first pass's check.
    env.controls.worktreePaths = ["src/appeared.ts"];
    env.provider.failSendFor.clear();
    await service.advanceNow(env.workflowId);
    expect(env.worktreeProbes()).toBe(2);
    const prompts = env.reviewerPrompts();
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("**Authoritative worktree state**");
    expect(prompts[1]).toContain("**Authoritative worktree state**");
    expect(prompts[2]).toContain("**Pinned worktree state (known stale)**");
    const drifted = await env.snapshot();
    expect(drifted.reviewSnapshotStale).toBe(true);
    expect(drifted.error).toBeUndefined();

    // A pass that admits nobody does not probe at all.
    await service.advanceNow(env.workflowId);
    expect(env.worktreeProbes()).toBe(2);
    await service.shutdown();
  } finally {
    await env.cleanup();
  }
});

test("a drift found by the pass's check reaches every prompt that pass builds", async () => {
  const env = await setup(3, { snapshotMode: true });
  try {
    env.controls.worktreePaths = ["src/appeared.ts"];
    const service = env.createService();
    await service.advanceNow(env.workflowId);
    expect(env.worktreeProbes()).toBe(1);
    const prompts = env.reviewerPrompts();
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt).toContain("**Pinned worktree state (known stale)**");
      expect(prompt).not.toContain("**Authoritative worktree state**");
    }
    const drifted = await env.snapshot();
    // Drift is a durable warning in snapshot mode, never a failure.
    expect(drifted.reviewSnapshotStale).toBe(true);
    expect(drifted.phase).toBe("reviewing");
    expect(drifted.reviewers.every((reviewer) => reviewer.dispatchState === "sent")).toBe(true);
    await service.shutdown();
  } finally {
    await env.cleanup();
  }
});

test("an unreadable worktree fails snapshot admission before any reviewer starts", async () => {
  const env = await setup(3, { snapshotMode: true });
  try {
    env.controls.worktreeUnreadable = true;
    const service = env.createService();
    await service.advanceNow(env.workflowId);
    // "Could not look" stays distinct from "has changed": it is not recorded
    // as drift, and no reviewer session is opened on unverified evidence.
    const failed = await env.snapshot();
    expect(failed.phase).toBe("failed");
    expect(failed.error).toContain("cannot verify its worktree snapshot");
    expect(failed.reviewSnapshotStale).toBeUndefined();
    expect(env.provider.sessions).toBe(0);
    expect(env.provider.sends).toEqual([]);
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

// The keyed supervisor's critical job is the only lease renewal: the due
// scheduler's own renewal timer went with it (todo 0048 task 13).
test("lease renewal runs as one critical job: never overlapping, once per init, stopped by shutdown", async () => {
  const env = await setup(1);
  const time = new ManualTime(0);
  const service = env.createService({
    autoAdvance: true,
    schedulerClock: { now: time.now, timers: time.timerFactory },
    controllerRenewMs: 1_000,
    // Keep every workflow pass out of the measured window, so each claim
    // counted below is a renewal.
    pollIntervalMs: 600_000,
    observationIntervalMs: 600_000,
    discoveryIntervalMs: 600_000,
  });
  const claim = env.storage.claimMultiReviewController.bind(env.storage);
  let gate: Promise<void> | null = null;
  let release: (() => void) | undefined;
  const renew = jest
    .spyOn(env.storage, "claimMultiReviewController")
    .mockImplementation(async (...args) => {
      if (gate) await gate;
      return claim(...args);
    });
  const settle = (allowInFlight = 0) => settleKeyedWork(time, [service], { allowInFlight });
  try {
    // A pass holds the lease the renewal keeps alive.
    await service.advanceNow(env.workflowId);
    await service.init();
    // A second init replaces the supervisor rather than adding a renewal.
    await service.init();
    await settle();
    renew.mockClear();

    await time.advance(1_000);
    await settle();
    expect(renew).toHaveBeenCalledTimes(1);

    // A slow renewal is never joined by a second one, however long it takes.
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await time.advance(1_000);
    await settle(1);
    expect(renew).toHaveBeenCalledTimes(2);
    for (let step = 0; step < 4; step += 1) {
      await time.advance(1_000);
      await settle(1);
    }
    expect(renew).toHaveBeenCalledTimes(2);
    gate = null;
    release!();
    await settle();
    await time.advance(1_000);
    await settle();
    // The next renewal is due from the slow one's completion: no catch-up burst.
    expect(renew).toHaveBeenCalledTimes(3);

    // Shutdown releases the lease; nothing renews afterwards.
    await service.shutdown();
    const afterShutdown = renew.mock.calls.length;
    await time.advance(10_000);
    expect(renew).toHaveBeenCalledTimes(afterShutdown);
  } finally {
    release?.();
    renew.mockRestore();
    await service.shutdown();
    await env.cleanup();
  }
});
