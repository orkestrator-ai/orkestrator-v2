import { describe, expect, test } from "bun:test";
import type { CommandHandler } from "./commands-context.js";
import { registerWorkflowResultCommands } from "./commands-registry-workflow-results.js";

describe("workflow result command registry", () => {
  test("rejects unknown providers instead of silently narrowing rollout", async () => {
    let handler: CommandHandler | undefined;
    registerWorkflowResultCommands((name, candidate) => {
      if (name === "set_workflow_result_tools_rollout") handler = candidate;
    });
    if (!handler) throw new Error("rollout command was not registered");

    await expect(handler({ providers: ["claud"] }, {} as never)).rejects.toThrow(
      "providers contains an unknown structured output provider",
    );
  });
});
