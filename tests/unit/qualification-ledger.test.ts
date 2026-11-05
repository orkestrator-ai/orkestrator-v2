import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  snapshotQualificationLedger,
  classifyQualificationChanges,
  LEDGER_MOVE_CHANGES,
} from "../../scripts/qualification-ledger.js";

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

test("schema-6 embedded rows survive schema-7 move, but missing or altered rows fail classification", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qualification-move-"));
  const oldFile = path.join(dir, "old.sqlite");
  const newFile = path.join(dir, "new.sqlite");
  const old = new Database(oldFile);
  const moved = new Database(newFile);
  try {
    const sql =
      "CREATE TABLE change_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT); INSERT INTO change_entries(value) VALUES ('kept'), ('deleted'); DELETE FROM change_entries WHERE id=2";
    old.exec(sql + "; PRAGMA user_version=6");
    moved.exec(sql + "; PRAGMA user_version=1");
    const before = snapshotQualificationLedger(oldFile, true);
    const classify = () => {
      const after = snapshotQualificationLedger(newFile);
      const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((key) => before[key] !== after[key])
        .map((key) => `${!(key in before) ? "+" : !(key in after) ? "-" : "~"} ${key}`);
      return classifyQualificationChanges(changes, LEDGER_MOVE_CHANGES);
    };
    expect(classify().unexplained).toEqual([]);
    expect(classify().explained).toHaveLength(2);
    for (const edit of [
      "UPDATE change_entries SET value='changed'",
      "DELETE FROM change_entries",
      "UPDATE sqlite_sequence SET seq=1",
    ]) {
      moved.exec("BEGIN");
      moved.exec(edit);
      moved.exec("COMMIT");
      expect(classify().unexplained.length).toBeGreaterThan(0);
      moved.exec(
        "DELETE FROM change_entries; INSERT INTO change_entries VALUES (1, 'kept'); UPDATE sqlite_sequence SET seq=2",
      );
    }
    moved.close();
    rmSync(newFile);
    expect(classify().unexplained.length).toBeGreaterThan(0);
  } finally {
    old.close();
    moved.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
