import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as realBackend from "@/lib/backend";
import { useClaudeStore } from "@/stores/claudeStore";
import { useClaudeTmuxStore } from "@/stores/claudeTmuxStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import type { PersistedPromptQueue } from "@/types";
import { isPromptQueueActionError } from "@/lib/prompt-queue-errors";

const realBackendSnapshot = { ...realBackend };
const enqueuePromptQueueMessage = mock(
  async (..._args: unknown[]): Promise<unknown> => undefined,
);
const requeuePromptQueueMessage = mock(
  async (..._args: unknown[]): Promise<unknown> => undefined,
);
const removePromptQueueMessage = mock(
  async (..._args: unknown[]): Promise<unknown> => undefined,
);
const movePromptQueueMessage = mock(
  async (..._args: unknown[]): Promise<unknown> => undefined,
);
const claimPromptQueueHead = mock(
  async (..._args: unknown[]): Promise<unknown> => undefined,
);
const acknowledgePromptQueueClaim = mock(
  async (..._args: unknown[]): Promise<unknown> => undefined,
);
const rejectPromptQueueClaim = mock(
  async (..._args: unknown[]): Promise<unknown> => undefined,
);
const transferPromptQueueMessageToComposeDraft = mock(
  async (..._args: unknown[]): Promise<unknown> => undefined,
);
const saveComposeDraft = mock(
  async (..._args: unknown[]): Promise<unknown> => ({ revision: 8 }),
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  enqueuePromptQueueMessage,
  requeuePromptQueueMessage,
  removePromptQueueMessage,
  movePromptQueueMessage,
  claimPromptQueueHead,
  acknowledgePromptQueueClaim,
  rejectPromptQueueClaim,
  transferPromptQueueMessageToComposeDraft,
  saveComposeDraft,
}));

const {
  acknowledgeAgentPromptClaim,
  claimAgentPromptQueueHead,
  createPromptQueueSources,
  enqueueAgentPrompt,
  moveAgentPrompt,
  rejectAgentPromptClaim,
  removeAgentPrompt,
  requeueAgentPrompt,
  transferAgentPromptToComposeDraft,
} = await import("./prompt-queue-sources");
const { persistComposeDraft } = await import("@/lib/compose-draft-persistence");

/**
 * Every adapter reaches its store through `as unknown as AnyQueueStore`, so
 * neither the compiler nor the type system verifies that the store really
 * exposes `messageQueue`. These tests exercise the adapters against the real
 * stores, which is the only thing that would catch a rename on either side.
 */

const stores = {
  claude: useClaudeStore,
  codex: useCodexStore,
  opencode: useOpenCodeStore,
  "claude-tmux": useClaudeTmuxStore,
} as const;

type TestQueuedMessage = {
  id: string;
  text?: string;
  attachments?: unknown[];
};

function setClaudeProjection(messages: TestQueuedMessage[]): void {
  (useClaudeStore as unknown as {
    setState: (partial: { messageQueue: Map<string, TestQueuedMessage[]> }) => void;
  }).setState({ messageQueue: new Map([["env-env-1:tab-1", messages]]) });
}

function getClaudeProjection(sessionKey: string): TestQueuedMessage[] | undefined {
  return (
    useClaudeStore.getState().messageQueue as unknown as
      Map<string, TestQueuedMessage[]>
  ).get(sessionKey);
}

function snapshot<T>(
  queueKey: string,
  environmentId: string,
  messages: T[],
  revision = 1,
): PersistedPromptQueue<T> {
  return {
    queueKey,
    environmentId,
    messages,
    updatedAt: "2026-07-29T00:00:00.000Z",
    revision,
  };
}

beforeEach(() => {
  for (const fn of [
    enqueuePromptQueueMessage,
    requeuePromptQueueMessage,
    removePromptQueueMessage,
    movePromptQueueMessage,
    claimPromptQueueHead,
    acknowledgePromptQueueClaim,
    rejectPromptQueueClaim,
    transferPromptQueueMessageToComposeDraft,
  ]) {
    fn.mockReset();
  }
});

afterEach(() => {
  for (const store of Object.values(stores)) {
    (store as unknown as { setState: (partial: unknown) => void })
      .setState({ messageQueue: new Map() });
  }
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("createPromptQueueSources", () => {
  test("exposes one uniquely namespaced source per agent", () => {
    const agents = createPromptQueueSources().map((source) => source.agent);
    expect(agents.sort()).toEqual(["claude", "claude-tmux", "codex", "opencode"]);
    expect(new Set(agents).size).toBe(agents.length);
  });

  test("no agent namespace contains the key separator", () => {
    // promptQueueKey joins on a NUL and parses at the first one, so a namespace
    // containing one would decode as a different agent.
    for (const source of createPromptQueueSources()) {
      expect(source.agent).not.toContain("\u0000");
      expect(source.agent.length).toBeGreaterThan(0);
    }
  });
});

describe("store adapters", () => {
  for (const [agent, store] of Object.entries(stores)) {
    describe(agent, () => {
      test("reads the store's live messageQueue map", () => {
        const source = createPromptQueueSources().find((entry) => entry.agent === agent)!;
        expect(source.getQueues()).toBeInstanceOf(Map);
        expect(source.getQueues()).toBe(
          (store.getState() as { messageQueue: unknown }).messageQueue as never,
        );
      });

      test("setQueue writes through to the store with a fresh map identity", () => {
        const source = createPromptQueueSources().find((entry) => entry.agent === agent)!;
        const before = source.getQueues();

        source.setQueue("session-key", [{ id: "a" }]);

        const after = source.getQueues();
        expect(after.get("session-key")).toEqual([{ id: "a" }]);
        // Zustand selectors detect the projection change by map identity.
        expect(after).not.toBe(before);
      });

      test("setQueue skips an identical application so hydration cannot loop", () => {
        const source = createPromptQueueSources().find((entry) => entry.agent === agent)!;
        source.setQueue("session-key", [{ id: "a" }]);
        const applied = source.getQueues();

        source.setQueue("session-key", [{ id: "a" }]);

        expect(source.getQueues()).toBe(applied);
      });

    });
  }
});

describe("environmentIdFor", () => {
  test("recovers the environment from the shared native session key", () => {
    for (const agent of ["claude", "codex", "opencode"]) {
      const source = createPromptQueueSources().find((entry) => entry.agent === agent)!;
      expect(source.environmentIdFor("env-abc123:tab-1")).toBe("abc123");
    }
  });

  test("returns null for a key carrying no recoverable environment", () => {
    // An unscoped queue could never be cleaned up when its environment goes,
    // so the adapter must be able to recognise one and decline to scope it.
    for (const source of createPromptQueueSources()) {
      expect(source.environmentIdFor("nonsense")).toBeNull();
    }
  });

  test("tmux recovers the environment from its own scoped key form", () => {
    const source = createPromptQueueSources().find((entry) => entry.agent === "claude-tmux")!;
    expect(source.environmentIdFor("env:abc123:tab:tab-1")).toBe("abc123");
  });
});

describe("backend mutation adapters", () => {
  const sessionKey = "env-env-1:tab-1";
  const queueKey = `claude\u0000${sessionKey}`;

  test("enqueues and requeues using authoritative snapshots", async () => {
    enqueuePromptQueueMessage.mockResolvedValueOnce(
      snapshot(queueKey, "env-1", [{ id: "m1" }], 1),
    );
    requeuePromptQueueMessage.mockResolvedValueOnce(
      snapshot(queueKey, "env-1", [{ id: "m0" }, { id: "m1" }], 2),
    );

    await enqueueAgentPrompt("claude", sessionKey, { id: "m1" });
    await requeueAgentPrompt("claude", sessionKey, { id: "m0" });

    expect(enqueuePromptQueueMessage).toHaveBeenCalledWith(
      queueKey,
      "env-1",
      { id: "m1" },
    );
    expect(requeuePromptQueueMessage).toHaveBeenCalledWith(
      queueKey,
      "env-1",
      { id: "m0" },
    );
    expect(getClaudeProjection(sessionKey)).toEqual([
      { id: "m0" },
      { id: "m1" },
    ]);
  });

  test("removes, moves, and transfers while applying returned snapshots", async () => {
    setClaudeProjection([{ id: "m1" }, { id: "m2" }]);
    movePromptQueueMessage.mockResolvedValueOnce(
      snapshot(queueKey, "env-1", [{ id: "m2" }, { id: "m1" }], 2),
    );
    removePromptQueueMessage.mockResolvedValueOnce({
      removed: { id: "m2" },
      queue: snapshot(queueKey, "env-1", [{ id: "m1" }], 3),
    });
    transferPromptQueueMessageToComposeDraft.mockResolvedValueOnce({
      removed: { id: "m1", text: "edit", attachments: [] },
      queue: snapshot(queueKey, "env-1", [], 4),
      draft: {
        draftKey: "claude:env-1:env-env-1%3Atab-1",
        ownerType: "environment",
        ownerId: "env-1",
        value: { text: "edit", mentions: [], attachments: [] },
        updatedAt: "2026-07-29T00:00:00.000Z",
        revision: 1,
      },
    });

    await moveAgentPrompt("claude", sessionKey, "m2", "up");
    await expect(removeAgentPrompt("claude", sessionKey, "m2"))
      .resolves.toEqual({ id: "m2" });
    await expect(
      transferAgentPromptToComposeDraft<TestQueuedMessage>(
        "claude",
        sessionKey,
        "m1",
      ),
    ).resolves.toEqual({ id: "m1", text: "edit", attachments: [] });

    expect(transferPromptQueueMessageToComposeDraft).toHaveBeenCalledWith(
      queueKey,
      "env-1",
      "m1",
      "claude:env-1:env-env-1%3Atab-1",
      "environment",
      "env-1",
    );
    expect(getClaudeProjection(sessionKey)).toEqual([]);
  });

  test("clears projections for null remove, move, transfer, and settlement snapshots", async () => {
    setClaudeProjection([{ id: "ghost" }]);
    removePromptQueueMessage.mockResolvedValueOnce({ removed: null, queue: null });
    await removeAgentPrompt("claude", sessionKey, "ghost");
    expect(getClaudeProjection(sessionKey)).toEqual([]);

    setClaudeProjection([{ id: "ghost" }]);
    movePromptQueueMessage.mockResolvedValueOnce(null);
    await moveAgentPrompt("claude", sessionKey, "ghost", "up");
    // A missing queue leaves the current move projection alone; the resource
    // change/hydration path owns deletion reconciliation.
    expect(getClaudeProjection(sessionKey)).toEqual([
      { id: "ghost" },
    ]);

    transferPromptQueueMessageToComposeDraft.mockResolvedValueOnce({
      removed: null,
      queue: null,
      draft: null,
    });
    await transferAgentPromptToComposeDraft("claude", sessionKey, "ghost");
    expect(getClaudeProjection(sessionKey)).toEqual([]);

    acknowledgePromptQueueClaim.mockResolvedValueOnce(null);
    await acknowledgeAgentPromptClaim("claude", sessionKey, "claim-1");
    expect(getClaudeProjection(sessionKey)).toEqual([]);
  });

  test("claims and settles a backend-owned head", async () => {
    setClaudeProjection([{ id: "m1" }, { id: "m2" }]);
    claimPromptQueueHead.mockResolvedValueOnce({
      claimed: { id: "m1" },
      claimToken: "claim-1",
      queue: snapshot(queueKey, "env-1", [{ id: "m2" }], 2),
    });
    acknowledgePromptQueueClaim.mockResolvedValueOnce(
      snapshot(queueKey, "env-1", [{ id: "m2" }], 3),
    );
    rejectPromptQueueClaim.mockResolvedValueOnce(
      snapshot(queueKey, "env-1", [{ id: "m1" }, { id: "m2" }], 4),
    );

    await expect(claimAgentPromptQueueHead("claude", sessionKey)).resolves.toEqual({
      entry: { id: "m1" },
      claimToken: "claim-1",
    });
    await acknowledgeAgentPromptClaim("claude", sessionKey, "claim-1");
    await rejectAgentPromptClaim("claude", sessionKey, "claim-2");
    expect(getClaudeProjection(sessionKey)).toEqual([
      { id: "m1" },
      { id: "m2" },
    ]);
  });

  test("rejects unknown agents and unscoped session keys without invoking backend", async () => {
    /**
     * Every helper resolves its identity the same way, so every helper has to
     * refuse the same two inputs: an agent with no adapter cannot be scoped to
     * a queue key, and a session key carrying no environment cannot be scoped
     * to an environment — writing either would create a queue nothing can ever
     * clean up.
     */
    const mutations: Array<[string, (agent: string, key: string) => Promise<unknown>]> = [
      ["enqueue", (agent, key) => enqueueAgentPrompt(agent, key, { id: "m1" })],
      ["requeue", (agent, key) => requeueAgentPrompt(agent, key, { id: "m1" })],
      ["remove", (agent, key) => removeAgentPrompt(agent, key, "m1")],
      ["move", (agent, key) => moveAgentPrompt(agent, key, "m1", "up")],
      ["acknowledge", (agent, key) => acknowledgeAgentPromptClaim(agent, key, "token")],
      ["reject", (agent, key) => rejectAgentPromptClaim(agent, key, "token")],
      [
        "transfer",
        (agent, key) => transferAgentPromptToComposeDraft(
          agent as "claude",
          key,
          "m1",
        ),
      ],
    ];

    for (const [label, mutate] of mutations) {
      await expect(
        mutate("unknown", sessionKey),
        `${label} with an unknown agent`,
      ).rejects.toThrow("Unknown prompt queue agent");
      await expect(
        mutate("claude", "unscoped"),
        `${label} with an unscoped session key`,
      ).rejects.toThrow("not scoped");
    }

    await expect(claimAgentPromptQueueHead("unknown", sessionKey)).resolves.toBeNull();
    expect(enqueuePromptQueueMessage).not.toHaveBeenCalled();
    expect(requeuePromptQueueMessage).not.toHaveBeenCalled();
    expect(removePromptQueueMessage).not.toHaveBeenCalled();
    expect(movePromptQueueMessage).not.toHaveBeenCalled();
    expect(acknowledgePromptQueueClaim).not.toHaveBeenCalled();
    expect(rejectPromptQueueClaim).not.toHaveBeenCalled();
    expect(transferPromptQueueMessageToComposeDraft).not.toHaveBeenCalled();
    expect(claimPromptQueueHead).not.toHaveBeenCalled();
  });

  test("scopes a tmux mutation through the tmux key form", async () => {
    // tmux encodes its environment differently from the three native agents,
    // and only a mutation proves the adapter translates it rather than the
    // read-only `environmentIdFor` helper.
    const tmuxSessionKey = "env:env-9:tab:tab-4";
    enqueuePromptQueueMessage.mockResolvedValueOnce(
      snapshot(
        `claude-tmux\u0000${tmuxSessionKey}`,
        "env-9",
        [{ id: "t1", text: "tmux prompt", attachments: [] }],
        1,
      ),
    );

    await enqueueAgentPrompt("claude-tmux", tmuxSessionKey, {
      id: "t1",
      text: "tmux prompt",
      attachments: [],
    });

    expect(enqueuePromptQueueMessage).toHaveBeenCalledWith(
      `claude-tmux\u0000${tmuxSessionKey}`,
      "env-9",
      { id: "t1", text: "tmux prompt", attachments: [] },
    );
    expect(
      useClaudeTmuxStore.getState().getQueuedMessages(tmuxSessionKey),
    ).toEqual([{ id: "t1", text: "tmux prompt", attachments: [] }]);
  });

  test("syncs the compose draft revision cursor after a transfer", async () => {
    // The transfer creates the draft behind the compose bar's back. Without
    // adopting its revision the next debounced save is a compare-and-swap
    // against 0 and loses to the record the transfer just wrote.
    setClaudeProjection([{ id: "m1" }]);
    transferPromptQueueMessageToComposeDraft.mockResolvedValueOnce({
      removed: { id: "m1", text: "edit", attachments: [] },
      queue: snapshot(queueKey, "env-1", [], 2),
      draft: {
        draftKey: "claude:env-1:env-env-1%3Atab-1",
        ownerType: "environment",
        ownerId: "env-1",
        value: { text: "edit", mentions: [], attachments: [] },
        updatedAt: "2026-07-29T00:00:00.000Z",
        revision: 7,
      },
    });

    await transferAgentPromptToComposeDraft("claude", sessionKey, "m1");

    await persistComposeDraft(
      "claude:env-1:env-env-1%3Atab-1",
      "environment",
      "env-1",
      { text: "edit", mentions: [], attachments: [] },
    );
    expect(saveComposeDraft).toHaveBeenCalledWith(
      "claude:env-1:env-env-1%3Atab-1",
      "environment",
      "env-1",
      { text: "edit", mentions: [], attachments: [] },
      7,
    );
  });

  test("leaves the revision cursor alone when the transfer returns no draft", async () => {
    setClaudeProjection([{ id: "m1" }]);
    transferPromptQueueMessageToComposeDraft.mockResolvedValueOnce({
      removed: null,
      queue: snapshot(queueKey, "env-1", [{ id: "m1" }], 2),
      draft: null,
    });

    await expect(
      transferAgentPromptToComposeDraft("claude", sessionKey, "m1"),
    ).resolves.toBeNull();
    expect(getClaudeProjection(sessionKey)).toEqual([{ id: "m1" }]);
  });

  test("reports an occupied composer instead of the backend's raw refusal", async () => {
    // The dialog shows a `PromptQueueActionError`'s own message; anything else
    // becomes "wait for the queue to refresh", which never helps here.
    setClaudeProjection([{ id: "m1" }]);
    transferPromptQueueMessageToComposeDraft.mockRejectedValueOnce(
      new Error("Compose draft already exists"),
    );

    const error = await transferAgentPromptToComposeDraft("claude", sessionKey, "m1")
      .then(() => null, (thrown: unknown) => thrown);

    expect(isPromptQueueActionError(error)).toBe(true);
    expect((error as Error).message).toContain(
      "Send or clear it before editing a queued prompt",
    );
    expect(getClaudeProjection(sessionKey)).toEqual([{ id: "m1" }]);
  });

  test("passes through a transfer failure that the user cannot resolve", async () => {
    setClaudeProjection([{ id: "m1" }]);
    transferPromptQueueMessageToComposeDraft.mockRejectedValueOnce(
      new Error("Queue storage is unavailable"),
    );

    const error = await transferAgentPromptToComposeDraft("claude", sessionKey, "m1")
      .then(() => null, (thrown: unknown) => thrown);

    expect(isPromptQueueActionError(error)).toBe(false);
    expect((error as Error).message).toBe("Queue storage is unavailable");
  });

  test("propagates backend rejection without changing the projection", async () => {
    setClaudeProjection([{ id: "current" }]);
    enqueuePromptQueueMessage.mockRejectedValueOnce(new Error("backend unavailable"));
    await expect(
      enqueueAgentPrompt("claude", sessionKey, { id: "new" }),
    ).rejects.toThrow("backend unavailable");
    expect(getClaudeProjection(sessionKey)).toEqual([
      { id: "current" },
    ]);
  });
});
