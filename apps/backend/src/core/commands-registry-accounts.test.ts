import { registrarFrom } from "./commands-registry-contracts.js";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { registerAgentAccountCommands } from "./commands-registry-accounts.js";
import type { CommandHandler } from "./commands-context.js";
import type { RegistryDependencies } from "./commands-registry-types.js";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { agentAccountLoginProgress } from "./agent-accounts.js";
import { AgentAccountsRuntime } from "./agent-accounts-runtime.js";
import { OpenCodeProviderLoginSlot } from "./opencode-provider-login-slot.js";

import * as cursorBridge from "./cursor-sdk-bridge.js";
import { decodeCommandArgs } from "@orkestrator/protocol/contract/command";
import { setOpenCodeProviderApiKeyCommand } from "@orkestrator/protocol/contract/domains/accounts";

/**
 * The message a rejected call carries; `""` when it resolved. The handlers
 * no longer refuse unknown keys (§11.4, plan item 7008): these calls go past
 * argument checks and fail later on the bare context instead.
 */
async function failureOf(run: () => unknown): Promise<string> {
  try {
    await run();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const command = createCommandRegistry().get("start_agent_account_login")!;

describe("account login argument validation", () => {
  test.each([null, 0, 1, "true", "false", {}, []])(
    "rejects non-boolean reauthenticate %j",
    async (reauthenticate) => {
      const loadAgentAccounts = mock(async () => ({ version: 1, accounts: [], active: {} }));
      const context = {
        storage: {
          agentAccounts: {
            loadAgentAccounts,
          },
        },
        runtime: { accounts: new AgentAccountsRuntime() },
      } as unknown as CommandContext;
      await expect(command({ platform: "claude", reauthenticate }, context)).rejects.toThrow(
        "reauthenticate",
      );
      expect(loadAgentAccounts).not.toHaveBeenCalled();
      expect(agentAccountLoginProgress(context).state).toBe("idle");
    },
  );
  test.each([undefined, false, true])(
    "defaults add mode and honors explicit boolean %j",
    async (reauthenticate) => {
      const context = {
        storage: {
          agentAccounts: {
            loadAgentAccounts: async () => {
              throw new Error("stop before spawn");
            },
          },
        },
        runtime: { accounts: new AgentAccountsRuntime() },
      } as unknown as CommandContext;
      await expect(
        command(
          { platform: "claude", ...(reauthenticate === undefined ? {} : { reauthenticate }) },
          context,
        ),
      ).rejects.toThrow("stop before spawn");
      expect(agentAccountLoginProgress(context).mode).toBe(
        reauthenticate ? "reauthenticate" : "add",
      );
      expect(agentAccountLoginProgress(context).operationId).toBeDefined();
    },
  );
});

describe("OpenCode provider login argument validation", () => {
  const registry = createCommandRegistry();
  const context = {
    runtime: { localServers: { openCodeProviderLogin: new OpenCodeProviderLoginSlot() } },
  } as unknown as CommandContext;

  test("drops unexpected fields and refuses non-string sign-in details before any work", async () => {
    // Decoded only: a call that passes validation would reach OpenCode.
    const decoded = decodeCommandArgs(setOpenCodeProviderApiKeyCommand, {
      providerId: "opencode-go",
      key: "k",
      extra: true,
    });
    expect(decoded._tag === "Success" && decoded.success).toEqual({
      providerId: "opencode-go",
      key: "k",
    });
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

describe("get_agent_sign_in_status", () => {
  const status = createCommandRegistry().get("get_agent_sign_in_status")!;
  test.each([{}, { platform: "invalid" }, { platform: 1 }, { platform: " " }])(
    "rejects invalid arguments before accessing dependencies %j",
    async (args) => {
      const loadConfig = mock(async () => {
        throw new Error("unexpected storage access");
      });
      await expect(
        status(args, { storage: { loadConfig } } as unknown as CommandContext),
      ).rejects.toThrow();
      expect(loadConfig).not.toHaveBeenCalled();
    },
  );
  test.each([undefined, "stored-test-key"])(
    "composes Cursor status with the optional configured key %s",
    async (key) => {
      const read = spyOn(cursorBridge, "cursorSdkAuthStatus").mockResolvedValue(
        key
          ? { authenticated: true, source: "api-key-config" }
          : { authenticated: false, source: "none" },
      );
      const context = {
        storage: { loadConfig: mock(async () => ({ global: { cursorApiKey: key } })) },
      } as unknown as CommandContext;
      try {
        const result = await status({ platform: "cursor" }, context);
        expect(read).toHaveBeenCalledWith(context, key);
        expect(result).toMatchObject({
          state: key ? "signed-in" : "signed-out",
          signIn: { kind: "browser-url" },
          signOut: false,
        });
        expect(JSON.stringify(result)).not.toContain("stored-test-key");
      } finally {
        read.mockRestore();
      }
    },
  );
  test("drops an unknown argument (§11.4)", async () => {
    const read = spyOn(cursorBridge, "cursorSdkAuthStatus").mockResolvedValue({
      authenticated: false,
      source: "none",
    });
    try {
      const context = {
        storage: { loadConfig: mock(async () => ({ global: {} })) },
      } as unknown as CommandContext;
      expect(await status({ platform: "cursor", extra: true }, context)).toMatchObject({
        state: "signed-out",
      });
    } finally {
      read.mockRestore();
    }
  });
});

function harness() {
  const commands = new Map<string, CommandHandler>();
  registerAgentAccountCommands(
    registrarFrom((name, handler) => commands.set(name, handler)),
    {
      commands,
    } as RegistryDependencies,
  );
  const context = {
    storage: {
      loadEnvironments: async () => [
        {
          id: "env",
          projectId: "project",
          environmentType: "local",
          status: "running",
          setupPhase: "ready",
        },
      ],
    },
  } as unknown as CommandContext;
  return {
    commands,
    context,
    invoke: (args: Record<string, unknown>) =>
      commands.get("open_agent_sign_in_terminal")!(args, context),
  };
}

// Unexpected arguments (`data`, `activateTab`) are dropped now (§11.4, plan item 7008); the
// launcher test below shows they never reach the terminal.
test("terminal sign-in command rejects unsupported platforms and invalid environment IDs", async () => {
  const { invoke } = harness();
  for (const args of [
    { platform: "claude" },
    { platform: "grok; echo x" },
    { platform: "grok", environmentId: 42 },
    {},
  ]) {
    await expect(invoke(args)).rejects.toThrow();
  }
});

test("terminal sign-in resolves the registered launcher at execution and fixes shell arguments", async () => {
  const { commands, context, invoke } = harness();
  await expect(invoke({ platform: "grok", environmentId: "env" })).rejects.toThrow(
    "Terminal jobs are unavailable",
  );
  for (const [platform, data] of [
    ["grok", "grok login\n"],
    ["pi", "pi\n"],
  ]) {
    let received: unknown;
    commands.set("launch_terminal_job", async (args, owner) => {
      expect(owner).toBe(context);
      received = args;
      return { tabId: "tab" };
    });
    expect(
      await invoke({ platform, environmentId: "env", data: "anything", activateTab: false }),
    ).toEqual({
      environmentId: "env",
      projectId: "project",
      tabId: "tab",
    });
    expect(received).toEqual({
      environmentId: "env",
      requestId: expect.stringMatching(/^agent-sign-in-/),
      tabType: "plain",
      title: `${platform === "grok" ? "Grok" : "Pi"} sign-in`,
      data,
      activateTab: true,
    });
  }
});

describe("automatic switching argument validation", () => {
  const tick = createCommandRegistry().get("set_agent_account_auto_switch")!;
  const resume = createCommandRegistry().get("resume_agent_account_auto_switch")!;
  const context = {} as unknown as CommandContext;

  test.each([
    [{ platform: "grok", enabled: true }, "not supported"],
    [{ platform: "claude" }, "Expected enabled"],
    [{ platform: "claude", enabled: "yes" }, "enabled"],
    [{ platform: "claude", included: true }, "either an email or an accountId"],
    [{ platform: "claude", email: "a@b", accountId: "x", included: true }, "either an email"],
  ])("refuses %j before any work", async (args, message) => {
    await expect(tick(args as Record<string, unknown>, context)).rejects.toThrow(message);
  });

  test("an unknown key is dropped, not refused", async () => {
    // Past validation, the bare context fails: the key was not the refusal.
    const failure = await failureOf(() =>
      tick({ platform: "claude", enabled: true, token: "x" }, context),
    );
    expect(failure).not.toContain("token");
    expect(failure).toContain("context.runtime");
  });

  test("ending a pin names a provider; other keys are dropped", async () => {
    await expect(resume({ platform: "grok" }, context)).rejects.toThrow("not supported");
    const failure = await failureOf(() => resume({ platform: "claude", enabled: true }, context));
    expect(failure).not.toContain("enabled");
    expect(failure).toContain("context.runtime");
  });
});

describe("an unsupported platform is reported before the other fields", () => {
  // Two wrong fields: the handler checked the platform first before the
  // definitions, so its message wins over the decode failure of the other.
  const registry = createCommandRegistry();
  test.each([
    ["set_active_agent_account", { platform: "grok", accountId: 1 }],
    ["set_agent_account_auto_switch", { platform: "grok", enabled: "yes" }],
    ["set_agent_account_auto_switch", { platform: "grok", included: "yes" }],
    ["set_coordinator_account_switch_grant", { platform: "grok", enabled: "yes" }],
    ["rename_agent_account", { platform: "grok", accountId: 1, label: 2 }],
    ["remove_agent_account", { platform: "grok", accountId: 1 }],
    ["get_agent_account_usage", { platform: "grok", accountId: 1, force: "yes" }],
    ["start_agent_account_login", { platform: "grok", reauthenticate: "yes" }],
  ] as const)("%s %j", async (name, args) => {
    await expect(
      registry.get(name)!(args as Record<string, unknown>, {} as CommandContext),
    ).rejects.toThrow("Agent accounts are not supported for grok");
  });
  test("a platform that is not a string keeps its wording", async () => {
    await expect(
      registry.get("set_active_agent_account")!(
        { platform: 1, accountId: 1 },
        {} as CommandContext,
      ),
    ).rejects.toThrow("Expected platform to be a string");
  });
});

describe("preferred identity argument validation", () => {
  const setPreferred = createCommandRegistry().get("set_preferred_agent_identity")!;
  test.each([
    { platform: "pi", email: "work@example.com" },
    { platform: 42, email: "work@example.com" },
    {},
    { platform: "claude", email: 42 },
    { platform: "claude", email: false },
    { platform: "claude", email: {} },
    { platform: "claude", email: [] },
    { platform: "claude", email: " " },
    { platform: "claude", email: "invalid" },
  ])("rejects invalid arguments before mutating storage %j", async (args) => {
    const mutateAgentAccounts = mock(() => {
      throw new Error("unexpected storage access");
    });
    await expect(
      setPreferred(args, {
        storage: {
          agentAccounts: {
            mutateAgentAccounts,
          },
        },
      } as unknown as CommandContext),
    ).rejects.toThrow();
    expect(mutateAgentAccounts).not.toHaveBeenCalled();
  });

  test.each([{}, { email: null }, { extra: true }])(
    "omitted or null email clears only the selected platform %j",
    async (args) => {
      const store = {
        version: 1 as const,
        accounts: [],
        active: {},
        preferred: { claude: "work@example.com", codex: "code@example.com" },
      };
      const mutateAgentAccounts = mock(
        (mutate: (value: typeof store) => { store: unknown; result: unknown }) => {
          const next = mutate(store);
          expect(next.store).toEqual({ ...store, preferred: { codex: "code@example.com" } });
          return Promise.resolve(next.result);
        },
      );
      await expect(
        setPreferred({ platform: "claude", ...args }, {
          storage: {
            agentAccounts: {
              mutateAgentAccounts,
            },
          },
        } as unknown as CommandContext),
      ).resolves.toEqual({ codex: "code@example.com" });
      expect(mutateAgentAccounts).toHaveBeenCalledTimes(1);
    },
  );
});
