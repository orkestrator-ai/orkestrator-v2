import { expect, test } from "bun:test";
import type { CommandHandler, CommandContext } from "./commands-context.js";
import { registerRequestCaptureCommands } from "./commands-request-capture.js";

function fixture(environments: unknown[] = []) {
  const commands = new Map<string, CommandHandler>();
  registerRequestCaptureCommands((name, handler) => commands.set(name, handler));
  const context = {
    storage: { loadEnvironments: async () => environments },
  } as unknown as CommandContext;
  return (args: Record<string, unknown>) => commands.get("claude_request_capture")!(args, context);
}
test("capture refuses unknown environments, mixed actions and extra arguments", async () => {
  const command = fixture();
  await expect(command({ environmentId: "missing" })).rejects.toThrow("Environment not found");
  await expect(
    command({ environmentId: "missing", enabled: true, name: "test.request.json" }),
  ).rejects.toThrow("Choose a setting change");
  await expect(command({ environmentId: "missing", url: "http://elsewhere" })).rejects.toThrow();
});
test("capture does not create a missing bridge", async () => {
  const command = fixture([{ id: "fixture", environmentType: "container", containerId: null }]);
  await expect(command({ environmentId: "fixture" })).rejects.toThrow("Start a Claude session");
});
