import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  chmod,
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
  OPENCODE2_LAUNCH_CACHE_HOME,
  OPENCODE2_LAUNCH_CONFIG_DIR,
  OPENCODE2_LAUNCH_CONFIG_HOME,
  OPENCODE2_LAUNCH_HOME,
  OPENCODE2_LAUNCH_PROJECT_CONFIG,
  OPENCODE2_LAUNCH_ROOT,
  OPENCODE_LAUNCH_CACHE_HOME,
  OPENCODE_LAUNCH_CONFIG_HOME,
  OPENCODE_LAUNCH_HOME,
  OPENCODE_LAUNCH_PROJECT_CONFIG,
  OPENCODE_LAUNCH_ROOT,
} from "./agent-credential-files.js";
import { OPENCODE2_SERVER_PORT, OPENCODE_SERVER_PORT } from "./constants.js";
import { OPENCODE_HOST_CONFIG_INPUT } from "./opencode-container-launch.js";
import {
  OPENCODE2_CONTAINER_BINARY,
  OPENCODE_CONTAINER_BINARY,
} from "./opencode-listener-identity.js";
import {
  OPENCODE2_LAUNCH_FINGERPRINT,
  openCode2Launch,
  openCode2LaunchConfigScript,
  openCode2LaunchPlugins,
  openCode2LaunchPrepareScript,
} from "./opencode2-container-launch.js";
import {
  OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT,
  OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE,
  OPENCODE2_GITHUB_ENV_PLUGIN_ID,
} from "./opencode2/container-server.js";
import { OPENCODE2_CREDENTIAL_PLUGIN_ID, OPENCODE2_FLAGS } from "./opencode2/server.js";

const repository = path.resolve(import.meta.dir, "../../../..");
const launcherPath = path.join(repository, "docker/orkestrator-bridge-launch.sh");
const launcher = readFileSync(launcherPath, "utf8");
const dockerfile = readFileSync(path.join(repository, "docker/Dockerfile"), "utf8");
const rootBoundary = readFileSync(path.join(repository, "docker/verify-root-boundary.sh"), "utf8");

// These tests run real shells; allow aggregate host load.
setDefaultTimeout(30_000);

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

describe("the image, the launcher and the backend agree on the 2.x server", () => {
  test("the image declares it and keeps its binary and directories root's", () => {
    expect(launcher).toContain("# ORKESTRATOR_CAPABILITY opencode2-launch=1");
    expect(launcher).toContain(`root=${OPENCODE2_LAUNCH_ROOT}\n`);
    expect(launcher).toContain(`export XDG_CONFIG_HOME=${OPENCODE2_LAUNCH_CONFIG_HOME}\n`);
    expect(launcher).toContain(`export OPENCODE_CONFIG_DIR=${OPENCODE2_LAUNCH_CONFIG_DIR}\n`);
    expect(launcher).toContain(
      `binary=${OPENCODE2_CONTAINER_BINARY} port=${OPENCODE2_SERVER_PORT}\n`,
    );
    expect(launcher).toContain(`root=${OPENCODE_LAUNCH_ROOT}\n`);
    expect(launcher).toContain(
      `binary=${OPENCODE_CONTAINER_BINARY} port=${OPENCODE_SERVER_PORT}\n`,
    );
    expect(dockerfile).toContain(
      `mv /tmp/opencode2/package/bin/opencode ${OPENCODE2_CONTAINER_BINARY}`,
    );
    expect(dockerfile).toContain(`chown root:root ${OPENCODE2_CONTAINER_BINARY}`);
    expect(dockerfile).toContain(
      `ln -s ${OPENCODE2_CONTAINER_BINARY} /home/node/.opencode/bin/opencode2`,
    );
    expect(dockerfile).toContain(`install -d -o root -g root -m 0755 ${OPENCODE2_LAUNCH_ROOT}`);
    expect(rootBoundary).toContain(OPENCODE2_CONTAINER_BINARY);
    expect(rootBoundary).toContain(OPENCODE2_LAUNCH_ROOT);
    // The OpenCode variables come after the backend's, so stdin cannot replace them.
    expect(launcher.indexOf('for line in "$@"; do export "$line"; done')).toBeLessThan(
      launcher.indexOf("export OPENCODE_CONFIG_DIR="),
    );
  });

  test("the launch hands the password to root's file and the launcher only", () => {
    const password = `okb_${"p".repeat(43)}`;
    const { launch, snapshot } = openCode2Launch(password, true);
    expect(snapshot).toMatch(/^\/tmp\/\.orkestrator-bridge-env-opencode2-[0-9a-f]{32}$/);
    expect(launch.rootCredential).toEqual({ kind: "opencode2", token: password });
    expect(launch.launcher).toEqual({
      kind: "opencode2",
      snapshot,
      env: {
        OPENCODE_PASSWORD: password,
        OPENCODE_FLAGS: OPENCODE2_FLAGS,
        OPENCODE_DB: "/home/node/.local/share/opencode/orkestrator-db/opencode2.db",
      },
    });
    expect(launch.secrets).toBeUndefined();
    expect(openCode2Launch(password, false).launch.launcher!.env.OPENCODE_DB).toBe(
      "/home/node/.local/share/opencode/opencode2.db",
    );
    const prepare = openCode2LaunchPrepareScript(snapshot);
    expect(prepare).not.toContain(password);
    expect(prepare).toContain(`env -0 > ${snapshot}`);
    expect(prepare).toContain(OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE);
    expect(prepare).toContain(OPENCODE2_LAUNCH_FINGERPRINT);
    expect(prepare).toContain("unset GITHUB_TOKEN GH_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN");
    // A login-shell server is never mistaken for a launched one.
    expect(OPENCODE2_LAUNCH_FINGERPRINT).not.toBe(OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT);
  });

  test("the launched credential plugin applies the start environment after hardening", () => {
    const plugins = openCode2LaunchPlugins();
    expect(plugins.map(({ id }) => id)).toEqual([
      OPENCODE2_CREDENTIAL_PLUGIN_ID,
      OPENCODE2_GITHUB_ENV_PLUGIN_ID,
    ]);
    const credential = plugins[0]!.source;
    expect(credential.startsWith("import { closeSync, constants, fstatSync, openSync")).toBe(true);
    expect(credential.indexOf("markNonDumpable())")).toBeLessThan(
      credential.indexOf("    applyLaunchEnvironment();"),
    );
    expect(credential).toContain("delete process.env.XDG_CACHE_HOME;");
  });
});

describe.skipIf(process.platform !== "linux")("the launcher starts each OpenCode server", () => {
  /**
   * The real launcher with its fixed paths moved into a temporary directory:
   * the server binaries print their environment and arguments, and the log
   * writer copies its input.
   */
  async function launch(
    kind: "opencode" | "opencode2",
    project?: string | ((projectDirectory: string) => Promise<void>),
  ) {
    const directory = await scratch("ork-opencode-launcher-");
    const report = path.join(directory, "server.env");
    const fake = path.join(directory, "server");
    await writeFile(
      fake,
      `#!/bin/sh\n{ printf 'ARGS=%s\\n' "$*"; printf 'CWD=%s\\n' "$(pwd)"; env; } > ${report}.tmp; mv ${report}.tmp ${report}\n`,
    );
    const writer = path.join(directory, "log-writer");
    await writeFile(writer, '#!/bin/sh\ncat > "$1"\n');
    await chmod(fake, 0o755);
    await chmod(writer, 0o755);
    const workspace = path.join(directory, "workspace");
    const roots = {
      opencode: path.join(directory, "run1"),
      opencode2: path.join(directory, "run2"),
    };
    await mkdir(workspace);
    for (const root of Object.values(roots))
      await mkdir(path.join(root, "project"), { recursive: true });
    if (typeof project === "string") {
      await writeFile(path.join(roots[kind], "project", "opencode.json"), project);
    } else if (project) {
      await project(path.join(roots[kind], "project"));
    }
    const script = path.join(directory, "launch.sh");
    await writeFile(
      script,
      launcher
        .replaceAll(OPENCODE2_CONTAINER_BINARY, fake)
        .replaceAll(OPENCODE_CONTAINER_BINARY, fake)
        .replaceAll(OPENCODE2_LAUNCH_ROOT, roots.opencode2)
        .replaceAll(OPENCODE_LAUNCH_ROOT, roots.opencode)
        .replaceAll("/usr/local/bin/orkestrator-log-writer", writer)
        .replaceAll("/usr/local/bin/orkestrator-bridge-launch", script)
        .replaceAll("workdir=/workspace", `workdir=${workspace}`),
    );
    const snapshot = `/tmp/.orkestrator-bridge-env-${kind}-${"a".repeat(32)}`;
    const password = `okb_${"s".repeat(43)}`;
    const result = Bun.spawnSync(["/bin/sh", script, kind, snapshot], {
      stdin: Buffer.from(
        kind === "opencode2"
          ? `OPENCODE_PASSWORD=${password}\nOPENCODE_FLAGS=${OPENCODE2_FLAGS}\n`
          : `OPENCODE_SERVER_PASSWORD=${password}\n`,
      ),
      env: {
        PATH: "/usr/bin:/bin",
        LD_PRELOAD: "/planted.so",
        OPENCODE_CONFIG_DIR: "/planted",
        OPENCODE_CONFIG_CONTENT: '{"plugin":["planted"]}',
      },
    });
    expect(result.exitCode).toBe(0);
    let text = "";
    for (let attempt = 0; attempt < 100 && !text; attempt++) {
      text = await readFile(report, "utf8").catch(() => "");
      if (!text) await Bun.sleep(20);
    }
    const env = Object.fromEntries(
      text
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { env, roots, workspace, password, snapshot };
  }

  test("2.x: root's configuration directory, an empty home and config, root's cache", async () => {
    const { env, roots, workspace, password, snapshot } = await launch("opencode2");
    expect(env.ARGS).toBe(`serve --port ${OPENCODE2_SERVER_PORT} --hostname 0.0.0.0`);
    expect(env.CWD).toBe(workspace);
    expect(env.OPENCODE_PASSWORD).toBe(password);
    expect(env.OPENCODE_FLAGS).toBe(OPENCODE2_FLAGS);
    expect(env.OPENCODE_CONFIG_DIR).toBe(
      OPENCODE2_LAUNCH_CONFIG_DIR.replace(OPENCODE2_LAUNCH_ROOT, roots.opencode2),
    );
    expect(env.XDG_CONFIG_HOME).toBe(
      OPENCODE2_LAUNCH_CONFIG_HOME.replace(OPENCODE2_LAUNCH_ROOT, roots.opencode2),
    );
    expect(env.OPENCODE_TEST_HOME).toBe(
      OPENCODE2_LAUNCH_HOME.replace(OPENCODE2_LAUNCH_ROOT, roots.opencode2),
    );
    expect(env.XDG_CACHE_HOME).toBe(
      OPENCODE2_LAUNCH_CACHE_HOME.replace(OPENCODE2_LAUNCH_ROOT, roots.opencode2),
    );
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    // AGENTS.md comes back through the filtered project file only.
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT).toBe(snapshot);
    expect(env.ORKESTRATOR_BRIDGE_LAUNCH_KEYS).toBe("OPENCODE_PASSWORD,OPENCODE_FLAGS");
    // Nothing from the caller's environment, and no 1.x password name.
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(env.OPENCODE_CONFIG).toBeUndefined();
  });

  test("2.x: the filtered project configuration, when there is one", async () => {
    const { env, roots } = await launch("opencode2", '{"model":"x/y"}\n');
    expect(env.OPENCODE_CONFIG).toBe(
      OPENCODE2_LAUNCH_PROJECT_CONFIG.replace(OPENCODE2_LAUNCH_ROOT, roots.opencode2),
    );
  });

  test("1.x: unchanged configuration and home, plus root's cache and the project file", async () => {
    const { env, roots, password } = await launch("opencode", "{}\n");
    expect(env.ARGS).toBe(`serve --port ${OPENCODE_SERVER_PORT} --hostname 0.0.0.0`);
    expect(env.OPENCODE_SERVER_PASSWORD).toBe(password);
    expect(env.OPENCODE_SERVER_USERNAME).toBe("opencode");
    expect(env.XDG_CONFIG_HOME).toBe(
      OPENCODE_LAUNCH_CONFIG_HOME.replace(OPENCODE_LAUNCH_ROOT, roots.opencode),
    );
    expect(env.OPENCODE_TEST_HOME).toBe(
      OPENCODE_LAUNCH_HOME.replace(OPENCODE_LAUNCH_ROOT, roots.opencode),
    );
    expect(env.XDG_CACHE_HOME).toBe(
      OPENCODE_LAUNCH_CACHE_HOME.replace(OPENCODE_LAUNCH_ROOT, roots.opencode),
    );
    expect(env.OPENCODE_CONFIG).toBe(
      OPENCODE_LAUNCH_PROJECT_CONFIG.replace(OPENCODE_LAUNCH_ROOT, roots.opencode),
    );
    // 1.x adds OPENCODE_CONFIG_DIR to what it reads; none may be named.
    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined();
  });

  test("a linked project file is not passed", async () => {
    const directory = await scratch("ork-opencode-link-");
    const target = path.join(directory, "planted.json");
    await writeFile(target, '{"plugin":["x"]}');
    const { env } = await launch("opencode2", (project) =>
      symlink(target, path.join(project, "opencode.json")),
    );
    expect(env.OPENCODE_CONFIG).toBeUndefined();
  });
});

describe.skipIf(process.platform !== "linux")("rebuilding the 2.x configuration as root", () => {
  /** The script with its fixed paths moved into a temporary directory, run as this user. */
  async function rebuild(prepareInput: (input: string) => Promise<void>) {
    const directory = await scratch("ork-opencode2-config-");
    const root = path.join(directory, "run");
    const input = path.join(directory, "input");
    await mkdir(root);
    await prepareInput(input);
    // A planted file in the previous configuration does not survive.
    await mkdir(path.join(root, "opencode", "plugins", "stale"), { recursive: true });
    await writeFile(path.join(root, "opencode", "plugins", "stale", "index.ts"), "stale");
    const uid = String(process.getuid?.() ?? 0);
    const script = openCode2LaunchConfigScript()
      .replaceAll(OPENCODE2_LAUNCH_ROOT, root)
      .replaceAll(OPENCODE_HOST_CONFIG_INPUT, input)
      .replaceAll("/usr/local/bin/bun", process.execPath)
      .replace(`!= 0 ]`, `!= ${uid} ]`)
      .replace('chown -R 0:0 "$next"', "true");
    const result = Bun.spawnSync(["sh", "-c", script]);
    return { root, exitCode: result.exitCode, stderr: result.stderr.toString() };
  }

  test("ours plugins, the user's entries copied, and one merged document without plugins", async () => {
    const { root, exitCode, stderr } = await rebuild(async (input) => {
      await mkdir(path.join(input, "plugins"), { recursive: true });
      await mkdir(path.join(input, "agents"), { recursive: true });
      await mkdir(path.join(input, "node_modules", "dep"), { recursive: true });
      await writeFile(path.join(input, "plugins", "mine.ts"), "export default {};");
      await writeFile(path.join(input, "agents", "review.md"), "# Review");
      await writeFile(path.join(input, "AGENTS.md"), "user rules");
      await writeFile(path.join(input, "node_modules", "dep", "index.js"), "x");
      await writeFile(
        path.join(input, "opencode.json"),
        '{"model":"a/b","plugin":["npm-plugin"],"instructions":["one.md"]}',
      );
      await writeFile(
        path.join(input, "opencode.jsonc"),
        '// comment\n{"model":"c/d","instructions":["two.md"],"agent":{"x":{"prompt":"{file:./p.md}"}}}',
      );
      await symlink("/home/node/planted.md", path.join(input, "agents", "linked.md"));
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const config = path.join(root, "opencode");
    expect((await readdir(config)).sort()).toEqual(
      ["AGENTS.md", "agents", "opencode.jsonc", "plugins"].sort(),
    );
    expect((await readdir(path.join(config, "plugins"))).sort()).toEqual(
      [OPENCODE2_CREDENTIAL_PLUGIN_ID, OPENCODE2_GITHUB_ENV_PLUGIN_ID].sort(),
    );
    for (const plugin of openCode2LaunchPlugins()) {
      expect(await readFile(path.join(config, "plugins", plugin.id, "index.ts"), "utf8")).toBe(
        plugin.source,
      );
    }
    expect(await readdir(path.join(config, "agents"))).toEqual(["review.md"]);
    const merged = await readFile(path.join(config, "opencode.jsonc"), "utf8");
    const document = Bun.JSONC.parse(merged) as Record<string, unknown>;
    expect(document.model).toBe("c/d");
    expect(document.plugin).toBeUndefined();
    expect(document.instructions).toEqual(["one.md", "two.md"]);
    // A relative reference resolves inside the final directory.
    expect(JSON.stringify(document.agent)).toContain(`{file:${config}/./p.md}`);
    // Readable by the server's uid, writable by no one else.
    expect((await stat(path.join(config, "opencode.jsonc"))).mode & 0o777).toBe(0o644);
    expect((await stat(config)).mode & 0o777).toBe(0o755);
    expect(await readdir(path.join(root, "home"))).toEqual([]);
    expect(await readdir(path.join(root, "config"))).toEqual([]);
    await expect(lstat(path.join(config, "node_modules"))).rejects.toThrow();
  });

  test("with no host configuration, only our plugins", async () => {
    const { root, exitCode } = await rebuild(async () => undefined);
    expect(exitCode).toBe(0);
    expect(await readdir(path.join(root, "opencode"))).toEqual(["plugins"]);
  });

  test("an unreadable merge leaves no user document behind, never the raw file", async () => {
    const { root, exitCode } = await rebuild(async (input) => {
      await mkdir(input, { recursive: true });
      await writeFile(path.join(input, "opencode.json"), "not json");
      await writeFile(path.join(input, "config.json"), '{"plugin":["x"]}');
    });
    expect(exitCode).toBe(0);
    const entries = await readdir(path.join(root, "opencode"));
    expect(entries).not.toContain("opencode.json");
    expect(entries).not.toContain("config.json");
    const merged = await readFile(path.join(root, "opencode", "opencode.jsonc"), "utf8");
    expect(merged).not.toContain('"plugin"');
  });

  test("refuses a root directory that is not root's", async () => {
    const directory = await scratch("ork-opencode2-refuse-");
    const result = Bun.spawnSync([
      "sh",
      "-c",
      openCode2LaunchConfigScript().replaceAll(
        OPENCODE2_LAUNCH_ROOT,
        path.join(directory, "missing"),
      ),
    ]);
    expect(result.exitCode).toBe(70);
  });
});
