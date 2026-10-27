import { expect, mock, test } from "bun:test";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerPermissionRuleCommands } from "./commands-registry-permission-rules.js";

test("remember command validates arguments before resolving a session", async () => {
  const commands = new Map<string, CommandHandler>();
  registerPermissionRuleCommands((name, handler) => commands.set(name, handler));
  const approve = mock(async () => ({ outcome: { result: "applied" } }));
  const context = {
    nativeAgents: { approveProjectionInteractionAndRemember: approve },
  } as unknown as CommandContext;
  const run = commands.get("approve_native_agent_interaction_and_remember")!;
  const args = {
    environmentId: "env",
    agent: "claude",
    logicalSessionKey: "tab",
    interactionId: "approval",
    pattern: "npm test",
    scope: "project",
    anyProvider: false,
  };
  for (const change of [
    { injected: true },
    { environmentId: " " },
    { logicalSessionKey: "" },
    { interactionId: "" },
    { pattern: "" },
    { scope: "machine" },
    { anyProvider: "yes" },
    { expiresInMs: 1.5 },
  ]) {
    await expect(run({ ...args, ...change }, context)).rejects.toThrow();
  }
  expect(approve).not.toHaveBeenCalled();
  await expect(run(args, context)).resolves.toEqual({ outcome: { result: "applied" } });
  expect(approve).toHaveBeenCalledWith({
    environmentId: "env",
    agent: "claude",
    logicalSessionKey: "tab",
    interactionId: "approval",
    choice: { pattern: "npm test", scope: "project", anyProvider: false },
  });
});
