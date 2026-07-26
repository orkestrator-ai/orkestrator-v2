import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearJsonFileCache,
  getJsonFileParseCount,
  readJsonFileCached,
  readJsonSliceCached,
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
    expect(getJsonFileParseCount()).toBe(1);
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
    expect(getJsonFileParseCount()).toBe(1);

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
      expect(getJsonFileParseCount()).toBe(1);
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
      expect(getJsonFileParseCount()).toBe(1);

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

      const result = await readJsonSliceCached<{ value: number }, unknown>(
        file,
        "explodes",
        () => {
          throw new Error("unexpected shape");
        },
      );

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
