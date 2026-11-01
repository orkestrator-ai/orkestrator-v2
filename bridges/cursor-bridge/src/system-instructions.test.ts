import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSystemInstructions } from "@orkestrator/protocol/agent-system-instructions";
import {
  stripSystemInstructions,
  wrapSystemInstructions,
} from "@orkestrator/protocol/review-evidence-frames";
import { newSessionState } from "./agent-session.js";
import { cursorPromptText, repositoryInstructionsFor } from "./prompt.js";

/**
 * Cursor has no channel that adds to its system prompt, so the instructions
 * every Orkestrator provider receives ride each prompt in a frame.
 */
describe("cursorPromptText", () => {
  test("sends the prompt, then the shared instructions in a frame", () => {
    const text = cursorPromptText(newSessionState(), { prompt: "make the header blue" });
    expect(text).toBe(
      `make the header blue\n\n${wrapSystemInstructions(agentSystemInstructions())}`,
    );
    expect(stripSystemInstructions(text)).toBe("make the header blue");
  });

  test("keeps a structured turn's schema contract last", () => {
    const text = cursorPromptText(newSessionState(), {
      prompt: "review",
      schema: { type: "object" },
    });
    expect(text.indexOf("<orkestrator-system-instructions>")).toBeGreaterThan(0);
    expect(text).toEndWith('{"type":"object"}');
  });

  test("a read-only session sends the prompt alone", () => {
    const state = newSessionState();
    state.readOnly = true;
    expect(cursorPromptText(state, { prompt: "inspect" })).toBe("inspect");
  });

  test("puts the repository's AGENTS.md in the same frame, read-only sessions included", () => {
    const writable = cursorPromptText(newSessionState(), { prompt: "go" }, "REPO RULES");
    expect(writable).toBe(
      `go\n\n${wrapSystemInstructions(agentSystemInstructions(), "REPO RULES")}`,
    );
    const state = newSessionState();
    state.readOnly = true;
    expect(cursorPromptText(state, { prompt: "inspect" }, "REPO RULES")).toBe(
      `inspect\n\n${wrapSystemInstructions("REPO RULES")}`,
    );
  });
});

describe("repositoryInstructionsFor", () => {
  let workspace: string;
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "cursor-agents-md-"));
    await writeFile(join(workspace, "AGENTS.md"), "Always show visual changes as images.\n");
  });
  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("sends AGENTS.md once per agent that does not load the project itself", async () => {
    const state: Parameters<typeof repositoryInstructionsFor>[0] = {
      agentId: "agent-1",
      loadsProjectRules: false,
    };
    expect(await repositoryInstructionsFor(state, workspace)).toContain(
      "Always show visual changes as images.",
    );
    state.repositoryInstructionsAgentId = "agent-1";
    expect(await repositoryInstructionsFor(state, workspace)).toBeUndefined();
    // A replacement agent has not seen it.
    state.agentId = "agent-2";
    expect(await repositoryInstructionsFor(state, workspace)).toContain(
      "# Repository instructions (AGENTS.md)",
    );
  });

  test("leaves AGENTS.md to an agent that loads the project", async () => {
    expect(
      await repositoryInstructionsFor({ agentId: "agent-1", loadsProjectRules: true }, workspace),
    ).toBeUndefined();
  });
});
