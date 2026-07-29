import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BuildPipeline,
  PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
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
  readonly sent: Array<{ sessionId: string; requestId: string }> = [];
  private counter = 0;

  async createSession(phase: PipelineSessionPhase): Promise<string> {
    const id = `${phase}-${++this.counter}`;
    this.phases.set(id, phase);
    return id;
  }

  async send(
    sessionId: string,
    _prompt: string,
    options: { requestId: string; schema?: JsonSchema },
  ): Promise<void> {
    this.sent.push({ sessionId, requestId: options.requestId });
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
      detection: {
        url: string;
        state: "open" | "merged" | "closed";
        hasMergeConflicts: boolean;
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
    detection: {
      url: "https://github.com/acme/repo/pull/1",
      state: "open" as const,
      hasMergeConflicts: false,
    } as {
      url: string;
      state: "open" | "merged" | "closed";
      hasMergeConflicts: boolean;
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
    if (command === "detect_pr_local") {
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

describe("BuildPipelineService", () => {
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

      controls.failCommands.delete("post_github_completion_comment");
      const retried = await service.retryCompletionComment(started.id);
      expect(retried).toMatchObject({
        completionCommentStatus: "posted",
        completionCommentId: "comment-1",
      });
      expect(invocations.filter((entry) =>
        entry.command === "post_github_completion_comment")).toHaveLength(2);
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
