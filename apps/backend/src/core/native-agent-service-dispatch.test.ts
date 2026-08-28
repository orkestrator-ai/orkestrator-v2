import { describe, expect, mock, test } from "bun:test";

import { promises as fs } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { type BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";

import {
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  ProviderSessionFailedError,
  ProviderUnavailableError,
  ProviderUnreachableError,
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
  expectedOpenCodeMessageId,
  openCodeFake,
  openCodeProvider,
} from "./agent-provider-test-support.js";

import { openCodeIncompleteTurnRequestId } from "./opencode-turn-recovery.js";

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

/** Polls until a fire-and-forget drain pass has observable side effects. */
async function waitForCondition(condition: () => boolean | Promise<boolean>): Promise<void> {
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
    activeSteerRun?: NativeAgentRuntimeProvider["activeSteerRun"];
    steerSupported?: NativeAgentRuntimeProvider["steerSupported"];
    steerStatus?: NativeAgentRuntimeProvider["steerStatus"];
    performSessionAction?: NativeAgentRuntimeProvider["performSessionAction"];
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
  const activeSteerRun = behaviour.activeSteerRun ? mock(behaviour.activeSteerRun) : undefined;
  const steerSupported = behaviour.steerSupported
    ? mock(behaviour.steerSupported)
    : behaviour.activeSteerRun
      ? mock(async () => true)
      : undefined;
  const steerStatus = behaviour.steerStatus ? mock(behaviour.steerStatus) : undefined;
  const performSessionAction = behaviour.performSessionAction
    ? mock(behaviour.performSessionAction)
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
    activeSteerRun,
    steerSupported,
    steerStatus,
    performSessionAction,
    dispose,
  } as unknown as NativeAgentRuntimeProvider;
  return {
    provider,
    prepareDispatch,
    dispatchStatus,
    activeSteerRun,
    steerSupported,
    steerStatus,
    performSessionAction,
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

describe("NativeAgentService", () => {
  test("classifies accepted, rejected, and ambiguous dispatch intents", async () => {
    let result: "accepted" | "rejected" | "unknown" = "accepted";
    const stub = createProviderStub("cursor", {
      send: async () => {
        if (result === "rejected") throw new PromptRejectedError("No input");
        if (result === "unknown") {
          throw new AmbiguousPromptDispatchError("Response was lost");
        }
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-dispatch-outcomes-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const base = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-1",
          prompt: "Do the work",
          attachments: [
            {
              type: "file" as const,
              path: "/workspace/review.txt",
              dataUrl: "data:text/plain;base64,cmV2aWV3",
            },
          ],
          schema: { type: "object" },
          mode: "plan" as const,
          model: "cursor/model",
          reasoningEffort: "high",
        };
        await expect(
          service.dispatchIntent({
            ...base,
            requestId: "accepted-1",
          }),
        ).resolves.toEqual({ outcome: "accepted", requestId: "accepted-1" });

        result = "rejected";
        await expect(
          service.dispatchIntent({
            ...base,
            requestId: "rejected-1",
          }),
        ).resolves.toEqual({ outcome: "rejected", error: "No input" });

        result = "unknown";
        await expect(
          service.dispatchIntent({
            ...base,
            requestId: "unknown-1",
          }),
        ).resolves.toEqual({
          outcome: "unknown",
          requestId: "unknown-1",
          error: "Response was lost",
        });

        const key = nativeAgentSessionStorageKey(
          base.environmentId,
          base.agent,
          base.logicalSessionKey,
        );
        expect((await storage.getNativeAgentSession(key))?.pendingDispatch).toMatchObject({
          requestId: "unknown-1",
          prompt: "Do the work",
          attachments: base.attachments,
          schema: base.schema,
          mode: "plan",
          model: "cursor/model",
          reasoningEffort: "high",
        });
        await expect(service.getProjection(base)).resolves.toMatchObject({
          recoverableDispatch: { requestId: "unknown-1" },
        });

        result = "accepted";
        const sendsBeforeStaleRetry = stub.send.mock.calls.length;
        await expect(
          service.retryRecoverableDispatch({
            ...base,
            requestId: "stale-request",
          }),
        ).resolves.toEqual({
          outcome: "rejected",
          error: "The recoverable dispatch changed; refresh before retrying",
        });
        expect(stub.send).toHaveBeenCalledTimes(sendsBeforeStaleRetry);
        await expect(
          service.retryRecoverableDispatch({
            ...base,
            requestId: "unknown-1",
          }),
        ).resolves.toEqual({
          outcome: "accepted",
          requestId: "unknown-1",
        });
        expect(stub.send.mock.calls.at(-1)?.[2]).toMatchObject({
          requestId: "unknown-1",
        });
        expect((await storage.getNativeAgentSession(key))?.pendingDispatch).toBeUndefined();
      },
    );
  });

  test("settles an ambiguous dispatch the provider can prove landed", async () => {
    const stub = createProviderStub("cursor", {
      send: async () => {
        throw new AmbiguousPromptDispatchError("Response was lost");
      },
      dispatchStatus: async () => "dispatched" as const,
    });
    await withService(
      {
        prefix: "orkestrator-native-dispatch-settled-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const base = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-1",
          prompt: "Do the work",
        };
        // The acknowledgement was lost, not the prompt. Asking the provider turns
        // that back into an ordinary accepted dispatch instead of a banner.
        await expect(service.dispatchIntent({ ...base, requestId: "lost-ack" })).resolves.toEqual({
          outcome: "accepted",
          requestId: "lost-ack",
        });
        expect(stub.dispatchStatus).toHaveBeenCalledWith("provider-session", "lost-ack");

        const key = nativeAgentSessionStorageKey(
          base.environmentId,
          base.agent,
          base.logicalSessionKey,
        );
        const session = await storage.getNativeAgentSession(key);
        expect(session?.pendingDispatch).toBeUndefined();
        // Recording the id is the half that stops a later retry running it twice.
        expect(session?.dispatchedRequestIds).toContain("lost-ack");
        await expect(service.getProjection(base)).resolves.not.toHaveProperty(
          "recoverableDispatch",
        );
      },
    );
  });

  test("owns steer identity, run pinning, parking, and exact recovery in the backend", async () => {
    let steerOutcome: "unknown" | "applied" = "unknown";
    const stub = createProviderStub("codex", {
      activeSteerRun: async () => ({ state: "running", runId: "turn-7" }),
      steerStatus: async () => "unknown",
      performSessionAction: async (_sessionId, action) => {
        expect(action).toMatchObject({
          kind: "steer",
          text: "Keep the change narrow",
          expectedRunId: "turn-7",
        });
        return steerOutcome === "applied"
          ? { outcome: "applied" }
          : { outcome: "unknown", requestId: action.kind === "steer" ? action.requestId : "" };
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-backend-steer-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-steer",
        };
        await service.ensureSession(identity);
        const first = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "Keep the change narrow" },
        });
        expect(first.outcome).toBe("unknown");
        const key = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        const pending = (await storage.getNativeAgentSession(key))?.pendingSteer;
        expect(pending).toMatchObject({
          text: "Keep the change narrow",
          expectedRunId: "turn-7",
          state: "unknown",
        });
        expect(pending?.requestId).toBeString();
        expect(stub.performSessionAction).toHaveBeenCalledTimes(1);

        await expect(service.getProjection(identity)).resolves.toMatchObject({
          recoverableDispatch: {
            requestId: pending!.requestId,
            kind: "steer",
          },
        });
        expect(stub.performSessionAction).toHaveBeenCalledTimes(1);
        await expect(
          service.dispatchIntent({
            ...identity,
            prompt: "This must remain blocked",
            requestId: "prompt-after-steer",
          }),
        ).resolves.toEqual({
          outcome: "rejected",
          error:
            "An earlier message is still awaiting confirmation. Retry or discard it before sending another.",
        });

        steerOutcome = "applied";
        await expect(
          service.retryRecoverableDispatch({ ...identity, requestId: pending!.requestId }),
        ).resolves.toEqual({ outcome: "accepted", requestId: pending!.requestId });
        const retryAction = stub.performSessionAction!.mock.calls.at(-1)?.[1];
        expect(retryAction).toMatchObject({
          requestId: pending!.requestId,
          expectedRunId: "turn-7",
        });
        expect((await storage.getNativeAgentSession(key))?.pendingSteer).toBeUndefined();
      },
    );
  });

  test("clears a parked steer only on an explicit no-touch positive", async () => {
    let dispatched = false;
    const stub = createProviderStub("pi", {
      activeSteerRun: async () => ({ state: "running", runId: "pi:generation:3" }),
      steerStatus: async () => (dispatched ? "dispatched" : "unknown"),
      performSessionAction: async (_sessionId, action) => ({
        outcome: "unknown",
        requestId: action.kind === "steer" ? action.requestId : "",
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-steer-reconcile-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "pi" as const,
          logicalSessionKey: "env-env-1:tab-pi-steer",
        };
        await service.ensureSession(identity);
        const outcome = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "Check the parser" },
        });
        const requestId = outcome.requestId!;
        dispatched = true;
        await expect(service.retryRecoverableDispatch({ ...identity, requestId })).resolves.toEqual(
          { outcome: "accepted", requestId },
        );
        expect(stub.performSessionAction).toHaveBeenCalledTimes(1);
        const key = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        expect((await storage.getNativeAgentSession(key))?.pendingSteer).toBeUndefined();
      },
    );
  });

  test("clears a provably dropped steer and admits the next prompt", async () => {
    let steerStatus: "unknown" | "absent" = "unknown";
    const stub = createProviderStub("pi", {
      activeSteerRun: async () => ({ state: "running", runId: "pi:generation:4" }),
      steerStatus: async () => steerStatus,
      performSessionAction: async (_sessionId, action) => ({
        outcome: "unknown",
        requestId: action.kind === "steer" ? action.requestId : "",
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-steer-absent-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "pi" as const,
          logicalSessionKey: "env-env-1:tab-pi-dropped-steer",
        };
        await service.ensureSession(identity);
        const outcome = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "Check the parser" },
        });
        expect(outcome.outcome).toBe("unknown");

        steerStatus = "absent";
        await expect(
          service.dispatchIntent({
            ...identity,
            prompt: "Continue with the next task",
            requestId: "prompt-after-dropped-steer",
          }),
        ).resolves.toEqual({
          outcome: "accepted",
          requestId: "prompt-after-dropped-steer",
        });
        const key = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        expect((await storage.getNativeAgentSession(key))?.pendingSteer).toBeUndefined();
        expect(stub.send).toHaveBeenCalledTimes(1);
      },
    );
  });

  test("keeps recovery parked when the current bridge no longer qualifies", async () => {
    let qualified = true;
    const stub = createProviderStub("pi", {
      steerSupported: async () => qualified,
      activeSteerRun: async () => ({ state: "running", runId: "pi:generation:5" }),
      steerStatus: async () => "unknown",
      performSessionAction: async (_sessionId, action) => ({
        outcome: "unknown",
        requestId: action.kind === "steer" ? action.requestId : "",
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-steer-requalify-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "pi" as const,
          logicalSessionKey: "env-env-1:tab-pi-requalify",
        };
        await service.ensureSession(identity);
        const outcome = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "Check the parser" },
        });
        const requestId = outcome.requestId!;
        const key = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );

        qualified = false;
        await expect(service.retryRecoverableDispatch({ ...identity, requestId })).resolves.toEqual(
          {
            outcome: "rejected",
            error: "pi bridge does not support reliable steering; recovery remains parked",
          },
        );
        expect(stub.performSessionAction).toHaveBeenCalledTimes(1);
        expect((await storage.getNativeAgentSession(key))?.pendingSteer?.requestId).toBe(requestId);
      },
    );
  });

  test("does not describe a running turn without a bindable id as idle", async () => {
    const stub = createProviderStub("codex", {
      activeSteerRun: async () => ({ state: "unknown" }),
      steerStatus: async () => "unknown",
      performSessionAction: async () => ({ outcome: "applied" }),
    });
    await withService(
      {
        prefix: "orkestrator-native-steer-unbound-run-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-unbound-run",
        };
        await service.ensureSession(identity);
        await expect(
          service.performProjectionAction({
            ...identity,
            action: { kind: "steer", text: "Keep the change narrow" },
          }),
        ).rejects.toThrow("active turn is not ready to steer");
        expect(stub.performSessionAction).not.toHaveBeenCalled();
        const key = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        expect((await storage.getNativeAgentSession(key))?.pendingSteer).toBeUndefined();
      },
    );
  });

  test("parks a steer when the session vanishes at the provider boundary", async () => {
    const stub = createProviderStub("codex", {
      activeSteerRun: async () => ({ state: "running", runId: "turn-vanished" }),
      steerStatus: async () => "unknown",
      performSessionAction: async () => {
        throw new PromptRejectedError("Codex session was not found");
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-steer-vanished-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-vanished-run",
        };
        await service.ensureSession(identity);
        const outcome = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "Keep the change narrow" },
        });
        expect(outcome).toMatchObject({ outcome: "unknown" });
        const key = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        expect((await storage.getNativeAgentSession(key))?.pendingSteer).toMatchObject({
          expectedRunId: "turn-vanished",
          state: "unknown",
        });
      },
    );
  });

  test("does not open a durability barrier for an older unqualified bridge", async () => {
    const stub = createProviderStub("codex", {
      steerSupported: async () => false,
      activeSteerRun: async () => ({ state: "running", runId: "turn-old" }),
      steerStatus: async () => "unknown",
      performSessionAction: async () => ({ outcome: "applied" }),
    });
    await withService(
      {
        prefix: "orkestrator-native-unqualified-steer-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-old-bridge",
        };
        await service.ensureSession(identity);
        await expect(
          service.performProjectionAction({
            ...identity,
            action: { kind: "steer", text: "Do not dispatch this" },
          }),
        ).rejects.toThrow("bridge does not support reliable steering");
        expect(stub.activeSteerRun).not.toHaveBeenCalled();
        expect(stub.performSessionAction).not.toHaveBeenCalled();
        const key = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        expect((await storage.getNativeAgentSession(key))?.pendingSteer).toBeUndefined();
      },
    );
  });

  describe("OpenCode ambiguous dispatch", () => {
    const base = {
      environmentId: "env-1",
      agent: "opencode" as const,
      logicalSessionKey: "env-env-1:tab-1",
      prompt: "Do the work",
    };
    const key = nativeAgentSessionStorageKey(
      base.environmentId,
      base.agent,
      base.logicalSessionKey,
    );

    /**
     * Drives the real `OpenCodeProvider` rather than a stub, because the
     * question this settles is whether an answer computed from OpenCode's own
     * transcript moves the durable record — not whether the service reacts to a
     * hand-written `"dispatched"`.
     */
    async function withOpenCodeService(
      prefix: string,
      transcript: () => unknown[],
      run: (context: { storage: StorageService; service: NativeAgentService }) => Promise<void>,
    ): Promise<void> {
      const fake = openCodeFake();
      // The prompt reached OpenCode; only the acknowledgement was lost. That is
      // exactly the shape that parks a recoverable dispatch.
      fake.setPromptError(new Error("socket hang up"));
      fake.setMessagesHandler(async () => ({
        data: fake.promptCalls.length > 0 ? transcript() : [],
      }));
      const provider = openCodeProvider(fake);
      try {
        await withService({ prefix, provider: async () => provider }, run);
      } finally {
        await provider.dispose?.();
      }
    }

    function userTurn(requestId: string): Record<string, unknown> {
      return {
        info: { id: expectedOpenCodeMessageId(requestId), role: "user" },
        parts: [],
      };
    }

    test("settles a parked dispatch from the transcript OpenCode kept", async () => {
      await withOpenCodeService(
        "orkestrator-native-opencode-settled-",
        () => [userTurn("lost-ack")],
        async ({ service, storage }) => {
          await expect(service.dispatchIntent({ ...base, requestId: "lost-ack" })).resolves.toEqual(
            { outcome: "accepted", requestId: "lost-ack" },
          );

          const session = await storage.getNativeAgentSession(key);
          expect(session?.pendingDispatch).toBeUndefined();
          // Burning the id is the half that stops a retry running the turn twice.
          expect(session?.dispatchedRequestIds).toContain("lost-ack");
          await expect(service.getProjection(base)).resolves.not.toHaveProperty(
            "recoverableDispatch",
          );
        },
      );
    });

    test("parks a dispatch the transcript cannot vouch for", async () => {
      await withOpenCodeService(
        "orkestrator-native-opencode-parked-",
        () => [],
        async ({ service, storage }) => {
          await expect(
            service.dispatchIntent({ ...base, requestId: "no-proof" }),
          ).resolves.toMatchObject({ outcome: "unknown", requestId: "no-proof" });
          expect((await storage.getNativeAgentSession(key))?.pendingDispatch).toMatchObject({
            requestId: "no-proof",
          });
        },
      );
    });

    test("does not settle a manual prompt from an incomplete-turn continuation", async () => {
      // Recovery continues a stalled turn under an id derived from the assistant
      // message, on the same session the composer dispatches into. Settling one
      // from the other's marker would clear a prompt that never ran, and the
      // burned id means the user would never be told.
      const continuation = openCodeIncompleteTurnRequestId("msg_stalled_assistant");
      await withOpenCodeService(
        "orkestrator-native-opencode-crosstalk-",
        () => [userTurn(continuation)],
        async ({ service, storage }) => {
          await expect(
            service.dispatchIntent({ ...base, requestId: "manual-1" }),
          ).resolves.toMatchObject({ outcome: "unknown", requestId: "manual-1" });
          const session = await storage.getNativeAgentSession(key);
          expect(session?.pendingDispatch).toMatchObject({ requestId: "manual-1" });
          expect(session?.dispatchedRequestIds ?? []).not.toContain("manual-1");
        },
      );
    });
  });

  test("parks an ambiguous dispatch the provider cannot vouch for", async () => {
    const stub = createProviderStub("cursor", {
      send: async () => {
        throw new AmbiguousPromptDispatchError("Response was lost");
      },
      // "I have no record" is not evidence the prompt never ran: the record may
      // have died with a previous bridge process.
      dispatchStatus: async () => "unknown" as const,
    });
    await withService(
      {
        prefix: "orkestrator-native-dispatch-unsettled-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const base = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-1",
          prompt: "Do the work",
        };
        await expect(
          service.dispatchIntent({ ...base, requestId: "unknown-1" }),
        ).resolves.toMatchObject({ outcome: "unknown", requestId: "unknown-1" });
        const key = nativeAgentSessionStorageKey(
          base.environmentId,
          base.agent,
          base.logicalSessionKey,
        );
        expect((await storage.getNativeAgentSession(key))?.pendingDispatch).toMatchObject({
          requestId: "unknown-1",
        });
      },
    );
  });

  test("offers retry and discard as the only ways past a parked dispatch", async () => {
    let sendOutcome: "ambiguous" | "accepted" = "ambiguous";
    const stub = createProviderStub("cursor", {
      send: async () => {
        if (sendOutcome === "ambiguous") {
          throw new AmbiguousPromptDispatchError("Response was lost");
        }
      },
      dispatchStatus: async () => "unknown" as const,
    });
    await withService(
      {
        prefix: "orkestrator-native-dispatch-wedge-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const base = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-1",
          prompt: "Do the work",
        };
        const key = nativeAgentSessionStorageKey(
          base.environmentId,
          base.agent,
          base.logicalSessionKey,
        );
        await expect(
          service.dispatchIntent({ ...base, requestId: "parked" }),
        ).resolves.toMatchObject({ outcome: "unknown" });

        // The refusal is the at-most-once guard working, but it has to name the
        // two choices rather than describe a storage invariant.
        sendOutcome = "accepted";
        await expect(
          service.dispatchIntent({
            ...base,
            prompt: "Something else",
            requestId: "second",
          }),
        ).resolves.toEqual({
          outcome: "rejected",
          error:
            "An earlier message is still awaiting confirmation." +
            " Retry or discard it before sending another.",
        });
        expect((await storage.getNativeAgentSession(key))?.pendingDispatch).toMatchObject({
          requestId: "parked",
        });

        await expect(
          service.discardRecoverableDispatch({
            ...base,
            requestId: "wrong-id",
          }),
        ).resolves.toEqual({ discarded: false });
        await expect(
          service.discardRecoverableDispatch({
            ...base,
            requestId: "parked",
          }),
        ).resolves.toEqual({ discarded: true });
        expect((await storage.getNativeAgentSession(key))?.pendingDispatch).toBeUndefined();

        await expect(
          service.dispatchIntent({
            ...base,
            prompt: "Something else",
            requestId: "second",
          }),
        ).resolves.toEqual({ outcome: "accepted", requestId: "second" });
      },
    );
  });

  test("keeps a parked dispatch recoverable when its retry cannot reach the provider", async () => {
    let sendOutcome: "ambiguous" | "unreachable" | "accepted" = "ambiguous";
    const stub = createProviderStub("cursor", {
      send: async () => {
        if (sendOutcome === "ambiguous") {
          throw new AmbiguousPromptDispatchError("Response was lost");
        }
        if (sendOutcome === "unreachable") {
          throw new ProviderUnreachableError("Bridge is offline");
        }
      },
      dispatchStatus: async () => "unknown" as const,
    });
    await withService(
      {
        prefix: "orkestrator-native-dispatch-retry-unreachable-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const base = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-1",
          prompt: "Do the work",
        };
        const key = nativeAgentSessionStorageKey(
          base.environmentId,
          base.agent,
          base.logicalSessionKey,
        );
        await expect(
          service.dispatchIntent({ ...base, requestId: "parked" }),
        ).resolves.toMatchObject({ outcome: "unknown" });

        sendOutcome = "unreachable";
        await expect(
          service.retryRecoverableDispatch({
            ...base,
            requestId: "parked",
          }),
        ).resolves.toEqual({ outcome: "rejected", error: "Bridge is offline" });
        expect((await storage.getNativeAgentSession(key))?.pendingDispatch).toMatchObject({
          requestId: "parked",
          prompt: "Do the work",
        });

        await expect(
          service.dispatchIntent({
            ...base,
            prompt: "A different turn",
            requestId: "second",
          }),
        ).resolves.toMatchObject({ outcome: "rejected" });
        expect((await storage.getNativeAgentSession(key))?.pendingDispatch).toMatchObject({
          requestId: "parked",
        });

        sendOutcome = "accepted";
        await expect(
          service.retryRecoverableDispatch({
            ...base,
            requestId: "parked",
          }),
        ).resolves.toEqual({ outcome: "accepted", requestId: "parked" });
        expect((await storage.getNativeAgentSession(key))?.pendingDispatch).toBeUndefined();
      },
    );
  });

  test("retries once past a parked dispatch the provider can now vouch for", async () => {
    let sendOutcome: "ambiguous" | "accepted" = "ambiguous";
    let dispatched = false;
    const stub = createProviderStub("cursor", {
      send: async () => {
        if (sendOutcome === "ambiguous") {
          throw new AmbiguousPromptDispatchError("Response was lost");
        }
      },
      dispatchStatus: async () => (dispatched ? ("dispatched" as const) : ("unknown" as const)),
    });
    await withService(
      {
        prefix: "orkestrator-native-dispatch-unblock-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const base = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-1",
          prompt: "Do the work",
        };
        await expect(
          service.dispatchIntent({ ...base, requestId: "parked" }),
        ).resolves.toMatchObject({ outcome: "unknown" });

        // The parked turn turns out to have run after all, so the block on the
        // next prompt was stale and that prompt should just go through.
        sendOutcome = "accepted";
        dispatched = true;
        await expect(
          service.dispatchIntent({
            ...base,
            prompt: "Something else",
            requestId: "second",
          }),
        ).resolves.toEqual({ outcome: "accepted", requestId: "second" });

        const key = nativeAgentSessionStorageKey(
          base.environmentId,
          base.agent,
          base.logicalSessionKey,
        );
        const session = await storage.getNativeAgentSession(key);
        expect(session?.pendingDispatch).toBeUndefined();
        expect(session?.dispatchedRequestIds).toEqual(expect.arrayContaining(["parked", "second"]));
      },
    );
  });

  test("attaches the provider before the pending dispatch record is written", async () => {
    const order: string[] = [];
    const stub = createProviderStub("cursor", {
      prepareDispatch: async () => {
        order.push("prepare");
      },
      send: async () => {
        order.push("send");
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-dispatch-attach-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const base = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-1",
          prompt: "Do the work",
        };
        await expect(service.dispatchIntent({ ...base, requestId: "warm-1" })).resolves.toEqual({
          outcome: "accepted",
          requestId: "warm-1",
        });
        // The cold start has to happen before the at-most-once window opens, or
        // it is spent inside the window it was moved out of.
        expect(order).toEqual(["prepare", "send"]);
        expect(stub.prepareDispatch).toHaveBeenCalledWith("provider-session");
        const key = nativeAgentSessionStorageKey(
          base.environmentId,
          base.agent,
          base.logicalSessionKey,
        );
        expect((await storage.getNativeAgentSession(key))?.pendingDispatch).toBeUndefined();
      },
    );
  });

  test("dispatches anyway when attaching the provider fails", async () => {
    const stub = createProviderStub("cursor", {
      // Best-effort by contract: the prompt request does the same work and is
      // the one that gets to report authoritatively.
      prepareDispatch: async () => {
        throw new Error("attach failed");
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-dispatch-attach-failed-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        await expect(
          service.dispatchIntent({
            environmentId: "env-1",
            agent: "cursor",
            logicalSessionKey: "env-env-1:tab-1",
            prompt: "Do the work",
            requestId: "warm-2",
          }),
        ).resolves.toEqual({ outcome: "accepted", requestId: "warm-2" });
        expect(stub.send).toHaveBeenCalledTimes(1);
      },
    );
  });

  test("runs launch and queue work from the background timer", async () => {
    await withService(
      {
        prefix: "orkestrator-native-launch-timer-body-",
      },
      async ({ service }) => {
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
      },
    );
  });

  test("does not report a parked waiting turn as completed or complete it when it becomes idle", async () => {
    let activityState: ProviderActivityState = "working";
    const { provider } = createProviderStub("codex", {
      activity: async () => activityState,
    });
    const invoke = mock(async () => undefined) as unknown as Invoke;

    await withService(
      {
        prefix: "orkestrator-native-pr-refresh-waiting-",
        environment: {
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: true,
          prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
        },
        provider: async () => provider,
        invoke,
      },
      async ({ storage, service }) => {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", "resolve"),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: "resolve",
          providerSessionId: "provider-resolve",
        });

        await service.reconcileAgentActivity();
        expect(invoke).not.toHaveBeenCalled();

        activityState = "waiting";
        await service.reconcileAgentActivity();
        expect(invoke).not.toHaveBeenCalled();
        expect(await storage.getEnvironment("env-1")).toMatchObject({
          agentActivityState: "waiting",
          hasUnreadWork: true,
        });

        activityState = "idle";
        await service.reconcileAgentActivity();
        await service.reconcileAgentActivity();

        expect(invoke).not.toHaveBeenCalled();
      },
    );
  });

  test("reports a fast accepted dispatch whose first activity snapshot is idle", async () => {
    const { provider, send } = createProviderStub("codex", {
      activity: async () => "idle",
    });
    const invoke = mock(async () => undefined) as unknown as Invoke;

    await withService(
      {
        prefix: "orkestrator-native-pr-refresh-fast-dispatch-",
        environment: {
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: true,
          prRecheckAfterAgentCompletionArmedAt: "2026-08-01T12:00:00.000Z",
        },
        provider: async () => provider,
        invoke,
      },
      async ({ service }) => {
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
        expect(invoke).toHaveBeenCalledWith("pr_monitor_agent_turn_completed", {
          environmentId: "env-1",
        });
      },
    );
  });

  test("two supervisors drain a queued prompt through one provider dispatch", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-service-"));
    const firstStorage = await createStorage(dataDir);
    const secondStorage = await createStorage(dataDir);
    await addEnvironment(firstStorage);
    await firstStorage.savePromptQueue("codex\u0000env-env-1:tab-1", "env-1", [
      { id: "row-1", requestId: "request-1", text: "Build it" },
    ]);
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
      expect(await firstStorage.getPromptQueue("codex\u0000env-env-1:tab-1")).toMatchObject({
        messages: [],
      });
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
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
    } as AgentSessionProvider;
    const service = new NativeAgentService(
      storage,
      async <T>(): Promise<T> => {
        throw new Error("unused");
      },
      { provider: async () => provider },
    );
    const drain = () =>
      (service as unknown as { drainPromptQueues(): Promise<void> }).drainPromptQueues();
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
    } as AgentSessionProvider;
    const service = new NativeAgentService(
      storage,
      async <T>(): Promise<T> => {
        throw new Error("unused");
      },
      { provider: async () => provider },
    );
    const drain = () =>
      (service as unknown as { drainPromptQueues(): Promise<void> }).drainPromptQueues();
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

  test.each([
    ["claude", { planModeEnabled: true }],
    ["opencode", { mode: "plan" }],
    ["cursor", { mode: "plan" }],
    ["grok", { mode: "plan" }],
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
    } as AgentSessionProvider;
    const service = new NativeAgentService(
      storage,
      async <T>(): Promise<T> => {
        throw new Error("unused");
      },
      { provider: async () => provider },
    );
    try {
      await (service as unknown as { drainPromptQueues(): Promise<void> }).drainPromptQueues();
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
    ["cursor", { fastMode: true }, true],
    ["grok", { fastMode: false }, false],
  ] as const)(
    "preserves queued %s fast mode through dispatch",
    async (agent, fastModeField, expectedFastMode) => {
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
      } as AgentSessionProvider;
      const service = new NativeAgentService(
        storage,
        async <T>(): Promise<T> => {
          throw new Error("unused");
        },
        { provider: async () => provider },
      );
      try {
        await (service as unknown as { drainPromptQueues(): Promise<void> }).drainPromptQueues();
        expect(send).toHaveBeenCalledWith(
          "provider-session",
          "Use the selected speed",
          expect.objectContaining({ fastMode: expectedFastMode }),
        );
      } finally {
        await service.shutdown();
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  // The renderer persists the shared `fastMode` key for every provider, while
  // ActionBar's review launch still writes Claude's legacy `fastModeEnabled`.
  // Both shapes reach the same queue, so pin which one wins — including when a
  // malformed legacy value must not shadow a perfectly good shared field.
  test.each([
    ["the shared field alone, enabled", { fastMode: true }, true],
    ["the shared field alone, disabled", { fastMode: false }, false],
    [
      "the legacy field ahead of a conflicting shared field",
      { fastModeEnabled: true, fastMode: false },
      true,
    ],
    [
      "the shared field when the legacy field is malformed",
      { fastModeEnabled: "yes", fastMode: true },
      true,
    ],
    [
      "no selection when neither field is a boolean",
      { fastModeEnabled: "yes", fastMode: 1 },
      undefined,
    ],
  ] as const)("honours queued claude %s", async (_label, fastModeFields, expectedFastMode) => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-claude-fast-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    const queueKey = "claude\u0000env-env-1:tab-1";
    await storage.savePromptQueue(queueKey, "env-1", [
      { id: "row-1", text: "Use the selected speed", ...fastModeFields },
    ]);
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
    } as AgentSessionProvider;
    const service = new NativeAgentService(
      storage,
      async <T>(): Promise<T> => {
        throw new Error("unused");
      },
      { provider: async () => provider },
    );
    try {
      await (service as unknown as { drainPromptQueues(): Promise<void> }).drainPromptQueues();
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

  test("retries a busy dispatch race with the same durable request id", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-busy-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    const queueKey = "codex\u0000env-env-1:tab-1";
    await storage.savePromptQueue(queueKey, "env-1", [{ id: "row-1", text: "Dispatch me" }]);
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
    } as AgentSessionProvider;
    const service = new NativeAgentService(
      storage,
      async <T>(): Promise<T> => {
        throw new Error("unused");
      },
      { provider: async () => provider },
    );
    try {
      await (service as unknown as { drainPromptQueues(): Promise<void> }).drainPromptQueues();
      expect(await storage.getPromptQueue(queueKey)).toMatchObject({
        inFlight: { requestId: "row-1" },
      });

      (service as unknown as { queueRetryAt: Map<string, number> }).queueRetryAt.delete(queueKey);
      await (service as unknown as { drainPromptQueues(): Promise<void> }).drainPromptQueues();

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

  describe("queue draining", () => {
    test("starts a newly persisted queue immediately when notified", async () => {
      let markDispatched!: () => void;
      const dispatched = new Promise<void>((resolve) => {
        markDispatched = resolve;
      });
      const { provider, send } = createProviderStub("opencode", {
        send: async () => {
          markDispatched();
        },
      });
      await withService(
        {
          prefix: "orkestrator-native-drain-notified-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
          const queueKey = "opencode\u0000env-env-1:review-tab";
          await storage.savePromptQueue(queueKey, "env-1", [
            {
              id: "initial-prompt:env-1:review-tab",
              text: "Review the change",
              mode: "build",
            },
          ]);

          service.notifyPromptQueueChanged(queueKey);
          await dispatched;

          expect(send).toHaveBeenCalledWith(
            "provider-session",
            "Review the change",
            expect.objectContaining({
              requestId: "initial-prompt:env-1:review-tab",
              mode: "build",
            }),
          );
        },
      );
    });

    test("drains two queued prompts in prompt and request order", async () => {
      const dispatched: Array<{ prompt: string; requestId: string }> = [];
      const { provider, send } = createProviderStub("codex", {
        send: async (_sessionId, prompt, options) => {
          dispatched.push({ prompt, requestId: options.requestId });
        },
      });
      await withService(
        {
          prefix: "orkestrator-native-drain-order-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
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
        },
      );
    });

    test("re-drains a coalesced notification once the in-flight pass settles", async () => {
      const dispatched: Array<{ prompt: string; requestId: string }> = [];
      let releaseFirstSend!: () => void;
      const firstSendBlocked = new Promise<void>((resolve) => {
        releaseFirstSend = resolve;
      });
      const { provider } = createProviderStub("codex", {
        send: async (_sessionId, prompt, options) => {
          dispatched.push({ prompt, requestId: options.requestId });
          if (dispatched.length === 1) {
            // Keep the first drain pass in flight so the notification for the
            // second message coalesces onto it instead of starting a new pass.
            await firstSendBlocked;
          }
        },
      });
      await withService(
        {
          prefix: "orkestrator-native-drain-recheck-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
          const queueKey = "codex\u0000env-env-1:tab-1";
          await storage.savePromptQueue(queueKey, "env-1", [
            { id: "row-1", requestId: "request-1", text: "First prompt" },
          ]);

          service.notifyPromptQueueChanged(queueKey);
          await waitForCondition(() => dispatched.length === 1);

          // The second message lands while the first drain pass is still in
          // flight. The notification coalesces onto it, so only the follow-up
          // pass scheduled by drainPromptQueue can pick the new head up.
          await storage.enqueuePromptQueueMessage(queueKey, "env-1", {
            id: "row-2",
            requestId: "request-2",
            text: "Second prompt",
          });
          service.notifyPromptQueueChanged(queueKey);

          releaseFirstSend();
          await waitForCondition(async () => {
            const queue = await storage.getPromptQueue(queueKey);
            return queue?.messages.length === 0 && queue?.inFlight === undefined;
          });

          expect(dispatched).toEqual([
            { prompt: "First prompt", requestId: "request-1" },
            { prompt: "Second prompt", requestId: "request-2" },
          ]);
          const queue = await storage.getPromptQueue(queueKey);
          expect(queue).toMatchObject({ messages: [] });
          expect(queue?.inFlight).toBeUndefined();
        },
      );
    });

    test("does not create a provider session when notified about an empty queue", async () => {
      const { provider, createSession } = createProviderStub("codex");
      await withService(
        {
          prefix: "orkestrator-native-drain-empty-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
          const queueKey = "codex\u0000env-env-1:tab-1";
          await storage.savePromptQueue(queueKey, "env-1", []);

          service.notifyPromptQueueChanged(queueKey);
          await new Promise((resolve) => setTimeout(resolve, 20));

          expect(createSession).not.toHaveBeenCalled();
          const queue = await storage.getPromptQueue(queueKey);
          expect(queue).toMatchObject({ messages: [] });
        },
      );
    });

    test.each([
      ["reasoningEffort", { reasoningEffort: "high" }],
      ["effort", { effort: "high" }],
      ["variant", { variant: "high" }],
    ])("forwards a queued %s alias as the provider effort", async (_label, effortField) => {
      const { provider, send, createSession } = createProviderStub("codex");
      await withService(
        {
          prefix: "orkestrator-native-drain-effort-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
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
        },
      );
    });

    test("prefers reasoningEffort over its effort and variant aliases", async () => {
      const { provider, send } = createProviderStub("codex");
      await withService(
        {
          prefix: "orkestrator-native-drain-effort-order-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
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
        },
      );
    });

    test("forwards queued per-prompt claude options", async () => {
      const { provider, send } = createProviderStub("claude");
      await withService(
        {
          prefix: "orkestrator-native-drain-options-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
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
        },
      );
    });

    test("passes queued attachments through as real attachments", async () => {
      const { provider, send } = createProviderStub("codex");
      await withService(
        {
          prefix: "orkestrator-native-drain-attachments-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
          await storage.savePromptQueue("codex\u0000env-env-1:tab-1", "env-1", [
            {
              id: "row-1",
              text: "What is in this screenshot?",
              attachments: [
                {
                  type: "image",
                  path: "/workspace/.orkestrator/prompt-attachments/shot.png",
                  dataUrl: "data:image/png;base64,cG5n",
                  filename: "shot.png",
                },
              ],
            },
          ]);

          await internals(service).drainPromptQueues();

          // Flattening these into an "Attached workspace files:" list degraded an
          // image to a filename the model had to guess at.
          expect(send).toHaveBeenCalledWith(
            "provider-session",
            "What is in this screenshot?",
            expect.objectContaining({
              attachments: [
                {
                  type: "image",
                  path: "/workspace/.orkestrator/prompt-attachments/shot.png",
                  dataUrl: "data:image/png;base64,cG5n",
                  filename: "shot.png",
                },
              ],
            }),
          );
        },
      );
    });

    test("parks a queued prompt whose attachments are invalid", async () => {
      const { provider, send } = createProviderStub("codex");
      await withService(
        {
          prefix: "orkestrator-native-drain-bad-attachments-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
          const queueKey = "codex\u0000env-env-1:tab-1";
          await storage.savePromptQueue(queueKey, "env-1", [
            {
              id: "row-1",
              text: "Look at this",
              attachments: [{ type: "image", dataUrl: "data:image/png;base64,cG5n" }],
            },
          ]);

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
        },
      );
    });

    test("acknowledges and drops a reserved prompt with no text", async () => {
      const { provider, send } = createProviderStub("codex");
      await withService(
        {
          prefix: "orkestrator-native-drain-blank-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
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
          expect(send).toHaveBeenCalledWith("provider-session", "Real work", expect.anything());
        },
      );
    });

    test("leaves a queue alone when the head cannot be reserved", async () => {
      const { provider, send } = createProviderStub("codex");
      await withService(
        {
          prefix: "orkestrator-native-drain-unreservable-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
          const queueKey = "codex\u0000env-env-1:tab-1";
          // No `id`, so the reservation cannot produce a durable request id.
          await storage.savePromptQueue(queueKey, "env-1", [{ text: "No identity" }]);

          await internals(service).drainPromptQueues();

          expect(send).not.toHaveBeenCalled();
          const queue = await storage.getPromptQueue(queueKey);
          expect(queue).toMatchObject({ messages: [{ text: "No identity" }] });
          expect(queue?.inFlight).toBeUndefined();
        },
      );
    });

    test.each([
      ["no separator", "codex"],
      ["an empty agent", "\u0000env-env-1:tab-1"],
      ["an unknown agent", "gemini\u0000env-env-1:tab-1"],
      ["a blank logical session key", "codex\u0000   "],
    ])("ignores a queue key with %s", async (_label, queueKey) => {
      const { provider, createSession, send } = createProviderStub("codex");
      await withService(
        {
          prefix: "orkestrator-native-drain-badkey-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
          await storage.savePromptQueue(queueKey, "env-1", [{ id: "row-1", text: "Do it" }]);

          await internals(service).drainPromptQueueOnce(queueKey);

          expect(createSession).not.toHaveBeenCalled();
          expect(send).not.toHaveBeenCalled();
          expect(await storage.getPromptQueue(queueKey)).toMatchObject({
            messages: [{ id: "row-1" }],
          });
        },
      );
    });

    test.each([
      ["a stopped environment", { status: "stopped" }],
      ["an environment still running setup", { setupScriptsComplete: false }],
    ] as const)("does not start agents for %s", async (_label, environment) => {
      const { provider, createSession, send } = createProviderStub("codex");
      await withService(
        {
          prefix: "orkestrator-native-drain-notready-",
          environment,
          provider: async () => provider,
        },
        async ({ storage, service }) => {
          const queueKey = "codex\u0000env-env-1:tab-1";
          await storage.savePromptQueue(queueKey, "env-1", [{ id: "row-1", text: "Do it" }]);

          await internals(service).drainPromptQueues();

          // Without this gate a leftover queued prompt spawns bridge servers and
          // attempts dispatch every two seconds against a dead environment.
          expect(createSession).not.toHaveBeenCalled();
          expect(send).not.toHaveBeenCalled();
          expect(await storage.getPromptQueue(queueKey)).toMatchObject({
            messages: [{ id: "row-1" }],
          });
          expect(internals(service).queueRetryAt.get(queueKey)).toBeGreaterThan(Date.now());
        },
      );
    });

    test("backs off a terminal session error as provider status data", async () => {
      const stub = createProviderStub("codex", {
        status: async () => {
          throw new ProviderSessionFailedError("codex", "usage limit reached");
        },
      });
      await withService(
        {
          prefix: "orkestrator-native-drain-terminal-status-",
          provider: async () => stub.provider,
        },
        async ({ storage, service }) => {
          const queueKey = "codex\u0000env-env-1:tab-1";
          await storage.savePromptQueue(queueKey, "env-1", [{ id: "row-1", text: "Do it" }]);

          for (let attempt = 1; attempt < 5; attempt += 1) {
            await internals(service).drainPromptQueues();
            expect(internals(service).queueAttempts.get(queueKey)).toBe(attempt);
            // The prompt is held, not burned: an at-capacity model would fail
            // every queued prompt in turn if the drain sent them anyway.
            expect(stub.send).not.toHaveBeenCalled();
            expect(await storage.getPromptQueue(queueKey)).toMatchObject({
              messages: [{ id: "row-1" }],
            });
            expect((await storage.getPromptQueue(queueKey))?.dispatchError).toBeUndefined();
            internals(service).queueRetryAt.delete(queueKey);
          }
          const warnings = await captureWarnings(() => internals(service).drainPromptQueues());

          expect(warnings.join(" ")).toContain("provider session is error");
          expect(warnings.join(" ")).not.toContain("ProviderSessionFailedError");
          // Provider-authored detail is persisted for the user, never logged.
          expect(warnings.join(" ")).not.toContain("usage limit reached");
          expect(stub.send).not.toHaveBeenCalled();
          expect(stub.dispose).not.toHaveBeenCalled();
          // Parked, not silently stalled. The drain is the only thing that would
          // have run the turn that clears a sticky terminal status, so deferring
          // forever left the prompt neither sent nor failed, and told the user
          // nothing.
          const parked = await storage.getPromptQueue(queueKey);
          expect(parked).toMatchObject({ messages: [{ id: "row-1" }] });
          expect(parked?.inFlight).toBeUndefined();
          expect(parked?.dispatchError).toMatchObject({
            requestId: "row-1",
            messageId: "row-1",
            message: "The codex session failed before this prompt was sent: usage limit reached",
          });
          expect(internals(service).queueAttempts.has(queueKey)).toBe(false);
          expect(internals(service).queueRetryAt.has(queueKey)).toBe(false);

          // The park is a latch, not a loop: a further sweep must not re-read the
          // provider or park a second time, and the retry control clears it.
          stub.status.mockClear();
          await internals(service).drainPromptQueues();
          expect(stub.status).not.toHaveBeenCalled();

          await storage.retryPromptQueueDispatch(queueKey);
          expect((await storage.getPromptQueue(queueKey))?.dispatchError).toBeUndefined();
        },
      );
    });

    test("parks a terminal session error reported without a detail", async () => {
      // The bridge reports `error` with no explanation, so `status()` returns it
      // instead of throwing. The queued prompt must still park, not stall.
      const stub = createProviderStub("codex", {
        status: async () => "error" as ProviderStatus,
      });
      await withService(
        {
          prefix: "orkestrator-native-drain-bare-error-",
          provider: async () => stub.provider,
        },
        async ({ storage, service }) => {
          // Same key shape as its siblings: agent and logical session key joined
          // by a NUL.
          const queueKey = ["codex", "env-env-1:tab-1"].join(String.fromCharCode(0));
          await storage.savePromptQueue(queueKey, "env-1", [{ id: "row-1", text: "Do it" }]);

          for (let attempt = 1; attempt < 5; attempt += 1) {
            await internals(service).drainPromptQueues();
            internals(service).queueRetryAt.delete(queueKey);
          }
          await captureWarnings(() => internals(service).drainPromptQueues());

          expect(stub.send).not.toHaveBeenCalled();
          expect((await storage.getPromptQueue(queueKey))?.dispatchError).toMatchObject({
            messageId: "row-1",
            message: "The codex session is error; the queued prompt was not sent.",
          });
        },
      );
    });

    test("backs off exponentially and then parks a repeatedly failing dispatch", async () => {
      const { provider, send } = createProviderStub("codex", {
        send: async () => {
          throw new ProviderUnavailableError("bridge is offline");
        },
      });
      await withService(
        {
          prefix: "orkestrator-native-drain-backoff-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
          const queueKey = "codex\u0000env-env-1:tab-1";
          await storage.savePromptQueue(queueKey, "env-1", [{ id: "row-1", text: "Do it" }]);

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
          expect(observed.map((delay) => Math.round(delay / 1_000))).toEqual([2, 4, 8, 16]);

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
        },
      );
    });

    test("clears the retry budget once a dispatch succeeds", async () => {
      let failures = 0;
      const { provider } = createProviderStub("codex", {
        send: async () => {
          failures += 1;
          if (failures === 1) throw new ProviderUnavailableError("busy");
        },
      });
      await withService(
        {
          prefix: "orkestrator-native-drain-recover-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
          const queueKey = "codex\u0000env-env-1:tab-1";
          await storage.savePromptQueue(queueKey, "env-1", [{ id: "row-1", text: "Do it" }]);

          await internals(service).drainPromptQueues();
          expect(internals(service).queueAttempts.get(queueKey)).toBe(1);

          internals(service).queueRetryAt.delete(queueKey);
          await internals(service).drainPromptQueues();

          // A recovered queue must start from a clean budget, or five failures
          // spread over a week would eventually park a healthy queue.
          expect(internals(service).queueAttempts.has(queueKey)).toBe(false);
          expect(internals(service).queueRetryAt.has(queueKey)).toBe(false);
          expect((await storage.getPromptQueue(queueKey))?.dispatchError).toBeUndefined();
        },
      );
    });

    test("keeps draining other queues when one queue's storage read fails", async () => {
      const dispatched: string[] = [];
      const { provider } = createProviderStub("codex", {
        send: async (_sessionId, prompt) => {
          dispatched.push(prompt);
        },
      });
      await withService(
        {
          prefix: "orkestrator-native-drain-read-failure-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
          const brokenKey = "codex\u0000env-env-1:tab-broken";
          const healthyKey = "codex\u0000env-env-1:tab-healthy";
          await storage.savePromptQueue(brokenKey, "env-1", [{ id: "row-1", text: "Unreadable" }]);
          await storage.savePromptQueue(healthyKey, "env-1", [{ id: "row-2", text: "Readable" }]);
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
        },
      );
    });

    test("keeps draining other queues when one reservation fails", async () => {
      const dispatched: string[] = [];
      const { provider } = createProviderStub("codex", {
        send: async (_sessionId, prompt) => {
          dispatched.push(prompt);
        },
      });
      await withService(
        {
          prefix: "orkestrator-native-drain-reserve-failure-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
          const brokenKey = "codex\u0000env-env-1:tab-broken";
          const healthyKey = "codex\u0000env-env-1:tab-healthy";
          await storage.savePromptQueue(brokenKey, "env-1", [
            { id: "row-1", text: "Unreservable" },
          ]);
          await storage.savePromptQueue(healthyKey, "env-1", [{ id: "row-2", text: "Readable" }]);
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
        },
      );
    });

    test("parks a queue whose storage keeps failing", async () => {
      const { provider } = createProviderStub("codex");
      await withService(
        {
          prefix: "orkestrator-native-drain-read-latch-",
          provider: async () => provider,
        },
        async ({ storage, service }) => {
          const queueKey = "codex\u0000env-env-1:tab-broken";
          await storage.savePromptQueue(queueKey, "env-1", [{ id: "row-1", text: "Unreadable" }]);
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
              delays.push((internals(service).queueRetryAt.get(queueKey) ?? 0) - Date.now());
            }
            expect(internals(service).queueAttempts.get(queueKey)).toBe(4);
            expect(delays[3]!).toBeGreaterThan(delays[0]!);
          } finally {
            storage.getPromptQueue = readQueue;
          }
        },
      );
    });
  });

  describe("backend-owned environment naming from the first prompt", () => {
    test("prepares a direct first prompt before provider dispatch", async () => {
      const order: string[] = [];
      const { provider, send } = createProviderStub("codex");
      send.mockImplementation(async () => {
        order.push("send");
      });
      await withService(
        {
          prefix: "orkestrator-native-direct-rename-",
          environment: { name: "20260729-174746" },
          provider: async () => provider,
          invoke: (async <T>(command: string): Promise<T> => {
            order.push(command);
            return undefined as T;
          }) as Invoke,
        },
        async ({ service }) => {
          await service.dispatchPrompt({
            environmentId: "env-1",
            agent: "codex",
            logicalSessionKey: "env-env-1:tab-1",
            prompt: "Add a login page",
            requestId: "direct-first-prompt",
          });
        },
      );

      expect(order).toEqual(["prepare_environment_first_prompt", "send"]);
    });

    test("does not rename an adopted session whose provider transcript is non-empty", async () => {
      const { provider, send } = createProviderStub("codex", {
        messages: async () => [
          {
            id: "existing-user-message",
            role: "user",
            content: "Earlier work",
            parts: [{ type: "text", content: "Earlier work" }],
            createdAt: new Date(0).toISOString(),
          },
        ],
      });
      const invoke = mock(async () => undefined) as unknown as Invoke;
      await withService(
        {
          prefix: "orkestrator-native-adopted-rename-",
          environment: { name: "20260729-174746" },
          provider: async () => provider,
          invoke,
        },
        async ({ service }) => {
          await service.dispatchPrompt({
            environmentId: "env-1",
            agent: "codex",
            logicalSessionKey: "env-env-1:tab-1",
            prompt: "Continue the work",
            requestId: "adopted-prompt",
          });
        },
      );

      expect(invoke).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    });

    test.each([
      ["a legacy timestamp name", "20260729-174746"],
      ["a compact timestamp name", "202607291747460"],
    ])("renames an environment that still has %s", async (_label, name) => {
      const { provider } = createProviderStub("codex");
      const invoked: Array<{ command: string; args?: Record<string, unknown> }> = [];
      await withService(
        {
          prefix: "orkestrator-native-rename-",
          environment: { name },
          provider: async () => provider,
          invoke: (async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
            invoked.push({ command, args });
            return undefined as T;
          }) as Invoke,
        },
        async ({ storage, service }) => {
          await storage.savePromptQueue("codex\u0000env-env-1:tab-1", "env-1", [
            { id: "row-1", text: "Add a login page" },
          ]);

          await internals(service).drainPromptQueues();

          expect(invoked).toEqual([
            {
              command: "prepare_environment_first_prompt",
              args: { environmentId: "env-1", prompt: "Add a login page" },
            },
          ]);
        },
      );
    });

    test("leaves a user-visible name and an already-used session alone", async () => {
      const { provider, send } = createProviderStub("codex");
      const invoked: string[] = [];
      const invoke = (async <T>(command: string): Promise<T> => {
        invoked.push(command);
        return undefined as T;
      }) as Invoke;
      await withService(
        {
          prefix: "orkestrator-native-rename-skip-",
          environment: { name: "Login page work" },
          provider: async () => provider,
          invoke,
        },
        async ({ storage, service }) => {
          await storage.savePromptQueue("codex\u0000env-env-1:tab-1", "env-1", [
            { id: "row-1", text: "Add a login page" },
          ]);
          await internals(service).drainPromptQueues();
          expect(invoked).toEqual([]);
          expect(send).toHaveBeenCalledTimes(1);
        },
      );

      const second = createProviderStub("codex");
      await withService(
        {
          prefix: "orkestrator-native-rename-second-",
          environment: { name: "20260729-174746" },
          provider: async () => second.provider,
          invoke,
        },
        async ({ storage, service }) => {
          const queueKey = "codex\u0000env-env-1:tab-1";
          await storage.savePromptQueue(queueKey, "env-1", [
            { id: "row-1", text: "First prompt" },
            { id: "row-2", text: "Second prompt" },
          ]);
          await internals(service).drainPromptQueues();
          await internals(service).drainPromptQueues();
          // Only the first prompt of a session names the environment; the second
          // would overwrite a name derived from the work that is already running.
          expect(invoked).toEqual(["prepare_environment_first_prompt"]);
        },
      );
    });

    test("dispatches the prompt even when renaming fails", async () => {
      const { provider, send } = createProviderStub("codex");
      await withService(
        {
          prefix: "orkestrator-native-rename-failure-",
          environment: { name: "20260729-174746" },
          provider: async () => provider,
          invoke: (async <T>(): Promise<T> => {
            throw new Error("rename command is unavailable");
          }) as Invoke,
        },
        async ({ storage, service }) => {
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
        },
      );
    });
  });
});
