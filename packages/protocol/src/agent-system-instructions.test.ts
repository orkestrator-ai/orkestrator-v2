import { describe, expect, test } from "bun:test";
import {
  AGENT_DOCUMENT_INSTRUCTION,
  AGENT_IMAGE_PREVIEW_INSTRUCTION,
  GENERAL_AGENT_INSTRUCTIONS,
  agentSystemInstructions,
} from "./agent-system-instructions.js";

describe("agentSystemInstructions", () => {
  test("is the general block alone without provider lines", () => {
    expect(agentSystemInstructions()).toBe(GENERAL_AGENT_INSTRUCTIONS.join("\n\n"));
    expect(agentSystemInstructions()).toContain(AGENT_IMAGE_PREVIEW_INSTRUCTION);
    expect(agentSystemInstructions()).toContain(AGENT_DOCUMENT_INSTRUCTION);
  });

  test("puts provider lines after the general block and drops blank ones", () => {
    expect(agentSystemInstructions(["first", "  ", "second"])).toBe(
      [...GENERAL_AGENT_INSTRUCTIONS, "first", "second"].join("\n\n"),
    );
  });

  test("states the image preview storage boundary", () => {
    expect(AGENT_IMAGE_PREVIEW_INSTRUCTION).toContain("absolute path");
    expect(AGENT_IMAGE_PREVIEW_INSTRUCTION).toContain("/tmp");
    expect(AGENT_IMAGE_PREVIEW_INSTRUCTION).toContain("Project-home checkouts");
  });
});
