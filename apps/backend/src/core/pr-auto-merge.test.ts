import { describe, expect, test } from "bun:test";
import type { PrMonitorEnvironmentState, PrMonitorEvent } from "@orkestrator/protocol/pr-monitor";
import {
  decideAutoMerge,
  PR_AUTO_MERGE_RETRY_BASE_MS,
  PR_AUTO_MERGE_RETRY_MAX_MS,
  PrAutoMergeController,
} from "./pr-auto-merge.js";
import type { Environment } from "./models.js";
import { createEnvironment } from "./storage.js";

const PR_URL = "https://github.com/acme/repo/pull/7";

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    ...createEnvironment("project", { name: "feature" }),
    id: "env-1",
    environmentType: "local",
    worktreePath: "/tmp/feature",
    status: "running",
    setupPhase: "ready",
    prUrl: PR_URL,
    prState: "open",
    hasMergeConflicts: false,
    prMergeability: "clean",
    autoMerge: true,
    autoMergePrUrl: PR_URL,
    autoMergeEnabledAt: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  };
}

function monitor(
  env: Environment,
  overrides: Partial<PrMonitorEnvironmentState> = {},
): PrMonitorEnvironmentState {
  return {
    environmentId: env.id,
    mode: "normal",
    checkInProgress: false,
    consecutiveErrors: 0,
    lastCheckAt: new Date().toISOString(),
    lastSuccessfulCheckAt: new Date().toISOString(),
    lastSuccessfulCheckStartedAt: new Date().toISOString(),
    headSha: "a".repeat(40),
    prUrl: env.prUrl,
    prState: env.prState,
    hasMergeConflicts: env.hasMergeConflicts,
    mergeability: env.prMergeability,
    checkSummary: null,
    viewerCanMerge: true,
    ...overrides,
  };
}

describe("decideAutoMerge", () => {
  test("merges a fresh, clean, open PR", () => {
    const env = environment();
    expect(decideAutoMerge(env, monitor(env))).toEqual({ kind: "merge" });
  });

  test("does nothing while auto-merge is off", () => {
    const env = environment({ autoMerge: false });
    expect(decideAutoMerge(env, monitor(env))).toEqual({ kind: "wait", reason: "disabled" });
  });

  test("waits on a stale or missing monitor reading", () => {
    const env = environment();
    expect(decideAutoMerge(env, null)).toEqual({ kind: "wait", reason: "stale" });
    expect(decideAutoMerge(env, monitor(env, { consecutiveErrors: 1 }))).toEqual({
      kind: "wait",
      reason: "stale",
    });
  });

  test("waits while checks are pending or the PR is blocked", () => {
    const env = environment();
    expect(
      decideAutoMerge(env, monitor(env, { checkSummary: { passed: 1, pending: 1, total: 2 } })),
    ).toEqual({ kind: "wait", reason: "checks-pending" });
    const blocked = environment({ prMergeability: "blocked" });
    expect(decideAutoMerge(blocked, monitor(blocked))).toEqual({
      kind: "wait",
      reason: "blocked",
    });
  });

  test("waits while another lifecycle operation owns the environment", () => {
    const env = environment({ lifecycleOperation: "merging" });
    expect(decideAutoMerge(env, monitor(env))).toEqual({ kind: "wait", reason: "busy" });
  });

  test("resolves conflicts once per episode", () => {
    const env = environment({ hasMergeConflicts: true, prMergeability: "dirty" });
    expect(decideAutoMerge(env, monitor(env))).toEqual({ kind: "resolve" });
    const armed = { ...env, prRecheckAfterAgentCompletionArmedAt: "2026-10-31T00:00:00.000Z" };
    expect(decideAutoMerge(armed, monitor(armed))).toEqual({
      kind: "wait",
      reason: "resolve-pending",
    });
  });

  test("waits on a dirty merge state that GitHub has not reported as a conflict", () => {
    const env = environment({ hasMergeConflicts: false, prMergeability: "dirty" });
    expect(decideAutoMerge(env, monitor(env))).toEqual({ kind: "wait", reason: "conflicts" });
  });

  test("ignores a merged PR", () => {
    const env = environment({ prState: "merged" });
    expect(decideAutoMerge(env, monitor(env))).toEqual({ kind: "wait", reason: "not-open" });
  });
});

function harness(initial: Environment) {
  let stored = initial;
  let monitorState: PrMonitorEnvironmentState | null = monitor(initial);
  const listeners = new Set<(event: PrMonitorEvent) => void>();
  const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
  const timers: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  let failNext: Error | null = null;
  let nextStatus: string | null = null;
  const storage = {
    getEnvironment: async (id: string) => (id === stored.id ? stored : null),
    loadEnvironments: async () => [stored],
    updateEnvironment: async (
      _id: string,
      updates: Record<string, unknown>,
      predicate?: (env: Environment) => boolean | Promise<boolean>,
    ) => {
      if (!predicate || (await predicate(stored))) stored = { ...stored, ...updates };
      return stored;
    },
    loadConfig: async () =>
      ({ global: { enabledAgentPlatforms: ["claude"] }, repositories: {} }) as never,
    getRepositoryConfig: async () => ({ prBaseBranch: "develop" }) as never,
  };
  const controller = new PrAutoMergeController({
    storage,
    invoke: async <T>(command: string, args: Record<string, unknown> = {}) => {
      invocations.push({ command, args });
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      const status = nextStatus ?? "accepted";
      nextStatus = null;
      return (command === "launch_native_agent_job" ? { status, error: "agent refused" } : {}) as T;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    monitorState: () => monitorState,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      (timer as { cancelled: boolean }).cancelled = true;
    },
    onWarning: () => undefined,
  });
  return {
    controller,
    storage,
    get stored() {
      return stored;
    },
    setMonitor(state: PrMonitorEnvironmentState | null) {
      monitorState = state;
    },
    invocations,
    timers,
    listeners,
    set(next: Environment) {
      stored = next;
      monitorState = monitor(next);
    },
    nextStatus(status: string) {
      nextStatus = status;
    },
    failNextInvoke(error: Error) {
      failNext = error;
    },
    async announce() {
      const state = monitorState!;
      for (const listener of listeners) listener({ environmentId: stored.id, state });
      await controller.evaluate(stored.id);
    },
  };
}

describe("PrAutoMergeController", () => {
  test("merges a ready PR when the monitor announces it", async () => {
    const h = harness(environment());
    h.controller.start();
    await h.announce();
    expect(h.invocations).toEqual([
      {
        command: "merge_environment_pr",
        args: {
          environmentId: "env-1",
          method: "squash",
          deleteBranch: true,
          cleanupAfterMerge: false,
          expectedHeadSha: "a".repeat(40),
          expectedPrUrl: PR_URL,
        },
      },
    ]);
  });

  test("launches Resolve in the background for a conflicting PR", async () => {
    const h = harness(environment({ hasMergeConflicts: true, prMergeability: "dirty" }));
    await h.controller.evaluate("env-1");
    expect(h.invocations).toHaveLength(1);
    const [launch] = h.invocations;
    expect(launch?.command).toBe("launch_native_agent_job");
    expect(launch?.args).toMatchObject({
      environmentId: "env-1",
      agent: "claude",
      title: "Resolve",
      conversationMode: "build",
      completionAction: "refresh-pr-after-agent-completion",
      activateTab: false,
    });
    expect(String(launch?.args.prompt)).toContain("develop");
  });

  test("does nothing for an environment with auto-merge off", async () => {
    const h = harness(environment({ autoMerge: false }));
    h.controller.start();
    await h.announce();
    expect(h.invocations).toEqual([]);
  });

  test("backs off after a failed merge and retries when the timer fires", async () => {
    const h = harness(environment());
    h.failNextInvoke(new Error("GitHub refused the merge"));
    await h.controller.evaluate("env-1");
    expect(h.invocations).toHaveLength(1);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.delayMs).toBe(PR_AUTO_MERGE_RETRY_BASE_MS);

    // A repeated reading during the back-off does not retry early.
    await h.controller.evaluate("env-1");
    expect(h.invocations).toHaveLength(1);

    h.timers[0]?.callback();
    await h.controller.evaluate("env-1");
    expect(h.invocations).toHaveLength(2);
  });

  test("dispose stops listening and cancels pending retries", async () => {
    const h = harness(environment());
    h.controller.start();
    h.failNextInvoke(new Error("transient"));
    await h.controller.evaluate("env-1");
    h.controller.dispose();
    expect(h.listeners.size).toBe(0);
    expect(h.timers[0]?.cancelled).toBe(true);
    await h.controller.evaluate("env-1");
    expect(h.invocations).toHaveLength(1);
  });
});

for (const change of ["disable", "dispose", "replace", "manual"] as const) {
  test(`Resolve preparation is fenced by ${change}`, async () => {
    const h = harness(environment({ hasMergeConflicts: true, prMergeability: "dirty" }));
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.storage.getRepositoryConfig = async () => {
      entered();
      await gate;
      return {} as never;
    };
    const running = h.controller.evaluate("env-1");
    await started;
    if (change === "dispose") h.controller.dispose();
    else
      h.set({
        ...h.stored,
        ...(change === "disable"
          ? { autoMerge: false }
          : change === "replace"
            ? { prUrl: PR_URL + "1" }
            : { prRecheckAfterAgentCompletionArmedAt: "manual" }),
      });
    release();
    await running;
    expect(h.invocations).toHaveLength(0);
    expect(h.timers).toHaveLength(0);
  });
}

test("stopped and unprepared Resolve environments wait without retries, then run when ready", async () => {
  const h = harness(
    environment({ status: "stopped", hasMergeConflicts: true, prMergeability: "dirty" }),
  );
  await h.controller.evaluate("env-1");
  expect(h.invocations).toHaveLength(0);
  expect(h.timers).toHaveLength(0);
  h.set({ ...h.stored, status: "running", setupPhase: "pending" });
  await h.controller.evaluate("env-1");
  expect(h.invocations).toHaveLength(0);
  h.set({ ...h.stored, setupPhase: "ready" });
  await h.controller.evaluate("env-1");
  expect(h.invocations).toHaveLength(1);
});

test("cached, old, unbound, and different-head readings cannot authorize a merge", async () => {
  const h = harness(environment());
  h.setMonitor(
    monitor(h.stored, { lastSuccessfulCheckStartedAt: new Date(Date.now() - 2000).toISOString() }),
  );
  await h.controller.evaluate("env-1");
  h.setMonitor(monitor(h.stored, { headSha: null }));
  await h.controller.evaluate("env-1");
  h.setMonitor(
    monitor(h.stored, {
      lastSuccessfulCheckStartedAt: new Date(Date.now() - 120000).toISOString(),
    }),
  );
  await h.controller.evaluate("env-1");
  h.set({ ...h.stored, prUrl: PR_URL + "1" });
  await h.controller.evaluate("env-1");
  expect(h.invocations).toHaveLength(0);
});

test("success holds a pending merge, and armed Resolve stays held after its timer", async () => {
  const h = harness(environment());
  await h.controller.evaluate("env-1");
  await h.controller.evaluate("env-1");
  expect(h.invocations).toHaveLength(1);
  h.timers.at(-1)!.callback();
  await h.controller.evaluate("env-1");
  expect(h.invocations).toHaveLength(2);
  const r = harness(environment({ hasMergeConflicts: true, prMergeability: "dirty" }));
  await r.controller.evaluate("env-1");
  r.set({ ...r.stored, prRecheckAfterAgentCompletionArmedAt: "owned" });
  r.timers.at(-1)!.callback();
  await r.controller.evaluate("env-1");
  expect(r.invocations).toHaveLength(1);
});

test("failure backoff reaches its ceiling, exposes an error, and recovery clears it", async () => {
  const h = harness(environment());
  h.failNextInvoke(new Error("refused"));
  await h.controller.evaluate("env-1");
  for (let attempt = 0; attempt < 7; attempt++) {
    expect(h.timers.at(-1)!.delayMs).toBe(
      Math.min(PR_AUTO_MERGE_RETRY_BASE_MS * 2 ** attempt, PR_AUTO_MERGE_RETRY_MAX_MS),
    );
    expect(h.stored.autoMergeError).toBe("refused");
    if (attempt < 6) h.failNextInvoke(new Error("refused"));
    h.timers.at(-1)!.callback();
    await h.controller.evaluate("env-1");
    // Drain the coalesced pass before firing another timer.
    await h.controller.evaluate("env-1");
  }
  expect(h.stored.autoMergeError).toBeNull();
});

for (const reason of ["disabled", "terminal", "removed"] as const) {
  test(`${reason} cancels retries`, async () => {
    const h = harness(environment());
    h.controller.start();
    await h.controller.evaluate("env-1");
    if (reason === "removed") {
      for (const listener of h.listeners) listener({ environmentId: "env-1", removed: true });
    } else {
      h.set({
        ...h.stored,
        ...(reason === "disabled" ? { autoMerge: false } : { prState: "closed" }),
      });
      await h.controller.evaluate("env-1");
    }
    expect(h.timers[0]!.cancelled).toBe(true);
  });
}

for (const status of ["rejected", "unknown"]) {
  test(`Resolve ${status} status is visible and does not count as a successful launch`, async () => {
    const h = harness(environment({ hasMergeConflicts: true, prMergeability: "dirty" }));
    h.nextStatus(status);
    await h.controller.evaluate("env-1");
    expect(h.stored.autoMergeError).toContain(
      status === "rejected" ? "agent refused" : "unconfirmed",
    );
    expect(h.timers[0]!.delayMs).toBe(PR_AUTO_MERGE_RETRY_BASE_MS);
  });
}
