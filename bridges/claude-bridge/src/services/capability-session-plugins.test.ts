import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITY_SESSION_PLUGINS_DIR_ENV } from "@orkestrator/protocol/capability-resources";
import { capabilitySessionPlugins, parseCapabilityPlugins } from "./capability-session-plugins.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "capability-session-plugins-"));
  dirs.push(base);
  const root = join(base, "capability-session-plugins");
  const plugin = join(root, "a".repeat(40));
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  await writeFile(join(plugin, ".claude-plugin", "plugin.json"), '{"name":"orkestrator-session"}');
  return { base, root, plugin, env: { [CAPABILITY_SESSION_PLUGINS_DIR_ENV]: root } };
}

describe("capabilityPlugins on a prompt", () => {
  test("parses a bounded list of strings", () => {
    expect(parseCapabilityPlugins(undefined)).toBeUndefined();
    expect(parseCapabilityPlugins("x")).toBeUndefined();
    expect(parseCapabilityPlugins([1, ""])).toBeUndefined();
    expect(parseCapabilityPlugins(["/a", "/b", "/c", "/d", "/e"])).toHaveLength(4);
  });

  test("passes a plugin directory the backend staged inside its root", async () => {
    const { plugin, env } = await fixture();
    expect(await capabilitySessionPlugins([plugin], undefined, env)).toEqual([
      { type: "local", path: plugin },
    ]);
  });

  test("refuses paths outside the root, links, and directories without a plugin", async () => {
    const { base, root, plugin, env } = await fixture();
    const outside = join(base, "b".repeat(40));
    await mkdir(join(outside, ".claude-plugin"), { recursive: true });
    await writeFile(join(outside, ".claude-plugin", "plugin.json"), "{}");
    const link = join(root, "c".repeat(40));
    await symlink(outside, link);
    const empty = join(root, "d".repeat(40));
    await mkdir(empty);
    const nested = join(plugin, "e".repeat(40));
    await mkdir(join(nested, ".claude-plugin"), { recursive: true });
    await writeFile(join(nested, ".claude-plugin", "plugin.json"), "{}");
    expect(
      await capabilitySessionPlugins(
        [outside, link, empty, nested, join(root, "not-a-digest"), "relative/path"],
        undefined,
        env,
      ),
    ).toEqual([]);
  });

  test("loads nothing without the backend's root, or on a read-only turn", async () => {
    const { plugin, env } = await fixture();
    expect(await capabilitySessionPlugins([plugin], undefined, {})).toEqual([]);
    expect(
      await capabilitySessionPlugins([plugin], { id: "coordinator-read-only" } as never, env),
    ).toEqual([]);
  });
});
