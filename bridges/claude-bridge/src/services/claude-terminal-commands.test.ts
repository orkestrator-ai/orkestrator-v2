import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeOrkestratorDir, setClaudeHomeForTesting } from "./claude-home.js";
import {
  recordTerminalSlashCommands,
  rememberedTerminalSlashCommands,
  resetTerminalSlashCommandsForTesting,
  terminalSlashCommandWritesForTesting,
} from "./claude-terminal-commands.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "claude-terminal-commands-"));
  setClaudeHomeForTesting(home);
  resetTerminalSlashCommandsForTesting();
});

afterEach(async () => {
  await terminalSlashCommandWritesForTesting();
  resetTerminalSlashCommandsForTesting();
  setClaudeHomeForTesting(null);
  await rm(home, { recursive: true, force: true });
});

/** A new bridge process: nothing in memory, the same Claude home. */
function restartBridge(): void {
  resetTerminalSlashCommandsForTesting();
}

describe("remembered Claude terminal commands", () => {
  test("a recorded list is served for its own version only, and survives a restart", async () => {
    recordTerminalSlashCommands("2.1.296", ["focus", "color", "reload-plugins"]);
    await expect(rememberedTerminalSlashCommands("2.1.296")).resolves.toEqual([
      "focus",
      "color",
      "reload-plugins",
    ]);
    // An upgraded CLI may run some of these headless: never borrow a list.
    await expect(rememberedTerminalSlashCommands("2.1.297")).resolves.toBeUndefined();
    await expect(rememberedTerminalSlashCommands(undefined)).resolves.toBeUndefined();

    await terminalSlashCommandWritesForTesting();
    restartBridge();
    await expect(rememberedTerminalSlashCommands("2.1.296")).resolves.toEqual([
      "focus",
      "color",
      "reload-plugins",
    ]);
  });

  test("absent or malformed init fields record nothing", async () => {
    recordTerminalSlashCommands(undefined, ["focus"]);
    recordTerminalSlashCommands("2.1.296", undefined);
    recordTerminalSlashCommands("", ["focus"]);
    recordTerminalSlashCommands(42, ["focus"]);
    await terminalSlashCommandWritesForTesting();
    await expect(rememberedTerminalSlashCommands("2.1.296")).resolves.toBeUndefined();
    await expect(
      readFile(join(claudeOrkestratorDir(), "terminal-slash-commands.json")),
    ).rejects.toThrow();
  });

  test("the newest list per version wins, and only four versions are kept", async () => {
    recordTerminalSlashCommands("1", ["a"]);
    recordTerminalSlashCommands("1", ["a", "b", 7, ""]);
    for (const version of ["2", "3", "4", "5"]) recordTerminalSlashCommands(version, [version]);
    await terminalSlashCommandWritesForTesting();
    restartBridge();
    await expect(rememberedTerminalSlashCommands("1")).resolves.toBeUndefined();
    await expect(rememberedTerminalSlashCommands("5")).resolves.toEqual(["5"]);
    await expect(rememberedTerminalSlashCommands("2")).resolves.toEqual(["2"]);
  });

  test("keeps versions another bridge wrote to the shared file", async () => {
    await mkdir(claudeOrkestratorDir(), { recursive: true });
    await writeFile(
      join(claudeOrkestratorDir(), "terminal-slash-commands.json"),
      JSON.stringify({ versions: [{ version: "2.1.290", commands: ["doctor"] }] }),
    );
    recordTerminalSlashCommands("2.1.296", ["focus"]);
    await terminalSlashCommandWritesForTesting();
    restartBridge();
    await expect(rememberedTerminalSlashCommands("2.1.290")).resolves.toEqual(["doctor"]);
    await expect(rememberedTerminalSlashCommands("2.1.296")).resolves.toEqual(["focus"]);
  });

  test("an unreadable file is treated as empty and then repaired", async () => {
    await mkdir(claudeOrkestratorDir(), { recursive: true });
    const file = join(claudeOrkestratorDir(), "terminal-slash-commands.json");
    await writeFile(file, "{not json");
    await expect(rememberedTerminalSlashCommands("2.1.296")).resolves.toBeUndefined();
    recordTerminalSlashCommands("2.1.296", ["focus"]);
    await terminalSlashCommandWritesForTesting();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      versions: [{ version: "2.1.296", commands: ["focus"] }],
    });
  });
});
