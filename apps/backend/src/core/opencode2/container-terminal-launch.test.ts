import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTerminalAgentLaunchCommand } from "@orkestrator/protocol/terminal-agent-launch";
import { OPENCODE2_LAUNCH_CONFIG_DIR } from "../agent-credential-files.js";
import { OPENCODE2_DB_PATH, OPENCODE2_LEGACY_DB_PATH } from "../container-state-layout.js";
import {
  OPENCODE2_CONTAINER_CLI_PATH,
  OPENCODE2_CONTAINER_CONFIG_DIR,
} from "./container-server.js";
import {
  OPENCODE2_CONTAINER_TERMINAL_UNAVAILABLE,
  buildOpenCode2ContainerTerminalCommand,
  containerOpenCodeTerminalCommand,
} from "./container-terminal-launch.js";
import { OPENCODE2_FLAGS } from "./server.js";

// These tests run real shells; allow aggregate host load.
setDefaultTimeout(30_000);

const opencodeTab = (options: { model?: string; initialPrompt?: string } = {}) =>
  buildTerminalAgentLaunchCommand({ tabType: "opencode", ...options })!;

describe("containerOpenCodeTerminalCommand", () => {
  test("the renderer's OpenCode launch becomes the image's 2.x TUI, line ending kept", () => {
    const line = containerOpenCodeTerminalCommand(`${opencodeTab({ initialPrompt: "hi" })}\r\n`);
    expect(line.endsWith(" )\r\n")).toBe(true);
    expect(line).toContain(`'${OPENCODE2_CONTAINER_CLI_PATH}' --standalone --prompt 'hi'`);
    // The container server's database, never 1.x's `opencode.db`.
    expect(line).toContain(`export OPENCODE_DB=${OPENCODE2_DB_PATH}`);
    expect(line).toContain(`export OPENCODE_DB=${OPENCODE2_LEGACY_DB_PATH}`);
    expect(line).not.toContain("/opencode.db");
    expect(line).toContain(`'${OPENCODE2_LAUNCH_CONFIG_DIR}' '${OPENCODE2_CONTAINER_CONFIG_DIR}'`);
    expect(line).toContain(`OPENCODE_FLAGS='${OPENCODE2_FLAGS}'`);
    expect(line).toContain("OPENCODE_DISABLE_FILEWATCHER='1'");
    expect(line).not.toContain("--model");
    // Typed into an interactive shell: one line, nothing exported to it.
    expect(line.trimEnd()).not.toContain("\n");
    expect(line.startsWith("( ")).toBe(true);
  });

  test("the model goes through inline configuration; the default one adds nothing", () => {
    const withModel = containerOpenCodeTerminalCommand(opencodeTab({ model: "opencode/big" }));
    expect(withModel).toContain('model: "opencode/big"');
    expect(withModel).toContain("export OPENCODE_CONFIG_CONTENT &&");
    expect(withModel).not.toContain("--model");
    expect(containerOpenCodeTerminalCommand(opencodeTab({ model: "default" }))).not.toContain(
      "OPENCODE_CONFIG_CONTENT",
    );
  });

  test.each([
    ["a plain command", "ls -la\n"],
    ["a user's own OpenCode flags", "OPENCODE_DISABLE_AUTOUPDATE=1 opencode --continue\n"],
    [
      "a shell expansion the builder would have escaped",
      'OPENCODE_DISABLE_AUTOUPDATE=1 opencode --prompt "$(id)"',
    ],
  ])("%s is left alone", (_name, data) => {
    expect(containerOpenCodeTerminalCommand(data)).toBe(data);
  });

  test("only the agent's own user is rewritten, never a root terminal", () => {
    const tab = opencodeTab();
    expect(containerOpenCodeTerminalCommand(tab, "node")).not.toBe(tab);
    expect(containerOpenCodeTerminalCommand(tab, "orkroot")).toBe(tab);
    expect(containerOpenCodeTerminalCommand(tab, "root")).toBe(tab);
  });
});

describe("running the command", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /** The command with its fixed paths moved into a temporary directory, run by `sh`. */
  async function run(
    launch: { model?: string; initialPrompt?: string },
    options: { binary?: boolean; configDir?: boolean; env?: Record<string, string> } = {},
  ) {
    const directory = await mkdtemp(path.join(tmpdir(), "ork-opencode2-tab-"));
    directories.push(directory);
    const fake = path.join(directory, "opencode2");
    if (options.binary !== false) {
      await writeFile(fake, `#!/bin/sh\nprintf 'ARGS=%s\\n' "$*"\nenv | grep '^OPENCODE_'\n`);
      await chmod(fake, 0o755);
    }
    const configDir = path.join(directory, "config");
    if (options.configDir) await mkdir(configDir);
    const script = buildOpenCode2ContainerTerminalCommand(launch)
      .replaceAll(OPENCODE2_CONTAINER_CLI_PATH, fake)
      .replaceAll(OPENCODE2_LAUNCH_CONFIG_DIR, configDir)
      .replaceAll(OPENCODE2_CONTAINER_CONFIG_DIR, path.join(directory, "absent"))
      .replaceAll("/usr/local/bin/bun", process.execPath);
    const result = Bun.spawnSync(["/bin/sh", "-c", `${script}\necho "after=$OPENCODE_DB"`], {
      env: { PATH: "/usr/bin:/bin", ...options.env },
    });
    const stdout = result.stdout.toString();
    const env = Object.fromEntries(
      stdout
        .split("\n")
        .filter((line) => line.startsWith("OPENCODE_") || line.startsWith("ARGS="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { env, stdout, exitCode: result.exitCode, configDir };
  }

  test("starts the TUI with the server's storage and no server credential", async () => {
    const { env, stdout, configDir } = await run(
      { model: "fixture/model", initialPrompt: `it's "$HOME"` },
      {
        configDir: true,
        env: {
          OPENCODE_CONFIG_CONTENT: '{"theme":"mine"}',
          OPENCODE_SERVER_PASSWORD: "leaked",
          OPENCODE_PASSWORD: "leaked",
          OPENCODE_CONFIG: "/elsewhere.json",
        },
      },
    );
    expect(env.ARGS).toBe(`--standalone --prompt it's "$HOME"`);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      theme: "mine",
      model: "fixture/model",
    });
    expect(env.OPENCODE_CONFIG_DIR).toBe(configDir);
    // No persistent mount here: the runtime's own 2.x database.
    expect(env.OPENCODE_DB).toBe(OPENCODE2_LEGACY_DB_PATH);
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(env.OPENCODE_FLAGS).toBe(OPENCODE2_FLAGS);
    for (const name of ["OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD", "OPENCODE_CONFIG"]) {
      expect(env[name]).toBeUndefined();
    }
    // Nothing is left in the tab's shell.
    expect(stdout).toContain("after=\n");
  });

  test("before the server has written a configuration directory, none is named", async () => {
    const { env } = await run({});
    expect(env.ARGS).toBe("--standalone");
    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined();
  });

  test("malformed inline configuration starts nothing", async () => {
    const { env, exitCode } = await run(
      { model: "fixture/model" },
      { env: { OPENCODE_CONFIG_CONTENT: "[1]" } },
    );
    expect(env.ARGS).toBeUndefined();
    expect(exitCode).toBe(0);
  });

  test("an image without OpenCode 2 says so instead", async () => {
    const { stdout, env } = await run({}, { binary: false });
    expect(stdout).toContain(OPENCODE2_CONTAINER_TERMINAL_UNAVAILABLE);
    expect(env.ARGS).toBeUndefined();
  });
});
