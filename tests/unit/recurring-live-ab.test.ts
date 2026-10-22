import { describe, expect, test } from "bun:test";
import {
  parsePsCpuTime,
  parsePsRows,
  percentile,
  pickKindCounters,
  processTreeTotals,
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
