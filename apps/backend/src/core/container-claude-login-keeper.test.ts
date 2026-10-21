import { describe, expect, test, spyOn } from "bun:test";

import type { CommandContext } from "./commands-context.js";
import {
  CLAUDE_HOST_REFRESH_LEAD_MS,
  CLAUDE_HOST_REFRESH_RETRY_MS,
  CLAUDE_LOGIN_KEEPER_INTERVAL_MS,
  ContainerClaudeLoginKeeper,
} from "./container-claude-login-keeper.js";
import type { Environment } from "./models.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");

function environment(id: string, overrides: Partial<Environment> = {}): Environment {
  return {
    id,
    containerId: `container-${id}`,
    status: "running",
    ...overrides,
  } as Environment;
}

function login(expiresAt: number, refreshToken = "host-refresh"): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken, expiresAt } });
}

function harness(options: {
  environments: Environment[];
  credentials: string[];
  runtimeFlavor?: "agent-test";
  useHostClaudeCredentials?: false;
  leaseHeld?: boolean;
  failRefresh?: boolean;
  timers?: import("./container-claude-login-keeper.js").ClaudeLoginKeeperOptions["timers"];
}) {
  let now = NOW;
  const reads: number[] = [];
  const synced: string[] = [];
  const refreshed: string[] = [];
  let credentialIndex = 0;
  const context = {
    runtimeFlavor: options.runtimeFlavor,
    credentialSources: new Set(["claude"]),
    registryWriterLease:
      options.leaseHeld === undefined ? undefined : { isHeld: () => options.leaseHeld },
    storage: {
      loadConfig: async () => ({
        global: {
          enabledAgentPlatforms: ["claude"],
          ...(options.useHostClaudeCredentials === false
            ? { useHostClaudeCredentials: false }
            : {}),
        },
      }),
      loadEnvironments: async () => options.environments,
      loadAgentAccounts: async () => ({ accounts: [], active: {} }),
    },
  } as unknown as CommandContext;
  const keeper = new ContainerClaudeLoginKeeper(context, {
    now: () => now,
    timers: options.timers,
    readCredentials: async () => {
      reads.push(now);
      const text = options.credentials[Math.min(credentialIndex, options.credentials.length - 1)];
      credentialIndex++;
      return text;
    },
    syncContainer: async (containerId) => {
      synced.push(containerId);
    },
    refreshHostLogin: async (account) => {
      refreshed.push(account.accountId);
      if (options.failRefresh) throw new Error("SECRET-OUTPUT");
    },
  });
  return {
    keeper,
    reads,
    synced,
    refreshed,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ContainerClaudeLoginKeeper", () => {
  test("pushes the host login into every running container that may receive it", async () => {
    const run = harness({
      environments: [
        environment("a"),
        environment("stopped", { status: "stopped" } as Partial<Environment>),
        environment("revoked", { revokedInputProviders: ["claude"] }),
        environment("local", { containerId: null } as Partial<Environment>),
        environment("b"),
      ],
      credentials: [login(NOW + 8 * 60 * 60_000)],
    });
    expect(await run.keeper.tick()).toBe(CLAUDE_LOGIN_KEEPER_INTERVAL_MS);
    expect(run.synced).toEqual(["container-a", "container-b"]);
    expect(run.refreshed).toEqual([]);
  });

  test("does nothing without a running container, with the opt-out or without the writer lease", async () => {
    for (const options of [
      { environments: [], credentials: [login(NOW + 60_000)] },
      {
        environments: [environment("a")],
        credentials: [login(NOW + 60_000)],
        useHostClaudeCredentials: false as const,
      },
      { environments: [environment("a")], credentials: [login(NOW + 60_000)], leaseHeld: false },
    ]) {
      const run = harness(options);
      await run.keeper.tick();
      expect(run.reads).toEqual([]);
      expect(run.synced).toEqual([]);
      expect(run.refreshed).toEqual([]);
    }
  });

  test("wakes just before the refresh window, refreshes the host, then pushes the renewal", async () => {
    const expiresAt = NOW + 30 * 60_000;
    const run = harness({
      environments: [environment("a")],
      credentials: [
        login(expiresAt),
        login(expiresAt),
        login(expiresAt),
        login(expiresAt + 8 * 60 * 60_000),
      ],
    });
    // Outside the window: no refresh, and the next pass is the normal interval.
    expect(await run.keeper.tick()).toBe(CLAUDE_LOGIN_KEEPER_INTERVAL_MS);
    expect(run.refreshed).toEqual([]);
    // Closer in, the next pass is timed to land at the start of the window.
    run.advance(30 * 60_000 - CLAUDE_HOST_REFRESH_LEAD_MS - 2 * 60_000);
    expect(await run.keeper.tick()).toBe(2 * 60_000);
    run.advance(2 * 60_000);
    expect(await run.keeper.tick()).toBe(CLAUDE_LOGIN_KEEPER_INTERVAL_MS);
    expect(run.refreshed).toEqual(["default"]);
    // The re-read after the refresh is what the containers then get.
    expect(run.synced).toHaveLength(3);
  });

  test("backs off when a host refresh does not renew the login", async () => {
    const expiresAt = NOW + 60_000;
    const run = harness({ environments: [environment("a")], credentials: [login(expiresAt)] });
    expect(await run.keeper.tick()).toBe(CLAUDE_HOST_REFRESH_RETRY_MS);
    expect(run.refreshed).toHaveLength(1);
    // A second pass inside the retry delay does not try again.
    run.advance(CLAUDE_HOST_REFRESH_RETRY_MS / 2);
    await run.keeper.tick();
    expect(run.refreshed).toHaveLength(1);
    run.advance(CLAUDE_HOST_REFRESH_RETRY_MS / 2);
    expect(await run.keeper.tick()).toBe(2 * CLAUDE_HOST_REFRESH_RETRY_MS);
    expect(run.refreshed).toHaveLength(2);
    // Containers are still kept on whatever the host has.
    expect(run.synced).toHaveLength(3);
  });

  test("never refreshes the host from an agent-test profile or for a login it cannot refresh", async () => {
    for (const options of [
      {
        environments: [environment("a")],
        credentials: [login(NOW + 60_000)],
        runtimeFlavor: "agent-test" as const,
      },
      { environments: [environment("a")], credentials: [login(NOW + 60_000, "")] },
      { environments: [environment("a")], credentials: ['{"claudeAiOauth":{"accessToken":"a"}}'] },
    ]) {
      const run = harness(options);
      expect(await run.keeper.tick()).toBe(CLAUDE_LOGIN_KEEPER_INTERVAL_MS);
      expect(run.refreshed).toEqual([]);
      expect(run.synced).toEqual(["container-a"]);
    }
  });

  test("concurrent refresh requests share one host refresh", async () => {
    const run = harness({ environments: [environment("a")], credentials: [login(NOW + 60_000)] });
    const [first, second] = await Promise.all([
      run.keeper.refreshHostIfDue(),
      run.keeper.refreshHostIfDue(),
    ]);
    expect(run.refreshed).toEqual(["default"]);
    expect(first).toEqual(second);
    // Inside the backoff a later request reads but does not refresh again.
    await run.keeper.refreshHostIfDue();
    expect(run.refreshed).toHaveLength(1);
  });

  test("start catches up a running container already inside the refresh window", async () => {
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const run = harness({
      environments: [environment("busy")],
      credentials: [login(NOW + 60_000), login(NOW + 8 * 3600_000)],
      timers: {
        setTimeout: (callback, delay) => {
          scheduled.push({ callback, delay });
          return scheduled.length;
        },
        clearTimeout: () => {},
      },
    });
    run.keeper.start();
    expect(scheduled[0]!.delay).toBe(1_000);
    scheduled[0]!.callback();
    for (let i = 0; i < 100 && scheduled.length < 2; i++) await Promise.resolve();
    expect(scheduled).toHaveLength(2);
    expect(run.refreshed).toEqual(["default"]);
    expect(run.synced).toEqual(["container-busy"]);
    expect(scheduled[1]!.delay).toBe(CLAUDE_LOGIN_KEEPER_INTERVAL_MS);
    run.keeper.stop();
  });

  for (const failRefresh of [true, false]) {
    test(`warns once per backoff window for ${failRefresh ? "failed" : "ineffective"} refreshes without command output`, async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const run = harness({
          environments: [environment("a")],
          credentials: [login(NOW + 60_000)],
          failRefresh,
        });
        await run.keeper.tick();
        await run.keeper.tick();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET");
        run.advance(CLAUDE_HOST_REFRESH_RETRY_MS);
        await run.keeper.tick();
        expect(warn).toHaveBeenCalledTimes(2);
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("start and stop schedule and cancel one timer", async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const cleared: unknown[] = [];
    const keeper = new ContainerClaudeLoginKeeper(
      {
        storage: {
          loadConfig: async () => ({ global: { enabledAgentPlatforms: ["claude"] } }),
          loadEnvironments: async () => [],
        },
      } as unknown as CommandContext,
      {
        timers: {
          setTimeout: (callback, delayMs) => {
            scheduled.push({ callback, delayMs });
            return scheduled.length;
          },
          clearTimeout: (handle) => cleared.push(handle),
        },
      },
    );
    keeper.start();
    keeper.start();
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([1_000]);
    keeper.stop();
    expect(cleared).toEqual([1]);
  });
});
