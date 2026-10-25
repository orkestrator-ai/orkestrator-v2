import { describe, expect, test } from "bun:test";
import {
  combineFootprints,
  parsePsCpuTime,
  parsePsRows,
  percentile,
  pickKindCounters,
  processTreeTotals,
  soakFootprint,
  soakLeaks,
  summarizeWindow,
  type LiveSample,
} from "../../scripts/recurring-live-ab-summary";

describe("recurring live A/B summary", () => {
  test("parses ps CPU time on macOS and Linux", () => {
    expect(parsePsCpuTime("0:01.25")).toBe(1_250);
    expect(parsePsCpuTime("12:03.50")).toBe(723_500);
    expect(parsePsCpuTime("01:02:03")).toBe(3_723_000);
    expect(parsePsCpuTime("2-01:00:00")).toBe(176_400_000);
    expect(parsePsCpuTime("n/a")).toBeNull();
  });

  test("keeps only counters, dropping unknown fields", () => {
    expect(
      pickKindCounters({
        "diff-scan": {
          started: 3,
          changed: 1,
          failed: 0,
          bytes: 9,
          workUnits: { "git-spawn": 6 },
          duration: {},
        },
        bad: null,
      }),
    ).toEqual({
      "diff-scan": { started: 3, changed: 1, failed: 0, bytes: 9, workUnits: { "git-spawn": 6 } },
    });
  });

  test("rates run from the first to the last sample that read metrics", () => {
    const kinds = (started: number, reads: number) => ({
      "feature-planning-tick": {
        started,
        changed: 0,
        failed: 0,
        bytes: 0,
        workUnits: { "storage-read": reads },
      },
    });
    const samples: LiveSample[] = [
      { atMs: 0, kinds: kinds(10, 10), processes: { backend: { cpuMs: 1_000, rssKiB: 100 } } },
      { atMs: 30_000, kinds: null, processes: { backend: { cpuMs: 1_500, rssKiB: 300 } } },
      {
        atMs: 120_000,
        kinds: kinds(14, 18),
        processes: { backend: { cpuMs: 3_000, rssKiB: 200 } },
      },
    ];
    const summary = summarizeWindow(samples);
    expect(summary.windowMs).toBe(120_000);
    expect(summary.kinds["feature-planning-tick"]).toEqual({
      observedMs: 120_000,
      partial: false,
      startedPerMinute: 2,
      changedPerMinute: 0,
      failedPerMinute: 0,
      bytesPerMinute: 0,
      workUnitsPerMinute: { "storage-read": 4 },
    });
    expect(summary.processes.backend).toEqual({
      cpuMsPerMinute: 1_000,
      rssKiBMedian: 200,
      rssKiBMax: 300,
    });
  });

  test("a counter that went backwards (a restart) is reported, not hidden", () => {
    const sample = (atMs: number, started: number): LiveSample => ({
      atMs,
      kinds: { "diff-scan": { started, changed: 0, failed: 0, bytes: 0, workUnits: {} } },
      processes: {},
    });
    const summary = summarizeWindow([sample(0, 50), sample(60_000, 5)]);
    expect(summary.kinds["diff-scan"]?.startedPerMinute).toBeNaN();
  });

  test("nearest-rank percentiles", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  test("totals a process alone or with its whole tree", () => {
    const rows = parsePsRows(
      [
        "  10     1  1000   0:01.00",
        "  11    10  2000   0:02.00",
        "  12    11  3000   0:03.00",
        "  13     1  9000   0:09.00",
        "garbage",
      ].join("\n"),
    );
    expect(rows).toHaveLength(4);
    expect(processTreeTotals(rows, 10, false)).toEqual({ cpuMs: 1_000, rssKiB: 1_000 });
    expect(processTreeTotals(rows, 10, true)).toEqual({ cpuMs: 6_000, rssKiB: 6_000 });
    expect(processTreeTotals(rows, 99, true)).toBeNull();
  });
});

describe("per-kind observation windows", () => {
  const counters = (started: number) => ({
    started,
    changed: started,
    failed: 0,
    bytes: started * 10,
    workUnits: { "storage-read": started },
  });
  const sample = (atMs: number, kinds: LiveSample["kinds"]): LiveSample => ({
    atMs,
    kinds,
    processes: {},
  });

  test("a new kind uses its first observed counter and interval", () => {
    const summary = summarizeWindow([
      sample(0, {}),
      sample(60_000, { late: counters(10) }),
      sample(120_000, { late: counters(14) }),
    ]);
    expect(summary.kinds.late).toEqual({
      observedMs: 60_000,
      partial: true,
      startedPerMinute: 4,
      changedPerMinute: 4,
      failedPerMinute: 0,
      bytesPerMinute: 40,
      workUnitsPerMinute: { "storage-read": 4 },
    });
  });

  test("a disappeared kind is retained over its observed interval", () => {
    const summary = summarizeWindow([
      sample(0, { early: counters(10) }),
      sample(60_000, { early: counters(14) }),
      sample(120_000, {}),
    ]);
    expect(summary.kinds.early).toMatchObject({
      observedMs: 60_000,
      partial: true,
      startedPerMinute: 4,
    });
  });

  test("one observation cannot establish a rate", () => {
    expect(
      summarizeWindow([sample(0, {}), sample(60_000, { late: counters(10) })]).kinds.late
        ?.startedPerMinute,
    ).toBeNaN();
  });

  test("resets and disappearances inside a window stay invalid even after counters recover", () => {
    const middles: Array<NonNullable<LiveSample["kinds"]>> = [{ scan: counters(1) }, {}];
    for (const middle of middles) {
      const summary = summarizeWindow([
        sample(0, { scan: counters(10) }),
        sample(60_000, middle),
        sample(120_000, { scan: counters(20) }),
      ]);
      expect(summary.kinds.scan?.startedPerMinute).toBeNaN();
      expect(summary.kinds.scan?.workUnitsPerMinute["storage-read"]).toBeNaN();
    }
  });
});

describe("soak footprint", () => {
  test("reads counts only, summing schedulers that share an owner", () => {
    const footprint = soakFootprint({
      stream: { open: 2, opened: 40 },
      terminalWebSocket: { open: 1, channelsOpen: 3 },
      recurringWork: {
        metrics: { kinds: { "diff-scan": { active: 1, started: 99 } } },
        schedulers: [
          {
            owner: "workflow",
            keys: 2,
            settling: 0,
            byKind: { "looped-review-tick": { keys: 2 } },
          },
          { owner: "workflow", keys: 3, settling: 1, byKind: {} },
        ],
        admission: [{ pool: "git-docker-scan", active: 1, waiting: 0, granted: 500 }],
        fetchPolicies: [
          { name: "container-git-fetch", status: { records: 1, containers: 1, inFlight: 0 } },
        ],
        signals: [{ name: "claude-state-signal", status: { containers: 1, rings: 7 } }],
      },
    });
    expect(footprint).toEqual({
      schedulers: 2,
      "scheduler:workflow:keys": 5,
      "scheduler:workflow:settling": 1,
      "scheduler:workflow:looped-review-tick": 2,
      pools: 1,
      "pool:git-docker-scan:active": 1,
      "pool:git-docker-scan:waiting": 0,
      "fetch:container-git-fetch:records": 1,
      "fetch:container-git-fetch:containers": 1,
      "fetch:container-git-fetch:inFlight": 0,
      "signal:claude-state-signal:containers": 1,
      "kind:diff-scan:active": 1,
      "stream:open": 2,
      "terminal:open": 1,
      "terminal:channels": 3,
    });
    expect(soakFootprint(null)).toBeNull();
    expect(soakFootprint({ stream: { open: 1 } })).toBeNull();
  });

  test("combines samples and reports only gauges that stayed above baseline", () => {
    const before = combineFootprints([{ a: 1, b: 2 }, null, { a: 3 }], "max")!;
    expect(before).toEqual({ a: 3, b: 2 });
    const after = combineFootprints(
      [
        { a: 4, b: 2, c: 1 },
        { a: 3, b: 5, c: 2 },
      ],
      "min",
    )!;
    expect(after).toEqual({ a: 3, b: 2, c: 1 });
    expect(soakLeaks(before, after)).toEqual([{ gauge: "c", baseline: 0, final: 1 }]);
    expect(combineFootprints([null], "min")).toBeNull();
  });
});
