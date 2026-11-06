import { expect, test } from "bun:test";
import {
  MAX_CACHE_GAUGE_FIELDS,
  MAX_DIAGNOSTIC_SOURCES,
  RecurringDiagnosticsRegistry,
} from "./recurring-diagnostics.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";

const snapshot = (registry: RecurringDiagnosticsRegistry) =>
  registry.snapshot(new RecurringWorkMetrics({ enabled: false }));

test("cache gauges are summed per name over live sources and leave on unregister", () => {
  const registry = new RecurringDiagnosticsRegistry();
  expect(snapshot(registry).caches).toEqual([]);
  const removeFirst = registry.addCacheSource("storage-row-cache", {
    cacheGauges: () => ({ connections: 1, stores: 3, rows: 10, bytes: 400 }),
  });
  const removeSecond = registry.addCacheSource("storage-row-cache", {
    cacheGauges: () => ({ connections: 1, stores: 1, rows: 2, bytes: 50 }),
  });
  registry.addCacheSource("local-git-scan", { cacheGauges: () => ({ worktrees: 2, counts: 7 }) });
  expect(snapshot(registry).caches).toEqual([
    {
      name: "storage-row-cache",
      sources: 2,
      gauges: { connections: 2, stores: 4, rows: 12, bytes: 450 },
    },
    { name: "local-git-scan", sources: 1, gauges: { worktrees: 2, counts: 7 } },
  ]);
  removeFirst();
  removeFirst();
  expect(snapshot(registry).caches[0]).toEqual({
    name: "storage-row-cache",
    sources: 1,
    gauges: { connections: 1, stores: 1, rows: 2, bytes: 50 },
  });
  removeSecond();
  expect(snapshot(registry).caches.map((entry) => entry.name)).toEqual(["local-git-scan"]);
});

test("cache gauges stay content-free: only short field names with finite, non-negative counts", () => {
  const registry = new RecurringDiagnosticsRegistry();
  registry.addCacheSource("worktree-snapshots", {
    cacheGauges: () => ({
      entries: 2,
      "/home/user/project": 1,
      "local:/tmp/worktree": 1,
      "with space": 1,
      Capitalised: 1,
      negative: -1,
      infinite: Number.POSITIVE_INFINITY,
      notANumber: Number.NaN,
      text: "secret" as unknown as number,
    }),
  });
  expect(snapshot(registry).caches).toEqual([
    { name: "worktree-snapshots", sources: 1, gauges: { entries: 2 } },
  ]);
});

test("a cache source's field count is bounded", () => {
  const registry = new RecurringDiagnosticsRegistry();
  const wide = Object.fromEntries(
    Array.from({ length: MAX_CACHE_GAUGE_FIELDS + 10 }, (_, index) => [`field${index}`, index]),
  );
  registry.addCacheSource("native-projection", { cacheGauges: () => wide });
  const gauges = snapshot(registry).caches[0]!.gauges;
  expect(Object.keys(gauges)).toHaveLength(MAX_CACHE_GAUGE_FIELDS);
});

test("a throwing cache source is skipped and counted; the others still report", () => {
  const registry = new RecurringDiagnosticsRegistry();
  registry.addCacheSource("change-tracking", {
    cacheGauges: () => {
      throw new Error("broken");
    },
  });
  registry.addCacheSource("change-tracking", { cacheGauges: () => ({ worktreeOwners: 1 }) });
  registry.addCacheSource("local-git-scan", {
    cacheGauges: () => {
      throw new Error("broken");
    },
  });
  const result = snapshot(registry);
  expect(result.faultedSources).toBe(2);
  expect(result.caches).toEqual([
    { name: "change-tracking", sources: 1, gauges: { worktreeOwners: 1 } },
  ]);
});

test("cache sources are bounded per name, and a refused registration counts as dropped", () => {
  const registry = new RecurringDiagnosticsRegistry();
  for (let index = 0; index < MAX_DIAGNOSTIC_SOURCES; index += 1) {
    registry.addCacheSource("storage-row-cache", { cacheGauges: () => ({ connections: 1 }) });
  }
  const refused = registry.addCacheSource("storage-row-cache", {
    cacheGauges: () => ({ connections: 1 }),
  });
  refused();
  // Another name has its own bound, and schedulers and pools are unaffected.
  registry.addCacheSource("local-git-scan", { cacheGauges: () => ({ worktrees: 0 }) });
  const result = snapshot(registry);
  expect(result.droppedSources).toBe(1);
  expect(result.caches).toEqual([
    {
      name: "storage-row-cache",
      sources: MAX_DIAGNOSTIC_SOURCES,
      gauges: { connections: MAX_DIAGNOSTIC_SOURCES },
    },
    { name: "local-git-scan", sources: 1, gauges: { worktrees: 0 } },
  ]);
});
