import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const register = path.join(root, "docs/tests/flaky-tests");
const INDEX = "0000-index.md";

const STATUSES = new Set(["open", "resolved", "environmental"]);
const CASE_FILE = /^\d{4}-.+\.md$/;

function groupFolders(register: string): string[] {
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

function checkCaseNumbers(register: string) {
  const byNumber = new Map<string, string[]>();
  for (const group of groupFolders(register)) {
    for (const file of caseFiles(path.join(register, group))) {
      const id = file.slice(0, 4);
      byNumber.set(id, [...(byNumber.get(id) ?? []), `${group}/${file}`]);
    }
  }
  const duplicates = Object.fromEntries(
    [...byNumber].filter(([, files]) => files.length > 1).map(([id, files]) => [id, files.sort()]),
  );

  // Two branches that each took "the next number" both pass alone; the
  // collision appears only once both merge (1304 and 1316 in October 2026).
  // Name it plainly so the branch that merges second renumbers its own case.
  const collisions = Object.entries(duplicates).map(([id, files]) => `${id}: ${files.join(", ")}`);
  expect(
    collisions,
    `Flake case numbers used by more than one file. Renumber the newer case to a free number, or one from a range reserved for your branch, and update its ID line, index row and references:\n${collisions.join("\n")}`,
  ).toEqual([]);
}

describe("flaky test register", () => {
  test("the top-level index links every group folder and tracks no cases", () => {
    const index = readFileSync(path.join(register, INDEX), "utf8");

    expect(index).toMatch(/Do not\s+read every case file/);
    expect(caseRows(index)).toEqual([]);
    expect(caseFiles(register)).toEqual([]);
    expect(groupLinks(index).sort()).toEqual(groupFolders(register));
  });

  test("case numbers are unique across and within groups", () => {
    checkCaseNumbers(register);
  });

  for (const group of groupFolders(register)) {
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

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function writeCase(register: string, file: string) {
  const target = path.join(register, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "");
}

function fixture() {
  const register = mkdtempSync(path.join(os.tmpdir(), "flake-index-"));
  fixtures.push(register);
  writeCase(register, "agent-bridges/0147-first.md");
  checkCaseNumbers(register);
  return register;
}

describe("flake number guard negative fixtures", () => {
  test.each(["agent-bridges", "another-group"])(
    "rejects another file sharing legacy number 0147 in %s",
    (group) => {
      const register = fixture();
      writeCase(register, `${group}/0147-unlisted.md`);
      expect(() => checkCaseNumbers(register)).toThrow();
    },
  );

  test.each(["agent-bridges", "another-group"])("rejects a new duplicate number in %s", (group) => {
    const register = fixture();
    writeCase(register, "agent-bridges/9999-first.md");
    checkCaseNumbers(register);
    writeCase(register, `${group}/9999-second.md`);
    expect(() => checkCaseNumbers(register)).toThrow();
  });

  test("accepts numbers from ranges reserved for concurrent branches", () => {
    const register = fixture();
    // Gaps are fine: workers running at once take disjoint reserved ranges
    // far above the highest number in use, in any group.
    writeCase(register, "agent-bridges/1320-highest-in-use.md");
    writeCase(register, "aggregate-validation-runs/1530-first-worker.md");
    writeCase(register, "web-ui/1531-first-worker.md");
    writeCase(register, "agent-bridges/1540-second-worker.md");
    checkCaseNumbers(register);
    writeCase(register, "web-ui/1540-second-worker-again.md");
    expect(() => checkCaseNumbers(register)).toThrow(/1540: /);
  });
});
