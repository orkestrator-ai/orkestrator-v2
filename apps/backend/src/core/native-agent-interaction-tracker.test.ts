import { describe, expect, mock, test } from "bun:test";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import {
  NativeAgentInteractionTracker,
  type NativeAgentInteractionTrackerHost,
} from "./native-agent-interaction-tracker.js";
import {
  nativeAgentSessionStorageKey,
  type AgentInteractionObservation,
  type NativeAgentRuntimeProvider,
  type NativeAgentServiceOptions,
  type NativeAgentSessionProjection,
  type StorageService,
} from "./native-agent-service-shared.js";

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

function withoutStorage<T extends { storage?: unknown; options?: unknown }>(
  value: T,
): Omit<T, "storage" | "options"> {
  const { storage: _storage, options: _options, ...rest } = value;
  return rest;
}

function harness(
  overrides: Partial<Omit<NativeAgentInteractionTrackerHost, "storage" | "options">> & {
    options?: NativeAgentServiceOptions;
    storage?: Partial<StorageService>;
  } = {},
) {
  let now = 10_000;
  let stopped = false;
  const observed: AgentInteractionObservation[] = [];
  const options: NativeAgentServiceOptions = {
    interactionMonitorMode: "observe-only",
    onInteractionObservation: (observation) => {
      observed.push({ ...observation });
    },
    ...overrides.options,
  };
  const host: NativeAgentInteractionTrackerHost = {
    storage: {
      getNativeAgentSession: async (key: string) =>
        key === sessionKey ? { key, providerSessionId: "provider-session" } : null,
      loadEnvironments: async () => [],
      listNativeAgentSessions: async () => [],
      listAllBuildPipelines: async () => [],
      ...overrides.storage,
    } as unknown as StorageService,
    options,
    evictProvider: () => undefined,
    now: () => now,
    isStopped: () => stopped,
    observeProvider: async () => undefined,
    trackScan: (task) => task,
    cachedProjectionSnapshot: () => null,
    ...withoutStorage(overrides),
  };
  const tracker = new NativeAgentInteractionTracker(host);
  return {
    tracker,
    observed,
    advance: (ms: number) => {
      now += ms;
    },
    stop: () => {
      stopped = true;
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

describe("NativeAgentInteractionTracker lifecycle", () => {
  test("start sweeps once and arms a timer only in observe-only mode; stop clears it", async () => {
    const listNativeAgentSessions = mock(async () => []);
    const { tracker } = harness({ storage: { listNativeAgentSessions } });
    await tracker.start();
    expect(listNativeAgentSessions).toHaveBeenCalled();
    expect(tracker.forTesting().interactionTimer()).not.toBeNull();
    tracker.stop();
    expect(tracker.forTesting().interactionTimer()).toBeNull();

    const disabled = harness({ options: { interactionMonitorMode: "disabled" } });
    await disabled.tracker.start();
    expect(disabled.tracker.forTesting().interactionTimer()).toBeNull();
  });

  test("the adoption kill switch follows the option and can be flipped at runtime", () => {
    const off = harness({ options: { interactionMonitorAdoptionEnabled: false } });
    expect(off.tracker.forTesting().interactionMonitorAdoptionEnabled()).toBe(false);
    off.tracker.setInteractionMonitorAdoptionEnabled(true);
    expect(off.tracker.forTesting().interactionMonitorAdoptionEnabled()).toBe(true);
  });
});
