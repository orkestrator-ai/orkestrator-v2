import { describe, expect, test } from "bun:test";
import {
  parseTmuxAgentObservation,
  parseTmuxAgentUsageSummaries,
  parseTmuxSelectionPrompt,
  stripTmuxAnsi,
  tmuxSelectionPromptFingerprint,
} from "./tmux-observation";

describe("tmux observations", () => {
  test("parses ANSI-decorated agent usage into a bounded normalized summary", () => {
    const snapshot = [
      "\u001b[32mRunning 2 research agents\u001b[0m",
      "├ scout · 1,204 tool uses · 12.5k tokens",
      "└ verifier · 7 tool uses · 980 tokens",
    ].join("\n");

    expect(parseTmuxAgentUsageSummaries(snapshot)).toEqual([
      {
        name: "scout",
        role: "research",
        toolUseCount: 1_204,
        tokenCount: 12_500,
        tokenCountText: "12.5k tokens",
      },
      {
        name: "verifier",
        role: "research",
        toolUseCount: 7,
        tokenCount: 980,
        tokenCountText: "980 tokens",
      },
    ]);
  });

  test("parses token-only roster rows with inline roles and durations", () => {
    expect(parseTmuxAgentUsageSummaries([
      "● main",
      "○ Explore  Review db-api test correctness                 1m 6s · ↓ 45.7k tokens",
    ].join("\n"))).toEqual([{
      name: "Review db-api test correctness",
      role: "Explore",
      tokenCount: 45_700,
      tokenCountText: "45.7k tokens",
    }]);
  });

  test("parses the latest selection prompt and its current choice", () => {
    const snapshot = [
      "Choose a deployment target",
      "",
      "  1. Staging",
      "> 2. Production",
      "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ].join("\n");

    expect(parseTmuxSelectionPrompt(snapshot)).toEqual({
      question: "Choose a deployment target",
      options: [
        { number: 1, label: "Staging", optionIndex: 0, selected: false },
        { number: 2, label: "Production", optionIndex: 1, selected: true },
      ],
      selectedOptionIndex: 1,
      inputMode: "navigate",
    });
  });

  test("parses wrapped labels even when the final option wraps", () => {
    const prompt = parseTmuxSelectionPrompt([
      "Do you want to proceed?",
      "",
      "❯ 1. Yes",
      "  2. No, and tell Claude",
      "     what to do differently",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n"));

    expect(prompt).toEqual({
      question: "Do you want to proceed?",
      options: [
        { number: 1, label: "Yes", optionIndex: 0, selected: true },
        {
          number: 2,
          label: "No, and tell Claude what to do differently",
          optionIndex: 1,
          selected: false,
        },
      ],
      selectedOptionIndex: 0,
      inputMode: "number",
    });
  });

  test("keeps an unknown highlighted option distinct from option one", () => {
    const prompt = parseTmuxSelectionPrompt([
      "Choose one",
      "",
      "  1. First",
      "  2. Second",
      "",
      "Enter to select · Arrow keys to navigate · Esc to cancel",
    ].join("\n"));

    expect(prompt?.selectedOptionIndex).toBeNull();
    expect(prompt?.options.every((option) => !option.selected)).toBe(true);
  });

  test("distinguishes numbered confirmation from cursor navigation", () => {
    const options = ["› 1. No", "  2. Yes"];
    expect(parseTmuxSelectionPrompt([
      ...options,
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n"))?.inputMode).toBe("number");
    expect(parseTmuxSelectionPrompt([
      ...options,
      "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ].join("\n"))?.inputMode).toBe("navigate");
    expect(parseTmuxSelectionPrompt([
      ...options,
      "",
      "Enter to select · Esc to cancel",
    ].join("\n"))?.inputMode).toBe("navigate");
  });

  test("does not revive a completed prompt when later pane output is present", () => {
    const prompt = parseTmuxSelectionPrompt([
      "Choose a deployment target",
      "",
      "› 1. Staging",
      "  2. Production",
      "",
      "Enter to select · Arrow keys to navigate · Esc to cancel",
      "ordinary pane output",
      "1. This is transcript text, not an adjacent active prompt",
      "",
      "",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n"));

    expect(prompt).toBeNull();
  });

  test("does not let a running-agent header classify later token text", () => {
    expect(parseTmuxAgentUsageSummaries([
      "Running 1 Explore agent...",
      "└ Review api correctness · 2 tool uses · 3k tokens",
      "context left until auto-compact: 12.0k tokens",
    ].join("\n"))).toEqual([{
      name: "Review api correctness",
      role: "Explore",
      toolUseCount: 2,
      tokenCount: 3_000,
      tokenCountText: "3k tokens",
    }]);
  });

  test("fingerprints the complete prompt semantics", () => {
    const prompt = parseTmuxSelectionPrompt([
      "Choose one",
      "",
      "› 1. First",
      "  2. Second",
      "",
      "Enter to select · Arrow keys to navigate · Esc to cancel",
    ].join("\n"));
    expect(prompt).not.toBeNull();
    expect(tmuxSelectionPromptFingerprint(prompt!)).toBe(
      tmuxSelectionPromptFingerprint({ ...prompt! }),
    );
    expect(tmuxSelectionPromptFingerprint(prompt!)).not.toBe(
      tmuxSelectionPromptFingerprint({ ...prompt!, selectedOptionIndex: 1 }),
    );
    expect(tmuxSelectionPromptFingerprint(prompt!)).not.toBe(
      tmuxSelectionPromptFingerprint({ ...prompt!, question: "Different" }),
    );
  });

  test("rejects non-contiguous transcript lists that resemble options", () => {
    expect(parseTmuxSelectionPrompt([
      "Copied instructions",
      "  2. First copied step",
      "  4. Another copied step",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n"))).toBeNull();
  });

  test("extracts only the active question instead of stale numbered transcript lines", () => {
    const prompt = parseTmuxSelectionPrompt([
      "1. Run git diff",
      "2. Run git log",
      "3. Create the PR",
      "",
      "Two staged files look wrong. What should I do?",
      "",
      "› 1. Unstage them",
      "     and add them to .gitignore",
      "  2. Commit them",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n"));

    expect(prompt?.question).toBe("Two staged files look wrong. What should I do?");
    expect(prompt?.options[0]?.label).toBe("Unstage them and add them to .gitignore");
  });

  test("expands URL-only questions through context but stops at boundaries", () => {
    const prompt = parseTmuxSelectionPrompt([
      "Earlier output must stay out.",
      "",
      "------------------------------------------------------------",
      "WARNING: Bypass Permissions mode",
      "",
      "Proceeding can run dangerous commands.",
      "",
      "https://code.claude.com/docs/en/security",
      "",
      "› 1. No, exit",
      "  2. Yes, I accept",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n"));

    expect(prompt?.question).toBe([
      "WARNING: Bypass Permissions mode",
      "",
      "Proceeding can run dangerous commands.",
      "",
      "https://code.claude.com/docs/en/security",
    ].join("\n"));
  });

  test.each([
    ["numbered list", "1. Earlier step\n2. Another step"],
    ["bracketed log", "[INFO] background task complete"],
    ["shell prompt", "node@host$"],
  ])("does not absorb a %s before a URL-only question", (_name, context) => {
    const prompt = parseTmuxSelectionPrompt([
      context,
      "",
      "https://code.claude.com/docs/en/security",
      "",
      "› 1. No, exit",
      "  2. Yes, I accept",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n"));

    expect(prompt?.question).toBe("https://code.claude.com/docs/en/security");
  });

  test("strips CSI, OSC, DCS, charset, carriage-return, and backspace controls", () => {
    expect(stripTmuxAnsi([
      "\u001b[32mgreen\u001b[0m",
      "\u001b]0;title\u0007visible",
      "\u001bPprivate payload\u001b\\after",
      "\u001b(Bplain\r\btext",
    ].join(" "))).toBe("green visible after plaintext");
  });

  test("detects prompts when ANSI sequences interrupt the hint and options", () => {
    const prompt = parseTmuxSelectionPrompt([
      "Which environment?",
      "",
      "\u001b(B\u001b[7m› 1. Development\u001b[0m",
      "  2. Production",
      "",
      "Enter\u001b[0m to confirm · Esc to cancel",
    ].join("\n"));

    expect(prompt?.options.map((option) => option.label)).toEqual([
      "Development",
      "Production",
    ]);
    expect(prompt?.inputMode).toBe("number");
  });

  test("bounds hostile padded rows and unterminated terminal controls", () => {
    const startedAt = performance.now();
    const observation = parseTmuxAgentObservation(
      `a${" ".repeat(4_000)}b\n\u001b]${"x".repeat(20_000)}`,
      1,
      "2026-08-04T12:00:00.000Z",
    );

    expect(observation.usage).toEqual([]);
    expect(observation.prompt).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  test("returns null for empty or hint-free snapshots", () => {
    expect(parseTmuxSelectionPrompt("")).toBeNull();
    expect(parseTmuxSelectionPrompt("1. Not a live prompt")).toBeNull();
  });

  test("stamps a complete observation without retaining raw pane text", () => {
    const observation = parseTmuxAgentObservation(
      "Running 1 build agent\n└ worker · 2 tool uses · 3k tokens",
      4,
      "2026-08-04T12:00:00.000Z",
    );

    expect(observation).toEqual({
      revision: 4,
      observedAt: "2026-08-04T12:00:00.000Z",
      usage: [{
        name: "worker",
        role: "build",
        toolUseCount: 2,
        tokenCount: 3_000,
        tokenCountText: "3k tokens",
      }],
      prompt: null,
    });
    expect(observation).not.toHaveProperty("snapshot");
  });
});
