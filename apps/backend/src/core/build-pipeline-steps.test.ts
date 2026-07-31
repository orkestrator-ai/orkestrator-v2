import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BuildPipeline,
  BuildPipelineAgent,
  PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { StorageService } from "./storage.js";
import { BuildPipelineService } from "./build-pipeline-service.js";
import type {
  BuildPipelineProvider,
  ProviderCreateSessionOptions,
  ProviderSendOptions,
  ProviderStatus,
} from "./build-pipeline-provider.js";

const cleanReview: StructuredReviewReport = {
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
    keyCodeChanges: [{ file: "src/app.ts", line: 1, description: "Adds it." }],
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

type CreatedSession = {
  agent: BuildPipelineAgent;
  phase: PipelineSessionPhase;
  model?: string;
  effort?: string;
};

type SentPrompt = {
  agent: BuildPipelineAgent;
  sessionId: string;
  model?: string;
  effort?: string;
};

/** Records what each harness was asked to run, per session. */
class RecordingProvider implements BuildPipelineProvider {
  private counter = 0;
  readonly phases = new Map<string, PipelineSessionPhase>();

  constructor(
    readonly agent: BuildPipelineAgent,
    private readonly created: CreatedSession[],
    private readonly sent: SentPrompt[],
  ) {}

  async createSession(
    phase: PipelineSessionPhase,
    _label: string,
    options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    const id = `${this.agent}-${phase}-${++this.counter}`;
    this.phases.set(id, phase);
    this.created.push({
      agent: this.agent,
      phase,
      model: options.model,
      effort: options.effort,
    });
    return id;
  }

  async send(
    sessionId: string,
    _prompt: string,
    options: ProviderSendOptions,
  ): Promise<void> {
    this.sent.push({
      agent: this.agent,
      sessionId,
      model: options.model,
      effort: options.effort,
    });
  }

  async status(_sessionId: string): Promise<ProviderStatus> {
    return "idle";
  }

  async messages(sessionId: string): Promise<unknown[]> {
    return [{ id: `${sessionId}-assistant`, role: "assistant", parts: [] }];
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T>> {
    const phase = this.phases.get(sessionId);
    return {
      ok: true,
      provider: this.agent,
      requestId,
      value: (phase === "review"
        ? cleanReview
        : { complete: true, rationale: "All criteria pass." }) as T,
    };
  }

  async abort(_sessionId: string): Promise<void> {}
}

async function withService(
  run: (context: {
    service: BuildPipelineService;
    storage: StorageService;
    created: CreatedSession[];
    sent: SentPrompt[];
    providerRequests: BuildPipelineAgent[];
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-steps-"));
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
  const created: CreatedSession[] = [];
  const sent: SentPrompt[] = [];
  const providerRequests: BuildPipelineAgent[] = [];
  const providers = new Map<BuildPipelineAgent, RecordingProvider>();
  const invoke = async <T>(
    command: string,
    _args: Record<string, unknown> = {},
  ): Promise<T> => {
    if (command === "start_environment" || command === "run_environment_setup") {
      return (await storage.getEnvironment("env-1")) as T;
    }
    if (command === "update_environment_agent_settings") {
      return (await storage.getEnvironment("env-1")) as T;
    }
    if (command === "detect_pr_local" || command === "detect_pr") return null as T;
    if (command === "get_kanban_tasks") return [] as T;
    return undefined as T;
  };
  const service = new BuildPipelineService(storage, invoke, {
    autoAdvance: false,
    provider: async (_pipeline, agent) => {
      providerRequests.push(agent);
      const existing = providers.get(agent);
      if (existing) return existing;
      const provider = new RecordingProvider(agent, created, sent);
      providers.set(agent, provider);
      return provider;
    },
  });
  try {
    await run({ service, storage, created, sent, providerRequests });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function snapshot(
  storage: StorageService,
  id: string,
): Promise<BuildPipeline> {
  const stored = await storage.getBuildPipeline(id);
  if (!stored) throw new Error("Pipeline disappeared");
  return stored.snapshot as BuildPipeline;
}

/** Runs supervisor passes until the named stage has started. */
async function advanceToStage(
  service: BuildPipelineService,
  storage: StorageService,
  id: string,
  stage: PipelineSessionPhase,
): Promise<BuildPipeline> {
  for (let pass = 0; pass < 12; pass += 1) {
    const current = await snapshot(storage, id);
    if (current.phase === "failed") {
      throw new Error(`Pipeline failed: ${current.error}`);
    }
    if (current.sessions.some((session) => session.phase === stage)) {
      return current;
    }
    await service.advanceNow(id);
  }
  throw new Error(`Pipeline never reached its ${stage} stage`);
}

const steps = {
  build: { agent: "claude" as const, model: "claude-a", reasoningEffort: "high" },
  review: { agent: "codex" as const, model: "codex-b", reasoningEffort: "low" },
  verify: { agent: "opencode" as const, model: "opencode/c" },
  pr: { agent: "codex" as const, model: "codex-pr" },
  "resolve-conflicts": { agent: "claude" as const, model: "claude-conflicts" },
};

function startInput() {
  return {
    taskId: "task-steps",
    projectId: "project-1",
    environmentType: "local" as const,
    // Deliberately not the build step's harness: the step configuration wins.
    agentType: "codex" as const,
    steps,
    taskTitle: "Per-step build",
    taskSnapshot: {
      title: "Per-step build",
      description: "Run each step on its own harness",
      acceptanceCriteria: "Each step uses its configured model",
      comments: [],
      images: [],
    },
    existingEnvironmentId: "env-1",
  };
}

describe("per-step build configuration", () => {
  test("runs each step on its configured harness, model and effort", async () => {
    await withService(async ({ service, storage, created, sent, providerRequests }) => {
      const started = await service.start(startInput());
      // The build step's harness becomes the pipeline agent, so the environment
      // default and every unconfigured stage follow it rather than the input.
      expect(started.agentType).toBe("claude");
      expect(started.steps).toEqual(steps);

      const pipeline = await advanceToStage(service, storage, started.id, "pr");

      expect(created).toEqual([
        { agent: "claude", phase: "build", model: "claude-a", effort: "high" },
        { agent: "codex", phase: "review", model: "codex-b", effort: "low" },
        { agent: "opencode", phase: "verify", model: "opencode/c", effort: undefined },
        { agent: "codex", phase: "pr", model: "codex-pr", effort: undefined },
      ]);
      expect(sent.map((prompt) => [prompt.agent, prompt.model, prompt.effort]))
        .toEqual([
          ["claude", "claude-a", "high"],
          ["codex", "codex-b", "low"],
          ["opencode", "opencode/c", undefined],
          ["codex", "codex-pr", undefined],
        ]);
      expect(providerRequests).toContain("claude");
      expect(providerRequests).toContain("codex");
      expect(providerRequests).toContain("opencode");

      // Recorded per session so status, transcript and abort calls reach the
      // harness that actually owns each one.
      expect(pipeline.sessions.map((session) => [session.phase, session.agent]))
        .toEqual([
          ["build", "claude"],
          ["review", "codex"],
          ["verify", "opencode"],
          ["pr", "codex"],
        ]);
    });
  });

  test("drops a step selection that pins nothing", async () => {
    await withService(async ({ service, storage, created }) => {
      const started = await service.start({
        ...startInput(),
        taskId: "task-default-model",
        steps: {
          build: { agent: "opencode", model: "default", reasoningEffort: "default" },
        },
      });
      expect(started.steps).toEqual({ build: { agent: "opencode" } });

      await advanceToStage(service, storage, started.id, "build");
      // "default" is a launcher placeholder, not a model id the bridge knows.
      expect(created[0]).toEqual({
        agent: "opencode",
        phase: "build",
        model: undefined,
        effort: undefined,
      });
    });
  });
});
