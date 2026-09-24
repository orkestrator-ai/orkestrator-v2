import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearJsonFileCache,
  getJsonFileParseCount,
  getJsonFileReadCohortStateForTesting,
  readJsonFileCached,
  readJsonSliceCached,
  readJsonSliceCachedWithDigest,
  setJsonFileCacheBeforeStatForTesting,
} from "./json-file-cache.js";

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
    expect(getJsonFileParseCount(file)).toBe(1);
  });

  test("digests the exact bytes parsed, once, and serves the digest from cache", async () => {
    const text = JSON.stringify({ mcpServers: { a: { command: "a" } } });
    await writeFile(file, text);
    const expected = createHash("sha256").update(text).digest("base64url");
    const select = (parsed: { mcpServers?: unknown }) => parsed.mcpServers;

    const first = await readJsonSliceCachedWithDigest(file, "mcpServers", select);
    const second = await readJsonSliceCachedWithDigest(file, "mcpServers", select);

    expect(first).toEqual({ value: { a: { command: "a" } }, digest: expected });
    expect(second.digest).toBe(expected);
    expect(getJsonFileParseCount(file)).toBe(1);
    // The plain reader shares the entry and still answers only the value.
    expect(await readJsonSliceCached(file, "mcpServers", select)).toEqual({ a: { command: "a" } });
  });

  test("a missing file has no digest; a malformed one does", async () => {
    const select = (parsed: { value?: unknown }) => parsed.value;
    expect(await readJsonSliceCachedWithDigest(file, "value", select)).toEqual({
      value: null,
      digest: null,
    });
    await writeFile(file, "{ nope");
    expect(await readJsonSliceCachedWithDigest(file, "value", select)).toEqual({
      value: null,
      digest: createHash("sha256").update("{ nope").digest("base64url"),
    });
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
    expect(getJsonFileParseCount(file)).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(file, JSON.stringify({ value: "fixed" }));
    expect(await readJsonFileCached(file)).toEqual({ value: "fixed" });
  });

  test("treats a readable-then-unreadable file as absent rather than throwing", async () => {
    await writeFile(file, JSON.stringify({ value: 1 }));
    clearJsonFileCache();
    // `stat` still succeeds while `readFile` is denied — the window a
    // permission change opens between the two syscalls.
    await chmod(file, 0o000);

    try {
      expect(await readJsonFileCached(file)).toBeNull();
    } finally {
      await chmod(file, 0o600);
    }
  });

  describe("slices", () => {
    const config = {
      mcpServers: { alpha: { command: "alpha-server" } },
      projects: {
        "/repo": { mcpServers: { beta: { command: "beta-server" } } },
      },
    };

    test("retains only the selected slice, not the whole document", async () => {
      await writeFile(file, JSON.stringify(config));

      const servers = await readJsonSliceCached<typeof config, Record<string, unknown>>(
        file,
        "mcpServers",
        (parsed) => parsed.mcpServers,
      );

      expect(servers).toEqual({ alpha: { command: "alpha-server" } });
      // The point of slicing: the project history alongside it is not held.
      expect(servers).not.toHaveProperty("projects");
    });

    test("keys slices separately so one selector cannot serve another", async () => {
      await writeFile(file, JSON.stringify(config));

      const global = await readJsonSliceCached<typeof config, Record<string, unknown>>(
        file,
        "mcpServers",
        (parsed) => parsed.mcpServers,
      );
      const project = await readJsonSliceCached<typeof config, Record<string, unknown>>(
        file,
        "projects:/repo:mcpServers",
        (parsed) => parsed.projects["/repo"]?.mcpServers,
      );

      expect(global).toEqual({ alpha: { command: "alpha-server" } });
      expect(project).toEqual({ beta: { command: "beta-server" } });
    });

    test("shares a single parse between concurrent cold readers", async () => {
      await writeFile(file, JSON.stringify(config));

      // This is the shape `getMergedMcpServers` produces: several readers of
      // the same path inside one `Promise.all`, all missing a cold cache.
      const [global, project, whole] = await Promise.all([
        readJsonSliceCached<typeof config, unknown>(file, "mcpServers", (p) => p.mcpServers),
        readJsonSliceCached<typeof config, unknown>(
          file,
          "projects:/repo:mcpServers",
          (p) => p.projects["/repo"]?.mcpServers,
        ),
        readJsonFileCached<typeof config>(file),
      ]);

      expect(global).toEqual({ alpha: { command: "alpha-server" } });
      expect(project).toEqual({ beta: { command: "beta-server" } });
      expect(whole).toEqual(config);
      expect(getJsonFileParseCount(file)).toBe(1);
    });

    test("keeps a completed parse for concurrent readers whose metadata is delayed", async () => {
      await writeFile(file, JSON.stringify(config));

      let statCall = 0;
      let releaseDelayedStats!: () => void;
      const delayedStats = new Promise<void>((resolve) => {
        releaseDelayedStats = resolve;
      });
      setJsonFileCacheBeforeStatForTesting(async (target) => {
        if (target === file && ++statCall > 1) await delayedStats;
      });

      // All calls join the same read cohort synchronously, but the latter two
      // cannot stat until the first reader has finished parsing. Deleting a
      // settled in-flight parse immediately made this sequence parse twice.
      const globalPromise = readJsonSliceCached<typeof config, unknown>(
        file,
        "mcpServers",
        (parsed) => parsed.mcpServers,
      );
      const projectPromise = readJsonSliceCached<typeof config, unknown>(
        file,
        "projects:/repo:mcpServers",
        (parsed) => parsed.projects["/repo"]?.mcpServers,
      );
      const wholePromise = readJsonFileCached<typeof config>(file);

      expect(getJsonFileReadCohortStateForTesting(file)).toEqual({ readers: 3, parses: 0 });

      try {
        expect(await globalPromise).toEqual({ alpha: { command: "alpha-server" } });
        expect(getJsonFileParseCount(file)).toBe(1);
        expect(getJsonFileReadCohortStateForTesting(file)).toEqual({ readers: 2, parses: 1 });
      } finally {
        // Do not strand the other readers if an assertion above fails.
        releaseDelayedStats();
      }

      const [project, whole] = await Promise.all([projectPromise, wholePromise]);
      expect(project).toEqual({ beta: { command: "beta-server" } });
      expect(whole).toEqual(config);
      expect(getJsonFileParseCount(file)).toBe(1);
      expect(getJsonFileReadCohortStateForTesting(file)).toBeNull();
    });

    test("retains mixed fingerprints until an overlapping cohort tears down", async () => {
      await writeFile(file, JSON.stringify({ value: "old" }));

      let statCall = 0;
      let releaseSecondStat!: () => void;
      let releaseThirdStat!: () => void;
      const secondStat = new Promise<void>((resolve) => {
        releaseSecondStat = resolve;
      });
      const thirdStat = new Promise<void>((resolve) => {
        releaseThirdStat = resolve;
      });
      setJsonFileCacheBeforeStatForTesting(async (target) => {
        if (target !== file) return;
        const call = ++statCall;
        if (call === 2) await secondStat;
        if (call === 3) await thirdStat;
      });

      const oldPromise = readJsonSliceCached<{ value: string }, string>(
        file,
        "old-value",
        (parsed) => parsed.value,
      );
      const newPromise = readJsonSliceCached<{ value: string }, string>(
        file,
        "new-value",
        (parsed) => parsed.value,
      );
      const overlappingPromise = readJsonSliceCached<{ value: string }, string>(
        file,
        "overlapping-new-value",
        (parsed) => parsed.value,
      );

      expect(getJsonFileReadCohortStateForTesting(file)).toEqual({ readers: 3, parses: 0 });
      try {
        expect(await oldPromise).toBe("old");
        expect(getJsonFileReadCohortStateForTesting(file)).toEqual({ readers: 2, parses: 1 });
        await writeFile(file, JSON.stringify({ value: "new and longer" }));
        releaseSecondStat();
        expect(await newPromise).toBe("new and longer");
        expect(getJsonFileParseCount(file)).toBe(2);
        expect(getJsonFileReadCohortStateForTesting(file)).toEqual({ readers: 1, parses: 2 });
      } finally {
        releaseSecondStat();
        releaseThirdStat();
      }

      expect(await overlappingPromise).toBe("new and longer");
      expect(getJsonFileParseCount(file)).toBe(2);
      expect(getJsonFileReadCohortStateForTesting(file)).toBeNull();
    });

    test("caches an absent slice without re-parsing, and revalidates on change", async () => {
      await writeFile(file, JSON.stringify({ unrelated: true }));

      expect(
        await readJsonSliceCached<{ mcpServers?: unknown }, unknown>(
          file,
          "mcpServers",
          (parsed) => parsed.mcpServers,
        ),
      ).toBeNull();
      expect(
        await readJsonSliceCached<{ mcpServers?: unknown }, unknown>(
          file,
          "mcpServers",
          (parsed) => parsed.mcpServers,
        ),
      ).toBeNull();
      expect(getJsonFileParseCount(file)).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(file, JSON.stringify({ mcpServers: { gamma: {} } }));

      expect(
        await readJsonSliceCached<{ mcpServers?: unknown }, unknown>(
          file,
          "mcpServers",
          (parsed) => parsed.mcpServers,
        ),
      ).toEqual({ gamma: {} });
    });

    test("treats a selector that throws as an absent slice", async () => {
      await writeFile(file, JSON.stringify({ value: 1 }));

      const result = await readJsonSliceCached<{ value: number }, unknown>(file, "explodes", () => {
        throw new Error("unexpected shape");
      });

      expect(result).toBeNull();
    });

    test("drops every slice for a path once the file is removed", async () => {
      await writeFile(file, JSON.stringify(config));
      await readJsonSliceCached<typeof config, unknown>(file, "mcpServers", (p) => p.mcpServers);
      await readJsonSliceCached<typeof config, unknown>(
        file,
        "projects:/repo:mcpServers",
        (p) => p.projects["/repo"]?.mcpServers,
      );

      await rm(file);

      expect(
        await readJsonSliceCached<typeof config, unknown>(file, "mcpServers", (p) => p.mcpServers),
      ).toBeNull();
      expect(
        await readJsonSliceCached<typeof config, unknown>(
          file,
          "projects:/repo:mcpServers",
          (p) => p.projects["/repo"]?.mcpServers,
        ),
      ).toBeNull();
    });
  });
});
