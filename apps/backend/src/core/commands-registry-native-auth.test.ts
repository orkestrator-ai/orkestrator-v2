import { describe, expect, mock, test } from "bun:test";
import { createCommandRegistry, type CommandContext } from "./commands.js";

const identity = { environmentId: "env-1", agent: "codex", logicalSessionKey: "tab-1" };
const registry = createCommandRegistry();
function command(name: string) {
  const handler = registry.get(name);
  if (!handler) throw new Error(`${name} is not registered`);
  return handler;
}

describe("on-demand native auth command", () => {
  test("returns the provider payload through the command registry", async () => {
    const status = { state: "signed-out", signIn: { kind: "browser-url" } };
    const readProjectionAuthStatus = mock(async () => status);
    const context = { nativeAgents: { readProjectionAuthStatus } } as unknown as CommandContext;
    expect(await command("get_native_agent_auth_status")(identity, context)).toEqual(status);
    expect(readProjectionAuthStatus).toHaveBeenCalledWith(identity);
  });

  test.each(["environmentId", "agent", "logicalSessionKey"])(
    "validates %s before calling the service",
    async (field) => {
      const readProjectionAuthStatus = mock(async () => null);
      const context = { nativeAgents: { readProjectionAuthStatus } } as unknown as CommandContext;
      for (const invalid of [undefined, 123, "", "   "]) {
        await expect(
          command("get_native_agent_auth_status")({ ...identity, [field]: invalid }, context),
        ).rejects.toThrow(field);
      }
      expect(readProjectionAuthStatus).not.toHaveBeenCalled();
    },
  );

  test("rejects unknown agent names", async () => {
    const readProjectionAuthStatus = mock(async () => null);
    const context = { nativeAgents: { readProjectionAuthStatus } } as unknown as CommandContext;
    await expect(
      command("get_native_agent_auth_status")({ ...identity, agent: "unknown" }, context),
    ).rejects.toThrow("Native agent provider is invalid");
    expect(readProjectionAuthStatus).not.toHaveBeenCalled();
  });

  test("rejects when the native service is unavailable", async () => {
    await expect(
      command("get_native_agent_auth_status")(identity, {} as CommandContext),
    ).rejects.toThrow("Native agent service is unavailable");
  });

  test("preserves null and propagates provider failures", async () => {
    const readProjectionAuthStatus = mock(async (): Promise<null> => null);
    const context = { nativeAgents: { readProjectionAuthStatus } } as unknown as CommandContext;
    await expect(command("get_native_agent_auth_status")(identity, context)).resolves.toBeNull();
    readProjectionAuthStatus.mockImplementation(async () => {
      throw new Error("Bridge unavailable");
    });
    await expect(command("get_native_agent_auth_status")(identity, context)).rejects.toThrow(
      "Bridge unavailable",
    );
  });
});

describe("legacy discovery requests", () => {
  test("accepts auth but requests only current sections", async () => {
    const result = {
      status: "snapshot",
      value: { models: [], commands: [], mcp: [], runtime: {} },
    };
    const getDiscoveryUpdate = mock(async () => result);
    const context = { nativeAgents: { getDiscoveryUpdate } } as unknown as CommandContext;
    expect(
      await command("get_native_agent_discovery_update")(
        { ...identity, viewVersion: 1, sections: ["models", "commands", "mcp", "auth", "runtime"] },
        context,
      ),
    ).toEqual(result);
    expect(getDiscoveryUpdate).toHaveBeenCalledWith({
      ...identity,
      viewVersion: 1,
      sections: ["models", "commands", "mcp", "runtime"],
      knownToken: undefined,
      forceSnapshot: undefined,
    });
  });

  test.each(
    [[], ["unknown"], [123], ["models", "models", "models", "models", "models", "models"]].map(
      (sections) => ({ sections }),
    ),
  )("still rejects malformed sections %j", async ({ sections }) => {
    const getDiscoveryUpdate = mock(async () => null);
    const context = { nativeAgents: { getDiscoveryUpdate } } as unknown as CommandContext;
    await expect(
      command("get_native_agent_discovery_update")(
        { ...identity, viewVersion: 1, sections },
        context,
      ),
    ).rejects.toThrow("Native agent discovery sections are invalid");
    expect(getDiscoveryUpdate).not.toHaveBeenCalled();
  });
});
