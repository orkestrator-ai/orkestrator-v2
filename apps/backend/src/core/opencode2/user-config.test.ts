import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { quoteShell } from "../commands-agent-support.js";
import {
  OPENCODE2_CONTAINER_BUN,
  OPENCODE2_USER_CONFIG_MIRROR_FILE,
  buildOpenCode2ContainerUserConfigScript,
  mergeOpenCodeUserConfig,
  mirrorOpenCodeUserConfig,
  openCodeUserConfigDirectory,
} from "./user-config.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ork-opencode2-user-config-"));
  dirs.push(dir);
  return dir;
}

/** Parse a mirror (JSONC: it starts with a comment). */
function parse(text: string | undefined): Record<string, unknown> {
  return (
    globalThis as unknown as { Bun: { JSONC: { parse(t: string): unknown } } }
  ).Bun.JSONC.parse(text ?? "") as Record<string, unknown>;
}

/** Every file below `dir`, with its contents, for proving nothing was written. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, file)] = entry.isFile()
      ? await readFile(file, "utf8")
      : entry.isSymbolicLink()
        ? `-> ${await readlink(file)}`
        : "dir";
  }
  return out;
}

describe("mergeOpenCodeUserConfig", () => {
  test("merges the user's files in 1.x order and withholds every plugin entry", () => {
    const result = mergeOpenCodeUserConfig([
      {
        name: "config.json",
        directory: "/u",
        text: JSON.stringify({
          mcp: { legacy: { type: "local", command: ["legacy"] } },
          model: "a/old",
          instructions: ["one.md"],
        }),
      },
      {
        name: "opencode.json",
        directory: "/u",
        text: JSON.stringify({
          plugin: ["opencode-wakatime"],
          mcp: { docs: { type: "remote", url: "https://d" } },
        }),
      },
      {
        name: "opencode.jsonc",
        directory: "/u",
        text: `{
          // the user's comment
          "model": "a/new",
          "instructions": ["one.md", "two.md"],
          "plugins": ["-*"],
          "mcp": { "docs": { "enabled": false } },
        }`,
      },
    ]);
    expect(result.droppedPlugins).toBe(true);
    expect(result.rejected).toEqual([]);
    expect(result.text).toStartWith("// Written by Orkestrator");
    expect(parse(result.text)).toEqual({
      mcp: {
        legacy: { type: "local", command: ["legacy"] },
        docs: { type: "remote", url: "https://d", enabled: false },
      },
      model: "a/new",
      instructions: ["one.md", "two.md"],
    });
  });

  test("rebases relative file references onto the user's directory only", () => {
    const result = mergeOpenCodeUserConfig([
      {
        name: "opencode.json",
        directory: "/home/u/.config/opencode",
        text: JSON.stringify({
          provider: {
            a: { options: { apiKey: "{file:./secret.txt}" } },
            b: { options: { apiKey: "{file:~/key}" } },
            c: { options: { apiKey: "{file:/etc/key}" } },
            d: { options: { apiKey: "{env:KEY}" } },
          },
        }),
      },
    ]);
    expect(parse(result.text).provider).toEqual({
      a: { options: { apiKey: "{file:/home/u/.config/opencode/./secret.txt}" } },
      b: { options: { apiKey: "{file:~/key}" } },
      c: { options: { apiKey: "{file:/etc/key}" } },
      d: { options: { apiKey: "{env:KEY}" } },
    });
  });

  test("leaves out a file that is not a JSONC object and never pollutes prototypes", () => {
    const result = mergeOpenCodeUserConfig([
      { name: "config.json", directory: "/u", text: "{ not json" },
      { name: "opencode.json", directory: "/u", text: "[1]" },
      {
        name: "opencode.jsonc",
        directory: "/u",
        text: '{"__proto__": {"polluted": true}, "a": 1}',
      },
    ]);
    expect(result.rejected).toEqual(["config.json", "opencode.json"]);
    expect(parse(result.text)).toEqual({ a: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(mergeOpenCodeUserConfig([])).toEqual({ rejected: [], droppedPlugins: false });
  });
});

describe("openCodeUserConfigDirectory", () => {
  test("follows XDG_CONFIG_HOME, else HOME", () => {
    expect(openCodeUserConfigDirectory({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe("/x/opencode");
    expect(openCodeUserConfigDirectory({ XDG_CONFIG_HOME: " " }, "/h")).toBe("/h/.config/opencode");
    expect(openCodeUserConfigDirectory({ HOME: "/h2" })).toBe("/h2/.config/opencode");
  });
});

describe("mirrorOpenCodeUserConfig", () => {
  async function fixture() {
    const root = await tempDir();
    const xdg = path.join(root, "xdg");
    const userDir = path.join(xdg, "opencode");
    const configDir = path.join(root, "data", "config");
    const customConfigFile = path.join(root, "data", "custom.jsonc");
    await mkdir(path.join(userDir, "command"), { recursive: true });
    await mkdir(path.join(userDir, "skills", "s"), { recursive: true });
    await mkdir(path.join(userDir, "plugins"), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(userDir, "command", "hi.md"), "say hi");
    await writeFile(path.join(userDir, "AGENTS.md"), "rules");
    await writeFile(path.join(userDir, "plugins", "v1.ts"), "export const P = async () => ({})");
    await writeFile(
      path.join(userDir, "opencode.json"),
      JSON.stringify({ plugin: ["x"], mcp: { mine: { type: "local", command: ["m"] } } }),
    );
    return { root, xdg, userDir, configDir, customConfigFile };
  }

  test("mirrors the user's files and directories without plugins, writing nothing of theirs", async () => {
    const f = await fixture();
    const before = await snapshot(f.userDir);
    const env = { HOME: f.root, XDG_CONFIG_HOME: f.xdg };
    await mirrorOpenCodeUserConfig({
      configDir: f.configDir,
      customConfigFile: f.customConfigFile,
      env,
    });

    const mirror = path.join(f.configDir, OPENCODE2_USER_CONFIG_MIRROR_FILE);
    expect(parse(await readFile(mirror, "utf8"))).toEqual({
      mcp: { mine: { type: "local", command: ["m"] } },
    });
    expect((await stat(mirror)).mode & 0o777).toBe(0o600);
    for (const entry of ["command", "skills", "AGENTS.md"]) {
      expect(await readlink(path.join(f.configDir, entry))).toBe(path.join(f.userDir, entry));
    }
    // Neither the user's plugin directory nor absent entries are linked.
    for (const entry of ["plugins", "plugin", "agent", "agents"]) {
      expect(await lstat(path.join(f.configDir, entry)).catch(() => undefined)).toBeUndefined();
    }
    await expect(stat(f.customConfigFile)).rejects.toThrow();
    expect(await snapshot(f.userDir)).toEqual(before);

    // A second start refreshes: removed sources and links go, a changed file is rewritten.
    await rm(path.join(f.userDir, "command"), { recursive: true });
    await writeFile(path.join(f.userDir, "opencode.json"), JSON.stringify({ model: "a/b" }));
    await mirrorOpenCodeUserConfig({
      configDir: f.configDir,
      customConfigFile: f.customConfigFile,
      env,
    });
    expect(parse(await readFile(mirror, "utf8"))).toEqual({ model: "a/b" });
    expect(await lstat(path.join(f.configDir, "command")).catch(() => undefined)).toBeUndefined();
    expect(await readlink(path.join(f.configDir, "skills"))).toBe(path.join(f.userDir, "skills"));

    // No user files: no mirror, and a stale `opencode.json` 2.x may have written is removed.
    await rm(path.join(f.userDir, "opencode.json"));
    await writeFile(path.join(f.configDir, "opencode.json"), "{}");
    await mirrorOpenCodeUserConfig({
      configDir: f.configDir,
      customConfigFile: f.customConfigFile,
      env,
    });
    await expect(stat(mirror)).rejects.toThrow();
    await expect(stat(path.join(f.configDir, "opencode.json"))).rejects.toThrow();
  });

  test("never replaces an entry of the config directory that is not a link", async () => {
    const f = await fixture();
    await mkdir(path.join(f.configDir, "skills"));
    await writeFile(path.join(f.configDir, "skills", "own.md"), "x");
    await symlink("/nowhere", path.join(f.configDir, "agents"));
    await mirrorOpenCodeUserConfig({
      configDir: f.configDir,
      customConfigFile: f.customConfigFile,
      env: { HOME: f.root, XDG_CONFIG_HOME: f.xdg },
    });
    expect(await readFile(path.join(f.configDir, "skills", "own.md"), "utf8")).toBe("x");
    // A stale link to something the user no longer has is removed.
    expect(await lstat(path.join(f.configDir, "agents")).catch(() => undefined)).toBeUndefined();
  });

  test("mirrors the backend's OPENCODE_CONFIG file to its own path", async () => {
    const f = await fixture();
    const custom = path.join(f.root, "custom", "my.jsonc");
    await mkdir(path.dirname(custom));
    await writeFile(custom, '{ "plugin": ["y"], "agent": { "a": { "prompt": "{file:./p.md}" } } }');
    const env = { HOME: f.root, XDG_CONFIG_HOME: f.xdg, OPENCODE_CONFIG: custom };
    await mirrorOpenCodeUserConfig({
      configDir: f.configDir,
      customConfigFile: f.customConfigFile,
      env,
    });
    expect(parse(await readFile(f.customConfigFile, "utf8"))).toEqual({
      agent: { a: { prompt: `{file:${path.dirname(custom)}/./p.md}` } },
    });
    // Unset again: the mirror goes too.
    await mirrorOpenCodeUserConfig({
      configDir: f.configDir,
      customConfigFile: f.customConfigFile,
      env: { HOME: f.root, XDG_CONFIG_HOME: f.xdg },
    });
    await expect(stat(f.customConfigFile)).rejects.toThrow();
  });
});

describe("buildOpenCode2ContainerUserConfigScript", () => {
  test("runs the same merge with Bun alone and links the same entries", async () => {
    const root = await tempDir();
    const userDir = path.join(root, "user");
    const configDir = path.join(root, "config");
    await mkdir(path.join(userDir, "agents"), { recursive: true });
    await mkdir(path.join(userDir, "plugins"), { recursive: true });
    await mkdir(configDir);
    await writeFile(
      path.join(userDir, "opencode.jsonc"),
      '// c\n{ "plugin": ["v1"], "mcp": { "m": { "type": "local", "command": ["x"] } }, }',
    );
    const script = buildOpenCode2ContainerUserConfigScript(userDir, configDir, quoteShell);
    expect(script).toContain(OPENCODE2_CONTAINER_BUN);
    // The image's Bun path does not exist on every host; run the same program with this one.
    const local = script.replace(OPENCODE2_CONTAINER_BUN, process.execPath);
    const run = Bun.spawnSync(["bash", "-c", `set -e\n${local}`], { stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    const mirror = await readFile(path.join(configDir, OPENCODE2_USER_CONFIG_MIRROR_FILE), "utf8");
    expect(parse(mirror)).toEqual({ mcp: { m: { type: "local", command: ["x"] } } });
    expect(await readlink(path.join(configDir, "agents"))).toBe(path.join(userDir, "agents"));
    expect(await lstat(path.join(configDir, "plugins")).catch(() => undefined)).toBeUndefined();

    // Without Bun the start still succeeds, with no mirror.
    const missing = script.replace(OPENCODE2_CONTAINER_BUN, path.join(root, "no-bun"));
    expect(Bun.spawnSync(["bash", "-c", `set -e\n${missing}`], { stderr: "pipe" }).exitCode).toBe(
      0,
    );
    await expect(stat(path.join(configDir, OPENCODE2_USER_CONFIG_MIRROR_FILE))).rejects.toThrow();
  }, 30_000);
});
