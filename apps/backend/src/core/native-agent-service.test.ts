import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BuildPipeline,
  BuildPipelineAgent,
} from "@orkestrator/protocol/build-pipeline";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import {
  createBuildPipelineProvider,
  PromptRejectedError,
  ProviderUnavailableError,
  type BridgeConnection,
  type BuildPipelineProvider,
  type ProviderSendOptions,
  type ProviderActivityState,
  type AgentInteractionProviderCapability,
  type ProviderStatus,
} from "./build-pipeline-provider.js";
import type { Environment } from "./models.js";
import {
  NativeAgentService,
  nativeAgentSessionStorageKey,
  type AgentInteractionObservation,
  type EnsureNativeAgentSessionInput,
  type NativeAgentServiceOptions,
} from "./native-agent-service.js";
import { StorageService } from "./storage.js";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** The default for every test whose provider is injected and stages nothing. */
const refusingInvoke: Invoke = async <T>(command: string): Promise<T> => {
  throw new Error(`Unexpected backend command: ${command}`);
};

function createProviderStub(
  agent: BuildPipelineAgent,
  behaviour: {
    createSession?: () => Promise<string>;
    send?: (
      sessionId: string,
      prompt: string,
      options: ProviderSendOptions,
    ) => Promise<void>;
    status?: (sessionId: string) => Promise<ProviderStatus>;
    activity?: (sessionId: string) => Promise<ProviderActivityState>;
    activityBatch?: (
      sessionIds: readonly string[],
    ) => Promise<Map<string, ProviderActivityState>>;
    interactions?: AgentInteractionProviderCapability;
  } = {},
) {
  const createSession = mock(
    behaviour.createSession ?? (async () => "provider-session"),
  );
  const send = mock(behaviour.send ?? (async () => undefined));
  const status = mock(behaviour.status ?? (async () => "idle" as ProviderStatus));
  const activity = behaviour.activity ? mock(behaviour.activity) : undefined;
  const activityBatch = behaviour.activityBatch
    ? mock(behaviour.activityBatch)
    : undefined;
  const registerSession = mock((_sessionId: string) => undefined);
  const dispose = mock(async () => undefined);
  const provider = {
    agent,
    createSession,
    registerSession,
    send,
    status,
    activity,
    activityBatch,
    interactions: behaviour.interactions,
    messages: async () => [],
    structured: async () => null,
    abort: async () => undefined,
    dispose,
  } as unknown as BuildPipelineProvider;
  return {
    provider,
    createSession,
    registerSession,
    send,
    status,
    activity,
    activityBatch,
    dispose,
  };
}

function createOpenCodeLifecycleProvider(existingSessionIds: readonly string[]) {
  const existing = new Set(existingSessionIds);
  const client = {
    session: {
      async status() {
        // OpenCode's real status map omits idle sessions.
        return { data: {} };
      },
      async list() {
        return { data: [...existing].map((id) => ({ id })) };
      },
      async get(parameters: { sessionID: string }) {
        return existing.has(parameters.sessionID)
          ? { data: { id: parameters.sessionID, directory: "/workspace" } }
          : { error: { name: "NotFound" }, response: { status: 404 } };
      },
    },
    question: { async list() { return { data: [] }; } },
    permission: { async list() { return { data: [] }; } },
  };
  return createBuildPipelineProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    },
    { openCodeClient: client as never, autoAnswerRequests: false },
  );
}

/** Reach the timer-driven scans and backoff bookkeeping the service keeps private. */
function internals(service: NativeAgentService) {
  return service as unknown as {
    drainPromptQueues(): Promise<void>;
    drainPromptQueueOnce(queueKey: string): Promise<void>;
    reconcilePendingLaunches(): Promise<void>;
    provider(input: EnsureNativeAgentSessionInput): Promise<BuildPipelineProvider>;
    bridgeConnection(
      agent: BuildPipelineAgent,
      environment: Environment,
      model?: string,
      effort?: string,
    ): Promise<BridgeConnection>;
    providers: Map<string, BuildPipelineProvider>;
    activityRetryAt: Map<string, number>;
    activityAttempts: Map<string, number>;
    absentBridgeUntil: Map<string, number>;
    observedSessionActivity: Map<
      string,
      { providerSessionId: string; state: ProviderActivityState }
    >;
    pendingPrRefreshEnvironmentIds: Set<string>;
    launchTasks: Map<string, Promise<void>>;
    queueRetryAt: Map<string, number>;
    queueAttempts: Map<string, number>;
    launchRetryAt: Map<string, number>;
    trackedInteractions: Map<string, unknown>;
    providerReportedInteractions: Map<
      string,
      {
        observationKey: string;
        providerSessionKey: string;
        missingSince?: number;
      }
    >;
    interactionObservations: Map<string, AgentInteractionObservation>;
    interactionRetryAt: Map<string, number>;
    interactionAttempts: Map<string, number>;
    monitoredInteractionSessionKeys: Set<string>;
    observedInteractionRevisions: Map<string, number>;
    interactionSelectionCursors: Map<string, number>;
    interactionRevisionReconciliations: number;
    launchTimer: ReturnType<typeof setInterval> | null;
    interactionTimer: ReturnType<typeof setInterval> | null;
  };
}

async function withService(
  setup: {
    prefix: string;
    environment?: Record<string, unknown>;
    provider?: NativeAgentServiceOptions["provider"];
    invoke?: Invoke;
    now?: NativeAgentServiceOptions["now"];
    interactionMonitorMode?: NativeAgentServiceOptions["interactionMonitorMode"];
    interactionMonitorAdoptionEnabled?: boolean;
    interactionMonitorIntervalMs?: number;
    interactionMonitorMaxConcurrency?: number;
    interactionMonitorMaxSessionsPerEnvironment?: number;
    interactionMonitorRetryBaseMs?: number;
    interactionMonitorMaxRetries?: number;
    onInteractionObservation?: NativeAgentServiceOptions["onInteractionObservation"];
  },
  run: (context: {
    storage: StorageService;
    service: NativeAgentService;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), setup.prefix));
  const storage = await createStorage(dataDir);
  await addEnvironment(storage, setup.environment);
  const service = new NativeAgentService(
    storage,
    setup.invoke ?? refusingInvoke,
    {
      ...(setup.provider ? { provider: setup.provider } : {}),
      ...(setup.now ? { now: setup.now } : {}),
      ...(setup.interactionMonitorMode
        ? { interactionMonitorMode: setup.interactionMonitorMode }
        : {}),
      ...(setup.interactionMonitorAdoptionEnabled === undefined
        ? {}
        : { interactionMonitorAdoptionEnabled: setup.interactionMonitorAdoptionEnabled }),
      ...(setup.interactionMonitorIntervalMs === undefined
        ? {}
        : { interactionMonitorIntervalMs: setup.interactionMonitorIntervalMs }),
      ...(setup.interactionMonitorMaxConcurrency === undefined
        ? {}
        : { interactionMonitorMaxConcurrency: setup.interactionMonitorMaxConcurrency }),
      ...(setup.interactionMonitorMaxSessionsPerEnvironment === undefined
        ? {}
        : {
            interactionMonitorMaxSessionsPerEnvironment:
              setup.interactionMonitorMaxSessionsPerEnvironment,
          }),
      ...(setup.interactionMonitorRetryBaseMs === undefined
        ? {}
        : { interactionMonitorRetryBaseMs: setup.interactionMonitorRetryBaseMs }),
      ...(setup.interactionMonitorMaxRetries === undefined
        ? {}
        : { interactionMonitorMaxRetries: setup.interactionMonitorMaxRetries }),
      ...(setup.onInteractionObservation
        ? { onInteractionObservation: setup.onInteractionObservation }
        : {}),
    },
  );
  try {
    await run({ storage, service });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function createStorage(dataDir: string): Promise<StorageService> {
  const storage = new StorageService(dataDir);
  await storage.init();
  return storage;
}

async function addEnvironment(
  storage: StorageService,
  updates: Record<string, unknown> = {},
): Promise<void> {
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "Environment",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/env-1",
    setupScriptsComplete: true,
    ...updates,
  });
}

/**
 * Run `body` with `console.warn` captured rather than printed.
 *
 * The activity sweep warns on every failed group by design, so a test that
 * exercises the failure path would otherwise flood the suite output. Returning
 * the captured lines also lets a test assert that nothing was warned at all.
 */
async function captureWarnings(body: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await body();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

function pendingInteractionSnapshot(
  now: number,
  requests: Array<"question" | "permission"> = ["question", "permission"],
): AgentInteractionSnapshot {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    revision: 1,
    requests: requests.map((kind, index) => ({
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      id: `interaction-${index}`,
      provider: "codex",
      kind,
      origin: "looped-review",
      sessionId: "provider-session",
      state: "pending",
      revision: 1,
      presentation: kind === "question"
        ? {
            title: "private request content",
            questions: [{
              id: "question-1",
              prompt: "private prompt content",
              required: true,
              multiple: false,
              secret: false,
              allowFreeText: true,
              options: [{
                id: "option-1",
                label: "private option content",
                providerValue: "private provider value",
              }],
            }],
          }
        : { title: "private permission content", questions: [] },
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 1_000,
    })),
  };
}

function activePipeline(
  id: string,
  providerSessionId: string,
  agent: BuildPipelineAgent = "codex",
): BuildPipeline {
  return {
    id,
    taskId: `task-${id}`,
    projectId: "project-1",
    environmentId: "env-1",
    environmentType: "local",
    agentType: agent,
    phase: "building",
    sessions: [{
      phase: "build",
      agent,
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      iteration: 0,
      sessionKey: `session-${id}`,
      sdkSessionId: providerSessionId,
      status: "running",
      startedAt: new Date(0).toISOString(),
      label: "Build",
    }],
    currentSessionIndex: 0,
    iteration: 0,
    maxIterations: 3,
    createdAt: new Date(0).toISOString(),
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 0,
    controller: "backend",
  };
}

describe("NativeAgentService", () => {
  test("observe-only monitoring survives without a renderer and never responds", async () => {
    let now = 10_000;
    let snapshot = pendingInteractionSnapshot(now);
    const listPendingInteractions = mock(async () => snapshot);
    const resolveInteraction = mock(async () => {
      throw new Error("observe-only must never resolve");
    });
    const { provider } = createProviderStub("codex", {
      interactions: { listPendingInteractions, resolveInteraction },
    });
    await withService({
      prefix: "orkestrator-native-interaction-observe-",
      provider: async () => provider,
      now: () => now,
      interactionMonitorMode: "observe-only",
      // A telemetry sink may be arbitrarily slow; provider polling must not
      // await it, just as Codex's stdout reader must never await consumers.
      onInteractionObservation: () => new Promise<void>(() => undefined),
    }, async ({ service }) => {
      await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow-1:discovery:Review",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      await service.reconcileAgentInteractions();
      expect(resolveInteraction).not.toHaveBeenCalled();
      expect(listPendingInteractions).toHaveBeenCalled();
      expect(service.getInteractionObservations()).toEqual([
        expect.objectContaining({
          provider: "codex",
          kind: "question",
          workflowSurface: "looped-review",
          phase: "discovery",
          count: 1,
          providerState: "blocked",
        }),
        expect.objectContaining({
          provider: "codex",
          kind: "permission",
          count: 1,
          providerState: "blocked",
        }),
      ]);
      const serialized = JSON.stringify(service.getInteractionObservations());
      expect(serialized).not.toContain("private request content");
      expect(serialized).not.toContain("private prompt content");
      expect(serialized).not.toContain("private provider value");

      now += 2_000;
      snapshot = {
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        revision: 2,
        requests: [],
      };
      await service.reconcileAgentInteractions();
      expect(service.getInteractionObservations().every((entry) =>
        entry.eventualOutcome === "expired" && entry.providerState === "idle"
      )).toBe(true);
    });
  });

  test("interaction monitoring is disabled by default and its kill switch blocks adoption", async () => {
    const listPendingInteractions = mock(async () => pendingInteractionSnapshot(10_000));
    const capability: AgentInteractionProviderCapability = {
      listPendingInteractions,
      resolveInteraction: async () => {
        throw new Error("must not resolve");
      },
    };
    const first = createProviderStub("codex", { interactions: capability });
    await withService({
      prefix: "orkestrator-native-interaction-disabled-",
      provider: async () => first.provider,
    }, async ({ service }) => {
      await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow-1:discovery:Review",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      await service.reconcileAgentInteractions();
      expect(listPendingInteractions).not.toHaveBeenCalled();
    });

    listPendingInteractions.mockClear();
    const second = createProviderStub("codex", { interactions: capability });
    await withService({
      prefix: "orkestrator-native-interaction-killswitch-",
      provider: async () => second.provider,
      interactionMonitorMode: "observe-only",
      interactionMonitorAdoptionEnabled: false,
    }, async ({ service }) => {
      await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow-1:discovery:Review",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      await service.reconcileAgentInteractions();
      expect(listPendingInteractions).not.toHaveBeenCalled();
      service.setInteractionMonitorAdoptionEnabled(true);
      await service.reconcileAgentInteractions();
      expect(listPendingInteractions).toHaveBeenCalledTimes(1);
    });
  });

  test("startup rehydrates unattended interaction metadata and pending requests", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-interaction-restart-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    const firstProvider = createProviderStub("codex");
    const first = new NativeAgentService(storage, refusingInvoke, {
      provider: async () => firstProvider.provider,
    });
    try {
      const saved = await first.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow-1:discovery:Review",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      expect(saved.origin).toBe("looped-review");
      await first.shutdown();

      const listPendingInteractions = mock(async () => pendingInteractionSnapshot(10_000, ["question"]));
      const secondProvider = createProviderStub("codex", {
        interactions: {
          listPendingInteractions,
          resolveInteraction: async () => {
            throw new Error("observe-only must not resolve");
          },
        },
      });
      const restarted = new NativeAgentService(storage, refusingInvoke, {
        provider: async () => secondProvider.provider,
        interactionMonitorMode: "observe-only",
      });
      try {
        await restarted.reconcileAgentInteractions();
        expect(listPendingInteractions).toHaveBeenCalledTimes(1);
        expect(secondProvider.registerSession).toHaveBeenCalledWith(
          "provider-session",
          expect.objectContaining({
            origin: "looped-review",
            interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          }),
        );
        expect(restarted.getInteractionObservations()[0]).toMatchObject({
          kind: "question",
          workflowSurface: "looped-review",
        });
      } finally {
        await restarted.shutdown();
      }
    } finally {
      await first.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("interaction monitor diagnostics never include provider request content", async () => {
    const privateContent = "private-request-content-must-not-leak";
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async () => {
          throw new Error(privateContent);
        },
        resolveInteraction: async () => {
          throw new Error("must not resolve");
        },
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-private-log-",
      provider: async () => provider,
      interactionMonitorMode: "observe-only",
    }, async ({ service }) => {
      await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow-1:discovery:Review",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      const warnings = await captureWarnings(() => service.reconcileAgentInteractions());
      expect(warnings.join(" ")).not.toContain(privateContent);
      expect(warnings.join(" ")).toContain("Error");
    });
  });

  test("fairly rotates bounded native sessions while prioritizing the active pipeline", async () => {
    const visited: string[] = [];
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async (sessionId) => {
          visited.push(sessionId);
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests: [],
          };
        },
        resolveInteraction: async () => {
          throw new Error("observe-only must never resolve");
        },
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-fairness-",
      provider: async () => provider,
      interactionMonitorMode: "observe-only",
      interactionMonitorMaxSessionsPerEnvironment: 2,
    }, async ({ storage, service }) => {
      for (let index = 0; index < 10; index += 1) {
        const logicalSessionKey = `looped-review:workflow:${index}:Review`;
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey,
          providerSessionId: `native-${index}`,
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        });
      }
      const pipeline = activePipeline("pipeline-tail", "pipeline-provider");
      await storage.saveBuildPipeline(
        pipeline.id,
        pipeline.projectId,
        pipeline.environmentId,
        1,
        pipeline,
      );

      for (let scan = 0; scan < 10; scan += 1) {
        await service.reconcileAgentInteractions();
      }

      expect(visited[0]).toBe("pipeline-provider");
      expect(new Set(visited.filter((id) => id.startsWith("native-"))).size).toBe(10);
      expect(visited.filter((id) => id === "pipeline-provider")).toHaveLength(10);
    });
  });

  test("rotates a one-slot environment between an active pipeline and native work", async () => {
    const visited: string[] = [];
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async (sessionId) => {
          visited.push(sessionId);
          return { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 1, requests: [] };
        },
        resolveInteraction: async () => {
          throw new Error("observe-only must never resolve");
        },
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-one-slot-",
      provider: async () => provider,
      interactionMonitorMode: "observe-only",
      interactionMonitorMaxSessionsPerEnvironment: 1,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey(
          "env-1",
          "codex",
          "looped-review:workflow:native:Review",
        ),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow:native:Review",
        providerSessionId: "native-provider",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      const pipeline = activePipeline("pipeline-one-slot", "pipeline-provider");
      await storage.saveBuildPipeline(
        pipeline.id,
        pipeline.projectId,
        pipeline.environmentId,
        1,
        pipeline,
      );
      await service.reconcileAgentInteractions();
      await service.reconcileAgentInteractions();
      expect(visited).toEqual(["pipeline-provider", "native-provider"]);
    });
  });

  test("settles retained evidence when a rotated-out session becomes ineligible", async () => {
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async () => pendingInteractionSnapshot(10_000, ["question"]),
        resolveInteraction: async () => {
          throw new Error("observe-only must never resolve");
        },
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-rotated-cleanup-",
      provider: async () => provider,
      interactionMonitorMode: "observe-only",
      interactionMonitorMaxSessionsPerEnvironment: 1,
    }, async ({ storage, service }) => {
      for (const suffix of ["a", "b"] as const) {
        const logicalSessionKey = `looped-review:workflow:${suffix}:Review`;
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey,
          providerSessionId: `provider-${suffix}`,
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        });
      }
      await service.reconcileAgentInteractions();
      await service.reconcileAgentInteractions();
      expect(internals(service).trackedInteractions.size).toBe(2);

      await storage.updateEnvironment("env-1", { status: "stopped" });
      await service.reconcileAgentInteractions();
      expect(internals(service).trackedInteractions.size).toBe(0);
      expect(service.getInteractionObservations()[0]).toMatchObject({
        providerState: "missing",
        eventualOutcome: "expired",
      });
    });
  });

  test("isolates retry backoff by durable session and recovers after eviction", async () => {
    let now = 1_000;
    let failingCalls = 0;
    let healthyCalls = 0;
    const providerFactory = mock(async () => createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async (sessionId) => {
          if (sessionId === "provider-failing" && failingCalls < 2) {
            failingCalls += 1;
            throw new Error("private provider failure");
          }
          if (sessionId === "provider-healthy") healthyCalls += 1;
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests: [],
          };
        },
        resolveInteraction: async () => ({
          result: "applied", interactionId: "unused", sessionId: "unused", revision: 1,
        }),
      },
    }).provider);
    await withService({
      prefix: "orkestrator-native-interaction-retry-isolation-",
      provider: providerFactory,
      now: () => now,
      interactionMonitorMode: "observe-only",
      interactionMonitorRetryBaseMs: 10,
      interactionMonitorMaxRetries: 2,
    }, async ({ storage, service }) => {
      for (const suffix of ["failing", "healthy"] as const) {
        const logicalSessionKey = `looped-review:workflow:${suffix}:Review`;
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey,
          providerSessionId: `provider-${suffix}`,
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        });
      }

      await captureWarnings(() => service.reconcileAgentInteractions());
      expect(failingCalls).toBe(1);
      expect(healthyCalls).toBe(1);
      expect(internals(service).interactionRetryAt.size).toBe(1);

      await service.reconcileAgentInteractions();
      expect(failingCalls).toBe(1);
      expect(healthyCalls).toBe(2);

      now += 10;
      await captureWarnings(() => service.reconcileAgentInteractions());
      expect(failingCalls).toBe(2);
      expect(healthyCalls).toBe(3);
      now += 20;
      await service.reconcileAgentInteractions();
      expect(failingCalls).toBe(2);
      expect(healthyCalls).toBe(4);
      expect(internals(service).interactionRetryAt.size).toBe(0);
      expect(internals(service).interactionAttempts.size).toBe(0);
      expect(providerFactory.mock.calls.length).toBeGreaterThan(1);
    });
  });

  test("preserves retry backoff while one-slot leases rotate", async () => {
    let now = 1_000;
    const calls = new Map<string, number>();
    await withService({
      prefix: "orkestrator-native-interaction-rotating-backoff-",
      provider: async () => createProviderStub("codex", {
        interactions: {
          listPendingInteractions: async (sessionId) => {
            calls.set(sessionId, (calls.get(sessionId) ?? 0) + 1);
            throw new Error("unavailable");
          },
          resolveInteraction: async () => {
            throw new Error("must not resolve");
          },
        },
      }).provider,
      now: () => now,
      interactionMonitorMode: "observe-only",
      interactionMonitorMaxSessionsPerEnvironment: 1,
      interactionMonitorRetryBaseMs: 10,
      interactionMonitorMaxRetries: 4,
    }, async ({ storage, service }) => {
      for (const suffix of ["a", "b"] as const) {
        const logicalSessionKey = `looped-review:workflow:${suffix}:Review`;
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey,
          providerSessionId: `provider-${suffix}`,
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        });
      }
      await captureWarnings(() => service.reconcileAgentInteractions());
      await captureWarnings(() => service.reconcileAgentInteractions());
      expect([...internals(service).interactionAttempts.values()]).toEqual([1, 1]);
      await service.reconcileAgentInteractions();
      expect(calls.get("provider-a")).toBe(1);
      now += 10;
      await captureWarnings(() => service.reconcileAgentInteractions());
      await captureWarnings(() => service.reconcileAgentInteractions());
      expect([...internals(service).interactionAttempts.values()]).toEqual([2, 2]);
    });
  });

  test("rotates multiple native-only monitor slots", async () => {
    const visited = new Set<string>();
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async (sessionId) => {
          visited.add(sessionId);
          return { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 1, requests: [] };
        },
        resolveInteraction: async () => {
          throw new Error("must not resolve");
        },
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-native-only-rotation-",
      provider: async () => provider,
      interactionMonitorMode: "observe-only",
      interactionMonitorMaxSessionsPerEnvironment: 2,
    }, async ({ storage, service }) => {
      for (const suffix of ["a", "b", "c"] as const) {
        const logicalSessionKey = `looped-review:workflow:${suffix}:Review`;
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey,
          providerSessionId: `provider-${suffix}`,
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        });
      }
      await service.reconcileAgentInteractions();
      await service.reconcileAgentInteractions();
      expect(visited.size).toBe(3);
    });
  });

  test("rotates the reserved slot across active pipelines", async () => {
    const visited = new Set<string>();
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async (sessionId) => {
          visited.add(sessionId);
          return { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 1, requests: [] };
        },
        resolveInteraction: async () => {
          throw new Error("must not resolve");
        },
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-pipeline-rotation-",
      provider: async () => provider,
      interactionMonitorMode: "observe-only",
      interactionMonitorMaxSessionsPerEnvironment: 2,
    }, async ({ storage, service }) => {
      for (const suffix of ["a", "b"] as const) {
        const candidate = activePipeline(`pipeline-${suffix}`, `pipeline-provider-${suffix}`);
        await storage.saveBuildPipeline(
          candidate.id,
          candidate.projectId,
          candidate.environmentId,
          1,
          candidate,
        );
      }
      await service.reconcileAgentInteractions();
      await service.reconcileAgentInteractions();
      expect(visited.has("pipeline-provider-a")).toBe(true);
      expect(visited.has("pipeline-provider-b")).toBe(true);
    });
  });

  test("interaction scans honor the absent-bridge cooldown", async () => {
    let now = 1_000;
    let peeks = 0;
    await withService({
      prefix: "orkestrator-native-interaction-absent-cooldown-",
      now: () => now,
      interactionMonitorMode: "observe-only",
      invoke: async <T>(command: string): Promise<T> => {
        if (command === "peek_local_agent_bridge") {
          peeks += 1;
          return null as T;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    }, async ({ storage, service }) => {
      const logicalSessionKey = "looped-review:workflow:absent:Review";
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey,
        providerSessionId: "provider-session",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      await service.reconcileAgentInteractions();
      await service.reconcileAgentInteractions();
      expect(peeks).toBe(1);
      now += 15_000;
      await service.reconcileAgentInteractions();
      expect(peeks).toBe(2);
    });
  });

  test("releases inactive environment state and re-adopts after it becomes ready", async () => {
    let now = 10_000;
    let revision = 1;
    const listPendingInteractions = mock(async () => ({
      ...pendingInteractionSnapshot(now, ["question"]),
      revision: revision++,
    }));
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions,
        resolveInteraction: async () => ({
          result: "applied", interactionId: "unused", sessionId: "unused", revision: 1,
        }),
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-inactive-cleanup-",
      provider: async () => provider,
      now: () => now,
      interactionMonitorMode: "observe-only",
    }, async ({ storage, service }) => {
      const session = await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow:review:Review",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      await service.reconcileAgentInteractions();
      expect(internals(service).monitoredInteractionSessionKeys.has(session.key)).toBe(true);
      expect(internals(service).trackedInteractions.size).toBe(1);

      await storage.updateEnvironment("env-1", { status: "stopped" });
      now += 1;
      await service.reconcileAgentInteractions();
      expect(internals(service).monitoredInteractionSessionKeys.size).toBe(0);
      expect(internals(service).trackedInteractions.size).toBe(0);
      expect(internals(service).observedInteractionRevisions.size).toBe(0);
      expect(service.getInteractionObservations()[0]).toMatchObject({
        providerState: "missing",
        eventualOutcome: "withdrawn",
      });

      await storage.updateEnvironment("env-1", {
        status: "running",
        setupScriptsComplete: true,
      });
      await service.reconcileAgentInteractions();
      expect(listPendingInteractions).toHaveBeenCalledTimes(2);
      expect(internals(service).monitoredInteractionSessionKeys.has(session.key)).toBe(true);

      await storage.updateEnvironment("env-1", { setupScriptsComplete: false });
      await service.reconcileAgentInteractions();
      expect(internals(service).monitoredInteractionSessionKeys.size).toBe(0);
      await storage.updateEnvironment("env-1", { setupScriptsComplete: true });
      await service.reconcileAgentInteractions();
      expect(listPendingInteractions).toHaveBeenCalledTimes(3);

      service.setInteractionMonitorAdoptionEnabled(false);
      const secondKey = nativeAgentSessionStorageKey(
        "env-1",
        "codex",
        "looped-review:workflow:new:Review",
      );
      await storage.adoptNativeAgentSession({
        key: secondKey,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow:new:Review",
        providerSessionId: "provider-new",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      await service.reconcileAgentInteractions();
      expect(internals(service).monitoredInteractionSessionKeys.has(session.key)).toBe(true);
      expect(internals(service).monitoredInteractionSessionKeys.has(secondKey)).toBe(false);

      await storage.updateEnvironment("env-1", {
        deletionRequestedAt: new Date(now).toISOString(),
      });
      await service.reconcileAgentInteractions();
      expect(internals(service).monitoredInteractionSessionKeys.size).toBe(0);
      expect(internals(service).trackedInteractions.size).toBe(0);
    });
  });

  test("cleans stale adopted capacity before admitting a live session", async () => {
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async () => ({
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          revision: 1,
          requests: [],
        }),
        resolveInteraction: async () => ({
          result: "applied", interactionId: "unused", sessionId: "unused", revision: 1,
        }),
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-cap-cleanup-",
      provider: async () => provider,
      interactionMonitorMode: "observe-only",
    }, async ({ service }) => {
      const session = await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow:live:Review",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      const state = internals(service);
      for (let index = 0; index < 1_024; index += 1) {
        state.monitoredInteractionSessionKeys.add(`stale-${index}`);
      }
      await service.reconcileAgentInteractions();
      expect(state.monitoredInteractionSessionKeys).toEqual(new Set([session.key]));
    });
  });

  test("bounds global monitor concurrency and serializes each environment", async () => {
    let inFlight = 0;
    let peak = 0;
    const inFlightByEnvironment = new Map<string, number>();
    let perEnvironmentPeak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = async (
      _input: EnsureNativeAgentSessionInput,
      environment: Environment,
    ): Promise<BuildPipelineProvider> => createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          const environmentInFlight = (inFlightByEnvironment.get(environment.id) ?? 0) + 1;
          inFlightByEnvironment.set(environment.id, environmentInFlight);
          perEnvironmentPeak = Math.max(perEnvironmentPeak, environmentInFlight);
          if (inFlight === 3) release();
          await gate;
          inFlight -= 1;
          inFlightByEnvironment.set(environment.id, environmentInFlight - 1);
          return {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            revision: 1,
            requests: [],
          };
        },
        resolveInteraction: async () => ({
          result: "applied", interactionId: "unused", sessionId: "unused", revision: 1,
        }),
      },
    }).provider;
    await withService({
      prefix: "orkestrator-native-interaction-concurrency-",
      provider,
      interactionMonitorMode: "observe-only",
      interactionMonitorMaxConcurrency: 3,
    }, async ({ storage, service }) => {
      for (let environmentIndex = 1; environmentIndex <= 4; environmentIndex += 1) {
        const environmentId = `env-${environmentIndex}`;
        if (environmentIndex > 1) {
          await addEnvironment(storage, {
            id: environmentId,
            worktreePath: `/tmp/${environmentId}`,
          });
        }
        for (let sessionIndex = 0; sessionIndex < 2; sessionIndex += 1) {
          const logicalSessionKey = `looped-review:workflow:${sessionIndex}:Review`;
          await storage.adoptNativeAgentSession({
            key: nativeAgentSessionStorageKey(environmentId, "codex", logicalSessionKey),
            environmentId,
            agent: "codex",
            logicalSessionKey,
            providerSessionId: `${environmentId}-provider-${sessionIndex}`,
            origin: "looped-review",
            interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          });
        }
      }
      await service.reconcileAgentInteractions();
      expect(peak).toBe(3);
      expect(perEnvironmentPeak).toBe(1);
    });
  });

  test("reconciles revision gaps and resets from authoritative snapshots", async () => {
    let now = 10_000;
    let index = 0;
    const snapshots: AgentInteractionSnapshot[] = [
      pendingInteractionSnapshot(now, ["question"]),
      { ...pendingInteractionSnapshot(now, ["question"]), revision: 3 },
      { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 0, requests: [] },
      {
        ...pendingInteractionSnapshot(now, ["question"]),
        revision: 1,
        requests: pendingInteractionSnapshot(now, ["question"]).requests.map((request) => ({
          ...request,
          expiresAt: undefined,
        })),
      },
      { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 2, requests: [] },
    ];
    const { provider } = createProviderStub("codex", {
      status: async () => index >= snapshots.length ? "error" : "running",
      interactions: {
        listPendingInteractions: async () => snapshots[index++]!,
        resolveInteraction: async () => ({
          result: "applied", interactionId: "unused", sessionId: "unused", revision: 1,
        }),
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-revisions-",
      provider: async () => provider,
      now: () => now,
      interactionMonitorMode: "observe-only",
    }, async ({ service }) => {
      await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow:revision:Review",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      await service.reconcileAgentInteractions();
      await service.reconcileAgentInteractions();
      now += 2_000;
      await service.reconcileAgentInteractions();
      expect(service.getInteractionObservations()[0]).toMatchObject({
        eventualOutcome: "expired",
        providerState: "running",
      });
      await service.reconcileAgentInteractions();
      await service.reconcileAgentInteractions();
      expect(internals(service).interactionRevisionReconciliations).toBe(2);
      expect(service.getInteractionObservations()[0]).toMatchObject({
        count: 2,
        eventualOutcome: "withdrawn",
        providerState: "error",
      });
    });
  });

  test("bounds observations and isolates synchronous and asynchronous telemetry failures", async () => {
    let hookCalls = 0;
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async () => pendingInteractionSnapshot(10_000, ["question"]),
        resolveInteraction: async () => ({
          result: "applied", interactionId: "unused", sessionId: "unused", revision: 1,
        }),
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-observation-bounds-",
      provider: async () => provider,
      interactionMonitorMode: "observe-only",
      interactionMonitorMaxSessionsPerEnvironment: 600,
      onInteractionObservation: () => {
        hookCalls += 1;
        if (hookCalls % 2 === 0) return Promise.reject(new Error("async telemetry failure"));
        throw new Error("sync telemetry failure");
      },
    }, async ({ storage, service }) => {
      for (let index = 0; index < 520; index += 1) {
        const logicalSessionKey = `looped-review:workflow:phase-${index}:Review`;
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey,
          providerSessionId: `provider-${index}`,
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        });
      }
      await service.reconcileAgentInteractions();
      expect(internals(service).trackedInteractions.size).toBe(64);
      expect(service.getInteractionObservations()).toHaveLength(64);
      expect(hookCalls).toBe(520);
      const state = internals(service);
      for (const tracked of state.trackedInteractions.values()) {
        const observationKey = (tracked as { observationKey: string }).observationKey;
        expect(state.interactionObservations.has(observationKey)).toBe(true);
      }
      await service.reconcileAgentInteractions();
      expect(internals(service).trackedInteractions.size).toBe(64);
      expect(hookCalls).toBe(1_040);
    });
  });

  test("settles an empty authoritative snapshot even when provider status fails", async () => {
    let pending = true;
    const { provider } = createProviderStub("codex", {
      status: async () => {
        throw new Error("status unavailable");
      },
      interactions: {
        listPendingInteractions: async () => pending
          ? pendingInteractionSnapshot(10_000, ["question"])
          : { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 2, requests: [] },
        resolveInteraction: async () => {
          throw new Error("observe-only must never resolve");
        },
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-status-failure-",
      provider: async () => provider,
      interactionMonitorMode: "observe-only",
    }, async ({ storage, service }) => {
      const logicalSessionKey = "looped-review:workflow:status:Review";
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey,
        providerSessionId: "provider-session",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      await service.reconcileAgentInteractions();
      pending = false;
      await captureWarnings(() => service.reconcileAgentInteractions());
      expect(service.getInteractionObservations()[0]).toMatchObject({
        providerState: "error",
        eventualOutcome: "expired",
      });
      expect(internals(service).trackedInteractions.size).toBe(0);
    });
  });

  test("keeps a shared aggregate blocked until its final request disappears", async () => {
    const pending = new Set(["provider-a", "provider-b"]);
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async (sessionId) => pending.has(sessionId)
          ? pendingInteractionSnapshot(10_000, ["question"])
          : { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 2, requests: [] },
        resolveInteraction: async () => {
          throw new Error("observe-only must never resolve");
        },
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-shared-aggregate-",
      provider: async () => provider,
      now: () => 10_000,
      interactionMonitorMode: "observe-only",
    }, async ({ storage, service }) => {
      for (const suffix of ["a", "b"] as const) {
        const logicalSessionKey = "looped-review:workflow:shared:Review" + suffix;
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey,
          providerSessionId: `provider-${suffix}`,
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        });
      }
      await service.reconcileAgentInteractions();
      expect(service.getInteractionObservations()[0]).toMatchObject({
        count: 2,
        providerState: "blocked",
      });
      const direct = {
        environmentId: "env-1",
        provider: "codex" as const,
        sessionId: "provider-direct",
        interactionId: "direct-question",
        kind: "question" as const,
        registration: {
          origin: "looped-review" as const,
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "shared",
        },
      };
      service.recordProviderInteractionObservation({ ...direct, state: "detected" });
      pending.delete("provider-a");
      await service.reconcileAgentInteractions();
      expect(service.getInteractionObservations()[0]).toMatchObject({
        providerState: "blocked",
      });
      expect(service.getInteractionObservations()[0]!.eventualOutcome).toBeUndefined();
      pending.delete("provider-b");
      await service.reconcileAgentInteractions();
      expect(service.getInteractionObservations()[0]).toMatchObject({
        providerState: "blocked",
      });
      expect(service.getInteractionObservations()[0]!.eventualOutcome).toBeUndefined();
      service.recordProviderInteractionObservation({
        ...direct,
        state: "withdrawn",
        providerState: "running",
      });
      expect(service.getInteractionObservations()[0]).toMatchObject({
        providerState: "running",
        eventualOutcome: "withdrawn",
      });
    });
  });

  test("records and settles provider-reported interactions without request content", async () => {
    await withService({
      prefix: "orkestrator-native-provider-reported-interaction-",
      interactionMonitorMode: "observe-only",
    }, async ({ service }) => {
      const base = {
        environmentId: "env-1",
        provider: "opencode" as const,
        sessionId: "provider-session",
        interactionId: "question-1",
        kind: "question" as const,
        registration: {
          origin: "build-pipeline" as const,
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "build",
        },
      };
      service.recordProviderInteractionObservation({ ...base, state: "detected" });
      service.recordProviderInteractionObservation({ ...base, state: "detected" });
      expect(service.getInteractionObservations()).toEqual([
        expect.objectContaining({
          provider: "opencode",
          kind: "question",
          workflowSurface: "build-pipeline",
          phase: "pipeline",
          count: 1,
          providerState: "blocked",
        }),
      ]);
      service.recordProviderInteractionObservation({
        ...base,
        state: "withdrawn",
        providerState: "error",
      });
      expect(service.getInteractionObservations()[0]).toMatchObject({
        providerState: "error",
        eventualOutcome: "withdrawn",
      });
      expect(internals(service).providerReportedInteractions.size).toBe(0);
    });
  });

  test("bounds direct reports together with polling tracks and normalizes edge cases", async () => {
    await withService({
      prefix: "orkestrator-native-provider-reported-bounds-",
      interactionMonitorMode: "observe-only",
    }, async ({ service }) => {
      const base = {
        environmentId: "env-1",
        provider: "opencode" as const,
        sessionId: "provider-session",
        kind: "permission" as const,
        registration: {
          origin: "looped-review" as const,
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "x".repeat(300),
        },
      };
      service.recordProviderInteractionObservation({
        ...base,
        interactionId: "unknown",
        state: "withdrawn",
      });
      const question = {
        ...base,
        kind: "question" as const,
        interactionId: "question-default",
        registration: {
          origin: "interactive-native" as const,
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        },
      };
      service.recordProviderInteractionObservation({ ...question, state: "detected" });
      service.recordProviderInteractionObservation({ ...question, state: "withdrawn" });
      expect(service.getInteractionObservations().find(({ kind }) => kind === "question"))
        .toMatchObject({ phase: "native-session", providerState: "running" });
      for (let index = 0; index < 512; index += 1) {
        service.recordProviderInteractionObservation({
          ...base,
          interactionId: `permission-${index}`,
          state: "detected",
        });
      }
      expect(internals(service).providerReportedInteractions.size).toBe(512);
      expect(service.getInteractionObservations().find(({ kind }) =>
        kind === "permission"
      )!.phase).toHaveLength(256);
      const internal = service as unknown as {
        recordInteractionDetection(
          session: Record<string, unknown>,
          interactionId: string,
          kind: "question",
          expiresAt: undefined,
          scan: number,
        ): void;
      };
      internal.recordInteractionDetection({
        key: "session-key",
        agent: "opencode",
        origin: "looped-review",
        logicalSessionKey: "looped-review:workflow:phase:Review",
      }, "polled-question", "question", undefined, 1);
      expect(internals(service).trackedInteractions.size).toBe(0);
      service.recordProviderInteractionObservation({
        ...base,
        interactionId: "permission-0",
        state: "withdrawn",
      });
      expect(service.getInteractionObservations().find(({ kind }) =>
        kind === "permission"
      )).toMatchObject({ providerState: "blocked" });
    });
  });

  test("recreates evicted direct reports and ignores disabled or stopped services", async () => {
    await withService({
      prefix: "orkestrator-native-provider-reported-recreate-",
      interactionMonitorMode: "observe-only",
    }, async ({ service }) => {
      const detect = (index: number) => service.recordProviderInteractionObservation({
        environmentId: "env-1",
        provider: "opencode",
        sessionId: `provider-${index}`,
        interactionId: `question-${index}`,
        kind: "question",
        registration: {
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: `phase-${index}`,
        },
        state: "detected",
      });
      for (let index = 0; index < 65; index += 1) detect(index);
      expect(service.getInteractionObservations().some(({ phase }) => phase === "phase-0"))
        .toBe(false);
      detect(0);
      expect(service.getInteractionObservations()).toContainEqual(
        expect.objectContaining({ phase: "phase-0", count: 1 }),
      );
      await service.shutdown();
      detect(100);
      expect(service.getInteractionObservations().some(({ phase }) => phase === "phase-100"))
        .toBe(false);
    });

    await withService({
      prefix: "orkestrator-native-provider-reported-disabled-",
    }, async ({ service }) => {
      service.recordProviderInteractionObservation({
        environmentId: "env-1",
        provider: "opencode",
        sessionId: "provider",
        interactionId: "question",
        kind: "question",
        registration: {
          origin: "build-pipeline",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        },
        state: "detected",
      });
      expect(service.getInteractionObservations()).toEqual([]);
    });
  });

  test("retains a direct observation until a terminal pipeline rejection is reported", async () => {
    let now = 10_000;
    await withService({
      prefix: "orkestrator-native-provider-reported-terminal-race-",
      interactionMonitorMode: "observe-only",
      now: () => now,
    }, async ({ storage, service }) => {
      const pipeline = activePipeline("pipeline-direct-race", "provider-session", "opencode");
      await storage.saveBuildPipeline(
        pipeline.id,
        pipeline.projectId,
        pipeline.environmentId,
        1,
        pipeline,
      );
      const event = {
        environmentId: "env-1",
        provider: "opencode" as const,
        sessionId: "provider-session",
        interactionId: "question-1",
        kind: "question" as const,
        registration: {
          origin: "build-pipeline" as const,
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "build",
        },
      };
      service.recordProviderInteractionObservation({ ...event, state: "detected" });

      const record = await storage.getBuildPipeline(pipeline.id);
      pipeline.phase = "failed";
      pipeline.sessions[0]!.status = "error";
      await storage.saveBuildPipeline(
        pipeline.id,
        pipeline.projectId,
        pipeline.environmentId,
        1,
        pipeline,
        record!.revision,
      );
      await service.reconcileAgentInteractions();
      expect(internals(service).providerReportedInteractions.size).toBe(1);
      expect(service.getInteractionObservations()[0]).toMatchObject({
        providerState: "blocked",
      });

      now += 30_000;
      await service.reconcileAgentInteractions();
      expect(internals(service).providerReportedInteractions.size).toBe(1);
      service.recordProviderInteractionObservation({
        ...event,
        state: "withdrawn",
        providerState: "error",
      });
      expect(service.getInteractionObservations()[0]).toMatchObject({
        providerState: "error",
        eventualOutcome: "withdrawn",
      });
    });
  });

  test("expires a stranded provider report while its session remains live", async () => {
    let now = 10_000;
    const { provider } = createProviderStub("opencode");
    await withService({
      prefix: "orkestrator-native-provider-reported-live-expiry-",
      interactionMonitorMode: "observe-only",
      now: () => now,
      provider: async () => provider,
    }, async ({ storage, service }) => {
      const logicalSessionKey = "looped-review:workflow:live:Review";
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "opencode", logicalSessionKey),
        environmentId: "env-1",
        agent: "opencode",
        logicalSessionKey,
        providerSessionId: "provider-session",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      service.recordProviderInteractionObservation({
        environmentId: "env-1",
        provider: "opencode",
        sessionId: "provider-session",
        interactionId: "permission-1",
        kind: "permission",
        registration: {
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        },
        state: "detected",
      });
      now += 60_000;
      await service.reconcileAgentInteractions();
      expect(internals(service).providerReportedInteractions.size).toBe(0);
      expect(service.getInteractionObservations()[0]).toMatchObject({
        providerState: "missing",
        eventualOutcome: "withdrawn",
      });
    });
  });

  test("rotates fairly beyond the global live-session adoption cap", async () => {
    const visited = new Set<string>();
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async (sessionId) => {
          visited.add(sessionId);
          return { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 1, requests: [] };
        },
        resolveInteraction: async () => {
          throw new Error("observe-only must never resolve");
        },
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-global-cap-",
      provider: async () => provider,
      interactionMonitorMode: "observe-only",
      interactionMonitorMaxSessionsPerEnvironment: 2_000,
    }, async ({ storage, service }) => {
      for (let index = 0; index < 1_025; index += 1) {
        const logicalSessionKey = `looped-review:workflow:global-${index}:Review`;
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey,
          providerSessionId: `provider-${index}`,
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        });
      }
      await service.reconcileAgentInteractions();
      expect(visited.has("provider-1024")).toBe(false);
      await service.reconcileAgentInteractions();
      expect(visited.has("provider-1024")).toBe(true);
      expect(internals(service).monitoredInteractionSessionKeys.size).toBe(1_024);
      expect(internals(service).observedInteractionRevisions.size).toBe(1_024);
      expect(internals(service).interactionRetryAt.size).toBe(0);
      expect(internals(service).interactionAttempts.size).toBe(0);
    });
  });

  test("treats providers without interaction capability as a successful no-op", async () => {
    const { provider } = createProviderStub("codex");
    await withService({
      prefix: "orkestrator-native-interaction-unsupported-provider-",
      provider: async () => provider,
      interactionMonitorMode: "observe-only",
    }, async ({ service }) => {
      await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow:unsupported:Review",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      const warnings = await captureWarnings(() => service.reconcileAgentInteractions());
      expect(warnings).toEqual([]);
      expect(internals(service).interactionAttempts.size).toBe(0);
      expect(internals(service).interactionRetryAt.size).toBe(0);
    });
  });

  test("settles stale evidence when a replacement provider loses interaction capability", async () => {
    const capable = createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async () => pendingInteractionSnapshot(10_000, ["question"]),
        resolveInteraction: async () => {
          throw new Error("observe-only must never resolve");
        },
      },
    });
    const unsupported = createProviderStub("codex");
    let current = capable.provider;
    await withService({
      prefix: "orkestrator-native-interaction-capability-loss-",
      provider: async () => current,
      interactionMonitorMode: "observe-only",
    }, async ({ storage, service }) => {
      const logicalSessionKey = "looped-review:workflow:capability:Review";
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey,
        providerSessionId: "provider-session",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      await service.reconcileAgentInteractions();
      current = unsupported.provider;
      internals(service).providers.clear();
      await service.reconcileAgentInteractions();
      expect(service.getInteractionObservations()[0]).toMatchObject({
        providerState: "error",
        eventualOutcome: "expired",
      });
      expect(internals(service).trackedInteractions.size).toBe(0);
    });
  });

  test("starts and stops the observe-only timer with the service lifecycle", async () => {
    const listPendingInteractions = mock(async () => ({
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      revision: 1,
      requests: [],
    }));
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions,
        resolveInteraction: async () => ({
          result: "applied", interactionId: "unused", sessionId: "unused", revision: 1,
        }),
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-timer-",
      provider: async () => provider,
      interactionMonitorMode: "observe-only",
      interactionMonitorIntervalMs: 100,
    }, async ({ service }) => {
      await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow:timer:Review",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      await service.init();
      const timer = internals(service).interactionTimer;
      await service.init();
      expect(internals(service).interactionTimer).toBe(timer);
      const afterInit = listPendingInteractions.mock.calls.length;
      expect(afterInit).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 130));
      expect(listPendingInteractions.mock.calls.length).toBeGreaterThan(afterInit);
      await service.shutdown();
      const afterShutdown = listPendingInteractions.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 130));
      expect(listPendingInteractions).toHaveBeenCalledTimes(afterShutdown);
    });
  });

  test("coalesces interaction scans and retries initialization after failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async () => {
          await gate;
          return { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 1, requests: [] };
        },
        resolveInteraction: async () => {
          throw new Error("must not resolve");
        },
      },
    });
    await withService({
      prefix: "orkestrator-native-interaction-coalesce-",
      provider: async () => provider,
      interactionMonitorMode: "observe-only",
    }, async ({ service }) => {
      await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow:coalesced:Review",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      const first = service.reconcileAgentInteractions();
      expect(service.reconcileAgentInteractions()).toBe(first);
      release();
      await first;
    });

    await withService({
      prefix: "orkestrator-native-init-retry-",
    }, async ({ service }) => {
      const internal = service as unknown as {
        initialize(): Promise<void>;
        initialization: Promise<void> | null;
      };
      let attempts = 0;
      internal.initialize = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("initialization failed");
      };
      await expect(service.init()).rejects.toThrow("initialization failed");
      expect(internal.initialization).toBeNull();
      await expect(service.init()).resolves.toBeUndefined();
      await service.shutdown();
      await expect(service.init()).rejects.toThrow("shut down");
    });
  });

  test("runs launch and queue work from the background timer", async () => {
    await withService({
      prefix: "orkestrator-native-launch-timer-body-",
    }, async ({ service }) => {
      const internal = service as unknown as {
        reconcilePendingLaunches(): Promise<void>;
        drainPromptQueues(): Promise<void>;
      };
      const launches = mock(async () => undefined);
      const drains = mock(async () => undefined);
      internal.reconcilePendingLaunches = launches;
      internal.drainPromptQueues = drains;
      await service.init();
      await Bun.sleep(2_100);
      expect(launches.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(drains.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  test("does not arm an interaction timer while observation is disabled", async () => {
    await withService({
      prefix: "orkestrator-native-interaction-disabled-timer-",
    }, async ({ service }) => {
      await service.init();
      expect(internals(service).launchTimer).not.toBeNull();
      expect(internals(service).interactionTimer).toBeNull();
    });
  });

  test("rehydrates environment activity from backend-owned native sessions without a renderer", async () => {
    const sessionActivity = new Map<string, ProviderActivityState>([
      ["provider-1", "idle"],
      ["provider-2", "working"],
    ]);
    const { provider } = createProviderStub("codex", {
      activity: async (sessionId) => sessionActivity.get(sessionId) ?? "missing",
    });
    await withService({
      prefix: "orkestrator-native-activity-",
      provider: async () => provider,
    }, async ({ storage, service }) => {
      const firstKey = nativeAgentSessionStorageKey(
        "env-1",
        "codex",
        "env-env-1:tab-1",
      );
      const secondKey = nativeAgentSessionStorageKey(
        "env-1",
        "codex",
        "env-env-1:tab-2",
      );
      const staleKey = nativeAgentSessionStorageKey(
        "env-1",
        "codex",
        "env-env-1:deleted-tab",
      );
      await storage.adoptNativeAgentSession({
        key: firstKey,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "env-env-1:tab-1",
        providerSessionId: "provider-1",
      });
      await storage.adoptNativeAgentSession({
        key: secondKey,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "env-env-1:tab-2",
        providerSessionId: "provider-2",
      });
      await storage.adoptNativeAgentSession({
        key: staleKey,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "env-env-1:deleted-tab",
        providerSessionId: "provider-missing",
      });

      await service.reconcileAgentActivity();
      expect(await storage.getNativeAgentSession(staleKey)).toBeNull();
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivityState: "working",
        agentActivitySources: {
          "native-agent": { state: "working" },
        },
      });

      sessionActivity.set("provider-1", "idle");
      sessionActivity.set("provider-2", "waiting");
      await service.reconcileAgentActivity();
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivityState: "waiting",
        agentActivitySources: {
          "native-agent": { state: "waiting" },
        },
      });

      sessionActivity.set("provider-2", "idle");
      await service.reconcileAgentActivity();
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivityState: "idle",
        agentActivitySources: {
          "native-agent": { state: "idle" },
        },
      });
    });
  });

  test("reports one session completion while another same-provider tab stays working", async () => {
    const sessionActivity = new Map<string, ProviderActivityState>([
      ["provider-resolve", "working"],
      ["provider-other", "working"],
    ]);
    const { provider } = createProviderStub("codex", {
      activity: async (sessionId) => sessionActivity.get(sessionId) ?? "missing",
    });
    const invoked: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: Invoke = async <T>(command: string, args?: Record<string, unknown>) => {
      invoked.push({ command, args });
      expect(command).toBe("pr_monitor_agent_turn_completed");
      expect(args).toEqual({ environmentId: "env-1" });
      return undefined as T;
    };

    await withService({
      prefix: "orkestrator-native-pr-refresh-completion-",
      environment: {
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
        hasMergeConflicts: true,
        prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
      },
      provider: async () => provider,
      invoke,
    }, async ({ storage, service }) => {
      for (const [logicalSessionKey, providerSessionId] of [
        ["env-env-1:resolve", "provider-resolve"],
        ["env-env-1:other", "provider-other"],
      ] as const) {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey,
          providerSessionId,
        });
      }

      await service.reconcileAgentActivity();
      expect(invoked).toEqual([]);

      sessionActivity.set("provider-resolve", "idle");
      await service.reconcileAgentActivity();

      expect(invoked).toHaveLength(1);
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivityState: "working",
      });
    });
  });

  test("does not report a parked waiting turn as completed when it becomes idle", async () => {
    let activityState: ProviderActivityState = "waiting";
    const { provider } = createProviderStub("codex", {
      activity: async () => activityState,
    });
    const invoke = mock(async () => undefined) as unknown as Invoke;

    await withService({
      prefix: "orkestrator-native-pr-refresh-waiting-",
      environment: {
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
        hasMergeConflicts: true,
        prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
      },
      provider: async () => provider,
      invoke,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "resolve"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "resolve",
        providerSessionId: "provider-resolve",
      });

      await service.reconcileAgentActivity();
      expect(invoke).not.toHaveBeenCalled();

      activityState = "idle";
      await service.reconcileAgentActivity();
      await service.reconcileAgentActivity();

      expect(invoke).not.toHaveBeenCalled();
    });
  });

  test("reports a fast accepted dispatch whose first activity snapshot is idle", async () => {
    const { provider, send } = createProviderStub("codex", {
      activity: async () => "idle",
    });
    const invoke = mock(async () => undefined) as unknown as Invoke;

    await withService({
      prefix: "orkestrator-native-pr-refresh-fast-dispatch-",
      environment: {
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
        hasMergeConflicts: true,
        prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
      },
      provider: async () => provider,
      invoke,
    }, async ({ service }) => {
      await service.dispatchPrompt({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "resolve",
        prompt: "Resolve conflicts",
        requestId: "resolve-1",
      });
      expect(send).toHaveBeenCalledTimes(1);

      await service.reconcileAgentActivity();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith(
        "pr_monitor_agent_turn_completed",
        { environmentId: "env-1" },
      );
    });
  });

  test("recovers an armed restart when the first provider snapshot is idle", async () => {
    const { provider } = createProviderStub("codex", {
      activity: async () => "idle",
    });
    const invoke = mock(async () => undefined) as unknown as Invoke;

    await withService({
      prefix: "orkestrator-native-pr-refresh-restart-",
      environment: {
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
        hasMergeConflicts: true,
        prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
      },
      provider: async () => provider,
      invoke,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "resolve"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "resolve",
        providerSessionId: "provider-resolve",
      });

      await service.reconcileAgentActivity();
      await service.reconcileAgentActivity();

      expect(invoke).toHaveBeenCalledTimes(1);
    });
  });

  test("coalesces simultaneous session completions into one environment notification", async () => {
    const activityBySession = new Map<string, ProviderActivityState>([
      ["provider-1", "working"],
      ["provider-2", "working"],
    ]);
    const { provider } = createProviderStub("codex", {
      activity: async (sessionId) => activityBySession.get(sessionId) ?? "missing",
    });
    const invoke = mock(async () => undefined) as unknown as Invoke;

    await withService({
      prefix: "orkestrator-native-pr-refresh-dedupe-",
      environment: {
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
        hasMergeConflicts: true,
        prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
      },
      provider: async () => provider,
      invoke,
    }, async ({ storage, service }) => {
      for (const suffix of ["1", "2"] as const) {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", `resolve-${suffix}`),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: `resolve-${suffix}`,
          providerSessionId: `provider-${suffix}`,
        });
      }
      await service.reconcileAgentActivity();

      activityBySession.set("provider-1", "idle");
      activityBySession.set("provider-2", "idle");
      await service.reconcileAgentActivity();

      expect(invoke).toHaveBeenCalledTimes(1);
    });
  });

  test("bounds concurrent completion notification delivery", async () => {
    const environmentIds = Array.from(
      { length: 12 },
      (_unused, index) => `env-${index + 1}`,
    );
    let activityState: ProviderActivityState = "working";
    const { provider } = createProviderStub("codex", {
      activity: async () => activityState,
    });
    const delivered: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const invoke: Invoke = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      expect(command).toBe("pr_monitor_agent_turn_completed");
      const environmentId = args?.environmentId;
      expect(typeof environmentId).toBe("string");
      delivered.push(environmentId as string);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (inFlight === 8) release();
      await gate;
      inFlight -= 1;
      return undefined as T;
    };

    await withService({
      prefix: "orkestrator-native-pr-refresh-concurrency-",
      environment: {
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
        hasMergeConflicts: true,
        prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
      },
      provider: async () => provider,
      invoke,
    }, async ({ storage, service }) => {
      for (const environmentId of environmentIds.slice(1)) {
        await addEnvironment(storage, {
          id: environmentId,
          worktreePath: `/tmp/${environmentId}`,
          prUrl: `https://github.com/acme/repo/pull/${environmentId}`,
          prState: "open",
          hasMergeConflicts: true,
          prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
        });
      }
      for (const environmentId of environmentIds) {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey(environmentId, "codex", "resolve"),
          environmentId,
          agent: "codex",
          logicalSessionKey: "resolve",
          providerSessionId: `${environmentId}-provider`,
        });
      }
      await service.reconcileAgentActivity();

      activityState = "idle";
      await service.reconcileAgentActivity();

      expect(peakInFlight).toBe(8);
      expect(delivered).toHaveLength(environmentIds.length);
      expect(new Set(delivered)).toEqual(new Set(environmentIds));
    });
  });

  test("stops starting queued completion notifications once shutdown begins", async () => {
    const environmentIds = Array.from({ length: 10 }, (_unused, index) => `env-${index + 1}`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let signalEightStarted!: () => void;
    const eightStarted = new Promise<void>((resolve) => { signalEightStarted = resolve; });
    const invoked: string[] = [];
    const invoke: Invoke = async <T>(
      _command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      invoked.push(args?.environmentId as string);
      if (invoked.length === 8) signalEightStarted();
      await gate;
      return undefined as T;
    };

    await withService({
      prefix: "orkestrator-native-pr-refresh-shutdown-flush-",
      environment: {
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open",
        hasMergeConflicts: true,
        prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
      },
      invoke,
    }, async ({ storage, service }) => {
      for (const environmentId of environmentIds.slice(1)) {
        await addEnvironment(storage, {
          id: environmentId,
          worktreePath: `/tmp/${environmentId}`,
          prUrl: `https://github.com/acme/repo/pull/${environmentId}`,
          prState: "open",
          hasMergeConflicts: true,
          prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
        });
      }
      for (const environmentId of environmentIds) {
        internals(service).pendingPrRefreshEnvironmentIds.add(environmentId);
      }

      const scan = service.reconcileAgentActivity();
      await eightStarted;
      const shuttingDown = service.shutdown();
      release();
      await Promise.all([scan, shuttingDown]);

      expect(invoked).toHaveLength(8);
      expect(new Set(invoked).size).toBe(8);
    });
  });

  test("retries a failed completion notification without repeating a success", async () => {
    let activityState: ProviderActivityState = "working";
    let invocationAttempt = 0;
    const { provider } = createProviderStub("codex", {
      activity: async () => activityState,
    });
    const invoke = mock(async () => {
      invocationAttempt += 1;
      if (invocationAttempt === 1) throw new Error("command registry unavailable");
    }) as unknown as Invoke;

    await withService({
      prefix: "orkestrator-native-pr-refresh-retry-",
      environment: {
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
        hasMergeConflicts: true,
        prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
      },
      provider: async () => provider,
      invoke,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "resolve"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "resolve",
        providerSessionId: "provider-resolve",
      });
      await service.reconcileAgentActivity();

      activityState = "idle";
      const warnings = await captureWarnings(async () => {
        await service.reconcileAgentActivity();
      });
      expect(warnings).toHaveLength(1);
      expect(internals(service).pendingPrRefreshEnvironmentIds)
        .toEqual(new Set(["env-1"]));

      // Delivery does not depend on keeping the completed tab/session alive.
      // A renderer may close it before the next background sweep retries.
      await storage.invalidateNativeAgentSession(
        nativeAgentSessionStorageKey("env-1", "codex", "resolve"),
        "provider-resolve",
      );
      await service.reconcileAgentActivity();
      await service.reconcileAgentActivity();

      expect(invoke).toHaveBeenCalledTimes(2);
      expect(internals(service).pendingPrRefreshEnvironmentIds.size).toBe(0);

      internals(service).pendingPrRefreshEnvironmentIds.add("env-1");
      await storage.removeEnvironment("env-1");
      await service.reconcileAgentActivity();
      expect(internals(service).pendingPrRefreshEnvironmentIds.size).toBe(0);
    });
  });

  test("prunes failed completion notifications when their durable arms disappear", async () => {
    let activityState: ProviderActivityState = "working";
    const { provider } = createProviderStub("codex", {
      activity: async () => activityState,
    });
    const invoke = mock(async () => {
      throw new Error("command registry unavailable");
    }) as unknown as Invoke;

    await withService({
      prefix: "orkestrator-native-pr-refresh-prune-",
      environment: {
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
        hasMergeConflicts: true,
        prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
      },
      provider: async () => provider,
      invoke,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "resolve"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "resolve",
        providerSessionId: "provider-resolve",
      });
      await service.reconcileAgentActivity();
      activityState = "idle";
      await captureWarnings(() => service.reconcileAgentActivity());
      await captureWarnings(() => service.reconcileAgentActivity());

      expect(invoke).toHaveBeenCalledTimes(2);
      expect(internals(service).pendingPrRefreshEnvironmentIds).toEqual(new Set(["env-1"]));

      await storage.updateEnvironment("env-1", {
        prRecheckAfterAgentCompletionArmedAt: undefined,
      });
      await service.reconcileAgentActivity();

      expect(invoke).toHaveBeenCalledTimes(2);
      expect(internals(service).pendingPrRefreshEnvironmentIds.size).toBe(0);
    });
  });

  test("does not report idle snapshots without an armed completion intent", async () => {
    let activityState: ProviderActivityState = "idle";
    const { provider } = createProviderStub("codex", {
      activity: async () => activityState,
    });
    const invoke = mock(async () => undefined) as unknown as Invoke;

    await withService({
      prefix: "orkestrator-native-pr-refresh-unarmed-",
      provider: async () => provider,
      invoke,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "tab-1"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });

      await service.reconcileAgentActivity();
      activityState = "working";
      await service.reconcileAgentActivity();
      activityState = "waiting";
      await service.reconcileAgentActivity();
      activityState = "idle";
      await service.reconcileAgentActivity();

      expect(invoke).not.toHaveBeenCalled();
    });
  });

  test("prunes observation state for removed and replaced provider sessions", async () => {
    let activityState: ProviderActivityState = "working";
    const { provider } = createProviderStub("codex", {
      activity: async () => activityState,
    });

    const invoke = mock(async () => undefined) as unknown as Invoke;
    await withService({
      prefix: "orkestrator-native-activity-observation-prune-",
      environment: {
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
        hasMergeConflicts: true,
        prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
      },
      provider: async () => provider,
      invoke,
    }, async ({ storage, service }) => {
      const key = nativeAgentSessionStorageKey("env-1", "codex", "tab-1");
      await storage.adoptNativeAgentSession({
        key,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-old",
      });
      await service.reconcileAgentActivity();
      expect(internals(service).observedSessionActivity.get(key)).toEqual({
        providerSessionId: "provider-old",
        state: "working",
      });

      await storage.adoptNativeAgentSession({
        key,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-new",
        expectedProviderSessionId: "provider-old",
      });
      activityState = "idle";
      await service.reconcileAgentActivity();
      expect(internals(service).observedSessionActivity.get(key)).toEqual({
        providerSessionId: "provider-new",
        state: "idle",
      });
      expect(invoke).not.toHaveBeenCalled();

      await storage.invalidateNativeAgentSession(key, "provider-new");
      await service.reconcileAgentActivity();
      expect(internals(service).observedSessionActivity.has(key)).toBe(false);
    });
  });

  test.each([
    ["stopped", { status: "stopped" }],
    ["errored", { status: "error" }],
    ["still provisioning", { setupScriptsComplete: false }],
  ])("does not start a provider for a %s local environment", async (
    _label,
    environmentUpdate,
  ) => {
    const providerFactory = mock(async () => createProviderStub("codex").provider);
    await withService({
      prefix: "orkestrator-native-activity-not-ready-",
      environment: environmentUpdate,
      provider: providerFactory,
    }, async ({ storage, service }) => {
      const key = nativeAgentSessionStorageKey("env-1", "codex", "tab-1");
      await storage.adoptNativeAgentSession({
        key,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });
      await storage.setEnvironmentAgentActivity(
        "env-1",
        "working",
        new Date().toISOString(),
        "native-agent",
      );

      await service.reconcileAgentActivity();

      expect(providerFactory).not.toHaveBeenCalled();
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: "idle" } },
      });
    });
  });

  test("registers sessions and uses one batched activity snapshot per provider", async () => {
    const snapshot = new Map<string, ProviderActivityState>([
      ["provider-1", "idle"],
      ["provider-2", "waiting"],
    ]);
    const { provider, activityBatch, registerSession, activity, status } =
      createProviderStub("opencode", {
        activity: async () => {
          throw new Error("per-session activity must not be used");
        },
        activityBatch: async () => snapshot,
      });
    await withService({
      prefix: "orkestrator-native-activity-batch-",
      provider: async () => provider,
    }, async ({ storage, service }) => {
      for (const [suffix, providerSessionId] of [
        ["one", "provider-1"],
        ["two", "provider-2"],
      ] as const) {
        const key = nativeAgentSessionStorageKey("env-1", "opencode", suffix);
        await storage.adoptNativeAgentSession({
          key,
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: suffix,
          providerSessionId,
        });
      }

      await service.reconcileAgentActivity();

      expect(activityBatch).toHaveBeenCalledTimes(1);
      expect(activityBatch).toHaveBeenCalledWith(["provider-1", "provider-2"]);
      expect(registerSession).toHaveBeenCalledTimes(2);
      expect(activity).not.toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: "waiting" } },
      });
    });
  });

  test("preserves an existing idle OpenCode native-session mapping", async () => {
    const provider = createOpenCodeLifecycleProvider(["provider-idle"]);
    await withService({
      prefix: "orkestrator-native-opencode-idle-existing-",
      provider: async () => provider,
    }, async ({ storage, service }) => {
      const key = nativeAgentSessionStorageKey(
        "env-1",
        "opencode",
        "tab-idle",
      );
      await storage.adoptNativeAgentSession({
        key,
        environmentId: "env-1",
        agent: "opencode",
        logicalSessionKey: "tab-idle",
        providerSessionId: "provider-idle",
      });

      await service.reconcileAgentActivity();

      expect(await storage.getNativeAgentSession(key)).toMatchObject({
        providerSessionId: "provider-idle",
      });
    });
  });

  test("invalidates a genuinely missing OpenCode native-session mapping", async () => {
    const provider = createOpenCodeLifecycleProvider([]);
    await withService({
      prefix: "orkestrator-native-opencode-missing-",
      provider: async () => provider,
    }, async ({ storage, service }) => {
      const key = nativeAgentSessionStorageKey(
        "env-1",
        "opencode",
        "tab-deleted",
      );
      await storage.adoptNativeAgentSession({
        key,
        environmentId: "env-1",
        agent: "opencode",
        logicalSessionKey: "tab-deleted",
        providerSessionId: "provider-deleted",
      });

      await service.reconcileAgentActivity();

      expect(await storage.getNativeAgentSession(key)).toBeNull();
    });
  });

  test("invalidates a missing session through the status fallback", async () => {
    const { provider, status } = createProviderStub("codex", {
      status: async () => "missing",
    });
    await withService({
      prefix: "orkestrator-native-activity-status-fallback-",
      provider: async () => provider,
    }, async ({ storage, service }) => {
      const key = nativeAgentSessionStorageKey("env-1", "codex", "tab-1");
      await storage.adoptNativeAgentSession({
        key,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-missing",
      });

      await service.reconcileAgentActivity();

      expect(status).toHaveBeenCalledWith("provider-missing");
      expect(await storage.getNativeAgentSession(key)).toBeNull();
    });
  });

  test("recreates a cached provider after an activity read failure", async () => {
    const stale = createProviderStub("codex", {
      activity: async () => {
        throw new ProviderUnavailableError("bridge stopped");
      },
    });
    const recovered = createProviderStub("codex", {
      activity: async () => "working",
    });
    const providerFactory = mock(async () => (
      providerFactory.mock.calls.length === 1 ? stale.provider : recovered.provider
    ));
    let clock = 1_000;
    await withService({
      prefix: "orkestrator-native-activity-recover-",
      provider: providerFactory,
      now: () => clock,
    }, async ({ storage, service }) => {
      const key = nativeAgentSessionStorageKey("env-1", "codex", "tab-1");
      await storage.adoptNativeAgentSession({
        key,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });
      const originalWarn = console.warn;
      console.warn = () => undefined;
      try {
        await service.reconcileAgentActivity();
        // Evicted, but deliberately not disposed: this provider may still be
        // carrying a prompt the user is waiting on, and disposing it aborts
        // every request it has in flight.
        expect(stale.dispose).not.toHaveBeenCalled();
        expect(internals(service).providers.size).toBe(0);

        clock += 2_000;
        await service.reconcileAgentActivity();
      } finally {
        console.warn = originalWarn;
      }

      expect(providerFactory).toHaveBeenCalledTimes(2);
      expect(recovered.activity).toHaveBeenCalledWith("provider-1");
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: "working" } },
      });
    });
  });

  test("coalesces overlapping scans and shutdown waits for the active read", async () => {
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const { provider, activity } = createProviderStub("codex", {
      activity: async () => {
        signalEntered();
        await barrier;
        return "working";
      },
    });
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-activity-shutdown-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    const key = nativeAgentSessionStorageKey("env-1", "codex", "tab-1");
    await storage.adoptNativeAgentSession({
      key,
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "tab-1",
      providerSessionId: "provider-1",
    });
    const service = new NativeAgentService(storage, refusingInvoke, {
      provider: async () => provider,
    });
    try {
      const first = service.reconcileAgentActivity();
      const second = service.reconcileAgentActivity();
      expect(second).toBe(first);
      await entered;
      let shutdownSettled = false;
      const shuttingDown = service.shutdown().then(() => { shutdownSettled = true; });
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);
      release();
      await Promise.all([first, shuttingDown]);
      expect(activity).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("isolates a failed agent group and leaves its previous projection intact", async () => {
    const codex = createProviderStub("codex", { activity: async () => "working" });
    const claude = createProviderStub("claude", {
      activity: async () => { throw new ProviderUnavailableError("offline"); },
    });
    await withService({
      prefix: "orkestrator-native-activity-partial-",
      provider: async (input) => input.agent === "codex" ? codex.provider : claude.provider,
    }, async ({ storage, service }) => {
      for (const agent of ["codex", "claude"] as const) {
        const key = nativeAgentSessionStorageKey("env-1", agent, `${agent}-tab`);
        await storage.adoptNativeAgentSession({
          key,
          environmentId: "env-1",
          agent,
          logicalSessionKey: `${agent}-tab`,
          providerSessionId: `${agent}-provider`,
        });
      }
      await storage.setEnvironmentAgentActivity(
        "env-1",
        "waiting",
        new Date().toISOString(),
        "native-agent",
      );
      const before = (await storage.getEnvironment("env-1"))!
        .agentActivitySources?.["native-agent"];
      const originalWarn = console.warn;
      console.warn = () => undefined;
      try {
        await service.reconcileAgentActivity();
      } finally {
        console.warn = originalWarn;
      }

      expect(codex.activity).toHaveBeenCalledTimes(1);
      expect(claude.activity).toHaveBeenCalledTimes(1);
      expect((await storage.getEnvironment("env-1"))!
        .agentActivitySources?.["native-agent"]).toEqual(before);
    });
  });

  test("isolates an activity persistence failure", async () => {
    const { provider } = createProviderStub("codex", {
      activity: async () => "working",
    });
    await withService({
      prefix: "orkestrator-native-activity-persist-error-",
      provider: async () => provider,
    }, async ({ storage, service }) => {
      const key = nativeAgentSessionStorageKey("env-1", "codex", "tab-1");
      await storage.adoptNativeAgentSession({
        key,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });
      const originalSet = storage.setEnvironmentAgentActivity.bind(storage);
      const setActivity = mock(async () => {
        throw new Error("disk unavailable");
      });
      storage.setEnvironmentAgentActivity = setActivity as typeof storage.setEnvironmentAgentActivity;
      const originalWarn = console.warn;
      console.warn = () => undefined;
      try {
        await expect(service.reconcileAgentActivity()).resolves.toBeUndefined();
      } finally {
        console.warn = originalWarn;
        storage.setEnvironmentAgentActivity = originalSet;
      }
      expect(setActivity).toHaveBeenCalledTimes(1);
    });
  });

  test("skips deleted-environment sessions and avoids rewriting an unchanged state", async () => {
    const { provider, activity } = createProviderStub("codex", {
      activity: async () => "idle",
    });
    await withService({
      prefix: "orkestrator-native-activity-stable-",
      provider: async () => provider,
    }, async ({ storage, service }) => {
      const liveKey = nativeAgentSessionStorageKey("env-1", "codex", "live");
      await storage.adoptNativeAgentSession({
        key: liveKey,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "live",
        providerSessionId: "live-provider",
      });
      await storage.setEnvironmentAgentActivity(
        "env-1",
        "idle",
        new Date().toISOString(),
        "native-agent",
      );
      const before = (await storage.getEnvironment("env-1"))!
        .agentActivitySources?.["native-agent"];

      await addEnvironment(storage, { id: "env-deleted", worktreePath: "/tmp/deleted" });
      const deletedKey = nativeAgentSessionStorageKey("env-deleted", "codex", "deleted");
      await storage.adoptNativeAgentSession({
        key: deletedKey,
        environmentId: "env-deleted",
        agent: "codex",
        logicalSessionKey: "deleted",
        providerSessionId: "deleted-provider",
      });
      await storage.removeEnvironment("env-deleted");

      await service.reconcileAgentActivity();

      expect(activity).toHaveBeenCalledTimes(1);
      expect(activity).toHaveBeenCalledWith("live-provider");
      expect((await storage.getEnvironment("env-1"))!
        .agentActivitySources?.["native-agent"]).toEqual(before);
    });
  });

  test("keeps a concurrently replaced session when an old snapshot reports missing", async () => {
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const { provider } = createProviderStub("codex", {
      activity: async () => {
        signalEntered();
        await barrier;
        return "missing";
      },
    });
    await withService({
      prefix: "orkestrator-native-activity-session-race-",
      provider: async () => provider,
    }, async ({ storage, service }) => {
      const key = nativeAgentSessionStorageKey("env-1", "codex", "tab-1");
      await storage.adoptNativeAgentSession({
        key,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-old",
      });
      const scan = service.reconcileAgentActivity();
      await entered;
      await storage.adoptNativeAgentSession({
        key,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-new",
        expectedProviderSessionId: "provider-old",
      });
      release();
      await scan;

      expect(await storage.getNativeAgentSession(key)).toMatchObject({
        providerSessionId: "provider-new",
      });
    });
  });

  test.each([
    ["running", "working"],
    ["idle", "idle"],
    ["error", "idle"],
  ] as const)("maps a coarse %s status onto %s activity", async (
    providerStatus,
    expectedState,
  ) => {
    const { provider, status, activity, activityBatch } = createProviderStub(
      "codex",
      { status: async () => providerStatus },
    );
    await withService({
      prefix: "orkestrator-native-activity-status-map-",
      provider: async () => provider,
    }, async ({ storage, service }) => {
      const key = nativeAgentSessionStorageKey("env-1", "codex", "tab-1");
      await storage.adoptNativeAgentSession({
        key,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });

      await service.reconcileAgentActivity();

      expect(activity).toBeUndefined();
      expect(activityBatch).toBeUndefined();
      expect(status).toHaveBeenCalledWith("provider-1");
      // The mapping is coarse on purpose: only `running` can be an in-flight
      // turn, so every other status settles the environment rather than
      // leaving a stale spinner behind.
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: expectedState } },
      });
      expect(await storage.getNativeAgentSession(key)).not.toBeNull();
    });
  });

  test("treats a batch that omits a requested session as a failed read, not a missing session", async () => {
    const { provider, activityBatch } = createProviderStub("opencode", {
      activityBatch: async () => new Map<string, ProviderActivityState>([
        ["provider-1", "idle"],
      ]),
    });
    await withService({
      prefix: "orkestrator-native-activity-partial-batch-",
      provider: async () => provider,
    }, async ({ storage, service }) => {
      const keys: string[] = [];
      for (const [suffix, providerSessionId] of [
        ["one", "provider-1"],
        ["two", "provider-2"],
      ] as const) {
        const key = nativeAgentSessionStorageKey("env-1", "opencode", suffix);
        keys.push(key);
        await storage.adoptNativeAgentSession({
          key,
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: suffix,
          providerSessionId,
        });
      }
      await storage.setEnvironmentAgentActivity(
        "env-1",
        "waiting",
        new Date().toISOString(),
        "native-agent",
      );
      const before = (await storage.getEnvironment("env-1"))!
        .agentActivitySources?.["native-agent"];

      const warnings = await captureWarnings(async () => {
        await service.reconcileAgentActivity();
      });

      expect(activityBatch).toHaveBeenCalledTimes(1);
      expect(warnings).toHaveLength(1);
      // A gap in the snapshot is a broken provider, never evidence that the
      // user's session is gone: deleting the mapping here would orphan a live
      // transcript.
      expect(await storage.getNativeAgentSession(keys[1]!)).toMatchObject({
        providerSessionId: "provider-2",
      });
      expect((await storage.getEnvironment("env-1"))!
        .agentActivitySources?.["native-agent"]).toEqual(before);
    });
  });

  test("leaves a provider installed by concurrent work in the cache after a failed read", async () => {
    let serviceRef: NativeAgentService | undefined;
    const replacement = createProviderStub("codex", {
      activity: async () => "idle",
    });
    const failing = createProviderStub("codex", {
      activity: async () => {
        // Stand in for a tab that resolved a fresh provider while this
        // read-only sweep was in flight.
        internals(serviceRef!).providers.set("env-1\u0000codex", replacement.provider);
        throw new ProviderUnavailableError("bridge stopped");
      },
    });
    await withService({
      prefix: "orkestrator-native-activity-evict-identity-",
      provider: async () => failing.provider,
    }, async ({ storage, service }) => {
      serviceRef = service;
      const key = nativeAgentSessionStorageKey("env-1", "codex", "tab-1");
      await storage.adoptNativeAgentSession({
        key,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });

      await captureWarnings(async () => {
        await service.reconcileAgentActivity();
      });

      expect(internals(service).providers.get("env-1\u0000codex"))
        .toBe(replacement.provider);
      expect(replacement.dispose).not.toHaveBeenCalled();
      expect(failing.dispose).not.toHaveBeenCalled();
    });
  });

  test("reads every agent group exactly once and never exceeds the worker pool", async () => {
    const environmentIds = Array.from(
      { length: 20 },
      (_unused, index) => `env-${index + 1}`,
    );
    const reads: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const { provider } = createProviderStub("codex", {
      activity: async (sessionId) => {
        reads.push(sessionId);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        // Releasing only once the pool is saturated proves the sweep really
        // does run eight groups at a time; a serial sweep would deadlock here.
        if (inFlight >= 8) openGate();
        await gate;
        inFlight -= 1;
        return "working";
      },
    });
    await withService({
      prefix: "orkestrator-native-activity-pool-",
      provider: async () => provider,
    }, async ({ storage, service }) => {
      for (const environmentId of environmentIds.slice(1)) {
        await addEnvironment(storage, {
          id: environmentId,
          worktreePath: `/tmp/${environmentId}`,
        });
      }
      for (const environmentId of environmentIds) {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey(environmentId, "codex", "tab-1"),
          environmentId,
          agent: "codex",
          logicalSessionKey: "tab-1",
          providerSessionId: `${environmentId}-provider`,
        });
      }

      await service.reconcileAgentActivity();

      expect(peakInFlight).toBe(8);
      expect(reads).toHaveLength(environmentIds.length);
      expect(new Set(reads).size).toBe(environmentIds.length);
      expect([...reads].sort()).toEqual(
        environmentIds.map((id) => `${id}-provider`).sort(),
      );
      for (const environmentId of environmentIds) {
        expect(await storage.getEnvironment(environmentId)).toMatchObject({
          agentActivitySources: { "native-agent": { state: "working" } },
        });
      }
    });
  });

  test("commits a healthy environment while another environment's provider fails", async () => {
    const healthy = createProviderStub("codex", { activity: async () => "working" });
    const broken = createProviderStub("codex", {
      activity: async () => { throw new ProviderUnavailableError("offline"); },
    });
    await withService({
      prefix: "orkestrator-native-activity-env-isolation-",
      provider: async (input) =>
        input.environmentId === "env-1" ? healthy.provider : broken.provider,
    }, async ({ storage, service }) => {
      await addEnvironment(storage, { id: "env-2", worktreePath: "/tmp/env-2" });
      for (const environmentId of ["env-1", "env-2"] as const) {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey(environmentId, "codex", "tab-1"),
          environmentId,
          agent: "codex",
          logicalSessionKey: "tab-1",
          providerSessionId: `${environmentId}-provider`,
        });
      }
      await storage.setEnvironmentAgentActivity(
        "env-2",
        "waiting",
        new Date().toISOString(),
        "native-agent",
      );
      const before = (await storage.getEnvironment("env-2"))!
        .agentActivitySources?.["native-agent"];

      await captureWarnings(async () => {
        await service.reconcileAgentActivity();
      });

      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: "working" } },
      });
      expect((await storage.getEnvironment("env-2"))!
        .agentActivitySources?.["native-agent"]).toEqual(before);
    });
  });

  test("retries a failing group on a widening schedule and reads immediately once it recovers", async () => {
    let failing = true;
    const activityCalls: string[] = [];
    const providerFactory = mock(async () => createProviderStub("codex", {
      activity: async (sessionId) => {
        activityCalls.push(sessionId);
        if (failing) throw new ProviderUnavailableError("bridge stopped");
        return "working";
      },
    }).provider);
    let clock = 1_000;
    await withService({
      prefix: "orkestrator-native-activity-backoff-",
      provider: providerFactory,
      now: () => clock,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "tab-1"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });

      await captureWarnings(async () => {
        await service.reconcileAgentActivity();
        expect(providerFactory).toHaveBeenCalledTimes(1);

        // First failure: two seconds. A sweep one second later must not touch
        // the bridge at all.
        clock = 2_000;
        await service.reconcileAgentActivity();
        expect(providerFactory).toHaveBeenCalledTimes(1);
        expect(activityCalls).toHaveLength(1);

        clock = 3_000;
        await service.reconcileAgentActivity();
        expect(providerFactory).toHaveBeenCalledTimes(2);

        // Second failure: four seconds.
        clock = 7_000;
        await service.reconcileAgentActivity();
        expect(providerFactory).toHaveBeenCalledTimes(3);

        // Third failure: eight seconds, so +4s is still inside the window.
        clock = 11_000;
        await service.reconcileAgentActivity();
        expect(providerFactory).toHaveBeenCalledTimes(3);

        clock = 15_000;
        await service.reconcileAgentActivity();
        expect(providerFactory).toHaveBeenCalledTimes(4);
      });

      // Fourth failure: sixteen seconds. Let it expire and then succeed.
      failing = false;
      clock = 31_000;
      await service.reconcileAgentActivity();
      expect(providerFactory).toHaveBeenCalledTimes(5);
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: "working" } },
      });

      // A success clears the backoff, so the very next sweep reads again with
      // no advance of the clock.
      const readsBefore = activityCalls.length;
      await service.reconcileAgentActivity();
      expect(activityCalls).toHaveLength(readsBefore + 1);
    });
  });

  test("withholds an environment whose group is still inside its backoff window", async () => {
    const providerFactory = mock(async () => createProviderStub("codex", {
      activity: async () => { throw new ProviderUnavailableError("offline"); },
    }).provider);
    let clock = 1_000;
    await withService({
      prefix: "orkestrator-native-activity-backoff-hold-",
      provider: providerFactory,
      now: () => clock,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "tab-1"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });
      await storage.setEnvironmentAgentActivity(
        "env-1",
        "working",
        new Date().toISOString(),
        "native-agent",
      );

      await captureWarnings(async () => {
        await service.reconcileAgentActivity();
      });
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: "working" } },
      });

      clock = 1_500;
      await service.reconcileAgentActivity();

      // A skipped group is an unread group: publishing an aggregate built
      // without it would report the unread agent as idle.
      expect(providerFactory).toHaveBeenCalledTimes(1);
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: "working" } },
      });
    });
  });

  test("records idle without invalidating anything when no bridge is running", async () => {
    const commands: string[] = [];
    const invoke = (async <T,>(command: string): Promise<T> => {
      commands.push(command);
      if (
        command === "peek_local_agent_bridge"
        || command === "peek_container_agent_bridge"
      ) {
        return null as T;
      }
      throw new Error(`Unexpected backend command: ${command}`);
    }) as Invoke;
    await withService({
      prefix: "orkestrator-native-activity-no-bridge-",
      invoke,
    }, async ({ storage, service }) => {
      const key = nativeAgentSessionStorageKey("env-1", "codex", "tab-1");
      await storage.adoptNativeAgentSession({
        key,
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });

      const warnings = await captureWarnings(async () => {
        await service.reconcileAgentActivity();
      });

      expect(warnings).toEqual([]);
      expect(commands).toEqual(["peek_local_agent_bridge"]);
      // No bridge means no turn in flight — an answer, not a failure, so the
      // mapping survives and the indicator is retired.
      expect(await storage.getNativeAgentSession(key)).toMatchObject({
        providerSessionId: "provider-1",
      });
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: "idle" } },
      });
    });
  });

  test("observes a running bridge without ever issuing a start command", async () => {
    const commands: string[] = [];
    const invoke = (async <T,>(command: string): Promise<T> => {
      commands.push(command);
      if (command === "peek_local_agent_bridge") {
        // Coordinates for a bridge nothing is actually listening on: the read
        // fails, which must still never escalate into starting one.
        return { port: 1, authToken: "token" } as T;
      }
      throw new Error(`Unexpected backend command: ${command}`);
    }) as Invoke;
    await withService({
      prefix: "orkestrator-native-activity-never-starts-",
      invoke,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "tab-1"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });

      await captureWarnings(async () => {
        await service.reconcileAgentActivity();
      });

      expect(commands).toEqual(["peek_local_agent_bridge"]);
      expect(commands.some((command) => command.startsWith("start_")))
        .toBe(false);
    });
  });

  test("re-probes an absent bridge only once its recheck window expires", async () => {
    const commands: string[] = [];
    const invoke = (async <T,>(command: string): Promise<T> => {
      commands.push(command);
      if (command === "peek_local_agent_bridge") return null as T;
      throw new Error(`Unexpected backend command: ${command}`);
    }) as Invoke;
    let clock = 1_000;
    await withService({
      prefix: "orkestrator-native-activity-absent-cooldown-",
      invoke,
      now: () => clock,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "tab-1"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });

      await service.reconcileAgentActivity();
      expect(commands).toHaveLength(1);

      // Nothing can have started a bridge in the meantime, and re-probing a
      // container costs a `docker exec` per sweep to re-learn the same answer.
      clock = 2_000;
      await service.reconcileAgentActivity();
      expect(commands).toHaveLength(1);

      clock = 16_001;
      await service.reconcileAgentActivity();
      expect(commands).toEqual([
        "peek_local_agent_bridge",
        "peek_local_agent_bridge",
      ]);
    });
  });

  test("still commits idle on a sweep that skipped an absent bridge", async () => {
    const invoke = (async <T,>(command: string): Promise<T> => {
      if (command === "peek_local_agent_bridge") return null as T;
      throw new Error(`Unexpected backend command: ${command}`);
    }) as Invoke;
    let clock = 1_000;
    await withService({
      prefix: "orkestrator-native-activity-absent-commit-",
      invoke,
      now: () => clock,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "tab-1"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });

      await service.reconcileAgentActivity();
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: "idle" } },
      });

      // A crashed renderer or an older observer left `working` behind. Unlike a
      // backoff-skipped group, a cooldown-skipped one has a real answer to
      // publish, so the environment must not be withheld from the commit.
      await storage.setEnvironmentAgentActivity(
        "env-1",
        "working",
        new Date().toISOString(),
        "native-agent",
      );
      clock = 2_000;
      await service.reconcileAgentActivity();

      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: "idle" } },
      });
    });
  });

  test("observes a bridge a user just started without waiting out the cooldown", async () => {
    const commands: string[] = [];
    const invoke = (async <T,>(command: string): Promise<T> => {
      commands.push(command);
      if (command === "peek_local_agent_bridge") return null as T;
      if (command === "start_local_codex_server_cmd") {
        return { port: 1, authToken: "token" } as T;
      }
      throw new Error(`Unexpected backend command: ${command}`);
    }) as Invoke;
    const started = createProviderStub("codex", {
      activity: async () => "working",
    });
    let clock = 1_000;
    await withService({
      prefix: "orkestrator-native-activity-cooldown-cleared-",
      invoke,
      now: () => clock,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "tab-1"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });

      await service.reconcileAgentActivity();
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: "idle" } },
      });

      // The user opens a tab well inside the recheck window: the starting path
      // caches its provider, which retires the "no bridge is running" note.
      clock = 2_000;
      await internals(service).provider({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
      });
      expect(commands).toEqual([
        "peek_local_agent_bridge",
        "start_local_codex_server_cmd",
      ]);
      // Swap the real HTTP provider for a stub so the read needs no socket. The
      // cooldown was already cleared by the caching above, which is what lets
      // this sweep consult the cache at all.
      internals(service).providers.set(
        "env-1\u0000codex",
        started.provider,
      );

      await service.reconcileAgentActivity();

      expect(started.activity).toHaveBeenCalledWith("provider-1");
      expect(commands).toHaveLength(2);
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: "working" } },
      });
    });
  });

  test("forgets a deleted environment's provider, backoff and cooldown together", async () => {
    const failing = createProviderStub("codex", {
      activity: async () => { throw new ProviderUnavailableError("offline"); },
    });
    await withService({
      prefix: "orkestrator-native-activity-forget-",
      provider: async () => failing.provider,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "tab-1"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });

      await captureWarnings(async () => {
        await service.reconcileAgentActivity();
      });
      // The failure left backoff bookkeeping behind; a tab opened afterwards
      // puts a provider back in the cache.
      expect(internals(service).activityRetryAt.size).toBe(1);
      await internals(service).provider({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
      });
      expect(internals(service).providers.size).toBe(1);

      await storage.removeEnvironment("env-1");
      await internals(service).reconcilePendingLaunches();

      expect(internals(service).providers.size).toBe(0);
      expect(internals(service).activityRetryAt.size).toBe(0);
      expect(internals(service).activityAttempts.size).toBe(0);
      expect(internals(service).absentBridgeUntil.size).toBe(0);
      expect(failing.dispose).toHaveBeenCalledTimes(1);
    });
  });

  test("skips an environment that is already pending deletion", async () => {
    const providerFactory = mock(async () => createProviderStub("codex").provider);
    await withService({
      prefix: "orkestrator-native-activity-deleting-",
      provider: providerFactory,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "tab-1"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });
      await storage.updateEnvironment("env-1", {
        deletionRequestedAt: new Date().toISOString(),
      });

      const warnings = await captureWarnings(async () => {
        await service.reconcileAgentActivity();
      });

      // Every provider call would throw the liveness assertion, warning and
      // backing off on a loop until the delete finishes.
      expect(providerFactory).not.toHaveBeenCalled();
      expect(warnings).toEqual([]);
    });
  });

  test("retires a stale projection once the last native session is gone", async () => {
    const providerFactory = mock(async () => createProviderStub("codex").provider);
    await withService({
      prefix: "orkestrator-native-activity-last-session-",
      provider: providerFactory,
    }, async ({ storage, service }) => {
      await storage.setEnvironmentAgentActivity(
        "env-1",
        "working",
        new Date().toISOString(),
        "native-agent",
      );

      await service.reconcileAgentActivity();

      // The tab that owned the only session was closed; without this the
      // sidebar spins forever on an agent that no longer exists.
      expect(providerFactory).not.toHaveBeenCalled();
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivitySources: { "native-agent": { state: "idle" } },
      });
    });
  });

  test("abandons the commit when shutdown lands mid-read and admits no later sweep", async () => {
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const providerFactory = mock(async () => createProviderStub("codex", {
      activity: async () => {
        signalEntered();
        await barrier;
        return "working";
      },
    }).provider);
    await withService({
      prefix: "orkestrator-native-activity-shutdown-commit-",
      provider: providerFactory,
    }, async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "tab-1"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });

      const scan = service.reconcileAgentActivity();
      await entered;
      const shuttingDown = service.shutdown();
      release();
      await Promise.all([scan, shuttingDown]);

      expect((await storage.getEnvironment("env-1"))!
        .agentActivitySources?.["native-agent"]).toBeUndefined();

      const callsBefore = providerFactory.mock.calls.length;
      await expect(service.reconcileAgentActivity()).resolves.toBeUndefined();
      expect(providerFactory).toHaveBeenCalledTimes(callsBefore);
    });
  });

  test("two supervisors drain a queued prompt through one provider dispatch", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-service-"));
    const firstStorage = await createStorage(dataDir);
    const secondStorage = await createStorage(dataDir);
    await addEnvironment(firstStorage);
    await firstStorage.savePromptQueue(
      "codex\u0000env-env-1:tab-1",
      "env-1",
      [{ id: "row-1", requestId: "request-1", text: "Build it" }],
    );
    const createSession = mock(async () => "provider-session");
    const send = mock(async () => undefined);
    const provider = {
      agent: "codex",
      createSession,
      registerSession: () => undefined,
      send,
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const invoke = async <T>(): Promise<T> => {
      throw new Error("The injected provider should avoid backend commands");
    };
    const first = new NativeAgentService(firstStorage, invoke, {
      provider: async () => provider,
    });
    const second = new NativeAgentService(secondStorage, invoke, {
      provider: async () => provider,
    });
    try {
      await Promise.all([first.init(), second.init()]);
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        "provider-session",
        "Build it",
        expect.objectContaining({ requestId: "request-1" }),
      );
      expect(await firstStorage.getPromptQueue("codex\u0000env-env-1:tab-1"))
        .toMatchObject({ messages: [] });
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("two supervisors consume one startup prompt with its images once", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-startup-"));
    const firstStorage = await createStorage(dataDir);
    const secondStorage = await createStorage(dataDir);
    await addEnvironment(firstStorage, {
      defaultAgent: "codex",
      codexMode: "native",
      pendingAgentLaunch: true,
      initialAgentModel: "gpt-startup",
      initialReasoningEffort: "high",
      initialPrompt: "Inspect the screenshots",
      initialPromptAttachments: [{
        id: "image-1",
        name: "reference.png",
        previewUrl: "data:image/png;base64,cG5n",
        base64Data: "cG5n",
      }],
    });
    const createSession = mock(async () => "provider-session");
    const send = mock(async () => undefined);
    const provider = {
      agent: "codex",
      createSession,
      registerSession: () => undefined,
      send,
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const invoke = async <T>(command: string): Promise<T> => {
      // Staging happens inside the provider, under the dispatch lock, so the
      // supervisor that loses the launch must never reach a backend command.
      throw new Error(`Unexpected backend command: ${command}`);
    };
    const first = new NativeAgentService(firstStorage, invoke, {
      provider: async () => provider,
    });
    const second = new NativeAgentService(secondStorage, invoke, {
      provider: async () => provider,
    });
    try {
      await Promise.all([first.init(), second.init()]);
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        "provider-session",
        "Inspect the screenshots",
        expect.objectContaining({
          requestId: "initial-prompt:env-1:startup-agent",
          images: [{ filename: "reference.png", data: "cG5n" }],
        }),
      );
      expect(await firstStorage.getEnvironment("env-1")).toMatchObject({
        pendingAgentLaunch: false,
        startupAgentSession: {
          tabId: "startup-agent",
          model: "gpt-startup",
          reasoningEffort: "high",
          providerSessionId: "provider-session",
          status: "running",
        },
      });
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("retains startup model and effort while launch is starting and after failure", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-startup-meta-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage, {
      defaultAgent: "codex",
      codexMode: "native",
      pendingAgentLaunch: true,
      initialAgentModel: "gpt-startup",
      initialReasoningEffort: "high",
    });
    let signalCreateEntered: (() => void) | undefined;
    const createEntered = new Promise<void>((resolve) => {
      signalCreateEntered = resolve;
    });
    let rejectCreate: ((error: Error) => void) | undefined;
    const createSession = mock(async () => {
      signalCreateEntered?.();
      return new Promise<string>((_resolve, reject) => {
        rejectCreate = reject;
      });
    });
    const provider = {
      agent: "codex",
      createSession,
      registerSession: () => undefined,
      send: async () => undefined,
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    try {
      const initializing = service.init();
      await createEntered;
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        startupAgentSession: {
          status: "starting",
          model: "gpt-startup",
          reasoningEffort: "high",
        },
      });

      rejectCreate?.(new Error("provider unavailable"));
      await initializing;
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        pendingAgentLaunch: true,
        initialAgentModel: "gpt-startup",
        initialReasoningEffort: "high",
        startupAgentSession: {
          status: "error",
          model: "gpt-startup",
          reasoningEffort: "high",
        },
      });
    } finally {
      rejectCreate?.(new Error("test cleanup"));
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("replaces a mapping only after the provider confirms it is missing", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-missing-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    let providerSessionId = "provider-old";
    const provider = {
      agent: "codex",
      createSession: mock(async () => providerSessionId),
      registerSession: () => undefined,
      send: async () => undefined,
      status: mock(async (sessionId: string) =>
        sessionId === "provider-old" ? "missing" as const : "idle" as const),
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(
      storage,
      async <T>(): Promise<T> => {
        throw new Error("The injected provider should avoid backend commands");
      },
      { provider: async () => provider },
    );
    try {
      const first = await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "env-env-1:tab-1",
      });
      expect(first.providerSessionId).toBe("provider-old");
      providerSessionId = "provider-new";
      const replacement = await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "env-env-1:tab-1",
      });
      expect(replacement.providerSessionId).toBe("provider-new");
      expect(provider.createSession).toHaveBeenCalledTimes(2);
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("persists default and workflow interaction metadata through the service", async () => {
    const { provider } = createProviderStub("codex", {
      createSession: async () => "provider-session",
    });
    await withService({
      prefix: "orkestrator-native-interaction-metadata-",
      provider: async () => provider,
    }, async ({ service }) => {
      const interactive = await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "env-env-1:interactive",
      });
      expect(interactive).toMatchObject({
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      });

      const unattended = await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "looped-review:workflow-1:review:round-1",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      expect(unattended).toMatchObject({
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
    });
  });

  test("rehydrates a legacy looped-review mapping without replacing its provider", async () => {
    const { provider, createSession, status } = createProviderStub("codex");
    await withService({
      prefix: "orkestrator-native-legacy-looped-review-",
      provider: async () => provider,
    }, async ({ storage, service }) => {
      const logicalSessionKey = "looped-review:workflow-1:review:round-1";
      const key = nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey);
      const file = path.join(storage.getDataDir(), "native-agent-sessions.json");
      await fs.writeFile(file, JSON.stringify({
        [key]: {
          key,
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey,
          providerSessionId: "legacy-provider-session",
          createdAt: new Date(1).toISOString(),
          updatedAt: new Date(2).toISOString(),
        },
      }));

      const session = await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey,
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      expect(session).toMatchObject({
        providerSessionId: "legacy-provider-session",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      expect(createSession).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith("legacy-provider-session");
      expect(JSON.parse(await fs.readFile(file, "utf8"))[key]).toMatchObject({
        version: 1,
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
    });
  });

  test("does not drain a queue until the authoritative provider is idle", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-idle-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    const queueKey = "codex\u0000env-env-1:tab-1";
    await storage.savePromptQueue(queueKey, "env-1", [
      { id: "row-1", text: "Wait for idle", mode: "build" },
    ]);
    let status: "running" | "idle" = "running";
    const send = mock(async () => undefined);
    const provider = {
      agent: "codex",
      createSession: async () => "provider-session",
      registerSession: () => undefined,
      send,
      status: async () => status,
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    const drain = () => (
      service as unknown as { drainPromptQueues(): Promise<void> }
    ).drainPromptQueues();
    try {
      await drain();
      expect(send).not.toHaveBeenCalled();
      expect(await storage.getPromptQueue(queueKey)).toMatchObject({
        messages: [{ id: "row-1" }],
      });

      status = "idle";
      await drain();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test.each([
    ["text", { text: "draft", mentions: [], attachments: [] }],
    ["mentions", { text: "", mentions: [{ id: "m" }], attachments: [] }],
    ["attachments", { text: "", mentions: [], attachments: [{ id: "a" }] }],
  ])("holds queued work for persisted compose draft %s", async (_label, value) => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-draft-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    const logicalSessionKey = "env-env-1:tab-1";
    const queueKey = `claude\u0000${logicalSessionKey}`;
    const draftKey = `claude:env-1:${encodeURIComponent(logicalSessionKey)}`;
    await storage.savePromptQueue(queueKey, "env-1", [
      { id: "row-1", text: "Wait for draft", planModeEnabled: false },
    ]);
    await storage.saveComposeDraft(draftKey, "environment", "env-1", value);
    const send = mock(async () => undefined);
    const provider = {
      agent: "claude",
      createSession: async () => "provider-session",
      registerSession: () => undefined,
      send,
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    const drain = () => (
      service as unknown as { drainPromptQueues(): Promise<void> }
    ).drainPromptQueues();
    try {
      await drain();
      expect(send).not.toHaveBeenCalled();
      await storage.deleteComposeDraft(draftKey);
      await drain();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rechecks the persisted compose draft after an asynchronous status lookup", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-draft-race-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    const logicalSessionKey = "env-env-1:tab-1";
    const queueKey = `claude\u0000${logicalSessionKey}`;
    const draftKey = `claude:env-1:${encodeURIComponent(logicalSessionKey)}`;
    await storage.savePromptQueue(queueKey, "env-1", [
      { id: "row-1", text: "Wait for the late draft", planModeEnabled: false },
    ]);

    let signalStatusEntered: (() => void) | undefined;
    const statusEntered = new Promise<void>((resolve) => {
      signalStatusEntered = resolve;
    });
    let releaseStatus: (() => void) | undefined;
    const statusBarrier = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const send = mock(async () => undefined);
    const status = mock(async () => {
      signalStatusEntered?.();
      await statusBarrier;
      return "idle" as const;
    });
    const provider = {
      agent: "claude",
      createSession: async () => "provider-session",
      registerSession: () => undefined,
      send,
      status,
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    const drain = () => (
      service as unknown as { drainPromptQueues(): Promise<void> }
    ).drainPromptQueues();
    try {
      const pendingDrain = drain();
      await statusEntered;
      await storage.saveComposeDraft(
        draftKey,
        "environment",
        "env-1",
        { text: "created during status", mentions: [], attachments: [] },
      );
      releaseStatus?.();
      await pendingDrain;

      expect(send).not.toHaveBeenCalled();
      expect(await storage.getPromptQueue(queueKey)).toMatchObject({
        messages: [{ id: "row-1" }],
      });

      await storage.deleteComposeDraft(draftKey);
      await drain();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      releaseStatus?.();
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test.each([
    ["claude", { planModeEnabled: true }],
    ["opencode", { mode: "plan" }],
  ] as const)("preserves queued %s plan mode through dispatch", async (agent, mode) => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-plan-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    const queueKey = `${agent}\u0000env-env-1:tab-1`;
    await storage.savePromptQueue(queueKey, "env-1", [
      { id: "row-1", text: "Inspect only", ...mode },
    ]);
    const send = mock(async () => undefined);
    const provider = {
      agent,
      createSession: async () => "provider-session",
      registerSession: () => undefined,
      send,
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    try {
      await (
        service as unknown as { drainPromptQueues(): Promise<void> }
      ).drainPromptQueues();
      expect(send).toHaveBeenCalledWith(
        "provider-session",
        "Inspect only",
        expect.objectContaining({ mode: "plan" }),
      );
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test.each([
    ["claude", { fastModeEnabled: true }, true],
    ["codex", { fastMode: false }, false],
  ] as const)("preserves queued %s fast mode through dispatch", async (
    agent,
    fastModeField,
    expectedFastMode,
  ) => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-fast-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    const queueKey = `${agent}\u0000env-env-1:tab-1`;
    await storage.savePromptQueue(queueKey, "env-1", [
      { id: "row-1", text: "Use the selected speed", ...fastModeField },
    ]);
    const send = mock(async () => undefined);
    const provider = {
      agent,
      createSession: async () => "provider-session",
      registerSession: () => undefined,
      send,
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    try {
      await (
        service as unknown as { drainPromptQueues(): Promise<void> }
      ).drainPromptQueues();
      expect(send).toHaveBeenCalledWith(
        "provider-session",
        "Use the selected speed",
        expect.objectContaining({ fastMode: expectedFastMode }),
      );
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("parks permanent rejection visibly but retains transient in-flight work", async () => {
    const run = async (
      error: Error,
    ): Promise<Awaited<ReturnType<StorageService["getPromptQueue"]>>> => {
      const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-error-"));
      const storage = await createStorage(dataDir);
      await addEnvironment(storage);
      const queueKey = "codex\u0000env-env-1:tab-1";
      await storage.savePromptQueue(queueKey, "env-1", [
        { id: "row-1", text: "Dispatch me" },
      ]);
      const provider = {
        agent: "codex",
        createSession: async () => "provider-session",
        registerSession: () => undefined,
        send: async () => { throw error; },
        status: async () => "idle",
        messages: async () => [],
        structured: async () => null,
        abort: async () => undefined,
      } as BuildPipelineProvider;
      const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
        throw new Error("unused");
      }, { provider: async () => provider });
      try {
        await (
          service as unknown as { drainPromptQueues(): Promise<void> }
        ).drainPromptQueues();
        return await storage.getPromptQueue(queueKey);
      } finally {
        await service.shutdown();
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    };

    const permanent = await run(new PromptRejectedError("bad request"));
    expect(permanent).toMatchObject({
      messages: [{ id: "row-1" }],
      dispatchError: { requestId: "row-1" },
    });
    expect(permanent?.inFlight).toBeUndefined();

    const transient = await run(new ProviderUnavailableError("offline"));
    expect(transient).toMatchObject({
      messages: [],
      inFlight: { requestId: "row-1" },
    });
    expect(transient?.dispatchError).toBeUndefined();
  });

  test("retries a busy dispatch race with the same durable request id", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-busy-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    const queueKey = "codex\u0000env-env-1:tab-1";
    await storage.savePromptQueue(queueKey, "env-1", [
      { id: "row-1", text: "Dispatch me" },
    ]);
    const requests: string[] = [];
    const provider = {
      agent: "codex",
      createSession: async () => "provider-session",
      registerSession: () => undefined,
      send: async (_sessionId: string, _prompt: string, options: { requestId: string }) => {
        requests.push(options.requestId);
        if (requests.length === 1) {
          throw new ProviderUnavailableError("busy (HTTP 409)");
        }
      },
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    try {
      await (
        service as unknown as { drainPromptQueues(): Promise<void> }
      ).drainPromptQueues();
      expect(await storage.getPromptQueue(queueKey)).toMatchObject({
        inFlight: { requestId: "row-1" },
      });

      (
        service as unknown as { queueRetryAt: Map<string, number> }
      ).queueRetryAt.delete(queueKey);
      await (
        service as unknown as { drainPromptQueues(): Promise<void> }
      ).drainPromptQueues();

      expect(requests).toEqual(["row-1", "row-1"]);
      expect(await storage.getPromptQueue(queueKey)).toMatchObject({
        messages: [],
      });
      expect((await storage.getPromptQueue(queueKey))?.inFlight).toBeUndefined();
      expect((await storage.getPromptQueue(queueKey))?.dispatchError).toBeUndefined();
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("adopts validated sessions and compare-and-swaps manual resume", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-adopt-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    const provider = {
      agent: "opencode",
      createSession: async () => "unused",
      registerSession: () => undefined,
      send: async () => undefined,
      status: async (sessionId: string) =>
        sessionId === "missing" ? "missing" as const : "idle" as const,
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    const base = {
      environmentId: "env-1",
      agent: "opencode" as const,
      logicalSessionKey: "env-env-1:tab-1",
    };
    try {
      expect((await service.adoptSession({
        ...base,
        providerSessionId: "provider-old",
      })).providerSessionId).toBe("provider-old");
      expect((await service.adoptSession({
        ...base,
        providerSessionId: "provider-new",
        expectedProviderSessionId: "provider-old",
      })).providerSessionId).toBe("provider-new");
      await expect(service.adoptSession({
        ...base,
        providerSessionId: "missing",
      })).rejects.toThrow("not found");
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("scopes durable identities by environment", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-scope-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    await storage.addEnvironment({
      ...(await storage.getEnvironment("env-1"))!,
      id: "env-2",
      worktreePath: "/tmp/env-2",
    });
    let created = 0;
    const provider = {
      agent: "codex",
      createSession: async () => `provider-${++created}`,
      registerSession: () => undefined,
      send: async () => undefined,
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    try {
      const logicalSessionKey = "shared-key";
      const first = await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey,
      });
      const second = await service.ensureSession({
        environmentId: "env-2",
        agent: "codex",
        logicalSessionKey,
      });
      expect(first.providerSessionId).not.toBe(second.providerSessionId);
      expect(nativeAgentSessionStorageKey(
        "env-1",
        "codex",
        logicalSessionKey,
      )).not.toBe(nativeAgentSessionStorageKey(
        "env-2",
        "codex",
        logicalSessionKey,
      ));
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("tracks startup scans and admits no work after shutdown begins", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-shutdown-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    let releaseScan!: (queues: Awaited<ReturnType<StorageService["listAllPromptQueues"]>>) => void;
    const scan = new Promise<
      Awaited<ReturnType<StorageService["listAllPromptQueues"]>>
    >((resolve) => {
      releaseScan = resolve;
    });
    const originalList = storage.listAllPromptQueues.bind(storage);
    storage.listAllPromptQueues = async () => scan;
    const createSession = mock(async () => "provider-session");
    const provider = {
      agent: "codex",
      createSession,
      registerSession: () => undefined,
      send: async () => undefined,
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    try {
      const initializing = service.init();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const shuttingDown = service.shutdown();
      releaseScan([]);
      await Promise.all([initializing, shuttingDown]);
      await expect(service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "env-env-1:tab-1",
      })).rejects.toThrow("shut down");
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      storage.listAllPromptQueues = originalList;
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("fences cached provider status and send when deletion starts", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-delete-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    let deleteDuringStatus = false;
    const status = mock(async () => {
      if (deleteDuringStatus) {
        deleteDuringStatus = false;
        await storage.updateEnvironment("env-1", {
          deletionRequestedAt: new Date().toISOString(),
        });
      }
      return "idle" as const;
    });
    const send = mock(async () => undefined);
    const provider = {
      agent: "codex",
      createSession: async () => "provider-session",
      registerSession: () => undefined,
      send,
      status,
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    const input = {
      environmentId: "env-1",
      agent: "codex" as const,
      logicalSessionKey: "env-env-1:tab-1",
    };
    try {
      await service.ensureSession(input);
      deleteDuringStatus = true;
      await expect(service.ensureSession(input)).rejects.toThrow("unavailable");
      await expect(service.dispatchPrompt({
        ...input,
        prompt: "must not run",
        requestId: "request-1",
      })).rejects.toThrow("unavailable");
      expect(send).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("orders environment deletion intent after an outbound prompt already holds the lock", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-send-delete-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    let signalSendEntered: (() => void) | undefined;
    const sendEntered = new Promise<void>((resolve) => {
      signalSendEntered = resolve;
    });
    let releaseSend: (() => void) | undefined;
    const sendBarrier = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const send = mock(async () => {
      signalSendEntered?.();
      await sendBarrier;
    });
    const provider = {
      agent: "codex",
      createSession: async () => "provider-session",
      registerSession: () => undefined,
      send,
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    const input = {
      environmentId: "env-1",
      agent: "codex" as const,
      logicalSessionKey: "env-env-1:tab-1",
    };
    try {
      await service.ensureSession(input);
      const dispatch = service.dispatchPrompt({
        ...input,
        prompt: "accepted before deletion",
        requestId: "request-1",
      });
      await sendEntered;

      let deletionSettled = false;
      const deletion = storage.updateEnvironment("env-1", {
        deletionRequestedAt: new Date().toISOString(),
      }).then(() => {
        deletionSettled = true;
      });
      await Promise.resolve();
      expect(deletionSettled).toBe(false);

      releaseSend?.();
      await Promise.all([dispatch, deletion]);
      expect(send).toHaveBeenCalledTimes(1);
      expect((await storage.getEnvironment("env-1"))?.deletionRequestedAt)
        .toBeDefined();
    } finally {
      releaseSend?.();
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("orders environment deletion intent after provider session creation already holds the lock", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-create-delete-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    let signalCreateEntered: (() => void) | undefined;
    const createEntered = new Promise<void>((resolve) => {
      signalCreateEntered = resolve;
    });
    let releaseCreate: (() => void) | undefined;
    const createBarrier = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createSession = mock(async () => {
      signalCreateEntered?.();
      await createBarrier;
      return "provider-session";
    });
    const provider = {
      agent: "opencode",
      createSession,
      registerSession: () => undefined,
      send: async () => undefined,
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    const input = {
      environmentId: "env-1",
      agent: "opencode" as const,
      logicalSessionKey: "env-env-1:tab-1",
    };
    try {
      const ensure = service.ensureSession(input);
      await createEntered;

      let deletionSettled = false;
      const deletion = storage.updateEnvironment("env-1", {
        deletionRequestedAt: new Date().toISOString(),
      }).then(() => {
        deletionSettled = true;
      });
      await Promise.resolve();
      expect(deletionSettled).toBe(false);

      releaseCreate?.();
      await Promise.all([ensure, deletion]);
      expect(createSession).toHaveBeenCalledTimes(1);
      expect((await storage.getEnvironment("env-1"))?.deletionRequestedAt)
        .toBeDefined();
    } finally {
      releaseCreate?.();
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  describe("bridge connections", () => {
    test.each([
      ["claude", "start_local_claude_server_cmd"],
      ["codex", "start_local_codex_server_cmd"],
      ["opencode", "start_local_opencode_server_cmd"],
    ] as const)("starts the %s local bridge and carries its worktree", async (
      agent,
      command,
    ) => {
      const invoke = mock(async () => ({ port: 4123, authToken: "token" }) as never);
      await withService({
        prefix: "orkestrator-native-bridge-local-",
        invoke: invoke as unknown as Invoke,
      }, async ({ storage, service }) => {
        const environment = (await storage.getEnvironment("env-1"))!;
        expect(await internals(service).bridgeConnection(
          agent,
          environment,
          "chosen-model",
          "chosen-effort",
        )).toEqual({
          agent,
          baseUrl: "http://127.0.0.1:4123",
          authToken: "token",
          directory: "/tmp/env-1",
          model: "chosen-model",
          effort: "chosen-effort",
        });
        expect(invoke).toHaveBeenCalledWith(command, { environmentId: "env-1" });
      });
    });

    test.each([
      ["claude", "start_claude_server"],
      ["codex", "start_codex_server"],
      ["opencode", "start_opencode_server"],
    ] as const)("starts the %s container bridge on its host port", async (
      agent,
      command,
    ) => {
      const invoke = mock(async () => ({ hostPort: 5123, authToken: "token" }) as never);
      await withService({
        prefix: "orkestrator-native-bridge-container-",
        environment: {
          environmentType: "containerized",
          containerId: "container-1",
          worktreePath: undefined,
        },
        invoke: invoke as unknown as Invoke,
      }, async ({ storage, service }) => {
        const environment = (await storage.getEnvironment("env-1"))!;
        // No `directory`: the bridge runs inside the container, where the
        // workspace path is fixed and a host path would be meaningless.
        expect(await internals(service).bridgeConnection(agent, environment))
          .toEqual({
            agent,
            baseUrl: "http://127.0.0.1:5123",
            authToken: "token",
            model: undefined,
            effort: undefined,
          });
        expect(invoke).toHaveBeenCalledWith(command, { containerId: "container-1" });
      });
    });

    test.each([
      ["local", { environmentType: "local" }],
      [
        "container",
        { environmentType: "containerized", containerId: "container-1" },
      ],
    ] as const)("refuses an unauthenticated %s bridge", async (_label, environment) => {
      const invoke = mock(async () => ({ port: 4123, hostPort: 5123 }) as never);
      await withService({
        prefix: "orkestrator-native-bridge-auth-",
        environment,
        invoke: invoke as unknown as Invoke,
      }, async ({ storage, service }) => {
        const stored = (await storage.getEnvironment("env-1"))!;
        // An unauthenticated bridge would accept prompts from any local
        // process, so a missing token must fail the connection outright.
        await expect(internals(service).bridgeConnection("codex", stored))
          .rejects.toThrow("codex bridge authentication is unavailable");
      });
    });

    test("refuses a container environment with no container", async () => {
      const invoke = mock(async () => ({ hostPort: 5123, authToken: "t" }) as never);
      await withService({
        prefix: "orkestrator-native-bridge-nocontainer-",
        environment: { environmentType: "containerized", containerId: null },
        invoke: invoke as unknown as Invoke,
      }, async ({ storage, service }) => {
        const stored = (await storage.getEnvironment("env-1"))!;
        await expect(internals(service).bridgeConnection("codex", stored))
          .rejects.toThrow("Native agent container is unavailable");
        expect(invoke).not.toHaveBeenCalled();
      });
    });

    test("builds one real provider per environment and agent", async () => {
      const invoke = mock(async () => ({ port: 4123, authToken: "token" }) as never);
      await withService({
        prefix: "orkestrator-native-bridge-cache-",
        invoke: invoke as unknown as Invoke,
      }, async ({ service }) => {
        const base = {
          environmentId: "env-1",
          logicalSessionKey: "env-env-1:tab-1",
        };
        const codex = await internals(service).provider({
          ...base,
          agent: "codex",
          model: "gpt-a",
        });
        // Model and effort are per-call, so a second variant must reuse the
        // same provider rather than starting another bridge connection.
        const again = await internals(service).provider({
          ...base,
          agent: "codex",
          model: "gpt-b",
          reasoningEffort: "high",
        });
        expect(again).toBe(codex);
        expect(codex.agent).toBe("codex");
        expect(invoke).toHaveBeenCalledTimes(1);

        const opencode = await internals(service).provider({
          ...base,
          agent: "opencode",
        });
        expect(opencode.agent).toBe("opencode");
        expect(invoke).toHaveBeenCalledTimes(2);
        expect([...internals(service).providers.keys()].sort())
          .toEqual(["env-1\u0000codex", "env-1\u0000opencode"]);
      });
    });

    test("stages images through the real provider callback before dispatch", async () => {
      const stagedPath = "/tmp/env-1/.orkestrator/initial-prompt/reference.png";
      const invoke = mock(async (command: string) => {
        if (command === "write_local_file") return stagedPath as never;
        throw new Error(`Unexpected backend command: ${command}`);
      });
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch;
      try {
        await withService({
          prefix: "orkestrator-native-provider-stage-images-",
          invoke: invoke as unknown as Invoke,
        }, async ({ service }) => {
          internals(service).bridgeConnection = async () => ({
            agent: "codex",
            baseUrl: "http://127.0.0.1:4123",
            authToken: "token",
            directory: "/tmp/env-1",
          });
          const provider = await internals(service).provider({
            environmentId: "env-1",
            agent: "codex",
            logicalSessionKey: "tab-1",
          });

          await provider.send("provider-1", "Inspect it", {
            requestId: "request-1",
            images: [{ filename: "reference.png", data: "cG5n" }],
          });

          expect(invoke).toHaveBeenCalledWith("write_local_file", {
            worktreePath: "/tmp/env-1",
            filePath: ".orkestrator/initial-prompt/reference.png",
            base64Data: "cG5n",
          });
          expect(requests).toHaveLength(1);
          expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
            prompt: "Inspect it",
            requestId: "request-1",
            attachments: [{
              type: "image",
              path: stagedPath,
              filename: "reference.png",
              dataUrl: "data:image/png;base64,cG5n",
            }],
          });
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("startup launch reconciliation", () => {
    test.each([
      ["a terminal-mode codex agent", { defaultAgent: "codex", codexMode: "terminal" }],
      ["a terminal-mode opencode agent", {
        defaultAgent: "opencode",
        opencodeMode: "terminal",
      }],
      ["a tmux-backed claude agent", {
        defaultAgent: "claude",
        claudeMode: "native",
        claudeNativeBackend: "tmux",
      }],
    ] as const)("leaves %s pending for the terminal coordinator", async (
      _label,
      agentConfig,
    ) => {
      const { provider, createSession, send } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-launch-skip-",
        environment: {
          ...agentConfig,
          pendingAgentLaunch: true,
          initialPrompt: "Start working",
        },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await service.reconcileInitialLaunch("env-1");

        // Marking the launch consumed here would lose the user's prompt: only
        // the terminal coordinator can project a PTY/tmux session.
        expect(await storage.getEnvironment("env-1")).toMatchObject({
          pendingAgentLaunch: true,
        });
        expect((await storage.getEnvironment("env-1"))?.startupAgentSession)
          .toBeUndefined();
        expect(createSession).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(await storage.getNativeAgentSession(nativeAgentSessionStorageKey(
          "env-1",
          "claude",
          "env-env-1:startup-agent",
        ))).toBeNull();
      });
    });

    test("falls back to the repository agent, model and effort", async () => {
      const { provider, createSession } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-launch-repo-",
        environment: { pendingAgentLaunch: true },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await storage.updateRepositoryConfig("project-1", {
          defaultBranch: "main",
          prBaseBranch: "main",
          defaultAgent: "codex",
          defaultModel: "repo-model",
          defaultEffort: "repo-effort",
        });

        await service.reconcileInitialLaunch("env-1");

        expect(await storage.getEnvironment("env-1")).toMatchObject({
          startupAgentSession: {
            agent: "codex",
            model: "repo-model",
            reasoningEffort: "repo-effort",
            status: "running",
          },
        });
        expect(createSession).toHaveBeenCalledWith(
          "build",
          "Agent Session",
          expect.objectContaining({
            model: "repo-model",
            effort: "repo-effort",
          }),
        );
      });
    });

    test("falls back to the global codex model and reasoning effort", async () => {
      const { provider } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-launch-global-codex-",
        environment: { pendingAgentLaunch: true },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const config = await storage.loadConfig();
        await storage.updateGlobalConfig({
          ...config.global,
          defaultAgent: "codex",
          codexMode: "native",
          codexModel: "global-codex",
          codexReasoningEffort: "xhigh",
        });

        await service.reconcileInitialLaunch("env-1");

        expect(await storage.getEnvironment("env-1")).toMatchObject({
          startupAgentSession: {
            agent: "codex",
            model: "global-codex",
            reasoningEffort: "xhigh",
          },
        });
      });
    });

    test("falls back to the global claude model and no reasoning effort", async () => {
      const { provider } = createProviderStub("claude");
      await withService({
        prefix: "orkestrator-native-launch-global-claude-",
        environment: { pendingAgentLaunch: true, claudeMode: "native" },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const config = await storage.loadConfig();
        await storage.updateGlobalConfig({
          ...config.global,
          defaultAgent: "claude",
          claudeModel: "global-claude",
        });

        await service.reconcileInitialLaunch("env-1");

        const environment = await storage.getEnvironment("env-1");
        expect(environment).toMatchObject({
          startupAgentSession: { agent: "claude", model: "global-claude" },
        });
        // Only codex has a global effort tier; inventing one for claude would
        // send an unsupported field to its bridge.
        expect(environment?.startupAgentSession?.reasoningEffort).toBeUndefined();
      });
    });

    test("prefers the environment's own agent, model and effort", async () => {
      const { provider } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-launch-precedence-",
        environment: {
          pendingAgentLaunch: true,
          defaultAgent: "codex",
          codexMode: "native",
          initialAgentModel: "env-model",
          initialReasoningEffort: "env-effort",
        },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await storage.updateRepositoryConfig("project-1", {
          defaultBranch: "main",
          prBaseBranch: "main",
          defaultAgent: "claude",
          defaultModel: "repo-model",
          defaultEffort: "repo-effort",
        });

        await service.reconcileInitialLaunch("env-1");

        expect(await storage.getEnvironment("env-1")).toMatchObject({
          startupAgentSession: {
            agent: "codex",
            model: "env-model",
            reasoningEffort: "env-effort",
          },
        });
      });
    });

    test("shares one launch task between concurrent reconciliations", async () => {
      let releaseCreate: (() => void) | undefined;
      const createBarrier = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      let signalCreateEntered: (() => void) | undefined;
      const createEntered = new Promise<void>((resolve) => {
        signalCreateEntered = resolve;
      });
      const { provider, createSession } = createProviderStub("codex", {
        createSession: async () => {
          signalCreateEntered?.();
          await createBarrier;
          return "provider-session";
        },
      });
      await withService({
        prefix: "orkestrator-native-launch-dedup-",
        environment: {
          pendingAgentLaunch: true,
          defaultAgent: "codex",
          codexMode: "native",
        },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const first = service.reconcileInitialLaunch("env-1");
        await createEntered;
        const tracked = internals(service).launchTasks.get("env-1");
        const second = service.reconcileInitialLaunch("env-1");
        // The second caller joins the in-flight task. Starting a parallel one
        // would leave storage as the only thing fencing a duplicate launch.
        expect(internals(service).launchTasks.get("env-1")).toBe(tracked);
        releaseCreate?.();
        await Promise.all([first, second]);

        expect(createSession).toHaveBeenCalledTimes(1);
        expect(internals(service).launchTasks.size).toBe(0);
        expect(await storage.getEnvironment("env-1")).toMatchObject({
          pendingAgentLaunch: false,
        });
      });
    });

    test("drains an in-flight launch before shutdown resolves", async () => {
      let releaseCreate: (() => void) | undefined;
      const createBarrier = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      let signalCreateEntered: (() => void) | undefined;
      const createEntered = new Promise<void>((resolve) => {
        signalCreateEntered = resolve;
      });
      const { provider } = createProviderStub("codex", {
        createSession: async () => {
          signalCreateEntered?.();
          await createBarrier;
          return "provider-session";
        },
      });
      const dataDir = await fs.mkdtemp(
        path.join(tmpdir(), "orkestrator-native-shutdown-drain-"),
      );
      const storage = await createStorage(dataDir);
      await addEnvironment(storage, {
        pendingAgentLaunch: true,
        defaultAgent: "codex",
        codexMode: "native",
      });
      const service = new NativeAgentService(storage, refusingInvoke, {
        provider: async () => provider,
      });
      try {
        const launching = service.reconcileInitialLaunch("env-1");
        await createEntered;

        let shutdownSettled = false;
        const shuttingDown = service.shutdown().then(() => {
          shutdownSettled = true;
        });
        for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
        // Resolving shutdown here would let the process exit while a launch is
        // still writing durable startup state.
        expect(shutdownSettled).toBe(false);

        releaseCreate?.();
        await Promise.allSettled([launching, shuttingDown]);
        expect(shutdownSettled).toBe(true);
      } finally {
        releaseCreate?.();
        await service.shutdown();
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    });

    test("stops retrying a startup prompt the agent rejected", async () => {
      const { provider, send } = createProviderStub("codex", {
        send: async () => {
          throw new PromptRejectedError("prompt is too long");
        },
      });
      await withService({
        prefix: "orkestrator-native-launch-rejected-",
        environment: {
          pendingAgentLaunch: true,
          defaultAgent: "codex",
          codexMode: "native",
          initialPrompt: "Do the thing",
          initialPromptAttachments: [{
            id: "image-1",
            name: "reference.png",
            previewUrl: "data:image/png;base64,cG5n",
            base64Data: "cG5n",
          }],
        },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await expect(service.reconcileInitialLaunch("env-1"))
          .rejects.toThrow("prompt is too long");

        const environment = await storage.getEnvironment("env-1");
        // A verdict on the prompt is not a transient fault: retrying it every
        // ten seconds forever keeps the environment polled for the app's life.
        expect(environment).toMatchObject({
          pendingAgentLaunch: false,
          startupAgentSession: {
            status: "error",
            error: "The agent rejected the initial prompt: prompt is too long",
          },
        });
        expect(environment?.initialPromptAttachments).toBeUndefined();
        expect(internals(service).launchRetryAt.has("env-1")).toBe(false);
        expect(send).toHaveBeenCalledTimes(1);
      });
    });

    test("retries a transiently failed startup launch after a delay", async () => {
      const { provider } = createProviderStub("codex", {
        send: async () => {
          throw new ProviderUnavailableError("bridge is offline");
        },
      });
      await withService({
        prefix: "orkestrator-native-launch-transient-",
        environment: {
          pendingAgentLaunch: true,
          defaultAgent: "codex",
          codexMode: "native",
          initialPrompt: "Do the thing",
          initialPromptAttachments: [{
            id: "image-1",
            name: "reference.png",
            previewUrl: "data:image/png;base64,cG5n",
            base64Data: "cG5n",
          }],
        },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const before = Date.now();
        await expect(service.reconcileInitialLaunch("env-1"))
          .rejects.toThrow("bridge is offline");

        const environment = await storage.getEnvironment("env-1");
        expect(environment).toMatchObject({
          pendingAgentLaunch: true,
          startupAgentSession: {
            status: "error",
            error: "Agent launch failed; the backend will retry.",
          },
        });
        // The images must survive: the retry still needs something to attach.
        expect(environment?.initialPromptAttachments).toHaveLength(1);
        expect(internals(service).launchRetryAt.get("env-1"))
          .toBeGreaterThanOrEqual(before + 10_000);
      });
    });

    test("disposes providers whose environment has gone away", async () => {
      const alive = createProviderStub("codex");
      const doomed = createProviderStub("codex");
      const dataDir = await fs.mkdtemp(
        path.join(tmpdir(), "orkestrator-native-prune-"),
      );
      const storage = await createStorage(dataDir);
      await addEnvironment(storage);
      await storage.addEnvironment({
        ...(await storage.getEnvironment("env-1"))!,
        id: "env-2",
        worktreePath: "/tmp/env-2",
      });
      await storage.addEnvironment({
        ...(await storage.getEnvironment("env-1"))!,
        id: "env-3",
        worktreePath: "/tmp/env-3",
      });
      const service = new NativeAgentService(storage, refusingInvoke, {
        provider: async (input) =>
          input.environmentId === "env-1" ? alive.provider : doomed.provider,
      });
      try {
        for (const environmentId of ["env-1", "env-2", "env-3"]) {
          await service.ensureSession({
            environmentId,
            agent: "codex",
            logicalSessionKey: `env-${environmentId}:tab-1`,
          });
        }
        expect(internals(service).providers.size).toBe(3);

        await storage.updateEnvironment("env-2", {
          deletionRequestedAt: new Date().toISOString(),
        });
        await storage.removeEnvironment("env-3");
        await internals(service).reconcilePendingLaunches();

        // A cached provider for a departed environment holds its bridge
        // connection open for the life of the process.
        expect([...internals(service).providers.keys()])
          .toEqual(["env-1\u0000codex"]);
        expect(doomed.dispose).toHaveBeenCalledTimes(2);
        expect(alive.dispose).not.toHaveBeenCalled();
      } finally {
        await service.shutdown();
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    });
  });

  describe("input validation", () => {
    test.each([
      ["a blank environment ID", { environmentId: " " }],
      ["a blank logical session key", { logicalSessionKey: "" }],
      ["an unknown agent", { agent: "gemini" as unknown as "codex" }],
      ["an unknown interaction origin", {
        origin: "scheduled-task" as unknown as "interactive-native",
      }],
      ["a malformed interaction policy", {
        interactionPolicy: {
          ...INTERACTIVE_AGENT_INTERACTION_POLICY,
          unknown: "await-user",
        } as unknown as typeof INTERACTIVE_AGENT_INTERACTION_POLICY,
      }],
      ["an interactive policy for a workflow origin", {
        origin: "looped-review" as const,
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      }],
      ["an unattended policy without a workflow origin", {
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      }],
    ])("refuses a session request with %s", async (_label, override) => {
      const { provider, createSession } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-validate-ensure-",
        provider: async () => provider,
      }, async ({ service }) => {
        const input = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-1",
          ...override,
        };
        await expect(service.ensureSession(input))
          .rejects.toThrow("Invalid native agent session request");
        await expect(service.adoptSession({
          ...input,
          providerSessionId: "provider-session",
        })).rejects.toThrow("Invalid native agent session adoption request");
        expect(createSession).not.toHaveBeenCalled();
      });
    });

    test.each([
      ["a blank provider session ID", { providerSessionId: "  " }],
      ["a blank replacement expectation", { expectedProviderSessionId: " " }],
    ])("refuses an adoption with %s", async (_label, override) => {
      const { provider } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-validate-adopt-",
        provider: async () => provider,
      }, async ({ service }) => {
        await expect(service.adoptSession({
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: "env-env-1:tab-1",
          providerSessionId: "provider-session",
          ...override,
        })).rejects.toThrow("Invalid native agent session adoption request");
      });
    });

    test.each([
      ["a blank prompt", { prompt: "   " }],
      ["a blank request ID", { requestId: "" }],
    ])("refuses a dispatch with %s", async (_label, override) => {
      const { provider, send } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-validate-dispatch-",
        provider: async () => provider,
      }, async ({ service }) => {
        await expect(service.dispatchPrompt({
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: "env-env-1:tab-1",
          prompt: "Do it",
          requestId: "request-1",
          ...override,
        })).rejects.toThrow("prompt and request ID must not be blank");
        expect(send).not.toHaveBeenCalled();
      });
    });

    test("refuses to reuse a storage key that names another logical session", async () => {
      const { provider, createSession } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-validate-collision-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const logicalSessionKey = "env-env-1:tab-1";
        // Publish a record under the key this request will derive, but for a
        // different logical session — a hash collision or a miscomputed key.
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: "env-env-1:some-other-tab",
          providerSessionId: "provider-foreign",
        });

        await expect(service.ensureSession({
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey,
        })).rejects.toThrow("Native agent session key collision");
        expect(createSession).not.toHaveBeenCalled();
      });
    });
  });

  describe("queue draining", () => {
    test("drains two queued prompts in prompt and request order", async () => {
      const dispatched: Array<{ prompt: string; requestId: string }> = [];
      const { provider, send } = createProviderStub("codex", {
        send: async (_sessionId, prompt, options) => {
          dispatched.push({ prompt, requestId: options.requestId });
        },
      });
      await withService({
        prefix: "orkestrator-native-drain-order-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const queueKey = "codex\u0000env-env-1:tab-1";
        await storage.savePromptQueue(queueKey, "env-1", [
          { id: "row-1", requestId: "request-1", text: "First prompt" },
          { id: "row-2", requestId: "request-2", text: "Second prompt" },
        ]);

        await internals(service).drainPromptQueues();
        await internals(service).drainPromptQueues();

        expect(dispatched).toEqual([
          { prompt: "First prompt", requestId: "request-1" },
          { prompt: "Second prompt", requestId: "request-2" },
        ]);
        expect(send).toHaveBeenCalledTimes(2);
        const queue = await storage.getPromptQueue(queueKey);
        expect(queue).toMatchObject({ messages: [] });
        expect(queue?.inFlight).toBeUndefined();
        expect(queue?.dispatchError).toBeUndefined();
      });
    });

    test.each([
      ["reasoningEffort", { reasoningEffort: "high" }],
      ["effort", { effort: "high" }],
      ["variant", { variant: "high" }],
    ])("forwards a queued %s alias as the provider effort", async (
      _label,
      effortField,
    ) => {
      const { provider, send, createSession } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-drain-effort-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await storage.savePromptQueue("codex\u0000env-env-1:tab-1", "env-1", [
          { id: "row-1", text: "Do it", model: "queued-model", ...effortField },
        ]);

        await internals(service).drainPromptQueues();

        expect(createSession).toHaveBeenCalledWith(
          "build",
          "Agent Session",
          expect.objectContaining({ model: "queued-model", effort: "high" }),
        );
        expect(send).toHaveBeenCalledWith(
          "provider-session",
          "Do it",
          expect.objectContaining({ model: "queued-model", effort: "high" }),
        );
      });
    });

    test("prefers reasoningEffort over its effort and variant aliases", async () => {
      const { provider, send } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-drain-effort-order-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await storage.savePromptQueue("codex\u0000env-env-1:tab-1", "env-1", [
          {
            id: "row-1",
            text: "Do it",
            reasoningEffort: "chosen",
            effort: "ignored",
            variant: "ignored-too",
          },
        ]);

        await internals(service).drainPromptQueues();

        expect(send).toHaveBeenCalledWith(
          "provider-session",
          "Do it",
          expect.objectContaining({ effort: "chosen" }),
        );
      });
    });

    test("forwards queued per-prompt claude options", async () => {
      const { provider, send } = createProviderStub("claude");
      await withService({
        prefix: "orkestrator-native-drain-options-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await storage.savePromptQueue("claude\u0000env-env-1:tab-1", "env-1", [
          {
            id: "row-1",
            text: "Review it",
            agent: "code-reviewer",
            includeLocalSettings: true,
            promptSuggestions: false,
            planModeEnabled: false,
          },
        ]);

        await internals(service).drainPromptQueues();

        // These were selected in the composer before the prompt was queued;
        // dropping them silently runs a different agent than the user chose.
        expect(send).toHaveBeenCalledWith(
          "provider-session",
          "Review it",
          expect.objectContaining({
            subAgent: "code-reviewer",
            includeLocalSettings: true,
            promptSuggestions: false,
          }),
        );
      });
    });

    test("passes queued attachments through as real attachments", async () => {
      const { provider, send } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-drain-attachments-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await storage.savePromptQueue("codex\u0000env-env-1:tab-1", "env-1", [{
          id: "row-1",
          text: "What is in this screenshot?",
          attachments: [{
            type: "image",
            path: "/workspace/.orkestrator/prompt-attachments/shot.png",
            dataUrl: "data:image/png;base64,cG5n",
            filename: "shot.png",
          }],
        }]);

        await internals(service).drainPromptQueues();

        // Flattening these into an "Attached workspace files:" list degraded an
        // image to a filename the model had to guess at.
        expect(send).toHaveBeenCalledWith(
          "provider-session",
          "What is in this screenshot?",
          expect.objectContaining({
            attachments: [{
              type: "image",
              path: "/workspace/.orkestrator/prompt-attachments/shot.png",
              dataUrl: "data:image/png;base64,cG5n",
              filename: "shot.png",
            }],
          }),
        );
      });
    });

    test("parks a queued prompt whose attachments are invalid", async () => {
      const { provider, send } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-drain-bad-attachments-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const queueKey = "codex\u0000env-env-1:tab-1";
        await storage.savePromptQueue(queueKey, "env-1", [{
          id: "row-1",
          text: "Look at this",
          attachments: [{ type: "image", dataUrl: "data:image/png;base64,cG5n" }],
        }]);

        await internals(service).drainPromptQueues();

        expect(send).not.toHaveBeenCalled();
        expect(await storage.getPromptQueue(queueKey)).toMatchObject({
          messages: [{ id: "row-1" }],
          dispatchError: {
            requestId: "row-1",
            message: "Prompt attachment path must be a non-empty string",
          },
        });
        // A validation failure is permanent, so the retry budget resets rather
        // than counting toward the transient-failure latch.
        expect(internals(service).queueAttempts.has(queueKey)).toBe(false);
        expect(internals(service).queueRetryAt.has(queueKey)).toBe(false);
      });
    });

    test("acknowledges and drops a reserved prompt with no text", async () => {
      const { provider, send } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-drain-blank-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const queueKey = "codex\u0000env-env-1:tab-1";
        await storage.savePromptQueue(queueKey, "env-1", [
          { id: "row-1", text: "   " },
          { id: "row-2", text: "Real work" },
        ]);

        await internals(service).drainPromptQueues();

        expect(send).not.toHaveBeenCalled();
        const queue = await storage.getPromptQueue(queueKey);
        // Leaving the reservation in place would wedge the queue behind a
        // prompt that can never be sent.
        expect(queue).toMatchObject({ messages: [{ id: "row-2" }] });
        expect(queue?.inFlight).toBeUndefined();
        expect(queue?.dispatchError).toBeUndefined();

        await internals(service).drainPromptQueues();
        expect(send).toHaveBeenCalledWith(
          "provider-session",
          "Real work",
          expect.anything(),
        );
      });
    });

    test("leaves a queue alone when the head cannot be reserved", async () => {
      const { provider, send } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-drain-unreservable-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const queueKey = "codex\u0000env-env-1:tab-1";
        // No `id`, so the reservation cannot produce a durable request id.
        await storage.savePromptQueue(queueKey, "env-1", [{ text: "No identity" }]);

        await internals(service).drainPromptQueues();

        expect(send).not.toHaveBeenCalled();
        const queue = await storage.getPromptQueue(queueKey);
        expect(queue).toMatchObject({ messages: [{ text: "No identity" }] });
        expect(queue?.inFlight).toBeUndefined();
      });
    });

    test.each([
      ["no separator", "codex"],
      ["an empty agent", "\u0000env-env-1:tab-1"],
      ["an unknown agent", "gemini\u0000env-env-1:tab-1"],
      ["a blank logical session key", "codex\u0000   "],
    ])("ignores a queue key with %s", async (_label, queueKey) => {
      const { provider, createSession, send } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-drain-badkey-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await storage.savePromptQueue(queueKey, "env-1", [
          { id: "row-1", text: "Do it" },
        ]);

        await internals(service).drainPromptQueueOnce(queueKey);

        expect(createSession).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(await storage.getPromptQueue(queueKey)).toMatchObject({
          messages: [{ id: "row-1" }],
        });
      });
    });

    test.each([
      ["a stopped environment", { status: "stopped" }],
      ["an environment still running setup", { setupScriptsComplete: false }],
    ] as const)("does not start agents for %s", async (_label, environment) => {
      const { provider, createSession, send } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-drain-notready-",
        environment,
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const queueKey = "codex\u0000env-env-1:tab-1";
        await storage.savePromptQueue(queueKey, "env-1", [
          { id: "row-1", text: "Do it" },
        ]);

        await internals(service).drainPromptQueues();

        // Without this gate a leftover queued prompt spawns bridge servers and
        // attempts dispatch every two seconds against a dead environment.
        expect(createSession).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(await storage.getPromptQueue(queueKey)).toMatchObject({
          messages: [{ id: "row-1" }],
        });
        expect(internals(service).queueRetryAt.get(queueKey))
          .toBeGreaterThan(Date.now());
      });
    });

    test("backs off exponentially and then parks a repeatedly failing dispatch", async () => {
      const { provider, send } = createProviderStub("codex", {
        send: async () => {
          throw new ProviderUnavailableError("bridge is offline");
        },
      });
      await withService({
        prefix: "orkestrator-native-drain-backoff-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const queueKey = "codex\u0000env-env-1:tab-1";
        await storage.savePromptQueue(queueKey, "env-1", [
          { id: "row-1", text: "Do it" },
        ]);

        const observed: number[] = [];
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          const before = Date.now();
          await internals(service).drainPromptQueues();
          observed.push(internals(service).queueRetryAt.get(queueKey)! - before);
          expect(internals(service).queueAttempts.get(queueKey)).toBe(attempt);
          // Only the backoff should hold the queue back, so clear it to reach
          // the next attempt without waiting.
          internals(service).queueRetryAt.delete(queueKey);
        }
        expect(observed.map((delay) => Math.round(delay / 1_000)))
          .toEqual([2, 4, 8, 16]);

        await internals(service).drainPromptQueues();

        expect(send).toHaveBeenCalledTimes(5);
        // An unbounded 2s retry is invisible: nothing is latched and the user
        // sees a queue that simply never drains.
        expect(await storage.getPromptQueue(queueKey)).toMatchObject({
          messages: [{ id: "row-1" }],
          dispatchError: {
            requestId: "row-1",
            message: "ProviderUnavailableError",
          },
        });
        expect(internals(service).queueAttempts.has(queueKey)).toBe(false);
        expect(internals(service).queueRetryAt.has(queueKey)).toBe(false);
      });
    });

    test("clears the retry budget once a dispatch succeeds", async () => {
      let failures = 0;
      const { provider } = createProviderStub("codex", {
        send: async () => {
          failures += 1;
          if (failures === 1) throw new ProviderUnavailableError("busy");
        },
      });
      await withService({
        prefix: "orkestrator-native-drain-recover-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const queueKey = "codex\u0000env-env-1:tab-1";
        await storage.savePromptQueue(queueKey, "env-1", [
          { id: "row-1", text: "Do it" },
        ]);

        await internals(service).drainPromptQueues();
        expect(internals(service).queueAttempts.get(queueKey)).toBe(1);

        internals(service).queueRetryAt.delete(queueKey);
        await internals(service).drainPromptQueues();

        // A recovered queue must start from a clean budget, or five failures
        // spread over a week would eventually park a healthy queue.
        expect(internals(service).queueAttempts.has(queueKey)).toBe(false);
        expect(internals(service).queueRetryAt.has(queueKey)).toBe(false);
        expect((await storage.getPromptQueue(queueKey))?.dispatchError)
          .toBeUndefined();
      });
    });

    test("keeps draining other queues when one queue's storage read fails", async () => {
      const dispatched: string[] = [];
      const { provider } = createProviderStub("codex", {
        send: async (_sessionId, prompt) => {
          dispatched.push(prompt);
        },
      });
      await withService({
        prefix: "orkestrator-native-drain-read-failure-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const brokenKey = "codex\u0000env-env-1:tab-broken";
        const healthyKey = "codex\u0000env-env-1:tab-healthy";
        await storage.savePromptQueue(brokenKey, "env-1", [
          { id: "row-1", text: "Unreadable" },
        ]);
        await storage.savePromptQueue(healthyKey, "env-1", [
          { id: "row-2", text: "Readable" },
        ]);
        const readQueue = storage.getPromptQueue.bind(storage);
        storage.getPromptQueue = async (queueKey: string) => {
          if (queueKey === brokenKey) throw new Error("prompt-queues.json is unreadable");
          return readQueue(queueKey);
        };

        try {
          await internals(service).drainPromptQueues();
        } finally {
          storage.getPromptQueue = readQueue;
        }

        expect(dispatched).toEqual(["Readable"]);
        expect(await storage.getPromptQueue(brokenKey)).toMatchObject({
          messages: [{ id: "row-1" }],
        });
        // A storage fault bypasses every inner handler, so without an outer
        // guard the scan retried this queue every two seconds forever with no
        // attempt counter and nothing logged.
        expect(internals(service).queueRetryAt.has(brokenKey)).toBe(true);
        expect(internals(service).queueAttempts.get(brokenKey)).toBe(1);
        expect(internals(service).queueRetryAt.has(healthyKey)).toBe(false);
      });
    });

    test("keeps draining other queues when one reservation fails", async () => {
      const dispatched: string[] = [];
      const { provider } = createProviderStub("codex", {
        send: async (_sessionId, prompt) => {
          dispatched.push(prompt);
        },
      });
      await withService({
        prefix: "orkestrator-native-drain-reserve-failure-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const brokenKey = "codex\u0000env-env-1:tab-broken";
        const healthyKey = "codex\u0000env-env-1:tab-healthy";
        await storage.savePromptQueue(brokenKey, "env-1", [
          { id: "row-1", text: "Unreservable" },
        ]);
        await storage.savePromptQueue(healthyKey, "env-1", [
          { id: "row-2", text: "Readable" },
        ]);
        const reserve = storage.reservePromptQueueHeadForDispatch.bind(storage);
        storage.reservePromptQueueHeadForDispatch = async (queueKey: string) => {
          if (queueKey === brokenKey) throw new Error("lock acquisition failed");
          return reserve(queueKey);
        };

        try {
          await internals(service).drainPromptQueues();
        } finally {
          storage.reservePromptQueueHeadForDispatch = reserve;
        }

        expect(dispatched).toEqual(["Readable"]);
        const broken = await storage.getPromptQueue(brokenKey);
        // Nothing was reserved, so the prompt is still queued rather than
        // stranded in an in-flight record no dispatch owns.
        expect(broken).toMatchObject({ messages: [{ id: "row-1" }] });
        expect(broken?.inFlight).toBeUndefined();
        // And the failure is counted, so the queue backs off instead of being
        // retried on every two-second scan indefinitely.
        expect(internals(service).queueRetryAt.has(brokenKey)).toBe(true);
        expect(internals(service).queueAttempts.get(brokenKey)).toBe(1);
      });
    });

    test("parks a queue whose storage keeps failing", async () => {
      const { provider } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-drain-read-latch-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const queueKey = "codex\u0000env-env-1:tab-broken";
        await storage.savePromptQueue(queueKey, "env-1", [
          { id: "row-1", text: "Unreadable" },
        ]);
        const readQueue = storage.getPromptQueue.bind(storage);
        storage.getPromptQueue = async (key: string) => {
          if (key === queueKey) throw new Error("prompt-queues.json is unreadable");
          return readQueue(key);
        };

        try {
          // Exhaust the attempt budget. There is no reservation to park against,
          // so the queue must keep backing off — but the backoff has to grow
          // rather than stay pinned at the two-second scan interval.
          const delays: number[] = [];
          for (let attempt = 0; attempt < 4; attempt += 1) {
            internals(service).queueRetryAt.delete(queueKey);
            await internals(service).drainPromptQueues();
            delays.push(
              (internals(service).queueRetryAt.get(queueKey) ?? 0) - Date.now(),
            );
          }
          expect(internals(service).queueAttempts.get(queueKey)).toBe(4);
          expect(delays[3]!).toBeGreaterThan(delays[0]!);
        } finally {
          storage.getPromptQueue = readQueue;
        }
      });
    });
  });

  describe("environment renaming from the first queued prompt", () => {
    test.each([
      ["a legacy timestamp name", "20260729-174746"],
      ["a compact timestamp name", "202607291747460"],
    ])("renames an environment that still has %s", async (_label, name) => {
      const { provider } = createProviderStub("codex");
      const invoked: Array<{ command: string; args?: Record<string, unknown> }> = [];
      await withService({
        prefix: "orkestrator-native-rename-",
        environment: { name },
        provider: async () => provider,
        invoke: (async <T>(
          command: string,
          args?: Record<string, unknown>,
        ): Promise<T> => {
          invoked.push({ command, args });
          return undefined as T;
        }) as Invoke,
      }, async ({ storage, service }) => {
        await storage.savePromptQueue("codex\u0000env-env-1:tab-1", "env-1", [
          { id: "row-1", text: "Add a login page" },
        ]);

        await internals(service).drainPromptQueues();

        expect(invoked).toEqual([{
          command: "rename_environment_from_prompt",
          args: { environmentId: "env-1", prompt: "Add a login page" },
        }]);
      });
    });

    test("leaves a user-visible name and an already-used session alone", async () => {
      const { provider, send } = createProviderStub("codex");
      const invoked: string[] = [];
      const invoke = (async <T>(command: string): Promise<T> => {
        invoked.push(command);
        return undefined as T;
      }) as Invoke;
      await withService({
        prefix: "orkestrator-native-rename-skip-",
        environment: { name: "Login page work" },
        provider: async () => provider,
        invoke,
      }, async ({ storage, service }) => {
        await storage.savePromptQueue("codex\u0000env-env-1:tab-1", "env-1", [
          { id: "row-1", text: "Add a login page" },
        ]);
        await internals(service).drainPromptQueues();
        expect(invoked).toEqual([]);
        expect(send).toHaveBeenCalledTimes(1);
      });

      const second = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-rename-second-",
        environment: { name: "20260729-174746" },
        provider: async () => second.provider,
        invoke,
      }, async ({ storage, service }) => {
        const queueKey = "codex\u0000env-env-1:tab-1";
        await storage.savePromptQueue(queueKey, "env-1", [
          { id: "row-1", text: "First prompt" },
          { id: "row-2", text: "Second prompt" },
        ]);
        await internals(service).drainPromptQueues();
        await internals(service).drainPromptQueues();
        // Only the first prompt of a session names the environment; the second
        // would overwrite a name derived from the work that is already running.
        expect(invoked).toEqual(["rename_environment_from_prompt"]);
      });
    });

    test("dispatches the prompt even when renaming fails", async () => {
      const { provider, send } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-rename-failure-",
        environment: { name: "20260729-174746" },
        provider: async () => provider,
        invoke: (async <T>(): Promise<T> => {
          throw new Error("rename command is unavailable");
        }) as Invoke,
      }, async ({ storage, service }) => {
        const queueKey = "codex\u0000env-env-1:tab-1";
        await storage.savePromptQueue(queueKey, "env-1", [
          { id: "row-1", text: "Add a login page" },
        ]);

        await internals(service).drainPromptQueues();

        // The name is cosmetic; the dispatch is not.
        expect(send).toHaveBeenCalledWith(
          "provider-session",
          "Add a login page",
          expect.anything(),
        );
        const queue = await storage.getPromptQueue(queueKey);
        expect(queue).toMatchObject({ messages: [] });
        expect(queue?.dispatchError).toBeUndefined();
      });
    });
  });

  test("rejects provider session creation when deletion intent wins the environment lock", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-delete-create-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    await storage.updateEnvironment("env-1", {
      deletionRequestedAt: new Date().toISOString(),
    });
    const createSession = mock(async () => "provider-session");
    const provider = {
      agent: "opencode",
      createSession,
      registerSession: () => undefined,
      send: async () => undefined,
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as BuildPipelineProvider;
    const service = new NativeAgentService(storage, async <T>(): Promise<T> => {
      throw new Error("unused");
    }, { provider: async () => provider });
    try {
      await expect(service.ensureSession({
        environmentId: "env-1",
        agent: "opencode",
        logicalSessionKey: "env-env-1:tab-1",
      })).rejects.toThrow("unavailable");
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
