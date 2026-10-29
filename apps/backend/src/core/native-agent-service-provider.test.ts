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
  type NativeAgentProviderEnvironment,
  type NativeAgentRuntimeProvider,
  type ProviderActivityState,
  type ProviderInteractiveSnapshot,
  type ProviderSendOptions,
  type ProviderStatus,
} from "./native-agent-provider.js";
import { createCommandRegistry } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import { AmbiguousPromptDispatchError } from "./native-agent-provider.js";
import { WorkflowResultService } from "./workflow-result-service.js";
import { openCodeFake } from "./agent-provider-test-support.js";
import { OPENCODE_GO_ONLY_PROVIDER_LIST_RESPONSE } from "./opencode-provider-list-test-fixtures.js";
import { OpenCodeMessageIdCoordinator } from "@orkestrator/protocol/opencode-message-id";
import { seedUnreadableStore } from "./storage-test-support.js";
import { LocalServerRuntime } from "./local-server-runtime.js";

import type { Environment } from "./models.js";

import {
  NativeAgentService,
  nativeAgentSessionStorageKey,
  type EnsureNativeAgentSessionInput,
  type NativeAgentServiceOptions,
} from "./native-agent-service.js";

import { createProject, StorageService } from "./storage.js";

import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { collaborators, interactionInternals } from "./native-agent-service-test-collaborators.js";

/** The model earlier releases shipped as the OpenCode default. */
const LEGACY_OPENCODE_DEFAULT_MODEL_ID = "opencode/claude-sonnet-5";

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
    provider(input: EnsureNativeAgentSessionInput): Promise<AgentSessionProvider>;
    createProviderSession(
      provider: NativeAgentRuntimeProvider,
      input: EnsureNativeAgentSessionInput,
    ): Promise<string>;
    bridgeConnection(
      agent: BuildPipelineAgent,
      environment: Environment,
      model?: string,
      effort?: string,
    ): Promise<BridgeConnection>;
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
    resolveAgentToolConnection?: NativeAgentServiceOptions["resolveAgentToolConnection"];
    localBridgeAccountId?: NativeAgentServiceOptions["localBridgeAccountId"];
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
    ...(setup.resolveAgentToolConnection
      ? { resolveAgentToolConnection: setup.resolveAgentToolConnection }
      : {}),
    ...(setup.localBridgeAccountId ? { localBridgeAccountId: setup.localBridgeAccountId } : {}),
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
      origin: "automated-review",
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
  test("falls through to provider structured output when the workflow result store is malformed", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-provider-result-fallback-"));
    const workflowResults = new WorkflowResultService(dataDir);
    try {
      seedUnreadableStore(dataDir, "workflow-results.json", "{malformed");
      const bridgeResult = {
        ok: true as const,
        provider: "codex" as const,
        requestId: "request-1",
        value: { complete: true },
      };
      const bridgeFetch = mock(async () => Response.json({ structuredOutput: bridgeResult }));
      const provider = createNativeAgentProvider(
        {
          agent: "codex",
          baseUrl: "http://codex.test",
          authToken: "test-token",
        },
        {
          fetch: bridgeFetch as unknown as typeof fetch,
          workflowResults,
        },
      );

      await expect(provider.structured("session-1", "request-1")).resolves.toEqual(bridgeResult);
      expect(bridgeFetch).toHaveBeenCalledTimes(1);
    } finally {
      workflowResults.closeStorage();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

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
        async get() {
          return { data: { id: "provider-session", directory: "/workspace" } };
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

  // A login with only `opencode-go` connected, against the shipped default
  // `opencode/claude-sonnet-5`. The configured default used to become the new
  // session's controls, outranking OpenCode's own default, so the picker
  // preselected a model the dispatch preflight then rejected.
  test("starts a new OpenCode tab on the connected default when the configured one is not connected", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: { list: mock(async () => ({ data: OPENCODE_GO_ONLY_PROVIDER_LIST_RESPONSE })) },
    });
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
      },
      {
        openCodeClient: fake.client,
        openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
      },
    );

    await withService(
      {
        prefix: "orkestrator-native-opencode-connected-default-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:tab-opencode",
          origin: "interactive-native" as const,
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        };
        const config = await storage.loadConfig();

        const ensure = createCommandRegistry().get("ensure_native_agent_session")!;
        const session = (await ensure(
          {
            ...identity,
            model: LEGACY_OPENCODE_DEFAULT_MODEL_ID,
            modelSource: "default",
          },
          { storage, nativeAgents: service } as unknown as CommandContext,
        )) as Awaited<ReturnType<NativeAgentService["ensureSession"]>>;

        expect(session.controls?.modelId).toBe("opencode-go/gpt-5.6-luna");
        expect(session.modelSubstitution).toEqual({
          requestedModelId: "opencode/claude-sonnet-5",
          modelId: "opencode-go/gpt-5.6-luna",
          message: "claude-sonnet-5 isn't available with your OpenCode login; using GPT-5.6 Luna.",
        });
        // Persisted controls only; the substitution is reported, not stored,
        // and the user's configuration keeps their choice.
        const stored = await storage.getNativeAgentSession(
          nativeAgentSessionStorageKey("env-1", "opencode", identity.logicalSessionKey),
        );
        expect(stored).not.toHaveProperty("modelSubstitution");
        expect(await storage.loadConfig()).toEqual(config);

        // The picker preselects the connected model and offers nothing else.
        const projection = await service.getProjection(identity);
        expect(projection?.composer?.selectedModelId).toBe("opencode-go/gpt-5.6-luna");
        expect(
          projection?.composer?.models.every((model) => model.id.startsWith("opencode-go/")),
        ).toBe(true);

        // Dispatch the original inherited choice through the command boundary,
        // without copying a model from the renderer projection first.
        const dispatch = createCommandRegistry().get("dispatch_native_agent_intent")!;
        await expect(
          dispatch(
            {
              ...identity,
              prompt: "Please continue",
              requestId: "request-1",
              model: LEGACY_OPENCODE_DEFAULT_MODEL_ID,
              modelSource: "default",
            },
            { storage, nativeAgents: service } as unknown as CommandContext,
          ),
        ).resolves.toEqual({ outcome: "accepted", requestId: "request-1" });
        expect(fake.promptCalls).toHaveLength(1);
        expect(fake.promptCalls[0]?.model).toMatchObject({
          providerID: "opencode-go",
          modelID: "gpt-5.6-luna",
        });
      },
    ).finally(() => provider.dispose?.());
  });

  // A new install's Codex default is `gpt-5.4`, which a ChatGPT login's
  // `model/list` does not offer. Codex runs the session's configured model, so
  // creating the session with it failed every turn while the picker showed the
  // catalogue's first model.
  test("starts a new Codex tab on an offered model when the configured default is not offered", async () => {
    const created: unknown[] = [];
    const provider = createNativeAgentProvider(
      {
        agent: "codex",
        baseUrl: "http://codex.test",
        authToken: "codex-token",
        requestTimeoutMs: 1_000,
      },
      {
        fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
          const url = String(input);
          if (url.endsWith("/global/models")) {
            return Response.json({
              source: "app-server",
              supportedModelIds: ["gpt-6.1-sol", "gpt-6.1-sol-mini"],
              models: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol" }],
            });
          }
          if (url.endsWith("/session/create")) {
            created.push(JSON.parse(String(init.body)));
            return Response.json({ sessionId: "codex-thread-1" });
          }
          throw new Error(`Unexpected Codex bridge request: ${url}`);
        }) as typeof fetch,
      },
    );
    await withService(
      { prefix: "orkestrator-native-codex-offered-default-", provider: async () => provider },
      async ({ storage, service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-codex",
          origin: "interactive-native" as const,
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        };
        const config = await storage.loadConfig();

        const ensure = createCommandRegistry().get("ensure_native_agent_session")!;
        const session = (await ensure({ ...identity, model: "gpt-5.4", modelSource: "default" }, {
          storage,
          nativeAgents: service,
        } as unknown as CommandContext)) as Awaited<
          ReturnType<NativeAgentService["ensureSession"]>
        >;

        expect(created).toEqual([expect.objectContaining({ model: "gpt-6.1-sol" })]);
        expect(session.controls?.modelId).toBe("gpt-6.1-sol");
        expect(session.modelSubstitution).toEqual({
          requestedModelId: "gpt-5.4",
          modelId: "gpt-6.1-sol",
          message: "gpt-5.4 isn't available with your Codex login; using GPT-6.1-Sol.",
        });
        // For this session only: the configured default keeps the user's choice.
        expect(await storage.loadConfig()).toEqual(config);
      },
    );
  });

  test("keeps an explicit Codex model the catalogue does not offer", async () => {
    const created: unknown[] = [];
    const requests: string[] = [];
    const provider = createNativeAgentProvider(
      { agent: "codex", baseUrl: "http://codex.test", authToken: "codex-token" },
      {
        fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
          requests.push(String(input));
          created.push(JSON.parse(String(init.body)));
          return Response.json({ sessionId: "codex-thread-1" });
        }) as typeof fetch,
      },
    );
    await withService(
      { prefix: "orkestrator-native-codex-explicit-", provider: async () => provider },
      async ({ service }) => {
        const session = await service.ensureSession({
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: "env-env-1:tab-codex-explicit",
          model: "gpt-5.4",
          modelSource: "explicit",
        });

        expect(requests).toEqual(["http://codex.test/session/create"]);
        expect(created).toEqual([expect.objectContaining({ model: "gpt-5.4" })]);
        expect(session.controls?.modelId).toBe("gpt-5.4");
        expect(session.modelSubstitution).toBeUndefined();
      },
    );
  });

  test("keeps an explicit disconnected initial model without reporting a substitution", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: { list: async () => ({ data: OPENCODE_GO_ONLY_PROVIDER_LIST_RESPONSE }) },
    });
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
      },
      {
        openCodeClient: fake.client,
        openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
      },
    );
    await withService(
      { prefix: "ork-explicit-model-", provider: async () => provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "explicit-tab",
        };
        const session = await service.ensureSession({
          ...identity,
          model: LEGACY_OPENCODE_DEFAULT_MODEL_ID,
          modelSource: "explicit",
        });
        expect(session.controls?.modelId).toBe(LEGACY_OPENCODE_DEFAULT_MODEL_ID);
        expect(session.modelSubstitution).toBeUndefined();
        expect(
          await service.dispatchIntent({
            ...identity,
            model: LEGACY_OPENCODE_DEFAULT_MODEL_ID,
            prompt: "Go",
            requestId: "explicit-1",
          }),
        ).toMatchObject({ outcome: "rejected", error: expect.stringContaining("not connected") });
        expect(fake.promptCalls).toHaveLength(0);
      },
    ).finally(() => provider.dispose?.());
  });

  for (const ambiguous of [false, true]) {
    test(`native job dispatch retains its resolved inherited selection (ambiguous=${ambiguous})`, async () => {
      const fake = openCodeFake();
      Object.assign(fake.client as object, {
        provider: { list: async () => ({ data: OPENCODE_GO_ONLY_PROVIDER_LIST_RESPONSE }) },
      });
      const provider = createNativeAgentProvider(
        {
          agent: "opencode",
          baseUrl: "http://opencode.test",
          authToken: "test-token",
          directory: "/workspace",
        },
        {
          openCodeClient: fake.client,
          openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
        },
      );
      const send = provider.send.bind(provider);
      let loseResponse = ambiguous;
      provider.send = async (id, prompt, options) => {
        if (loseResponse) {
          loseResponse = false;
          throw new AmbiguousPromptDispatchError("response lost");
        }
        return send(id, prompt, options);
      };
      await withService(
        { prefix: "ork-job-model-", provider: async () => provider },
        async ({ storage, service }) => {
          const config = await storage.loadConfig();
          await storage.saveConfig({
            ...config,
            global: {
              ...config.global,
              enabledAgentPlatforms: ["opencode"],
              agentSettings: {
                platforms: { opencode: { model: LEGACY_OPENCODE_DEFAULT_MODEL_ID } },
              },
            },
          });
          const savedConfig = await storage.loadConfig();
          const context = {
            storage,
            nativeAgents: service,
            emit: () => undefined,
          } as unknown as CommandContext;
          const command = createCommandRegistry().get("launch_native_agent_job")!;
          const result = (await command(
            { environmentId: "env-1", agent: "opencode", requestId: "job-1", prompt: "Go" },
            context,
          )) as { status: string; logicalSessionKey: string };
          const identity = {
            environmentId: "env-1",
            agent: "opencode" as const,
            logicalSessionKey: result.logicalSessionKey,
          };
          if (ambiguous) {
            expect(result.status).toBe("unknown");
            const stored = await storage.getNativeAgentSession(
              nativeAgentSessionStorageKey("env-1", "opencode", result.logicalSessionKey),
            );
            expect(stored?.pendingDispatch?.model).toBe("opencode-go/gpt-5.6-luna");
            await expect(
              service.retryRecoverableDispatch({ ...identity, requestId: "job-1" }),
            ).resolves.toEqual({ outcome: "accepted", requestId: "job-1" });
          } else expect(result.status).toBe("accepted");
          expect(fake.promptCalls[0]?.model).toMatchObject({
            providerID: "opencode-go",
            modelID: "gpt-5.6-luna",
          });
          expect(await storage.loadConfig()).toEqual(savedConfig);
        },
      ).finally(() => provider.dispose?.());
    });
  }

  test("keeps a configured OpenCode model whose provider is connected", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: { list: mock(async () => ({ data: OPENCODE_GO_ONLY_PROVIDER_LIST_RESPONSE })) },
    });
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
      },
      {
        openCodeClient: fake.client,
        openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
      },
    );

    await withService(
      {
        prefix: "orkestrator-native-opencode-connected-configured-",
        provider: async () => provider,
      },
      async ({ service }) => {
        const session = await service.ensureSession({
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "env-env-1:tab-opencode",
          origin: "interactive-native",
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
          model: "opencode-go/deepseek-v4.1-flash",
        });

        expect(session.controls?.modelId).toBe("opencode-go/deepseek-v4.1-flash");
        expect(session.modelSubstitution).toBeUndefined();
      },
    ).finally(() => provider.dispose?.());
  });

  // Nothing ships as the OpenCode default any more: unset is the effective
  // default, resolved here rather than left to OpenCode's server, whose own
  // default ignores the provider allowlist.
  test("starts an OpenCode tab with no configured model on the connected default", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: { list: mock(async () => ({ data: OPENCODE_GO_ONLY_PROVIDER_LIST_RESPONSE })) },
    });
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
      },
      {
        openCodeClient: fake.client,
        openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
      },
    );

    await withService(
      {
        prefix: "orkestrator-native-opencode-unset-default-",
        provider: async () => provider,
      },
      async ({ service }) => {
        const session = await service.ensureSession({
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "env-env-1:tab-opencode",
          origin: "interactive-native",
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        });

        expect(session.controls?.modelId).toBe("opencode-go/gpt-5.6-luna");
        expect(session.modelSubstitution).toBeUndefined();
      },
    ).finally(() => provider.dispose?.());
  });

  test("gives every provider creation site the live settings reader", async () => {
    await withService(
      { prefix: "orkestrator-native-provider-environment-" },
      async ({ storage, service }) => {
        // Whichever site creates the provider first (tab, activity observer or
        // tab close) caches it for the tab, so none may pass less than another.
        const environment = (
          service as unknown as {
            providerEnvironment(environmentId: string): NativeAgentProviderEnvironment;
          }
        ).providerEnvironment("env-1");
        expect(environment).toMatchObject({
          environmentId: "env-1",
          dataDir: storage.getDataDir(),
        });
        expect(environment.loadConfig).toBeFunction();

        const config = await storage.loadConfig();
        await storage.saveConfig({
          ...config,
          global: { ...config.global, openCodeModelProviders: ["hpc-ai"] },
        });
        // Read per call, so a settings edit reaches an already-cached provider.
        await expect(environment.loadConfig?.()).resolves.toMatchObject({
          global: { openCodeModelProviders: ["hpc-ai"] },
        });
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

  test("persists generic parameters when it creates a session", async () => {
    const stub = createProviderStub("claude");
    await withService(
      {
        prefix: "orkestrator-native-claude-parameter-defaults-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const input = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:claude-tab",
          parameterValues: { thinking: "budget-16384", context1m: true },
        };

        await service.ensureSession(input);

        const stored = await storage.getNativeAgentSession(
          nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
        );
        expect(stored?.controls?.parameterValues).toEqual(input.parameterValues);
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
        const logicalSessionKey = "automated-review:workflow:capability:Review";
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey,
          providerSessionId: "provider-session",
          origin: "automated-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        });
        await service.reconcileAgentInteractions();
        current = unsupported.provider;
        collaborators(service).providerRegistry.stateForTesting().providers.clear();
        await service.reconcileAgentInteractions();
        expect(service.getInteractionObservations()[0]).toMatchObject({
          providerState: "error",
          eventualOutcome: "expired",
        });
        expect(interactionInternals(service).trackedInteractions.size).toBe(0);
      },
    );
  });

  test("refuses a provider session whose create overlapped the environment's deletion intent", async () => {
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
      const ensureOutcome = ensure.then(
        () => "created" as const,
        (error: unknown) => error,
      );
      await createEntered;

      // The create holds only the native-agent lock, never the environments
      // lock, so the deletion intent lands while the provider call is still in
      // flight rather than queuing behind it.
      await storage.updateEnvironment("env-1", {
        deletionRequestedAt: new Date().toISOString(),
      });
      expect((await storage.getEnvironment("env-1"))?.deletionRequestedAt).toBeDefined();

      // The post-create fence then sees the intent: the mapping is refused and
      // nothing is published for an environment that is being deleted.
      releaseCreate?.();
      const outcome = await ensureOutcome;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("environment is unavailable");
      expect(createSession).toHaveBeenCalledTimes(1);
      await expect(storage.listNativeAgentSessions()).resolves.toEqual([]);
    } finally {
      releaseCreate?.();
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  describe("bridge connections", () => {
    test("binds local usage to the account recorded at bridge launch", async () => {
      const localServers = new LocalServerRuntime();
      localServers.adoptProcess("codex:env-1", {} as never, {
        workingDirectory: "/workspace",
        accountId: "account-a",
      });
      await withService(
        {
          prefix: "orkestrator-native-bridge-account-",
          invoke: (async () => ({ port: 4123, authToken: "token" })) as Invoke,
          localBridgeAccountId: (key) => localServers.launchedAccountId(key),
        },
        async ({ storage, service }) => {
          const environment = (await storage.getEnvironment("env-1"))!;
          expect((await internals(service).bridgeConnection("codex", environment)).accountId).toBe(
            "account-a",
          );
        },
      );
    });
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
            ...(agent === "claude" || agent === "codex" ? { accountId: "unknown" } : {}),
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
            ...(agent === "claude" || agent === "codex" ? { accountId: "unknown" } : {}),
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
          expect(
            [...collaborators(service).providerRegistry.stateForTesting().providers.keys()].sort(),
          ).toEqual(["env-1\u0000codex", "env-1\u0000opencode"]);
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
          expect(collaborators(service).providerRegistry.cached("env-1\0cursor")).toBe(replacement);
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

  test("stages a coordinator's images outside the checkout it may not write to", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-coordinator-stage-"));
    const storage = await createStorage(dataDir);
    const checkout = path.join(dataDir, "checkout");
    await fs.mkdir(checkout);
    const project = await storage.addProject(createProject("remote", checkout));
    const now = new Date(0).toISOString();
    await storage.coordinators.mutateCoordinatorWorkspace(project.id, () => ({
      version: COORDINATOR_WORKSPACE_VERSION,
      id: "coordinator-1",
      projectId: project.id,
      executionPolicy: COORDINATOR_EXECUTION_POLICY,
      lifecycleState: "ready",
      conversations: [
        {
          id: "conversation-1",
          tabId: "coordinator-tab",
          logicalSessionKey: "coordinator-coordinator-1:conversation-1",
          agent: "codex",
          title: "Coordinator",
          createdAt: now,
          mailboxIncarnationId: "incarnation-1",
        },
      ],
      selectedConversationId: "conversation-1",
      repositoryContextRevision: 0,
      createdAt: now,
      updatedAt: now,
    }));
    // Reaching a workspace-staging command at all would mean writing into the
    // user's own checkout, which is the one thing a read-only coordinator must
    // never do — so the invoker refuses every command.
    const service = new NativeAgentService(storage, refusingInvoke, {});
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    try {
      const runtimeId = coordinatorRuntimeId("coordinator-1", "conversation-1");
      internals(service).bridgeConnection = async () => ({
        agent: "codex",
        baseUrl: "http://127.0.0.1:4123",
        authToken: "token",
        directory: checkout,
      });
      const provider = await internals(service).provider({
        environmentId: runtimeId,
        agent: "codex",
        logicalSessionKey: "coordinator-coordinator-1:conversation-1",
      });

      await provider.send("provider-1", "Inspect it", {
        requestId: "request-1",
        images: [{ filename: "reference.png", data: "cG5n" }],
      });

      const attachments = JSON.parse(String(requests[0]?.init?.body)).attachments as Array<{
        type: string;
        path: string;
        filename: string;
        dataUrl: string;
      }>;
      expect(attachments).toMatchObject([
        { type: "image", filename: "reference.png", dataUrl: "data:image/png;base64,cG5n" },
      ]);
      expect(attachments[0]!.path.startsWith(checkout)).toBe(false);
      expect(
        attachments[0]!.path.startsWith(
          storage.coordinators.coordinatorAttachmentDirectory("coordinator-1", "conversation-1"),
        ),
      ).toBe(true);
      expect(await fs.readFile(attachments[0]!.path)).toEqual(Buffer.from("cG5n", "base64"));
    } finally {
      globalThis.fetch = originalFetch;
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
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

  test.each(["cursor", "grok"] as const)(
    "forwards a tab-scoped MCP connection when creating a %s environment-owned session",
    async (agent) => {
      const connection = { url: "http://127.0.0.1:4567/mcp", token: `${agent}-tab-token` };
      const resolveAgentToolConnection = mock(() => connection);
      const stub = createProviderStub(agent);
      await withService(
        {
          prefix: `orkestrator-native-${agent}-tab-mcp-`,
          provider: async () => stub.provider,
          resolveAgentToolConnection,
        },
        async ({ service }) => {
          await service.ensureSession({
            environmentId: "env-1",
            agent,
            logicalSessionKey: "env-env-1:tab-1",
            owner: { kind: "environment", projectId: "project-1", environmentId: "env-1" },
          });
          expect(resolveAgentToolConnection).toHaveBeenCalledWith(
            "env-1",
            "project-1",
            "tab-1",
            "host",
          );
          expect(stub.createSession).toHaveBeenCalledWith(
            "build",
            "Agent Session",
            expect.objectContaining({ agentMcp: connection }),
          );
        },
      );
    },
  );

  test("does not mint a tab credential for a coordinator-owned session", async () => {
    const resolveAgentToolConnection = mock(() => ({
      url: "http://127.0.0.1:4567/mcp",
      token: "should-not-be-used",
    }));
    const stub = createProviderStub("cursor");
    await withService(
      {
        prefix: "orkestrator-native-cursor-coordinator-mcp-",
        provider: async () => stub.provider,
        resolveAgentToolConnection,
      },
      async ({ service }) => {
        const input = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-1",
          owner: {
            kind: "coordinator" as const,
            projectId: "project-1",
            coordinatorId: "coord-1",
          },
        };
        await internals(service).createProviderSession(stub.provider, input);
        expect(resolveAgentToolConnection).not.toHaveBeenCalled();
        expect(stub.createSession).toHaveBeenCalledWith(
          "build",
          "Agent Session",
          expect.objectContaining({ agentMcp: undefined }),
        );
      },
    );
  });

  test("fails session creation when the tab credential cannot be resolved", async () => {
    const stub = createProviderStub("cursor");
    await withService(
      {
        prefix: "orkestrator-native-cursor-mcp-fail-",
        provider: async () => stub.provider,
        resolveAgentToolConnection: () => {
          throw new Error("mint failed");
        },
      },
      async ({ service }) => {
        await expect(
          service.ensureSession({
            environmentId: "env-1",
            agent: "cursor",
            logicalSessionKey: "env-env-1:tab-1",
            owner: { kind: "environment", projectId: "project-1", environmentId: "env-1" },
          }),
        ).rejects.toThrow("mint failed");
        expect(stub.createSession).not.toHaveBeenCalled();
      },
    );
  });
});

describe("MCP configuration evidence", () => {
  const LOGICAL = "env-env-1:tab-1";
  const persist = (storage: StorageService) =>
    storage.getOrCreateNativeAgentSession(
      {
        key: nativeAgentSessionStorageKey("env-1", "claude", LOGICAL),
        environmentId: "env-1",
        agent: "claude",
        logicalSessionKey: LOGICAL,
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      },
      async () => "provider-session-1",
    );

  test("reads a persisted session's evidence from the running bridge and nothing else", async () => {
    const evidence = {
      sources: { user: `sha256:${"a".repeat(43)}` },
      observedAt: "2026-09-24T10:00:00.000Z",
      scope: "session" as const,
    };
    const stub = createProviderStub("claude");
    const read = mock(async (_sessionId: string) => ({ state: "evidence" as const, evidence }));
    (stub.provider as { mcpConfigEvidence?: unknown }).mcpConfigEvidence = read;
    await withService(
      { prefix: "orkestrator-native-mcp-evidence-", provider: async () => stub.provider },
      async ({ storage, service }) => {
        // No persisted mapping: there is no session to ask about.
        expect(await service.mcpConfigEvidenceIfRunning("env-1", "claude", LOGICAL)).toEqual({
          state: "none",
        });
        expect(read).not.toHaveBeenCalled();

        await persist(storage);
        expect(await service.mcpConfigEvidenceIfRunning("env-1", "claude", LOGICAL)).toEqual({
          state: "evidence",
          evidence,
        });
        expect(read).toHaveBeenCalledWith("provider-session-1");
        // A bridge older than the report says so, rather than "nothing loaded".
        read.mockImplementationOnce(async () => ({ state: "unsupported" }) as never);
        expect(await service.mcpConfigEvidenceIfRunning("env-1", "claude", LOGICAL)).toEqual({
          state: "unsupported",
        });
        // Observation only: nothing was created, sent or re-attached.
        expect(stub.createSession).not.toHaveBeenCalled();
        expect(stub.send).not.toHaveBeenCalled();
      },
    );
  });

  test("a bridge that is not running is reported, never started", async () => {
    const commands: string[] = [];
    const invoke = (async <T>(command: string): Promise<T> => {
      commands.push(command);
      if (command === "peek_local_agent_bridge") return null as T;
      throw new Error(`Unexpected backend command: ${command}`);
    }) as Invoke;
    await withService(
      { prefix: "orkestrator-native-mcp-evidence-idle-", invoke },
      async ({ storage, service }) => {
        await persist(storage);
        expect(await service.mcpConfigEvidenceIfRunning("env-1", "claude", LOGICAL)).toEqual({
          state: "not-running",
        });
        expect(commands).toEqual(["peek_local_agent_bridge"]);
      },
    );
  });
});

describe("OpenCode MCP listing observation", () => {
  test("an absent server returns undefined without invoking a start command", async () => {
    const commands: string[] = [];
    const invoke: Invoke = async <T>(command: string): Promise<T> => {
      commands.push(command);
      expect(command).toBe("peek_local_agent_bridge");
      return null as T;
    };
    await withService({ prefix: "opencode-mcp-no-spawn-", invoke }, async ({ service }) => {
      expect(await service.openCodeMcpServerNamesIfRunning("env-1")).toBeUndefined();
      expect(commands).toEqual(["peek_local_agent_bridge"]);
    });
  });

  test("a running server lists names through observation without a session or spawn", async () => {
    const inventory = mock(async () => [
      { id: "docs", name: "Documentation", status: "connected" as const, actions: [] },
    ]);
    const stub = createProviderStub("opencode");
    await withService(
      {
        prefix: "opencode-mcp-observe-",
        environment: { localOpencodePort: 12345, localOpencodePassword: "test" },
        provider: async (input) => {
          expect(input.agent).toBe("opencode");
          return { ...stub.provider, mcpServers: inventory };
        },
      },
      async ({ service }) => {
        expect(await service.openCodeMcpServerNamesIfRunning("env-1")).toEqual(["Documentation"]);
        expect(inventory).toHaveBeenCalledWith("");
        expect(stub.createSession).not.toHaveBeenCalled();
      },
    );
  });
});
