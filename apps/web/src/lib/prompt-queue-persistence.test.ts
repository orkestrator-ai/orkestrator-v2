import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  applyPromptQueueSnapshot,
  getPromptQueueDispatchError,
  hydratePromptQueue,
  hydratePromptQueuesForEnvironment,
  parsePromptQueueKey,
  promptQueueKey,
  resetPromptQueueRevisions,
  retryPromptQueueDispatch,
  subscribePromptQueueDispatchErrors,
  type PromptQueueDispatchError,
  type PromptQueueRetrier,
  type PromptQueueSource,
  type QueuedItem,
} from "./prompt-queue-persistence";
import type { PersistedPromptQueue } from "@/types";

const SESSION = "env-env-1:tab-1";

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
    revision,
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function dispatchError(message = "Rejected", messageId = "m1"): PromptQueueDispatchError {
  return {
    requestId: messageId,
    messageId,
    messageFingerprint: "a".repeat(64),
    message,
    failedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createSource(
  agent = "claude",
  environmentIdFor: (sessionKey: string) => string | null = () => "env-1",
): PromptQueueSource & {
  read: (sessionKey?: string) => QueuedItem[];
  push: (sessionKey: string, messages: QueuedItem[]) => void;
} {
  let queues = new Map<string, QueuedItem[]>();
  const replace = (sessionKey: string, messages: QueuedItem[]) => {
    queues = new Map(queues);
    queues.set(sessionKey, messages);
  };
  return {
    agent,
    getQueues: () => queues,
    setQueue: replace,
    push: replace,
    environmentIdFor,
    read: (sessionKey = SESSION) => queues.get(sessionKey) ?? [],
  };
}

beforeEach(resetPromptQueueRevisions);

describe("backend-owned prompt queue projections", () => {
  test("round-trips composite queue keys", () => {
    expect(parsePromptQueueKey(promptQueueKey("claude", SESSION))).toEqual({
      agent: "claude",
      sessionKey: SESSION,
    });
  });

  test("rejects malformed composite queue keys", () => {
    expect(parsePromptQueueKey("")).toBeNull();
    expect(parsePromptQueueKey("claude")).toBeNull();
    expect(parsePromptQueueKey("\u0000session")).toBeNull();
  });

  test("never lets an older backend response overwrite a newer snapshot", () => {
    const source = createSource();
    const key = promptQueueKey("claude", SESSION);
    applyPromptQueueSnapshot(source, persisted(key, [{ id: "new" }], 3));
    applyPromptQueueSnapshot(source, persisted(key, [{ id: "old" }], 2));
    expect(source.read()).toEqual([{ id: "new" }]);
  });

  test("accepts an equal-revision reconciliation and filters malformed messages", () => {
    const source = createSource();
    const key = promptQueueKey("claude", SESSION);
    applyPromptQueueSnapshot(source, persisted(key, [{ id: "first" }], 3));
    applyPromptQueueSnapshot(
      source,
      persisted(
        key,
        [{ id: "replacement" }, null, "bad", { missingId: true }] as unknown as QueuedItem[],
        3,
      ),
    );
    expect(source.read()).toEqual([{ id: "replacement" }]);
  });

  test("ignores malformed and wrong-agent snapshots", () => {
    const source = createSource();
    source.setQueue(SESSION, [{ id: "current" }]);
    applyPromptQueueSnapshot(source, persisted("malformed", [{ id: "bad" }], 2));
    applyPromptQueueSnapshot(
      source,
      persisted(promptQueueKey("codex", SESSION), [{ id: "bad" }], 3),
    );
    expect(source.read()).toEqual([{ id: "current" }]);
  });

  test("hydrates all queues for an environment", async () => {
    const claude = createSource("claude");
    const codex = createSource("codex");
    await hydratePromptQueuesForEnvironment("env-1", [claude, codex], async () => [
      persisted(promptQueueKey("claude", SESSION), [{ id: "c1" }], 1),
      persisted(promptQueueKey("codex", SESSION), [{ id: "x1" }], 1),
    ]);
    expect(claude.read()).toEqual([{ id: "c1" }]);
    expect(codex.read()).toEqual([{ id: "x1" }]);
  });

  test("filters unrelated, malformed, and unknown-agent environment entries", async () => {
    const source = createSource();
    await hydratePromptQueuesForEnvironment("env-1", [source], async () => [
      persisted(promptQueueKey("claude", SESSION), [{ id: "valid" }], 1),
      persisted(promptQueueKey("claude", "other"), [{ id: "other-env" }], 1, "env-2"),
      persisted(promptQueueKey("unknown", SESSION), [{ id: "unknown" }], 1),
      persisted("malformed", [{ id: "malformed" }], 1),
    ]);
    expect(source.read()).toEqual([{ id: "valid" }]);
  });

  test("ignores a malformed environment-list response", async () => {
    const source = createSource();
    source.setQueue(SESSION, [{ id: "current" }]);
    await hydratePromptQueuesForEnvironment(
      "env-1",
      [source],
      async () => "bad" as unknown as PersistedPromptQueue<QueuedItem>[],
    );
    expect(source.read()).toEqual([{ id: "current" }]);
  });

  test("clears the projection when the backend record is gone", async () => {
    const source = createSource();
    source.setQueue(SESSION, [{ id: "ghost" }]);
    await hydratePromptQueue(promptQueueKey("claude", SESSION), [source], async () => null);
    expect(source.read()).toEqual([]);
  });

  test("hydrates one matching queue and ignores malformed or unknown queue keys", async () => {
    const source = createSource();
    const key = promptQueueKey("claude", SESSION);
    await hydratePromptQueue(key, [source], async () => persisted(key, [{ id: "restored" }], 1));
    expect(source.read()).toEqual([{ id: "restored" }]);

    await hydratePromptQueue("malformed", [source], async () => {
      throw new Error("loader must not run");
    });
    await hydratePromptQueue(promptQueueKey("codex", SESSION), [source], async () => {
      throw new Error("loader must not run");
    });
    expect(source.read()).toEqual([{ id: "restored" }]);
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
    const detachFirst = subscribePromptQueueDispatchErrors(() => {
      first += 1;
    });
    const detachSecond = subscribePromptQueueDispatchErrors(() => {
      second += 1;
    });
    try {
      await publish(source, 1, dispatchError("Provider rejected this prompt."));
      expect(first).toBe(1);
      expect(second).toBe(1);
      expect(getPromptQueueDispatchError(KEY)?.message).toBe("Provider rejected this prompt.");

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
    const detach = subscribePromptQueueDispatchErrors(() => {
      notifications += 1;
    });
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
    const detach = subscribePromptQueueDispatchErrors(() => {
      notifications += 1;
    });
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
