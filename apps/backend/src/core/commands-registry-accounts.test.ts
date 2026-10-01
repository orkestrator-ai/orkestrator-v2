import { afterEach, describe, expect, mock, test } from "bun:test";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { agentAccountLoginProgress, resetAgentAccountLoginForTests } from "./agent-accounts.js";

const command = createCommandRegistry().get("start_agent_account_login")!;
afterEach(resetAgentAccountLoginForTests);

describe("account login argument validation", () => {
  test.each([null, 0, 1, "true", "false", {}, []])(
    "rejects non-boolean reauthenticate %j",
    async (reauthenticate) => {
      const loadAgentAccounts = mock(async () => ({ version: 1, accounts: [], active: {} }));
      await expect(
        command({ platform: "claude", reauthenticate }, {
          storage: { loadAgentAccounts },
        } as unknown as CommandContext),
      ).rejects.toThrow("reauthenticate");
      expect(loadAgentAccounts).not.toHaveBeenCalled();
      expect(agentAccountLoginProgress().state).toBe("idle");
    },
  );
  test.each([undefined, false, true])(
    "defaults add mode and honors explicit boolean %j",
    async (reauthenticate) => {
      const context = {
        storage: {
          loadAgentAccounts: async () => {
            throw new Error("stop before spawn");
          },
        },
      } as unknown as CommandContext;
      await expect(
        command(
          { platform: "claude", ...(reauthenticate === undefined ? {} : { reauthenticate }) },
          context,
        ),
      ).rejects.toThrow("stop before spawn");
      expect(agentAccountLoginProgress().mode).toBe(reauthenticate ? "reauthenticate" : "add");
      expect(agentAccountLoginProgress().operationId).toBeDefined();
    },
  );
});
