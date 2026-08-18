import { describe, expect, mock, test } from "bun:test";

import { promises as fs } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { type BuildPipeline, type BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";

import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";

import {
  createNativeAgentProvider,
  PromptRejectedError,
  ProviderSessionFailedError,
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
  isAgentTurnEndTransition,
  NATIVE_PROJECTION_MAX_BYTES,
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
    question: {
      async list() {
        return { data: [] };
      },
    },
    permission: {
      async list() {
        return { data: [] };
      },
    },
  };
  return createNativeAgentProvider(
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

async function seedLoopedReviewNativeSessions(
  storage: StorageService,
  count: number,
  logicalSessionKeyForIndex: (index: number) => string,
): Promise<void> {
  const timestamp = new Date(0).toISOString();
  const sessions = Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const logicalSessionKey = logicalSessionKeyForIndex(index);
      const key = nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey);
      return [
        key,
        {
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
        },
      ];
    }),
  );
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
    sessions: [
      {
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
      },
    ],
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
  test("does not retry a transient failure for a non-ACP agent", async () => {
    const delays: number[] = [];
    const stub = createProviderStub("codex", {
      createSession: async () => {
        throw new ProviderUnavailableError("codex bridge is down");
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-codex-create-no-retry-",
        provider: async () => stub.provider,
        delay: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
      async ({ service }) => {
        await expect(
          service.ensureSession({
            environmentId: "env-1",
            agent: "codex",
            logicalSessionKey: "env-env-1:codex-tab",
          }),
        ).rejects.toThrow(ProviderUnavailableError);

        expect(stub.createSession).toHaveBeenCalledTimes(1);
        expect(delays).toEqual([]);
      },
    );
  });

  test("adopts a session whose last turn failed rather than calling it missing", async () => {
    const stub = createProviderStub("codex", {
      status: async () => {
        throw new ProviderSessionFailedError("codex", "usage limit reached");
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-adopt-failed-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        await expect(
          service.adoptSession({
            environmentId: "env-1",
            agent: "codex",
            logicalSessionKey: "env-env-1:tab-adopt-failed",
            providerSessionId: "provider-existing",
          }),
        ).resolves.toMatchObject({ providerSessionId: "provider-existing" });
      },
    );
  });

  for (const agent of ["cursor", "grok"] as const) {
    test(`advertises ${agent} session resume and queued prompts through the native projection`, async () => {
      const stub = createProviderStub(agent, {
        interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      });
      await withService(
        {
          prefix: `orkestrator-native-${agent}-resume-capability-`,
          provider: async () => stub.provider,
        },
        async ({ storage, service }) => {
          const identity = {
            environmentId: "env-1",
            agent,
            logicalSessionKey: `env-env-1:tab-${agent}-resume`,
          };
          await service.ensureSession(identity);
          await storage.savePromptQueue(
            `${agent}\u0000${identity.logicalSessionKey}`,
            identity.environmentId,
            [{ id: `queued-${agent}`, text: `Queued for ${agent}` }],
          );
          const projection = await service.getProjection(identity);
          expect(projection?.capabilities.resume).toBe(true);
          expect(projection?.capabilities.queue).toBe(true);
          expect(projection?.queue?.items).toEqual([
            { id: `queued-${agent}`, text: `Queued for ${agent}` },
          ]);
        },
      );
    });

    /*
     * The whole point of enabling the queue for the ACP agents is that a
     * follow-up typed mid-turn survives the tab being closed. Nothing here
     * mounts a component or holds a subscription: the queue is persisted while
     * the provider reports `running`, the turn ends out of band, and the drain
     * plus a fresh projection read have to do the rest. A dispatch that only
     * happened because someone was watching would fail this.
     */
    test(`drains a queued ${agent} prompt after the turn ends with no tab attached`, async () => {
      let running = true;
      const stub = createProviderStub(agent, {
        status: async () => (running ? "running" : "idle"),
        interactiveSnapshot: async () => ({
          status: running ? "running" : "idle",
          messages: [],
        }),
      });
      await withService(
        {
          prefix: `orkestrator-native-${agent}-inactive-queue-`,
          provider: async () => stub.provider,
        },
        async ({ storage, service }) => {
          const identity = {
            environmentId: "env-1",
            agent,
            logicalSessionKey: `env-env-1:tab-${agent}-inactive`,
          };
          await service.ensureSession(identity);
          const queueKey = `${agent}\u0000${identity.logicalSessionKey}`;
          await storage.savePromptQueue(queueKey, identity.environmentId, [
            { id: "queued-follow-up", text: "Follow up after this turn", mode: "plan" },
          ]);

          const drain = async () => {
            await (
              service as unknown as { drainPromptQueues(): Promise<void> }
            ).drainPromptQueues();
          };

          // Still running: the prompt must stay queued rather than race the turn.
          await drain();
          expect(stub.send).not.toHaveBeenCalled();
          expect((await storage.getPromptQueue(queueKey))?.messages).toHaveLength(1);

          running = false;
          await drain();
          expect(stub.send).toHaveBeenCalledWith(
            "provider-session",
            "Follow up after this turn",
            expect.objectContaining({ mode: "plan" }),
          );
          expect((await storage.getPromptQueue(queueKey))?.messages ?? []).toHaveLength(0);

          // A tab returning later rebuilds from the authoritative snapshot, not
          // from the event that drained the queue while it was unmounted.
          const projection = await service.getProjection(identity);
          expect(projection?.queue?.items ?? []).toEqual([]);
          expect(projection?.queue?.blocked).toBeUndefined();
          expect(projection?.queue?.inFlightRequestId).toBeUndefined();
        },
      );
    });
  }

  test("defers heavy tool fields and removes a staged image data URL", async () => {
    const messages = [
      {
        id: "user-1",
        role: "user" as const,
        content: "see image",
        parts: [
          {
            type: "file",
            content: "/workspace/.orkestrator/initial-prompt/image.png",
            fileUrl: `data:image/png;base64,${"a".repeat(64_000)}`,
          },
          {
            type: "file",
            content: "clipboard.png",
            fileUrl: "data:image/png;base64,still-required",
          },
        ],
        createdAt: "2026-08-15T10:00:00.000Z",
      },
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "done",
        parts: [
          {
            type: "tool-invocation",
            content: "src/a.ts",
            toolName: "apply_patch",
            toolState: "success",
            toolOutput: "updated src/a.ts",
            toolDiff: {
              filePath: "/workspace/src/a.ts",
              additions: 1,
              deletions: 1,
              before: "old",
              after: "new",
              diff: "-old\n+new",
            },
          },
        ],
        createdAt: "2026-08-15T10:00:01.000Z",
      },
    ];
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });
    await withService(
      {
        prefix: "orkestrator-native-deferred-tool-details-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-details",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        const projected = projection?.messages as Array<{
          parts: Array<Record<string, unknown>>;
        }>;
        expect(projected[0]?.parts[0]?.fileUrl).toBeUndefined();
        expect(projected[0]?.parts[1]?.fileUrl).toBe("data:image/png;base64,still-required");
        const tool = projected[1]?.parts[0];
        expect(tool?.toolOutput).toBeUndefined();
        expect(tool?.toolDiff).toEqual({
          filePath: "/workspace/src/a.ts",
          additions: 1,
          deletions: 1,
          // Without this the renderer cannot distinguish a stripped diff from a
          // location-only hint, and drops the edit treatment for the row.
          deferred: true,
        });
        expect(tool?.detailRef).toBeString();

        const details = await service.getProjectionToolDetails({
          ...identity,
          detailRef: tool!.detailRef as string,
        });
        expect(details).toMatchObject({
          toolOutput: "updated src/a.ts",
          toolDiff: { before: "old", after: "new", diff: "-old\n+new" },
        });
      },
    );
  });

  test("trims parts off one oversized message and reports omittedParts", async () => {
    // A single long turn: message-level dropping has nothing left to take, so
    // the part-level lever is the only thing standing between the renderer and
    // an oversized projection.
    const messages = [
      {
        id: "message-long-turn",
        role: "assistant" as const,
        content: "done",
        parts: Array.from({ length: 40 }, (_, index) => ({
          type: "text",
          content: `${index}:${"x".repeat(1024 * 1024)}`,
        })),
        createdAt: "2026-08-15T10:00:00.000Z",
      },
    ];
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });
    await withService(
      {
        prefix: "orkestrator-native-part-window-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-part-window",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);

        expect(projection?.connection).toBe("connected");
        expect(projection?.messages).toHaveLength(1);
        expect(projection?.messageWindow).toMatchObject({
          truncated: true,
          truncationReason: "bytes",
        });
        expect(projection?.messageWindow?.omittedParts).toBeGreaterThan(0);
        expect(Buffer.byteLength(JSON.stringify(projection?.messages))).toBeLessThanOrEqual(
          NATIVE_PROJECTION_MAX_BYTES,
        );
        const retained = (projection?.messages[0] as { parts: Array<{ content: string }> }).parts;
        // Oldest-first, so the newest part is always the one that survives.
        expect(retained.at(-1)?.content).toBe(messages[0]!.parts.at(-1)!.content);
      },
    );
  });

  test("startup rehydrates unattended interaction metadata and pending requests", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(tmpdir(), "orkestrator-native-interaction-restart-"),
    );
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

      const listPendingInteractions = mock(async () =>
        pendingInteractionSnapshot(10_000, ["question"]),
      );
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
    await withService(
      {
        prefix: "orkestrator-native-interaction-fairness-",
        provider: async () => provider,
        interactionMonitorMode: "observe-only",
        interactionMonitorMaxSessionsPerEnvironment: 2,
      },
      async ({ storage, service }) => {
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
      },
    );
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
    await withService(
      {
        prefix: "orkestrator-native-interaction-one-slot-",
        provider: async () => provider,
        interactionMonitorMode: "observe-only",
        interactionMonitorMaxSessionsPerEnvironment: 1,
      },
      async ({ storage, service }) => {
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
      },
    );
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
    await withService(
      {
        prefix: "orkestrator-native-interaction-rotated-cleanup-",
        provider: async () => provider,
        interactionMonitorMode: "observe-only",
        interactionMonitorMaxSessionsPerEnvironment: 1,
      },
      async ({ storage, service }) => {
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
      },
    );
  });

  test("isolates retry backoff by durable session and recovers after eviction", async () => {
    let now = 1_000;
    let failingCalls = 0;
    let healthyCalls = 0;
    const providerFactory = mock(
      async () =>
        createProviderStub("codex", {
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
              result: "applied",
              interactionId: "unused",
              sessionId: "unused",
              revision: 1,
            }),
          },
        }).provider,
    );
    await withService(
      {
        prefix: "orkestrator-native-interaction-retry-isolation-",
        provider: providerFactory,
        now: () => now,
        interactionMonitorMode: "observe-only",
        interactionMonitorRetryBaseMs: 10,
        interactionMonitorMaxRetries: 2,
      },
      async ({ storage, service }) => {
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
      },
    );
  });

  test("preserves retry backoff while one-slot leases rotate", async () => {
    let now = 1_000;
    const calls = new Map<string, number>();
    await withService(
      {
        prefix: "orkestrator-native-interaction-rotating-backoff-",
        provider: async () =>
          createProviderStub("codex", {
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
      },
      async ({ storage, service }) => {
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
      },
    );
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
    await withService(
      {
        prefix: "orkestrator-native-interaction-pipeline-rotation-",
        provider: async () => provider,
        interactionMonitorMode: "observe-only",
        interactionMonitorMaxSessionsPerEnvironment: 2,
      },
      async ({ storage, service }) => {
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
      },
    );
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
          result: "applied",
          interactionId: "unused",
          sessionId: "unused",
          revision: 1,
        }),
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-interaction-inactive-cleanup-",
        provider: async () => provider,
        now: () => now,
        interactionMonitorMode: "observe-only",
      },
      async ({ storage, service }) => {
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

        await storage.updateEnvironment("env-1", {
          setupScriptsComplete: false,
          setupPhase: "pending",
        });
        await service.reconcileAgentInteractions();
        expect(internals(service).monitoredInteractionSessionKeys.size).toBe(0);
        await storage.updateEnvironment("env-1", {
          setupScriptsComplete: true,
          setupPhase: "ready",
        });
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
      },
    );
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
          result: "applied",
          interactionId: "unused",
          sessionId: "unused",
          revision: 1,
        }),
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-interaction-cap-cleanup-",
        provider: async () => provider,
        interactionMonitorMode: "observe-only",
      },
      async ({ service }) => {
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
      },
    );
  });

  test("settles an empty interaction snapshot from a terminal turn without backoff", async () => {
    let pending = true;
    const { provider, status } = createProviderStub("codex", {
      status: async () => {
        throw new ProviderSessionFailedError("codex", "usage limit reached");
      },
      interactions: {
        listPendingInteractions: async () =>
          pending
            ? pendingInteractionSnapshot(10_000, ["question"])
            : { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 2, requests: [] },
        resolveInteraction: async () => {
          throw new Error("observe-only must never resolve");
        },
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-interaction-terminal-status-",
        provider: async () => provider,
        now: () => 10_000,
        interactionMonitorMode: "observe-only",
      },
      async ({ storage, service }) => {
        const logicalSessionKey = "looped-review:workflow:terminal-status:Review";
        const key = nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey);
        await storage.adoptNativeAgentSession({
          key,
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey,
          providerSessionId: "provider-session",
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        });
        await service.reconcileAgentInteractions();
        pending = false;

        const warnings = await captureWarnings(() => service.reconcileAgentInteractions());

        expect(warnings).toEqual([]);
        expect(status).toHaveBeenCalledTimes(1);
        expect(service.getInteractionObservations()[0]).toMatchObject({
          providerState: "error",
          eventualOutcome: "withdrawn",
        });
        expect(internals(service).trackedInteractions.size).toBe(0);
        expect(internals(service).interactionAttempts.has(key)).toBe(false);
        expect(internals(service).interactionRetryAt.has(key)).toBe(false);
      },
    );
  });

  test("keeps a shared aggregate blocked until its final request disappears", async () => {
    const pending = new Set(["provider-a", "provider-b"]);
    const { provider } = createProviderStub("codex", {
      interactions: {
        listPendingInteractions: async (sessionId) =>
          pending.has(sessionId)
            ? pendingInteractionSnapshot(10_000, ["question"])
            : { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 2, requests: [] },
        resolveInteraction: async () => {
          throw new Error("observe-only must never resolve");
        },
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-interaction-shared-aggregate-",
        provider: async () => provider,
        now: () => 10_000,
        interactionMonitorMode: "observe-only",
      },
      async ({ storage, service }) => {
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
      },
    );
  });

  test("records and settles provider-reported interactions without request content", async () => {
    await withService(
      {
        prefix: "orkestrator-native-provider-reported-interaction-",
        interactionMonitorMode: "observe-only",
      },
      async ({ service }) => {
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
      },
    );
  });

  test("bounds direct reports together with polling tracks and normalizes edge cases", async () => {
    await withService(
      {
        prefix: "orkestrator-native-provider-reported-bounds-",
        interactionMonitorMode: "observe-only",
      },
      async ({ service }) => {
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
        expect(
          service.getInteractionObservations().find(({ kind }) => kind === "question"),
        ).toMatchObject({ phase: "native-session", providerState: "running" });
        for (let index = 0; index < 512; index += 1) {
          service.recordProviderInteractionObservation({
            ...base,
            interactionId: `permission-${index}`,
            state: "detected",
          });
        }
        expect(internals(service).providerReportedInteractions.size).toBe(512);
        expect(
          service.getInteractionObservations().find(({ kind }) => kind === "permission")!.phase,
        ).toHaveLength(256);
        const internal = service as unknown as {
          recordInteractionDetection(
            session: Record<string, unknown>,
            interactionId: string,
            kind: "question",
            expiresAt: undefined,
            scan: number,
          ): void;
        };
        internal.recordInteractionDetection(
          {
            key: "session-key",
            agent: "opencode",
            origin: "looped-review",
            logicalSessionKey: "looped-review:workflow:phase:Review",
          },
          "polled-question",
          "question",
          undefined,
          1,
        );
        expect(internals(service).trackedInteractions.size).toBe(0);
        service.recordProviderInteractionObservation({
          ...base,
          interactionId: "permission-0",
          state: "withdrawn",
        });
        expect(
          service.getInteractionObservations().find(({ kind }) => kind === "permission"),
        ).toMatchObject({ providerState: "blocked" });
      },
    );
  });

  test("recreates evicted direct reports and ignores disabled or stopped services", async () => {
    await withService(
      {
        prefix: "orkestrator-native-provider-reported-recreate-",
        interactionMonitorMode: "observe-only",
      },
      async ({ service }) => {
        const detect = (index: number) =>
          service.recordProviderInteractionObservation({
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
        expect(service.getInteractionObservations().some(({ phase }) => phase === "phase-0")).toBe(
          false,
        );
        detect(0);
        expect(service.getInteractionObservations()).toContainEqual(
          expect.objectContaining({ phase: "phase-0", count: 1 }),
        );
        await service.shutdown();
        detect(100);
        expect(
          service.getInteractionObservations().some(({ phase }) => phase === "phase-100"),
        ).toBe(false);
      },
    );

    await withService(
      {
        prefix: "orkestrator-native-provider-reported-disabled-",
      },
      async ({ service }) => {
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
      },
    );
  });

  test("expires a stranded provider report while its session remains live", async () => {
    let now = 10_000;
    const { provider } = createProviderStub("opencode");
    await withService(
      {
        prefix: "orkestrator-native-provider-reported-live-expiry-",
        interactionMonitorMode: "observe-only",
        now: () => now,
        provider: async () => provider,
      },
      async ({ storage, service }) => {
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
      },
    );
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
    await withService(
      {
        prefix: "orkestrator-native-interaction-global-cap-",
        provider: async () => provider,
        interactionMonitorMode: "observe-only",
        interactionMonitorMaxSessionsPerEnvironment: 2_000,
      },
      async ({ storage, service }) => {
        // Rotation, not the storage mutation path, is under test. Writing the
        // equivalent valid snapshot once avoids 1,025 serialized rewrites of a
        // growing JSON file and keeps aggregate load outside the assertion's
        // five-second timeout budget.
        await seedLoopedReviewNativeSessions(
          storage,
          1_025,
          (index) => `looped-review:workflow:global-${index}:Review`,
        );
        await service.reconcileAgentInteractions();
        expect(visited.has("provider-1024")).toBe(false);
        await service.reconcileAgentInteractions();
        expect(visited.has("provider-1024")).toBe(true);
        expect(internals(service).monitoredInteractionSessionKeys.size).toBe(1_024);
        expect(internals(service).observedInteractionRevisions.size).toBe(1_024);
        expect(internals(service).interactionRetryAt.size).toBe(0);
        expect(internals(service).interactionAttempts.size).toBe(0);
      },
    );
  });

  test("treats providers without interaction capability as a successful no-op", async () => {
    const { provider } = createProviderStub("codex");
    await withService(
      {
        prefix: "orkestrator-native-interaction-unsupported-provider-",
        provider: async () => provider,
        interactionMonitorMode: "observe-only",
      },
      async ({ service }) => {
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
      },
    );
  });

  test("rehydrates environment activity from backend-owned native sessions without a renderer", async () => {
    const sessionActivity = new Map<string, ProviderActivityState>([
      ["provider-1", "idle"],
      ["provider-2", "working"],
    ]);
    const { provider } = createProviderStub("codex", {
      activity: async (sessionId) => sessionActivity.get(sessionId) ?? "missing",
    });
    await withService(
      {
        prefix: "orkestrator-native-activity-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
        const firstKey = nativeAgentSessionStorageKey("env-1", "codex", "env-env-1:tab-1");
        const secondKey = nativeAgentSessionStorageKey("env-1", "codex", "env-env-1:tab-2");
        const staleKey = nativeAgentSessionStorageKey("env-1", "codex", "env-env-1:deleted-tab");
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
      },
    );
  });

  test("signals the agent-idle PR probe edge once per ended turn", async () => {
    let activityState: ProviderActivityState = "working";
    const { provider } = createProviderStub("codex", {
      activity: async () => activityState,
    });
    const probedEnvironmentIds: string[] = [];
    // Exactly what the composition root does with this callback, so a repeated
    // idle sweep cannot turn into a repeated `gh` call.
    const onActivityTransition: NonNullable<NativeAgentServiceOptions["onActivityTransition"]> = (
      event,
    ) => {
      if (isAgentTurnEndTransition(event)) probedEnvironmentIds.push(event.environmentId);
    };

    await withService(
      {
        prefix: "orkestrator-native-idle-probe-edge-",
        provider: async () => provider,
        onActivityTransition,
      },
      async ({ storage, service }) => {
        // An environment with no agent activity at all is never probed: the
        // sweep observes nothing and reports no transition.
        await service.reconcileAgentActivity();
        expect(probedEnvironmentIds).toEqual([]);

        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", "tab-1"),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
        });

        await service.reconcileAgentActivity();
        await service.reconcileAgentActivity();
        expect(probedEnvironmentIds).toEqual([]);

        activityState = "idle";
        await service.reconcileAgentActivity();
        expect(probedEnvironmentIds).toEqual(["env-1"]);

        // The sweep re-reads idle every two seconds forever after. None of those
        // readings is a completed turn.
        await service.reconcileAgentActivity();
        await service.reconcileAgentActivity();
        expect(probedEnvironmentIds).toEqual(["env-1"]);

        // A new turn that ends is a new probe.
        activityState = "working";
        await service.reconcileAgentActivity();
        activityState = "idle";
        await service.reconcileAgentActivity();
        expect(probedEnvironmentIds).toEqual(["env-1", "env-1"]);
      },
    );
  });

  test("recovers an armed restart when the first provider snapshot is idle", async () => {
    const { provider } = createProviderStub("codex", {
      activity: async () => "idle",
    });
    const invoke = mock(async () => undefined) as unknown as Invoke;

    await withService(
      {
        prefix: "orkestrator-native-pr-refresh-restart-",
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
        await service.reconcileAgentActivity();

        expect(invoke).toHaveBeenCalledTimes(1);
      },
    );
  });

  test.each([
    ["stopped", { status: "stopped" }],
    ["errored", { status: "error" }],
    ["still provisioning", { setupScriptsComplete: false }],
  ])("does not start a provider for a %s local environment", async (_label, environmentUpdate) => {
    const providerFactory = mock(async () => createProviderStub("codex").provider);
    await withService(
      {
        prefix: "orkestrator-native-activity-not-ready-",
        environment: environmentUpdate,
        provider: providerFactory,
      },
      async ({ storage, service }) => {
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
      },
    );
  });

  test("registers sessions and uses one batched activity snapshot per provider", async () => {
    const snapshot = new Map<string, ProviderActivityState>([
      ["provider-1", "idle"],
      ["provider-2", "waiting"],
    ]);
    const { provider, activityBatch, registerSession, activity, status } = createProviderStub(
      "opencode",
      {
        activity: async () => {
          throw new Error("per-session activity must not be used");
        },
        activityBatch: async () => snapshot,
      },
    );
    await withService(
      {
        prefix: "orkestrator-native-activity-batch-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
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
      },
    );
  });

  test("preserves an existing idle OpenCode native-session mapping", async () => {
    const provider = createOpenCodeLifecycleProvider(["provider-idle"]);
    await withService(
      {
        prefix: "orkestrator-native-opencode-idle-existing-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
        const key = nativeAgentSessionStorageKey("env-1", "opencode", "tab-idle");
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
      },
    );
  });

  test("invalidates a genuinely missing OpenCode native-session mapping", async () => {
    const provider = createOpenCodeLifecycleProvider([]);
    await withService(
      {
        prefix: "orkestrator-native-opencode-missing-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
        const key = nativeAgentSessionStorageKey("env-1", "opencode", "tab-deleted");
        await storage.adoptNativeAgentSession({
          key,
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "tab-deleted",
          providerSessionId: "provider-deleted",
        });

        await service.reconcileAgentActivity();

        expect(await storage.getNativeAgentSession(key)).toBeNull();
      },
    );
  });

  test("coalesces overlapping scans and shutdown waits for the active read", async () => {
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
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
      const shuttingDown = service.shutdown().then(() => {
        shutdownSettled = true;
      });
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

  test("isolates an activity persistence failure", async () => {
    const { provider } = createProviderStub("codex", {
      activity: async () => "working",
    });
    await withService(
      {
        prefix: "orkestrator-native-activity-persist-error-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
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
        storage.setEnvironmentAgentActivity =
          setActivity as typeof storage.setEnvironmentAgentActivity;
        const originalWarn = console.warn;
        console.warn = () => undefined;
        try {
          await expect(service.reconcileAgentActivity()).resolves.toBeUndefined();
        } finally {
          console.warn = originalWarn;
          storage.setEnvironmentAgentActivity = originalSet;
        }
        expect(setActivity).toHaveBeenCalledTimes(1);
      },
    );
  });

  test("skips deleted-environment sessions and avoids rewriting an unchanged state", async () => {
    const { provider, activity } = createProviderStub("codex", {
      activity: async () => "idle",
    });
    await withService(
      {
        prefix: "orkestrator-native-activity-stable-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
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
        const before = (await storage.getEnvironment("env-1"))!.agentActivitySources?.[
          "native-agent"
        ];

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
        expect(
          (await storage.getEnvironment("env-1"))!.agentActivitySources?.["native-agent"],
        ).toEqual(before);
      },
    );
  });

  test("keeps a concurrently replaced session when an old snapshot reports missing", async () => {
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider } = createProviderStub("codex", {
      activity: async () => {
        signalEntered();
        await barrier;
        return "missing";
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-activity-session-race-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
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
      },
    );
  });

  test.each([
    ["running", "working"],
    ["idle", "idle"],
    ["error", "idle"],
  ] as const)("maps a coarse %s status onto %s activity", async (providerStatus, expectedState) => {
    const { provider, status, activity, activityBatch } = createProviderStub("codex", {
      status: async () => providerStatus,
    });
    await withService(
      {
        prefix: "orkestrator-native-activity-status-map-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
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
      },
    );
  });

  test("maps a terminal turn failure onto idle activity without retry backoff", async () => {
    const { provider, status, activity, activityBatch } = createProviderStub("codex", {
      status: async () => {
        throw new ProviderSessionFailedError("codex", "usage limit reached");
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-activity-terminal-status-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
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

        const warnings = await captureWarnings(() => service.reconcileAgentActivity());

        expect(warnings).toEqual([]);
        expect(activity).toBeUndefined();
        expect(activityBatch).toBeUndefined();
        expect(status).toHaveBeenCalledWith("provider-1");
        expect(await storage.getEnvironment("env-1")).toMatchObject({
          agentActivitySources: { "native-agent": { state: "idle" } },
        });
        expect(await storage.getNativeAgentSession(key)).not.toBeNull();
        expect(internals(service).activityAttempts.size).toBe(0);
        expect(internals(service).activityRetryAt.size).toBe(0);
      },
    );
  });

  test("treats a batch that omits a requested session as a failed read, not a missing session", async () => {
    const { provider, activityBatch } = createProviderStub("opencode", {
      activityBatch: async () => new Map<string, ProviderActivityState>([["provider-1", "idle"]]),
    });
    await withService(
      {
        prefix: "orkestrator-native-activity-partial-batch-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
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
        const before = (await storage.getEnvironment("env-1"))!.agentActivitySources?.[
          "native-agent"
        ];

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
        expect(
          (await storage.getEnvironment("env-1"))!.agentActivitySources?.["native-agent"],
        ).toEqual(before);
      },
    );
  });

  test("reads every agent group exactly once and never exceeds the worker pool", async () => {
    const environmentIds = Array.from({ length: 20 }, (_unused, index) => `env-${index + 1}`);
    const reads: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
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
    await withService(
      {
        prefix: "orkestrator-native-activity-pool-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
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
        expect([...reads].sort()).toEqual(environmentIds.map((id) => `${id}-provider`).sort());
        for (const environmentId of environmentIds) {
          expect(await storage.getEnvironment(environmentId)).toMatchObject({
            agentActivitySources: { "native-agent": { state: "working" } },
          });
        }
      },
    );
  });

  test("commits a healthy environment while another environment's provider fails", async () => {
    const healthy = createProviderStub("codex", { activity: async () => "working" });
    const broken = createProviderStub("codex", {
      activity: async () => {
        throw new ProviderUnavailableError("offline");
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-activity-env-isolation-",
        provider: async (input) =>
          input.environmentId === "env-1" ? healthy.provider : broken.provider,
      },
      async ({ storage, service }) => {
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
        const before = (await storage.getEnvironment("env-2"))!.agentActivitySources?.[
          "native-agent"
        ];

        await captureWarnings(async () => {
          await service.reconcileAgentActivity();
        });

        expect(await storage.getEnvironment("env-1")).toMatchObject({
          agentActivitySources: { "native-agent": { state: "working" } },
        });
        expect(
          (await storage.getEnvironment("env-2"))!.agentActivitySources?.["native-agent"],
        ).toEqual(before);
      },
    );
  });

  test("retries a failing group on a widening schedule and reads immediately once it recovers", async () => {
    let failing = true;
    const activityCalls: string[] = [];
    const providerFactory = mock(
      async () =>
        createProviderStub("codex", {
          activity: async (sessionId) => {
            activityCalls.push(sessionId);
            if (failing) throw new ProviderUnavailableError("bridge stopped");
            return "working";
          },
        }).provider,
    );
    let clock = 1_000;
    await withService(
      {
        prefix: "orkestrator-native-activity-backoff-",
        provider: providerFactory,
        now: () => clock,
      },
      async ({ storage, service }) => {
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
      },
    );
  });

  test("withholds an environment whose group is still inside its backoff window", async () => {
    const providerFactory = mock(
      async () =>
        createProviderStub("codex", {
          activity: async () => {
            throw new ProviderUnavailableError("offline");
          },
        }).provider,
    );
    let clock = 1_000;
    await withService(
      {
        prefix: "orkestrator-native-activity-backoff-hold-",
        provider: providerFactory,
        now: () => clock,
      },
      async ({ storage, service }) => {
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
      },
    );
  });

  test("records idle without invalidating anything when no bridge is running", async () => {
    const commands: string[] = [];
    const invoke = (async <T>(command: string): Promise<T> => {
      commands.push(command);
      if (command === "peek_local_agent_bridge" || command === "peek_container_agent_bridge") {
        return null as T;
      }
      throw new Error(`Unexpected backend command: ${command}`);
    }) as Invoke;
    await withService(
      {
        prefix: "orkestrator-native-activity-no-bridge-",
        invoke,
      },
      async ({ storage, service }) => {
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
      },
    );
  });

  test("observes a running bridge without ever issuing a start command", async () => {
    const commands: string[] = [];
    const invoke = (async <T>(command: string): Promise<T> => {
      commands.push(command);
      if (command === "peek_local_agent_bridge") {
        // Coordinates for a bridge nothing is actually listening on: the read
        // fails, which must still never escalate into starting one.
        return { port: 1, authToken: "token" } as T;
      }
      throw new Error(`Unexpected backend command: ${command}`);
    }) as Invoke;
    await withService(
      {
        prefix: "orkestrator-native-activity-never-starts-",
        invoke,
      },
      async ({ storage, service }) => {
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
        expect(commands.some((command) => command.startsWith("start_"))).toBe(false);
      },
    );
  });

  test("re-probes an absent bridge only once its recheck window expires", async () => {
    const commands: string[] = [];
    const invoke = (async <T>(command: string): Promise<T> => {
      commands.push(command);
      if (command === "peek_local_agent_bridge") return null as T;
      throw new Error(`Unexpected backend command: ${command}`);
    }) as Invoke;
    let clock = 1_000;
    await withService(
      {
        prefix: "orkestrator-native-activity-absent-cooldown-",
        invoke,
        now: () => clock,
      },
      async ({ storage, service }) => {
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
        expect(commands).toEqual(["peek_local_agent_bridge", "peek_local_agent_bridge"]);
      },
    );
  });

  test("still commits idle on a sweep that skipped an absent bridge", async () => {
    const invoke = (async <T>(command: string): Promise<T> => {
      if (command === "peek_local_agent_bridge") return null as T;
      throw new Error(`Unexpected backend command: ${command}`);
    }) as Invoke;
    let clock = 1_000;
    await withService(
      {
        prefix: "orkestrator-native-activity-absent-commit-",
        invoke,
        now: () => clock,
      },
      async ({ storage, service }) => {
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
      },
    );
  });

  test("observes a bridge a user just started without waiting out the cooldown", async () => {
    const commands: string[] = [];
    const invoke = (async <T>(command: string): Promise<T> => {
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
    await withService(
      {
        prefix: "orkestrator-native-activity-cooldown-cleared-",
        invoke,
        now: () => clock,
      },
      async ({ storage, service }) => {
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
        expect(commands).toEqual(["peek_local_agent_bridge", "start_local_codex_server_cmd"]);
        // Swap the real HTTP provider for a stub so the read needs no socket. The
        // cooldown was already cleared by the caching above, which is what lets
        // this sweep consult the cache at all.
        internals(service).providers.set("env-1\u0000codex", started.provider);

        await service.reconcileAgentActivity();

        expect(started.activity).toHaveBeenCalledWith("provider-1");
        expect(commands).toHaveLength(2);
        expect(await storage.getEnvironment("env-1")).toMatchObject({
          agentActivitySources: { "native-agent": { state: "working" } },
        });
      },
    );
  });

  test("forgets a deleted environment's provider, backoff and cooldown together", async () => {
    const failing = createProviderStub("codex", {
      activity: async () => {
        throw new ProviderUnavailableError("offline");
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-activity-forget-",
        provider: async () => failing.provider,
      },
      async ({ storage, service }) => {
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
      },
    );
  });

  test("skips an environment that is already pending deletion", async () => {
    const providerFactory = mock(async () => createProviderStub("codex").provider);
    await withService(
      {
        prefix: "orkestrator-native-activity-deleting-",
        provider: providerFactory,
      },
      async ({ storage, service }) => {
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
      },
    );
  });

  test("abandons the commit when shutdown lands mid-read and admits no later sweep", async () => {
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const providerFactory = mock(
      async () =>
        createProviderStub("codex", {
          activity: async () => {
            signalEntered();
            await barrier;
            return "working";
          },
        }).provider,
    );
    await withService(
      {
        prefix: "orkestrator-native-activity-shutdown-commit-",
        provider: providerFactory,
      },
      async ({ storage, service }) => {
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

        expect(
          (await storage.getEnvironment("env-1"))!.agentActivitySources?.["native-agent"],
        ).toBeUndefined();

        const callsBefore = providerFactory.mock.calls.length;
        await expect(service.reconcileAgentActivity()).resolves.toBeUndefined();
        expect(providerFactory).toHaveBeenCalledTimes(callsBefore);
      },
    );
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
        sessionId === "provider-old" ? ("missing" as const) : ("idle" as const),
      ),
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as AgentSessionProvider;
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
    await withService(
      {
        prefix: "orkestrator-native-interaction-metadata-",
        provider: async () => provider,
      },
      async ({ service }) => {
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
      },
    );
  });

  test("rehydrates a legacy looped-review mapping without replacing its provider", async () => {
    const { provider, createSession, status } = createProviderStub("codex");
    await withService(
      {
        prefix: "orkestrator-native-legacy-looped-review-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
        const logicalSessionKey = "looped-review:workflow-1:review:round-1";
        const key = nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey);
        const file = path.join(storage.getDataDir(), "native-agent-sessions.json");
        await fs.writeFile(
          file,
          JSON.stringify({
            [key]: {
              key,
              environmentId: "env-1",
              agent: "codex",
              logicalSessionKey,
              providerSessionId: "legacy-provider-session",
              createdAt: new Date(1).toISOString(),
              updatedAt: new Date(2).toISOString(),
            },
          }),
        );

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
      },
    );
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
      const pendingDrain = drain();
      await statusEntered;
      await storage.saveComposeDraft(draftKey, "environment", "env-1", {
        text: "created during status",
        mentions: [],
        attachments: [],
      });
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

  test("parks permanent rejection visibly but retains transient in-flight work", async () => {
    const run = async (
      error: Error,
    ): Promise<Awaited<ReturnType<StorageService["getPromptQueue"]>>> => {
      const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-error-"));
      const storage = await createStorage(dataDir);
      await addEnvironment(storage);
      const queueKey = "codex\u0000env-env-1:tab-1";
      await storage.savePromptQueue(queueKey, "env-1", [{ id: "row-1", text: "Dispatch me" }]);
      const provider = {
        agent: "codex",
        createSession: async () => "provider-session",
        registerSession: () => undefined,
        send: async () => {
          throw error;
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
        sessionId === "missing" ? ("missing" as const) : ("idle" as const),
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
    const base = {
      environmentId: "env-1",
      agent: "opencode" as const,
      logicalSessionKey: "env-env-1:tab-1",
    };
    try {
      expect(
        (
          await service.adoptSession({
            ...base,
            providerSessionId: "provider-old",
          })
        ).providerSessionId,
      ).toBe("provider-old");
      expect(
        (
          await service.adoptSession({
            ...base,
            providerSessionId: "provider-new",
            expectedProviderSessionId: "provider-old",
          })
        ).providerSessionId,
      ).toBe("provider-new");
      await expect(
        service.adoptSession({
          ...base,
          providerSessionId: "missing",
        }),
      ).rejects.toThrow("not found");
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
    } as AgentSessionProvider;
    const service = new NativeAgentService(
      storage,
      async <T>(): Promise<T> => {
        throw new Error("unused");
      },
      { provider: async () => provider },
    );
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
      expect(nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey)).not.toBe(
        nativeAgentSessionStorageKey("env-2", "codex", logicalSessionKey),
      );
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
    const scan = new Promise<Awaited<ReturnType<StorageService["listAllPromptQueues"]>>>(
      (resolve) => {
        releaseScan = resolve;
      },
    );
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
    } as AgentSessionProvider;
    const service = new NativeAgentService(
      storage,
      async <T>(): Promise<T> => {
        throw new Error("unused");
      },
      { provider: async () => provider },
    );
    try {
      const initializing = service.init();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const shuttingDown = service.shutdown();
      releaseScan([]);
      await Promise.all([initializing, shuttingDown]);
      await expect(
        service.ensureSession({
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: "env-env-1:tab-1",
        }),
      ).rejects.toThrow("shut down");
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      storage.listAllPromptQueues = originalList;
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
