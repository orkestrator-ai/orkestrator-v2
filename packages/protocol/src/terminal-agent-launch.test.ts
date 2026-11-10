import { describe, expect, test } from "bun:test";
import {
  buildTerminalAgentLaunchCommand,
  OPENCODE_PINNED_RUNTIME_ENV,
  parseTerminalOpenCodeLaunchCommand,
} from "./terminal-agent-launch.js";

describe("Claude terminal launch", () => {
  test("starts Ultracode with high CLI effort and the session flag", () => {
    expect(
      buildTerminalAgentLaunchCommand({
        tabType: "claude",
        model: "sonnet",
        reasoningEffort: "ultracode",
        fastMode: false,
      }),
    ).toContain('--effort "high" --settings "{\\"fastMode\\":false,\\"ultracode\\":true}"');
  });

  test("includes the Ultracode flag without a speed selection", () => {
    expect(
      buildTerminalAgentLaunchCommand({ tabType: "claude", reasoningEffort: "ultracode" }),
    ).toContain('--settings "{\\"ultracode\\":true}"');
  });
});

describe("OpenCode terminal launch", () => {
  test("disables OpenCode's update check on the command itself", () => {
    expect(
      buildTerminalAgentLaunchCommand({
        tabType: "opencode",
        model: "anthropic/claude-sonnet",
        initialPrompt: "Fix $HOME",
      }),
    ).toBe(
      'OPENCODE_DISABLE_AUTOUPDATE=1 opencode --model "anthropic/claude-sonnet" --prompt "Fix \\$HOME"',
    );
    expect(buildTerminalAgentLaunchCommand({ tabType: "opencode" })).toBe(
      "OPENCODE_DISABLE_AUTOUPDATE=1 opencode",
    );
    expect(OPENCODE_PINNED_RUNTIME_ENV).toEqual({ OPENCODE_DISABLE_AUTOUPDATE: "1" });
  });
});

describe("parseTerminalOpenCodeLaunchCommand", () => {
  test.each([
    {},
    { model: "opencode-go/claude-haiku-5-5" },
    { initialPrompt: "Hi" },
    { model: "provider/model'next", initialPrompt: 'Say "hi" to \\ $HOME and `id`\nthen stop' },
  ])("reads back what the builder wrote: %p", (launch) => {
    const line = buildTerminalAgentLaunchCommand({ tabType: "opencode", ...launch })!;
    for (const lineEnding of ["", "\n", "\r\n"]) {
      expect(parseTerminalOpenCodeLaunchCommand(`${line}${lineEnding}`)).toEqual({
        ...launch,
        lineEnding,
      });
    }
  });

  test("ignores the synthetic default model the builder omits", () => {
    const line = buildTerminalAgentLaunchCommand({ tabType: "opencode", model: "default" })!;
    expect(parseTerminalOpenCodeLaunchCommand(line)).toEqual({ lineEnding: "" });
  });

  test.each([
    'opencode --model "a/b"',
    "OPENCODE_DISABLE_AUTOUPDATE=1 opencode --continue",
    'OPENCODE_DISABLE_AUTOUPDATE=1 opencode --prompt "a"; rm -rf .',
    'OPENCODE_DISABLE_AUTOUPDATE=1 opencode --prompt "unterminated',
    'OPENCODE_DISABLE_AUTOUPDATE=1 opencode --prompt "bad \\q escape"',
    'OPENCODE_DISABLE_AUTOUPDATE=1 opencode --prompt "$HOME"',
    'OPENCODE_DISABLE_AUTOUPDATE=1 opencode --prompt "$(cat notes.txt)"',
    'OPENCODE_DISABLE_AUTOUPDATE=1 opencode --prompt "`whoami`"',
    'OPENCODE_DISABLE_AUTOUPDATE=1 opencode --model "$MODEL"',
    'OPENCODE_DISABLE_AUTOUPDATE=1 opencode --model "default"',
    'OPENCODE_DISABLE_AUTOUPDATE=1 opencode --prompt ""',
    "OPENCODE_DISABLE_AUTOUPDATE=1 opencode\n\n",
    "OPENCODE_DISABLE_AUTOUPDATE=1 opencode\nwhoami\n",
    'codex "Fix it"',
  ])("refuses anything the builder did not produce: %p", (data) => {
    expect(parseTerminalOpenCodeLaunchCommand(data)).toBeNull();
  });
});
