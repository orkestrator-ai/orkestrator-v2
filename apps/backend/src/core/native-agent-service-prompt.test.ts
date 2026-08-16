import { describe,expect,mock,test } from "bun:test";


import { promises as fs } from "node:fs";


import { tmpdir } from "node:os";


import path from "node:path";


import {
type BuildPipelineAgent
} from "@orkestrator/protocol/build-pipeline";




import {
INTERACTIVE_AGENT_INTERACTION_POLICY,
UNATTENDED_AGENT_INTERACTION_POLICY
} from "@orkestrator/protocol/agent-interactions";


import {
type AgentInteractionProviderCapability,
type AgentSessionProvider,
type NativeAgentRuntimeProvider,
type ProviderActivityState,
type ProviderInteractiveSnapshot,
type ProviderSendOptions,
type ProviderStatus
} from "./native-agent-provider.js";




import {
NativeAgentService,
nativeAgentSessionStorageKey,
type NativeAgentServiceOptions
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

describe("NativeAgentService", () => {



  test("resolves a composer reasoning id the selected model actually offers", async () => {
    // No `selectedReasoningId` on the provider composer and no persisted
    // controls, so the projection has to derive one from the catalogue.
    const composerWith = (
      reasoning: Array<{ id: string; label: string }>,
      defaultReasoningId: string,
    ) => async () => ({
      status: "idle" as const,
      messages: [],
      composer: {
        models: [{
          platform: "claude" as const,
          id: "model-1",
          label: "Model 1",
          reasoning,
          defaultReasoningId,
        }],
        selectedModelId: "model-1",
        fastModeEnabled: false,
        fastModeAvailable: false,
        modes: [{ id: "build" as const, label: "Build" }],
      },
    });

    // "high" is on offer, so it outranks an advertised medium.
    await withService({
      prefix: "orkestrator-native-projection-reasoning-high-",
      provider: async () => createProviderStub("claude", {
        interactiveSnapshot: composerWith(
          [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
          "medium",
        ),
      }).provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:tab-reasoning-high",
      };
      await service.ensureSession(identity);
      await expect(service.getProjection(identity)).resolves.toMatchObject({
        composer: { selectedReasoningId: "high" },
      });
    });

    // With no "high" the model's advertised default must survive rather than
    // collapsing to the first listed option.
    await withService({
      prefix: "orkestrator-native-projection-reasoning-advertised-",
      provider: async () => createProviderStub("claude", {
        interactiveSnapshot: composerWith(
          [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "xhigh", label: "Extra high" },
          ],
          "medium",
        ),
      }).provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:tab-reasoning-advertised",
      };
      await service.ensureSession(identity);
      await expect(service.getProjection(identity)).resolves.toMatchObject({
        composer: { selectedReasoningId: "medium" },
      });
    });
  });



  test("keeps a persisted reasoning id ahead of the catalogue fallback", async () => {
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [{
            platform: "claude" as const,
            id: "model-1",
            label: "Model 1",
            reasoning: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
            defaultReasoningId: "high",
          }],
          selectedModelId: "model-1",
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [{ id: "build" as const, label: "Build" }],
        },
      }),
    });
    await withService({
      prefix: "orkestrator-native-projection-reasoning-persisted-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:tab-reasoning-persisted",
      };
      await service.ensureSession(identity);
      await service.updateProjectionControls({
        ...identity,
        update: { reasoningId: "low" },
      });

      // An explicit user choice must not be re-raised to "high" on every read.
      await expect(service.getProjection(identity)).resolves.toMatchObject({
        composer: { selectedReasoningId: "low" },
      });
    });
  });



  test("keeps persisted session options ahead of provider composer defaults", async () => {
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [],
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [{ id: "build", label: "Build" }],
          executionProfiles: [
            { id: "default", label: "Default" },
            { id: "reviewer", label: "Reviewer" },
          ],
          selectedExecutionProfileId: "default",
          includeLocalSettings: false,
          promptSuggestionsEnabled: false,
        },
      }),
    });
    await withService({
      prefix: "orkestrator-native-projection-session-options-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:tab-session-options",
      };
      await service.ensureSession(identity);

      const updated = await service.updateProjectionControls({
        ...identity,
        update: {
          executionProfileId: "reviewer",
          includeLocalSettings: true,
          promptSuggestions: true,
        },
      });

      expect(updated?.composer).toMatchObject({
        selectedExecutionProfileId: "reviewer",
        includeLocalSettings: true,
        promptSuggestionsEnabled: true,
      });
      await expect(service.getProjection(identity)).resolves.toMatchObject({
        composer: {
          selectedExecutionProfileId: "reviewer",
          includeLocalSettings: true,
          promptSuggestionsEnabled: true,
        },
      });
    });
  });



  test("routes neutral background-task and suggested-prompt intents", async () => {
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        backgroundTasks: [],
      }),
      stopBackgroundTask: async () => undefined,
      dismissSuggestedPrompt: async () => undefined,
    });
    await withService({
      prefix: "orkestrator-native-claude-parity-intents-",
      provider: async () => stub.provider,
    }, async ({ service }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:tab-1",
      };
      await service.ensureSession(identity);
      await service.stopProjectionBackgroundTask({ ...identity, taskId: "task/1" });
      await service.dismissProjectionSuggestedPrompt(identity);
      expect(stub.stopBackgroundTask).toHaveBeenCalledWith("provider-session", "task/1");
      expect(stub.dismissSuggestedPrompt).toHaveBeenCalledWith("provider-session");
    });
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
    } as AgentSessionProvider;
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
      const converged = await firstStorage.getEnvironment("env-1");
      expect(converged).toMatchObject({ pendingAgentLaunch: false });
      // The durable pane is what the launch converged on, so the transient
      // snapshot has reached its terminal state rather than lingering forever.
      expect(converged?.startupAgentSession).toBeUndefined();
      expect((await firstStorage.getPaneLayout("env-1"))?.root).toMatchObject({
        tabs: [
          { id: "default" },
          {
            id: "startup-agent",
            type: "agent-native",
            nativeAgentData: { platform: "codex", sessionId: "provider-session" },
          },
        ],
      });
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
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
        })).rejects.toThrow("prompt or attachment and request ID must not be blank");
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

});
