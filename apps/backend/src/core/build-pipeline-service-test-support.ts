import { expect } from "bun:test";

import { promises as fs } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import type {
  BuildPipeline,
  PipelineSession,
  PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";

import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";

import { type StructuredReviewReport } from "@orkestrator/protocol/structured-review";

import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";

import { StorageService } from "./storage.js";

import { BuildPipelineService } from "./build-pipeline-service.js";

import type {
  BuildPipelineProvider,
  ProviderCreateSessionOptions,
  ProviderSessionRegistration,
  ProviderStatus,
} from "./build-pipeline-provider.js";
import { WorkflowResultService } from "./workflow-result-service.js";
import type { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import type { EnvironmentGit } from "./build-pipeline-code-rewind.js";
import type { WorkspaceWriters } from "./workspace-writers.js";
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
  testResults: {
    total: 1,
    passed: 1,
    failed: 0,
    notRun: 0,
    failures: [],
  },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready." },
  summaryOfChange: "Implemented the task.",
  reviewSummary: "No findings.",
};

export class FakeProvider implements BuildPipelineProvider {
  readonly agent = "claude" as const;
  readonly phases = new Map<string, PipelineSessionPhase>();
  readonly sent: Array<{
    sessionId: string;
    requestId: string;
    prompt: string;
    schema?: JsonSchema;
    mode?: "plan" | "build";
  }> = [];
  readonly created: Array<{
    phase: PipelineSessionPhase;
    label: string;
    options?: ProviderCreateSessionOptions;
  }> = [];
  readonly registered: Array<{
    sessionId: string;
    interaction?: ProviderSessionRegistration;
  }> = [];
  readonly aborted: string[] = [];
  readonly runningPhases = new Set<PipelineSessionPhase>();
  statusValue: ProviderStatus = "idle";
  private counter = 0;

  registerSession(sessionId: string, interaction?: ProviderSessionRegistration): void {
    this.registered.push({ sessionId, interaction });
  }

  async createSession(
    phase: PipelineSessionPhase,
    label: string,
    options?: ProviderCreateSessionOptions,
  ): Promise<string> {
    this.created.push({ phase, label, options });
    const id = `${phase}-${++this.counter}`;
    this.phases.set(id, phase);
    return id;
  }

  async send(
    sessionId: string,
    prompt: string,
    options: { requestId: string; schema?: JsonSchema; mode?: "plan" | "build" },
  ): Promise<void> {
    this.sent.push({
      sessionId,
      requestId: options.requestId,
      prompt,
      schema: options.schema,
      mode: options.mode,
    });
  }

  async status(sessionId: string): Promise<ProviderStatus> {
    if (this.runningPhases.has(this.phases.get(sessionId)!)) return "running";
    return this.statusValue;
  }

  async messages(sessionId: string): Promise<unknown[]> {
    return [
      {
        id: `${sessionId}-assistant`,
        role: "assistant",
        parts: [{ type: "text", content: "Finished" }],
      },
    ];
  }

  async structured<T>(sessionId: string, requestId: string): Promise<StructuredOutputResult<T>> {
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

  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
  }
}

export async function withService(
  run: (
    service: BuildPipelineService,
    storage: StorageService,
    provider: FakeProvider,
    invocations: Array<{ command: string; args: Record<string, unknown> }>,
    controls: {
      dataDir: string;
      detection: {
        url: string;
        state: "open" | "merged" | "closed";
        hasMergeConflicts: boolean | null;
      } | null;
      failCommands: Set<string>;
      failCommandsOnce: Map<string, number>;
      currentHead: string;
      uncommittedPaths: string[];
      workflowResults?: WorkflowResultService;
      kanbanTasks: Map<
        string,
        {
          id: string;
          status: string;
          prUrl?: string;
          prState?: string;
          comments: Array<{ text: string }>;
        }
      >;
    },
  ) => Promise<void>,
  options: {
    toolMode?: boolean;
    workflowResultsWithoutTools?: boolean;
    completeEmptyValidation?: boolean;
    /** Defaults to a local worktree environment. */
    environmentType?: "local" | "containerized";
    assertAgentToolsReachable?: (environmentId: string, stage: string) => Promise<void>;
    /** Git in the environment worktree, for code-rewind tests. */
    environmentGit?: EnvironmentGit;
    environmentFence?: EnvironmentMutationFence;
    assertEnvironmentQuiescent?: (environmentId: string) => Promise<void>;
    /** D3 across engines: the shared workspace-holder projection. */
    workspaceWriters?: (storage: StorageService) => WorkspaceWriters;
  } = {},
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-runner-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "build",
    branch: "build",
    containerId: options.environmentType === "containerized" ? "container-1" : null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: options.environmentType ?? "local",
    worktreePath: "/tmp/build",
    setupScriptsComplete: true,
  });
  const provider = new FakeProvider();
  const invocations: Array<{
    command: string;
    args: Record<string, unknown>;
  }> = [];
  const kanbanTasks = new Map<
    string,
    {
      id: string;
      status: string;
      prUrl?: string;
      prState?: string;
      comments: Array<{ text: string }>;
    }
  >();
  const controls = {
    dataDir,
    detection: {
      url: "https://github.com/acme/repo/pull/1",
      state: "open" as const,
      hasMergeConflicts: false,
    } as {
      url: string;
      state: "open" | "merged" | "closed";
      hasMergeConflicts: boolean | null;
    } | null,
    failCommands: new Set<string>(),
    // Counts down a command's remaining transient failures, so a test can make
    // a probe fail once and then succeed rather than only fail forever.
    failCommandsOnce: new Map<string, number>(),
    currentHead: "1111111111111111111111111111111111111111",
    uncommittedPaths: [] as string[],
    kanbanTasks,
    ...(options.toolMode || options.workflowResultsWithoutTools
      ? { workflowResults: new WorkflowResultService(dataDir) }
      : {}),
  };
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    invocations.push({ command, args });
    if (controls.failCommands.has(command)) {
      throw new Error(`${command} failed`);
    }
    const transient = controls.failCommandsOnce.get(command) ?? 0;
    if (transient > 0) {
      controls.failCommandsOnce.set(command, transient - 1);
      throw new Error(`${command} failed transiently`);
    }
    if (command === "detect_pr_local" || command === "detect_pr") {
      return controls.detection as T;
    }
    if (command === "get_environment_uncommitted_paths") {
      return {
        head: controls.currentHead,
        paths: [...controls.uncommittedPaths],
      } as T;
    }
    if (command === "generate_review_package") {
      return testGeneratedReviewPackage(args) as T;
    }
    if (command === "verify_review_package") return { valid: true } as T;
    if (command === "cancel_review_validation") {
      const run = args.run as NonNullable<BuildPipeline["validationRun"]>;
      return { ...run, status: "cancelled" } as T;
    }
    if (command === "start_review_validation" || command === "status_review_validation") {
      const run = args.run as NonNullable<BuildPipeline["validationRun"]>;
      return {
        ...run,
        status:
          options.completeEmptyValidation && run.plan.commands.length === 0
            ? "completed"
            : "running",
      } as T;
    }
    if (command === "start_environment" || command === "run_environment_setup") {
      return (await storage.getEnvironment("env-1")) as T;
    }
    if (command === "update_environment_agent_settings") {
      return (await storage.getEnvironment("env-1")) as T;
    }
    if (command === "get_kanban_tasks") {
      return [...kanbanTasks.values()] as T;
    }
    if (command === "update_kanban_task") {
      const taskId = String(args.taskId);
      const task = kanbanTasks.get(taskId) ?? {
        id: taskId,
        status: "backlog",
        comments: [],
      };
      Object.assign(task, args);
      kanbanTasks.set(taskId, task);
      return task as T;
    }
    if (command === "add_kanban_comment") {
      const taskId = String(args.taskId);
      const task = kanbanTasks.get(taskId) ?? {
        id: taskId,
        status: "backlog",
        comments: [],
      };
      task.comments.push({ text: String(args.text) });
      kanbanTasks.set(taskId, task);
      return undefined as T;
    }
    if (command === "record_kanban_criteria_checks") {
      const task = kanbanTasks.get(String(args.taskId));
      if (task) Object.assign(task, { criteriaChecks: args.checks });
      return (task ?? null) as T;
    }
    if (command === "update_feature_plan") return undefined as T;
    if (command === "pr_monitor_watch") return undefined as T;
    if (
      command === "post_linear_completion_comment" ||
      command === "post_github_completion_comment"
    ) {
      return {
        commentId: "comment-1",
        postedAt: new Date(1).toISOString(),
      } as T;
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  const service = new BuildPipelineService(storage, invoke, {
    autoAdvance: false,
    provider: async () => provider,
    ...(controls.workflowResults
      ? {
          workflowResults: controls.workflowResults,
          ...(options.toolMode
            ? {
                resolveAgentToolConnection: () => ({
                  url: "http://127.0.0.1:1234/mcp",
                  token: "test-token",
                }),
              }
            : {}),
        }
      : {}),
    ...(options.assertAgentToolsReachable
      ? { assertAgentToolsReachable: options.assertAgentToolsReachable }
      : {}),
    environmentGit: options.environmentGit,
    environmentFence: options.environmentFence,
    assertEnvironmentQuiescent: options.assertEnvironmentQuiescent,
    ...(options.workspaceWriters ? { workspaceWriters: options.workspaceWriters(storage) } : {}),
  });
  try {
    await run(service, storage, provider, invocations, controls);
  } finally {
    await service.shutdown();
    controls.workflowResults?.closeStorage();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

export async function pipeline(storage: StorageService, id: string): Promise<BuildPipeline> {
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

export function pendingQuestion(sessionId: string, id = "question-1"): AgentInteractionRequest {
  const now = Date.now();
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    id,
    provider: "claude",
    kind: "question",
    origin: "build-pipeline",
    sessionId,
    state: "pending",
    revision: 1,
    presentation: {
      title: "Choose a safe implementation",
      questions: [],
    },
    createdAt: now,
    updatedAt: now,
  };
}

type ProviderInteractions = NonNullable<BuildPipelineProvider["interactions"]>;

/** The cast every interaction test needs to bolt a capability onto the fake. */
export function installInteractions(
  provider: FakeProvider,
  interactions: ProviderInteractions,
): void {
  (provider as unknown as { interactions: ProviderInteractions }).interactions = interactions;
}

/** Runs the two provisioning passes and returns the live build session. */
export async function startBuilding(
  service: BuildPipelineService,
  storage: StorageService,
  overrides: Partial<Parameters<BuildPipelineService["start"]>[0]> = {},
): Promise<{ started: BuildPipeline; session: PipelineSession }> {
  const started = await service.start(startInput(overrides));
  await service.advanceNow(started.id);
  await service.advanceNow(started.id);
  const running = await pipeline(storage, started.id);
  expect(running.phase).toBe("building");
  return { started, session: running.sessions[running.currentSessionIndex]! };
}

/** Writes durable state the way another process would, outside the service. */
export async function mutateStored(
  storage: StorageService,
  pipelineId: string,
  mutation: (snapshot: BuildPipeline) => void,
): Promise<BuildPipeline> {
  const record = await storage.getBuildPipeline(pipelineId);
  if (!record) throw new Error("Pipeline disappeared");
  const snapshot = record.snapshot as BuildPipeline;
  mutation(snapshot);
  await storage.saveBuildPipeline(
    snapshot.id,
    snapshot.projectId,
    snapshot.environmentId,
    record.version,
    snapshot,
    record.revision,
  );
  return snapshot;
}

export async function startVerifying(
  service: BuildPipelineService,
  storage: StorageService,
): Promise<BuildPipeline> {
  const started = await service.start(startInput());
  for (let pass = 0; pass < 4; pass += 1) {
    await service.advanceNow(started.id);
  }
  const verifying = await pipeline(storage, started.id);
  expect(verifying.phase).toBe("verifying");
  return verifying;
}
