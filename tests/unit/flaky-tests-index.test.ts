import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const register = path.join(root, "docs/tests/flaky-tests");
const INDEX = "0000-index.md";

const STATUSES = new Set(["open", "resolved", "environmental"]);
const CASE_FILE = /^\d{4}-.+\.md$/;

function groupFolders(): string[] {
  return readdirSync(register, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function caseFiles(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => CASE_FILE.test(name) && name !== INDEX)
    .sort();
}

function tableCells(line: string): string[] | undefined {
  if (!line.startsWith("| ")) return undefined;
  return line
    .slice(1, line.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
}

function caseRows(index: string): Array<{ id: string; status: string; file: string }> {
  const rows: Array<{ id: string; status: string; file: string }> = [];
  for (const line of index.split("\n")) {
    const cells = tableCells(line);
    if (!cells || cells.length < 6 || !/^\d{4}$/.test(cells[0]!)) continue;
    const link = cells.at(-1)!.match(/^\[([^\]]+\.md)\]\(\1\)$/);
    if (!link) continue;
    rows.push({ id: cells[0]!, status: cells[1]!, file: link[1]! });
  }
  return rows;
}

function groupLinks(index: string): string[] {
  const links: string[] = [];
  for (const line of index.split("\n")) {
    const link = tableCells(line)?.[0]?.match(/^\[[^\]]+\]\(([a-z0-9-]+)\/0000-index\.md\)$/);
    if (link) links.push(link[1]!);
  }
  return links;
}

describe("flaky test register", () => {
  test("the top-level index links every group folder and tracks no cases", () => {
    const index = readFileSync(path.join(register, INDEX), "utf8");

    expect(index).toMatch(/Do not\s+read every case file/);
    expect(caseRows(index)).toEqual([]);
    expect(caseFiles(register)).toEqual([]);
    expect(groupLinks(index).sort()).toEqual(groupFolders());
  });

  for (const group of groupFolders()) {
    test(`${group} index lists every case file and stores a status for each row`, () => {
      const folder = path.join(register, group);
      const rows = caseRows(readFileSync(path.join(folder, INDEX), "utf8"));
      const files = caseFiles(folder);

      expect(rows.length).toBe(files.length);
      expect(new Set(rows.map((row) => row.file))).toEqual(new Set(files));

      for (const row of rows) {
        expect(STATUSES.has(row.status), `${row.id} has status ${row.status}`).toBe(true);
        expect(row.file.startsWith(`${row.id}-`)).toBe(true);
        const body = readFileSync(path.join(folder, row.file), "utf8");
        expect(body).toMatch(new RegExp(`^- \\*\\*ID:\\*\\* ${row.id}$`, "m"));
        expect(body).toMatch(new RegExp(`^- \\*\\*Status:\\*\\* ${row.status}$`, "m"));
      }
    });
  }
});
