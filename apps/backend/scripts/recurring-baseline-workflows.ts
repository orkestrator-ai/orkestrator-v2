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
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { reviewPackageArtifactPath } from "@orkestrator/protocol/review-artifacts";
import type { RecurringJobKind } from "@orkestrator/protocol/recurring-work";
import type { BuildPipelineProvider } from "../src/core/build-pipeline-provider.js";
import { BuildPipelineService } from "../src/core/build-pipeline-service.js";
import { testGeneratedReviewPackage } from "../src/core/build-pipeline-test-fixtures.js";
import { FeaturePlanningService } from "../src/core/feature-planning.js";
import { MultiReviewService } from "../src/core/multi-review-service.js";
import { parseReviewPackageReference } from "../src/core/review-package.js";
import { ManualTime, advanceKeyedWork } from "../src/core/recurring-test-support.js";
import { recurringWorkMetrics } from "../src/core/recurring-work-metrics.js";
import { StorageService } from "../src/core/storage.js";

/**
 * Drives the *real* feature-planning, build-pipeline and multi-review
 * supervisors over a fixture of many completed records and a few
 * active ones, in two modes:
 *
 * - `rollback`: what `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` selects. For
 *   feature planning and build pipelines that is the previous whole-store
 *   tick, stepped at its own interval (1 s / 1.5 s). Multi
 *   review's rollback is the adaptive `WorkflowDueScheduler`, driven on the
 *   same manual clock as the keyed mode (15 s reconciliation scan, per-workflow
 *   due passes).
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
  /**
   * Store content decoded for the supervisor (whole-store, owner and row
   * reads), whether the rows came from SQLite or the connection's cache.
   */
  storageReads: number;
  /** Revision checks that reused records already decoded (build pipelines' control cache). */
  storageStats: number;
  /**
   * Serialized length of the content those reads fetched from SQLite. A row
   * read charges its row, a whole-store read every row; cache-served reads
   * charge nothing.
   */
  storageBytes: number;
  /** Provider status/activity reads for the active records. */
  providerReads: number;
}

type Domain = "feature-planning" | "build-pipeline" | "multi-review";
const KINDS: Record<Domain, RecurringJobKind> = {
  "feature-planning": "feature-planning-tick",
  "build-pipeline": "build-supervisor-tick",
  "multi-review": "multi-review-tick",
};
const LEGACY_TICK_MS: Record<Domain, number> = {
  "feature-planning": 1_000,
  "build-pipeline": 1_500,
  "multi-review": 1_000,
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
  async prepareDispatch(): Promise<void> {}
  async observeSession() {
    return { status: await this.status() };
  }
  async transcriptSnapshot(_sessionId: string, options: { knownSourceToken?: string }) {
    // The transcript never moves while the turn runs.
    if (options.knownSourceToken === "rev-1") {
      return { unchanged: true as const, sourceToken: "rev-1" };
    }
    return { messages: [], sourceToken: "rev-1", complete: true };
  }
  async abort(): Promise<void> {}
  async dispose(): Promise<void> {}
}

const reviewInvoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
  if (command === "generate_review_package") {
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
  if (command === "verify_review_package") return { valid: true } as T;
  if (command === "get_environment_uncommitted_paths") {
    return { head: "1".repeat(40), paths: [] } as T;
  }
  return undefined as T;
};

/** Multi review also checks the worktree fingerprint it captured at start. */
const multiReviewInvoke = async <T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> => {
  if (command === "generate_review_package") return testGeneratedReviewPackage(args) as T;
  if (command === "get_environment_uncommitted_paths") {
    return { head: "1".repeat(40), paths: [], fingerprint: "a".repeat(64) } as T;
  }
  return reviewInvoke<T>(command, args);
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
    const plan = await storage.kanban.createFeaturePlan("project-1");
    await storage.kanban.updateFeaturePlan(plan.id, { codexEnvironmentId: "env-planning" });
    await storage.kanban.startFeaturePlanning(
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

async function seedMultiReviews(storage: StorageService, fixture: WorkflowFixture) {
  const provider = new BusyProvider("claude");
  const seeder = new MultiReviewService(storage, multiReviewInvoke, {
    autoAdvance: false,
    keyedScheduling: false,
    provider: async () => provider as unknown as BuildPipelineProvider,
  });
  const timestamp = new Date().toISOString();
  const workflow = (id: string, environmentId: string): MultiReviewWorkflow => ({
    version: 1,
    controller: "backend",
    id,
    environmentId,
    projectId: "project-1",
    targetBranch: "main",
    autoFix: false,
    reviewers: [1, 2].map((index) => ({
      id: `reviewer-${index}`,
      agent: "claude" as const,
      model: "model",
      status: "pending" as const,
    })),
    fixModel: { agent: "claude", model: "model" },
    reviewWorktreeSnapshot: {
      status: "clean",
      head: "1".repeat(40),
      paths: [],
      fingerprint: "a".repeat(64),
      capturedAt: timestamp,
    },
    reviewPackage: parseReviewPackageReference(
      testGeneratedReviewPackage({ packageId: `package-${id}`, round: 1, targetBranch: "main" }),
      { id: `package-${id}`, round: 1, targetBranch: "main" },
    ),
    phase: "reviewing",
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 0,
  });
  let template: MultiReviewWorkflow | null = null;
  for (let index = 0; index < fixture.activePerStore; index += 1) {
    const environmentId = `env-multi-${index}`;
    await addEnvironment(storage, environmentId);
    const id = `active-multi-${index}`;
    await storage.createMultiReviewWorkflowIfNoActive(
      id,
      environmentId,
      1,
      workflow(id, environmentId),
    );
    // Dispatch both reviewers, whose turns then stay running.
    await seeder.advanceNow(id);
    template ??= (await storage.getMultiReviewWorkflow(id))!.snapshot as MultiReviewWorkflow;
  }
  await seeder.shutdown();
  for (let index = 0; index < fixture.completedPerStore; index += 1) {
    const id = `completed-multi-${index}`;
    await storage.saveMultiReviewWorkflow(id, template!.environmentId, 1, {
      ...template!,
      id,
      phase: "completed",
      reviewers: template!.reviewers.map((reviewer) => ({ ...reviewer, status: "completed" })),
      controllerFence: undefined,
      backendRevision: 0,
    });
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
  let owner: Owner | undefined;
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
      await seedMultiReviews(storage, fixture);
      provider = new BusyProvider("claude");
      owner = new MultiReviewService(storage, multiReviewInvoke, {
        keyedScheduling: keyed,
        ...clock,
        provider: async () => provider as unknown as BuildPipelineProvider,
      });
    }
    recurringWorkMetrics.reset();
    await owner.init();
    if (keyed) {
      await advanceKeyedWork(time, [owner], fixture.windowMs, LEGACY_TICK_MS[domain]);
    } else if (domain === "multi-review") {
      // The due scheduler is not the keyed supervisor, so its own in-flight
      // count tells the settle loop when real storage I/O has finished.
      const scheduler = (owner as unknown as { scheduler: { inFlight: number } }).scheduler;
      await advanceKeyedWork(
        time,
        [{ schedulingStatus: () => ({ inFlight: scheduler.inFlight }) }],
        fixture.windowMs,
        LEGACY_TICK_MS[domain],
      );
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
      storageStats: counters?.workUnits["storage-stat"] ?? 0,
      storageBytes: counters?.bytes ?? 0,
      providerReads: provider.reads,
    };
  } finally {
    await owner?.shutdown().catch(() => undefined);
    // Closed before the directory goes, so no snapshot timer outlives it.
    storage.close();
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
