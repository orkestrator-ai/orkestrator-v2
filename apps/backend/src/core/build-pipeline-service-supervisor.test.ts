import { describe, expect, mock, test } from "bun:test";

import { promises as fs } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import type {
  BuildPipeline,
  PipelineSession,
  PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";

import { VERIFICATION_VERDICT_SCHEMA } from "@orkestrator/protocol/build-pipeline";

import { type StructuredReviewReport } from "@orkestrator/protocol/structured-review";

import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";

import { StorageService } from "./storage.js";

import { BuildPipelineService } from "./build-pipeline-service.js";

import { ProviderSessionFailedError } from "./build-pipeline-provider.js";

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
  reviewReport: StructuredReviewReport = cleanReview;

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
        ? this.reviewReport
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

describe("BuildPipelineService", () => {
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
      expect(completed.sessions.every((session) => Array.isArray(session.messages))).toBe(true);
      expect(
        completed.sessions.map((session) => [session.phase, session.structuredResultStatus]),
      ).toEqual([
        ["build", undefined],
        ["review", "accepted"],
        ["verify", "accepted"],
        ["pr", undefined],
      ]);
      expect(provider.sent).toHaveLength(4);
      const verificationDispatch = provider.sent.find(
        (entry) => provider.phases.get(entry.sessionId) === "verify",
      );
      expect(verificationDispatch?.schema).toBe(VERIFICATION_VERDICT_SCHEMA);
      expect(completed.verificationResult).toBe("pass");
    });
  });

  test("strips provider-invented review provenance before persistence", async () => {
    await withService(async (service, storage, provider) => {
      provider.reviewReport = {
        ...cleanReview,
        issues: [
          {
            reviewModels: ["provider-invented-model"],
            reviewSourceIds: ["provider-invented-source"],
            severity: "P2",
            confidence: 80,
            category: "correctness",
            title: "Review finding",
            file: "src/app.ts",
            line: 1,
            symbol: "run",
            description: "A finding that enters the address stage.",
            evidence: "The provider returned it.",
            suggestion: "Address it.",
            verification: "Run the pipeline.",
          },
        ],
        verdict: { ready: "with-fixes", reasoning: "One fix remains." },
      };
      const started = await service.start(startInput());

      for (let pass = 0; pass < 8; pass += 1) await service.advanceNow(started.id);

      const completed = await pipeline(storage, started.id);
      expect(completed.structuredReview?.issues[0]).not.toHaveProperty("reviewModels");
      expect(completed.structuredReview?.issues[0]).not.toHaveProperty("reviewSourceIds");
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
      provider.messages = async (sessionId) => [
        {
          id: `${sessionId}-assistant`,
          role: "assistant",
          parts: [{ type: "text", content: "Implementing the backend runner" }],
        },
      ];
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

  test("uses container PR detection for containerized build environments", async () => {
    await withService(async (service, storage, _provider, invocations) => {
      await storage.updateEnvironment("env-1", {
        environmentType: "containerized",
        containerId: "container-1",
      });
      const started = await service.start(
        startInput({
          environmentType: "containerized",
        }),
      );
      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }

      expect((await pipeline(storage, started.id)).phase).toBe("complete");
      expect(invocations).toContainEqual({
        command: "detect_pr",
        args: { containerId: "container-1", branch: "build" },
      });
      expect(invocations.some(({ command }) => command === "detect_pr_local")).toBe(false);
    });
  });

  test("fails when a containerized build has no container for PR detection", async () => {
    await withService(async (service, storage) => {
      await storage.updateEnvironment("env-1", {
        environmentType: "containerized",
        containerId: null,
      });
      const started = await service.start(
        startInput({
          environmentType: "containerized",
        }),
      );
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
      const started = await service.start(
        startInput({
          taskId: "task-kanban",
          source: { type: "kanban", taskId: "task-kanban" },
        }),
      );
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
      const started = await service.start(
        startInput({
          source: {
            type: "github",
            repositoryOwner: "acme",
            repositoryName: "repo",
            issueNumber: 7,
            issueUrl: "https://github.com/acme/repo/issues/7",
            status: "open",
          },
        }),
      );
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
      expect(
        invocations.filter((entry) => entry.command === "post_github_completion_comment"),
      ).toHaveLength(3);
    });
  });

  test("remove disposes a cached provider only after its final pipeline is gone", async () => {
    await withService(async (service, storage, provider) => {
      const first = await service.start(startInput({ taskId: "remove-first" }));
      const second = await service.start(startInput({ taskId: "remove-second" }));
      await service.cancel(first.id);
      await service.cancel(second.id);

      const dispose = mock(async () => {});
      (provider as FakeProvider & { dispose: () => Promise<void> }).dispose = dispose;
      const providers = (
        service as unknown as {
          providers: Map<string, BuildPipelineProvider>;
        }
      ).providers;
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
    const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
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
      const started = await service.start(
        startInput({
          existingEnvironmentId: undefined,
          namingPrompt: "Use the customer's exact naming context",
        }),
      );
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

  /**
   * Provisions one environment and reports the arguments `create_environment`
   * was called with. The pipeline creates its own environment, so this is the
   * only place a launcher's environment shaping can be observed.
   */
  async function provisioningArgs(
    overrides: Partial<Parameters<BuildPipelineService["start"]>[0]>,
  ): Promise<Record<string, unknown>> {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-env-options-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    let observed: Record<string, unknown> = {};
    const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
      if (command !== "create_environment") {
        throw new Error(`Unexpected command: ${command}`);
      }
      observed = args;
      return (await storage.addEnvironment({
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
      })) as T;
    };
    const service = new BuildPipelineService(storage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    try {
      await service.start(startInput({ existingEnvironmentId: undefined, ...overrides }));
      return observed;
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }

  test("provisions the environment a launcher shaped", async () => {
    const args = await provisioningArgs({
      environmentType: "containerized",
      namingPrompt: "Dark mode toggle",
      environmentOptions: {
        name: "  feature-dark-mode  ",
        networkAccessMode: "full",
        portMappings: [{ containerPort: 5173, hostPort: 4300, protocol: "tcp" }],
      },
    });

    // A chosen name wins over the ticket-derived one, and is trimmed, because
    // `create_environment` skips the rename-from-prompt path when it has one.
    expect(args.name).toBe("feature-dark-mode");
    // The launcher's mode wins over the containerized default of `restricted`.
    expect(args.networkAccessMode).toBe("full");
    expect(args.portMappings).toEqual([{ containerPort: 5173, hostPort: 4300, protocol: "tcp" }]);
    expect(args.environmentType).toBe("containerized");
    expect(args.namingPrompt).toBe("Dark mode toggle");
  });

  test("keeps its own provisioning defaults when a launcher shaped nothing", async () => {
    const containerized = await provisioningArgs({ environmentType: "containerized" });
    expect(containerized.networkAccessMode).toBe("restricted");
    // Absent rather than empty: an explicit name suppresses naming from the
    // prompt, so sending a blank one would leave the environment called "".
    expect("name" in containerized).toBe(false);
    expect("portMappings" in containerized).toBe(false);

    // A local worktree has no firewall to apply a mode to.
    const local = await provisioningArgs({ environmentType: "local" });
    expect(local.networkAccessMode).toBe("full");
  });

  test("drops a blank name and an empty port list rather than forwarding them", async () => {
    const args = await provisioningArgs({
      environmentType: "containerized",
      environmentOptions: { name: "   ", networkAccessMode: "restricted", portMappings: [] },
    });

    expect("name" in args).toBe(false);
    expect("portMappings" in args).toBe(false);
    expect(args.networkAccessMode).toBe("restricted");
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

  // A bridge that answers a status read with a terminal turn error is reachable,
  // not broken, so the stage must fail with the provider's own explanation
  // instead of letting the throw escape as an anonymous provider read fault.
  test("fails durably with the detail when provider status throws a session failure", async () => {
    await withService(async (service, storage, provider) => {
      const { started } = await startBuilding(service, storage);
      provider.status = async () => {
        throw new ProviderSessionFailedError(
          provider.agent,
          "Selected model is at capacity. Please try a different model.",
        );
      };

      await service.advanceNow(started.id);

      const failed = await pipeline(storage, started.id);
      // Read before toMatchObject: it substitutes its asymmetric matcher into
      // the received object, so a later read of `failed.error` is not a string.
      const recordedError = failed.error;
      expect(failed).toMatchObject({
        phase: "failed",
        error: expect.stringContaining("failed"),
      });
      // The provider's own explanation must survive into the durable error, so
      // the message is the detailed form rather than the bare stage failure.
      expect(recordedError).toContain(
        "Selected model is at capacity. Please try a different model.",
      );
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

      provider.messages = async () => [
        {
          id: "new-progress",
          role: "assistant",
          parts: [{ type: "text", content: "Progress resumed" }],
        },
      ];
      await service.advanceNow(started.id);
      const resumed = await pipeline(storage, started.id);
      expect(resumed.phase).toBe("building");
      expect(resumed.stallWarning).toBeUndefined();
    });
  });
});
