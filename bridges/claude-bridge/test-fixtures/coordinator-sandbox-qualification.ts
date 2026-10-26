/** Shared pinned-CLI fixture for coordinator and paired AppArmor qualification. */
import { expect } from "bun:test";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  scriptedAnthropicEndpoint,
  scriptedClaudeEnv,
} from "../../../tests/conformance/execution-policy/scripted-anthropic.js";
import { withPolicyCliFixture } from "../../../tests/conformance/execution-policy/vendor-cli.js";
import { claudeExecutionSandbox } from "../src/services/claude-execution-sandbox.js";
import { claudePermissionMode } from "../src/services/claude-query-config.js";
import {
  claudeReadOnlyAllowedTools,
  coordinatorProcessPolicy,
  createCoordinatorReadOnlyHook,
} from "../src/services/read-only-policy.js";

export type Scenario =
  /** The ordinary provider sandbox: the checkout is writable. */
  | "default-sandbox-writes"
  /** A real required sandbox fails to read under stock Ubuntu AppArmor. */
  | "apparmor-sandbox-reads"
  /** The coordinator sandbox alone, no hook: the same write is refused. */
  | "coordinator-sandbox-refuses"
  /** The coordinator sandbox still lets a command read the checkout. */
  | "coordinator-sandbox-reads"
  /** The whole coordinator turn: the hook refuses the writing reader. */
  | "coordinator-hook-refuses"
  /**
   * Qualified without a working sandbox (on Linux, also a host whose
   * bubblewrap cannot nest the CLI's namespace): a reading command still runs.
   */
  | "unavailable-hook-reads"
  | "unavailable-hook-refuses-quoted"
  | "unavailable-hook-refuses-escaped"
  | "unavailable-hook-refuses-glob"
  | "unavailable-hook-refuses-abbreviation";

const coordinatorPolicy = coordinatorProcessPolicy({});

export async function qualifyCoordinatorSandbox(scenario: Scenario, cliPath?: string) {
  return withPolicyCliFixture(async (fixture) => {
    // sandbox-exec matches canonical paths; macOS /var is a symlink.
    const cwd = await realpath(fixture.cwd);
    await writeFile(join(cwd, "in.txt"), "a\na\nb\n");
    const unavailable = scenario.startsWith("unavailable-");
    const command =
      scenario === "unavailable-hook-refuses-quoted"
        ? "sort '-oout.txt' in.txt"
        : scenario === "unavailable-hook-refuses-escaped"
          ? String.raw`sort --out\put=out.txt in.txt`
          : scenario === "unavailable-hook-refuses-glob"
            ? "uniq [io]*.txt"
            : scenario === "unavailable-hook-refuses-abbreviation"
              ? "sort --out=out.txt in.txt"
              : scenario === "coordinator-sandbox-reads" ||
                  scenario === "apparmor-sandbox-reads" ||
                  scenario === "unavailable-hook-reads"
                ? "cat in.txt"
                : scenario === "coordinator-hook-refuses"
                  ? "uniq in.txt out.txt"
                  : "printf written > out.txt";
    if (scenario === "unavailable-hook-refuses-glob")
      await writeFile(join(cwd, "out.txt"), "sentinel\n");
    const endpoint = scriptedAnthropicEndpoint(() => [
      [
        {
          type: "tool_use",
          id: "coordinator_probe",
          name: "Bash",
          input: { command, description: "Coordinator sandbox fixture" },
        },
      ],
      [{ type: "text", text: "Done." }],
    ]);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const coordinatorTurn = scenario === "coordinator-hook-refuses" || unavailable;
    const options: Options = {
      cwd,
      ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
      model: "claude-sonnet-4-6",
      maxTurns: 2,
      persistSession: false,
      settingSources: [],
      abortController: controller,
      ...(coordinatorTurn
        ? {
            // The mode the bridge gives a coordinator turn; the hook decides first.
            permissionMode: claudePermissionMode(coordinatorPolicy, undefined),
            allowedTools: claudeReadOnlyAllowedTools({ policy: coordinatorPolicy }),
            hooks: {
              PreToolUse: [{ hooks: [createCoordinatorReadOnlyHook(coordinatorPolicy, [])] }],
            },
          }
        : {
            tools: ["Bash"],
            permissionMode: "bypassPermissions" as const,
            allowDangerouslySkipPermissions: true,
          }),
      sandbox:
        scenario === "default-sandbox-writes"
          ? claudeExecutionSandbox(
              {
                id: "interactive-host",
                sandbox: "provider",
                approvals: "auto-approve",
                projectResources: false,
                networkAccess: "restricted",
              },
              false,
            )
          : claudeExecutionSandbox(coordinatorPolicy, false, {
              cwd,
              commandSandbox: unavailable ? "unavailable" : "required",
            }),
      env: {
        ...scriptedClaudeEnv(fixture, endpoint, join(fixture.root, "claude")),
        // Hides bubblewrap, so the refusals below cannot lean on a sandbox.
        // The reading case keeps PATH: the bridge leaves the sandbox off there.
        ...(unavailable && scenario !== "unavailable-hook-reads" && process.platform === "linux"
          ? { PATH: fixture.root }
          : {}),
      },
      ...(unavailable && process.platform === "darwin"
        ? {
            spawnClaudeCodeProcess: (options) =>
              spawn(
                "/usr/bin/sandbox-exec",
                [
                  "-p",
                  '(version 1)(allow default)(deny process-exec (literal "/usr/bin/sandbox-exec"))',
                  options.command,
                  ...options.args,
                ],
                {
                  cwd: options.cwd,
                  env: options.env,
                  signal: options.signal,
                  stdio: ["pipe", "pipe", "pipe"],
                },
              ),
          }
        : {}),
      stderr: () => {},
    };
    const messages: SDKMessage[] = [];
    let failure: unknown;
    try {
      for await (const message of query({ prompt: "Run the fixture", options })) {
        messages.push(message);
        if (messages.length > 64) {
          controller.abort();
          throw new Error("CLI fixture message bound exceeded");
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timeout);
      endpoint.stop();
    }
    expect(failure).toBeUndefined();
    expect(controller.signal.aborted).toBe(false);
    expect(endpoint.modelCalls()).toBe(2);
    const toolResults = messages.flatMap((message) =>
      message.type === "user" && Array.isArray(message.message.content)
        ? message.message.content.filter((block) => block.type === "tool_result")
        : [],
    );
    expect(toolResults).toHaveLength(1);
    const written = existsSync(join(cwd, "out.txt"));
    // A command that should succeed reports why it failed, not only that it did.
    const commandFailure = (block: (typeof toolResults)[number]) =>
      block.is_error === true ? JSON.stringify(block.content) : undefined;
    if (scenario === "default-sandbox-writes") {
      expect(commandFailure(toolResults[0]!)).toBeUndefined();
      expect(written).toBe(true);
    } else if (scenario === "apparmor-sandbox-reads") {
      expect(toolResults[0]!.is_error).toBe(true);
      const output = JSON.stringify(toolResults[0]!.content);
      expect(output).toContain("apply-seccomp");
      expect(output).toContain("setgroups");
      expect(output).toContain("Permission denied");
      expect(written).toBe(false);
    } else if (scenario === "coordinator-sandbox-reads" || scenario === "unavailable-hook-reads") {
      expect(commandFailure(toolResults[0]!)).toBeUndefined();
      expect(JSON.stringify(toolResults[0]!.content)).toContain("a\\na\\nb");
    } else {
      expect(toolResults[0]!.is_error).toBe(true);
      expect(written).toBe(scenario === "unavailable-hook-refuses-glob");
      if (scenario === "unavailable-hook-refuses-glob")
        expect(await Bun.file(join(cwd, "out.txt")).text()).toBe("sentinel\n");
      if (scenario === "coordinator-hook-refuses") {
        expect(JSON.stringify(toolResults[0]!.content)).toContain("Coordinator is read-only");
      }
    }
    return {
      scenario,
      modelCalls: endpoint.modelCalls(),
      toolError: toolResults[0]!.is_error === true,
      written,
    };
  });
}
