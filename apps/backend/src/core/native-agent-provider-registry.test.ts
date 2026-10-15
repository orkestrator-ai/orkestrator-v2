import { describe, expect, mock, test } from "bun:test";
import {
  ABSENT_BRIDGE_RECHECK_MS,
  type BridgeConnection,
  type BuildPipelineAgent,
  type Environment,
  type NativeAgentRuntimeProvider,
  type NativeAgentServiceOptions,
} from "./native-agent-service-shared.js";
import {
  ProviderRegistry,
  bridgeConnectionIdentity,
  providerCacheKey,
  type ProviderRegistryDependencies,
} from "./native-agent-provider-registry.js";

const KEY = providerCacheKey("env-1", "codex");
const INPUT = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey: "tab-1" };

function fakeProvider(label: string) {
  const dispose = mock(async () => undefined);
  const provider = { agent: "codex", label, dispose } as unknown as NativeAgentRuntimeProvider;
  return { provider, dispose };
}

function connection(port: number, authToken = "token"): BridgeConnection {
  return { agent: "codex", baseUrl: `http://127.0.0.1:${port}`, authToken };
}

function harness(
  overrides: {
    options?: Pick<NativeAgentServiceOptions, "provider" | "providerRetirementGraceMs">;
    bridge?: () => BridgeConnection;
    peek?: () => BridgeConnection | undefined;
  } = {},
) {
  let clock = 1_000;
  let stopped = false;
  const created: NativeAgentRuntimeProvider[] = [];
  const dispositions: Array<ReturnType<typeof mock>> = [];
  const replaced: string[] = [];
  const forgotten: string[] = [];
  const environment = { id: "env-1", environmentType: "local" } as Environment;
  const bridgeConnection = mock(async () => (overrides.bridge ?? (() => connection(4000)))());
  const observeBridgeConnection = mock(async () => (overrides.peek ?? (() => undefined))());
  const deps: ProviderRegistryDependencies = {
    now: () => clock,
    isStopped: () => stopped,
    assertAcceptingWork: () => {
      if (stopped) throw new Error("Native agent service is shut down");
    },
    assertEnvironmentLive: async () => environment,
    options: overrides.options ?? { providerRetirementGraceMs: 0 },
    observations: {
      replaceGroupGeneration: (groupKey: string) => {
        replaced.push(groupKey);
      },
      wakeGroup: () => undefined,
    },
    bridgeConnection:
      bridgeConnection as unknown as ProviderRegistryDependencies["bridgeConnection"],
    observeBridgeConnection:
      observeBridgeConnection as unknown as ProviderRegistryDependencies["observeBridgeConnection"],
    createProvider: () => {
      const { provider, dispose } = fakeProvider(`created-${created.length}`);
      created.push(provider);
      dispositions.push(dispose);
      return provider;
    },
    forgetGroup: (cacheKey) => {
      forgotten.push(cacheKey);
    },
  };
  return {
    registry: new ProviderRegistry(deps),
    created,
    dispositions,
    replaced,
    forgotten,
    bridgeConnection,
    observeBridgeConnection,
    advance: (ms: number) => {
      clock += ms;
    },
    stop: () => {
      stopped = true;
    },
  };
}

/** Let zero-delay retirement timers and their disposal settle. */
async function settleTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("ProviderRegistry", () => {
  test("keys provider groups by environment and agent", () => {
    expect(providerCacheKey("env-1", "codex" as BuildPipelineAgent)).toBe("env-1\0codex");
  });

  test("bridge identity changes with the port, the token and the account", () => {
    const base = bridgeConnectionIdentity(connection(4000));
    expect(bridgeConnectionIdentity(connection(4000))).toBe(base);
    expect(bridgeConnectionIdentity(connection(4001))).not.toBe(base);
    expect(bridgeConnectionIdentity(connection(4000, "other"))).not.toBe(base);
    expect(bridgeConnectionIdentity({ ...connection(4000), accountId: "acct" })).not.toBe(base);
  });

  test("an injected factory is called once and its provider reused", async () => {
    const injected = fakeProvider("injected");
    const factory = mock(async () => injected.provider);
    const { registry, bridgeConnection } = harness({
      options: { provider: factory, providerRetirementGraceMs: 0 },
    });

    expect(await registry.resolve(INPUT)).toBe(injected.provider);
    expect(await registry.resolve(INPUT)).toBe(injected.provider);
    expect(await registry.observe(INPUT)).toBe(injected.provider);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(bridgeConnection).not.toHaveBeenCalled();
    expect(registry.cached(KEY)).toBe(injected.provider);
    expect(registry.connectionIdentity(KEY)).toBeUndefined();
  });

  test("reuses a provider while its bridge generation is unchanged", async () => {
    const { registry, created, bridgeConnection } = harness();

    const first = await registry.resolve(INPUT);
    const again = await registry.resolve(INPUT);

    expect(again).toBe(first);
    expect(created).toHaveLength(1);
    // The generation is re-resolved every time, never trusted from the cache.
    expect(bridgeConnection).toHaveBeenCalledTimes(2);
    expect(registry.connectionIdentity(KEY)).toBe(bridgeConnectionIdentity(connection(4000)));
  });

  test("replaces and retires a provider when its bridge is replaced", async () => {
    let port = 4000;
    const { registry, created, dispositions, replaced } = harness({
      bridge: () => connection(port),
    });

    const first = await registry.resolve(INPUT);
    port = 4001;
    const replacement = await registry.resolve(INPUT);

    expect(replacement).not.toBe(first);
    expect(created).toEqual([first, replacement]);
    expect(registry.cached(KEY)).toBe(replacement);
    expect(replaced.filter((key) => key === KEY).length).toBeGreaterThanOrEqual(2);
    expect(registry.stateForTesting().retiring.has(first)).toBe(true);
    await settleTimers();
    expect(dispositions[0]).toHaveBeenCalledTimes(1);
    expect(dispositions[1]).not.toHaveBeenCalled();
    expect(registry.stateForTesting().retiring.size).toBe(0);
  });

  test("observation never starts a bridge and remembers an absent one", async () => {
    let running: BridgeConnection | undefined;
    const { registry, created, observeBridgeConnection, bridgeConnection, advance } = harness({
      peek: () => running,
    });

    expect(await registry.observe(INPUT)).toBeUndefined();
    expect(registry.isBridgeKnownAbsent(KEY)).toBe(true);
    // Inside the recheck window the absent bridge is not probed again.
    expect(await registry.observe(INPUT)).toBeUndefined();
    expect(observeBridgeConnection).toHaveBeenCalledTimes(1);

    running = connection(4000);
    advance(ABSENT_BRIDGE_RECHECK_MS + 1);
    const observed = await registry.observe(INPUT);

    expect(observed).toBe(created[0]!);
    expect(observeBridgeConnection).toHaveBeenCalledTimes(2);
    expect(bridgeConnection).not.toHaveBeenCalled();
    expect(registry.isBridgeKnownAbsent(KEY)).toBe(false);
  });

  test("caching a provider clears the absent-bridge note", async () => {
    const { registry } = harness();
    registry.markBridgeAbsent(KEY);
    expect(registry.isBridgeKnownAbsent(KEY)).toBe(true);

    await registry.resolve(INPUT);

    expect(registry.isBridgeKnownAbsent(KEY)).toBe(false);
  });

  test("a retired provider is not disposed while a dispatch it sent is in flight", async () => {
    let port = 4000;
    const { registry, dispositions } = harness({ bridge: () => connection(port) });
    const first = await registry.resolve(INPUT);
    registry.beginDispatch(first);
    registry.beginDispatch(first);
    expect(registry.hasDispatchInFlight(first)).toBe(true);

    port = 4001;
    await registry.resolve(INPUT);
    await settleTimers();
    expect(dispositions[0]).not.toHaveBeenCalled();

    registry.endDispatch(first);
    await settleTimers();
    expect(dispositions[0]).not.toHaveBeenCalled();

    registry.endDispatch(first);
    expect(registry.hasDispatchInFlight(first)).toBe(false);
    await settleTimers();
    expect(dispositions[0]).toHaveBeenCalledTimes(1);
  });

  test("re-caching a retiring provider cancels its retirement", async () => {
    const { registry } = harness({ options: { providerRetirementGraceMs: 60_000 } });
    const first = await registry.resolve(INPUT);
    const other = fakeProvider("other");

    registry.cache(KEY, other.provider);
    expect(registry.stateForTesting().retiring.has(first)).toBe(true);
    registry.cache(KEY, first, bridgeConnectionIdentity(connection(4000)));

    expect(registry.stateForTesting().retiring.has(first)).toBe(false);
    expect(registry.cachedForConnection(KEY, bridgeConnectionIdentity(connection(4000)))).toBe(
      first,
    );
    await registry.shutdown();
  });

  test("eviction honours identity and retires without disposing immediately", async () => {
    const { registry, dispositions } = harness({
      options: { providerRetirementGraceMs: 60_000 },
    });
    const cached = await registry.resolve(INPUT);
    const stranger = fakeProvider("stranger");

    registry.evict(INPUT, stranger.provider);
    expect(registry.cached(KEY)).toBe(cached);

    registry.evict(INPUT, cached);
    expect(registry.cached(KEY)).toBeUndefined();
    expect(registry.connectionIdentity(KEY)).toBeUndefined();
    expect(registry.stateForTesting().retiring.has(cached)).toBe(true);
    expect(dispositions[0]).not.toHaveBeenCalled();
    await registry.shutdown();
    expect(dispositions[0]).toHaveBeenCalledTimes(1);
  });

  test("prune disposes providers of deleted environments, sparing in-flight sends", async () => {
    const { registry, forgotten } = harness();
    const gone = fakeProvider("gone");
    const busy = fakeProvider("busy");
    const live = fakeProvider("live");
    registry.cache(providerCacheKey("env-gone", "codex"), gone.provider);
    registry.cache(providerCacheKey("env-busy", "codex"), busy.provider);
    registry.cache(KEY, live.provider);
    registry.markBridgeAbsent(providerCacheKey("env-gone", "codex"));
    registry.beginDispatch(busy.provider);

    await registry.prune(new Set(["env-1"]));

    expect(gone.dispose).toHaveBeenCalledTimes(1);
    expect(busy.dispose).not.toHaveBeenCalled();
    expect(live.dispose).not.toHaveBeenCalled();
    expect(forgotten).toEqual([providerCacheKey("env-gone", "codex")]);
    expect(registry.cached(providerCacheKey("env-gone", "codex"))).toBeUndefined();
    expect(registry.isBridgeKnownAbsent(providerCacheKey("env-gone", "codex"))).toBe(false);
    expect(registry.cached(providerCacheKey("env-busy", "codex"))).toBe(busy.provider);

    registry.endDispatch(busy.provider);
    await registry.prune(new Set(["env-1"]));
    expect(busy.dispose).toHaveBeenCalledTimes(1);
  });

  test("shutdown disposes cached and retiring providers exactly once", async () => {
    const { registry } = harness({ options: { providerRetirementGraceMs: 60_000 } });
    const retiring = fakeProvider("retiring");
    const cached = fakeProvider("cached");
    registry.cache(KEY, retiring.provider);
    registry.cache(KEY, cached.provider);
    registry.beginDispatch(cached.provider);

    await registry.shutdown();

    expect(retiring.dispose).toHaveBeenCalledTimes(1);
    expect(cached.dispose).toHaveBeenCalledTimes(1);
    expect(registry.cached(KEY)).toBeUndefined();
    expect(registry.hasDispatchInFlight(cached.provider)).toBe(false);
    expect(registry.stateForTesting().retiring.size).toBe(0);
  });

  test("a stopped service retires nothing and resolves nothing", async () => {
    const { registry, stop } = harness();
    const first = fakeProvider("first");
    registry.cache(KEY, first.provider);
    stop();

    registry.cache(KEY, fakeProvider("second").provider);
    expect(registry.stateForTesting().retiring.has(first.provider)).toBe(false);
    await expect(registry.resolve(INPUT)).rejects.toThrow("shut down");
    await expect(registry.observe(INPUT)).rejects.toThrow("shut down");
  });
});
