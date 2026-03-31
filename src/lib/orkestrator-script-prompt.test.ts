import { describe, expect, test } from "bun:test";
import { createOrkestratorScriptPrompt } from "@/prompts";

describe("createOrkestratorScriptPrompt", () => {
  test("includes local-environment guidance", () => {
    const prompt = createOrkestratorScriptPrompt(true);

    expect(prompt).toContain("Create or update a project root file named `orkestrator-ai.json`");
    expect(prompt).toContain("This is a local environment, so include useful setup commands in `setupLocal`.");
    expect(prompt).toContain("prefer Bun commands");
    expect(prompt).toContain("`run`: array of strings");
  });

  test("includes container-environment guidance", () => {
    const prompt = createOrkestratorScriptPrompt(false);

    expect(prompt).toContain("This is a containerized environment, so include useful setup commands in `setupContainer`.");
    expect(prompt).toContain("`setupContainer`");
    expect(prompt).toContain("`setupLocal`");
  });

  test("enforces strict JSON compatibility instructions", () => {
    const prompt = createOrkestratorScriptPrompt(false);

    expect(prompt).toContain("The file must be valid JSON only");
    expect(prompt).toContain("Every command must be a non-empty shell command string");
    expect(prompt).toContain("If `orkestrator-ai.json` already exists, preserve useful existing commands and update safely");
  });
});
