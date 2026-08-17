import { describe,expect,mock,test } from "bun:test";


import { promises as fs } from "node:fs";


import { tmpdir } from "node:os";


import path from "node:path";


import {
BUILD_PIPELINE_AGENTS,
type BuildPipelineAgent
} from "@orkestrator/protocol/build-pipeline";


import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";


import {
AGENT_INTERACTION_CONTRACT_VERSION,
type AgentInteractionSnapshot
} from "@orkestrator/protocol/agent-interactions";


import {
ProviderSessionFailedError,
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
NATIVE_PROJECTION_CACHE_LIMIT,
NATIVE_PROJECTION_MAX_BYTES,
NativeAgentService,
nativeAgentSessionStorageKey,
type AgentInteractionObservation,
type EnsureNativeAgentSessionInput,
type NativeAgentServiceOptions
} from "./native-agent-service.js";


import { StorageService } from "./storage.js";





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

describe("NativeAgentService", () => {



  test("uses the provider's raw OpenCode catalogue for durable cache refreshes", async () => {
    const filtered = [{ platform: "opencode" as const, id: "opencode/a", label: "A" }];
    const raw = [
      ...filtered,
      { platform: "opencode" as const, id: "openrouter/b", label: "B" },
    ];
    const stub = createProviderStub("opencode", {
      modelCatalog: async () => filtered,
      rawModelCatalog: async () => raw,
    });
    await withService({
      prefix: "orkestrator-native-catalog-cache-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      await expect(service.listModelCatalogForCache({
        environmentId: "env-1",
        agent: "opencode",
        logicalSessionKey: "model-catalog:env-1",
      })).resolves.toEqual(raw);
      expect(stub.rawModelCatalog).toHaveBeenCalledTimes(1);
      expect(stub.modelCatalog).not.toHaveBeenCalled();
    });
  });



  test("projects authoritative interactive state with stable revisions and inactive refresh", async () => {
    let now = 10_000;
    let providerRevision = 4;
    let status: ProviderStatus = "idle";
    const interactiveSnapshot = async (): Promise<ProviderInteractiveSnapshot> => ({
      status,
      providerRevision,
      title: "Projected session",
      shareUrl: "https://share.example/session",
      controls: { mode: "plan" },
      messages: [{
        id: "message-1",
        role: "assistant",
        content: "Ready",
        parts: [{ type: "text", text: "Ready" }],
        createdAt: "2026-08-14T10:00:00.000Z",
      }],
      composer: {
        models: [{ platform: "cursor", id: "cursor/default", label: "Default" }],
        selectedModelId: "cursor/default",
        fastModeEnabled: false,
        fastModeAvailable: true,
        selectedModeId: "build",
        modes: [
          { id: "build", label: "Build" },
          { id: "plan", label: "Plan" },
        ],
      },
    });
    const stub = createProviderStub("cursor", { interactiveSnapshot });
    await withService({
      prefix: "orkestrator-native-projection-",
      provider: async () => stub.provider,
      now: () => now,
    }, async ({ service }) => {
      await service.ensureSession({
        environmentId: "env-1",
        agent: "cursor",
        logicalSessionKey: "env-env-1:tab-1",
        sessionMode: "build",
      });

      const first = await service.getProjection({
        environmentId: "env-1",
        agent: "cursor",
        logicalSessionKey: "env-env-1:tab-1",
      });
      expect(first).toMatchObject({
        platform: "cursor",
        connection: "connected",
        turn: { phase: "idle" },
        revision: 1,
        generation: "in-process:cursor",
        title: "Projected session",
        shareUrl: "https://share.example/session",
        cursor: "in-process:cursor:1",
        messages: [{ id: "message-1", content: "Ready" }],
        composer: { selectedModelId: "cursor/default", selectedModeId: "plan" },
      });
      expect(first?.composerControls.map((control) => control.id)).toEqual([
        "model",
        "speed",
        "mode",
      ]);

      const unchanged = await service.getProjection({
        environmentId: "env-1",
        agent: "cursor",
        logicalSessionKey: "env-env-1:tab-1",
      });
      expect(unchanged).toBe(first);

      status = "running";
      providerRevision = 5;
      now += 2_000;
      const refreshed = await service.getProjection({
        environmentId: "env-1",
        agent: "cursor",
        logicalSessionKey: "env-env-1:tab-1",
      });
      expect(refreshed).toMatchObject({
        turn: { phase: "running" },
        revision: 2,
        cursor: "in-process:cursor:2",
      });
      expect(stub.interactiveSnapshot).toHaveBeenCalledTimes(3);
    });
  });



  test("gates composer surfaces on the capability table, not on what the provider reported", async () => {
    // OpenCode has no fast surface and no Build/Plan permission mode: its
    // `mode` used to be sent as the SDK `agent` name, duplicating the execution
    // profile. A provider snapshot that claims both must not reintroduce them.
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [{
            platform: "opencode",
            id: "opencode/sonnet",
            label: "Sonnet",
            supportsSpeed: true,
          }],
          selectedModelId: "opencode/sonnet",
          fastModeEnabled: true,
          fastModeAvailable: true,
          selectedModeId: "plan",
          modes: [{ id: "build", label: "Build" }, { id: "plan", label: "Plan" }],
          executionProfiles: [{ id: "build", label: "build" }],
        },
      }),
    });
    await withService({
      prefix: "orkestrator-native-projection-capability-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "opencode" as const,
        logicalSessionKey: "env-env-1:tab-capability",
      };
      await service.ensureSession(identity);
      const projection = await service.getProjection(identity);
      expect(projection?.composer?.modes).toEqual([]);
      expect(projection?.composer?.selectedModeId).toBeUndefined();
      expect(projection?.composer?.fastModeAvailable).toBe(false);
      expect(projection?.composer?.fastModeEnabled).toBeNull();
      // Execution profiles stay: OpenCode primary agents are the real control.
      expect(projection?.composer?.executionProfiles).toEqual([
        { id: "build", label: "build" },
      ]);
      expect(projection?.composerControls.map((control) => control.id)).toEqual([
        "model",
        "execution-profile",
      ]);

      // A mode the table forbids is refused rather than persisted, because the
      // projected `modes` list is what `updateProjectionControls` validates.
      await expect(service.updateProjectionControls({
        ...identity,
        update: { mode: "plan" },
      })).rejects.toThrow("Native agent conversation mode is invalid");
      await expect(service.updateProjectionControls({
        ...identity,
        update: { fastMode: true },
      })).rejects.toThrow("Native agent fast mode is unavailable");
    });
  });

  test("projects an initial OpenCode execution profile before the first prompt", async () => {
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [],
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
          executionProfiles: [
            { id: "build", label: "Build agent" },
            { id: "plan", label: "Plan agent" },
          ],
        },
      }),
    });
    await withService({
      prefix: "orkestrator-native-initial-execution-profile-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "opencode" as const,
        logicalSessionKey: "env-env-1:tab-initial-profile",
      };
      await service.ensureSession({
        ...identity,
        executionProfileId: "plan",
      });

      await expect(service.getProjection(identity)).resolves.toMatchObject({
        composer: {
          modes: [],
          selectedExecutionProfileId: "plan",
          executionProfiles: [
            { id: "build", label: "Build agent" },
            { id: "plan", label: "Plan agent" },
          ],
        },
      });
    });
  });

  test("carries a pre-reclassification conversation mode onto the execution profile", async () => {
    // A session created while OpenCode still had a Build/Plan pair persisted
    // `controls.mode`, and that value was dispatched as the SDK `agent` name.
    // Now that the table says OpenCode has no mode, the projection is the only
    // thing that can carry the choice across; without it the upgraded session
    // silently drops to the provider default and runs the build agent.
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [],
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
          executionProfiles: [
            { id: "build", label: "Build agent" },
            { id: "plan", label: "Plan agent" },
          ],
        },
      }),
    });
    await withService({
      prefix: "orkestrator-native-legacy-mode-profile-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "opencode" as const,
        logicalSessionKey: "env-env-1:tab-legacy-mode",
      };
      await service.ensureSession({ ...identity, sessionMode: "plan" });

      const projection = await service.getProjection(identity);
      expect(projection?.composer?.selectedExecutionProfileId).toBe("plan");
      // The mode itself stays off the projection: the platform has no mode.
      expect(projection?.composer?.selectedModeId).toBeUndefined();
      expect(projection?.composer?.modes).toEqual([]);
      expect(projection?.composerControls.map((control) => control.id)).toEqual([
        "execution-profile",
      ]);

      // An explicit profile still wins over the legacy mode it replaces.
      await service.updateProjectionControls({
        ...identity,
        update: { executionProfileId: "build" },
      });
      await expect(service.getProjection(identity)).resolves.toMatchObject({
        composer: { selectedExecutionProfileId: "build" },
      });
    });
  });

  test("drops a stored execution profile the provider does not list", async () => {
    // The unassigned launcher pins a profile before any session exists, so it
    // cannot know the real agent names. A pinned id the provider turns out not
    // to have must not reach `send` as an unknown agent.
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [],
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
          executionProfiles: [{ id: "architect", label: "architect" }],
        },
      }),
    });
    await withService({
      prefix: "orkestrator-native-unknown-execution-profile-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "opencode" as const,
        logicalSessionKey: "env-env-1:tab-unknown-profile",
      };
      await service.ensureSession({ ...identity, executionProfileId: "plan" });

      const projection = await service.getProjection(identity);
      expect(projection?.composer?.selectedExecutionProfileId).toBeUndefined();
      expect(projection?.composer?.executionProfiles).toEqual([
        { id: "architect", label: "architect" },
      ]);
    });
  });

  test("keeps a stored execution profile while the provider's agent list is unavailable", async () => {
    // An empty list means the agent listing failed or has not arrived yet, not
    // that the profile is gone. Dropping the selection there would swap the
    // user's agent for the provider default on a transient read.
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [],
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
          executionProfiles: [],
        },
      }),
    });
    await withService({
      prefix: "orkestrator-native-pending-execution-profile-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "opencode" as const,
        logicalSessionKey: "env-env-1:tab-pending-profile",
      };
      await service.ensureSession({ ...identity, executionProfileId: "plan" });

      const projection = await service.getProjection(identity);
      expect(projection?.composer?.selectedExecutionProfileId).toBe("plan");
      // The generated control list stays empty — the native tab supplies a
      // Plan/Build fallback itself rather than reading composerControls.
      expect(projection?.composer?.executionProfiles).toBeUndefined();
      expect(projection?.composerControls.map((control) => control.id)).toEqual([]);
    });
  });

  test("accepts an execution-profile update while the provider's agent list is unavailable", async () => {
    // Same empty-list rule as projection: the listing has not arrived, so a
    // Plan/Build choice from the compose bar must persist rather than 400.
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [],
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
          executionProfiles: [],
        },
      }),
    });
    await withService({
      prefix: "orkestrator-native-pending-execution-profile-update-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "opencode" as const,
        logicalSessionKey: "env-env-1:tab-pending-profile-update",
      };
      await service.ensureSession(identity);
      await service.updateProjectionControls({
        ...identity,
        update: { executionProfileId: "plan" },
      });
      await expect(service.getProjection(identity)).resolves.toMatchObject({
        composer: { selectedExecutionProfileId: "plan" },
      });
    });
  });

  test("rejects a non-fallback execution profile while the agent list is unavailable", async () => {
    // The empty-list exemption is for the two ids the compose bar can offer
    // without a listing, not a hole. Anything else is unverifiable and is
    // forwarded verbatim as the provider's `agent` name, so it must still 400.
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [],
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
          executionProfiles: [],
        },
      }),
    });
    await withService({
      prefix: "orkestrator-native-unknown-execution-profile-update-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "opencode" as const,
        logicalSessionKey: "env-env-1:tab-unknown-profile-update",
      };
      await service.ensureSession(identity);
      await expect(service.updateProjectionControls({
        ...identity,
        update: { executionProfileId: "totally-unknown-agent" },
      })).rejects.toThrow("Native agent execution profile is invalid");
      await expect(service.updateProjectionControls({
        ...identity,
        update: { executionProfileId: "x".repeat(5_000) },
      })).rejects.toThrow("Native agent execution profile is invalid");
      // Nothing was persisted, so the projection still carries no selection.
      const projection = await service.getProjection(identity);
      expect(projection?.composer?.selectedExecutionProfileId).toBeUndefined();
    });
  });

  test("drops execution profiles and Claude-only toggles a provider reports off-table", async () => {
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [{ platform: "codex", id: "gpt-5", label: "GPT-5" }],
          selectedModelId: "gpt-5",
          fastModeEnabled: false,
          fastModeAvailable: false,
          selectedModeId: "build",
          modes: [{ id: "build", label: "Build" }],
          executionProfiles: [{ id: "reviewer", label: "Reviewer" }],
          selectedExecutionProfileId: "reviewer",
          includeLocalSettings: true,
          promptSuggestionsEnabled: true,
        },
      }),
    });
    await withService({
      prefix: "orkestrator-native-projection-offtable-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-offtable",
      };
      await service.ensureSession(identity);
      const projection = await service.getProjection(identity);
      expect(projection?.composer?.executionProfiles).toBeUndefined();
      expect(projection?.composer?.selectedExecutionProfileId).toBeUndefined();
      expect(projection?.composer?.includeLocalSettings).toBeUndefined();
      expect(projection?.composer?.promptSuggestionsEnabled).toBeUndefined();
      expect(projection?.composerControls.map((control) => control.id)).toEqual([
        "model",
        "mode",
      ]);
    });
  });



  test("renders provider terminal states as uniform durable transcript rows", async () => {
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        notices: [{ kind: "stopped", message: "Query stopped by user." }],
      }),
    });
    await withService({
      prefix: "orkestrator-native-terminal-row-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "opencode" as const,
        logicalSessionKey: "env-env-1:tab-terminal",
      };
      await service.ensureSession(identity);
      const projection = await service.getProjection(identity);
      expect(projection?.messages).toEqual([expect.objectContaining({
        role: "system",
        content: "Query stopped by user.",
      })]);
      expect(projection?.notices).toBeUndefined();
    });
  });



  test("does not poll tab-facing projection routes without a foreground reader", async () => {
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    });
    await withService({
      prefix: "orkestrator-native-no-background-projection-poll-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-inactive",
      };
      await service.init();
      await service.ensureSession(identity);
      await service.getProjection(identity);
      expect(stub.interactiveSnapshot).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 425));
      expect(stub.interactiveSnapshot).toHaveBeenCalledTimes(1);
    });
  });



  test("serializes projection reads and preserves the newest expanded window", async () => {
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { signalFirst = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let activeReads = 0;
    let maxActiveReads = 0;
    let call = 0;
    const messages = Array.from({ length: 700 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant" as const,
      content: `message ${index}`,
      parts: [],
      createdAt: new Date(index).toISOString(),
    }));
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => {
        call += 1;
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        try {
          if (call === 1) {
            signalFirst();
            await firstGate;
            return { status: "idle" as const, messages: messages.slice(-512) };
          }
          return { status: "running" as const, messages };
        } finally {
          activeReads -= 1;
        }
      },
    });
    await withService({
      prefix: "orkestrator-native-serialized-projections-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:tab-race",
      };
      await service.ensureSession(identity);
      const first = service.getProjection(identity);
      await firstEntered;
      const second = service.getProjection({ ...identity, messageLimit: 1_024 });
      await Promise.resolve();
      expect(stub.interactiveSnapshot).toHaveBeenCalledTimes(1);
      releaseFirst();
      await expect(first).resolves.toMatchObject({ turn: { phase: "idle" } });
      const newest = await second;
      expect(maxActiveReads).toBe(1);
      expect(newest).toMatchObject({
        turn: { phase: "running" },
        messageWindow: { limit: 1_024, truncated: false },
      });
      expect(newest?.messages).toHaveLength(700);
    });
  });



  test("evicting the oldest cache entry does not fence a read in flight for it", async () => {
    let releaseSlow!: () => void;
    let signalSlow!: () => void;
    const slowEntered = new Promise<void>((resolve) => { signalSlow = resolve; });
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let call = 0;
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => {
        call += 1;
        // Only the second read of the evicted tab is held open; the first
        // populates the cache and the third belongs to the new tab.
        if (call === 2) {
          signalSlow();
          await slowGate;
        }
        return { status: "idle", messages: [] };
      },
    });
    await withService({
      prefix: "orkestrator-native-eviction-fence-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const evicted = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:tab-evicted",
      };
      const fresh = { ...evicted, logicalSessionKey: "env-env-1:tab-fresh" };
      await service.ensureSession(evicted);
      await service.ensureSession(fresh);
      // Cached first, so it is the oldest key the capacity sweep will drop.
      expect(await service.getProjection(evicted)).not.toBeNull();

      const cache = internals(service).projectionCache;
      const evictedKey = nativeAgentSessionStorageKey(
        evicted.environmentId,
        evicted.agent,
        evicted.logicalSessionKey,
      );
      expect([...cache.keys()][0]).toBe(evictedKey);
      while (cache.size < NATIVE_PROJECTION_CACHE_LIMIT) {
        cache.set(`filler:${cache.size}`, cache.get(evictedKey)!);
      }

      const held = service.getProjection(evicted);
      await slowEntered;
      // Committing a new key now trips the capacity sweep and drops the tab
      // whose read is still outstanding.
      expect(await service.getProjection(fresh)).not.toBeNull();
      expect(cache.has(evictedKey)).toBe(false);

      releaseSlow();
      // Capacity eviction is not an identity change, so the outstanding read
      // still commits rather than reporting the session as missing.
      const resolved = await held;
      expect(resolved).not.toBeNull();
      expect(resolved).toMatchObject({ turn: { phase: "idle" } });
      expect(cache.has(evictedKey)).toBe(true);
    });
  });



  test("keeps an at-capacity session usable so a new model can continue it", async () => {
    // Codex answers a turn it could not run with a terminal session error. The
    // thread, rollout and config all survive it, and the fix is to pick another
    // model and send again — so neither the liveness probe nor the dispatch may
    // treat the previous turn's failure as a dead session.
    const stub = createProviderStub("codex", {
      status: async () => {
        throw new ProviderSessionFailedError(
          "codex",
          "Selected model is at capacity. Please try a different model.",
        );
      },
      interactiveSnapshot: async () => ({
        status: "error",
        messages: [],
        error: "Selected model is at capacity. Please try a different model.",
      }),
    });
    await withService({
      prefix: "orkestrator-native-at-capacity-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-capacity",
      };
      const created = await service.ensureSession({ ...identity, model: "gpt-5.6-sol" });

      const reused = await service.ensureSession({ ...identity, model: "gpt-5.6-luna" });
      expect(reused.providerSessionId).toBe(created.providerSessionId);
      expect(stub.createSession).toHaveBeenCalledTimes(1);

      await service.dispatchPrompt({
        ...identity,
        prompt: "Please continue",
        requestId: "request-after-capacity",
        model: "gpt-5.6-luna",
      });
      expect(stub.send).toHaveBeenCalledTimes(1);
      expect(stub.send.mock.calls[0]?.[1]).toBe("Please continue");
      // The point of reusing the session is that the *replacement* model runs.
      // Reuse alone would still be broken if the new model were dropped here.
      expect(stub.send.mock.calls[0]?.[2]).toMatchObject({ model: "gpt-5.6-luna" });

      // The failure is still reported — it just no longer blocks the composer.
      const projection = await service.getProjection(identity);
      expect(projection?.turn).toMatchObject({
        phase: "error",
        error: "Selected model is at capacity. Please try a different model.",
      });
    });
  });



  test("projects a terminal turn failure through the status fallback", async () => {
    const detail = "Selected model is at capacity. Please try a different model.";
    const stub = createProviderStub("codex", {
      status: async () => {
        throw new ProviderSessionFailedError("codex", detail);
      },
    });
    await withService({
      prefix: "orkestrator-native-terminal-projection-fallback-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-terminal-projection",
      };
      await service.ensureSession(identity);

      const projection = await service.getProjection(identity);

      expect(stub.status).toHaveBeenCalledWith("provider-session");
      expect(projection).toMatchObject({
        connection: "connected",
        turn: { phase: "error", error: detail },
        messages: [{ role: "system", content: detail }],
      });
    });
  });



  test("reclaims projection epochs once a key is neither cached nor being read", async () => {
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    });
    await withService({
      prefix: "orkestrator-native-epoch-bound-",
      provider: async () => stub.provider,
    }, async ({ service, storage }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-epoch",
      };
      const key = nativeAgentSessionStorageKey(
        identity.environmentId,
        identity.agent,
        identity.logicalSessionKey,
      );
      const session = await service.ensureSession(identity);
      await service.getProjection(identity);

      // A session action changes the tab's identity and so records an epoch.
      await service.performProjectionAction({ ...identity, action: { kind: "compact" } })
        .catch(() => undefined);
      await service.getProjection(identity);
      const epochs = internals(service).projectionEpochs;
      expect(epochs.size).toBeLessThanOrEqual(
        internals(service).projectionCache.size
          + internals(service).projectionRefreshes.size,
      );

      // Once the session is gone the projection resolves to nothing, the cache
      // entry goes with it, and the epoch must not outlive either.
      await storage.invalidateNativeAgentSession(key, session.providerSessionId);
      await expect(service.getProjection(identity)).resolves.toBeNull();
      expect(internals(service).projectionCache.has(key)).toBe(false);
      expect(epochs.has(key)).toBe(false);
    });
  });



  test("resumes with complete controls and discards an in-flight old-session projection", async () => {
    let releaseOld!: () => void;
    let signalOld!: () => void;
    const oldEntered = new Promise<void>((resolve) => { signalOld = resolve; });
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    let snapshotCall = 0;
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async (sessionId) => {
        snapshotCall += 1;
        if (snapshotCall === 1) {
          signalOld();
          await oldGate;
        }
        return {
          status: "idle",
          messages: [{
            id: `message-${sessionId}`,
            role: "assistant",
            content: sessionId,
            parts: [],
            createdAt: new Date(0).toISOString(),
          }],
        };
      },
    });
    const resumeSession = mock(async () => "provider-resumed");
    (stub.provider as NativeAgentRuntimeProvider).resumeSession = resumeSession;
    await withService({
      prefix: "orkestrator-native-resume-controls-",
      provider: async () => stub.provider,
    }, async ({ service, storage }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:tab-resume-controls",
      };
      await service.ensureSession({
        ...identity,
        model: "old-model",
        sessionMode: "build",
      });
      const stale = service.getProjection(identity);
      await oldEntered;
      const controls = {
        modelId: "new-model",
        reasoningId: "high",
        mode: "plan" as const,
        fastMode: true,
        executionProfileId: "reviewer",
        includeLocalSettings: true,
        promptSuggestions: true,
      };
      const resumed = service.resumeProjectionSession({
        ...identity,
        providerSessionId: "provider-resumed",
        controls,
      });
      await waitForCondition(() => resumeSession.mock.calls.length === 1);
      releaseOld();
      /*
       * The fenced read must not become the cached authoritative state, but it
       * must not report `null` either: that is reserved for "this tab resolves
       * to no provider session", and a caller without its own fence would read
       * an ordinary resume as a deleted session. It is handed back uncommitted
       * at revision 0 instead.
       */
      const fenced = await stale;
      expect(fenced).not.toBeNull();
      expect(fenced).toMatchObject({ revision: 0 });
      await expect(resumed).resolves.toMatchObject({ sessionId: "provider-resumed" });
      expect(resumeSession).toHaveBeenCalledWith("provider-resumed", controls);
      const key = nativeAgentSessionStorageKey(
        identity.environmentId,
        identity.agent,
        identity.logicalSessionKey,
      );
      expect((await storage.getNativeAgentSession(key))?.controls).toEqual(controls);
    });
  });



  test("projects bounded slash commands and caches discovery independently of transcript refresh", async () => {
    let now = 1_000;
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [{ platform: "claude", id: "sonnet", label: "Sonnet" }],
          selectedModelId: "sonnet",
          fastModeEnabled: false,
          fastModeAvailable: false,
          selectedModeId: "build",
          modes: [{ id: "build", label: "Build" }],
        },
      }),
      slashCommands: async () => [{
        name: "/review",
        description: "Review the current changes",
        argumentHint: "[focus]",
      }],
    });
    await withService({
      prefix: "orkestrator-native-projection-slash-",
      provider: async () => stub.provider,
      now: () => now,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:tab-slash",
      };
      await service.ensureSession(identity);
      const first = await service.getProjection(identity);
      expect(first?.slashCommands).toEqual([{
        name: "/review",
        description: "Review the current changes",
        argumentHint: "[focus]",
      }]);
      await service.getProjection(identity);
      expect(stub.slashCommands).toHaveBeenCalledTimes(1);

      now += 30_001;
      await service.getProjection(identity);
      expect(stub.slashCommands).toHaveBeenCalledTimes(2);
    });
  });



  test("does not hold an updated transcript behind expired discovery metadata", async () => {
    let now = 1_000;
    let message = "old transcript";
    let releaseCatalog!: () => void;
    let releaseCommands!: () => void;
    const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    const commandGate = new Promise<void>((resolve) => { releaseCommands = resolve; });
    let catalogReads = 0;
    let catalogRefreshFinished = false;
    const invoke: Invoke = async <T>(command: string): Promise<T> => {
      if (command !== "get_native_agent_model_catalog") {
        throw new Error(`Unexpected backend command: ${command}`);
      }
      catalogReads += 1;
      if (catalogReads > 1) {
        await catalogGate;
        catalogRefreshFinished = true;
      }
      return [{
        platform: "codex",
        id: catalogReads > 1 ? "gpt-new" : "gpt-old",
        label: catalogReads > 1 ? "GPT new" : "GPT old",
      }] as T;
    };
    let commandReads = 0;
    let commandRefreshFinished = false;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [{
          id: "message-1",
          role: "assistant",
          content: message,
          parts: [],
          createdAt: "2026-08-14T10:00:00.000Z",
        }],
      }),
      slashCommands: async () => {
        commandReads += 1;
        if (commandReads > 1) {
          await commandGate;
          commandRefreshFinished = true;
        }
        return [{ name: commandReads > 1 ? "/new" : "/old" }];
      },
    });
    await withService({
      prefix: "orkestrator-native-stale-discovery-",
      provider: async () => stub.provider,
      invoke,
      now: () => now,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-stale-discovery",
      };
      await service.ensureSession(identity);
      await service.getProjection(identity);

      now += 30_001;
      message = "latest transcript";
      const projection = await Promise.race([
        service.getProjection(identity),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Transcript waited for discovery metadata")), 100);
        }),
      ]);

      expect(projection?.messages).toEqual([
        expect.objectContaining({ content: "latest transcript" }),
      ]);
      expect(projection?.composer?.models).toEqual([
        expect.objectContaining({ id: "gpt-old" }),
      ]);
      expect(projection?.slashCommands?.map((command) => command.name))
        .toEqual(["/old", "/steer"]);

      releaseCatalog();
      releaseCommands();
      await waitForCondition(() => catalogRefreshFinished && commandRefreshFinished);
      const updated = await service.getProjection(identity);
      expect(updated?.composer?.models).toEqual([
        expect.objectContaining({ id: "gpt-new" }),
      ]);
      expect(updated?.slashCommands?.map((command) => command.name))
        .toEqual(["/new", "/steer"]);
    });
  });



  test("runs fresh discovery after an explicit refresh overlaps stale background work", async () => {
    let now = 1_000;
    let releaseCatalog!: () => void;
    let releaseCommands!: () => void;
    const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    const commandGate = new Promise<void>((resolve) => { releaseCommands = resolve; });
    let catalogReads = 0;
    let staleCatalogSettled = false;
    const invoke: Invoke = async <T>(command: string): Promise<T> => {
      if (command !== "get_native_agent_model_catalog") {
        throw new Error(`Unexpected backend command: ${command}`);
      }
      catalogReads += 1;
      if (catalogReads === 2) {
        await catalogGate;
        staleCatalogSettled = true;
      }
      return [{
        platform: "codex",
        id: catalogReads > 2 ? "gpt-new" : "gpt-old",
        label: catalogReads > 2 ? "GPT new" : "GPT old",
      }] as T;
    };
    let commandReads = 0;
    let staleCommandsSettled = false;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      slashCommands: async () => {
        commandReads += 1;
        if (commandReads === 2) {
          await commandGate;
          staleCommandsSettled = true;
        }
        return [{ name: commandReads > 2 ? "/new" : "/old" }];
      },
      refreshCatalog: () => undefined,
    });
    await withService({
      prefix: "orkestrator-native-forced-discovery-",
      provider: async () => stub.provider,
      invoke,
      now: () => now,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-forced-discovery",
      };
      try {
        await service.ensureSession(identity);
        const initial = await service.getProjection(identity);
        expect(initial?.composer?.models.map((model) => model.id)).toEqual(["gpt-old"]);
        expect(initial?.slashCommands?.map((command) => command.name))
          .toEqual(["/old", "/steer"]);

        now += 30_001;
        await service.getProjection(identity);
        await waitForCondition(() => catalogReads === 2 && commandReads === 2);

        const refreshedProjection = service.refreshProjectionModels(identity);
        await Promise.resolve();
        expect(catalogReads).toBe(2);
        expect(commandReads).toBe(2);

        // Both gates are still closed: an explicit refresh discards the stale
        // reads instead of inheriting their latency, which for a wedged bridge
        // is a full request timeout.
        const refreshed = await refreshedProjection;
        expect(staleCatalogSettled).toBe(false);
        expect(staleCommandsSettled).toBe(false);
        expect(stub.refreshCatalog).toHaveBeenCalledTimes(1);
        expect(catalogReads).toBe(3);
        expect(commandReads).toBe(3);
        expect(refreshed?.composer?.models.map((model) => model.id)).toEqual(["gpt-new"]);
        expect(refreshed?.slashCommands?.map((command) => command.name))
          .toEqual(["/new", "/steer"]);

        // The discarded reads finishing later must not overwrite the catalogue
        // the explicit refresh just installed.
        releaseCatalog();
        releaseCommands();
        await waitForCondition(() => staleCatalogSettled && staleCommandsSettled);
        const settled = await service.getProjection(identity);
        expect(catalogReads).toBe(3);
        expect(commandReads).toBe(3);
        expect(settled?.composer?.models.map((model) => model.id)).toEqual(["gpt-new"]);
        expect(settled?.slashCommands?.map((command) => command.name))
          .toEqual(["/new", "/steer"]);
      } finally {
        releaseCatalog();
        releaseCommands();
      }
    });
  });



  test("backs a failed background discovery off instead of retrying every poll", async () => {
    let now = 1_000;
    let catalogReads = 0;
    const invoke: Invoke = async <T>(command: string): Promise<T> => {
      if (command !== "get_native_agent_model_catalog") {
        throw new Error(`Unexpected backend command: ${command}`);
      }
      catalogReads += 1;
      if (catalogReads > 1) throw new Error("Model discovery is unavailable");
      return [{ platform: "codex", id: "gpt-old", label: "GPT old" }] as T;
    };
    let commandReads = 0;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      slashCommands: async () => {
        commandReads += 1;
        if (commandReads > 1) throw new Error("Command discovery is unavailable");
        return [{ name: "/old" }];
      },
    });
    await withService({
      prefix: "orkestrator-native-discovery-backoff-",
      provider: async () => stub.provider,
      invoke,
      now: () => now,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-discovery-backoff",
      };
      await service.ensureSession(identity);
      await service.getProjection(identity);
      expect(catalogReads).toBe(1);
      expect(commandReads).toBe(1);

      now += 30_001;
      const stale = await service.getProjection(identity);
      expect(stale?.composer?.models.map((model) => model.id)).toEqual(["gpt-old"]);
      expect(stale?.slashCommands?.map((command) => command.name))
        .toEqual(["/old", "/steer"]);

      // A failed optional endpoint must not be re-probed on every 500ms
      // projection poll, so the retained entry carries an explicit back-off.
      const caches = service as unknown as {
        modelCatalogCache: Map<string, { expiresAt: number }>;
        slashCommandCache: Map<string, { expiresAt: number }>;
      };
      await waitForCondition(() => (
        caches.modelCatalogCache.get("env-1")?.expiresAt === now + 5_000
        && caches.slashCommandCache.get("env-1\0codex")?.expiresAt === now + 5_000
      ));
      expect(catalogReads).toBe(2);
      expect(commandReads).toBe(2);

      now += 4_999;
      const withinBackoff = await service.getProjection(identity);
      expect(catalogReads).toBe(2);
      expect(commandReads).toBe(2);
      expect(withinBackoff?.composer?.models.map((model) => model.id)).toEqual(["gpt-old"]);
      expect(withinBackoff?.slashCommands?.map((command) => command.name))
        .toEqual(["/old", "/steer"]);

      now += 2;
      await service.getProjection(identity);
      await waitForCondition(() => catalogReads === 3 && commandReads === 3);
    });
  });



  test("advertises runtime session-action commands beside provider discovery", async () => {
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      slashCommands: async () => [{ name: "/review", description: "Review changes" }],
    });
    await withService({
      prefix: "orkestrator-native-projection-actions-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-actions",
      };
      await service.ensureSession(identity);
      const projection = await service.getProjection(identity);
      // `/steer` is performed by the runtime rather than the model, so it has
      // to be advertised by whoever knows the capability — not by a tab.
      expect(projection?.slashCommands?.map((command) => command.name))
        .toEqual(["/review", "/steer"]);
      expect(projection?.capabilities.attachments).toEqual({
        files: false,
        images: true,
      });
    });
  });



  /*
   * The renderer gates the composer's enqueue on its own adapter capabilities
   * and the backend gates the projection's queue on the protocol table. Those
   * used to be separate copies, so a one-sided edit produced a prompt that
   * dispatched but never showed up in the queue list. Assert the projection
   * really publishes the shared table rather than anything of its own.
   */
  test.each([...BUILD_PIPELINE_AGENTS])(
    "publishes the shared %s capability table through the projection",
    async (agent) => {
      const stub = createProviderStub(agent, {
        interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      });
      await withService({
        prefix: `orkestrator-native-${agent}-capability-table-`,
        provider: async () => stub.provider,
      }, async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent,
          logicalSessionKey: `env-env-1:tab-${agent}-capabilities`,
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.capabilities).toEqual(nativeAgentCapabilities(agent));
      });
    },
  );



  test("orders resumable sessions by most recent activity", async () => {
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    });
    (stub.provider as { listResumableSessions?: unknown }).listResumableSessions =
      async () => [
        { sessionId: "older", updatedAt: "2026-08-01T00:00:00.000Z" },
        { sessionId: "undated" },
        { sessionId: "newest", updatedAt: "2026-08-14T00:00:00.000Z", status: "running" as const },
      ];
    await withService({
      prefix: "orkestrator-native-projection-resume-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:tab-resume",
      };
      await service.ensureSession(identity);
      const entries = await service.listProjectionResumableSessions(identity);
      // Providers return their own order; the picker must not have to know
      // which field each provider sorts on. Undated entries sink.
      expect(entries.map((entry) => entry.sessionId))
        .toEqual(["newest", "older", "undated"]);
      expect(entries[0]?.status).toBe("running");
    });
  });



  test("windows a long transcript and reports that it was truncated", async () => {
    const messages = Array.from({ length: 600 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant" as const,
      content: `line ${index}`,
      parts: [],
      createdAt: "2026-08-14T10:00:00.000Z",
    }));
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });
    await withService({
      prefix: "orkestrator-native-projection-window-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:tab-window",
      };
      await service.ensureSession(identity);
      const bounded = await service.getProjection(identity);
      expect(bounded?.messages).toHaveLength(512);
      expect(bounded?.messageWindow).toEqual({
        limit: 512,
        truncated: true,
        truncationReason: "count",
      });

      const expanded = await service.getProjection({ ...identity, messageLimit: 1_024 });
      expect(expanded?.messages).toHaveLength(600);
      expect(expanded?.messageWindow).toEqual({ limit: 1_024, truncated: false });

      // A caller that asks for nothing — the reconciler, the info panel —
      // inherits the expanded window instead of collapsing the tab's view.
      const inherited = await service.getProjection(identity);
      expect(inherited?.messages).toHaveLength(600);
    });
  });



  test("uses a byte-aware tail instead of failing an oversized projection", async () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant" as const,
      content: String(index).repeat(1024 * 1024),
      parts: [],
      createdAt: "2026-08-15T10:00:00.000Z",
    }));
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });
    await withService({
      prefix: "orkestrator-native-byte-window-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-byte-window",
      };
      await service.ensureSession(identity);
      const projection = await service.getProjection(identity);
      expect(projection?.connection).toBe("connected");
      expect(projection?.messageWindow).toMatchObject({
        truncated: true,
        truncationReason: "bytes",
      });
      expect(Buffer.byteLength(JSON.stringify(projection?.messages)))
        .toBeLessThanOrEqual(NATIVE_PROJECTION_MAX_BYTES);
      expect(projection?.messages.length).toBeLessThan(messages.length);
      expect((projection?.messages.at(-1) as { id?: string })?.id).toBe("message-19");
    });
  });



  test("reports a non-serializable transcript as an unavailable provider", async () => {
    // The bound measures with `JSON.stringify`, so a circular part surfaces
    // there. It is a transport violation, not something to hand a renderer.
    const circular: Record<string, unknown> = { type: "text", content: "loop" };
    circular.self = circular;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [{
          id: "assistant-1",
          role: "assistant" as const,
          content: "done",
          parts: [circular],
          createdAt: "2026-08-15T10:00:00.000Z",
        }],
      }),
    });
    await withService({
      prefix: "orkestrator-native-unserializable-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-unserializable",
      };
      await service.ensureSession(identity);
      const projection = await service.getProjection(identity);
      expect(projection?.connection).toBe("error");
    });
  });



  test("refuses a tool detail reference belonging to another session", async () => {
    // `detailRef` is a bearer token for transcript content. It is hashed with
    // the session key precisely so one tab cannot read another tab's output by
    // replaying a reference, and the lookup must enforce that rather than trust
    // the hash to be unguessable.
    const messages = [{
      id: "assistant-1",
      role: "assistant" as const,
      content: "done",
      parts: [{
        type: "tool-invocation",
        content: "cat secrets.txt",
        toolName: "bash",
        toolState: "success",
        toolOutput: "the other tab's output",
      }],
      createdAt: "2026-08-15T10:00:00.000Z",
    }];
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });
    await withService({
      prefix: "orkestrator-native-detail-scope-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const owner = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-owner",
      };
      const other = { ...owner, logicalSessionKey: "env-env-1:tab-other" };
      await service.ensureSession(owner);
      await service.ensureSession(other);
      const projection = await service.getProjection(owner);
      const detailRef = (projection?.messages[0] as {
        parts: Array<{ detailRef?: string }>;
      }).parts[0]?.detailRef;
      expect(detailRef).toBeString();

      // The owning tab reads it back.
      expect(await service.getProjectionToolDetails({ ...owner, detailRef: detailRef! }))
        .toMatchObject({ toolOutput: "the other tab's output" });
      // A different logical session presenting the same reference does not.
      await expect(
        service.getProjectionToolDetails({ ...other, detailRef: detailRef! }),
      ).rejects.toThrow("no longer available");
    });
  });

  test("preserves a bounded background-task id when launch output is deferred", async () => {
    const messages = [{
      id: "assistant-background",
      role: "assistant" as const,
      content: "",
      parts: [
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolState: "success",
          toolArgs: { command: "bun test", run_in_background: true },
          toolOutput:
            "Command running in background with ID: bg-suite. Output is being written elsewhere.",
        },
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolState: "success",
          toolArgs: { command: "bun run dev", run_in_background: true },
          toolOutput: `Command running in background with ID: ${"x".repeat(513)}.`,
        },
      ],
      createdAt: "2026-08-15T10:00:00.000Z",
    }];
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });

    await withService({
      prefix: "orkestrator-native-background-correlation-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:tab-background",
      };
      await service.ensureSession(identity);
      const projection = await service.getProjection(identity);
      const parts = (projection?.messages[0] as {
        parts: Array<{
          backgroundTaskId?: string;
          detailRef?: string;
          toolOutput?: string;
        }>;
      }).parts;
      const part = parts[0];

      expect(part).toMatchObject({
        backgroundTaskId: "bg-suite",
        detailRef: expect.any(String),
      });
      expect(part?.toolOutput).toBeUndefined();
      expect(parts[1]?.backgroundTaskId).toBeUndefined();
    });
  });

  test("recovers a launch id a command was backgrounded into after it started", async () => {
    /*
     * Ctrl+B and a foreground timeout both background a command that was
     * launched without `run_in_background`, so the argument cannot decide this.
     * Since the projection strips every `toolOutput`, refusing to scan these
     * rows would leave the renderer with no way to reach the id at all.
     */
    const messages = [{
      id: "assistant-backgrounded",
      role: "assistant" as const,
      content: "",
      parts: [
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolState: "success",
          toolArgs: { command: "bun run dev" },
          toolOutput: "Command was manually backgrounded by user with ID: bg-dev",
        },
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolState: "success",
          toolArgs: { command: "bun run build" },
          toolOutput:
            "Command exceeded its timeout and was moved to the background (ID: bg-build). Use BashOutput.",
        },
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolState: "success",
          toolArgs: { command: "bun test" },
          toolOutput: '{"task_id":"bg-json"}',
        },
        {
          // Reading a file that quotes the note is not a launch. Decorating it
          // would put a stop control on an id naming somebody else's work.
          type: "tool-invocation",
          content: "Read",
          toolName: "Read",
          toolState: "success",
          toolArgs: { file_path: "/repo/native-message-adapters.ts" },
          toolOutput: "Command running in background with ID: bg-suite. …",
        },
      ],
      createdAt: "2026-08-15T10:00:00.000Z",
    }];
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });

    await withService({
      prefix: "orkestrator-native-background-late-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:tab-late-background",
      };
      await service.ensureSession(identity);
      const projection = await service.getProjection(identity);
      const parts = (projection?.messages[0] as {
        parts: Array<{ backgroundTaskId?: string }>;
      }).parts;

      expect(parts.map((part) => part.backgroundTaskId)).toEqual([
        "bg-dev",
        "bg-build",
        "bg-json",
        undefined,
      ]);
    });
  });

  test("rejects a blank or oversized tool detail reference", async () => {
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    });
    await withService({
      prefix: "orkestrator-native-detail-validation-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-validation",
      };
      await service.ensureSession(identity);

      await expect(service.getProjectionToolDetails({ ...identity, detailRef: "   " }))
        .rejects.toThrow("invalid");
      await expect(
        service.getProjectionToolDetails({ ...identity, detailRef: "a".repeat(129) }),
      ).rejects.toThrow("invalid");
    });
  });



  test("re-reads the provider when a cached tool detail was evicted", async () => {
    // The detail cache is bounded and shared across every session, so a busy
    // host will evict entries the renderer still has references to. Expanding
    // that row must recover from the authoritative provider snapshot rather
    // than report the output as lost.
    const messages = [{
      id: "assistant-1",
      role: "assistant" as const,
      content: "done",
      parts: [{
        type: "tool-invocation",
        content: "bun test",
        toolName: "bash",
        toolState: "success",
        toolOutput: "recovered after eviction",
      }],
      createdAt: "2026-08-15T10:00:00.000Z",
    }];
    let snapshots = 0;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => {
        snapshots += 1;
        return { status: "idle", messages };
      },
    });
    await withService({
      prefix: "orkestrator-native-detail-eviction-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-eviction",
      };
      await service.ensureSession(identity);
      const projection = await service.getProjection(identity);
      const detailRef = (projection?.messages[0] as {
        parts: Array<{ detailRef?: string }>;
      }).parts[0]?.detailRef;
      expect(detailRef).toBeString();

      // Simulate capacity eviction of exactly this entry.
      (service as unknown as {
        toolDetailCache: Map<string, unknown>;
        toolDetailCacheBytes: number;
      }).toolDetailCache.clear();
      (service as unknown as { toolDetailCacheBytes: number }).toolDetailCacheBytes = 0;
      const snapshotsBefore = snapshots;

      expect(await service.getProjectionToolDetails({ ...identity, detailRef: detailRef! }))
        .toMatchObject({ toolOutput: "recovered after eviction" });
      expect(snapshots).toBeGreaterThan(snapshotsBefore);
    });
  });



  test("pins a requested visible detail while capacity recovery rebuilds the cache", async () => {
    const messages = [{
      id: "assistant-capacity",
      role: "assistant" as const,
      content: "done",
      parts: Array.from({ length: 3 }, (_, index) => ({
        type: "tool-invocation",
        content: `tool-${index}`,
        toolName: "bash",
        toolState: "success" as const,
        toolOutput: `${index}:${"x".repeat(1_200)}`,
      })),
      createdAt: "2026-08-15T10:00:00.000Z",
    }];
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });
    await withService({
      prefix: "orkestrator-native-detail-capacity-",
      provider: async () => stub.provider,
      toolDetailCacheMaxBytes: 2_700,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-capacity",
      };
      await service.ensureSession(identity);
      const projection = await service.getProjection(identity);
      const refs = (projection?.messages[0] as {
        parts: Array<{ detailRef?: string }>;
      }).parts.map((part) => part.detailRef!);
      const cache = (service as unknown as {
        toolDetailCache: Map<string, unknown>;
      }).toolDetailCache;
      expect(cache.has(refs[0]!)).toBe(false);

      await expect(service.getProjectionToolDetails({
        ...identity,
        detailRef: refs[0]!,
      })).resolves.toMatchObject({ toolOutput: expect.stringMatching(/^0:/) });
    });
  });



  test("replaces tool details that exceed the deferred display limit", async () => {
    // The per-entry cap is a memory bound on the detail cache. Exceeding it
    // must degrade to an explicit notice, never to a silent empty expansion.
    const messages = [{
      id: "assistant-1",
      role: "assistant" as const,
      content: "done",
      parts: [{
        type: "tool-invocation",
        content: "bun run build",
        toolName: "bash",
        toolState: "success",
        toolOutput: "x".repeat(5 * 1024 * 1024),
      }],
      createdAt: "2026-08-15T10:00:00.000Z",
    }];
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });
    await withService({
      prefix: "orkestrator-native-detail-limit-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-detail-limit",
      };
      await service.ensureSession(identity);
      const projection = await service.getProjection(identity);
      const detailRef = (projection?.messages[0] as {
        parts: Array<{ detailRef?: string }>;
      }).parts[0]?.detailRef;

      const details = await service.getProjectionToolDetails({
        ...identity,
        detailRef: detailRef!,
      });
      expect(details.toolOutput).toBeUndefined();
      expect(details.toolError).toBe("Tool details exceeded the deferred display limit.");
    });
  });



  test("projects pending interactions and routes neutral stop, controls, and resolution", async () => {
    const resolveInteraction = mock(async () => ({
      result: "applied" as const,
      interactionId: "interaction-0",
      sessionId: "provider-session",
      revision: 2,
    }));
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({
        status: "running",
        messages: [],
        composer: {
          models: [{ platform: "codex", id: "gpt-5", label: "GPT-5" }],
          selectedModelId: "gpt-5",
          fastModeEnabled: false,
          fastModeAvailable: true,
          selectedModeId: "build",
          modes: [{ id: "build", label: "Build" }],
        },
      }),
      interactions: {
        listPendingInteractions: async () => pendingInteractionSnapshot(10_000, ["permission"]),
        resolveInteraction,
      },
      updateInteractiveControls: async () => undefined,
    });
    await withService({
      prefix: "orkestrator-native-projection-intents-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      await service.ensureSession({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "env-env-1:tab-1",
      });
      const identity = {
        environmentId: "env-1",
        agent: "codex" as const,
        logicalSessionKey: "env-env-1:tab-1",
      };
      const blocked = await service.getProjection(identity);
      expect(blocked).toMatchObject({
        turn: { phase: "blocked" },
        interactions: [{ id: "interaction-0", kind: "permission" }],
      });

      await service.updateProjectionControls({
        ...identity,
        update: { modelId: "gpt-5", fastMode: true },
      });
      expect(stub.updateInteractiveControls).toHaveBeenCalledWith(
        "provider-session",
        { modelId: "gpt-5", fastMode: true },
      );

      const resolution = {
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        interactionId: "interaction-0",
        sessionId: "provider-session",
        action: "decline" as const,
        resolvedAt: 10_001,
      };
      await service.resolveProjectionInteraction({
        ...identity,
        interactionId: "interaction-0",
        resolution,
      });
      expect(resolveInteraction).toHaveBeenCalledWith(
        "provider-session",
        "interaction-0",
        resolution,
      );

      await service.stopProjectionSession(identity);
      expect(stub.abort).toHaveBeenCalledWith("provider-session");
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
    } as AgentSessionProvider;
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
    } as AgentSessionProvider;
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

});
