import { describe,expect,test } from "bun:test";


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
AGENT_INTERACTION_CLAIM_RETENTION_MS,
AGENT_INTERACTION_CONTRACT_VERSION,
AGENT_INTERACTION_JOURNAL_VERSION,
AGENT_INTERACTION_LIMITS,
AGENT_INTERACTION_SUMMARY_VERSION,
UNATTENDED_AGENT_INTERACTION_POLICY,
type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";


import {
type StructuredReviewReport
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
ProviderUnavailableError
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

describe("BuildPipelineService", () => {



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
          interactionAdapter: {
            interactionTracker: {
              registration: (sessionId: string) => ProviderSessionRegistration;
            };
          };
        }).interactionAdapter.interactionTracker.registration("build-1");
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
