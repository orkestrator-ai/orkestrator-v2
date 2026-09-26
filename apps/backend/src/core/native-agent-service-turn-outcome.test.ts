import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import {
  ProviderSessionFailedError,
  type NativeAgentRuntimeProvider,
  type ProviderSendOptions,
  type ProviderStatus,
} from "./native-agent-provider.js";
import { NativeAgentService, nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { StorageService } from "./storage.js";

/**
 * Turn-outcome bookkeeping and mode preservation on the native queue path:
 * the drain's own status read records how the previous turn ended, observers
 * can settle a finished turn with one status read, and a backend-authored
 * prompt can leave a session-scoped mode untouched.
 */

async function waitForCondition(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for background work");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function providerStub(agent: BuildPipelineAgent) {
  let status: () => Promise<ProviderStatus> = async () => "idle";
  const send = mock(async (_id: string, _prompt: string, _options: ProviderSendOptions) => {});
  const statusMock = mock(() => status());
  const provider = {
    agent,
    createSession: async () => "provider-session",
    registerSession: () => undefined,
    send,
    status: statusMock,
    messages: async () => [],
    structured: async () => null,
    abort: async () => undefined,
    dispose: async () => undefined,
  } as unknown as NativeAgentRuntimeProvider;
  return {
    provider,
    send,
    statusMock,
    setStatus(next: () => Promise<ProviderStatus>) {
      status = next;
    },
  };
}

async function withService(
  provider: NativeAgentRuntimeProvider,
  run: (context: { storage: StorageService; service: NativeAgentService }) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-outcome-"));
  const storage = new StorageService(dataDir);
  await storage.init();
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
  });
  const service = new NativeAgentService(
    storage,
    async <T>(name: string): Promise<T> => {
      throw new Error(`Unexpected backend command: ${name}`);
    },
    { provider: async () => provider },
  );
  try {
    await run({ storage, service });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const logicalSessionKey = "env-env-1:tab-1";

function markIdle(
  service: NativeAgentService,
  agent: BuildPipelineAgent,
  providerSessionId: string,
) {
  (
    service as unknown as {
      observedSessionActivity: Map<string, { providerSessionId: string; state: string }>;
    }
  ).observedSessionActivity.set(nativeAgentSessionStorageKey("env-1", agent, logicalSessionKey), {
    providerSessionId,
    state: "idle",
  });
}

describe("native queue mode preservation", () => {
  test("a preserve-mode message sends no mode; explicit and default modes are unchanged", async () => {
    const stub = providerStub("codex");
    await withService(stub.provider, async ({ service, storage }) => {
      const queueKey = `codex\0${logicalSessionKey}`;
      await storage.savePromptQueue(queueKey, "env-1", [
        { id: "a-1", text: "annotation brief", preserveSessionMode: true },
      ]);
      service.notifyPromptQueueChanged(queueKey);
      await waitForCondition(() => stub.send.mock.calls.length === 1);
      expect(stub.send.mock.calls[0]![2].mode).toBeUndefined();

      markIdle(service, "codex", "provider-session");
      await storage.enqueuePromptQueueMessage(queueKey, "env-1", {
        id: "a-2",
        text: "planned",
        mode: "plan",
        preserveSessionMode: true,
      });
      service.notifyPromptQueueChanged(queueKey);
      await waitForCondition(() => stub.send.mock.calls.length === 2);
      expect(stub.send.mock.calls[1]![2].mode).toBe("plan");

      markIdle(service, "codex", "provider-session");
      await storage.enqueuePromptQueueMessage(queueKey, "env-1", { id: "u-1", text: "user" });
      service.notifyPromptQueueChanged(queueKey);
      await waitForCondition(() => stub.send.mock.calls.length === 3);
      expect(stub.send.mock.calls[2]![2].mode).toBe("build");
    });
  });
});

describe("native turn outcomes", () => {
  test("the drain records the previous turn's provider error before parking", async () => {
    const stub = providerStub("claude");
    await withService(stub.provider, async ({ service, storage }) => {
      await service.dispatchPrompt({
        environmentId: "env-1",
        agent: "claude",
        logicalSessionKey,
        prompt: "first",
        requestId: "r-1",
      });
      stub.setStatus(async () => {
        throw new ProviderSessionFailedError("claude", "model overloaded");
      });
      const queueKey = `claude\0${logicalSessionKey}`;
      await storage.enqueuePromptQueueMessage(queueKey, "env-1", { id: "u-2", text: "next" });
      service.notifyPromptQueueChanged(queueKey);
      const key = nativeAgentSessionStorageKey("env-1", "claude", logicalSessionKey);
      await waitForCondition(
        async () => (await storage.getNativeAgentSession(key))?.turnOutcomes?.length === 1,
      );
      expect((await storage.getNativeAgentSession(key))?.turnOutcomes?.[0]).toMatchObject({
        requestId: "r-1",
        outcome: "failed",
        error: "model overloaded",
      });
      expect(stub.send).toHaveBeenCalledTimes(1);
    });
  });

  test("an observer settles a finished turn with one status read, then durably", async () => {
    const stub = providerStub("claude");
    await withService(stub.provider, async ({ service, storage }) => {
      const session = await service.dispatchPrompt({
        environmentId: "env-1",
        agent: "claude",
        logicalSessionKey,
        prompt: "first",
        requestId: "r-1",
      });
      const input = { environmentId: "env-1", agent: "claude" as const, logicalSessionKey };
      // Still visibly working after dispatch: ask again later.
      expect(await service.sessionTurnOutcome({ ...input, requestId: "r-1" })).toEqual({
        outcome: "pending",
      });
      markIdle(service, "claude", session.providerSessionId);
      stub.setStatus(async () => {
        throw new ProviderSessionFailedError("claude", "rate limited");
      });
      const reads = stub.statusMock.mock.calls.length;
      expect(await service.sessionTurnOutcome({ ...input, requestId: "r-1" })).toEqual({
        outcome: "failed",
        error: "rate limited",
      });
      expect(stub.statusMock.mock.calls.length).toBe(reads + 1);
      // Durable: answered from storage without reading the provider again.
      expect(await service.sessionTurnOutcome({ ...input, requestId: "r-1" })).toEqual({
        outcome: "failed",
        error: "rate limited",
      });
      expect(stub.statusMock.mock.calls.length).toBe(reads + 1);
      expect(
        (await storage.getNativeAgentSession(session.key))?.turnOutcomes?.map(
          (entry) => entry.requestId,
        ),
      ).toEqual(["r-1"]);
      // An id that is not the latest dispatch cannot be read from status.
      expect(await service.sessionTurnOutcome({ ...input, requestId: "r-unknown" })).toEqual({
        outcome: "unknown",
      });
    });
  });

  test("an idle status is not success when the request's turn recorded an error", async () => {
    const stub = providerStub("opencode");
    let terminal: () => Promise<string | null> = async () => {
      throw new Error("transcript unavailable");
    };
    const turnTerminalError = mock((_session: string, _request: string) => terminal());
    Object.assign(stub.provider, { turnTerminalError });
    await withService(stub.provider, async ({ service }) => {
      const session = await service.dispatchPrompt({
        environmentId: "env-1",
        agent: "opencode",
        logicalSessionKey,
        prompt: "first",
        requestId: "r-1",
      });
      const input = { environmentId: "env-1", agent: "opencode" as const, logicalSessionKey };
      markIdle(service, "opencode", session.providerSessionId);
      // Unreadable evidence is never settled as completed.
      expect(await service.sessionTurnOutcome({ ...input, requestId: "r-1" })).toEqual({
        outcome: "pending",
      });
      terminal = async () => "Cannot connect to API";
      (
        service as unknown as { turnOutcomeAttempts: Map<string, unknown> }
      ).turnOutcomeAttempts.clear();
      expect(await service.sessionTurnOutcome({ ...input, requestId: "r-1" })).toEqual({
        outcome: "failed",
        error: "Cannot connect to API",
      });
      expect(turnTerminalError.mock.calls.at(-1)).toEqual([session.providerSessionId, "r-1"]);

      await service.dispatchPrompt({
        environmentId: "env-1",
        agent: "opencode",
        logicalSessionKey,
        prompt: "second",
        requestId: "r-2",
      });
      markIdle(service, "opencode", session.providerSessionId);
      terminal = async () => null;
      expect(await service.sessionTurnOutcome({ ...input, requestId: "r-2" })).toEqual({
        outcome: "completed",
      });
    });
  });

  test("the drain records a transcript-held failure instead of a success", async () => {
    const stub = providerStub("opencode");
    Object.assign(stub.provider, { turnTerminalError: async () => "Cannot connect to API" });
    await withService(stub.provider, async ({ service, storage }) => {
      await service.dispatchPrompt({
        environmentId: "env-1",
        agent: "opencode",
        logicalSessionKey,
        prompt: "first",
        requestId: "r-1",
      });
      const key = nativeAgentSessionStorageKey("env-1", "opencode", logicalSessionKey);
      markIdle(service, "opencode", (await storage.getNativeAgentSession(key))!.providerSessionId);
      const queueKey = `opencode\0${logicalSessionKey}`;
      await storage.enqueuePromptQueueMessage(queueKey, "env-1", { id: "u-2", text: "next" });
      service.notifyPromptQueueChanged(queueKey);
      await waitForCondition(
        async () => (await storage.getNativeAgentSession(key))?.turnOutcomes?.length === 1,
      );
      expect((await storage.getNativeAgentSession(key))?.turnOutcomes?.[0]).toMatchObject({
        requestId: "r-1",
        outcome: "failed",
        error: "Cannot connect to API",
      });
    });
  });
});
