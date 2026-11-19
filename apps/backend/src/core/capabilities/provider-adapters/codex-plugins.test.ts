/**
 * Codex plugin enablement over a real config.toml in a temporary CODEX_HOME.
 * The live run against the pinned Codex binary is in
 * `provider-conformance.live.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseCodexInstalledPlugins,
  setCodexPluginEnabled,
  toggleCodexPlugin,
} from "./codex-plugins.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const CONFIG = `# my settings
model = "gpt-5"

[mcp_servers.docs]
command = "docs-mcp" # keep me

[marketplaces.local-test]
source_type = "local"
source = "/somewhere"

[plugins."demo@local-test"]
enabled = true # switched by hand

[plugins."other@local-test"]
enabled = false
`;

async function codexHome(config = CONFIG, mode = 0o600) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-plugins-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "config.toml"), config, { mode });
  return root;
}

const installed = [
  { pluginId: "demo@local-test", enabled: true },
  { pluginId: "other@local-test", enabled: false },
];

describe("Codex plugin enablement", () => {
  test("flips only the enabled flag, keeping every other byte and the file's mode", async () => {
    const home = await codexHome();
    const result = await setCodexPluginEnabled({
      codexHome: home,
      pluginId: "demo@local-test",
      enabled: false,
      installed,
    });
    expect(result).toEqual({ pluginId: "demo@local-test", enabled: false, changed: true });
    const after = await fs.readFile(path.join(home, "config.toml"), "utf8");
    expect(after).toBe(
      CONFIG.replace("enabled = true # switched by hand", "enabled = false # switched by hand"),
    );
    expect((await fs.stat(path.join(home, "config.toml"))).mode & 0o777).toBe(0o600);
  });

  test("a plugin already in the requested state is not rewritten", async () => {
    const home = await codexHome();
    const before = await fs.stat(path.join(home, "config.toml"));
    const result = await setCodexPluginEnabled({
      codexHome: home,
      pluginId: "other@local-test",
      enabled: false,
      installed,
    });
    expect(result.changed).toBe(false);
    expect((await fs.stat(path.join(home, "config.toml"))).ino).toBe(before.ino);
  });

  test("a plugin Codex does not report as installed is refused and nothing is written", async () => {
    const home = await codexHome();
    await expect(
      setCodexPluginEnabled({
        codexHome: home,
        pluginId: "demo@local-test",
        enabled: false,
        installed: [],
      }),
    ).rejects.toThrow("install it in Codex first");
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(CONFIG);
  });

  test("no entry is ever added: a missing table is left to Codex", async () => {
    const home = await codexHome('model = "gpt-5"\n');
    await expect(
      setCodexPluginEnabled({
        codexHome: home,
        pluginId: "demo@local-test",
        enabled: true,
        installed,
      }),
    ).rejects.toThrow("no [plugins.");
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe('model = "gpt-5"\n');
  });

  test("an inline or dotted layout stays read-only", async () => {
    const inline = 'plugins = { "demo@local-test" = { enabled = true } }\n';
    const home = await codexHome(inline);
    await expect(
      setCodexPluginEnabled({
        codexHome: home,
        pluginId: "demo@local-test",
        enabled: false,
        installed,
      }),
    ).rejects.toThrow("switch it in Codex instead");
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(inline);
  });

  test("a linked config.toml is refused", async () => {
    const home = await codexHome();
    const real = path.join(home, "real.toml");
    await fs.rename(path.join(home, "config.toml"), real);
    await fs.symlink(real, path.join(home, "config.toml"));
    await expect(
      setCodexPluginEnabled({
        codexHome: home,
        pluginId: "demo@local-test",
        enabled: false,
        installed,
      }),
    ).rejects.toThrow("not a regular file");
    expect(await fs.readFile(real, "utf8")).toBe(CONFIG);
  });

  test("an unsafe plugin id is refused", async () => {
    const home = await codexHome();
    await expect(
      setCodexPluginEnabled({
        codexHome: home,
        pluginId: 'demo"]\nx = 1',
        enabled: false,
        installed,
      }),
    ).rejects.toThrow("name@marketplace");
  });

  test("the change is confirmed with Codex's own list", async () => {
    const home = await codexHome();
    let reported = true;
    const calls: string[][] = [];
    const cli = async (args: string[]) => {
      calls.push(args);
      const list = {
        installed: [{ pluginId: "demo@local-test", installed: true, enabled: reported }],
        available: [],
      };
      return { stdout: JSON.stringify(list), exitCode: 0 };
    };
    // Codex reads the file again; this fake keeps saying "enabled".
    await expect(
      toggleCodexPlugin({ codexHome: home, cli }, "demo@local-test", false),
    ).rejects.toThrow("does not report");
    reported = false;
    await fs.writeFile(path.join(home, "config.toml"), CONFIG);
    await expect(
      toggleCodexPlugin({ codexHome: home, cli }, "demo@local-test", false),
    ).resolves.toMatchObject({ enabled: false, changed: true });
    expect(calls.every((args) => args.join(" ") === "plugin list --json")).toBe(true);
  });

  test("Codex's list is parsed defensively and lists only installed plugins", () => {
    expect(parseCodexInstalledPlugins("nope")).toBeNull();
    expect(
      parseCodexInstalledPlugins(
        JSON.stringify({
          installed: [
            { pluginId: "a@m", installed: true, enabled: false },
            { pluginId: "b@m", installed: false, enabled: true },
            { name: "no-id" },
          ],
        }),
      ),
    ).toEqual([{ pluginId: "a@m", enabled: false }]);
  });
});
