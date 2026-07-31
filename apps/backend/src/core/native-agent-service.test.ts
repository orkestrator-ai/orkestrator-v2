import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import {
  PromptRejectedError,
  ProviderUnavailableError,
  type BridgeConnection,
  type BuildPipelineProvider,
  type ProviderSendOptions,
  type ProviderActivityState,
  type ProviderStatus,
} from "./build-pipeline-provider.js";
import type { Environment } from "./models.js";
import {
  NativeAgentService,
  nativeAgentSessionStorageKey,
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
    launchTasks: Map<string, Promise<void>>;
    queueRetryAt: Map<string, number>;
    queueAttempts: Map<string, number>;
    launchRetryAt: Map<string, number>;
  };
}

async function withService(
  setup: {
    prefix: string;
    environment?: Record<string, unknown>;
    provider?: NativeAgentServiceOptions["provider"];
    invoke?: Invoke;
    now?: NativeAgentServiceOptions["now"];
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

describe("NativeAgentService", () => {
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
