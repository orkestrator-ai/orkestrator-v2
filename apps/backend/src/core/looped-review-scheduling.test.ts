import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LOOPED_REVIEW_WORKFLOW_VERSION,
  type LoopedReviewWorkflow,
} from "@orkestrator/protocol/review-workflow";
import { reviewPackageArtifactPath } from "@orkestrator/protocol/review-artifacts";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type {
  BuildPipelineProvider,
  ProviderSendOptions,
  ProviderStatus,
} from "./build-pipeline-provider.js";
import { LoopedReviewService } from "./looped-review-service.js";
import { discoverLoopedReviews, loopedReviewObligation } from "./looped-review-scheduling.js";
import {
  ManualTime,
  advanceKeyedWork,
  deferred,
  settleKeyedWork,
  type Deferred,
} from "./recurring-test-support.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { StorageService } from "./storage.js";

const cleanReport: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: [],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "No relevant changes.",
    before: "Unchanged.",
    after: "Unchanged.",
    keyCodeChanges: [],
    userImpact: "None.",
  },
  riskProfile: { changeTypes: [], riskAreas: [], overallRisk: "low", reasoning: "No change." },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready." },
  summaryOfChange: "No change.",
  reviewSummary: "No high-confidence issues were found in the reviewed scope.",
};

/** Answers every turn by its schema; `returnNull` models a turn with no result. */
class Provider {
  readonly agent = "claude" as const;
  readonly sent: { sessionId: string; requestId: string; schema?: JsonSchema }[] = [];
  statusValue: ProviderStatus = "idle";
  returnNull = false;
  statusReads = 0;
  gate: Deferred<void> | null = null;
  private sessions = 0;

  registerSession(): void {}

  async createSession(): Promise<string> {
    this.sessions += 1;
    return `session-${this.sessions}`;
  }

  async send(sessionId: string, _prompt: string, options: ProviderSendOptions): Promise<void> {
    this.sent.push({ sessionId, requestId: options.requestId, schema: options.schema });
  }

  async status(): Promise<ProviderStatus> {
    this.statusReads += 1;
    if (this.gate) await this.gate.promise;
    return this.statusValue;
  }

  async messages(): Promise<unknown[]> {
    return [];
  }

  async structured<T>(_s: string, requestId: string): Promise<StructuredOutputResult<T> | null> {
    if (this.returnNull) return null;
    const send = this.sent.find((entry) => entry.requestId === requestId);
    const required = (send?.schema as { required?: string[] } | undefined)?.required ?? [];
    const value = required.includes("validation")
      ? { validation: [], uncommittedFiles: [], limitations: ["none"] }
      : required.includes("reviewScope")
        ? cleanReport
        : required.includes("issueOutcomes")
          ? {
              newIssues: [],
              issueUpdates: [],
              newCoverageGaps: [],
              coverageGapUpdates: [],
              issueOutcomes: [],
              coverageGapOutcomes: [],
            }
          : required.includes("url")
            ? { status: "created", url: "https://github.com/acme/repo/pull/7", summary: "Created." }
            : {
                complete: true,
                summary: "Fixed.",
                filesChanged: [],
                commandsRun: [],
                notes: [],
                limitations: [],
              };
    return { ok: true, provider: "claude", requestId, value: value as T };
  }

  async abort(): Promise<void> {}
  async dispose(): Promise<void> {}
}

const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
  if (command === "generate_looped_review_package") {
    const id = String(args.packageId);
    const sha256 = "a".repeat(64);
    return {
      kind: "file",
      id,
      round: args.round,
      preparedAt: new Date().toISOString(),
      targetBranch: args.targetBranch,
      baseRef: "aaaaaaa",
      headRef: "bbbbbbb",
      filePath: reviewPackageArtifactPath(id, sha256),
      sha256,
      bytes: 1_024,
      changedFileCount: 0,
      diffCharacters: 0,
      limitations: [],
    } as T;
  }
  if (command === "verify_looped_review_package") return { valid: true } as T;
  if (command === "verify_environment_pr") return { url: args.prUrl } as T;
  throw new Error(`Unexpected command: ${command}`);
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function environment(storage: StorageService, id: string) {
  await storage.addEnvironment({
    id,
    projectId: "project-1",
    name: id,
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
    worktreePath: `/tmp/${id}`,
    setupScriptsComplete: true,
  });
}

function startInput(environmentId: string) {
  return {
    environmentId,
    projectId: "project-1",
    agent: "claude" as const,
    model: "model",
    targetBranch: "main",
    allowance: 1,
  };
}

async function workflowOf(storage: StorageService, id: string): Promise<LoopedReviewWorkflow> {
  return (await storage.getLoopedReviewWorkflow(id))!.snapshot as LoopedReviewWorkflow;
}

/**
 * One persisted fixture for both drivers: `completed` finished reviews
 * (clones of one run to completion) and `active` reviews just started.
 */
async function fixture(options: { completed: number; active: number }) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-looped-keyed-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new Provider();
  const seeder = new LoopedReviewService(storage, invoke, {
    autoAdvance: false,
    keyedScheduling: false,
    provider: async () => provider as unknown as BuildPipelineProvider,
  });
  await seeder.init();
  const completed: string[] = [];
  if (options.completed > 0) {
    await environment(storage, "env-done");
    const done = await seeder.start(startInput("env-done"));
    for (let step = 0; step < 30; step += 1) {
      await seeder.advanceNow(done.id);
      if ((await workflowOf(storage, done.id)).phase === "completed") break;
    }
    const finished = await workflowOf(storage, done.id);
    expect(finished.phase).toBe("completed");
    for (let index = 0; index < options.completed; index += 1) {
      const id = `completed-${index}`;
      await storage.saveLoopedReviewWorkflow(
        id,
        "env-done",
        LOOPED_REVIEW_WORKFLOW_VERSION,
        { ...finished, id, backendRevision: 0 },
        0,
      );
      completed.push(id);
    }
  }
  const active: string[] = [];
  for (let index = 0; index < options.active; index += 1) {
    const environmentId = `env-${index}`;
    await environment(storage, environmentId);
    active.push((await seeder.start(startInput(environmentId))).id);
  }
  await seeder.shutdown();
  return { dataDir, storage, completed, active };
}

function keyed(
  storage: StorageService,
  provider: Provider,
  time: ManualTime,
  extra: ConstructorParameters<typeof LoopedReviewService>[2] = {},
) {
  const service = new LoopedReviewService(storage, invoke, {
    keyedScheduling: true,
    provider: async () => provider as unknown as BuildPipelineProvider,
    schedulerClock: { now: time.now, timers: time.timerFactory },
    ...extra,
  });
  cleanups.unshift(() => service.shutdown());
  return service;
}

describe("looped review obligations", () => {
  test("classify dispatch states, cancellation and outboxes; nothing terminal or parked", async () => {
    const context = await fixture({ completed: 1, active: 1 });
    const done = await workflowOf(context.storage, context.completed[0]!);
    const live = await workflowOf(context.storage, context.active[0]!);
    expect(loopedReviewObligation(done, true)).toBeNull();
    expect(loopedReviewObligation({ ...done, pendingResultConsumptions: ["k"] }, true)).toBe(
      "result-consumption",
    );
    // `start` already prepared the first turn.
    expect(loopedReviewObligation(live, true)).toBe("dispatch");
    expect(loopedReviewObligation({ ...live, dispatch: undefined }, true)).toBe("advance");
    const dispatch = {
      id: "d",
      requestId: "r",
      sessionId: "s",
      phase: "preparing" as const,
      kind: "prepare" as const,
      createdAt: new Date(0).toISOString(),
    };
    expect(
      loopedReviewObligation({ ...live, dispatch: { ...dispatch, state: "prepared" } }, true),
    ).toBe("dispatch");
    expect(
      loopedReviewObligation({ ...live, dispatch: { ...dispatch, state: "dispatching" } }, true),
    ).toBe("dispatch-reconciliation");
    expect(
      loopedReviewObligation({ ...live, dispatch: { ...dispatch, state: "sent" } }, true),
    ).toBe("await-result");
    expect(loopedReviewObligation({ ...live, phase: "cancelling" }, true)).toBe("cancelling");
    expect(loopedReviewObligation({ ...live, phase: "paused" }, true)).toBeNull();
    expect(loopedReviewObligation({ garbage: true }, false)).toBeNull();
    const cache = new Map<string, number>();
    const { result, validated } = await discoverLoopedReviews({
      list: () => context.storage.listAllLoopedReviewWorkflows(),
      read: (id) => context.storage.getLoopedReviewWorkflow(id),
      adopt: async () => undefined,
      validatedRevisions: cache,
    });
    expect(result.entries.map((entry) => entry.key)).toEqual(context.active);
    expect(validated.size).toBe(3);
  });
});

describe("LoopedReviewService keyed scheduling", () => {
  test("old and new drivers make the same transitions from one persisted fixture", async () => {
    const outcomes: Record<string, unknown> = {};
    for (const mode of ["legacy", "keyed"] as const) {
      const context = await fixture({ completed: 20, active: 2 });
      const provider = new Provider();
      const time = new ManualTime(0);
      const service =
        mode === "keyed"
          ? keyed(context.storage, provider, time)
          : new LoopedReviewService(context.storage, invoke, {
              autoAdvance: false,
              keyedScheduling: false,
              provider: async () => provider as unknown as BuildPipelineProvider,
            });
      if (mode === "legacy") cleanups.unshift(() => service.shutdown());
      await service.init();
      for (let step = 0; step < 40; step += 1) {
        if (mode === "legacy") {
          await (service as unknown as { requestTick(): Promise<void> }).requestTick();
        } else {
          await advanceKeyedWork(time, [service], 1_000);
        }
      }
      outcomes[mode] = {
        phases: await Promise.all(
          context.active.map(async (id) => (await workflowOf(context.storage, id)).phase),
        ),
        completedRevisions: await Promise.all(
          context.completed.map(
            async (id) => (await context.storage.getLoopedReviewWorkflow(id))!.revision,
          ),
        ),
        sends: provider.sent.length,
      };
    }
    expect(outcomes.keyed).toEqual(outcomes.legacy);
    expect((outcomes.keyed as { phases: string[] }).phases).toEqual(["completed", "completed"]);
  });

  test("retained history is enumerated only by the safety scan", async () => {
    const context = await fixture({ completed: 50, active: 0 });
    const provider = new Provider();
    const time = new ManualTime(0);
    const service = keyed(context.storage, provider, time, { discoveryIntervalMs: 30_000 });
    recurringWorkMetrics.reset();
    await service.init();
    await advanceKeyedWork(time, [service], 60_000, 1_000);
    const counters = recurringWorkMetrics.snapshot().kinds["looped-review-tick"]!;
    expect(counters.started).toBe(3);
    expect(counters.workUnits["record-scanned"]).toBe(3 * 51);
    expect(provider.statusReads).toBe(0);
  });

  test("lease renewal stays on time while every pass is blocked on a provider", async () => {
    const context = await fixture({ completed: 0, active: 3 });
    const provider = new Provider();
    provider.statusValue = "running";
    const time = new ManualTime(0);
    const service = keyed(context.storage, provider, time);
    await service.init();
    await advanceKeyedWork(time, [service], 3_000, 1_000);
    // Every workflow now waits on a hung status read.
    provider.gate = deferred();
    const renewals: number[] = [];
    const claim = context.storage.claimLoopedReviewController.bind(context.storage);
    context.storage.claimLoopedReviewController = async (...args) => {
      renewals.push(time.now());
      return claim(...args);
    };
    await advanceKeyedWork(time, [service], 15_000, 1_000, { allowInFlight: 3 });
    // Three held leases renewed on each 5 s critical deadline.
    expect(renewals.length).toBeGreaterThanOrEqual(3 * 3);
    provider.gate.resolve();
    provider.gate = null;
  });

  test("a stolen lease fences further mutation and is not renewed", async () => {
    const context = await fixture({ completed: 0, active: 1 });
    const [id] = context.active;
    const provider = new Provider();
    provider.statusValue = "running";
    const time = new ManualTime(0);
    const service = keyed(context.storage, provider, time);
    await service.init();
    await advanceKeyedWork(time, [service], 4_000, 1_000);
    const internals = service as unknown as {
      ownerId: string;
      leases: Map<string, { token: string }>;
    };
    const held = internals.leases.get(id!)!;
    // Another controller takes over once ours is released (as after expiry).
    await context.storage.releaseLoopedReviewController(id!, internals.ownerId, held.token);
    const thief = await context.storage.claimLoopedReviewController(id!, "thief", 15_000);
    expect(thief.granted).toBe(true);
    const revision = (await context.storage.getLoopedReviewWorkflow(id!))!.revision;
    const sends = provider.sent.length;
    provider.statusValue = "idle";
    await advanceKeyedWork(time, [service], 12_000, 1_000);
    expect(internals.leases.has(id!)).toBe(false);
    expect((await context.storage.getLoopedReviewWorkflow(id!))!.revision).toBe(revision);
    expect(provider.sent.length).toBe(sends);
  });

  test("a wakeup burst cannot exhaust the missing-result grace", async () => {
    const context = await fixture({ completed: 0, active: 1 });
    const [id] = context.active;
    const provider = new Provider();
    const time = new ManualTime(0);
    const service = keyed(context.storage, provider, time, { missingResultPollLimit: 3 });
    await service.init();
    await settleKeyedWork(time, [service]);
    provider.returnNull = true;
    // One pass moves the prepared turn to sent.
    await advanceKeyedWork(time, [service], 1_000);
    const workflow = await workflowOf(context.storage, id!);
    expect(workflow.dispatch?.state).toBe("sent");
    for (let index = 0; index < 10; index += 1) {
      service.wakeEnvironment(workflow.environmentId, "result-accepted");
      await settleKeyedWork(time, [service]);
    }
    const waiting = await workflowOf(context.storage, id!);
    expect(waiting.phase).not.toBe("failed");
    expect(waiting.structuredWait?.idlePolls ?? 0).toBeLessThanOrEqual(1);
    // The ordinary cadence still ends the grace after its three polls.
    await advanceKeyedWork(time, [service], 4_000, 1_000);
    expect((await workflowOf(context.storage, id!)).phase).toBe("failed");
  });

  test("startup discovery resumes an active review committed before a crash", async () => {
    const context = await fixture({ completed: 0, active: 1 });
    const [id] = context.active;
    const provider = new Provider();
    const time = new ManualTime(0);
    const service = keyed(context.storage, provider, time);
    await service.init();
    await advanceKeyedWork(time, [service], 30_000, 1_000);
    expect((await workflowOf(context.storage, id!)).phase).toBe("completed");
    expect(service.schedulingStatus()?.keys).toBe(0);
    // The completed record carries no lease: nothing is renewed forever.
    expect((await context.storage.getLoopedReviewWorkflow(id!))!.controllerLease).toBeUndefined();
  });
});
