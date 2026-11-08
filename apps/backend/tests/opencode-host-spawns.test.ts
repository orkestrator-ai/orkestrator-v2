import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildTerminalAgentLaunchCommand } from "@orkestrator/protocol/terminal-agent-launch";
import { SETUP_DONE_OSC_SEQUENCE } from "../src/core/container-scripts";
import { spawnSetupTerminal } from "../src/core/commands-environment";
import { startLocalServerUnlocked } from "../src/core/commands-servers";
import { ORKESTRATOR_OPENCODE_DB_FILE } from "../src/core/opencode-host-database";
import { createCommandFixtures } from "./command-fixtures";

const {
  createContext,
  createEnvironment,
  createTempDir,
  createCommandRegistry,
  fs,
  path,
  ptySpawn,
  ptyProcesses,
  terminalSessionResult,
} = await createCommandFixtures();

describe("host OpenCode database at spawn boundaries", () => {
  let root: string;
  let previous: NodeJS.ProcessEnv;
  beforeEach(async () => {
    previous = { ...process.env };
    root = await createTempDir("ork-opencode-spawns-");
    process.env.XDG_DATA_HOME = path.join(root, "xdg");
    delete process.env.OPENCODE_DB;
    const directory = path.join(process.env.XDG_DATA_HOME, "opencode");
    await fs.mkdir(directory, { recursive: true });
    const database = new Database(path.join(directory, "opencode.db"), { create: true });
    database.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)");
    database.close();
  });
  afterEach(() => {
    for (const name of ["XDG_DATA_HOME", "OPENCODE_DB"]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });

  test.each(["plain", "codex", "opencode"] as const)(
    "%s shell keeps defaults; only managed OpenCode bootstrap receives the override",
    async (tabType) => {
      const environment = createEnvironment({ worktreePath: root });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const { sessionId } = terminalSessionResult(
        await commands.get("create_local_terminal_session")!(
          { environmentId: environment.id, cols: 80, rows: 24 },
          context,
        ),
      );
      await commands.get("start_local_terminal_session")!({ sessionId }, context);
      expect(
        (ptySpawn.mock.calls.at(-1)?.[2]?.env as NodeJS.ProcessEnv | undefined)?.OPENCODE_DB,
      ).toBeUndefined();
      const data = `${buildTerminalAgentLaunchCommand({ tabType, initialPrompt: "Check" }) ?? "pwd"}\n`;
      await commands.get("bootstrap_terminal_session")!({ sessionId, data }, context);
      const written = ptyProcesses.at(-1)!.write.mock.calls[0]?.[0];
      if (tabType === "opencode") {
        expect(written).toStartWith(`OPENCODE_DB='${ORKESTRATOR_OPENCODE_DB_FILE}' `);
        expect(written).toEndWith(data);
      } else expect(written).toBe(data);
      await commands.get("bootstrap_terminal_session")!({ sessionId, data }, context);
      expect(ptyProcesses.at(-1)!.write).toHaveBeenCalledTimes(1);
      // Subsequent user input is untouched, including a user's own OpenCode.
      commands.get("local_terminal_write")!({ sessionId, data: "opencode\n" }, context);
      expect(ptyProcesses.at(-1)!.write).toHaveBeenLastCalledWith("opencode\n");
    },
  );

  test("setup shell excludes the override but supports managed OpenCode handoff", async () => {
    const environment = createEnvironment({ worktreePath: root });
    const { context } = createContext(environment);
    const { sessionId, completion } = await spawnSetupTerminal(environment, [], context);
    expect(
      (ptySpawn.mock.calls.at(-1)?.[2]?.env as NodeJS.ProcessEnv | undefined)?.OPENCODE_DB,
    ).toBeUndefined();
    const data = `${buildTerminalAgentLaunchCommand({ tabType: "opencode" })}\n`;
    await createCommandRegistry().get("bootstrap_terminal_session")!({ sessionId, data }, context);
    expect(ptyProcesses.at(-1)!.write.mock.calls[0]?.[0]).toStartWith(
      `OPENCODE_DB='${ORKESTRATOR_OPENCODE_DB_FILE}' `,
    );
    ptyProcesses.at(-1)!.emitData(SETUP_DONE_OSC_SEQUENCE);
    expect(await completion).toBe(true);
    ptyProcesses.at(-1)!.emitExit({ exitCode: 0 });
  });

  test.each(["opencode", "claude", "codex", "cursor", "grok", "pi"] as const)(
    "%s server receives only its own database setting",
    async (kind) => {
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
              throw new Error("captured spawn");
            },
          },
        },
      });
      context.appRoot = root;
      context.resourceRoot = root;
      context.toolchainBinDir = bin;
      await expect(startLocalServerUnlocked(environment.id, context, kind)).rejects.toThrow(
        "captured spawn",
      );
      expect(spawnedEnv).toBeDefined();
      expect(spawnedEnv?.OPENCODE_DB).toBe(
        kind === "opencode" ? ORKESTRATOR_OPENCODE_DB_FILE : undefined,
      );
      expect(process.env.OPENCODE_DB).toBeUndefined();
    },
  );
});
