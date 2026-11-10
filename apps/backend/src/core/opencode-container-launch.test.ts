import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPENCODE_CREDENTIAL_PLUGIN_FILE,
  OPENCODE_GITHUB_ENV_PLUGIN_FILE,
  OPENCODE_GITHUB_ENV_PLUGIN_SOURCE,
  OPENCODE_LAUNCH_CONFIG_HOME,
  OPENCODE_LAUNCH_HOME,
  OPENCODE_LAUNCH_ROOT,
} from "./agent-credential-files.js";
import { OPENCODE_SERVER_PORT } from "./constants.js";
import {
  OPENCODE_HOST_CONFIG_INPUT,
  OPENCODE_LAUNCH_CREDENTIAL_PLUGIN_SOURCE,
  openCodeLaunch,
  openCodeLaunchConfigScript,
  openCodeLaunchPrepareScript,
} from "./opencode-container-launch.js";
import { OPENCODE_CONTAINER_BINARY } from "./opencode-listener-identity.js";

const repository = path.resolve(import.meta.dir, "../../../..");
const launcher = readFileSync(path.join(repository, "docker/orkestrator-bridge-launch.sh"), "utf8");
const dockerfile = readFileSync(path.join(repository, "docker/Dockerfile"), "utf8");

// These tests run real shells and socket processes; allow aggregate host load.
setDefaultTimeout(30_000);

describe("the launcher and the backend agree", () => {
  test("on where OpenCode reads its configuration and home, and what it runs", () => {
    expect(launcher).toContain("# ORKESTRATOR_CAPABILITY opencode-launch=1");
    expect(launcher).toContain(`export XDG_CONFIG_HOME=${OPENCODE_LAUNCH_CONFIG_HOME}\n`);
    expect(launcher).toContain(`export OPENCODE_TEST_HOME=${OPENCODE_LAUNCH_HOME}\n`);
    expect(launcher).toContain("OPENCODE_DISABLE_PROJECT_CONFIG=1");
    // Which also drops the checkout's AGENTS.md, named back in as instructions.
    expect(launcher).toContain(
      `export OPENCODE_CONFIG_CONTENT='{"instructions":["/workspace/AGENTS.md"]}'`,
    );
    expect(launcher).toContain(
      `setsid ${OPENCODE_CONTAINER_BINARY} serve --port ${OPENCODE_SERVER_PORT} --hostname 0.0.0.0`,
    );
    // The OpenCode variables come after the backend's, so stdin cannot replace them.
    expect(launcher.indexOf('for line in "$@"; do export "$line"; done')).toBeLessThan(
      launcher.indexOf(`export XDG_CONFIG_HOME=`),
    );
    expect(dockerfile).toContain(`install -d -o root -g root -m 0755 ${OPENCODE_LAUNCH_ROOT}`);
  });

  test("the password is never an argument of a process that outlives the launch", () => {
    const branch = launcher.slice(
      launcher.indexOf('if [ "$kind" = opencode ]; then'),
      launcher.indexOf("# A new session, detached from this exec"),
    );
    // Not `env -i NAME=VALUE ...` and not a long-lived `sh -c` wrapper.
    expect(branch).not.toContain('"$@" \\');
    expect(branch).not.toContain("sh -c");
    expect(branch).toContain(
      "/usr/bin/env -i PATH=/usr/bin:/bin /usr/local/bin/orkestrator-log-writer",
    );
    // The script re-runs itself with an empty environment first.
    expect(launcher).toContain(
      "exec /usr/bin/env -i ORKESTRATOR_BRIDGE_LAUNCH_CLEAN=1 PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    );
  });
});

test("the launch hands the password to root's file and the launcher only", () => {
  const password = `okb_${"p".repeat(43)}`;
  const { launch, snapshot } = openCodeLaunch(password, true);
  expect(snapshot).toMatch(/^\/tmp\/\.orkestrator-bridge-env-opencode-[0-9a-f]{32}$/);
  expect(launch.rootCredential).toEqual({ kind: "opencode", token: password });
  expect(launch.launcher).toEqual({
    kind: "opencode",
    snapshot,
    env: {
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DB: "/home/node/.local/share/opencode/orkestrator-db/opencode.db",
    },
  });
  expect(launch.secrets).toBeUndefined();
  expect(openCodeLaunch(password, false).launch.launcher!.env).toEqual({
    OPENCODE_SERVER_PASSWORD: password,
  });
  const prepare = openCodeLaunchPrepareScript(snapshot);
  expect(prepare).not.toContain(password);
  expect(prepare).toContain(`env -0 > ${snapshot}`);
  expect(prepare).toContain("unset GITHUB_TOKEN GH_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN");
});

describe.skipIf(process.platform !== "linux")("rebuilding the configuration as root", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /** The script with its fixed paths moved into a temporary directory, run as this user. */
  async function rebuild(prepareInput: (input: string) => Promise<void>) {
    const directory = await mkdtemp(path.join(tmpdir(), "ork-opencode-config-"));
    directories.push(directory);
    const root = path.join(directory, "run");
    const input = path.join(directory, "input");
    await mkdir(root);
    await prepareInput(input);
    // A planted file in the previous configuration does not survive.
    await mkdir(path.join(root, "config", "opencode", "plugins"), { recursive: true });
    await writeFile(path.join(root, "config", "opencode", "plugins", "stale.js"), "stale");
    const uid = String(process.getuid?.() ?? 0);
    const script = openCodeLaunchConfigScript()
      .replaceAll(OPENCODE_LAUNCH_ROOT, root)
      .replaceAll(OPENCODE_HOST_CONFIG_INPUT, input)
      .replace(`!= 0 ]`, `!= ${uid} ]`)
      .replace('chown -R 0:0 "$next"', "true");
    const result = Bun.spawnSync(["sh", "-c", script]);
    return { root, exitCode: result.exitCode, stderr: result.stderr.toString() };
  }

  test("copies the user's host configuration without node_modules or links, and adds ours", async () => {
    const { root, exitCode } = await rebuild(async (input) => {
      await mkdir(path.join(input, "plugins"), { recursive: true });
      await mkdir(path.join(input, "node_modules", "dep"), { recursive: true });
      await writeFile(path.join(input, "opencode.json"), '{"model":"x/y"}');
      await writeFile(path.join(input, "plugins", "mine.js"), "export const Mine = 1;");
      await writeFile(path.join(input, "node_modules", "dep", "index.js"), "x");
      await symlink(
        "/home/node/.config/opencode/plugins/planted.js",
        path.join(input, "plugins", "linked.js"),
      );
      // A plugin of ours the user's copy cannot replace.
      await writeFile(path.join(input, "plugins", OPENCODE_CREDENTIAL_PLUGIN_FILE), "export {}");
    });
    expect(exitCode).toBe(0);
    const config = path.join(root, "config", "opencode");
    expect(await readFile(path.join(config, "opencode.json"), "utf8")).toBe('{"model":"x/y"}');
    expect((await readdir(path.join(config, "plugins"))).sort()).toEqual(
      ["mine.js", OPENCODE_CREDENTIAL_PLUGIN_FILE, OPENCODE_GITHUB_ENV_PLUGIN_FILE].sort(),
    );
    expect(
      await readFile(path.join(config, "plugins", OPENCODE_CREDENTIAL_PLUGIN_FILE), "utf8"),
    ).toBe(OPENCODE_LAUNCH_CREDENTIAL_PLUGIN_SOURCE);
    expect(
      await readFile(path.join(config, "plugins", OPENCODE_GITHUB_ENV_PLUGIN_FILE), "utf8"),
    ).toBe(OPENCODE_GITHUB_ENV_PLUGIN_SOURCE);
    await expect(lstat(path.join(config, "node_modules"))).rejects.toThrow();
    // Readable by the server's uid, writable by no one else.
    expect((await stat(path.join(config, "plugins", "mine.js"))).mode & 0o777).toBe(0o644);
    expect((await stat(path.join(root, "config"))).mode & 0o777).toBe(0o755);
    // An empty home: no `.opencode` for OpenCode to find there.
    expect(await readdir(path.join(root, "home"))).toEqual([]);
  });

  test("with no host configuration, only our plugins", async () => {
    const { root, exitCode } = await rebuild(async () => undefined);
    expect(exitCode).toBe(0);
    expect((await readdir(path.join(root, "config", "opencode", "plugins"))).sort()).toEqual(
      [OPENCODE_CREDENTIAL_PLUGIN_FILE, OPENCODE_GITHUB_ENV_PLUGIN_FILE].sort(),
    );
  });
});
