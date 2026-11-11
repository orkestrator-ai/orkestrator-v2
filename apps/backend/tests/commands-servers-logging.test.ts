import { describe, expect, mock, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { BRIDGE_LOG_RELAY_ENV } from "@orkestrator/protocol/node/logger-environment";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { stopLocalServerUnlocked } from "../src/core/commands-local-server-lifecycle.js";
import { startLocalServerUnlocked } from "../src/core/commands-servers.js";
import { createCommandFixtures } from "./command-fixtures.js";

const { createContext, createEnvironment, createTempDir, fs, path } = await createCommandFixtures();

describe("local server logging environment", () => {
  test.each(["claude", "codex", "cursor", "grok", "pi", "opencode"] as const)(
    "%s receives only its own relay setting",
    async (kind) => {
      const root = await createTempDir("ork-server-logging-");
      const bin = path.join(root, "bin");
      await fs.mkdir(bin);
      for (const name of ["bun", "claude", "codex", "grok", "pi", "opencode2"]) {
        await fs.writeFile(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }
      for (const bridge of ["claude", "codex", "cursor", "acp", "pi"]) {
        const dist = path.join(root, "bridges", `${bridge}-bridge`, "dist");
        await fs.mkdir(dist, { recursive: true });
        await fs.writeFile(path.join(dist, "index.js"), "export {};\n");
      }
      let spawnedEnv: NodeJS.ProcessEnv | undefined;
      const environment = createEnvironment({ worktreePath: root });
      const { context } = createContext(environment, {
        dataDir: path.join(root, "data"),
        runtimeOptions: {
          localServers: {
            spawn: (_command, _args, options) => {
              spawnedEnv = { ...options?.env };
              // Stop at the real spawn boundary without starting any provider.
              throw new Error("captured logging environment");
            },
          },
        },
      });
      context.appRoot = root;
      context.resourceRoot = root;
      context.toolchainBinDir = bin;
      const previous = process.env[BRIDGE_LOG_RELAY_ENV];
      process.env[BRIDGE_LOG_RELAY_ENV] = "1";
      try {
        await expect(startLocalServerUnlocked(environment.id, context, kind)).rejects.toThrow(
          "captured logging environment",
        );
        expect(spawnedEnv).toBeDefined();
        expect(spawnedEnv?.[BRIDGE_LOG_RELAY_ENV]).toBe(kind === "opencode" ? undefined : "1");
        expect(process.env[BRIDGE_LOG_RELAY_ENV]).toBe("1");
      } finally {
        if (previous === undefined) delete process.env[BRIDGE_LOG_RELAY_ENV];
        else process.env[BRIDGE_LOG_RELAY_ENV] = previous;
      }
    },
  );
});

describe("local bridge exit logging", () => {
  /** A real process that answers health checks, and exits with a code when asked to. */
  const FAKE_BRIDGE = `
    Bun.serve({
      hostname: "127.0.0.1",
      port: Number(process.env.PORT),
      fetch(request) {
        const code = new URL(request.url).searchParams.get("exit");
        if (code !== null) setTimeout(() => process.exit(Number(code)), 5);
        return Response.json({ healthy: true });
      },
    });
  `;

  /** A Codex environment whose bridge process is whatever `launch` starts. */
  async function codexEnvironment(
    prefix: string,
    launch: (root: string, env: NodeJS.ProcessEnv | undefined) => ChildProcessWithoutNullStreams,
  ) {
    const root = await createTempDir(prefix);
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    for (const name of ["bun", "codex"]) {
      await fs.writeFile(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    const dist = path.join(root, "bridges", "codex-bridge", "dist");
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(path.join(dist, "index.js"), "export {};\n");
    const environment = createEnvironment({ worktreePath: root });
    const reap = mock(async (_pid: number | undefined, _options: unknown) => "empty" as const);
    const { context } = createContext(environment, {
      dataDir: path.join(root, "data"),
      runtimeOptions: {
        localServers: {
          reapProcessGroup: reap,
          spawn: (_command, _args, options) => launch(root, options?.env),
        },
      },
    });
    context.appRoot = root;
    context.resourceRoot = root;
    context.toolchainBinDir = bin;
    return { context, environment, reap };
  }

  async function startBridge(prefix: string) {
    let child: ChildProcessWithoutNullStreams | undefined;
    const { context, environment, reap } = await codexEnvironment(prefix, (root, env) => {
      child = spawn(process.execPath, ["-e", FAKE_BRIDGE], {
        cwd: root,
        env,
        detached: true,
      }) as ChildProcessWithoutNullStreams;
      return child;
    });
    const started = (await startLocalServerUnlocked(environment.id, context, "codex")) as {
      port: number;
    };
    return { context, environment, port: started.port, child: child!, reap };
  }

  test.each([
    [0, "exits cleanly"],
    [3, "crashes"],
  ] as const)("a running bridge that %i %s warns with its code", async (code) => {
    const logs = captureLogs();
    try {
      const { child, port, environment, reap } = await startBridge("ork-bridge-exit-");
      const exited = once(child, "exit");
      await fetch(`http://127.0.0.1:${port}/?exit=${code}`);
      await exited;
      expect(reap).toHaveBeenCalledTimes(1);
      expect(reap.mock.calls[0]?.[0]).toBe(child.pid);
      const exits = logs.records().filter((record) => record.event === "bridge.exited");
      expect(exits).toMatchObject([
        {
          level: "warn",
          area: "local-server",
          fields: {
            key: `codex:${environment.id}`,
            pid: child.pid,
            code,
            signal: null,
            requested: false,
          },
        },
      ]);
    } finally {
      logs.restore();
    }
  });

  test("a bridge the backend stops logs info, with the signal that ended it", async () => {
    const logs = captureLogs();
    try {
      const { child, context, environment, reap } = await startBridge("ork-bridge-stop-");
      await stopLocalServerUnlocked(environment.id, context, "codex");
      expect(reap).not.toHaveBeenCalled();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      const exits = logs.records().filter((record) => record.event === "bridge.exited");
      expect(exits).toMatchObject([{ level: "info", fields: { pid: child.pid, requested: true } }]);
    } finally {
      logs.restore();
    }
  });

  test("replacement start terminates the old bridge without reaping it", async () => {
    const { child, context, environment, reap } = await startBridge("ork-bridge-replace-");
    try {
      const replacementRoot = await createTempDir("ork-bridge-replacement-cwd-");
      await context.storage.updateEnvironment(environment.id, { worktreePath: replacementRoot });
      await startLocalServerUnlocked(environment.id, context, "codex");
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(reap).not.toHaveBeenCalled();
    } finally {
      await stopLocalServerUnlocked(environment.id, context, "codex");
    }
    expect(reap).not.toHaveBeenCalled();
  });

  test("a bridge that dies before it is healthy still logs its code", async () => {
    const logs = captureLogs();
    try {
      const { context, environment } = await codexEnvironment(
        "ork-bridge-startup-exit-",
        (_root, env) =>
          spawn("/bin/sh", ["-c", "exit 7"], {
            env,
            detached: true,
          }) as ChildProcessWithoutNullStreams,
      );
      await expect(startLocalServerUnlocked(environment.id, context, "codex")).rejects.toThrow(
        "exited before becoming healthy",
      );
      const exits = logs.records().filter((record) => record.event === "bridge.exited");
      expect(exits).toMatchObject([{ level: "warn", fields: { code: 7, requested: false } }]);
    } finally {
      logs.restore();
    }
  });
});
