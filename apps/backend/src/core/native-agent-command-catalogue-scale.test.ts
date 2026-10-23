/**
 * Load qualification for the command catalogue (0015, "Performance"), as
 * counts and bytes rather than latency: same-key coalescing, provider probes
 * per operation, the cross-key read cap, and the retained-bytes budget under
 * maximal inventories. The real `HttpBridgeCatalogAdapter` reads from an
 * in-process fake bridge, so bridge requests are counted exactly. Latencies
 * are reported by `scripts/benchmark-slash-command-catalogue.ts`.
 */
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COMMAND_CATALOGUE_LIMITS,
  commandCatalogueBytes,
} from "@orkestrator/protocol/agent-command-catalogue";
import type {
  NativeAgentRuntimeProvider,
  ProviderCommandCatalogue,
  ProviderStatus,
} from "./agent-provider-contract.js";
import { HttpBridgeCatalogAdapter } from "./http-bridge-catalog.js";
import {
  COMMAND_CATALOGUE_MAX_BYTES,
  COMMAND_CATALOGUE_MAX_CONCURRENT_READS,
  COMMAND_CATALOGUE_MAX_ENTRIES,
  COMMAND_CATALOGUE_MAX_QUEUED_READS,
  COMMAND_CATALOGUE_TTL_MS,
  NativeAgentCommandCatalogueCache,
  commandCatalogueKey,
  type CommandCatalogueSnapshot,
} from "./native-agent-command-catalogue.js";
import {
  bridgeCataloguePayload,
  fakeCatalogueBridge,
  syntheticCommandRows,
  type FakeCatalogueBridge,
} from "./native-agent-command-catalogue-test-support.js";
import { NativeAgentService } from "./native-agent-service.js";
import { StorageService } from "./storage.js";

const KEY = commandCatalogueKey("env-1", "claude", "s1");
const PAYLOAD_100 = bridgeCataloguePayload(syntheticCommandRows(100));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Hold every bridge request until `open()`, tracking the in-flight peak. */
function gate(bridge: FakeCatalogueBridge) {
  const barrier = deferred();
  const inner = bridge.fetch;
  const counters = { active: 0, peak: 0 };
  bridge.fetch = (async (...args: Parameters<typeof fetch>) => {
    counters.active += 1;
    counters.peak = Math.max(counters.peak, counters.active);
    await barrier.promise;
    try {
      return await inner(...args);
    } finally {
      counters.active -= 1;
    }
  }) as typeof fetch;
  return { open: barrier.resolve, counters };
}

function counted(bridge: FakeCatalogueBridge) {
  const adapter = new HttpBridgeCatalogAdapter("claude", bridge.connection, bridge.fetch);
  const counts = { reads: 0, refreshes: 0 };
  const provider = {
    commandCatalogue: (sessionId?: string) => {
      counts.reads += 1;
      return adapter.commandCatalogue(sessionId);
    },
    refreshCommands: (sessionId?: string) => {
      counts.refreshes += 1;
      return adapter.refreshCommands(sessionId);
    },
  } as unknown as NativeAgentRuntimeProvider;
  return { provider, counts };
}

function harness() {
  const clock = { now: 1_000_000 };
  const cache = new NativeAgentCommandCatalogueCache({
    now: () => clock.now,
    announce: () => undefined,
    // Never let a test's gated read publish `loading` on wall time.
    firstReadBudgetMs: 60_000,
  });
  return { cache, clock };
}

/** The bytes the cache charges for one stored snapshot, recomputed independently. */
function chargedBytes(snapshot: CommandCatalogueSnapshot): number {
  const { revision: _revision, fetchedAt: _fetchedAt, ...semantic } = snapshot.state;
  return (
    commandCatalogueBytes(snapshot.commands) + JSON.stringify([snapshot.commands, semantic]).length
  );
}

describe("command catalogue under load", () => {
  test("concurrent cold reads and dispatch reads for one key share one provider read", async () => {
    const bridge = fakeCatalogueBridge(PAYLOAD_100);
    const held = gate(bridge);
    const { provider, counts } = counted(bridge);
    const { cache } = harness();
    const pending = Array.from({ length: 32 }, (_, index) =>
      index % 2
        ? cache.read(KEY, "env-1", provider, "s1")
        : cache.readForDispatch(KEY, "env-1", provider, "s1"),
    );
    await Bun.sleep(0);
    held.open();
    const snapshots = await Promise.all(pending);
    expect(counts.reads).toBe(1);
    expect(bridge.requests).toEqual(["/session/s1/commands"]);
    for (const snapshot of snapshots) {
      expect(snapshot.state.status).toBe("ready");
      expect(snapshot.commands).toHaveLength(100);
    }
  });

  test("concurrent reads of an expired entry serve the retained list and revalidate once", async () => {
    const bridge = fakeCatalogueBridge(PAYLOAD_100);
    const { provider, counts } = counted(bridge);
    const { cache, clock } = harness();
    await cache.read(KEY, "env-1", provider, "s1");
    clock.now += COMMAND_CATALOGUE_TTL_MS + 1;
    const held = gate(bridge);
    // The adapter captured the ungated fetch; route the next reads through the gate.
    const gated = counted(bridge);
    const snapshots = await Promise.all(
      Array.from({ length: 32 }, () => cache.read(KEY, "env-1", gated.provider, "s1")),
    );
    expect(snapshots.every((snapshot) => snapshot.commands.length === 100)).toBe(true);
    held.open();
    await cache.settle();
    expect(counts.reads).toBe(1);
    expect(gated.counts.reads).toBe(1);
    expect(bridge.requests).toHaveLength(2);
  });

  test("concurrent refreshes coalesce into one running and one queued refresh", async () => {
    const bridge = fakeCatalogueBridge(PAYLOAD_100);
    const held = gate(bridge);
    const { provider, counts } = counted(bridge);
    const { cache } = harness();
    const refreshes = 50;
    const first = cache.refresh(KEY, "env-1", provider, "s1");
    await Bun.sleep(0);
    // Every later caller arrived after the first started, so they share the
    // one refresh queued behind it, which starts after all of their requests.
    const later = Array.from({ length: refreshes - 1 }, () =>
      cache.refresh(KEY, "env-1", provider, "s1"),
    );
    held.open();
    const results = await Promise.all([first, ...later]);
    await cache.settle();
    expect(results.every((result) => result.outcome === "reloaded")).toBe(true);
    expect(counts.refreshes).toBe(2);
    expect(counts.reads).toBe(2);
    expect(cache.peek(KEY)?.state.status).toBe("ready");
    expect(cache.peek(KEY)?.state.lastRefresh?.outcome).toBe("reloaded");
    expect(cache.peek(KEY)?.commands).toHaveLength(100);
  });

  test("a third refresh arriving while the queued refresh runs gets its own inventory", async () => {
    const bridge = fakeCatalogueBridge(PAYLOAD_100);
    const { provider, counts } = counted(bridge);
    const { cache } = harness();
    const gates = [deferred(), deferred(), deferred()];
    const started = [deferred(), deferred(), deferred()];
    const originalRefresh = provider.refreshCommands!;
    let reloads = 0;
    let active = 0;
    let peak = 0;
    provider.refreshCommands = async (sessionId) => {
      const index = reloads++;
      active += 1;
      peak = Math.max(peak, active);
      started[index]!.resolve();
      await gates[index]!.promise;
      try {
        bridge.setPayload(bridgeCataloguePayload(syntheticCommandRows(index + 1)));
        return await originalRefresh(sessionId);
      } finally {
        active -= 1;
      }
    };
    const first = cache.refresh(KEY, "env-1", provider, "s1");
    await started[0]!.promise;
    const second = cache.refresh(KEY, "env-1", provider, "s1");
    gates[0]!.resolve();
    await started[1]!.promise;
    const third = cache.refresh(KEY, "env-1", provider, "s1").then((outcome) => ({
      outcome,
      commands: cache.peek(KEY)?.commands,
    }));
    expect(reloads).toBe(2);
    gates[1]!.resolve();
    await started[2]!.promise;
    expect((await first).outcome).toBe("reloaded");
    expect((await second).outcome).toBe("reloaded");
    gates[2]!.resolve();
    const result = await third;
    expect(result.outcome.outcome).toBe("reloaded");
    expect(result.commands).toHaveLength(3);
    expect(counts.refreshes).toBe(3);
    expect(counts.reads).toBe(3);
    expect(peak).toBe(1);
    await cache.settle();
  });

  test("bridge requests per operation", async () => {
    const expectations: Array<{
      legacy: boolean;
      operations: Array<[string, number, string[]]>;
    }> = [
      {
        legacy: false,
        operations: [
          ["cold read", 1, ["/session/s1/commands"]],
          ["warm read", 0, []],
          ["warm dispatch", 0, []],
          ["forced dispatch", 1, ["/session/s1/commands"]],
          ["expired read", 1, ["/session/s1/commands"]],
          ["refresh", 1, ["/session/s1/commands/refresh", "/session/s1/commands"]],
        ],
      },
      {
        legacy: true,
        operations: [
          ["cold read", 1, ["/session/s1/commands", "/plugins/commands"]],
          ["warm read", 0, []],
          ["warm dispatch", 0, []],
          ["forced dispatch", 1, ["/session/s1/commands", "/plugins/commands"]],
          ["expired read", 1, ["/session/s1/commands", "/plugins/commands"]],
          [
            "refresh",
            1,
            ["/session/s1/commands/refresh", "/session/s1/commands", "/plugins/commands"],
          ],
        ],
      },
    ];
    for (const { legacy, operations } of expectations) {
      const bridge = fakeCatalogueBridge(PAYLOAD_100, { legacy });
      const { provider, counts } = counted(bridge);
      const { cache, clock } = harness();
      const run: Record<string, () => Promise<unknown>> = {
        "cold read": () => cache.read(KEY, "env-1", provider, "s1"),
        "warm read": () => cache.read(KEY, "env-1", provider, "s1"),
        "warm dispatch": () => cache.readForDispatch(KEY, "env-1", provider, "s1"),
        "forced dispatch": () => cache.readForDispatch(KEY, "env-1", provider, "s1", true),
        "expired read": () => {
          clock.now += COMMAND_CATALOGUE_TTL_MS + 1;
          return cache.read(KEY, "env-1", provider, "s1");
        },
        refresh: () => cache.refresh(KEY, "env-1", provider, "s1"),
      };
      for (const [operation, reads, requests] of operations) {
        const readsBefore = counts.reads;
        const requestsBefore = bridge.requests.length;
        await run[operation]!();
        await cache.settle();
        expect({ legacy, operation, reads: counts.reads - readsBefore }).toEqual({
          legacy,
          operation,
          reads,
        });
        expect(bridge.requests.slice(requestsBefore)).toEqual(requests);
      }
    }
  });

  test("cold reads across keys never exceed the read cap, and overflow past the queue fails fast", async () => {
    const bridge = fakeCatalogueBridge(PAYLOAD_100);
    const held = gate(bridge);
    const { provider, counts } = counted(bridge);
    const { cache } = harness();
    const keys = COMMAND_CATALOGUE_MAX_CONCURRENT_READS + COMMAND_CATALOGUE_MAX_QUEUED_READS + 32;
    const pending = Array.from({ length: keys }, (_, index) =>
      cache.readForDispatch(
        commandCatalogueKey("env-1", "claude", `k${index}`),
        "env-1",
        provider,
        `k${index}`,
      ),
    );
    await Bun.sleep(0);
    expect(counts.reads).toBe(COMMAND_CATALOGUE_MAX_CONCURRENT_READS);
    held.open();
    const snapshots = await Promise.all(pending);
    await cache.settle();
    expect(held.counters.peak).toBe(COMMAND_CATALOGUE_MAX_CONCURRENT_READS);
    const admitted = COMMAND_CATALOGUE_MAX_CONCURRENT_READS + COMMAND_CATALOGUE_MAX_QUEUED_READS;
    expect(counts.reads).toBe(admitted);
    expect(snapshots.filter((snapshot) => snapshot.state.status === "ready")).toHaveLength(
      admitted,
    );
    // Refused reads never become an authoritative empty list.
    const refused = snapshots.filter((snapshot) => snapshot.state.status !== "ready");
    expect(refused).toHaveLength(keys - admitted);
    expect(refused.every((snapshot) => snapshot.state.status === "unavailable")).toBe(true);
  });

  test("256 maximal inventories stay within the byte budget with exact accounting and LRU eviction", async () => {
    const payload = bridgeCataloguePayload(syntheticCommandRows(512, "wire-max"));
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(COMMAND_CATALOGUE_LIMITS.maxWireBytes);
    const bridge = fakeCatalogueBridge(payload);
    const { provider, counts } = counted(bridge);
    const { cache } = harness();
    const keyFor = (index: number) => commandCatalogueKey("env-1", "claude", `s${index}`);
    let perEntry = 0;
    for (let index = 0; index < COMMAND_CATALOGUE_MAX_ENTRIES; index += 1) {
      const snapshot = await cache.read(keyFor(index), "env-1", provider, `s${index}`);
      expect(snapshot.commands).toHaveLength(512);
      perEntry ||= chargedBytes(snapshot);
      expect(cache.retainedBytes).toBeLessThanOrEqual(COMMAND_CATALOGUE_MAX_BYTES);
    }
    expect(counts.reads).toBe(COMMAND_CATALOGUE_MAX_ENTRIES);
    // Charged at roughly twice the wire size: the rows plus their signature.
    expect(perEntry).toBeGreaterThan(Buffer.byteLength(payload));
    const fits = Math.floor(COMMAND_CATALOGUE_MAX_BYTES / perEntry);
    expect(cache.size).toBe(fits);
    expect(cache.retainedBytes).toBe(fits * perEntry);
    const retained: number[] = [];
    let recomputed = 0;
    for (let index = 0; index < COMMAND_CATALOGUE_MAX_ENTRIES; index += 1) {
      const snapshot = cache.peek(keyFor(index));
      if (!snapshot) continue;
      retained.push(index);
      recomputed += chargedBytes(snapshot);
    }
    expect(recomputed).toBe(cache.retainedBytes);
    // Least recently used went first: the survivors are the newest keys.
    expect(retained).toEqual(
      Array.from({ length: fits }, (_, offset) => COMMAND_CATALOGUE_MAX_ENTRIES - fits + offset),
    );

    // A read refreshes recency: the oldest survivor outlives the next insert.
    const oldest = retained[0]!;
    await cache.read(keyFor(oldest), "env-1", provider, `s${oldest}`);
    await cache.read(keyFor(1_000), "env-1", provider, "s1000");
    expect(cache.peek(keyFor(oldest))).toBeDefined();
    expect(cache.peek(keyFor(retained[1]!))).toBeUndefined();
    expect(cache.retainedBytes).toBeLessThanOrEqual(COMMAND_CATALOGUE_MAX_BYTES);

    // Forgetting the environment releases every byte.
    cache.forgetEnvironment("env-1");
    expect(cache.size).toBe(0);
    expect(cache.retainedBytes).toBe(0);
  });

  test("small inventories are bounded by the entry cap instead", async () => {
    const bridge = fakeCatalogueBridge(bridgeCataloguePayload(syntheticCommandRows(10)));
    const { provider } = counted(bridge);
    const { cache } = harness();
    for (let index = 0; index < COMMAND_CATALOGUE_MAX_ENTRIES + 20; index += 1) {
      await cache.read(
        commandCatalogueKey("env-1", "claude", `s${index}`),
        "env-1",
        provider,
        `s${index}`,
      );
    }
    expect(cache.size).toBe(COMMAND_CATALOGUE_MAX_ENTRIES);
    expect(cache.retainedBytes).toBeLessThan(COMMAND_CATALOGUE_MAX_BYTES);
    expect(cache.peek(commandCatalogueKey("env-1", "claude", "s19"))).toBeUndefined();
    expect(cache.peek(commandCatalogueKey("env-1", "claude", "s20"))).toBeDefined();
  });
});

describe("projection catalogue reads", () => {
  test("repeated projection reads cost one provider read per session until the entry expires", async () => {
    const bridge = fakeCatalogueBridge(
      bridgeCataloguePayload(syntheticCommandRows(512, "wire-max")),
    );
    const adapter = new HttpBridgeCatalogAdapter("claude", bridge.connection, bridge.fetch);
    let reads = 0;
    let sessions = 0;
    const provider = {
      agent: "claude",
      createSession: async () => `provider-session-${(sessions += 1)}`,
      registerSession: () => undefined,
      send: async () => undefined,
      status: async () => "idle" as ProviderStatus,
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
      commandCatalogue: (sessionId?: string): Promise<ProviderCommandCatalogue> => {
        reads += 1;
        return adapter.commandCatalogue(sessionId);
      },
      dispose: async () => undefined,
    } as unknown as NativeAgentRuntimeProvider;
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-catalogue-scale-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Environment",
      branch: "main",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: "/tmp/env-1",
      setupScriptsComplete: true,
    });
    const service = new NativeAgentService(
      storage,
      async <T>(name: string): Promise<T> => {
        throw new Error(`Unexpected backend command: ${name}`);
      },
      { provider: async () => provider },
    );
    try {
      const tabs = ["tab-1", "tab-2"].map((tab) => ({
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: `env-env-1:${tab}`,
      }));
      for (const input of tabs) {
        await service.ensureSession(input);
        expect(reads).toBe(tabs.indexOf(input));
        for (let index = 0; index < 5; index += 1) {
          const projection = await service.getProjection(input);
          expect(projection?.slashCommandCatalogue?.status).toBe("ready");
          expect(
            projection?.slashCommands?.filter((row) => row.executionKind !== "session-action"),
          ).toHaveLength(512);
        }
        expect(reads).toBe(tabs.indexOf(input) + 1);
      }
      expect(bridge.requests).toEqual([
        "/session/provider-session-1/commands",
        "/session/provider-session-2/commands",
      ]);
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
