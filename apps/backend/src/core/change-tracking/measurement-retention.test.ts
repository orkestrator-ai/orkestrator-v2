import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import type { DiffStatsTarget } from "../diff-stats-service.js";
import type { MeasurementFileRecord, TurnBoundaryRow } from "./change-ledger.js";
import { MEASUREMENTS_KEPT_PER_OWNER } from "./measurement-service.js";
import { FINISHED_TURN_SUPERSEDED_GRACE_MS } from "./retention.js";
import { createHarness, type Harness } from "./service-test-support.js";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

function setup() {
  const h = createHarness();
  harnesses.push(h);
  const target: DiffStatsTarget = {
    environmentId: "env-1",
    comparisonRef: "main",
    kind: "local",
    worktreePath: h.repo,
  };
  return { h, target, key: environmentChangeResourceKey("env-1") };
}

/** One environment scan: `files` changed files, the last one varying with `round`. */
async function scan(h: Harness, target: DiffStatsTarget, files: number, round: number) {
  const changes = Array.from({ length: files }, (_, index) => {
    const path = index === files - 1 ? `round-${round}.ts` : `file-${index}.ts`;
    return { path, filename: path, directory: "", additions: 1, deletions: 0, status: "M" };
  });
  const at = new Date().toISOString();
  h.service.onDiffScanEvent({
    kind: "scanned",
    target,
    result: {
      stats: { additions: files, deletions: 0, filesChanged: files, truncated: false },
      changes,
      baseOid: "a".repeat(40),
    },
    changed: true,
    at,
    startedAt: at,
  });
  await h.service.environments.idle();
}

function count(h: Harness, sql: string, ...params: string[]): number {
  return (
    h
      .database()
      .db.query(sql)
      .get(...params) as { n: number }
  ).n;
}

function fileRecord(pathId: string): MeasurementFileRecord {
  return {
    pathId,
    oldPath: null,
    newPath: null,
    oldBlob: null,
    newBlob: null,
    oldMode: null,
    newMode: null,
    status: "modified",
    fileKind: "text",
    additions: 1,
    additionsQuality: "exact",
    deletions: 0,
    deletionsQuality: "exact",
    bodyState: "not-retained",
    reason: null,
  };
}

describe("superseded measurements", () => {
  test("re-measuring an environment keeps only its latest measurements", async () => {
    const { h, target, key } = setup();
    for (let round = 0; round < 8; round += 1) await scan(h, target, 50, round);

    expect(
      count(h, "SELECT COUNT(*) AS n FROM change_measurements WHERE scope = 'environment-net'"),
    ).toBe(MEASUREMENTS_KEPT_PER_OWNER);
    expect(count(h, "SELECT COUNT(*) AS n FROM change_measurement_files")).toBe(
      50 * MEASUREMENTS_KEPT_PER_OWNER,
    );
    // Identities of pruned measurements go with them.
    const identities = count(h, "SELECT COUNT(*) AS n FROM change_diff_identities");
    expect(identities).toBeLessThanOrEqual(MEASUREMENTS_KEPT_PER_OWNER);

    const view = h.service.getView({ resourceKey: key });
    if (view.kind !== "projection") throw new Error("projection expected");
    expect(view.projection.counters.changedFiles).toBe(50);
    expect(view.projection.filePage?.rows.some((row) => row.newPathDisplay === "round-7.ts")).toBe(
      true,
    );
  });

  test("retention prunes a backlog in batches, sparing selected and restorable ones", async () => {
    const { h, target, key } = setup();
    await scan(h, target, 3, 0);
    const ledger = h.service.ledger;
    const latest = h.service.projections.selectedMeasurement(key)!;
    // A backlog an older build left: many superseded copies of one owner's diff.
    const backlog = Array.from({ length: 150 }, (_, index) => `m_backlog_${index}`);
    // Seed the backlog atomically, as production callers do. Autocommitting
    // each of the 30,000 file rows makes setup dominate the test under load.
    ledger.transaction(() => {
      for (const measurementId of backlog) {
        ledger.insertMeasurement(
          { ...latest, measurementId },
          { kind: "environment", id: "env-backlog" },
          Array.from({ length: 200 }, (_, index) => fileRecord(`p${index}`)),
          ledger.nextSequence(),
        );
      }
    });
    const selected = backlog[10]!;
    const restorable = backlog[20]!;
    const pruned = backlog[0]!;
    const applying = backlog[30]!;
    ledger.insertRestoreToken({
      token: "consumed",
      measurementId: applying,
      payloadJson: "{}",
      ownerFence: 0,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    ledger.consumeRestoreToken("consumed");
    ledger.insertRestoreOperation({
      id: "applying",
      idempotencyKey: "applying",
      token: "consumed",
      measurementId: applying,
    });
    ledger.swapSelection({
      key: "test:pinned",
      selector: "pinned",
      expectedRevision: 0,
      baselineVersion: null,
      measurementId: selected,
      observationEpoch: 0,
      worktreeIncarnation: null,
      ownerFence: 0,
    });
    ledger.insertRestoreToken({
      token: "restore-token",
      measurementId: restorable,
      payloadJson: "{}",
      ownerFence: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const batch = spyOn(ledger, "pruneSupersededMeasurements");
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
      // A user-facing write can commit while the backlog is draining.
      h.database().writeStore("retention-progress", { ticks });
    }, 0);
    let report;
    try {
      report = await h.service.retention.run();
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
    expect(
      batch.mock.results.every((result) => result.type !== "return" || result.value.files <= 256),
    ).toBe(true);
    batch.mockRestore();
    expect(report.prunedMeasurements).toBe(backlog.length - MEASUREMENTS_KEPT_PER_OWNER - 3);
    expect(report.prunedMeasurementFiles).toBe(report.prunedMeasurements * 200);

    const remaining = (
      h
        .database()
        .db.query("SELECT id FROM change_measurements WHERE owner_id = 'env-backlog'")
        .all() as Array<{ id: string }>
    )
      .map((row) => row.id)
      .sort();
    expect(remaining).toEqual([selected, restorable, applying, ...backlog.slice(-2)].sort());
    expect(
      count(
        h,
        "SELECT COUNT(*) AS n FROM change_measurement_files WHERE measurement_id = ?",
        pruned,
      ),
    ).toBe(0);
    // The environment's own live measurement is untouched.
    expect(ledger.measurement(latest.measurementId)).not.toBeNull();
    expect(ledger.measurementFileCount(latest.measurementId)).toBe(3);
    // A handoff that names a pruned measurement says so instead of failing.
    expect(h.service.handoff.serialize([pruned]).text).toContain("not retained");

    // Idempotent.
    expect((await h.service.retention.run()).prunedMeasurements).toBe(0);
  });
  test("a single large measurement is pruned in strict row batches and reader pins are counted", async () => {
    const { h, target, key } = setup();
    await scan(h, target, 1, 0);
    const ledger = h.service.ledger;
    const latest = h.service.projections.selectedMeasurement(key)!;
    ledger.transaction(() => {
      for (let i = 0; i < 3; i++)
        ledger.insertMeasurement(
          { ...latest, measurementId: `large-${i}` },
          { kind: "environment", id: "large" },
          Array.from({ length: 700 }, (_, j) => fileRecord(`p${j}`)),
          ledger.nextSequence(),
        );
    });
    const prune = () =>
      ledger.pruneSupersededMeasurements({
        keepLatest: 2,
        nowIso: new Date().toISOString(),
        maxMeasurements: 64,
        maxFileRows: 256,
        owner: { kind: "environment", id: "large", scope: latest.scope },
      });
    const a = ledger.pinMeasurement("large-0");
    const b = ledger.pinMeasurement("large-0");
    expect(prune()).toEqual({ measurements: 0, files: 0 });
    a();
    a();
    expect(prune()).toEqual({ measurements: 0, files: 0 });
    b();
    expect(prune()).toEqual({ measurements: 0, files: 256 });
    expect(prune()).toEqual({ measurements: 0, files: 256 });
    expect(prune()).toEqual({ measurements: 1, files: 188 });
    expect(ledger.measurement("large-0")).toBeNull();
  });

  test("a publication drains the owner's superseded rows in batches, without the hourly pass", async () => {
    const { h, target, key } = setup();
    const ledger = h.service.ledger;
    const batch = spyOn(ledger, "pruneSupersededMeasurements");
    const drains = spyOn(h.service.retention, "drainOwner");
    for (let round = 0; round < 6; round += 1) await scan(h, target, 700, round);
    await h.service.retention.idle();

    expect(drains).toHaveBeenCalled();
    expect(
      batch.mock.results.every((result) => result.type !== "return" || result.value.files <= 256),
    ).toBe(true);
    drains.mockRestore();
    batch.mockRestore();
    expect(
      count(h, "SELECT COUNT(*) AS n FROM change_measurements WHERE scope = 'environment-net'"),
    ).toBe(MEASUREMENTS_KEPT_PER_OWNER);
    expect(count(h, "SELECT COUNT(*) AS n FROM change_measurement_files")).toBe(
      700 * MEASUREMENTS_KEPT_PER_OWNER,
    );
    const view = h.service.getView({ resourceKey: key, pageSize: 200 });
    if (view.kind !== "projection") throw new Error("projection expected");
    expect(view.projection.filePage?.totalRows).toBe(700);
  });

  test("a publication under the row ceiling prunes in its own transaction and starts no drain", async () => {
    const { h, target } = setup();
    const drains = spyOn(h.service.retention, "drainOwner");
    for (let round = 0; round < 5; round += 1) await scan(h, target, 50, round);
    expect(drains).not.toHaveBeenCalled();
    drains.mockRestore();
    expect(count(h, "SELECT COUNT(*) AS n FROM change_measurement_files")).toBe(
      50 * MEASUREMENTS_KEPT_PER_OWNER,
    );
  });

  test("one owner runs one drain, and a reader's pin outlives it", async () => {
    const { h, target, key } = setup();
    await scan(h, target, 1, 0);
    const ledger = h.service.ledger;
    const latest = h.service.projections.selectedMeasurement(key)!;
    const owner = { kind: "environment", id: "pinned" };
    ledger.transaction(() => {
      for (let index = 0; index < 5; index += 1)
        ledger.insertMeasurement(
          { ...latest, measurementId: `pinned-${index}` },
          owner,
          Array.from({ length: 300 }, (_, row) => fileRecord(`p${row}`)),
          ledger.nextSequence(),
        );
    });
    const release = ledger.pinMeasurement("pinned-0");
    const batch = spyOn(ledger, "pruneSupersededMeasurements");
    const scoped = { ...owner, scope: latest.scope };
    h.service.retention.drainOwner(scoped);
    h.service.retention.drainOwner(scoped);
    await h.service.retention.idle();
    // Two measurements of 300 rows at 256 a batch, then the empty one that ends it.
    expect(batch.mock.calls.length).toBe(4);
    batch.mockRestore();
    expect(ledger.measurementFileCount("pinned-0")).toBe(300);
    expect(ledger.measurement("pinned-1")).toBeNull();
    expect(ledger.measurement("pinned-2")).toBeNull();
    expect(ledger.measurementFileCount("pinned-4")).toBe(300);
    release();
    h.service.retention.drainOwner(scoped);
    await h.service.retention.idle();
    expect(ledger.measurement("pinned-0")).toBeNull();
  });

  test("a failed drain does not reject and the retention pass still finishes the work", async () => {
    const { h, target, key } = setup();
    await scan(h, target, 1, 0);
    const ledger = h.service.ledger;
    const latest = h.service.projections.selectedMeasurement(key)!;
    const owner = { kind: "environment", id: "failing" };
    ledger.transaction(() => {
      for (let index = 0; index < 3; index += 1)
        ledger.insertMeasurement(
          { ...latest, measurementId: `failing-${index}` },
          owner,
          [fileRecord("p")],
          ledger.nextSequence(),
        );
    });
    const batch = spyOn(ledger, "pruneSupersededMeasurements").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    h.service.retention.drainOwner({ ...owner, scope: latest.scope });
    await h.service.retention.idle();
    batch.mockRestore();
    expect(ledger.measurement("failing-0")).not.toBeNull();
    await h.service.retention.run();
    expect(ledger.measurement("failing-0")).toBeNull();
  });

  test("a stopped service starts no drain and ends a running one at its next batch", async () => {
    const { h, target, key } = setup();
    await scan(h, target, 1, 0);
    const ledger = h.service.ledger;
    const latest = h.service.projections.selectedMeasurement(key)!;
    const owner = { kind: "environment", id: "stopping" };
    ledger.transaction(() => {
      for (let index = 0; index < 3; index += 1)
        ledger.insertMeasurement(
          { ...latest, measurementId: `stopping-${index}` },
          owner,
          Array.from({ length: 600 }, (_, row) => fileRecord(`p${row}`)),
          ledger.nextSequence(),
        );
    });
    const batch = spyOn(ledger, "pruneSupersededMeasurements");
    h.service.retention.drainOwner({ ...owner, scope: latest.scope });
    h.service.retention.stop();
    await h.service.retention.idle();
    h.service.retention.drainOwner({ ...owner, scope: latest.scope });
    await h.service.retention.idle();
    expect(batch).not.toHaveBeenCalled();
    batch.mockRestore();
    expect(ledger.measurementFileCount("stopping-0")).toBe(600);
  });

  test("the retention pass releases pages a drain freed even when it prunes nothing itself", async () => {
    const { h, target } = setup();
    const release = spyOn(h.service.ledger, "releaseFreePages");
    await scan(h, target, 700, 0);
    const report = await h.service.retention.run();
    expect(report.prunedMeasurements).toBe(0);
    expect(release).toHaveBeenCalled();
    release.mockRestore();
  });

  test("contention ends this page-release pass; the next pass can make progress", async () => {
    const { h } = setup();
    const release = spyOn(h.service.ledger, "releaseFreePages")
      .mockReturnValueOnce(-1)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(0);
    try {
      await h.service.retention.run();
      expect(release).toHaveBeenCalledTimes(1);
      await h.service.retention.run();
      expect(release).toHaveBeenCalledTimes(3);
    } finally {
      release.mockRestore();
    }
  });

  test.each(["incremental", "no-progress"])(
    "retention releases free pages and stops on %s",
    async (mode) => {
      const { h, target, key } = setup();
      await scan(h, target, 1, 0);
      const ledger = h.service.ledger;
      const latest = h.service.projections.selectedMeasurement(key)!;
      ledger.transaction(() => {
        for (let i = 0; i < 5; i++)
          ledger.insertMeasurement(
            { ...latest, measurementId: `free-${i}` },
            { kind: "environment", id: "free" },
            Array.from({ length: 300 }, (_, j) => fileRecord("x".repeat(2000) + j)),
            ledger.nextSequence(),
          );
      });
      const db = h.database().db;
      const freelist = () =>
        (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
      const release = spyOn(ledger, "releaseFreePages");
      if (mode === "no-progress") release.mockReturnValue(10);
      try {
        await h.service.retention.run();
        if (mode === "incremental") {
          expect(release).toHaveBeenCalled();
          expect(freelist()).toBe(0);
        } else expect(release).toHaveBeenCalledTimes(2);
      } finally {
        release.mockRestore();
      }
    },
  );
});

describe("finished turns", () => {
  test("past the grace a finished turn keeps only its newest and selected measurements", async () => {
    const { h, target, key } = setup();
    await scan(h, target, 3, 0);
    const ledger = h.service.ledger;
    const latest = h.service.projections.selectedMeasurement(key)!;
    const nowMs = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const turn = (
      turnId: string,
      lifecycle: TurnBoundaryRow["lifecycle"],
      finishedMs: number | null,
    ) =>
      ledger.insertTurn({
        turn_id: turnId,
        segment_id: "seg-1",
        thread_id: "thread-1",
        environment_id: "env-1",
        worktree_id: "wt-1",
        lifecycle,
        start_attempt_id: null,
        start_snapshot_id: null,
        end_snapshot_id: null,
        before_quality: "exact",
        after_quality: "exact",
        terminal_evidence: null,
        dispatch_token: null,
        dispatch_receipt: null,
        reason: null,
        started_at: iso(nowMs - 3_600_000),
        finished_at: finishedMs === null ? null : iso(finishedMs),
        ordinal: 1,
      });
    /** A provisional then a final measurement for one turn, 50 rows each; the final selected. */
    const measure = (turnId: string, select: "final" | "provisional" = "final") => {
      const ids: [string, string] = [`${turnId}-provisional`, `${turnId}-final`];
      ledger.transaction(() => {
        for (const measurementId of ids)
          ledger.insertMeasurement(
            { ...latest, scope: "turn-net", measurementId },
            { kind: "turn", id: turnId },
            Array.from({ length: 50 }, (_, index) => fileRecord(`p${index}`)),
            ledger.nextSequence(),
          );
      });
      ledger.swapSelection({
        key: `turn:${turnId}`,
        selector: "live",
        expectedRevision: 0,
        baselineVersion: null,
        measurementId: select === "final" ? ids[1] : ids[0],
        observationEpoch: 0,
        worktreeIncarnation: latest.worktreeIncarnation,
        ownerFence: 0,
      });
      return ids;
    };
    const past = nowMs - FINISHED_TURN_SUPERSEDED_GRACE_MS - 60_000;
    turn("turn-old", "finalized", past);
    const [oldProvisional, oldFinal] = measure("turn-old");
    turn("turn-old-selected-provisional", "interrupted", past);
    const pinnedIds = measure("turn-old-selected-provisional", "provisional");
    turn("turn-recent", "finalized", nowMs - 60_000);
    const recentIds = measure("turn-recent");
    turn("turn-recovering", "end-unavailable", past);
    const recoveringIds = measure("turn-recovering");
    ledger.addReference({
      ownerKind: "turn",
      ownerId: "turn-recovering",
      snapshotId: "snap-recovery",
      reason: "turn-recovery-pending",
    });
    turn("turn-running", "running", null);
    const runningIds = measure("turn-running");

    const report = await h.service.retention.run(nowMs);
    expect(report.prunedMeasurements).toBe(1);
    expect(report.prunedMeasurementFiles).toBe(50);
    const kept = (turnId: string) =>
      (
        h
          .database()
          .db.query("SELECT id FROM change_measurements WHERE owner_kind = 'turn' AND owner_id = ?")
          .all(turnId) as Array<{ id: string }>
      )
        .map((row) => row.id)
        .sort();
    expect(kept("turn-old")).toEqual([oldFinal]);
    expect(ledger.measurementFileCount(oldProvisional)).toBe(0);
    // A selected measurement stays whatever its age; so does the newest.
    expect(kept("turn-old-selected-provisional")).toEqual([...pinnedIds].sort());
    // Inside the grace, with end recovery pending, or still running: untouched.
    expect(kept("turn-recent")).toEqual([...recentIds].sort());
    expect(kept("turn-recovering")).toEqual([...recoveringIds].sort());
    expect(kept("turn-running")).toEqual([...runningIds].sort());
    // The environment's own measurement is untouched, and the pass is idempotent.
    expect(ledger.measurementFileCount(latest.measurementId)).toBe(3);
    expect((await h.service.retention.run(nowMs)).prunedMeasurements).toBe(0);
  });
});
