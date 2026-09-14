import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const register = path.join(root, "docs/tests/flaky-tests");
const indexPath = path.join(register, "0000-index.md");

const STATUSES = new Set(["open", "resolved", "environmental"]);

function caseFiles(): string[] {
  return readdirSync(register)
    .filter((name) => /^\d{4}-.+\.md$/.test(name) && name !== "0000-index.md")
    .sort();
}

function indexRows(index: string): Array<{ id: string; status: string; file: string }> {
  const rows: Array<{ id: string; status: string; file: string }> = [];
  for (const line of index.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line
      .slice(1, line.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 6 || !/^\d{4}$/.test(cells[0]!)) continue;
    const link = cells.at(-1)!.match(/^\[([^\]]+\.md)\]\(\1\)$/);
    if (!link) continue;
    rows.push({ id: cells[0]!, status: cells[1]!, file: link[1]! });
  }
  return rows;
}

describe("flaky test register", () => {
  test("the index lists every case file and stores a status for each row", () => {
    const index = readFileSync(indexPath, "utf8");
    const rows = indexRows(index);
    const files = caseFiles();

    expect(index).toMatch(/Do not\s+read every case file/);
    expect(rows.length).toBe(files.length);
    expect(new Set(rows.map((row) => row.file))).toEqual(new Set(files));

    for (const row of rows) {
      expect(STATUSES.has(row.status), `${row.id} has status ${row.status}`).toBe(true);
      expect(row.file.startsWith(`${row.id}-`)).toBe(true);
      const body = readFileSync(path.join(register, row.file), "utf8");
      expect(body).toMatch(new RegExp(`^- \\*\\*ID:\\*\\* ${row.id}$`, "m"));
      expect(body).toMatch(new RegExp(`^- \\*\\*Status:\\*\\* ${row.status}$`, "m"));
    }
  });
});
