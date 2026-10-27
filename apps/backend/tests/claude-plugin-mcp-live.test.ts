/**
 * Claude plugin MCP servers: the MCP editor's plugin rows, the live rows a
 * real session reports and the settings page's join between them agree, on
 * the pinned Claude CLI with no credentials (no prompt is sent).
 *
 * Opt-in: RUN_LIVE_CLAUDE_PLUGIN_MCP=1, or `mise run verify:claude:plugin-mcp-live`.
 * The CLI comes from the Claude bridge's pinned SDK (or CLAUDE_CLI_PATH).
 *
 * Fixture plugins with one stdio server each are installed in a disposable
 * home and project. The bridge's own probe (`plugin-mcp.live-probe.ts`)
 * resolves the plugin set exactly as a turn does and starts the CLI with it;
 * the editor's catalogue reads the same files. Installs are passed only when
 * Claude Code's own `enabledPlugins` enables their `<name>@<marketplace>` id
 * (todo 0151), so turning one off in Claude Code turns it off here too.
 * Nothing reads or writes the operator's Claude configuration.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { cpSync } from "node:fs";

import type { McpManagementSnapshot } from "@orkestrator/protocol/mcp-management";

import { joinLiveMcpServer } from "../../web/src/components/settings/mcp-servers/mcp-live-join";
import { createFixture, targetIdFor, type Fixture } from "../src/core/mcp-management/test-support";

const ENABLED = process.env.RUN_LIVE_CLAUDE_PLUGIN_MCP === "1";
const BRIDGE = path.resolve(import.meta.dir, "../../../bridges/claude-bridge");
const PROBE = path.join(BRIDGE, "src/services/plugin-mcp.live-probe.ts");
const SERVER = path.join(BRIDGE, "src/services/session-manager-prompt-mcp-sync.live-fixture.ts");
const SENTINEL = "__CLAUDE_PLUGIN_MCP_RESULT__";

interface LiveServer {
  name: string;
  status: string;
  scope: "user" | "project" | "local" | "orkestrator" | "plugin";
  args?: string[];
}

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture({ env: {} });
});

afterEach(async () => {
  await fixture.cleanup();
});

const server = (label: string) => ({
  command: process.execPath,
  args: [SERVER, label, "1"],
  env: { ROOT: "${CLAUDE_PLUGIN_ROOT}" },
});

function json(relative: string, value: unknown): void {
  fixture.write(relative, JSON.stringify(value));
}

/**
 * Installed plugins, recorded with another machine's paths as the CLI writes
 * them, and plugins listed in `~/.claude.json` and the project. No marketplace
 * is known, so the CLI never loads an install of its own here: every plugin
 * that loads is one the bridge passed.
 */
function installFixture(): void {
  // The CLI's own configuration file, so it starts without onboarding.
  json("home/.claude/.claude.json", { hasCompletedOnboarding: true });
  const installed: Record<string, unknown[]> = {};
  const install = (name: string, manifest: Record<string, unknown>, mcpJson?: unknown) => {
    const relative = `.claude/plugins/cache/market/${name}/1.0.0`;
    json(`home/${relative}/.claude-plugin/plugin.json`, { name, ...manifest });
    if (mcpJson !== undefined) json(`home/${relative}/.mcp.json`, mcpJson);
    installed[`${name}@market`] = [
      { scope: "user", installPath: `/Users/someone/${relative}`, version: "1.0.0" },
    ];
  };
  install("alpha", {}, { mcpServers: { one: server("alpha") } });
  install("gamma", {}, { mcpServers: { one: server("gamma") } });
  install("iota", {}, { mcpServers: { one: server("iota") } });
  install("kappa", {}, { mcpServers: { one: server("kappa") } });
  install("lambda", {}, { mcpServers: { one: server("lambda") } });
  install(
    "epsilon",
    {
      mcpServers: {
        one: { ...server("epsilon-manifest") },
        two: server("epsilon-two"),
      },
    },
    { mcpServers: { one: server("epsilon-mcp-json") } },
  );
  json("home/.claude/plugins/installed_plugins.json", { version: 2, plugins: installed });
  // The global and project plugin lists the bridge also reads. Only the
  // `@inline` id applies to these: they have no install.
  const listed = (name: string, manifest: Record<string, unknown> | null, mcpJson: unknown) => {
    if (manifest) json(`home/listed/${name}/.claude-plugin/plugin.json`, { name, ...manifest });
    json(`home/listed/${name}/.mcp.json`, mcpJson);
    return { type: "local", path: `~/listed/${name}` };
  };
  json("home/.claude.json", {
    plugins: [
      listed("omega", null, { one: server("omega") }),
      listed("beta", {}, { mcpServers: { one: server("beta") } }),
      listed("delta", { defaultEnabled: false }, { mcpServers: { one: server("delta") } }),
      listed("zeta", {}, { one: server("zeta") }),
      listed("eta", {}, { mcpServers: { one: server("eta") } }),
    ],
  });
  json("worktree/.claude/plugins.json", { plugins: [{ type: "local", path: "./tools/theta" }] });
  json("worktree/tools/theta/.mcp.json", { mcpServers: { one: server("theta") } });
  // enabledPlugins in each settings layer. `claude plugin install` writes
  // `true` under the install's id; `claude plugin disable` writes `false`.
  json("home/.claude/settings.json", {
    enabledPlugins: {
      "alpha@market": true,
      "epsilon@market": true,
      "gamma@market": false,
      "iota@market": true,
      "kappa@market": true,
      // lambda@market is installed but enabled nowhere.
      "ZETA@Inline": false,
    },
  });
  json("worktree/.claude/settings.json", {
    enabledPlugins: { "beta@inline": false, "iota@market": false },
  });
  json("worktree/.claude/settings.local.json", {
    enabledPlugins: { "eta@inline": false, "kappa@market": false },
  });
}

async function runCli(settingSources: string[]): Promise<LiveServer[]> {
  return (await runProbe(settingSources)).servers;
}

/** The plugin folders the bridge passed, and the servers the CLI loaded. */
async function runProbe(
  settingSources: string[],
): Promise<{ plugins: string[]; servers: LiveServer[] }> {
  const probe = Bun.spawn(
    [
      process.execPath,
      PROBE,
      JSON.stringify({ home: fixture.home, cwd: fixture.worktree, settingSources }),
    ],
    { cwd: BRIDGE, env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  const deadline = setTimeout(() => probe.kill(), 60_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const line = stdout.split("\n").find((candidate) => candidate.startsWith(SENTINEL));
    if (!line) throw new Error(`no ${SENTINEL} line:\n${stdout}\n${stderr}`);
    return JSON.parse(line.slice(SENTINEL.length)) as { plugins: string[]; servers: LiveServer[] };
  } finally {
    clearTimeout(deadline);
    if (probe.exitCode === null) probe.kill();
  }
}

async function editor(projectResources: boolean): Promise<McpManagementSnapshot> {
  fixture.environment.agentSettings = { executionPolicy: { projectResources } };
  return fixture.service.snapshot({
    targetId: await targetIdFor(fixture, "claude", "environment"),
  });
}

/** Plugin servers the editor says the session loads: the winning, effective row per name. */
function editorLoaded(snapshot: McpManagementSnapshot): string[] {
  return snapshot.definitions
    .filter(
      (row) =>
        row.name.startsWith("plugin:") &&
        row.status === "effective" &&
        snapshot.effective[row.name] === row.entryId,
    )
    .map((row) => row.name)
    .sort();
}

function liveLoaded(servers: LiveServer[]): string[] {
  return servers
    .filter((entry) => entry.name.startsWith("plugin:") && entry.status !== "disabled")
    .map((entry) => entry.name)
    .sort();
}

/** Every live plugin row joins to exactly the editor's winning row for it. */
function expectJoins(snapshot: McpManagementSnapshot, servers: LiveServer[]): void {
  for (const live of servers.filter((entry) => entry.name.startsWith("plugin:"))) {
    expect(live.scope).toBe("plugin");
    const join = joinLiveMcpServer(snapshot, {
      provider: "claude",
      environmentId: "env-1",
      serverName: live.name,
      scope: live.scope,
    });
    expect(join).toMatchObject({ kind: "plugin", entryId: snapshot.effective[live.name] });
  }
}

describe.skipIf(!ENABLED)("Claude plugin MCP servers on the pinned CLI", () => {
  test("the CLI loads the installed marketplace copy when the inline copy is disabled", async () => {
    json("home/.claude/.claude.json", { hasCompletedOnboarding: true });
    const relative = ".claude/plugins/cache/fixture-market/installed/1.0.0";
    const installPath = path.join(fixture.home, relative);
    json(`home/${relative}/.claude-plugin/plugin.json`, { name: "installed", version: "1.0.0" });
    json(`home/${relative}/.mcp.json`, { mcpServers: { one: server("installed-marketplace") } });
    json("home/.claude/plugins/installed_plugins.json", {
      version: 2,
      plugins: {
        "installed@fixture-market": [
          {
            scope: "user",
            installPath,
            version: "1.0.0",
            installedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
          },
        ],
      },
    });
    json("home/marketplace/.claude-plugin/marketplace.json", {
      name: "fixture-market",
      owner: { name: "Fixture" },
      plugins: [{ name: "installed", source: "./installed", version: "1.0.0" }],
    });
    cpSync(installPath, path.join(fixture.home, "marketplace/installed"), { recursive: true });
    json("home/.claude/plugins/known_marketplaces.json", {
      "fixture-market": {
        source: { source: "directory", path: path.join(fixture.home, "marketplace") },
        installLocation: path.join(fixture.home, "marketplace"),
        lastUpdated: new Date().toISOString(),
      },
    });
    json("home/.claude/settings.json", {
      enabledPlugins: { "installed@inline": false, "installed@fixture-market": true },
    });
    const snapshot = await editor(false);
    expect(editorLoaded(snapshot)).toEqual(["plugin:installed:one"]);
    expect(snapshot.sources.find((source) => source.label === "Plugin installed")!.note).toContain(
      'enabled by enabledPlugins["installed@fixture-market"]',
    );
    const live = await runCli(["user"]);
    expect(liveLoaded(live)).toEqual(editorLoaded(snapshot));
    expect(live.find((entry) => entry.name === "plugin:installed:one")?.args).toContain(
      "installed-marketplace",
    );
    expectJoins(snapshot, live);

    // A negative control proves the installed layer, rather than inline
    // enablement, supplied that live server.
    json("home/.claude/settings.json", {
      enabledPlugins: { "installed@inline": false, "installed@fixture-market": false },
    });
    expect(editorLoaded(await editor(false))).toEqual([]);
    expect(liveLoaded(await runCli(["user"]))).toEqual([]);

    // Turned off in Claude Code alone (`claude plugin disable` writes only
    // the marketplace id): the bridge no longer passes it, the CLI's own copy
    // is off too, and the editor's row says why.
    json("home/.claude/settings.json", {
      enabledPlugins: { "installed@fixture-market": false },
    });
    const off = await editor(false);
    expect(editorLoaded(off)).toEqual([]);
    expect(off.definitions.find((row) => row.name === "plugin:installed:one")).toMatchObject({
      status: "disabled",
      statusReason:
        'Disabled: enabledPlugins["installed@fixture-market"] is false in ~/.claude/settings.json, so Orkestrator does not pass this installed plugin to Claude Code.',
    });
    const probe = await runProbe(["user"]);
    expect(probe.plugins).toEqual([]);
    expect(liveLoaded(probe.servers)).toEqual([]);
  }, 120_000);

  test("the editor's rows, the live rows and the join agree", async () => {
    installFixture();

    // Project resources on: sessions load user and project settings.
    const withProject = await editor(true);
    const live = await runCli(["user", "project"]);
    expect(liveLoaded(live)).toEqual([
      "plugin:alpha:one",
      "plugin:epsilon:one",
      "plugin:epsilon:two",
      "plugin:eta:one",
      // Installs turned off in Claude Code (gamma, iota in project settings)
      // or never enabled (lambda) are not passed, so they do not load.
      "plugin:kappa:one",
      "plugin:omega:one",
      "plugin:theta:one",
    ]);
    expect(editorLoaded(withProject)).toEqual(liveLoaded(live));
    expectJoins(withProject, live);
    // The manifest's server replaces the same name in .mcp.json, in both.
    expect(live.find((entry) => entry.name === "plugin:epsilon:one")?.args).toContain(
      "epsilon-manifest",
    );
    const epsilon = withProject.definitions.find(
      (row) => row.entryId === withProject.effective["plugin:epsilon:one"],
    )!;
    expect(withProject.sources.find((source) => source.sourceId === epsilon.sourceId)?.label).toBe(
      "Plugin epsilon (plugin.json)",
    );
    // The disabled plugins are shown disabled, naming the setting.
    const reason = (name: string) =>
      withProject.definitions.find((row) => row.name === name)?.statusReason;
    expect(reason("plugin:beta:one")).toContain('enabledPlugins["beta@inline"]');
    expect(reason("plugin:zeta:one")).toContain('enabledPlugins["ZETA@Inline"]');
    expect(reason("plugin:delta:one")).toContain("defaultEnabled");
    expect(reason("plugin:gamma:one")).toBe(
      'Disabled: enabledPlugins["gamma@market"] is false in ~/.claude/settings.json, so Orkestrator does not pass this installed plugin to Claude Code.',
    );
    expect(reason("plugin:iota:one")).toBe(
      'Disabled: enabledPlugins["iota@market"] is false in <worktree>/.claude/settings.json, so Orkestrator does not pass this installed plugin to Claude Code.',
    );
    expect(reason("plugin:lambda:one")).toContain(
      'no settings file these sessions load sets enabledPlugins["lambda@market"] to true',
    );
    // Shown as written: the editor never expands the plugin root.
    const alpha = await fixture.service.getDefinition({
      targetId: withProject.target.targetId,
      entryId: withProject.effective["plugin:alpha:one"]!,
    });
    expect(alpha.env).toEqual([
      { key: "ROOT", presence: "reference", reference: "${CLAUDE_PLUGIN_ROOT}" },
    ]);

    // "Include local settings": local settings turn eta and kappa off, as the
    // editor's notes say.
    const withLocal = await runCli(["user", "project", "local"]);
    expect(liveLoaded(withLocal)).toEqual(
      liveLoaded(live).filter((name) => name !== "plugin:eta:one" && name !== "plugin:kappa:one"),
    );
    const note = (label: string) =>
      withProject.sources.find((source) => source.label === label)?.note;
    expect(note("Plugin eta")).toContain('"Include local settings" on do not load this plugin');
    expect(note("Plugin kappa")).toContain(
      '"Include local settings" on do not load this plugin: enabledPlugins["kappa@market"]',
    );

    // Project resources off (the host default): no project plugin list or settings.
    const userOnly = await editor(false);
    const liveUser = await runCli(["user"]);
    expect(liveLoaded(liveUser)).toEqual([
      "plugin:alpha:one",
      "plugin:beta:one",
      "plugin:epsilon:one",
      "plugin:epsilon:two",
      "plugin:eta:one",
      // Project settings turn iota off; without them user settings enable it.
      "plugin:iota:one",
      "plugin:kappa:one",
      "plugin:omega:one",
    ]);
    expect(editorLoaded(userOnly)).toEqual(liveLoaded(liveUser));
    expectJoins(userOnly, liveUser);
  }, 180_000);
});
