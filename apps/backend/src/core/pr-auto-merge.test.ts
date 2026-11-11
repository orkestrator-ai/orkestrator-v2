import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { CommandFailedError } from "./shell.js";
import { describe, expect, spyOn, test } from "bun:test";
import type { PrMonitorEnvironmentState, PrMonitorEvent } from "@orkestrator/protocol/pr-monitor";
import {
  decideAutoMerge,
  PR_AUTO_MERGE_RESOLVE_SETTLE_MS,
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

  test("waits while checks are pending or the PR is blocked when checks are required", () => {
    const env = environment();
    expect(
      decideAutoMerge(env, monitor(env, { checkSummary: { passed: 1, pending: 1, total: 2 } }), {
        requireChecks: true,
      }),
    ).toEqual({ kind: "wait", reason: "checks-pending" });
    const unstable = environment({ prMergeability: "unstable" });
    expect(decideAutoMerge(unstable, monitor(unstable), { requireChecks: true })).toEqual({
      kind: "wait",
      reason: "checks-not-passing",
    });
    const blocked = environment({ prMergeability: "blocked" });
    expect(decideAutoMerge(blocked, monitor(blocked), { requireChecks: true })).toEqual({
      kind: "wait",
      reason: "blocked",
    });
  });

  test("explicitly opting out merges past failing or pending checks GitHub does not require", () => {
    const unstable = environment({ prMergeability: "unstable" });
    expect(
      decideAutoMerge(
        unstable,
        monitor(unstable, { checkSummary: { passed: 1, pending: 1, total: 3 } }),
        { requireChecks: false },
      ),
    ).toEqual({ kind: "merge" });
    // Required checks surface as `blocked`, which GitHub would refuse anyway.
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

function harness(
  initial: Environment,
  defaultLogging = false,
  resolveSettled?: (environmentId: string) => boolean,
) {
  let stored = initial;
  let monitorState: PrMonitorEnvironmentState | null = monitor(initial);
  const listeners = new Set<(event: PrMonitorEvent) => void>();
  const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
  const timers: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  let failNext: Error | null = null;
  let nextStatus: string | null = null;
  let requireChecks: boolean | undefined;
  const warnings: string[] = [];
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
      ({
        global: {
          enabledAgentPlatforms: ["claude"],
          ...(requireChecks === undefined ? {} : { autoMergeRequireChecks: requireChecks }),
        },
        repositories: {},
      }) as never,
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
    ...(resolveSettled
      ? { resolveSettled: async (environmentId: string) => resolveSettled(environmentId) }
      : {}),
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      (timer as { cancelled: boolean }).cancelled = true;
    },
    ...(defaultLogging ? {} : { onWarning: (warning) => void warnings.push(warning.event) }),
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
    warnings,
    set(next: Environment) {
      stored = next;
      monitorState = monitor(next);
    },
    nextStatus(status: string) {
      nextStatus = status;
    },
    requireChecks(value: boolean | undefined) {
      requireChecks = value;
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

  // `merge_environment_pr` refuses a pinned merge whose effects differ from
  // the ones it would apply ("The pull request or merge effects changed").
  test("keeps the branch of a project's home checkout", async () => {
    const h = harness(environment({ projectHome: true }));
    await h.controller.evaluate("env-1");
    expect(h.invocations[0]?.args).toMatchObject({ deleteBranch: false, cleanupAfterMerge: false });
  });

  test("carries a cleanup the user already requested", async () => {
    const h = harness(environment({ cleanupAfterMergeRequestedAt: new Date().toISOString() }));
    await h.controller.evaluate("env-1");
    expect(h.invocations[0]?.args).toMatchObject({ deleteBranch: true, cleanupAfterMerge: true });
  });

  test("asks for cleanup when auto-merge was turned on with cleanup", async () => {
    const h = harness(environment({ autoMergeCleanup: true }));
    await h.controller.evaluate("env-1");
    expect(h.invocations[0]?.args).toMatchObject({ deleteBranch: true, cleanupAfterMerge: true });
  });

  test("completed cleanup neither records an error nor schedules another attempt", async () => {
    const logs = captureLogs();
    const h = harness(
      environment({ cleanupAfterMergeRequestedAt: new Date().toISOString() }),
      true,
    );
    const get = h.storage.getEnvironment;
    h.storage.getEnvironment = async (id) => (h.invocations.length ? null : get(id));
    const update = spyOn(h.storage, "updateEnvironment").mockImplementation(async () => {
      throw new Error("Environment not found");
    });
    try {
      await h.controller.evaluate("env-1");
      expect(h.invocations).toHaveLength(1);
      expect(update).not.toHaveBeenCalled();
      expect(h.timers).toHaveLength(0);
      expect(logs.records()).toHaveLength(0);
    } finally {
      update.mockRestore();
      logs.restore();
    }
  });

  for (const requested of [true, false]) {
    test(`uses latest cleanup intent after preparation: ${requested}`, async () => {
      const h = harness(
        environment({
          cleanupAfterMergeRequestedAt: requested ? undefined : new Date().toISOString(),
        }),
      );
      const load = h.storage.loadConfig;
      let reads = 0;
      h.storage.loadConfig = async () => {
        const config = await load();
        if (++reads === 2)
          h.set({
            ...h.stored,
            cleanupAfterMergeRequestedAt: requested ? new Date().toISOString() : undefined,
          });
        return config;
      };
      await h.controller.evaluate("env-1");
      expect(h.invocations[0]?.args).toMatchObject({ cleanupAfterMerge: requested });
    });
  }

  test("follows the machine's check requirement for an unstable PR", async () => {
    const required = harness(environment({ prMergeability: "unstable" }));
    required.requireChecks(true);
    required.controller.start();
    await required.announce();
    expect(required.invocations).toEqual([]);

    const unset = harness(environment({ prMergeability: "unstable" }));
    unset.storage.loadConfig = async () => ({ global: {}, repositories: {} }) as never;
    unset.setMonitor(monitor(unset.stored, { checkSummary: { passed: 1, pending: 1, total: 2 } }));
    unset.controller.start();
    await unset.announce();
    expect(unset.invocations).toEqual([]);

    const optedOut = harness(environment({ prMergeability: "unstable" }));
    optedOut.requireChecks(false);
    await optedOut.controller.evaluate("env-1");
    expect(optedOut.invocations.map((invocation) => invocation.command)).toEqual([
      "merge_environment_pr",
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
      tabReuse: "any-agent",
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

for (const change of ["disable", "dispose", "intent", "head", "readiness", "policy"] as const) {
  test(`final policy loading fences merge after ${change}`, async () => {
    const h = harness(environment({ prMergeability: "unstable" }));
    h.requireChecks(false);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const loadConfig = h.storage.loadConfig;
    let reads = 0;
    h.storage.loadConfig = async () => {
      if (++reads === 2) {
        entered();
        await gate;
      }
      return loadConfig();
    };
    const running = h.controller.evaluate("env-1");
    await started;
    switch (change) {
      case "disable":
        h.set({ ...h.stored, autoMerge: false });
        break;
      case "dispose":
        h.controller.dispose();
        break;
      case "intent":
        h.set({ ...h.stored, autoMergeEnabledAt: new Date().toISOString() });
        break;
      case "head":
        // Even a ready replacement must not substitute an unauthorized head.
        h.setMonitor(monitor(h.stored, { headSha: "b".repeat(40) }));
        break;
      case "readiness":
        h.setMonitor(monitor(h.stored, { viewerCanMerge: false }));
        break;
      case "policy":
        h.requireChecks(true);
        break;
    }
    release();
    await running;
    expect(h.invocations).toEqual([]);
    expect(h.timers).toEqual([]);
  });
}

test.each(["merge", "resolve"] as const)(
  "default %s failure logging classifies GitHub errors",
  async (kind) => {
    const h = harness(
      environment(kind === "resolve" ? { hasMergeConflicts: true, prMergeability: "dirty" } : {}),
      true,
    );
    const logs = captureLogs();
    try {
      h.failNextInvoke(
        new CommandFailedError("gh auth login: private command output", { exitCode: 4 }),
      );
      await h.controller.evaluate("env-1");
      expect(logs.records()).toMatchObject([
        {
          area: "pull-request",
          level: "warn",
          event: `auto-merge.${kind}-failed`,
          fields: {
            environmentId: "env-1",
            reason: "auth-failed",
            exitCode: 4,
            signal: null,
            error: { name: "CommandFailedError", outputOmitted: true, exitCode: 4 },
          },
        },
      ]);
      expect(logs.lines.join("\n")).not.toContain("private command output");
      expect(logs.records()[0]?.fields).not.toHaveProperty("detail");
    } finally {
      h.controller.dispose();
      logs.restore();
    }
  },
);

test("a conflict-free reading ends the Resolve hold and backoff, so the next conflict launches at once", async () => {
  const h = harness(environment({ hasMergeConflicts: true, prMergeability: "dirty" }));
  h.failNextInvoke(new Error("agent unavailable"));
  await h.controller.evaluate("env-1");
  expect(h.invocations).toHaveLength(1);
  const backoff = h.timers.at(-1)!;
  // Still conflicting: the failed launch waits for its backoff.
  await h.controller.evaluate("env-1");
  expect(h.invocations).toHaveLength(1);

  h.set({ ...h.stored, hasMergeConflicts: false, prMergeability: "blocked" });
  await h.controller.evaluate("env-1");
  expect(backoff.cancelled).toBe(true);
  h.set({ ...h.stored, hasMergeConflicts: true, prMergeability: "dirty" });
  await h.controller.evaluate("env-1");
  expect(h.invocations).toHaveLength(2);
  expect(h.invocations[1]?.args).toMatchObject({ tabReuse: "any-agent" });
});

test("a conflict-free reading does not lift a pending merge's hold", async () => {
  const h = harness(environment());
  await h.controller.evaluate("env-1");
  expect(h.invocations).toHaveLength(1);
  await h.controller.evaluate("env-1");
  expect(h.invocations).toHaveLength(1);
  expect(h.timers.at(-1)!.cancelled).toBe(false);
});

/** An armed, conflicting environment whose monitor readings are all fresh. */
function resolvingEnvironment(overrides: Partial<Environment> = {}): Environment {
  return environment({
    autoMergeEnabledAt: new Date(Date.now() - 55_000).toISOString(),
    hasMergeConflicts: true,
    prMergeability: "dirty",
    prRecheckAfterAgentCompletionArmedAt: new Date(Date.now() - 54_000).toISOString(),
    ...overrides,
  });
}

/** Lets the controller's unawaited follow-up pass run. */
async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

test("completed resolution retries only after a reading past the settle window, then stops at three", async () => {
  const completed = isoAgo(PR_AUTO_MERGE_RESOLVE_SETTLE_MS + 10_000);
  const h = harness(resolvingEnvironment({ autoMergeResolveCompletedAt: completed }));
  // A reading from inside the settle window may still show the old conflict.
  h.setMonitor(monitor(h.stored, { lastSuccessfulCheckStartedAt: isoAgo(15_000) }));
  await h.controller.evaluate("env-1");
  expect(h.invocations).toHaveLength(0);
  expect(h.stored.autoMergeResolveAttempts ?? 0).toBe(0);
  h.setMonitor(monitor(h.stored));
  await h.controller.evaluate("env-1");
  await flush();
  expect(h.stored.autoMergeResolveAttempts).toBe(1);
  expect(h.stored.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();
  // The prompt goes back to the open Resolve tab without waiting for another reading.
  expect(h.invocations).toHaveLength(1);
  expect(h.invocations[0]).toMatchObject({
    command: "launch_native_agent_job",
    args: { title: "Resolve", tabReuse: "any-agent" },
  });
  h.set({
    ...h.stored,
    autoMergeResolveAttempts: 2,
    prRecheckAfterAgentCompletionArmedAt: completed,
    autoMergeResolveCompletedAt: completed,
  });
  await h.controller.evaluate("env-1");
  await flush();
  expect(h.stored.autoMerge).toBe(false);
  expect(h.stored.autoMergeError).toContain("three attempts");
  expect(h.invocations).toHaveLength(1);
  h.controller.dispose();
});

test("a second Resolve can clear conflicts and continue to merge with cleanup", async () => {
  const completed = isoAgo(PR_AUTO_MERGE_RESOLVE_SETTLE_MS + 10_000);
  const h = harness(
    resolvingEnvironment({ autoMergeCleanup: true, autoMergeResolveCompletedAt: completed }),
  );
  await h.controller.evaluate("env-1");
  await flush();
  expect(h.invocations[0]?.command).toBe("launch_native_agent_job");
  h.set({
    ...h.stored,
    hasMergeConflicts: false,
    prMergeability: "clean",
    prRecheckAfterAgentCompletionArmedAt: undefined,
  });
  await h.controller.evaluate("env-1");
  expect(h.invocations[1]).toMatchObject({
    command: "merge_environment_pr",
    args: { cleanupAfterMerge: true },
  });
  h.controller.dispose();
});

test("a settled manual Resolve records its completion and is sent again after the settle window", async () => {
  let settled = false;
  // Armed by a manual press: no automatic request id, no completion time.
  const h = harness(resolvingEnvironment(), false, () => settled);
  await h.controller.evaluate("env-1");
  expect(h.stored.autoMergeResolveCompletedAt).toBeUndefined();
  expect(h.invocations).toHaveLength(0);

  settled = true;
  await h.controller.evaluate("env-1");
  const completedAt = Date.parse(h.stored.autoMergeResolveCompletedAt ?? "");
  expect(Number.isFinite(completedAt)).toBe(true);
  // The reading that noticed the settle started before it; nothing is sent yet.
  await h.controller.evaluate("env-1");
  expect(h.invocations).toHaveLength(0);
  expect(h.stored.prRecheckAfterAgentCompletionArmedAt).toBeDefined();

  h.set({ ...h.stored, autoMergeResolveCompletedAt: isoAgo(PR_AUTO_MERGE_RESOLVE_SETTLE_MS) });
  await h.controller.evaluate("env-1");
  await flush();
  expect(h.stored.autoMergeResolveAttempts).toBe(1);
  expect(h.invocations).toHaveLength(1);
  expect(h.invocations[0]).toMatchObject({
    command: "launch_native_agent_job",
    args: { tabReuse: "any-agent", completionAction: "refresh-pr-after-agent-completion" },
  });
  h.controller.dispose();
});

test("a Resolve working again restarts the settle window instead of counting an attempt", async () => {
  let settled = false;
  const h = harness(
    resolvingEnvironment({
      autoMergeResolveCompletedAt: isoAgo(PR_AUTO_MERGE_RESOLVE_SETTLE_MS + 10_000),
    }),
    false,
    () => settled,
  );
  await h.controller.evaluate("env-1");
  await flush();
  expect(h.stored.autoMergeResolveCompletedAt).toBeUndefined();
  expect(h.stored.prRecheckAfterAgentCompletionArmedAt).toBeDefined();
  expect(h.stored.autoMergeResolveAttempts ?? 0).toBe(0);
  expect(h.invocations).toHaveLength(0);

  settled = true;
  await h.controller.evaluate("env-1");
  expect(h.stored.autoMergeResolveCompletedAt).toBeDefined();
  expect(h.invocations).toHaveLength(0);
  h.controller.dispose();
});

test("a conflict-free reading after Resolve merges without sending the prompt again", async () => {
  const h = harness(
    resolvingEnvironment({
      autoMergeResolveCompletedAt: isoAgo(PR_AUTO_MERGE_RESOLVE_SETTLE_MS + 10_000),
      hasMergeConflicts: false,
      prMergeability: "clean",
      prRecheckAfterAgentCompletionArmedAt: undefined,
    }),
    false,
    () => true,
  );
  await h.controller.evaluate("env-1");
  await flush();
  expect(h.invocations.map((invocation) => invocation.command)).toEqual(["merge_environment_pr"]);
  h.controller.dispose();
});

test("a consumption that loses to a concurrent attempt count does not undercount the cap", async () => {
  let calls = 0;
  const h = harness(
    resolvingEnvironment({
      autoMergeResolveCompletedAt: isoAgo(PR_AUTO_MERGE_RESOLVE_SETTLE_MS + 10_000),
    }),
    false,
    () => {
      // Another writer counts two attempts after this pass read its snapshot.
      if ((calls += 1) === 1) h.set({ ...h.stored, autoMergeResolveAttempts: 2 });
      return true;
    },
  );
  await h.controller.evaluate("env-1");
  await flush();
  // The stale write (0 + 1) was refused; the follow-up pass counted from 2.
  expect(h.stored.autoMergeResolveAttempts).toBe(3);
  expect(h.stored.autoMerge).toBe(false);
  expect(h.stored.autoMergeError).toContain("three attempts");
  expect(h.invocations).toHaveLength(0);
  h.controller.dispose();
});

test("a consumption that loses to a re-armed token launches nothing", async () => {
  let calls = 0;
  const rearmedAt = isoAgo(1_000);
  const h = harness(
    resolvingEnvironment({
      autoMergeResolveCompletedAt: isoAgo(PR_AUTO_MERGE_RESOLVE_SETTLE_MS + 10_000),
    }),
    false,
    () => {
      // A Resolve pressed by hand re-arms the token and is still working.
      if ((calls += 1) > 1) return false;
      h.set({
        ...h.stored,
        prRecheckAfterAgentCompletionArmedAt: rearmedAt,
        autoMergeResolveCompletedAt: undefined,
      });
      return true;
    },
  );
  await h.controller.evaluate("env-1");
  await flush();
  expect(calls).toBe(2);
  expect(h.stored.prRecheckAfterAgentCompletionArmedAt).toBe(rearmedAt);
  expect(h.stored.autoMergeResolveCompletedAt).toBeUndefined();
  expect(h.stored.autoMergeResolveAttempts ?? 0).toBe(0);
  expect(h.stored.autoMerge).toBe(true);
  expect(h.invocations).toHaveLength(0);
  h.controller.dispose();
});

test("a failing settled check leaves the Resolve armed and the next reading retries", async () => {
  let fail = true;
  const h = harness(
    resolvingEnvironment({
      autoMergeResolveCompletedAt: isoAgo(PR_AUTO_MERGE_RESOLVE_SETTLE_MS + 10_000),
    }),
    false,
    () => {
      if (fail) throw new Error("storage unavailable");
      return true;
    },
  );
  await h.controller.evaluate("env-1");
  await flush();
  expect(h.warnings).toEqual(["auto-merge.evaluation-failed"]);
  expect(h.stored.prRecheckAfterAgentCompletionArmedAt).toBeDefined();
  expect(h.stored.autoMergeResolveAttempts ?? 0).toBe(0);
  expect(h.invocations).toHaveLength(0);

  fail = false;
  await h.controller.evaluate("env-1");
  await flush();
  expect(h.stored.autoMergeResolveAttempts).toBe(1);
  expect(h.invocations).toHaveLength(1);
  h.controller.dispose();
});

test("a failing consumption write counts nothing and sends nothing", async () => {
  const h = harness(
    resolvingEnvironment({
      autoMergeResolveCompletedAt: isoAgo(PR_AUTO_MERGE_RESOLVE_SETTLE_MS + 10_000),
    }),
    false,
    () => true,
  );
  const update = h.storage.updateEnvironment;
  h.storage.updateEnvironment = async () => {
    throw new Error("database is locked");
  };
  await h.controller.evaluate("env-1");
  await flush();
  expect(h.warnings).toEqual(["auto-merge.evaluation-failed"]);
  expect(h.stored.prRecheckAfterAgentCompletionArmedAt).toBeDefined();
  expect(h.stored.autoMergeResolveAttempts ?? 0).toBe(0);
  expect(h.invocations).toHaveLength(0);

  h.storage.updateEnvironment = update;
  await h.controller.evaluate("env-1");
  await flush();
  expect(h.stored.autoMergeResolveAttempts).toBe(1);
  expect(h.invocations).toHaveLength(1);
  h.controller.dispose();
});
