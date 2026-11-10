import { describe, expect, mock, test } from "bun:test";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import {
  NativeAgentLaunchActivityReconciler,
  type NativeAgentLaunchActivityReconcilerHost,
} from "./native-agent-launch-activity-reconciler.js";
import { NativeAgentObservationBroker } from "./native-agent-observation.js";
import type { ProviderRegistry } from "./native-agent-provider-registry.js";
import {
  nativeAgentSessionStorageKey,
  type CommandInvoker,
  type Environment,
  type StorageService,
} from "./native-agent-service-shared.js";
import type { NativeAgentTurnRecovery } from "./native-agent-turn-recovery.js";
import { deepFreeze } from "./storage-frozen-snapshot.js";

function frozenCopy<T>(items: T[]): T[] {
  return [...deepFreeze(structuredClone(items))];
}

const sessionKey = nativeAgentSessionStorageKey("env-1", "codex", "env-env-1:tab-1");

function harness(
  overrides: {
    environments?: () => Promise<Partial<Environment>[]>;
    sessions?: () => Promise<unknown[]>;
    stopped?: () => boolean;
    cachedEnvironmentIds?: () => string[];
  } = {},
) {
  const loadEnvironments = mock(overrides.environments ?? (async () => []));
  const listNativeAgentSessions = overrides.sessions ?? (async () => []);
  const prune = mock(async () => undefined);
  const scans: Promise<void>[] = [];
  const host: NativeAgentLaunchActivityReconcilerHost = {
    storage: {
      loadEnvironments,
      listNativeAgentSessions,
      // Frozen as storage freezes the shared snapshots, so a sweep that writes
      // to a record it only read fails here.
      readEnvironmentsSnapshot: async () =>
        frozenCopy(await (overrides.environments ?? (async () => []))()),
      readNativeAgentSessionsSnapshot: async () => frozenCopy(await listNativeAgentSessions()),
    } as unknown as StorageService,
    invoke: (async () => undefined) as CommandInvoker,
    options: {},
    providerRegistry: {
      prune,
      cachedEnvironmentIds: overrides.cachedEnvironmentIds ?? (() => []),
    } as unknown as ProviderRegistry,
    observations: new NativeAgentObservationBroker(() => Date.now()),
    turnRecovery: {} as NativeAgentTurnRecovery,
    now: () => Date.now(),
    isStopped: overrides.stopped ?? (() => false),
    observeProvider: async () => undefined,
    trackScan: (task) => {
      scans.push(task);
      return task;
    },
    recordAsyncQuestionAttention: async () => undefined,
    withdrawEnvironmentInteractions: () => undefined,
    dispatchPrompt: mock(async () => {
      throw new Error("unexpected dispatch");
    }),
    dispatchPromptWithPreparation: mock(async () => {
      throw new Error("unexpected dispatch");
    }),
  };
  return {
    reconciler: new NativeAgentLaunchActivityReconciler(host),
    loadEnvironments,
    prune,
    scans,
  };
}

describe("NativeAgentLaunchActivityReconciler observed activity", () => {
  test("recorded edges answer the session and turn snapshots", () => {
    const { reconciler } = harness();
    expect(reconciler.sessionActivitySnapshot("env-1", "codex", "env-env-1:tab-1")).toBe("unknown");

    reconciler.recordObservedActivity(sessionKey, {
      providerSessionId: "provider-session",
      state: "working",
    });
    expect(reconciler.observedActivity(sessionKey)?.state).toBe("working");
    expect(reconciler.sessionActivitySnapshot("env-1", "codex", "env-env-1:tab-1")).toBe("working");
    expect(reconciler.sessionTurnActivitySnapshot("env-1", "codex", "env-env-1:tab-1")).toBe(
      "working",
    );
  });

  test("background work that left the composer free reads as an idle turn", () => {
    const { reconciler } = harness();
    reconciler.recordObservedActivity(sessionKey, {
      providerSessionId: "provider-session",
      state: "working",
      readyForInput: true,
    });
    expect(reconciler.sessionActivitySnapshot("env-1", "codex", "env-env-1:tab-1")).toBe("working");
    expect(reconciler.sessionTurnActivitySnapshot("env-1", "codex", "env-env-1:tab-1")).toBe(
      "idle",
    );
  });

  test("only a fresh provider-confirmed observation marks a queue's session busy", () => {
    const { reconciler } = harness();
    expect(reconciler.queueSessionObservedBusy("env-1", "codex", "env-env-1:tab-1", {})).toBe(
      false,
    );
    // A dispatch's own acceptance edge is not evidence the turn still runs.
    reconciler.recordObservedActivity(sessionKey, {
      providerSessionId: "provider-session",
      state: "working",
    });
    expect(reconciler.queueSessionObservedBusy("env-1", "codex", "env-env-1:tab-1", {})).toBe(
      false,
    );
  });

  test("forgetting a provider group drops its activity back-off", () => {
    const { reconciler } = harness();
    const state = reconciler.forTesting();
    state.activityRetryAt.set("group", 1);
    state.activityAttempts.set("group", 3);
    reconciler.forgetActivityGroup("group");
    expect(state.activityRetryAt.has("group")).toBe(false);
    expect(state.activityAttempts.has("group")).toBe(false);
  });
});

describe("NativeAgentLaunchActivityReconciler launch scans", () => {
  test("a counted scan prunes retired providers and reports environments with an intent", async () => {
    const { reconciler, prune } = harness({
      environments: async () => [
        { id: "env-1", status: "running" },
        { id: "env-2", status: "running", deletionRequestedAt: "2026-10-01T00:00:00.000Z" },
      ],
    });
    await expect(reconciler.countedLaunchScan()).resolves.toBe(0);
    expect(prune).toHaveBeenCalledWith(new Set(["env-1"]));
  });

  test("a cached provider with no environment row is kept only while its runtime may be live", async () => {
    // An unreadable coordinator store proves nothing, so that provider is
    // kept; an ordinary id with no row is not a runtime and is pruned.
    const coordinator = coordinatorRuntimeId("coordinator-1", "conversation-1");
    const { reconciler, prune } = harness({
      environments: async () => [{ id: "env-1", status: "running" }],
      cachedEnvironmentIds: () => ["env-1", "env-gone", coordinator],
    });
    await expect(reconciler.countedLaunchScan()).resolves.toBe(0);
    expect(prune).toHaveBeenCalledWith(new Set(["env-1", coordinator]));
  });

  test("a stopped reconciler never reads storage", async () => {
    const { reconciler, loadEnvironments } = harness({ stopped: () => true });
    await expect(reconciler.countedLaunchScan()).resolves.toBe(0);
    expect(loadEnvironments).not.toHaveBeenCalled();
  });
});

describe("NativeAgentLaunchActivityReconciler activity sweep", () => {
  test("a stopped reconciler starts no sweep", async () => {
    const sessions = mock(async () => []);
    const { reconciler } = harness({ stopped: () => true, sessions });
    await reconciler.reconcileAgentActivity();
    expect(sessions).not.toHaveBeenCalled();
  });
});
