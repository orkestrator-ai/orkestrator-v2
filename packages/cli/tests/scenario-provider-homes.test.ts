import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isolateProviderHomes, startIsolatedBackend } from "../scenarios/harness.js";
import {
  INHERITED_AGENT_TOOL_ENV,
  prepareIsolatedBackendEnvironment,
} from "../scenarios/provider-homes.js";

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
  await writeFile(
    path.join(hostHome, ".codex", "auth.json"),
    '{"auth_mode":"apikey","OPENAI_API_KEY":"test-key"}',
  );
  await writeFile(path.join(hostHome, ".codex", "config.toml"), 'model = "host"\n');
  await writeFile(path.join(hostHome, ".codex", "hooks.json"), "{}");
  await mkdir(path.join(hostHome, ".local", "share", "opencode"), {
    recursive: true,
  });
  await writeFile(
    path.join(hostHome, ".local", "share", "opencode", "auth.json"),
    '{"example":{"type":"api","key":"test-key"}}',
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
    expect(env.ORKESTRATOR_AGENT_TEST_HOST_HOME).toBeUndefined();
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
    expect(await readFile(copied, "utf8")).toBe(
      '{"auth_mode":"apikey","OPENAI_API_KEY":"test-key"}',
    );
    expect((await stat(copied)).mode & 0o777).toBe(0o600);
  });

  test("honours the host's XDG_DATA_HOME", async () => {
    const { hostHome, root } = await fixture();
    const elsewhere = path.join(hostHome, "elsewhere");
    await mkdir(path.join(elsewhere, "opencode"), { recursive: true });
    await writeFile(
      path.join(elsewhere, "opencode", "auth.json"),
      '{"moved":{"type":"api","key":"moved-key"}}',
    );
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
      '{"moved":{"type":"api","key":"moved-key"}}',
    );
  });

  test("a missing host login copies nothing", async () => {
    const { hostHome, root } = await fixture();
    await rm(path.join(hostHome, ".codex"), { recursive: true });
    await isolateProviderHomes({
      root,
      hostHome,
      hostEnv: {},
      credentialSource: "codex",
    });
    expect(await filesUnder(path.join(root, "provider-homes"))).toEqual([]);
  });
});

test("honours a custom host CODEX_HOME without copying settings", async () => {
  const { hostHome, root } = await fixture();
  const custom = path.join(hostHome, "custom-codex");
  await mkdir(custom);
  await writeFile(path.join(custom, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "custom-key" }));
  await writeFile(path.join(custom, "config.toml"), "host settings");
  const env = await isolateProviderHomes({
    root,
    hostHome,
    hostEnv: { CODEX_HOME: custom },
    credentialSource: "codex",
  });
  expect(JSON.parse(await readFile(path.join(env.CODEX_HOME!, "auth.json"), "utf8"))).toEqual({
    auth_mode: "apikey",
    OPENAI_API_KEY: "custom-key",
  });
  expect(await filesUnder(path.join(root, "provider-homes"))).toEqual([
    path.join("codex", "auth.json"),
  ]);
});

test.each(["CLAUDE_CONFIG_DIR", "ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR"])(
  "extracts only Claude's access token from %s before isolating homes",
  async (key) => {
    const { hostHome, root } = await fixture();
    const custom = path.join(hostHome, "custom-claude");
    await mkdir(custom);
    const credentials = JSON.stringify({
      claudeAiOauth: {
        accessToken: "custom-token",
        refreshToken: "never-copy",
        expiresAt: Date.now() + 3600000,
      },
    });
    await writeFile(path.join(custom, ".credentials.json"), credentials);
    const env = await prepareIsolatedBackendEnvironment({
      root,
      hostHome,
      hostEnv: { [key]: custom },
      credentialSource: "claude",
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("custom-token");
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(root, "provider-homes", "claude"));
    expect(env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR).toBe(env.CLAUDE_CONFIG_DIR);
    expect(env.ORKESTRATOR_AGENT_TEST_HOST_HOME).toBe(path.join(root, "provider-homes"));
    const staged = path.join(env.CLAUDE_CONFIG_DIR!, ".credentials.json");
    expect(JSON.parse(await readFile(staged, "utf8"))).toEqual({
      claudeAiOauth: { accessToken: "custom-token" },
    });
    expect((await stat(staged)).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(custom, ".credentials.json"), "utf8")).toBe(credentials);
  },
);

test.each(["codex", "opencode"] as const)(
  "refuses %s OAuth before refresh or cleanup can invalidate the host login",
  async (provider) => {
    for (const lastRefresh of ["2000-01-01T00:00:00Z", new Date().toISOString()]) {
      const { hostHome, root } = await fixture();
      const source =
        provider === "codex"
          ? path.join(hostHome, ".codex", "auth.json")
          : path.join(hostHome, ".local", "share", "opencode", "auth.json");
      const credentials = JSON.stringify(
        provider === "codex"
          ? {
              auth_mode: "chatgpt",
              tokens: { access_token: "access", refresh_token: "rotating-refresh" },
              last_refresh: lastRefresh,
            }
          : {
              openai: { type: "oauth", access: "access", refresh: "rotating-refresh", expires: 0 },
            },
      );
      await writeFile(source, credentials);
      // Refuse fresh tokens too: a 401 can demand refresh at any age. No child
      // or credential copy exists, so neither refresh nor cleanup can rotate it.
      await expect(
        isolateProviderHomes({ root, hostHome, hostEnv: {}, credentialSource: provider }),
      ).rejects.toThrow("refusing to clone OAuth");
      expect(await filesUnder(path.join(root, "provider-homes"))).toEqual([]);
      await rm(root, { recursive: true, force: true });
      expect(await readFile(source, "utf8")).toBe(credentials);
    }
  },
);

test("an explicit Codex API key avoids reading or copying the host OAuth login", async () => {
  const { hostHome, root } = await fixture();
  const source = path.join(hostHome, ".codex", "auth.json");
  await writeFile(source, "host-oauth-must-not-be-read");
  const env = await prepareIsolatedBackendEnvironment({
    root,
    hostHome,
    hostEnv: { CODEX_API_KEY: "test-api-key" },
    credentialSource: "codex",
  });
  expect(JSON.parse(await readFile(path.join(env.CODEX_HOME!, "auth.json"), "utf8"))).toEqual({
    auth_mode: "apikey",
    OPENAI_API_KEY: "test-api-key",
  });
  expect(await readFile(source, "utf8")).toBe("host-oauth-must-not-be-read");
});

test("backend environment wiring cannot inherit credential authorization or bypass isolation", async () => {
  const { hostHome, root } = await fixture();
  const hostile = {
    ORKESTRATOR_CREDENTIAL_SOURCE: "claude",
    ORKESTRATOR_AGENT_TEST_HOST_HOME: hostHome,
    ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR: "host-claude",
    ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR: "host-pi",
    CLAUDE_CONFIG_DIR: "host-claude",
    CODEX_HOME: "host-codex",
    XDG_CONFIG_HOME: "host-config",
    XDG_DATA_HOME: "host-data",
    XDG_STATE_HOME: "host-state",
    ANTHROPIC_API_KEY: "host-key",
    ANTHROPIC_AUTH_TOKEN: "host-token",
    ORKESTRATOR_AGENT_MCP_URL: "real-connection",
    ORKESTRATOR_AGENT_MCP_TOKEN: "real-token",
  };
  const env = await prepareIsolatedBackendEnvironment({
    root,
    hostHome,
    hostEnv: hostile,
    env: hostile,
  });
  expect(Object.keys(env).filter((key) => key.startsWith("ORKESTRATOR_AGENT_TEST_"))).toEqual([]);
  for (const key of ["ORKESTRATOR_CREDENTIAL_SOURCE", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])
    expect(env[key]).toBeUndefined();
  for (const key of [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ])
    expect(env[key]!.startsWith(path.join(root, "provider-homes"))).toBe(true);
  for (const [key, value] of Object.entries(INHERITED_AGENT_TOOL_ENV)) expect(env[key]).toBe(value);
  expect(await filesUnder(path.join(root, "provider-homes"))).toEqual([]);
  await expect(
    startIsolatedBackend({ root, extraArgs: ["--credential-source", "claude"] }),
  ).rejects.toThrow("credentialSource, not extraArgs");
});

test("preserves XDG-based Git, gh and mise configuration for backend children", async () => {
  const { hostHome, root } = await fixture();
  const config = path.join(hostHome, "host-config");
  const data = path.join(hostHome, "host-data");
  await mkdir(path.join(config, "git"), { recursive: true });
  await writeFile(
    path.join(config, "git", "config"),
    "[test]\n  xdg = visible\n  order = xdg\n[include]\n  path = extra\n",
  );
  await writeFile(path.join(config, "git", "extra"), "[test]\n  relative = visible\n");
  await writeFile(path.join(hostHome, ".gitconfig"), "[test]\n  home = visible\n  order = home\n");
  const hostEnv = {
    HOME: hostHome,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    PATH: process.env.PATH,
  };
  const env = await prepareIsolatedBackendEnvironment({ root, hostHome, hostEnv });
  const git = (key: string) =>
    spawnSync("git", ["config", "--global", "--includes", "--get", key], { env, encoding: "utf8" });
  for (const key of ["test.xdg", "test.relative", "test.home"]) {
    expect(git(key).status).toBe(0);
    expect(git(key).stdout.trim()).toBe("visible");
  }
  expect(git("test.order").stdout.trim()).toBe("home");
  expect(env.GH_CONFIG_DIR).toBe(path.join(config, "gh"));
  expect(env.MISE_CONFIG_DIR).toBe(path.join(config, "mise"));
  expect(env.MISE_DATA_DIR).toBe(path.join(data, "mise"));
  // A real mise invocation must resolve both the host's XDG global config
  // and its installed runtime, without downloading or executing a provider.
  await mkdir(path.join(config, "mise"), { recursive: true });
  await writeFile(
    path.join(config, "mise", "config.toml"),
    `[tools]\nbun = "${process.versions.bun}"\n`,
  );
  const installs = path.join(data, "mise", "installs", "bun");
  await mkdir(installs, { recursive: true });
  await symlink(
    path.dirname(path.dirname(process.execPath)),
    path.join(installs, process.versions.bun!),
  );
  const mise = spawnSync(process.env.MISE_BIN_PATH || "mise", ["where", "bun"], {
    cwd: hostHome,
    env,
    encoding: "utf8",
  });
  expect(mise.stderr).toBe("");
  expect(mise.status).toBe(0);
  expect(mise.stdout.trim()).toBe(path.join(installs, process.versions.bun!));
  const explicit = {
    GH_CONFIG_DIR: "custom-gh",
    MISE_CONFIG_DIR: "custom-mise-config",
    MISE_DATA_DIR: "custom-mise-data",
    MISE_STATE_DIR: "custom-state",
    MISE_CACHE_DIR: "custom-cache",
    GIT_CONFIG_GLOBAL: "custom-git",
  };
  const custom = await prepareIsolatedBackendEnvironment({
    root,
    hostHome,
    hostEnv: { ...hostEnv, ...explicit },
  });
  for (const [key, value] of Object.entries(explicit)) expect(custom[key]).toBe(value);
});
