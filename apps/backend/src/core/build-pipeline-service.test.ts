import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  BuildPipeline,
  PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import {
  isBuildPipeline,
  VERIFICATION_VERDICT_SCHEMA,
} from "@orkestrator/protocol/build-pipeline";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_CLAIM_RETENTION_MS,
  AGENT_INTERACTION_JOURNAL_VERSION,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type {
  JsonSchema,
  StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import { StorageService } from "./storage.js";
import {
  BuildPipelineService,
} from "./build-pipeline-service.js";
import type {
  BuildPipelineProvider,
  ProviderCreateSessionOptions,
  ProviderSessionRegistration,
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
    keyCodeChanges: [{
      file: "src/app.ts",
      line: 1,
      description: "Adds the feature.",
    }],
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

  registerSession(
    sessionId: string,
    interaction?: ProviderSessionRegistration,
  ): void {
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
    return [{
      id: `${sessionId}-assistant`,
      role: "assistant",
      parts: [{ type: "text", content: "Finished" }],
    }];
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T>> {
    const phase = this.phases.get(sessionId);
    return {
      ok: true,
      provider: "claude",
      requestId,
      value: (phase === "review"
        ? cleanReview
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
      kanbanTasks: Map<string, {
        id: string;
        status: string;
        prUrl?: string;
        prState?: string;
        comments: Array<{ text: string }>;
      }>;
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
  const kanbanTasks = new Map<string, {
    id: string;
    status: string;
    prUrl?: string;
    prState?: string;
    comments: Array<{ text: string }>;
  }>();
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
    kanbanTasks,
  };
  const invoke = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    invocations.push({ command, args });
    if (controls.failCommands.has(command)) {
      throw new Error(`${command} failed`);
    }
    if (command === "detect_pr_local" || command === "detect_pr") {
      return controls.detection as T;
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
    if (command === "update_feature_plan") return undefined as T;
    if (command === "pr_monitor_watch") return undefined as T;
    if (
      command === "post_linear_completion_comment"
      || command === "post_github_completion_comment"
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

async function pipeline(
  storage: StorageService,
  id: string,
): Promise<BuildPipeline> {
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

function pendingQuestion(
  sessionId: string,
  id = "question-1",
): AgentInteractionRequest {
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
      await expect(service.start(startInput())).rejects.toThrow(
        "does not belong to this project",
      );
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

      const [left, right] = await Promise.all([
        first.start(firstInput),
        second.start(secondInput),
      ]);

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
    const service = new BuildPipelineService(
      storage,
      async <T>(): Promise<T> => undefined as T,
      {
        autoAdvance: false,
        provider: async () => new FakeProvider(),
      },
    );
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
      expect(await storage.listBuildPipelines("project-1")).toHaveLength(
        starts.length,
      );
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
    const invoke = async <T>(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<T> => {
      if (command === "create_environment") {
        return await createEnvironment(args) as T;
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
      const [left, right] = await Promise.all([
        first.start(input),
        second.start(input),
      ]);

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
    storage.saveBuildPipeline = mock(async (
      _pipelineId,
      projectId,
      environmentId,
      version,
    ) => ({
      version,
      id: "admitted-malformed",
      projectId,
      environmentId,
      snapshot: {},
      updatedAt: new Date().toISOString(),
      revision: 1,
    }));
    const service = new BuildPipelineService(
      storage,
      async <T>(): Promise<T> => undefined as T,
      {
        autoAdvance: false,
        provider: async () => new FakeProvider(),
      },
    );
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
      defaultAgent: "codex",
      defaultModel: "repo-codex",
      defaultEffort: "xhigh",
    });

    const requests: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (
      input: string | URL | Request,
      init: RequestInit = {},
    ) => {
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
      async <T>(
        command: string,
        args: Record<string, unknown> = {},
      ): Promise<T> => {
        invocations.push({ command, args });
        if (
          command === "update_environment_agent_settings"
          || command === "run_environment_setup"
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
      const started = await service.start(startInput({
        agentType: "codex",
        taskSnapshot: {
          ...startInput().taskSnapshot,
          images: [{ filename: "shot.png", data: "AAAA" }],
        },
      }));
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
      expect(new Headers(create.init.headers).get("X-Orkestrator-Codex-Token"))
        .toBe("test-auth-token");
      expect(JSON.parse(String(create.init.body))).toMatchObject({
        model: "repo-codex",
        modelReasoningEffort: "xhigh",
        mode: "build",
      });
      expect(JSON.parse(String(requests[1]!.init.body))).toMatchObject({
        attachments: [{
          type: "image",
          path: "/tmp/build/.orkestrator/prompt-attachments/shot.png",
          filename: "shot.png",
          dataUrl: "data:image/png;base64,AAAA",
        }],
      });
    } finally {
      await service.shutdown();
      globalThis.fetch = originalFetch;
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("owns and advances the complete pipeline without a renderer", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start({
        taskId: "task-1",
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
        source: { type: "kanban", taskId: "task-1" },
        existingEnvironmentId: "env-1",
      });

      expect(started).toMatchObject({
        controller: "backend",
        phase: "starting-environment",
        environmentId: "env-1",
      });

      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }

      const completed = await pipeline(storage, started.id);
      expect(completed.phase).toBe("complete");
      expect(completed.sessions.map((session) => session.phase)).toEqual([
        "build",
        "review",
        "verify",
        "pr",
      ]);
      expect(completed.sessions.every((session) =>
        Array.isArray(session.messages))).toBe(true);
      expect(provider.sent).toHaveLength(4);
      const verificationDispatch = provider.sent.find((entry) =>
        provider.phases.get(entry.sessionId) === "verify"
      );
      expect(verificationDispatch?.schema).toBe(VERIFICATION_VERDICT_SCHEMA);
      expect(completed.verificationResult).toBe("pass");
    });
  });

  test("pause and cancel are backend mutations and abort running work", async () => {
    await withService(async (service, storage, provider) => {
      let aborted = "";
      provider.abort = async (sessionId) => {
        aborted = sessionId;
      };
      const started = await service.start({
        taskId: "task-2",
        projectId: "project-1",
        environmentType: "local",
        agentType: "claude",
        taskTitle: "Control pipeline",
        taskSnapshot: {
          title: "Control pipeline",
          description: "",
          acceptanceCriteria: "",
          comments: [],
          images: [],
        },
        existingEnvironmentId: "env-1",
      });
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const running = await pipeline(storage, started.id);
      expect(running.phase).toBe("building");

      const paused = await service.pause(started.id);
      expect(paused.phase).toBe("paused");
      expect(aborted).toBe(running.sessions[0]?.sdkSessionId ?? "");

      const resumed = await service.resume(started.id);
      expect(resumed.phase).toBe("building");
      const cancelled = await service.cancel(started.id);
      expect(cancelled).toMatchObject({
        phase: "failed",
        error: "Build cancelled",
        controller: "backend",
      });
    });
  });

  test("publishes running transcripts from the backend before a stage completes", async () => {
    await withService(async (service, storage, provider) => {
      provider.status = async () => "running";
      provider.messages = async (sessionId) => [{
        id: `${sessionId}-assistant`,
        role: "assistant",
        parts: [{ type: "text", content: "Implementing the backend runner" }],
      }];
      const started = await service.start({
        taskId: "task-live",
        projectId: "project-1",
        environmentType: "local",
        agentType: "claude",
        taskTitle: "Live transcript",
        taskSnapshot: {
          title: "Live transcript",
          description: "",
          acceptanceCriteria: "",
          comments: [],
          images: [],
        },
        existingEnvironmentId: "env-1",
      });

      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);

      const running = await pipeline(storage, started.id);
      expect(running.phase).toBe("building");
      expect(running.sessions[0]).toMatchObject({
        status: "running",
        messageRevision: 1,
        messages: [expect.objectContaining({ role: "assistant" })],
      });
    });
  });

  test("durably links Kanban and feature-plan ownership before advancing", async () => {
    await withService(async (service, storage, _provider, invocations) => {
      const started = await service.start({
        taskId: "task-3",
        projectId: "project-1",
        environmentType: "local",
        agentType: "codex",
        taskTitle: "Feature pipeline",
        taskSnapshot: {
          title: "Feature pipeline",
          description: "",
          acceptanceCriteria: "",
          comments: [],
          images: [],
        },
        source: { type: "kanban", taskId: "task-3" },
        featurePlanId: "feature-1",
        existingEnvironmentId: "env-1",
      });

      expect(started.sourceLinkedAt).toBeString();
      expect(invocations).toContainEqual({
        command: "update_kanban_task",
        args: {
          taskId: "task-3",
          environmentId: "env-1",
          buildPipelineId: started.id,
        },
      });
      expect(invocations).toContainEqual({
        command: "update_feature_plan",
        args: {
          featureId: "feature-1",
          updates: {
            status: "building",
            buildTaskId: "task-3",
            buildPipelineId: started.id,
            codexEnvironmentId: "env-1",
          },
        },
      });
      expect((await pipeline(storage, started.id)).sourceLinkedAt).toBeString();
    });
  });

  test("recovers an environment created before the pipeline association was saved", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-recovery-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "recovered-env",
      projectId: "project-1",
      buildPipelineId: "recovering-pipeline",
      name: "recovered",
      branch: "recovered",
      containerId: null,
      status: "stopped",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
      worktreePath: "/tmp/recovered",
    });
    const recovering: BuildPipeline = {
      id: "recovering-pipeline",
      taskId: "task-3",
      projectId: "project-1",
      environmentId: "",
      environmentType: "local",
      agentType: "claude",
      phase: "creating-environment",
      sessions: [],
      currentSessionIndex: -1,
      iteration: 0,
      maxIterations: 3,
      createdAt: new Date(0).toISOString(),
      taskTitle: "Recover pipeline",
      taskSnapshot: {
        title: "Recover pipeline",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      backendRevision: 0,
      controller: "backend",
    };
    await storage.saveBuildPipeline(
      recovering.id,
      recovering.projectId,
      "",
      2,
      recovering,
      0,
    );
    let createCalls = 0;
    const service = new BuildPipelineService(
      storage,
      async <T>(command: string): Promise<T> => {
        if (command === "create_environment") createCalls += 1;
        throw new Error(`Unexpected command: ${command}`);
      },
      {
        autoAdvance: false,
        provider: async () => new FakeProvider(),
      },
    );
    try {
      await service.advanceNow(recovering.id);
      expect(createCalls).toBe(0);
      expect(await pipeline(storage, recovering.id)).toMatchObject({
        environmentId: "recovered-env",
        environmentType: "local",
        phase: "starting-environment",
      });
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects missing and cross-project existing environments before persisting", async () => {
    await withService(async (service, storage) => {
      await expect(service.start(startInput({
        existingEnvironmentId: "missing",
      }))).rejects.toThrow("does not belong to this project");
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
      await expect(service.start(startInput({
        existingEnvironmentId: "foreign-env",
      }))).rejects.toThrow("does not belong to this project");
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

  test("persists pause and cancel intent even when abort cannot be confirmed", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      provider.abort = async () => {
        throw new Error("bridge disconnected");
      };

      await expect(service.pause(started.id)).rejects.toThrow("bridge disconnected");
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "paused",
        error: expect.stringContaining("could not be confirmed"),
      });

      await service.resume(started.id);
      await expect(service.cancel(started.id)).rejects.toThrow("bridge disconnected");
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        error: expect.stringContaining("could not be confirmed"),
      });
    });
  });

  test("does not complete until PR detection returns an authoritative result", async () => {
    await withService(async (service, storage, _provider, invocations, controls) => {
      controls.detection = null;
      const started = await service.start(startInput());
      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }
      expect((await pipeline(storage, started.id)).phase).toBe("creating-pr");
      expect(invocations).toContainEqual({
        command: "pr_monitor_watch",
        args: { environmentId: "env-1", mode: "create-pending" },
      });

      controls.detection = {
        url: "https://github.com/acme/repo/pull/42",
        state: "open",
        hasMergeConflicts: false,
      };
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).phase).toBe("complete");
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        prUrl: "https://github.com/acme/repo/pull/42",
        prState: "open",
        hasMergeConflicts: false,
      });
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

  test("uses container PR detection for containerized build environments", async () => {
    await withService(async (service, storage, _provider, invocations) => {
      await storage.updateEnvironment("env-1", {
        environmentType: "containerized",
        containerId: "container-1",
      });
      const started = await service.start(startInput({
        environmentType: "containerized",
      }));
      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }

      expect((await pipeline(storage, started.id)).phase).toBe("complete");
      expect(invocations).toContainEqual({
        command: "detect_pr",
        args: { containerId: "container-1", branch: "build" },
      });
      expect(invocations.some(({ command }) => command === "detect_pr_local"))
        .toBe(false);
    });
  });

  test("fails when a containerized build has no container for PR detection", async () => {
    await withService(async (service, storage) => {
      await storage.updateEnvironment("env-1", {
        environmentType: "containerized",
        containerId: null,
      });
      const started = await service.start(startInput({
        environmentType: "containerized",
      }));
      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }

      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        error: "Build container is unavailable",
      });
    });
  });

  test("rejects malformed pull request detection results", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      controls.detection = {
        url: "",
        state: "unknown",
        hasMergeConflicts: "yes",
      } as unknown as typeof controls.detection;
      const started = await service.start(startInput());
      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }

      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        error: "Pull request detection returned an invalid result",
      });
    });
  });

  test("restores Kanban lifecycle transitions, comments, and PR metadata idempotently", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      const started = await service.start(startInput({
        taskId: "task-kanban",
        source: { type: "kanban", taskId: "task-kanban" },
      }));
      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }
      const task = controls.kanbanTasks.get("task-kanban");
      expect((await pipeline(storage, started.id)).phase).toBe("complete");
      expect(task).toMatchObject({
        status: "review",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open",
      });
      expect(task?.comments.map((comment) => comment.text)).toEqual([
        "🔨 Build started",
        "✅ Validation complete",
        "🔗 PR raised: https://github.com/acme/repo/pull/1",
      ]);
      await service.advanceNow(started.id);
      expect(task?.comments).toHaveLength(3);
    });
  });

  test("persists terminal comment failures and retries the idempotent command", async () => {
    await withService(async (service, storage, _provider, invocations, controls) => {
      controls.failCommands.add("post_github_completion_comment");
      const started = await service.start(startInput({
        source: {
          type: "github",
          repositoryOwner: "acme",
          repositoryName: "repo",
          issueNumber: 7,
          issueUrl: "https://github.com/acme/repo/issues/7",
          status: "open",
        },
      }));
      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "complete",
        completionCommentStatus: "failed",
        completionCommentError: "post_github_completion_comment failed",
      });

      await expect(service.retryCompletionComment(started.id)).rejects.toThrow(
        "post_github_completion_comment failed",
      );
      expect(await pipeline(storage, started.id)).toMatchObject({
        completionCommentStatus: "failed",
        completionCommentError: "post_github_completion_comment failed",
      });

      controls.failCommands.delete("post_github_completion_comment");
      const retried = await service.retryCompletionComment(started.id);
      expect(retried).toMatchObject({
        completionCommentStatus: "posted",
        completionCommentId: "comment-1",
      });
      expect(invocations.filter((entry) =>
        entry.command === "post_github_completion_comment")).toHaveLength(3);
    });
  });

  test("imports only valid unowned legacy snapshots and never overwrites backend records", async () => {
    await withService(async (service, storage) => {
      const legacy = {
        ...startInput(),
        id: "legacy-pipeline",
        environmentId: "env-1",
        phase: "building",
        sessions: [],
        currentSessionIndex: -1,
        iteration: 0,
        maxIterations: 3,
        createdAt: new Date(0).toISOString(),
        backendRevision: 99,
      };
      delete (legacy as { existingEnvironmentId?: string }).existingEnvironmentId;
      delete (legacy as { namingPrompt?: string }).namingPrompt;

      const first = await service.importLegacy("project-1", [
        legacy,
        { id: "malformed" },
        { ...legacy, id: "foreign", projectId: "project-2" },
      ]);
      expect(first).toEqual({ importedIds: ["legacy-pipeline"], skipped: 2 });
      expect(await pipeline(storage, "legacy-pipeline")).toMatchObject({
        controller: "backend",
        backendRevision: 1,
      });
      const duplicate = await service.importLegacy("project-1", [legacy]);
      expect(duplicate).toEqual({ importedIds: [], skipped: 1 });

      expect(await service.importLegacy("", [legacy])).toEqual({
        importedIds: [],
        skipped: 1,
      });
      expect(await service.importLegacy(
        "project-1",
        null as unknown as unknown[],
      )).toEqual({ importedIds: [], skipped: 0 });

      expect(await service.importLegacy("project-1", [{
        ...legacy,
        id: "missing-environment",
        environmentId: "does-not-exist",
      }])).toEqual({ importedIds: [], skipped: 1 });

      await storage.addEnvironment({
        ...(await storage.getEnvironment("env-1"))!,
        id: "owned-env",
        name: "owned",
        branch: "owned",
        worktreePath: "/tmp/owned",
        buildPipelineId: "another-pipeline",
      });
      expect(await service.importLegacy("project-1", [{
        ...legacy,
        id: "owned-environment",
        environmentId: "owned-env",
      }])).toEqual({ importedIds: [], skipped: 1 });
    });
  });

  test("does not report or persist a legacy snapshot that collides with an active admission", async () => {
    await withService(async (service, storage) => {
      const active = await service.start(startInput({
        taskId: "admission-collision",
      }));
      const collidingId = "legacy-admission-collision";
      const collidingSnapshot: BuildPipeline = {
        ...active,
        id: collidingId,
        backendRevision: 0,
        controller: "backend",
      };

      const result = await service.importLegacy("project-1", [
        collidingSnapshot,
      ]);

      expect(result).toEqual({ importedIds: [], skipped: 1 });
      expect(await storage.getBuildPipeline(collidingId)).toBeNull();
      expect(await storage.getBuildPipeline(active.id)).toMatchObject({
        id: active.id,
        snapshot: expect.objectContaining({
          admissionKey: active.admissionKey,
          taskId: "admission-collision",
        }),
      });
      expect(await storage.listBuildPipelines("project-1")).toHaveLength(1);
    });
  });

  test("remove disposes a cached provider only after its final pipeline is gone", async () => {
    await withService(async (service, storage, provider) => {
      const first = await service.start(startInput({ taskId: "remove-first" }));
      const second = await service.start(startInput({ taskId: "remove-second" }));
      await service.cancel(first.id);
      await service.cancel(second.id);

      const dispose = mock(async () => {});
      (provider as FakeProvider & { dispose: () => Promise<void> }).dispose =
        dispose;
      const providers = (service as unknown as {
        providers: Map<string, BuildPipelineProvider>;
      }).providers;
      providers.set("env-1:claude", provider);

      await service.remove(first.id);
      expect(await storage.getBuildPipeline(first.id)).toBeNull();
      expect(dispose).not.toHaveBeenCalled();

      await service.remove(second.id);
      expect(await storage.getBuildPipeline(second.id)).toBeNull();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(providers.has("env-1:claude")).toBe(false);
    });
  });

  test("coalesces a timer-style provisioning race without losing the custom name prompt", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-race-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    let service: BuildPipelineService;
    let createCalls = 0;
    let observedNamingPrompt: unknown;
    let buildPipelineEvents = 0;
    const invoke = async <T>(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<T> => {
      if (command !== "create_environment") {
        throw new Error(`Unexpected command: ${command}`);
      }
      createCalls += 1;
      observedNamingPrompt = args.namingPrompt;
      const environment = await storage.addEnvironment({
        id: "created-env",
        projectId: "project-1",
        buildPipelineId: String(args.buildPipelineId),
        name: "created",
        branch: "created",
        containerId: null,
        status: "stopped",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "full",
        order: 0,
        environmentType: "local",
        worktreePath: "/tmp/created",
      });
      return environment as T;
    };
    service = new BuildPipelineService(storage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    storage.setResourceChangeListener((change) => {
      if (change.resource !== "build-pipeline") return;
      buildPipelineEvents += 1;
      if (buildPipelineEvents === 1) {
        void service.advanceNow(change.id);
      } else if (buildPipelineEvents === 2) {
        // The environment association is now visible, but the provisioning
        // pass has not necessarily released its lock. Model a timer callback
        // scheduled at precisely that boundary.
        queueMicrotask(() => {
          void service.advanceNow(change.id);
        });
      }
    });
    try {
      const started = await service.start(startInput({
        existingEnvironmentId: undefined,
        namingPrompt: "Use the customer's exact naming context",
      }));
      expect(started.environmentId).toBe("created-env");
      expect(started.sourceLinkedAt).toBeString();
      expect(started.phase).toBe("starting-environment");
      expect(createCalls).toBe(1);
      expect(observedNamingPrompt).toBe("Use the customer's exact naming context");
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("shutdown waits for an in-flight supervisor pass before disposing providers", async () => {
    await withService(async (service, _storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);

      let resolveStatus!: (status: ProviderStatus) => void;
      const statusResult = new Promise<ProviderStatus>((resolve) => {
        resolveStatus = resolve;
      });
      let statusStarted = false;
      provider.status = () => {
        statusStarted = true;
        return statusResult;
      };
      let shutdownFinished = false;
      const advance = service.advanceNow(started.id);
      while (!statusStarted) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const shutdown = service.shutdown().then(() => {
        shutdownFinished = true;
      });
      await Promise.resolve();
      expect(shutdownFinished).toBe(false);
      resolveStatus("running");
      await advance;
      await shutdown;
      expect(shutdownFinished).toBe(true);
    });
  });

  test("coalesces overlapping timer ticks into one in-flight wrapper and one rerun", async () => {
    await withService(async (service, storage) => {
      const originalList = storage.listAllBuildPipelines.bind(storage);
      let releaseFirst!: () => void;
      const firstList = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let listCalls = 0;
      storage.listAllBuildPipelines = async () => {
        listCalls += 1;
        if (listCalls === 1) await firstList;
        return originalList();
      };
      const scheduler = service as unknown as {
        requestTick: () => Promise<void>;
      };
      const first = scheduler.requestTick();
      const second = scheduler.requestTick();
      const third = scheduler.requestTick();
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(listCalls).toBe(1);
      releaseFirst();
      await first;
      expect(listCalls).toBe(2);
    });
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
          error: expect.stringContaining(
            status === "missing" ? "no longer available" : "failed",
          ),
        });
      });
    });
  }

  test("forwards unattended interaction metadata and keeps pending blocked work parked", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      expect(provider.created).toContainEqual({
        phase: "build",
        label: "Build Session",
        options: expect.objectContaining({
          interaction: expect.objectContaining({
            origin: "build-pipeline",
            interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
            phase: "build",
            workflowId: started.id,
            provider: "claude",
            fence: expect.any(String),
          }),
        }),
      });
      expect(provider.registered).toContainEqual(expect.objectContaining({
        sessionId: "build-1",
        interaction: expect.objectContaining({
          origin: "build-pipeline",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "build",
          workflowId: started.id,
          provider: "claude",
          fence: expect.any(String),
        }),
      }));
      provider.status = async () => "blocked";
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const blocked = await pipeline(storage, started.id);
      expect(blocked.phase).toBe("building");
      expect(blocked.sessions[blocked.currentSessionIndex]).toMatchObject({
        status: "running",
        origin: "build-pipeline",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });

      const restoredService = new BuildPipelineService(
        storage,
        async <T>(): Promise<T> => {
          throw new Error("A parked session must not invoke backend commands");
        },
        { autoAdvance: false, provider: async () => provider },
      );
      try {
        await restoredService.advanceNow(started.id);
        expect((await pipeline(storage, started.id)).phase).toBe("building");
      } finally {
        await restoredService.shutdown();
      }
    });
  });

  test("warns on transcript silence without aborting and clears the warning on growth", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const record = await storage.getBuildPipeline(started.id);
      if (!record) throw new Error("Pipeline disappeared");
      const snapshot = record.snapshot as BuildPipeline;
      const session = snapshot.sessions[snapshot.currentSessionIndex]!;
      const messages = await provider.messages(session.sdkSessionId);
      session.messages = messages;
      session.messagesFingerprint = `${messages.length}:${JSON.stringify(messages.at(-1))}`;
      const stalledAt = new Date(Date.now() - 11 * 60_000).toISOString();
      session.startedAt = stalledAt;
      session.messagesPersistedAt = stalledAt;
      session.turnStartedAt = stalledAt;
      await storage.saveBuildPipeline(
        snapshot.id,
        snapshot.projectId,
        snapshot.environmentId,
        record.version,
        snapshot,
        record.revision,
      );
      provider.status = async () => "running";

      await service.advanceNow(started.id);
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "building",
        stallWarning: { sessionId: session.sdkSessionId },
      });

      provider.messages = async () => [{
        id: "new-progress",
        role: "assistant",
        parts: [{ type: "text", content: "Progress resumed" }],
      }];
      await service.advanceNow(started.id);
      const resumed = await pipeline(storage, started.id);
      expect(resumed.phase).toBe("building");
      expect(resumed.stallWarning).toBeUndefined();
    });
  });

  test("starts a fresh stall clock whenever a new turn is dispatched", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const record = await storage.getBuildPipeline(started.id);
      if (!record) throw new Error("Pipeline disappeared");
      const snapshot = record.snapshot as BuildPipeline;
      const session = snapshot.sessions[snapshot.currentSessionIndex]!;
      const messages = await provider.messages(session.sdkSessionId);
      const stalledAt = new Date(Date.now() - 11 * 60_000).toISOString();
      session.messages = messages;
      session.messagesFingerprint = `${messages.length}:${JSON.stringify(messages.at(-1))}`;
      session.messagesPersistedAt = stalledAt;
      session.turnStartedAt = stalledAt;
      await storage.saveBuildPipeline(
        snapshot.id,
        snapshot.projectId,
        snapshot.environmentId,
        record.version,
        snapshot,
        record.revision,
      );

      await service.sendMessage(started.id, "Continue with the safe assumption");
      await service.advanceNow(started.id);
      const dispatched = await pipeline(storage, started.id);
      const dispatchedSession = dispatched.sessions[dispatched.currentSessionIndex]!;
      expect(Date.parse(dispatchedSession.turnStartedAt!)).toBeGreaterThan(
        Date.now() - 5_000,
      );

      provider.status = async () => "running";
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).stallWarning).toBeUndefined();
    });
  });

  test("production OpenCode uses journaled decline/deny enforcement without a grant-once stream", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput({ agentType: "opencode" }));
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const restored = await pipeline(storage, started.id);
      const session = restored.sessions[restored.currentSessionIndex]!;

      const rejected: string[] = [];
      const permissionReplies: Array<{ requestID: string; reply: string }> = [];
      const phaseAtRejection: string[] = [];
      let pendingQuestions: Array<Record<string, unknown>> = [{
        id: "question-1",
        sessionID: session.sdkSessionId,
        questions: [{
          question: "Choose a safe implementation",
          options: [{ label: "Conservative", description: "Smallest change" }],
        }],
      }];
      let pendingPermissions: Array<Record<string, unknown>> = [];
      let subscriptions = 0;
      const client = {
        event: {
          async subscribe() {
            subscriptions += 1;
            throw new Error("The common backend resolver must not subscribe");
          },
        },
        permission: {
          async list() {
            return { data: pendingPermissions };
          },
          async reply(parameters: { requestID: string; reply: string }) {
            permissionReplies.push(parameters);
            pendingPermissions = pendingPermissions.filter(
              ({ id }) => id !== parameters.requestID,
            );
            return { data: true };
          },
        },
        question: {
          async list() {
            return { data: pendingQuestions };
          },
          async reject(parameters: { requestID: string }) {
            const currentPhase = (await pipeline(storage, started.id)).phase;
            pendingQuestions = pendingQuestions.filter(
              ({ id }) => id !== parameters.requestID,
            );
            phaseAtRejection.push(currentPhase);
            rejected.push(parameters.requestID);
            return { data: true };
          },
        },
        session: {
          async status() {
            return { data: { [session.sdkSessionId]: { type: "busy" } } };
          },
        },
      } as unknown as OpencodeClient;
      const production = new BuildPipelineService(
        storage,
        async <T>(command: string): Promise<T> => {
          if (command === "start_local_opencode_server_cmd") {
            return { port: 43210, authToken: "test-token" } as T;
          }
          throw new Error(`Unexpected command: ${command}`);
        },
        {
          autoAdvance: false,
          providerDependencies: { openCodeClient: client, monitorRetryMs: 1 },
        },
      );
      try {
        await production.advanceNow(started.id);
        expect(subscriptions).toBe(0);
        expect(rejected).toEqual(["question-1"]);
        expect(phaseAtRejection).toEqual(["building"]);
        expect(await pipeline(storage, started.id)).toMatchObject({
          phase: "building",
          autoDeclineCount: 1,
          sessions: [expect.objectContaining({
            autoDeclineCount: 1,
            interactionTranscript: [expect.objectContaining({
              id: `opencode:question:${encodeURIComponent(session.sdkSessionId)}:question-1`,
              outcome: "auto-declined-headless",
            })],
          })],
        });
        const firstJournal = await storage.getAgentInteractionResolutionJournal();
        expect(firstJournal.entries).toContainEqual(expect.objectContaining({
          state: "workflow-recorded",
          outcome: "auto-declined",
        }));

        pendingPermissions = [{
          id: "permission-1",
          sessionID: session.sdkSessionId,
          permission: "edit",
          patterns: ["**"],
          title: "Edit files",
          metadata: {},
          time: { created: Date.now() },
        }];
        await production.advanceNow(started.id);
        expect(permissionReplies).toEqual([expect.objectContaining({
          requestID: "permission-1",
          reply: "reject",
        })]);
        expect(await pipeline(storage, started.id)).toMatchObject({
          phase: "failed",
          failureContext: {
            kind: "interactive-request",
            sessionId: session.sdkSessionId,
          },
        });
      } finally {
        await production.shutdown();
      }
    });
  });

  test("declines three Claude questions exactly once and never consumes a queued message as an answer", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const running = await pipeline(storage, started.id);
      const session = running.sessions[running.currentSessionIndex]!;
      const now = Date.now();
      let requests: AgentInteractionRequest[] = Array.from(
        { length: 3 },
        (_, index) => ({
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          id: `question-${index + 1}`,
          provider: "claude" as const,
          kind: "question" as const,
          origin: "build-pipeline" as const,
          sessionId: session.sdkSessionId,
          state: "pending" as const,
          revision: 1,
          presentation: {
            title: `Question ${index + 1}`,
            questions: [{
              id: "choice",
              prompt: "Choose safely",
              required: true,
              multiple: false,
              secret: false,
              allowFreeText: false,
              options: [{
                id: "safe",
                label: "Safe",
                providerValue: "safe",
              }],
            }],
          },
          createdAt: now + index,
          updatedAt: now + index,
        }),
      );
      const resolutions: Array<{ id: string; action: string }> = [];
      (provider as unknown as BuildPipelineProvider & {
        interactions: NonNullable<BuildPipelineProvider["interactions"]>;
      }).interactions = {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId, resolution) {
          resolutions.push({ id: interactionId, action: resolution.action });
          requests = requests.filter((request) => request.id !== interactionId);
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      };

      await service.sendMessage(started.id, "This is a normal follow-up");
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);

      const resolved = await pipeline(storage, started.id);
      expect(resolutions).toEqual([
        { id: "question-1", action: "decline" },
        { id: "question-2", action: "decline" },
        { id: "question-3", action: "decline" },
      ]);
      expect(resolved).toMatchObject({
        phase: "building",
        autoDeclineCount: 3,
        pendingUserMessages: [{ text: "This is a normal follow-up" }],
      });
      expect(resolved.sessions[resolved.currentSessionIndex]).toMatchObject({
        autoDeclineCount: 3,
        interactionTranscript: [
          expect.objectContaining({ id: "question-1" }),
          expect.objectContaining({ id: "question-2" }),
          expect.objectContaining({ id: "question-3" }),
        ],
      });
      const journal = await storage.getAgentInteractionResolutionJournal();
      expect(journal.entries.filter((entry) => entry.claim.workflowId === started.id))
        .toHaveLength(3);
      expect(journal.entries.every((entry) => entry.state === "workflow-recorded"))
        .toBe(true);

      requests = [{
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        id: "permission-1",
        provider: "claude",
        kind: "permission",
        origin: "build-pipeline",
        sessionId: session.sdkSessionId,
        state: "pending",
        revision: 2,
        presentation: {
          title: "Authorize an unexpected privilege",
          questions: [],
        },
        createdAt: now + 10,
        updatedAt: now + 10,
      }];
      await service.advanceNow(started.id);
      expect(resolutions.at(-1)).toEqual({ id: "permission-1", action: "deny" });
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        failureContext: {
          kind: "interactive-request",
          requestId: "permission-1",
        },
      });

      const retried = await service.retryInteractionFailure(started.id);
      expect(retried.phase).toBe("building");
      expect(retried.sessions).toHaveLength(2);
      expect(retried.sessions[1]).toMatchObject({
        phase: "build",
        status: "running",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
    });
  });

  test("retries an addressing interaction with the findings prompt in build mode", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const record = await storage.getBuildPipeline(started.id);
      if (!record) throw new Error("Pipeline disappeared");
      const failed = record.snapshot as BuildPipeline;
      const report: StructuredReviewReport = {
        ...cleanReview,
        issues: [{
          severity: "P1",
          confidence: 90,
          category: "correctness",
          title: "Address this exact finding",
          file: "src/app.ts",
          line: 12,
          symbol: "run",
          description: "The result is wrong.",
          evidence: "The boundary test fails.",
          suggestion: "Correct the boundary.",
          verification: "Run the boundary test.",
        }],
        verdict: { ready: "with-fixes", reasoning: "One fix is required." },
      };
      failed.phase = "failed";
      failed.structuredReview = report;
      failed.failureContext = {
        phase: "addressing",
        kind: "interactive-request",
        sessionId: failed.sessions[failed.currentSessionIndex]!.sdkSessionId,
        requestId: "permission-1",
      };
      await storage.saveBuildPipeline(
        failed.id,
        failed.projectId,
        failed.environmentId,
        record.version,
        failed,
        record.revision,
      );

      const retried = await service.retryInteractionFailure(started.id);
      const dispatch = provider.sent.at(-1)!;
      expect(retried.phase).toBe("addressing");
      expect(retried.structuredReview).toEqual(report);
      expect(retried.sessions.at(-1)).toMatchObject({ phase: "review" });
      expect(provider.created.at(-1)?.options?.mode).toBe("build");
      expect(dispatch.mode).toBe("build");
      expect(dispatch.schema).toBeUndefined();
      expect(dispatch.prompt).toContain("Address this exact finding");
      expect(dispatch.prompt).toContain("non-interactive build session");
    });
  });

  test("reconciles stale provider outcomes and fails safely while the request is still live", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const running = await pipeline(storage, started.id);
      const session = running.sessions[running.currentSessionIndex]!;
      const request = pendingQuestion(session.sdkSessionId, "stale-question");
      let listCalls = 0;
      let resolveCalls = 0;
      (provider as unknown as BuildPipelineProvider & {
        interactions: NonNullable<BuildPipelineProvider["interactions"]>;
      }).interactions = {
        async listPendingInteractions() {
          listCalls += 1;
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: listCalls,
            requests: [request],
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          resolveCalls += 1;
          return { result: "stale", sessionId, interactionId, revision: listCalls };
        },
      };

      await service.advanceNow(started.id);
      expect(resolveCalls).toBe(1);
      expect(listCalls).toBeGreaterThanOrEqual(3);
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        failureContext: {
          kind: "interactive-request",
          requestId: "stale-question",
        },
      });
      const journal = await storage.getAgentInteractionResolutionJournal();
      expect(journal.entries.find((entry) =>
        entry.interactionId === "stale-question"
      )).toMatchObject({ state: "workflow-recorded", outcome: "failed" });
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
        (provider as unknown as BuildPipelineProvider & {
          interactions: NonNullable<BuildPipelineProvider["interactions"]>;
        }).interactions = {
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
        expect(journal.entries.find((entry) => entry.interactionId === request.id))
          .toMatchObject({ state: "workflow-recorded", outcome: "failed" });
      });
    });
  }

  test("rechecks an absent recovered request after leasing and resolves it if it reappears", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const running = await pipeline(storage, started.id);
      const session = running.sessions[running.currentSessionIndex]!;
      const request = pendingQuestion(session.sdkSessionId, "reappeared-question");
      await storage.updateAgentInteractionResolutionJournal(() => ({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{
          id: "reappeared-journal",
          interactionId: request.id,
          provider: "claude",
          kind: "question",
          sessionId: session.sdkSessionId,
          state: "claimed",
          claim: {
            workflowType: "build-pipeline",
            workflowId: running.id,
            phase: "building",
            fence: session.sessionKey,
            claimedAt: Date.now(),
          },
        }],
      }));
      let listCalls = 0;
      let resolveCalls = 0;
      (provider as unknown as BuildPipelineProvider & {
        interactions: NonNullable<BuildPipelineProvider["interactions"]>;
      }).interactions = {
        async listPendingInteractions() {
          listCalls += 1;
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: listCalls,
            requests: listCalls === 1 ? [] : [request],
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          resolveCalls += 1;
          return { result: "applied", sessionId, interactionId, revision: listCalls };
        },
      };

      await service.advanceNow(started.id);
      expect(listCalls).toBeGreaterThanOrEqual(2);
      expect(resolveCalls).toBe(1);
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "building",
        autoDeclineCount: 1,
      });
    });
  });

  test("two backends race a new live interaction claim and converge on one response", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const running = await pipeline(storage, started.id);
      const session = running.sessions[running.currentSessionIndex]!;
      const request = pendingQuestion(session.sdkSessionId, "new-contended-question");
      let requests = [request];
      let initialListCalls = 0;
      let releaseInitialLists!: () => void;
      const bothListed = new Promise<void>((resolve) => {
        releaseInitialLists = resolve;
      });
      let resolveCalls = 0;
      (provider as unknown as BuildPipelineProvider & {
        interactions: NonNullable<BuildPipelineProvider["interactions"]>;
      }).interactions = {
        async listPendingInteractions() {
          initialListCalls += 1;
          if (initialListCalls <= 2) {
            if (initialListCalls === 2) releaseInitialLists();
            await bothListed;
          }
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: initialListCalls,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          resolveCalls += 1;
          requests = [];
          return { result: "applied", sessionId, interactionId, revision: 3 };
        },
      };
      const second = new BuildPipelineService(
        storage,
        async <T>(): Promise<T> => {
          throw new Error("No backend command is expected");
        },
        { autoAdvance: false, provider: async () => provider },
      );
      try {
        expect(running.pendingInteractionResolution).toBeUndefined();
        expect((await storage.getAgentInteractionResolutionJournal()).entries)
          .toHaveLength(0);

        await Promise.all([
          service.advanceNow(started.id),
          second.advanceNow(started.id),
        ]);

        const resolved = await pipeline(storage, started.id);
        expect(resolveCalls).toBe(1);
        expect(resolved.phase).toBe("building");
        expect(resolved.error).toBeUndefined();
        expect(resolved.autoDeclineCount).toBe(1);
        expect(resolved.sessions[resolved.currentSessionIndex]?.interactionTranscript)
          .toEqual([expect.objectContaining({ id: request.id })]);
        const journal = await storage.getAgentInteractionResolutionJournal();
        expect(journal.entries).toContainEqual(expect.objectContaining({
          interactionId: request.id,
          state: "workflow-recorded",
          outcome: "auto-declined",
        }));
      } finally {
        await second.shutdown();
      }
    });
  });

  test("a losing pending-envelope CAS re-reads after the winner records the outcome", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const running = await pipeline(storage, started.id);
      const session = running.sessions[running.currentSessionIndex]!;
      const request = pendingQuestion(session.sdkSessionId, "late-cas-reread-question");
      let requests = [request];
      let initialListCalls = 0;
      let releaseInitialLists!: () => void;
      const bothListed = new Promise<void>((resolve) => {
        releaseInitialLists = resolve;
      });
      let resolveCalls = 0;
      (provider as unknown as BuildPipelineProvider & {
        interactions: NonNullable<BuildPipelineProvider["interactions"]>;
      }).interactions = {
        async listPendingInteractions() {
          initialListCalls += 1;
          if (initialListCalls <= 2) {
            if (initialListCalls === 2) releaseInitialLists();
            await bothListed;
          }
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: initialListCalls,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          resolveCalls += 1;
          requests = [];
          return { result: "applied", sessionId, interactionId, revision: 3 };
        },
      };
      const second = new BuildPipelineService(
        storage,
        async <T>(): Promise<T> => {
          throw new Error("No backend command is expected");
        },
        { autoAdvance: false, provider: async () => provider },
      );
      const originalSave = storage.saveBuildPipeline.bind(storage);
      let pendingSaveAttempts = 0;
      let releasePendingSaves!: () => void;
      const bothPendingSaves = new Promise<void>((resolve) => {
        releasePendingSaves = resolve;
      });
      let releaseWinnerOutcome!: () => void;
      const winnerOutcomeSaved = new Promise<void>((resolve) => {
        releaseWinnerOutcome = resolve;
      });
      let winnerOutcomeWasSaved = false;
      storage.saveBuildPipeline = async (...args) => {
        const candidate = args[4] as BuildPipeline;
        const isPendingEnvelopeSave =
          candidate.pendingInteractionResolution?.interactionId === request.id;
        const isOutcomeSave =
          candidate.pendingInteractionResolution === undefined
          && candidate.sessions.some((candidateSession) =>
            candidateSession.interactionTranscript?.some((entry) =>
              entry.id === request.id
            )
          );
        if (isPendingEnvelopeSave) {
          pendingSaveAttempts += 1;
          if (pendingSaveAttempts === 2) releasePendingSaves();
          await bothPendingSaves;
        }
        try {
          const saved = await originalSave(...args);
          if (isOutcomeSave && !winnerOutcomeWasSaved) {
            winnerOutcomeWasSaved = true;
            releaseWinnerOutcome();
          }
          return saved;
        } catch (error) {
          if (
            isPendingEnvelopeSave
            && error instanceof Error
            && error.message === "Build pipeline revision conflict"
          ) {
            // Surface the losing CAS only after the winner has removed the
            // envelope and durably recorded the terminal interaction outcome.
            await winnerOutcomeSaved;
          }
          throw error;
        }
      };
      try {
        await Promise.all([
          service.advanceNow(started.id),
          second.advanceNow(started.id),
        ]);

        const resolved = await pipeline(storage, started.id);
        expect(pendingSaveAttempts).toBe(2);
        expect(winnerOutcomeWasSaved).toBe(true);
        expect(resolveCalls).toBe(1);
        expect(resolved.phase).toBe("building");
        expect(resolved.error).toBeUndefined();
        expect(resolved.pendingInteractionResolution).toBeUndefined();
        expect(resolved.autoDeclineCount).toBe(1);
        expect(resolved.sessions[resolved.currentSessionIndex]?.interactionTranscript)
          .toEqual([expect.objectContaining({ id: request.id })]);
      } finally {
        storage.saveBuildPipeline = originalSave;
        await second.shutdown();
      }
    });
  });

  test("interaction outcome save merges a concurrent queued user message", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const running = await pipeline(storage, started.id);
      const session = running.sessions[running.currentSessionIndex]!;
      const request = pendingQuestion(session.sdkSessionId, "outcome-merge-question");
      let requests = [request];
      let resolveCalls = 0;
      (provider as unknown as BuildPipelineProvider & {
        interactions: NonNullable<BuildPipelineProvider["interactions"]>;
      }).interactions = {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: resolveCalls,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          resolveCalls += 1;
          requests = [];
          return { result: "applied", sessionId, interactionId, revision: 1 };
        },
      };
      const originalUpdateJournal = storage
        .updateAgentInteractionResolutionJournal.bind(storage);
      let releaseProviderResolved!: () => void;
      const providerResolved = new Promise<void>((resolve) => {
        releaseProviderResolved = resolve;
      });
      let allowOutcomeSave!: () => void;
      const outcomeSaveAllowed = new Promise<void>((resolve) => {
        allowOutcomeSave = resolve;
      });
      let blockedProviderResolved = false;
      const concurrentStorage = new StorageService(controls.dataDir);
      await concurrentStorage.init();
      storage.updateAgentInteractionResolutionJournal = async (...args) => {
        const journal = await originalUpdateJournal(...args);
        if (
          !blockedProviderResolved
          && journal.entries.some((entry) =>
            entry.interactionId === request.id && entry.state === "provider-resolved"
          )
        ) {
          blockedProviderResolved = true;
          releaseProviderResolved();
          // The provider result and journal transition are durable here, while
          // the service still holds its pre-mutation pipeline revision.
          await outcomeSaveAllowed;
        }
        return journal;
      };
      try {
        const advancing = service.advanceNow(started.id);
        await providerResolved;

        const concurrentRecord = await concurrentStorage.getBuildPipeline(started.id);
        if (!concurrentRecord) throw new Error("Pipeline disappeared");
        const concurrent = concurrentRecord.snapshot as BuildPipeline;
        const concurrentMessage = {
          id: "concurrent-follow-up",
          text: "Preserve this concurrent follow-up",
          createdAt: new Date().toISOString(),
        };
        concurrent.pendingUserMessages = [
          ...(concurrent.pendingUserMessages ?? []),
          concurrentMessage,
        ];
        await concurrentStorage.saveBuildPipeline(
          concurrent.id,
          concurrent.projectId,
          concurrent.environmentId,
          concurrentRecord.version,
          concurrent,
          concurrentRecord.revision,
        );
        allowOutcomeSave();
        await advancing;

        const resolved = await pipeline(storage, started.id);
        expect(blockedProviderResolved).toBe(true);
        expect(resolveCalls).toBe(1);
        expect(resolved.phase).toBe("building");
        expect(resolved.error).toBeUndefined();
        expect(resolved.pendingInteractionResolution).toBeUndefined();
        expect(resolved.pendingUserMessages).toEqual([concurrentMessage]);
        expect(resolved.autoDeclineCount).toBe(1);
        expect(resolved.sessions[resolved.currentSessionIndex]?.interactionTranscript)
          .toEqual([expect.objectContaining({ id: request.id })]);
      } finally {
        allowOutcomeSave();
        storage.updateAgentInteractionResolutionJournal = originalUpdateJournal;
      }
    });
  });

  for (const concurrentAction of ["pause", "cancel"] as const) {
    test(`terminal authorization outcome merges over a concurrent ${concurrentAction}`, async () => {
      await withService(async (service, storage, provider, _invocations, controls) => {
        const started = await service.start(startInput());
        await service.advanceNow(started.id);
        await service.advanceNow(started.id);
        const running = await pipeline(storage, started.id);
        const session = running.sessions[running.currentSessionIndex]!;
        const request: AgentInteractionRequest = {
          ...pendingQuestion(
            session.sdkSessionId,
            `authorization-${concurrentAction}`,
          ),
          kind: "permission",
          presentation: {
            title: "Authorize an unexpected privilege",
            questions: [],
          },
        };
        let requests = [request];
        let resolveCalls = 0;
        let resolutionAction = "";
        (provider as unknown as BuildPipelineProvider & {
          interactions: NonNullable<BuildPipelineProvider["interactions"]>;
        }).interactions = {
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
        const originalUpdateJournal = storage
          .updateAgentInteractionResolutionJournal.bind(storage);
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
            !blockedProviderResolved
            && journal.entries.some((entry) =>
              entry.interactionId === request.id
              && entry.state === "provider-resolved"
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
          expect(journal.entries).toContainEqual(expect.objectContaining({
            interactionId: request.id,
            state: "workflow-recorded",
            outcome: "denied",
          }));
        } finally {
          allowOutcomeSave();
          storage.updateAgentInteractionResolutionJournal = originalUpdateJournal;
          await concurrentService.shutdown();
        }
      });
    });
  }

  test("fails a live pending interaction whose journal claim cleanup reclaimed", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const record = await storage.getBuildPipeline(started.id);
      if (!record) throw new Error("Pipeline disappeared");
      const running = record.snapshot as BuildPipeline;
      const session = running.sessions[running.currentSessionIndex]!;
      const request = pendingQuestion(session.sdkSessionId, "reclaimed-live-question");
      const claimedAt = Date.now() - AGENT_INTERACTION_CLAIM_RETENTION_MS - 1;
      running.pendingInteractionResolution = {
        journalId: "reclaimed-live-journal",
        sessionKey: session.sessionKey,
        sessionId: session.sdkSessionId,
        interactionId: request.id,
        provider: "claude",
        kind: "question",
        phase: "build",
        requestedAt: claimedAt,
        claimedAt,
        action: "decline-and-continue",
        title: request.presentation.title,
        questions: [],
      };
      await storage.saveBuildPipeline(
        running.id,
        running.projectId,
        running.environmentId,
        record.version,
        running,
        record.revision,
      );
      await storage.updateAgentInteractionResolutionJournal(() => ({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{
          id: "reclaimed-live-journal",
          interactionId: request.id,
          provider: "claude",
          kind: "question",
          sessionId: session.sdkSessionId,
          state: "claimed",
          claim: {
            workflowType: "build-pipeline",
            workflowId: running.id,
            phase: "building",
            fence: session.sessionKey,
            claimedAt,
          },
        }],
      }));
      const reclaimed = await storage.getAgentInteractionResolutionJournal();
      expect(reclaimed.entries).toContainEqual(expect.objectContaining({
        id: "reclaimed-live-journal",
        state: "workflow-recorded",
        outcome: "stale",
      }));
      let resolveCalls = 0;
      (provider as unknown as BuildPipelineProvider & {
        interactions: NonNullable<BuildPipelineProvider["interactions"]>;
      }).interactions = {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests: [request],
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          resolveCalls += 1;
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      };

      await service.advanceNow(started.id);

      expect(resolveCalls).toBe(0);
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        error: expect.stringContaining("could not be resolved safely"),
        failureContext: {
          phase: "building",
          kind: "interactive-request",
          sessionId: session.sdkSessionId,
          requestId: request.id,
        },
      });
    });
  });

  test("leases a durable interaction response to only one backend process", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const record = await storage.getBuildPipeline(started.id);
      if (!record) throw new Error("Pipeline disappeared");
      const running = record.snapshot as BuildPipeline;
      const session = running.sessions[running.currentSessionIndex]!;
      const request = pendingQuestion(session.sdkSessionId, "contended-question");
      const claimedAt = Date.now();
      running.pendingInteractionResolution = {
        journalId: "contended-journal",
        sessionKey: session.sessionKey,
        sessionId: session.sdkSessionId,
        interactionId: request.id,
        provider: "claude",
        kind: "question",
        phase: "build",
        requestedAt: request.createdAt,
        claimedAt,
        action: "decline-and-continue",
        title: request.presentation.title,
        questions: [],
      };
      await storage.updateAgentInteractionResolutionJournal(() => ({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{
          id: "contended-journal",
          interactionId: request.id,
          provider: "claude",
          kind: "question",
          sessionId: session.sdkSessionId,
          state: "claimed",
          claim: {
            workflowType: "build-pipeline",
            workflowId: running.id,
            phase: "building",
            fence: session.sessionKey,
            claimedAt,
          },
        }],
      }));
      await storage.saveBuildPipeline(
        running.id,
        running.projectId,
        running.environmentId,
        record.version,
        running,
        record.revision,
      );

      let requests = [request];
      let resolveCalls = 0;
      (provider as unknown as BuildPipelineProvider & {
        interactions: NonNullable<BuildPipelineProvider["interactions"]>;
      }).interactions = {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: resolveCalls,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          resolveCalls += 1;
          requests = [];
          await Bun.sleep(2);
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      };
      const second = new BuildPipelineService(
        storage,
        async <T>(): Promise<T> => {
          throw new Error("No backend command is expected");
        },
        { autoAdvance: false, provider: async () => provider },
      );
      try {
        await Promise.all([
          service.advanceNow(started.id),
          second.advanceNow(started.id),
        ]);
        const resolved = await pipeline(storage, started.id);
        expect(resolveCalls).toBe(1);
        expect(resolved.phase).toBe("building");
        expect(resolved.autoDeclineCount).toBe(1);
        expect(resolved.sessions[resolved.currentSessionIndex]?.interactionTranscript)
          .toHaveLength(1);
      } finally {
        await second.shutdown();
      }
    });
  });

  test("recovers each interaction journal crash boundary without a duplicate provider response", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const running = await pipeline(storage, started.id);
      const session = running.sessions[running.currentSessionIndex]!;
      const claimedAt = Date.now();
      let requests: AgentInteractionRequest[] = [{
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        id: "claimed-question",
        provider: "claude",
        kind: "question",
        origin: "build-pipeline",
        sessionId: session.sdkSessionId,
        state: "pending",
        revision: 1,
        presentation: {
          title: "Question found after restart",
          questions: [],
        },
        createdAt: claimedAt,
        updatedAt: claimedAt,
      }];
      const responses: string[] = [];
      (provider as unknown as BuildPipelineProvider & {
        interactions: NonNullable<BuildPipelineProvider["interactions"]>;
      }).interactions = {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          responses.push(interactionId);
          requests = requests.filter((request) => request.id !== interactionId);
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      };

      await storage.updateAgentInteractionResolutionJournal(() => ({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{
          id: "journal-claimed",
          interactionId: "claimed-question",
          provider: "claude",
          kind: "question",
          sessionId: session.sdkSessionId,
          state: "claimed",
          claim: {
            workflowType: "build-pipeline",
            workflowId: started.id,
            phase: "building",
            fence: session.sessionKey,
            claimedAt,
          },
        }],
      }));
      await service.advanceNow(started.id);
      expect(responses).toEqual(["claimed-question"]);
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "building",
        autoDeclineCount: 1,
      });

      // Provider-resolved input recovery writes the workflow record without
      // sending anything upstream a second time.
      const inputResolvedAt = Date.now();
      await storage.updateAgentInteractionResolutionJournal((journal) => ({
        ...journal,
        entries: [...journal.entries, {
          id: "journal-provider-resolved-input",
          interactionId: "resolved-question",
          provider: "claude",
          kind: "question",
          sessionId: session.sdkSessionId,
          state: "provider-resolved",
          claim: {
            workflowType: "build-pipeline",
            workflowId: started.id,
            phase: "building",
            fence: session.sessionKey,
            claimedAt: inputResolvedAt - 1,
          },
          outcome: "auto-declined",
          providerResolvedAt: inputResolvedAt,
        }],
      }));
      await service.advanceNow(started.id);
      expect(responses).toEqual(["claimed-question"]);
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "building",
        autoDeclineCount: 2,
      });

      // The same boundary for authorization records a terminal failure, again
      // without redispatching an already accepted provider response.
      const authorizationResolvedAt = Date.now();
      await storage.updateAgentInteractionResolutionJournal((journal) => ({
        ...journal,
        entries: [...journal.entries, {
          id: "journal-provider-resolved-auth",
          interactionId: "resolved-permission",
          provider: "claude",
          kind: "permission",
          sessionId: session.sdkSessionId,
          state: "provider-resolved",
          claim: {
            workflowType: "build-pipeline",
            workflowId: started.id,
            phase: "building",
            fence: session.sessionKey,
            claimedAt: authorizationResolvedAt - 1,
          },
          outcome: "denied",
          providerResolvedAt: authorizationResolvedAt,
        }],
      }));
      await service.advanceNow(started.id);
      expect(responses).toEqual(["claimed-question"]);
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        failureContext: {
          kind: "interactive-request",
          requestId: "resolved-permission",
        },
      });

      // Simulate the last crash window: workflow state is durable, while the
      // journal update that follows it was lost. init() must finish only that
      // journal transition and must not contact the provider.
      await storage.updateAgentInteractionResolutionJournal((journal) => ({
        ...journal,
        entries: journal.entries.map((entry) =>
          entry.id === "journal-provider-resolved-auth"
            ? {
                ...entry,
                state: "provider-resolved" as const,
                workflowRecordedAt: undefined,
              }
            : entry),
      }));
      const restored = new BuildPipelineService(
        storage,
        async <T>(): Promise<T> => {
          throw new Error("Crash-boundary journal recovery must stay local");
        },
        { autoAdvance: false, provider: async () => provider },
      );
      try {
        await restored.init();
        const journal = await storage.getAgentInteractionResolutionJournal();
        expect(journal.entries.find((entry) =>
          entry.id === "journal-provider-resolved-auth"
        )).toMatchObject({
          state: "workflow-recorded",
          outcome: "denied",
        });
        expect(responses).toEqual(["claimed-question"]);
      } finally {
        await restored.shutdown();
      }
    });
  });

  test("re-registers restored sessions with cached and injected providers", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const restored = await pipeline(storage, started.id);
      const resolveProvider = service as unknown as {
        provider: (
          pipeline: BuildPipeline,
          agent: "claude",
        ) => Promise<BuildPipelineProvider>;
        providers: Map<string, BuildPipelineProvider>;
        options: {
          provider?: () => Promise<BuildPipelineProvider>;
        };
      };

      provider.registered.length = 0;
      expect(await resolveProvider.provider(restored, "claude")).toBe(provider);
      expect(provider.registered).toEqual([expect.objectContaining({
        sessionId: "build-1",
        interaction: expect.objectContaining({
          origin: "build-pipeline",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "build",
          workflowId: started.id,
          provider: "claude",
          fence: expect.any(String),
        }),
      })]);

      const injected = new FakeProvider();
      resolveProvider.providers.clear();
      resolveProvider.options.provider = async () => injected;
      expect(await resolveProvider.provider(restored, "claude")).toBe(injected);
      expect(injected.registered).toEqual([expect.objectContaining({
        sessionId: "build-1",
        interaction: expect.objectContaining({
          origin: "build-pipeline",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "build",
          workflowId: started.id,
          provider: "claude",
          fence: expect.any(String),
        }),
      })]);
    });
  });

  test("registers restored interaction metadata on a production bridge provider", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const restored = await pipeline(storage, started.id);
      const production = new BuildPipelineService(
        storage,
        async <T>(command: string): Promise<T> => {
          if (command === "start_local_claude_server_cmd") {
            return { port: 43210, authToken: "test-token" } as T;
          }
          throw new Error(`Unexpected command: ${command}`);
        },
        { autoAdvance: false },
      );
      try {
        const provider = await (production as unknown as {
          provider: (
            pipeline: BuildPipeline,
            agent: "claude",
          ) => Promise<BuildPipelineProvider>;
        }).provider(restored, "claude");
        const registration = (provider as unknown as {
          interactionTracker: {
            registration: (sessionId: string) => ProviderSessionRegistration;
          };
        }).interactionTracker.registration("build-1");
        expect(registration).toEqual(expect.objectContaining({
          origin: "build-pipeline",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "build",
          workflowId: started.id,
          provider: "claude",
          fence: expect.any(String),
        }));
      } finally {
        await production.shutdown();
      }
    });
  });

  test("rejects malformed structured review output instead of advancing", async () => {
    await withService(async (service, storage, provider) => {
      provider.structured = async <T>(
        _sessionId: string,
        requestId: string,
      ): Promise<StructuredOutputResult<T>> => ({
        ok: true,
        provider: "claude",
        requestId,
        value: { issues: "not-an-array" } as T,
      });
      const started = await service.start(startInput());
      for (let pass = 0; pass < 4; pass += 1) {
        await service.advanceNow(started.id);
      }
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        error: expect.any(String),
      });
    });
  });

  for (const [label, legacyMessage, expectedRequestId] of [
    [
      "nested provider metadata",
      { info: { role: "user", id: "legacy-info-request" } },
      "legacy-info-request",
    ],
    [
      "an explicit requestId",
      { requestId: "legacy-explicit-request" },
      "legacy-explicit-request",
    ],
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
          provider.phases.get(sessionId) === "verify"
            ? [legacyMessage]
            : [];
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

  test("fails a legacy verification snapshot with no recoverable request id", async () => {
    await withService(async (service, storage, provider) => {
      const verifying = await startVerifying(service, storage);
      const record = await storage.getBuildPipeline(verifying.id);
      if (!record) throw new Error("Pipeline disappeared");
      const snapshot = record.snapshot as BuildPipeline;
      delete snapshot.sessions[snapshot.currentSessionIndex]!.structuredRequestId;
      await storage.saveBuildPipeline(
        snapshot.id,
        snapshot.projectId,
        snapshot.environmentId,
        record.version,
        snapshot,
        record.revision,
      );
      provider.messages = async () => [
        null,
        "not-an-object",
        { info: { role: "assistant", id: "not-a-user" } },
      ];

      await service.advanceNow(verifying.id);

      expect(await pipeline(storage, verifying.id)).toMatchObject({
        phase: "failed",
        error: "Verification result key is missing",
      });
    });
  });

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

  test("init retries a terminal comment left in posting state after a crash", async () => {
    await withService(async (service, storage, _provider, invocations, controls) => {
      controls.failCommands.add("post_linear_completion_comment");
      const started = await service.start(startInput({
        source: {
          type: "linear",
          issueId: "issue-1",
          issueIdentifier: "ENG-1",
        },
      }));
      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }
      const record = await storage.getBuildPipeline(started.id);
      if (!record) throw new Error("Pipeline disappeared");
      const snapshot = record.snapshot as BuildPipeline;
      snapshot.completionCommentStatus = "posting";
      delete snapshot.completionCommentError;
      await storage.saveBuildPipeline(
        snapshot.id,
        snapshot.projectId,
        snapshot.environmentId,
        2,
        snapshot,
        record.revision,
      );
      controls.failCommands.delete("post_linear_completion_comment");
      await service.init();
      expect(await pipeline(storage, started.id)).toMatchObject({
        completionCommentStatus: "posted",
        completionCommentId: "comment-1",
      });
      expect(invocations.filter((entry) =>
        entry.command === "post_linear_completion_comment")).toHaveLength(2);
    });
  });
});
