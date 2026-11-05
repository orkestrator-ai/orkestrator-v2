/** Logical ledger evidence; callers supply a private, consistent database copy. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export function snapshotQualificationLedger(
  file: string,
  embedded = false,
): Record<string, string> {
  if (!existsSync(file)) return {};
  const db = new Database(file, { readonly: true });
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const rows: Record<string, string> = {};
  try {
    if (!embedded) rows["ledger:version"] = hash(db.query("PRAGMA user_version").get());
    if (!embedded)
      rows["ledger:schema"] = hash(
        db
          .query(
            "SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_stat%' ORDER BY name",
          )
          .all(),
      );
    for (const { name } of db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()) {
      // Planner statistics and per-file storage bookkeeping are not ledger content.
      if (name.startsWith("sqlite_stat") || name === "storage_meta") continue;
      if (embedded && !name.startsWith("change_") && name !== "sqlite_sequence") continue;
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      // Hash each whole row, sorted independently of physical page order. This
      // includes sqlite_sequence's deleted-row high-water marks and duplicates.
      const values = db
        .query<Record<string, unknown>, []>(`SELECT * FROM ${quoted}`)
        .all()
        .filter(
          (row) =>
            !embedded || name !== "sqlite_sequence" || String(row.name).startsWith("change_"),
        )
        .map(hash)
        .sort();
      values.forEach((value, index) => {
        rows[`ledger:row:${name}:${index}`] = value;
      });
    }
    return rows;
  } finally {
    db.close();
  }
}

export type QualificationExpected = { pattern: RegExp; reason: string; changes?: string };

export function classifyQualificationChanges(changes: string[], expected: QualificationExpected[]) {
  const explained: string[] = [];
  const unexplained: string[] = [];
  for (const change of changes) {
    const rule = expected.find(
      (entry) =>
        (!entry.changes || entry.changes.includes(change[0]!)) &&
        entry.pattern.test(change.replace(/^[+~-] /, "")),
    );
    if (rule) explained.push(`${change} — ${rule.reason}`);
    else unexplained.push(change);
  }
  return { explained, unexplained };
}

// Only metadata is introduced by the move. Logical rows must stay identical.
export const LEDGER_MOVE_CHANGES: QualificationExpected[] = [
  { pattern: /^ledger:(version|schema)$/, changes: "+", reason: "separate ledger file metadata" },
];
