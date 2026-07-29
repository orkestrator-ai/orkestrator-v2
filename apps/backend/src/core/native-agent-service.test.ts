import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PromptRejectedError,
  ProviderUnavailableError,
  type BuildPipelineProvider,
} from "./build-pipeline-provider.js";
import {
  NativeAgentService,
  nativeAgentSessionStorageKey,
} from "./native-agent-service.js";
import { StorageService } from "./storage.js";

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
