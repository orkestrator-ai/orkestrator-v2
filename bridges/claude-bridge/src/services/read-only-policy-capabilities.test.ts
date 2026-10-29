import { describe, expect, test } from "bun:test";
import {
  nativeAgentPolicyForBridge,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import { readOnlyTurnPolicy } from "./claude-query-config.js";
import {
  claudeDeniedTools,
  claudeDisallowedTools,
  createCoordinatorReadOnlyHook,
} from "./read-only-policy.js";

const builder: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
  capabilityPolicy: {
    deny: ["git.commit", "git.push", "github.write", "subagents", "mcp:docs.search-v2"],
  },
};

async function decide(policy: NativeAgentExecutionPolicy, toolName: string) {
  const hook = createCoordinatorReadOnlyHook(policy, [], { commandSandbox: "required" });
  const output = await hook(
    { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: {} } as never,
    undefined as never,
    { signal: new AbortController().signal } as never,
  );
  return (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision;
}

describe("Claude translation of graph capabilities", () => {
  test("sub-agents, MCP servers and git commands become tools and command rules", () => {
    expect(claudeDeniedTools(builder).toSorted()).toEqual([
      "Agent",
      "Bash(gh *)",
      "Bash(gh)",
      "Bash(git commit *)",
      "Bash(git commit)",
      "Bash(git push *)",
      "Bash(git push)",
      "Task",
      // The CLI matches rules on its normalised server name.
      "mcp__docs_search-v2__*",
    ]);
  });

  test("the backend's wire form translates exactly like the canonical one", () => {
    const wire = nativeAgentPolicyForBridge(
      { ...builder, capabilityPolicy: { deny: ["git.push", "subagents", "mcp:docs"] } },
      "claude",
    );
    expect(wire.capabilityPolicy).toEqual({
      deny: [],
      extendedDeny: ["git.push", "subagents", "mcp:docs"],
    });
    // Claude translates MCP denials itself, so it keeps project resources.
    expect(wire.projectResources).toBe(true);
    expect(claudeDisallowedTools(wire)?.toSorted()).toEqual([
      "Agent",
      "Bash(git push *)",
      "Bash(git push)",
      "Task",
      "mcp__docs__*",
    ]);
  });

  test("a read-only turn keeps the session's extra denials and nothing wider", () => {
    const turn = readOnlyTurnPolicy({
      ...builder,
      capabilityPolicy: { deny: ["shell", "subagents"], allow: ["web.search"] },
    });
    expect(turn.id).toBe("coordinator-read-only");
    expect(turn.capabilityPolicy).toEqual({
      deny: ["file.write", "file.patch", "shell.mutate", "network", "shell"],
      extendedDeny: ["subagents"],
    });
    expect(claudeDeniedTools(turn)).toEqual(
      expect.arrayContaining(["Bash", "Task", "Agent", "Write", "WebSearch"]),
    );
    // Without extra denials the fixed policy is unchanged.
    expect(readOnlyTurnPolicy(undefined).capabilityPolicy).toEqual({
      deny: ["file.write", "file.patch", "shell.mutate", "network"],
    });
  });

  test("the read-only hook refuses a denied MCP server and the sub-agent tool", async () => {
    const turn = readOnlyTurnPolicy({
      ...builder,
      capabilityPolicy: { deny: ["subagents", "mcp:orkestrator"] },
    });
    expect(await decide(turn, "Task")).toBe("deny");
    expect(await decide(turn, "mcp__orkestrator__send_message")).toBe("deny");
    expect(await decide(readOnlyTurnPolicy(undefined), "Task")).toBeUndefined();
  });
});
