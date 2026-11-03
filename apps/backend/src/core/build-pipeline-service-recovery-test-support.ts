/**
 * The scripted provider and service set-up shared by the build pipeline recovery
 * and user-message suites.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildPipeline, PipelineSessionPhase } from "@orkestrator/protocol/build-pipeline";
import { type StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { NativeAgentSessionActionOutcome } from "@orkestrator/protocol/native-agent";
import type { ProviderActiveSteerRun, ProviderDispatchStatus } from "./agent-provider-contract.js";
import { StorageService } from "./storage.js";
import { BuildPipelineService } from "./build-pipeline-service.js";
import {
  type BuildPipelineProvider,
  type ProviderExecutionMode,
  type ProviderStatus,
} from "./build-pipeline-provider.js";
import {
  TEST_FIX_RESULT,
  TEST_REVIEW_PREPARATION,
  testGeneratedReviewPackage,
} from "./build-pipeline-test-fixtures.js";

export const cleanReview: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "base",
    commit: { sha: "head", subject: "feat: build" },
    filesReviewed: ["src/app.ts"],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [{ command: "bun test", result: "passed", summary: "Passed" }],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "Implemented the task.",
    before: "Missing.",
    after: "Present.",
    keyCodeChanges: [
      {
        file: "src/app.ts",
        line: 1,
        description: "Adds the feature.",
      },
    ],
    userImpact: "The feature is available.",
  },
  riskProfile: {
    changeTypes: ["feature"],
    riskAreas: [],
    overallRisk: "low",
    reasoning: "Small change.",
  },
  testResults: { total: 1, passed: 1, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready." },
  summaryOfChange: "Implemented the task.",
  reviewSummary: "No findings.",
};

export const CLEAN_GIT_STATE = {
  head: "1111111111111111111111111111111111111111",
  paths: [],
} as const;

export const reviewWithIssues: StructuredReviewReport = {
  ...cleanReview,
  issues: [
    {
      severity: "P1",
      confidence: 90,
      category: "correctness",
      title: "Off-by-one in the range check",
      file: "src/app.ts",
      line: 12,
      symbol: "clamp",
      description: "The upper bound is exclusive where it should be inclusive.",
      evidence: "clamp(10) returns 9.",
      suggestion: "Use <= for the upper bound.",
      verification: "Add a boundary test for the maximum.",
    },
  ],
  verdict: { ready: "with-fixes", reasoning: "One real bug." },
  reviewSummary: "One issue found.",
};

/**
 * A provider whose every call can be scripted per test.
 *
 * The happy-path fake always succeeds, which is what leaves the retry and
 * reconnect branches unexercised. This one lets a test make exactly one call
 * fail, in exactly one way, and then observe what the supervisor persisted.
 */
export class ScriptedProvider implements BuildPipelineProvider {
  readonly agent = "claude" as const;
  readonly phases = new Map<string, PipelineSessionPhase>();
  readonly sent: Array<{
    sessionId: string;
    prompt: string;
    requestId: string;
    mode?: ProviderExecutionMode;
    schema?: JsonSchema;
    model?: string;
  }> = [];
  readonly registered: string[] = [];
  disposed = 0;

  statusOverride: ProviderStatus | null = null;
  /** Queue of errors; each send() shifts one and throws it when present. */
  sendErrors: unknown[] = [];
  /**
   * What `dispatchStatus` answers. By default a bridge with a complete
   * journal: `dispatched` for an id it took, `absent` for one it never did
   * (a scripted send error happens before the bridge takes anything).
   */
  dispatchAnswer: ProviderDispatchStatus | null = null;
  readonly dispatchReads: string[] = [];
  /** Ordered attach/send trace, so the two can be asserted against each other. */
  readonly dispatchTrace: string[] = [];
  prepareDispatchError: unknown = null;
  statusError: unknown = null;
  structuredResult: StructuredOutputResult<unknown> | null | "absent" = "absent";
  messagesBySession = new Map<string, unknown[]>();

  /** Steering is on by default; a test turns it off to model a bridge that cannot. */
  steerQualified = true;
  steerOutcome: NativeAgentSessionActionOutcome = { outcome: "applied" };
  readonly steers: Array<{
    sessionId: string;
    text: string;
    requestId: string;
    expectedRunId: string;
  }> = [];

  private counter = 0;
  private running = new Set<string>();

  async steerSupported(): Promise<boolean> {
    return this.steerQualified;
  }

  async activeSteerRun(sessionId: string): Promise<ProviderActiveSteerRun> {
    return this.running.has(sessionId)
      ? { state: "running", runId: `run-${sessionId}` }
      : { state: "idle" };
  }

  async performSessionAction(
    sessionId: string,
    action: { kind: string; text?: string; requestId?: string; expectedRunId?: string },
  ): Promise<NativeAgentSessionActionOutcome> {
    if (action.kind !== "steer") throw new Error(`unexpected action ${action.kind}`);
    this.steers.push({
      sessionId,
      text: action.text!,
      requestId: action.requestId!,
      expectedRunId: action.expectedRunId!,
    });
    return this.steerOutcome;
  }

  registerSession(sessionId: string): void {
    this.registered.push(sessionId);
  }

  async createSession(phase: PipelineSessionPhase): Promise<string> {
    const id = `${phase}-${++this.counter}`;
    this.phases.set(id, phase);
    return id;
  }

  async prepareDispatch(sessionId: string): Promise<void> {
    this.dispatchTrace.push(`attach:${sessionId}`);
    if (this.prepareDispatchError) throw this.prepareDispatchError;
  }

  async send(
    sessionId: string,
    prompt: string,
    options: {
      requestId: string;
      schema?: JsonSchema;
      mode?: ProviderExecutionMode;
      model?: string;
    },
  ): Promise<void> {
    this.dispatchTrace.push(`send:${sessionId}`);
    const error = this.sendErrors.shift();
    if (error) throw error;
    this.sent.push({
      sessionId,
      prompt,
      requestId: options.requestId,
      mode: options.mode,
      schema: options.schema,
      model: options.model,
    });
    this.running.delete(sessionId);
  }

  async dispatchStatus(_sessionId: string, requestId: string): Promise<ProviderDispatchStatus> {
    this.dispatchReads.push(requestId);
    if (this.dispatchAnswer) return this.dispatchAnswer;
    return this.sent.some((entry) => entry.requestId === requestId) ? "dispatched" : "absent";
  }

  async status(sessionId: string): Promise<ProviderStatus> {
    if (this.statusError) throw this.statusError;
    if (this.statusOverride) return this.statusOverride;
    return this.running.has(sessionId) ? "running" : "idle";
  }

  markRunning(sessionId: string): void {
    this.running.add(sessionId);
  }

  markIdle(sessionId: string): void {
    this.running.delete(sessionId);
  }

  async messages(sessionId: string): Promise<unknown[]> {
    return (
      this.messagesBySession.get(sessionId) ?? [
        { id: `${sessionId}-assistant`, role: "assistant", parts: [] },
      ]
    );
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    if (this.structuredResult === "absent") {
      if (!this.sent.some((entry) => entry.requestId === requestId)) return null;
      const phase = this.phases.get(sessionId);
      return {
        ok: true,
        provider: "claude",
        requestId,
        value: (phase === "review"
          ? cleanReview
          : phase === "build" || phase === "fix"
            ? TEST_REVIEW_PREPARATION
            : phase === "address"
              ? TEST_FIX_RESULT
              : { complete: true, rationale: "All criteria pass." }) as T,
      };
    }
    return this.structuredResult as StructuredOutputResult<T> | null;
  }

  async abort(): Promise<void> {}

  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

export type ServiceOptions = ConstructorParameters<typeof BuildPipelineService>[2];

export async function withService(
  run: (context: {
    service: BuildPipelineService;
    dataDir: string;
    storage: StorageService;
    provider: ScriptedProvider;
    invocations: Array<{ command: string; args: Record<string, unknown> }>;
    packageGeneration: { count: number; error: Error | null; verificationValid: boolean };
  }) => Promise<void>,
  options: ServiceOptions = {},
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-recovery-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "build",
    branch: "build",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/build",
    setupScriptsComplete: true,
  });
  const provider = new ScriptedProvider();
  const kanbanTasks = new Map<
    string,
    {
      id: string;
      status: string;
      prUrl?: string;
      prState?: string;
      comments: Array<{ text: string }>;
    }
  >([["task-default", { id: "task-default", status: "backlog", comments: [] }]]);
  const invocations: Array<{
    command: string;
    args: Record<string, unknown>;
  }> = [];
  const packageGeneration = {
    count: 0,
    error: null as Error | null,
    verificationValid: true,
  };
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    invocations.push({ command, args });
    if (command === "detect_pr_local") {
      return {
        url: "https://github.com/acme/repo/pull/1",
        state: "open",
        hasMergeConflicts: false,
      } as T;
    }
    if (command === "get_environment_uncommitted_paths") {
      return CLEAN_GIT_STATE as T;
    }
    if (command === "generate_review_package") {
      packageGeneration.count += 1;
      if (packageGeneration.error) throw packageGeneration.error;
      const generated = testGeneratedReviewPackage(args);
      const head = String(packageGeneration.count).repeat(40);
      generated.headRef = head;
      return generated as T;
    }
    if (command === "verify_review_package") {
      return {
        valid: packageGeneration.verificationValid,
        ...(packageGeneration.verificationValid ? {} : { reason: "artifact is missing" }),
      } as T;
    }
    if (command === "get_kanban_tasks") {
      return [...kanbanTasks.values()] as T;
    }
    if (command === "update_kanban_task") {
      const task = kanbanTasks.get(String(args.taskId));
      if (task) Object.assign(task, args);
      return task as T;
    }
    return undefined as T;
  };
  const service = new BuildPipelineService(storage, invoke, {
    autoAdvance: false,
    provider: async () => provider,
    ...options,
  });
  try {
    await run({ service, dataDir, storage, provider, invocations, packageGeneration });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

export async function snapshot(storage: StorageService, id: string): Promise<BuildPipeline> {
  const stored = await storage.getBuildPipeline(id);
  if (!stored) throw new Error("Pipeline disappeared");
  return stored.snapshot as BuildPipeline;
}

export function startInput(
  overrides: Partial<Parameters<BuildPipelineService["start"]>[0]> = {},
): Parameters<BuildPipelineService["start"]>[0] {
  return {
    taskId: "task-default",
    projectId: "project-1",
    environmentType: "local",
    agentType: "claude",
    taskTitle: "Backend pipeline",
    taskSnapshot: {
      title: "Backend pipeline",
      description: "Move the runner",
      acceptanceCriteria: "No renderer orchestration",
      comments: [],
      images: [],
    },
    existingEnvironmentId: "env-1",
    ...overrides,
  };
}

/**
 * Drives the pipeline to the pass that is about to start the build stage.
 *
 * start() commits the source link, the first pass configures and starts the
 * environment, and only the pass after that runs setup and opens the build
 * session — so a test that wants to interfere with the build dispatch has to
 * stop here rather than at start().
 */
export async function startAtSetup(
  service: BuildPipelineService,
  storage: StorageService,
  overrides: Parameters<typeof startInput>[0] = {},
): Promise<BuildPipeline> {
  const started = await service.start(startInput(overrides));
  await service.advanceNow(started.id);
  return snapshot(storage, started.id);
}

/** Drives the pipeline to its first running build session. */
export async function startBuilding(
  service: BuildPipelineService,
  storage: StorageService,
  overrides: Parameters<typeof startInput>[0] = {},
): Promise<BuildPipeline> {
  const staged = await startAtSetup(service, storage, overrides);
  await service.advanceNow(staged.id);
  return snapshot(storage, staged.id);
}
