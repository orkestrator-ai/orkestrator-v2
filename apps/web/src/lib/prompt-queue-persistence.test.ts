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

function createSource(agent = "claude"): PromptQueueSource & {
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
    environmentIdFor: () => "env-1",
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

  test("never lets an older backend response overwrite a newer snapshot", () => {
    const source = createSource();
    const key = promptQueueKey("claude", SESSION);
    applyPromptQueueSnapshot(source, persisted(key, [{ id: "new" }], 3));
    applyPromptQueueSnapshot(source, persisted(key, [{ id: "old" }], 2));
    expect(source.read()).toEqual([{ id: "new" }]);
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
          queue: persisted(key, backendQueue, revision, environmentId),
        };
      }
      backendQueue = backendQueue.slice(1);
      revision += 1;
      return {
        claimed: head,
        queue: persisted(key, backendQueue, revision, environmentId),
      };
    };

    const [winner, loser] = await Promise.all([
      claimPromptQueueHead(first, SESSION, claim),
      claimPromptQueueHead(second, SESSION, claim),
    ]);
    expect(winner).toEqual({ id: "m1" });
    expect(loser).toBeNull();
    expect(first.read()).toEqual([{ id: "m2" }]);
    expect(second.read()).toEqual([{ id: "m2" }]);
  });
});
