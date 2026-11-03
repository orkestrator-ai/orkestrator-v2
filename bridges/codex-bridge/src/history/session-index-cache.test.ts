import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSessionIndexCache,
  getSessionIndexCacheStats,
  readSessionIndex,
  setSessionIndexCacheLimitsForTesting,
} from "./session-index-cache.js";

const temporaryDirectories: string[] = [];

async function indexFile(lines: unknown[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "session-index-cache-"));
  temporaryDirectories.push(root);
  const path = join(root, "session_index.jsonl");
  await writeFile(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
  return path;
}

function line(id: string, threadName?: string): string {
  return `${JSON.stringify({
    id,
    ...(threadName ? { thread_name: threadName } : {}),
    updated_at: "2026-11-03T09:00:00.000Z",
  })}\n`;
}

function counts() {
  const { fullReads, tailReads, uncachedReads } = getSessionIndexCacheStats();
  return { fullReads, tailReads, uncachedReads };
}

beforeEach(() => {
  clearSessionIndexCache();
  setSessionIndexCacheLimitsForTesting();
});

afterEach(async () => {
  clearSessionIndexCache();
  setSessionIndexCacheLimitsForTesting();
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("session index cache", () => {
  test("parses entries the way the whole-file readers did", async () => {
    const path = await indexFile();
    await writeFile(
      path,
      [
        "null",
        "[]",
        "{malformed",
        "",
        '  {"id":"a","thread_name":"First","updated_at":"2026-11-03T09:00:00.000Z"}  ',
        JSON.stringify({ id: 42 }),
        JSON.stringify({ id: "b", thread_name: { bad: true }, updated_at: 7 }),
        JSON.stringify({ id: "a", thread_name: "Renamed" }),
      ].join("\r\n"),
      "utf8",
    );

    const index = await readSessionIndex(path);
    expect(index.entries()).toEqual([
      { id: "a", threadName: "First", updatedAt: "2026-11-03T09:00:00.000Z" },
      { id: "b" },
      { id: "a", threadName: "Renamed" },
    ]);
    // The last line has no newline and is still read, as it always was.
    expect(index.last("a")).toEqual({ id: "a", threadName: "Renamed" });
    expect(index.last("b")).toEqual({ id: "b" });
    expect(index.last("missing")).toBeUndefined();
  });

  test("a missing index, or a directory, reads as empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-index-cache-"));
    temporaryDirectories.push(root);
    expect((await readSessionIndex(join(root, "session_index.jsonl"))).entries()).toEqual([]);
    expect((await readSessionIndex(root)).entries()).toEqual([]);
    expect(getSessionIndexCacheStats().paths).toBe(0);
  });

  test("an unchanged index is read once", async () => {
    const path = await indexFile([{ id: "a", thread_name: "Name" }]);

    expect((await readSessionIndex(path)).last("a")?.threadName).toBe("Name");
    const bytesAfterFirst = getSessionIndexCacheStats().bytesRead;
    expect((await readSessionIndex(path)).last("a")?.threadName).toBe("Name");

    expect(counts()).toEqual({ fullReads: 1, tailReads: 0, uncachedReads: 0 });
    expect(getSessionIndexCacheStats().bytesRead).toBe(bytesAfterFirst);
  });

  test("an appended line is found after one read of only the appended bytes", async () => {
    const path = await indexFile([{ id: "a", thread_name: "Old" }]);
    await readSessionIndex(path);
    const bytesBefore = getSessionIndexCacheStats().bytesRead;

    const appended = line("a", "New") + line("b", "Other");
    await appendFile(path, appended, "utf8");
    const index = await readSessionIndex(path);

    expect(index.last("a")?.threadName).toBe("New");
    expect(index.last("b")?.threadName).toBe("Other");
    expect(index.entries().map((entry) => entry.threadName)).toEqual(["Old", "New", "Other"]);
    expect(counts()).toEqual({ fullReads: 1, tailReads: 1, uncachedReads: 0 });
    // The appended bytes plus the boundary anchor, never the whole file again.
    const read = getSessionIndexCacheStats().bytesRead - bytesBefore;
    expect(read).toBeGreaterThanOrEqual(Buffer.byteLength(appended));
    expect(read).toBeLessThanOrEqual(Buffer.byteLength(appended) + 64);
  });

  test("a rewritten, shorter file is read again from scratch", async () => {
    const path = await indexFile([
      { id: "a", thread_name: "Long name that makes this file longer" },
      { id: "b", thread_name: "Second" },
    ]);
    await readSessionIndex(path);

    await writeFile(path, line("c", "Short"), "utf8");
    const index = await readSessionIndex(path);

    expect(index.entries()).toEqual([
      { id: "c", threadName: "Short", updatedAt: "2026-11-03T09:00:00.000Z" },
    ]);
    expect(index.last("a")).toBeUndefined();
    expect(counts()).toEqual({ fullReads: 2, tailReads: 0, uncachedReads: 0 });
  });

  test("a file replaced by another inode is read again even when it grew", async () => {
    const path = await indexFile([{ id: "a", thread_name: "Original" }]);
    await readSessionIndex(path);

    const replacement = `${path}.next`;
    await writeFile(replacement, line("a", "Replaced") + line("b", "Added"), "utf8");
    await rename(replacement, path);
    const index = await readSessionIndex(path);

    expect(index.entries().map((entry) => entry.threadName)).toEqual(["Replaced", "Added"]);
    expect(counts()).toEqual({ fullReads: 2, tailReads: 0, uncachedReads: 0 });
  });

  test("growth over rewritten bytes on the same inode is not taken as an append", async () => {
    const path = await indexFile([{ id: "a", thread_name: "Before" }]);
    await readSessionIndex(path);

    // Same inode, more bytes, but the bytes before the old boundary changed.
    await writeFile(path, line("z", "Rewritten in place") + line("y", "And longer"), "utf8");
    const index = await readSessionIndex(path);

    expect(index.last("a")).toBeUndefined();
    expect(index.entries().map((entry) => entry.id)).toEqual(["z", "y"]);
    expect(counts()).toEqual({ fullReads: 2, tailReads: 0, uncachedReads: 0 });
  });

  test("a same-size rewrite is read again from scratch", async () => {
    const path = await indexFile([{ id: "a", thread_name: "AAAA" }]);
    await readSessionIndex(path);

    await writeFile(path, line("a", "BBBB"), "utf8");
    // Force a distinct mtime even on a coarse-grained filesystem clock.
    const later = new Date(Date.now() + 5_000);
    await utimes(path, later, later);
    expect((await readSessionIndex(path)).last("a")?.threadName).toBe("BBBB");
    expect(counts().fullReads).toBe(2);
  });

  test("an unterminated last line is served, then committed once its newline lands", async () => {
    const path = await indexFile([{ id: "a", thread_name: "Done" }]);
    await readSessionIndex(path);

    const partial = line("b", "Pending").trimEnd();
    await appendFile(path, partial, "utf8");
    expect((await readSessionIndex(path)).last("b")?.threadName).toBe("Pending");

    await appendFile(path, `\n${line("c", "After")}`, "utf8");
    const index = await readSessionIndex(path);
    expect(index.entries().map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(index.last("b")?.threadName).toBe("Pending");
    expect(counts()).toEqual({ fullReads: 1, tailReads: 2, uncachedReads: 0 });
  });

  test("a half-written line is not an entry until it is complete", async () => {
    const path = await indexFile([{ id: "a", thread_name: "Done" }]);
    await readSessionIndex(path);
    const full = line("b", "Complete");

    await appendFile(path, full.slice(0, 12), "utf8");
    expect((await readSessionIndex(path)).last("b")).toBeUndefined();

    await appendFile(path, full.slice(12), "utf8");
    expect((await readSessionIndex(path)).last("b")?.threadName).toBe("Complete");
    expect(counts()).toEqual({ fullReads: 1, tailReads: 2, uncachedReads: 0 });
  });

  test("a snapshot keeps what it saw while later appends land", async () => {
    const path = await indexFile([{ id: "a", thread_name: "First" }]);
    const before = await readSessionIndex(path);

    await appendFile(path, line("a", "Second") + line("b", "New"), "utf8");
    const after = await readSessionIndex(path);

    expect(before.entries().map((entry) => entry.threadName)).toEqual(["First"]);
    expect(before.last("a")?.threadName).toBe("First");
    expect(before.last("b")).toBeUndefined();
    expect(after.last("a")?.threadName).toBe("Second");
    expect(counts().tailReads).toBe(1);
  });

  test("concurrent readers of an appended index parse the tail once", async () => {
    const path = await indexFile([{ id: "a" }]);
    await readSessionIndex(path);
    await appendFile(path, line("b", "Concurrent"), "utf8");

    const results = await Promise.all(Array.from({ length: 5 }, () => readSessionIndex(path)));
    for (const index of results) expect(index.last("b")?.threadName).toBe("Concurrent");
    expect(counts()).toEqual({ fullReads: 1, tailReads: 1, uncachedReads: 0 });
  });
});

describe("session index cache bounds", () => {
  test("the least recently used index is evicted past the path bound", async () => {
    setSessionIndexCacheLimitsForTesting({ maxPaths: 2 });
    const first = await indexFile([{ id: "a" }]);
    const second = await indexFile([{ id: "b" }]);
    const third = await indexFile([{ id: "c" }]);

    await readSessionIndex(first);
    await readSessionIndex(second);
    await readSessionIndex(first);
    await readSessionIndex(third);

    expect(getSessionIndexCacheStats().paths).toBe(2);
    await readSessionIndex(first);
    expect(counts().fullReads).toBe(3);
    await readSessionIndex(second);
    expect(counts().fullReads).toBe(4);
  });

  test("the entry bound evicts older indexes and refuses one too large alone", async () => {
    setSessionIndexCacheLimitsForTesting({ maxEntries: 3 });
    const small = await indexFile([{ id: "a" }, { id: "b" }]);
    const other = await indexFile([{ id: "c" }, { id: "d" }]);

    await readSessionIndex(small);
    await readSessionIndex(other);
    // Four entries do not fit in three: the older index went.
    expect(getSessionIndexCacheStats()).toMatchObject({ paths: 1, entries: 2 });

    const large = await indexFile([{ id: "e" }, { id: "f" }, { id: "g" }, { id: "h" }]);
    expect((await readSessionIndex(large)).last("h")?.id).toBe("h");
    expect((await readSessionIndex(large)).last("e")?.id).toBe("e");
    // Parsed from scratch each time and never retained.
    expect(counts().uncachedReads).toBe(2);
    expect(getSessionIndexCacheStats()).toMatchObject({ paths: 1, entries: 2 });
  });

  test("an append past the entry bound drops the index instead of growing it", async () => {
    setSessionIndexCacheLimitsForTesting({ maxEntries: 2 });
    const path = await indexFile([{ id: "a" }, { id: "b" }]);
    await readSessionIndex(path);
    expect(getSessionIndexCacheStats().entries).toBe(2);

    await appendFile(path, line("c", "Third"), "utf8");
    expect((await readSessionIndex(path)).last("c")?.threadName).toBe("Third");
    expect(getSessionIndexCacheStats()).toMatchObject({ paths: 0, entries: 0, tailReads: 0 });
  });

  test("the byte bound holds across indexes", async () => {
    const name = "x".repeat(1_000);
    const path = await indexFile([{ id: "a", thread_name: name }]);
    await readSessionIndex(path);
    const oneIndexBytes = getSessionIndexCacheStats().bytes;
    expect(oneIndexBytes).toBeGreaterThan(2 * name.length);

    setSessionIndexCacheLimitsForTesting({ maxBytes: oneIndexBytes + 100 });
    const other = await indexFile([{ id: "b", thread_name: name }]);
    await readSessionIndex(other);
    expect(getSessionIndexCacheStats().paths).toBe(1);
    expect(getSessionIndexCacheStats().bytes).toBeLessThanOrEqual(oneIndexBytes + 100);

    setSessionIndexCacheLimitsForTesting({ maxBytes: oneIndexBytes - 1 });
    // Lowering the bound applies at once, and a too-large index is not kept.
    expect(getSessionIndexCacheStats().paths).toBe(0);
    expect((await readSessionIndex(path)).last("a")?.threadName).toBe(name);
    expect(getSessionIndexCacheStats().paths).toBe(0);
    expect(counts().uncachedReads).toBe(1);
  });
});
