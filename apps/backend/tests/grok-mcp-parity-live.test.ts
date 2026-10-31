/**
 * The MCP editor's Grok rows against the real pinned Grok, with no
 * credentials (no model is called, nothing signs in).
 *
 * Opt-in: RUN_LIVE_GROK_MCP=1, with the pinned binary installed by the
 * toolchain (or GROK_CLI_PATH pointing at one):
 *
 *   mise run verify:grok:mcp-live
 *
 * Each case writes fixture files into a throwaway HOME, GROK_HOME, XDG
 * directories and git repository, then compares what Grok reports with what
 * the catalogue concludes from the same files:
 *
 * - folder trust: `grok inspect --json` `projectTrusted` against
 *   `grokFolderTrust`;
 * - the trust gate itself: `grok mcp doctor --json` refuses to start the
 *   project-bound sources of an untrusted folder, which the catalogue must not
 *   report as `allowed`;
 * - sources and precedence: the server `grok inspect` keeps for a name defined
 *   in several files is the catalogue's effective row;
 * - the `[compat.*] mcps` switches: `externalCompat` against `grokCompat`;
 * - saved enable: servers `grok mcp list` reports off are the catalogue's
 *   disabled rows.
 *
 * `/etc/grok` cannot be written without root, so the system managed and
 * requirements files are not exercised; their order comes from Grok's own
 * configuration reference. Fixture servers name commands that do not exist,
 * so `doctor` never starts a process.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { PINNED_TOOLCHAIN_VERSIONS } from "../../../packages/toolchain/src/manifest";
import { loadCatalog, summarizeEntries } from "../src/core/mcp-management/catalog";
import {
  grokCompat,
  grokFolderTrust,
  readHostText,
} from "../src/core/mcp-management/native-policy";
import {
  providerCapabilities,
  providerSources,
  resolveProviderHomes,
} from "../src/core/mcp-management/providers";
import { McpSourceStore } from "../src/core/mcp-management/source-store";

const ENABLED = process.env.RUN_LIVE_GROK_MCP === "1";

function pinnedBinary(): string {
  if (process.env.GROK_CLI_PATH) return process.env.GROK_CLI_PATH;
  const platform = `${process.platform}-${process.arch}`;
  const dataDir =
    process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support", "orkestrator-v2")
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "orkestrator-v2");
  return path.join(dataDir, "toolchains", "grok", PINNED_TOOLCHAIN_VERSIONS.grok, platform, "grok");
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A throwaway home, Grok home and git repository. */
class Sandbox {
  readonly root = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-mcp-parity-")));
  readonly home = path.join(this.root, "home");
  readonly grokHome = path.join(this.home, ".grok");
  readonly systemDir = path.join(this.root, "no-etc-grok");
  readonly repo = path.join(this.root, "repo");
  env: Record<string, string> = {};

  constructor() {
    roots.push(this.root);
    mkdirSync(this.grokHome, { recursive: true });
    this.git(this.root, "init", "-q", this.repo);
  }

  git(cwd: string, ...args: string[]): void {
    const result = spawnSync("git", args, {
      cwd,
      env: { ...this.processEnv(), GIT_CONFIG_NOSYSTEM: "1" },
      encoding: "utf8",
    });
    expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  }

  write(file: string, content: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  trust(folder: string, body = `trusted = true\n`): void {
    this.write(path.join(this.grokHome, "trusted_folders.toml"), `[folders."${folder}"]\n${body}`);
  }

  processEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: this.home,
      GROK_HOME: this.grokHome,
      XDG_CONFIG_HOME: path.join(this.home, ".config"),
      XDG_DATA_HOME: path.join(this.home, ".local", "share"),
      XDG_STATE_HOME: path.join(this.home, ".local", "state"),
      XDG_CACHE_HOME: path.join(this.home, ".cache"),
      ...this.env,
    };
  }

  grok(cwd: string, ...args: string[]): any {
    const result = spawnSync(pinnedBinary(), [...args, "--json"], {
      cwd,
      env: this.processEnv(),
      encoding: "utf8",
      timeout: 90_000,
    });
    // `mcp doctor` exits 1 when a server is unhealthy, which every fixture is.
    expect(result.error, `grok ${args.join(" ")}`).toBeUndefined();
    expect(
      result.stdout.trim().startsWith("{") || result.stdout.trim().startsWith("["),
      `grok ${args.join(" ")}: ${result.stderr}`,
    ).toBe(true);
    return JSON.parse(result.stdout);
  }

  homes() {
    return {
      ...resolveProviderHomes(this.processEnv(), this.home),
      grokSystemDir: this.systemDir,
    };
  }

  async catalog(worktree: string) {
    const specs = await providerSources("grok", {
      context: { kind: "environment", location: "local-worktree", worktreePath: worktree },
      homes: this.homes(),
      exists: async (file: string) => existsSync(file),
    });
    const store = new McpSourceStore({ keyFile: path.join(this.root, "data", "revision.key") });
    const catalog = await loadCatalog(store, specs);
    return { specs, ...summarizeEntries(catalog, providerCapabilities("grok")) };
  }

  async folderTrust(worktree: string) {
    const homes = this.homes();
    return grokFolderTrust(
      { grokHome: this.grokHome, systemDir: this.systemDir, env: homes.grokEnv ?? {} },
      worktree,
      readHostText,
    );
  }
}

const SERVER = (name: string, command: string) =>
  `[mcp_servers.${name}]\ncommand = "/nonexistent/${command}"\n`;
const JSON_SERVER = (name: string, command: string) =>
  JSON.stringify({ mcpServers: { [name]: { command: `/nonexistent/${command}` } } });

describe.skipIf(!ENABLED)(`Grok ${PINNED_TOOLCHAIN_VERSIONS.grok} MCP rules`, () => {
  test("the pinned binary is installed", () => {
    const binary = pinnedBinary();
    expect(existsSync(binary), `pinned Grok binary at ${binary}`).toBe(true);
    const version = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      env: new Sandbox().processEnv(),
    });
    expect(version.stdout).toContain(PINNED_TOOLCHAIN_VERSIONS.grok);
  });

  // Each case arranges the store (and anything else) and names the folder the
  // session runs in. Grok's verdict and the catalogue's must agree.
  const trustCases: Array<[string, (box: Sandbox) => string]> = [
    ["no decision", (box) => box.repo],
    ["the repository root", (box) => (box.trust(box.repo), box.repo)],
    ["a trailing slash on the key", (box) => (box.trust(`${box.repo}/`), box.repo)],
    ["a declined repository", (box) => (box.trust(box.repo, "trusted = false\n"), box.repo)],
    [
      "a bare boolean value",
      (box) => {
        box.write(
          path.join(box.grokHome, "trusted_folders.toml"),
          `[folders]\n"${box.repo}" = true\n`,
        );
        return box.repo;
      },
    ],
    [
      "an array of tables",
      (box) => {
        box.write(
          path.join(box.grokHome, "trusted_folders.toml"),
          `[[folders]]\npath = "${box.repo}"\ntrusted = true\n`,
        );
        return box.repo;
      },
    ],
    ["a string verdict", (box) => (box.trust(box.repo, `trusted = "trusted"\n`), box.repo)],
    [
      "a key spelled through a symlink",
      (box) => {
        const link = path.join(box.root, "link");
        symlinkSync(box.repo, link);
        box.trust(link);
        return box.repo;
      },
    ],
    [
      "a grant on a non-git parent",
      (box) => {
        const nested = path.join(box.root, "parent", "nested");
        box.git(box.root, "init", "-q", nested);
        box.trust(path.join(box.root, "parent"));
        return nested;
      },
    ],
    [
      "a grant on an enclosing repository",
      (box) => {
        const inner = path.join(box.repo, "inner");
        box.git(box.root, "init", "-q", inner);
        box.trust(box.repo);
        return inner;
      },
    ],
    ...(["main", "self"] as const).map((grant): [string, (box: Sandbox) => string] => [
      `a linked worktree with a grant on ${grant === "main" ? "its main checkout" : "itself"}`,
      (box) => {
        const worktree = path.join(box.root, "wt");
        box.git(
          box.repo,
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "i",
        );
        box.git(box.repo, "worktree", "add", "-q", worktree, "-b", "wt");
        box.trust(grant === "main" ? box.repo : worktree);
        return worktree;
      },
    ]),
    [
      "GROK_FOLDER_TRUST=0",
      (box) => {
        box.env.GROK_FOLDER_TRUST = "0";
        return box.repo;
      },
    ],
    [
      "[folder_trust] enabled = false",
      (box) => {
        box.write(path.join(box.grokHome, "config.toml"), `[folder_trust]\nenabled = false\n`);
        return box.repo;
      },
    ],
  ];

  for (const [name, arrange] of trustCases) {
    test(`folder trust: ${name}`, async () => {
      const box = new Sandbox();
      const folder = arrange(box);
      // Grok reports a folder with nothing to hold back as trusted.
      box.write(path.join(folder, ".grok", "config.toml"), SERVER("project", "project"));
      const grok = box.grok(folder, "inspect").projectTrusted as boolean;
      const verdict = await box.folderTrust(folder);
      expect({ name, allowed: verdict.trust === "allowed" }).toEqual({ name, allowed: grok });
    });
  }

  test("an untrusted folder starts none of its project-bound servers", async () => {
    const box = new Sandbox();
    box.write(path.join(box.repo, ".grok", "config.toml"), SERVER("native", "native"));
    box.write(path.join(box.repo, ".mcp.json"), JSON_SERVER("mcpjson", "mcpjson"));
    box.write(path.join(box.repo, ".cursor", "mcp.json"), JSON_SERVER("cursorproj", "cursorproj"));
    box.write(
      path.join(box.home, ".claude.json"),
      JSON.stringify({ projects: { [box.repo]: JSON.parse(JSON_SERVER("claudelocal", "cl")) } }),
    );
    box.write(path.join(box.grokHome, "config.toml"), SERVER("usersrv", "user"));
    const doctor = box.grok(box.repo, "mcp", "doctor");
    const held = new Set(
      (doctor.servers as Array<{ name: string; checks: Array<{ label: string; passed: boolean }> }>)
        .filter((server) => server.checks.some((check) => check.label === "folder untrusted"))
        .map((server) => server.name),
    );
    expect([...held].sort()).toEqual(["claudelocal", "cursorproj", "mcpjson", "native"]);

    const { specs } = await box.catalog(box.repo);
    const gated = specs.filter((spec) =>
      [
        "grok:project",
        "grok:compat-project-mcp-json",
        "grok:compat-cursor-project",
        "grok:compat-claude-local",
      ].includes(spec.sourceId),
    );
    expect(gated).toHaveLength(4);
    for (const spec of gated)
      expect({ id: spec.sourceId, trust: spec.trust }).not.toEqual({
        id: spec.sourceId,
        trust: "allowed",
      });
    expect(specs.find((spec) => spec.sourceId === "grok:user")?.trust).toBeUndefined();

    // Declined, the catalogue excludes every one of them.
    box.trust(box.repo, "trusted = false\n");
    for (const spec of (await box.catalog(box.repo)).specs) {
      if (gated.some((gate) => gate.sourceId === spec.sourceId))
        expect(spec.trust).toBe("excluded");
    }
  });

  // Every file defines `dup` with a command naming the file; Grok's kept
  // definition must be the catalogue's effective one.
  const precedenceCases: Array<
    [string, Array<[(box: Sandbox) => string, string, "toml" | "json"]>]
  > = [
    [
      "project over user",
      [
        [(b) => path.join(b.grokHome, "config.toml"), "user", "toml"],
        [(b) => path.join(b.repo, ".grok", "config.toml"), "project", "toml"],
      ],
    ],
    [
      "user over managed",
      [
        [(b) => path.join(b.grokHome, "managed_config.toml"), "managed", "toml"],
        [(b) => path.join(b.grokHome, "config.toml"), "user", "toml"],
      ],
    ],
    [
      "requirements over user and project",
      [
        [(b) => path.join(b.grokHome, "config.toml"), "user", "toml"],
        [(b) => path.join(b.repo, ".grok", "config.toml"), "project", "toml"],
        [(b) => path.join(b.grokHome, "requirements.toml"), "req", "toml"],
      ],
    ],
    [
      "user over Claude",
      [
        [(b) => path.join(b.home, ".claude.json"), "claude", "json"],
        [(b) => path.join(b.grokHome, "config.toml"), "user", "toml"],
      ],
    ],
    [
      "Claude over Cursor",
      [
        [(b) => path.join(b.home, ".cursor", "mcp.json"), "cursoruser", "json"],
        [(b) => path.join(b.home, ".claude.json"), "claude", "json"],
      ],
    ],
    [
      "Cursor project over Cursor user",
      [
        [(b) => path.join(b.home, ".cursor", "mcp.json"), "cursoruser", "json"],
        [(b) => path.join(b.repo, ".cursor", "mcp.json"), "cursorproj", "json"],
      ],
    ],
    [
      "Cursor project over .mcp.json",
      [
        [(b) => path.join(b.repo, ".mcp.json"), "mcpjson", "json"],
        [(b) => path.join(b.repo, ".cursor", "mcp.json"), "cursorproj", "json"],
      ],
    ],
  ];

  for (const [name, files] of precedenceCases) {
    test(`precedence: ${name}`, async () => {
      const box = new Sandbox();
      box.trust(box.repo);
      for (const [file, command, format] of files) {
        box.write(
          file(box),
          format === "toml" ? SERVER("dup", command) : JSON_SERVER("dup", command),
        );
      }
      const kept = (
        box.grok(box.repo, "inspect").mcpServers as Array<{ name: string; target: string }>
      )
        .filter((server) => server.name === "dup")
        .map((server) => server.target);
      const { definitions, effective } = await box.catalog(box.repo);
      const winner = definitions.find((row) => row.entryId === effective.dup);
      const command = winner?.command?.kind === "visible" ? winner.command.value : undefined;
      expect(kept).toEqual([command ?? "<none>"]);
    });
  }

  test("precedence: Claude's private entry over its user entry", async () => {
    const box = new Sandbox();
    box.trust(box.repo);
    box.write(
      path.join(box.home, ".claude.json"),
      JSON.stringify({
        mcpServers: { dup: { command: "/nonexistent/claudeuser" } },
        projects: { [box.repo]: { mcpServers: { dup: { command: "/nonexistent/claudelocal" } } } },
      }),
    );
    const kept = (
      box.grok(box.repo, "inspect").mcpServers as Array<{ name: string; target: string }>
    )
      .filter((server) => server.name === "dup")
      .map((server) => server.target);
    const { definitions, effective } = await box.catalog(box.repo);
    const winner = definitions.find((row) => row.entryId === effective.dup);
    expect(kept).toEqual([winner?.command?.kind === "visible" ? winner.command.value : "<none>"]);
  });

  const compatCases: Array<[string, (box: Sandbox) => void]> = [
    ["defaults", () => {}],
    [
      "config.toml off",
      (b) =>
        b.write(
          path.join(b.grokHome, "config.toml"),
          `[compat.claude]\nmcps = false\n[compat.cursor]\nmcps = false\n`,
        ),
    ],
    [
      "managed off, config.toml on",
      (b) => {
        b.write(path.join(b.grokHome, "config.toml"), `[compat.claude]\nmcps = true\n`);
        b.write(path.join(b.grokHome, "managed_config.toml"), `[compat.claude]\nmcps = false\n`);
      },
    ],
    [
      "requirements off, config.toml on",
      (b) => {
        b.write(path.join(b.grokHome, "config.toml"), `[compat.cursor]\nmcps = true\n`);
        b.write(path.join(b.grokHome, "requirements.toml"), `[compat.cursor]\nmcps = false\n`);
      },
    ],
    [
      "environment on over config.toml off",
      (b) => {
        b.write(path.join(b.grokHome, "config.toml"), `[compat.claude]\nmcps = false\n`);
        b.env.GROK_CLAUDE_MCPS_ENABLED = "1";
        b.env.GROK_CURSOR_MCPS_ENABLED = "0";
      },
    ],
    [
      "the project file is ignored",
      (b) => b.write(path.join(b.repo, ".grok", "config.toml"), `[compat.claude]\nmcps = false\n`),
    ],
  ];

  for (const [name, arrange] of compatCases) {
    test(`compatibility switches: ${name}`, async () => {
      const box = new Sandbox();
      box.trust(box.repo);
      arrange(box);
      const cells = box.grok(box.repo, "inspect").externalCompat.cells as Array<{
        vendor: string;
        surface: string;
        enabled: boolean;
      }>;
      const homes = box.homes();
      const policy = { grokHome: box.grokHome, systemDir: box.systemDir, env: homes.grokEnv ?? {} };
      for (const vendor of ["claude", "cursor"] as const) {
        const grok = cells.find(
          (cell) => cell.vendor === vendor && cell.surface === "mcps",
        )?.enabled;
        const ours = (await grokCompat(vendor, policy, readHostText)).enabled;
        expect({ vendor, enabled: ours }).toEqual({ vendor, enabled: grok as boolean });
      }
    });
  }

  test("saved enable: servers Grok turns off are the catalogue's disabled rows", async () => {
    const box = new Sandbox();
    box.trust(box.repo);
    box.write(
      path.join(box.grokHome, "config.toml"),
      `disabled_mcp_servers = ["listed"]\n\n${SERVER("off", "off")}enabled = false\n\n${SERVER("on", "on")}`,
    );
    box.write(
      path.join(box.repo, ".grok", "config.toml"),
      SERVER("listed", "listed") + SERVER("policy_off", "policy_off"),
    );
    box.write(
      path.join(box.grokHome, "requirements.toml"),
      `[mcp_servers.on2]\ncommand = "/nonexistent/x"\nenabled = false\n[mcp_servers.policy_off]\nenabled = false\n`,
    );
    // `grok inspect` still lists a server named in `disabled_mcp_servers`
    // (and drops one with `enabled = false`); `grok mcp list` and `doctor`
    // ("disabled in config") agree on both, so the list is the reference.
    const listed = box.grok(box.repo, "mcp", "list") as Array<{ name: string; enabled: boolean }>;
    const loaded = new Set(listed.filter((server) => server.enabled).map((server) => server.name));
    const { definitions, effective } = await box.catalog(box.repo);
    for (const name of ["off", "on", "listed", "on2", "policy_off"]) {
      const row =
        definitions.find((item) => item.entryId === effective[name]) ??
        definitions.find((item) => item.name === name);
      expect(row?.status).toBe(name === "on" ? "effective" : "disabled");
      if (name === "policy_off") expect(row?.statusReason).toContain("administrator policy");
      const running = row?.status === "effective" && row.enabled !== false;
      expect({ name, running }).toEqual({ name, running: loaded.has(name) });
    }
  });
});
