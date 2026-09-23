import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mcpManagementErrorFromUnknown } from "@orkestrator/protocol/mcp-management";

import { createCommandRegistry } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import { createFixture, type Fixture } from "./mcp-management/test-support.js";

describe("MCP management commands", () => {
  let fixture: Fixture;
  let context: CommandContext;
  const commands = createCommandRegistry();
  const invoke = (name: string, args: Record<string, unknown> = {}) =>
    Promise.resolve(commands.get(name)!(args, context));

  beforeEach(() => {
    fixture = createFixture();
    context = {
      mcpManagement: fixture.service,
      emit: () => undefined,
    } as unknown as CommandContext;
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("registers every management command", () => {
    for (const name of [
      "list_mcp_management_targets",
      "get_mcp_management_snapshot",
      "get_mcp_definition",
      "validate_mcp_mutation",
      "mutate_mcp_definition",
      "apply_mcp_configuration",
      "get_mcp_operation",
      "cancel_mcp_apply",
    ]) {
      expect(commands.has(name)).toBe(true);
    }
  });

  test("routes a save through the command map and refuses path-shaped target ids", async () => {
    const list = (await invoke("list_mcp_management_targets")) as {
      targets: Array<{ provider: string; targetId: string }>;
    };
    const targetId = list.targets.find((target) => target.provider === "pi")!.targetId;
    const saved = (await invoke("mutate_mcp_definition", {
      mutation: {
        requestId: "cmd-1",
        targetId,
        applyIntent: "save",
        operation: {
          kind: "add",
          sourceId: "pi:user",
          expectedRevision: null,
          definition: { name: "via-command", transport: "http", url: "https://a.example/mcp" },
        },
      },
    })) as { operation: { phase: string } };
    expect(saved.operation.phase).toBe("saved");
    expect(JSON.parse(fixture.read("home/.pi/agent/mcp.json")).mcpServers["via-command"]).toEqual({
      url: "https://a.example/mcp",
    });

    const error = await invoke("get_mcp_management_snapshot", { targetId: "../../etc" }).catch(
      (failure: unknown) => failure,
    );
    expect(mcpManagementErrorFromUnknown(error)?.code).toBe("unknown-target");
  });
});
