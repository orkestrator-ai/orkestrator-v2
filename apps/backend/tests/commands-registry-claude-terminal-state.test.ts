import { describe, expect, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const { createCommandRegistry, createContext, createEnvironment } = await createCommandFixtures();

describe("get_claude_terminal_state", () => {
  test("returns only the persisted Claude tmux state and its timestamp for a container", async () => {
    const environment = createEnvironment({
      id: "env-claude-terminal-state",
      containerId: "container-claude-state",
      agentActivitySources: {
        "claude-terminal": { state: "working", updatedAt: "2026-10-14T10:00:00.000Z" },
        "native-agent": { state: "waiting", updatedAt: "2026-10-14T10:00:01.000Z" },
      },
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(
      commands.get("get_claude_terminal_state")?.(
        { containerId: "container-claude-state" },
        context,
      ),
    ).resolves.toEqual({ state: "working", occurredAt: "2026-10-14T10:00:00.000Z" });
  });

  test("returns null before any observation and refuses a container it does not own", async () => {
    const environment = createEnvironment({
      id: "env-claude-terminal-unobserved",
      containerId: "container-unobserved",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(
      commands.get("get_claude_terminal_state")?.({ containerId: "container-unobserved" }, context),
    ).resolves.toBeNull();
    // The registry's ownership guard trusts only persisted associations.
    await expect(
      commands.get("get_claude_terminal_state")?.({ containerId: "container-missing" }, context),
    ).rejects.toThrow();
    await expect(commands.get("get_claude_terminal_state")?.({}, context)).rejects.toThrow(
      "containerId",
    );
  });
});
