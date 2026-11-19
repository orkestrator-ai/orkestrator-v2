import { describe, expect, test } from "bun:test";
import {
  INTERACTIVE_INTERACTION_INSTRUCTION,
  TASK_INTERACTION_INSTRUCTION,
  isEnvironmentInteractionMode,
  withEnvironmentInteraction,
} from "./environment-interaction";
import { stripSystemInstructions, wrapSystemInstructions } from "./review-evidence-frames";

describe("withEnvironmentInteraction", () => {
  test("tells a task not to ask questions and to wait when finished", () => {
    const framed = withEnvironmentInteraction("Fix the login bug.", "task");
    expect(framed).toBe(
      `Fix the login bug.\n\n${wrapSystemInstructions(TASK_INTERACTION_INSTRUCTION)}`,
    );
    expect(TASK_INTERACTION_INSTRUCTION).toContain("do not ask the user questions");
    expect(TASK_INTERACTION_INSTRUCTION).toContain("then stop and wait");
  });

  test("tells an interactive environment it may ask the user questions", () => {
    const framed = withEnvironmentInteraction("Design the settings page.", "interactive");
    expect(framed).toBe(
      `Design the settings page.\n\n${wrapSystemInstructions(INTERACTIVE_INTERACTION_INSTRUCTION)}`,
    );
    expect(INTERACTIVE_INTERACTION_INSTRUCTION).toContain("Ask clarifying questions");
  });

  test("leaves the prompt unchanged without a mode or without text", () => {
    expect(withEnvironmentInteraction("Fix it.", undefined)).toBe("Fix it.");
    expect(withEnvironmentInteraction("", "task")).toBe("");
    expect(withEnvironmentInteraction("  ", "interactive")).toBe("  ");
  });

  test("shows the user only their own words in a transcript", () => {
    for (const mode of ["task", "interactive"] as const) {
      expect(stripSystemInstructions(withEnvironmentInteraction("Fix it.", mode))).toBe("Fix it.");
    }
  });
});

describe("isEnvironmentInteractionMode", () => {
  test("accepts only task and interactive", () => {
    expect(isEnvironmentInteractionMode("task")).toBe(true);
    expect(isEnvironmentInteractionMode("interactive")).toBe(true);
    expect(isEnvironmentInteractionMode("pipeline")).toBe(false);
    expect(isEnvironmentInteractionMode(undefined)).toBe(false);
    expect(isEnvironmentInteractionMode(true)).toBe(false);
  });
});
