import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  BRIDGE_EXECUTION_POLICY_ENV,
  claudeDeniedTools,
  claudeReadOnlyAllowedTools,
  claudeReadOnlySandbox,
  coordinatorProcessPolicy,
  createCoordinatorReadOnlyHook,
  effectiveExecutionPolicy,
  isReadOnlyShellCommand,
} from "./read-only-policy.js";

const coordinatorPolicy: NativeAgentExecutionPolicy = coordinatorProcessPolicy();

async function decide(toolName: string, toolInput: Record<string, unknown> = {}) {
  const hook = createCoordinatorReadOnlyHook(coordinatorPolicy);
  const output = await hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolInput,
    } as never,
    undefined as never,
    { signal: new AbortController().signal } as never,
  );
  return (
    output as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;
}

describe("Claude coordinator read-only policy", () => {
  test("capabilities translate to Claude's own tool names", () => {
    // The policy's `toolPolicy` carries Codex's names, which match nothing
    // here; this is the mapping that makes one policy work on both.
    expect(claudeDeniedTools(coordinatorPolicy).toSorted()).toEqual([
      "ApplyPatch",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Write",
    ]);
  });

  test("the allowlist includes Orkestrator's tools, because dontAsk denies the rest", () => {
    const allowed = claudeReadOnlyAllowedTools({ agentMcpServerNames: ["orkestrator"] });
    expect(allowed).toContain("Read");
    expect(allowed).toContain("mcp__orkestrator__*");
    expect(allowed).not.toContain("Write");
    expect(allowed).not.toContain("Edit");
    // Without a server there is nothing to allow, and no wildcard is emitted
    // that could match some other server.
    expect(claudeReadOnlyAllowedTools({ agentMcpServerNames: [] })).not.toContain(
      "mcp__orkestrator__*",
    );
  });

  test("the sandbox closes the model's own escape hatch", () => {
    const sandbox = claudeReadOnlySandbox(coordinatorPolicy);
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    expect(sandbox.failIfUnavailable).toBe(true);
    expect(sandbox.excludedCommands).toEqual([]);
    expect(sandbox.network).toMatchObject({ strictAllowlist: true, allowedDomains: [] });
    expect(sandbox.network.allowLocalBinding).toBe(false);
  });

  test("write and network tools are denied by the hook", async () => {
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch"]) {
      const decision = await decide(tool, {});
      expect(decision?.permissionDecision).toBe("deny");
      expect(decision?.permissionDecisionReason).toContain("read-only");
    }
  });

  test("read tools pass through untouched", async () => {
    for (const tool of ["Read", "Glob", "Grep", "TodoWrite"]) {
      expect(await decide(tool, {})).toBeUndefined();
    }
  });

  test("only Orkestrator's own MCP tools are reachable", async () => {
    expect(await decide("mcp__orkestrator__launch_environment", {})).toBeUndefined();
    const denied = await decide("mcp__project-server__deploy", {});
    expect(denied?.permissionDecision).toBe("deny");
  });

  test("a command asking to leave the sandbox is denied", async () => {
    const decision = await decide("Bash", {
      command: "ls",
      dangerouslyDisableSandbox: true,
    });
    expect(decision?.permissionDecision).toBe("deny");
    expect(decision?.permissionDecisionReason).toContain("outside the sandbox");
  });

  test("read-only commands are allowed and mutating ones are not", async () => {
    for (const command of [
      "ls -la",
      "rg TODO src",
      "git status",
      "git log --oneline -5",
      "/usr/bin/cat README.md",
      "gh api repos/foo/bar",
    ]) {
      expect(isReadOnlyShellCommand(command).allowed).toBe(true);
      expect(await decide("Bash", { command })).toBeUndefined();
    }
    for (const command of [
      "rm -rf src",
      "touch new-file",
      "git commit -m x",
      "git push",
      "npm install",
      "gh pr create",
      "tee out.txt",
    ]) {
      expect(isReadOnlyShellCommand(command).allowed).toBe(false);
      expect((await decide("Bash", { command }))?.permissionDecision).toBe("deny");
    }
  });

  test("shell composition is refused, because the checked command is not the one that runs", async () => {
    for (const command of [
      "cat a > b",
      "echo $(rm -rf .)",
      "ls; rm -rf .",
      "ls && touch x",
      "cat a | tee b",
      "sudo ls",
      "echo `whoami`",
    ]) {
      const verdict = isReadOnlyShellCommand(command);
      expect(verdict.allowed).toBe(false);
      expect((await decide("Bash", { command }))?.permissionDecision).toBe("deny");
    }
  });

  test("an empty command is not a mutation", () => {
    expect(isReadOnlyShellCommand("   ").allowed).toBe(true);
  });

  test("process authority replaces whatever a caller asked for", () => {
    const permissive: NativeAgentExecutionPolicy = {
      id: "interactive-host",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "full",
    };
    const coordinatorEnv = { [BRIDGE_EXECUTION_POLICY_ENV]: "coordinator-read-only" };
    expect(effectiveExecutionPolicy(permissive, coordinatorEnv)).toMatchObject({
      id: "coordinator-read-only",
      approvals: "deny",
      projectResources: false,
    });
    // A restored session that carries no policy at all is the case a restart
    // hits, and it must still be a coordinator inside a coordinator process.
    expect(effectiveExecutionPolicy(undefined, coordinatorEnv)).toMatchObject({
      id: "coordinator-read-only",
    });
    // Outside one, nothing is imposed.
    expect(effectiveExecutionPolicy(permissive, {})).toBe(permissive);
    expect(effectiveExecutionPolicy(undefined, {})).toBeUndefined();
  });
});
