import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realBackend from "@/lib/backend";
import { useClaudeTmuxStore } from "@/stores/claudeTmuxStore";
import type { PersistedPromptQueue } from "@/types";

const realBackendSnapshot = { ...realBackend };
const enqueuePromptQueueMessage = mock(async (..._args: unknown[]): Promise<unknown> => undefined);
const removePromptQueueMessage = mock(async (..._args: unknown[]): Promise<unknown> => undefined);
const movePromptQueueMessage = mock(async (..._args: unknown[]): Promise<unknown> => undefined);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  enqueuePromptQueueMessage,
  removePromptQueueMessage,
  movePromptQueueMessage,
}));

const { createPromptQueueSources, enqueueAgentPrompt, moveAgentPrompt, removeAgentPrompt } =
  await import("./prompt-queue-sources");

/**
 * The adapter reaches its store through `as unknown as AnyQueueStore`, so
 * neither the compiler nor the type system verifies that the store really
 * exposes `messageQueue`. These tests exercise the adapter against the real
 * store, which is the only thing that would catch a rename on either side.
 */

type TestQueuedMessage = {
  id: string;
  text?: string;
  attachments?: unknown[];
};

const sessionKey = "env:env-1:tab:tab-1";
const queueKey = `claude-tmux\u0000${sessionKey}`;

function setTmuxProjection(messages: TestQueuedMessage[]): void {
  (
    useClaudeTmuxStore as unknown as {
      setState: (partial: { messageQueue: Map<string, TestQueuedMessage[]> }) => void;
    }
  ).setState({ messageQueue: new Map([[sessionKey, messages]]) });
}

function getTmuxProjection(key: string): TestQueuedMessage[] | undefined {
  return (
    useClaudeTmuxStore.getState().messageQueue as unknown as Map<string, TestQueuedMessage[]>
  ).get(key);
}

function snapshot<T>(
  queueKeyValue: string,
  environmentId: string,
  messages: T[],
  revision = 1,
): PersistedPromptQueue<T> {
  return {
    queueKey: queueKeyValue,
    environmentId,
    messages,
    updatedAt: "2026-07-29T00:00:00.000Z",
    revision,
  };
}

beforeEach(() => {
  for (const fn of [enqueuePromptQueueMessage, removePromptQueueMessage, movePromptQueueMessage]) {
    fn.mockReset();
  }
});

afterEach(() => {
  useClaudeTmuxStore.setState({ messageQueue: new Map() });
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("createPromptQueueSources", () => {
  test("projects only the Claude Tmux queue; native agent queues are backend-drained", () => {
    const agents = createPromptQueueSources().map((source) => source.agent);
    expect(agents).toEqual(["claude-tmux"]);
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

describe("store adapter", () => {
  const source = () => createPromptQueueSources().find((entry) => entry.agent === "claude-tmux")!;

  test("reads the store's live messageQueue map", () => {
    expect(source().getQueues()).toBeInstanceOf(Map);
    expect(source().getQueues()).toBe(useClaudeTmuxStore.getState().messageQueue as never);
  });

  test("setQueue writes through to the store with a fresh map identity", () => {
    const before = source().getQueues();

    source().setQueue("session-key", [{ id: "a" }]);

    const after = source().getQueues();
    expect(after.get("session-key")).toEqual([{ id: "a" }]);
    // Zustand selectors detect the projection change by map identity.
    expect(after).not.toBe(before);
  });

  test("setQueue skips an identical application so hydration cannot loop", () => {
    source().setQueue("session-key", [{ id: "a" }]);
    const applied = source().getQueues();

    source().setQueue("session-key", [{ id: "a" }]);

    expect(source().getQueues()).toBe(applied);
  });
});

describe("environmentIdFor", () => {
  test("tmux recovers the environment from its own scoped key form", () => {
    const source = createPromptQueueSources().find((entry) => entry.agent === "claude-tmux")!;
    expect(source.environmentIdFor("env:abc123:tab:tab-1")).toBe("abc123");
  });

  test("returns null for a key carrying no recoverable environment", () => {
    // An unscoped queue could never be cleaned up when its environment goes,
    // so the adapter must be able to recognise one and decline to scope it.
    for (const source of createPromptQueueSources()) {
      expect(source.environmentIdFor("nonsense")).toBeNull();
    }
  });
});

describe("backend mutation adapters", () => {
  test("enqueues using the authoritative snapshot", async () => {
    enqueuePromptQueueMessage.mockResolvedValueOnce(snapshot(queueKey, "env-1", [{ id: "m1" }], 1));

    await enqueueAgentPrompt("claude-tmux", sessionKey, { id: "m1" });

    expect(enqueuePromptQueueMessage).toHaveBeenCalledWith(queueKey, "env-1", { id: "m1" });
    expect(getTmuxProjection(sessionKey)).toEqual([{ id: "m1" }]);
  });

  test("removes and moves while applying returned snapshots", async () => {
    setTmuxProjection([{ id: "m1" }, { id: "m2" }]);
    movePromptQueueMessage.mockResolvedValueOnce(
      snapshot(queueKey, "env-1", [{ id: "m2" }, { id: "m1" }], 2),
    );
    removePromptQueueMessage.mockResolvedValueOnce({
      removed: { id: "m2" },
      queue: snapshot(queueKey, "env-1", [{ id: "m1" }], 3),
    });

    await moveAgentPrompt("claude-tmux", sessionKey, "m2", "up");
    expect(getTmuxProjection(sessionKey)).toEqual([{ id: "m2" }, { id: "m1" }]);
    await expect(removeAgentPrompt("claude-tmux", sessionKey, "m2")).resolves.toEqual({
      id: "m2",
    });

    expect(getTmuxProjection(sessionKey)).toEqual([{ id: "m1" }]);
  });

  test("clears projections for null remove and move snapshots", async () => {
    setTmuxProjection([{ id: "ghost" }]);
    removePromptQueueMessage.mockResolvedValueOnce({ removed: null, queue: null });
    await removeAgentPrompt("claude-tmux", sessionKey, "ghost");
    expect(getTmuxProjection(sessionKey)).toEqual([]);

    setTmuxProjection([{ id: "ghost" }]);
    movePromptQueueMessage.mockResolvedValueOnce(null);
    await moveAgentPrompt("claude-tmux", sessionKey, "ghost", "up");
    // A missing queue leaves the current move projection alone; the resource
    // change/hydration path owns deletion reconciliation.
    expect(getTmuxProjection(sessionKey)).toEqual([{ id: "ghost" }]);
  });

  test("rejects unknown agents and unscoped session keys without invoking backend", async () => {
    /**
     * Every helper resolves its identity the same way, so every helper has to
     * refuse the same two inputs: an agent with no adapter cannot be scoped to
     * a queue key, and a session key carrying no environment cannot be scoped
     * to an environment — writing either would create a queue nothing can ever
     * clean up. Native agents have no renderer adapter, so they are unknown
     * here too.
     */
    const mutations: Array<[string, (agent: string, key: string) => Promise<unknown>]> = [
      ["enqueue", (agent, key) => enqueueAgentPrompt(agent, key, { id: "m1" })],
      ["remove", (agent, key) => removeAgentPrompt(agent, key, "m1")],
      ["move", (agent, key) => moveAgentPrompt(agent, key, "m1", "up")],
    ];

    for (const [label, mutate] of mutations) {
      for (const agent of ["unknown", "claude", "codex"]) {
        await expect(mutate(agent, sessionKey), `${label} with agent ${agent}`).rejects.toThrow(
          "Unknown prompt queue agent",
        );
      }
      await expect(
        mutate("claude-tmux", "unscoped"),
        `${label} with an unscoped session key`,
      ).rejects.toThrow("not scoped");
    }

    expect(enqueuePromptQueueMessage).not.toHaveBeenCalled();
    expect(removePromptQueueMessage).not.toHaveBeenCalled();
    expect(movePromptQueueMessage).not.toHaveBeenCalled();
  });

  test("propagates backend rejection without changing the projection", async () => {
    setTmuxProjection([{ id: "current" }]);
    enqueuePromptQueueMessage.mockRejectedValueOnce(new Error("backend unavailable"));
    await expect(enqueueAgentPrompt("claude-tmux", sessionKey, { id: "new" })).rejects.toThrow(
      "backend unavailable",
    );
    expect(getTmuxProjection(sessionKey)).toEqual([{ id: "current" }]);
  });
});
