import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  FILE_ROWS_CAPPED_REASON,
  type ChangeMeasurement,
} from "@orkestrator/protocol/change-measurements";
import {
  environmentChangeResourceKey,
  type ChangeFileRow,
} from "@orkestrator/protocol/change-resources";
import type { DiffStatsTarget } from "../diff-stats-service.js";
import { encodePath } from "./capture.js";
import type { MeasurementFileRecord, OperationRow } from "./change-ledger.js";
import { toolResourceKeys } from "./identities.js";
import { capMeasurementFiles } from "./measurement-file-cap.js";
import { CHANGE_TRACKING_POLICY_V1 } from "./policy-registry.js";
import { createHarness, git, type Harness } from "./service-test-support.js";
import { gitScopeResourceKey } from "./git-scopes.js";
import { turnIdFor } from "./turn-boundaries.js";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

function harness(cap?: number): Harness {
  const created = createHarness(
    cap === undefined ? {} : { policy: { measurementFileRowCap: cap } },
  );
  harnesses.push(created);
  return created;
}

const RESOURCE = environmentChangeResourceKey("env-1");

interface ScanFile {
  path: string;
  additions?: number;
  binary?: true;
}

async function scan(h: Harness, files: readonly ScanFile[]) {
  const target: DiffStatsTarget = {
    environmentId: "env-1",
    comparisonRef: "main",
    kind: "local",
    worktreePath: h.repo,
  };
  const at = new Date().toISOString();
  h.service.onDiffScanEvent({
    kind: "scanned",
    target,
    result: {
      stats: {
        additions: files.length,
        deletions: 0,
        filesChanged: files.length,
        truncated: false,
      },
      changes: files.map((file) => ({
        path: file.path,
        filename: file.path,
        directory: "",
        additions: file.additions ?? 1,
        deletions: 0,
        status: "M",
        ...(file.binary ? { binary: true as const } : {}),
      })),
      baseOid: "a".repeat(40),
    },
    changed: true,
    at,
    startedAt: at,
  });
  await h.service.environments.idle();
}

function selected(h: Harness, key = RESOURCE): ChangeMeasurement {
  const measurement = h.service.projections.selectedMeasurement(key);
  if (!measurement) throw new Error(`no measurement for ${key}`);
  return measurement;
}

function projection(h: Harness, key = RESOURCE, pageSize?: number) {
  const view = h.service.getView({
    resourceKey: key,
    ...(pageSize === undefined ? {} : { pageSize }),
  });
  if (view.kind !== "projection") throw new Error(`expected a projection, got ${view.kind}`);
  return view.projection;
}

function allRows(h: Harness, key = RESOURCE): ChangeFileRow[] {
  const first = projection(h, key).filePage!;
  const rows = [...first.rows];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = h.service.projections.files(key, first.snapshotToken, cursor, 200);
    if (page.kind !== "page") throw new Error(page.error.code);
    rows.push(...page.rows);
    cursor = page.nextCursor;
  }
  return rows;
}

function record(pathId: string, extra: Partial<MeasurementFileRecord> = {}): MeasurementFileRecord {
  return {
    pathId,
    oldPath: pathId,
    newPath: pathId,
    oldBlob: null,
    newBlob: null,
    oldMode: null,
    newMode: null,
    status: "modified",
    fileKind: "text",
    additions: 1,
    additionsQuality: "complete",
    deletions: 0,
    deletionsQuality: "complete",
    bodyState: "pending",
    reason: null,
    ...extra,
  };
}

const completeDraft = (omittedFileCount: number | null = 0) => ({
  completeness: {
    files: "complete" as ChangeMeasurement["completeness"]["files"],
    reasons: ["keep-me"],
    omittedFileCount,
  },
});

describe("capMeasurementFiles", () => {
  test("at the cap everything stays as it was, in its original order", () => {
    const files = [record("z"), record("a")];
    const draft = completeDraft();
    const capped = capMeasurementFiles(draft, files, 2);
    expect(capped.rows).toBe(files);
    expect(capped.draft).toBe(draft);
  });

  test("text changes survive first, then the rest by path, whatever the input order", () => {
    const zeroLineChange = record("a-mode", {
      status: "mode-changed",
      additions: 0,
      deletions: 0,
    });
    const binary = record("b-image", { fileKind: "binary", additions: null, deletions: null });
    const unknown = record("c-omitted", {
      status: "unknown",
      fileKind: "unknown",
      additions: null,
      deletions: null,
    });
    const files = [unknown, record("z-text"), binary, zeroLineChange, record("m-text")];
    const expected = ["m-text", "z-text", "a-mode"];
    expect(capMeasurementFiles(completeDraft(), files, 3).rows.map((row) => row.pathId)).toEqual(
      expected,
    );
    expect(
      capMeasurementFiles(completeDraft(), files.toReversed(), 3).rows.map((row) => row.pathId),
    ).toEqual(expected);
  });

  test("goes partial with its reason first and counts each dropped file once", () => {
    const counted = record("omitted", {
      status: "unknown",
      fileKind: "unknown",
      reason: "omitted-too-large",
    });
    const { draft, rows } = capMeasurementFiles(
      completeDraft(1),
      [record("a"), record("b"), counted, record("n", { additions: 0 })],
      2,
    );
    expect(rows).toHaveLength(2);
    expect(draft.completeness).toEqual({
      files: "partial",
      reasons: [FILE_ROWS_CAPPED_REASON, "keep-me"],
      // 1 from the comparison (the omitted row) plus the one other dropped row.
      omittedFileCount: 2,
    });
  });

  test("an unknown omitted count stays unknown", () => {
    const { draft } = capMeasurementFiles(completeDraft(null), [record("a"), record("b")], 1);
    expect(draft.completeness.omittedFileCount).toBeNull();
  });

  test("the reason survives a full reason list", () => {
    const full = {
      completeness: {
        files: "partial" as const,
        reasons: Array.from({ length: 32 }, (_, index) => `reason-${index}`),
        omittedFileCount: 0,
      },
    };
    const { draft } = capMeasurementFiles(full, [record("a"), record("b")], 1);
    expect(draft.completeness.reasons).toHaveLength(32);
    expect(draft.completeness.reasons[0]).toBe(FILE_ROWS_CAPPED_REASON);
  });
});

describe("the environment scan past the cap", () => {
  const OVER = CHANGE_TRACKING_POLICY_V1.measurementFileRowCap;
  const bulk = (round = 0): ScanFile[] => [
    // These sort before the text rows, and a pure path order would keep them.
    ...Array.from({ length: 10 }, (_, index) => ({
      path: `aaa-image-${index}.png`,
      binary: true as const,
    })),
    ...Array.from({ length: OVER + 500 }, (_, index) => ({
      path: `file-${String(index).padStart(5, "0")}.ts`,
      additions: index === OVER + 499 ? round + 1 : 1,
    })),
  ];

  test("stores the cap's rows, keeps true totals and pages to a real end", async () => {
    const h = harness();
    await scan(h, bulk());
    const measurement = selected(h);
    expect(h.service.ledger.measurementFileCount(measurement.measurementId)).toBe(OVER);
    expect(measurement.totals.changedFiles).toBe(OVER + 510);
    expect(measurement.totals.additions).toEqual({
      value: OVER + 500,
      quality: "complete",
      bound: "exact",
    });
    expect(measurement.completeness).toMatchObject({
      files: "partial",
      omittedFileCount: 510,
    });
    expect(measurement.completeness.reasons).toContain(FILE_ROWS_CAPPED_REASON);

    const view = projection(h);
    expect(view.state).toBe("partial");
    expect(view.coverageState).toBe("partial");
    expect(view.hasFileChanges).toBe(true);
    expect(view.counters.changedFiles).toBe(OVER + 510);
    expect(view.reasonKeys).toContain(`changes.reason.${FILE_ROWS_CAPPED_REASON}`);
    expect(view.filePage).toMatchObject({ totalRows: OVER, omittedRows: 510 });

    const rows = allRows(h);
    expect(rows).toHaveLength(OVER);
    expect(new Set(rows.map((row) => row.rowId)).size).toBe(OVER);
    expect(rows.some((row) => row.newPathDisplay?.startsWith("aaa-image"))).toBe(false);
    // The last page answers the same omitted count and no further cursor.
    const last = h.service.projections.files(
      RESOURCE,
      view.filePage!.snapshotToken,
      Buffer.from(
        JSON.stringify({ token: view.filePage!.snapshotToken, offset: OVER - 1 }),
      ).toString("base64url"),
      200,
    );
    expect(last).toMatchObject({ kind: "page", nextCursor: null, omittedRows: 510 });
  });

  test("the same list makes no new measurement, a change past the cap makes one", async () => {
    const h = harness();
    await scan(h, bulk());
    const first = selected(h).measurementId;
    const rowCount = () =>
      (
        h.database().db.query("SELECT COUNT(*) AS n FROM change_measurement_files").get() as {
          n: number;
        }
      ).n;
    const before = rowCount();
    await scan(h, bulk());
    expect(selected(h).measurementId).toBe(first);
    expect(rowCount()).toBe(before);

    // Same totals and same stored rows; only a dropped row's path differs.
    const renamed = bulk().map((file) =>
      file.path === "aaa-image-3.png" ? { ...file, path: "aaa-image-renamed.png" } : file,
    );
    await scan(h, renamed);
    const second = selected(h);
    expect(second.measurementId).not.toBe(first);
    expect(second.totals.changedFiles).toBe(OVER + 510);
    expect(second.supersedesMeasurementId).toBe(first);
  });

  test("the handoff names the true total and the limit", async () => {
    const h = harness();
    await scan(h, bulk());
    const { text } = h.service.handoff.serialize([selected(h).measurementId], 100_000);
    expect(text).toContain(`${OVER + 510} files (partial)`);
    expect(text).toContain(FILE_ROWS_CAPPED_REASON);
    expect(text).toContain(`… ${OVER + 510 - 20} more files`);
  });

  test("under the cap nothing changes", async () => {
    const h = harness();
    await scan(h, [{ path: "b.ts" }, { path: "a.ts" }]);
    const measurement = selected(h);
    expect(measurement.completeness).toEqual({
      files: "complete",
      reasons: [],
      omittedFileCount: 0,
    });
    const page = projection(h).filePage!;
    expect(page.omittedRows).toBeUndefined();
    // Scan order, as before the cap.
    expect(page.rows.map((row) => row.newPathDisplay)).toEqual(["b.ts", "a.ts"]);
  });
});

async function runTurn(h: Harness, requestId: string, work: () => void) {
  await h.service.prepareTurnStart({
    environmentId: "env-1",
    logicalSessionKey: "env-env-1:tab",
    requestId,
    provider: "claude",
  });
  h.service.markTurnDispatched("env-1", "env-env-1:tab", requestId, "accepted");
  work();
  await h.service.finalizeTurn({
    environmentId: "env-1",
    logicalSessionKey: "env-env-1:tab",
    requestId,
  });
}

function turnMeasurement(h: Harness, requestId: string): ChangeMeasurement {
  const turnId = turnIdFor("env-1", "env-env-1:tab", requestId);
  const measurement = h.service.ledger.latestMeasurement("turn", turnId, "turn-net");
  if (!measurement) throw new Error("no turn measurement");
  return measurement;
}

/** A tree with a modification, a deletion, a rename and additions. */
function seedRepo(h: Harness) {
  mkdirSync(join(h.repo, "src"));
  writeFileSync(join(h.repo, "src", "keep.ts"), "keep\n");
  writeFileSync(join(h.repo, "src", "gone.ts"), "gone\n");
  writeFileSync(join(h.repo, "src", "old-name.ts"), "same content\n");
  git(h.repo, "add", ".");
  git(h.repo, "commit", "-qm", "seed");
}

function changeRepo(h: Harness) {
  writeFileSync(join(h.repo, "src", "keep.ts"), "kept and changed\n");
  rmSync(join(h.repo, "src", "gone.ts"));
  renameSync(join(h.repo, "src", "old-name.ts"), join(h.repo, "src", "new-name.ts"));
  writeFileSync(join(h.repo, "src", "new-1.ts"), "one\n");
  writeFileSync(join(h.repo, "src", "new-2.ts"), "two\n");
}

describe("snapshot measurements past the cap", () => {
  test("turn-net and thread-net store the cap's rows with true totals", async () => {
    const h = harness(2);
    seedRepo(h);
    await runTurn(h, "r1", () => changeRepo(h));
    const turn = turnMeasurement(h, "r1");
    expect(h.service.ledger.measurementFileCount(turn.measurementId)).toBe(2);
    expect(turn.totals.changedFiles).toBe(5);
    expect(turn.totals.additions.value).toBe(3);
    expect(turn.totals.deletions.value).toBe(2);
    expect(turn.completeness).toMatchObject({ files: "partial", omittedFileCount: 3 });
    expect(turn.finality).toBe("final");

    const thread = h.service.threadResource("env-1", "env-env-1:tab")!;
    const threadMeasurement = selected(h, thread.resourceKey);
    expect(h.service.ledger.measurementFileCount(threadMeasurement.measurementId)).toBe(2);
    expect(threadMeasurement.totals.changedFiles).toBe(5);
    expect(threadMeasurement.completeness.reasons).toContain(FILE_ROWS_CAPPED_REASON);
  });

  test("restore recomputes the whole plan from the manifests and undoes every file", async () => {
    const h = harness(2);
    seedRepo(h);
    await runTurn(h, "r1", () => changeRepo(h));
    const turn = turnMeasurement(h, "r1");
    const preview = await h.service.restore.prepare({ measurementId: turn.measurementId });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect(preview.files.map((file) => file.pathDisplay).sort()).toEqual([
      "src/gone.ts",
      "src/keep.ts",
      "src/new-1.ts",
      "src/new-2.ts",
      "src/new-name.ts",
    ]);
    expect(preview.files.every((file) => file.action !== "skip")).toBe(true);
    const applied = await h.service.restore.apply({
      actionToken: preview.actionToken,
      idempotencyKey: "k1",
    });
    expect(applied).toMatchObject({ kind: "applied", outcome: "complete" });
    expect(readFileSync(join(h.repo, "src", "keep.ts"), "utf8")).toBe("keep\n");
    expect(readFileSync(join(h.repo, "src", "gone.ts"), "utf8")).toBe("gone\n");
    expect(readFileSync(join(h.repo, "src", "old-name.ts"), "utf8")).toBe("same content\n");
    for (const created of ["new-1.ts", "new-2.ts", "new-name.ts"])
      expect(existsSync(join(h.repo, "src", created))).toBe(false);
  });

  test("restore includes omitted symlinks and gitlinks as explicit unsupported skips", async () => {
    const h = harness(1);
    symlinkSync("a.txt", join(h.repo, "z-link"));
    const head = git(h.repo, "rev-parse", "HEAD").trim();
    git(h.repo, "update-index", "--add", "--cacheinfo", `160000,${head},z-module`);
    git(h.repo, "add", "z-link");
    git(h.repo, "commit", "-qm", "seed special entries");
    await runTurn(h, "special", () => {
      writeFileSync(join(h.repo, "a.txt"), "keep the text row first\n");
      rmSync(join(h.repo, "z-link"));
      symlinkSync("b.txt", join(h.repo, "z-link"));
      git(h.repo, "update-index", "--force-remove", "z-module");
    });
    const turn = turnMeasurement(h, "special");
    expect(h.service.ledger.measurementFiles(turn.measurementId, 0, 10)).toHaveLength(1);
    const preview = await h.service.restore.prepare({ measurementId: turn.measurementId });
    if (preview.kind !== "preview") throw new Error(`expected preview, got ${preview.kind}`);
    expect(preview.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pathDisplay: "z-link",
          action: "skip",
          reasonKey: "changes.restore.symlink-unsupported",
        }),
        expect.objectContaining({
          pathDisplay: "z-module",
          action: "skip",
          reasonKey: "changes.restore.gitlink-unsupported",
        }),
      ]),
    );
    expect(
      await h.service.restore.apply({
        actionToken: preview.actionToken,
        idempotencyKey: "special",
      }),
    ).toMatchObject({ kind: "applied", outcome: "complete" });
    expect(readlinkSync(join(h.repo, "z-link"))).toBe("b.txt");
  });

  test("a restore can name one path that has no stored row", async () => {
    const h = harness(1);
    seedRepo(h);
    await runTurn(h, "r1", () => changeRepo(h));
    const turn = turnMeasurement(h, "r1");
    const [stored] = h.service.ledger.measurementFiles(turn.measurementId, 0, 1);
    const pathId = encodePath(new TextEncoder().encode("src/keep.ts"));
    expect(stored!.path_id).not.toBe(pathId);
    const preview = await h.service.restore.prepare({
      measurementId: turn.measurementId,
      pathIds: [pathId],
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect(preview.files.map((file) => file.pathDisplay)).toEqual(["src/keep.ts"]);
    expect(preview.files[0]!.action).toBe("write");
  });

  test("restore plans at the real cap stay complete and cost no blob reads", async () => {
    const h = harness();
    const count = CHANGE_TRACKING_POLICY_V1.measurementFileRowCap + 50;
    await runTurn(h, "r1", () => {
      mkdirSync(join(h.repo, "bulk"));
      for (let index = 0; index < count; index++)
        writeFileSync(join(h.repo, "bulk", `f${index}.txt`), `${index}\n`);
    });
    const turn = turnMeasurement(h, "r1");
    expect(h.service.ledger.measurementFileCount(turn.measurementId)).toBe(
      CHANGE_TRACKING_POLICY_V1.measurementFileRowCap,
    );
    const reads = spyOn(h.service.objects, "get");
    const preview = await h.service.restore.prepare({ measurementId: turn.measurementId });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect(preview.files).toHaveLength(count);
    expect(preview.files.filter((file) => file.action === "delete")).toHaveLength(count);
    // The manifests are read through their own path; no file body is inflated for counts.
    expect(reads.mock.calls.length).toBeLessThan(10);
    reads.mockRestore();
  });

  test("a diff of a capped measurement ends at its rows and says it is partial", async () => {
    const h = harness(2);
    seedRepo(h);
    await runTurn(h, "r1", () => changeRepo(h));
    const turn = turnMeasurement(h, "r1");
    const body = await h.service.diffBodies.getDiff({ diffIdentityId: turn.diffIdentityId! });
    if (body.kind !== "body") throw new Error(`expected a body, got ${body.kind}`);
    expect(body.files).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
    expect(body.measurement?.totals.changedFiles).toBe(5);
    expect(body.measurement?.completeness.reasons).toContain(FILE_ROWS_CAPPED_REASON);
  });
});

describe("Git scopes and live details past the cap", () => {
  test("a Git scope stores the cap's rows and refuses a path it cannot vouch for", async () => {
    const h = harness(2);
    for (const name of ["u1", "u2", "u3", "u4"]) writeFileSync(join(h.repo, `${name}.txt`), "x\n");
    const key = gitScopeResourceKey("uncommitted-net", "env-1");
    await h.service.ensureResource(key);
    const measurement = selected(h, key);
    expect(h.service.ledger.measurementFileCount(measurement.measurementId)).toBe(2);
    expect(measurement.totals.changedFiles).toBe(4);
    expect(measurement.completeness.reasons).toContain(FILE_ROWS_CAPPED_REASON);
    expect(projection(h, key).filePage?.omittedRows).toBe(2);

    const stored = h.service.ledger.measurementFiles(measurement.measurementId, 0, 2);
    const listed = await h.service.diffBodies.resolveLiveDetail({
      resourceKey: key,
      pathId: stored[0]!.path_id,
    });
    expect(listed.kind).toBe("identity");
    const unlisted = ["u1", "u2", "u3", "u4"]
      .map((name) => encodePath(new TextEncoder().encode(`${name}.txt`)))
      .find((pathId) => !stored.some((row) => row.path_id === pathId))!;
    expect(
      await h.service.diffBodies.resolveLiveDetail({ resourceKey: key, pathId: unlisted }),
    ).toEqual({
      kind: "error",
      error: { code: "not-found", reasonKey: `changes.reason.${FILE_ROWS_CAPPED_REASON}` },
    });
  });

  test("the environment's explicit current-file action still opens a path with no row", async () => {
    const h = harness(1);
    writeFileSync(join(h.repo, "listed.txt"), "x\n");
    writeFileSync(join(h.repo, "unlisted.txt"), "y\n");
    await scan(h, [{ path: "listed.txt" }, { path: "unlisted.txt", additions: 0 }]);
    const measurement = selected(h);
    const [row] = h.service.ledger.measurementFiles(measurement.measurementId, 0, 1);
    expect(row!.new_path).toBe(encodePath(new TextEncoder().encode("listed.txt")));
    const detail = await h.service.diffBodies.resolveLiveDetail({
      resourceKey: RESOURCE,
      pathId: encodePath(new TextEncoder().encode("unlisted.txt")),
    });
    expect(detail.kind).toBe("identity");
  });
});

describe("recorded edit activity", () => {
  test("a capped contribution makes the touched-file count unknown, not short", () => {
    const h = harness(1);
    const ledger = h.service.ledger;
    const measurements = h.service.measurements;
    const files = [record("a"), record("b")];
    const capped = measurements.capFileRows(
      {
        ...measurements.base({
          scope: "tool-effect",
          owner: { environmentId: "env-1", operationId: "op" },
          worktreeId: "w",
          worktreeIncarnation: "i",
        }),
        completeness: { files: "complete" as const, reasons: [], omittedFileCount: 0 },
      },
      files,
    );
    const owner = { kind: "operation", id: "op" };
    const { measurement } = measurements.seal(capped.draft, owner, null, undefined, files);
    measurements.publish({
      measurement,
      owner,
      files: capped.rows,
      identity: null,
      resourceKey: toolResourceKeys("op").effect,
    });
    const key = measurements.publishOperationVolume(
      { kind: "turn", id: "turn-1" },
      [{ operation_id: "op", tool_kind: "file-edit", phase: "succeeded" } as OperationRow],
      { worktreeId: "w", incarnation: "i" },
      "env-1",
    );
    const volume = selected(h, key!);
    expect(ledger.measurementFileCount(volume.measurementId)).toBe(0);
    expect(volume.totals.touchedFiles).toBeNull();
    expect(volume.completeness.files).toBe("partial");
    expect(volume.completeness.reasons).toContain(FILE_ROWS_CAPPED_REASON);
  });
  test("an uncapped 501-row contribution counts every touched file", () => {
    const h = harness(2_000);
    const ledger = h.service.ledger;
    const measurements = h.service.measurements;
    const files = Array.from({ length: 501 }, (_, i) => record(`file-${i}`));
    const capped = measurements.capFileRows(
      {
        ...measurements.base({
          scope: "tool-effect",
          owner: { environmentId: "env-1", operationId: "op" },
          worktreeId: "w",
          worktreeIncarnation: "i",
        }),
        completeness: { files: "complete" as const, reasons: [], omittedFileCount: 0 },
      },
      files,
    );
    const owner = { kind: "operation", id: "op" };
    const { measurement } = measurements.seal(capped.draft, owner, null, undefined, files);
    measurements.publish({
      measurement,
      owner,
      files: capped.rows,
      identity: null,
      resourceKey: toolResourceKeys("op").effect,
    });
    const key = measurements.publishOperationVolume(
      { kind: "turn", id: "turn-1" },
      [{ operation_id: "op", tool_kind: "file-edit", phase: "succeeded" } as OperationRow],
      { worktreeId: "w", incarnation: "i" },
      "env-1",
    );
    const volume = selected(h, key!);
    expect(ledger.measurementFileCount(volume.measurementId)).toBe(0);
    expect(volume.totals.touchedFiles).toBe(501);
    expect(volume.completeness.files).toBe("complete");
    expect(volume.completeness.reasons).not.toContain(FILE_ROWS_CAPPED_REASON);
  });
});

describe("history written before the cap", () => {
  test("reads back complete past the cap and shrinks when it is superseded", async () => {
    const h = harness(2);
    await scan(h, [{ path: "first.ts" }]);
    const ledger = h.service.ledger;
    const current = selected(h);
    // A row list an earlier build stored: over today's cap, with no cap reason.
    const old: ChangeMeasurement = { ...current, measurementId: "m_before_the_cap" };
    ledger.transaction(() => {
      ledger.insertMeasurement(
        old,
        { kind: "environment", id: "env-1" },
        Array.from({ length: 6 }, (_, index) => record(`old-${index}`)),
        ledger.nextSequence(),
      );
      ledger.swapSelection({
        key: RESOURCE,
        selector: "live",
        expectedRevision: ledger.selection(RESOURCE)!.revision,
        baselineVersion: old.baselineVersion,
        measurementId: old.measurementId,
        observationEpoch: 0,
        worktreeIncarnation: old.worktreeIncarnation,
        ownerFence: 0,
      });
    });
    h.service.projections.bump(RESOURCE);
    const page = projection(h).filePage!;
    expect(page.totalRows).toBe(6);
    expect(page.omittedRows).toBeUndefined();
    expect(allRows(h)).toHaveLength(6);

    for (let round = 0; round < 3; round += 1)
      await scan(h, [{ path: `round-${round}.ts` }, { path: `other-${round}.ts` }]);
    await h.service.retention.idle();
    expect(ledger.measurement(old.measurementId)).toBeNull();
    expect(ledger.measurementFileCount(old.measurementId)).toBe(0);
  });
});
