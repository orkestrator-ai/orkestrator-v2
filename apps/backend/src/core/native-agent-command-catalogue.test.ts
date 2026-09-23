import { describe, expect, mock, test } from "bun:test";
import type { NativeAgentSlashCommand } from "@orkestrator/protocol/native-agent";
import type {
  NativeAgentRuntimeProvider,
  ProviderCommandCatalogue,
} from "./agent-provider-contract.js";
import { ProviderUnreachableError } from "./agent-provider-contract.js";
import {
  NativeAgentCommandCatalogueCache,
  commandCatalogueKey,
} from "./native-agent-command-catalogue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function row(name: string, extra: Partial<NativeAgentSlashCommand> = {}): NativeAgentSlashCommand {
  return {
    name,
    source: "project",
    id: `test:${name}`,
    executionKind: "provider-prompt",
    bindingRevision: `rev:${name}`,
    ...extra,
  };
}

function catalogue(commands: NativeAgentSlashCommand[]): ProviderCommandCatalogue {
  return { enhanced: true, status: "ready", commands, freshness: "ttl" };
}

function provider(
  read: (sessionId?: string) => Promise<ProviderCommandCatalogue>,
  extra: Partial<NativeAgentRuntimeProvider> = {},
): NativeAgentRuntimeProvider {
  return { commandCatalogue: mock(read), ...extra } as unknown as NativeAgentRuntimeProvider;
}

function harness(
  overrides: Partial<ConstructorParameters<typeof NativeAgentCommandCatalogueCache>[0]> = {},
) {
  let now = 1_000;
  const announce = mock((_environmentId: string) => undefined);
  const cache = new NativeAgentCommandCatalogueCache({
    now: () => now,
    announce,
    firstReadBudgetMs: 20,
    ...overrides,
  });
  return {
    cache,
    announce,
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

const KEY = commandCatalogueKey("env-1", "claude", "session-1");

describe("NativeAgentCommandCatalogueCache", () => {
  test("a successful empty list is ready and distinct from a failed first read", async () => {
    const { cache } = harness();
    const empty = await cache.read(
      KEY,
      "env-1",
      provider(async () => catalogue([])),
      "session-1",
    );
    expect(empty.commands).toEqual([]);
    expect(empty.state).toMatchObject({ status: "ready", enhanced: true, revision: 1 });

    const other = harness();
    const failed = await other.cache.read(
      KEY,
      "env-1",
      provider(async () => {
        throw new ProviderUnreachableError("down");
      }),
      "session-1",
    );
    expect(failed.commands).toEqual([]);
    expect(failed.state).toMatchObject({ status: "unavailable", error: { code: "unreachable" } });
  });

  test("publishes loading instead of holding a projection behind a slow first read", async () => {
    const { cache, announce } = harness();
    const gate = deferred<ProviderCommandCatalogue>();
    const slow = provider(() => gate.promise);
    const first = await cache.read(KEY, "env-1", slow, "session-1");
    expect(first.state.status).toBe("loading");
    gate.resolve(catalogue([row("/review")]));
    await Bun.sleep(0);
    expect(announce).toHaveBeenCalledWith("env-1");
    const second = await cache.read(KEY, "env-1", slow, "session-1");
    expect(second.state.status).toBe("ready");
    expect(second.commands.map((command) => command.name)).toEqual(["/review"]);
  });

  test("expiry serves the retained list while revalidating once in the background", async () => {
    const h = harness();
    let version = 1;
    const reads = mock(async () => catalogue([row(version === 1 ? "/old" : "/new")]));
    const source = provider(reads);
    await h.cache.read(KEY, "env-1", source, "session-1");
    version = 2;
    h.advance(30_001);
    const served = await h.cache.read(KEY, "env-1", source, "session-1");
    const concurrent = await h.cache.read(KEY, "env-1", source, "session-1");
    expect(served.commands.map((command) => command.name)).toEqual(["/old"]);
    expect(concurrent.commands.map((command) => command.name)).toEqual(["/old"]);
    await Bun.sleep(0);
    expect(reads).toHaveBeenCalledTimes(2);
    const refreshed = await h.cache.read(KEY, "env-1", source, "session-1");
    expect(refreshed.commands.map((command) => command.name)).toEqual(["/new"]);
    expect(refreshed.state.revision).toBe(2);
  });

  test("a failed revalidation keeps the list as stale and backs off exponentially", async () => {
    const h = harness();
    let fail = false;
    const reads = mock(async () => {
      if (fail) throw new Error("boom");
      return catalogue([row("/kept")]);
    });
    const source = provider(reads);
    await h.cache.read(KEY, "env-1", source, "session-1");
    fail = true;
    h.advance(30_001);
    await h.cache.read(KEY, "env-1", source, "session-1");
    await Bun.sleep(0);
    const stale = h.cache.peek(KEY)!;
    expect(stale.commands.map((command) => command.name)).toEqual(["/kept"]);
    expect(stale.state).toMatchObject({ status: "stale", error: { code: "provider-error" } });
    expect(h.cache.expiresAt(KEY)).toBe(h.now + 5_000);

    h.advance(5_001);
    await h.cache.read(KEY, "env-1", source, "session-1");
    await Bun.sleep(0);
    expect(h.cache.expiresAt(KEY)).toBe(h.now + 10_000);
    expect(reads).toHaveBeenCalledTimes(3);
  });

  test("revision advances only for meaningful changes", async () => {
    const h = harness();
    const source = provider(async () => catalogue([row("/same")]));
    await h.cache.read(KEY, "env-1", source, "session-1");
    for (let index = 0; index < 3; index += 1) {
      h.advance(30_001);
      await h.cache.read(KEY, "env-1", source, "session-1");
      await Bun.sleep(0);
    }
    expect(h.cache.peek(KEY)!.state.revision).toBe(1);
    expect(h.announce).toHaveBeenCalledTimes(1);
  });

  test("an explicit refresh discards an older in-flight read so it cannot overwrite", async () => {
    const h = harness();
    const stale = deferred<ProviderCommandCatalogue>();
    let reads = 0;
    const source = provider(async () => {
      reads += 1;
      if (reads === 2) return stale.promise;
      return catalogue([row(reads === 1 ? "/one" : "/three")]);
    });
    await h.cache.read(KEY, "env-1", source, "session-1");
    h.advance(30_001);
    await h.cache.read(KEY, "env-1", source, "session-1");
    const result = await h.cache.refresh(KEY, "env-1", source, "session-1");
    expect(result.outcome).toBe("reread");
    stale.resolve(catalogue([row("/two")]));
    await Bun.sleep(0);
    expect(h.cache.peek(KEY)!.commands.map((command) => command.name)).toEqual(["/three"]);
    expect(h.cache.peek(KEY)!.state.lastRefresh).toMatchObject({ outcome: "reread" });
  });

  test("refresh reports what the provider actually did", async () => {
    const h = harness();
    const deferredReload = provider(async () => catalogue([row("/a")]), {
      refreshCommands: async () => ({ outcome: "deferred", message: "Busy" }),
    });
    expect(await h.cache.refresh(KEY, "env-1", deferredReload, "session-1")).toEqual({
      outcome: "deferred",
      message: "Busy",
    });
    const failing = provider(
      async () => {
        throw new Error("down");
      },
      { refreshCommands: async () => ({ outcome: "reloaded" }) },
    );
    const other = harness();
    expect((await other.cache.refresh(KEY, "env-1", failing, "session-1")).outcome).toBe("failed");
  });

  test("unsupported and missing provider answers never look like ready lists", async () => {
    const { cache } = harness();
    const unsupported = await cache.read(
      KEY,
      "env-1",
      provider(async () => ({ enhanced: true, status: "unsupported", commands: [row("/x")] })),
      "session-1",
    );
    expect(unsupported).toMatchObject({ commands: [], state: { status: "unsupported" } });
    const other = harness();
    const missing = await other.cache.read(
      KEY,
      "env-1",
      provider(async () => ({ enhanced: true, status: "missing", commands: [] })),
      "session-1",
    );
    expect(missing.state.status).toBe("unavailable");
  });

  test("bounds retained bytes and entry count with least-recently-used eviction", async () => {
    const h = harness({ maxEntries: 3, maxBytes: 64 * 1024 });
    const big = Array.from({ length: 100 }, (_, index) =>
      row(`/c${index}`, { description: "d".repeat(400) }),
    );
    for (let index = 0; index < 6; index += 1) {
      await h.cache.read(
        commandCatalogueKey("env-1", "claude", `s${index}`),
        "env-1",
        provider(async () => catalogue(big)),
        `s${index}`,
      );
    }
    expect(h.cache.size).toBeLessThanOrEqual(3);
    expect(h.cache.retainedBytes).toBeLessThanOrEqual(64 * 1024 + 64 * 1024);
    // The most recent entry always survives.
    expect(h.cache.peek(commandCatalogueKey("env-1", "claude", "s5"))).toBeDefined();
  });

  test("bounds concurrent provider reads across keys", async () => {
    const h = harness({ maxConcurrentReads: 2, firstReadBudgetMs: 5 });
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    let index = 0;
    const source = provider(async () => {
      const gate = gates[index++]!;
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return catalogue([]);
    });
    await Promise.all(
      gates.map((_, key) =>
        h.cache.read(commandCatalogueKey("env-1", "claude", `k${key}`), "env-1", source, `k${key}`),
      ),
    );
    for (const gate of gates) {
      gate.resolve();
      await Bun.sleep(0);
    }
    await h.cache.settle();
    expect(peak).toBe(2);
  });

  test("a read that outlives its timeout is marked failed without an unhandled rejection", async () => {
    const h = harness({ readTimeoutMs: 10, firstReadBudgetMs: 50 });
    const never = deferred<ProviderCommandCatalogue>();
    const result = await h.cache.read(
      KEY,
      "env-1",
      provider(() => never.promise),
      "session-1",
    );
    expect(result.state).toMatchObject({ status: "unavailable", error: { code: "timeout" } });
    never.reject(new Error("late"));
    await Bun.sleep(0);
  });

  test("timed out probes retain their slot and waking waiters cannot over-admit", async () => {
    const h = harness({ maxConcurrentReads: 1, readTimeoutMs: 20 });
    const gates = Array.from({ length: 3 }, () => deferred<void>());
    let started = 0;
    let active = 0;
    let peak = 0;
    const source = provider(async () => {
      const gate = gates[started++]!;
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return catalogue([]);
    });
    const first = h.cache.readForDispatch("k1", "env-1", source, "s1");
    await Bun.sleep(0);
    const second = h.cache.readForDispatch("k2", "env-1", source, "s2");
    expect((await first).state.error?.code).toBe("timeout");
    const third = h.cache.readForDispatch("k3", "env-1", source, "s3");
    expect(started).toBe(1);
    gates[0]!.resolve();
    await Bun.sleep(0);
    expect(started).toBe(2);
    gates[1]!.resolve();
    await Bun.sleep(0);
    expect(started).toBe(3);
    gates[2]!.resolve();
    await Promise.all([second, third]);
    expect(peak).toBe(1);
  });

  test("dispatch reads force a re-read on request and forget environments", async () => {
    const h = harness();
    const reads = mock(async () => catalogue([row("/a")]));
    const source = provider(reads);
    await h.cache.readForDispatch(KEY, "env-1", source, "session-1");
    await h.cache.readForDispatch(KEY, "env-1", source, "session-1");
    expect(reads).toHaveBeenCalledTimes(1);
    await h.cache.readForDispatch(KEY, "env-1", source, "session-1", true);
    expect(reads).toHaveBeenCalledTimes(2);
    h.cache.forgetEnvironment("env-1");
    expect(h.cache.peek(KEY)).toBeUndefined();
  });

  test("legacy providers are read through slashCommands and marked non-enhanced", async () => {
    const { cache } = harness();
    const legacy = {
      slashCommands: async () => [{ name: "/old", source: "builtin" }],
    } as unknown as NativeAgentRuntimeProvider;
    const result = await cache.read(KEY, "env-1", legacy, "session-1");
    expect(result.state).toMatchObject({ status: "ready", enhanced: false });
    expect(result.commands[0]).toMatchObject({
      id: "legacy:/old",
      executionKind: "provider-prompt",
    });
  });
});
