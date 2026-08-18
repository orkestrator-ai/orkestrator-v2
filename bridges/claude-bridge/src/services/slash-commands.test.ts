import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We mock plugin-config (only the bits slash-commands.ts uses) so we don't
// depend on the host's ~/.claude.json or ~/.claude/plugins directories.
// Snapshot first so other test files in the same `bun test` run get the real
// implementation back when this suite finishes.
import * as realPluginConfig from "./plugin-config.js";
const pluginConfigSnapshot = { ...realPluginConfig };

const mockGetMergedPlugins = mock(
  async (_cwd: string): Promise<Array<{ type: "local"; path: string }>> => [],
);
const mockReadPluginManifest = mock(
  async (_path: string): Promise<{ name: string; description?: string } | null> => null,
);

mock.module("./plugin-config.js", () => ({
  getMergedPlugins: mockGetMergedPlugins,
  readPluginManifest: mockReadPluginManifest,
}));

const { discoverSlashCommands, MAX_COMMAND_DESCRIPTION_CACHE_ENTRIES } =
  await import("./slash-commands.js");

/** A minimal command file whose only frontmatter field is `description`. */
function describedCommand(description: string): string {
  return `---\ndescription: ${description}\n---`;
}

/**
 * Pinned so `mtimeMs` is exactly representable as a `Date`. A filesystem
 * timestamp carries sub-millisecond precision that `utimes` cannot restore,
 * which would otherwise change the fingerprint of a rewritten file.
 */
const PINNED_MTIME = new Date("2026-07-01T00:00:00.000Z");

/** Write a command file at the pinned mtime so it can be rewritten in place. */
async function writePinnedCommand(filePath: string, description: string): Promise<void> {
  await writeFile(filePath, describedCommand(description));
  await utimes(filePath, PINNED_MTIME, PINNED_MTIME);
}

/**
 * Rewrite a file's contents while leaving `dev`/`ino`/`size`/`mtime` — the
 * whole cache fingerprint — untouched, so a cached description survives and a
 * re-read is observable in the returned command string.
 */
async function rewriteWithSameFingerprint(filePath: string, description: string): Promise<void> {
  const content = describedCommand(description);
  const before = await stat(filePath);
  if (Buffer.byteLength(content) !== before.size) {
    throw new Error(
      `fingerprint rewrite must preserve size (${before.size} -> ${Buffer.byteLength(content)})`,
    );
  }
  await writeFile(filePath, content);
  await utimes(filePath, PINNED_MTIME, PINNED_MTIME);
  const after = await stat(filePath);
  if (after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) {
    throw new Error("fingerprint rewrite did not preserve the file identity");
  }
}

afterAll(() => {
  mock.module("./plugin-config.js", () => pluginConfigSnapshot);
});

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slash-commands-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  mockGetMergedPlugins.mockClear();
  mockReadPluginManifest.mockClear();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const BUILTIN_NAMES = [
  "/clear",
  "/compact",
  "/context",
  "/cost",
  "/doctor",
  "/goal",
  "/help",
  "/init",
  "/logout",
  "/memory",
  "/model",
  "/permissions",
  "/review",
  "/status",
  "/vim",
];

describe("discoverSlashCommands", () => {
  test("returns sorted built-ins when no project or plugin commands exist", async () => {
    const cwd = await makeTempDir();
    const commands = await discoverSlashCommands(cwd);

    const names = commands.map((c) => c.split(" - ")[0]);
    for (const builtin of BUILTIN_NAMES) {
      expect(names).toContain(builtin);
    }

    const sorted = [...commands].sort((a, b) => a.localeCompare(b));
    expect(commands).toEqual(sorted);
  });

  test("includes repo-scoped commands from .claude/commands with parsed descriptions", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });

    await writeFile(
      join(commandsDir, "deploy.md"),
      `---
description: Deploy the current branch
---
# Deploy
Body content here.`,
    );
    await writeFile(join(commandsDir, "no-frontmatter.md"), "Just markdown without frontmatter.");
    await writeFile(
      join(commandsDir, "single-quoted.md"),
      `---
description: 'Quoted description'
---`,
    );
    await writeFile(
      join(commandsDir, "double-quoted.md"),
      `---
description: "Double quoted"
---`,
    );
    // Non-markdown file should be ignored
    await writeFile(join(commandsDir, "ignore.txt"), "ignore me");

    const commands = await discoverSlashCommands(cwd);

    expect(commands).toContain("/deploy - Deploy the current branch");
    expect(commands).toContain("/no-frontmatter");
    expect(commands).toContain("/single-quoted - Quoted description");
    expect(commands).toContain("/double-quoted - Double quoted");
    expect(commands.find((c) => c.includes("ignore"))).toBeUndefined();
  });

  test("repo-scoped commands take priority over built-ins with the same name", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "help.md"),
      `---
description: Project-scoped help
---`,
    );

    const commands = await discoverSlashCommands(cwd);
    const helpEntries = commands.filter((c) => c.startsWith("/help"));
    expect(helpEntries).toHaveLength(1);
    expect(helpEntries[0]).toBe("/help - Project-scoped help");
  });

  test("includes plugin commands prefixed with the plugin manifest name", async () => {
    const cwd = await makeTempDir();
    const pluginPath = await makeTempDir();
    const pluginCommandsDir = join(pluginPath, "commands");
    await mkdir(pluginCommandsDir, { recursive: true });
    await writeFile(
      join(pluginCommandsDir, "ship.md"),
      `---
description: Ship it
---`,
    );

    mockGetMergedPlugins.mockImplementationOnce(async () => [
      { type: "local" as const, path: pluginPath },
    ]);
    mockReadPluginManifest.mockImplementationOnce(async () => ({ name: "rocket" }));

    const commands = await discoverSlashCommands(cwd);
    expect(commands).toContain("/rocket:ship - Ship it");
  });

  test("falls back to plugin directory name when manifest has no name", async () => {
    const cwd = await makeTempDir();
    const pluginParent = await makeTempDir();
    const pluginPath = join(pluginParent, "fallback-plugin");
    const pluginCommandsDir = join(pluginPath, "commands");
    await mkdir(pluginCommandsDir, { recursive: true });
    await writeFile(join(pluginCommandsDir, "go.md"), "");

    mockGetMergedPlugins.mockImplementationOnce(async () => [
      { type: "local" as const, path: pluginPath },
    ]);
    mockReadPluginManifest.mockImplementationOnce(async () => null);

    const commands = await discoverSlashCommands(cwd);
    expect(commands).toContain("/fallback-plugin:go");
  });

  test("logs a warning but still returns built-ins when getMergedPlugins throws", async () => {
    const cwd = await makeTempDir();
    mockGetMergedPlugins.mockImplementationOnce(async () => {
      throw new Error("plugin discovery exploded");
    });

    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const commands = await discoverSlashCommands(cwd);
      expect(commands.some((c) => c.startsWith("/help"))).toBe(true);
      expect(
        warnings.some((w) => String(w[0] ?? "").includes("Failed to scan plugin commands")),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("repo command beats plugin command with the same /name (deduplicates by name)", async () => {
    // The dedupe key is the *full* command name including plugin prefix, so a
    // `/help` repo command should suppress the built-in `/help` but NOT a
    // `/foo:help` from a plugin.
    const cwd = await makeTempDir();
    const repoCommandsDir = join(cwd, ".claude", "commands");
    await mkdir(repoCommandsDir, { recursive: true });
    await writeFile(
      join(repoCommandsDir, "help.md"),
      `---
description: Repo help
---`,
    );

    const pluginPath = await makeTempDir();
    const pluginCommandsDir = join(pluginPath, "commands");
    await mkdir(pluginCommandsDir, { recursive: true });
    await writeFile(
      join(pluginCommandsDir, "help.md"),
      `---
description: Plugin help
---`,
    );

    mockGetMergedPlugins.mockImplementationOnce(async () => [
      { type: "local" as const, path: pluginPath },
    ]);
    mockReadPluginManifest.mockImplementationOnce(async () => ({ name: "foo" }));

    const commands = await discoverSlashCommands(cwd);
    expect(commands.filter((c) => c.startsWith("/help"))).toEqual(["/help - Repo help"]);
    expect(commands).toContain("/foo:help - Plugin help");
  });

  test("returns built-ins when commands directory is missing", async () => {
    const cwd = await makeTempDir();
    // No .claude/commands directory created.
    const commands = await discoverSlashCommands(cwd);
    expect(commands.some((c) => c.startsWith("/help"))).toBe(true);
  });

  test("serves repeat discoveries from cache and picks up an edited description", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    const commandPath = join(commandsDir, "deploy.md");
    await writePinnedCommand(commandPath, "First description");

    expect(await discoverSlashCommands(cwd)).toContain("/deploy - First description");

    // Rewriting the body while preserving the fingerprint makes a cache hit
    // observable without reaching into the implementation: only a discovery
    // that re-read the file could report the new text.
    await rewriteWithSameFingerprint(commandPath, "Later description");
    expect(await discoverSlashCommands(cwd)).toContain("/deploy - First description");

    // An ordinary on-disk edit changes the fingerprint (size differs even when
    // the mtime granularity is coarse), so the cache must re-read it.
    await writeFile(commandPath, describedCommand("Second, longer description"));
    expect(await discoverSlashCommands(cwd)).toContain("/deploy - Second, longer description");
  });

  test("bounds the description cache so it cannot grow for the process lifetime", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    const probePath = join(commandsDir, "probe.md");
    await writePinnedCommand(probePath, "Cached alpha");
    expect(await discoverSlashCommands(cwd)).toContain("/probe - Cached alpha");
    await rewriteWithSameFingerprint(probePath, "Reread bravo");
    expect(await discoverSlashCommands(cwd)).toContain("/probe - Cached alpha");

    // A directory discovery visits once and never again — an uninstalled
    // plugin — is never pruned, so only the cap can reclaim its entries.
    const pluginPath = await makeTempDir();
    const pluginCommandsDir = join(pluginPath, "commands");
    await mkdir(pluginCommandsDir, { recursive: true });
    await Promise.all(
      Array.from({ length: MAX_COMMAND_DESCRIPTION_CACHE_ENTRIES + 8 }, (_unused, index) =>
        writeFile(join(pluginCommandsDir, `bulk-${index}.md`), describedCommand(`Bulk ${index}`)),
      ),
    );
    mockGetMergedPlugins.mockImplementationOnce(async () => [
      { type: "local" as const, path: pluginPath },
    ]);
    mockReadPluginManifest.mockImplementationOnce(async () => ({ name: "bulk" }));
    await discoverSlashCommands(cwd);

    // The probe's entry was pushed out, so its description is re-read from
    // disk. Without a cap the entry would still be there reporting the stale
    // text, and the Map would keep every bulk entry forever.
    expect(await discoverSlashCommands(cwd)).toContain("/probe - Reread bravo");
  }, 20_000);

  test("prunes entries for command files that disappear from a live directory", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    const probePath = join(commandsDir, "probe.md");
    await writePinnedCommand(probePath, "Cached alpha");
    expect(await discoverSlashCommands(cwd)).toContain("/probe - Cached alpha");
    await rewriteWithSameFingerprint(probePath, "Reread bravo");

    // Churn more short-lived commands through the directory than the cache can
    // hold. Pruning each one as it disappears keeps the cache small enough that
    // the probe survives; without it the churn alone evicts the probe.
    for (let index = 0; index < MAX_COMMAND_DESCRIPTION_CACHE_ENTRIES + 8; index += 1) {
      const churnPath = join(commandsDir, `churn-${index}.md`);
      await writeFile(churnPath, describedCommand(`Churn ${index}`));
      await discoverSlashCommands(cwd);
      await unlink(churnPath);
    }

    expect(await discoverSlashCommands(cwd)).toContain("/probe - Cached alpha");
  }, 30_000);

  test("prunes entries for a commands directory that disappears entirely", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    const probePath = join(commandsDir, "probe.md");
    await writePinnedCommand(probePath, "Cached alpha");
    expect(await discoverSlashCommands(cwd)).toContain("/probe - Cached alpha");
    await rewriteWithSameFingerprint(probePath, "Reread bravo");

    // A plugin whose directory is removed between discoveries. `readdir`
    // throws, which is the only chance to drop what that directory cached.
    const pluginParent = await makeTempDir();
    for (let index = 0; index < MAX_COMMAND_DESCRIPTION_CACHE_ENTRIES + 8; index += 1) {
      const pluginPath = join(pluginParent, `plugin-${index}`);
      const pluginCommandsDir = join(pluginPath, "commands");
      await mkdir(pluginCommandsDir, { recursive: true });
      await writeFile(join(pluginCommandsDir, "only.md"), describedCommand(`Plugin ${index}`));
      mockGetMergedPlugins.mockImplementation(async () => [
        { type: "local" as const, path: pluginPath },
      ]);
      mockReadPluginManifest.mockImplementation(async () => ({
        name: `plugin-${index}`,
      }));
      await discoverSlashCommands(cwd);
      await rm(pluginPath, { recursive: true, force: true });
      await discoverSlashCommands(cwd);
    }
    mockGetMergedPlugins.mockImplementation(async () => []);
    mockReadPluginManifest.mockImplementation(async () => null);

    expect(await discoverSlashCommands(cwd)).toContain("/probe - Cached alpha");
  }, 60_000);

  test("decodes a multi-byte character split across the chunk boundary", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });

    // Pad so the 4-byte emoji straddles the 8 KiB read boundary: a naive
    // per-chunk `toString("utf8")` turns both halves into replacement
    // characters, which is the whole reason for the StringDecoder.
    const header = "---\nnotes: ";
    const padding = "x".repeat(8 * 1024 - Buffer.byteLength(header) - 2);
    await writeFile(
      join(commandsDir, "split.md"),
      `${header}${padding}🚀\ndescription: Survived the chunk boundary\n---\n# Body`,
    );

    expect(await discoverSlashCommands(cwd)).toContain("/split - Survived the chunk boundary");
  });

  test("accepts frontmatter whose closing delimiter ends exactly at the read cap", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });

    const head = "---\ndescription: Exactly at the cap\nnotes: ";
    const tail = "\n---\n";
    const padding = "x".repeat(256 * 1024 - Buffer.byteLength(head) - Buffer.byteLength(tail));
    const content = `${head}${padding}${tail}`;
    expect(Buffer.byteLength(content)).toBe(256 * 1024);
    await writeFile(join(commandsDir, "at-cap.md"), `${content}# Body`);

    expect(await discoverSlashCommands(cwd)).toContain("/at-cap - Exactly at the cap");
  });

  test("parses the description of a command with a large body without choking", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      commandsDir + "/big.md",
      `---
description: Big command
---
${"body ".repeat(10_000)}`,
    );

    // Only the head of the file is read; the frontmatter is complete there.
    expect(await discoverSlashCommands(cwd)).toContain("/big - Big command");
  });

  test("reads valid frontmatter whose closing delimiter is beyond 8 KiB", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "large-frontmatter.md"),
      `---
notes: ${"x".repeat(12 * 1024)}
description: Found after the old read limit
---
# Body`,
    );

    expect(await discoverSlashCommands(cwd)).toContain(
      "/large-frontmatter - Found after the old read limit",
    );
  });

  test("stops at the frontmatter safety cap when no closing delimiter is present", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "unterminated.md"),
      `---
notes: ${"x".repeat(300 * 1024)}
description: Must not be parsed without a closing delimiter`,
    );

    const commands = await discoverSlashCommands(cwd);
    expect(commands).toContain("/unterminated");
    expect(commands.some((command) => command.startsWith("/unterminated - "))).toBe(false);
  });

  test("invalidates the cache after an atomic replacement with matching size and mtime", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    const commandPath = join(commandsDir, "replace.md");
    const replacementPath = join(commandsDir, "replacement.tmp");
    const original = `---
description: Alpha value
---`;
    const replacement = `---
description: Bravo value
---`;
    expect(Buffer.byteLength(original)).toBe(Buffer.byteLength(replacement));

    const fixedTime = new Date("2026-07-01T00:00:00.000Z");
    await writeFile(commandPath, original);
    await utimes(commandPath, fixedTime, fixedTime);
    expect(await discoverSlashCommands(cwd)).toContain("/replace - Alpha value");
    const originalStats = await stat(commandPath);

    await writeFile(replacementPath, replacement);
    await utimes(replacementPath, fixedTime, fixedTime);
    await rename(replacementPath, commandPath);
    const replacementStats = await stat(commandPath);
    expect(replacementStats.size).toBe(originalStats.size);
    expect(replacementStats.mtimeMs).toBe(originalStats.mtimeMs);
    expect(replacementStats.ino).not.toBe(originalStats.ino);

    expect(await discoverSlashCommands(cwd)).toContain("/replace - Bravo value");
  });

  test("recovers after a command file read failure", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    const commandPath = join(commandsDir, "broken.md");
    await symlink(join(commandsDir, "missing-target.md"), commandPath);

    expect(await discoverSlashCommands(cwd)).toContain("/broken");

    await unlink(commandPath);
    await writeFile(
      commandPath,
      `---
description: Recovered command
---`,
    );
    expect(await discoverSlashCommands(cwd)).toContain("/broken - Recovered command");
  });

  test("drops deleted command entries and accepts a later recreation", async () => {
    const cwd = await makeTempDir();
    const commandsDir = join(cwd, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    const commandPath = join(commandsDir, "temporary.md");
    await writeFile(
      commandPath,
      `---
description: Before deletion
---`,
    );
    expect(await discoverSlashCommands(cwd)).toContain("/temporary - Before deletion");

    await unlink(commandPath);
    expect(
      (await discoverSlashCommands(cwd)).some((command) => command.startsWith("/temporary")),
    ).toBe(false);

    await writeFile(
      commandPath,
      `---
description: After recreation
---`,
    );
    expect(await discoverSlashCommands(cwd)).toContain("/temporary - After recreation");
  });
});
