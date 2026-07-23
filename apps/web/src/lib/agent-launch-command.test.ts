import { describe, expect, test } from "bun:test";
import { buildAgentLaunchCommand } from "./agent-launch-command";

describe("buildAgentLaunchCommand", () => {
  test("launches Claude CLI with one-shot model and effort settings", () => {
    expect(buildAgentLaunchCommand({
      tabType: "claude",
      initialPrompt: "Review the diff",
      model: "claude-fable-5[1m]",
      reasoningEffort: "xhigh",
    })).toBe(
      'claude --dangerously-skip-permissions --model "claude-fable-5[1m]" --effort "xhigh" "Review the diff"',
    );
  });

  test("launches Codex CLI with documented model and TOML effort overrides", () => {
    expect(buildAgentLaunchCommand({
      tabType: "codex",
      initialPrompt: "Review the diff",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    })).toBe(
      'codex --model "gpt-5.6-sol" --config "model_reasoning_effort=\\"high\\"" "Review the diff"',
    );
  });

  test("quotes untrusted model and prompt values as shell arguments", () => {
    expect(buildAgentLaunchCommand({
      tabType: "opencode",
      initialPrompt: "Review Bob's change; $(touch /tmp/nope)",
      model: "provider/model'next",
      reasoningEffort: "high",
    })).toBe(
      'opencode --model "provider/model\'next" --prompt "Review Bob\'s change; \\$(touch /tmp/nope)"',
    );
  });

  test("omits the synthetic default model and unsupported OpenCode CLI effort", () => {
    expect(buildAgentLaunchCommand({
      tabType: "opencode",
      initialPrompt: "Review",
      model: "default",
      reasoningEffort: "xhigh",
    })).toBe('opencode --prompt "Review"');
  });

  test("preserves multiline and CRLF prompt structure", () => {
    expect(buildAgentLaunchCommand({
      tabType: "claude",
      initialPrompt: "Review:\r\n- first\n- second",
    })).toBe('claude --dangerously-skip-permissions "Review:\r\n- first\n- second"');
  });

  test("supports empty optional values and rejects non-agent tab types", () => {
    expect(buildAgentLaunchCommand({ tabType: "codex" })).toBe("codex");
    expect(buildAgentLaunchCommand({
      tabType: "plain",
      initialPrompt: "Review",
    })).toBeNull();
  });
});
