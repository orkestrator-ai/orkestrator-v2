import { describe, expect, mock, test } from "bun:test";

import { promises as fs } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { type BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";

import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";

import {
  createNativeAgentProvider,
  ProviderUnavailableError,
  type AgentInteractionProviderCapability,
  type AgentSessionProvider,
  type BridgeConnection,
  type NativeAgentRuntimeProvider,
  type ProviderActivityState,
  type ProviderInteractiveSnapshot,
  type ProviderSendOptions,
  type ProviderStatus,
} from "./native-agent-provider.js";

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
    send?: (sessionId: string, prompt: string, options: ProviderSendOptions) => Promise<void>;
    status?: (sessionId: string) => Promise<ProviderStatus>;
    activity?: (sessionId: string) => Promise<ProviderActivityState>;
    activityBatch?: (sessionIds: readonly string[]) => Promise<Map<string, ProviderActivityState>>;
    interactions?: AgentInteractionProviderCapability;
    messages?: (sessionId: string) => Promise<unknown[]>;
    interactiveSnapshot?: (sessionId: string) => Promise<ProviderInteractiveSnapshot>;
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
  const createSession = mock(behaviour.createSession ?? (async () => "provider-session"));
  const send = mock(behaviour.send ?? (async () => undefined));
  const status = mock(behaviour.status ?? (async () => "idle" as ProviderStatus));
  const activity = behaviour.activity ? mock(behaviour.activity) : undefined;
  const activityBatch = behaviour.activityBatch ? mock(behaviour.activityBatch) : undefined;
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
  const modelCatalog = behaviour.modelCatalog ? mock(behaviour.modelCatalog) : undefined;
  const rawModelCatalog = behaviour.rawModelCatalog ? mock(behaviour.rawModelCatalog) : undefined;
  const updateInteractiveControls = behaviour.updateInteractiveControls
    ? mock(behaviour.updateInteractiveControls)
    : undefined;
  const slashCommands = behaviour.slashCommands ? mock(behaviour.slashCommands) : undefined;
  const refreshCatalog = behaviour.refreshCatalog ? mock(behaviour.refreshCatalog) : undefined;
  const prepareDispatch = behaviour.prepareDispatch ? mock(behaviour.prepareDispatch) : undefined;
  const dispatchStatus = behaviour.dispatchStatus ? mock(behaviour.dispatchStatus) : undefined;
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
  run: (context: { storage: StorageService; service: NativeAgentService }) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), setup.prefix));
  const storage = await createStorage(dataDir);
  await addEnvironment(storage, setup.environment);
  const service = new NativeAgentService(storage, setup.invoke ?? refusingInvoke, {
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
    ...(setup.onActivityTransition ? { onActivityTransition: setup.onActivityTransition } : {}),
    ...(setup.onInteractionObservation
      ? { onInteractionObservation: setup.onInteractionObservation }
      : {}),
    ...(setup.toolDetailCacheMaxEntries === undefined
      ? {}
      : { toolDetailCacheMaxEntries: setup.toolDetailCacheMaxEntries }),
    ...(setup.toolDetailCacheMaxBytes === undefined
      ? {}
      : { toolDetailCacheMaxBytes: setup.toolDetailCacheMaxBytes }),
  });
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
      presentation:
        kind === "question"
          ? {
              title: "private request content",
              questions: [
                {
                  id: "question-1",
                  prompt: "private prompt content",
                  required: true,
                  multiple: false,
                  secret: false,
                  allowFreeText: true,
                  options: [
                    {
                      id: "option-1",
                      label: "private option content",
                      providerValue: "private provider value",
                    },
                  ],
                },
              ],
            }
          : { title: "private permission content", questions: [] },
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 1_000,
    })),
  };
}

describe("NativeAgentService", () => {
  test("rejects a disconnected OpenCode model on the interactive tab path", async () => {
    const messageCalls = mock(async () => ({ data: [] }));
    const promptCalls = mock(async () => ({ data: true }));
    const client = {
      provider: {
        async list() {
          return {
            data: {
              all: [
                {
                  id: "hpc-ai",
                  models: {
                    "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash" },
                  },
                },
                {
                  id: "opencode",
                  models: { "kimi-k2.7": { name: "Kimi K2.7" } },
                },
              ],
              connected: ["opencode"],
            },
          };
        },
      },
      session: {
        async create() {
          return { data: { id: "provider-session" } };
        },
        async status() {
          return { data: { "provider-session": { type: "idle" } } };
        },
        messages: messageCalls,
        promptAsync: promptCalls,
      },
    };
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
      },
      {
        openCodeClient: client as never,
        autoAnswerRequests: false,
        resolveOpenCodeModelProviders: () => ["hpc-ai", "opencode"],
      },
    );

    await withService(
      {
        prefix: "orkestrator-native-opencode-disconnected-model-",
        provider: async () => provider,
      },
      async ({ service }) => {
        const input = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:tab-opencode",
          origin: "interactive-native" as const,
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
          prompt: "Please continue",
          requestId: "request-1",
          model: "hpc-ai/deepseek/deepseek-v4-flash",
          mode: "build" as const,
        };

        await expect(service.dispatchIntent(input)).resolves.toEqual({
          outcome: "rejected",
          error:
            "The selected OpenCode model is not connected or is no longer available. Choose an available model and retry.",
        });
        // `promptAsync` would persist the user message before resolving the model.
        // The interactive path must reject before either transcript or dispatch.
        expect(messageCalls).not.toHaveBeenCalled();
        expect(promptCalls).not.toHaveBeenCalled();
        await expect(service.listProjectionModels(input)).resolves.toEqual([
          expect.objectContaining({ id: "opencode/kimi-k2.7" }),
        ]);
      },
    );
  });

  test("keeps a transient Cursor session startup in the connecting request", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const stub = createProviderStub("cursor", {
      createSession: async () => {
        attempts += 1;
        if (attempts < 3) throw new ProviderUnavailableError("Cursor is still starting");
        return "cursor-session";
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-cursor-create-retry-",
        provider: async () => stub.provider,
        delay: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
      async ({ service }) => {
        await expect(
          service.ensureSession({
            environmentId: "env-1",
            agent: "cursor",
            logicalSessionKey: "env-env-1:cursor-tab",
          }),
        ).resolves.toMatchObject({ providerSessionId: "cursor-session" });

        expect(stub.createSession).toHaveBeenCalledTimes(3);
        expect(delays).toEqual([250, 500]);
      },
    );
  });

  test("keeps a transient Pi session startup in the connecting request", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const stub = createProviderStub("pi", {
      createSession: async () => {
        attempts += 1;
        if (attempts < 3) throw new ProviderUnavailableError("Pi is still starting");
        return "pi-session";
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-pi-create-retry-",
        provider: async () => stub.provider,
        delay: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
      async ({ service }) => {
        await expect(
          service.ensureSession({
            environmentId: "env-1",
            agent: "pi",
            logicalSessionKey: "env-env-1:pi-tab",
          }),
        ).resolves.toMatchObject({ providerSessionId: "pi-session" });

        expect(stub.createSession).toHaveBeenCalledTimes(3);
        expect(delays).toEqual([250, 500]);
      },
    );
  });

  test("surfaces a Cursor session startup that stays unavailable for every attempt", async () => {
    const delays: number[] = [];
    const stub = createProviderStub("cursor", {
      createSession: async () => {
        throw new ProviderUnavailableError("Cursor never came up");
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-cursor-create-exhausted-",
        provider: async () => stub.provider,
        delay: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
      async ({ service }) => {
        // The retry is bounded: a bridge that never starts must surface as an
        // error rather than retrying inside one request forever.
        await expect(
          service.ensureSession({
            environmentId: "env-1",
            agent: "cursor",
            logicalSessionKey: "env-env-1:cursor-tab",
          }),
        ).rejects.toThrow(ProviderUnavailableError);

        expect(stub.createSession).toHaveBeenCalledTimes(4);
        expect(delays).toEqual([250, 500, 1_000]);
      },
    );
  });

  test("does not retry a Cursor session startup the provider actually rejected", async () => {
    const delays: number[] = [];
    const stub = createProviderStub("cursor", {
      createSession: async () => {
        throw new Error("cursor refused this workspace");
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-cursor-create-fatal-",
        provider: async () => stub.provider,
        delay: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
      async ({ service }) => {
        // Only "not up yet" is transient. Retrying a real rejection would hide
        // the provider's verdict behind three pointless attempts.
        await expect(
          service.ensureSession({
            environmentId: "env-1",
            agent: "cursor",
            logicalSessionKey: "env-env-1:cursor-tab",
          }),
        ).rejects.toThrow("cursor refused this workspace");

        expect(stub.createSession).toHaveBeenCalledTimes(1);
        expect(delays).toEqual([]);
      },
    );
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
    await withService(
      {
        prefix: "orkestrator-native-interaction-capability-loss-",
        provider: async () => current,
        interactionMonitorMode: "observe-only",
      },
      async ({ storage, service }) => {
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
      },
    );
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
    } as AgentSessionProvider;
    const service = new NativeAgentService(
      storage,
      async <T>(): Promise<T> => {
        throw new Error("unused");
      },
      { provider: async () => provider },
    );
    const input = {
      environmentId: "env-1",
      agent: "opencode" as const,
      logicalSessionKey: "env-env-1:tab-1",
    };
    try {
      const ensure = service.ensureSession(input);
      await createEntered;

      let deletionSettled = false;
      const deletion = storage
        .updateEnvironment("env-1", {
          deletionRequestedAt: new Date().toISOString(),
        })
        .then(() => {
          deletionSettled = true;
        });
      await Promise.resolve();
      expect(deletionSettled).toBe(false);

      releaseCreate?.();
      await Promise.all([ensure, deletion]);
      expect(createSession).toHaveBeenCalledTimes(1);
      expect((await storage.getEnvironment("env-1"))?.deletionRequestedAt).toBeDefined();
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
    ] as const)("starts the %s local bridge and carries its worktree", async (agent, command) => {
      const invoke = mock(async () => ({ port: 4123, authToken: "token" }) as never);
      await withService(
        {
          prefix: "orkestrator-native-bridge-local-",
          invoke: invoke as unknown as Invoke,
        },
        async ({ storage, service }) => {
          const environment = (await storage.getEnvironment("env-1"))!;
          expect(
            await internals(service).bridgeConnection(
              agent,
              environment,
              "chosen-model",
              "chosen-effort",
            ),
          ).toEqual({
            agent,
            baseUrl: "http://127.0.0.1:4123",
            authToken: "token",
            directory: "/tmp/env-1",
            model: "chosen-model",
            effort: "chosen-effort",
          });
          expect(invoke).toHaveBeenCalledWith(command, { environmentId: "env-1" });
        },
      );
    });

    test.each([
      ["claude", "start_claude_server"],
      ["codex", "start_codex_server"],
      ["opencode", "start_opencode_server"],
    ] as const)("starts the %s container bridge on its host port", async (agent, command) => {
      const invoke = mock(async () => ({ hostPort: 5123, authToken: "token" }) as never);
      await withService(
        {
          prefix: "orkestrator-native-bridge-container-",
          environment: {
            environmentType: "containerized",
            containerId: "container-1",
            worktreePath: undefined,
          },
          invoke: invoke as unknown as Invoke,
        },
        async ({ storage, service }) => {
          const environment = (await storage.getEnvironment("env-1"))!;
          // No `directory`: the bridge runs inside the container, where the
          // workspace path is fixed and a host path would be meaningless.
          expect(await internals(service).bridgeConnection(agent, environment)).toEqual({
            agent,
            baseUrl: "http://127.0.0.1:5123",
            authToken: "token",
            model: undefined,
            effort: undefined,
          });
          expect(invoke).toHaveBeenCalledWith(command, { containerId: "container-1" });
        },
      );
    });

    test.each([
      ["local", { environmentType: "local" }],
      ["container", { environmentType: "containerized", containerId: "container-1" }],
    ] as const)("refuses an unauthenticated %s bridge", async (_label, environment) => {
      const invoke = mock(async () => ({ port: 4123, hostPort: 5123 }) as never);
      await withService(
        {
          prefix: "orkestrator-native-bridge-auth-",
          environment,
          invoke: invoke as unknown as Invoke,
        },
        async ({ storage, service }) => {
          const stored = (await storage.getEnvironment("env-1"))!;
          // An unauthenticated bridge would accept prompts from any local
          // process, so a missing token must fail the connection outright.
          await expect(internals(service).bridgeConnection("codex", stored)).rejects.toThrow(
            "codex bridge authentication is unavailable",
          );
        },
      );
    });

    test("refuses a container environment with no container", async () => {
      const invoke = mock(async () => ({ hostPort: 5123, authToken: "t" }) as never);
      await withService(
        {
          prefix: "orkestrator-native-bridge-nocontainer-",
          environment: { environmentType: "containerized", containerId: null },
          invoke: invoke as unknown as Invoke,
        },
        async ({ storage, service }) => {
          const stored = (await storage.getEnvironment("env-1"))!;
          await expect(internals(service).bridgeConnection("codex", stored)).rejects.toThrow(
            "Native agent container is unavailable",
          );
          expect(invoke).not.toHaveBeenCalled();
        },
      );
    });

    test("reuses a real provider while revalidating its bridge generation", async () => {
      const invoke = mock(async () => ({ port: 4123, authToken: "token" }) as never);
      await withService(
        {
          prefix: "orkestrator-native-bridge-cache-",
          invoke: invoke as unknown as Invoke,
        },
        async ({ service }) => {
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
          // same provider. The start command is still re-read: a tab can replace
          // the bridge behind the service's back, changing its port and token.
          const again = await internals(service).provider({
            ...base,
            agent: "codex",
            model: "gpt-b",
            reasoningEffort: "high",
          });
          expect(again).toBe(codex);
          expect(codex.agent).toBe("codex");
          expect(invoke).toHaveBeenCalledTimes(2);

          const opencode = await internals(service).provider({
            ...base,
            agent: "opencode",
          });
          expect(opencode.agent).toBe("opencode");
          expect(invoke).toHaveBeenCalledTimes(3);
          expect([...internals(service).providers.keys()].sort()).toEqual([
            "env-1\u0000codex",
            "env-1\u0000opencode",
          ]);
        },
      );
    });

    test("replaces a cached provider when the bridge port or token changes", async () => {
      let generation = { port: 4123, authToken: "token-a" };
      const invoke = mock(async () => generation as never);
      await withService(
        {
          prefix: "orkestrator-native-bridge-generation-",
          invoke: invoke as unknown as Invoke,
        },
        async ({ service }) => {
          const input = {
            environmentId: "env-1",
            logicalSessionKey: "env-env-1:tab-1",
            agent: "cursor" as const,
          };
          const first = await internals(service).provider(input);

          generation = { port: 4188, authToken: "token-b" };
          const replacement = await internals(service).provider(input);

          expect(replacement).not.toBe(first);
          expect(replacement.agent).toBe("cursor");
          expect(invoke).toHaveBeenCalledTimes(2);
          expect(internals(service).providers.get("env-1\0cursor")).toBe(replacement);
        },
      );
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
        await withService(
          {
            prefix: "orkestrator-native-provider-stage-images-",
            invoke: invoke as unknown as Invoke,
          },
          async ({ service }) => {
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
              attachments: [
                {
                  type: "image",
                  path: stagedPath,
                  filename: "reference.png",
                  dataUrl: "data:image/png;base64,cG5n",
                },
              ],
            });
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
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
    } as AgentSessionProvider;
    const service = new NativeAgentService(
      storage,
      async <T>(): Promise<T> => {
        throw new Error("unused");
      },
      { provider: async () => provider },
    );
    try {
      await expect(
        service.ensureSession({
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "env-env-1:tab-1",
        }),
      ).rejects.toThrow("unavailable");
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
