import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolateProviderHomes } from "../scenarios/harness.js";

/**
 * Live scenarios must never write into the host's provider homes, and may see
 * only the one credential file the selected provider needs.
 */

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "ork-provider-homes-"));
  directories.push(base);
  const hostHome = path.join(base, "host");
  const root = path.join(base, "scenario");
  await mkdir(path.join(hostHome, ".codex"), { recursive: true });
  await writeFile(path.join(hostHome, ".codex", "auth.json"), '{"codex":"login"}');
  await writeFile(path.join(hostHome, ".codex", "config.toml"), 'model = "host"\n');
  await writeFile(path.join(hostHome, ".codex", "hooks.json"), "{}");
  await mkdir(path.join(hostHome, ".local", "share", "opencode"), {
    recursive: true,
  });
  await writeFile(
    path.join(hostHome, ".local", "share", "opencode", "auth.json"),
    '{"opencode":"login"}',
  );
  await mkdir(root, { recursive: true });
  return { hostHome, root };
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort();
}

describe("isolateProviderHomes", () => {
  test("points every provider home inside the scenario root", async () => {
    const { hostHome, root } = await fixture();
    const env = await isolateProviderHomes({ root, hostHome, hostEnv: {} });
    for (const key of [
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ]) {
      expect(env[key]!.startsWith(path.join(root, "provider-homes"))).toBe(true);
      expect((await stat(env[key]!)).mode & 0o777).toBe(0o700);
    }
    expect(env.ORKESTRATOR_AGENT_TEST_HOST_HOME).toBe(hostHome);
    // Credential-free runs copy nothing.
    expect(await filesUnder(path.join(root, "provider-homes"))).toEqual([]);
  });

  test("copies only the Codex login for a Codex run", async () => {
    const { hostHome, root } = await fixture();
    const env = await isolateProviderHomes({
      root,
      hostHome,
      hostEnv: {},
      credentialSource: "codex",
    });
    expect(await filesUnder(path.join(root, "provider-homes"))).toEqual([
      path.join("codex", "auth.json"),
    ]);
    const copied = path.join(env.CODEX_HOME!, "auth.json");
    expect(await readFile(copied, "utf8")).toBe('{"codex":"login"}');
    expect((await stat(copied)).mode & 0o777).toBe(0o600);
  });

  test("honours the host's CODEX_HOME and XDG_DATA_HOME", async () => {
    const { hostHome, root } = await fixture();
    const elsewhere = path.join(hostHome, "elsewhere");
    await mkdir(path.join(elsewhere, "opencode"), { recursive: true });
    await writeFile(path.join(elsewhere, "opencode", "auth.json"), '{"moved":true}');
    const env = await isolateProviderHomes({
      root,
      hostHome,
      hostEnv: { XDG_DATA_HOME: elsewhere },
      credentialSource: "opencode",
    });
    expect(await filesUnder(path.join(root, "provider-homes"))).toEqual([
      path.join("xdg-data", "opencode", "auth.json"),
    ]);
    expect(await readFile(path.join(env.XDG_DATA_HOME!, "opencode", "auth.json"), "utf8")).toBe(
      '{"moved":true}',
    );
  });

  test("a missing host login or a Claude run copies nothing", async () => {
    const { hostHome, root } = await fixture();
    await rm(path.join(hostHome, ".codex"), { recursive: true });
    await isolateProviderHomes({
      root,
      hostHome,
      hostEnv: {},
      credentialSource: "codex",
    });
    await isolateProviderHomes({
      root,
      hostHome,
      hostEnv: {},
      credentialSource: "claude",
    });
    expect(await filesUnder(path.join(root, "provider-homes"))).toEqual([]);
  });
});
