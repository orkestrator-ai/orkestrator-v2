import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildOpenCodeCredentialPluginSource } from "./agent-credential-files.js";
import { writeHostOpenCodeCredentialPlugin } from "./opencode-host-credential.js";

const FAKE_PASSWORD = "fake-password-for-a-test";
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ork-opencode-credential-"));
  directories.push(directory);
  return directory;
}

/**
 * Load the plugin the way OpenCode does, under Bun, in a process of its own: it
 * marks whatever loads it non-dumpable. Prints what the process then looks like.
 */
async function runPlugin(source: string): Promise<{
  env: string | null;
  childEnv: string;
  dumpable: number;
  hooks: string[];
  toolError: string | null;
}> {
  const directory = await temporaryDirectory();
  const plugin = path.join(directory, "plugin.js");
  await writeFile(plugin, source);
  const runner = path.join(directory, "runner.js");
  await writeFile(
    runner,
    `import { dlopen, FFIType } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { OrkestratorCredentialPlugin } from ${JSON.stringify(plugin)};
const hooks = await OrkestratorCredentialPlugin();
const libc = dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });
const child = spawnSync("sh", ["-c", "printf %s \\"$OPENCODE_SERVER_PASSWORD\\""]);
let toolError = null;
try { await hooks["tool.execute.before"]?.(); } catch (error) { toolError = error.message; }
console.log(JSON.stringify({
  env: process.env.OPENCODE_SERVER_PASSWORD ?? null,
  childEnv: child.stdout.toString(),
  dumpable: libc.symbols.prctl(3, 0n, 0n, 0n, 0n),
  hooks: Object.keys(hooks),
  toolError,
}));
`,
  );
  const result = Bun.spawnSync([process.execPath, runner], {
    env: { PATH: process.env.PATH, OPENCODE_SERVER_PASSWORD: FAKE_PASSWORD },
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

describe.skipIf(process.platform !== "linux")("the OpenCode credential plugin", () => {
  test("takes the password from the environment and marks the server non-dumpable", async () => {
    expect(await runPlugin(buildOpenCodeCredentialPluginSource("refuse-tools"))).toEqual({
      env: null,
      childEnv: "",
      dumpable: 0,
      hooks: [],
      toolError: null,
    });
  });

  /** libc that cannot load stands in for any reason the flag cannot be set. */
  const unhardenable = (mode: "refuse-tools" | "log") =>
    buildOpenCodeCredentialPluginSource(mode).replace("libc.so.6", "libnot-a-real-library.so");

  test("a container server it could not harden refuses tools", async () => {
    const result = await runPlugin(unhardenable("refuse-tools"));
    expect(result).toMatchObject({ env: null, dumpable: 1 });
    expect(result.toolError).toContain("Refusing to run tools");
  });

  test("a host server it could not harden keeps running, as a bridge does", async () => {
    expect(await runPlugin(unhardenable("log"))).toMatchObject({
      env: null,
      dumpable: 1,
      hooks: [],
      toolError: null,
    });
  });
});

test("the host plugin is written whole, private, and again on each start", async () => {
  const dataDir = await temporaryDirectory();
  const configDir = await writeHostOpenCodeCredentialPlugin(dataDir);
  expect(configDir).toBe(path.join(dataDir, "opencode-host-config"));
  const plugin = path.join(configDir, "plugins", "orkestrator-credential.js");
  await writeFile(plugin, "stale");
  await writeHostOpenCodeCredentialPlugin(dataDir);
  expect(await readFile(plugin, "utf8")).toBe(buildOpenCodeCredentialPluginSource("log"));
  expect((await stat(plugin)).mode & 0o777).toBe(0o600);
});

test("concurrent host starts install a complete private plugin", async () => {
  const dataDir = await temporaryDirectory();
  const results = await Promise.all(
    Array.from({ length: 32 }, () => writeHostOpenCodeCredentialPlugin(dataDir)),
  );
  expect(new Set(results).size).toBe(1);
  const plugin = path.join(results[0]!, "plugins", "orkestrator-credential.js");
  expect(await readFile(plugin, "utf8")).toBe(buildOpenCodeCredentialPluginSource("log"));
  expect((await stat(plugin)).mode & 0o777).toBe(0o600);
});

describe.skipIf(process.platform !== "linux")("a launched server's credential plugin", () => {
  /**
   * The server `orkestrator-bridge-launch opencode` starts has only the
   * launcher's environment; the plugin applies what the start script recorded,
   * for the tools it spawns, and nothing that steers OpenCode itself.
   */
  test("applies the recorded environment for tools, refusing OpenCode's flags and the launcher's values", async () => {
    const directory = await temporaryDirectory();
    const snapshot = path.join(directory, "snapshot");
    await writeFile(
      snapshot,
      [
        "PATH=/opt/project/bin:/usr/bin:/bin",
        "PROJECT_SETTING=from the start script",
        "OPENCODE_CONFIG_DIR=/workspace/.opencode",
        "OPENCODE_DISABLE_PROJECT_CONFIG=",
        "OPENCODE_TEST_HOME=/home/node",
        "OPENCODE_SERVER_PASSWORD=caught",
        "ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT=/tmp/other",
        "LAUNCHER_VALUE=from the snapshot",
        "NODE_PATH=/workspace/node_modules",
        "PWD=/somewhere",
        "",
      ].join("\0"),
    );
    const plugin = path.join(directory, "plugin.js");
    await writeFile(
      plugin,
      buildOpenCodeCredentialPluginSource("refuse-tools", { applyLaunchEnvironment: true }),
    );
    const runner = path.join(directory, "runner.js");
    await writeFile(
      runner,
      `import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { OrkestratorCredentialPlugin } from ${JSON.stringify(plugin)};
await OrkestratorCredentialPlugin();
const tool = spawnSync("sh", ["-c", "env"], { env: process.env }).stdout.toString();
const pick = (name) => process.env[name] ?? null;
console.log(JSON.stringify({
  snapshotRemoved: !existsSync(${JSON.stringify(snapshot)}),
  password: pick("OPENCODE_SERVER_PASSWORD"),
  path: pick("PATH"),
  project: pick("PROJECT_SETTING"),
  configDir: pick("OPENCODE_CONFIG_DIR"),
  disableProject: pick("OPENCODE_DISABLE_PROJECT_CONFIG"),
  testHome: pick("OPENCODE_TEST_HOME"),
  xdgConfig: pick("XDG_CONFIG_HOME"),
  launcherValue: pick("LAUNCHER_VALUE"),
  nodePath: pick("NODE_PATH"),
  launchVariables: Object.keys(process.env).filter((name) => name.startsWith("ORKESTRATOR_BRIDGE_LAUNCH")),
  toolSeesProject: tool.includes("PROJECT_SETTING=from the start script"),
  toolSeesPassword: tool.includes("OPENCODE_SERVER_PASSWORD"),
}));
`,
    );
    const result = Bun.spawnSync([process.execPath, runner], {
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        OPENCODE_SERVER_PASSWORD: FAKE_PASSWORD,
        ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT: snapshot,
        ORKESTRATOR_BRIDGE_LAUNCH_KEYS: "OPENCODE_SERVER_PASSWORD,LAUNCHER_VALUE",
        LAUNCHER_VALUE: "from the backend",
        XDG_CONFIG_HOME: "/run/orkestrator-opencode/config",
        OPENCODE_TEST_HOME: "/run/orkestrator-opencode/home",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      snapshotRemoved: true,
      password: null,
      path: "/opt/project/bin:/usr/bin:/bin",
      project: "from the start script",
      configDir: null,
      disableProject: "1",
      testHome: "/run/orkestrator-opencode/home",
      xdgConfig: null,
      launcherValue: "from the backend",
      nodePath: null,
      launchVariables: [],
      toolSeesProject: true,
      toolSeesPassword: false,
    });
  });

  test("a symlinked snapshot is not followed, and the plugin still hardens the server", async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, "elsewhere");
    await writeFile(target, "PROJECT_SETTING=through a link\0");
    const snapshot = path.join(directory, "snapshot");
    await symlink(target, snapshot);
    const plugin = path.join(directory, "plugin.js");
    await writeFile(
      plugin,
      buildOpenCodeCredentialPluginSource("refuse-tools", { applyLaunchEnvironment: true }),
    );
    const runner = path.join(directory, "runner.js");
    await writeFile(
      runner,
      `import { dlopen, FFIType } from "bun:ffi";
import { OrkestratorCredentialPlugin } from ${JSON.stringify(plugin)};
await OrkestratorCredentialPlugin();
const libc = dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });
console.log(JSON.stringify({ project: process.env.PROJECT_SETTING ?? null, dumpable: libc.symbols.prctl(3, 0n, 0n, 0n, 0n) }));
`,
    );
    const result = Bun.spawnSync([process.execPath, runner], {
      env: { PATH: process.env.PATH, ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT: snapshot },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ project: null, dumpable: 0 });
  });

  test.each(["fifo", "missing", "read-error"])(
    "%s snapshot cannot block or bypass hardening",
    async (kind) => {
      const directory = await temporaryDirectory();
      const snapshot = path.join(directory, "snapshot");
      if (kind === "fifo") {
        expect(Bun.spawnSync(["mkfifo", snapshot]).exitCode).toBe(0);
      } else if (kind === "read-error") {
        await writeFile(snapshot, "PROJECT_SETTING=must not apply\0");
      }
      let source = buildOpenCodeCredentialPluginSource("refuse-tools", {
        applyLaunchEnvironment: true,
      });
      // Assert the flag at the first untrusted access, not just after the plugin returns.
      source = source.replace(
        "function readSnapshot(file) {",
        `function readSnapshot(file) {
        const { dlopen, FFIType } = globalThis.testFFI;
        const libc = dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });
        try { if (libc.symbols.prctl(3, 0n, 0n, 0n, 0n) !== 0) throw new Error("snapshot accessed before hardening"); }
        finally { libc.close(); }
      `,
      );
      if (kind === "read-error")
        source = source.replace(
          "const read = readSync(",
          "const read = (() => { throw new Error('injected read failure'); })(",
        );
      const plugin = path.join(directory, "plugin.js");
      await writeFile(plugin, source);
      const runner = path.join(directory, "runner.js");
      await writeFile(
        runner,
        `
        globalThis.testFFI = await import("bun:ffi");
        const { OrkestratorCredentialPlugin } = await import(${JSON.stringify(plugin)});
        const hooks = await OrkestratorCredentialPlugin();
        if (process.env.PROJECT_SETTING || process.env.OPENCODE_SERVER_PASSWORD) throw new Error("snapshot consumed or password retained");
        console.log(JSON.stringify(Object.keys(hooks)));
      `,
      );
      const child = Bun.spawn([process.execPath, runner], {
        env: {
          PATH: process.env.PATH,
          OPENCODE_SERVER_PASSWORD: FAKE_PASSWORD,
          ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT: snapshot,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const deadline = setTimeout(() => child.kill(), 3000);
      try {
        expect(await child.exited).toBe(0);
        expect(await new Response(child.stdout).text()).toBe("[]\n");
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    },
  );

  test("a server the launcher did not start has nothing to apply", () => {
    expect(buildOpenCodeCredentialPluginSource("refuse-tools")).not.toContain(
      "applyLaunchEnvironment",
    );
  });
});
