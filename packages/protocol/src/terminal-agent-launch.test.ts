import { describe, expect, test } from "bun:test";
import { buildTerminalAgentLaunchCommand } from "./terminal-agent-launch.js";

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
