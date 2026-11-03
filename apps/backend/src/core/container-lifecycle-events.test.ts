import { describe, expect, mock, spyOn, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import { ContainerLifecycleReactor, containerIdsMatch } from "./container-lifecycle-events.js";
import { EnvironmentOperations } from "./environment-operations.js";
import type { Environment } from "./models.js";

const FULL = "f".repeat(64);
const SHORT = FULL.slice(0, 12);

function harness(
  options: {
    lifecycleWork?: boolean;
    status?: Environment["status"];
    operations?: EnvironmentOperations;
  } = {},
) {
  const environment = {
    id: "env-1",
    environmentType: "containerized",
    containerId: SHORT,
    status: "running",
  } as unknown as Environment;
  const calls: string[] = [];
  const context = {
    storage: {
      getEnvironment: async () => environment,
      loadEnvironments: async () => [
        { id: "local", environmentType: "local", containerId: null },
        environment,
      ],
    },
    runtime: {
      environments: options.operations ?? {
        hasLifecycleWork: () => options.lifecycleWork === true,
        enqueueLifecycleOperation: async (_id: string, _tasks: unknown, run: () => Promise<void>) =>
          run(),
      },
      diffStats: {
        containerEnded: () => undefined,
        containerStarted: () => undefined,
        sync: async () => void calls.push("diff-sync"),
      },
      prMonitor: {
        containerEnded: () => undefined,
        containerStarted: () => undefined,
        sync: async () => void calls.push("pr-sync"),
      },
      tmux: {
        claudeStatePolls: {
          startedMatching: () => undefined,
          shutdownMatching: (id: string) => void calls.push(`state-poll-shutdown:${id}`),
          reconcile: async () => void calls.push("state-poll-reconcile"),
        },
        hookSignals: { forgetMatching: (id: string) => void calls.push(`doorbell-forget:${id}`) },
        sessions: { containerEnded: (id: string) => void calls.push(`tabs-ended:${id}`) },
      },
    },
  } as unknown as CommandContext;
  const syncStatus = mock(async (env: Environment) => {
    calls.push(`status-sync:${env.id}`);
    return { ...env, status: options.status ?? "stopped" };
  });
  const reactor = new ContainerLifecycleReactor(() => context, {
    syncStatus: syncStatus as never,
  });
  return { reactor, calls, syncStatus, context, environment };
}

describe("container lifecycle events", () => {
  test("a dying container retires its loops at once, then reconciles status, diff and PR loops", async () => {
    const h = harness();
    h.reactor.handle(FULL, "die");
    // Retired synchronously, before any storage read.
    expect(h.calls).toEqual([
      `state-poll-shutdown:${FULL}`,
      `doorbell-forget:${FULL}`,
      `tabs-ended:${FULL}`,
    ]);
    await h.reactor.idle();
    expect(h.calls.slice(3)).toEqual([
      "status-sync:env-1",
      "diff-sync",
      "pr-sync",
      "state-poll-reconcile",
    ]);
  });

  test("a start re-adopts without retiring anything", async () => {
    const h = harness({ status: "running" });
    h.reactor.handle(FULL, "start");
    await h.reactor.idle();
    expect(h.calls).toEqual(["status-sync:env-1", "diff-sync", "pr-sync", "state-poll-reconcile"]);
  });

  test("a lifecycle operation in flight owns the reconciliation", async () => {
    const h = harness({ lifecycleWork: true });
    h.reactor.handle(FULL, "stop");
    await h.reactor.idle();
    expect(h.syncStatus).not.toHaveBeenCalled();
    expect(h.calls).toContain("diff-sync");
    expect(h.calls).toContain("pr-sync");
  });

  test("a burst of events for one container reconciles at most twice", async () => {
    const h = harness();
    h.reactor.handle(FULL, "die");
    h.reactor.handle(FULL, "stop");
    h.reactor.handle(FULL, "destroy");
    await h.reactor.idle();
    expect(h.syncStatus).toHaveBeenCalledTimes(2);
  });

  test("an unknown container costs one storage read and nothing else", async () => {
    const h = harness();
    h.reactor.handle("0".repeat(64), "die");
    await h.reactor.idle();
    expect(h.syncStatus).not.toHaveBeenCalled();
  });

  test("ids match by prefix in either direction, never on empty", () => {
    expect(containerIdsMatch(FULL, SHORT)).toBe(true);
    expect(containerIdsMatch(SHORT, FULL)).toBe(true);
    expect(containerIdsMatch(FULL, "")).toBe(false);
    expect(containerIdsMatch("abc", "abd")).toBe(false);
  });
});

test("failed inspect keeps diff/PR fenced, retries once, and a rejected diff sync cannot skip PR", async () => {
  const h = harness();
  let diffActive = true;
  let prActive = true;
  h.context.runtime.diffStats.containerEnded = () => {
    diffActive = false;
  };
  h.context.runtime.prMonitor.containerEnded = () => {
    prActive = false;
  };
  h.context.runtime.diffStats.sync = async () => {
    throw new Error("diff failure");
  };
  h.syncStatus.mockImplementation(async () => {
    throw new Error("inspect unavailable");
  });
  h.reactor.handle(FULL, "die");
  await h.reactor.idle();
  expect(h.syncStatus).toHaveBeenCalledTimes(2);
  expect(diffActive).toBe(false);
  expect(prActive).toBe(false);
  expect(h.calls).toContain("pr-sync");
  expect(h.calls).toContain("state-poll-reconcile");
});

test("a queued replacement cannot be overwritten by a delayed observation of the old container", async () => {
  const { EnvironmentOperations } = await import("./environment-operations.js");
  const { EnvironmentLifecycleTaskTracker } = await import("./environment-lifecycle-tasks.js");
  const h = harness({ operations: new EnvironmentOperations() });
  h.context.environmentLifecycleTasks = new EnvironmentLifecycleTaskTracker();
  let release!: () => void;
  let entered!: () => void;
  const inspecting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.syncStatus.mockImplementation(async (env) => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    h.environment.status = "stopped";
    h.environment.containerId = null;
    return env;
  });
  h.reactor.handle(FULL, "die");
  await inspecting;
  const replacement = h.context.runtime.environments.enqueueLifecycleOperation(
    h.environment.id,
    h.context.environmentLifecycleTasks,
    async () => {
      h.environment.containerId = "replacement-B";
      h.environment.status = "running";
    },
  );
  release();
  await replacement;
  await h.reactor.idle();
  expect(h.environment.containerId).toBe("replacement-B");
  expect(h.environment.status).toBe("running");
});

test("real diff and PR managers cannot re-admit an ended container from stale stored running status", async () => {
  const { BackendRuntime } = await import("./backend-runtime.js");
  const runtime = new BackendRuntime({ emit: () => undefined });
  const environment = {
    id: "env",
    projectId: "project",
    environmentType: "containerized",
    containerId: SHORT,
    status: "running",
    branch: "feature",
  } as Environment;
  const context = {
    runtime,
    storage: { loadEnvironments: async () => [environment], loadConfig: async () => ({}) },
    emit: () => undefined,
  } as unknown as CommandContext;
  const track = spyOn(runtime.diffStats.service, "track").mockImplementation(() => undefined);
  const prSync = spyOn(runtime.prMonitor.service, "sync").mockImplementation(() => undefined);
  try {
    runtime.diffStats.containerEnded(environment.id, SHORT);
    runtime.prMonitor.containerEnded(environment.id, SHORT);
    await runtime.diffStats.sync(context);
    await runtime.prMonitor.sync(context);
    expect(track).not.toHaveBeenCalled();
    expect(prSync.mock.calls.at(-1)?.[0][0]?.ready).toBe(false);
    runtime.diffStats.containerStarted(FULL);
    runtime.prMonitor.containerStarted(FULL);
    await runtime.diffStats.sync(context);
    await runtime.prMonitor.sync(context);
    expect(track).toHaveBeenCalled();
    expect(prSync.mock.calls.at(-1)?.[0][0]?.ready).toBe(true);
  } finally {
    runtime.shutdown();
    track.mockRestore();
    prSync.mockRestore();
  }
});
