import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandChangeJournal,
  hasMeasuredChanges,
  parseMeasuredWorkspaceChange,
  readCommandChangeJournalFile,
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
    await journal.append("late", change(2));
    expect((await journal.read()).size).toBe(0);
  });

  test("round-trips file statuses needed by deleted-file links", async () => {
    const journal = new CommandChangeJournal(path);
    await journal.append("deleted", {
      additions: 0,
      deletions: 1,
      files: [{ path: "gone.ts", status: "D", additions: 0, deletions: 1 }],
    });
    expect((await new CommandChangeJournal(path).read()).get("deleted")?.files[0]?.status).toBe(
      "D",
    );
  });
});

describe("adoptOlder", () => {
  test("puts older records first, so the journal's own survive the entry limit", async () => {
    const journal = new CommandChangeJournal(path, 3);
    await journal.append("current-1", change(1));
    await journal.append("shared", change(2));
    await journal.append("current-2", change(3));
    await journal.adoptOlder(
      new Map([
        ["older-1", change(10)],
        ["shared", change(20)],
      ]),
    );
    const records = await new CommandChangeJournal(path, 3).read();
    expect(Array.from(records.keys())).toEqual(["current-1", "shared", "current-2"]);
    expect(records.get("shared")?.additions).toBe(2);
  });

  test("keeps older records that fit, ahead of the journal's own", async () => {
    const journal = new CommandChangeJournal(path, 4);
    await journal.append("current", change(1));
    await journal.adoptOlder(
      new Map([
        ["older-1", change(10)],
        ["older-2", change(11)],
      ]),
    );
    await journal.append("later", change(2));
    expect(Array.from((await new CommandChangeJournal(path, 4).read()).keys())).toEqual([
      "older-1",
      "older-2",
      "current",
      "later",
    ]);
  });

  test("rejects and leaves the journal alone when it cannot be read", async () => {
    mkdirSync(path, { recursive: true });
    const journal = new CommandChangeJournal(path);
    await expect(journal.adoptOlder(new Map([["older", change(1)]]))).rejects.toThrow();
    // A later append still runs: a failed adoption does not wedge the queue.
    rmSync(path, { recursive: true });
    await journal.append("after", change(2));
    expect(Array.from((await journal.read()).keys())).toEqual(["after"]);
  });

  test("rejects when the merged file cannot be published, keeping the journal as it was", async () => {
    const journal = new CommandChangeJournal(path);
    await journal.append("current", change(1));
    // The temporary file's name is taken by a directory, so the publish fails.
    const temp = `${path}.${process.pid}.tmp`;
    mkdirSync(temp);
    await expect(journal.adoptOlder(new Map([["older", change(2)]]))).rejects.toThrow();
    expect(Array.from((await journal.read()).keys())).toEqual(["current"]);
    rmSync(temp, { recursive: true });
    await journal.adoptOlder(new Map([["older", change(2)]]));
    expect(Array.from((await journal.read()).keys())).toEqual(["older", "current"]);
    expect(existsSync(temp)).toBe(false);
  });
});

describe("readCommandChangeJournalFile", () => {
  test("reads a missing file as empty and rejects any other read failure", async () => {
    expect((await readCommandChangeJournalFile(path)).size).toBe(0);
    mkdirSync(path, { recursive: true });
    await expect(readCommandChangeJournalFile(path)).rejects.toThrow();
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
