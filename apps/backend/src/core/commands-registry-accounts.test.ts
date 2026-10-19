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

describe("OpenCode provider login argument validation", () => {
  const registry = createCommandRegistry();
  const context = {} as CommandContext;

  test("refuses unexpected fields and non-string sign-in details before any work", async () => {
    await expect(
      registry.get("set_opencode_provider_api_key")!(
        { providerId: "opencode-go", key: "k", extra: true },
        context,
      ),
    ).rejects.toThrow("Unexpected arguments field: extra");
    await expect(
      registry.get("set_opencode_provider_api_key")!(
        { providerId: "opencode-go", key: "k", metadata: { accountId: 1 } },
        context,
      ),
    ).rejects.toThrow("metadata.accountId");
    await expect(
      registry.get("start_opencode_provider_login")!(
        { providerId: "openai", method: "0" },
        context,
      ),
    ).rejects.toThrow("Expected method to be a number");
    await expect(
      registry.get("remove_opencode_provider_login")!({ providerId: " " }, context),
    ).rejects.toThrow("providerId");
  });

  test("reads an idle login without a server", async () => {
    expect(await registry.get("get_opencode_provider_login")!({}, context)).toEqual({
      state: "idle",
    });
    expect(await registry.get("cancel_opencode_provider_login")!({}, context)).toEqual({
      state: "idle",
    });
  });
});
