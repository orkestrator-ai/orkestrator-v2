import { describe, expect, mock, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import { ContainerLifecycleReactor, containerIdsMatch } from "./container-lifecycle-events.js";
import type { Environment } from "./models.js";

const FULL = "f".repeat(64);
const SHORT = FULL.slice(0, 12);

function harness(options: { lifecycleWork?: boolean; status?: Environment["status"] } = {}) {
  const environment = {
    id: "env-1",
    environmentType: "containerized",
    containerId: SHORT,
    status: "running",
  } as unknown as Environment;
  const calls: string[] = [];
  const context = {
    storage: {
      loadEnvironments: async () => [
        { id: "local", environmentType: "local", containerId: null },
        environment,
      ],
    },
    runtime: {
      environments: { hasLifecycleWork: () => options.lifecycleWork === true },
      diffStats: { sync: async () => void calls.push("diff-sync") },
      prMonitor: { sync: async () => void calls.push("pr-sync") },
      tmux: {
        claudeStatePolls: {
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
  return { reactor, calls, syncStatus };
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
    expect(h.calls.some((call) => call.endsWith("-sync"))).toBe(false);
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
