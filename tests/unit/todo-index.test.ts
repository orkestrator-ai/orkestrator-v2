import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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

function areaFolders(): string[] {
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

describe("todo folders", () => {
  test("the top-level index links every area folder and holds no todo files", () => {
    const index = readFileSync(path.join(todo, INDEX), "utf8");

    expect(todoFiles(todo)).toEqual([]);
    expect(folderLinks(index).sort()).toEqual(areaFolders());
  });

  test("todo numbers are unique across folders, except the allowlisted duplicates", () => {
    const byNumber = new Map<string, string[]>();
    for (const folder of areaFolders()) {
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
  });

  for (const folder of areaFolders()) {
    test(`${folder} index has one rated row for every todo file`, () => {
      const directory = path.join(todo, folder);
      const rows = todoRows(readFileSync(path.join(directory, INDEX), "utf8"));
      const files = todoFiles(directory);

      expect(rows.map((row) => row.file).sort()).toEqual(files);
      expect(rows.map((row) => row.rank)).toEqual(rows.map((_, i) => String(i + 1)));
      for (const row of rows) {
        expect(CRITICALITY.has(row.criticality), `${row.file} is rated ${row.criticality}`).toBe(
          true,
        );
        expect(FINISHED.has(row.finished), `${row.file} has Finished ${row.finished}`).toBe(true);
      }
    });
  }
});
