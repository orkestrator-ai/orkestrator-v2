import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { mcpManagementErrorFromUnknown } from "@orkestrator/protocol/mcp-management";

import { createCommandRegistry } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import { createMcpRuntimeProbe } from "./commands-registry-mcp.js";
import { SENTINEL, createFixture, type Fixture } from "./mcp-management/test-support.js";

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

describe("MCP management command failures carry a correlation id", () => {
  let fixture: Fixture;
  let context: CommandContext;
  const commands = createCommandRegistry();
  const invoke = (name: string, args: Record<string, unknown> = {}) =>
    Promise.resolve(commands.get(name)!(args, context));
  let warnings: string[];
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fixture = createFixture();
    context = {
      mcpManagement: fixture.service,
      emit: () => undefined,
    } as unknown as CommandContext;
    warnings = [];
    warn = spyOn(console, "warn").mockImplementation((...parts: unknown[]) => {
      warnings.push(parts.map(String).join(" "));
    });
  });

  afterEach(() => {
    warn.mockRestore();
    fixture.cleanup();
  });

  test("a structured failure gets a reference that matches exactly one log line", async () => {
    const error = await invoke("get_mcp_management_snapshot", {
      targetId: "../../etc/SENTINEL-path",
    }).catch((failure: unknown) => failure);
    const detail = mcpManagementErrorFromUnknown(error);
    expect(detail?.code).toBe("unknown-target");
    expect(detail?.correlationId).toMatch(/^mcpe-[A-Za-z0-9_-]+$/);
    // The reference is stripped back out of the user-facing message.
    expect(detail?.message).not.toContain("[ref:");
    const lines = warnings.filter((line) => line.includes(detail!.correlationId!));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("code=unknown-target");
    expect(lines[0]).not.toContain("SENTINEL-path");
  });

  test("an unexpected error becomes `internal` without leaking its text", async () => {
    context = {
      mcpManagement: {
        snapshot: async () => {
          throw new Error(`EACCES /home/user/.claude.json ${SENTINEL}`);
        },
      },
      emit: () => undefined,
    } as unknown as CommandContext;
    const error = await invoke("get_mcp_management_snapshot", { targetId: "x" }).catch(
      (failure: unknown) => failure,
    );
    const detail = mcpManagementErrorFromUnknown(error);
    expect(detail?.code).toBe("internal");
    expect(detail?.correlationId).toBeDefined();
    expect(String((error as Error).message)).not.toContain(SENTINEL);
    expect(warnings.join("\n")).not.toContain(SENTINEL);
    expect(warnings.join("\n")).not.toContain(".claude.json");
  });
});

describe("MCP management rollout commands", () => {
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
      storage: {
        loadConfig: async () => ({ global: { mcpManagement: fixture.rollout.value } }),
        updateMcpManagementRollout: async (settings: unknown) => {
          fixture.rollout.value = settings;
        },
      },
    } as unknown as CommandContext;
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("defaults to everything enabled and narrows per provider", async () => {
    expect(await invoke("get_mcp_management_rollout")).toMatchObject({ enabled: true });
    const next = (await invoke("set_mcp_management_rollout", {
      writeProviders: ["claude"],
    })) as { writeProviders: string[]; applyProviders: string[] };
    expect(next.writeProviders).toEqual(["claude"]);
    expect(next.applyProviders.length).toBeGreaterThan(1);
    const list = (await invoke("list_mcp_management_targets")) as {
      targets: Array<{
        provider: string;
        capabilities: { operations: { add: { supported: boolean; reason?: string } } };
      }>;
    };
    const pi = list.targets.find((target) => target.provider === "pi")!;
    expect(pi.capabilities.operations.add).toMatchObject({ supported: false });
    expect(pi.capabilities.operations.add.reason).toContain("not enabled");
    const claude = list.targets.find((target) => target.provider === "claude")!;
    expect(claude.capabilities.operations.add.supported).toBe(true);
  });

  test("rejects unknown providers", async () => {
    const error = await invoke("set_mcp_management_rollout", { applyProviders: ["nope"] }).catch(
      (failure: unknown) => failure,
    );
    expect(mcpManagementErrorFromUnknown(error)?.code).toBe("invalid-request");
  });
});

describe("Codex reload probe", () => {
  test("reloads at the environment level and never resolves a session", async () => {
    const calls: unknown[][] = [];
    const probe = createMcpRuntimeProbe({
      nativeAgents: {
        reloadMcpConfigurationIfRunning: async (...args: unknown[]) => {
          calls.push(args);
          return "reloaded";
        },
        performProjectionMcpAction: async () => {
          throw new Error("Native agent session was not found");
        },
      },
    } as unknown as CommandContext);
    await expect(probe.reloadCodex("env-1")).resolves.toBe("reloaded");
    expect(calls).toEqual([["env-1", "codex"]]);
  });

  test("with no native agent service nothing is running", async () => {
    const probe = createMcpRuntimeProbe({} as unknown as CommandContext);
    await expect(probe.reloadCodex("env-1")).resolves.toBe("not-running");
  });
});

describe("MCP configuration evidence probe", () => {
  test("reads through the observation-only service path and copies only the evidence fields", async () => {
    const calls: unknown[][] = [];
    const probe = createMcpRuntimeProbe({
      nativeAgents: {
        mcpConfigEvidenceIfRunning: async (...args: unknown[]) => {
          calls.push(args);
          return {
            state: "evidence",
            evidence: {
              sources: { user: "absent" },
              observedAt: "2026-09-24T10:00:00.000Z",
              scope: "session",
              extra: "dropped",
            },
          };
        },
      },
    } as unknown as CommandContext);
    expect(await probe.mcpConfigEvidence("env-1", "claude", "env-env-1:tab-1")).toEqual({
      state: "evidence",
      evidence: {
        sources: { user: "absent" },
        observedAt: "2026-09-24T10:00:00.000Z",
        scope: "session",
      },
    });
    expect(calls).toEqual([["env-1", "claude", "env-env-1:tab-1"]]);
  });

  test("with no native agent service nothing is running", async () => {
    const probe = createMcpRuntimeProbe({} as unknown as CommandContext);
    expect(await probe.mcpConfigEvidence("env-1", "pi", "k")).toEqual({ state: "not-running" });
  });

  test("reports a local bridge's recorded process id, and none for containers", async () => {
    const probe = createMcpRuntimeProbe({
      storage: {
        loadEnvironments: async () => [
          { id: "local", environmentType: "local", status: "running", grokBridgePid: 4242 },
          { id: "stopped", environmentType: "local", status: "stopped", grokBridgePid: null },
          { id: "box", environmentType: "containerized", status: "running", grokBridgePid: 7 },
        ],
      },
    } as unknown as CommandContext);
    const environments = await probe.environments();
    expect(environments.map((environment) => environment.bridgePid?.("grok"))).toEqual([
      4242,
      undefined,
      undefined,
    ]);
  });
});
