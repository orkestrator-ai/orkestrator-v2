import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DiffStatsService,
  DiffTargetUnavailableError,
  type DiffScanResult,
  type DiffStatsTarget,
  type DiffStatsWarning,
} from "../src/core/diff-stats-service";
import { diffTargetPresent } from "../src/core/diff-stats-tracking";
import { RecurringWorkMetrics } from "../src/core/recurring-work-metrics";

// A local environment whose worktree sits on an unmounted drive (or was
// deleted) used to run `git -C <missing>` on every poll; each run failed and
// was counted as a failed `diff-scan` job, about 1,200 a day per environment.

const stats = { additions: 1, deletions: 0, filesChanged: 1, truncated: false };

async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function createHarness(initiallyPresent: boolean) {
  const metrics = new RecurringWorkMetrics();
  const warnings: DiffStatsWarning[] = [];
  const delayed: Array<() => void> = [];
  const ticks: Array<() => void> = [];
  const clock = { value: 1_000 };
  const state = { present: initiallyPresent, scans: 0 };
  const service = new DiffStatsService({
    metrics,
    emit: () => undefined,
    localScanMinGapMs: 0,
    monotonicNow: () => clock.value,
    schedule: (callback) => {
      ticks.push(callback);
      return ticks.length;
    },
    cancel: () => undefined,
    delay: (callback) => {
      delayed.push(callback);
      return delayed.length;
    },
    cancelDelay: () => undefined,
    // The watcher of a missing folder fails; the target polls.
    startWatcher: () => ({ watching: false, close: () => undefined }),
    onWarning: (warning) => warnings.push(warning),
    targetPresent: async () => state.present,
    scan: async (): Promise<DiffScanResult> => {
      state.scans += 1;
      return { stats, changes: [] };
    },
  });
  const target: DiffStatsTarget = {
    environmentId: "env-missing",
    kind: "local",
    worktreePath: "/Volumes/Unmounted/worktree",
    comparisonRef: "main",
  };
  const tickAll = () => {
    for (const tick of ticks) tick();
  };
  return { service, metrics, warnings, clock, state, target, tickAll };
}

describe("diff scans of a missing local worktree", () => {
  test("never run git and are not counted as failed scans", async () => {
    const harness = createHarness(false);
    harness.service.track(harness.target);
    await settle();
    for (let round = 0; round < 6; round += 1) {
      // Past any backoff, so every poll tick checks again.
      harness.clock.value += 10 * 60_000;
      harness.tickAll();
      await settle();
    }

    expect(harness.state.scans).toBe(0);
    const diffScan = harness.metrics.snapshot().kinds["diff-scan"];
    expect(diffScan?.failed ?? 0).toBe(0);
    expect(diffScan?.started ?? 0).toBe(0);
    expect(diffScan?.rejected).toBe(7);
    // Reported once per streak, under its own event.
    expect(harness.warnings).toEqual([
      { event: "scan.target-missing", environmentId: "env-missing" },
    ]);
    expect(harness.service.snapshot()).toEqual([]);
  });

  test("a reader is told the folder is missing", async () => {
    const harness = createHarness(false);
    harness.service.track(harness.target);
    await settle();

    await expect(
      harness.service.readFileList({
        lookup: { worktreePath: harness.target.worktreePath! },
        comparisonRef: "main",
        includeUncommitted: true,
      }),
    ).rejects.toBeInstanceOf(DiffTargetUnavailableError);
  });

  test("keeps the last counts, stale, and scans again once the folder returns", async () => {
    const harness = createHarness(true);
    harness.service.track(harness.target);
    await settle();
    expect(harness.state.scans).toBe(1);

    harness.state.present = false;
    harness.service.refresh("env-missing");
    await settle();
    expect(harness.state.scans).toBe(1);
    expect(harness.service.snapshot()).toEqual([expect.objectContaining({ stats })]);

    harness.state.present = true;
    harness.clock.value += 10 * 60_000;
    harness.tickAll();
    await settle();
    expect(harness.state.scans).toBe(2);
    expect(harness.metrics.snapshot().kinds["diff-scan"]?.failed ?? 0).toBe(0);
    // A later missing streak is reported again.
    harness.state.present = false;
    harness.service.refresh("env-missing");
    await settle();
    expect(harness.warnings.map((warning) => warning.event)).toEqual([
      "scan.target-missing",
      "scan.target-missing",
    ]);
  });

  test("a presence check that throws lets the scan run", async () => {
    const metrics = new RecurringWorkMetrics();
    let scans = 0;
    const service = new DiffStatsService({
      metrics,
      emit: () => undefined,
      schedule: () => 1,
      cancel: () => undefined,
      startWatcher: () => ({ watching: false, close: () => undefined }),
      targetPresent: async () => {
        throw new Error("stat exploded");
      },
      scan: async () => {
        scans += 1;
        return { stats, changes: [] };
      },
    });
    service.track({
      environmentId: "env",
      kind: "local",
      worktreePath: "/tmp/whatever",
      comparisonRef: "main",
    });
    await settle();
    expect(scans).toBe(1);
  });
});

describe("diffTargetPresent", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("answers by whether the local worktree folder exists", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "diff-target-present-"));
    roots.push(root);
    const file = path.join(root, "file");
    writeFileSync(file, "");
    const local = (worktreePath: string): DiffStatsTarget => ({
      environmentId: "env",
      kind: "local",
      worktreePath,
      comparisonRef: "main",
    });

    expect(await diffTargetPresent(local(root))).toBe(true);
    expect(await diffTargetPresent(local(path.join(root, "gone")))).toBe(false);
    expect(await diffTargetPresent(local(file))).toBe(false);
    expect(await diffTargetPresent(local(path.join(file, "below")))).toBe(false);
    expect(
      await diffTargetPresent({
        environmentId: "env",
        kind: "container",
        containerId: "c1",
        comparisonRef: "main",
      }),
    ).toBe(true);
  });
});
