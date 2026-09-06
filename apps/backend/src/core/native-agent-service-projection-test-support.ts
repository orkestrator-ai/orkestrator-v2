/**
 * Shared harness for the native-agent projection suites.
 *
 * The projection tests were one 3,000-line file. They are now split by the
 * surface they cover — projection state, transcript presentation, service
 * lifecycle, and remote synchronization — and this module is what keeps that
 * split from duplicating the stub provider and service fixture four times.
 */
import { mock } from "bun:test";

import { promises as fs } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { type BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";

import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";

import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";

import {
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
  type AgentInteractionObservation,
  type EnsureNativeAgentSessionInput,
  type NativeAgentServiceOptions,
} from "./native-agent-service.js";

import { StorageService } from "./storage.js";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** The default for every test whose provider is injected and stages nothing. */
export const refusingInvoke: Invoke = async <T>(command: string): Promise<T> => {
  throw new Error(`Unexpected backend command: ${command}`);
};

/** Polls until a fire-and-forget drain pass has observable side effects. */
export async function waitForCondition(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for background drain work");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function createProviderStub(
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
    steerSupported?: NativeAgentRuntimeProvider["steerSupported"];
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
  const steerSupported = nativeAgentCapabilities(agent).actions?.steer
    ? mock(behaviour.steerSupported ?? (async () => true))
    : behaviour.steerSupported
      ? mock(behaviour.steerSupported)
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
    steerSupported,
    dispose,
  } as unknown as NativeAgentRuntimeProvider;
  return {
    provider,
    prepareDispatch,
    dispatchStatus,
    steerSupported,
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
export function internals(service: NativeAgentService) {
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

export async function withService(
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
    onAsyncQuestionAttention?: NativeAgentServiceOptions["onAsyncQuestionAttention"];
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
    ...(setup.onAsyncQuestionAttention
      ? { onAsyncQuestionAttention: setup.onAsyncQuestionAttention }
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
  });
  try {
    await run({ storage, service });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

export async function createStorage(dataDir: string): Promise<StorageService> {
  const storage = new StorageService(dataDir);
  await storage.init();
  return storage;
}

export async function addEnvironment(
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
export async function captureWarnings(body: () => Promise<void>): Promise<string[]> {
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

export function pendingInteractionSnapshot(
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
