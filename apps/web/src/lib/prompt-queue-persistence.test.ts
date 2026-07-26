import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  hydratePromptQueue,
  hydratePromptQueuesForEnvironment,
  parsePromptQueueKey,
  promptQueueKey,
  resetPromptQueueRevisions,
  startPromptQueuePersistence,
  type PromptQueueLoader,
  type PromptQueueSaver,
  type PromptQueueSource,
  type QueuedItem,
} from "./prompt-queue-persistence";
import type { PersistedPromptQueue } from "@/types";

/**
 * Stand-in for an agent store's queue map.
 *
 * Replaces the Map on every write and notifies, exactly as a Zustand store
 * does: the mirror uses map identity to detect change, so a fixture that
 * mutated in place would silently test nothing.
 */
function createSource(agent = "claude"): PromptQueueSource & {
  read: (sessionKey: string) => QueuedItem[] | undefined;
  size: () => number;
  push: (sessionKey: string, messages: QueuedItem[]) => void;
} {
  let queues = new Map<string, QueuedItem[]>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const replace = (sessionKey: string, messages: QueuedItem[]) => {
    const next = new Map(queues);
    next.set(sessionKey, messages);
    queues = next;
  };
  return {
    agent,
    read: (sessionKey) => queues.get(sessionKey),
    size: () => queues.size,
    push: (sessionKey, messages) => {
      replace(sessionKey, messages);
      notify();
    },
    getQueues: () => queues,
    setQueue: (sessionKey, messages) => {
      replace(sessionKey, messages);
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    environmentIdFor: (sessionKey) => {
      if (!sessionKey.startsWith("env-")) return null;
      const colon = sessionKey.indexOf(":");
      return colon === -1 ? null : sessionKey.slice(4, colon);
    },
  };
}

function persisted(
  queueKey: string,
  messages: QueuedItem[],
  revision: number,
  environmentId = "env-1",
): PersistedPromptQueue<QueuedItem> {
  return {
    queueKey,
    environmentId,
    messages,
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision,
  };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SESSION = "env-env-1:tab-1";

beforeEach(() => {
  resetPromptQueueRevisions();
});

describe("promptQueueKey", () => {
  test("round-trips agent and session key", () => {
    expect(parsePromptQueueKey(promptQueueKey("claude", SESSION)))
      .toEqual({ agent: "claude", sessionKey: SESSION });
  });

  test("namespaces two agents sharing a tab id", () => {
    expect(promptQueueKey("claude", "env-e:t")).not.toBe(promptQueueKey("codex", "env-e:t"));
  });

  test("rejects a key with no separator", () => {
    expect(parsePromptQueueKey("nonsense")).toBeNull();
  });
});

describe("hydratePromptQueuesForEnvironment", () => {
  test("restores a queue into the matching agent store", async () => {
    const source = createSource();
    await hydratePromptQueuesForEnvironment("env-1", [source], async () => [
      persisted(promptQueueKey("claude", SESSION), [{ id: "m1" }, { id: "m2" }], 3),
    ]);

    expect(source.read(SESSION)).toEqual([{ id: "m1" }, { id: "m2" }]);
  });

  test("ignores a queue belonging to an agent that is not registered", async () => {
    const source = createSource("claude");
    await hydratePromptQueuesForEnvironment("env-1", [source], async () => [
      persisted(promptQueueKey("codex", SESSION), [{ id: "m1" }], 1),
    ]);

    expect(source.size()).toBe(0);
  });

  test("drops messages with no stable id rather than queueing something unsendable", async () => {
    const source = createSource();
    await hydratePromptQueuesForEnvironment("env-1", [source], async () => [
      persisted(
        promptQueueKey("claude", SESSION),
        [{ id: "m1" }, { text: "no id" } as unknown as QueuedItem],
        1,
      ),
    ]);

    expect(source.read(SESSION)).toEqual([{ id: "m1" }]);
  });
});

describe("hydratePromptQueue", () => {
  test("clears the local queue when the backend record is gone", async () => {
    const source = createSource();
    source.push(SESSION, [{ id: "stale" }]);

    await hydratePromptQueue(
      promptQueueKey("claude", SESSION),
      [source],
      async () => null,
    );

    expect(source.read(SESSION)).toEqual([]);
  });

  test("adopts the backend ordering", async () => {
    const source = createSource();
    source.push(SESSION, [{ id: "a" }, { id: "b" }]);

    await hydratePromptQueue(
      promptQueueKey("claude", SESSION),
      [source],
      async () => persisted(promptQueueKey("claude", SESSION), [{ id: "b" }], 4),
    );

    expect(source.read(SESSION)).toEqual([{ id: "b" }]);
  });
});

describe("startPromptQueuePersistence", () => {
  test("mirrors a queued prompt to the backend", async () => {
    const source = createSource();
    const save = mock<PromptQueueSaver>(async () => persisted(promptQueueKey("claude", SESSION), [], 1));
    const stop = startPromptQueuePersistence([source], { debounceMs: 5, save });
    try {
      source.push(SESSION, [{ id: "m1" }]);
      await tick(50);

      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]?.[0]).toBe(promptQueueKey("claude", SESSION));
      expect(save.mock.calls[0]?.[1]).toBe("env-1");
      expect(save.mock.calls[0]?.[2]).toEqual([{ id: "m1" }]);
    } finally {
      stop();
    }
  });

  test("sends the observed revision so a second client cannot also take the head", async () => {
    const source = createSource();
    const save = mock<PromptQueueSaver>(async () => persisted(promptQueueKey("claude", SESSION), [], 7));
    const stop = startPromptQueuePersistence([source], { debounceMs: 5, save });
    try {
      source.push(SESSION, [{ id: "m1" }]);
      await tick(50);
      expect(save.mock.calls[0]?.[3]).toBe(0);

      source.push(SESSION, []);
      await tick(50);
      expect(save.mock.calls[1]?.[3]).toBe(7);
    } finally {
      stop();
    }
  });

  test("adopts the backend queue when a write conflicts", async () => {
    const source = createSource();
    const save = mock<PromptQueueSaver>(async () => {
      throw new Error("Prompt queue revision conflict");
    });
    const load = mock<PromptQueueLoader>(async () =>
      persisted(promptQueueKey("claude", SESSION), [{ id: "taken-by-peer" }], 9),
    );
    const stop = startPromptQueuePersistence([source], {
      debounceMs: 5,
      save,
      load,
    });
    try {
      source.push(SESSION, [{ id: "mine" }]);
      await tick(60);

      expect(source.read(SESSION)).toEqual([{ id: "taken-by-peer" }]);
    } finally {
      stop();
    }
  });

  test("coalesces a burst into one write carrying the final queue", async () => {
    const source = createSource();
    const save = mock<PromptQueueSaver>(async () => persisted(promptQueueKey("claude", SESSION), [], 1));
    const stop = startPromptQueuePersistence([source], { debounceMs: 25, save });
    try {
      source.push(SESSION, [{ id: "m1" }]);
      source.push(SESSION, [{ id: "m1" }, { id: "m2" }]);
      source.push(SESSION, [{ id: "m1" }, { id: "m2" }, { id: "m3" }]);
      await tick(90);

      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]?.[2]).toHaveLength(3);
    } finally {
      stop();
    }
  });

  test("skips a queue whose key carries no environment", async () => {
    const source = createSource();
    const save = mock<PromptQueueSaver>(async () => persisted("x", [], 1));
    const stop = startPromptQueuePersistence([source], { debounceMs: 5, save });
    try {
      source.push("unscoped-key", [{ id: "m1" }]);
      await tick(50);

      expect(save).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  test("does not rewrite a queue that hydration just applied", async () => {
    const source = createSource();
    const save = mock<PromptQueueSaver>(async () => persisted(promptQueueKey("claude", SESSION), [], 1));
    const stop = startPromptQueuePersistence([source], { debounceMs: 5, save });
    try {
      await hydratePromptQueue(
        promptQueueKey("claude", SESSION),
        [source],
        async () => persisted(promptQueueKey("claude", SESSION), [{ id: "m1" }], 4),
      );
      await tick(50);

      expect(save).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  test("mirrors each agent independently", async () => {
    const claude = createSource("claude");
    const codex = createSource("codex");
    const save = mock<PromptQueueSaver>(async () => persisted("k", [], 1));
    const stop = startPromptQueuePersistence([claude, codex], {
      debounceMs: 5,
      save,
    });
    try {
      claude.push(SESSION, [{ id: "c1" }]);
      codex.push(SESSION, [{ id: "x1" }]);
      await tick(60);

      expect(save.mock.calls.map((call) => call[0]).sort()).toEqual([
        promptQueueKey("claude", SESSION),
        promptQueueKey("codex", SESSION),
      ].sort());
    } finally {
      stop();
    }
  });

  test("stops mirroring once detached", async () => {
    const source = createSource();
    const save = mock<PromptQueueSaver>(async () => persisted("k", [], 1));
    const stop = startPromptQueuePersistence([source], { debounceMs: 5, save });
    stop();

    source.push(SESSION, [{ id: "m1" }]);
    await tick(50);

    expect(save).not.toHaveBeenCalled();
  });
});
