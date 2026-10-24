import { describe, expect, test } from "bun:test";
import { WORKTREE_SNAPSHOT_CHANGED_EVENT } from "@orkestrator/protocol/worktree-snapshots";
import type { WorktreeSignalReason } from "./agent-tools.js";
import {
  CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS,
  CONTAINER_WORKTREE_SIGNAL_MISS_GRACE_MS,
  ContainerWorktreeSignals,
} from "./container-worktree-signal.js";
import {
  CONTAINER_SAFETY_NET_INTERVAL_MS,
  CONTAINER_TREE_MAX_AGE_MS,
  DIFF_POLL_INTERVAL_MS,
  DiffStatsService,
  type DiffStatsTarget,
} from "./diff-stats-service.js";
import { DIFF_CACHE_MAX_AGE_MS } from "./diff-stats-tracking.js";
import { ManualTime, deferred, flushMicrotasks } from "./recurring-test-support.js";
import { WorkAdmissionPool } from "./work-admission.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";

/**
 * The container worktree signal end to end inside the scan owner: real
 * `DiffStatsService` and `ContainerWorktreeSignals` on one manual clock, with
 * the Docker side (status exec, tree walk, install) replaced by counters.
 */
function harness(admission?: WorkAdmissionPool) {
  const time = new ManualTime(1_000_000);
  const rings: Array<(reason: WorktreeSignalReason) => void> = [];
  const revoked: boolean[] = [];
  const intervals: number[] = [];
  const snapshots: Array<{ watched: boolean }> = [];
  let file = "a.ts";
  let scanGate: Promise<void> | undefined;
  let scans = 0;
  let walks = 0;
  const signals = new ContainerWorktreeSignals({
    installer: { support: async () => "supported", install: async () => undefined },
    context: () =>
      ({
        storage: {},
        agentTools: {
          issueWorktreeSignal: (ring: (reason: WorktreeSignalReason) => void) => {
            const index = rings.push(ring) - 1;
            revoked[index] = false;
            return {
              url: "http://host.docker.internal:1/worktree-signal",
              token: `token-${index}`,
              revoke: () => {
                revoked[index] = true;
              },
            };
          },
        },
      }) as never,
    nowMs: time.now,
    delay: (callback, delayMs) => time.setTimeout(callback, delayMs),
    cancelDelay: (timer) => time.clear(timer),
    onWarning: () => undefined,
  });
  const service = new DiffStatsService({
    admission,
    scan: async () => {
      scans += 1;
      const scannedFile = file;
      const gate = scanGate;
      scanGate = undefined;
      await gate;
      return {
        stats: { additions: 1, deletions: 0, filesChanged: 1, truncated: false },
        changes: [{ path: scannedFile, status: "M", additions: 1, deletions: 0 }],
      };
    },
    walkTree: async () => {
      walks += 1;
      return [{ name: file, path: file, isDirectory: false }];
    },
    emit: (event, payload) => {
      if (event === WORKTREE_SNAPSHOT_CHANGED_EVENT)
        snapshots.push(payload as { watched: boolean });
    },
    fileListMaxAgeMs: DIFF_CACHE_MAX_AGE_MS,
    containerTreeMaxAgeMs: CONTAINER_TREE_MAX_AGE_MS,
    startContainerWatcher: (watch) => signals.start(watch),
    metrics: new RecurringWorkMetrics({ enabled: false }),
    now: () => new Date(time.now()).toISOString(),
    monotonicNow: time.now,
    schedule: (callback, intervalMs) => {
      intervals.push(intervalMs);
      return time.setInterval(callback, intervalMs);
    },
    cancel: (timer) => time.clear(timer),
    delay: (callback, delayMs) => time.setTimeout(callback, delayMs),
    cancelDelay: (timer) => time.clear(timer),
  });
  const target: DiffStatsTarget = {
    environmentId: "env-container",
    kind: "container",
    containerId: "container-1",
    comparisonRef: "main",
  };
  const lookup = { containerId: "container-1" };
  return {
    time,
    service,
    signals,
    target,
    intervals,
    snapshots,
    revoked,
    ring: (reason: WorktreeSignalReason) => rings.at(-1)?.(reason),
    readList: () =>
      service.readFileList({ lookup, comparisonRef: "main", includeUncommitted: true }),
    readTree: () => service.readTree({ lookup }),
    edit: (next: string) => {
      file = next;
    },
    gateScan: (gate: Promise<void>) => {
      scanGate = gate;
    },
    scans: () => scans,
    walks: () => walks,
  };
}

async function settle(time: ManualTime) {
  await flushMicrotasks();
  await time.advance(0);
}

describe("container worktree signal in the scan owner", () => {
  test("an unconfirmed container keeps the unwatched bounds", async () => {
    const h = harness();
    h.service.track(h.target);
    await settle(h.time);
    expect(h.intervals.at(-1)).toBe(DIFF_POLL_INTERVAL_MS);
    expect(h.scans()).toBe(1);
    await h.readList();
    expect(h.scans()).toBe(1);
    await h.time.advance(DIFF_CACHE_MAX_AGE_MS + 1);
    await h.readList();
    expect(h.scans()).toBe(2);
    expect(h.signals.status().states.armed).toBe(1);
  });

  test("a confirmed container is served from its last scan until a ring", async () => {
    const h = harness();
    h.service.track(h.target);
    await settle(h.time);
    h.ring("ready");
    await settle(h.time);
    // The probe ring rescans under qualified coverage and moves to the safety cadence.
    expect(h.scans()).toBe(2);
    expect(h.intervals.at(-1)).toBe(CONTAINER_SAFETY_NET_INTERVAL_MS);
    expect(h.snapshots.at(-1)?.watched).toBe(true);

    await h.readTree();
    expect(h.walks()).toBe(1);
    // A quiet panel: 5 s polls for 25 s cost no exec at all.
    for (let poll = 0; poll < 5; poll += 1) {
      await h.time.advance(5_000);
      await h.readList();
      await h.readTree();
    }
    expect(h.scans()).toBe(2);
    expect(h.walks()).toBe(1);

    h.edit("b.ts");
    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS);
    h.ring("change");
    await settle(h.time);
    expect(h.scans()).toBe(3);
    expect((await h.readList()).changes).toEqual([
      { path: "b.ts", status: "M", additions: 1, deletions: 0 },
    ]);
    await h.readTree();
    expect(h.walks()).toBe(2);
    expect(h.scans()).toBe(3);
  });

  test("a safety scan that finds an unannounced change demotes back to the timers", async () => {
    const h = harness();
    h.service.track(h.target);
    await settle(h.time);
    h.ring("ready");
    await settle(h.time);
    const scansBefore = h.scans();

    // The watcher missed this edit; only the safety scan sees it.
    h.edit("missed.ts");
    await h.time.advance(CONTAINER_SAFETY_NET_INTERVAL_MS);
    await settle(h.time);
    expect(h.scans()).toBe(scansBefore + 1);
    expect(h.snapshots.at(-1)?.watched).toBe(true);
    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_MISS_GRACE_MS);
    await settle(h.time);
    expect(h.intervals.at(-1)).toBe(DIFF_POLL_INTERVAL_MS);
    expect(h.snapshots.at(-1)?.watched).toBe(false);
    expect(h.revoked.at(-1)).toBe(true);
    expect(h.signals.status().demotions).toEqual({ "missed-change": 1 });

    // Back on the unwatched bound: reads past 3 s scan again.
    const scansAfter = h.scans();
    await h.time.advance(DIFF_CACHE_MAX_AGE_MS + 1);
    await h.readList();
    expect(h.scans()).toBe(scansAfter + 1);
  });

  for (const phase of ["queued", "running"] as const) {
    test(`a ring while a safety scan is ${phase} does not demote the watcher`, async () => {
      const pool = new WorkAdmissionPool({ name: "git-docker-scan", diagnostics: null });
      const h = harness(pool);
      try {
        h.service.track(h.target);
        await settle(h.time);
        h.ring("ready");
        await settle(h.time);
        h.edit("announced-in-flight.ts");
        const before = h.scans();
        const gate = deferred();
        const lease =
          phase === "queued"
            ? await pool.acquire({
                kind: "diff-scan",
                priority: "interactive",
                target: "container:container-1",
              })
            : undefined;
        if (phase === "running") h.gateScan(gate.promise);
        await h.time.advance(CONTAINER_SAFETY_NET_INTERVAL_MS);
        expect(h.scans()).toBe(before + (phase === "running" ? 1 : 0));
        h.ring("change");
        await settle(h.time);
        lease?.release();
        gate.resolve();
        await settle(h.time);
        await h.time.advance(
          CONTAINER_WORKTREE_SIGNAL_MISS_GRACE_MS + CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS,
        );
        await settle(h.time);
        expect((await h.readList()).changes).toEqual([
          { path: "announced-in-flight.ts", status: "M", additions: 1, deletions: 0 },
        ]);
        expect(h.signals.status().states.confirmed).toBe(1);
        expect(h.signals.status().demotions).toEqual({});
      } finally {
        h.service.shutdown();
      }
    });
  }

  test("an announced change never counts as a miss", async () => {
    const h = harness();
    h.service.track(h.target);
    await settle(h.time);
    h.ring("ready");
    await settle(h.time);
    h.edit("announced.ts");
    await h.time.advance(CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS);
    h.ring("change");
    await settle(h.time);
    await h.time.advance(
      CONTAINER_SAFETY_NET_INTERVAL_MS + CONTAINER_WORKTREE_SIGNAL_MISS_GRACE_MS,
    );
    await settle(h.time);
    expect(h.snapshots.at(-1)?.watched).toBe(true);
    expect(h.signals.status().demotions).toEqual({});
  });

  test("a pause closes the lineage and a resume arms a new one", async () => {
    const h = harness();
    h.service.track(h.target);
    await settle(h.time);
    h.ring("ready");
    await settle(h.time);
    h.service.pause("env-container");
    expect(h.revoked[0]).toBe(true);
    expect(h.signals.status().containers).toBe(0);
    h.service.track(h.target);
    await settle(h.time);
    expect(h.revoked).toHaveLength(2);
    expect(h.signals.status().states).toMatchObject({ armed: 1, confirmed: 0 });
    expect(h.intervals.at(-1)).toBe(DIFF_POLL_INTERVAL_MS);
    h.ring("ready");
    await settle(h.time);
    expect(h.signals.status().states).toMatchObject({ armed: 0, confirmed: 1 });
    expect(h.intervals.at(-1)).toBe(CONTAINER_SAFETY_NET_INTERVAL_MS);
  });
});
