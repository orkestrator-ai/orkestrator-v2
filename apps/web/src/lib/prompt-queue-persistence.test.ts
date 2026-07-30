import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  claimPromptQueueHead,
  getPromptQueueDispatchError,
  hydratePromptQueue,
  hydratePromptQueuesForEnvironment,
  parsePromptQueueKey,
  promptQueueKey,
  resetPromptQueueRevisions,
  retryPromptQueueDispatch,
  startPromptQueuePersistence,
  subscribePromptQueueDispatchErrors,
  type PromptQueueClaimer,
  type PromptQueueDispatchError,
  type PromptQueueLoader,
  type PromptQueueRetrier,
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

function dispatchError(
  message = "Rejected",
  messageId = "m1",
): PromptQueueDispatchError {
  return {
    requestId: messageId,
    messageId,
    messageFingerprint: "a".repeat(64),
    message,
    failedAt: "2026-01-01T00:00:00.000Z",
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

  test("ignores malformed lists, foreign environments, and malformed keys", async () => {
    const source = createSource();
    await hydratePromptQueuesForEnvironment(
      "env-1",
      [source],
      async () => "not-an-array" as unknown as Array<PersistedPromptQueue<QueuedItem>>,
    );
    await hydratePromptQueuesForEnvironment("env-1", [source], async () => [
      persisted(promptQueueKey("claude", SESSION), [{ id: "foreign" }], 1, "env-2"),
      persisted("missing-separator", [{ id: "malformed" }], 1),
    ]);

    expect(source.size()).toBe(0);
  });
});

/**
 * Every committed write is announced to every client including the one that
 * made it, so a client hears its own queue write back. Re-applying that echo
 * over a queue the user has added to since would silently destroy a prompt they
 * had already committed to sending.
 */
describe("self-echo", () => {
  const KEY = promptQueueKey("claude", SESSION);

  /** Mirrors a queue to the backend and returns the revision it landed at. */
  async function writeThrough(
    source: ReturnType<typeof createSource>,
    messages: QueuedItem[],
    revision: number,
  ): Promise<void> {
    const save = mock<PromptQueueSaver>(async () => persisted(KEY, messages, revision));
    const detach = startPromptQueuePersistence([source], { debounceMs: 1, save });
    source.push(SESSION, messages);
    await tick(20);
    detach();
    await tick(5);
  }

  test("keeps a prompt queued after the write was issued", async () => {
    const source = createSource();
    await writeThrough(source, [{ id: "A" }], 1);
    // The user queues another prompt while the announcement is still in flight.
    source.push(SESSION, [{ id: "A" }, { id: "B" }]);

    await hydratePromptQueuesForEnvironment("env-1", [source], async () => [
      persisted(KEY, [{ id: "A" }], 1),
    ]);

    expect(source.read(SESSION)).toEqual([{ id: "A" }, { id: "B" }]);
  });

  test("keeps a prompt queued when the echo arrives through the single-queue path", async () => {
    const source = createSource();
    await writeThrough(source, [{ id: "A" }], 1);
    source.push(SESSION, [{ id: "A" }, { id: "B" }]);

    await hydratePromptQueue(KEY, [source], async () => persisted(KEY, [{ id: "A" }], 1));

    expect(source.read(SESSION)).toEqual([{ id: "A" }, { id: "B" }]);
  });

  test("still adopts a strictly newer revision from another client", async () => {
    // Another client taking the head is the one case where losing the local
    // edit is correct: adopting is the only outcome that cannot double-dispatch.
    const source = createSource();
    await writeThrough(source, [{ id: "A" }], 1);
    source.push(SESSION, [{ id: "A" }, { id: "B" }]);

    await hydratePromptQueuesForEnvironment("env-1", [source], async () => [
      persisted(KEY, [{ id: "C" }], 2),
    ]);

    expect(source.read(SESSION)).toEqual([{ id: "C" }]);
  });

  test("re-applies an echo when the local queue matches what was written", async () => {
    // With no unflushed edit there is nothing to protect, so the guard must not
    // block ordinary convergence.
    const source = createSource();
    await writeThrough(source, [{ id: "A" }], 1);

    await hydratePromptQueuesForEnvironment("env-1", [source], async () => [
      persisted(KEY, [{ id: "A" }], 1),
    ]);

    expect(source.read(SESSION)).toEqual([{ id: "A" }]);
  });

  test("applies a first hydration even though nothing has been written yet", async () => {
    const source = createSource();
    source.push(SESSION, [{ id: "local-only" }]);

    await hydratePromptQueuesForEnvironment("env-1", [source], async () => [
      persisted(KEY, [{ id: "from-backend" }], 1),
    ]);

    expect(source.read(SESSION)).toEqual([{ id: "from-backend" }]);
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

  test("does not load a single queue for an unknown agent", async () => {
    const source = createSource("claude");
    const load = mock<PromptQueueLoader>(async () =>
      persisted(promptQueueKey("codex", SESSION), [{ id: "m1" }], 1));

    await hydratePromptQueue(promptQueueKey("codex", SESSION), [source], load);

    expect(load).not.toHaveBeenCalled();
    expect(source.size()).toBe(0);
  });
});

describe("claimPromptQueueHead", () => {
  test("allows only one of two clients to claim the same head", async () => {
    const first = createSource();
    const second = createSource();
    const initial = [{ id: "m1" }, { id: "m2" }];
    first.push(SESSION, initial);
    second.push(SESSION, initial);

    let backendQueue = [...initial];
    let revision = 0;
    const claim = (async (
      queueKey: string,
      environmentId: string,
      expectedMessageId: string,
      candidateMessages: QueuedItem[],
    ) => {
      if (revision === 0) backendQueue = [...candidateMessages];
      const head = backendQueue[0];
      if (!head || head.id !== expectedMessageId) {
        return {
          claimed: null,
          queue: persisted(queueKey, backendQueue, revision, environmentId),
        };
      }
      backendQueue = backendQueue.slice(1);
      revision += 1;
      return {
        claimed: head,
        queue: persisted(queueKey, backendQueue, revision, environmentId),
      };
    }) as unknown as PromptQueueClaimer;

    const [winner, loser] = await Promise.all([
      claimPromptQueueHead(first, SESSION, claim),
      claimPromptQueueHead(second, SESSION, claim),
    ]);

    expect(winner).toEqual({ id: "m1" });
    expect(loser).toBeNull();
    expect(first.read(SESSION)).toEqual([{ id: "m2" }]);
    expect(second.read(SESSION)).toEqual([{ id: "m2" }]);
  });

  test("clears a local ghost queue when the backend refuses a missing queue", async () => {
    const source = createSource();
    source.push(SESSION, [{ id: "m1" }]);

    const claimed = await claimPromptQueueHead(
      source,
      SESSION,
      async () => ({ claimed: null, queue: null }),
    );

    expect(claimed).toBeNull();
    expect(source.read(SESSION)).toEqual([]);
  });
});

/**
 * The module-level latch contract. `usePromptQueueDispatchRecovery` consumes this
 * through `useSyncExternalStore`, so the notify/de-dupe behaviour is asserted here
 * against the exported subscription rather than through a rendered tab.
 */
describe("subscribePromptQueueDispatchErrors", () => {
  const KEY = promptQueueKey("claude", SESSION);

  /** Publishes one backend record; each call must carry a newer revision. */
  async function publish(
    source: PromptQueueSource,
    revision: number,
    error: PromptQueueDispatchError | undefined,
  ): Promise<void> {
    await hydratePromptQueue(KEY, [source], async () => ({
      ...persisted(KEY, [{ id: "m1" }], revision),
      ...(error ? { dispatchError: error } : {}),
    }));
  }

  test("notifies every listener when a queue parks and again when it clears", async () => {
    const source = createSource();
    let first = 0;
    let second = 0;
    const detachFirst = subscribePromptQueueDispatchErrors(() => { first += 1; });
    const detachSecond = subscribePromptQueueDispatchErrors(() => { second += 1; });
    try {
      await publish(source, 1, dispatchError("Provider rejected this prompt."));
      expect(first).toBe(1);
      expect(second).toBe(1);
      expect(getPromptQueueDispatchError(KEY)?.message)
        .toBe("Provider rejected this prompt.");

      await publish(source, 2, undefined);
      expect(first).toBe(2);
      expect(getPromptQueueDispatchError(KEY)).toBeUndefined();
    } finally {
      detachFirst();
      detachSecond();
    }
  });

  test("does not notify when an equal error is republished", async () => {
    // A re-announced identical latch must leave the snapshot untouched, or a
    // useSyncExternalStore consumer re-renders forever.
    const source = createSource();
    let notifications = 0;
    const detach = subscribePromptQueueDispatchErrors(() => { notifications += 1; });
    try {
      await publish(source, 1, dispatchError("Provider rejected this prompt."));
      expect(notifications).toBe(1);

      await publish(source, 2, dispatchError("Provider rejected this prompt."));
      expect(notifications).toBe(1);

      // A genuinely different failure for the same queue must still get through.
      await publish(source, 3, dispatchError("Agent session is gone."));
      expect(notifications).toBe(2);
    } finally {
      detach();
    }
  });

  test("stops notifying once the returned unsubscribe runs", async () => {
    const source = createSource();
    let notifications = 0;
    const detach = subscribePromptQueueDispatchErrors(() => { notifications += 1; });
    await publish(source, 1, dispatchError("Provider rejected this prompt."));
    expect(notifications).toBe(1);

    detach();
    await publish(source, 2, dispatchError("Agent session is gone."));

    expect(notifications).toBe(1);
    // The latch itself still advanced; only the notification was withdrawn.
    expect(getPromptQueueDispatchError(KEY)?.message).toBe("Agent session is gone.");
  });
});

describe("retryPromptQueueDispatch", () => {
  test("clears the visible error and applies the authoritative retry revision", async () => {
    const source = createSource();
    const key = promptQueueKey("claude", SESSION);
    const dispatchError = {
      requestId: "m1",
      messageId: "m1",
      messageFingerprint: "a".repeat(64),
      message: "Rejected",
      failedAt: "2026-01-01T00:00:00.000Z",
    };
    await hydratePromptQueue(key, [source], async () => ({
      ...persisted(key, [{ id: "m1" }], 2),
      dispatchError,
    }));
    expect(getPromptQueueDispatchError(key)).toEqual(dispatchError);

    const retry = mock(async () => persisted(key, [{ id: "m1" }], 3));
    await retryPromptQueueDispatch(source, SESSION, retry);

    expect(retry).toHaveBeenCalledWith(key);
    expect(getPromptQueueDispatchError(key)).toBeUndefined();
    expect(source.read(SESSION)).toEqual([{ id: "m1" }]);
  });

  test("clears a queue whose backend record disappeared before the retry", async () => {
    const source = createSource();
    const key = promptQueueKey("claude", SESSION);
    await hydratePromptQueue(key, [source], async () => ({
      ...persisted(key, [{ id: "m1" }], 2),
      dispatchError: dispatchError(),
    }));
    expect(getPromptQueueDispatchError(key)).toBeDefined();

    const retry = mock<PromptQueueRetrier>(async () => null);
    await retryPromptQueueDispatch(source, SESSION, retry);

    // Nothing authoritative is left to retry, so keeping the local head would
    // leave a parked prompt that no backend record can ever drain or unpark.
    expect(source.read(SESSION)).toEqual([]);
    expect(getPromptQueueDispatchError(key)).toBeUndefined();
  });

  test("adopts the retry response even when it lands at an unchanged revision", async () => {
    const source = createSource();
    const key = promptQueueKey("claude", SESSION);
    await hydratePromptQueue(key, [source], async () => ({
      ...persisted(key, [{ id: "m1" }], 2),
      dispatchError: dispatchError(),
    }));
    // The user queues another prompt while looking at the parked head, so the
    // self-echo guard would otherwise refuse this equal revision.
    source.push(SESSION, [{ id: "m1" }, { id: "m2" }]);

    const retry = mock<PromptQueueRetrier>(async () => persisted(key, [{ id: "m1" }], 2));
    await retryPromptQueueDispatch(source, SESSION, retry);

    // The retry response is the state the user explicitly asked for. Discarding
    // it because the backend cleared the latch in place would leave the error
    // visible with no way left to dismiss it.
    expect(getPromptQueueDispatchError(key)).toBeUndefined();
    expect(source.read(SESSION)).toEqual([{ id: "m1" }]);
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

  test("latches a dispatch error the mirror write brings back", async () => {
    // The backend can refuse to drain the head it was just handed, and the
    // write response is the first place this client hears about it.
    const source = createSource();
    const key = promptQueueKey("claude", SESSION);
    const parked = dispatchError("Agent session is gone.");
    const save = mock<PromptQueueSaver>(async (queueKey, environment, messages) => ({
      ...persisted(queueKey, messages, 1, environment),
      dispatchError: parked,
    }));
    let notifications = 0;
    const detach = subscribePromptQueueDispatchErrors(() => { notifications += 1; });
    const stop = startPromptQueuePersistence([source], { debounceMs: 5, save });
    try {
      source.push(SESSION, [{ id: "m1" }]);
      await tick(50);

      expect(getPromptQueueDispatchError(key)).toEqual(parked);
      expect(notifications).toBe(1);
    } finally {
      detach();
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

  test("retries a transient save failure without another store mutation", async () => {
    const source = createSource();
    let attempts = 0;
    const save = mock<PromptQueueSaver>(async (_key, _environment, messages) => {
      attempts += 1;
      if (attempts === 1) throw new Error("backend temporarily unavailable");
      return persisted(promptQueueKey("claude", SESSION), messages, 1);
    });
    const stop = startPromptQueuePersistence([source], { debounceMs: 1, save });
    try {
      source.push(SESSION, [{ id: "m1" }]);
      await tick(180);

      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[1]?.[2]).toEqual([{ id: "m1" }]);
    } finally {
      stop();
    }
  });

  test("retries when a revision conflict cannot load an authoritative winner", async () => {
    const source = createSource();
    let attempts = 0;
    const save = mock<PromptQueueSaver>(async (_key, _environment, messages) => {
      attempts += 1;
      if (attempts === 1) throw new Error("Prompt queue revision conflict");
      return persisted(promptQueueKey("claude", SESSION), messages, 2);
    });
    const load = mock<PromptQueueLoader>(async () => null);
    const stop = startPromptQueuePersistence([source], {
      debounceMs: 1,
      save,
      load,
    });
    try {
      source.push(SESSION, [{ id: "m1" }]);
      await tick(180);

      expect(load).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  test("serializes writes for one queue while preserving the newest state", async () => {
    const source = createSource();
    let releaseFirst: () => void = () => {};
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });
    let callCount = 0;
    const save = mock<PromptQueueSaver>(async (key, environment, messages) => {
      const call = ++callCount;
      if (call === 1) await firstPending;
      return persisted(key, messages, call, environment);
    });
    const stop = startPromptQueuePersistence([source], { debounceMs: 1, save });
    try {
      source.push(SESSION, [{ id: "m1" }]);
      await tick(20);
      source.push(SESSION, [{ id: "m1" }, { id: "m2" }]);
      await tick(20);

      expect(save).toHaveBeenCalledTimes(1);
      releaseFirst();
      await tick(30);
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[1]?.[2]).toEqual([{ id: "m1" }, { id: "m2" }]);
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

  test("flushes a pending debounced write on pagehide", async () => {
    const source = createSource();
    const save = mock<PromptQueueSaver>(async (key, environment, messages) =>
      persisted(key, messages, 1, environment));
    const stop = startPromptQueuePersistence([source], {
      debounceMs: 10_000,
      save,
    });
    try {
      source.push(SESSION, [{ id: "m1" }]);
      window.dispatchEvent(new Event("pagehide"));
      await tick(20);

      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  test("flushes a pending debounced write when detached", async () => {
    const source = createSource();
    const save = mock<PromptQueueSaver>(async (key, environment, messages) =>
      persisted(key, messages, 1, environment));
    const stop = startPromptQueuePersistence([source], {
      debounceMs: 10_000,
      save,
    });
    source.push(SESSION, [{ id: "m1" }]);

    stop();
    await tick(20);

    expect(save).toHaveBeenCalledTimes(1);
  });
});
