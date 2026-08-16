import { describe,expect,mock,test } from "bun:test";


import { promises as fs } from "node:fs";


import { tmpdir } from "node:os";


import path from "node:path";


import {
type BuildPipeline,
type BuildPipelineAgent
} from "@orkestrator/protocol/build-pipeline";




import {
AGENT_INTERACTION_CONTRACT_VERSION,
UNATTENDED_AGENT_INTERACTION_POLICY,
type AgentInteractionSnapshot
} from "@orkestrator/protocol/agent-interactions";


import {
PromptRejectedError,
ProviderUnavailableError,
type AgentInteractionProviderCapability,
type AgentSessionProvider,
type BridgeConnection,
type NativeAgentRuntimeProvider,
type ProviderActivityState,
type ProviderInteractiveSnapshot,
type ProviderSendOptions,
type ProviderStatus
} from "./native-agent-provider.js";


import type { Environment } from "./models.js";


import {
NativeAgentService,
nativeAgentSessionStorageKey,
type AgentInteractionObservation,
type EnsureNativeAgentSessionInput,
type NativeAgentServiceOptions
} from "./native-agent-service.js";


import { StorageService } from "./storage.js";


import {
OPENCODE_INCOMPLETE_TURN_CONTINUATION,
openCodeIncompleteTurnRequestId,
} from "./opencode-turn-recovery.js";



type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;



/** The default for every test whose provider is injected and stages nothing. */
const refusingInvoke: Invoke = async <T>(command: string): Promise<T> => {
  throw new Error(`Unexpected backend command: ${command}`);
};



/** Polls until a fire-and-forget drain pass has observable side effects. */
async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for background drain work");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}



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
    messages?: (sessionId: string) => Promise<unknown[]>;
    interactiveSnapshot?: (
      sessionId: string,
    ) => Promise<ProviderInteractiveSnapshot>;
    modelCatalog?: NativeAgentRuntimeProvider["modelCatalog"];
    rawModelCatalog?: NativeAgentRuntimeProvider["rawModelCatalog"];
    abort?: (sessionId: string) => Promise<void>;
    stopBackgroundTask?: NativeAgentRuntimeProvider["stopBackgroundTask"];
    dismissSuggestedPrompt?: NativeAgentRuntimeProvider["dismissSuggestedPrompt"];
    updateInteractiveControls?: NativeAgentRuntimeProvider["updateInteractiveControls"];
    slashCommands?: NativeAgentRuntimeProvider["slashCommands"];
    refreshCatalog?: NativeAgentRuntimeProvider["refreshCatalog"];
    prepareDispatch?: NativeAgentRuntimeProvider["prepareDispatch"];
    dispatchStatus?: NativeAgentRuntimeProvider["dispatchStatus"];
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
  const abort = mock(behaviour.abort ?? (async () => undefined));
  const stopBackgroundTask = behaviour.stopBackgroundTask
    ? mock(behaviour.stopBackgroundTask)
    : undefined;
  const dismissSuggestedPrompt = behaviour.dismissSuggestedPrompt
    ? mock(behaviour.dismissSuggestedPrompt)
    : undefined;
  const interactiveSnapshot = behaviour.interactiveSnapshot
    ? mock(behaviour.interactiveSnapshot)
    : undefined;
  const modelCatalog = behaviour.modelCatalog
    ? mock(behaviour.modelCatalog)
    : undefined;
  const rawModelCatalog = behaviour.rawModelCatalog
    ? mock(behaviour.rawModelCatalog)
    : undefined;
  const updateInteractiveControls = behaviour.updateInteractiveControls
    ? mock(behaviour.updateInteractiveControls)
    : undefined;
  const slashCommands = behaviour.slashCommands
    ? mock(behaviour.slashCommands)
    : undefined;
  const refreshCatalog = behaviour.refreshCatalog
    ? mock(behaviour.refreshCatalog)
    : undefined;
  const prepareDispatch = behaviour.prepareDispatch
    ? mock(behaviour.prepareDispatch)
    : undefined;
  const dispatchStatus = behaviour.dispatchStatus
    ? mock(behaviour.dispatchStatus)
    : undefined;
  const provider = {
    agent,
    createSession,
    registerSession,
    send,
    status,
    activity,
    activityBatch,
    interactions: behaviour.interactions,
    messages: behaviour.messages ?? (async () => []),
    interactiveSnapshot,
    modelCatalog,
    rawModelCatalog,
    updateInteractiveControls,
    slashCommands,
    refreshCatalog,
    structured: async () => null,
    abort,
    stopBackgroundTask,
    dismissSuggestedPrompt,
    prepareDispatch,
    dispatchStatus,
    dispose,
  } as unknown as NativeAgentRuntimeProvider;
  return {
    provider,
    prepareDispatch,
    dispatchStatus,
    createSession,
    registerSession,
    send,
    status,
    activity,
    activityBatch,
    abort,
    stopBackgroundTask,
    dismissSuggestedPrompt,
    interactiveSnapshot,
    modelCatalog,
    rawModelCatalog,
    updateInteractiveControls,
    slashCommands,
    refreshCatalog,
    dispose,
  };
}



/** Reach the timer-driven scans and backoff bookkeeping the service keeps private. */
function internals(service: NativeAgentService) {
  return service as unknown as {
    drainPromptQueues(): Promise<void>;
    drainPromptQueueOnce(queueKey: string): Promise<void>;
    reconcilePendingLaunches(): Promise<void>;
    provider(input: EnsureNativeAgentSessionInput): Promise<AgentSessionProvider>;
    bridgeConnection(
      agent: BuildPipelineAgent,
      environment: Environment,
      model?: string,
      effort?: string,
    ): Promise<BridgeConnection>;
    providers: Map<string, AgentSessionProvider>;
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
    projectionCache: Map<string, unknown>;
    projectionEpochs: Map<string, number>;
    projectionRefreshes: Map<string, Promise<unknown>>;
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
    delay?: NativeAgentServiceOptions["delay"];
    interactionMonitorMode?: NativeAgentServiceOptions["interactionMonitorMode"];
    interactionMonitorAdoptionEnabled?: boolean;
    interactionMonitorIntervalMs?: number;
    interactionMonitorMaxConcurrency?: number;
    interactionMonitorMaxSessionsPerEnvironment?: number;
    interactionMonitorRetryBaseMs?: number;
    interactionMonitorMaxRetries?: number;
    onActivityTransition?: NativeAgentServiceOptions["onActivityTransition"];
    onInteractionObservation?: NativeAgentServiceOptions["onInteractionObservation"];
    toolDetailCacheMaxEntries?: number;
    toolDetailCacheMaxBytes?: number;
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
      ...(setup.delay ? { delay: setup.delay } : {}),
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
      ...(setup.onActivityTransition
        ? { onActivityTransition: setup.onActivityTransition }
        : {}),
      ...(setup.onInteractionObservation
        ? { onInteractionObservation: setup.onInteractionObservation }
        : {}),
      ...(setup.toolDetailCacheMaxEntries === undefined
        ? {}
        : { toolDetailCacheMaxEntries: setup.toolDetailCacheMaxEntries }),
      ...(setup.toolDetailCacheMaxBytes === undefined
        ? {}
        : { toolDetailCacheMaxBytes: setup.toolDetailCacheMaxBytes }),
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



async function seedLoopedReviewNativeSessions(
  storage: StorageService,
  count: number,
  logicalSessionKeyForIndex: (index: number) => string,
): Promise<void> {
  const timestamp = new Date(0).toISOString();
  const sessions = Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const logicalSessionKey = logicalSessionKeyForIndex(index);
    const key = nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey);
    return [key, {
      version: 1,
      key,
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey,
      providerSessionId: `provider-${index}`,
      origin: "looped-review",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
  }));
  await fs.writeFile(
    path.join(storage.getDataDir(), "native-agent-sessions.json"),
    `${JSON.stringify(sessions)}\n`,
  );
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
    ): Promise<AgentSessionProvider> => createProviderStub("codex", {
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
      // This test exercises the service's 512-request and 64-observation
      // bounds, not StorageService's per-record persistence path. Seeding the
      // valid durable snapshot once avoids 520 serialized rewrites of a growing
      // JSON file, which could exceed Bun's test timeout under aggregate load.
      await seedLoopedReviewNativeSessions(
        storage,
        520,
        (index) => `looped-review:workflow:phase-${index}:Review`,
      );
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
      await waitForCondition(
        () => listPendingInteractions.mock.calls.length > afterInit,
      );
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



  test("does not arm an interaction timer while observation is disabled", async () => {
    await withService({
      prefix: "orkestrator-native-interaction-disabled-timer-",
    }, async ({ service }) => {
      await service.init();
      expect(internals(service).launchTimer).not.toBeNull();
      expect(internals(service).interactionTimer).toBeNull();
    });
  });



  test("emits each provider session activity transition once", async () => {
    let activityState: ProviderActivityState = "working";
    const { provider } = createProviderStub("codex", {
      activity: async () => activityState,
    });
    const transitions: Array<Parameters<
      NonNullable<NativeAgentServiceOptions["onActivityTransition"]>
    >[0]> = [];
    const onActivityTransition: NonNullable<
      NativeAgentServiceOptions["onActivityTransition"]
    > = (event) => {
      transitions.push(event);
    };

    await withService({
      prefix: "orkestrator-native-activity-transition-event-",
      provider: async () => provider,
      onActivityTransition,
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
      await service.reconcileAgentActivity();
      activityState = "waiting";
      await service.reconcileAgentActivity();

      expect(transitions).toEqual([
        {
          environmentId: "env-1",
          sessionKey: key,
          providerSessionId: "provider-1",
          previousState: undefined,
          state: "working",
        },
        {
          environmentId: "env-1",
          sessionKey: key,
          providerSessionId: "provider-1",
          previousState: "working",
          state: "waiting",
        },
      ]);
    });
  });



  describe("OpenCode incomplete-turn recovery", () => {
    const stalledUser = {
      info: {
        id: "user-1",
        role: "user",
        request: {
          model: {
            providerID: "opencode-go",
            modelID: "deepseek-v4-flash",
          },
          agent: "reviewer",
          variant: "high",
        },
      },
      parts: [{ type: "text", text: "Review this branch" }],
    };
    const stalledAssistant = (id: string) => ({
      info: {
        id,
        role: "assistant",
        providerID: "opencode-go",
        modelID: "deepseek-v4-flash",
        agent: "build",
      },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "I still need to summarize" },
        { type: "step-finish", reason: "unknown" },
      ],
    });

    function recoveryTasks(service: NativeAgentService): Map<string, Promise<void>> {
      return (service as unknown as {
        openCodeRecoveryTasks: Map<string, Promise<void>>;
      }).openCodeRecoveryTasks;
    }

    test("continues a stalled interactive turn once, durably, then reports exhaustion", async () => {
      let activityState: ProviderActivityState = "working";
      let transcript: unknown[] = [stalledUser, stalledAssistant("assistant-1")];
      const { provider, send } = createProviderStub("opencode", {
        activity: async () => activityState,
        messages: async () => transcript,
      });

      await withService({
        prefix: "orkestrator-native-opencode-recovery-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const key = nativeAgentSessionStorageKey("env-1", "opencode", "tab-1");
        await storage.adoptNativeAgentSession({
          key,
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
        });

        await service.reconcileAgentActivity();
        activityState = "idle";
        await captureWarnings(async () => {
          await service.reconcileAgentActivity();
          await waitForCondition(() => send.mock.calls.length === 1);
          await waitForCondition(() => recoveryTasks(service).size === 0);
        });

        const [sessionId, prompt, options] = send.mock.calls[0]! as [
          string,
          string,
          ProviderSendOptions,
        ];
        expect(sessionId).toBe("provider-1");
        expect(prompt).toBe(OPENCODE_INCOMPLETE_TURN_CONTINUATION);
        expect(options).toMatchObject({
          requestId: openCodeIncompleteTurnRequestId("assistant-1"),
          model: "opencode-go/deepseek-v4-flash",
          executionAgent: "reviewer",
          effort: "high",
        });
        expect((await storage.getNativeAgentSession(key))?.dispatchedRequestIds)
          .toContain(openCodeIncompleteTurnRequestId("assistant-1"));

        // Provider acceptance marked the session working again; a re-observed
        // idle edge with an unchanged transcript must not double-send — the
        // durable request journal absorbs the retry.
        await captureWarnings(async () => {
          await service.reconcileAgentActivity();
          await waitForCondition(() => recoveryTasks(service).size === 0);
        });
        expect(send).toHaveBeenCalledTimes(1);

        // The continuation ran and stalled again: the continuation prompt is
        // now the latest user turn, so recovery reports exhaustion and stops.
        transcript = [
          stalledUser,
          stalledAssistant("assistant-1"),
          {
            info: { id: "user-2", role: "user" },
            parts: [{ type: "text", text: OPENCODE_INCOMPLETE_TURN_CONTINUATION }],
          },
          stalledAssistant("assistant-2"),
        ];
        activityState = "working";
        await service.reconcileAgentActivity();
        activityState = "idle";
        const warnings = await captureWarnings(async () => {
          await service.reconcileAgentActivity();
          await waitForCondition(() => recoveryTasks(service).size === 0);
        });
        expect(send).toHaveBeenCalledTimes(1);
        expect(warnings.join("\n")).toContain("incomplete again");
        expect((await storage.getNativeAgentSession(key))?.openCodeIncompleteTurnNotice)
          .toMatchObject({
            kind: "exhausted",
            assistantMessageId: "assistant-2",
          });
      });
    });

    test("recovers an incomplete transcript on the first idle snapshot after restart", async () => {
      const { provider, send } = createProviderStub("opencode", {
        activity: async () => "idle",
        messages: async () => [stalledUser, stalledAssistant("assistant-startup")],
      });

      await withService({
        prefix: "orkestrator-native-opencode-recovery-startup-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "opencode", "tab-1"),
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
        });
        await captureWarnings(async () => {
          await service.reconcileAgentActivity();
          await waitForCondition(() => send.mock.calls.length === 1);
          await waitForCondition(() => recoveryTasks(service).size === 0);
        });
        expect(send).toHaveBeenCalledTimes(1);
      });
    });

    test("retries a transient transcript failure while the session remains idle", async () => {
      let now = 1_000;
      let messageReads = 0;
      const { provider, send } = createProviderStub("opencode", {
        activity: async () => "idle",
        messages: async () => {
          messageReads += 1;
          if (messageReads === 1) throw new Error("temporary transcript failure");
          return [stalledUser, stalledAssistant("assistant-retry")];
        },
      });

      await withService({
        prefix: "orkestrator-native-opencode-recovery-transient-",
        provider: async () => provider,
        now: () => now,
      }, async ({ storage, service }) => {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "opencode", "tab-1"),
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
        });

        await captureWarnings(async () => {
          await service.reconcileAgentActivity();
          await waitForCondition(() => recoveryTasks(service).size === 0);
        });
        expect(send).not.toHaveBeenCalled();

        now += 2_000;
        await captureWarnings(async () => {
          await service.reconcileAgentActivity();
          await waitForCondition(() => send.mock.calls.length === 1);
          await waitForCondition(() => recoveryTasks(service).size === 0);
        });
        expect(send).toHaveBeenCalledTimes(1);
      });
    });

    test("rechecks a queue that appears while the recovery transcript is loading", async () => {
      let reads = 0;
      let releaseRead!: () => void;
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const { provider, send } = createProviderStub("opencode", {
        activity: async () => "idle",
        messages: async () => {
          reads += 1;
          if (reads === 2) await readGate;
          return [stalledUser, stalledAssistant("assistant-race")];
        },
      });

      await withService({
        prefix: "orkestrator-native-opencode-recovery-queue-race-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "opencode", "tab-1"),
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
        });
        await storage.setOpenCodeIncompleteTurnNotice(
          nativeAgentSessionStorageKey("env-1", "opencode", "tab-1"),
          "provider-1",
          {
            kind: "failed",
            assistantMessageId: "assistant-manual-race",
            updatedAt: new Date().toISOString(),
          },
        );

        const reconcile = service.reconcileAgentActivity();
        await waitForCondition(() => reads === 2);
        await storage.savePromptQueue("opencode\0tab-1", "env-1", [
          { id: "new-user-prompt", text: "Do this instead" },
        ]);
        releaseRead();
        await reconcile;
        await waitForCondition(() => recoveryTasks(service).size === 0);
        expect(send).not.toHaveBeenCalled();
      });
    });

    test("a manual prompt claim suppresses a stale automatic continuation", async () => {
      let reads = 0;
      let releaseRead!: () => void;
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const { provider, send } = createProviderStub("opencode", {
        activity: async () => "idle",
        messages: async () => {
          reads += 1;
          if (reads === 2) await readGate;
          return [stalledUser, stalledAssistant("assistant-manual-race")];
        },
      });

      await withService({
        prefix: "orkestrator-native-opencode-recovery-manual-race-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "opencode", "tab-1"),
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
        });

        const reconcile = service.reconcileAgentActivity();
        await waitForCondition(() => reads === 2);
        const claim = service.claimOpenCodeManualPrompt({
          environmentId: "env-1",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
          requestId: "manual-1",
        });
        // The claim is published synchronously, but its durable notice cleanup
        // waits behind the recovery dispatch lock. Let the transcript read
        // finish so recovery can observe the claim and release that lock.
        releaseRead();
        await claim;
        expect((await storage.getNativeAgentSession(
          nativeAgentSessionStorageKey("env-1", "opencode", "tab-1"),
        ))?.openCodeIncompleteTurnNotice).toBeUndefined();
        await reconcile;
        await waitForCondition(() => recoveryTasks(service).size === 0);
        expect(send).not.toHaveBeenCalled();
        service.releaseOpenCodeManualPrompt({
          environmentId: "env-1",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
          requestId: "manual-1",
        });
      });
    });

    test("rejects a manual prompt during the final automatic dispatch handoff", async () => {
      let releaseSend!: () => void;
      const sendGate = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      const { provider, send } = createProviderStub("opencode", {
        activity: async () => "idle",
        messages: async () => [
          stalledUser,
          stalledAssistant("assistant-final-handoff"),
        ],
      });
      send.mockImplementation(async () => {
        await sendGate;
      });

      await withService({
        prefix: "orkestrator-native-opencode-recovery-final-handoff-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "opencode", "tab-1"),
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
        });

        await captureWarnings(async () => {
          await service.reconcileAgentActivity();
          await waitForCondition(() => send.mock.calls.length === 1);
          await expect(service.claimOpenCodeManualPrompt({
            environmentId: "env-1",
            logicalSessionKey: "tab-1",
            providerSessionId: "provider-1",
            requestId: "manual-overlap",
          })).rejects.toThrow("automatic recovery is already being sent");
          releaseSend();
          await waitForCondition(() => recoveryTasks(service).size === 0);
        });

        await service.claimOpenCodeManualPrompt({
          environmentId: "env-1",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
          requestId: "manual-after-recovery",
        });
        service.releaseOpenCodeManualPrompt({
          environmentId: "env-1",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
          requestId: "manual-after-recovery",
        });
      });
    });

    test("persists a visible failure notice when continuation dispatch fails", async () => {
      const { provider, send } = createProviderStub("opencode", {
        activity: async () => "idle",
        messages: async () => [stalledUser, stalledAssistant("assistant-failed")],
      });
      send.mockRejectedValue(new Error("provider unavailable"));

      await withService({
        prefix: "orkestrator-native-opencode-recovery-failed-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const key = nativeAgentSessionStorageKey("env-1", "opencode", "tab-1");
        await storage.adoptNativeAgentSession({
          key,
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
        });

        await captureWarnings(async () => {
          await service.reconcileAgentActivity();
          await waitForCondition(() => recoveryTasks(service).size === 0);
        });
        expect((await storage.getNativeAgentSession(key))?.openCodeIncompleteTurnNotice)
          .toMatchObject({
            kind: "failed",
            assistantMessageId: "assistant-failed",
          });
      });
    });

    test("does not continue unattended sessions or turns with queued prompts", async () => {
      let activityState: ProviderActivityState = "working";
      const { provider, send } = createProviderStub("opencode", {
        activity: async () => activityState,
        messages: async () => [stalledUser, stalledAssistant("assistant-1")],
      });

      await withService({
        prefix: "orkestrator-native-opencode-recovery-skip-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const pipelineKey = nativeAgentSessionStorageKey(
          "env-1",
          "opencode",
          "pipeline-tab",
        );
        await storage.adoptNativeAgentSession({
          key: pipelineKey,
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "pipeline-tab",
          providerSessionId: "provider-pipeline",
          origin: "build-pipeline",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        });
        const queuedKey = nativeAgentSessionStorageKey(
          "env-1",
          "opencode",
          "queued-tab",
        );
        await storage.adoptNativeAgentSession({
          key: queuedKey,
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "queued-tab",
          providerSessionId: "provider-queued",
        });
        // A queued user prompt supersedes the automatic continuation.
        await storage.savePromptQueue("opencode\0queued-tab", "env-1", [
          { id: "queued-1", text: "The user's own next prompt" },
        ]);

        await service.reconcileAgentActivity();
        activityState = "idle";
        await captureWarnings(async () => {
          await service.reconcileAgentActivity();
          await waitForCondition(() => recoveryTasks(service).size === 0);
        });
        expect(send).not.toHaveBeenCalled();
      });
    });
  });



  test("reports one session completion while another same-provider tab stays working", async () => {
    let clock = Date.now();
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
      now: () => clock,
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
      const beforeCompletion = (await storage.getEnvironment("env-1"))!;
      expect(beforeCompletion.agentActivityState).toBe("working");
      expect(beforeCompletion.hasUnreadWork).not.toBe(true);

      clock += 1_000;
      sessionActivity.set("provider-resolve", "idle");
      await service.reconcileAgentActivity();

      expect(invoked).toHaveLength(1);
      const completed = (await storage.getEnvironment("env-1"))!;
      expect(completed).toMatchObject({
        agentActivityState: "working",
        hasUnreadWork: true,
      });
      expect(Date.parse(completed.lastActivityAt!))
        .toBeGreaterThan(Date.parse(beforeCompletion.lastActivityAt!));
    });
  });



  test("retries durable session completion before accepting the terminal observation", async () => {
    let clock = Date.now();
    let activityState: ProviderActivityState = "working";
    const { provider } = createProviderStub("codex", {
      activity: async () => activityState,
    });

    await withService({
      prefix: "orkestrator-native-completion-persistence-retry-",
      provider: async () => provider,
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
      await service.reconcileAgentActivity();

      const originalRecord = storage.recordEnvironmentSessionCompletion.bind(storage);
      let attempts = 0;
      storage.recordEnvironmentSessionCompletion = (async (...args) => {
        attempts += 1;
        if (attempts === 1) throw new Error("disk unavailable");
        return originalRecord(...args);
      }) as typeof storage.recordEnvironmentSessionCompletion;
      const warnings = await captureWarnings(async () => {
        clock += 1_000;
        activityState = "idle";
        await service.reconcileAgentActivity();
        expect(internals(service).observedSessionActivity.get(key)?.state).toBe("working");

        clock += 2_000;
        await service.reconcileAgentActivity();
      });
      storage.recordEnvironmentSessionCompletion = originalRecord;

      expect(attempts).toBe(2);
      expect(warnings.some((warning) => warning.includes("Activity reconciliation"))).toBe(true);
      expect(internals(service).observedSessionActivity.get(key)?.state).toBe("idle");
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        agentActivityState: "idle",
        hasUnreadWork: true,
      });
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



  describe("startup launch reconciliation", () => {
    test("publishes setup and Cursor tabs before setup is ready without starting the provider", async () => {
      const { provider, createSession } = createProviderStub("cursor");
      await withService({
        prefix: "orkestrator-native-cursor-startup-during-setup-",
        environment: {
          pendingAgentLaunch: true,
          defaultAgent: "cursor",
          opencodeMode: "native",
          setupPhase: "running",
          setupScriptsComplete: false,
        },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await internals(service).reconcilePendingLaunches();

        expect(createSession).not.toHaveBeenCalled();
        expect(await storage.getEnvironment("env-1")).toMatchObject({
          pendingAgentLaunch: true,
          startupAgentSession: {
            agent: "cursor",
            status: "starting",
          },
        });
        expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
          activeTabId: "startup-agent",
          tabs: [
            { id: "default", type: "plain", isSetupTab: true },
            {
              id: "startup-agent",
              type: "agent-native",
              nativeAgentData: {
                platform: "cursor",
                environmentId: "env-1",
              },
            },
          ],
        });
      });
    });

    test("hands focus from the setup terminal to the startup agent once setup is ready", async () => {
      const { provider, createSession } = createProviderStub("cursor");
      await withService({
        prefix: "orkestrator-native-cursor-startup-setup-handoff-",
        environment: {
          pendingAgentLaunch: true,
          defaultAgent: "cursor",
          opencodeMode: "native",
          setupPhase: "running",
          setupScriptsComplete: false,
        },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await internals(service).reconcilePendingLaunches();
        expect(createSession).not.toHaveBeenCalled();

        const duringSetup = await storage.getPaneLayout("env-1");
        if (!duringSetup || !duringSetup.root || typeof duringSetup.root !== "object") {
          throw new Error("expected a pane layout");
        }
        await storage.savePaneLayout("env-1", {
          version: duringSetup.version,
          containerId: duringSetup.containerId,
          activePaneId: duringSetup.activePaneId,
          root: { ...(duringSetup.root as Record<string, unknown>), activeTabId: "default" },
        }, duringSetup.revision);

        await storage.updateEnvironment("env-1", {
          setupPhase: "ready",
          setupScriptsComplete: true,
        });
        await service.reconcileInitialLaunch("env-1");

        expect(createSession).toHaveBeenCalled();
        expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
          activeTabId: "startup-agent",
        });
      });
    });

    test("publishes Cursor's native startup tab before consuming the launch", async () => {
      const { provider } = createProviderStub("cursor");
      await withService({
        prefix: "orkestrator-native-cursor-startup-tab-",
        environment: {
          pendingAgentLaunch: true,
          defaultAgent: "cursor",
          opencodeMode: "native",
        },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await service.reconcileInitialLaunch("env-1");

        const converged = await storage.getEnvironment("env-1");
        expect(converged).toMatchObject({ pendingAgentLaunch: false });
        // Both halves of the launch are durable now, so the transient snapshot
        // is cleared rather than left running for the life of the environment.
        expect(converged?.startupAgentSession).toBeUndefined();
        expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
          activeTabId: "startup-agent",
          tabs: [
            { id: "default", type: "plain", isSetupTab: true },
            {
              id: "startup-agent",
              type: "agent-native",
              nativeAgentData: {
                platform: "cursor",
                sessionId: "provider-session",
              },
            },
          ],
        });
      });
    });

    test("records a durable error and backs off when publishing the startup pane fails", async () => {
      const { provider, createSession } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-startup-publish-failure-",
        environment: {
          pendingAgentLaunch: true,
          defaultAgent: "codex",
          codexMode: "native",
        },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const publish = storage.ensureStartupNativeAgentTab.bind(storage);
        let failures = 0;
        storage.ensureStartupNativeAgentTab = async (input) => {
          if (failures === 0) {
            failures += 1;
            throw new Error("pane layout is unwritable");
          }
          return publish(input);
        };

        // The publish happens before the provider call, so its failure has to
        // travel the same path as a launch failure: no provider session, a
        // durable error for the renderer to surface, and an armed retry window.
        await expect(service.reconcileInitialLaunch("env-1")).rejects.toThrow(
          "pane layout is unwritable",
        );
        expect(createSession).not.toHaveBeenCalled();
        expect(await storage.getEnvironment("env-1")).toMatchObject({
          pendingAgentLaunch: true,
          startupAgentSession: {
            agent: "codex",
            status: "error",
            error: "Agent launch failed; the backend will retry.",
          },
        });

        // Armed backoff means the very next sweep is a no-op rather than an
        // unthrottled retry every two seconds.
        await internals(service).reconcilePendingLaunches();
        expect(createSession).not.toHaveBeenCalled();
      });
    });

    test("repairs a persisted provider-specific startup tab on backend init", async () => {
      const { provider } = createProviderStub("cursor");
      await withService({
        prefix: "orkestrator-native-cursor-startup-repair-",
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await service.ensureSession({
          environmentId: "env-1",
          agent: "cursor",
          logicalSessionKey: "env-env-1:startup-agent",
        });
        await storage.savePaneLayout("env-1", {
          version: 3,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "default", type: "plain", isSetupTab: true },
              { id: "startup-agent", type: "cursor" },
            ],
            activeTabId: "startup-agent",
          },
        }, 0);

        await service.init();

        expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
          tabs: [
            { id: "default", type: "plain" },
            {
              id: "startup-agent",
              type: "agent-native",
              nativeAgentData: {
                platform: "cursor",
                sessionId: "provider-session",
              },
            },
          ],
        });
      });
    });

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

        // The resolved selection is observed where it is actually consumed —
        // the provider call and the durable pane — because the transient
        // startup snapshot is cleared once the launch converges.
        expect(createSession).toHaveBeenCalledWith(
          "build",
          "Agent Session",
          expect.objectContaining({
            model: "repo-model",
            effort: "repo-effort",
          }),
        );
        expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
          tabs: [
            { id: "default" },
            {
              id: "startup-agent",
              type: "agent-native",
              nativeAgentData: { platform: "codex", sessionId: "provider-session" },
            },
          ],
        });
      });
    });

    test("falls back to the global codex model and reasoning effort", async () => {
      const { provider, createSession } = createProviderStub("codex");
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

        expect(createSession).toHaveBeenCalledWith(
          "build",
          "Agent Session",
          expect.objectContaining({ model: "global-codex", effort: "xhigh" }),
        );
        expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
          tabs: [
            { id: "default" },
            { id: "startup-agent", nativeAgentData: { platform: "codex" } },
          ],
        });
      });
    });

    test("falls back to the global claude model and no reasoning effort", async () => {
      const { provider, createSession } = createProviderStub("claude");
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

        // Only codex has a global effort tier; inventing one for claude would
        // send an unsupported field to its bridge.
        expect(createSession).toHaveBeenCalledWith(
          "build",
          "Agent Session",
          expect.objectContaining({ model: "global-claude", effort: undefined }),
        );
        expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
          tabs: [
            { id: "default" },
            { id: "startup-agent", nativeAgentData: { platform: "claude" } },
          ],
        });
      });
    });

    test("prefers the environment's own agent, model and effort", async () => {
      const { provider, createSession } = createProviderStub("codex");
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

        expect(createSession).toHaveBeenCalledWith(
          "build",
          "Agent Session",
          expect.objectContaining({ model: "env-model", effort: "env-effort" }),
        );
        expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
          tabs: [
            { id: "default" },
            { id: "startup-agent", nativeAgentData: { platform: "codex" } },
          ],
        });
      });
    });

    test("dispatches an attachment-only startup prompt before clearing its images", async () => {
      const { provider, send } = createProviderStub("codex");
      await withService({
        prefix: "orkestrator-native-launch-image-only-",
        environment: {
          pendingAgentLaunch: true,
          defaultAgent: "codex",
          codexMode: "native",
          initialPrompt: "   ",
          initialPromptAttachments: [{
            id: "image-1",
            name: "reference.png",
            previewUrl: "data:image/png;base64,cG5n",
            base64Data: "cG5n",
          }],
        },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await service.reconcileInitialLaunch("env-1");

        expect(send).toHaveBeenCalledWith(
          "provider-session",
          "",
          expect.objectContaining({
            requestId: "initial-prompt:env-1:startup-agent",
            images: [{ filename: "reference.png", data: "cG5n" }],
          }),
        );
        const converged = await storage.getEnvironment("env-1");
        expect(converged).toMatchObject({ pendingAgentLaunch: false });
        expect(converged?.startupAgentSession).toBeUndefined();
        expect(converged?.initialPromptAttachments).toBeUndefined();
        expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
          tabs: [
            { id: "default" },
            {
              id: "startup-agent",
              nativeAgentData: { sessionId: "provider-session" },
            },
          ],
        });
      });
    });

    test.each([
      ["claude", { claudeMode: "native" }] as const,
      ["opencode", { opencodeMode: "native" }] as const,
    ])(
      "dispatches an attachment-only startup prompt for %s too",
      async (agent, modes) => {
        // The blank-prompt relaxation is agent-neutral: every native agent that
        // accepts an attachment-only turn must reach the same dispatch, not
        // only the codex path the fix was written against.
        const { provider, send } = createProviderStub(agent);
        await withService({
          prefix: `orkestrator-native-launch-image-only-${agent}-`,
          environment: {
            pendingAgentLaunch: true,
            defaultAgent: agent,
            ...modes,
            initialPrompt: "",
            initialPromptAttachments: [{
              id: "image-1",
              name: "reference.png",
              previewUrl: "data:image/png;base64,cG5n",
              base64Data: "cG5n",
            }],
          },
          provider: async () => provider,
        }, async ({ storage, service }) => {
          await service.reconcileInitialLaunch("env-1");

          expect(send).toHaveBeenCalledWith(
            "provider-session",
            "",
            expect.objectContaining({
              requestId: "initial-prompt:env-1:startup-agent",
              images: [{ filename: "reference.png", data: "cG5n" }],
            }),
          );
          const converged = await storage.getEnvironment("env-1");
          expect(converged).toMatchObject({ pendingAgentLaunch: false });
          expect(converged?.startupAgentSession).toBeUndefined();
          expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
            tabs: [
              { id: "default" },
              {
                id: "startup-agent",
                type: "agent-native",
                nativeAgentData: { platform: agent, sessionId: "provider-session" },
              },
            ],
          });
        });
      },
    );

    test("dispatches a launch the repository's agent style makes native", async () => {
      // The renderer resolves the Claude style through the repository tier when
      // it decides whether to leave the initial prompt's images alone. This
      // side has to agree: if it declined here, a launch the renderer stood
      // down for would never deliver its attachments.
      const { provider, send } = createProviderStub("claude");
      await withService({
        prefix: "orkestrator-native-launch-repo-style-",
        environment: {
          pendingAgentLaunch: true,
          defaultAgent: "claude",
          initialPrompt: "Inspect this screenshot",
        },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        const config = await storage.loadConfig();
        await storage.updateGlobalConfig({ ...config.global, claudeMode: "terminal" });
        await storage.updateRepositoryConfig("project-1", {
          defaultBranch: "main",
          prBaseBranch: "main",
          agentStyle: "native",
        });

        await service.reconcileInitialLaunch("env-1");

        expect(send).toHaveBeenCalledWith(
          "provider-session",
          "Inspect this screenshot",
          expect.objectContaining({
            requestId: "initial-prompt:env-1:startup-agent",
          }),
        );
      });
    });

    test("leaves a tmux-backed native Claude launch to the terminal coordinator", async () => {
      const { provider, send, createSession } = createProviderStub("claude");
      await withService({
        prefix: "orkestrator-native-launch-tmux-",
        environment: {
          pendingAgentLaunch: true,
          defaultAgent: "claude",
          claudeMode: "native",
          claudeNativeBackend: "tmux",
          initialPrompt: "Inspect this screenshot",
        },
        provider: async () => provider,
      }, async ({ storage, service }) => {
        await service.reconcileInitialLaunch("env-1");

        expect(send).not.toHaveBeenCalled();
        expect(createSession).not.toHaveBeenCalled();
        // Still pending: the terminal coordinator owns this launch and the
        // renderer is the side that will deliver its attachments.
        expect(await storage.getEnvironment("env-1")).toMatchObject({
          pendingAgentLaunch: true,
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

});
