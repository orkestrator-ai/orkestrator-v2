import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  downgradeReadFailure,
  finishQualification,
} from "../../scripts/design-mixed-version-checks";

describe("mixed version qualification", () => {
  test("accepts snapshots and explicit version fences only", () => {
    expect(downgradeReadFailure({ ok: true, value: { kind: "snapshot" } })).toBeNull();
    expect(
      downgradeReadFailure({
        ok: true,
        value: { kind: "record-problem", problem: "unsupported-version" },
      }),
    ).toBeNull();
    for (const result of [
      { ok: false, failure: { code: "transport", message: "offline" } },
      { ok: true, value: { kind: "missing" } },
      { ok: true, value: { kind: "record-problem", problem: "corrupt" } },
    ])
      expect(downgradeReadFailure(result)).not.toBeNull();
  });

  test("rejects silent frame loss or content changes when the old backend starts", () => {
    const canvas = { id: "old", frames: [{ id: "frame", html: "Edited by the new backend" }] };
    expect(
      downgradeReadFailure({ ok: true, value: { kind: "snapshot", canvas } }, canvas),
    ).toBeNull();
    for (const damaged of [
      { ...canvas, frames: [] },
      { ...canvas, frames: [{ id: "frame", html: "Old content" }] },
    ]) {
      expect(
        downgradeReadFailure({ ok: true, value: { kind: "snapshot", canvas: damaged } }, canvas),
      ).toBe("canvas content changed");
    }
  });

  test("creates missing report parents and removes scratch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mixed-report-test-"));
    const scratch = await mkdtemp(path.join(root, "scratch-"));
    const reportPath = path.join(root, "new", "nested", "report.json");
    try {
      await finishQualification({ scratch, reportPath, report: { exitCode: 0 }, keep: false });
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual({ exitCode: 0 });
      expect(await stat(scratch).catch(() => null)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes scratch even if report writing fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mixed-report-test-"));
    const scratch = await mkdtemp(path.join(root, "scratch-"));
    const blocked = path.join(root, "report.json");
    await mkdir(blocked); // Parent creation succeeds; writing the report fails with EISDIR.
    try {
      await expect(
        finishQualification({
          scratch,
          reportPath: blocked,
          report: {},
          keep: false,
        }),
      ).rejects.toThrow();
      expect(await stat(scratch).catch(() => null)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
