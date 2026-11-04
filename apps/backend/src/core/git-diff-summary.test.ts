import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseGitDiffSummary,
  parseGitFileChanges,
  parseGitNumstat,
  withoutStatOnlyModifications,
} from "./git-diff-summary.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8");
}

const body = (seed: string, lines = 12) =>
  Array.from({ length: lines }, (_, line) => `${seed} ${line}\n`).join("");

/** A byte-for-byte file name that is not valid UTF-8. */
const NON_UTF8_NAME = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(".txt")]);
const NON_UTF8_RENAMED = Buffer.concat([
  Buffer.from("ren"),
  Buffer.from([0xff]),
  Buffer.from(".txt"),
]);

function repositoryWithEveryChange(): { repo: string; base: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "ork-diff-summary-"));
  roots.push(repo);
  const write = (name: string, contents: string | Buffer) => {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    writeFileSync(path.join(repo, name), contents);
  };
  git(repo, "init", "-q", "-b", "main");
  write("modified.txt", body("modified"));
  write("deleted.txt", body("deleted"));
  write("old name.txt", body("rename exact"));
  write("dir with space/before.txt", body("rename edit"));
  write("tab\tand\nnewline.txt", body("control"));
  write(":looks-raw.txt", body("colon"));
  write("1\t2\tlooks-numstat.txt", body("numstat"));
  write("binary.bin", Buffer.from([0, 1, 2, 3]));
  write("mode.sh", "#!/bin/sh\n");
  write("stat-only.txt", body("stat"));
  write("empty.txt", "");
  writeFileSync(Buffer.concat([Buffer.from(`${repo}/`), NON_UTF8_NAME]), body("latin1 modified"));
  writeFileSync(Buffer.concat([Buffer.from(`${repo}/`), NON_UTF8_RENAMED]), body("latin1 renamed"));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD").trim();

  write("modified.txt", `${body("modified")}more\nand more\n`);
  unlinkSync(path.join(repo, "deleted.txt"));
  renameSync(path.join(repo, "old name.txt"), path.join(repo, "new name.txt"));
  write("dir with space/after edit.txt", `${body("rename edit")}edited\n`);
  unlinkSync(path.join(repo, "dir with space/before.txt"));
  write("tab\tand\nnewline.txt", `${body("control")}edited\n`);
  write(":looks-raw.txt", `${body("colon")}edited\n`);
  write("1\t2\tlooks-numstat.txt", `${body("numstat")}edited\n`);
  write("binary.bin", Buffer.from([0, 9, 9, 9]));
  chmodSync(path.join(repo, "mode.sh"), 0o755);
  writeFileSync(
    Buffer.concat([Buffer.from(`${repo}/`), NON_UTF8_NAME]),
    `${body("latin1 modified")}x\n`,
  );
  renameSync(
    Buffer.concat([Buffer.from(`${repo}/`), NON_UTF8_RENAMED]),
    Buffer.concat([
      Buffer.from(`${repo}/`),
      Buffer.from("réné"),
      Buffer.from([0xfe]),
      Buffer.from(".txt"),
    ]),
  );
  write("staged new.txt", body("added"));
  git(repo, "add", "-A");
  // Unstaged on top of staged, and a file whose stat changed but whose bytes did not.
  write("modified.txt", `${body("modified")}more\nand more\nunstaged\n`);
  utimesSync(path.join(repo, "stat-only.txt"), new Date("2001-01-01"), new Date("2001-01-01"));
  return { repo, base };
}

const NO_REFRESH = ["-c", "diff.autoRefreshIndex=false", "--no-optional-locks"];
const DIFF = ["diff", "--no-ext-diff", "--no-textconv"];

/** What every scan did before ST-14: two processes, then the stat-only filter. */
function twoPassChanges(repo: string, ...range: string[]) {
  const nameStatus = git(repo, ...NO_REFRESH, ...DIFF, "--name-status", "-z", "-M", ...range);
  const numstat = git(repo, ...NO_REFRESH, ...DIFF, "--numstat", "-z", "-M", ...range);
  const changed = parseGitNumstat(numstat);
  return parseGitFileChanges(nameStatus, numstat).filter(
    (change) => change.status !== "M" || changed.has(change.path),
  );
}

function onePassChanges(repo: string, ...range: string[]) {
  return withoutStatOnlyModifications(
    parseGitDiffSummary(
      git(repo, ...NO_REFRESH, ...DIFF, "--raw", "--numstat", "-z", "-M", ...range),
    ),
  );
}

describe("one combined diff pass", () => {
  test("reports exactly what the two separate passes reported, working tree against a commit", () => {
    const { repo, base } = repositoryWithEveryChange();
    const before = twoPassChanges(repo, base);
    expect(onePassChanges(repo, base)).toEqual(before);

    // The comparison above must have exercised every case it claims to.
    const byPath = new Map(before.map((change) => [change.path, change]));
    expect(byPath.get("new name.txt")).toMatchObject({
      status: "R100",
      originalPath: "old name.txt",
      additions: 0,
      deletions: 0,
    });
    expect(byPath.get("dir with space/after edit.txt")).toMatchObject({
      originalPath: "dir with space/before.txt",
      additions: 1,
      deletions: 0,
      directory: "dir with space",
      filename: "after edit.txt",
    });
    expect(byPath.get("modified.txt")).toMatchObject({ status: "M", additions: 3 });
    expect(byPath.get("deleted.txt")).toMatchObject({ status: "D", deletions: 12 });
    expect(byPath.get("staged new.txt")).toMatchObject({ status: "A", additions: 12 });
    expect(byPath.get("tab\tand\nnewline.txt")).toMatchObject({ status: "M", additions: 1 });
    expect(byPath.get(":looks-raw.txt")).toMatchObject({ status: "M", additions: 1 });
    expect(byPath.get("1\t2\tlooks-numstat.txt")).toMatchObject({ status: "M", additions: 1 });
    expect(byPath.get("binary.bin")).toMatchObject({ status: "M", binary: true });
    expect(byPath.get("mode.sh")).toMatchObject({ status: "M", additions: 0, deletions: 0 });
    // Non-UTF-8 names decode lossily, and the same way in both shapes.
    expect(byPath.get("caf�.txt")).toMatchObject({ status: "M", additions: 1 });
    expect(byPath.get("réné�.txt")).toMatchObject({
      status: "R100",
      originalPath: "ren�.txt",
    });
    // A stat-only change is listed by the raw records and dropped by both filters.
    expect(byPath.has("stat-only.txt")).toBe(false);
    expect(
      parseGitDiffSummary(
        git(repo, ...NO_REFRESH, ...DIFF, "--raw", "--numstat", "-z", "-M", base),
      ).changes.some((change) => change.path === "stat-only.txt"),
    ).toBe(true);
  });

  test("reports exactly what the two separate passes reported between commits", () => {
    const { repo, base } = repositoryWithEveryChange();
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "work");
    const before = twoPassChanges(repo, base, "HEAD");
    expect(before.some((change) => change.status.startsWith("R"))).toBe(true);
    expect(onePassChanges(repo, base, "HEAD")).toEqual(before);
  });

  test("reports exactly what the two separate passes reported for a conflicted merge", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "ork-diff-summary-conflict-"));
    roots.push(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "conflict.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    const base = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "checkout", "-qb", "other");
    writeFileSync(path.join(repo, "conflict.txt"), "other\n");
    git(repo, "commit", "-qam", "other");
    git(repo, "checkout", "-q", "main");
    writeFileSync(path.join(repo, "conflict.txt"), "main\n");
    git(repo, "commit", "-qam", "main");
    expect(() => git(repo, "merge", "-q", "other")).toThrow();
    expect(onePassChanges(repo, base)).toEqual(twoPassChanges(repo, base));
    // Against the index, as the `unstaged` scope reads it: one path, two records.
    const before = twoPassChanges(repo);
    expect(before.map((change) => change.status)).toEqual(["U", "M"]);
    expect(onePassChanges(repo)).toEqual(before);
  });

  test("an empty diff is no changes", () => {
    expect(parseGitDiffSummary("")).toEqual({ changes: [], numstat: new Map() });
  });

  test("rejects malformed summaries", () => {
    for (const malformed of [
      ":100644 100644 aaa bbb M\0missing-terminator",
      ":100644 100644 aaa bbb\0file.txt\0",
      ":bad header\0file.txt\0",
      ":100644 100644 aaa bbb R100\0only-one-path\0",
      ":100644 100644 aaa bbb M\0\0",
      ":100644 100644 aaa bbb M\0file.txt\0bad\t0\tfile.txt\0",
      ":100644 100644 aaa bbb M\0file.txt\x001\t0\t\0old-only.txt\0",
    ]) {
      expect(() => parseGitDiffSummary(malformed)).toThrow("Malformed");
    }
  });
});
