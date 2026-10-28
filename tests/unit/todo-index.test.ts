import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const todo = path.join(root, "docs/todo");
const INDEX = "0000-index.md";

const TODO_FILE = /^\d{4}-.+\.md$/;
const CRITICALITY = new Set(["Very high", "High", "Medium", "Low"]);
const FINISHED = new Set(["Yes", "No"]);

// Numbers already shared by more than one todo file when the uniqueness check
// was added (todo 0732). They keep their numbers, because a todo number is a
// permanent ID (docs/README.md). Finished files are deleted, so an entry may
// shrink, but no number here may gain a file that is not listed.
const ALLOWED_DUPLICATES: Record<string, string[]> = {
  "0054": [
    "cross-cutting/0054-agent-test-pi-default-model.md",
    "design-canvas/0054-design-canvas-accessibility-findings.md",
    "previews-and-annotations/0054-preview-cross-service-reads.md",
  ],
  "0723": [
    "agent-engines/0723-orkestrator-permission-rules.md",
    "coordinator-and-multi-review/0723-build-pipeline-resend-without-dispatch-check.md",
  ],
};

function areaFolders(todo: string): string[] {
  return readdirSync(todo, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function todoFiles(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => TODO_FILE.test(name) && name !== INDEX)
    .sort();
}

function tableCells(line: string): string[] | undefined {
  if (!line.startsWith("| ")) return undefined;
  return line
    .slice(1, line.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
}

function todoRows(
  index: string,
): Array<{ rank: string; file: string; criticality: string; finished: string }> {
  const rows: Array<{ rank: string; file: string; criticality: string; finished: string }> = [];
  for (const line of index.split("\n")) {
    const cells = tableCells(line);
    if (!cells || cells.length < 6 || !/^\d+$/.test(cells[0]!)) continue;
    const link = cells[1]!.match(/^\[([^\]]+\.md)\]\(\1\)$/);
    if (!link) continue;
    rows.push({ rank: cells[0]!, file: link[1]!, criticality: cells[2]!, finished: cells[3]! });
  }
  return rows;
}

function folderLinks(index: string): string[] {
  const links: string[] = [];
  for (const line of index.split("\n")) {
    const link = tableCells(line)?.[0]?.match(/^\[[^\]]+\]\(([a-z0-9-]+)\/0000-index\.md\)$/);
    if (link) links.push(link[1]!);
  }
  return links;
}

function checkFolderLinks(todo: string) {
  const index = readFileSync(path.join(todo, INDEX), "utf8");
  expect(todoFiles(todo)).toEqual([]);
  expect(folderLinks(index).sort()).toEqual(areaFolders(todo));
}

function checkTodoNumbers(todo: string) {
  const byNumber = new Map<string, string[]>();
  for (const folder of areaFolders(todo)) {
    for (const file of todoFiles(path.join(todo, folder))) {
      const id = file.slice(0, 4);
      byNumber.set(id, [...(byNumber.get(id) ?? []), `${folder}/${file}`]);
    }
  }

  const clashes = [...byNumber]
    .filter(([id, files]) => {
      const allowed = new Set(ALLOWED_DUPLICATES[id] ?? []);
      return files.length > 1 && files.some((file) => !allowed.has(file));
    })
    .map(([id, files]) => `${id}: ${files.join(", ")}`);

  expect(clashes).toEqual([]);
}

function checkAreaIndex(directory: string) {
  const rows = todoRows(readFileSync(path.join(directory, INDEX), "utf8"));
  const files = todoFiles(directory);

  expect(rows.map((row) => row.file).sort()).toEqual(files);
  expect(rows.map((row) => row.rank)).toEqual(rows.map((_, i) => String(i + 1)));
  for (const row of rows) {
    expect(CRITICALITY.has(row.criticality), `${row.file} is rated ${row.criticality}`).toBe(true);
    expect(FINISHED.has(row.finished), `${row.file} has Finished ${row.finished}`).toBe(true);
  }
}

describe("todo folders", () => {
  test("the top-level index links every area folder and holds no todo files", () => {
    checkFolderLinks(todo);
  });

  test("todo numbers are unique across folders, except the allowlisted duplicates", () => {
    checkTodoNumbers(todo);
  });

  for (const folder of areaFolders(todo)) {
    test(`${folder} index has one rated row for every todo file`, () => {
      checkAreaIndex(path.join(todo, folder));
    });
  }
});

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function writeFixtureFile(root: string, file: string, body = "") {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "todo-index-"));
  fixtures.push(directory);
  writeFixtureFile(directory, INDEX, "| [Area](area/0000-index.md) | Example |\n");
  for (const file of ["0001-first.md", "0002-middle.md", "0003-last.md"]) {
    writeFixtureFile(directory, `area/${file}`);
  }
  writeFixtureFile(
    directory,
    `area/${INDEX}`,
    ["0001-first.md", "0002-middle.md", "0003-last.md"]
      .map((file, i) => `| ${i + 1} | [${file}](${file}) | High | No | Example | Notes |`)
      .join("\n"),
  );
  // Every negative case starts with a valid filesystem and exercises the same
  // checks as the live documentation above, without modifying the repository.
  checkFolderLinks(directory);
  checkTodoNumbers(directory);
  checkAreaIndex(path.join(directory, "area"));
  return directory;
}

describe("todo guard negative fixtures", () => {
  test.each(["area", "another-area"])("rejects a duplicate number in %s", (area) => {
    const directory = fixture();
    writeFixtureFile(directory, `${area}/0001-duplicate.md`);
    expect(() => checkTodoNumbers(directory)).toThrow();
  });

  test("rejects an unlisted file added to allowlisted number 0054", () => {
    const directory = fixture();
    for (const file of ALLOWED_DUPLICATES["0054"]!) writeFixtureFile(directory, file);
    checkTodoNumbers(directory);
    writeFixtureFile(directory, "area/0054-unlisted.md");
    expect(() => checkTodoNumbers(directory)).toThrow();
  });

  test("allows deletion of a finished allowlisted duplicate", () => {
    const directory = fixture();
    for (const file of ALLOWED_DUPLICATES["0054"]!) writeFixtureFile(directory, file);
    rmSync(path.join(directory, ALLOWED_DUPLICATES["0054"]![0]!));
    checkTodoNumbers(directory);
  });

  test.each([
    ["missing row", (index: string) => index.split("\n").slice(0, 2).join("\n")],
    ["stale row", (index: string) => index.replaceAll("0002-middle.md", "0004-stale.md")],
    ["duplicate row", (index: string) => `${index}\n${index.split("\n")[0]}`],
    ["rank gap", (index: string) => index.replace("| 2 |", "| 4 |")],
    ["duplicate rank", (index: string) => index.replace("| 2 |", "| 1 |")],
    ["moved ranks", (index: string) => index.split("\n").reverse().join("\n")],
    ["invalid criticality", (index: string) => index.replace("| High |", "| Urgent |")],
    ["invalid finished value", (index: string) => index.replace("| No |", "| Maybe |")],
  ] as const)("rejects %s", (_name, mutate) => {
    const directory = fixture();
    const index = path.join(directory, "area", INDEX);
    writeFileSync(index, mutate(readFileSync(index, "utf8")));
    expect(() => checkAreaIndex(path.dirname(index))).toThrow();
  });

  test("middle-row deletion requires renumbering the remaining rows", () => {
    const directory = fixture();
    const index = path.join(directory, "area", INDEX);
    rmSync(path.join(directory, "area/0002-middle.md"));
    const remaining = readFileSync(index, "utf8")
      .split("\n")
      .filter((line) => !line.includes("0002-middle.md"))
      .join("\n");
    writeFileSync(index, remaining);
    expect(() => checkAreaIndex(path.dirname(index))).toThrow();
    writeFileSync(index, remaining.replace("| 3 |", "| 2 |"));
    checkAreaIndex(path.dirname(index));
  });

  test("rejects an unlinked area folder", () => {
    const directory = fixture();
    writeFixtureFile(directory, `unlinked/${INDEX}`);
    expect(() => checkFolderLinks(directory)).toThrow();
  });

  test("rejects a todo file at the top level", () => {
    const directory = fixture();
    writeFixtureFile(directory, "0004-misplaced.md");
    expect(() => checkFolderLinks(directory)).toThrow();
  });
});
