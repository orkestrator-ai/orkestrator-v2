import { describe, expect, test } from "bun:test";
import { gaugeTrends, soakCacheGauges } from "../../scripts/recurring-live-ab-summary";

describe("soak cache gauges", () => {
  test("reads the caches block as cache:<name>:<field> counts", () => {
    expect(
      soakCacheGauges({
        recurringWork: {
          caches: [
            { name: "storage-row-cache", sources: 2, gauges: { stores: 12, rows: 340 } },
            { name: "worktree-snapshots", sources: 1, gauges: { entries: 3, treeBytes: 0 } },
          ],
        },
      }),
    ).toEqual({
      "cache:storage-row-cache:sources": 2,
      "cache:storage-row-cache:stores": 12,
      "cache:storage-row-cache:rows": 340,
      "cache:worktree-snapshots:sources": 1,
      "cache:worktree-snapshots:entries": 3,
      "cache:worktree-snapshots:treeBytes": 0,
    });
  });

  test("drops anything that is not a named count, and reads an older backend as unmeasured", () => {
    expect(
      soakCacheGauges({
        recurringWork: {
          caches: [
            null,
            { name: "/etc/passwd", gauges: { entries: 1 } },
            { name: "local-git-scan", gauges: { "/tmp/worktree": 1, counts: "7", worktrees: 2 } },
          ],
        },
      }),
    ).toEqual({ "cache:local-git-scan:worktrees": 2 });
    expect(soakCacheGauges({ recurringWork: { schedulers: [] } })).toBeNull();
    expect(soakCacheGauges(null)).toBeNull();
  });
});

describe("soak gauge trends", () => {
  const series = (values: number[]) => values.map((value) => ({ gauge: value }));

  test("a warm-up that plateaus, and a gauge that tracks open environments, are not rising", () => {
    const [plateau] = gaugeTrends(series([1, 5, 9, 10, 10, 10, 10, 10, 10]));
    expect(plateau).toMatchObject({ first: 1, last: 10, earlyMax: 9, lateMin: 10, growing: false });
    const [tracking] = gaugeTrends(series([2, 3, 2, 3, 2, 3, 2, 3, 2]));
    expect(tracking?.growing).toBe(false);
  });

  test("a gauge that climbs through the whole soak is rising", () => {
    const [climbing] = gaugeTrends(series([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(climbing).toMatchObject({ first: 1, last: 9, earlyMax: 3, lateMin: 7, growing: true });
    // One step up between the first and second third, then flat: it settled.
    const [stepped] = gaugeTrends(series([1, 1, 1, 4, 4, 4, 4, 4, 4]));
    expect(stepped?.growing).toBe(false);
  });

  test("needs six readings, skips unreadable ones, and counts a vanished gauge as zero", () => {
    expect(gaugeTrends(series([1, 2, 3, 4, 5]))).toEqual([]);
    expect(gaugeTrends([...series([1, 2, 3, 4, 5]), null])).toEqual([]);
    const trends = gaugeTrends([
      { kept: 1, gone: 4 },
      { kept: 1, gone: 4 },
      { kept: 1 },
      { kept: 1 },
      { kept: 1 },
      { kept: 1 },
    ]);
    expect(trends.map((trend) => [trend.gauge, trend.last, trend.growing])).toEqual([
      ["gone", 0, false],
      ["kept", 1, false],
    ]);
  });
});
