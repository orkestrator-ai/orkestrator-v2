import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BUILD_PIPELINE_VERSION,
  type BuildPipeline,
  type PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import {
  FEATURE_PLANNING_RECORD_VERSION,
  type FeaturePlanningRecord,
} from "@orkestrator/protocol/feature-planning";
import {
  LOOPED_REVIEW_WORKFLOW_VERSION,
  type LoopedReviewWorkflow,
} from "@orkestrator/protocol/review-workflow";
import { reviewPackageArtifactPath } from "@orkestrator/protocol/review-artifacts";
import type { RecurringJobKind } from "@orkestrator/protocol/recurring-work";
import type { BuildPipelineProvider } from "../src/core/build-pipeline-provider.js";
import { BuildPipelineService } from "../src/core/build-pipeline-service.js";
import { FeaturePlanningService } from "../src/core/feature-planning.js";
import { LoopedReviewService } from "../src/core/looped-review-service.js";
import { ManualTime, advanceKeyedWork } from "../src/core/recurring-test-support.js";
import { recurringWorkMetrics } from "../src/core/recurring-work-metrics.js";
import { StorageService } from "../src/core/storage.js";

/**
 * Drives the *real* feature-planning, build-pipeline and looped-review
 * supervisors (recurring-processes step 08) over a fixture of many completed
 * records and a few active ones, in two modes:
 *
 * - `rollback`: the previous whole-store tick, stepped at its own interval
 *   (1 s / 1.5 s / 1 s) — `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK`.
 * - `keyed`: the keyed supervisor on a manual clock, with the 30 s safety
 *   discovery.
 *
 * Storage is a real `StorageService` in a temporary directory; providers are
 * fakes that keep every active turn busy for the whole window, so the counts
 * measure selection and supervision cost, not workflow progress. Only counts
 * leave this module.
 */

export interface WorkflowFixture {
  completedPerStore: number;
  activePerStore: number;
  windowMs: number;
}

export const DEFAULT_WORKFLOW_FIXTURE: WorkflowFixture = {
  completedPerStore: 200,
  activePerStore: 2,
  windowMs: 10 * 60_000,
};

export interface WorkflowDomainCounts {
  /** Recorded attempts (whole-store ticks, or key passes + discoveries). */
  attempts: number;
  recordsScanned: number;
  recordsSelected: number;
  storageReads: number;
  /** Provider status/activity reads for the active records. */
  providerReads: number;
}

type Domain = "feature-planning" | "build-pipeline" | "looped-review";
const KINDS: Record<Domain, RecurringJobKind> = {
  "feature-planning": "feature-planning-tick",
  "build-pipeline": "build-supervisor-tick",
  "looped-review": "looped-review-tick",
};
const LEGACY_TICK_MS: Record<Domain, number> = {
  "feature-planning": 1_000,
  "build-pipeline": 1_500,
  "looped-review": 1_000,
};

export interface WorkflowBaselineResult {
  fixture: WorkflowFixture;
  modes: {
    rollback: Record<Domain, WorkflowDomainCounts>;
    keyed: Record<Domain, WorkflowDomainCounts>;
  };
}

/** A provider whose every turn is running for the whole window. */
class BusyProvider {
  readonly agent: "claude" | "codex";
  reads = 0;
  private sessions = 0;

  constructor(agent: "claude" | "codex") {
    this.agent = agent;
  }

  registerSession(): void {}
  async createSession(phase?: PipelineSessionPhase | string): Promise<string> {
    this.sessions += 1;
    return `${String(phase ?? "session")}-${this.sessions}`;
  }
  async send(): Promise<void> {}
  async status() {
    this.reads += 1;
    return "running" as const;
  }
  async activity() {
    this.reads += 1;
    return "working" as const;
  }
  async messages(): Promise<unknown[]> {
    return [];
  }
  async structured(): Promise<null> {
    return null;
  }
  async settleTurn(): Promise<boolean> {
    return true;
  }
  async abort(): Promise<void> {}
  async dispose(): Promise<void> {}
}

const reviewInvoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
  if (command === "generate_looped_review_package") {
    const id = String(args.packageId);
    const sha256 = "a".repeat(64);
    return {
      kind: "file",
      id,
      round: args.round,
      preparedAt: new Date(0).toISOString(),
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
  if (command === "get_environment_uncommitted_paths") {
    return { head: "1".repeat(40), paths: [] } as T;
  }
  return undefined as T;
};

async function addEnvironment(storage: StorageService, id: string): Promise<void> {
  await storage.addEnvironment({
    id,
    projectId: "project-1",
    name: "fixture",
    branch: "fixture",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: `/fixture/${id}`,
    setupScriptsComplete: true,
  } as Parameters<StorageService["addEnvironment"]>[0]);
}

async function seedFeaturePlanning(storage: StorageService, fixture: WorkflowFixture) {
  const timestamp = new Date().toISOString();
  const record = (featureId: string, phase: FeaturePlanningRecord["phase"]) =>
    ({
      version: FEATURE_PLANNING_RECORD_VERSION,
      operationId: `operation-${featureId}`,
      featureId,
      projectId: "project-1",
      kind: "feature",
      userMessage: "synthetic",
      environmentId: "env-planning",
      phase,
      startedAt: timestamp,
      attemptStartedAt: timestamp,
      dispatchId: `dispatch-${featureId}`,
      dispatchState: "sent",
      providerSessionId: `session-${featureId}`,
      dispatchedAt: timestamp,
      updatedAt: timestamp,
      backendRevision: 0,
    }) satisfies FeaturePlanningRecord;
  await addEnvironment(storage, "env-planning");
  for (let index = 0; index < fixture.completedPerStore + fixture.activePerStore; index += 1) {
    const plan = await storage.createFeaturePlan("project-1");
    await storage.updateFeaturePlan(plan.id, { codexEnvironmentId: "env-planning" });
    await storage.startFeaturePlanning(
      record(plan.id, index < fixture.completedPerStore ? "complete" : "running"),
    );
  }
}

async function seedBuildPipelines(storage: StorageService, fixture: WorkflowFixture) {
  const provider = new BusyProvider("claude");
  const seeder = new BuildPipelineService(storage, reviewInvoke, {
    autoAdvance: false,
    keyedScheduling: false,
    provider: async () => provider as unknown as BuildPipelineProvider,
  });
  let template: { id: string; snapshot: BuildPipeline } | null = null;
  for (let index = 0; index < fixture.activePerStore + 1; index += 1) {
    const environmentId = `env-build-${index}`;
    await addEnvironment(storage, environmentId);
    const started = await seeder.start({
      taskId: `task-${index}`,
      projectId: "project-1",
      environmentType: "local",
      agentType: "claude",
      taskTitle: "Synthetic",
      taskSnapshot: {
        title: "Synthetic",
        description: "Synthetic",
        acceptanceCriteria: "Synthetic",
        comments: [],
        images: [],
      },
      existingEnvironmentId: environmentId,
    });
    await seeder.advanceNow(started.id);
    await seeder.advanceNow(started.id);
    if (index === fixture.activePerStore) {
      template = {
        id: started.id,
        snapshot: (await storage.getBuildPipeline(started.id))!.snapshot as BuildPipeline,
      };
    }
  }
  await seeder.shutdown();
  // Completed history: clones of one pipeline, marked complete.
  await storage.deleteBuildPipeline(template!.id);
  for (let index = 0; index < fixture.completedPerStore; index += 1) {
    const id = `completed-build-${index}`;
    await storage.saveBuildPipeline(
      id,
      "project-1",
      template!.snapshot.environmentId,
      BUILD_PIPELINE_VERSION,
      { ...template!.snapshot, id, taskId: `done-${index}`, phase: "complete", backendRevision: 1 },
      0,
    );
  }
}

async function seedLoopedReviews(storage: StorageService, fixture: WorkflowFixture) {
  const provider = new BusyProvider("claude");
  const seeder = new LoopedReviewService(storage, reviewInvoke, {
    autoAdvance: false,
    keyedScheduling: false,
    provider: async () => provider as unknown as BuildPipelineProvider,
  });
  await seeder.init();
  let template: LoopedReviewWorkflow | null = null;
  for (let index = 0; index < fixture.activePerStore; index += 1) {
    const environmentId = `env-review-${index}`;
    await addEnvironment(storage, environmentId);
    const started = await seeder.start({
      environmentId,
      projectId: "project-1",
      agent: "claude",
      model: "model",
      targetBranch: "main",
      allowance: 1,
    });
    // Dispatch the first turn, which then stays running.
    await seeder.advanceNow(started.id);
    template ??= (await storage.getLoopedReviewWorkflow(started.id))!
      .snapshot as LoopedReviewWorkflow;
  }
  await seeder.shutdown();
  for (let index = 0; index < fixture.completedPerStore; index += 1) {
    const id = `completed-review-${index}`;
    // Cancelled history carries the same retained snapshot shape as a
    // completed one without needing a full run to produce it.
    await storage.saveLoopedReviewWorkflow(
      id,
      template!.environmentId,
      LOOPED_REVIEW_WORKFLOW_VERSION,
      {
        ...template!,
        id,
        phase: "cancelled",
        dispatch: undefined,
        controllerFence: undefined,
        backendRevision: 0,
      },
      0,
    );
  }
}

interface Owner {
  init(): Promise<void>;
  shutdown(): Promise<void>;
  schedulingStatus(): { inFlight: number } | null;
}

async function runDomain(
  domain: Domain,
  mode: "rollback" | "keyed",
  fixture: WorkflowFixture,
): Promise<WorkflowDomainCounts> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `ork-workflow-baseline-${domain}-`));
  const storage = new StorageService(dataDir);
  await storage.init();
  const time = new ManualTime(0);
  const keyed = mode === "keyed";
  const clock = { schedulerClock: { now: time.now, timers: time.timerFactory } };
  let provider: BusyProvider;
  let owner: Owner;
  try {
    if (domain === "feature-planning") {
      await seedFeaturePlanning(storage, fixture);
      provider = new BusyProvider("codex");
      owner = new FeaturePlanningService(storage, reviewInvoke, {
        keyedScheduling: keyed,
        ...(keyed ? clock : { autoAdvance: false }),
        provider: async () => provider as unknown as BuildPipelineProvider,
      });
    } else if (domain === "build-pipeline") {
      await seedBuildPipelines(storage, fixture);
      provider = new BusyProvider("claude");
      owner = new BuildPipelineService(storage, reviewInvoke, {
        keyedScheduling: keyed,
        ...(keyed ? clock : { autoAdvance: false }),
        provider: async () => provider as unknown as BuildPipelineProvider,
      });
    } else {
      await seedLoopedReviews(storage, fixture);
      provider = new BusyProvider("claude");
      owner = new LoopedReviewService(storage, reviewInvoke, {
        keyedScheduling: keyed,
        ...(keyed ? clock : { autoAdvance: false }),
        provider: async () => provider as unknown as BuildPipelineProvider,
      });
    }
    recurringWorkMetrics.reset();
    await owner.init();
    if (keyed) {
      await advanceKeyedWork(time, [owner], fixture.windowMs, LEGACY_TICK_MS[domain]);
    } else {
      const tick = (owner as unknown as { requestTick(): Promise<void> }).requestTick.bind(owner);
      for (let elapsed = 0; elapsed < fixture.windowMs; elapsed += LEGACY_TICK_MS[domain]) {
        await tick();
      }
    }
    const counters = recurringWorkMetrics.snapshot().kinds[KINDS[domain]];
    return {
      attempts: counters?.started ?? 0,
      recordsScanned: counters?.workUnits["record-scanned"] ?? 0,
      recordsSelected: counters?.workUnits["record-selected"] ?? 0,
      storageReads: counters?.workUnits["storage-read"] ?? 0,
      providerReads: provider.reads,
    };
  } finally {
    await owner!?.shutdown().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function runWorkflowBaseline(
  fixture: WorkflowFixture = DEFAULT_WORKFLOW_FIXTURE,
): Promise<WorkflowBaselineResult> {
  const modes = { rollback: {}, keyed: {} } as WorkflowBaselineResult["modes"];
  for (const mode of ["rollback", "keyed"] as const) {
    for (const domain of Object.keys(KINDS) as Domain[]) {
      modes[mode][domain] = await runDomain(domain, mode, fixture);
    }
  }
  return { fixture, modes };
}
