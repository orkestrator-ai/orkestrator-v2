import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isExternalLink, relativeLinkProblem } from "../helpers/markdown-links";

const root = path.resolve(import.meta.dir, "../..");
const todo = path.join(root, "docs/todo");
const INDEX = "0000-index.md";

const TODO_FILE = /^\d{4}-.+\.md$/;
const CRITICALITY = new Set(["Very high", "High", "Medium", "Low"]);
// The four status columns of the top-level index, in order (docs/README.md,
// "Choosing a status"). Area folders use only `backlog` and `blocked`: every
// task that needs the user lives in the manual-test checklist, whose folder
// uses only `requires user input`. `done` is never valid: a finished file is
// retired in the same change.
const STATUSES = ["backlog", "blocked", "requires user input", "done"] as const;
type Status = (typeof STATUSES)[number];
const STATUS_SET = new Set<string>(STATUSES);
const AREA_STATUSES = new Set<string>(["backlog", "blocked"]);
const MANUAL_TEST = "manual-test";
const MANUAL_TEST_STATUSES = new Set<string>(["requires user input"]);
const NONE = "—";
const WAITS_ON = "Waits on:";
// A checklist item is one top-level checkbox whose bold label names its source
// to-do, the task or check within it, and a title, followed by the steps and
// what to record, e.g.
// `- [ ] **[0039](../mcp/0039-mcp-management.md) task 1: title.** Steps. Record: ...`.
// The label must close, the task identity and title must be non-empty, and at
// least a short instruction must follow it (longer steps may continue in
// sub-bullets), so a bare source such as `**0009 (retired) **` is refused.
const CHECKBOX = /^\s*- \[[ xX]\] /;
const CHECKLIST_ITEM =
  /^- \[[ xX]\] \*\*(?:\[\d{4}\]\([^)]+\)|\d{4} \(retired\)) [^:*\s][^:*]*: [^\s*].*?\*\* \S.{9,}$/;

// Numbers already shared by more than one todo file when the uniqueness check
// was added (todo 0732). They keep their numbers, because a todo number is a
// permanent ID (docs/README.md). Finished files are deleted, so an entry may
// shrink, but no number here may gain a file that is not listed.
const ALLOWED_DUPLICATES: Record<string, string[]> = {
  "0054": [
    "cross-cutting/0054-agent-test-pi-default-model.md",
    "design-canvas/0054-design-canvas-accessibility-findings.md",
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
  const manualTest = path.basename(directory) === MANUAL_TEST;
  const allowed = manualTest ? MANUAL_TEST_STATUSES : AREA_STATUSES;

  expect(rows.map((row) => row.file).sort()).toEqual(files);
  expect(rows.map((row) => row.rank)).toEqual(rows.map((_, i) => String(i + 1)));
  for (const row of rows) {
    expect(CRITICALITY.has(row.criticality), `${row.file} is rated ${row.criticality}`).toBe(true);
    expect(
      allowed.has(row.status),
      manualTest
        ? `${row.file}: the manual-test folder holds only "requires user input" rows`
        : `${row.file} has Status ${row.status}; an area to-do is backlog or blocked, and work ` +
            "that needs the user belongs in the manual-test checklist",
    ).toBe(true);
    expect(row.needsYou, `${row.file} has an empty Needs you cell`).not.toBe("");
    if (row.status === "requires user input") {
      expect(row.needsYou, `${row.file} must say what the user must provide`).not.toBe(NONE);
    }
    if (row.status === "backlog") {
      expect(
        row.needsYou,
        `${row.file}: a backlog row's Needs you is "${NONE}"; move the user's part to the manual-test checklist`,
      ).toBe(NONE);
    }
    expect(
      row.needsYou.startsWith(WAITS_ON),
      `${row.file}: every blocked row, and only a blocked row, starts Needs you with "${WAITS_ON}"`,
    ).toBe(row.status === "blocked");
  }
}

// The manual-test folder exists, and every checkbox in its checklist names its
// source to-do and task, and every relative link in it resolves.
function checkManualTest(todo: string) {
  const directory = path.join(todo, MANUAL_TEST);
  const files = todoFiles(directory);
  expect(files.length, "the manual-test folder holds one checklist file").toBe(1);
  const checklist = readFileSync(path.join(directory, files[0]!), "utf8");
  const items = checklist.split("\n").filter((line) => CHECKBOX.test(line));
  expect(items.length, "the checklist has checkbox items").toBeGreaterThan(0);
  for (const item of items) {
    expect(
      item,
      "a checklist item names its source, task and title in bold, then what to do",
    ).toMatch(CHECKLIST_ITEM);
  }
  const checklistPath = path.join(directory, files[0]!);
  const broken = [...checklist.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1]!)
    .filter((link) => !isExternalLink(link))
    .map((link) => ({ link, problem: relativeLinkProblem(checklistPath, link) }))
    .filter((entry) => entry.problem !== undefined)
    .map((entry) => `${entry.link}: ${entry.problem}`);
  expect(broken, "checklist links that do not resolve").toEqual([]);
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

  test("the manual-test checklist names a source for every item and its links resolve", () => {
    checkManualTest(todo);
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
      "| [Area](area/0000-index.md) | 2 | 1 | 0 | 0 | 3 | Example |",
      "| [Manual test](manual-test/0000-index.md) | 0 | 0 | 1 | 0 | 1 | Checklist |",
      "| **Total** | 2 | 1 | 1 | 0 | 4 | |",
    ].join("\n"),
  );
  for (const file of ["0001-first.md", "0002-middle.md", "0003-last.md"]) {
    writeFixtureFile(directory, `area/${file}`);
  }
  writeFixtureFile(
    directory,
    "area/0001-first.md",
    ["# First", "## Set-up `env`", "### Machines", "```", "## Fenced", "```", "## Machines"].join(
      "\n",
    ),
  );
  writeFixtureFile(
    directory,
    `area/${INDEX}`,
    [
      "| 1 | [0001-first.md](0001-first.md) | High | backlog | — | Example | Notes |",
      "| 2 | [0002-middle.md](0002-middle.md) | High | blocked | Waits on: 0001 | Example | Notes |",
      "| 3 | [0003-last.md](0003-last.md) | Low | backlog | — | Example | Notes |",
    ].join("\n"),
  );
  writeFixtureFile(
    directory,
    `${MANUAL_TEST}/0004-checklist.md`,
    [
      "## Manual tests",
      "- [ ] **[0001](../area/0001-first.md) task 1: run it.** Record the result.",
      "- [ ] **0009 (retired) task 2: decide.** Record the decision.",
      "  (Background: [set-up](../area/0001-first.md#set-up-env), [second](../area/0001-first.md#machines-1), [index](0000-index.md), [top](#manual-tests), [web](https://example.com/a#b).)",
    ].join("\n"),
  );
  writeFixtureFile(
    directory,
    `${MANUAL_TEST}/${INDEX}`,
    "| 1 | [0004-checklist.md](0004-checklist.md) | High | requires user input | Work through it | Example | Notes |",
  );
  // Every negative case starts with a valid filesystem and exercises the same
  // checks as the live documentation above, without modifying the repository.
  checkFolderLinks(directory);
  checkStatusCounts(directory);
  checkTodoNumbers(directory);
  checkAreaIndex(path.join(directory, "area"));
  checkAreaIndex(path.join(directory, MANUAL_TEST));
  checkManualTest(directory);
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
      "requires user input in an area folder",
      (index: string) =>
        index.replace("| Low | backlog | — |", "| Low | requires user input | Decide the scope |"),
    ],
    ["done row", (index: string) => index.replace("| Low | backlog | — |", "| Low | done | — |")],
    [
      "backlog row naming a user part",
      (index: string) => index.replace("| Low | backlog | — |", "| Low | backlog | Your login |"),
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
        index.replace("| 2 | 1 | 0 | 0 | 3 | Example |", "| 3 | 0 | 0 | 0 | 3 | Example |"),
    ],
    [
      "missing folder counts",
      (index: string) => index.replace("| 2 | 1 | 0 | 0 | 3 | Example |", "| Example |"),
    ],
    [
      "stale total",
      (index: string) =>
        index.replace("| **Total** | 2 | 1 | 1 | 0 | 4 |", "| **Total** | 2 | 1 | 1 | 0 | 5 |"),
    ],
    ["missing total row", (index: string) => index.split("\n").slice(0, 4).join("\n")],
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

  test.each([
    [
      "a backlog row",
      (index: string) =>
        index.replace("| requires user input | Work through it |", "| backlog | — |"),
    ],
    [
      "a user row without Needs you",
      (index: string) =>
        index.replace("| requires user input | Work through it |", "| requires user input | — |"),
    ],
  ] as const)("rejects a manual-test index with %s", (_name, mutate) => {
    const directory = fixture();
    const index = path.join(directory, MANUAL_TEST, INDEX);
    writeFileSync(index, mutate(readFileSync(index, "utf8")));
    expect(() => checkAreaIndex(path.dirname(index))).toThrow();
  });

  test.each([
    ["an item without a source", "- [ ] Run the live check and record it."],
    ["an item that names only its source", "- [ ] **0009 (retired) **"],
    [
      "an item that names only its linked source",
      "- [ ] **[0001](../area/0001-first.md)** Record.",
    ],
    [
      "an item without a task identity",
      "- [ ] **[0001](../area/0001-first.md): run it.** Record the result.",
    ],
    ["an item without a title", "- [ ] **0009 (retired) task 2:** Record the result."],
    [
      "an item whose label never closes",
      "- [ ] **0009 (retired) task 2: run it. Record the result.",
    ],
    ["an item with nothing to do after its label", "- [ ] **0009 (retired) task 2: run it.**"],
    [
      "an item with an unresolved link",
      "- [ ] **[0002](../area/0002-gone.md) task 1: run.** Record the result.",
    ],
    [
      "an unresolved same-folder link",
      "- [ ] **0009 (retired) task 3: run.** See [notes](0006-gone.md) first.",
    ],
    [
      "an anchor no heading has",
      "- [ ] **[0001](../area/0001-first.md#missing) task 2: run.** Record the result.",
    ],
    [
      "an anchor that only a fenced line would produce",
      "- [ ] **[0001](../area/0001-first.md#fenced) task 2: run.** Record the result.",
    ],
    [
      "the bare anchor of a repeated heading",
      "- [ ] **[0001](../area/0001-first.md#machines) task 2: run.** Record the result.",
    ],
    [
      "a same-file anchor no heading has",
      "- [ ] **0009 (retired) task 4: run.** See [x](#nowhere) first.",
    ],
  ] as const)("rejects a checklist with %s", (_name, line) => {
    const directory = fixture();
    const checklist = path.join(directory, MANUAL_TEST, "0004-checklist.md");
    writeFileSync(checklist, `${readFileSync(checklist, "utf8")}\n${line}`);
    expect(() => checkManualTest(directory)).toThrow();
  });

  test("rejects a second checklist file", () => {
    const directory = fixture();
    writeFixtureFile(
      directory,
      `${MANUAL_TEST}/0005-another.md`,
      "- [ ] **0001 (retired) task 1: x.**",
    );
    expect(() => checkManualTest(directory)).toThrow();
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
