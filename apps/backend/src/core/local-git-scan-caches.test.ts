import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { statStamp } from "./stat-stamp.js";
import { UNTRACKED_SCAN_MAX_FILES } from "./commands-validation.js";
import {
  countUntrackedFileLines,
  dropLocalGitScanCaches,
  ensureLocalGitExcludeOnce,
  localGitScanCacheStats,
  resetLocalGitScanCachesForTests,
  retainUntrackedCounts,
} from "./local-git-scan-caches.js";

const roots: string[] = [];
afterEach(() => {
  resetLocalGitScanCachesForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function worktree(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ork-scan-caches-"));
  roots.push(root);
  return root;
}

/** Every file reads as older than the settle window. */
function settledClock() {
  const now = Date.now;
  return spyOn(Date, "now").mockImplementation(() => now() + 10_000);
}

describe("untracked line counts", () => {
  test("an unchanged settled file is not read again", async () => {
    const root = worktree();
    writeFileSync(path.join(root, "file.txt"), "a\nb\n");
    const clock = settledClock();
    try {
      await expect(countUntrackedFileLines(root, "file.txt")).resolves.toEqual({
        kind: "text",
        lines: 2,
      });
      expect(localGitScanCacheStats(root)).toEqual({ counts: 1, contentRead: 1, stampReused: 0 });
      await expect(countUntrackedFileLines(root, "file.txt")).resolves.toEqual({
        kind: "text",
        lines: 2,
      });
      expect(localGitScanCacheStats(root)).toEqual({ counts: 1, contentRead: 1, stampReused: 1 });
    } finally {
      clock.mockRestore();
    }
  });

  test("a file changed within the settle window is read on every scan", async () => {
    const root = worktree();
    const file = path.join(root, "file.txt");
    writeFileSync(file, "aaaa\n");
    await expect(countUntrackedFileLines(root, "file.txt")).resolves.toEqual({
      kind: "text",
      lines: 1,
    });
    expect(localGitScanCacheStats(root)).toEqual({ counts: 0, contentRead: 1, stampReused: 0 });
    await countUntrackedFileLines(root, "file.txt");
    expect(localGitScanCacheStats(root)).toEqual({ counts: 0, contentRead: 2, stampReused: 0 });

    // A racy rewrite: same size, and the mtime put back. The previous read was
    // inside the window, so no stamp was kept that could hide it.
    const { mtime, atime } = statSync(file);
    writeFileSync(file, "a\nb\n\n");
    utimesSync(file, atime, mtime);
    await expect(countUntrackedFileLines(root, "file.txt")).resolves.toEqual({
      kind: "text",
      lines: 3,
    });
    expect(localGitScanCacheStats(root)?.contentRead).toBe(3);
  });

  test("a settled file ages in once the window has passed", async () => {
    const root = worktree();
    writeFileSync(path.join(root, "file.txt"), "a\n");
    await countUntrackedFileLines(root, "file.txt");
    const clock = settledClock();
    try {
      await countUntrackedFileLines(root, "file.txt");
      await countUntrackedFileLines(root, "file.txt");
      expect(localGitScanCacheStats(root)).toEqual({ counts: 1, contentRead: 2, stampReused: 1 });
    } finally {
      clock.mockRestore();
    }
  });

  test("any stamp change forces a read: rewrite, or a replacement with the same size and mtime", async () => {
    const root = worktree();
    const file = path.join(root, "file.txt");
    writeFileSync(file, "aaaa\n");
    const clock = settledClock();
    try {
      await countUntrackedFileLines(root, "file.txt");
      const { mtime, atime } = statSync(file);

      writeFileSync(file, "a\nb\n\n");
      utimesSync(file, atime, mtime);
      await expect(countUntrackedFileLines(root, "file.txt")).resolves.toEqual({
        kind: "text",
        lines: 3,
      });

      const replacement = path.join(root, "replacement");
      writeFileSync(replacement, "a\n\n\n\n");
      utimesSync(replacement, atime, mtime);
      renameSync(replacement, file);
      await expect(countUntrackedFileLines(root, "file.txt")).resolves.toEqual({
        kind: "text",
        lines: 4,
      });
      expect(localGitScanCacheStats(root)).toMatchObject({ contentRead: 3, stampReused: 0 });
    } finally {
      clock.mockRestore();
    }
  });

  test("a binary file's kind is cached too, and a failure is not", async () => {
    const root = worktree();
    writeFileSync(path.join(root, "bin.dat"), Buffer.from([0, 1]));
    const clock = settledClock();
    try {
      await countUntrackedFileLines(root, "bin.dat");
      await expect(countUntrackedFileLines(root, "bin.dat")).resolves.toEqual({ kind: "binary" });
      expect(localGitScanCacheStats(root)?.stampReused).toBe(1);
      await expect(countUntrackedFileLines(root, "missing.txt")).rejects.toThrow();
      await expect(countUntrackedFileLines(root, "missing.txt")).rejects.toThrow();
      expect(localGitScanCacheStats(root)?.contentRead).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });

  test("a removed file's entry is dropped and it fails as it always did", async () => {
    const root = worktree();
    writeFileSync(path.join(root, "file.txt"), "a\n");
    const clock = settledClock();
    try {
      await countUntrackedFileLines(root, "file.txt");
      rmSync(path.join(root, "file.txt"));
      await expect(countUntrackedFileLines(root, "file.txt")).rejects.toThrow();
      expect(localGitScanCacheStats(root)?.counts).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  test("a scan's list prunes files no longer untracked, and dropping forgets the worktree", async () => {
    const root = worktree();
    writeFileSync(path.join(root, "kept.txt"), "a\n");
    writeFileSync(path.join(root, "gone.txt"), "a\n");
    const clock = settledClock();
    try {
      await countUntrackedFileLines(root, "kept.txt");
      await countUntrackedFileLines(root, "gone.txt");
      retainUntrackedCounts(root, ["kept.txt"]);
      expect(localGitScanCacheStats(root)?.counts).toBe(1);
      dropLocalGitScanCaches(root);
      expect(localGitScanCacheStats(root)).toBeNull();
      dropLocalGitScanCaches("/never/scanned");
    } finally {
      clock.mockRestore();
    }
  });

  test("entries per worktree stay within the count and byte bounds", async () => {
    const root = worktree();
    const clock = settledClock();
    try {
      writeFileSync(path.join(root, "same.txt"), "a\n");
      for (let index = 0; index <= UNTRACKED_SCAN_MAX_FILES; index += 1) {
        const name = `f${index}.txt`;
        writeFileSync(path.join(root, name), "a\n");
        await countUntrackedFileLines(root, name);
      }
      expect(localGitScanCacheStats(root)?.counts).toBe(UNTRACKED_SCAN_MAX_FILES);

      // Long names reach the byte bound first.
      const long = worktree();
      for (let index = 0; index < 1_000; index += 1) {
        const name = `${"n".repeat(240)}${index}`;
        writeFileSync(path.join(long, name), "a\n");
        await countUntrackedFileLines(long, name);
      }
      const held = localGitScanCacheStats(long)!.counts;
      expect(held).toBeLessThan(1_000);
      expect(held).toBeGreaterThan(0);
    } finally {
      clock.mockRestore();
    }
  }, 30_000);

  test("worktrees are bounded, least recently scanned first", async () => {
    const roots64 = Array.from({ length: 65 }, () => worktree());
    for (const root of roots64) {
      writeFileSync(path.join(root, "file.txt"), "a\n");
      await countUntrackedFileLines(root, "file.txt");
    }
    expect(localGitScanCacheStats(roots64[0]!)).toBeNull();
    expect(localGitScanCacheStats(roots64[64]!)).not.toBeNull();
  });
});

describe("ensuring the exclude file", () => {
  test("runs once, and again only when the file changed or went away", async () => {
    const root = worktree();
    const file = path.join(root, "exclude");
    let ensures = 0;
    const ensure = async () => {
      ensures += 1;
      writeFileSync(file, ".orkestrator\n");
      return { file, stamp: statStamp(statSync(file)) };
    };
    await ensureLocalGitExcludeOnce(root, ensure);
    await ensureLocalGitExcludeOnce(root, ensure);
    expect(ensures).toBe(1);

    rmSync(file);
    await ensureLocalGitExcludeOnce(root, ensure);
    expect(ensures).toBe(2);

    writeFileSync(file, "someone else's rewrite\n");
    await ensureLocalGitExcludeOnce(root, ensure);
    expect(ensures).toBe(3);
    await ensureLocalGitExcludeOnce(root, ensure);
    expect(ensures).toBe(3);
  });

  test("concurrent scans share an attempt, and a failure is not remembered", async () => {
    const root = worktree();
    const file = path.join(root, "exclude");
    writeFileSync(file, "x\n");
    let ensures = 0;
    const failing = async () => {
      ensures += 1;
      throw new Error("not a repository");
    };
    await expect(
      Promise.all([
        ensureLocalGitExcludeOnce(root, failing),
        ensureLocalGitExcludeOnce(root, failing),
      ]),
    ).rejects.toThrow("not a repository");
    expect(ensures).toBe(1);
    await expect(ensureLocalGitExcludeOnce(root, failing)).rejects.toThrow("not a repository");
    expect(ensures).toBe(2);
    await ensureLocalGitExcludeOnce(root, async () => ({
      file,
      stamp: statStamp(statSync(file)),
    }));
    await ensureLocalGitExcludeOnce(root, failing);
    expect(ensures).toBe(2);
  });

  test("a scan that joins an attempt notices a rewrite that attempt missed", async () => {
    const root = worktree();
    const file = path.join(root, "exclude");
    writeFileSync(file, ".orkestrator\n");
    let ensures = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ensure = async () => {
      ensures += 1;
      // The stamp and the read happen first; the file changes while this attempt runs.
      const stamp = statStamp(statSync(file));
      if (ensures === 1) await held;
      return { file, stamp };
    };
    const first = ensureLocalGitExcludeOnce(root, ensure);
    await Bun.sleep(0);
    const joined = ensureLocalGitExcludeOnce(root, ensure);
    writeFileSync(file, "someone else's rewrite\n");
    release();
    await Promise.all([first, joined]);
    expect(ensures).toBe(2);
  });
});
