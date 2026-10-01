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

describe("native request outcomes", () => {
  test("a stop marks only an active turn, and a later prompt supersedes an earlier one", async () => {
    const stub = providerStub("codex");
    Object.assign(stub.provider, {
      abort: async () => stub.setStatus(async () => "idle"),
    });
    await withService(stub.provider, async ({ service, storage }) => {
      const input = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey };
      const key = nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey);
      const session = await service.dispatchPrompt({
        ...input,
        prompt: "fix",
        requestId: "fix-1",
      });
      markIdle(service, "codex", session.providerSessionId);
      expect(await service.sessionRequestOutcome({ ...input, requestId: "fix-1" })).toEqual({
        outcome: "completed",
      });

      // Stopping a session that already finished is not an interruption.
      await service.stopProjectionSession(input);
      expect((await storage.getNativeAgentSession(key))?.interruptedRequestIds).toBeUndefined();

      await service.dispatchPrompt({ ...input, prompt: "follow-up", requestId: "user-2" });
      expect(await service.sessionRequestOutcome({ ...input, requestId: "fix-1" })).toEqual({
        outcome: "superseded",
      });

      stub.setStatus(async () => "running");
      await service.stopProjectionSession(input);
      expect((await storage.getNativeAgentSession(key))?.interruptedRequestIds).toEqual(["user-2"]);
      // The stopped turn now reads idle, but it did not finish on its own.
      markIdle(service, "codex", session.providerSessionId);
      expect(await service.sessionRequestOutcome({ ...input, requestId: "user-2" })).toEqual({
        outcome: "interrupted",
      });
      expect(await service.sessionRequestOutcome({ ...input, requestId: "never-sent" })).toEqual({
        outcome: "unknown",
      });
    });
  });
});

function barrier() {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return { gate, started, release, entered };
}

test.each([false, true])("queued work fences completion (reserved %s)", async (reserved) => {
  const stub = providerStub("codex");
  await withService(stub.provider, async ({ service, storage }) => {
    const input = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey };
    const session = await service.dispatchPrompt({ ...input, prompt: "fix", requestId: "fix" });
    markIdle(service, "codex", session.providerSessionId);
    expect((await service.sessionRequestOutcome({ ...input, requestId: "fix" })).outcome).toBe(
      "completed",
    );
    const queueKey = `codex\0${logicalSessionKey}`;
    await storage.enqueuePromptQueueMessage(queueKey, "env-1", {
      id: "later",
      text: "continue fixing",
    });
    if (reserved) await storage.reservePromptQueueHeadForDispatch(queueKey);
    expect((await service.sessionRequestOutcome({ ...input, requestId: "fix" })).outcome).toBe(
      "pending",
    );
    // Historical completion remains available to request-specific consumers.
    expect((await service.sessionTurnOutcome({ ...input, requestId: "fix" })).outcome).toBe(
      "completed",
    );
  });
});

test.each(["stop", "follow-up", "replace"] as const)(
  "rechecks %s after awaited provider outcome",
  async (mutation) => {
    const stub = providerStub("codex");
    await withService(stub.provider, async ({ service }) => {
      const input = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey };
      const session = await service.dispatchPrompt({ ...input, prompt: "fix", requestId: "fix" });
      markIdle(service, "codex", session.providerSessionId);
      const read = barrier();
      stub.setStatus(async () => {
        read.entered();
        await read.gate;
        return "idle";
      });
      const outcome = service.sessionRequestOutcome({ ...input, requestId: "fix" });
      await read.started;
      stub.setStatus(async () => (mutation === "stop" ? "running" : "idle"));
      if (mutation === "stop") {
        Object.assign(stub.provider, { abort: async () => stub.setStatus(async () => "idle") });
        await service.stopProjectionSession(input);
      } else if (mutation === "follow-up") {
        await service.dispatchPrompt({ ...input, prompt: "follow-up", requestId: "later" });
      } else {
        await service.adoptSession({
          ...input,
          providerSessionId: "replacement",
          expectedProviderSessionId: session.providerSessionId,
        });
      }
      read.release();
      expect((await outcome).outcome).toBe(
        mutation === "stop" ? "interrupted" : mutation === "follow-up" ? "superseded" : "unknown",
      );
    });
  },
);

test.each(["stop", "follow-up"] as const)(
  "rechecks %s between initial classification and delegated durable outcome",
  async (mutation) => {
    const stub = providerStub("codex");
    await withService(stub.provider, async ({ service }) => {
      const input = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey };
      const session = await service.dispatchPrompt({ ...input, prompt: "fix", requestId: "fix" });
      markIdle(service, "codex", session.providerSessionId);
      await service.sessionTurnOutcome({ ...input, requestId: "fix" });
      const delegated = service.sessionTurnOutcome.bind(service);
      const read = barrier();
      service.sessionTurnOutcome = async (args) => {
        read.entered();
        await read.gate;
        return delegated(args);
      };
      const outcome = service.sessionRequestOutcome({ ...input, requestId: "fix" });
      await read.started;
      if (mutation === "stop") {
        stub.setStatus(async () => "running");
        Object.assign(stub.provider, { abort: async () => stub.setStatus(async () => "idle") });
        await service.stopProjectionSession(input);
      } else {
        await service.dispatchPrompt({ ...input, prompt: "follow-up", requestId: "later" });
      }
      read.release();
      expect((await outcome).outcome).toBe(mutation === "stop" ? "interrupted" : "superseded");
    });
  },
);

test.each(["blocked", "unreadable"] as const)(
  "Stop records an interrupt when pre-abort status is %s",
  async (status) => {
    const stub = providerStub("codex");
    await withService(stub.provider, async ({ service, storage }) => {
      const input = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey };
      const session = await service.dispatchPrompt({ ...input, prompt: "fix", requestId: "fix" });
      stub.setStatus(async () => {
        if (status === "unreadable") throw new Error("offline");
        return "blocked";
      });
      Object.assign(stub.provider, { abort: async () => stub.setStatus(async () => "idle") });
      await service.stopProjectionSession(input);
      expect((await storage.getNativeAgentSession(session.key))?.interruptedRequestIds).toEqual([
        "fix",
      ]);
      expect((await service.sessionRequestOutcome({ ...input, requestId: "fix" })).outcome).toBe(
        "interrupted",
      );
    });
  },
);

test("failed interrupt persistence honors Stop and retains publication denial until durable reconciliation", async () => {
  const stub = providerStub("codex");
  const abort = mock(async () => stub.setStatus(async () => "idle"));
  Object.assign(stub.provider, { abort });
  await withService(stub.provider, async ({ service, storage }) => {
    const input = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey };
    const session = await service.dispatchPrompt({ ...input, prompt: "fix", requestId: "fix" });
    const persist = storage.recordNativeAgentTurnInterrupt.bind(storage);
    storage.recordNativeAgentTurnInterrupt = async () => {
      throw new Error("disk unavailable");
    };
    stub.setStatus(async () => "running");
    await service.stopProjectionSession(input);
    expect(abort).toHaveBeenCalledTimes(1);
    markIdle(service, "codex", session.providerSessionId);
    expect((await service.sessionRequestOutcome({ ...input, requestId: "fix" })).outcome).toBe(
      "interrupted",
    );
    // Even a concurrent historical read cannot erase the retained Stop intent.
    await service.sessionTurnOutcome({ ...input, requestId: "fix" });
    storage.recordNativeAgentTurnInterrupt = persist;
    expect((await service.sessionRequestOutcome({ ...input, requestId: "fix" })).outcome).toBe(
      "interrupted",
    );
    expect((await storage.getNativeAgentSession(session.key))?.interruptedRequestIds).toEqual([
      "fix",
    ]);
    const restarted = new NativeAgentService(storage, async <T>() => undefined as T, {
      provider: async () => stub.provider,
    });
    try {
      expect((await restarted.sessionRequestOutcome({ ...input, requestId: "fix" })).outcome).toBe(
        "interrupted",
      );
    } finally {
      await restarted.shutdown();
    }
  });
});

test("publication fence orders a later dispatch without blocking other sessions", async () => {
  const stub = providerStub("codex");
  await withService(stub.provider, async ({ service }) => {
    const input = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey };
    const session = await service.dispatchPrompt({ ...input, prompt: "fix", requestId: "fix" });
    markIdle(service, "codex", session.providerSessionId);
    const admission = barrier();
    const publishing = service.withSessionWorkFence(input, async () => {
      expect((await service.sessionRequestOutcome({ ...input, requestId: "fix" })).outcome).toBe(
        "completed",
      );
      admission.entered();
      await admission.gate;
    });
    await admission.started;
    const followUp = service.dispatchPrompt({ ...input, prompt: "continue", requestId: "later" });
    await service.dispatchPrompt({
      ...input,
      logicalSessionKey: "other",
      prompt: "independent",
      requestId: "other",
    });
    expect(stub.send.mock.calls.map((call) => call[2].requestId)).toEqual(["fix", "other"]);
    admission.release();
    await publishing;
    await followUp;
    expect(stub.send.mock.calls.at(-1)?.[2].requestId).toBe("later");
  });
});

test("temporary provider absence uses bounded pending retries", async () => {
  const stub = providerStub("codex");
  await withService(stub.provider, async ({ service }) => {
    const input = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey };
    const session = await service.dispatchPrompt({ ...input, prompt: "fix", requestId: "fix" });
    markIdle(service, "codex", session.providerSessionId);
    const internal = service as unknown as {
      observeProvider: () => Promise<NativeAgentRuntimeProvider | undefined>;
      turnOutcomeAttempts: Map<string, { attempts: number; retryAt: number }>;
    };
    internal.observeProvider = async () => undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const entry of internal.turnOutcomeAttempts.values()) entry.retryAt = 0;
      expect((await service.sessionRequestOutcome({ ...input, requestId: "fix" })).outcome).toBe(
        attempt < 2 ? "pending" : "unknown",
      );
    }
    internal.observeProvider = async () => stub.provider;
    expect((await service.sessionRequestOutcome({ ...input, requestId: "fix" })).outcome).toBe(
      "completed",
    );
  });
});

test("a follow-up waiting at publication admission keeps authorization pending", async () => {
  const stub = providerStub("codex");
  await withService(stub.provider, async ({ service }) => {
    const input = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey };
    const session = await service.dispatchPrompt({ ...input, prompt: "fix", requestId: "fix" });
    markIdle(service, "codex", session.providerSessionId);
    await service.sessionTurnOutcome({ ...input, requestId: "fix" });
    const admission = barrier();
    const publishing = service.withSessionWorkFence(input, async () => {
      admission.entered();
      await admission.gate;
      expect((await service.sessionRequestOutcome({ ...input, requestId: "fix" })).outcome).toBe(
        "pending",
      );
    });
    await admission.started;
    const followUp = service.dispatchPrompt({ ...input, prompt: "continue", requestId: "later" });
    admission.release();
    await publishing;
    await followUp;
    expect((await service.sessionRequestOutcome({ ...input, requestId: "fix" })).outcome).toBe(
      "superseded",
    );
  });
});

test("Stop bypasses an in-flight attach and still fences publication", async () => {
  const stub = providerStub("codex");
  await withService(stub.provider, async ({ service }) => {
    const input = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey };
    const session = await service.dispatchPrompt({ ...input, prompt: "fix", requestId: "fix" });
    markIdle(service, "codex", session.providerSessionId);
    const attach = barrier();
    Object.assign(stub.provider, {
      prepareDispatch: async () => {
        attach.entered();
        await attach.gate;
      },
    });
    const followUp = service.dispatchPrompt({ ...input, prompt: "continue", requestId: "later" });
    await attach.started;
    stub.setStatus(async () => "running");
    const abort = mock(async () => stub.setStatus(async () => "idle"));
    Object.assign(stub.provider, { abort });
    await service.stopProjectionSession(input);
    expect(abort).toHaveBeenCalledTimes(1);
    expect((await service.sessionRequestOutcome({ ...input, requestId: "fix" })).outcome).toBe(
      "interrupted",
    );
    attach.release();
    await followUp;
  });
});

test("stopping background work leaves a released turn eligible for natural completion", async () => {
  const stub = providerStub("codex");
  await withService(stub.provider, async ({ service, storage }) => {
    const input = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey };
    const session = await service.dispatchPrompt({ ...input, prompt: "fix", requestId: "fix" });
    markIdle(service, "codex", session.providerSessionId);
    await service.sessionTurnOutcome({ ...input, requestId: "fix" });
    Object.assign(stub.provider, {
      observeActivity: async () => ({ state: "working", readyForInput: true }),
    });
    const abort = mock(async () =>
      Object.assign(stub.provider, {
        observeActivity: async () => ({ state: "idle", readyForInput: true }),
      }),
    );
    stub.setStatus(async () => "running");
    Object.assign(stub.provider, {
      abort: async () => {
        await abort();
        stub.setStatus(async () => "idle");
      },
    });
    await service.stopProjectionSession(input);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(
      (await storage.getNativeAgentSession(session.key))?.interruptedRequestIds,
    ).toBeUndefined();
    expect((await service.sessionRequestOutcome({ ...input, requestId: "fix" })).outcome).toBe(
      "completed",
    );
  });
});
