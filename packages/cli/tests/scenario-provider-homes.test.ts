import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { BACKEND_INSTANCE_DESCRIPTOR_TYPE } from "@orkestrator/protocol/backend-instance";
import { stagePortableInputs } from "../../../apps/backend/src/core/portable-inputs.js";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isolateProviderHomes, startIsolatedBackend } from "../scenarios/harness.js";
import {
  INHERITED_AGENT_TOOL_ENV,
  prepareIsolatedBackendEnvironment,
} from "../scenarios/provider-homes.js";
import { prepareProviderRuntime } from "../scenarios/provider-runtime.js";

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

describe("Pi, Cursor and Grok", () => {
  test("Pi gets only its API-key logins, never an OAuth one", async () => {
    const { hostHome, root } = await fixture();
    const source = path.join(hostHome, ".pi", "agent", "auth.json");
    await mkdir(path.dirname(source), { recursive: true });
    const credentials = JSON.stringify({
      "openai-codex": { type: "oauth", access: "a", refresh: "rotating-refresh", expires: 0 },
      "opencode-go": { type: "api_key", key: "pi-key" },
    });
    await writeFile(source, credentials);
    await writeFile(path.join(hostHome, ".pi", "agent", "settings.json"), "{}");
    const env = await prepareIsolatedBackendEnvironment({
      root,
      hostHome,
      hostEnv: {},
      credentialSource: "pi",
    });
    const base = path.join(root, "provider-homes");
    expect(env.PI_CODING_AGENT_DIR).toBe(path.join(base, ".pi", "agent"));
    expect(env.ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR).toBe(env.PI_CODING_AGENT_DIR);
    expect(env.ORKESTRATOR_AGENT_TEST_HOST_HOME).toBe(base);
    expect(await filesUnder(base)).toEqual([path.join(".pi", "agent", "auth.json")]);
    const staged = path.join(env.PI_CODING_AGENT_DIR!, "auth.json");
    expect(JSON.parse(await readFile(staged, "utf8"))).toEqual({
      "opencode-go": { type: "api_key", key: "pi-key" },
    });
    expect((await stat(staged)).mode & 0o777).toBe(0o600);
    expect(await readFile(source, "utf8")).toBe(credentials);
  });

  test("Pi refuses a login with no API key", async () => {
    const { hostHome, root } = await fixture();
    const source = path.join(hostHome, ".pi", "agent", "auth.json");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, JSON.stringify({ anthropic: { type: "oauth", refresh: "r" } }));
    await expect(
      isolateProviderHomes({ root, hostHome, hostEnv: {}, credentialSource: "pi" }),
    ).rejects.toThrow("refusing to clone OAuth");
    expect(await filesUnder(path.join(root, "provider-homes"))).toEqual([]);
  });

  test("Grok gets its login with the refresh token blanked, or an explicit API key", async () => {
    const { hostHome, root } = await fixture();
    const source = path.join(hostHome, ".grok", "auth.json");
    await mkdir(path.dirname(source), { recursive: true });
    const credentials = JSON.stringify({
      "https://auth.x.ai::user": {
        key: "access",
        refresh_token: "rotating-refresh",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    await writeFile(source, credentials);
    await writeFile(path.join(hostHome, ".grok", "config.toml"), "host settings");
    const env = await prepareIsolatedBackendEnvironment({
      root,
      hostHome,
      hostEnv: {},
      credentialSource: "grok",
    });
    const base = path.join(root, "provider-homes");
    expect(env.GROK_HOME).toBe(path.join(base, ".grok"));
    expect(env.ORKESTRATOR_AGENT_TEST_HOST_HOME).toBe(base);
    expect(await filesUnder(base)).toEqual([path.join(".grok", "auth.json")]);
    const staged = JSON.parse(await readFile(path.join(env.GROK_HOME!, "auth.json"), "utf8"));
    expect(staged["https://auth.x.ai::user"]).toMatchObject({ key: "access", refresh_token: "" });
    expect(await readFile(source, "utf8")).toBe(credentials);

    const keyed = await fixture();
    await mkdir(path.join(keyed.hostHome, ".grok"), { recursive: true });
    await writeFile(path.join(keyed.hostHome, ".grok", "auth.json"), "must-not-be-read");
    const keyedEnv = await prepareIsolatedBackendEnvironment({
      root: keyed.root,
      hostHome: keyed.hostHome,
      hostEnv: { XAI_API_KEY: "xai-key" },
      credentialSource: "grok",
    });
    expect(keyedEnv.XAI_API_KEY).toBe("xai-key");
    expect(await filesUnder(path.join(keyed.root, "provider-homes"))).toEqual([
      path.join(".grok", "xai-api-key"),
    ]);
    const keyFile = path.join(keyedEnv.GROK_HOME!, "xai-api-key");
    expect(await readFile(keyFile, "utf8")).toBe("xai-key");
    expect((await stat(keyFile)).mode & 0o077).toBe(0);
  });

  test("Grok's selected key crosses portable input staging and the container startup into a child only for Grok", async () => {
    const { root, hostHome } = await fixture();
    const env = await prepareIsolatedBackendEnvironment({
      root,
      hostHome,
      hostEnv: { XAI_API_KEY: "dummy-xai-container" },
      credentialSource: "grok",
    });
    const roots = {
      home: hostHome,
      agentTest: true,
      agentTestHostHome: env.ORKESTRATOR_AGENT_TEST_HOST_HOME,
    };
    const staged = await stagePortableInputs(
      path.join(root, "data"),
      "env",
      new Set(["grok"]),
      roots,
    );
    const mount = staged.mounts.find((entry) => entry.target === "/grok-home")!;
    const containerHome = path.join(root, "container-home");
    await mkdir(containerHome);
    // Execute the production entrypoint copy block and Grok-only startup line
    // against a credential-free filesystem, with a child standing in for Grok.
    const entrypoint = await readFile(
      path.resolve(import.meta.dir, "../../../docker/entrypoint.sh"),
      "utf8",
    );
    const block = entrypoint.slice(
      entrypoint.indexOf("# Set up Grok configuration."),
      entrypoint.indexOf('log_progress "Grok configuration ready"'),
    );
    const startup = await readFile(
      path.resolve(import.meta.dir, "../../../apps/backend/src/core/commands-registry-servers.ts"),
      "utf8",
    );
    const loadKey = startup
      .split("\n")
      .find((line) => line.includes('if [ -s "$HOME/.grok/xai-api-key" ]'))!
      .trim()
      .replace(/^: `/, "");
    const script = `set -e
log_progress() { :; }
report_agent_copy_skips() { :; }
copy_agent_file() { mkdir -p "$2"; if [ -f "$1/$3" ]; then cp "$1/$3" "$2/$3"; fi; }
copy_agent_directory_entries() { :; }
copy_agent_directory() { :; }
restrict_imported_login() { :; }
${block.replaceAll("/grok-home", mount.source).replaceAll("/grok-config", path.join(root, "missing-config"))}
${loadKey}
exec "$TEST_BUN" -e 'process.stdout.write(process.env.XAI_API_KEY || "missing")'
`;
    const child = spawnSync("bash", ["-c", script], {
      env: { HOME: containerHome, PATH: process.env.PATH, TEST_BUN: process.execPath },
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("dummy-xai-container");
    expect(child.stderr).toBe("");
    expect((await stat(path.join(containerHome, ".grok", "xai-api-key"))).mode & 0o077).toBe(0);
    const other = await stagePortableInputs(
      path.join(root, "data"),
      "other",
      new Set(["codex"]),
      roots,
    );
    expect(other.mounts.some((entry) => entry.target === "/grok-home")).toBe(false);
    await mkdir(path.join(root, "unrelated"));
    const unrelated = await prepareIsolatedBackendEnvironment({
      root: path.join(root, "unrelated"),
      hostHome,
      hostEnv: { XAI_API_KEY: "dummy-xai-container" },
      credentialSource: "cursor",
    });
    expect(unrelated.XAI_API_KEY).toBeUndefined();
    expect(await filesUnder(unrelated.GROK_HOME!)).toEqual([]);
  });

  test("Grok refuses an expired login rather than copying one that must refresh", async () => {
    const { hostHome, root } = await fixture();
    await mkdir(path.join(hostHome, ".grok"), { recursive: true });
    await writeFile(
      path.join(hostHome, ".grok", "auth.json"),
      JSON.stringify({
        login: { key: "a", refresh_token: "r", expires_at: "2000-01-01T00:00:00Z" },
      }),
    );
    await expect(
      isolateProviderHomes({ root, hostHome, hostEnv: {}, credentialSource: "grok" }),
    ).rejects.toThrow("cannot use the host login");
  });

  test("provider keys reach only their own authorized run", async () => {
    const { hostHome, root } = await fixture();
    const hostEnv = {
      CURSOR_API_KEY: "cursor-key",
      XAI_API_KEY: "xai-key",
      GROK_AUTH_FILE: "host-grok-auth",
      GROK_HOME: "host-grok",
      PI_CODING_AGENT_DIR: "host-pi",
    };
    const free = await prepareIsolatedBackendEnvironment({ root, hostHome, hostEnv });
    for (const key of ["CURSOR_API_KEY", "XAI_API_KEY", "GROK_AUTH_FILE"])
      expect(free[key]).toBeUndefined();
    expect(free.GROK_HOME!.startsWith(path.join(root, "provider-homes"))).toBe(true);
    expect(free.PI_CODING_AGENT_DIR!.startsWith(path.join(root, "provider-homes"))).toBe(true);
    const cursor = await prepareIsolatedBackendEnvironment({
      root,
      hostHome,
      hostEnv,
      credentialSource: "cursor",
    });
    expect(cursor.CURSOR_API_KEY).toBe("cursor-key");
    expect(cursor.XAI_API_KEY).toBeUndefined();
    expect(cursor.ORKESTRATOR_AGENT_TEST_HOST_HOME).toBeUndefined();
  });
});

describe("prepareProviderRuntime", () => {
  async function layout() {
    const base = await mkdtemp(path.join(os.tmpdir(), "ork-provider-runtime-"));
    directories.push(base);
    const packageRoot = path.join(base, "repo", "packages", "cli");
    for (const name of ["claude-bridge", "codex-bridge"]) {
      await mkdir(path.join(packageRoot, "resources", name, "dist"), { recursive: true });
      await writeFile(path.join(packageRoot, "resources", name, "dist", "index.js"), "");
    }
    for (const name of ["pi-bridge", "cursor-bridge", "acp-bridge"]) {
      const bridge = path.join(base, "repo", "bridges", name);
      await mkdir(path.join(bridge, "dist"), { recursive: true });
      await mkdir(path.join(bridge, "src"), { recursive: true });
      await writeFile(path.join(bridge, "dist", "index.js"), "");
      await writeFile(path.join(bridge, "package.json"), `{"name":"${name}"}`);
    }
    const root = path.join(base, "scenario");
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    return { packageRoot, root, dataDir, repo: path.join(base, "repo") };
  }

  test("packaged providers keep the packaged resources untouched", async () => {
    const { packageRoot, root, dataDir } = await layout();
    for (const provider of [undefined, "claude", "codex", "opencode"]) {
      expect(
        await prepareProviderRuntime({
          root,
          dataDir,
          packageRoot,
          ...(provider ? { provider } : {}),
        }),
        // An agent-test backend never falls back to PATH, so a packaged
        // provider still needs its pinned binary.
      ).toEqual({ serveArgs: [], toolchainTools: provider ? [provider] : [] });
    }
    expect(await readdir(dataDir)).toEqual([]);
  });

  test.each([
    ["pi", "pi-bridge", ["pi"]],
    ["cursor", "cursor-bridge", []],
    ["grok", "acp-bridge", ["grok"]],
  ] as const)(
    "%s runs its built bridge beside the packaged ones",
    async (provider, bridge, tools) => {
      const { packageRoot, root, dataDir, repo } = await layout();
      const runtime = await prepareProviderRuntime({ root, dataDir, packageRoot, provider });
      const resources = path.join(root, "resources");
      expect(runtime).toEqual({
        serveArgs: ["--resource-root", resources],
        toolchainTools: [...tools],
      });
      expect((await readdir(resources)).sort()).toEqual(
        ["claude-bridge", "codex-bridge", bridge].sort(),
      );
      expect(await realpath(path.join(resources, "claude-bridge"))).toBe(
        await realpath(path.join(packageRoot, "resources", "claude-bridge")),
      );
      // Only what the desktop app ships: dist and package.json, never src.
      expect((await readdir(path.join(resources, bridge))).sort()).toEqual([
        "dist",
        "package.json",
      ]);
      expect(await realpath(path.join(resources, bridge, "dist"))).toBe(
        await realpath(path.join(repo, "bridges", bridge, "dist")),
      );
      expect(
        JSON.parse(await readFile(path.join(dataDir, "agent-platforms.json"), "utf8")),
      ).toEqual({
        enabled: ["claude", "codex", "opencode", provider],
      });
    },
  );

  test.each(["pi", "cursor", "grok"])(
    "startIsolatedBackend wires %s resources and installs only its pinned tools",
    async (provider) => {
      const { packageRoot, root, dataDir } = await layout();
      await mkdir(path.join(packageRoot, "bin"));
      const calls = path.join(root, "calls.jsonl");
      await writeFile(
        path.join(packageRoot, "bin", "orkestrator.js"),
        `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const dataDir = args[args.indexOf("--data-dir") + 1];
const platforms = JSON.parse(readFileSync(path.join(dataDir, "agent-platforms.json"), "utf8"));
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, platforms }) + "\\n");
if (args[0] === "toolchain") process.exit(process.env.FAIL_INSTALL === "1" ? 1 : 0);
writeFileSync(path.join(dataDir, "backend-instance.json"), JSON.stringify({
version: 1, type: ${JSON.stringify(BACKEND_INSTANCE_DESCRIPTOR_TYPE)}, installationId: "stub", generation: "stub", pid: process.pid,
startedAt: new Date().toISOString(), url: "http://127.0.0.1:1", authFile: path.join(dataDir, "auth"), dataDir, appVersion: "test", publicApiSchemaVersion: 1
}));
console.log(JSON.stringify({ type: "orkestrator-backend-ready" }));
setInterval(() => {}, 1000);
`,
      );
      const backend = await startIsolatedBackend({
        root,
        packageRoot,
        credentialSource: provider,
        hostHome: path.join(root, "host-home"),
        hostEnv: { GROK_HOME: path.join(root, "empty") },
      });
      try {
        const recorded = (await readFile(calls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const serve = recorded.at(-1);
        expect(serve.args.slice(0, 1)).toEqual(["serve"]);
        expect(
          serve.args.slice(
            serve.args.indexOf("--resource-root"),
            serve.args.indexOf("--resource-root") + 2,
          ),
        ).toEqual(["--resource-root", path.join(root, "resources")]);
        expect(serve.platforms.enabled).toContain(provider);
        // Cursor has no pinned binary; Pi and Grok install theirs first.
        expect(recorded).toHaveLength(provider === "cursor" ? 1 : 2);
        if (provider !== "cursor")
          expect(recorded[0].args).toEqual([
            "toolchain",
            "install",
            "--json",
            "--data-dir",
            dataDir,
            "--tool",
            provider,
          ]);
      } finally {
        await backend.stop();
      }
      if (provider === "grok") {
        await rm(path.join(root, "resources"), { recursive: true });
        await rm(calls);
        await expect(
          startIsolatedBackend({
            root,
            packageRoot,
            credentialSource: provider,
            hostHome: path.join(root, "host-home"),
            hostEnv: { GROK_HOME: path.join(root, "empty"), FAIL_INSTALL: "1" },
          }),
        ).rejects.toThrow("toolchain install grok failed");
        const recorded = (await readFile(calls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(recorded).toHaveLength(1);
        expect(recorded[0].args[0]).toBe("toolchain");
      }
    },
  );

  test("an unbuilt bridge fails with the build command", async () => {
    const { packageRoot, root, dataDir, repo } = await layout();
    await rm(path.join(repo, "bridges", "pi-bridge", "dist"), { recursive: true });
    await expect(
      prepareProviderRuntime({ root, dataDir, packageRoot, provider: "pi" }),
    ).rejects.toThrow("mise run build:pi-bridge");
  });
});
