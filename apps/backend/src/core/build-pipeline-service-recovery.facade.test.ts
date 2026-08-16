import { describe,expect,mock,test } from "bun:test";


import { promises as fs } from "node:fs";


import { tmpdir } from "node:os";


import path from "node:path";




import type {
BuildPipeline,
PipelineSession,
PipelineSessionPhase
} from "@orkestrator/protocol/build-pipeline";




import {
AGENT_INTERACTION_CONTRACT_VERSION,
AGENT_INTERACTION_JOURNAL_VERSION,
UNATTENDED_AGENT_INTERACTION_POLICY,
type AgentInteractionRequest
} from "@orkestrator/protocol/agent-interactions";


import {
STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";


import type {
JsonSchema,
StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";


import { StorageService } from "./storage.js";


import {
BuildPipelineService,
} from "./build-pipeline-service.js";


import {
ProviderSessionFailedError,
ProviderUnavailableError,
} from "./build-pipeline-provider.js";


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
      failCommandsOnce: Map<string, number>;
      currentHead: string;
      uncommittedPaths: string[];
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
    // Counts down a command's remaining transient failures, so a test can make
    // a probe fail once and then succeed rather than only fail forever.
    failCommandsOnce: new Map<string, number>(),
    currentHead: "1111111111111111111111111111111111111111",
    uncommittedPaths: [] as string[],
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



  test("repairs build-tab publication when an admitted start is retried", async () => {
    await withService(async (service, storage) => {
      const ensureBuildPipelineTab = storage.ensureBuildPipelineTab.bind(storage);
      let attempts = 0;
      storage.ensureBuildPipelineTab = mock(async (input) => {
        attempts += 1;
        if (attempts === 1) throw new Error("pane layout temporarily unavailable");
        return ensureBuildPipelineTab(input);
      });

      const input = startInput();
      await expect(service.start(input)).rejects.toThrow(
        "pane layout temporarily unavailable",
      );

      const [persisted] = await storage.listBuildPipelines(input.projectId);
      expect(persisted).toBeDefined();
      expect(persisted!.snapshot).toMatchObject({
        id: persisted!.id,
        environmentId: "env-1",
        sourceLinkedAt: expect.any(String),
      });
      expect(await storage.getPaneLayout("env-1")).toBeNull();

      const retried = await service.start(input);
      expect(retried.id).toBe(persisted!.id);
      expect(attempts).toBe(2);
      expect(await storage.getPaneLayout("env-1")).toMatchObject({
        root: {
          kind: "leaf",
          activeTabId: `build-${persisted!.id}`,
          tabs: [{
            id: `build-${persisted!.id}`,
            type: "claude-build",
            buildTabData: {
              pipelineId: persisted!.id,
              taskId: input.taskId,
            },
          }],
        },
      });
    });
  });



  // A snapshot written before the path list existed still has to certify. The
  // "clean" status pins the baseline to the empty set on its own.
  test("certifies a legacy baseline that recorded a clean status without paths", async () => {
    await withService(async (service, storage) => {
      const verifying = await startVerifying(service, storage);
      await mutateStored(storage, verifying.id, (snapshot) => {
        delete snapshot.sessions[snapshot.currentSessionIndex]!
          .validationUncommittedPathsAtStart;
      });

      await service.advanceNow(verifying.id);

      expect((await pipeline(storage, verifying.id)).phase).toBe("creating-pr");
    });
  });



  // A legacy "dirty" baseline has no path set to compare against, and guessing
  // one would either wave through an edit or reject a leftover. Fail instead.
  test("refuses to certify a legacy dirty baseline that recorded no paths", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      controls.uncommittedPaths = ["src/forgotten.ts"];
      const verifying = await startVerifying(service, storage);
      expect(
        verifying.sessions[verifying.currentSessionIndex]!.validationWorktreeStatusAtStart,
      ).toBe("dirty");
      await mutateStored(storage, verifying.id, (snapshot) => {
        delete snapshot.sessions[snapshot.currentSessionIndex]!
          .validationUncommittedPathsAtStart;
      });

      await service.advanceNow(verifying.id);

      expect(await pipeline(storage, verifying.id)).toMatchObject({
        phase: "failed",
        error: "Verification cannot be certified because its starting Git state was not recorded",
      });
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



  // A terminal turn error proves the bridge answered, so a stale reconnect
  // attempt accusing it of being unreachable must be cleared instead of
  // outliving it and eventually failing the pipeline with "stayed unreachable"
  // instead of the real reason. Clearing returns, so the stage failure lands on
  // the following pass rather than this one.
  test("clears a stale reconnect attempt before failing on a terminal turn error", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      provider.status = async () => {
        throw new ProviderUnavailableError("claude bridge is unreachable");
      };

      await service.advanceNow(started.id);

      const reconnecting = await pipeline(storage, started.id);
      expect(reconnecting.phase).toBe("building");
      expect(reconnecting.reconnectAttempt).toMatchObject({
        agent: provider.agent,
        sessionId: session.sdkSessionId,
      });

      provider.status = async () => {
        throw new ProviderSessionFailedError(
          provider.agent,
          "Selected model is at capacity. Please try a different model.",
        );
      };

      // The bridge answered, so this pass spends itself clearing the accusation.
      await service.advanceNow(started.id);

      const cleared = await pipeline(storage, started.id);
      expect(cleared.phase).toBe("building");
      expect(cleared.reconnectAttempt).toBeUndefined();
      expect(cleared.error).toBeUndefined();

      // Only now does the terminal turn error reach the failing branch.
      await service.advanceNow(started.id);

      const failed = await pipeline(storage, started.id);
      const recordedError = failed.error;
      expect(failed.phase).toBe("failed");
      expect(recordedError).toContain(
        "Selected model is at capacity. Please try a different model.",
      );
    });
  });



  test("retries a failed build stage in a fresh session", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session: firstSession } = await startBuilding(
        service,
        storage,
      );
      provider.status = async () => "error";
      await service.advanceNow(started.id);

      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        failureContext: {
          phase: "building",
          kind: "stage-transition",
          sessionId: firstSession.sdkSessionId,
        },
        sessions: [expect.objectContaining({
          sdkSessionId: firstSession.sdkSessionId,
          status: "error",
        })],
      });

      provider.status = async () => "idle";
      const retried = await service.retryStage(started.id);

      expect(retried).toMatchObject({
        phase: "building",
        currentSessionIndex: 1,
      });
      expect(retried.error).toBeUndefined();
      expect(retried.failureContext).toBeUndefined();
      expect(retried.stageRetryRequested).toBeUndefined();
      expect(retried.sessions).toHaveLength(2);
      expect(retried.sessions[0]).toMatchObject({
        sdkSessionId: firstSession.sdkSessionId,
        status: "error",
      });
      expect(retried.sessions[1]).toMatchObject({
        phase: "build",
        status: "running",
      });
      expect(retried.sessions[1]?.sdkSessionId)
        .not.toBe(firstSession.sdkSessionId);
      expect(provider.sent.at(-1)?.sessionId)
        .toBe(retried.sessions[1]?.sdkSessionId);
    });
  });



  test("persists a failed retry without reporting that a session restarted", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session: firstSession } = await startBuilding(
        service,
        storage,
      );
      provider.status = async () => "error";
      await service.advanceNow(started.id);
      provider.createSession = async () => {
        throw new Error("fresh session could not be created");
      };

      const retried = await service.retryStage(started.id);

      expect(retried).toMatchObject({
        phase: "failed",
        error: "fresh session could not be created",
      });
      expect(retried.stageRetryRequested).toBeUndefined();
      expect(retried.failureContext?.sessionId).toBeUndefined();
      expect(retried.sessions).toEqual([
        expect.objectContaining({
          sdkSessionId: firstSession.sdkSessionId,
          status: "error",
        }),
      ]);
    });
  });



  test("retries a failed provisioning phase without creating an agent session", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      expect(started.phase).toBe("starting-environment");
      await mutateStored(storage, started.id, (candidate) => {
        candidate.phase = "failed";
        candidate.error = "environment start failed";
        candidate.failureContext = {
          phase: "starting-environment",
          kind: "stage-transition",
        };
      });

      const retried = await service.retryStage(started.id);

      expect(retried).toMatchObject({
        phase: "waiting-for-setup",
        sessions: [],
        currentSessionIndex: -1,
      });
      expect(retried.error).toBeUndefined();
      expect(retried.failureContext).toBeUndefined();
      expect(retried.stageRetryRequested).toBeUndefined();
      expect(provider.created).toEqual([]);
    });
  });



  test("retries a failed PR stage in a fresh session", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session: firstSession } = await startBuilding(
        service,
        storage,
      );
      await mutateStored(storage, started.id, (candidate) => {
        candidate.phase = "failed";
        candidate.error = "The pr session failed";
        candidate.failureContext = {
          phase: "creating-pr",
          kind: "stage-transition",
          sessionId: firstSession.sdkSessionId,
        };
        candidate.sessions[candidate.currentSessionIndex]!.status = "error";
      });

      const retried = await service.retryStage(started.id);

      expect(retried).toMatchObject({
        phase: "creating-pr",
        currentSessionIndex: 1,
      });
      expect(retried.error).toBeUndefined();
      expect(retried.failureContext).toBeUndefined();
      expect(retried.stageRetryRequested).toBeUndefined();
      expect(retried.sessions).toHaveLength(2);
      expect(retried.sessions[0]).toMatchObject({
        sdkSessionId: firstSession.sdkSessionId,
        status: "error",
      });
      expect(retried.sessions[1]).toMatchObject({
        phase: "pr",
        status: "running",
      });
      expect(retried.sessions[1]?.sdkSessionId)
        .not.toBe(firstSession.sdkSessionId);
      expect(provider.created.at(-1)?.phase).toBe("pr");
      expect(provider.sent.at(-1)?.sessionId)
        .toBe(retried.sessions[1]?.sdkSessionId);
    });
  });



  test("retries a failed conflict-resolution stage in a fresh session", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session: firstSession } = await startBuilding(
        service,
        storage,
      );
      await mutateStored(storage, started.id, (candidate) => {
        candidate.phase = "failed";
        candidate.error = "The conflict resolution failed";
        candidate.failureContext = {
          phase: "resolving-conflicts",
          kind: "stage-transition",
          sessionId: firstSession.sdkSessionId,
        };
        candidate.sessions[candidate.currentSessionIndex]!.status = "error";
      });

      const retried = await service.retryStage(started.id);

      expect(retried).toMatchObject({
        phase: "resolving-conflicts",
        currentSessionIndex: 1,
      });
      expect(retried.error).toBeUndefined();
      expect(retried.failureContext).toBeUndefined();
      expect(retried.stageRetryRequested).toBeUndefined();
      expect(retried.sessions).toHaveLength(2);
      expect(retried.sessions[0]).toMatchObject({
        sdkSessionId: firstSession.sdkSessionId,
        status: "error",
      });
      expect(retried.sessions[1]).toMatchObject({
        phase: "resolve-conflicts",
        status: "running",
      });
      expect(retried.sessions[1]?.sdkSessionId)
        .not.toBe(firstSession.sdkSessionId);
      expect(provider.created.at(-1)?.phase).toBe("resolve-conflicts");
      expect(provider.sent.at(-1)?.sessionId)
        .toBe(retried.sessions[1]?.sdkSessionId);
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



  test("repairs a report that broke the contract without restarting the review", async () => {
    await withService(async (service, storage, provider) => {
      let reports = 0;
      provider.structured = async <T>(
        sessionId: string,
        requestId: string,
      ): Promise<StructuredOutputResult<T>> => {
        if (provider.phases.get(sessionId) !== "review") {
          return {
            ok: true,
            provider: "claude",
            requestId,
            value: { complete: true, rationale: "All criteria pass." } as T,
          };
        }
        reports += 1;
        return {
          ok: true,
          provider: "claude",
          requestId,
          // Schema-valid but contract-invalid: the failure count disagrees with
          // the failure details, which no JSON schema can express.
          value: (reports === 1
            ? {
              ...cleanReview,
              testResults: {
                total: 2,
                passed: 1,
                failed: 1,
                notRun: 0,
                failures: [],
              },
            }
            : cleanReview) as T,
        };
      };
      const started = await service.start(startInput());
      for (
        let pass = 0;
        pass < 8 && (await pipeline(storage, started.id)).phase !== "verifying";
        pass += 1
      ) {
        await service.advanceNow(started.id);
      }

      const advanced = await pipeline(storage, started.id);
      expect(advanced.phase).toBe("verifying");
      expect(advanced.structuredReview).toEqual(cleanReview);
      // The repair is a second turn in the first review session, not a new one.
      const reviews = advanced.sessions.filter((session) => session.phase === "review");
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        structuredReportRepairAttempts: 1,
        structuredResultStatus: "accepted",
      });
      const repair = provider.sent.find((sent) =>
        sent.prompt.includes("Failure details count must equal failed."));
      expect(repair).toMatchObject({
        sessionId: reviews[0]!.sdkSessionId,
        requestId: reviews[0]!.structuredRequestId,
        schema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
      });
      expect(repair!.prompt).toContain("$.testResults.failures");
      expect(repair!.prompt).toContain("repair attempt 1 of 3");
    });
  });



  test("accepts a report repaired on the last permitted attempt", async () => {
    await withService(async (service, storage, provider) => {
      let reports = 0;
      provider.structured = async <T>(
        sessionId: string,
        requestId: string,
      ): Promise<StructuredOutputResult<T>> => {
        if (provider.phases.get(sessionId) !== "review") {
          return {
            ok: true,
            provider: "claude",
            requestId,
            value: { complete: true, rationale: "All criteria pass." } as T,
          };
        }
        reports += 1;
        // Rejected three times, corrected on the third and final repair — the
        // path where the attempt counter is read back from a persisted value
        // rather than from an absent one.
        return {
          ok: true,
          provider: "claude",
          requestId,
          value: (reports <= 3
            ? { ...cleanReview, riskProfile: { ...cleanReview.riskProfile, overallRisk: "severe" } }
            : cleanReview) as T,
        };
      };
      const started = await service.start(startInput());
      for (
        let pass = 0;
        pass < 12 && (await pipeline(storage, started.id)).phase !== "verifying";
        pass += 1
      ) {
        await service.advanceNow(started.id);
      }

      const advanced = await pipeline(storage, started.id);
      expect(advanced.phase).toBe("verifying");
      expect(advanced.structuredReview).toEqual(cleanReview);
      expect(reports).toBe(4);
      const reviews = advanced.sessions.filter((session) => session.phase === "review");
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        structuredReportRepairAttempts: 3,
        structuredResultStatus: "accepted",
      });
      // Each repair is its own turn under its own request id, and the last one
      // is the id the accepted report was read from.
      const repairs = provider.sent.filter((sent) =>
        sent.prompt.includes("$.riskProfile.overallRisk"));
      expect(repairs).toHaveLength(3);
      expect(new Set(repairs.map((sent) => sent.requestId)).size).toBe(3);
      expect(repairs.at(-1)?.requestId).toBe(reviews[0]!.structuredRequestId);
      expect(repairs.map((sent) => sent.sessionId)).toEqual(
        Array.from({ length: 3 }, () => reviews[0]!.sdkSessionId),
      );
      expect(repairs.map((sent) =>
        sent.prompt.includes(`repair attempt ${repairs.indexOf(sent) + 1} of 3`)
      )).toEqual([true, true, true]);
    });
  });



  test("fails the review once the bounded report repairs are exhausted", async () => {
    await withService(async (service, storage, provider) => {
      let reports = 0;
      provider.structured = async <T>(
        _sessionId: string,
        requestId: string,
      ): Promise<StructuredOutputResult<T>> => {
        reports += 1;
        return {
          ok: true,
          provider: "claude",
          requestId,
          value: { issues: "not-an-array" } as T,
        };
      };
      const started = await service.start(startInput());
      for (
        let pass = 0;
        pass < 12 && (await pipeline(storage, started.id)).phase !== "failed";
        pass += 1
      ) {
        await service.advanceNow(started.id);
      }

      const failed = await pipeline(storage, started.id);
      expect(failed).toMatchObject({
        phase: "failed",
        error: expect.stringContaining("3 repair attempts"),
      });
      // One original report plus exactly three repairs, all in one session.
      expect(reports).toBe(4);
      const reviews = failed.sessions.filter((session) => session.phase === "review");
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.structuredReportRepairAttempts).toBe(3);
    });
  });



  test("fails the review when a repair turn itself fails provider-side", async () => {
    await withService(async (service, storage, provider) => {
      let reports = 0;
      provider.structured = async <T>(
        _sessionId: string,
        requestId: string,
      ): Promise<StructuredOutputResult<T>> => {
        reports += 1;
        if (reports === 1) {
          // Schema-valid but contract-invalid: the failure count disagrees with
          // the failure details, so the report is rejected and a repair is asked
          // for. The provider error comes on the repair turn itself.
          return {
            ok: true,
            provider: "claude",
            requestId,
            value: {
              ...cleanReview,
              testResults: {
                total: 2,
                passed: 1,
                failed: 1,
                notRun: 0,
                failures: [],
              },
            } as T,
          };
        }
        return {
          ok: false,
          provider: "claude",
          requestId,
          error: {
            code: "provider_error",
            message: "the review provider did not produce a structured result",
            provider: "claude",
            retryable: true,
          },
        };
      };
      const started = await service.start(startInput());
      for (
        let pass = 0;
        pass < 8 && (await pipeline(storage, started.id)).phase !== "failed";
        pass += 1
      ) {
        await service.advanceNow(started.id);
      }

      const failed = await pipeline(storage, started.id);
      expect(failed).toMatchObject({
        phase: "failed",
        error: expect.stringContaining("did not produce a structured result"),
      });
      // One original report plus one repair turn; the provider error on the
      // repair is not repaired again, because no report was ever emitted for it.
      expect(reports).toBe(2);
      const reviews = failed.sessions.filter((session) => session.phase === "review");
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.structuredReportRepairAttempts).toBe(1);
      // The single repair was dispatched and still carried the report schema.
      const repairs = provider.sent.filter((sent) =>
        sent.prompt.includes("repair attempt 1 of 3"));
      expect(repairs).toHaveLength(1);
      expect(repairs[0]?.schema).toBe(STRUCTURED_REVIEW_REPORT_JSON_SCHEMA);
    });
  });



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



  test("keeps one stall warning per stalled turn and clears it when it ends", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const messages = await provider.messages(session.sdkSessionId);
      const stalledAt = new Date(Date.now() - 11 * 60_000).toISOString();
      await mutateStored(storage, started.id, (snapshot) => {
        const current = snapshot.sessions[snapshot.currentSessionIndex]!;
        current.messages = messages;
        current.messagesFingerprint =
          `${messages.length}:${JSON.stringify(messages.at(-1))}`;
        current.startedAt = stalledAt;
        current.messagesPersistedAt = stalledAt;
        current.turnStartedAt = stalledAt;
      });
      provider.status = async () => "running";
      const beforeRevision = (await storage.getBuildPipeline(started.id))!.revision;

      await service.advanceNow(started.id);
      const warnedRecord = (await storage.getBuildPipeline(started.id))!;
      const warned = warnedRecord.snapshot as BuildPipeline;
      // Neither the status nor the transcript moved, so the new warning is the
      // only thing that could have driven this write.
      expect(warnedRecord.revision).toBeGreaterThan(beforeRevision);
      expect(warned.stallWarning?.sessionId).toBe(session.sdkSessionId);

      await service.advanceNow(started.id);
      const secondRecord = (await storage.getBuildPipeline(started.id))!;
      expect(secondRecord.revision).toBe(warnedRecord.revision);
      expect((secondRecord.snapshot as BuildPipeline).stallWarning?.detectedAt)
        .toBe(warned.stallWarning!.detectedAt);

      provider.status = async () => "idle";
      await service.advanceNow(started.id);
      const finished = await pipeline(storage, started.id);
      expect(finished.phase).toBe("reviewing");
      expect(finished.stallWarning).toBeUndefined();
    });
  });



  test("a completing pipeline carries no stall warning", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput());
      for (let pass = 0; pass < 5; pass += 1) {
        await service.advanceNow(started.id);
      }
      expect((await pipeline(storage, started.id)).phase).toBe("creating-pr");
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.stallWarning = {
          sessionId: snapshot.sessions[snapshot.currentSessionIndex]!.sdkSessionId,
          detectedAt: new Date().toISOString(),
        };
      });

      await service.advanceNow(started.id);

      const completed = await pipeline(storage, started.id);
      expect(completed.phase).toBe("complete");
      expect(completed.stallWarning).toBeUndefined();
    });
  });

});
