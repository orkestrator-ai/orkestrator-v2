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
import { WorkflowResultService } from "./workflow-result-service.js";
import { REVIEW_PACKAGE_SESSION_LABEL } from "@orkestrator/protocol/build-pipeline";

import { BuildPipelineService } from "./build-pipeline-service.js";
import { UNCHANGED_FIX_PAUSE_MESSAGE } from "./build-pipeline-service-supervisor.js";
import {
  connectionDefaultsFor,
  fastModeForModel,
  legacyTranscriptFingerprint,
  normalizeTranscriptFingerprint,
  transcriptFingerprint,
} from "./build-pipeline-service-helpers.js";

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

describe("build pipeline connection defaults", () => {
  test("resolves repository speed independently and preserves explicit Normal", () => {
    expect(
      connectionDefaultsFor(
        "codex",
        {
          global: {
            agentSettings: {
              platforms: { codex: { model: "global-model", fastMode: true } },
            },
          },
        } as never,
        {
          agentSettings: {
            platforms: { codex: { reasoningEffort: "xhigh", fastMode: false } },
          },
        },
      ),
    ).toEqual({ model: "global-model", effort: "xhigh", fastMode: false });
  });

  test("lets an environment override the inherited speed used by background workflows", () => {
    expect(
      connectionDefaultsFor(
        "cursor",
        {
          global: {
            agentSettings: {
              platforms: { cursor: { model: "global-model", fastMode: false } },
            },
          },
        } as never,
        {
          agentSettings: {
            platforms: { cursor: { reasoningEffort: "high", fastMode: false } },
          },
        },
        {
          agentSettings: {
            platforms: { cursor: { fastMode: true } },
          },
        },
      ),
    ).toEqual({ model: "global-model", effort: "high", fastMode: true });
  });

  test("keeps explicit Normal and only clamps Fast for a known unsupported model", () => {
    const catalog = [
      {
        id: "fast-model",
        aliases: ["fast-alias"],
        name: "Fast model",
        label: "Fast model",
        platform: "codex" as const,
        supportsSpeed: true,
      },
      {
        id: "normal-only",
        name: "Normal only",
        label: "Normal only",
        platform: "codex" as const,
        supportsSpeed: false,
      },
    ];

    expect(fastModeForModel("codex", false, "normal-only", catalog)).toBe(false);
    expect(fastModeForModel("codex", true, "fast-alias", catalog)).toBe(true);
    expect(fastModeForModel("codex", true, "normal-only", catalog)).toBeUndefined();
    expect(fastModeForModel("codex", true, "catalogue-not-loaded", [])).toBe(true);
    expect(fastModeForModel("opencode", true, "any-model", catalog)).toBeUndefined();
  });
});

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

class RecoveryTestService extends BuildPipelineService {
  recoverMissingStage(snapshot: BuildPipeline): Promise<void> {
    return this.restartMissingStage(snapshot);
  }
}

async function withService(
  run: (
    service: RecoveryTestService,
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
      fingerprint?: string;
      probeError?: Error;
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
  options: { toolMode?: boolean } = {},
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
    // Content identity is opt-in, matching the real probe: absent unless a
    // test sets it, so the unchanged-fix check stays disabled by default.
    fingerprint: undefined as string | undefined,
    probeError: undefined as Error | undefined,
    workflowResults: options.toolMode ? new WorkflowResultService(dataDir) : undefined,
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
      if (args.fingerprint && controls.probeError) throw controls.probeError;
      return {
        head: controls.currentHead,
        paths: [...controls.uncommittedPaths],
        ...(args.fingerprint && controls.fingerprint ? { fingerprint: controls.fingerprint } : {}),
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
  const service = new RecoveryTestService(storage, invoke, {
    autoAdvance: false,
    provider: async () => provider,
    ...(controls.workflowResults
      ? {
          workflowResults: controls.workflowResults,
          resolveAgentToolConnection: () => ({
            url: "http://127.0.0.1:1234/mcp",
            token: "test-token",
          }),
        }
      : {}),
  });
  if (controls.workflowResults) {
    const send = provider.send.bind(provider);
    provider.send = async (sessionId, prompt, sendOptions) => {
      await send(sessionId, prompt, sendOptions);
      if (["build", "review", "verify", "fix"].includes(provider.phases.get(sessionId)!)) {
        const result = await provider.structured(sessionId, sendOptions.requestId);
        if (!result.ok) throw new Error("Test provider returned no submission");
        expect(
          await controls.workflowResults!.submit(
            { environmentId: "env-1", projectId: "project-1" },
            sendOptions.requestId,
            result.value,
          ),
        ).toMatchObject({ ok: true });
      }
    };
  }
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

/** Simulates another process changing the authoritative snapshot. */
async function mutateStored(
  storage: StorageService,
  id: string,
  mutation: (snapshot: BuildPipeline) => void,
): Promise<void> {
  const record = await storage.getBuildPipeline(id);
  if (!record) throw new Error("Pipeline disappeared");
  const snapshot = record.snapshot as BuildPipeline;
  mutation(snapshot);
  await storage.saveBuildPipeline(
    id,
    snapshot.projectId,
    snapshot.environmentId,
    record.version,
    snapshot,
    record.revision,
  );
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
  overrides: Partial<Parameters<BuildPipelineService["start"]>[0]> = {},
): Promise<BuildPipeline> {
  const started = await service.start(startInput(overrides));
  for (let pass = 0; pass < 4; pass += 1) {
    await service.advanceNow(started.id);
  }
  const verifying = await pipeline(storage, started.id);
  expect(verifying.phase).toBe("verifying");
  return verifying;
}

describe("BuildPipelineService", () => {
  test("builds one immutable package and gives the single reviewer no worktree baseline", async () => {
    await withService(async (service, storage, provider, invocations) => {
      const { started } = await startBuilding(service, storage);
      await service.advanceNow(started.id);

      const reviewing = await pipeline(storage, started.id);
      expect(reviewing.phase).toBe("reviewing");
      expect(reviewing.reviewPackage).toMatchObject({
        kind: "file",
        headRef: "1111111111111111111111111111111111111111",
      });
      expect("filePath" in reviewing.reviewPackage!).toBe(true);
      expect(
        "filePath" in reviewing.reviewPackage! ? reviewing.reviewPackage.filePath : "",
      ).toContain(".orkestrator/review-artifacts/");
      expect(invocations.some((entry) => entry.command === "generate_looped_review_package")).toBe(
        true,
      );
      expect(reviewing.sessions.at(-1)).not.toHaveProperty("validationHeadAtStart");
      expect(provider.sent.at(-1)?.prompt).toContain("pins the exact committed range under review");
      expect(provider.sent.at(-1)?.prompt).toContain("Do not modify, create, or delete files");
      expect(provider.sent.at(-1)?.prompt).toContain("Do not rerun the full test suite");
      expect(provider.sent.at(-1)?.prompt).toContain("review-package-");
    });
  });

  test("does not fail review when a temporary Git-visible artifact appears", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      const { started } = await startBuilding(service, storage);
      await service.advanceNow(started.id);
      controls.uncommittedPaths = ["coverage/tmp.json"];

      await service.advanceNow(started.id);

      expect((await pipeline(storage, started.id)).phase).toBe("verifying");
    });
  });

  test("does not probe the live worktree before dispatching the packaged review", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      const { started } = await startBuilding(service, storage);
      controls.failCommands.add("get_environment_uncommitted_paths");

      await service.advanceNow(started.id);

      expect((await pipeline(storage, started.id)).phase).toBe("reviewing");
    });
  });

  // Addressing and verification each open fresh sessions. Anything the address
  // stage leaves uncommitted is the verification session's new baseline, not a
  // violation of it.
  test("rebaselines verification against what the addressing turn left behind", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      provider.structured = async <T>(sessionId: string) => {
        const phase = provider.phases.get(sessionId);
        return {
          ok: true,
          value:
            phase === "build" || phase === "fix"
              ? TEST_REVIEW_PREPARATION
              : {
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
        } as StructuredOutputResult<T>;
      };
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
          "Verification cannot start because the backend could not establish the environment Git state: probe failed (Error)",
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

  describe("a fix that leaves the worktree unchanged", () => {
    const UNCHANGED = "a".repeat(64);
    const CHANGED = "b".repeat(64);

    /** Fails the first verification and returns the pipeline in its fix stage. */
    async function startFixing(
      service: BuildPipelineService,
      storage: StorageService,
      provider: FakeProvider,
    ): Promise<BuildPipeline> {
      const structured = provider.structured.bind(provider);
      provider.structured = async <T>(sessionId: string, requestId: string) =>
        provider.phases.get(sessionId) === "verify"
          ? ({
              ok: true,
              provider: "claude",
              requestId,
              value: { complete: false, rationale: "options.test.ts fails on this host." },
            } as StructuredOutputResult<T>)
          : structured<T>(sessionId, requestId);
      const verifying = await startVerifying(service, storage);
      await service.advanceNow(verifying.id);
      const fixing = await pipeline(storage, verifying.id);
      expect(fixing.phase).toBe("fixing");
      return fixing;
    }

    test("a requested repair failing on both refs remains incomplete and opens a fix", async () => {
      await withService(async (service, storage, provider, _invocations, controls) => {
        controls.fingerprint = UNCHANGED;
        const structured = provider.structured.bind(provider);
        provider.structured = async <T>(id: string, requestId: string) =>
          provider.phases.get(id) === "verify"
            ? ({
                ok: true,
                provider: "claude",
                requestId,
                value: {
                  complete: false,
                  rationale:
                    "The requested runner repair still fails on HEAD and origin/main; ticket acceptance criteria take precedence.",
                },
              } as StructuredOutputResult<T>)
            : structured<T>(id, requestId);
        const verifying = await startVerifying(service, storage, {
          taskSnapshot: {
            ...startInput().taskSnapshot,
            acceptanceCriteria: "Repair the runner hang in options.test.ts.",
          },
        });
        expect(provider.sent.at(-1)?.prompt).toContain(
          "If any ticket-required repair remains unmet on this branch, report complete: false",
        );
        await service.advanceNow(verifying.id);
        const fixing = await pipeline(storage, verifying.id);
        expect(fixing.phase).toBe("fixing");
        expect(fixing.verificationResult).toBe("fail");
        expect(provider.sent.at(-1)?.prompt).toContain(
          "including requested repairs that also fail on origin/main",
        );
        await service.advanceNow(verifying.id);
        expect((await pipeline(storage, verifying.id)).phase).toBe("paused");
        expect(provider.created.some((session) => session.phase === "pr")).toBe(false);
      });
    });

    test("pauses instead of re-reviewing identical code", async () => {
      await withService(async (service, storage, provider, _invocations, controls) => {
        controls.fingerprint = UNCHANGED;
        const fixing = await startFixing(service, storage, provider);
        expect(fixing.sessions.at(-1)).toMatchObject({
          phase: "fix",
          fixWorktreeFingerprintAtStart: UNCHANGED,
        });

        await service.advanceNow(fixing.id);

        const paused = await pipeline(storage, fixing.id);
        expect(paused).toMatchObject({
          phase: "paused",
          pausedFromPhase: "fixing",
          error: UNCHANGED_FIX_PAUSE_MESSAGE,
        });
        expect(paused.sessions.at(-1)?.fixWorktreeFingerprintAtStart).toBeUndefined();
        expect(
          paused.sessions.some((session) => session.phase === "review" && session.iteration === 1),
        ).toBe(false);
      });
    });

    test("continues to review when the fix changed the worktree", async () => {
      await withService(async (service, storage, provider, _invocations, controls) => {
        controls.fingerprint = UNCHANGED;
        const fixing = await startFixing(service, storage, provider);

        controls.fingerprint = CHANGED;
        await service.advanceNow(fixing.id);

        const next = await pipeline(storage, fixing.id);
        expect(next.phase).toBe("reviewing");
        expect(next.error).toBeUndefined();
      });
    });

    test("a new verification failure opens a new fix-stage baseline", async () => {
      await withService(async (service, storage, provider, _invocations, controls) => {
        controls.fingerprint = UNCHANGED;
        const fixing = await startFixing(service, storage, provider);
        controls.fingerprint = CHANGED;
        await service.advanceNow(fixing.id);
        await service.advanceNow(fixing.id);
        expect((await pipeline(storage, fixing.id)).phase).toBe("verifying");
        await service.advanceNow(fixing.id);
        const nextFix = await pipeline(storage, fixing.id);
        expect(nextFix).toMatchObject({ phase: "fixing", iteration: 2 });
        expect(nextFix.sessions.at(-1)?.fixWorktreeFingerprintAtStart).toBe(CHANGED);
        await service.advanceNow(fixing.id);
        expect((await pipeline(storage, fixing.id)).phase).toBe("paused");
      });
    });

    test("continues the loop when the fingerprint cannot be established", async () => {
      await withService(async (service, storage, provider) => {
        const fixing = await startFixing(service, storage, provider);
        expect(fixing.sessions.at(-1)?.fixWorktreeFingerprintAtStart).toBeUndefined();

        await service.advanceNow(fixing.id);

        expect((await pipeline(storage, fixing.id)).phase).toBe("reviewing");
      });
    });

    for (const recovery of ["retry", "restart", "missing-stage"] as const) {
      test(`${recovery} preserves the baseline before a failed fix changed code`, async () => {
        await withService(async (service, storage, provider, invocations, controls) => {
          controls.fingerprint = UNCHANGED;
          const fixing = await startFixing(service, storage, provider);
          const originalSessionId = fixing.sessions.at(-1)!.sdkSessionId;
          controls.fingerprint = CHANGED;
          const before = invocations.filter((call) => call.args.fingerprint).length;
          if (recovery === "retry") {
            const status = provider.status.bind(provider);
            provider.status = async (id) => (id === originalSessionId ? "error" : status(id));
            await service.advanceNow(fixing.id);
            expect((await pipeline(storage, fixing.id)).phase).toBe("failed");
            await service.retryStage(fixing.id);
          } else if (recovery === "restart") {
            await service.restartCurrentStep(fixing.id);
          } else {
            // Recovery receives a missing current session in memory. Storage
            // rejects invalid indexes, so enter the recovery method directly.
            const record = (await storage.getBuildPipeline(fixing.id))!;
            const snapshot = record.snapshot as BuildPipeline;
            snapshot.backendRevision = record.revision;
            snapshot.currentSessionIndex = snapshot.sessions.length;
            await service.recoverMissingStage(snapshot);
          }
          const retried = await pipeline(storage, fixing.id);
          expect(retried.sessions.at(-1)).toMatchObject({
            phase: "fix",
            fixWorktreeFingerprintAtStart: UNCHANGED,
          });
          expect(retried.sessions.at(-1)!.sdkSessionId).not.toBe(originalSessionId);
          expect(invocations.filter((call) => call.args.fingerprint)).toHaveLength(before);
          // The replacement makes no further changes, but the stage as a whole did.
          await service.advanceNow(fixing.id);
          const next = await pipeline(storage, fixing.id);
          expect(next.phase).toBe("reviewing");
          expect(
            next.sessions
              .filter((session) => session.phase === "fix")
              .every((session) => session.fixWorktreeFingerprintAtStart === undefined),
          ).toBe(true);
        });
      });
    }

    test("restart keeps an unavailable initial baseline disabled", async () => {
      await withService(async (service, storage, provider, invocations, controls) => {
        const fixing = await startFixing(service, storage, provider);
        controls.fingerprint = UNCHANGED;
        const before = invocations.filter((call) => call.args.fingerprint).length;
        await service.restartCurrentStep(fixing.id);
        expect(
          (await pipeline(storage, fixing.id)).sessions.at(-1)?.fixWorktreeFingerprintAtStart,
        ).toBeUndefined();
        await service.advanceNow(fixing.id);
        expect((await pipeline(storage, fixing.id)).phase).toBe("reviewing");
        expect(invocations.filter((call) => call.args.fingerprint)).toHaveLength(before);
      });
    });

    for (const failure of ["unavailable", "failed", "transient"] as const) {
      test(`consumes the persisted baseline after ${failure} completion probes`, async () => {
        await withService(async (service, storage, provider, invocations, controls) => {
          controls.fingerprint = UNCHANGED;
          const fixing = await startFixing(service, storage, provider);
          const before = invocations.filter((call) => call.args.fingerprint).length;
          if (failure === "unavailable") controls.fingerprint = undefined;
          else if (failure === "failed") controls.probeError = new Error("busy");
          else controls.failCommandsOnce.set("get_environment_uncommitted_paths", 2);
          await service.advanceNow(fixing.id);
          const next = await pipeline(storage, fixing.id);
          expect(next.phase).toBe(failure === "transient" ? "paused" : "reviewing");
          expect(
            next.sessions
              .filter((session) => session.phase === "fix")
              .every((session) => session.fixWorktreeFingerprintAtStart === undefined),
          ).toBe(true);
          expect(invocations.filter((call) => call.args.fingerprint)).toHaveLength(before + 3);
          controls.probeError = undefined;
          controls.fingerprint = UNCHANGED;
          // Reload the durable snapshot through the next pass; no stale comparison remains.
          await service.advanceNow(fixing.id);
          expect(invocations.filter((call) => call.args.fingerprint)).toHaveLength(before + 3);
        });
      });
    }

    test("does not retry an oversized fingerprint at fix start or completion", async () => {
      await withService(async (service, storage, provider, invocations, controls) => {
        controls.fingerprint = UNCHANGED;
        controls.probeError = new Error("review-worktree-probe:too-large");
        const fixing = await startFixing(service, storage, provider);
        expect(invocations.filter((call) => call.args.fingerprint)).toHaveLength(1);
        expect(fixing.sessions.at(-1)?.fixWorktreeFingerprintAtStart).toBeUndefined();
        // Install a persisted baseline to exercise the same policy on completion.
        await mutateStored(storage, fixing.id, (snapshot) => {
          snapshot.sessions.at(-1)!.fixWorktreeFingerprintAtStart = UNCHANGED;
        });
        await service.advanceNow(fixing.id);
        expect(invocations.filter((call) => call.args.fingerprint)).toHaveLength(2);
        expect((await pipeline(storage, fixing.id)).phase).toBe("reviewing");
      });
    });

    for (const preparation of ["fanout", "preparation"] as const) {
      test(`pauses before ${preparation} package preparation and excludes its override turn`, async () => {
        await withService(async (service, storage, provider, invocations, controls) => {
          controls.fingerprint = UNCHANGED;
          const fixing = await startFixing(service, storage, provider);
          await mutateStored(storage, fixing.id, (snapshot) => {
            if (preparation === "fanout") {
              snapshot.reviewers = [{ agent: "claude" }, { agent: "codex" }];
            } else snapshot.reviewPreparation = { agent: "claude" };
          });
          const before = invocations.length;
          const sessionCount = provider.created.length;
          await service.advanceNow(fixing.id);
          expect((await pipeline(storage, fixing.id)).phase).toBe("paused");
          expect(provider.created).toHaveLength(sessionCount);
          expect(
            invocations
              .slice(before)
              .some((call) => call.command === "generate_looped_review_package"),
          ).toBe(false);

          // Explicit resume moves to the preparation override, without a new fingerprint.
          await service.resume(fixing.id);
          await service.advanceNow(fixing.id);
          const probes = invocations.filter((call) => call.args.fingerprint).length;
          await service.advanceNow(fixing.id);
          const preparing = await pipeline(storage, fixing.id);
          expect(preparing.sessions.at(-1)).toMatchObject({
            phase: "fix",
            label: REVIEW_PACKAGE_SESSION_LABEL,
          });
          expect(preparing.sessions.at(-1)?.fixWorktreeFingerprintAtStart).toBeUndefined();
          expect(invocations.filter((call) => call.args.fingerprint)).toHaveLength(probes);
          // Completion of that override also must not trigger the unchanged-fix check.
          await service.advanceNow(fixing.id);
          expect((await pipeline(storage, fixing.id)).phase).toBe("reviewing");
          expect(invocations.filter((call) => call.args.fingerprint)).toHaveLength(probes);
        });
      });
    }

    for (const action of ["resume", "cancel"] as const) {
      test(`tool-mode auto-pause retains the unused submission until ${action} closes it`, async () => {
        await withService(
          async (service, storage, provider, _invocations, controls) => {
            controls.fingerprint = UNCHANGED;
            const fixing = await startFixing(service, storage, provider);
            const session = fixing.sessions.at(-1)!;
            expect(session.resultTransport).toBe("tool-v1");
            const key = session.structuredRequestId!;
            const scope = { environmentId: "env-1", projectId: "project-1" };
            await service.advanceNow(fixing.id);
            expect((await pipeline(storage, fixing.id)).phase).toBe("paused");
            expect(await controls.workflowResults!.status(scope, key)).toMatchObject({
              lifecycle: "accepted",
            });
            await service[action](fixing.id);
            expect(await controls.workflowResults!.status(scope, key)).toMatchObject({
              lifecycle: action === "resume" ? "superseded" : "cancelled",
              completion: "blocked",
            });
            expect(
              await controls.workflowResults!.submit(scope, key, TEST_REVIEW_PREPARATION),
            ).toMatchObject({ ok: false, error: { code: "attempt_closed" } });
            if (action === "resume") {
              expect(
                (await pipeline(storage, fixing.id)).sessions.at(-1)!.structuredRequestId,
              ).not.toBe(key);
            }
          },
          { toolMode: true },
        );
      });
    }

    test("resume runs the next round instead of pausing again", async () => {
      await withService(async (service, storage, provider, _invocations, controls) => {
        controls.fingerprint = UNCHANGED;
        const fixing = await startFixing(service, storage, provider);
        await service.advanceNow(fixing.id);
        expect((await pipeline(storage, fixing.id)).phase).toBe("paused");

        const resumed = await service.resume(fixing.id);
        expect(resumed.phase).toBe("fixing");
        expect(resumed.error).toBeUndefined();
        // The first pass dispatches the resume prompt to the idle fix session;
        // the second sees that turn finish on the same, unchanged worktree.
        await service.advanceNow(fixing.id);
        expect(provider.sent.at(-1)?.prompt).toContain("Resume fixing");
        await service.advanceNow(fixing.id);

        expect((await pipeline(storage, fixing.id)).phase).toBe("reviewing");
      });
    });
  });
});

describe("transcript fingerprints", () => {
  const tail = { id: "m2", content: "x".repeat(1024 * 1024), parts: [{ toolOutput: "y" }] };

  test("stay fixed-size however large the newest entry is", () => {
    const fingerprint = transcriptFingerprint([{ id: "m1" }, tail]);
    expect(fingerprint).toMatch(/^tf2:2:[0-9a-f]{32}$/);
    expect(fingerprint).not.toContain("xxx");
  });

  test("change with the length or with the newest entry alone", () => {
    const base = transcriptFingerprint([{ id: "m1" }, tail]);
    expect(transcriptFingerprint([{ id: "m1" }, { ...tail, content: "changed" }])).not.toBe(base);
    expect(transcriptFingerprint([{ id: "m0" }, { id: "m1" }, tail])).not.toBe(base);
    expect(transcriptFingerprint([{ id: "other" }, tail])).toBe(base);
    expect(transcriptFingerprint([])).toBe(transcriptFingerprint([]));
  });

  test("a stored raw key normalizes to the digest of the same transcript", () => {
    const messages = [{ id: "m1" }, tail];
    const legacy = legacyTranscriptFingerprint(messages);
    expect(normalizeTranscriptFingerprint(legacy)).toBe(transcriptFingerprint(messages));
    expect(normalizeTranscriptFingerprint(transcriptFingerprint(messages))).toBe(
      transcriptFingerprint(messages),
    );
    expect(normalizeTranscriptFingerprint(undefined)).toBeUndefined();
  });
});
