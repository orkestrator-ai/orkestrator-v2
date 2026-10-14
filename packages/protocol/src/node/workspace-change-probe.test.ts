import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseNameStatusZ,
  parseNumstatZ,
  runGit,
  WorkspaceChangeProbe,
  type GitRunner,
} from "./workspace-change-probe";

let repo: string;
let probeTemp: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function write(path: string, content: string): void {
  writeFileSync(join(repo, path), content);
}

function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join("");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "probe-repo-"));
  probeTemp = mkdtempSync(join(tmpdir(), "probe-temp-"));
  git("init", "-q");
  git("config", "user.email", "probe@example.com");
  git("config", "user.name", "Probe");
  write("tracked.txt", lines(5));
  write(".gitignore", "ignored/\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(probeTemp, { recursive: true, force: true });
});

function probe(options: ConstructorParameters<typeof WorkspaceChangeProbe>[0] = {}) {
  return new WorkspaceChangeProbe({ tempDir: probeTemp, ...options });
}

describe("WorkspaceChangeProbe", () => {
  test("measures tracked edits, new files and deletions made during the window", async () => {
    write("doomed.txt", lines(3));
    const subject = probe();
    await subject.begin(repo, "call-1");

    write("tracked.txt", lines(5).replace("line 2\n", "changed\n") + "extra\n");
    write("new.txt", lines(4, "fresh"));
    rmSync(join(repo, "doomed.txt"));

    const change = await subject.end("call-1");
    expect(change).toEqual({
      additions: 6,
      deletions: 4,
      files: expect.arrayContaining([
        { path: "tracked.txt", status: "M", additions: 2, deletions: 1 },
        { path: "new.txt", status: "A", additions: 4, deletions: 0 },
        { path: "doomed.txt", status: "D", additions: 0, deletions: 3 },
      ]),
    });
    expect(change?.approximate).toBeUndefined();
  });

  test("does not charge a command for changes that were already dirty", async () => {
    write("tracked.txt", lines(9));
    write("untracked.txt", lines(2));
    const subject = probe();
    await subject.begin(repo, "call-1");
    expect(await subject.end("call-1")).toEqual({ additions: 0, deletions: 0, files: [] });
  });

  test("leaves the real index, HEAD and ignored files alone", async () => {
    const indexBefore = git("ls-files", "--stage");
    const head = git("rev-parse", "HEAD");
    await mkdir(join(repo, "ignored"));
    write("ignored/build.log", lines(50));
    const subject = probe();
    await subject.begin(repo, "call-1");
    write("ignored/build.log", lines(80));
    write("fresh.txt", "a\n");

    const change = await subject.end("call-1");
    expect(change?.files.map((file) => file.path)).toEqual(["fresh.txt"]);
    expect(git("ls-files", "--stage")).toBe(indexBefore);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("status", "--porcelain")).toContain("?? fresh.txt");
    expect(readdirSync(probeTemp)).toEqual([]);
  });

  test("never writes dirty file contents to the repository object database", async () => {
    const secret = `private-${crypto.randomUUID()}\n`;
    const oid = createHash("sha1")
      .update(`blob ${Buffer.byteLength(secret)}\0${secret}`)
      .digest("hex");
    const subject = probe();
    await subject.begin(repo, "secret-write");
    write("private.txt", secret);
    expect((await subject.end("secret-write"))?.files[0]?.status).toBe("A");
    rmSync(join(repo, "private.txt"));
    await subject.begin(repo, "secret-delete");
    await subject.end("secret-delete");
    expect(() => git("cat-file", "-e", oid)).toThrow();
    expect(readdirSync(probeTemp)).toEqual([]);
  });

  test("reports a git mv as a rename rather than a rewrite", async () => {
    const subject = probe();
    await subject.begin(repo, "call-1");
    git("mv", "tracked.txt", "moved.txt");
    expect(await subject.end("call-1")).toEqual({
      additions: 0,
      deletions: 0,
      files: [
        { path: "moved.txt", previousPath: "tracked.txt", status: "R", additions: 0, deletions: 0 },
      ],
    });
  });

  test("marks overlapping windows approximate, including noted edit calls", async () => {
    const subject = probe();
    await subject.begin(repo, "shell-a");
    await subject.note(repo, "edit-b");
    write("tracked.txt", lines(6));
    await subject.end("edit-b");
    const change = await subject.end("shell-a");
    expect(change?.additions).toBe(1);
    expect(change?.approximate).toBe(true);

    await subject.begin(repo, "shell-c");
    write("tracked.txt", lines(7));
    expect((await subject.end("shell-c"))?.approximate).toBeUndefined();
  });

  test("never hashes large untracked files and flags a change to one", async () => {
    write("big.bin", "x".repeat(64));
    const subject = probe({ maxUntrackedFileBytes: 16 });
    await subject.begin(repo, "call-1");
    write("big.bin", "y".repeat(128));
    write("small.txt", "ok\n");
    const change = await subject.end("call-1");
    expect(change?.files.map((file) => file.path)).toEqual(["small.txt"]);
    expect(change?.approximate).toBe(true);
  });

  test("returns undefined outside a git repository and for unknown calls", async () => {
    const plain = mkdtempSync(join(tmpdir(), "probe-plain-"));
    try {
      const subject = probe();
      await subject.begin(plain, "call-1");
      expect(await subject.end("call-1")).toBeUndefined();
      expect(await subject.end("never-began")).toBeUndefined();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("an end that races a fire-and-forget begin still measures", async () => {
    const subject = probe();
    void subject.begin(repo, "call-1");
    const change = await subject.end("call-1");
    expect(change).toEqual({ additions: 0, deletions: 0, files: [] });
  });

  test("stops measuring a repository whose snapshots are repeatedly slow", async () => {
    let clock = 0;
    const subject = probe({ slowSnapshotMs: 10, now: () => (clock += 100) });
    // Both of the first call's snapshots are slow; the measurement it already
    // paid for is still reported, and the repository is dropped after it.
    await subject.begin(repo, "call-1");
    expect(await subject.end("call-1")).toEqual({ additions: 0, deletions: 0, files: [] });
    await subject.begin(repo, "call-2");
    expect(await subject.end("call-2")).toBeUndefined();
  });

  test("stops measuring a repository with too many untracked files", async () => {
    write("a.txt", "a\n");
    write("b.txt", "b\n");
    const subject = probe({ maxUntrackedFiles: 1 });
    await subject.begin(repo, "call-1");
    expect(await subject.end("call-1")).toBeUndefined();
  });

  test("callers queued behind a running snapshot share one", async () => {
    const snapshotStarts: string[] = [];
    const counting: GitRunner = (args, options) => {
      if (args[0] === "ls-files") snapshotStarts.push(args[0]);
      return runGit(args, options);
    };
    const subject = probe({ git: counting });
    await Promise.all([
      subject.begin(repo, "a"),
      subject.begin(repo, "b"),
      subject.begin(repo, "c"),
    ]);
    expect(snapshotStarts).toHaveLength(1);
    const ends = await Promise.all([subject.end("a"), subject.end("b"), subject.end("c")]);
    expect(ends.every((change) => change?.approximate === true)).toBe(true);
    // One "after" snapshot runs; the two calls that ask meanwhile share the next.
    expect(snapshotStarts).toHaveLength(3);
  });

  test("an abandoned window stops marking later calls approximate", async () => {
    let clock = 0;
    const subject = probe({ maxWindowMs: 1_000, now: () => clock });
    await subject.begin(repo, "never-ends");
    clock = 5_000;
    await subject.begin(repo, "call-1");
    write("tracked.txt", lines(6));
    const change = await subject.end("call-1");
    expect(change?.additions).toBe(1);
    expect(change?.approximate).toBeUndefined();
    expect(await subject.end("never-ends")).toBeUndefined();
  });

  test("discarded fresh windows release their private snapshot", async () => {
    const subject = probe();
    await subject.begin(repo, "denied");
    subject.discard("denied");
    for (let attempt = 0; attempt < 50 && readdirSync(probeTemp).length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(readdirSync(probeTemp)).toEqual([]);
  });

  test("caps the reported file list but not the totals", async () => {
    const subject = probe({ maxReportedFiles: 2 });
    await subject.begin(repo, "call-1");
    for (const name of ["a", "b", "c"]) write(`${name}.txt`, "1\n2\n");
    const change = await subject.end("call-1");
    expect(change?.additions).toBe(6);
    expect(change?.files).toHaveLength(2);
    expect(change?.filesTruncated).toBe(true);
  });
});

describe("parseNumstatZ", () => {
  test("parses plain, binary and renamed entries", () => {
    expect(parseNumstatZ("3\t1\tsrc/a.ts\0-\t-\timg.png\0" + "0\t0\t\0old.ts\0new.ts\0")).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1 },
      { path: "img.png", additions: 0, deletions: 0, binary: true },
      { path: "new.ts", previousPath: "old.ts", additions: 0, deletions: 0 },
    ]);
  });

  test("keeps tabs and newlines inside paths", () => {
    expect(parseNumstatZ("1\t0\tweird\tname\nx\0")).toEqual([
      { path: "weird\tname\nx", additions: 1, deletions: 0 },
    ]);
  });
});

test("parseNameStatusZ keeps rename targets and deleted paths", () => {
  expect([...parseNameStatusZ("A\0new\0D\0gone\0R100\0old\0moved\0")]).toEqual([
    ["new", "A"],
    ["gone", "D"],
    ["moved", "R"],
  ]);
});

describe("WorkspaceChangeProbe baseline mode", () => {
  test("retains only the latest private baseline and removes it on close", async () => {
    const subject = probe();
    await subject.prime(repo);
    expect(readdirSync(probeTemp)).toHaveLength(1);
    for (const index of [6, 7, 8]) {
      await subject.begin(repo, `call-${index}`, { baseline: true });
      write("tracked.txt", lines(index));
      await subject.end(`call-${index}`);
      expect(readdirSync(probeTemp)).toHaveLength(1);
    }
    await subject.close();
    expect(readdirSync(probeTemp)).toEqual([]);
  });
  test("suppresses a command whose first prime has not read the worktree", async () => {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const atAdd = new Promise<void>((resolve) => (entered = resolve));
    let held = false;
    const runner: GitRunner = async (args, options) => {
      if (args[0] === "add" && !held) {
        held = true;
        entered();
        await blocked;
      }
      return runGit(args, options);
    };
    const subject = probe({ git: runner });
    const prime = subject.prime(repo);
    await atAdd;
    write("tracked.txt", lines(6));
    void subject.begin(repo, "racing-call", { baseline: true });
    const ending = subject.end("racing-call");
    release();
    await prime;
    expect(await ending).toBeUndefined();
  });

  test("keeps an ending call in the overlap window through its after snapshot", async () => {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const atAdd = new Promise<void>((resolve) => (entered = resolve));
    let additions = 0;
    const runner: GitRunner = async (args, options) => {
      if (args[0] === "add" && ++additions === 2) {
        entered();
        await blocked;
      }
      return runGit(args, options);
    };
    const subject = probe({ git: runner });
    await subject.prime(repo);
    await subject.begin(repo, "a", { baseline: true });
    write("a.txt", "a\n");
    const endA = subject.end("a");
    await atAdd;
    void subject.begin(repo, "b", { baseline: true });
    write("b.txt", "b\n");
    const endB = subject.end("b");
    release();
    expect((await endA)?.approximate).toBe(true);
    expect((await endB)?.approximate).toBe(true);
    await subject.close();
  });
  test("measures a command that finished before its start was observed", async () => {
    const subject = probe();
    await subject.prime(repo);
    // The command has already written by the time its start event arrives.
    write("tracked.txt", lines(7));
    void subject.begin(repo, "call-1", { baseline: true });
    const change = await subject.end("call-1");
    expect(change).toEqual({
      additions: 2,
      deletions: 0,
      files: [{ path: "tracked.txt", status: "M", additions: 2, deletions: 0 }],
    });
  });

  test("a noted edit refreshes the baseline so the next command is not charged for it", async () => {
    const subject = probe();
    await subject.prime(repo);
    await subject.note(repo, "edit-1");
    write("tracked.txt", lines(9));
    await subject.end("edit-1");

    write("other.txt", "x\n");
    void subject.begin(repo, "shell-1", { baseline: true });
    const change = await subject.end("shell-1");
    expect(change?.files.map((file) => file.path)).toEqual(["other.txt"]);
    expect(change?.approximate).toBeUndefined();
  });

  test("without a baseline the result is approximate", async () => {
    const subject = probe();
    await subject.begin(repo, "call-1", { baseline: true });
    write("tracked.txt", lines(6));
    const change = await subject.end("call-1");
    expect(change?.additions).toBe(1);
    expect(change?.approximate).toBe(true);
  });
});
