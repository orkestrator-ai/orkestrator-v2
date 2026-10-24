/**
 * Offline qualification of the coordinator's command sandbox on the pinned CLI.
 *
 * The SDK sandbox lets a command write its working directory by default, and a
 * coordinator's working directory is the user's checkout. Before the
 * coordinator sandbox denied it, `uniq in.txt out.txt` (a reading program the
 * hook admitted) wrote the checkout on a host reported as `enforced`.
 */
import { describe, expect, test } from "bun:test";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  scriptedAnthropicEndpoint,
  scriptedClaudeEnv,
} from "../../../tests/conformance/execution-policy/scripted-anthropic.js";
import { withPolicyCliFixture } from "../../../tests/conformance/execution-policy/vendor-cli.js";
import { claudeExecutionSandbox } from "./services/claude-execution-sandbox.js";
import { claudePermissionMode } from "./services/claude-query-config.js";
import {
  claudeReadOnlyAllowedTools,
  coordinatorProcessPolicy,
  createCoordinatorReadOnlyHook,
} from "./services/read-only-policy.js";

type Scenario =
  /** The ordinary provider sandbox: the checkout is writable. */
  | "default-sandbox-writes"
  /** The coordinator sandbox alone, no hook: the same write is refused. */
  | "coordinator-sandbox-refuses"
  /** The coordinator sandbox still lets a command read the checkout. */
  | "coordinator-sandbox-reads"
  /** The whole coordinator turn: the hook refuses the writing reader. */
  | "coordinator-hook-refuses";

const coordinatorPolicy = coordinatorProcessPolicy({});

async function qualify(scenario: Scenario) {
  return withPolicyCliFixture(async (fixture) => {
    // sandbox-exec matches canonical paths; macOS /var is a symlink.
    const cwd = await realpath(fixture.cwd);
    await writeFile(join(cwd, "in.txt"), "a\na\nb\n");
    const command =
      scenario === "coordinator-sandbox-reads"
        ? "cat in.txt"
        : scenario === "coordinator-hook-refuses"
          ? "uniq in.txt out.txt"
          : "printf written > out.txt";
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
    const coordinatorTurn = scenario === "coordinator-hook-refuses";
    const options: Options = {
      cwd,
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
              commandSandbox: "required",
            }),
      env: scriptedClaudeEnv(fixture, endpoint, join(fixture.root, "claude")),
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
    if (scenario === "default-sandbox-writes") {
      expect(toolResults[0]!.is_error).not.toBe(true);
      expect(written).toBe(true);
    } else if (scenario === "coordinator-sandbox-reads") {
      expect(toolResults[0]!.is_error).not.toBe(true);
      expect(JSON.stringify(toolResults[0]!.content)).toContain("a\\na\\nb");
    } else {
      expect(toolResults[0]!.is_error).toBe(true);
      expect(written).toBe(false);
      if (scenario === "coordinator-hook-refuses") {
        expect(JSON.stringify(toolResults[0]!.content)).toContain("Coordinator is read-only");
      }
    }
  });
}

const supported = process.platform === "darwin" || process.platform === "linux";
describe("Claude coordinator sandbox qualification", () => {
  for (const scenario of [
    "default-sandbox-writes",
    "coordinator-sandbox-refuses",
    "coordinator-sandbox-reads",
    "coordinator-hook-refuses",
  ] as const) {
    (supported ? test : test.skip)(scenario, () => qualify(scenario), 20_000);
  }
});
