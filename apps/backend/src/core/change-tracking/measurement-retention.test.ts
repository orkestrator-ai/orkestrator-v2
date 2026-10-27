import { afterEach, describe, expect, test } from "bun:test";
import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import type { DiffStatsTarget } from "../diff-stats-service.js";
import type { MeasurementFileRecord } from "./change-ledger.js";
import { MEASUREMENTS_KEPT_PER_OWNER } from "./measurement-service.js";
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
    for (const measurementId of backlog) {
      ledger.insertMeasurement(
        { ...latest, measurementId },
        { kind: "environment", id: "env-backlog" },
        Array.from({ length: 200 }, (_, index) => fileRecord(`p${index}`)),
        ledger.nextSequence(),
      );
    }
    const selected = backlog[10]!;
    const restorable = backlog[20]!;
    const pruned = backlog[0]!;
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

    const report = await h.service.retention.run();
    expect(report.prunedMeasurements).toBe(backlog.length - MEASUREMENTS_KEPT_PER_OWNER - 2);
    expect(report.prunedMeasurementFiles).toBe(report.prunedMeasurements * 200);

    const remaining = (
      h
        .database()
        .db.query("SELECT id FROM change_measurements WHERE owner_id = 'env-backlog'")
        .all() as Array<{ id: string }>
    )
      .map((row) => row.id)
      .sort();
    expect(remaining).toEqual([selected, restorable, ...backlog.slice(-2)].sort());
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
});
