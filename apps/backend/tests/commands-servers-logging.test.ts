import { describe, expect, test } from "bun:test";
import { BRIDGE_LOG_RELAY_ENV } from "@orkestrator/protocol/node/logger-environment";
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
      for (const name of ["bun", "claude", "codex", "grok", "pi", "opencode"]) {
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
