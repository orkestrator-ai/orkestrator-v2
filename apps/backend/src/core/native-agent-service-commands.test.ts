import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import type { NativeAgentSlashCommand } from "@orkestrator/protocol/native-agent";
import {
  AmbiguousPromptDispatchError,
  type NativeAgentRuntimeProvider,
  type ProviderCommandCatalogue,
  type ProviderSendOptions,
  type ProviderStatus,
} from "./native-agent-provider.js";
import { NativeAgentService, nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { StorageService } from "./storage.js";

/**
 * Command intent through the real dispatch path: resolution happens before
 * the at-most-once window, rejections keep the provider untouched, and a
 * retry or dequeue can never turn a command into ordinary text.
 */

async function waitForCondition(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for background work");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function command(
  name: string,
  extra: Partial<NativeAgentSlashCommand> = {},
): NativeAgentSlashCommand {
  return {
    name,
    source: "project",
    id: `claude:${name}`,
    executionKind: "provider-prompt",
    bindingRevision: `rev:${name}`,
    ...extra,
  };
}

function providerStub(
  agent: BuildPipelineAgent,
  behaviour: {
    catalogue?: () => Promise<ProviderCommandCatalogue>;
    send?: (sessionId: string, prompt: string, options: ProviderSendOptions) => Promise<void>;
    status?: () => Promise<ProviderStatus>;
    performSessionAction?: NativeAgentRuntimeProvider["performSessionAction"];
    dispatchStatus?: NativeAgentRuntimeProvider["dispatchStatus"];
  } = {},
) {
  const send = mock(behaviour.send ?? (async () => undefined));
  const commandCatalogue = mock(
    behaviour.catalogue ??
      (async (): Promise<ProviderCommandCatalogue> => ({
        enhanced: true,
        status: "ready",
        commands: [command("/review")],
      })),
  );
  const performSessionAction = behaviour.performSessionAction
    ? mock(behaviour.performSessionAction)
    : undefined;
  const provider = {
    agent,
    createSession: async () => "provider-session",
    registerSession: () => undefined,
    send,
    status: mock(behaviour.status ?? (async () => "idle" as ProviderStatus)),
    messages: async () => [],
    structured: async () => null,
    abort: async () => undefined,
    commandCatalogue,
    performSessionAction,
    dispatchStatus: behaviour.dispatchStatus,
    dispose: async () => undefined,
  } as unknown as NativeAgentRuntimeProvider;
  return { provider, send, commandCatalogue, performSessionAction };
}

async function withService(
  provider: NativeAgentRuntimeProvider,
  run: (context: { storage: StorageService; service: NativeAgentService }) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-commands-"));
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

const base = {
  environmentId: "env-1",
  agent: "claude" as const,
  logicalSessionKey: "env-env-1:tab-1",
};

describe("NativeAgentService command intent", () => {
  test("a selected command reaches the provider as an explicit binding with verbatim arguments", async () => {
    const stub = providerStub("claude");
    await withService(stub.provider, async ({ service }) => {
      await expect(
        service.dispatchIntent({
          ...base,
          prompt: "/review  first line\n\tsecond  ",
          requestId: "r-1",
          command: {
            kind: "selected",
            commandId: "claude:/review",
            bindingRevision: "rev:/review",
          },
        }),
      ).resolves.toEqual({ outcome: "accepted", requestId: "r-1" });
      expect(stub.send).toHaveBeenCalledTimes(1);
      const [, prompt, options] = stub.send.mock.calls[0]!;
      expect(prompt).toBe("/review  first line\n\tsecond  ");
      expect(options.allowProviderCommands).toBe(true);
      expect(options.command).toEqual({
        id: "claude:/review",
        name: "/review",
        executionKind: "provider-prompt",
        bindingRevision: "rev:/review",
        arguments: "first line\n\tsecond  ",
      });
    });
  });

  test("a removed selection re-reads once, then fails without sending anything", async () => {
    const stub = providerStub("claude", {
      catalogue: async () => ({ enhanced: true, status: "ready", commands: [] }),
    });
    await withService(stub.provider, async ({ service }) => {
      const outcome = await service.dispatchIntent({
        ...base,
        prompt: "/review",
        requestId: "r-1",
        command: { kind: "selected", commandId: "claude:/review" },
      });
      expect(outcome.outcome).toBe("rejected");
      expect(stub.send).not.toHaveBeenCalled();
      // One ordinary read plus exactly one forced re-read.
      expect(stub.commandCatalogue).toHaveBeenCalledTimes(2);
    });
  });

  test("discovery failure does not turn a selection into a model prompt", async () => {
    const stub = providerStub("claude", {
      catalogue: async () => {
        throw new Error("bridge down");
      },
    });
    await withService(stub.provider, async ({ service }) => {
      const outcome = await service.dispatchIntent({
        ...base,
        prompt: "/review",
        requestId: "r-1",
        command: { kind: "selected", commandId: "claude:/review" },
      });
      expect(outcome).toMatchObject({ outcome: "rejected" });
      expect(outcome.outcome === "rejected" && outcome.error).toContain("could not be verified");
      expect(stub.send).not.toHaveBeenCalled();
    });
  });

  test("typed unknown slash text and paths remain ordinary prompts", async () => {
    const stub = providerStub("claude");
    await withService(stub.provider, async ({ service }) => {
      await service.dispatchIntent({ ...base, prompt: "/tmp/log is empty", requestId: "r-1" });
      const [, , options] = stub.send.mock.calls[0]!;
      expect(options.command).toBeUndefined();
      expect(options.allowProviderCommands).toBe(true);
    });
  });

  test("a workflow literal prompt naming a known command is refused on a provider that cannot suppress it", async () => {
    const stub = providerStub("claude");
    await withService(stub.provider, async ({ service }) => {
      await expect(
        service.dispatchPrompt({
          ...base,
          origin: "build-pipeline",
          logicalSessionKey: "pipeline:1",
          prompt: "/review everything",
          requestId: "w-1",
        }),
      ).rejects.toThrow("cannot send it as plain text");
      expect(stub.send).not.toHaveBeenCalled();
    });
  });

  test("a literal prompt on a suppressing provider is sent with commands disabled", async () => {
    const stub = providerStub("codex");
    await withService(stub.provider, async ({ service }) => {
      await service.dispatchIntent({
        ...base,
        agent: "codex",
        prompt: "/review but as text",
        requestId: "r-1",
        command: { kind: "literal" },
      });
      const [, , options] = stub.send.mock.calls[0]!;
      expect(options.allowProviderCommands).toBe(false);
      expect(options.command).toBeUndefined();
    });
  });

  test("a parked command keeps its resolved identity for the retry", async () => {
    let lose = true;
    const stub = providerStub("claude", {
      send: async () => {
        if (lose) throw new AmbiguousPromptDispatchError("Response was lost");
      },
      dispatchStatus: async () => "unknown",
    });
    await withService(stub.provider, async ({ service, storage }) => {
      const outcome = await service.dispatchIntent({
        ...base,
        prompt: "/review x",
        requestId: "r-1",
      });
      expect(outcome.outcome).toBe("unknown");
      const key = nativeAgentSessionStorageKey(
        base.environmentId,
        base.agent,
        base.logicalSessionKey,
      );
      // Typed text that resolved is recorded as the selection it resolved to.
      expect((await storage.getNativeAgentSession(key))?.pendingDispatch?.command).toEqual({
        kind: "selected",
        commandId: "claude:/review",
        bindingRevision: "rev:/review",
      });
      lose = false;
      await expect(
        service.retryRecoverableDispatch({ ...base, requestId: "r-1" }),
      ).resolves.toMatchObject({ outcome: "accepted" });
      const retried = stub.send.mock.calls.at(-1)![2];
      expect(retried.requestId).toBe("r-1");
      expect(retried.command?.id).toBe("claude:/review");
    });
  });

  test("a retry whose command disappeared fails instead of sending text", async () => {
    let commands = [command("/review")];
    const stub = providerStub("claude", {
      catalogue: async () => ({ enhanced: true, status: "ready", commands }),
      send: async () => {
        throw new AmbiguousPromptDispatchError("Response was lost");
      },
      dispatchStatus: async () => "unknown",
    });
    await withService(stub.provider, async ({ service }) => {
      await service.dispatchIntent({ ...base, prompt: "/review", requestId: "r-1" });
      commands = [];
      // The removal is observed on the next authoritative read.
      await service.refreshProjectionCommands(base);
      const sends = stub.send.mock.calls.length;
      const retry = await service.retryRecoverableDispatch({ ...base, requestId: "r-1" });
      expect(retry.outcome).toBe("rejected");
      expect(stub.send.mock.calls.length).toBe(sends);
    });
  });

  test("a queued selection is revalidated at dequeue and failed with its reason", async () => {
    const stub = providerStub("claude", {
      catalogue: async () => ({
        enhanced: true,
        status: "ready",
        commands: [command("/review", { bindingRevision: "rev:changed" })],
      }),
    });
    await withService(stub.provider, async ({ service, storage }) => {
      const queueKey = `claude\0${base.logicalSessionKey}`;
      await storage.savePromptQueue(queueKey, "env-1", [
        {
          id: "row-1",
          requestId: "q-1",
          text: "/review",
          command: {
            kind: "selected",
            commandId: "claude:/review",
            bindingRevision: "rev:/review",
          },
        },
      ]);
      service.notifyPromptQueueChanged(queueKey);
      await waitForCondition(async () =>
        Boolean((await storage.getPromptQueue(queueKey))?.dispatchError),
      );
      expect(stub.send).not.toHaveBeenCalled();
      expect((await storage.getPromptQueue(queueKey))?.dispatchError?.message).toContain("changed");
    });
  });

  test("/compact runs the existing session action when the provider lists no /compact", async () => {
    const stub = providerStub("codex", {
      catalogue: async () => ({ enhanced: true, status: "ready", commands: [] }),
      performSessionAction: async () => ({ outcome: "applied" }),
    });
    await withService(stub.provider, async ({ service }) => {
      await expect(
        service.dispatchIntent({ ...base, agent: "codex", prompt: "/compact", requestId: "c-1" }),
      ).resolves.toMatchObject({ outcome: "accepted" });
      expect(stub.performSessionAction).toHaveBeenCalledWith("provider-session", {
        kind: "compact",
      });
      expect(stub.send).not.toHaveBeenCalled();
    });
  });

  test("/compact refuses while a turn is running instead of interrupting it", async () => {
    const stub = providerStub("codex", {
      catalogue: async () => ({ enhanced: true, status: "ready", commands: [] }),
      status: async () => "running",
      performSessionAction: async () => ({ outcome: "applied" }),
    });
    await withService(stub.provider, async ({ service }) => {
      const outcome = await service.dispatchIntent({
        ...base,
        agent: "codex",
        prompt: "/compact",
        requestId: "c-1",
      });
      expect(outcome).toMatchObject({ outcome: "rejected" });
      expect(stub.performSessionAction).not.toHaveBeenCalled();
    });
  });

  test("the projection carries catalogue state and an explicit refresh reports its outcome", async () => {
    const stub = providerStub("claude");
    await withService(stub.provider, async ({ service }) => {
      await service.ensureSession(base);
      const projection = await service.getProjection(base);
      expect(projection?.slashCommandCatalogue).toMatchObject({ status: "ready", enhanced: true });
      expect(projection?.slashCommands?.map((row) => row.id)).toContain("claude:/review");
      const refreshed = await service.refreshProjectionCommands(base);
      expect(refreshed.outcome).toBe("reread");
      expect(refreshed.projection?.slashCommandCatalogue?.lastRefresh).toMatchObject({
        outcome: "reread",
      });
    });
  });

  test("an unsupported integration projects unsupported rather than an empty ready list", async () => {
    const stub = providerStub("cursor");
    await withService(stub.provider, async ({ service }) => {
      const cursor = { ...base, agent: "cursor" as const };
      await service.ensureSession(cursor);
      const projection = await service.getProjection(cursor);
      expect(projection?.slashCommandCatalogue?.status).toBe("unsupported");
      expect(stub.commandCatalogue).not.toHaveBeenCalled();
    });
  });
});
