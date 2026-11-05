import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshotQualificationLedger } from "../../scripts/qualification-ledger.js";

test("qualification detects changed, deleted or missing ledger rows, schema, version and counters", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qualification-ledger-"));
  const file = path.join(dir, "ledger.sqlite");
  const db = new Database(file);
  try {
    db.exec(
      "CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT); INSERT INTO entries(value) VALUES ('kept'), ('deleted'); DELETE FROM entries WHERE id = 2",
    );
    const before = snapshotQualificationLedger(file);
    expect(before["ledger:row:sqlite_sequence:0"]).toBeDefined();
    db.exec("UPDATE entries SET value = 'changed'");
    expect(snapshotQualificationLedger(file)).not.toEqual(before);
    db.exec("UPDATE entries SET value = 'kept'");
    expect(snapshotQualificationLedger(file)).toEqual(before);
    for (const sql of [
      "DELETE FROM entries",
      "UPDATE sqlite_sequence SET seq = 99",
      "PRAGMA user_version = 3",
      "CREATE INDEX entries_value ON entries(value)",
    ]) {
      const previous = snapshotQualificationLedger(file);
      db.exec("BEGIN");
      db.exec(sql);
      // Separate readers see only committed state.
      db.exec("COMMIT");
      expect(snapshotQualificationLedger(file)).not.toEqual(previous);
    }
    expect(snapshotQualificationLedger(path.join(dir, "missing.sqlite"))).not.toEqual(before);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
