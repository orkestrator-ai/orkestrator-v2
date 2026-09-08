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

  test("waiting tools are refused with the reason, not just refused", async () => {
    for (const tool of ["Monitor", "ScheduleWakeup", "CronCreate", "CronList", "CronDelete"]) {
      const decision = await decide(tool, {});
      expect(decision?.permissionDecision).toBe("deny");
      // The allowlist would refuse these anyway. What matters is that the model
      // is told why, so it ends its turn instead of trying the next tool that
      // might let it wait.
      expect(decision?.permissionDecisionReason).toContain("do not wait");
      expect(decision?.permissionDecisionReason).toContain("end your turn");
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
      // A newline separates commands exactly as `;` does, while a whitespace
      // split reduces the pair to its harmless-looking first half.
      "ls\nrm -rf .",
      "printf x\nrm y",
      "cat a\r\ntouch b",
      "git status\n\ngit push",
    ]) {
      const verdict = isReadOnlyShellCommand(command);
      expect(verdict.allowed).toBe(false);
      expect((await decide("Bash", { command }))?.permissionDecision).toBe("deny");
    }
  });

  test("a program that launches another program is not a read", async () => {
    // `env` was allowlisted, which made the check inspect the launcher rather
    // than the command that actually runs. `git difftool` is the same shape:
    // it reads, but it reads by running whatever `diff.tool` names — and that
    // comes from the checkout's own configuration.
    for (const command of [
      "env rm -rf src",
      "env touch pwned",
      "env",
      "git difftool HEAD~1",
      "git difftool --tool=evil",
    ]) {
      expect(isReadOnlyShellCommand(command).allowed).toBe(false);
      expect((await decide("Bash", { command }))?.permissionDecision).toBe("deny");
    }
    // The reading form it replaces stays available.
    expect(isReadOnlyShellCommand("git diff HEAD~1").allowed).toBe(true);
  });

  test("an allowlisted program is still refused when its arguments write", async () => {
    for (const command of [
      "find . -delete",
      "find . -execdir rm {} +",
      "find . -fprintf out.txt %p",
      "sort -o out.txt in.txt",
      "sort --output=out.txt in.txt",
      "yq -i '.a=1' f.yaml",
      "yq --inplace '.a=1' f.yaml",
      "fd -x rm",
      "rg --pre ./evil.sh TODO",
      "date -s 2020-01-01",
    ]) {
      expect(isReadOnlyShellCommand(command).allowed).toBe(false);
      expect((await decide("Bash", { command }))?.permissionDecision).toBe("deny");
    }
    // `-execdir rm {} +` is caught earlier as composition; the argument rule is
    // what refuses the forms that carry no shell metacharacter at all.
    expect(isReadOnlyShellCommand("find . -delete").reason).toContain(
      "argument that writes or runs another program",
    );
    // The reading forms of the same tools stay available.
    for (const command of [
      "find . -name *.ts",
      "sort in.txt",
      "yq '.a' f.yaml",
      "fd -e ts",
      "rg TODO src",
      "date",
    ]) {
      expect(isReadOnlyShellCommand(command).allowed).toBe(true);
    }
  });

  test("a git subcommand that reads or writes by argument is judged on the argument", async () => {
    for (const command of [
      "git branch -D feature",
      "git branch --delete feature",
      "git branch new-feature",
      "git tag -d v1.0",
      "git tag v1.0",
      "git remote remove origin",
      "git remote set-url origin https://example.invalid/x.git",
      "git config user.email someone@example.invalid",
      "git config --global user.email someone@example.invalid",
      "git config --unset user.email",
      "git config set user.email someone@example.invalid",
    ]) {
      const verdict = isReadOnlyShellCommand(command);
      expect(verdict.allowed).toBe(false);
      expect((await decide("Bash", { command }))?.permissionDecision).toBe("deny");
    }
    for (const command of [
      "git branch",
      "git branch -a",
      "git branch --list feature-*",
      "git branch --show-current",
      "git tag",
      "git tag --list v1.*",
      "git remote",
      "git remote -v",
      "git remote show origin",
      "git remote get-url origin",
      "git config user.email",
      "git config --global user.email",
      "git config --get user.email",
      "git config -l",
      "git config list",
    ]) {
      expect(isReadOnlyShellCommand(command).allowed).toBe(true);
      expect(await decide("Bash", { command })).toBeUndefined();
    }
  });

  test("an inherited object property is not a rule", async () => {
    // The subcommand comes from the model. A plain-object lookup for these
    // returns a function off `Object.prototype`, and calling it yields a truthy
    // value — an allow decision reached without any rule matching.
    for (const command of [
      "git constructor",
      "git toString",
      "git valueOf --oneline",
      "git hasOwnProperty branch",
    ]) {
      expect(isReadOnlyShellCommand(command).allowed).toBe(false);
      expect((await decide("Bash", { command }))?.permissionDecision).toBe("deny");
    }
  });

  test("a refusal names the command it refused rather than a template fragment", () => {
    const verdict = isReadOnlyShellCommand("git commit -m x");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe(
      "Coordinator is read-only, so `git commit` is not available here. Delegate it to a worker environment.",
    );
    expect(verdict.reason).not.toContain(".trim()");
    // A bare `git` with no subcommand still reads back cleanly.
    expect(isReadOnlyShellCommand("git").reason).toBe(
      "Coordinator is read-only, so `git` is not available here. Delegate it to a worker environment.",
    );
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
