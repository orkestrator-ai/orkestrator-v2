import { describe, expect, mock, test } from "bun:test";
import {
  NativeAgentLaunchActivityReconciler,
  type NativeAgentLaunchActivityReconcilerHost,
} from "./native-agent-launch-activity-reconciler.js";
import { NativeAgentObservationBroker } from "./native-agent-observation.js";
import { waitForCondition } from "./native-agent-service-projection-test-support.js";
import type { ProviderRegistry } from "./native-agent-provider-registry.js";
import {
  nativeAgentSessionStorageKey,
  type CommandInvoker,
  type Environment,
  type StorageService,
} from "./native-agent-service-shared.js";
import type { NativeAgentTurnRecovery } from "./native-agent-turn-recovery.js";

const sessionKey = nativeAgentSessionStorageKey("env-1", "codex", "env-env-1:tab-1");

function harness(
  overrides: {
    environments?: () => Promise<Partial<Environment>[]>;
    sessions?: () => Promise<unknown[]>;
    stopped?: () => boolean;
  } = {},
) {
  const loadEnvironments = mock(overrides.environments ?? (async () => []));
  const prune = mock(async () => undefined);
  const scans: Promise<void>[] = [];
  const host: NativeAgentLaunchActivityReconcilerHost = {
    storage: {
      loadEnvironments,
      listNativeAgentSessions: overrides.sessions ?? (async () => []),
    } as unknown as StorageService,
    invoke: (async () => undefined) as CommandInvoker,
    options: {},
    providerRegistry: { prune } as unknown as ProviderRegistry,
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

  test("a stopped reconciler never reads storage", async () => {
    const { reconciler, loadEnvironments } = harness({ stopped: () => true });
    await expect(reconciler.countedLaunchScan()).resolves.toBe(0);
    expect(loadEnvironments).not.toHaveBeenCalled();
  });

  test("the rollback timer runs the launch scan and the queue scan until stopped", async () => {
    const { reconciler, loadEnvironments } = harness();
    const queueScan = mock(async () => undefined);
    reconciler.startTimer(20, queueScan);
    expect(reconciler.forTesting().launchTimer()).not.toBeNull();
    await waitForCondition(
      () => loadEnvironments.mock.calls.length >= 2 && queueScan.mock.calls.length >= 2,
    );
    reconciler.stopTimer();
    expect(reconciler.forTesting().launchTimer()).toBeNull();
    expect(loadEnvironments.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(queueScan.mock.calls.length).toBeGreaterThanOrEqual(2);
    const calls = queueScan.mock.calls.length;
    await Bun.sleep(50);
    expect(queueScan.mock.calls.length).toBe(calls);
    expect(reconciler.pendingLaunchTasks()).toEqual([]);
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
