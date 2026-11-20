import { describe, expect, mock, test } from "bun:test";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import {
  NativeAgentInteractionTracker,
  type NativeAgentInteractionTrackerHost,
} from "./interaction-tracker.js";
import {
  nativeAgentSessionStorageKey,
  type NativeAgentRuntimeProvider,
  type NativeAgentSessionProjection,
  type StorageService,
} from "./service-shared.js";

const identity = {
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "env-env-1:tab-1",
};
const sessionKey = nativeAgentSessionStorageKey(
  identity.environmentId,
  identity.agent,
  identity.logicalSessionKey,
);

function request(id: string, state: AgentInteractionRequest["state"]): AgentInteractionRequest {
  return { id, kind: "question", state } as AgentInteractionRequest;
}

function harness(overrides: Partial<Omit<NativeAgentInteractionTrackerHost, "storage">> = {}) {
  let now = 10_000;
  const storage = {
    getNativeAgentSession: async (key: string) =>
      key === sessionKey ? { key, providerSessionId: "provider-session" } : null,
  } as unknown as StorageService;
  const host: NativeAgentInteractionTrackerHost = {
    storage,
    now: () => now,
    observeProvider: async () => undefined,
    cachedProjectionSnapshot: () => null,
    ...overrides,
  };
  const tracker = new NativeAgentInteractionTracker(host);
  return {
    tracker,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("NativeAgentInteractionTracker pending-interaction reads", () => {
  test("reads the provider once per ten seconds and filters to live requests", async () => {
    const listPendingInteractions = mock(async () => ({
      requests: [request("live", "pending"), request("done", "resolved")],
      revision: 1,
    }));
    const provider = {
      interactions: { listPendingInteractions },
    } as unknown as NativeAgentRuntimeProvider;
    const { tracker, advance } = harness({ observeProvider: async () => provider });

    expect((await tracker.sessionPendingInteractions(identity))?.map(({ id }) => id)).toEqual([
      "live",
    ]);
    await tracker.sessionPendingInteractions(identity);
    expect(listPendingInteractions).toHaveBeenCalledTimes(1);

    tracker.forgetPendingInteractions(sessionKey);
    await tracker.sessionPendingInteractions(identity);
    expect(listPendingInteractions).toHaveBeenCalledTimes(2);

    advance(10_001);
    await tracker.sessionPendingInteractions(identity);
    expect(listPendingInteractions).toHaveBeenCalledTimes(3);
  });

  test("shares a read and fences its response when the session's requests change", async () => {
    const entered = Promise.withResolvers<void>();
    const old = Promise.withResolvers<AgentInteractionRequest[]>();
    let calls = 0;
    const listPendingInteractions = async () => {
      if (++calls === 1) {
        entered.resolve();
        return { requests: await old.promise, revision: 1 };
      }
      return { requests: [request("next-question", "pending")], revision: 2 };
    };
    const provider = {
      interactions: { listPendingInteractions },
    } as unknown as NativeAgentRuntimeProvider;
    const { tracker } = harness({ observeProvider: async () => provider });
    const first = tracker.sessionPendingInteractions(identity);
    const shared = tracker.sessionPendingInteractions(identity);
    await entered.promise;
    expect(calls).toBe(1);
    tracker.forgetPendingInteractions(sessionKey);
    const fresh = await tracker.sessionPendingInteractions(identity);
    expect(fresh?.map(({ id }) => id)).toEqual(["next-question"]);
    old.resolve([request("old-question", "pending")]);
    expect(await first).toBeNull();
    expect(await shared).toBeNull();
    expect(await tracker.sessionPendingInteractions(identity)).toEqual(fresh);
    expect(calls).toBe(2);
  });

  test("falls back to the cached projection when the provider cannot answer", async () => {
    const projection = {
      interactions: [request("from-projection", "answering"), request("old", "expired")],
    } as unknown as NativeAgentSessionProjection;
    const { tracker } = harness({ cachedProjectionSnapshot: () => projection });

    expect((await tracker.sessionPendingInteractions(identity))?.map(({ id }) => id)).toEqual([
      "from-projection",
    ]);
  });

  test("an unknown session has no pending interactions", async () => {
    const { tracker } = harness();
    await expect(
      tracker.sessionPendingInteractions({ ...identity, logicalSessionKey: "missing" }),
    ).resolves.toBeNull();
  });
});
