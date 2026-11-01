import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_HANDOFF_VERSION,
  createAgentHandoffSnapshot,
  sanitizeAgentHandoffMessage,
  textCarriesAgentHandoff,
  type AgentHandoffSnapshot,
} from "@orkestrator/protocol/agent-handoff";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  AGENT_HANDOFF_PENDING_COMMAND_MESSAGE,
  AGENT_HANDOFF_PENDING_GOAL_MESSAGE,
  AGENT_HANDOFF_UNVERIFIED_MESSAGE,
  NativeAgentHandoffs,
  pendingHandoffCommandRefusal,
} from "./native-agent-handoffs.js";
import {
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  type NativeAgentRuntimeProvider,
} from "./native-agent-provider.js";
import { NativeAgentService, nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { StorageService } from "./storage.js";

const ENVIRONMENT = "env-1";
const TAB = "tab-destination";
const LOGICAL_KEY = `env-${ENVIRONMENT}:${TAB}`;
const SESSION_KEY = nativeAgentSessionStorageKey(ENVIRONMENT, "codex", LOGICAL_KEY);

function handoffSnapshot(id = "handoff-1"): AgentHandoffSnapshot {
  return createAgentHandoffSnapshot({
    id,
    environmentId: ENVIRONMENT,
    sourceProvider: "claude",
    destinationProvider: "codex",
    sourceSessionId: "claude-session",
    messages: [
      {
        id: "source-user",
        role: "user",
        content: "Fix the failing build",
        parts: [{ type: "text", content: "Fix the failing build" }],
        createdAt: "2026-07-27T10:00:00.000Z",
      },
    ],
    now: "2026-07-27T11:00:00.000Z",
  });
}

type SendCall = [string, string, Record<string, unknown>];

function providerStub(behaviour: {
  send?: (sessionId: string, prompt: string) => Promise<void>;
  messages?: () => Promise<unknown[]>;
}) {
  const send = mock(behaviour.send ?? (async () => undefined));
  const provider = {
    agent: "codex",
    createSession: async () => "destination-session",
    registerSession: () => undefined,
    send,
    status: async () => "idle",
    messages: behaviour.messages ?? (async () => []),
    structured: async () => null,
    abort: async () => undefined,
    dispose: async () => undefined,
  } as unknown as NativeAgentRuntimeProvider;
  return { provider, send };
}

async function withDestination(
  behaviour: Parameters<typeof providerStub>[0],
  run: (context: {
    service: NativeAgentService;
    storage: StorageService;
    send: ReturnType<typeof providerStub>["send"];
  }) => Promise<void>,
  options: { tab?: Record<string, unknown> } = {},
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-handoff-delivery-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: ENVIRONMENT,
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
  const snapshot = handoffSnapshot();
  await storage.saveAgentHandoff(snapshot.id, ENVIRONMENT, AGENT_HANDOFF_VERSION, { ...snapshot });
  await storage.savePaneLayout(
    ENVIRONMENT,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          {
            id: TAB,
            type: "agent-native",
            agentHandoffId: snapshot.id,
            ...options.tab,
          },
        ],
        activeTabId: TAB,
      } as never,
    },
    0,
  );
  const { provider, send } = providerStub(behaviour);
  const service = new NativeAgentService(
    storage,
    async <T>(command: string): Promise<T> => {
      throw new Error(`Unexpected backend command: ${command}`);
    },
    { provider: async () => provider },
  );
  try {
    await run({ service, storage, send });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const dispatch = (requestId: string, prompt = "Carry on") => ({
  environmentId: ENVIRONMENT,
  agent: "codex" as const,
  logicalSessionKey: LOGICAL_KEY,
  prompt,
  requestId,
});

function promptOf(call: unknown): string {
  return (call as SendCall)[1];
}

async function consumedHandoff(storage: StorageService): Promise<unknown> {
  const layout = await storage.getPaneLayout(ENVIRONMENT);
  const leaf = layout!.root as unknown as { tabs: Array<Record<string, unknown>> };
  return leaf.tabs.find((tab) => tab.id === TAB)?.consumedAgentHandoffId;
}

describe("handoff delivery at dispatch", () => {
  test("the first prompt from any sender carries the history, journaled with the request", async () => {
    await withDestination({}, async ({ service, storage, send }) => {
      await expect(service.dispatchIntent({ ...dispatch("first"), mode: "plan" })).resolves.toEqual(
        {
          outcome: "accepted",
          requestId: "first",
        },
      );
      const sent = promptOf(send.mock.calls[0]);
      expect(textCarriesAgentHandoff(sent, "handoff-1")).toBe(true);
      expect(sent).toEndWith("Carry on");

      const session = await storage.getNativeAgentSession(SESSION_KEY);
      expect(session?.dispatchedRequestIds).toEqual(["first"]);
      expect(session?.deliveredAgentHandoffIds).toEqual(["handoff-1"]);
      expect(session?.lastDispatchedTurn).toEqual({ requestId: "first", mode: "plan" });
      expect(await consumedHandoff(storage)).toBe("handoff-1");
    });
  });

  test("the second prompt is plain", async () => {
    await withDestination({}, async ({ service, storage, send }) => {
      await service.dispatchIntent(dispatch("first"));
      await service.dispatchIntent({ ...dispatch("second", "Next"), mode: "build" });
      expect(promptOf(send.mock.calls[1])).toBe("Next");
      expect((await storage.getNativeAgentSession(SESSION_KEY))?.lastDispatchedTurn).toEqual({
        requestId: "second",
        mode: "build",
      });
    });
  });

  test("a prompt that already holds the carrier (an older renderer) is not prefixed again", async () => {
    await withDestination({}, async ({ service, storage, send }) => {
      const carried = `${handoffSnapshot().bootstrapPrompt}\n\nCarry on`;
      await service.dispatchIntent(dispatch("first", carried));
      expect(promptOf(send.mock.calls[0])).toBe(carried);
      expect((await storage.getNativeAgentSession(SESSION_KEY))?.deliveredAgentHandoffIds).toEqual([
        "handoff-1",
      ]);
    });
  });

  test("a definite rejection leaves the history pending for the next attempt", async () => {
    let reject = true;
    await withDestination(
      {
        send: async () => {
          if (reject) throw new PromptRejectedError("No input");
        },
      },
      async ({ service, storage, send }) => {
        await expect(service.dispatchIntent(dispatch("first"))).resolves.toEqual({
          outcome: "rejected",
          error: "No input",
        });
        expect(
          (await storage.getNativeAgentSession(SESSION_KEY))?.deliveredAgentHandoffIds,
        ).toBeUndefined();
        expect(await consumedHandoff(storage)).toBeUndefined();

        reject = false;
        await service.dispatchIntent(dispatch("second", "Again"));
        expect(textCarriesAgentHandoff(promptOf(send.mock.calls[1]), "handoff-1")).toBe(true);
      },
    );
  });

  test("an ambiguous dispatch parks with the handoff; a retry sends the same carrier", async () => {
    let ambiguous = true;
    await withDestination(
      {
        send: async () => {
          if (ambiguous) throw new AmbiguousPromptDispatchError("Response was lost");
        },
      },
      async ({ service, storage, send }) => {
        await expect(service.dispatchIntent(dispatch("first"))).resolves.toMatchObject({
          outcome: "unknown",
          requestId: "first",
        });
        const parked = await storage.getNativeAgentSession(SESSION_KEY);
        expect(parked?.pendingDispatch).toMatchObject({
          requestId: "first",
          prompt: "Carry on",
          agentHandoffId: "handoff-1",
        });
        expect(parked?.deliveredAgentHandoffIds).toBeUndefined();

        ambiguous = false;
        await service.dispatchIntent(dispatch("first"));
        expect(promptOf(send.mock.calls[1])).toBe(promptOf(send.mock.calls[0]));
        const settled = await storage.getNativeAgentSession(SESSION_KEY);
        expect(settled?.deliveredAgentHandoffIds).toEqual(["handoff-1"]);
        expect(settled?.dispatchedRequestIds).toEqual(["first"]);
        expect(settled?.pendingDispatch).toBeUndefined();
      },
    );
  });

  test("confirming a parked dispatch records the delivery in the same write", async () => {
    await withDestination(
      {
        send: async () => {
          throw new AmbiguousPromptDispatchError("Response was lost");
        },
      },
      async ({ service, storage }) => {
        await service.dispatchIntent(dispatch("first"));
        await expect(storage.confirmNativeAgentDispatch(SESSION_KEY, "first")).resolves.toBe(true);
        const session = await storage.getNativeAgentSession(SESSION_KEY);
        expect(session?.dispatchedRequestIds).toEqual(["first"]);
        expect(session?.deliveredAgentHandoffIds).toEqual(["handoff-1"]);
      },
    );
  });

  test("a destination whose transcript started is not sent the history again", async () => {
    await withDestination(
      {
        messages: async () => [
          { id: "real-user", role: "user", content: "old client already sent this" },
        ],
      },
      async ({ service, storage, send }) => {
        await service.dispatchIntent(dispatch("first"));
        expect(promptOf(send.mock.calls[0])).toBe("Carry on");
        expect(await consumedHandoff(storage)).toBe("handoff-1");
      },
    );
  });

  test("a local error row is not evidence the destination started", async () => {
    await withDestination(
      { messages: async () => [{ id: "error-1", role: "system", content: "refused" }] },
      async ({ service, send }) => {
        await service.dispatchIntent(dispatch("first"));
        expect(textCarriesAgentHandoff(promptOf(send.mock.calls[0]), "handoff-1")).toBe(true);
      },
    );
  });

  test("an unreadable destination refuses rather than guessing, before anything is journaled", async () => {
    await withDestination(
      {
        messages: async () => {
          throw new Error("bridge unavailable");
        },
      },
      async ({ service, storage, send }) => {
        await expect(service.dispatchIntent(dispatch("first"))).resolves.toEqual({
          outcome: "rejected",
          error: AGENT_HANDOFF_UNVERIFIED_MESSAGE,
        });
        expect(send).not.toHaveBeenCalled();
        expect(
          (await storage.getNativeAgentSession(SESSION_KEY))?.dispatchedRequestIds ?? [],
        ).toEqual([]);
      },
    );
  });

  test("a tab whose handoff is already consumed sends plain text", async () => {
    await withDestination(
      {},
      async ({ service, send }) => {
        await service.dispatchIntent(dispatch("first"));
        expect(promptOf(send.mock.calls[0])).toBe("Carry on");
      },
      { tab: { consumedAgentHandoffId: "handoff-1" } },
    );
  });

  test("a tab with no handoff, or a missing record, sends plain text", async () => {
    await withDestination(
      {},
      async ({ service, send }) => {
        await service.dispatchIntent(dispatch("first"));
        expect(promptOf(send.mock.calls[0])).toBe("Carry on");
      },
      { tab: { agentHandoffId: "no-such-record" } },
    );
  });
});

describe("reading a source transcript for a handoff", () => {
  const SOURCE_LOGICAL_KEY = `env-${ENVIRONMENT}:tab-source`;

  async function withSource(
    agent: "opencode" | "claude",
    behaviour: { messages: () => Promise<unknown[]>; status?: () => Promise<string> },
    run: (read: () => Promise<{ messages: unknown[] }>) => Promise<void>,
  ): Promise<void> {
    await withDestination({}, async ({ storage }) => {
      const key = nativeAgentSessionStorageKey(ENVIRONMENT, agent, SOURCE_LOGICAL_KEY);
      await storage.getOrCreateNativeAgentSession(
        { key, environmentId: ENVIRONMENT, agent, logicalSessionKey: SOURCE_LOGICAL_KEY },
        async () => "source-session",
      );
      const provider = {
        messages: mock(behaviour.messages),
        status: behaviour.status ?? (async () => "idle"),
      } as unknown as NativeAgentRuntimeProvider;
      const handoffs = new NativeAgentHandoffs({ storage, provider: async () => provider });
      await run(() =>
        handoffs.readSourceTranscript({
          environmentId: ENVIRONMENT,
          agent,
          logicalSessionKey: SOURCE_LOGICAL_KEY,
          expectedProviderSessionId: "source-session",
        }),
      );
    });
  }

  test("reads the provider's whole transcript with no window", async () => {
    const rows = Array.from({ length: 300 }, (_, index) => ({ id: `row-${index}`, role: "user" }));
    const messages = mock(async (_id: string, _options?: unknown) => rows);
    await withSource("claude", { messages: messages as never }, async (read) => {
      const transcript = await read();
      expect(transcript.messages).toEqual(rows);
    });
    expect(messages).toHaveBeenCalledWith("source-session");
  });

  test("unwraps OpenCode's envelopes into the neutral row shape", async () => {
    await withSource(
      "opencode",
      {
        messages: async () => [
          {
            info: { id: "msg-1", role: "user", time: { created: 1_700_000_000_000 } },
            parts: [{ type: "text", text: "Fix the build" }],
          },
        ],
      },
      async (read) => {
        const [row] = (await read()).messages as Array<Record<string, unknown>>;
        expect(row).toMatchObject({ id: "msg-1", role: "user" });
        expect(sanitizeAgentHandoffMessage(row, "2026-11-01T00:00:00.000Z")?.content).toContain(
          "Fix the build",
        );
      },
    );
  });

  test("refuses a session that is mid-turn, and one that moves during the read", async () => {
    await withSource(
      "claude",
      { messages: async () => [], status: async () => "running" },
      async (read) => {
        await expect(read()).rejects.toThrow("to finish before continuing");
      },
    );
    let statusReads = 0;
    await withSource(
      "claude",
      {
        messages: async () => [],
        status: async () => (++statusReads === 1 ? "idle" : "running"),
      },
      async (read) => {
        await expect(read()).rejects.toThrow("changed while it was being transferred");
      },
    );
  });

  test("refuses when the tab now shows another provider session", async () => {
    await withDestination({}, async ({ storage }) => {
      const handoffs = new NativeAgentHandoffs({
        storage,
        provider: async () => ({}) as NativeAgentRuntimeProvider,
      });
      await expect(
        handoffs.readSourceTranscript({
          environmentId: ENVIRONMENT,
          agent: "claude",
          logicalSessionKey: SOURCE_LOGICAL_KEY,
          expectedProviderSessionId: "gone",
        }),
      ).rejects.toThrow("session is unavailable");
    });
  });
});

describe("what a pending handoff refuses", () => {
  test("a resolved command cannot carry history; plain text and compact can", () => {
    expect(
      pendingHandoffCommandRefusal({
        kind: "prompt",
        allowProviderCommands: true,
        command: { kind: "selected" } as never,
        persistedIntent: { kind: "typed" },
      }),
    ).toBe(AGENT_HANDOFF_PENDING_COMMAND_MESSAGE);
    expect(
      pendingHandoffCommandRefusal({
        kind: "prompt",
        allowProviderCommands: true,
        persistedIntent: { kind: "typed" },
      }),
    ).toBeUndefined();
    expect(
      pendingHandoffCommandRefusal({
        kind: "session-action",
        action: "compact",
        commandName: "compact",
      }),
    ).toBeUndefined();
  });

  test("only setting or resuming a goal is refused", () => {
    const plan = (args: string) =>
      pendingHandoffCommandRefusal({ kind: "goal", commandName: "goal", arguments: args });
    expect(plan("ship the feature")).toBe(AGENT_HANDOFF_PENDING_GOAL_MESSAGE);
    expect(plan("resume")).toBe(AGENT_HANDOFF_PENDING_GOAL_MESSAGE);
    expect(plan("pause")).toBeUndefined();
    expect(plan("clear")).toBeUndefined();
  });
});
