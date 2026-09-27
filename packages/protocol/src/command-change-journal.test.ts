import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandChangeJournal,
  hasMeasuredChanges,
  parseMeasuredWorkspaceChange,
} from "./command-change-journal";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "change-journal-"));
  path = join(dir, "nested", "session.jsonl");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const change = (additions: number) => ({
  additions,
  deletions: 1,
  files: [{ path: "a.ts", additions, deletions: 1 }],
});

describe("CommandChangeJournal", () => {
  test("round-trips records, later records for an id winning", async () => {
    const journal = new CommandChangeJournal(path);
    await journal.append("t1", change(1));
    await journal.append("t2", { ...change(2), approximate: true });
    await journal.append("t1", change(3));
    const records = await new CommandChangeJournal(path).read();
    expect(Array.from(records.keys())).toEqual(["t2", "t1"]);
    expect(records.get("t1")?.additions).toBe(3);
    expect(records.get("t2")?.approximate).toBe(true);
  });

  test("skips corrupt lines and invalid records", async () => {
    const journal = new CommandChangeJournal(path);
    await journal.append("ok", change(1));
    appendFileSync(path, 'not json\n{"id":"bad","change":{"additions":-1,"deletions":0}}\n');
    expect(Array.from((await journal.read()).keys())).toEqual(["ok"]);
  });

  test("keeps only the newest entries and compacts the file", async () => {
    const journal = new CommandChangeJournal(path, 3);
    for (let index = 0; index < 5; index += 1) await journal.append(`t${index}`, change(index));
    const records = await journal.read();
    expect(Array.from(records.keys())).toEqual(["t2", "t3", "t4"]);
    expect(readFileSync(path, "utf8").trim().split("\n").length).toBeLessThanOrEqual(3 + 2);
  });

  test("reads nothing from a missing file and removes its file", async () => {
    const journal = new CommandChangeJournal(path);
    expect((await journal.read()).size).toBe(0);
    await journal.append("t1", change(1));
    await journal.remove();
    expect((await journal.read()).size).toBe(0);
  });
});

describe("parseMeasuredWorkspaceChange", () => {
  test("bounds the file list and flags the truncation", () => {
    const files = Array.from({ length: 5 }, (_, index) => ({
      path: `f${index}`,
      additions: 1,
      deletions: 0,
    }));
    expect(parseMeasuredWorkspaceChange({ additions: 5, deletions: 0, files }, 2)).toEqual({
      additions: 5,
      deletions: 0,
      files: files.slice(0, 2),
      filesTruncated: true,
    });
  });

  test("rejects malformed totals", () => {
    expect(parseMeasuredWorkspaceChange({ additions: "1", deletions: 0 })).toBeUndefined();
    expect(parseMeasuredWorkspaceChange(null)).toBeUndefined();
  });

  test("hasMeasuredChanges ignores a measured no-op", () => {
    expect(hasMeasuredChanges({ additions: 0, deletions: 0, files: [] })).toBe(false);
    expect(hasMeasuredChanges(change(0))).toBe(true);
  });
});
