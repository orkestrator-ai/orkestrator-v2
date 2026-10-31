/**
 * The MCP editor's Codex rows against the real pinned Codex, with no
 * credentials (no model is called, nothing signs in).
 *
 * Opt-in: RUN_LIVE_CODEX_MCP=1, with the pinned binary installed by the
 * toolchain (or CODEX_CLI_PATH pointing at one):
 *
 *   mise run verify:codex:mcp-live
 *
 * Each case writes fixture files into a throwaway HOME, CODEX_HOME and git
 * repository, then compares `codex mcp list --json` run in that repository
 * (the servers Codex's configuration loader keeps for it) with what the
 * catalogue concludes from the same files:
 *
 * - project trust: whether the project's `.codex/config.toml` loads, against
 *   `codexProjectTrust`;
 * - precedence and merging: which command a name ends up with, and whether
 *   it is enabled, against the catalogue's effective row;
 * - which files are sources at all.
 *
 * `/etc/codex` cannot be written without root, so the system and managed
 * files are not exercised. Fixture servers name commands that do not exist,
 * and `mcp list` starts none of them.
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
import { codexProjectTrust, readHostText } from "../src/core/mcp-management/native-policy";
import {
  providerCapabilities,
  providerSources,
  resolveProviderHomes,
} from "../src/core/mcp-management/providers";
import { McpSourceStore } from "../src/core/mcp-management/source-store";

const ENABLED = process.env.RUN_LIVE_CODEX_MCP === "1";

function pinnedBinary(): string {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  const platform = `${process.platform}-${process.arch}`;
  const dataDir =
    process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support", "orkestrator-v2")
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "orkestrator-v2");
  return path.join(
    dataDir,
    "toolchains",
    "codex",
    PINNED_TOOLCHAIN_VERSIONS.codex,
    platform,
    "codex",
  );
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface ListedServer {
  name: string;
  enabled: boolean;
  transport: { command?: string; args?: string[] };
}

/** A throwaway home, Codex home and git repository. */
class Sandbox {
  readonly root = realpathSync(mkdtempSync(path.join(tmpdir(), "codex-mcp-parity-")));
  readonly home = path.join(this.root, "home");
  readonly codexHome = path.join(this.home, ".codex");
  readonly systemDir = path.join(this.root, "no-etc-codex");
  readonly repo = path.join(this.root, "repo");

  constructor() {
    roots.push(this.root);
    mkdirSync(this.codexHome, { recursive: true });
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

  /** The user config: `servers` first, then one `[projects]` decision per key. */
  user(servers: string, trust: Record<string, string> = {}): void {
    const projects = Object.entries(trust)
      .map(([folder, level]) => `[projects."${folder}"]\ntrust_level = "${level}"\n`)
      .join("\n");
    this.write(path.join(this.codexHome, "config.toml"), `${servers}\n${projects}`);
  }

  processEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: this.home,
      CODEX_HOME: this.codexHome,
      XDG_CONFIG_HOME: path.join(this.home, ".config"),
    };
  }

  /** `codex mcp list --json` in `cwd`; it prints a warning line before the JSON under /tmp. */
  list(cwd: string): ListedServer[] {
    const result = spawnSync(pinnedBinary(), ["mcp", "list", "--json"], {
      cwd,
      env: this.processEnv(),
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status, `codex mcp list: ${result.stderr}`).toBe(0);
    const start = result.stdout.indexOf("[");
    expect(start, `codex mcp list printed no JSON: ${result.stdout}`).toBeGreaterThanOrEqual(0);
    return JSON.parse(result.stdout.slice(start)) as ListedServer[];
  }

  homes() {
    return {
      ...resolveProviderHomes(this.processEnv(), this.home),
      codexSystemDir: this.systemDir,
    };
  }

  async catalog(worktree: string) {
    const specs = await providerSources("codex", {
      context: { kind: "environment", location: "local-worktree", worktreePath: worktree },
      homes: this.homes(),
      exists: async (file: string) => existsSync(file),
    });
    const store = new McpSourceStore({ keyFile: path.join(this.root, "data", "revision.key") });
    const catalog = await loadCatalog(store, specs);
    return { specs, ...summarizeEntries(catalog, providerCapabilities("codex")) };
  }

  /** The catalogue's verdict on `name`: running with which command, or off. */
  async running(worktree: string, name: string): Promise<string | false> {
    const { definitions, effective } = await this.catalog(worktree);
    const row = definitions.find((item) => item.entryId === effective[name]);
    if (!row || row.status !== "effective" || row.enabled === false) return false;
    // A higher layer that leaves `command` out inherits it from a lower one.
    for (const candidate of [
      row,
      ...definitions.filter((item) => row.shadows.includes(item.entryId)),
    ]) {
      if (candidate.command?.kind === "visible") return candidate.command.value;
    }
    return "<no command>";
  }
}

const SERVER = (name: string, command: string, extra = "") =>
  `[mcp_servers.${name}]\ncommand = "/nonexistent/${command}"\n${extra}`;

describe.skipIf(!ENABLED)(`Codex ${PINNED_TOOLCHAIN_VERSIONS.codex} MCP rules`, () => {
  test("the pinned binary is installed", () => {
    const binary = pinnedBinary();
    expect(existsSync(binary), `pinned Codex binary at ${binary}`).toBe(true);
    const version = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      env: new Sandbox().processEnv(),
    });
    expect(version.stdout).toContain(PINNED_TOOLCHAIN_VERSIONS.codex);
  });

  // Each case writes the user config's trust decisions and names the folder
  // the session runs in; that folder holds a project server.
  const trustCases: Array<[string, (box: Sandbox) => string]> = [
    ["no decision", (box) => (box.user(""), box.repo)],
    ["trusted", (box) => (box.user("", { [box.repo]: "trusted" }), box.repo)],
    ["untrusted", (box) => (box.user("", { [box.repo]: "untrusted" }), box.repo)],
    [
      "a trailing slash on the key",
      (box) => (box.user("", { [`${box.repo}/`]: "trusted" }), box.repo),
    ],
    [
      "a key spelled through a symlink",
      (box) => {
        const link = path.join(box.root, "link");
        symlinkSync(box.repo, link);
        box.user("", { [link]: "trusted" });
        return link;
      },
    ],
    [
      "a session started through a symlink",
      (box) => {
        const link = path.join(box.root, "link");
        symlinkSync(box.repo, link);
        box.user("", { [box.repo]: "trusted" });
        return link;
      },
    ],
    [
      "a grant on a non-git parent",
      (box) => {
        const nested = path.join(box.root, "parent", "nested");
        box.git(box.root, "init", "-q", nested);
        box.user("", { [path.join(box.root, "parent")]: "trusted" });
        return nested;
      },
    ],
    [
      "a grant on an enclosing repository",
      (box) => {
        const inner = path.join(box.repo, "inner");
        box.git(box.root, "init", "-q", inner);
        box.user("", { [box.repo]: "trusted" });
        return inner;
      },
    ],
    ...(
      [
        ["main trusted", { main: "trusted" }],
        ["itself trusted", { self: "trusted" }],
        ["itself untrusted, main trusted", { self: "untrusted", main: "trusted" }],
        ["itself trusted, main untrusted", { self: "trusted", main: "untrusted" }],
      ] as const
    ).map(([label, levels]): [string, (box: Sandbox) => string] => [
      `a linked worktree, ${label}`,
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
        const trust: Record<string, string> = {};
        if ("self" in levels) trust[worktree] = levels.self;
        if ("main" in levels) trust[box.repo] = levels.main;
        box.user("", trust);
        return worktree;
      },
    ]),
  ];

  for (const [name, arrange] of trustCases) {
    test(`project trust: ${name}`, async () => {
      const box = new Sandbox();
      const folder = arrange(box);
      box.write(path.join(folder, ".codex", "config.toml"), SERVER("project", "project"));
      const loaded = box.list(folder).some((server) => server.name === "project");
      const verdict = await codexProjectTrust(box.codexHome, folder, readHostText);
      expect({ name, allowed: verdict.trust === "allowed" }).toEqual({ name, allowed: loaded });
    });
  }

  // `dup` in the user file, then the project's (trusted) override of it.
  const mergeCases: Array<[string, string, string]> = [
    [
      "the project's command wins",
      SERVER("dup", "user", `args = ["u"]\n`),
      SERVER("dup", "project"),
    ],
    [
      "a project entry without a command inherits it",
      SERVER("dup", "user"),
      `[mcp_servers.dup]\nargs = ["p"]\n`,
    ],
    [
      "a project enabled = false turns it off",
      SERVER("dup", "user"),
      `[mcp_servers.dup]\nenabled = false\n`,
    ],
    [
      "a project enabled = true turns it back on",
      SERVER("dup", "user", "enabled = false\n"),
      `[mcp_servers.dup]\nenabled = true\n`,
    ],
    ["user enabled = false alone", SERVER("dup", "user", "enabled = false\n"), ""],
    [
      "a project command inherits the user's enabled = false",
      SERVER("dup", "user", "enabled = false\n"),
      SERVER("dup", "project"),
    ],
  ];

  for (const [name, userServers, projectServers] of mergeCases) {
    test(`precedence: ${name}`, async () => {
      const box = new Sandbox();
      box.user(userServers, { [box.repo]: "trusted" });
      if (projectServers) box.write(path.join(box.repo, ".codex", "config.toml"), projectServers);
      const listed = box.list(box.repo).find((server) => server.name === "dup");
      const codex = listed?.enabled ? (listed.transport.command ?? "<no command>") : false;
      expect({ name, running: await box.running(box.repo, "dup") }).toEqual({
        name,
        running: codex,
      });
    });
  }

  test("sources: CODEX_HOME's managed_config.toml is not one", async () => {
    const box = new Sandbox();
    box.user("");
    box.write(path.join(box.codexHome, "managed_config.toml"), SERVER("managed", "managed"));
    expect(box.list(box.repo).map((server) => server.name)).toEqual([]);
    const { specs } = await box.catalog(box.repo);
    expect(
      specs.some((spec) => spec.path === path.join(box.codexHome, "managed_config.toml")),
    ).toBe(false);
  });
});
