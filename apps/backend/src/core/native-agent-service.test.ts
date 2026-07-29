import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { NativeAgentService } from "./native-agent-service.js";
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
          providerSessionId: "provider-session",
          status: "running",
        },
      });
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
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
});
