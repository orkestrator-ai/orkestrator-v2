import { describe, expect, test } from "bun:test";

import { promises as fs } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import type {
  BuildPipeline,
  PipelineSession,
  PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";

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
  // The build stage is only asked to commit. Without the backend's own probe a
  // review would re-derive the worktree state inside its turn and could quietly
  // decide it was dirty and skip validation altogether.
  test("tells the review stage the backend saw a clean worktree", async () => {
    await withService(async (service, storage, provider, invocations, controls) => {
      controls.uncommittedPaths = [];
      const { started } = await startBuilding(service, storage);
      await service.advanceNow(started.id);

      expect((await pipeline(storage, started.id)).phase).toBe("reviewing");
      expect(invocations).toContainEqual({
        command: "get_environment_uncommitted_paths",
        args: { environmentId: "env-1" },
      });
      const review = provider.sent.at(-1)!;
      expect(review.prompt).toContain(
        "the backend confirmed the environment worktree was clean when this review started",
      );
      expect((await pipeline(storage, started.id)).sessions.at(-1)).toMatchObject({
        structuredResultStatus: "pending",
      });
    });
  });

  test("names the paths the build stage left uncommitted in the review prompt", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      controls.uncommittedPaths = ["src/forgotten.ts", "src/forgotten.test.ts"];
      const { started } = await startBuilding(service, storage);
      await service.advanceNow(started.id);

      const review = provider.sent.at(-1)!;
      expect(review.prompt).toContain("the preceding build stage did not commit everything");
      expect(review.prompt).toContain("- `src/forgotten.ts`");
      expect(review.prompt).toContain("- `src/forgotten.test.ts`");
    });
  });

  // The build stage is only asked to commit, so a review can legitimately open
  // on a dirty tree. Certification compares against that baseline rather than
  // against cleanliness, so the leftovers must not fail a review that passed.
  test("certifies a review that started on a dirty worktree it did not change", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      controls.uncommittedPaths = ["src/forgotten.ts", "src/forgotten.test.ts"];
      const { started } = await startBuilding(service, storage);
      await service.advanceNow(started.id);
      const reviewing = await pipeline(storage, started.id);
      expect(reviewing.phase).toBe("reviewing");
      expect(reviewing.sessions.at(-1)).toMatchObject({
        validationHeadAtStart: controls.currentHead,
        validationWorktreeStatusAtStart: "dirty",
        validationUncommittedPathsAtStart: ["src/forgotten.ts", "src/forgotten.test.ts"],
      });

      // Reported in a different order: the baseline is a set, not a sequence.
      controls.uncommittedPaths = ["src/forgotten.test.ts", "src/forgotten.ts"];
      await service.advanceNow(started.id);

      expect((await pipeline(storage, started.id)).phase).toBe("verifying");
    });
  });

  test("fails closed when validation adds a path to an already dirty worktree", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      controls.uncommittedPaths = ["src/forgotten.ts"];
      const { started } = await startBuilding(service, storage);
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).phase).toBe("reviewing");

      controls.uncommittedPaths = ["src/forgotten.ts", "src/generated.ts"];
      await service.advanceNow(started.id);

      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        error:
          "Review cannot be certified because validation left 1 uncommitted path that was not there when it started",
      });
    });
  });

  // Deleting an uncommitted leftover destroys work no commit is holding, so it
  // is a violation in the same way adding one is.
  test("fails closed when validation removes an uncommitted path it started with", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      controls.uncommittedPaths = ["src/forgotten.ts", "src/forgotten.test.ts"];
      const { started } = await startBuilding(service, storage);
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).phase).toBe("reviewing");

      controls.uncommittedPaths = ["src/forgotten.ts"];
      await service.advanceNow(started.id);

      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        error:
          "Review cannot be certified because validation removed 1 uncommitted path that was there when it started",
      });
    });
  });

  test("fails and retries the review before dispatch when its worktree probe fails", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      const { started } = await startBuilding(service, storage);
      const dispatched = provider.sent.length;
      controls.failCommands.add("get_environment_uncommitted_paths");

      await service.advanceNow(started.id);

      // A state the backend cannot establish can never be certified, so the
      // stage fails here rather than after burning an agent turn on it.
      const failed = await pipeline(storage, started.id);
      expect(failed).toMatchObject({
        phase: "failed",
        error:
          "Review cannot start because the backend could not establish the environment Git state: probe failed (Error)",
        failureContext: {
          phase: "reviewing",
          kind: "stage-transition",
        },
      });
      expect(failed.sessions).toEqual([
        expect.objectContaining({ phase: "build", status: "idle" }),
      ]);
      expect(provider.sent.length).toBe(dispatched);

      controls.failCommands.delete("get_environment_uncommitted_paths");
      const retried = await service.retryStage(started.id);
      expect(retried).toMatchObject({
        phase: "reviewing",
        currentSessionIndex: 1,
        sessions: [
          expect.objectContaining({ phase: "build", status: "idle" }),
          expect.objectContaining({ phase: "review", status: "running" }),
        ],
      });
    });
  });

  test("retries a transient worktree probe failure instead of failing the stage", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      const { started } = await startBuilding(service, storage);
      // One lost exec must not decide a stage the pipeline cannot recover.
      controls.failCommandsOnce.set("get_environment_uncommitted_paths", 1);

      await service.advanceNow(started.id);

      const reviewing = await pipeline(storage, started.id);
      expect(reviewing.phase).toBe("reviewing");
      expect(reviewing.sessions.at(-1)).toMatchObject({
        validationHeadAtStart: controls.currentHead,
        validationWorktreeStatusAtStart: "clean",
      });

      controls.failCommandsOnce.set("get_environment_uncommitted_paths", 2);
      await service.advanceNow(started.id);

      expect((await pipeline(storage, started.id)).phase).toBe("verifying");
    });
  });

  test("fails closed when review validation leaves an uncommitted input", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      const { started } = await startBuilding(service, storage);
      await service.advanceNow(started.id);
      const reviewing = await pipeline(storage, started.id);
      expect(reviewing.phase).toBe("reviewing");
      expect(reviewing.sessions.at(-1)).toMatchObject({
        validationHeadAtStart: controls.currentHead,
        validationWorktreeStatusAtStart: "clean",
        validationUncommittedPathsAtStart: [],
      });

      controls.uncommittedPaths = ["src/generated.ts"];
      await service.advanceNow(started.id);

      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        error:
          "Review cannot be certified because validation left 1 uncommitted path that was not there when it started",
      });
    });
  });

  // Addressing and verification each open fresh sessions. Anything the address
  // stage leaves uncommitted is the verification session's new baseline, not a
  // violation of it.
  test("rebaselines verification against what the addressing turn left behind", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      provider.structured = async <T>() =>
        ({
          ok: true,
          value: {
            ...cleanReview,
            issues: [
              {
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
              },
            ],
            verdict: { ready: "with-fixes", reasoning: "One fix is required." },
          },
        }) as StructuredOutputResult<T>;
      const { started } = await startBuilding(service, storage);
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).phase).toBe("addressing");

      // The addressing turn commits its fixes and leaves a scratch file.
      controls.currentHead = "3333333333333333333333333333333333333333";
      controls.uncommittedPaths = ["notes/scratch.md"];
      await service.advanceNow(started.id);

      const verifying = await pipeline(storage, started.id);
      expect(verifying.phase).toBe("verifying");
      expect(verifying.sessions.at(-1)).toMatchObject({
        phase: "verify",
        validationHeadAtStart: "3333333333333333333333333333333333333333",
        validationWorktreeStatusAtStart: "dirty",
        validationUncommittedPathsAtStart: ["notes/scratch.md"],
      });
    });
  });

  test("fails closed when verification validation commits a change", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      const verifying = await startVerifying(service, storage);
      const session = verifying.sessions[verifying.currentSessionIndex]!;
      expect(session).toMatchObject({
        phase: "verify",
        validationHeadAtStart: controls.currentHead,
        validationWorktreeStatusAtStart: "clean",
      });

      controls.currentHead = "2222222222222222222222222222222222222222";
      await service.advanceNow(verifying.id);

      expect(await pipeline(storage, verifying.id)).toMatchObject({
        phase: "failed",
        error: "Verification cannot be certified because validation changed the environment HEAD",
      });
    });
  });

  test("fails closed when Git state cannot be verified after validation", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      const { started } = await startBuilding(service, storage);
      await service.advanceNow(started.id);
      controls.failCommands.add("get_environment_uncommitted_paths");

      await service.advanceNow(started.id);

      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        error:
          "Review cannot be certified because the backend could not verify Git state after validation: probe failed (Error)",
      });
    });
  });

  test("allows ignored validation output when Git state remains clean", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      const verifying = await startVerifying(service, storage);

      // Ignored caches and build output never appear in the authoritative
      // porcelain response, so unchanged HEAD plus no paths is the safe case.
      controls.uncommittedPaths = [];
      await service.advanceNow(verifying.id);

      expect((await pipeline(storage, verifying.id)).phase).toBe("creating-pr");
    });
  });
});
