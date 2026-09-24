import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GrokMcpConfigWatcher,
  grokMcpConfigFiles,
  grokMcpConfigFingerprint,
  grokMcpConfigStatus,
  vendorMcpInventory,
} from "./acp-mcp-inventory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acp-mcp-inventory-"));
  roots.push(root);
  return root;
}

const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("base64url")}`;

describe("vendorMcpInventory", () => {
  test("a listed server is unknown, never assumed connected", () => {
    expect(
      vendorMcpInventory({
        mcpServers: [
          { name: "context7", command: "npx", args: ["--api-key", "secret"], env: { K: "v" } },
          { name: "remote", url: "https://example.test/mcp", headers: { Authorization: "x" } },
          { name: "streamed", type: "sse", url: "https://example.test/sse" },
          { name: "orkestrator", type: "http", url: "http://127.0.0.1/mcp" },
        ],
      }),
    ).toEqual([
      { id: "context7", name: "context7", status: "unknown", transport: "stdio", actions: [] },
      { id: "remote", name: "remote", status: "unknown", transport: "http", actions: [] },
      { id: "streamed", name: "streamed", status: "unknown", transport: "sse", actions: [] },
      {
        id: "orkestrator",
        name: "orkestrator",
        status: "unknown",
        scope: "orkestrator",
        transport: "http",
        actions: [],
      },
    ]);
  });

  test("an explicit vendor status is evidence and is kept", () => {
    expect(
      vendorMcpInventory({
        mcpServers: [
          { name: "a", status: "connected" },
          { name: "b", state: "FAILED" },
          { name: "c", status: "exploded" },
        ],
      })?.map((server) => [server.name, server.status]),
    ).toEqual([
      ["a", "connected"],
      ["b", "failed"],
      ["c", "unknown"],
    ]);
  });

  test("never copies launch settings, and bounds names and count", () => {
    const listed = vendorMcpInventory({
      mcpServers: [
        { command: "run", args: ["--token", "secret-value"] },
        "not-an-object",
        { name: "x".repeat(500) },
        ...Array.from({ length: 100 }, (_, index) => ({ name: `s${index}` })),
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("secret-value");
    expect(listed?.[0]?.name).toBe("server-1");
    expect(listed?.[1]?.name).toHaveLength(128);
    expect(listed?.length).toBeLessThanOrEqual(64);
  });

  test("params that are not a listing yield nothing", () => {
    expect(vendorMcpInventory({})).toBeUndefined();
    expect(vendorMcpInventory({ mcpServers: "nope" })).toBeUndefined();
  });
});

describe("Grok MCP configuration fingerprint", () => {
  test("resolves GROK_HOME the way the backend does", () => {
    expect(grokMcpConfigFiles({ env: {}, cwd: "/w", home: "/h" })).toEqual({
      user: "/h/.grok/config.toml",
      project: "/w/.grok/config.toml",
    });
    expect(grokMcpConfigFiles({ env: { GROK_HOME: "~/g" }, cwd: "/w", home: "/h" }).user).toBe(
      "/h/g/config.toml",
    );
    expect(grokMcpConfigFiles({ env: { GROK_HOME: "/abs" }, cwd: "/w", home: "/h" }).user).toBe(
      "/abs/config.toml",
    );
  });

  test("digests each native file and reports absence", async () => {
    const root = await scratch();
    const files = { user: join(root, "user.toml"), project: join(root, "missing.toml") };
    await writeFile(files.user, '[mcp_servers.a]\ncommand = "a"\n');
    const fingerprint = await grokMcpConfigFingerprint(files);
    expect(fingerprint.sources).toEqual({
      user: digest('[mcp_servers.a]\ncommand = "a"\n'),
      project: "absent",
    });
    expect(JSON.stringify(fingerprint)).not.toContain(root);
  });

  test("status says whether the saved files changed since the child loaded them", async () => {
    const root = await scratch();
    await mkdir(join(root, ".grok"), { recursive: true });
    const files = { user: join(root, "config.toml"), project: join(root, ".grok", "config.toml") };
    await writeFile(files.user, "[mcp_servers]\n");
    const watcher = new GrokMcpConfigWatcher(() => files);
    const atSpawn = await grokMcpConfigFingerprint(files);
    const loaded = { ...atSpawn, observedAt: "2026-09-24T00:00:00.000Z" };

    expect(grokMcpConfigStatus(loaded, await watcher.current())).toMatchObject({
      inventoryScope: "process",
      changedSinceLoad: false,
    });

    // Past coarse mtime granularity; the size differs too.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(files.project, '[mcp_servers.added]\ncommand = "x"\n');
    const status = grokMcpConfigStatus(loaded, await watcher.current());
    expect(status.changedSinceLoad).toBe(true);
    expect(status.loaded?.fingerprint).toBe(atSpawn.fingerprint);
    expect(status.current?.fingerprint).not.toBe(atSpawn.fingerprint);
  });

  test("without a reporting child the status is process-level and indeterminate", () => {
    expect(grokMcpConfigStatus(undefined, undefined)).toEqual({ inventoryScope: "process" });
  });

  test("the watcher re-reads only when a file's identity or mtime changes", async () => {
    const root = await scratch();
    const files = { user: join(root, "config.toml"), project: join(root, "p.toml") };
    await writeFile(files.user, "a = 1\n");
    const watcher = new GrokMcpConfigWatcher(() => files);
    const first = await watcher.current();
    expect(await watcher.current()).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(files.user, "a = 22\n");
    expect((await watcher.current()).fingerprint).not.toBe(first.fingerprint);
  });

  test("a read started before a save cannot poison the newer stat cache", async () => {
    const root = await scratch();
    const files = { user: join(root, "config.toml"), project: join(root, "missing.toml") };
    await writeFile(files.user, "old\n");
    const old = await grokMcpConfigFingerprint(files);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let reads = 0;
    const watcher = new GrokMcpConfigWatcher(
      () => files,
      async (paths) => {
        if (++reads === 1) {
          started();
          await held;
          return old;
        }
        return grokMcpConfigFingerprint(paths);
      },
    );
    const first = watcher.current();
    await entered;
    await writeFile(files.user, "new and longer\n");
    const second = await watcher.current();
    release();
    await first;
    expect(second.fingerprint).not.toBe(old.fingerprint);
    expect((await watcher.current()).fingerprint).toBe(second.fingerprint);
  });
});
