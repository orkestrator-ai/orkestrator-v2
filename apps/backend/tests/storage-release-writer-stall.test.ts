import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFixture } from "../scripts/storage-release-writer-stall.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("writer-stall benchmark fixture", () => {
  test.each([
    { freeMb: 1, liveMb: 2 },
    { freeMb: 2, liveMb: 1 },
    { freeMb: 1, liveMb: 1 },
    { freeMb: 0.02, liveMb: 0.03 },
  ])("retains all requested live rows for %j", ({ freeMb, liveMb }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "ork-writer-stall-fixture-"));
    directories.push(directory);
    const file = buildFixture(directory, freeMb, liveMb);
    const db = new Database(file, { readonly: true });
    try {
      expect(db.query("SELECT count(*) AS rows FROM live").get()).toEqual({
        rows: Math.ceil((liveMb * 1024 * 1024) / 4096),
      });
      expect(db.query("SELECT count(*) AS rows FROM waste").get()).toEqual({ rows: 0 });
      // DELETE retains the table's root page; the fixture must still leave free pages.
      expect(
        (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count,
      ).toBeGreaterThan(0);
      expect(db.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally {
      db.close();
    }
  });
});
