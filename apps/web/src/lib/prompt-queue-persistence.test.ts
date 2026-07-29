import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyPromptQueueSnapshot,
  claimPromptQueueHead,
  hydratePromptQueue,
  hydratePromptQueuesForEnvironment,
  parsePromptQueueKey,
  promptQueueKey,
  resetPromptQueueRevisions,
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

function createSource(
  agent = "claude",
  environmentIdFor: (sessionKey: string) => string | null = () => "env-1",
): PromptQueueSource & {
  read: () => QueuedItem[];
} {
  let queues = new Map<string, QueuedItem[]>();
  return {
    agent,
    getQueues: () => queues,
    setQueue: (sessionKey, messages) => {
      queues = new Map(queues);
      queues.set(sessionKey, messages);
    },
    environmentIdFor,
    read: () => queues.get(SESSION) ?? [],
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
        [
          { id: "replacement" },
          null,
          "bad",
          { missingId: true },
        ] as unknown as QueuedItem[],
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
    await hydratePromptQueuesForEnvironment(
      "env-1",
      [claude, codex],
      async () => [
        persisted(promptQueueKey("claude", SESSION), [{ id: "c1" }], 1),
        persisted(promptQueueKey("codex", SESSION), [{ id: "x1" }], 1),
      ],
    );
    expect(claude.read()).toEqual([{ id: "c1" }]);
    expect(codex.read()).toEqual([{ id: "x1" }]);
  });

  test("filters unrelated, malformed, and unknown-agent environment entries", async () => {
    const source = createSource();
    await hydratePromptQueuesForEnvironment(
      "env-1",
      [source],
      async () => [
        persisted(promptQueueKey("claude", SESSION), [{ id: "valid" }], 1),
        persisted(promptQueueKey("claude", "other"), [{ id: "other-env" }], 1, "env-2"),
        persisted(promptQueueKey("unknown", SESSION), [{ id: "unknown" }], 1),
        persisted("malformed", [{ id: "malformed" }], 1),
      ],
    );
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
    await hydratePromptQueue(
      promptQueueKey("claude", SESSION),
      [source],
      async () => null,
    );
    expect(source.read()).toEqual([]);
  });

  test("hydrates one matching queue and ignores malformed or unknown queue keys", async () => {
    const source = createSource();
    const key = promptQueueKey("claude", SESSION);
    await hydratePromptQueue(key, [source], async () =>
      persisted(key, [{ id: "restored" }], 1)
    );
    expect(source.read()).toEqual([{ id: "restored" }]);

    await hydratePromptQueue("malformed", [source], async () => {
      throw new Error("loader must not run");
    });
    await hydratePromptQueue(
      promptQueueKey("codex", SESSION),
      [source],
      async () => {
        throw new Error("loader must not run");
      },
    );
    expect(source.read()).toEqual([{ id: "restored" }]);
  });

  test("does not claim an unscoped or empty projection", async () => {
    const unscoped = createSource("claude", () => null);
    const empty = createSource();
    let calls = 0;
    const claim = async () => {
      calls += 1;
      return { claimed: null, claimToken: null, queue: null };
    };
    await expect(claimPromptQueueHead(unscoped, SESSION, claim)).resolves.toBeNull();
    await expect(claimPromptQueueHead(empty, SESSION, claim)).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  test("clears a ghost projection when a claim reports no backend queue", async () => {
    const source = createSource();
    source.setQueue(SESSION, [{ id: "ghost" }]);
    await expect(
      claimPromptQueueHead(source, SESSION, async () => ({
        claimed: null,
        claimToken: null,
        queue: null,
      })),
    ).resolves.toBeNull();
    expect(source.read()).toEqual([]);
  });

  test("rejects malformed or mismatched claimed messages while applying the snapshot", async () => {
    for (const claimed of [null, "bad", { id: "different" }, { id: 7 }]) {
      const source = createSource();
      source.setQueue(SESSION, [{ id: "expected" }]);
      await expect(
        claimPromptQueueHead(source, SESSION, async (key, environmentId) => ({
          claimed: claimed as QueuedItem | null,
          claimToken: claimed ? "claim-token" : null,
          queue: persisted(key, [], 2, environmentId),
        })),
      ).resolves.toBeNull();
      expect(source.read()).toEqual([]);
    }
  });

  test("allows only one of two clients to claim an authoritative head", async () => {
    const first = createSource();
    const second = createSource();
    first.setQueue(SESSION, [{ id: "m1" }, { id: "m2" }]);
    second.setQueue(SESSION, [{ id: "m1" }, { id: "m2" }]);

    let backendQueue: QueuedItem[] = [{ id: "m1" }, { id: "m2" }];
    let revision = 1;
    const claim = async (
      key: string,
      environmentId: string,
      expectedId: string,
    ) => {
      const head = backendQueue[0];
      if (!head || head.id !== expectedId) {
        return {
          claimed: null,
          claimToken: null,
          queue: persisted(key, backendQueue, revision, environmentId),
        };
      }
      backendQueue = backendQueue.slice(1);
      revision += 1;
      return {
        claimed: head,
        claimToken: `claim-${head.id}`,
        queue: persisted(key, backendQueue, revision, environmentId),
      };
    };

    const [winner, loser] = await Promise.all([
      claimPromptQueueHead(first, SESSION, claim),
      claimPromptQueueHead(second, SESSION, claim),
    ]);
    expect(winner).toEqual({
      entry: { id: "m1" },
      claimToken: "claim-m1",
    });
    expect(loser).toBeNull();
    expect(first.read()).toEqual([{ id: "m2" }]);
    expect(second.read()).toEqual([{ id: "m2" }]);
  });
});
