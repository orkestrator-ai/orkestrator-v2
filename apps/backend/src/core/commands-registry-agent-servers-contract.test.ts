/**
 * The `agent-servers` commands are registered with their definitions (plan
 * item 7009): the registry holds each definition and advertises the domain,
 * a workspace grant runs exactly its `workspace` commands, the keys the
 * handlers read survive decoding (a defined command drops undeclared keys),
 * and the two retired commands count their calls.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { AGENT_SERVERS_COMMANDS } from "@orkestrator/protocol/contract/domains/agent-servers";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { grantAdmits } from "./nodes/workspace-grant-test-support.js";

afterEach(() => {
  mock.restore();
});

test("registers every agent-servers command with its definition", () => {
  const registry = createCommandRegistry();
  for (const def of AGENT_SERVERS_COMMANDS) {
    expect({ name: def.name, defined: registry.contracts.get(def.name) === def }).toEqual({
      name: def.name,
      defined: true,
    });
  }
  expect(registry.helloDomains()["agent-servers"]).toEqual({ min: 1, max: 1 });
});

test("a workspace grant runs exactly the agent-servers commands defined as workspace", () => {
  for (const def of AGENT_SERVERS_COMMANDS) {
    expect({ name: def.name, admitted: grantAdmits(def.name) }).toEqual({
      name: def.name,
      admitted: def.access === "workspace",
    });
  }
});

test("the catalogue cache keeps the keys its handler reads and drops the rest", async () => {
  const getOpenCodeModelCatalog = mock(async () => null);
  const context = {
    storage: { getOpenCodeModelCatalog, loadConfig: mock(async () => ({ global: {} })) },
  } as unknown as CommandContext;
  const command = createCommandRegistry().get("get_opencode_model_catalog_cache")!;
  await expect(command({ projectId: " project-1 ", future: true }, context)).resolves.toBeNull();
  expect(getOpenCodeModelCatalog).toHaveBeenCalledWith("project-1");
});

test("the GitHub sign-in cancel keeps its operation id", async () => {
  const cancel = mock(() => ({ state: "idle" }));
  const context = {
    runtime: { localServers: { gitHubCliLogin: { cancel } } },
  } as unknown as CommandContext;
  const command = createCommandRegistry().get("cancel_github_cli_login")!;
  await command({ operationId: "op-1", future: 1 }, context);
  expect(cancel).toHaveBeenCalledWith("op-1");
});

test("await_bridge_ready keeps its texts for a missing or malformed key", async () => {
  const command = createCommandRegistry().get("await_bridge_ready")!;
  const context = {} as CommandContext;
  await expect(
    (async () => command({ environmentId: "env-1", agent: "codex" }, context))(),
  ).rejects.toThrow("Expected timeoutMs to be a number");
  await expect(
    (async () => command({ environmentId: "env-1", agent: "codex", timeoutMs: "5" }, context))(),
  ).rejects.toThrow("Expected timeoutMs to be a number");
  await expect(
    (async () => command({ environmentId: "env-1", agent: "gemini", timeoutMs: 5_000 }, context))(),
  ).rejects.toThrow("agent must be one of");
});

test("the retired commands still answer and count their calls", async () => {
  const record = mock((_id: string) => undefined);
  const original = compatibilityPathUsage.record.bind(compatibilityPathUsage);
  compatibilityPathUsage.record = record as typeof compatibilityPathUsage.record;
  try {
    const registry = createCommandRegistry();
    const context = {
      runtimeFlavor: "agent-test",
      resourceRoot: "/nonexistent-orkestrator-resources",
      appRoot: "/nonexistent-orkestrator-app",
    } as unknown as CommandContext;
    expect(registry.get("cleanup_stale_local_servers_cmd")!({}, context)).toBeUndefined();
    await registry.get("check_codex_cli")!({}, context);
    expect(record.mock.calls).toEqual([
      ["retired-command.cleanup-stale-local-servers"],
      ["retired-command.provider-cli-check"],
    ]);
  } finally {
    compatibilityPathUsage.record = original;
  }
});
