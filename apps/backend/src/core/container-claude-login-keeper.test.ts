import { afterEach, describe, expect, test, spyOn } from "bun:test";

import type { CommandContext } from "./commands-context.js";
import {
  CLAUDE_HOST_REFRESH_LEAD_MS,
  CLAUDE_HOST_REFRESH_RETRY_MS,
  CLAUDE_LOGIN_KEEPER_INTERVAL_MS,
  ContainerClaudeLoginKeeper,
} from "./container-claude-login-keeper.js";
import * as credentialFiles from "./commands-files.js";
import type { ClaudeLoginHandover } from "./agent-accounts-containers.js";
import { BackendRuntime } from "./backend-runtime.js";

const runtimes: BackendRuntime[] = [];
function trackedRuntime(): BackendRuntime {
  const runtime = new BackendRuntime({ emit: () => undefined });
  runtimes.push(runtime);
  return runtime;
}
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.shutdown();
});
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
  localBridges?: boolean;
  timers?: import("./container-claude-login-keeper.js").ClaudeLoginKeeperOptions["timers"];
}) {
  let now = NOW;
  const reads: number[] = [];
  const synced: string[] = [];
  const handovers: Array<ClaudeLoginHandover | undefined> = [];
  const refreshed: string[] = [];
  let credentialIndex = 0;
  const context = {
    runtime: trackedRuntime(),
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
      agentAccounts: {
        loadAgentAccounts: async () => ({ accounts: [], active: {} }),
      },
    },
  } as unknown as CommandContext;
  const read = async () => {
    reads.push(now);
    const text = options.credentials[Math.min(credentialIndex, options.credentials.length - 1)];
    credentialIndex++;
    return text;
  };
  const keeper = new ContainerClaudeLoginKeeper(context, {
    now: () => now,
    timers: options.timers,
    readCredentials: read,
    readLocalCredentials: read,
    hasLocalTokenBridges: () => options.localBridges === true,
    syncContainer: async (containerId, handover) => {
      synced.push(containerId);
      handovers.push(handover);
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
    handovers,
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

  test("reads the host login once per pass and hands that read to every container", async () => {
    const run = harness({
      environments: [environment("a"), environment("b"), environment("c")],
      credentials: [login(NOW + 8 * 60 * 60_000)],
    });
    await run.keeper.tick();
    expect(run.reads).toHaveLength(1);
    expect(run.handovers).toEqual([
      { account: { accountId: "default" }, credentials: login(NOW + 8 * 60 * 60_000) },
      { account: { accountId: "default" }, credentials: login(NOW + 8 * 60 * 60_000) },
      { account: { accountId: "default" }, credentials: login(NOW + 8 * 60 * 60_000) },
    ]);
  });

  test("a pass that refreshes the host hands containers the login read after the refresh", async () => {
    const renewed = login(NOW + 8 * 60 * 60_000);
    const run = harness({
      environments: [environment("a"), environment("b")],
      credentials: [login(NOW + 60_000), renewed],
    });
    await run.keeper.tick();
    expect(run.refreshed).toEqual(["default"]);
    expect(run.reads).toHaveLength(2);
    expect(run.handovers.map((handover) => handover?.credentials)).toEqual([renewed, renewed]);
  });

  test("renews the login for local coordinator bridges, even with the container opt-out", async () => {
    const run = harness({
      environments: [environment("a")],
      credentials: [login(NOW + 60_000), login(NOW + 8 * 60 * 60_000)],
      useHostClaudeCredentials: false,
      localBridges: true,
    });
    await run.keeper.tick();
    expect(run.refreshed).toEqual(["default"]);
    // The opt-out still keeps the login out of containers.
    expect(run.synced).toEqual([]);
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

test("default local bridge detection reads the host login and ignores other providers", async () => {
  const read = spyOn(credentialFiles, "readRuntimeHostClaudeCredentials").mockResolvedValue(
    login(NOW + 3600_000),
  );
  const context = {
    runtime: trackedRuntime(),
    runtimeFlavor: "production",
    storage: {
      loadConfig: async () => ({ global: { useHostClaudeCredentials: false } }),
      agentAccounts: {
        loadAgentAccounts: async () => ({ accounts: [], active: {} }),
      },
    },
  } as unknown as CommandContext;
  const keeper = new ContainerClaudeLoginKeeper(context, { now: () => NOW });
  try {
    context.runtime.localServers.adoptProcess("codex:other", {} as never, {
      workingDirectory: "/isolated",
      loginless: true,
    });
    await keeper.tick();
    expect(read).not.toHaveBeenCalled();
    context.runtime.localServers.adoptProcess("claude:waiting", {} as never, {
      workingDirectory: "/isolated",
      loginless: true,
    });
    await keeper.tick();
    expect(read).toHaveBeenCalledTimes(1);
    context.runtime.localServers.releaseOwnership(
      "claude:waiting",
      context.runtime.localServers.process("claude:waiting")!,
    );
    context.runtime.localServers.adoptProcess("claude:running", {} as never, {
      workingDirectory: "/isolated",
      tokenExpiresAt: NOW + 3600_000,
    });
    await keeper.tick();
    expect(read).toHaveBeenCalledTimes(2);
    context.runtimeFlavor = "agent-test";
    await keeper.tick();
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    read.mockRestore();
    context.runtime.localServers.releaseOwnership(
      "codex:other",
      context.runtime.localServers.process("codex:other")!,
    );
    context.runtime.localServers.releaseOwnership(
      "claude:waiting",
      context.runtime.localServers.process("claude:waiting")!,
    );
    context.runtime.localServers.releaseOwnership(
      "claude:running",
      context.runtime.localServers.process("claude:running")!,
    );
  }
});

test("the default local read resolves an added account's own credentials", async () => {
  const read = spyOn(credentialFiles, "getHostClaudeCredentials").mockResolvedValue(
    login(NOW + 3600_000),
  );
  const host = spyOn(credentialFiles, "readRuntimeHostClaudeCredentials").mockRejectedValue(
    new Error("must not read host"),
  );
  const id = "11111111-2222-4333-8444-555555555555";
  const context = {
    runtime: trackedRuntime(),
    runtimeFlavor: "production",
    storage: {
      loadConfig: async () => ({ global: { useHostClaudeCredentials: false } }),
      agentAccounts: {
        loadAgentAccounts: async () => ({ accounts: [], active: { claude: id } }),
        agentAccountsDirectory: () => "/isolated/accounts",
      },
    },
  } as unknown as CommandContext;
  const keeper = new ContainerClaudeLoginKeeper(context, {
    now: () => NOW,
    hasLocalTokenBridges: () => true,
  });
  try {
    await keeper.tick();
    expect(read).toHaveBeenCalledWith(
      process.platform,
      expect.any(String),
      `/isolated/accounts/claude/${id}`,
      expect.objectContaining({ configDirOnly: true }),
    );
    expect(host).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    host.mockRestore();
  }
});

for (const first of ["local", "containers"] as const) {
  test(`simultaneous local and container refreshes respect opt-out when ${first} reads first`, async () => {
    let renewed = false;
    let refreshes = 0;
    const read = async () => login(NOW + (renewed ? 3600_000 : 60_000));
    const keeper = new ContainerClaudeLoginKeeper(
      {
        runtime: trackedRuntime(),
        runtimeFlavor: "production",
        storage: {
          loadConfig: async () => ({ global: { useHostClaudeCredentials: false } }),
          agentAccounts: {
            loadAgentAccounts: async () => ({ accounts: [], active: {} }),
          },
        },
      } as unknown as CommandContext,
      {
        now: () => NOW,
        readCredentials: async () => {
          throw new Error("container opted out");
        },
        readLocalCredentials: read,
        refreshHostLogin: async () => {
          refreshes++;
          renewed = true;
        },
      },
    );
    const order =
      first === "local"
        ? [keeper.refreshLocalLoginIfDue(), keeper.refreshHostIfDue()]
        : [keeper.refreshHostIfDue(), keeper.refreshLocalLoginIfDue()];
    const result = await Promise.all(order);
    expect(result[first === "local" ? 0 : 1]?.expiresAt).toBe(NOW + 3600_000);
    expect(result[first === "local" ? 1 : 0]).toBeUndefined();
    expect(refreshes).toBe(1);
  });
}

test("a container opt-out read cannot suppress a concurrent local refresh", async () => {
  const run = harness({
    environments: [],
    useHostClaudeCredentials: false,
    localBridges: true,
    credentials: [login(NOW + 60_000), login(NOW + 8 * 3600_000)],
  });
  const [container, local] = await Promise.all([
    run.keeper.refreshHostIfDue(),
    run.keeper.refreshLocalLoginIfDue(),
  ]);
  expect(container).toBeUndefined();
  expect(local?.expiresAt).toBe(NOW + 8 * 3600_000);
  expect(run.refreshed).toEqual(["default"]);
});

test("local and container consumers serialize refresh and both observe the renewal", async () => {
  const run = harness({
    environments: [environment("a")],
    credentials: [login(NOW + 60_000), login(NOW + 8 * 3600_000)],
  });
  const [local, container] = await Promise.all([
    run.keeper.refreshLocalLoginIfDue(),
    run.keeper.refreshHostIfDue(),
  ]);
  expect(local?.expiresAt).toBe(NOW + 8 * 3600_000);
  expect(container).toEqual(local);
  expect(run.refreshed).toEqual(["default"]);
});

test("default local detection includes token and loginless Claude bridges only", async () => {
  let reads = 0;
  const context = {
    runtime: trackedRuntime(),
    storage: {
      loadConfig: async () => ({ global: { useHostClaudeCredentials: false } }),
      agentAccounts: {
        loadAgentAccounts: async () => ({ active: {} }),
      },
    },
  } as unknown as CommandContext;
  const keeper = new ContainerClaudeLoginKeeper(context, {
    readLocalCredentials: async () => {
      reads++;
      return login(NOW + 8 * 3600_000);
    },
    now: () => NOW,
  });
  try {
    context.runtime.localServers.adoptProcess("codex:keeper-test", {} as never, {
      workingDirectory: "/isolated",
      loginless: true,
    });
    await keeper.tick();
    expect(reads).toBe(0);
    context.runtime.localServers.adoptProcess("claude:keeper-test", {} as never, {
      workingDirectory: "/isolated",
      loginless: true,
    });
    await keeper.tick();
    expect(reads).toBe(1);
    context.runtime.localServers.releaseOwnership(
      "claude:keeper-test",
      context.runtime.localServers.process("claude:keeper-test")!,
    );
    context.runtime.localServers.adoptProcess("claude:keeper-test", {} as never, {
      workingDirectory: "/isolated",
      tokenExpiresAt: NOW + 60_000,
    });
    await keeper.tick();
    expect(reads).toBe(2);
  } finally {
    context.runtime.localServers.releaseOwnership(
      "codex:keeper-test",
      context.runtime.localServers.process("codex:keeper-test")!,
    );
    context.runtime.localServers.releaseOwnership(
      "claude:keeper-test",
      context.runtime.localServers.process("claude:keeper-test")!,
    );
    context.runtime.localServers.releaseOwnership(
      "claude:keeper-test",
      context.runtime.localServers.process("claude:keeper-test")!,
    );
  }
});
