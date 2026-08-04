import { describe, expect, test } from "bun:test";
import {
  parseTmuxAgentObservation,
  parseTmuxAgentUsageSummaries,
  parseTmuxSelectionPrompt,
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
