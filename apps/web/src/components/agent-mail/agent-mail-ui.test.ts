import { describe, expect, test } from "bun:test";
import { agentMailParticipantLabel } from "./agent-mail-ui";

describe("agentMailParticipantLabel", () => {
  test("names an agent by its environment and tab, and anyone else by its own name", () => {
    expect(
      agentMailParticipantLabel({
        kind: "agent",
        displayName: "Claude 2",
        environmentName: "fix-login-bug",
      }),
    ).toBe("fix-login-bug · Claude 2");
    // A closed tab whose environment is gone keeps the name its messages carried.
    expect(agentMailParticipantLabel({ kind: "agent", displayName: "Claude 2" })).toBe("Claude 2");
    // The coordinator's mailbox lives in a "Coordinator" environment; it stays a coordinator.
    expect(
      agentMailParticipantLabel({
        kind: "coordinator",
        displayName: "Project coordinator",
        environmentName: "Coordinator",
      }),
    ).toBe("Project coordinator");
    expect(agentMailParticipantLabel({ kind: "user", displayName: "You" })).toBe("You");
  });
});
