/** Logical ledger evidence; callers supply a private, consistent database copy. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export function snapshotQualificationLedger(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const db = new Database(file, { readonly: true });
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const rows: Record<string, string> = {};
  try {
    rows["ledger:version"] = hash(db.query("PRAGMA user_version").get());
    rows["ledger:schema"] = hash(
      db.query("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
    );
    for (const { name } of db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()) {
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      // Hash each whole row, sorted independently of physical page order. This
      // includes sqlite_sequence's deleted-row high-water marks and duplicates.
      const values = db.query(`SELECT * FROM ${quoted}`).all().map(hash).sort();
      values.forEach((value, index) => {
        rows[`ledger:row:${name}:${index}`] = value;
      });
    }
    return rows;
  } finally {
    db.close();
  }
}
