import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// plans/graphs/ keeps one file per work item of plans/composable-graphs.md.
// An item's status lives in its front matter and is mirrored by a row in
// 000-index.md. Agents update both (plans/graphs/AGENTS.md); this keeps the
// format parseable and the two from drifting apart.

const root = path.resolve(import.meta.dir, "../..");
const folder = path.join(root, "plans/graphs");
const INDEX = "000-index.md";

const ITEM_FILE = /^(\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const STATUSES = new Set(["not-started", "in-progress", "blocked", "done", "dropped"]);
const KEYS = [
  "id",
  "title",
  "phase",
  "plan",
  "status",
  "depends_on",
  "blocked_by",
  "owner",
  "branch",
  "pr",
  "updated",
];

interface Item {
  file: string;
  id: string;
  title: string;
  phase: string;
  plan: string;
  status: string;
  dependsOn: string[];
  blockedBy: string;
  owner: string;
  branch: string;
  pr: string;
  updated: string;
  body: string;
}

interface Row {
  id: string;
  file: string;
  phase: string;
  status: string;
  dependsOn: string[];
}

function quoted(file: string, key: string, raw: string): string {
  if (!/^".*"$/.test(raw)) throw new Error(`${file}: ${key} must be a double-quoted string`);
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "string") throw new Error(`${file}: ${key} must be a string`);
  return value;
}

function parseItem(file: string): Item {
  const text = readFileSync(path.join(folder, file), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${file}: missing front matter`);
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z_]+): (.*)$/.exec(line);
    if (!field) throw new Error(`${file}: malformed front matter line ${JSON.stringify(line)}`);
    fields.set(field[1]!, field[2]!);
  }
  expect([...fields.keys()], `${file}: front matter keys and their order`).toEqual(KEYS);
  const field = (key: string) => fields.get(key)!;
  const deps = /^\[(\d{3}(?:, \d{3})*)?\]$/.exec(field("depends_on"));
  if (!deps) throw new Error(`${file}: depends_on must be [] or [101, 102]`);
  return {
    file,
    id: field("id"),
    title: quoted(file, "title", field("title")),
    phase: field("phase"),
    plan: quoted(file, "plan", field("plan")),
    status: field("status"),
    dependsOn: deps[1] ? deps[1].split(", ") : [],
    blockedBy: quoted(file, "blocked_by", field("blocked_by")),
    owner: quoted(file, "owner", field("owner")),
    branch: quoted(file, "branch", field("branch")),
    pr: quoted(file, "pr", field("pr")),
    updated: field("updated"),
    body: text.slice(match[0].length),
  };
}

function tableCells(line: string): string[] | undefined {
  if (!line.startsWith("| ")) return undefined;
  return line
    .slice(1, line.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
}

function indexRows(): Row[] {
  const rows: Row[] = [];
  for (const line of readFileSync(path.join(folder, INDEX), "utf8").split("\n")) {
    const cells = tableCells(line);
    if (!cells || cells.length < 6 || !/^\d{3}$/.test(cells[0]!)) continue;
    const link = /^\[([^\]]+\.md)\]\(\1\)$/.exec(cells[1]!);
    if (!link) throw new Error(`${INDEX}: row ${cells[0]} must link its file as [name](name)`);
    rows.push({
      id: cells[0]!,
      file: link[1]!,
      phase: cells[2]!,
      status: cells[3]!,
      dependsOn: cells[4] === "—" ? [] : cells[4]!.split(", "),
    });
  }
  return rows;
}

function itemFiles(): string[] {
  return readdirSync(folder)
    .filter((name) => name !== INDEX && /^\d/.test(name))
    .sort();
}

function cycles(items: Item[]): string[] {
  const deps = new Map(items.map((item) => [item.id, item.dependsOn]));
  const state = new Map<string, "visiting" | "done">();
  const found: string[] = [];
  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      found.push([...trail.slice(trail.indexOf(id)), id].join(" → "));
      return;
    }
    state.set(id, "visiting");
    for (const dep of deps.get(id) ?? []) visit(dep, [...trail, id]);
    state.set(id, "done");
  };
  for (const id of deps.keys()) visit(id, []);
  return found;
}

describe("graphs plan work items", () => {
  const files = itemFiles();
  const items = files.map((file) => {
    expect(ITEM_FILE.test(file), `${file} is named NNN-kebab-case.md`).toBe(true);
    return parseItem(file);
  });
  const ids = new Set(items.map((item) => item.id));

  test("every item file has valid front matter", () => {
    for (const item of items) {
      const where = item.file;
      expect(item.id, `${where}: id matches the file name`).toBe(item.file.slice(0, 3));
      expect(item.phase, `${where}: phase is the id's first digit`).toBe(item.id[0]!);
      expect(STATUSES.has(item.status), `${where}: status ${item.status}`).toBe(true);
      expect(item.title.length > 0 && item.plan.length > 0, `${where}: title and plan`).toBe(true);
      expect(/^\d{4}-\d{2}-\d{2}$/.test(item.updated), `${where}: updated is YYYY-MM-DD`).toBe(
        true,
      );
      expect(item.body.trimStart().split("\n")[0], `${where}: heading`).toBe(
        `# ${item.id} · ${item.title}`,
      );
    }
  });

  test("statuses carry the fields they need", () => {
    for (const item of items) {
      const where = item.file;
      expect(item.blockedBy !== "", `${where}: blocked_by is set exactly when blocked`).toBe(
        item.status === "blocked",
      );
      if (item.status === "in-progress") {
        expect(item.owner !== "" && item.branch !== "", `${where}: owner and branch`).toBe(true);
      }
      if (item.status === "done") {
        expect(item.pr !== "", `${where}: a done item names its pull request`).toBe(true);
        expect(/^\s*- \[ \]/m.test(item.body), `${where}: a done item has no open boxes`).toBe(
          false,
        );
      }
    }
  });

  test("dependencies exist and form no cycle", () => {
    for (const item of items) {
      for (const dep of item.dependsOn) {
        expect(ids.has(dep), `${item.file}: depends on unknown item ${dep}`).toBe(true);
        expect(dep, `${item.file}: depends on itself`).not.toBe(item.id);
      }
    }
    expect(cycles(items)).toEqual([]);
  });

  test("the index has one matching row per item, in ID order", () => {
    const rows = indexRows();
    expect(rows.map((row) => row.file)).toEqual(files);
    const byFile = new Map(items.map((item) => [item.file, item]));
    for (const row of rows) {
      const item = byFile.get(row.file)!;
      expect(row.id, `${INDEX}: row for ${row.file}`).toBe(item.id);
      expect(row.phase, `${INDEX}: phase of ${row.id}`).toBe(item.phase);
      expect(row.status, `${INDEX}: status of ${row.id} must match its file`).toBe(item.status);
      expect(row.dependsOn, `${INDEX}: dependencies of ${row.id}`).toEqual(item.dependsOn);
    }
  });
});
