import { describe, expect, test } from "bun:test";
import { createCommandRegistry, type CommandContext } from "./commands.js";

describe("agent skill commands", () => {
  test("returns the AgentSkillScan contract in isolated agent-test profiles", async () => {
    const command = createCommandRegistry().get("list_agent_skills");
    if (!command) throw new Error("list_agent_skills command is not registered");

    const context = { runtimeFlavor: "agent-test" } as CommandContext;
    for (const provider of ["claude", "cursor", "grok"] as const) {
      await expect(command({ provider }, context)).resolves.toEqual({
        provider,
        roots: [],
        skills: [],
        errors: [],
      });
    }
  });

  test("keeps host plugins out of isolated agent-test profiles", async () => {
    const command = createCommandRegistry().get("list_agent_plugins");
    if (!command) throw new Error("list_agent_plugins command is not registered");

    const context = { runtimeFlavor: "agent-test" } as CommandContext;
    await expect(command({ provider: "claude" }, context)).resolves.toEqual({
      agent: "claude",
      plugins: [],
    });
    // A defined command drops an unknown key (plan item 7009) instead of refusing it.
    await expect(command({ provider: "claude", unexpected: true }, context)).resolves.toEqual({
      agent: "claude",
      plugins: [],
    });
    await expect(command({ provider: "other" }, context)).rejects.toThrow();
  });
});
