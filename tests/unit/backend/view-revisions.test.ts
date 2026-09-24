/**
 * Owner generation/revision stamping for the PR monitor and diff-stats
 * services (recurring-processes step 11). Lifecycle behaviour stays in the
 * owning service suites; this file only proves the ordering contract clients
 * rely on: one contiguous revision per announced event, a snapshot whose
 * revision identifies exactly the captured state, and removals that advance
 * the revision so a conditional read can never answer `unchanged` wrongly.
 */
import { describe, expect, test } from "bun:test";
import { isEnvironmentDiffStatsEvent } from "@orkestrator/protocol/diff-stats";
import { isPrMonitorEvent, isPrMonitorSnapshot } from "@orkestrator/protocol/pr-monitor";
import {
  parseViewSnapshotRequest,
  resolveViewSnapshotOutcome,
} from "@orkestrator/protocol/view-sync";
import {
  DiffStatsService,
  type DiffScanResult,
  type DiffStatsTarget,
} from "../../../apps/backend/src/core/diff-stats-service";
import {
  PrMonitorService,
  type PrDetection,
  type PrMonitorTarget,
} from "../../../apps/backend/src/core/pr-monitor";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function prHarness(generation = "pr-gen-1") {
  const emitted: any[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let detect: () => Promise<PrDetection | null> = async () => null;
  const service = new PrMonitorService({
    generation,
    emit: (_event, payload) => emitted.push(payload),
    now: () => "2026-09-24T00:00:00.000Z",
    monotonicNow: () => 0,
    schedule: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    cancel: (timer) => {
      timers.delete(timer as number);
    },
    effects: {
      detect: () => detect(),
      persistPr: async () => {},
      clearPr: async () => {},
      findTaskForEnvironment: async () => null,
      moveTaskToReview: async () => {},
      addTaskComment: async () => {},
      updateTaskPrMetadata: async () => {},
    },
  });
  return {
    service,
    emitted,
    setDetect(next: () => Promise<PrDetection | null>) {
      detect = next;
    },
    async fireAll() {
      for (const [id, callback] of Array.from(timers)) {
        timers.delete(id);
        callback();
      }
      await settle();
    },
  };
}

function prTarget(overrides: Partial<PrMonitorTarget> = {}): PrMonitorTarget {
  return {
    environmentId: "env-1",
    branch: "feature/x",
    kind: "local",
    worktreePath: "/tmp/env-1",
    ready: true,
    prUrl: "https://github.com/org/repo/pull/1",
    prState: "open",
    hasMergeConflicts: false,
    ...overrides,
  };
}

describe("PrMonitorService revisions", () => {
  test("stamps every announced event with one contiguous revision", async () => {
    const harness = prHarness();
    harness.service.sync([prTarget(), prTarget({ environmentId: "env-2" })]);
    harness.service.untrack("env-2");

    expect(harness.emitted.map((event) => event.revision)).toEqual([1, 2, 3]);
    expect(harness.emitted.every((event) => event.generation === "pr-gen-1")).toBe(true);
    expect(harness.emitted.every(isPrMonitorEvent)).toBe(true);
    expect(harness.emitted[2]).toEqual({
      environmentId: "env-2",
      removed: true,
      generation: "pr-gen-1",
      revision: 3,
    });
  });

  test("the client snapshot is exactly the fold of announced events at its revision", async () => {
    const harness = prHarness();
    harness.service.sync([prTarget()]);
    const snapshot = harness.service.revisionedSnapshot();

    expect(isPrMonitorSnapshot(snapshot)).toBe(true);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.generation).toBe("pr-gen-1");
    expect(snapshot.entries).toEqual([harness.emitted[0].state]);
  });

  test("an unannounced probe never appears in the client snapshot", async () => {
    const harness = prHarness();
    const pending = deferred<PrDetection | null>();
    harness.setDetect(() => pending.promise);
    harness.service.probe(prTarget({ prUrl: null, prState: null, hasMergeConflicts: null }));
    await harness.fireAll();

    // The diagnostic view still sees the probe; clients do not.
    expect(harness.service.snapshot()).toHaveLength(1);
    expect(harness.service.revisionedSnapshot()).toEqual({
      entries: [],
      generation: "pr-gen-1",
      revision: 0,
    });

    pending.resolve(null);
    await settle();
    // Silently retired: no event, no revision change, still nothing to correct.
    expect(harness.emitted).toEqual([]);
    expect(harness.service.currentRevision().revision).toBe(0);
  });

  test("a mid-check announcement of a detecting state is always followed by its lowering", async () => {
    const harness = prHarness();
    harness.service.sync([prTarget()]);
    const pending = deferred<PrDetection | null>();
    harness.setDetect(() => pending.promise);
    await harness.fireAll();
    // A mode request lands while the check runs and announces checkInProgress.
    harness.service.requestMode(prTarget(), "merge-pending");
    expect(harness.emitted.at(-1).state).toMatchObject({
      mode: "merge-pending",
      checkInProgress: true,
    });

    pending.resolve({
      url: "https://github.com/org/repo/pull/1",
      state: "open",
      hasMergeConflicts: false,
      checkSummary: null,
      checkSummaryStatus: "skipped",
    });
    await settle();

    expect(harness.emitted.at(-1).state.checkInProgress).toBe(false);
    expect(harness.service.revisionedSnapshot().entries[0]?.checkInProgress).toBe(false);
  });

  test("shutdown advances the revision so a conditional read cannot answer unchanged", () => {
    const harness = prHarness();
    harness.service.sync([prTarget()]);
    const known = harness.service.currentRevision();
    harness.service.shutdown();

    const outcome = resolveViewSnapshotOutcome(
      parseViewSnapshotRequest({ knownGeneration: known.generation, knownRevision: 1 }),
      harness.service.currentRevision(),
      () => ({ entries: harness.service.revisionedSnapshot().entries }),
    );
    expect(outcome).toEqual({
      status: "snapshot",
      generation: "pr-gen-1",
      revision: 2,
      snapshot: { entries: [] },
    });
  });

  test("separate service instances have unrelated default generations", () => {
    const first = new PrMonitorService({ emit: () => {}, effects: {} as never });
    const second = new PrMonitorService({ emit: () => {}, effects: {} as never });
    expect(first.generation).not.toBe(second.generation);
    expect(first.generation.length).toBeGreaterThan(0);
  });
});

function diffHarness(generation = "diff-gen-1") {
  const emitted: any[] = [];
  let scan: (target: DiffStatsTarget) => Promise<DiffScanResult> = async () => ({
    stats: { additions: 1, deletions: 0, filesChanged: 1, truncated: false },
    changes: [],
  });
  const service = new DiffStatsService({
    generation,
    scan: (target) => scan(target),
    emit: (_event, payload) => emitted.push(payload),
    now: () => "2026-09-24T00:00:00.000Z",
    monotonicNow: () => 0,
    schedule: () => 1,
    cancel: () => {},
    startWatcher: () => ({ watching: false, close() {} }),
  });
  return {
    service,
    emitted,
    setScan(next: typeof scan) {
      scan = next;
    },
  };
}

const diffTarget = (environmentId = "env-1", comparisonRef = "main"): DiffStatsTarget => ({
  environmentId,
  kind: "container",
  containerId: `container-${environmentId}`,
  comparisonRef,
});

describe("DiffStatsService revisions", () => {
  test("stamps changes, retarget removals and untrack removals contiguously", async () => {
    const harness = diffHarness();
    harness.service.track(diffTarget("env-1"));
    await settle();
    harness.service.track(diffTarget("env-1", "develop"));
    await settle();
    harness.service.untrack("env-1");

    expect(harness.emitted.map((event) => [event.revision, event.removed === true])).toEqual([
      [1, false],
      [2, true],
      [3, false],
      [4, true],
    ]);
    expect(harness.emitted.every(isEnvironmentDiffStatsEvent)).toBe(true);
    expect(harness.emitted[3]).toMatchObject({
      environmentId: "env-1",
      comparisonRef: "develop",
      removed: true,
      generation: "diff-gen-1",
    });
  });

  test("untrack without published counts announces nothing", () => {
    const harness = diffHarness();
    harness.setScan(() => new Promise(() => {}));
    harness.service.track(diffTarget("env-1"));
    harness.service.untrack("env-1");
    expect(harness.emitted).toEqual([]);
    expect(harness.service.currentRevision().revision).toBe(0);
  });

  test("the revisioned snapshot identifies exactly the captured counts", async () => {
    const harness = diffHarness();
    harness.service.track(diffTarget("env-1"));
    harness.service.track(diffTarget("env-2"));
    await settle();

    const snapshot = harness.service.revisionedSnapshot();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.entries.map((entry) => entry.environmentId).sort()).toEqual(["env-1", "env-2"]);
    // Entries stay unstamped; the snapshot-level stamp orders them.
    expect(snapshot.entries.every((entry) => entry.revision === undefined)).toBe(true);
  });

  test("shutdown advances the revision without announcing per-environment removals", async () => {
    const harness = diffHarness();
    harness.service.track(diffTarget("env-1"));
    await settle();
    harness.service.shutdown();

    expect(harness.emitted).toHaveLength(1);
    expect(harness.service.revisionedSnapshot()).toEqual({
      entries: [],
      generation: "diff-gen-1",
      revision: 2,
    });
  });
});
