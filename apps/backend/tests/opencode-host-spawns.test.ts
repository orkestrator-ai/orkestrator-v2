import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildTerminalAgentLaunchCommand } from "@orkestrator/protocol/terminal-agent-launch";
import { SETUP_DONE_OSC_SEQUENCE } from "../src/core/container-scripts";
import { spawnSetupTerminal } from "../src/core/commands-environment";
import { startLocalServerUnlocked } from "../src/core/commands-servers";
import { createCommandFixtures } from "./command-fixtures";

const {
  createContext,
  createEnvironment,
  createTempDir,
  createCommandRegistry,
  createDeferred,
  fs,
  path,
  ptySpawn,
  ptyProcesses,
  terminalSessionResult,
} = await createCommandFixtures();

/**
 * OpenCode at host spawn boundaries: terminal tabs run the managed `opencode2`
 * TUI on the host server's storage (`opencode2/terminal-launch.ts`), plain
 * shells keep the user's defaults, and only the OpenCode server is given a
 * database (`opencode2/host-launch.ts`).
 */
describe("host OpenCode at spawn boundaries", () => {
  let root: string;
  let bin: string;
  let previous: NodeJS.ProcessEnv;
  beforeEach(async () => {
    previous = { ...process.env };
    root = await createTempDir("ork-opencode-spawns-");
    process.env.XDG_DATA_HOME = path.join(root, "xdg");
    process.env.XDG_CONFIG_HOME = path.join(root, "xdg-config");
    delete process.env.OPENCODE_DB;
    bin = path.join(root, "toolchain bin");
    await fs.mkdir(bin, { recursive: true });
  });
  afterEach(() => {
    for (const name of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "OPENCODE_DB"]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });

  async function installOpenCode2() {
    await fs.writeFile(path.join(bin, "opencode2"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }

  test.each(["plain", "codex", "opencode"] as const)(
    "%s shell keeps defaults; only the OpenCode bootstrap is rewritten",
    async (tabType) => {
      await installOpenCode2();
      const dataDir = path.join(root, "data");
      const environment = createEnvironment({ worktreePath: root });
      const { context } = createContext(environment, { dataDir });
      context.toolchainBinDir = bin;
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
      const written = ptyProcesses.at(-1)!.write.mock.calls[0]?.[0] as string;
      if (tabType === "opencode") {
        expect(written).toContain(
          `OPENCODE_DB='${path.join(dataDir, "opencode2", "opencode.db")}'`,
        );
        expect(written).toContain("OPENCODE_DISABLE_FILEWATCHER='1'");
        expect(written).toEndWith(
          `'${path.join(bin, "opencode2")}' --standalone --prompt 'Check'\n`,
        );
      } else expect(written).toBe(data);
      await commands.get("bootstrap_terminal_session")!({ sessionId, data }, context);
      expect(ptyProcesses.at(-1)!.write).toHaveBeenCalledTimes(1);
      // Subsequent user input is untouched, including a user's own OpenCode.
      commands.get("local_terminal_write")!({ sessionId, data: "opencode\n" }, context);
      expect(ptyProcesses.at(-1)!.write).toHaveBeenLastCalledWith("opencode\n");
    },
  );

  test.each([
    { installed: true, expected: "managed" },
    { installed: false, expected: "missing" },
  ] as const)("a new OpenCode tab runs the managed TUI: %p", async ({ installed, expected }) => {
    if (installed) await installOpenCode2();
    const dataDir = path.join(root, "data");
    const environment = createEnvironment({ worktreePath: root });
    const { context } = createContext(environment, { dataDir });
    context.toolchainBinDir = bin;
    const commands = createCommandRegistry();
    const { sessionId } = terminalSessionResult(
      await commands.get("create_local_terminal_session")!(
        { environmentId: environment.id, cols: 80, rows: 24 },
        context,
      ),
    );
    await commands.get("start_local_terminal_session")!({ sessionId }, context);
    const data = `${buildTerminalAgentLaunchCommand({
      tabType: "opencode",
      model: "opencode-go/claude-haiku-5-5",
      initialPrompt: "Hi",
    })}\n`;
    expect(await commands.get("bootstrap_terminal_session")!({ sessionId, data }, context)).toEqual(
      { bootstrapped: true, delivered: true, duplicate: false },
    );
    const written = ptyProcesses.at(-1)!.write.mock.calls[0]?.[0] as string;
    expect(written).toEndWith("\n");
    if (expected === "managed") {
      expect(written).toContain("env -u OPENCODE_CONFIG ");
      expect(written).toContain(`OPENCODE_DB='${path.join(dataDir, "opencode2", "opencode.db")}'`);
      expect(written).toContain('model: "opencode-go/claude-haiku-5-5"');
      expect(written).toEndWith(`'${path.join(bin, "opencode2")}' --standalone --prompt 'Hi' )\n`);
      expect(written).not.toContain("--model");
      // The tab shares the host servers' configuration directory.
      expect(
        await fs.stat(path.join(dataDir, "opencode2", "config")).then((s) => s.isDirectory()),
      ).toBe(true);
    } else {
      expect(written).toStartWith("printf '%s\\n' 'OpenCode is not installed yet.");
    }
    // A replay is a duplicate of the original launch data, not of the rewrite.
    expect(
      await commands.get("bootstrap_terminal_session")!({ sessionId, data }, context),
    ).toMatchObject({ duplicate: true, matchesExisting: true });
    expect(ptyProcesses.at(-1)!.write).toHaveBeenCalledTimes(1);
  });

  async function pausedBootstrap() {
    const environment = createEnvironment({ worktreePath: root });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const { sessionId } = terminalSessionResult(
      await commands.get("create_local_terminal_session")!(
        { environmentId: environment.id, terminalKey: "opencode-tab", cols: 80, rows: 24 },
        context,
      ),
    );
    await commands.get("start_local_terminal_session")!({ sessionId }, context);
    // The rewrite reads the environment first; holding that read holds the bootstrap.
    const loadEnvironment = context.storage.getEnvironment.bind(context.storage);
    const config = await loadEnvironment(environment.id);
    const gate = createDeferred<typeof config>();
    context.storage.getEnvironment = (() => gate.promise) as typeof context.storage.getEnvironment;
    const loadConfig = loadEnvironment;
    const data = `${buildTerminalAgentLaunchCommand({ tabType: "opencode" })}\n`;
    const args = { sessionId, data };
    const bootstrap = () => commands.get("bootstrap_terminal_session")!(args, context);
    const snapshot = () => commands.get("get_terminal_session")!({ sessionId }, context);
    return { context, commands, sessionId, config, gate, args, bootstrap, snapshot, loadConfig };
  }

  test("rehydration and concurrent retries wait for delivery before reporting bootstrap success", async () => {
    const f = await pausedBootstrap();
    const first = f.bootstrap();
    // Another renderer/registry rehydrates while the initiating renderer is gone.
    expect(f.snapshot()).toMatchObject({ bootstrapped: false });
    const retry = createCommandRegistry().get("bootstrap_terminal_session")!(f.args, f.context);
    const different = f.commands.get("bootstrap_terminal_session")!(
      { sessionId: f.sessionId, data: "other command\n" },
      f.context,
    );
    let retrySettled = false;
    void Promise.resolve(retry).then(() => {
      retrySettled = true;
    });
    await Promise.resolve();
    expect(retrySettled).toBe(false);
    expect(ptyProcesses.at(-1)!.write).not.toHaveBeenCalled();
    f.gate.resolve(f.config);
    expect(await first).toMatchObject({ bootstrapped: true, delivered: true, duplicate: false });
    expect(await retry).toMatchObject({
      bootstrapped: true,
      duplicate: true,
      matchesExisting: true,
    });
    expect(await different).toMatchObject({ duplicate: true, matchesExisting: false });
    expect(f.snapshot()).toMatchObject({ bootstrapped: true });
    expect(ptyProcesses.at(-1)!.write).toHaveBeenCalledTimes(1);
  });

  test("overlapping requests share a write failure and can retry after it", async () => {
    const f = await pausedBootstrap();
    ptyProcesses.at(-1)!.write.mockImplementationOnce(() => {
      throw new Error("PTY write failed");
    });
    const results = Promise.allSettled([f.bootstrap(), f.bootstrap()]);
    f.gate.resolve(f.config);
    for (const result of await results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.message).toBe("PTY write failed");
    }
    expect(f.snapshot()).toMatchObject({ bootstrapped: false });
    f.context.storage.getEnvironment = f.loadConfig;
    expect(await f.bootstrap()).toMatchObject({ bootstrapped: true, delivered: true });
  });

  test("configuration preparation failure rejects every waiter without consuming bootstrap", async () => {
    const f = await pausedBootstrap();
    await installOpenCode2();
    f.context.toolchainBinDir = bin;
    const blocker = path.join(f.context.storage.getDataDir(), "opencode2");
    await fs.mkdir(path.dirname(blocker), { recursive: true });
    await fs.writeFile(blocker, "not a directory");
    const results = Promise.allSettled([f.bootstrap(), f.bootstrap()]);
    f.gate.resolve(f.config);
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(f.snapshot()).toMatchObject({ bootstrapped: false });
    expect(ptyProcesses.at(-1)!.write).not.toHaveBeenCalled();
    await fs.rm(blocker);
    f.context.storage.getEnvironment = f.loadConfig;
    expect(await f.bootstrap()).toMatchObject({ bootstrapped: true, delivered: true });
    expect(ptyProcesses.at(-1)!.write).toHaveBeenCalledTimes(1);
  });

  test.each(["resolve", "reject"])(
    "a replaced PTY keeps its own bootstrap when old preparation ends: %s",
    async (outcome) => {
      const f = await pausedBootstrap();
      const oldProcess = ptyProcesses.at(-1)!;
      const first = f.bootstrap();
      const retry = f.bootstrap();
      oldProcess.emitExit({ exitCode: 0 });
      f.context.storage.getEnvironment = f.loadConfig;
      await f.commands.get("start_local_terminal_session")!({ sessionId: f.sessionId }, f.context);
      const replacement = ptyProcesses.at(-1)!;
      expect(replacement).not.toBe(oldProcess);
      const replacementArgs = { sessionId: f.sessionId, data: "codex\n" };
      expect(
        await f.commands.get("bootstrap_terminal_session")!(replacementArgs, f.context),
      ).toMatchObject({ bootstrapped: true, delivered: true });
      if (outcome === "resolve") f.gate.resolve(f.config);
      else f.gate.reject(new Error("Configuration read failed"));
      for (const result of await Promise.all([first, retry])) {
        expect(result).toMatchObject({ bootstrapped: false, delivered: false });
      }
      expect(oldProcess.write).not.toHaveBeenCalled();
      expect(replacement.write).toHaveBeenCalledTimes(1);
      expect(f.snapshot()).toMatchObject({ bootstrapped: true });
      expect(
        await f.commands.get("bootstrap_terminal_session")!(replacementArgs, f.context),
      ).toMatchObject({ duplicate: true, matchesExisting: true });
    },
  );

  test("closing during preparation prevents delivery and does not resurrect the terminal", async () => {
    const f = await pausedBootstrap();
    const process = ptyProcesses.at(-1)!;
    const first = f.bootstrap();
    await f.commands.get("close_local_terminal_session")!({ sessionId: f.sessionId }, f.context);
    f.gate.resolve(f.config);
    expect(await first).toMatchObject({ bootstrapped: false, delivered: false });
    expect(process.write).not.toHaveBeenCalled();
    expect(f.context.runtime.terminals.sessionConfig(f.sessionId)).toBeUndefined();
  });

  test("setup shell gets no database but hands off to the managed OpenCode", async () => {
    await installOpenCode2();
    const environment = createEnvironment({ worktreePath: root });
    const { context } = createContext(environment);
    context.toolchainBinDir = bin;
    const { sessionId, completion } = await spawnSetupTerminal(environment, [], context);
    expect(
      (ptySpawn.mock.calls.at(-1)?.[2]?.env as NodeJS.ProcessEnv | undefined)?.OPENCODE_DB,
    ).toBeUndefined();
    const data = `${buildTerminalAgentLaunchCommand({ tabType: "opencode" })}\n`;
    await createCommandRegistry().get("bootstrap_terminal_session")!({ sessionId, data }, context);
    expect(ptyProcesses.at(-1)!.write.mock.calls[0]?.[0]).toContain(
      `'${path.join(bin, "opencode2")}' --standalone`,
    );
    ptyProcesses.at(-1)!.emitData(SETUP_DONE_OSC_SEQUENCE);
    expect(await completion).toBe(true);
    ptyProcesses.at(-1)!.emitExit({ exitCode: 0 });
  });

  test.each(["opencode", "claude", "codex", "cursor", "grok", "pi"] as const)(
    "%s server receives only its own database setting",
    async (kind) => {
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
        kind === "opencode" ? path.join(root, "data", "opencode2", "opencode.db") : undefined,
      );
      expect(process.env.OPENCODE_DB).toBeUndefined();
    },
  );
});
