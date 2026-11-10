import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const todo = path.join(root, "docs/todo");
const INDEX = "0000-index.md";

const TODO_FILE = /^\d{4}-.+\.md$/;
const CRITICALITY = new Set(["Very high", "High", "Medium", "Low"]);
// The four statuses and the order they are chosen in (docs/README.md,
// "Choosing a status"). The top-level index counts them in this order.
const STATUSES = ["backlog", "blocked", "requires user input", "done"] as const;
type Status = (typeof STATUSES)[number];
const STATUS_SET = new Set<string>(STATUSES);
const NONE = "—";
const WAITS_ON = "Waits on:";

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

type TodoRow = {
  rank: string;
  file: string;
  criticality: string;
  status: string;
  needsYou: string;
};

// Folder index columns: Rank | File | Criticality | Status | Needs you |
// Covers | Why this rating.
function todoRows(index: string): TodoRow[] {
  const rows: TodoRow[] = [];
  for (const line of index.split("\n")) {
    const cells = tableCells(line);
    if (!cells || cells.length < 7 || !/^\d+$/.test(cells[0]!)) continue;
    const link = cells[1]!.match(/^\[([^\]]+\.md)\]\(\1\)$/);
    if (!link) continue;
    rows.push({
      rank: cells[0]!,
      file: link[1]!,
      criticality: cells[2]!,
      status: cells[3]!,
      needsYou: cells[4]!,
    });
  }
  return rows;
}

type StatusCounts = Record<Status | "total", number>;

function emptyCounts(): StatusCounts {
  return { backlog: 0, blocked: 0, "requires user input": 0, done: 0, total: 0 };
}

function countStatuses(rows: TodoRow[]): StatusCounts {
  const counts = emptyCounts();
  for (const row of rows) {
    if (STATUS_SET.has(row.status)) counts[row.status as Status] += 1;
    counts.total += 1;
  }
  return counts;
}

// Top-level index columns: Folder | backlog | blocked | requires user input |
// done | Total | Covers, then a `**Total**` row summing every folder.
function parseCountCells(cells: string[]): StatusCounts | undefined {
  const values = cells.slice(1, 6);
  if (values.length < 5 || !values.every((value) => /^\d+$/.test(value))) return undefined;
  const [backlog, blocked, needsUser, done, total] = values.map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return { backlog, blocked, "requires user input": needsUser, done, total };
}

function folderRows(index: string): Array<{ folder: string; counts: StatusCounts | undefined }> {
  const rows: Array<{ folder: string; counts: StatusCounts | undefined }> = [];
  for (const line of index.split("\n")) {
    const cells = tableCells(line);
    const link = cells?.[0]?.match(/^\[[^\]]+\]\(([a-z0-9-]+)\/0000-index\.md\)$/);
    if (cells && link) rows.push({ folder: link[1]!, counts: parseCountCells(cells) });
  }
  return rows;
}

function totalRow(index: string): StatusCounts | undefined {
  for (const line of index.split("\n")) {
    const cells = tableCells(line);
    if (cells?.[0] === "**Total**") return parseCountCells(cells);
  }
  return undefined;
}

function checkFolderLinks(todo: string) {
  const index = readFileSync(path.join(todo, INDEX), "utf8");
  expect(todoFiles(todo)).toEqual([]);
  expect(
    folderRows(index)
      .map((row) => row.folder)
      .sort(),
  ).toEqual(areaFolders(todo));
}

function checkStatusCounts(todo: string) {
  const index = readFileSync(path.join(todo, INDEX), "utf8");
  const sum = emptyCounts();
  for (const { folder, counts } of folderRows(index)) {
    const actual = countStatuses(todoRows(readFileSync(path.join(todo, folder, INDEX), "utf8")));
    expect(counts, `${folder} status counts in the top-level index`).toEqual(actual);
    for (const key of [...STATUSES, "total"] as const) sum[key] += actual[key];
  }
  expect(totalRow(index), "the top-level index total row").toEqual(sum);
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
    expect(STATUS_SET.has(row.status), `${row.file} has Status ${row.status}`).toBe(true);
    expect(row.needsYou, `${row.file} has an empty Needs you cell`).not.toBe("");
    if (row.status === "requires user input") {
      expect(row.needsYou, `${row.file} must say what the user must provide`).not.toBe(NONE);
    }
    expect(
      row.needsYou.startsWith(WAITS_ON),
      `${row.file}: every blocked row, and only a blocked row, starts Needs you with "${WAITS_ON}"`,
    ).toBe(row.status === "blocked");
  }
}

describe("todo folders", () => {
  test("the top-level index links every area folder and holds no todo files", () => {
    checkFolderLinks(todo);
  });

  test("the top-level index counts every folder's statuses and totals them", () => {
    checkStatusCounts(todo);
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
  writeFixtureFile(
    directory,
    INDEX,
    [
      "| Folder | backlog | blocked | requires user input | done | Total | Covers |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| [Area](area/0000-index.md) | 1 | 1 | 1 | 0 | 3 | Example |",
      "| **Total** | 1 | 1 | 1 | 0 | 3 | |",
    ].join("\n"),
  );
  for (const file of ["0001-first.md", "0002-middle.md", "0003-last.md"]) {
    writeFixtureFile(directory, `area/${file}`);
  }
  writeFixtureFile(
    directory,
    `area/${INDEX}`,
    [
      "| 1 | [0001-first.md](0001-first.md) | High | backlog | — | Example | Notes |",
      "| 2 | [0002-middle.md](0002-middle.md) | High | blocked | Waits on: 0001 | Example | Notes |",
      "| 3 | [0003-last.md](0003-last.md) | Low | requires user input | Decide the scope | Example | Notes |",
    ].join("\n"),
  );
  // Every negative case starts with a valid filesystem and exercises the same
  // checks as the live documentation above, without modifying the repository.
  checkFolderLinks(directory);
  checkStatusCounts(directory);
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
    ["invalid status", (index: string) => index.replace("| backlog |", "| in progress |")],
    ["capitalised status", (index: string) => index.replace("| backlog |", "| Backlog |")],
    ["old Finished column", (index: string) => index.replace("| backlog | — |", "| No |")],
    ["empty Needs you", (index: string) => index.replace("| backlog | — |", "| backlog |  |")],
    [
      "user row without Needs you",
      (index: string) =>
        index.replace("| requires user input | Decide the scope |", "| requires user input | — |"),
    ],
    [
      "blocked row without Waits on",
      (index: string) => index.replace("| Waits on: 0001 |", "| 0001 |"),
    ],
    [
      "Waits on outside a blocked row",
      (index: string) => index.replace("| backlog | — |", "| backlog | Waits on: 0002 |"),
    ],
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

  test.each([
    [
      "stale folder count",
      (index: string) =>
        index.replace("| 1 | 1 | 1 | 0 | 3 | Example |", "| 2 | 0 | 1 | 0 | 3 | Example |"),
    ],
    [
      "missing folder counts",
      (index: string) => index.replace("| 1 | 1 | 1 | 0 | 3 | Example |", "| Example |"),
    ],
    [
      "stale total",
      (index: string) =>
        index.replace("| **Total** | 1 | 1 | 1 | 0 | 3 |", "| **Total** | 1 | 1 | 1 | 0 | 4 |"),
    ],
    ["missing total row", (index: string) => index.split("\n").slice(0, 3).join("\n")],
  ] as const)("rejects a top-level index with a %s", (_name, mutate) => {
    const directory = fixture();
    const index = path.join(directory, INDEX);
    writeFileSync(index, mutate(readFileSync(index, "utf8")));
    expect(() => checkStatusCounts(directory)).toThrow();
  });

  test("a status change in a folder index requires updating the counts", () => {
    const directory = fixture();
    const index = path.join(directory, "area", INDEX);
    writeFileSync(
      index,
      readFileSync(index, "utf8").replace("| blocked | Waits on: 0001 |", "| backlog | — |"),
    );
    checkAreaIndex(path.dirname(index));
    expect(() => checkStatusCounts(directory)).toThrow();
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
