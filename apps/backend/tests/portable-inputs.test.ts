import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import {
  INPUT_LIMITS,
  INPUT_REVISION_PRUNE_GRACE_MS,
  defaultInputSourceRoots,
  grokStagingConfig,
  grokStagingHome,
  portableInputSpec,
  pruneInputRevisions,
  readInputsManifest,
  scrubStagedProvider,
  stagePortableInputs,
  stagedInputMountArguments,
  type InputSourceRoots,
} from "../src/core/portable-inputs";
import {
  providerCredentialsAllowed,
  revokeProviderCredentials,
  selectedInputProviders,
} from "../src/core/portable-input-status";
import { environmentStateDirectory } from "../src/core/environment-state-paths";
import {
  CURSOR_MCP_STAGED_INPUTS_VERSION,
  IMAGE_CAPABILITIES,
  imageCopiesCursorMcpConfig,
} from "@orkestrator/protocol/image-manifest";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function write(file: string, content: string | Buffer = "x") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** A fake host home with inputs, excluded state and sentinels. */
async function fixtureHome() {
  const root = await tempDir("ork-inputs-");
  cleanup.push(root);
  const home = path.join(root, "home");
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  // Claude: allowlisted files and extensions, plus state that must never be staged.
  await write(path.join(home, ".claude", "CLAUDE.md"), "memory");
  await write(
    path.join(home, ".claude", ".credentials.json"),
    '{"claudeAiOauth":{"accessToken":"fixture","refreshToken":"fixture-refresh"}}',
  );
  await write(path.join(home, ".claude", "history.jsonl"), "SENTINEL-HISTORY");
  await write(path.join(home, ".claude", "projects", "p", "s.jsonl"), "SENTINEL-TRANSCRIPT");
  await write(path.join(home, ".claude", "commands", "review.md"), "command");
  await fs.symlink("/etc/hostname", path.join(home, ".claude", "commands", "escape.md"));
  await write(path.join(home, ".claude.json"), '{"hasCompletedOnboarding":true}');
  // Codex: disabled in most tests; its sentinel must never appear.
  await write(path.join(home, ".codex", "auth.json"), "SENTINEL-CODEX-AUTH");
  await write(path.join(home, ".codex", "sessions", "r.jsonl"), "SENTINEL-CODEX-SESSION");
  // A dotfiles-managed gitconfig (the file itself is a link).
  await write(path.join(root, "dotfiles", "gitconfig"), "[user]\n\tname = Fixture\n");
  await fs.symlink(path.join(root, "dotfiles", "gitconfig"), path.join(home, ".gitconfig"));
  const roots: InputSourceRoots = { home, agentTest: false };
  return { root, home, dataDir, roots };
}

async function listFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (relative: string) => {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else out.push(child);
    }
  };
  await walk("");
  return out.sort();
}

describe("portable input staging", () => {
  test("stages only the allowlist of enabled providers and binds only staged subtrees", async () => {
    const { dataDir, roots } = await fixtureHome();
    const staged = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["claude", "git"] as const),
      roots,
    );
    const files = await listFiles(staged.directory);
    expect(files).toEqual([
      "claude-config/.credentials.json",
      "claude-config/CLAUDE.md",
      "claude-config/commands/review.md",
      "files/claude.json/.claude.json",
      "files/gitconfig/gitconfig",
      "manifest.json",
    ]);
    for (const file of files) {
      const content = await fs.readFile(path.join(staged.directory, file), "utf8");
      expect(content).not.toContain("SENTINEL");
    }
    expect(staged.providers.find((entry) => entry.provider === "claude")).toMatchObject({
      files: 5 - 1,
      skipped: { symlink: 1 },
    });
    // Mounts: the staged subtrees at the entrypoint's paths, read-only, and
    // never the revision directory or its parent.
    const args = stagedInputMountArguments(staged);
    expect(args.filter((arg) => arg !== "--mount")).toEqual([
      `type=bind,src=${staged.directory}/claude-config,dst=/claude-config,readonly`,
      `type=bind,src=${staged.directory}/files/claude.json/.claude.json,dst=/claude-config.json,readonly`,
      `type=bind,src=${staged.directory}/files/gitconfig/gitconfig,dst=/tmp/gitconfig,readonly`,
    ]);
    for (const arg of args) expect(arg).not.toContain("SENTINEL");
  });

  test("revisions are private, atomic and described by a content-free manifest", async () => {
    const { dataDir, roots } = await fixtureHome();
    const staged = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["claude"] as const),
      roots,
    );
    const parent = environmentStateDirectory(dataDir, "portable-inputs", "env-inputs");
    expect((await fs.stat(parent)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(path.join(staged.directory, "claude-config", ".credentials.json"))).mode &
        0o777,
    ).toBe(0o600);
    expect((await fs.readdir(parent)).filter((name) => name.endsWith(".partial"))).toEqual([]);
    const manifest = await readInputsManifest(dataDir, "env-inputs", staged.revision);
    expect(manifest?.providers).toEqual(staged.providers);
    expect(JSON.stringify(manifest)).not.toContain("review.md");
    expect(await readInputsManifest(dataDir, "env-inputs", "../../etc")).toBeNull();
  });

  test("enforces per-file, per-directory and aggregate bounds while copying", async () => {
    const { dataDir, roots, home } = await fixtureHome();
    await write(path.join(home, ".claude", "commands", "big.md"), Buffer.alloc(2048, 1));
    for (let index = 0; index < 5; index += 1) {
      await write(path.join(home, ".claude", "agents", `a${index}.md`), "agent");
    }
    const staged = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["claude"] as const),
      roots,
      new Date(),
      { ...INPUT_LIMITS, fileBytes: 1024, totalEntries: 6 },
    );
    const summary = staged.providers[0]!;
    expect(summary.skipped["too-large"]).toBe(1);
    expect(summary.skipped["aggregate-budget"]).toBeGreaterThan(0);
    expect(summary.files).toBeLessThanOrEqual(6);
  });

  test("an agent-test profile stages its own Grok snapshot, never the real host's", async () => {
    // The profile's isolated HOME holds the restricted copy `dev:test` seeded
    // (and a test may edit); the real host home is somewhere else.
    const { dataDir, root, home } = await fixtureHome();
    const host = path.join(root, "real-host-home");
    const login = (key: string) =>
      JSON.stringify({
        live: { key, refresh_token: "", expires_at: "2099-01-01T00:00:00Z" },
      });
    await write(path.join(home, ".grok", "auth.json"), login("profile-snapshot"));
    await write(path.join(home, ".config", "grok", "settings.toml"), "profile = true");
    await write(path.join(host, ".grok", "auth.json"), login("SENTINEL-HOST-LOGIN"));
    await write(path.join(host, ".config", "grok", "settings.toml"), "SENTINEL-HOST-CONFIG");
    const staged = await stagePortableInputs(dataDir, "env-grok-profile", new Set(["grok"]), {
      home: host,
      agentTest: true,
      agentTestHostHome: host,
      grokHome: path.join(home, ".grok"),
    });
    expect(
      JSON.parse(await fs.readFile(path.join(staged.directory, "grok-home", "auth.json"), "utf8"))
        .live.key,
    ).toBe("profile-snapshot");
    for (const file of await listFiles(staged.directory)) {
      expect(await fs.readFile(path.join(staged.directory, file), "utf8")).not.toContain(
        "SENTINEL-HOST",
      );
    }
  });

  test("an agent-test run's Grok home is GROK_HOME, else its own HOME, never the host's", () => {
    const saved = { HOME: process.env.HOME, GROK_HOME: process.env.GROK_HOME };
    try {
      process.env.HOME = "/profile/home";
      delete process.env.GROK_HOME;
      // A `dev:test` profile: its isolated HOME.
      expect(grokStagingHome(defaultInputSourceRoots("agent-test", "UNSET"))).toBe(
        "/profile/home/.grok",
      );
      expect(grokStagingConfig(defaultInputSourceRoots("agent-test", "UNSET"))).toBe(
        "/profile/home/.config/grok",
      );
      // A CLI scenario keeps HOME and names its disposable copy.
      process.env.GROK_HOME = "/scenario/provider-homes/.grok";
      expect(grokStagingHome(defaultInputSourceRoots("agent-test", "UNSET"))).toBe(
        "/scenario/provider-homes/.grok",
      );
      expect(grokStagingConfig(defaultInputSourceRoots("agent-test", "UNSET"))).toBe(
        "/scenario/provider-homes/.config/grok",
      );
      // Outside agent-test nothing changes.
      expect(defaultInputSourceRoots("production", "UNSET").grokHome).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("stages single-use Codex and Grok logins access-only, never their refresh tokens", async () => {
    const { dataDir, roots, home } = await fixtureHome();
    const now = new Date("2026-10-21T12:00:00Z");
    const accessToken = `h.${Buffer.from(
      JSON.stringify({ exp: now.getTime() / 1000 + 3600 }),
    ).toString("base64url")}.s`;
    await write(
      path.join(home, ".codex", "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: accessToken, refresh_token: "SENTINEL-CODEX-REFRESH" },
      }),
    );
    await write(
      path.join(home, ".grok", "auth.json"),
      JSON.stringify({
        live: {
          key: "grok-access",
          refresh_token: "SENTINEL-GROK-REFRESH",
          expires_at: "2026-10-21T18:00:00Z",
        },
      }),
    );
    await write(path.join(home, ".grok", "config.toml"), "model = 'x'");
    const staged = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["codex", "grok"] as const),
      roots,
      now,
    );
    const codex = JSON.parse(
      await fs.readFile(path.join(staged.directory, "codex-home", "auth.json"), "utf8"),
    );
    expect(codex.tokens).toEqual({ access_token: accessToken, refresh_token: "" });
    expect(codex.last_refresh).toBe(now.toISOString());
    const grok = JSON.parse(
      await fs.readFile(path.join(staged.directory, "grok-home", "auth.json"), "utf8"),
    );
    expect(grok.live).toMatchObject({ key: "grok-access", refresh_token: "" });
    for (const provider of ["codex", "grok"] as const) {
      const files = await listFiles(path.join(staged.directory, `${provider}-home`));
      const bytes = (
        await Promise.all(
          files.map((file) => fs.stat(path.join(staged.directory, `${provider}-home`, file))),
        )
      ).reduce((sum, stat) => sum + stat.size, 0);
      expect(staged.providers.find((entry) => entry.provider === provider)).toMatchObject({
        files: files.length,
        bytes,
      });
    }
    for (const file of await listFiles(staged.directory)) {
      expect(await fs.readFile(path.join(staged.directory, file), "utf8")).not.toContain(
        "SENTINEL",
      );
      expect((await fs.stat(path.join(staged.directory, file))).mode & 0o077).toBe(0);
    }

    // An expired login cannot be used without refreshing, so none is staged.
    await write(
      path.join(home, ".grok", "auth.json"),
      JSON.stringify({ old: { key: "k", refresh_token: "r", expires_at: "2026-10-21T11:00:00Z" } }),
    );
    const expired = await stagePortableInputs(
      dataDir,
      "env-expired",
      new Set(["grok"] as const),
      roots,
      now,
      // The withheld login must release its budget before config is copied.
      { ...INPUT_LIMITS, totalEntries: 1 },
    );
    expect(await listFiles(expired.directory)).toEqual(["grok-home/config.toml", "manifest.json"]);
    expect(expired.providers[0]).toEqual({
      provider: "grok",
      files: 1,
      bytes: Buffer.byteLength("model = 'x'"),
      skipped: { "login-withheld": 1 },
    });
    expect((await readInputsManifest(dataDir, "env-expired", expired.revision))?.providers).toEqual(
      expired.providers,
    );
    // Codex is subject to the same withholding and accounting rules.
    await write(
      path.join(home, ".codex", "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: `h.${Buffer.from(JSON.stringify({ exp: now.getTime() / 1000 - 3600 })).toString("base64url")}.s`,
          refresh_token: "SENTINEL",
        },
      }),
    );
    const expiredCodex = await stagePortableInputs(
      dataDir,
      "env-expired-codex",
      new Set(["codex"]),
      roots,
      now,
    );
    expect(expiredCodex.providers[0]).toEqual({
      provider: "codex",
      files: 0,
      bytes: 0,
      skipped: { "login-withheld": 1 },
    });
  });

  test("stages Claude's login access-only and withholds an expired one without a warning", async () => {
    const { dataDir, roots, home } = await fixtureHome();
    const now = new Date("2026-10-21T12:00:00Z");
    await write(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "access",
          refreshToken: "SENTINEL",
          expiresAt: now.getTime() + 60 * 60_000,
        },
        mcpOAuth: { server: { accessToken: "mcp", refreshToken: "SENTINEL" } },
      }),
    );
    const live = await stagePortableInputs(dataDir, "env-claude", new Set(["claude"]), roots, now);
    const text = await fs.readFile(
      path.join(live.directory, "claude-config", ".credentials.json"),
      "utf8",
    );
    expect(JSON.parse(text)).toEqual({
      claudeAiOauth: { accessToken: "access", expiresAt: now.getTime() + 60 * 60_000 },
      mcpOAuth: { server: { accessToken: "mcp" } },
    });
    // A stale on-disk file beside a Keychain login is normal on macOS; the
    // stdin sync delivers Claude's login, so withholding it is not reported.
    await write(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "a", refreshToken: "SENTINEL", expiresAt: 1 },
      }),
    );
    const expired = await stagePortableInputs(
      dataDir,
      "env-claude-expired",
      new Set(["claude"]),
      roots,
      now,
    );
    expect(await listFiles(expired.directory)).not.toContain("claude-config/.credentials.json");
    expect(expired.providers[0]?.skipped["login-withheld"]).toBeUndefined();
  });

  test("filters a dotfile-managed settings symlink and bounds its resolved target", async () => {
    const { dataDir, roots, home, root } = await fixtureHome();
    const target = path.join(root, "dotfiles", "claude-settings.json");
    await write(
      target,
      JSON.stringify({
        env: { SECRET: "SENTINEL" },
        enabledPlugins: { "on@market": true, "off@market": false },
      }),
    );
    await fs.symlink(target, path.join(home, ".claude", "settings.json"));
    const staged = await stagePortableInputs(
      dataDir,
      "linked-settings",
      new Set(["claude"]),
      roots,
    );
    expect(
      JSON.parse(
        await fs.readFile(path.join(staged.directory, "claude-config", "settings.json"), "utf8"),
      ),
    ).toEqual({ enabledPlugins: { "on@market": true, "off@market": false } });
    await write(target, "x".repeat(INPUT_LIMITS.fileBytes + 1));
    const oversized = await stagePortableInputs(
      dataDir,
      "large-settings",
      new Set(["claude"]),
      roots,
    );
    expect(await listFiles(oversized.directory)).not.toContain("claude-config/settings.json");
    expect(oversized.providers[0]!.skipped["too-large"]).toBe(1);
  });

  test("a non-ENOENT settings read failure cannot publish raw settings", async () => {
    const { dataDir, roots, home } = await fixtureHome();
    const settings = path.join(home, ".claude", "settings.json");
    await write(
      settings,
      JSON.stringify({ env: { SECRET: "SENTINEL-SECRET" }, enabledPlugins: { "on@market": true } }),
    );
    const resolvedSettings = await fs.realpath(settings);
    const originalOpen = fs.open.bind(fs);
    let injected = false;
    const openSpy = spyOn(fsPromises, "open").mockImplementation(
      async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (args[0] === resolvedSettings) {
          const read = handle.read.bind(handle);
          let calls = 0;
          handle.read = (async (...readArgs: Parameters<typeof read>) => {
            if (++calls > 1) {
              injected = true;
              throw Object.assign(new Error("fixture read failure"), { code: "EIO" });
            }
            return read(...readArgs);
          }) as typeof handle.read;
        }
        return handle;
      },
    );
    let staged;
    try {
      staged = await stagePortableInputs(dataDir, "read-failure", new Set(["claude"]), roots);
    } finally {
      openSpy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await listFiles(staged.directory)).not.toContain("claude-config/settings.json");
    expect(staged.providers[0]!.skipped.unreadable).toBe(1);
    for (const file of await listFiles(staged.directory))
      expect(await fs.readFile(path.join(staged.directory, file), "utf8")).not.toContain(
        "SENTINEL-SECRET",
      );
  });

  test("stages only the plugin enablement of Claude's user settings, and the entrypoint merges it", async () => {
    const { dataDir, roots, home, root } = await fixtureHome();
    await write(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({
        env: { API_TOKEN: "SENTINEL-SETTINGS-ENV" },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "SENTINEL-HOOK" }] }] },
        permissions: { allow: ["SENTINEL-PERMISSION"] },
        enabledPlugins: {
          "docs@market": true,
          "off@market": false,
          "odd@market": "SENTINEL-VALUE",
          ["x".repeat(300)]: true,
        },
      }),
    );
    const staged = await stagePortableInputs(dataDir, "env-plugins", new Set(["claude"]), roots);
    const stagedSettings = path.join(staged.directory, "claude-config", "settings.json");
    const text = await fs.readFile(stagedSettings, "utf8");
    expect(JSON.parse(text)).toEqual({
      enabledPlugins: { "docs@market": true, "off@market": false },
    });
    expect(text).not.toContain("SENTINEL");
    // The summary counts the filtered bytes, not the host file's.
    const claude = staged.providers.find((entry) => entry.provider === "claude")!;
    const stagedBytes = await Promise.all(
      (await listFiles(path.join(staged.directory, "claude-config"))).map(
        async (file) => (await fs.stat(path.join(staged.directory, "claude-config", file))).size,
      ),
    );
    const claudeJson = (await fs.stat(path.join(home, ".claude.json"))).size;
    expect(claude.bytes).toBe(stagedBytes.reduce((sum, size) => sum + size, 0) + claudeJson);

    // Settings that name no plugin are not staged at all.
    await write(path.join(home, ".claude", "settings.json"), '{"env":{"A":"SENTINEL"}}');
    const none = await stagePortableInputs(dataDir, "env-no-plugins", new Set(["claude"]), roots);
    expect(await listFiles(none.directory)).not.toContain("claude-config/settings.json");

    // The entrypoint keeps its own settings and takes only boolean plugin
    // entries from the staged file, refusing a symlinked one.
    const entrypoint = await fs.readFile(
      path.join(import.meta.dir, "../../../docker/entrypoint.sh"),
      "utf8",
    );
    const block = entrypoint.match(
      /^# Claude Code's plugin enablement from the host's user settings\.[\s\S]*?^fi$/m,
    )?.[0];
    if (!block) throw new Error("Missing Claude plugin enablement entrypoint block");
    const run = async (source: string, name: string) => {
      const containerHome = path.join(root, name);
      const own = { permissions: { defaultMode: "bypassPermissions" }, hooks: {} };
      await write(path.join(containerHome, ".claude", "settings.json"), JSON.stringify(own));
      const result = Bun.spawnSync({
        cmd: [
          "bash",
          "-c",
          `set -e\nlog_progress() { echo "$1"; }\n${block.replaceAll("/claude-config", '"$TEST_SOURCE"')}`,
        ],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: containerHome,
          TEST_SOURCE: source,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      return JSON.parse(
        await fs.readFile(path.join(containerHome, ".claude", "settings.json"), "utf8"),
      ) as Record<string, unknown>;
    };
    const source = path.join(root, "staged-claude-config");
    await write(
      path.join(source, "settings.json"),
      JSON.stringify({
        enabledPlugins: { "docs@market": true, "off@market": false, "odd@market": "x" },
        hooks: { Stop: "SENTINEL" },
      }),
    );
    expect(await run(source, "merged-home")).toEqual({
      permissions: { defaultMode: "bypassPermissions" },
      hooks: {},
      enabledPlugins: { "docs@market": true, "off@market": false },
    });
    const linked = path.join(root, "linked-claude-config");
    await fs.mkdir(linked);
    await fs.symlink(path.join(source, "settings.json"), path.join(linked, "settings.json"));
    expect(await run(linked, "linked-home")).toEqual({
      permissions: { defaultMode: "bypassPermissions" },
      hooks: {},
    });
    // An unreadable file leaves the container's settings as they were.
    const broken = path.join(root, "broken-claude-config");
    await write(path.join(broken, "settings.json"), "{ not json");
    expect(await run(broken, "broken-home")).toEqual({
      permissions: { defaultMode: "bypassPermissions" },
      hooks: {},
    });
  });

  test("stages only OpenCode's login from its data directory", async () => {
    const { dataDir, roots, home } = await fixtureHome();
    const data = path.join(home, ".local", "share", "opencode");
    await write(path.join(data, "auth.json"), JSON.stringify({ zen: { type: "api", key: "k" } }));
    // Host state OpenCode never reads in a container (a snapshot directory is
    // keyed by the host worktree path), plus the host's session database.
    await write(path.join(data, "account.json"), "{}");
    await write(path.join(data, "storage", "migration"), "2");
    await write(path.join(data, "storage", "session_diff", "ses_host.json"), "[]");
    await write(path.join(data, "snapshot", "project", "worktree", "HEAD"), "ref");
    await write(path.join(data, "opencode.db"), "db");
    const staged = await stagePortableInputs(dataDir, "env-opencode", new Set(["opencode"]), roots);
    expect(await listFiles(path.join(staged.directory, "opencode-data"))).toEqual(["auth.json"]);
  });

  test("stages OpenCode and Pi OAuth logins access-only and keeps their API keys", async () => {
    const { dataDir, roots, home } = await fixtureHome();
    const now = new Date("2026-10-21T12:00:00Z");
    const live = now.getTime() + 8 * 3600_000;
    await write(
      path.join(home, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({
        "opencode-go": { type: "api", key: "go-key" },
        openai: { type: "oauth", access: "oc", refresh: "SENTINEL-OC", expires: live },
        "github-copilot": { type: "oauth", access: "gho", refresh: "gho", expires: 0 },
      }),
    );
    await write(
      path.join(home, ".pi", "agent", "auth.json"),
      JSON.stringify({
        anthropic: { type: "oauth", access: "pi", refresh: "SENTINEL-PI", expires: live },
        openai: { type: "oauth", access: "old", refresh: "SENTINEL-OLD", expires: 1 },
        openrouter: { type: "api_key", key: "or-key" },
      }),
    );
    await write(path.join(home, ".pi", "agent", "settings.json"), "{}");
    const staged = await stagePortableInputs(
      dataDir,
      "env-provider-logins",
      new Set(["opencode", "pi"] as const),
      roots,
      now,
    );
    expect(
      JSON.parse(
        await fs.readFile(path.join(staged.directory, "opencode-data", "auth.json"), "utf8"),
      ),
    ).toEqual({
      "opencode-go": { type: "api", key: "go-key" },
      openai: { type: "oauth", access: "oc", refresh: "", expires: live },
      "github-copilot": { type: "oauth", access: "gho", refresh: "gho", expires: 0 },
    });
    expect(
      JSON.parse(
        await fs.readFile(path.join(staged.directory, "pi-config", "agent", "auth.json"), "utf8"),
      ),
    ).toEqual({
      anthropic: { type: "oauth", access: "pi", refresh: "", expires: live },
      openrouter: { type: "api_key", key: "or-key" },
    });
    for (const [provider, stage] of [
      ["opencode", "opencode-data"],
      ["pi", "pi-config"],
    ] as const) {
      const files = await listFiles(path.join(staged.directory, stage));
      const bytes = (
        await Promise.all(files.map((file) => fs.stat(path.join(staged.directory, stage, file))))
      ).reduce((sum, stat) => sum + stat.size, 0);
      expect(staged.providers.find((entry) => entry.provider === provider)).toEqual({
        provider,
        files: files.length,
        bytes,
        // The expired Pi OpenAI login is reported; the file itself is still staged.
        skipped: provider === "pi" ? { "login-withheld": 1 } : {},
      });
    }
    for (const file of await listFiles(staged.directory)) {
      expect(await fs.readFile(path.join(staged.directory, file), "utf8")).not.toContain(
        "SENTINEL",
      );
    }

    // Expired OAuth logins only: nothing is staged for them.
    await write(
      path.join(home, ".pi", "agent", "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } }),
    );
    const expired = await stagePortableInputs(
      dataDir,
      "env-provider-expired",
      new Set(["pi"] as const),
      roots,
      now,
    );
    expect(await listFiles(expired.directory)).toEqual([
      "manifest.json",
      "pi-config/agent/settings.json",
    ]);
    expect(expired.providers[0]).toMatchObject({
      provider: "pi",
      files: 1,
      skipped: { "login-withheld": 1 },
    });
  });

  test("withheld non-UTF-8 logins do not leave negative byte totals", async () => {
    const { dataDir, roots, home } = await fixtureHome();
    await write(path.join(home, ".grok", "auth.json"), Buffer.from([0xff]));
    const staged = await stagePortableInputs(
      dataDir,
      "env-invalid-login",
      new Set(["grok"]),
      roots,
    );
    expect(staged.providers[0]).toEqual({
      provider: "grok",
      files: 0,
      bytes: 0,
      skipped: { "login-withheld": 1 },
    });
  });

  test("a symlinked ancestor below the home entry is never followed", async () => {
    const { dataDir, roots, home, root } = await fixtureHome();
    await write(path.join(root, "elsewhere", "secret.md"), "SENTINEL-ELSEWHERE");
    await fs.symlink(path.join(root, "elsewhere"), path.join(home, ".claude", "plugins"));
    const staged = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["claude"] as const),
      roots,
    );
    const files = await listFiles(staged.directory);
    expect(files.some((file) => file.startsWith("claude-config/plugins"))).toBe(false);
    expect(staged.providers[0]!.skipped.symlink).toBeGreaterThanOrEqual(2);
  });

  test("prunes only revisions no container binds", async () => {
    const { dataDir, roots } = await fixtureHome();
    const first = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["git"] as const),
      roots,
    );
    const second = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["git"] as const),
      roots,
    );
    const parent = environmentStateDirectory(dataDir, "portable-inputs", "env-inputs");
    await fs.mkdir(path.join(parent, ".r0-abcdef01.partial"));
    await fs.writeFile(path.join(parent, "unrelated.txt"), "keep");
    // Nothing is old enough yet: a staging or creation may still be using them.
    expect(await pruneInputRevisions(dataDir, "env-inputs", new Set([second.revision]))).toBe(0);
    const later = Date.now() + INPUT_REVISION_PRUNE_GRACE_MS + 1_000;
    expect(
      await pruneInputRevisions(dataDir, "env-inputs", new Set([second.revision]), later),
    ).toBe(2);
    expect((await fs.readdir(parent)).sort()).toEqual([second.revision, "unrelated.txt"].sort());
    expect(first.revision).not.toBe(second.revision);
  });
});

describe("provider selection", () => {
  test("stages enabled providers, narrowed to authorized ones in agent-test profiles", () => {
    expect([...selectedInputProviders({}, ["claude", "codex"])].sort()).toEqual([
      "claude",
      "codex",
      "git",
    ]);
    expect(
      [
        ...selectedInputProviders(
          { runtimeFlavor: "agent-test", credentialSources: new Set(["codex"]) },
          ["claude", "codex"],
        ),
      ].sort(),
    ).toEqual(["codex"]);
  });

  test("scrubbing a provider empties its staged inputs in place and leaves others", async () => {
    const { dataDir, roots } = await fixtureHome();
    const staged = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["claude", "git"] as const),
      roots,
    );
    const claudeMount = staged.mounts.find((mount) => mount.target === "/claude-config")!;
    const configFile = staged.mounts.find((mount) => mount.target === "/claude-config.json")!;
    const before = await fs.stat(configFile.source);
    expect(await scrubStagedProvider(dataDir, "env-inputs", staged.revision, "claude")).toBe(true);
    // The bound directory still exists (a bind mount keeps it) but is empty.
    expect(await fs.readdir(claudeMount.source)).toEqual([]);
    // A bound file keeps its inode, so the container sees it emptied.
    const after = await fs.stat(configFile.source);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(0);
    const git = staged.mounts.find((mount) => mount.target === "/tmp/gitconfig")!;
    expect((await fs.readFile(git.source, "utf8")).length).toBeGreaterThan(0);
    expect(await scrubStagedProvider(dataDir, "env-inputs", "r0-00000000", "claude")).toBe(false);
    expect(await scrubStagedProvider(dataDir, "env-inputs", "../escape", "claude")).toBe(false);
  });

  test("revocation is recorded, empties the staged inputs and gates later credential syncs", async () => {
    const { dataDir, roots } = await fixtureHome();
    const staged = await stagePortableInputs(
      dataDir,
      "env-lifecycle",
      new Set(["claude", "git"] as const),
      roots,
    );
    const { context, environments } = memoryLifecycleContext(
      [lifecycleEnvironment({ containerId: "container-1" })],
      dataDir,
    );
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) case "$*" in *Config.Env*) printf '[]\\n' ;; *) printf '${staged.revision}\\n' ;; esac ;;
esac
exit 0
`,
      async (log) => {
        const result = await revokeProviderCredentials("env-lifecycle", "claude", context);
        expect(result).toEqual({
          provider: "claude",
          removed: true,
          pendingRebuild: false,
          processesStopped: true,
        });
        const calls = await log.read();
        expect(calls).toContain("/home/node/.claude/.credentials.json");
        expect(calls).toContain("pkill -TERM -f '[/]opt/claude-bridge/'");
      },
    );
    expect(environments.get("env-lifecycle")?.revokedInputProviders).toEqual(["claude"]);
    const claudeMount = staged.mounts.find((mount) => mount.target === "/claude-config")!;
    expect(await fs.readdir(claudeMount.source)).toEqual([]);
    const environment = environments.get("env-lifecycle")!;
    expect(providerCredentialsAllowed({}, ["claude", "codex"], environment, "claude")).toBe(false);
    expect(providerCredentialsAllowed({}, ["claude", "codex"], environment, "codex")).toBe(true);
    expect([
      ...selectedInputProviders({}, ["claude", "codex"], environment.revokedInputProviders),
    ]).toEqual(["codex", "git"]);
    // Disabled is never allowed, revoked or not.
    expect(providerCredentialsAllowed({}, ["codex"], null, "claude")).toBe(false);
  });

  test("a revocation interrupted before the container answers is still in force", async () => {
    const { dataDir } = await fixtureHome();
    const { context, environments } = memoryLifecycleContext(
      [lifecycleEnvironment({ containerId: "container-1" })],
      dataDir,
    );
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
echo "Cannot connect to the Docker daemon" >&2
exit 1
`,
      async () => {
        const result = await revokeProviderCredentials("env-lifecycle", "claude", context);
        // Nothing could be confirmed in the container...
        expect(result.removed).toBe(false);
        expect(result.pendingRebuild).toBe(true);
      },
    );
    // ...but the revocation was recorded first, so nothing hands it back.
    const environment = environments.get("env-lifecycle")!;
    expect(environment.revokedInputProviders).toEqual(["claude"]);
    expect(providerCredentialsAllowed({}, ["claude"], environment, "claude")).toBe(false);
  });

  test("legacy immutable API keys require replacement after revocation", async () => {
    const { dataDir, roots } = await fixtureHome();
    const staged = await stagePortableInputs(
      dataDir,
      "env-lifecycle",
      new Set(["claude"] as const),
      roots,
    );
    const { context } = memoryLifecycleContext(
      [lifecycleEnvironment({ containerId: "container-1" })],
      dataDir,
    );
    await withDockerScript(
      `#!/bin/sh
case "$*" in
  *Config.Env*) printf '["ANTHROPIC_API_KEY=old-secret"]\\n' ;;
  *Config.Labels*) printf '${staged.revision}\\n' ;;
esac
exit 0
`,
      async () => {
        const result = await revokeProviderCredentials("env-lifecycle", "claude", context);
        expect(result.pendingRebuild).toBe(true);
      },
    );
    expect(await fs.readdir(path.join(staged.directory, "claude-config"))).toEqual([]);
  });

  test("revocation scrubs staged credentials bound by retained runtimes", async () => {
    const { dataDir, roots } = await fixtureHome();
    const current = await stagePortableInputs(
      dataDir,
      "env-lifecycle",
      new Set(["claude"] as const),
      roots,
    );
    const retained = await stagePortableInputs(
      dataDir,
      "env-lifecycle",
      new Set(["claude"] as const),
      roots,
    );
    const environment = lifecycleEnvironment({
      containerId: "current-container",
      containerLifecycle: {
        schemaVersion: 1,
        revision: 2,
        lastRuntimeGeneration: 2,
        runtime: { containerId: "current-container", runtimeGeneration: 2, owner: "owner" },
        storage: { format: "legacy-layer", workspaceGeneration: 1 },
        retainedRuntimes: [
          {
            containerId: "retained-container",
            runtimeGeneration: 1,
            owner: "owner",
            retainedAt: new Date().toISOString(),
            retainedReason: "migrate-source",
          },
        ],
        outcomes: [],
      },
    });
    const { context } = memoryLifecycleContext([environment], dataDir);
    await withDockerScript(
      `#!/bin/sh
case "$*" in
  *Config.Env*) printf '[]\\n' ;;
  *retained-container*) printf '${retained.revision}\\n' ;;
  *current-container*) printf '${current.revision}\\n' ;;
esac
`,
      async () => {
        await revokeProviderCredentials(environment.id, "claude", context);
      },
    );
    expect(await fs.readdir(path.join(current.directory, "claude-config"))).toEqual([]);
    expect(await fs.readdir(path.join(retained.directory, "claude-config"))).toEqual([]);
  });

  test("a staging interrupted by a restart is never read and a new one is independent", async () => {
    const { dataDir, roots } = await fixtureHome();
    const parent = environmentStateDirectory(dataDir, "portable-inputs", "env-inputs");
    await fs.mkdir(path.join(parent, ".r0-abcdef01.partial", "claude-config"), { recursive: true });
    await fs.writeFile(path.join(parent, ".r0-abcdef01.partial", "claude-config", "x"), "half");
    expect(await readInputsManifest(dataDir, "env-inputs", ".r0-abcdef01.partial")).toBeNull();
    expect(await readInputsManifest(dataDir, "env-inputs", "r0-abcdef01")).toBeNull();
    const staged = await stagePortableInputs(
      dataDir,
      "env-inputs",
      new Set(["claude", "git"] as const),
      roots,
    );
    expect(staged.revision).not.toBe("r0-abcdef01");
    expect(await readInputsManifest(dataDir, "env-inputs", staged.revision)).toMatchObject({
      revision: staged.revision,
    });
    // The abandoned partial goes once it is old enough, never the live one.
    const later = Date.now() + INPUT_REVISION_PRUNE_GRACE_MS + 1_000;
    expect(
      await pruneInputRevisions(dataDir, "env-inputs", new Set([staged.revision]), later),
    ).toBe(1);
    expect(await fs.readdir(parent)).toEqual([staged.revision]);
  });

  test("the allowlist mirrors every mount point the entrypoint reads", async () => {
    const entrypoint = await fs.readFile(
      path.join(import.meta.dir, "../../../docker/entrypoint.sh"),
      "utf8",
    );
    const spec = portableInputSpec({ home: "/h", agentTest: false });
    for (const provider of spec) {
      for (const directory of provider.directories) {
        expect(entrypoint).toContain(directory.target);
        for (const file of directory.files ?? []) {
          expect(entrypoint).toContain(path.basename(file));
        }
      }
      for (const file of provider.files) expect(entrypoint).toContain(file.target);
    }
    expect(entrypoint).toContain(
      `ORKESTRATOR_CAPABILITY staged-inputs=${IMAGE_CAPABILITIES["staged-inputs"]}`,
    );
    expect(IMAGE_CAPABILITIES["staged-inputs"]).toBeGreaterThanOrEqual(
      CURSOR_MCP_STAGED_INPUTS_VERSION,
    );
    expect(imageCopiesCursorMcpConfig({ "staged-inputs": 1 })).toBe(false);
    expect(imageCopiesCursorMcpConfig({ "staged-inputs": 2 })).toBe(true);
    expect(imageCopiesCursorMcpConfig(null)).toBe(false);
  });
});

/** A host ~/.cursor holding MCP servers beside state that must never be staged. */
async function cursorFixture() {
  const fixture = await fixtureHome();
  const cursor = path.join(fixture.home, ".cursor");
  await write(
    path.join(cursor, "mcp.json"),
    '{"mcpServers":{"docs":{"url":"https://example.test/mcp"}}}',
  );
  await write(path.join(cursor, "auth.json"), "SENTINEL-CURSOR-AUTH");
  await write(path.join(cursor, "cli-config.json"), "SENTINEL-CURSOR-CLI");
  await write(path.join(cursor, "sdk", "state.json"), "SENTINEL-CURSOR-SDK");
  await write(path.join(cursor, "hooks.json"), "SENTINEL-CURSOR-HOOKS");
  await write(path.join(cursor, "extensions", "e", "package.json"), "SENTINEL-CURSOR-EXT");
  return { ...fixture, cursor };
}

describe("Cursor MCP configuration", () => {
  test("stages only mcp.json from the host's ~/.cursor", async () => {
    const { dataDir, roots } = await cursorFixture();
    const staged = await stagePortableInputs(dataDir, "env-cursor", new Set(["cursor"]), roots);
    expect(await listFiles(staged.directory)).toEqual(["cursor-config/mcp.json", "manifest.json"]);
    expect(staged.mounts).toEqual([
      { source: path.join(staged.directory, "cursor-config"), target: "/cursor-config" },
    ]);
    const stagedMcp = path.join(staged.directory, "cursor-config", "mcp.json");
    expect(JSON.parse(await fs.readFile(stagedMcp, "utf8"))).toEqual({
      mcpServers: { docs: { url: "https://example.test/mcp" } },
    });
    expect((await fs.stat(stagedMcp)).mode & 0o077).toBe(0);
    expect(staged.providers).toEqual([
      {
        provider: "cursor",
        files: 1,
        bytes: (await fs.stat(stagedMcp)).size,
        skipped: {},
      },
    ]);
  });

  test("agent-test profiles read the isolated host home", async () => {
    const { dataDir, root, home } = await cursorFixture();
    const isolated = path.join(root, "isolated-home");
    await write(path.join(isolated, ".cursor", "mcp.json"), '{"mcpServers":{}}');
    const staged = await stagePortableInputs(dataDir, "env-cursor-test", new Set(["cursor"]), {
      home,
      agentTest: true,
      agentTestHostHome: isolated,
    });
    expect(
      await fs.readFile(path.join(staged.directory, "cursor-config", "mcp.json"), "utf8"),
    ).toBe('{"mcpServers":{}}');
  });

  test("refuses a symlinked mcp.json and one over the size bound", async () => {
    const { dataDir, roots, root, cursor } = await cursorFixture();
    await write(path.join(root, "elsewhere", "mcp.json"), "SENTINEL-LINKED");
    await fs.rm(path.join(cursor, "mcp.json"));
    await fs.symlink(path.join(root, "elsewhere", "mcp.json"), path.join(cursor, "mcp.json"));
    const linked = await stagePortableInputs(
      dataDir,
      "env-cursor-link",
      new Set(["cursor"]),
      roots,
    );
    expect(await listFiles(linked.directory)).toEqual(["manifest.json"]);
    expect(linked.mounts).toEqual([]);
    expect(linked.providers[0]).toEqual({
      provider: "cursor",
      files: 0,
      bytes: 0,
      skipped: { symlink: 1 },
    });

    await fs.rm(path.join(cursor, "mcp.json"));
    await write(path.join(cursor, "mcp.json"), Buffer.alloc(2048, 0x20));
    const large = await stagePortableInputs(
      dataDir,
      "env-cursor-large",
      new Set(["cursor"]),
      roots,
      new Date(),
      { ...INPUT_LIMITS, fileBytes: 1024 },
    );
    expect(await listFiles(large.directory)).toEqual(["manifest.json"]);
    expect(large.providers[0]?.skipped).toEqual({ "too-large": 1 });
  });

  test("nothing of Cursor's is staged when Cursor is not selected", async () => {
    const { dataDir, roots } = await cursorFixture();
    const staged = await stagePortableInputs(
      dataDir,
      "env-no-cursor",
      new Set(["claude", "git"] as const),
      roots,
    );
    expect((await listFiles(staged.directory)).some((file) => file.startsWith("cursor"))).toBe(
      false,
    );
    expect(staged.mounts.some((mount) => mount.target === "/cursor-config")).toBe(false);
    expect(staged.providers.some((entry) => entry.provider === "cursor")).toBe(false);
    // Disabled, revoked, or unauthorized in an agent-test profile: never selected.
    expect(selectedInputProviders({}, ["claude"]).has("cursor")).toBe(false);
    expect(selectedInputProviders({}, ["claude", "cursor"], ["cursor"]).has("cursor")).toBe(false);
    expect(
      selectedInputProviders({ runtimeFlavor: "agent-test", credentialSources: new Set() }, [
        "cursor",
      ]).has("cursor"),
    ).toBe(false);
    expect(selectedInputProviders({}, ["cursor"]).has("cursor")).toBe(true);
  });

  test("revocation scrubs the staged mcp.json", async () => {
    const { dataDir, roots } = await cursorFixture();
    const staged = await stagePortableInputs(dataDir, "env-cursor", new Set(["cursor"]), roots);
    expect(await scrubStagedProvider(dataDir, "env-cursor", staged.revision, "cursor")).toBe(true);
    expect(await fs.readdir(path.join(staged.directory, "cursor-config"))).toEqual([]);
  });

  test("the entrypoint copies the staged mcp.json owner-only and refuses a symlinked one", async () => {
    const { dataDir, roots, root, cursor } = await cursorFixture();
    const staged = await stagePortableInputs(dataDir, "env-cursor", new Set(["cursor"]), roots);
    const mount = staged.mounts.find((entry) => entry.target === "/cursor-config")!;
    const entrypoint = await fs.readFile(
      path.join(import.meta.dir, "../../../docker/entrypoint.sh"),
      "utf8",
    );
    const helpers = [
      "log_progress",
      "agent_copy_warn",
      "report_agent_copy_skips",
      "agent_source_path_has_symlink",
      "agent_destination_path_has_symlink",
      "copy_agent_file",
    ]
      .map((name) => {
        const body = entrypoint.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0];
        if (!body) throw new Error(`Missing entrypoint helper: ${name}`);
        return body;
      })
      .join("\n");
    const block = entrypoint.match(
      /^# Set up Cursor configuration\.[\s\S]*?^log_progress "Cursor configuration ready"$/m,
    )?.[0];
    if (!block) throw new Error("Missing Cursor entrypoint setup");
    const run = async (source: string, home: string) => {
      const progress = path.join(root, `progress-${path.basename(home)}`);
      const result = Bun.spawnSync({
        cmd: [
          "bash",
          "-c",
          `set -e\nAGENT_COPY_SKIPPED=""\n${helpers}\n${block.replaceAll("/cursor-config", '"$TEST_SOURCE"')}`,
        ],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          PROGRESS_FILE: progress,
          TEST_SOURCE: source,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      return fs.readFile(progress, "utf8");
    };

    const home = path.join(root, "container-home");
    await run(mount.source, home);
    expect((await fs.readdir(path.join(home, ".cursor"))).sort()).toEqual(["mcp.json"]);
    const copied = path.join(home, ".cursor", "mcp.json");
    expect(await fs.readFile(copied, "utf8")).toBe(
      await fs.readFile(path.join(cursor, "mcp.json"), "utf8"),
    );
    expect((await fs.stat(copied)).mode & 0o777).toBe(0o600);

    // A source swapped for a link (the mount is read-only in production, but
    // the helper never trusts it) is reported and not followed.
    const linkedSource = path.join(root, "linked-source");
    await fs.mkdir(linkedSource);
    await fs.symlink(path.join(cursor, "auth.json"), path.join(linkedSource, "mcp.json"));
    const linkedHome = path.join(root, "linked-home");
    const progress = await run(linkedSource, linkedHome);
    expect(await fs.readdir(path.join(linkedHome, ".cursor"))).toEqual([]);
    expect(progress).toContain("Cursor host config NOT copied into this container: mcp.json");
  });
});
