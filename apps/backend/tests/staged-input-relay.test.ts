import { enabledInstalledPlugins } from "@orkestrator/protocol/node/claude-plugin-set";
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  STAGED_INPUT_RELAY_DIR,
  scrubStagedProvider,
  stagePortableInputs,
  stagedInputRelayPaths,
  type InputSourceRoots,
} from "../src/core/portable-inputs";

/**
 * The root entrypoint's relay (`relay_staged_inputs`) run on the host. The
 * unprivileged half (`as_input_user`, `setpriv` to node in the image) runs as
 * the test user; `unreadable` decides what the `find ! -readable` probe sees,
 * standing in for node's view of a rootless daemon's owner-only mounts.
 */
const rootEntrypoint = await fs.readFile(
  path.join(import.meta.dir, "../../../docker/network-policy-entrypoint.sh"),
  "utf8",
);
const entrypoint = await fs.readFile(
  path.join(import.meta.dir, "../../../docker/entrypoint.sh"),
  "utf8",
);

function shellFunction(source: string, name: string): string {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0];
  if (!body) throw new Error(`Missing shell function: ${name}`);
  return body;
}

function shellAssignment(source: string, name: string): string {
  const line = source.match(new RegExp(`^${name}=.*$`, "m"))?.[0];
  if (!line) throw new Error(`Missing shell assignment: ${name}`);
  return line;
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-relay-"));
  roots.push(root);
  return root;
}

function relay(
  sourceRoot: string,
  relayDir: string,
  options: { unreadable: boolean; maxEntries?: number },
) {
  const script = [
    "set -euo pipefail",
    shellAssignment(rootEntrypoint, "STAGED_INPUT_MOUNTS"),
    `STAGED_INPUT_RELAY_MAX_ENTRIES=${options.maxEntries ?? 20000}`,
    shellAssignment(rootEntrypoint, "STAGED_INPUT_RELAY_MAX_BYTES"),
    // node's view: the probe reports an unreadable entry, or none.
    `as_input_user() { if [ "$1" = find ]; then ${options.unreadable ? 'echo "$2"' : "true"}; return 0; fi; "$@"; }`,
    shellFunction(rootEntrypoint, "relay_staged_inputs"),
    `relay_staged_inputs "$SOURCE_ROOT" "$RELAY_DIR" "$(id -un)" || echo "Staged inputs were not relayed" >&2`,
  ].join("\n");
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", script],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      SOURCE_ROOT: sourceRoot,
      RELAY_DIR: relayDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

/** The mount points as the container sees them, from a real staged revision. */
async function mountedRevision(root: string) {
  const home = path.join(root, "home");
  await fs.mkdir(path.join(home, ".codex", "rules"), { recursive: true });
  await fs.writeFile(path.join(home, ".codex", "auth.json"), '{"OPENAI_API_KEY":"sk-test"}');
  await fs.writeFile(path.join(home, ".codex", "config.toml"), "model = 'x'\n");
  await fs.writeFile(path.join(home, ".codex", "rules", "default.rules"), "allow\n");
  await fs.writeFile(path.join(home, ".gitconfig"), "[user]\n\tname = Test\n");
  const dataDir = path.join(root, "data");
  const inputRoots: InputSourceRoots = { home, agentTest: false };
  const staged = await stagePortableInputs(
    dataDir,
    "env-relay",
    new Set(["codex", "git"]),
    inputRoots,
  );
  // Docker's view: each staged source bound at its target below `/`.
  const container = path.join(root, "container");
  for (const mount of staged.mounts) {
    const target = path.join(container, mount.target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(mount.source, `${target}.bind`);
    await fs.cp(mount.source, target, { recursive: true, preserveTimestamps: true });
  }
  return { staged, dataDir, container };
}

describe("staged input relay", () => {
  test("a mount node cannot read is copied owner-only into node's directory", async () => {
    const root = await tempRoot();
    const { container } = await mountedRevision(root);
    const relayDir = path.join(root, "run", "orkestrator-inputs");
    await fs.mkdir(path.dirname(relayDir), { recursive: true });
    expect(relay(container, relayDir, { unreadable: true }).exitCode).toBe(0);

    expect((await fs.stat(relayDir)).mode & 0o777).toBe(0o700);
    const auth = path.join(relayDir, "codex-home", "auth.json");
    expect(await fs.readFile(auth, "utf8")).toContain("OPENAI_API_KEY");
    expect((await fs.stat(auth)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(relayDir, "codex-home"))).mode & 0o777).toBe(0o700);
    expect(
      await fs.readFile(path.join(relayDir, "codex-home", "rules", "default.rules"), "utf8"),
    ).toBe("allow\n");
    expect(await fs.readFile(path.join(relayDir, "tmp", "gitconfig"), "utf8")).toContain("Test");
    // Mounts the backend did not bind are not invented.
    expect((await fs.readdir(relayDir)).sort()).toEqual(["codex-home", "tmp"]);
  });

  test("a mount node can read is left alone, and an earlier relay is removed", async () => {
    const root = await tempRoot();
    const { container } = await mountedRevision(root);
    const relayDir = path.join(root, "orkestrator-inputs");
    await fs.mkdir(path.join(relayDir, "codex-home"), { recursive: true });
    await fs.writeFile(path.join(relayDir, "codex-home", "auth.json"), "stale");
    expect(relay(container, relayDir, { unreadable: false }).exitCode).toBe(0);
    await expect(fs.stat(relayDir)).rejects.toThrow();
  });

  test("a revoked provider's emptied mount relays nothing at the next boot", async () => {
    const root = await tempRoot();
    const { container, dataDir, staged } = await mountedRevision(root);
    const relayDir = path.join(root, "orkestrator-inputs");
    relay(container, relayDir, { unreadable: true });
    expect(await fs.readdir(path.join(relayDir, "codex-home"))).toContain("auth.json");

    expect(await scrubStagedProvider(dataDir, "env-relay", staged.revision, "codex")).toBe(true);
    // The bound directory now shows the emptied stage.
    const codexMount = path.join(container, "codex-home");
    await fs.rm(codexMount, { recursive: true });
    await fs.cp(await fs.readlink(`${codexMount}.bind`), codexMount, { recursive: true });
    relay(container, relayDir, { unreadable: true });
    expect(await fs.readdir(path.join(relayDir, "codex-home"))).toEqual([]);
  });

  test("links are never followed, and an over-bound mount is not relayed", async () => {
    const root = await tempRoot();
    const container = path.join(root, "container");
    const secret = path.join(root, "secret.txt");
    await fs.writeFile(secret, "host secret");
    await fs.mkdir(path.join(container, "codex-home"), { recursive: true });
    await fs.symlink(secret, path.join(container, "codex-home", "auth.json"));
    await fs.symlink(path.join(root, "elsewhere"), path.join(container, "pi-config"));
    const relayDir = path.join(root, "orkestrator-inputs");
    relay(container, relayDir, { unreadable: true });
    const relayed = path.join(relayDir, "codex-home", "auth.json");
    expect((await fs.lstat(relayed)).isSymbolicLink()).toBe(true);
    // A mount point that is itself a link is skipped.
    await expect(fs.lstat(path.join(relayDir, "pi-config"))).rejects.toThrow();

    await fs.writeFile(path.join(container, "codex-home", "one"), "1");
    await fs.writeFile(path.join(container, "codex-home", "two"), "2");
    const bounded = relay(container, relayDir, { unreadable: true, maxEntries: 2 });
    expect(bounded.stderr).toContain("Staged input /codex-home is over the relay bounds");
    await expect(fs.stat(path.join(relayDir, "codex-home"))).rejects.toThrow();
  });
});

describe("entrypoint input resolution", () => {
  const resolve = (relayDir: string, name: string) => {
    const script = [
      `STAGED_INPUT_RELAY_DIR="$RELAY_DIR"`,
      shellFunction(entrypoint, "staged_input_path"),
      `staged_input_path "$NAME"`,
    ].join("\n");
    return Bun.spawnSync({
      cmd: ["bash", "-c", script],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", RELAY_DIR: relayDir, NAME: name },
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
  };

  test("reads the relayed copy when there is one, the mount otherwise", async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, "codex-home"));
    await fs.mkdir(path.join(root, "claude-config"));
    await fs.writeFile(path.join(root, "claude-config", ".credentials.json"), "{}");
    await fs.symlink(path.join(root, "codex-home"), path.join(root, "grok-home"));
    expect(resolve(root, "/codex-home")).toBe(path.join(root, "codex-home"));
    expect(resolve(root, "/claude-config/.credentials.json")).toBe(
      path.join(root, "claude-config", ".credentials.json"),
    );
    expect(resolve(root, "/claude-config.json")).toBe("/claude-config.json");
    // A link in the relay is never taken for a relayed input.
    expect(resolve(root, "/grok-home")).toBe("/grok-home");
  });

  test("the copy helpers read a relayed mount in place of the mount", async () => {
    const root = await tempRoot();
    const relayDir = path.join(root, "relay");
    await fs.mkdir(path.join(relayDir, "codex-home"), { recursive: true });
    await fs.writeFile(path.join(relayDir, "codex-home", "config.toml"), "relayed\n");
    const home = path.join(root, "home");
    const helpers = [
      "log_progress",
      "agent_copy_warn",
      "report_agent_copy_skips",
      "agent_source_path_has_symlink",
      "agent_destination_path_has_symlink",
      "copy_agent_file",
    ]
      .map((name) => shellFunction(entrypoint, name))
      .join("\n");
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        `set -e\nAGENT_COPY_SKIPPED=""\nSTAGED_INPUT_RELAY_DIR="$RELAY_DIR"\n${helpers}\nmkdir -p "$HOME/.codex"\ncopy_agent_file /codex-home "$HOME/.codex" config.toml Codex`,
      ],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        RELAY_DIR: relayDir,
        PROGRESS_FILE: path.join(root, "progress"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8")).toBe("relayed\n");
  });

  for (const linked of [false, true]) {
    test(`plugin enablement reads the relay and rejects linked settings (linked=${linked})`, async () => {
      const root = await tempRoot();
      const relayDir = path.join(root, "relay");
      const config = path.join(relayDir, "claude-config");
      const home = path.join(root, "home");
      await fs.mkdir(config, { recursive: true });
      await fs.mkdir(path.join(home, ".claude"), { recursive: true });
      const host = path.join(root, "host-settings.json");
      await fs.writeFile(
        host,
        JSON.stringify({
          enabledPlugins: {
            "review@fixture": true,
            "off@fixture": false,
            "invalid@fixture": "true",
          },
          env: { UNTRUSTED: "excluded" },
        }),
      );
      const input = path.join(config, "settings.json");
      if (linked) await fs.symlink(host, input);
      else await fs.copyFile(host, input);
      const output = path.join(home, ".claude", "settings.json");
      await fs.writeFile(output, '{"permissions":{"defaultMode":"bypassPermissions"}}');
      // Execute the production merge with no readable raw mount, only a relay.
      const merge = entrypoint.slice(
        entrypoint.indexOf("CLAUDE_SETTINGS_INPUT="),
        entrypoint.indexOf("# Copy and filter ~/.claude.json"),
      );
      expect(merge).toContain('jq --slurpfile host "$CLAUDE_SETTINGS_INPUT"');
      const result = Bun.spawnSync({
        cmd: [
          "bash",
          "-ec",
          [
            'STAGED_INPUT_RELAY_DIR="$RELAY_DIR"',
            shellFunction(entrypoint, "staged_input_path"),
            "log_progress() { :; }",
            merge,
          ].join("\n"),
        ],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, RELAY_DIR: relayDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      const settings = JSON.parse(await fs.readFile(output, "utf8"));
      expect(settings.permissions.defaultMode).toBe("bypassPermissions");
      expect(settings.env).toBeUndefined();
      expect(settings.enabledPlugins).toEqual(
        linked
          ? undefined
          : {
              "review@fixture": true,
              "off@fixture": false,
            },
      );
      const installed = [
        { type: "local" as const, path: "/plugin", installedId: "review@fixture" },
      ];
      expect(enabledInstalledPlugins(installed, { user: settings }, ["user"])).toEqual(
        linked ? [] : installed,
      );
    });
  }

  test("the backend's relay path and revocation targets match the image", () => {
    expect(shellAssignment(entrypoint, "STAGED_INPUT_RELAY_DIR")).toBe(
      `STAGED_INPUT_RELAY_DIR=${STAGED_INPUT_RELAY_DIR}`,
    );
    expect(shellAssignment(rootEntrypoint, "STAGED_INPUT_RELAY_DIR")).toBe(
      `STAGED_INPUT_RELAY_DIR=${STAGED_INPUT_RELAY_DIR}`,
    );
    expect(stagedInputRelayPaths("codex")).toEqual([`${STAGED_INPUT_RELAY_DIR}/codex-home`]);
    expect(stagedInputRelayPaths("opencode")).toEqual([
      `${STAGED_INPUT_RELAY_DIR}/opencode-config`,
      `${STAGED_INPUT_RELAY_DIR}/opencode-data`,
      `${STAGED_INPUT_RELAY_DIR}/opencode-state/model.json`,
    ]);
    expect(stagedInputRelayPaths("claude")).toContain(`${STAGED_INPUT_RELAY_DIR}/claude-config`);
  });
});
