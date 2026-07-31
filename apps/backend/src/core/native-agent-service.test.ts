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
    status?: () => Promise<ProviderStatus>;
    activity?: (sessionId: string) => Promise<ProviderActivityState>;
  } = {},
) {
  const createSession = mock(
    behaviour.createSession ?? (async () => "provider-session"),
  );
  const send = mock(behaviour.send ?? (async () => undefined));
  const status = mock(behaviour.status ?? (async () => "idle" as ProviderStatus));
  const activity = behaviour.activity ? mock(behaviour.activity) : undefined;
  const dispose = mock(async () => undefined);
  const provider = {
    agent,
    createSession,
    registerSession: () => undefined,
    send,
    status,
    activity,
    messages: async () => [],
    structured: async () => null,
    abort: async () => undefined,
    dispose,
  } as unknown as BuildPipelineProvider;
  return { provider, createSession, send, status, activity, dispose };
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
    setup.provider ? { provider: setup.provider } : {},
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
