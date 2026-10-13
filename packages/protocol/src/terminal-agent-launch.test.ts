import { describe, expect, test } from "bun:test";
import {
  buildTerminalAgentLaunchCommand,
  OPENCODE_PINNED_RUNTIME_ENV,
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
