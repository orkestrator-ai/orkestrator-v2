import { expect, test } from "bun:test";
import { HumanPromptScanner } from "@orkestrator/protocol/human-prompts";
import { HumanPromptRegistry } from "./human-prompt-registry.js";

test("a later ENTER action updates the registry without a new notification identity", () => {
  const scanner = new HumanPromptScanner();
  const registry = new HumanPromptRegistry();
  let updates = 0;
  let notices = 0;
  registry.subscribe((change) => {
    if (change.type !== "set") return;
    updates++;
    if (change.previous?.prompt.key !== change.entry.prompt.key) notices++;
  });
  scanner.push("https://github.com/login/device\n");
  const input = { id: "tool", environmentId: "env", tabId: "tab", source: "agent-tool" as const };
  registry.set({ ...input, prompt: scanner.prompt! });
  scanner.push("Press ENTER to continue");
  registry.set({ ...input, prompt: scanner.prompt! });
  registry.set({ ...input, prompt: scanner.prompt! });
  expect(registry.list()[0]?.prompt.wantsEnter).toBe(true);
  expect(updates).toBe(2);
  expect(notices).toBe(1);
});
