import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPENCODE2_FLAGS,
  buildOpenCode2CredentialPluginSource,
  openCode2HostLaunch,
  openCode2HostPaths,
  waitForOpenCode2Ready,
  writeOpenCode2HostConfig,
} from "./server.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("openCode2HostLaunch", () => {
  test("gives 2.x its own database, config dir and password, and pins its behaviour", () => {
    const launch = openCode2HostLaunch({
      cliPath: "/toolchain/bin/opencode2",
      dataDir: "/data",
      configDir: "/data/opencode2/config",
      port: 41234,
      password: "secret",
      baseEnv: {
        PATH: "/usr/bin",
        OPENCODE_SERVER_PASSWORD: "stale-1x",
        OPENCODE_SERVER_USERNAME: "someone",
        UNSET: undefined,
      },
    });
    expect(launch.command).toBe("/toolchain/bin/opencode2");
    expect(launch.args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "41234"]);
    expect(launch.env).toEqual({
      PATH: "/usr/bin",
      OPENCODE_PASSWORD: "secret",
      OPENCODE_DB: path.join("/data", "opencode2", "opencode.db"),
      OPENCODE_CONFIG_DIR: "/data/opencode2/config",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_FLAGS: OPENCODE2_FLAGS,
    });
    expect(OPENCODE2_FLAGS.split(",")).toContain("-schedules");
  });

  test("the database never resolves to the user's shared opencode.db", () => {
    expect(openCode2HostPaths("/data").database).not.toContain(".local/share/opencode");
  });
});

describe("writeOpenCode2HostConfig", () => {
  test("writes the credential plugin as a directory plugin, owner-only", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-opencode2-config-"));
    dirs.push(dataDir);
    const configDir = await writeOpenCode2HostConfig(dataDir);
    const plugin = path.join(configDir, "plugins", "orkestrator-credential", "index.ts");
    const source = await readFile(plugin, "utf8");
    expect(source).toContain('"create.before"');
    expect(source).toContain("OPENCODE_PASSWORD");
    expect(source).not.toContain("import ");
    expect((await stat(plugin)).mode & 0o777).toBe(0o600);
    // Idempotent.
    await writeOpenCode2HostConfig(dataDir);
  });
});

describe("waitForOpenCode2Ready", () => {
  test("waits through failures and accepts only a 2.x version", async () => {
    let calls = 0;
    const info = await waitForOpenCode2Ready(
      {
        info: async () => {
          calls++;
          if (calls === 1) throw new Error("connection refused");
          if (calls === 2) return { version: "1.19.5" };
          return { version: "2.2.6" };
        },
      },
      { timeoutMs: 2_000, intervalMs: 1 },
    );
    expect(info.version).toBe("2.2.6");
    expect(calls).toBe(3);
  });

  test("gives up when the process exits or the deadline passes", async () => {
    const never = { info: async () => Promise.reject(new Error("down")) };
    await expect(
      waitForOpenCode2Ready(never, { timeoutMs: 5_000, intervalMs: 1, isAlive: () => false }),
    ).rejects.toThrow("exited before it was ready");
    await expect(waitForOpenCode2Ready(never, { timeoutMs: 20, intervalMs: 5 })).rejects.toThrow(
      "did not become ready",
    );
  });
});

describe("buildOpenCode2CredentialPluginSource", () => {
  type Hook = (event: { env: Record<string, string | undefined> }) => unknown;

  /**
   * Run a plugin source's `setup` against a stand-in context and process. The
   * module's own `process` is shadowed, so the test process is never changed.
   */
  async function runSetup(source: string, platform: string) {
    const dir = await mkdtemp(path.join(tmpdir(), "ork-opencode2-plugin-"));
    dirs.push(dir);
    const fakeProcess = {
      platform,
      env: { OPENCODE_PASSWORD: "pw", OPENCODE_SERVER_PASSWORD: "pw", KEEP: "1" } as Record<
        string,
        string | undefined
      >,
      stderr: { write: () => true },
    };
    const key = `__orkPluginProcess${Math.random().toString(36).slice(2)}`;
    (globalThis as Record<string, unknown>)[key] = fakeProcess;
    const file = path.join(dir, "index.ts");
    // A library that cannot load stands for a kernel that refuses the flag.
    await Bun.write(
      file,
      `const process = globalThis[${JSON.stringify(key)}];\n${source.replace('"libc.so.6"', '"/nonexistent/libc.so.6"')}`,
    );
    const hooks: Record<string, Hook[]> = {};
    const hook = (domain: string) => async (name: string, callback: Hook) => {
      (hooks[`${domain}:${name}`] ??= []).push(callback);
    };
    try {
      const plugin = (await import(file)).default as {
        id: string;
        setup(ctx: unknown): Promise<void>;
      };
      await plugin.setup({ shell: { hook: hook("shell") }, tool: { hook: hook("tool") } });
      return { plugin, hooks, env: fakeProcess.env };
    } finally {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }

  test("the host form removes the password from the process and every shell", async () => {
    const { plugin, hooks, env } = await runSetup(buildOpenCode2CredentialPluginSource(), "darwin");
    expect(plugin.id).toBe("orkestrator-credential");
    expect(env).toEqual({ KEEP: "1" });
    const shell = {
      env: { OPENCODE_PASSWORD: "pw", OPENCODE_SERVER_PASSWORD: "pw", PATH: "/bin" } as Record<
        string,
        string | undefined
      >,
    };
    for (const callback of hooks["shell:create.before"] ?? []) await callback(shell);
    expect(shell.env).toEqual({ PATH: "/bin" });
    expect(hooks["tool:execute.before"]).toBeUndefined();
  });

  test("the container form refuses every tool on a Linux server it cannot harden", async () => {
    const source = buildOpenCode2CredentialPluginSource({ hardened: "refuse-tools" });
    expect(source).toContain("PR_SET_DUMPABLE");
    const { hooks, env } = await runSetup(source, "linux");
    expect(env).toEqual({ KEEP: "1" });
    const [refuse] = hooks["tool:execute.before"] ?? [];
    expect(refuse).toBeDefined();
    expect(() => refuse!({ env: {} })).toThrow("Refusing to run tools");
    const shell = { env: { OPENCODE_PASSWORD: "pw" } as Record<string, string | undefined> };
    for (const callback of hooks["shell:create.before"] ?? []) await callback(shell);
    expect(shell.env).toEqual({});
  });

  test("the container form leaves tools alone where there is no /proc to protect", async () => {
    const { hooks } = await runSetup(
      buildOpenCode2CredentialPluginSource({ hardened: "refuse-tools" }),
      "darwin",
    );
    expect(hooks["tool:execute.before"]).toBeUndefined();
    expect(hooks["shell:create.before"]).toHaveLength(1);
  });
});
