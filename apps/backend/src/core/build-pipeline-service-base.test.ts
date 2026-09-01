import { describe, expect, mock, test } from "bun:test";

import { promises as fs } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import type {
  BuildPipeline,
  PipelineSession,
  PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";

import { isBuildPipeline } from "@orkestrator/protocol/build-pipeline";

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
import {
  TEST_REVIEW_PREPARATION,
  testGeneratedReviewPackage,
} from "./build-pipeline-test-fixtures.js";

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

class FakeProvider implements BuildPipelineProvider {
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

  async status(_sessionId: string): Promise<ProviderStatus> {
    return "idle";
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
          : { complete: true, rationale: "All criteria pass." }) as T,
    };
  }

  async abort(_sessionId: string): Promise<void> {}
}

async function withService(
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
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-runner-"));
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
    if (command === "generate_looped_review_package") {
      return testGeneratedReviewPackage(args) as T;
    }
    if (command === "verify_looped_review_package") return { valid: true } as T;
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
  });
  try {
    await run(service, storage, provider, invocations, controls);
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function pipeline(storage: StorageService, id: string): Promise<BuildPipeline> {
  const stored = await storage.getBuildPipeline(id);
  if (!stored) throw new Error("Pipeline disappeared");
  return stored.snapshot as BuildPipeline;
}

function startInput(
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

function pendingQuestion(sessionId: string, id = "question-1"): AgentInteractionRequest {
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
function installInteractions(provider: FakeProvider, interactions: ProviderInteractions): void {
  (provider as unknown as { interactions: ProviderInteractions }).interactions = interactions;
}

/** Runs the two provisioning passes and returns the live build session. */
async function startBuilding(
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
async function mutateStored(
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

async function startVerifying(
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

describe("BuildPipelineService", () => {
  test("rejects malformed starts and environments already being deleted", async () => {
    await withService(async (service, storage) => {
      await expect(service.start({} as never)).rejects.toThrow(
        "Invalid build pipeline start request",
      );

      await storage.updateEnvironment("env-1", {
        deletionRequestedAt: new Date().toISOString(),
      });
      await expect(service.start(startInput())).rejects.toThrow("does not belong to this project");
      expect(await storage.listBuildPipelines("project-1")).toEqual([]);
    });
  });

  test("admits one equivalent start across two backend processes", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-admission-"));
    const firstStorage = new StorageService(dataDir);
    const secondStorage = new StorageService(dataDir);
    await Promise.all([firstStorage.init(), secondStorage.init()]);
    await firstStorage.addEnvironment({
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
    const invoke = async <T>(): Promise<T> => {
      throw new Error("No backend command should run during admission");
    };
    const first = new BuildPipelineService(firstStorage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    const second = new BuildPipelineService(secondStorage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    try {
      const [left, right] = await Promise.all([
        first.start(startInput()),
        second.start(startInput()),
      ]);
      expect(right.id).toBe(left.id);
      expect(await firstStorage.listBuildPipelines("project-1")).toHaveLength(1);
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("selects the build tab when setup hands off to the build stage", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).phase).toBe("waiting-for-setup");

      const buildLayout = await storage.getPaneLayout("env-1");
      const buildRoot = buildLayout?.root as
        | {
            kind?: unknown;
            id?: unknown;
            tabs?: unknown;
            activeTabId?: unknown;
          }
        | undefined;
      if (
        !buildLayout ||
        buildRoot?.kind !== "leaf" ||
        typeof buildRoot.id !== "string" ||
        !Array.isArray(buildRoot.tabs)
      ) {
        throw new Error("expected a leaf build layout");
      }
      await storage.savePaneLayout(
        "env-1",
        {
          version: buildLayout.version,
          containerId: buildLayout.containerId,
          activePaneId: buildLayout.activePaneId,
          root: {
            ...buildRoot,
            tabs: [...buildRoot.tabs, { id: "setup-terminal", type: "plain", isSetupTab: true }],
            activeTabId: "setup-terminal",
          },
        },
        buildLayout.revision,
      );
      expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
        activeTabId: "setup-terminal",
      });

      await service.advanceNow(started.id);

      expect((await pipeline(storage, started.id)).phase).toBe("building");
      expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
        activeTabId: `build-${started.id}`,
      });
    });
  });

  test("canonicalizes immutable admission identity and ignores mutable source metadata", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-canonical-"));
    const firstStorage = new StorageService(dataDir);
    const secondStorage = new StorageService(dataDir);
    await Promise.all([firstStorage.init(), secondStorage.init()]);
    await firstStorage.addEnvironment({
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
    const invoke = async <T>(): Promise<T> => undefined as T;
    const first = new BuildPipelineService(firstStorage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    const second = new BuildPipelineService(secondStorage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    try {
      const firstInput = startInput({
        existingEnvironmentId: " env-1 ",
        featurePlanId: " feature-1 ",
        source: {
          type: "linear",
          issueId: "issue-1",
          issueIdentifier: "OLD-1",
          issueUrl: "https://linear.example/old",
          status: "backlog",
          teamKey: "OLD",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      const secondInput = startInput({
        existingEnvironmentId: "env-1",
        featurePlanId: "feature-1",
        source: {
          type: "linear",
          issueId: "issue-1",
          issueIdentifier: "NEW-99",
          issueUrl: "https://linear.example/new",
          status: "started",
          teamKey: "NEW",
          updatedAt: "2026-07-29T00:00:00.000Z",
        },
      });

      const [left, right] = await Promise.all([first.start(firstInput), second.start(secondInput)]);

      expect(right.id).toBe(left.id);
      expect(await firstStorage.listBuildPipelines("project-1")).toHaveLength(1);
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("keeps distinct immutable admission identities separate", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-distinct-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    for (const id of ["env-1", "env-2"]) {
      await storage.addEnvironment({
        id,
        projectId: "project-1",
        name: id,
        branch: id,
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "full",
        order: id === "env-1" ? 0 : 1,
        environmentType: "local",
        worktreePath: `/tmp/${id}`,
        setupScriptsComplete: true,
      });
    }
    const service = new BuildPipelineService(storage, async <T>(): Promise<T> => undefined as T, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    try {
      const source = {
        type: "linear" as const,
        issueId: "issue-1",
        issueIdentifier: "TEAM-1",
      };
      const starts = [
        startInput({ taskId: "task-1", source }),
        startInput({ taskId: "task-2", source }),
        startInput({
          taskId: "task-1",
          source: { ...source, issueId: "issue-2" },
        }),
        startInput({
          taskId: "task-1",
          source,
          existingEnvironmentId: "env-2",
        }),
        startInput({
          taskId: "task-1",
          source,
          featurePlanId: "feature-2",
        }),
      ];
      const results = [];
      for (const input of starts) results.push(await service.start(input));

      expect(new Set(results.map(({ id }) => id)).size).toBe(starts.length);
      expect(await storage.listBuildPipelines("project-1")).toHaveLength(starts.length);
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("admits one concurrent new-environment start and preserves its naming prompt", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-new-env-"));
    const firstStorage = new StorageService(dataDir);
    const secondStorage = new StorageService(dataDir);
    await Promise.all([firstStorage.init(), secondStorage.init()]);
    const createEnvironment = mock(async (args: Record<string, unknown>) => {
      const environment = {
        id: "env-created",
        projectId: "project-1",
        name: "created",
        branch: "created",
        containerId: null,
        status: "running" as const,
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "full" as const,
        order: 0,
        environmentType: "local" as const,
        worktreePath: "/tmp/env-created",
        setupScriptsComplete: true,
      };
      await firstStorage.addEnvironment(environment);
      expect(args.namingPrompt).toBe("name this durable build");
      return environment;
    });
    const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
      if (command === "create_environment") {
        return (await createEnvironment(args)) as T;
      }
      throw new Error(`Unexpected command: ${command}`);
    };
    const first = new BuildPipelineService(firstStorage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    const second = new BuildPipelineService(secondStorage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    try {
      const input = startInput({
        existingEnvironmentId: undefined,
        namingPrompt: "name this durable build",
      });
      const [left, right] = await Promise.all([first.start(input), second.start(input)]);

      expect(right.id).toBe(left.id);
      expect(createEnvironment).toHaveBeenCalledTimes(1);
      expect(await firstStorage.listBuildPipelines("project-1")).toHaveLength(1);
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects a malformed snapshot returned by admission", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-malformed-"));
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
    storage.saveBuildPipeline = mock(async (_pipelineId, projectId, environmentId, version) => ({
      version,
      id: "admitted-malformed",
      projectId,
      environmentId,
      snapshot: {},
      updatedAt: new Date().toISOString(),
      revision: 1,
    }));
    const service = new BuildPipelineService(storage, async <T>(): Promise<T> => undefined as T, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    try {
      await expect(service.start(startInput())).rejects.toThrow(
        "Existing build pipeline admission is invalid",
      );
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("wires repository defaults, authentication and staged images into the production Codex provider", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(tmpdir(), "orkestrator-pipeline-production-provider-"),
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
    await storage.updateRepositoryConfig("project-1", {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: {
        defaultAgent: "codex",
        platforms: { codex: { model: "repo-codex", reasoningEffort: "xhigh" } },
      },
    });

    const requests: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/session/create")) {
        return Response.json({ sessionId: "build-production-1" });
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const invocations: Array<{
      command: string;
      args: Record<string, unknown>;
    }> = [];
    const service = new BuildPipelineService(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
        invocations.push({ command, args });
        if (
          command === "update_environment_agent_settings" ||
          command === "run_environment_setup"
        ) {
          return (await storage.getEnvironment("env-1")) as T;
        }
        if (command === "start_local_codex_server_cmd") {
          return { port: 3210, authToken: "test-auth-token" } as T;
        }
        if (command === "write_local_file") {
          return "/tmp/build/.orkestrator/prompt-attachments/shot.png" as T;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      { autoAdvance: false },
    );
    try {
      const started = await service.start(
        startInput({
          agentType: "codex",
          taskSnapshot: {
            ...startInput().taskSnapshot,
            images: [{ filename: "shot.png", data: "AAAA" }],
          },
        }),
      );
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);

      expect(invocations).toContainEqual({
        command: "start_local_codex_server_cmd",
        args: { environmentId: "env-1" },
      });
      expect(invocations).toContainEqual({
        command: "write_local_file",
        args: {
          worktreePath: "/tmp/build",
          filePath: ".orkestrator/prompt-attachments/shot.png",
          base64Data: "AAAA",
        },
      });
      expect(requests.map(({ url }) => url)).toEqual([
        "http://127.0.0.1:3210/session/create",
        "http://127.0.0.1:3210/session/build-production-1/prompt",
      ]);
      const create = requests[0]!;
      expect(new Headers(create.init.headers).get("X-Orkestrator-Codex-Token")).toBe(
        "test-auth-token",
      );
      expect(JSON.parse(String(create.init.body))).toMatchObject({
        model: "repo-codex",
        modelReasoningEffort: "xhigh",
        mode: "build",
      });
      expect(JSON.parse(String(requests[1]!.init.body))).toMatchObject({
        attachments: [
          {
            type: "image",
            path: "/tmp/build/.orkestrator/prompt-attachments/shot.png",
            filename: "shot.png",
            dataUrl: "data:image/png;base64,AAAA",
          },
        ],
      });
    } finally {
      await service.shutdown();
      globalThis.fetch = originalFetch;
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects missing and cross-project existing environments before persisting", async () => {
    await withService(async (service, storage) => {
      await expect(
        service.start(
          startInput({
            existingEnvironmentId: "missing",
          }),
        ),
      ).rejects.toThrow("does not belong to this project");
      await storage.addEnvironment({
        id: "foreign-env",
        projectId: "project-2",
        name: "foreign",
        branch: "foreign",
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "full",
        order: 0,
        environmentType: "local",
        worktreePath: "/tmp/foreign",
      });
      await expect(
        service.start(
          startInput({
            existingEnvironmentId: "foreign-env",
          }),
        ),
      ).rejects.toThrow("does not belong to this project");
      expect(await storage.listBuildPipelines("project-1")).toEqual([]);
    });
  });

  test("resume dispatches durable continuation work instead of advancing an aborted stage", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      expect(provider.sent).toHaveLength(1);

      await service.pause(started.id);
      expect((await pipeline(storage, started.id)).sessions[0]?.status).toBe("idle");
      await service.resume(started.id);
      await service.advanceNow(started.id);

      const resumed = await pipeline(storage, started.id);
      expect(resumed.phase).toBe("building");
      expect(resumed.sessions[0]?.status).toBe("running");
      expect(provider.sent).toHaveLength(2);
      expect(resumed.pendingPromptAttempt).toBeUndefined();
    });
  });

  test("completes PR creation when GitHub mergeability is still indeterminate", async () => {
    await withService(async (service, storage, _provider, invocations, controls) => {
      controls.detection = {
        url: "https://github.com/acme/repo/pull/43",
        state: "open",
        hasMergeConflicts: null,
      };
      const started = await service.start(startInput());
      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }

      expect((await pipeline(storage, started.id)).phase).toBe("complete");
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        prUrl: "https://github.com/acme/repo/pull/43",
        prState: "open",
        hasMergeConflicts: null,
      });
      expect(invocations).toContainEqual({
        command: "pr_monitor_watch",
        args: { environmentId: "env-1", mode: "normal" },
      });
    });
  });

  test("fails a local build cleanly when the project has no host checkout", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-no-checkout-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    // What `create_environment` now answers for a remote-only project.
    const rejection = "Project has no local path - cannot create a local worktree";
    const invoke = async <T>(command: string): Promise<T> => {
      if (command !== "create_environment") {
        throw new Error(`Unexpected command: ${command}`);
      }
      throw new Error(rejection);
    };
    const service = new BuildPipelineService(storage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });

    try {
      await expect(
        service.start(
          startInput({
            existingEnvironmentId: undefined,
            environmentType: "local",
          }),
        ),
      ).rejects.toThrow(rejection);

      // The rejection must land as a terminal, explained failure rather than
      // leaving the pipeline parked in `creating-environment` forever.
      const pipelines = await storage.listBuildPipelines("project-1");
      expect(pipelines).toHaveLength(1);
      const pipeline = pipelines[0]!.snapshot as BuildPipeline;
      expect(pipeline.phase).toBe("failed");
      expect(pipeline.error).toContain(rejection);
      expect(pipeline.environmentId).toBeFalsy();
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  for (const status of ["missing", "error"] as const) {
    test(`fails durably when provider status is ${status}`, async () => {
      await withService(async (service, storage, provider) => {
        const started = await service.start(startInput());
        await service.advanceNow(started.id);
        await service.advanceNow(started.id);
        provider.status = async () => status;
        await service.advanceNow(started.id);
        expect(await pipeline(storage, started.id)).toMatchObject({
          phase: "failed",
          error: expect.stringContaining(status === "missing" ? "no longer available" : "failed"),
        });
      });
    });
  }

  test("persists the provider's session failure detail", async () => {
    await withService(async (service, storage, provider) => {
      const { started } = await startBuilding(service, storage);
      provider.status = async () => {
        throw new Error("The codex session failed: stream disconnected before completion");
      };

      await service.advanceNow(started.id);

      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        error: "The codex session failed: stream disconnected before completion",
      });
    });
  });

  for (const result of ["rejected", "provider-unavailable"] as const) {
    test(`fails safely when the provider interaction response is ${result}`, async () => {
      await withService(async (service, storage, provider) => {
        const started = await service.start(startInput({ taskId: `task-${result}` }));
        await service.advanceNow(started.id);
        await service.advanceNow(started.id);
        const running = await pipeline(storage, started.id);
        const session = running.sessions[running.currentSessionIndex]!;
        const request = pendingQuestion(session.sdkSessionId, `${result}-question`);
        (
          provider as unknown as BuildPipelineProvider & {
            interactions: NonNullable<BuildPipelineProvider["interactions"]>;
          }
        ).interactions = {
          async listPendingInteractions() {
            return {
              version: AGENT_INTERACTION_CONTRACT_VERSION,
              revision: 1,
              requests: [request],
            };
          },
          async resolveInteraction(sessionId, interactionId) {
            return { result, sessionId, interactionId, revision: 1 };
          },
        };

        await service.advanceNow(started.id);
        expect(await pipeline(storage, started.id)).toMatchObject({
          phase: "failed",
          failureContext: {
            kind: "interactive-request",
            requestId: request.id,
          },
        });
        const journal = await storage.getAgentInteractionResolutionJournal();
        expect(journal.entries.find((entry) => entry.interactionId === request.id)).toMatchObject({
          state: "workflow-recorded",
          outcome: "failed",
        });
      });
    });
  }

  for (const concurrentAction of ["pause", "cancel"] as const) {
    test(`terminal authorization outcome merges over a concurrent ${concurrentAction}`, async () => {
      await withService(async (service, storage, provider, _invocations, controls) => {
        const started = await service.start(startInput());
        await service.advanceNow(started.id);
        await service.advanceNow(started.id);
        const running = await pipeline(storage, started.id);
        const session = running.sessions[running.currentSessionIndex]!;
        const request: AgentInteractionRequest = {
          ...pendingQuestion(session.sdkSessionId, `authorization-${concurrentAction}`),
          kind: "permission",
          presentation: {
            title: "Authorize an unexpected privilege",
            questions: [],
          },
        };
        let requests = [request];
        let resolveCalls = 0;
        let resolutionAction = "";
        (
          provider as unknown as BuildPipelineProvider & {
            interactions: NonNullable<BuildPipelineProvider["interactions"]>;
          }
        ).interactions = {
          async listPendingInteractions() {
            return {
              version: AGENT_INTERACTION_CONTRACT_VERSION,
              revision: resolveCalls,
              requests,
            };
          },
          async resolveInteraction(sessionId, interactionId, resolution) {
            resolveCalls += 1;
            resolutionAction = resolution.action;
            requests = [];
            return { result: "applied", sessionId, interactionId, revision: 1 };
          },
        };
        const concurrentStorage = new StorageService(controls.dataDir);
        await concurrentStorage.init();
        const concurrentService = new BuildPipelineService(
          concurrentStorage,
          async <T>(): Promise<T> => {
            throw new Error("No backend command is expected");
          },
          { autoAdvance: false, provider: async () => provider },
        );
        const originalUpdateJournal = storage.updateAgentInteractionResolutionJournal.bind(storage);
        let releaseProviderResolved!: () => void;
        const providerResolved = new Promise<void>((resolve) => {
          releaseProviderResolved = resolve;
        });
        let allowOutcomeSave!: () => void;
        const outcomeSaveAllowed = new Promise<void>((resolve) => {
          allowOutcomeSave = resolve;
        });
        let blockedProviderResolved = false;
        storage.updateAgentInteractionResolutionJournal = async (...args) => {
          const journal = await originalUpdateJournal(...args);
          if (
            !blockedProviderResolved &&
            journal.entries.some(
              (entry) => entry.interactionId === request.id && entry.state === "provider-resolved",
            )
          ) {
            blockedProviderResolved = true;
            releaseProviderResolved();
            await outcomeSaveAllowed;
          }
          return journal;
        };
        try {
          const advancing = service.advanceNow(started.id);
          await providerResolved;

          if (concurrentAction === "pause") {
            const paused = await concurrentService.pause(started.id);
            expect(paused).toMatchObject({
              phase: "paused",
              pausedFromPhase: "building",
            });
          } else {
            const cancelled = await concurrentService.cancel(started.id);
            expect(cancelled).toMatchObject({
              phase: "failed",
              error: "Build cancelled",
            });
          }
          allowOutcomeSave();
          await advancing;

          const resolved = await pipeline(storage, started.id);
          expect(isBuildPipeline(resolved)).toBe(true);
          expect(blockedProviderResolved).toBe(true);
          expect(resolveCalls).toBe(1);
          expect(resolutionAction).toBe("deny");
          expect(resolved.pendingInteractionResolution).toBeUndefined();
          if (concurrentAction === "pause") {
            expect(resolved).toMatchObject({
              phase: "failed",
              error: expect.stringContaining("requested unexpected authorization"),
              failureContext: {
                phase: "building",
                kind: "interactive-request",
                sessionId: session.sdkSessionId,
                requestId: request.id,
              },
            });
            expect(resolved.pausedFromPhase).toBeUndefined();
          } else {
            expect(resolved).toMatchObject({
              phase: "failed",
              error: "Build cancelled",
            });
          }
          const journal = await storage.getAgentInteractionResolutionJournal();
          expect(journal.entries).toContainEqual(
            expect.objectContaining({
              interactionId: request.id,
              state: "workflow-recorded",
              outcome: "denied",
            }),
          );
        } finally {
          allowOutcomeSave();
          storage.updateAgentInteractionResolutionJournal = originalUpdateJournal;
          await concurrentService.shutdown();
        }
      });
    });
  }

  for (const [label, legacyMessage, expectedRequestId] of [
    [
      "nested provider metadata",
      { info: { role: "user", id: "legacy-info-request" } },
      "legacy-info-request",
    ],
    ["an explicit requestId", { requestId: "legacy-explicit-request" }, "legacy-explicit-request"],
    [
      "a top-level user message",
      { id: "legacy-user-request", role: "user" },
      "legacy-user-request",
    ],
  ] as const) {
    test(`recovers a legacy verification request id from ${label}`, async () => {
      await withService(async (service, storage, provider) => {
        const verifying = await startVerifying(service, storage);
        const record = await storage.getBuildPipeline(verifying.id);
        if (!record) throw new Error("Pipeline disappeared");
        const snapshot = record.snapshot as BuildPipeline;
        const session = snapshot.sessions[snapshot.currentSessionIndex]!;
        delete session.structuredRequestId;
        await storage.saveBuildPipeline(
          snapshot.id,
          snapshot.projectId,
          snapshot.environmentId,
          record.version,
          snapshot,
          record.revision,
        );

        provider.messages = async (sessionId) =>
          provider.phases.get(sessionId) === "verify" ? [legacyMessage] : [];
        let observedRequestId = "";
        provider.structured = async <T>(
          sessionId: string,
          requestId: string,
        ): Promise<StructuredOutputResult<T>> => {
          observedRequestId = requestId;
          return {
            ok: true,
            provider: "claude",
            requestId,
            value: (provider.phases.get(sessionId) === "review"
              ? cleanReview
              : { complete: true, rationale: "Recovered." }) as T,
          };
        };

        await service.advanceNow(verifying.id);

        expect(observedRequestId).toBe(expectedRequestId);
        expect((await pipeline(storage, verifying.id)).phase).toBe("creating-pr");
      });
    });
  }

  test("loops through fix work and stops at the verification iteration bound", async () => {
    await withService(async (service, storage, provider) => {
      provider.structured = async <T>(
        sessionId: string,
        requestId: string,
      ): Promise<StructuredOutputResult<T>> => ({
        ok: true,
        provider: "claude",
        requestId,
        value: (provider.phases.get(sessionId) === "review"
          ? cleanReview
          : provider.phases.get(sessionId) === "build" || provider.phases.get(sessionId) === "fix"
            ? TEST_REVIEW_PREPARATION
            : { complete: false, rationale: "Still failing acceptance checks." }) as T,
      });
      const started = await service.start(startInput({ maxIterations: 1 }));
      for (let pass = 0; pass < 8; pass += 1) {
        await service.advanceNow(started.id);
      }
      const failed = await pipeline(storage, started.id);
      expect(failed).toMatchObject({
        phase: "failed",
        iteration: 1,
        verificationResult: "fail",
        error: expect.stringContaining("failed after 1 iterations"),
      });
      expect(failed.sessions.map((session) => session.phase)).toEqual([
        "build",
        "review",
        "verify",
        "fix",
        "review",
        "verify",
      ]);
      const retainedReports = failed.sessions.filter((session) => session.reviewReport);
      expect(retainedReports).toHaveLength(1);
      expect(retainedReports[0]?.iteration).toBe(failed.iteration);
    });
  });

  test("persists a conflicting PR and completes only after resolution is verified", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      controls.detection = {
        url: "https://github.com/acme/repo/pull/9",
        state: "open",
        hasMergeConflicts: true,
      };
      const started = await service.start(startInput());
      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "resolving-conflicts",
      });
      controls.detection = {
        ...controls.detection,
        hasMergeConflicts: null,
      };
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).phase).toBe("resolving-conflicts");
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        prUrl: "https://github.com/acme/repo/pull/9",
        hasMergeConflicts: null,
      });
      controls.detection = {
        ...controls.detection,
        hasMergeConflicts: false,
      };
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).phase).toBe("complete");
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        prUrl: "https://github.com/acme/repo/pull/9",
        hasMergeConflicts: false,
      });
    });
  });

  for (const result of ["already-resolved", "stale"] as const) {
    for (const kind of ["question", "permission"] as const) {
      test(`reconciles an ${result} ${kind} to a terminal outcome once it is gone`, async () => {
        await withService(async (service, storage, provider) => {
          const { started, session } = await startBuilding(service, storage, {
            taskId: `task-${result}-${kind}`,
          });
          const request: AgentInteractionRequest = {
            ...pendingQuestion(session.sdkSessionId, `${result}-${kind}`),
            kind,
          };
          let requests = [request];
          let resolveCalls = 0;
          installInteractions(provider, {
            async listPendingInteractions() {
              return {
                version: AGENT_INTERACTION_CONTRACT_VERSION,
                revision: 1,
                requests,
              };
            },
            async resolveInteraction(sessionId, interactionId) {
              resolveCalls += 1;
              // The provider had already applied the response; the reconcile
              // read is the only evidence that it is terminal and not failed.
              requests = [];
              return { result, sessionId, interactionId, revision: 2 };
            },
          });

          await service.advanceNow(started.id);

          expect(resolveCalls).toBe(1);
          const resolved = await pipeline(storage, started.id);
          const journalEntry = (await storage.getAgentInteractionResolutionJournal()).entries.find(
            (entry) => entry.interactionId === request.id,
          );
          if (kind === "question") {
            expect(resolved).toMatchObject({
              phase: "building",
              autoDeclineCount: 1,
            });
            expect(journalEntry).toMatchObject({
              state: "workflow-recorded",
              outcome: "auto-declined",
            });
          } else {
            expect(resolved).toMatchObject({
              phase: "failed",
              error: expect.stringContaining("requested unexpected authorization"),
              failureContext: {
                kind: "interactive-request",
                requestId: request.id,
              },
            });
            expect(journalEntry).toMatchObject({
              state: "workflow-recorded",
              outcome: "denied",
            });
          }
        });
      });
    }
  }

  test("refuses to persist a structurally invalid pipeline snapshot", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      // A bridge answering with an empty session id would otherwise commit a
      // snapshot every later read rejects, hiding the pipeline permanently.
      provider.createSession = async () => "";

      await service.advanceNow(started.id);

      const refused = await pipeline(storage, started.id);
      expect(refused).toMatchObject({
        phase: "failed",
        error: `Refusing to persist an invalid build pipeline snapshot: ${started.id}`,
      });
      expect(refused.sessions).toEqual([]);
      expect(isBuildPipeline(refused)).toBe(true);
    });
  });

  for (const action of ["pause", "cancel"] as const) {
    test(`${action} clears a stall warning that no longer applies`, async () => {
      await withService(async (service, storage) => {
        const { started, session } = await startBuilding(service, storage);
        await mutateStored(storage, started.id, (snapshot) => {
          snapshot.stallWarning = {
            sessionId: session.sdkSessionId,
            detectedAt: new Date().toISOString(),
          };
        });

        const result =
          action === "pause" ? await service.pause(started.id) : await service.cancel(started.id);

        // The warning says the stage "is still running"; a stopped build is not,
        // and no later pass would ever clear it.
        expect(result.phase).toBe(action === "pause" ? "paused" : "failed");
        expect(result.stallWarning).toBeUndefined();
        expect((await pipeline(storage, started.id)).stallWarning).toBeUndefined();
      });
    });
  }
});
