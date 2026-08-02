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
import type { AppConfig, RepositoryConfig } from "./models.js";
import { StorageService } from "./storage.js";
import { BuildPipelineService } from "./build-pipeline-service.js";
import {
  AmbiguousPromptDispatchError,
  ProviderUnavailableError,
  type BuildPipelineProvider,
  type ProviderCreateSessionOptions,
  type ProviderSendOptions,
  type ProviderStatus,
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
  /** Every session id this harness was told about, in call order. */
  readonly registered: string[] = [];
  disposed = 0;
  /** Thrown by createSession while set, to model an unreachable bridge. */
  createSessionError: unknown = null;
  /** Queue of errors; each send() shifts one and throws it when present. */
  sendErrors: unknown[] = [];
  /**
   * The verdict every verify stage returns. Set false to drive the pipeline
   * into its fix stage, which has no launcher control of its own.
   */
  verificationComplete = true;
  /**
   * The execution mode each stage asked for, kept apart from `created`/`sent`
   * so the sandbox can be asserted on its own.
   */
  readonly createdModes: Array<[PipelineSessionPhase, string | undefined]> = [];
  readonly sentModes: Array<string | undefined> = [];
  /** Session ids this harness was asked to stop, in call order. */
  readonly aborted: string[] = [];

  constructor(
    readonly agent: BuildPipelineAgent,
    private readonly created: CreatedSession[],
    private readonly sent: SentPrompt[],
  ) {}

  registerSession(sessionId: string): void {
    this.registered.push(sessionId);
  }

  async createSession(
    phase: PipelineSessionPhase,
    _label: string,
    options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    if (this.createSessionError) throw this.createSessionError;
    const id = `${this.agent}-${phase}-${++this.counter}`;
    this.phases.set(id, phase);
    this.createdModes.push([phase, options.mode]);
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
    const error = this.sendErrors.shift();
    if (error) throw error;
    this.sentModes.push(options.mode);
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
        : this.verificationComplete
          ? { complete: true, rationale: "All criteria pass." }
          : { complete: false, rationale: "Acceptance checks still fail." }) as T,
    };
  }

  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
  }

  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

type ServiceOptions = ConstructorParameters<typeof BuildPipelineService>[2];

async function withService(
  run: (context: {
    service: BuildPipelineService;
    storage: StorageService;
    created: CreatedSession[];
    sent: SentPrompt[];
    providerRequests: BuildPipelineAgent[];
    /**
     * The harness fake for one agent, created on demand.
     *
     * Exposed so a test can script a failure before the supervisor first asks
     * for that harness; the service resolves providers lazily, so there is no
     * other moment at which it could be reached.
     */
    providerFor: (agent: BuildPipelineAgent) => RecordingProvider;
    /**
     * What PR detection reports. Mutable so a test can present a conflicting
     * pull request and then clear the conflict, which is the only route into
     * — and out of — the `resolve-conflicts` stage.
     */
    controls: { detection: unknown };
  }) => Promise<void>,
  options: ServiceOptions = {},
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
  const controls: { detection: unknown } = { detection: null };
  const providers = new Map<BuildPipelineAgent, RecordingProvider>();
  const providerFor = (agent: BuildPipelineAgent): RecordingProvider => {
    const existing = providers.get(agent);
    if (existing) return existing;
    const provider = new RecordingProvider(agent, created, sent);
    providers.set(agent, provider);
    return provider;
  };
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
    if (command === "detect_pr_local" || command === "detect_pr") {
      return controls.detection as T;
    }
    if (command === "get_kanban_tasks") return [] as T;
    return undefined as T;
  };
  const service = new BuildPipelineService(storage, invoke, {
    autoAdvance: false,
    provider: async (_pipeline, agent) => {
      providerRequests.push(agent);
      return providerFor(agent);
    },
    ...options,
  });
  try {
    await run({
      service,
      storage,
      created,
      sent,
      providerRequests,
      providerFor,
      controls,
    });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

/** The service's own provider cache, keyed by `${environmentId}:${agent}`. */
function providerCache(
  service: BuildPipelineService,
): Map<string, BuildPipelineProvider> {
  return (service as unknown as {
    providers: Map<string, BuildPipelineProvider>;
  }).providers;
}

/** The harness each pipeline last resolved a provider for. */
function lastProviderAgents(
  service: BuildPipelineService,
): Map<string, BuildPipelineAgent> {
  return (service as unknown as {
    lastProviderAgent: Map<string, BuildPipelineAgent>;
  }).lastProviderAgent;
}

/** Writes the global and repository defaults a step may fall back to. */
async function writeDefaults(
  storage: StorageService,
  defaults: {
    global?: Partial<AppConfig["global"]>;
    repository?: Partial<RepositoryConfig>;
  },
): Promise<void> {
  const config = await storage.loadConfig();
  Object.assign(config.global, defaults.global ?? {});
  config.repositories["project-1"] = {
    defaultBranch: "main",
    prBaseBranch: "main",
    ...defaults.repository,
  };
  await storage.saveConfig(config);
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

type BridgeRequest = { url: string; body: Record<string, unknown> | undefined };

/**
 * A service that builds its own providers instead of being handed one.
 *
 * The injected provider used everywhere else bypasses
 * `createBuildPipelineProvider`, which is where the *connection-level* model and
 * effort are chosen. Those never appear in a `createSession`/`send` argument, so
 * letting the service reach a stubbed bridge is the only way to observe them.
 */
async function withBridgeService(
  run: (context: {
    service: BuildPipelineService;
    storage: StorageService;
    requests: BridgeRequest[];
    invocations: string[];
    bridges: Map<BuildPipelineAgent, { port: number; authToken?: string }>;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(
    path.join(tmpdir(), "orkestrator-pipeline-steps-bridge-"),
  );
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
  const requests: BridgeRequest[] = [];
  const originalFetch = globalThis.fetch;
  let sessionCounter = 0;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = input instanceof Request ? input.method : init.method ?? "GET";
    const rawBody = input instanceof Request
      ? await input.clone().text()
      : init.body
        ? String(init.body)
        : "";
    requests.push({
      url,
      body: rawBody
        ? JSON.parse(rawBody) as Record<string, unknown>
        : undefined,
    });
    const pathname = new URL(url).pathname;
    if (pathname === "/permission" || pathname === "/question") {
      return Response.json([]);
    }
    if (pathname.endsWith("/questions")) {
      return Response.json({ questions: [] });
    }
    if (pathname.endsWith("/plan-approvals")) {
      return Response.json({ approvals: [] });
    }
    if (pathname.endsWith("/approvals")) {
      return Response.json({ approvals: [] });
    }
    if (pathname.endsWith("/interactions")) {
      return Response.json({ interactions: [] });
    }
    if (pathname === "/event") {
      const signal = input instanceof Request ? input.signal : init.signal;
      return new Response(new ReadableStream({
        start(controller) {
          if (signal?.aborted) {
            controller.close();
            return;
          }
          signal?.addEventListener("abort", () => controller.close(), {
            once: true,
          });
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.endsWith("/session/create")) {
      return Response.json({ sessionId: `bridge-session-${++sessionCounter}` });
    }
    if (pathname === "/session" && method === "POST") {
      return Response.json({ id: `bridge-session-${++sessionCounter}` });
    }
    if (url.endsWith("/prompt")) return new Response(null, { status: 204 });
    if (url.includes("/prompt_async")) return new Response(null, { status: 204 });
    if (url.endsWith("/messages")) return Response.json({ messages: [] });
    if (url.includes("/structured-output")) {
      return Response.json({ structuredOutput: null });
    }
    return Response.json({ status: "idle" });
  }) as unknown as typeof fetch;
  const bridges = new Map<
    BuildPipelineAgent,
    { port: number; authToken?: string }
  >([
    ["claude", { port: 3210, authToken: "claude-token" }],
    ["codex", { port: 3211, authToken: "codex-token" }],
  ]);
  const invocations: string[] = [];
  const invoke = async <T>(command: string): Promise<T> => {
    invocations.push(command);
    if (
      command === "start_environment"
      || command === "run_environment_setup"
      || command === "update_environment_agent_settings"
    ) {
      return (await storage.getEnvironment("env-1")) as T;
    }
    const local = /^start_local_(claude|codex|opencode)_server_cmd$/.exec(command);
    if (local) {
      return (bridges.get(local[1] as BuildPipelineAgent) ?? { port: 0 }) as T;
    }
    return undefined as T;
  };
  const service = new BuildPipelineService(storage, invoke, {
    autoAdvance: false,
  });
  try {
    await run({ service, storage, requests, invocations, bridges });
  } finally {
    await service.shutdown();
    globalThis.fetch = originalFetch;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
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

  test("drops blank selections, empty step maps and absent step entries", async () => {
    await withService(async ({ service, storage }) => {
      const empty = await service.start({
        ...startInput(),
        taskId: "task-empty-steps",
        steps: {},
      });
      // Not just undefined on the returned object: an empty map must never be
      // persisted, or `steps` in the snapshot would read as a configuration.
      expect(empty.steps).toBeUndefined();
      expect("steps" in await snapshot(storage, empty.id)).toBe(false);

      const blank = await service.start({
        ...startInput(),
        taskId: "task-blank-selections",
        steps: {
          build: { agent: "claude", model: "  ", reasoningEffort: "  " },
        },
      });
      expect(blank.steps).toEqual({ build: { agent: "claude" } });

      const sparse = await service.start({
        ...startInput(),
        taskId: "task-sparse-steps",
        steps: { build: undefined, review: { agent: "codex" } },
      });
      expect(sparse.steps).toEqual({ review: { agent: "codex" } });
      // No build step, so the pipeline agent is still the requested one.
      expect(sparse.agentType).toBe("codex");
    });
  });

  test("redispatches a lost prompt with the step's own model and effort", async () => {
    await withService(async ({ service, storage, sent, providerFor }) => {
      // Claude and OpenCode bind the model per prompt, so a redispatch that
      // dropped it would quietly rerun the turn on the connection default.
      providerFor("codex").sendErrors = [
        new AmbiguousPromptDispatchError("response lost"),
      ];
      const started = await service.start({
        ...startInput(),
        taskId: "task-redispatch",
      });
      const reviewing = await advanceToStage(
        service,
        storage,
        started.id,
        "review",
      );
      const review = reviewing.sessions.at(-1)!;
      expect(sent).toHaveLength(1);

      await service.advanceNow(started.id);

      expect(sent).toHaveLength(2);
      expect(sent.at(-1)).toEqual({
        agent: "codex",
        sessionId: review.sdkSessionId,
        model: "codex-b",
        effort: "low",
      });
      expect((await snapshot(storage, started.id)).pendingPromptAttempt)
        .toBeUndefined();
    });
  });

  test("falls back to the repository defaults only for the unconfigured steps", async () => {
    await withService(async ({ service, storage, created }) => {
      await writeDefaults(storage, {
        repository: {
          defaultAgent: "claude",
          defaultModel: "repo-claude",
          defaultEffort: "repo-effort",
        },
      });
      const started = await service.start({
        ...startInput(),
        taskId: "task-mixed-steps",
        steps: {
          build: { agent: "claude", model: "claude-a", reasoningEffort: "high" },
        },
      });

      await advanceToStage(service, storage, started.id, "review");

      expect(created).toEqual([
        { agent: "claude", phase: "build", model: "claude-a", effort: "high" },
        {
          agent: "claude",
          phase: "review",
          model: "repo-claude",
          effort: "repo-effort",
        },
      ]);
    });
  });

  test("keeps the repository default off a harness it was not chosen for", async () => {
    await withService(async ({ service, storage, created }) => {
      // The repository stores one model and effort, chosen for its own default
      // agent. Handing them to another harness sends a Codex model id to Claude.
      await writeDefaults(storage, {
        global: {
          claudeModel: "global-claude",
          codexModel: "global-codex",
          codexReasoningEffort: "medium",
        },
        repository: {
          defaultAgent: "codex",
          defaultModel: "gpt-5.1-codex-max",
          defaultEffort: "xhigh",
        },
      });

      const onClaude = await service.start({
        ...startInput(),
        taskId: "task-claude-step",
        steps: { build: { agent: "claude" } },
      });
      await advanceToStage(service, storage, onClaude.id, "review");

      expect(created).toEqual([
        { agent: "claude", phase: "build", model: undefined, effort: undefined },
        {
          agent: "claude",
          phase: "review",
          model: "global-claude",
          effort: undefined,
        },
      ]);

      // The repository's own agent still gets them: they were chosen for it.
      const onCodex = await service.start({
        ...startInput(),
        taskId: "task-codex-step",
        steps: { build: { agent: "codex" } },
      });
      await advanceToStage(service, storage, onCodex.id, "review");

      expect(created.slice(2)).toEqual([
        { agent: "codex", phase: "build", model: undefined, effort: undefined },
        {
          agent: "codex",
          phase: "review",
          model: "gpt-5.1-codex-max",
          effort: "xhigh",
        },
      ]);
    });
  });

  test("uses the global default agent to interpret repository defaults", async () => {
    await withService(async ({ service, storage, created }) => {
      await writeDefaults(storage, {
        global: {
          defaultAgent: "codex",
          claudeModel: "global-claude",
          codexModel: "global-codex",
          codexReasoningEffort: "medium",
        },
        // Older repository entries may omit `defaultAgent`. Their model and
        // effort still belong to the globally selected harness.
        repository: {
          defaultModel: "repo-codex",
          defaultEffort: "xhigh",
        },
      });

      const started = await service.start({
        ...startInput(),
        taskId: "task-global-default-agent",
        agentType: "codex",
        steps: undefined,
      });
      await advanceToStage(service, storage, started.id, "review");

      expect(created).toEqual([
        {
          agent: "codex",
          phase: "build",
          model: "repo-codex",
          effort: "xhigh",
        },
        {
          agent: "codex",
          phase: "review",
          model: "repo-codex",
          effort: "xhigh",
        },
      ]);
    });
  });
});

describe("per-step provider lifecycle", () => {
  test("pauses and cancels mixed-agent work through only the session owner", async () => {
    await withService(async ({ service, storage, providerFor }) => {
      const claude = providerFor("claude");
      const codex = providerFor("codex");
      const pauseTarget = await service.start({
        ...startInput(),
        taskId: "task-pause-owner",
        steps: { build: { agent: "claude" }, review: { agent: "codex" } },
      });
      const reviewingForPause = await advanceToStage(
        service,
        storage,
        pauseTarget.id,
        "review",
      );
      const pausedSession = reviewingForPause.sessions.at(-1)!;

      await service.pause(pauseTarget.id);

      expect(codex.aborted).toEqual([pausedSession.sdkSessionId]);
      expect(claude.aborted).toEqual([]);

      const cancelTarget = await service.start({
        ...startInput(),
        taskId: "task-cancel-owner",
        steps: { build: { agent: "claude" }, review: { agent: "codex" } },
      });
      const reviewingForCancel = await advanceToStage(
        service,
        storage,
        cancelTarget.id,
        "review",
      );
      const cancelledSession = reviewingForCancel.sessions.at(-1)!;
      expect(lastProviderAgents(service).get(cancelTarget.id)).toBe("codex");

      await service.cancel(cancelTarget.id);

      expect(codex.aborted).toEqual([
        pausedSession.sdkSessionId,
        cancelledSession.sdkSessionId,
      ]);
      expect(claude.aborted).toEqual([]);
      expect(lastProviderAgents(service).has(cancelTarget.id)).toBe(false);
    });
  });

  test("disposes only the harnesses no remaining pipeline still uses", async () => {
    await withService(async ({ service, storage, providerFor }) => {
      const claude = providerFor("claude");
      const codex = providerFor("codex");
      const removed = await service.start({
        ...startInput(),
        taskId: "task-removed",
        steps: {
          build: { agent: "claude" },
          review: { agent: "codex" },
        },
      });
      await advanceToStage(service, storage, removed.id, "review");
      // A sibling build in the same environment shares the Claude provider.
      await service.start({
        ...startInput(),
        taskId: "task-sibling",
        steps: { build: { agent: "claude" } },
      });

      await service.remove(removed.id);

      expect(codex.disposed).toBe(1);
      // Disposing this would tear the bridge client out from under the sibling.
      expect(claude.disposed).toBe(0);
      expect(providerCache(service).has("env-1:claude")).toBe(true);
      expect(providerCache(service).has("env-1:codex")).toBe(false);
    });
  });

  test("disposes every harness of a removed pipeline with no sibling", async () => {
    await withService(async ({ service, storage, providerFor }) => {
      const claude = providerFor("claude");
      const codex = providerFor("codex");
      const removed = await service.start({
        ...startInput(),
        taskId: "task-only",
        steps: {
          build: { agent: "claude" },
          review: { agent: "codex" },
        },
      });
      await advanceToStage(service, storage, removed.id, "review");
      expect(lastProviderAgents(service).has(removed.id)).toBe(true);

      await service.remove(removed.id);

      expect([claude.disposed, codex.disposed]).toEqual([1, 1]);
      expect(providerCache(service).size).toBe(0);
      // Nothing else keys off a deleted pipeline id, so retaining it is a leak.
      expect(lastProviderAgents(service).has(removed.id)).toBe(false);
    });
  });

  test("evicts the harness that failed, not the one the snapshot describes", async () => {
    await withService(async ({ service, storage, providerFor }) => {
      const claude = providerFor("claude");
      const codex = providerFor("codex");
      const started = await service.start({
        ...startInput(),
        taskId: "task-reconnect-eviction",
        steps: {
          build: { agent: "claude" },
          review: { agent: "codex" },
        },
      });
      await advanceToStage(service, storage, started.id, "build");
      codex.createSessionError = new ProviderUnavailableError(
        "codex bridge is unavailable",
      );

      // The review harness fails while the stored snapshot still describes the
      // build stage: the failing provider cannot be derived from the session.
      await service.advanceNow(started.id);

      const reconnecting = await snapshot(storage, started.id);
      // The guarantee only has teeth while the snapshot still points at the
      // healthy harness: the review session is not recorded until it opens.
      expect(reconnecting.sessions.at(reconnecting.currentSessionIndex))
        .toMatchObject({ phase: "build", agent: "claude" });
      expect(reconnecting.error).toContain("Reconnecting to codex");
      expect(reconnecting.error).not.toContain("claude");
      expect(codex.disposed).toBe(1);
      expect(providerCache(service).has("env-1:codex")).toBe(false);
      // Dropping the healthy harness would also leave the unreachable one
      // cached forever, so the retry would keep hitting the dead client.
      expect(claude.disposed).toBe(0);
      expect(providerCache(service).has("env-1:claude")).toBe(true);
    });
  });

  test("names the failing harness when it stays unreachable past the deadline", async () => {
    await withService(async ({ service, storage, providerFor }) => {
      const codex = providerFor("codex");
      const started = await service.start({
        ...startInput(),
        taskId: "task-reconnect-deadline",
        steps: {
          build: { agent: "claude" },
          review: { agent: "codex" },
        },
      });
      await advanceToStage(service, storage, started.id, "build");
      codex.createSessionError = new ProviderUnavailableError(
        "codex bridge is unavailable",
      );

      await service.advanceNow(started.id);
      await service.advanceNow(started.id);

      const failed = await snapshot(storage, started.id);
      expect(failed.phase).toBe("failed");
      expect(failed.error).toContain("codex stayed unreachable");
      expect(failed.error).not.toContain("claude");
    }, { reconnectDeadlineMs: 0 });
  });

  test("never registers a session with a harness that does not own it", async () => {
    await withService(async ({ service, storage, providerFor }) => {
      const claude = providerFor("claude");
      const codex = providerFor("codex");
      const opencode = providerFor("opencode");
      const started = await service.start(startInput());

      const pipeline = await advanceToStage(service, storage, started.id, "pr");

      const owned = (agent: BuildPipelineAgent): string[] =>
        pipeline.sessions
          .filter((session) => session.agent === agent)
          .map((session) => session.sdkSessionId);
      // A foreign id in an environment-wide monitor is a session it is supposed
      // to ignore everything about.
      expect([...new Set(claude.registered)]).toEqual(owned("claude"));
      expect([...new Set(codex.registered)]).toEqual(owned("codex"));
      expect([...new Set(opencode.registered)]).toEqual(owned("opencode"));
      for (const sessionId of owned("codex")) {
        expect(claude.registered).not.toContain(sessionId);
      }
    });
  });

  test("routes a session recorded before per-step harnesses to the pipeline agent", async () => {
    await withService(async ({
      service,
      storage,
      created,
      sent,
      providerRequests,
      providerFor,
    }) => {
      const codex = providerFor("codex");
      const started = await service.start({
        ...startInput(),
        taskId: "task-legacy-session",
        agentType: "codex",
        steps: undefined,
      });
      const building = await advanceToStage(service, storage, started.id, "build");

      // A snapshot written before sessions recorded their own harness.
      const record = (await storage.getBuildPipeline(started.id))!;
      const legacy = record.snapshot as BuildPipeline;
      delete legacy.sessions[0]!.agent;
      await storage.saveBuildPipeline(
        legacy.id,
        legacy.projectId,
        legacy.environmentId,
        record.version,
        legacy,
        record.revision,
      );
      const legacySessionId = building.sessions[0]!.sdkSessionId;
      const registeredBefore = codex.registered.length;

      await service.advanceNow(started.id);

      // Re-registered by the ownership filter, which only claims it because the
      // agentless session resolves to the pipeline agent.
      expect(codex.registered.slice(registeredBefore))
        .toContain(legacySessionId);
      expect(new Set(providerRequests)).toEqual(new Set(["codex"]));
      expect(created.every((session) => session.agent === "codex")).toBe(true);
      expect(sent.every((prompt) => prompt.agent === "codex")).toBe(true);
      expect((await snapshot(storage, started.id)).sessions.at(-1)?.phase)
        .toBe("review");
    });
  });
});

describe("per-step bridge connections", () => {
  test("connects a pinned harness with its own defaults, not the repository's", async () => {
    await withBridgeService(async ({ service, storage, requests }) => {
      await writeDefaults(storage, {
        global: { claudeModel: "global-claude" },
        repository: {
          defaultAgent: "codex",
          defaultModel: "gpt-5.1-codex-max",
          defaultEffort: "xhigh",
        },
      });
      const started = await service.start({
        ...startInput(),
        taskId: "task-connection-defaults",
        steps: { build: { agent: "claude" } },
      });

      await service.advanceNow(started.id);
      await service.advanceNow(started.id);

      const prompt = requests.find((request) => request.url.endsWith("/prompt"));
      expect(prompt?.url).toBe(
        "http://127.0.0.1:3210/session/bridge-session-1/prompt",
      );
      // Claude takes the model per prompt, so the connection default is what a
      // step that pinned nothing runs on.
      expect(prompt?.body?.model).toBe("global-claude");
      expect(prompt?.body?.effort).toBeUndefined();
      expect(JSON.stringify(prompt?.body)).not.toContain("gpt-5.1-codex-max");
      expect(JSON.stringify(prompt?.body)).not.toContain("xhigh");
    });
  });

  test("passes the global OpenCode model through the production provider", async () => {
    await withBridgeService(async ({
      service,
      storage,
      requests,
      invocations,
      bridges,
    }) => {
      bridges.set("opencode", { port: 3212, authToken: "opencode-token" });
      await writeDefaults(storage, {
        global: { opencodeModel: "anthropic/claude-sonnet" },
        repository: {
          defaultAgent: "claude",
          defaultModel: "repo-claude",
        },
      });
      const started = await service.start({
        ...startInput(),
        taskId: "task-opencode-global-model",
        steps: { build: { agent: "opencode" } },
      });

      await service.advanceNow(started.id);
      await service.advanceNow(started.id);

      expect(invocations).toContain("start_local_opencode_server_cmd");
      const prompt = requests.find((request) =>
        new URL(request.url).pathname.endsWith("/prompt_async")
      );
      expect(prompt?.body?.model).toEqual({
        providerID: "anthropic",
        modelID: "claude-sonnet",
      });
      expect(JSON.stringify(prompt?.body)).not.toContain("repo-claude");
    });
  });

  test("fails on the review harness's bridge while the build harness stays healthy", async () => {
    await withBridgeService(async ({
      service,
      storage,
      requests,
      invocations,
      bridges,
    }) => {
      bridges.set("codex", { port: 3211 });
      const started = await service.start({
        ...startInput(),
        taskId: "task-review-bridge-down",
        steps: {
          build: { agent: "claude" },
          review: { agent: "codex" },
        },
      });

      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      expect(requests.map((request) => request.url)).toEqual([
        "http://127.0.0.1:3210/session/create",
        "http://127.0.0.1:3210/session/bridge-session-1/prompt",
      ]);

      await service.advanceNow(started.id);

      const failed = await snapshot(storage, started.id);
      expect(failed.phase).toBe("failed");
      expect(failed.error).toBe("codex bridge authentication is unavailable");
      expect(invocations).toContain("start_local_codex_server_cmd");
      // The build harness is untouched: only the harness that could not be
      // reached is missing from the cache.
      expect(providerCache(service).has("env-1:claude")).toBe(true);
      expect(providerCache(service).has("env-1:codex")).toBe(false);
      // A semantic bridge failure moves the snapshot to a terminal phase, so
      // reconnect attribution for the failed pipeline must be released too.
      expect(lastProviderAgents(service).has(started.id)).toBe(false);
    });
  });
});

describe("per-step stage coverage", () => {
  test("runs the fix stage on the build step's harness", async () => {
    await withService(async ({ service, storage, created, providerFor }) => {
      // `fix` re-implements against verification feedback, so it is build work
      // and has no launcher control of its own. It must follow the build step
      // rather than falling back to a repository default.
      await writeDefaults(storage, {
        global: { claudeModel: "global-claude", codexModel: "global-codex" },
        repository: { defaultAgent: "codex", defaultModel: "repo-codex" },
      });
      providerFor("opencode").verificationComplete = false;

      const started = await service.start({
        ...startInput(),
        steps: {
          build: { agent: "claude", model: "claude-a", reasoningEffort: "high" },
          review: { agent: "codex", model: "codex-b" },
          verify: { agent: "opencode", model: "opencode/c" },
        },
      });
      const pipeline = await advanceToStage(service, storage, started.id, "fix");

      expect(created).toContainEqual({
        agent: "claude",
        phase: "fix",
        model: "claude-a",
        effort: "high",
      });
      const fix = pipeline.sessions.find((session) => session.phase === "fix");
      expect(fix?.agent).toBe("claude");
    });
  });

  test("runs the conflict stage on its own configured harness", async () => {
    await withService(async ({ service, storage, created, controls }) => {
      controls.detection = {
        url: "https://github.com/acme/repo/pull/9",
        state: "open",
        hasMergeConflicts: true,
      };

      const started = await service.start(startInput());
      const pipeline = await advanceToStage(
        service,
        storage,
        started.id,
        "resolve-conflicts",
      );

      expect(created).toContainEqual({
        agent: "claude",
        phase: "resolve-conflicts",
        model: "claude-conflicts",
        effort: undefined,
      });
      const conflicts = pipeline.sessions.find(
        (session) => session.phase === "resolve-conflicts",
      );
      expect(conflicts?.agent).toBe("claude");

      controls.detection = {
        url: "https://github.com/acme/repo/pull/9",
        state: "open",
        hasMergeConflicts: false,
      };
      await service.advanceNow(started.id);
      expect((await snapshot(storage, started.id)).phase).toBe("complete");
    });
  });

  test("falls back to the global Codex effort for a step the repository does not own", async () => {
    await withService(async ({ service, storage, created }) => {
      // The repository's effort belongs to Claude, so a Codex step cannot take
      // it — but Codex still has a global effort of its own to fall back to.
      await writeDefaults(storage, {
        global: {
          claudeModel: "global-claude",
          codexModel: "global-codex",
          codexReasoningEffort: "medium",
        },
        repository: {
          defaultAgent: "claude",
          defaultModel: "repo-claude",
          defaultEffort: "max",
        },
      });

      const started = await service.start({
        ...startInput(),
        agentType: "codex",
        steps: { build: { agent: "codex" } },
      });
      await advanceToStage(service, storage, started.id, "review");

      expect(created).toEqual([
        { agent: "codex", phase: "build", model: undefined, effort: undefined },
        {
          agent: "codex",
          phase: "review",
          model: "global-codex",
          effort: "medium",
        },
      ]);
    });
  });

  test("redispatches a stage-less attempt without a step selection", async () => {
    await withService(async ({ service, storage, sent, providerFor }) => {
      const started = await service.start(startInput());
      await advanceToStage(service, storage, started.id, "build");
      const running = await snapshot(storage, started.id);
      const session = running.sessions[0]!;

      // `waiting-for-setup` maps to no session phase, so the redispatch has no
      // step to read and must send the prompt without pinning a model at all.
      running.pendingPromptAttempt = {
        id: "attempt-setup",
        sessionId: session.sdkSessionId,
        requestId: "request-setup",
        phase: "waiting-for-setup",
        prompt: "Resume",
        useTaskImages: false,
        startedAt: new Date().toISOString(),
      };
      session.status = "idle";
      const record = await storage.getBuildPipeline(started.id);
      await storage.saveBuildPipeline(
        running.id,
        running.projectId,
        running.environmentId,
        2,
        running,
        record!.revision,
      );

      providerFor("claude").phases.set(session.sdkSessionId, "build");
      const before = sent.length;
      await service.advanceNow(started.id);

      expect(sent.slice(before)).toEqual([
        {
          agent: "claude",
          sessionId: session.sdkSessionId,
          model: undefined,
          effort: undefined,
        },
      ]);
    });
  });
});

describe("per-step reconnect accounting", () => {
  test("lets the deadline elapse when a healthy harness owns the current session", async () => {
    await withService(async ({ service, storage, providerFor }) => {
      // The regression this pins: a stage transition resolves the *next* step's
      // provider before it records that step's session, so the failure belongs
      // to a harness no session names. Clearing the attempt on the previous
      // stage's still-healthy harness restarted `startedAt` every pass, and the
      // deadline could then never elapse — the pipeline retried a dead bridge
      // forever instead of failing.
      const codex = providerFor("codex");
      const started = await service.start({
        ...startInput(),
        taskId: "task-reconnect-accrues",
        steps: { build: { agent: "claude" }, review: { agent: "codex" } },
      });
      await advanceToStage(service, storage, started.id, "build");
      codex.createSessionError = new ProviderUnavailableError(
        "codex bridge is unavailable",
      );

      await service.advanceNow(started.id);
      const first = (await snapshot(storage, started.id)).reconnectAttempt;
      expect(first).toMatchObject({ agent: "codex" });
      // The build session is on the healthy harness, so it must not be offered
      // as the failure's session id.
      expect(first?.sessionId).toBeUndefined();

      for (let pass = 0; pass < 4; pass += 1) {
        await service.advanceNow(started.id);
        const current = await snapshot(storage, started.id);
        if (current.phase === "failed") break;
        expect(current.reconnectAttempt?.startedAt).toBe(first!.startedAt);
        expect(current.reconnectAttempt?.id).toBe(first!.id);
      }
    }, { reconnectDeadlineMs: 60_000 });
  });

  test("gives a different harness's outage its own deadline", async () => {
    await withService(async ({ service, storage, providerFor }) => {
      const codex = providerFor("codex");
      const started = await service.start({
        ...startInput(),
        taskId: "task-reconnect-switches",
        steps: { build: { agent: "claude" }, review: { agent: "codex" } },
      });
      await advanceToStage(service, storage, started.id, "build");
      codex.createSessionError = new ProviderUnavailableError("codex is down");
      await service.advanceNow(started.id);
      const onCodex = (await snapshot(storage, started.id)).reconnectAttempt!;
      expect(onCodex.agent).toBe("codex");

      // Rewrite the standing attempt so it belongs to another harness and has
      // already run past the deadline. A continuation would inherit that
      // elapsed time and fail the pipeline on this very pass; a new outage on a
      // harness that has only just stopped answering must start its own clock.
      const pipeline = await snapshot(storage, started.id);
      pipeline.reconnectAttempt = {
        ...pipeline.reconnectAttempt!,
        agent: "opencode",
        startedAt: new Date(0).toISOString(),
      };
      const record = await storage.getBuildPipeline(started.id);
      await storage.saveBuildPipeline(
        pipeline.id,
        pipeline.projectId,
        pipeline.environmentId,
        2,
        pipeline,
        record!.revision,
      );

      await service.advanceNow(started.id);

      const after = await snapshot(storage, started.id);
      expect(after.phase).not.toBe("failed");
      expect(after.reconnectAttempt?.agent).toBe("codex");
      expect(after.reconnectAttempt?.startedAt).not.toBe(new Date(0).toISOString());
      expect(after.reconnectAttempt?.id).not.toBe(onCodex.id);
    }, { reconnectDeadlineMs: 60_000 });
  });

  test("clears the attempt once the harness that failed answers again", async () => {
    await withService(async ({ service, storage, providerFor }) => {
      const codex = providerFor("codex");
      const started = await service.start({
        ...startInput(),
        taskId: "task-reconnect-recovers",
        steps: { build: { agent: "claude" }, review: { agent: "codex" } },
      });
      await advanceToStage(service, storage, started.id, "build");
      codex.createSessionError = new ProviderUnavailableError("codex is down");
      await service.advanceNow(started.id);
      expect((await snapshot(storage, started.id)).reconnectAttempt?.agent)
        .toBe("codex");

      codex.createSessionError = null;
      // Opens the review stage on the recovered harness, then lets the next
      // pass observe it: the outage is over, so nothing should still say so.
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);

      const recovered = await snapshot(storage, started.id);
      expect(recovered.reconnectAttempt).toBeUndefined();
      expect(recovered.error).toBeUndefined();
      expect(recovered.sessions.map((session) => session.phase))
        .toContain("review");
    }, { reconnectDeadlineMs: 60_000 });
  });

  test("clears its recorded harness once the pipeline reaches a terminal phase", async () => {
    await withService(async ({ service, storage, controls }) => {
      controls.detection = {
        url: "https://github.com/acme/repo/pull/4",
        state: "open",
        hasMergeConflicts: false,
      };
      const started = await service.start(startInput());
      for (let pass = 0; pass < 8; pass += 1) {
        if ((await snapshot(storage, started.id)).phase === "complete") break;
        await service.advanceNow(started.id);
      }

      expect((await snapshot(storage, started.id)).phase).toBe("complete");
      // Kept only while a pass may still need to attribute a failure. A finished
      // pipeline keeps nothing, and `shutdown` clears the rest.
      expect(lastProviderAgents(service).has(started.id)).toBe(false);
    });
  });

  test("shutdown clears every recorded harness", async () => {
    await withService(async ({ service, storage }) => {
      const started = await service.start(startInput());
      await advanceToStage(service, storage, started.id, "build");
      expect(lastProviderAgents(service).size).toBe(1);

      await service.shutdown();

      expect(lastProviderAgents(service).size).toBe(0);
      expect(providerCache(service).size).toBe(0);
    });
  });
});

describe("per-step model placeholders", () => {
  test("keeps Claude's own default model id, which is a real one", async () => {
    await withService(async ({ service, storage, created, sent }) => {
      // `"default"` is a Claude catalog id — the bridge resolves it to Opus with
      // a 1M context. Dropping it as if it meant "unset" ran the stage on the
      // global default instead, so the build silently used a different model
      // from the one the launcher displayed.
      await writeDefaults(storage, {
        global: { claudeModel: "claude-sonnet-5", codexModel: "global-codex" },
      });

      const started = await service.start({
        ...startInput(),
        agentType: "claude",
        steps: { build: { agent: "claude", model: "default" } },
      });
      expect((await snapshot(storage, started.id)).steps)
        .toEqual({ build: { agent: "claude", model: "default" } });

      await advanceToStage(service, storage, started.id, "build");

      expect(created[0]).toEqual({
        agent: "claude",
        phase: "build",
        model: "default",
        effort: undefined,
      });
      expect(sent[0]?.model).toBe("default");
    });
  });

  test("drops the placeholder the launcher shows for a harness with no catalog", async () => {
    await withService(async ({ service, storage, created }) => {
      // No Codex or OpenCode server knows a model called "default"; it is only
      // what the picker displays when that harness has not published a catalog.
      await writeDefaults(storage, {
        global: { claudeModel: "global-claude", codexModel: "global-codex" },
      });

      const started = await service.start({
        ...startInput(),
        agentType: "codex",
        steps: { build: { agent: "codex", model: "default" } },
      });
      expect((await snapshot(storage, started.id)).steps)
        .toEqual({ build: { agent: "codex" } });

      await advanceToStage(service, storage, started.id, "build");

      expect(created[0]).toEqual({
        agent: "codex",
        phase: "build",
        model: undefined,
        effort: undefined,
      });
    });
  });

  test("normalizes a placeholder that reached the snapshot unnormalized", async () => {
    await withService(async ({ service, storage, created }) => {
      // `start()` is not the only way a snapshot arrives — `importLegacy` takes
      // one straight from disk — so the read side has to normalize too.
      const started = await service.start({
        ...startInput(),
        agentType: "codex",
        steps: { build: { agent: "codex", model: "codex-b" } },
      });
      const pipeline = await snapshot(storage, started.id);
      pipeline.steps = {
        build: { agent: "codex", model: "default", reasoningEffort: "default" },
      };
      const record = await storage.getBuildPipeline(started.id);
      await storage.saveBuildPipeline(
        pipeline.id,
        pipeline.projectId,
        pipeline.environmentId,
        2,
        pipeline,
        record!.revision,
      );

      await advanceToStage(service, storage, started.id, "build");

      expect(created[0]).toEqual({
        agent: "codex",
        phase: "build",
        model: undefined,
        effort: undefined,
      });
    });
  });
});

describe("per-step execution modes", () => {
  test("sandboxes review and verify on Codex and states build mode elsewhere", async () => {
    await withService(async ({ service, storage, providerFor }) => {
      const codex = providerFor("codex");
      const started = await service.start({
        ...startInput(),
        agentType: "codex",
        steps: {
          build: { agent: "codex" },
          review: { agent: "codex" },
          verify: { agent: "codex" },
          pr: { agent: "codex" },
        },
      });
      await advanceToStage(service, storage, started.id, "pr");

      // Stated by the supervisor rather than inferred inside the provider, so
      // the sandbox a stage runs under is one decision in one place.
      expect(codex.createdModes).toEqual([
        ["build", "build"],
        ["review", "plan"],
        ["verify", "plan"],
        ["pr", "build"],
      ]);
      expect(codex.sentModes).toEqual(["build", "plan", "plan", "build"]);
    });
  });

  test("keeps a harness that cannot be sandboxed in build mode", async () => {
    await withService(async ({ service, storage, providerFor }) => {
      // Claude's plan mode waits on `ExitPlanMode` approval, which a pipeline
      // has nobody to give, so a plan-mode review would stall rather than run.
      const claude = providerFor("claude");
      const started = await service.start({
        ...startInput(),
        agentType: "claude",
        steps: {
          build: { agent: "claude" },
          review: { agent: "claude" },
          verify: { agent: "claude" },
          pr: { agent: "claude" },
        },
      });
      await advanceToStage(service, storage, started.id, "pr");

      expect(claude.createdModes.map(([, mode]) => mode))
        .toEqual(["build", "build", "build", "build"]);
      expect(claude.sentModes).toEqual(["build", "build", "build", "build"]);
    });
  });

  test("addressing review findings overrides the review stage's read-only mode", async () => {
    await withService(async ({ service, storage, providerFor }) => {
      const codex = providerFor("codex");
      codex.structured = async <T>(
        sessionId: string,
        requestId: string,
      ): Promise<StructuredOutputResult<T>> => ({
        ok: true,
        provider: "codex",
        requestId,
        value: (codex.phases.get(sessionId) === "review"
          ? {
              ...cleanReview,
              issues: [{
                severity: "P1" as const,
                confidence: 90,
                category: "correctness" as const,
                title: "Off-by-one",
                file: "src/app.ts",
                line: 2,
                symbol: "run",
                description: "Loops once too many.",
                evidence: "for (i <= n)",
                suggestion: "Use <.",
                verification: "Run the suite.",
              }],
            }
          : { complete: true, rationale: "All criteria pass." }) as T,
      });

      const started = await service.start({
        ...startInput(),
        agentType: "codex",
        steps: { build: { agent: "codex" }, review: { agent: "codex" } },
      });
      await advanceToStage(service, storage, started.id, "verify");

      // The review session is reused to write the fixes, so that turn has to
      // leave the read-only sandbox the review itself ran in.
      expect(codex.sentModes.slice(0, 3)).toEqual(["build", "plan", "build"]);
    });
  });
});

describe("per-step provider reservations", () => {
  test("keeps a harness a sibling has only configured, not yet run", async () => {
    await withService(async ({ service, storage, providerFor }) => {
      const codex = providerFor("codex");
      const kept = await service.start({
        ...startInput(),
        taskId: "task-keeps-codex",
        steps: { build: { agent: "claude" }, review: { agent: "codex" } },
      });
      // Only reaches its build stage, so its Codex step exists purely as
      // configuration — no session names that harness yet.
      await advanceToStage(service, storage, kept.id, "build");

      const removed = await service.start({
        ...startInput(),
        taskId: "task-removed",
        steps: { build: { agent: "codex" } },
      });
      await advanceToStage(service, storage, removed.id, "build");
      expect(providerCache(service).has("env-1:codex")).toBe(true);

      await service.remove(removed.id);

      // The surviving pipeline has reserved Codex through its review step, so
      // disposing it here would tear the bridge out from under that stage.
      expect(codex.disposed).toBe(0);
      expect(providerCache(service).has("env-1:codex")).toBe(true);
    });
  });
});
