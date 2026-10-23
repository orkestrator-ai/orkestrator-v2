/**
 * Slash-command catalogue performance qualification (0015, "Performance").
 *
 * Drives the real backend read path with synthetic inventories served by an
 * in-process fake bridge: `HttpBridgeCatalogAdapter` (bounded JSON read and
 * protocol normalization) behind `NativeAgentCommandCatalogueCache`, and the
 * projection read (`NativeAgentService.getProjection`) on top of it. Also
 * measures the renderer's picker filter (`rankSlashCommands`) per keystroke.
 *
 * No network, no provider process, no filesystem scan. Inventories are
 * seeded, so every count and byte figure is deterministic; only latencies and
 * heap figures vary between runs.
 *
 *   bun scripts/benchmark-slash-command-catalogue.ts            # Markdown
 *   bun scripts/benchmark-slash-command-catalogue.ts --json     # JSON
 *   bun scripts/benchmark-slash-command-catalogue.ts --quick    # fewer samples
 */
import { promises as fs } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import path from "node:path";
import {
  COMMAND_CATALOGUE_LIMITS,
  commandCatalogueBytes,
  normalizeCommandCataloguePayload,
} from "@orkestrator/protocol/agent-command-catalogue";
import type { NativeAgentSlashCommand } from "@orkestrator/protocol/native-agent";
import type {
  NativeAgentRuntimeProvider,
  ProviderCommandCatalogue,
  ProviderStatus,
} from "../apps/backend/src/core/agent-provider-contract";
import { HttpBridgeCatalogAdapter } from "../apps/backend/src/core/http-bridge-catalog";
import {
  COMMAND_CATALOGUE_MAX_BYTES,
  COMMAND_CATALOGUE_MAX_CONCURRENT_READS,
  COMMAND_CATALOGUE_MAX_ENTRIES,
  COMMAND_CATALOGUE_MAX_QUEUED_READS,
  NativeAgentCommandCatalogueCache,
  commandCatalogueKey,
} from "../apps/backend/src/core/native-agent-command-catalogue";
import {
  bridgeCataloguePayload,
  fakeCatalogueBridge,
  syntheticCommandRows,
  type SyntheticInventoryProfile,
} from "../apps/backend/src/core/native-agent-command-catalogue-test-support";
import { NativeAgentService } from "../apps/backend/src/core/native-agent-service";
import { StorageService } from "../apps/backend/src/core/storage";
import { rankSlashCommands } from "../apps/web/src/lib/chat/slash-command-search";

export const BENCHMARK_SCHEMA = "orkestrator.slash-command-catalogue-benchmark.v1";

interface Scenario {
  label: string;
  rows: number;
  profile: SyntheticInventoryProfile;
}

const SCENARIOS: Scenario[] = [
  { label: "10", rows: 10, profile: "realistic" },
  { label: "100", rows: 100, profile: "realistic" },
  { label: "1,000 (truncated to 512)", rows: 1_000, profile: "realistic" },
  { label: "512 wire-max", rows: COMMAND_CATALOGUE_LIMITS.maxCommands, profile: "wire-max" },
];

interface Stats {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

function stats(values: number[]): Stats {
  const sorted = values.toSorted((left, right) => left - right);
  const at = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
  const round = (value: number) => Math.round(value * 1_000) / 1_000;
  return {
    samples: sorted.length,
    p50Ms: round(at(0.5)),
    p95Ms: round(at(0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function adapterProvider(bridge: ReturnType<typeof fakeCatalogueBridge>) {
  const adapter = new HttpBridgeCatalogAdapter("claude", bridge.connection, bridge.fetch);
  let reads = 0;
  let refreshes = 0;
  const provider = {
    commandCatalogue: (sessionId?: string) => {
      reads += 1;
      return adapter.commandCatalogue(sessionId);
    },
    refreshCommands: (sessionId?: string) => {
      refreshes += 1;
      return adapter.refreshCommands(sessionId);
    },
  } as unknown as NativeAgentRuntimeProvider;
  return {
    provider,
    get reads() {
      return reads;
    },
    get refreshes() {
      return refreshes;
    },
  };
}

function newCache(overrides: Partial<{ now: () => number; firstReadBudgetMs: number }> = {}) {
  return new NativeAgentCommandCatalogueCache({
    now: overrides.now ?? (() => Date.now()),
    announce: () => undefined,
    ...(overrides.firstReadBudgetMs !== undefined
      ? { firstReadBudgetMs: overrides.firstReadBudgetMs }
      : {}),
  });
}

/** Cold and warm `read()` through the cache and the HTTP adapter. */
async function cacheLatency(scenario: Scenario, coldSamples: number, warmSamples: number) {
  const payload = bridgeCataloguePayload(syntheticCommandRows(scenario.rows, scenario.profile));
  const bridge = fakeCatalogueBridge(payload);
  const source = adapterProvider(bridge);
  const cache = newCache();
  const cold: number[] = [];
  let lastStatus = "";
  let rowsReturned = 0;
  // Warm-up the JIT on a throwaway key so sample 0 is not an outlier.
  await cache.read(commandCatalogueKey("env-w", "claude", "w"), "env-w", source.provider, "w");
  const readsBefore = source.reads;
  const requestsBefore = bridge.requests.length;
  for (let index = 0; index < coldSamples; index += 1) {
    const sessionId = `cold-${index}`;
    const started = performance.now();
    const snapshot = await cache.read(
      commandCatalogueKey("env-1", "claude", sessionId),
      "env-1",
      source.provider,
      sessionId,
    );
    cold.push(performance.now() - started);
    lastStatus = snapshot.state.status;
    rowsReturned = snapshot.commands.length;
  }
  const coldReads = source.reads - readsBefore;
  const coldRequests = bridge.requests.length - requestsBefore;
  const warmKey = commandCatalogueKey("env-1", "claude", `cold-${coldSamples - 1}`);
  const warm: number[] = [];
  const warmReadsBefore = source.reads;
  for (let index = 0; index < warmSamples; index += 1) {
    const started = performance.now();
    await cache.read(warmKey, "env-1", source.provider, `cold-${coldSamples - 1}`);
    warm.push(performance.now() - started);
  }
  const warmDispatch: number[] = [];
  for (let index = 0; index < warmSamples; index += 1) {
    const started = performance.now();
    await cache.readForDispatch(warmKey, "env-1", source.provider, `cold-${coldSamples - 1}`);
    warmDispatch.push(performance.now() - started);
  }
  const normalized = normalizeCommandCataloguePayload(JSON.parse(payload));
  cache.clear();
  return {
    wireBytes: Buffer.byteLength(payload),
    rowsServed: scenario.rows,
    rowsReturned,
    truncated: normalized.truncated,
    lastStatus,
    cold: stats(cold),
    coldProviderReadsPerRead: coldReads / coldSamples,
    coldBridgeRequestsPerRead: coldRequests / coldSamples,
    warm: stats(warm),
    warmDispatch: stats(warmDispatch),
    warmProviderReads: source.reads - warmReadsBefore,
    /** `commandCatalogueBytes` of the kept rows (the cache adds its signature). */
    rowBytes: commandCatalogueBytes(normalized.commands),
  };
}

/** Cold (first) and warm projection reads through `NativeAgentService`. */
async function projectionLatency(scenario: Scenario, samples: number) {
  const payload = bridgeCataloguePayload(syntheticCommandRows(scenario.rows, scenario.profile));
  const bridge = fakeCatalogueBridge(payload);
  const adapter = new HttpBridgeCatalogAdapter("claude", bridge.connection, bridge.fetch);
  let catalogueReads = 0;
  let sessionCounter = 0;
  const provider = {
    agent: "claude",
    createSession: async () => `provider-session-${(sessionCounter += 1)}`,
    registerSession: () => undefined,
    send: async () => undefined,
    status: async () => "idle" as ProviderStatus,
    messages: async () => [],
    structured: async () => null,
    abort: async () => undefined,
    commandCatalogue: (sessionId?: string): Promise<ProviderCommandCatalogue> => {
      catalogueReads += 1;
      return adapter.commandCatalogue(sessionId);
    },
    dispose: async () => undefined,
  } as unknown as NativeAgentRuntimeProvider;
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-slash-catalogue-bench-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "Benchmark",
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
    worktreePath: path.join(dataDir, "worktree"),
    setupScriptsComplete: true,
  });
  const service = new NativeAgentService(
    storage,
    async <T>(name: string): Promise<T> => {
      throw new Error(`Unexpected backend command: ${name}`);
    },
    { provider: async () => provider },
  );
  const cold: number[] = [];
  const warm: number[] = [];
  let ensureReads = 0;
  let coldReads = 0;
  let warmReads = 0;
  let projectedRows = 0;
  let projectedStatus = "";
  try {
    for (let index = -1; index < samples; index += 1) {
      const input = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: `env-env-1:tab-${index + 1}`,
      };
      const beforeEnsure = catalogueReads;
      await service.ensureSession(input);
      const beforeCold = catalogueReads;
      let started = performance.now();
      const first = await service.getProjection(input);
      const coldMs = performance.now() - started;
      const beforeWarm = catalogueReads;
      started = performance.now();
      await service.getProjection(input);
      const warmMs = performance.now() - started;
      if (index < 0) continue; // warm-up
      ensureReads += beforeCold - beforeEnsure;
      coldReads += beforeWarm - beforeCold;
      warmReads += catalogueReads - beforeWarm;
      cold.push(coldMs);
      warm.push(warmMs);
      projectedRows = first?.slashCommands?.length ?? 0;
      projectedStatus = first?.slashCommandCatalogue?.status ?? "none";
    }
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
  return {
    cold: stats(cold),
    warm: stats(warm),
    providerReadsPerEnsure: ensureReads / samples,
    providerReadsPerColdProjection: coldReads / samples,
    providerReadsPerWarmProjection: warmReads / samples,
    projectedRows,
    projectedStatus,
  };
}

/** Provider and bridge request counts per cache operation. */
async function probeCounts() {
  const payload = bridgeCataloguePayload(syntheticCommandRows(100));
  const results: Array<{ operation: string; providerReads: number; bridgeRequests: string[] }> = [];
  for (const legacy of [false, true]) {
    let now = 1_000_000;
    const bridge = fakeCatalogueBridge(payload, { legacy });
    const source = adapterProvider(bridge);
    const cache = newCache({ now: () => now });
    const key = commandCatalogueKey("env-1", "claude", "s1");
    const measure = async (operation: string, run: () => Promise<unknown>) => {
      const reads = source.reads;
      const requests = bridge.requests.length;
      await run();
      await cache.settle();
      results.push({
        operation: `${legacy ? "legacy bridge: " : ""}${operation}`,
        providerReads: source.reads - reads,
        bridgeRequests: bridge.requests
          .slice(requests)
          .map((request) => request.replace(/^\/session\/[^/]+/, "/session/:id")),
      });
    };
    await measure("cold read", () => cache.read(key, "env-1", source.provider, "s1"));
    await measure("warm read", () => cache.read(key, "env-1", source.provider, "s1"));
    await measure("warm readForDispatch", () =>
      cache.readForDispatch(key, "env-1", source.provider, "s1"),
    );
    await measure("forced readForDispatch (selection not found)", () =>
      cache.readForDispatch(key, "env-1", source.provider, "s1", true),
    );
    now += 30_001;
    await measure("expired read (stale-while-revalidate)", () =>
      cache.read(key, "env-1", source.provider, "s1"),
    );
    await measure("explicit refresh", () => cache.refresh(key, "env-1", source.provider, "s1"));
    cache.clear();
  }
  return results;
}

/** N concurrent operations on one key against a gated bridge. */
async function coalescing(concurrency: number) {
  const payload = bridgeCataloguePayload(syntheticCommandRows(100));
  const run = async (
    operation: string,
    start: (
      cache: NativeAgentCommandCatalogueCache,
      provider: NativeAgentRuntimeProvider,
      index: number,
    ) => Promise<unknown>,
    prime = false,
  ) => {
    let now = 1_000_000;
    const bridge = fakeCatalogueBridge(payload);
    const gate = deferred<void>();
    const inner = bridge.fetch;
    let gated = !prime;
    bridge.fetch = (async (...args: Parameters<typeof fetch>) => {
      if (gated) await gate.promise;
      return inner(...args);
    }) as typeof fetch;
    const source = adapterProvider(bridge);
    const cache = new NativeAgentCommandCatalogueCache({
      now: () => now,
      announce: () => undefined,
      firstReadBudgetMs: 60_000,
    });
    const key = commandCatalogueKey("env-1", "claude", "s1");
    if (prime) {
      await cache.read(key, "env-1", source.provider, "s1");
      now += 30_001;
      gated = true;
    }
    const readsBefore = source.reads;
    const refreshesBefore = source.refreshes;
    const pending = Array.from({ length: concurrency }, (_, index) =>
      start(cache, source.provider, index),
    );
    await Bun.sleep(0);
    gate.resolve();
    const settled = await Promise.allSettled(pending);
    await cache.settle();
    const result = {
      operation,
      concurrency,
      providerReads: source.reads - readsBefore,
      providerRefreshes: source.refreshes - refreshesBefore,
      rejected: settled.filter((entry) => entry.status === "rejected").length,
      /** Refresh outcomes reported to the callers (empty for plain reads). */
      refreshOutcomes: tally(
        settled.flatMap((entry) =>
          entry.status === "fulfilled" &&
          entry.value &&
          typeof entry.value === "object" &&
          "outcome" in entry.value
            ? [String(entry.value.outcome)]
            : [],
        ),
      ),
      finalStatus: cache.peek(key)?.state.status ?? "none",
    };
    cache.clear();
    return result;
  };
  const key = commandCatalogueKey("env-1", "claude", "s1");
  return [
    await run("cold read()", (cache, provider) => cache.read(key, "env-1", provider, "s1")),
    await run("cold readForDispatch()", (cache, provider) =>
      cache.readForDispatch(key, "env-1", provider, "s1"),
    ),
    await run("cold read() + readForDispatch() mixed", (cache, provider, index) =>
      index % 2
        ? cache.read(key, "env-1", provider, "s1")
        : cache.readForDispatch(key, "env-1", provider, "s1"),
    ),
    await run(
      "expired read() (background revalidate)",
      (cache, provider) => cache.read(key, "env-1", provider, "s1"),
      true,
    ),
    await run("explicit refresh()", (cache, provider) =>
      cache.refresh(key, "env-1", provider, "s1"),
    ),
  ];
}

/** Concurrent cold reads across distinct keys against the read cap and queue. */
async function crossKeyAdmission(keys: number) {
  const payload = bridgeCataloguePayload(syntheticCommandRows(100));
  const bridge = fakeCatalogueBridge(payload);
  const gate = deferred<void>();
  const inner = bridge.fetch;
  let active = 0;
  let peak = 0;
  bridge.fetch = (async (...args: Parameters<typeof fetch>) => {
    active += 1;
    peak = Math.max(peak, active);
    await gate.promise;
    try {
      return await inner(...args);
    } finally {
      active -= 1;
    }
  }) as typeof fetch;
  const source = adapterProvider(bridge);
  const cache = newCache({ firstReadBudgetMs: 60_000 });
  const pending = Array.from({ length: keys }, (_, index) =>
    cache.readForDispatch(
      commandCatalogueKey("env-1", "claude", `k${index}`),
      "env-1",
      source.provider,
      `k${index}`,
    ),
  );
  await Bun.sleep(0);
  const startedWhileGated = source.reads;
  gate.resolve();
  const snapshots = await Promise.all(pending);
  await cache.settle();
  const statuses = tally(snapshots.map((snapshot) => snapshot.state.status));
  cache.clear();
  return {
    keys,
    cap: COMMAND_CATALOGUE_MAX_CONCURRENT_READS,
    queueCap: COMMAND_CATALOGUE_MAX_QUEUED_READS,
    peakConcurrentBridgeRequests: peak,
    providerReadsStartedWhileGated: startedWhileGated,
    providerReadsTotal: source.reads,
    statuses,
  };
}

function heapUsed(): number {
  Bun.gc(true);
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
}

/** Fill every entry slot with one inventory shape and watch accounting and eviction. */
async function retention(scenario: Scenario, keys: number) {
  const payload = bridgeCataloguePayload(syntheticCommandRows(scenario.rows, scenario.profile));
  const bridge = fakeCatalogueBridge(payload);
  const source = adapterProvider(bridge);
  const cache = newCache();
  const before = heapUsed();
  let peakRetained = 0;
  let overBudget = 0;
  for (let index = 0; index < keys; index += 1) {
    await cache.read(
      commandCatalogueKey(`env-${index % 16}`, "claude", `s${index}`),
      `env-${index % 16}`,
      source.provider,
      `s${index}`,
    );
    peakRetained = Math.max(peakRetained, cache.retainedBytes);
    if (cache.retainedBytes > COMMAND_CATALOGUE_MAX_BYTES) overBudget += 1;
  }
  const after = heapUsed();
  const result = {
    inventory: scenario.label,
    keysFilled: keys,
    providerReads: source.reads,
    entriesRetained: cache.size,
    evictions: keys - cache.size,
    retainedBytes: cache.retainedBytes,
    retainedBytesPerEntry: Math.round(cache.retainedBytes / Math.max(1, cache.size)),
    peakRetainedBytes: peakRetained,
    budgetBytes: COMMAND_CATALOGUE_MAX_BYTES,
    insertsOverBudget: overBudget,
    heapDeltaBytes: after - before,
    heapDeltaPerEntry: Math.round((after - before) / Math.max(1, cache.size)),
  };
  cache.clear();
  return result;
}

/** Picker filter cost per keystroke, as `useSlashCommandMenu` runs it. */
function filterLatency(scenario: Scenario, rounds: number) {
  const normalized = normalizeCommandCataloguePayload(
    JSON.parse(bridgeCataloguePayload(syntheticCommandRows(scenario.rows, scenario.profile))),
  ).commands;
  const typed = "team-tools:review-xy"; // 20 characters after the sigil
  const queries = Array.from({ length: typed.length + 1 }, (_, length) => typed.slice(0, length));
  const perKeystroke: number[] = [];
  const miss: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const query of queries) {
      const started = performance.now();
      rankSlashCommands<NativeAgentSlashCommand>(normalized, query);
      perKeystroke.push(performance.now() - started);
    }
    const started = performance.now();
    rankSlashCommands<NativeAgentSlashCommand>(normalized, "zzzz-no-match");
    miss.push(performance.now() - started);
  }
  return {
    rows: normalized.length,
    keystrokesPerRound: queries.length,
    perKeystroke: stats(perKeystroke),
    noMatchFullScan: stats(miss),
  };
}

async function main() {
  const json = process.argv.includes("--json");
  const quick = process.argv.includes("--quick");
  const coldSamples = quick ? 40 : 200;
  const warmSamples = quick ? 500 : 5_000;
  const projectionSamples = quick ? 10 : 40;
  const filterRounds = quick ? 20 : 200;

  const machine = {
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryBytes: totalmem(),
    platform: `${process.platform}-${process.arch}`,
    bun: Bun.version,
  };
  const scenarios = [];
  for (const scenario of SCENARIOS) {
    const cache = await cacheLatency(scenario, coldSamples, warmSamples);
    const projection = await projectionLatency(scenario, projectionSamples);
    const filter = filterLatency(scenario, filterRounds);
    scenarios.push({ scenario: scenario.label, cache, projection, filter });
  }
  const retentionResults = [
    await retention(SCENARIOS[1]!, COMMAND_CATALOGUE_MAX_ENTRIES),
    await retention(SCENARIOS[3]!, COMMAND_CATALOGUE_MAX_ENTRIES),
  ];
  const report = {
    schema: BENCHMARK_SCHEMA,
    machine,
    limits: {
      maxCommands: COMMAND_CATALOGUE_LIMITS.maxCommands,
      maxWireBytes: COMMAND_CATALOGUE_LIMITS.maxWireBytes,
      cacheMaxBytes: COMMAND_CATALOGUE_MAX_BYTES,
      cacheMaxEntries: COMMAND_CATALOGUE_MAX_ENTRIES,
      maxConcurrentReads: COMMAND_CATALOGUE_MAX_CONCURRENT_READS,
      maxQueuedReads: COMMAND_CATALOGUE_MAX_QUEUED_READS,
    },
    samples: { coldSamples, warmSamples, projectionSamples, filterRounds },
    scenarios,
    probeCounts: await probeCounts(),
    coalescing: await coalescing(50),
    crossKeyAdmission: [await crossKeyAdmission(16), await crossKeyAdmission(100)],
    retention: retentionResults,
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderMarkdown(report));
}

type Report = {
  machine: Record<string, unknown>;
  samples: Record<string, number>;
  scenarios: Array<{
    scenario: string;
    cache: Awaited<ReturnType<typeof cacheLatency>>;
    projection: Awaited<ReturnType<typeof projectionLatency>>;
    filter: ReturnType<typeof filterLatency>;
  }>;
  probeCounts: Awaited<ReturnType<typeof probeCounts>>;
  coalescing: Awaited<ReturnType<typeof coalescing>>;
  crossKeyAdmission: Array<Awaited<ReturnType<typeof crossKeyAdmission>>>;
  retention: Array<Awaited<ReturnType<typeof retention>>>;
};

function renderMarkdown(report: Report): string {
  const ms = (value: Stats) => `${value.p50Ms} / ${value.p95Ms}`;
  const lines = [
    "# Slash-command catalogue benchmark",
    "",
    `Machine: ${report.machine.cpu} (${report.machine.cores} cores), ${report.machine.platform}, Bun ${report.machine.bun}`,
    `Samples: ${JSON.stringify(report.samples)}`,
    "",
    "## Discovery latency (ms, p50 / p95)",
    "",
    "| Inventory | Wire bytes | Rows kept | Cache cold | Cache warm | Dispatch warm | Projection cold | Projection warm | Provider reads (cold / warm / projection cold / warm) | Filter per key | Filter no-match |",
    "| --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const { scenario, cache, projection, filter } of report.scenarios) {
    lines.push(
      `| ${scenario} | ${cache.wireBytes} | ${cache.rowsReturned}${cache.truncated ? " (truncated)" : ""} | ${ms(cache.cold)} | ${ms(cache.warm)} | ${ms(cache.warmDispatch)} | ${ms(projection.cold)} | ${ms(projection.warm)} | ${cache.coldProviderReadsPerRead} / ${cache.warmProviderReads} / ${projection.providerReadsPerColdProjection + projection.providerReadsPerEnsure} / ${projection.providerReadsPerWarmProjection} | ${ms(filter.perKeystroke)} | ${ms(filter.noMatchFullScan)} |`,
    );
  }
  lines.push(
    "",
    "## Probe count per operation",
    "",
    "| Operation | Provider reads | Bridge requests |",
    "| --- | ---: | --- |",
  );
  for (const row of report.probeCounts) {
    lines.push(
      `| ${row.operation} | ${row.providerReads} | ${row.bridgeRequests.join(", ") || "none"} |`,
    );
  }
  lines.push(
    "",
    "## Same-key coalescing",
    "",
    "| Operation | Concurrent | Provider reads | Provider refreshes | Rejected | Refresh outcomes | Final status |",
    "| --- | ---: | ---: | ---: | ---: | --- | --- |",
  );
  for (const row of report.coalescing) {
    lines.push(
      `| ${row.operation} | ${row.concurrency} | ${row.providerReads} | ${row.providerRefreshes} | ${row.rejected} | ${JSON.stringify(row.refreshOutcomes)} | ${row.finalStatus} |`,
    );
  }
  lines.push(
    "",
    "## Cross-key admission",
    "",
    "| Keys | Cap / queue | Peak concurrent | Started while gated | Total reads | Statuses |",
    "| ---: | --- | ---: | ---: | ---: | --- |",
  );
  for (const row of report.crossKeyAdmission) {
    lines.push(
      `| ${row.keys} | ${row.cap} / ${row.queueCap} | ${row.peakConcurrentBridgeRequests} | ${row.providerReadsStartedWhileGated} | ${row.providerReadsTotal} | ${JSON.stringify(row.statuses)} |`,
    );
  }
  lines.push(
    "",
    "## Retention (256 keys filled)",
    "",
    "| Inventory | Reads | Retained entries | Evictions | Retained bytes | Bytes / entry | Peak retained | Inserts over budget | Heap delta | Heap / entry |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const row of report.retention) {
    lines.push(
      `| ${row.inventory} | ${row.providerReads} | ${row.entriesRetained} | ${row.evictions} | ${row.retainedBytes} | ${row.retainedBytesPerEntry} | ${row.peakRetainedBytes} | ${row.insertsOverBudget} | ${row.heapDeltaBytes} | ${row.heapDeltaPerEntry} |`,
    );
  }
  return lines.join("\n");
}

if (import.meta.main) {
  await main();
}
