import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearJsonFileCache, readJsonFileCached } from "./json-file-cache.js";

describe("json file cache", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-bridge-json-cache-"));
    file = join(dir, "config.json");
    clearJsonFileCache();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    clearJsonFileCache();
  });

  test("serves repeat reads from cache", async () => {
    await writeFile(file, JSON.stringify({ value: 1 }));

    const first = await readJsonFileCached<{ value: number }>(file);
    const second = await readJsonFileCached<{ value: number }>(file);

    expect(first).toEqual({ value: 1 });
    // Same object: the file was parsed once, which is the whole point.
    expect(second).toBe(first);
  });

  test("re-reads after the file changes", async () => {
    await writeFile(file, JSON.stringify({ value: 1 }));
    expect(await readJsonFileCached<{ value: number }>(file)).toEqual({ value: 1 });

    // Wait past filesystem mtime granularity so the change is observable even
    // where timestamps are coarse; the size also differs here.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(file, JSON.stringify({ value: 22 }));

    expect(await readJsonFileCached<{ value: number }>(file)).toEqual({ value: 22 });
  });

  test("returns null for a missing file and picks it up when it appears", async () => {
    expect(await readJsonFileCached(file)).toBeNull();

    await writeFile(file, JSON.stringify({ value: "now here" }));
    expect(await readJsonFileCached(file)).toEqual({ value: "now here" });
  });

  test("forgets a cached parse once the file is removed", async () => {
    await writeFile(file, JSON.stringify({ value: 1 }));
    expect(await readJsonFileCached(file)).toEqual({ value: 1 });

    await rm(file);
    // A stale parse here would keep a deleted MCP config alive for the life of
    // the process.
    expect(await readJsonFileCached(file)).toBeNull();
  });

  test("treats malformed JSON as absent without re-parsing it every call", async () => {
    await writeFile(file, "{ not valid json");
    expect(await readJsonFileCached(file)).toBeNull();
    expect(await readJsonFileCached(file)).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(file, JSON.stringify({ value: "fixed" }));
    expect(await readJsonFileCached(file)).toEqual({ value: "fixed" });
  });
});
