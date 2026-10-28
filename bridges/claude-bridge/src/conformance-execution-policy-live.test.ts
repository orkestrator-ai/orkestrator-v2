/** Offline qualification of the pinned CLI, with a scripted local model endpoint. */
import { describe, expect, test } from "bun:test";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  scriptedAnthropicEndpoint,
  scriptedClaudeEnv,
} from "../../../tests/conformance/execution-policy/scripted-anthropic.js";
import { withPolicyCliFixture } from "../../../tests/conformance/execution-policy/vendor-cli.js";
import { claudeExecutionSandbox } from "./services/claude-execution-sandbox.js";

type Scenario = "control" | "escape" | "network" | "unavailable";

// Native CLI launch and SDK initialization slow down under the aggregate suite.
// Keep that startup budget separate from the scripted model/tool round trip.
const CLI_STARTUP_TIMEOUT_MS = 45_000;
const FIXTURE_EXECUTION_TIMEOUT_MS = 15_000;
const QUALIFICATION_TIMEOUT_MS = CLI_STARTUP_TIMEOUT_MS + FIXTURE_EXECUTION_TIMEOUT_MS + 5_000;

async function qualify(scenario: Scenario) {
  return withPolicyCliFixture(async (fixture) => {
    // sandbox-exec matches canonical paths; macOS /var is a symlink.
    const cwd = await realpath(fixture.cwd);
    const marker = join(cwd, "marker");
    const messages: SDKMessage[] = [];
    const startedAt = performance.now();
    let firstMessageMs: number | undefined;
    let firstModelMs: number | undefined;
    let expiredPhase: "startup" | "execution" | undefined;
    let executionTimeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const startupTimeout = setTimeout(() => {
      expiredPhase = "startup";
      controller.abort();
    }, CLI_STARTUP_TIMEOUT_MS);
    const endpoint = scriptedAnthropicEndpoint((origin) => {
      // This callback runs once, when the CLI first reaches the local model.
      // An unavailable Linux sandbox can fail before making any model request.
      firstModelMs = Math.round(performance.now() - startedAt);
      clearTimeout(startupTimeout);
      executionTimeout = setTimeout(() => {
        expiredPhase = "execution";
        controller.abort();
      }, FIXTURE_EXECUTION_TIMEOUT_MS);
      return [
        [
          {
            type: "tool_use",
            id: "policy_probe",
            name: "Bash",
            input: {
              command:
                scenario === "network" || scenario === "control"
                  ? `curl --silent --show-error --max-time 2 ${origin}/unlisted`
                  : `printf qualified > '${marker}'`,
              description: "Conformance fixture",
              dangerouslyDisableSandbox: scenario === "escape",
            },
          },
        ],
        [{ type: "text", text: "Done." }],
      ];
    });
    const sandbox = claudeExecutionSandbox(
      {
        id: "interactive-host",
        sandbox: "provider",
        approvals: "auto-approve",
        projectResources: false,
        networkAccess: "restricted",
      },
      false,
    )!;
    const options: Options = {
      cwd,
      model: "claude-sonnet-4-6",
      maxTurns: 2,
      persistSession: false,
      settingSources: [],
      tools: ["Bash"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      abortController: controller,
      ...(scenario !== "control"
        ? {
            sandbox: {
              ...sandbox,
              ...(scenario === "escape" ? { filesystem: { denyWrite: [marker] } } : {}),
            },
          }
        : {}),
      env: {
        ...scriptedClaudeEnv(fixture, endpoint, join(fixture.root, "claude")),
        ...(scenario === "unavailable" && process.platform === "linux"
          ? { PATH: fixture.root }
          : {}),
      },
      stderr: () => {},
      ...(scenario === "unavailable" && process.platform === "darwin"
        ? {
            // Forbid only the nested sandbox launch. The fixture command itself
            // remains writable: running it as an unsandboxed fallback would fail.
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
    };
    let failure: unknown;
    try {
      for await (const message of query({ prompt: "Run the conformance fixture", options })) {
        firstMessageMs ??= Math.round(performance.now() - startedAt);
        messages.push(message);
        if (messages.length > 64) {
          controller.abort();
          throw new Error("CLI fixture message bound exceeded");
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(startupTimeout);
      clearTimeout(executionTimeout);
      endpoint.stop();
    }
    expect(
      controller.signal.aborted,
      `CLI fixture deadline: ${expiredPhase ?? "none"}; elapsedMs=${Math.round(performance.now() - startedAt)}; firstMessageMs=${firstMessageMs ?? "none"}; firstModelMs=${firstModelMs ?? "none"}; messages=${messages.length}; modelCalls=${endpoint.modelCalls()}`,
    ).toBe(false);
    const toolResults = messages.flatMap((message) =>
      message.type === "user" && Array.isArray(message.message.content)
        ? message.message.content.filter((block) => block.type === "tool_result")
        : [],
    );
    if (scenario === "control") {
      expect(failure).toBeUndefined();
      expect(endpoint.networkHits()).toBe(1);
      expect(toolResults.some((block) => !block.is_error)).toBe(true);
    } else if (scenario === "unavailable" && process.platform === "linux") {
      expect(endpoint.modelCalls()).toBe(0);
      expect(messages.some((message) => message.type === "result" && message.is_error)).toBe(true);
    } else {
      expect(failure).toBeUndefined();
      expect(endpoint.modelCalls()).toBe(2);
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]!.is_error).toBe(true);
      if (scenario === "unavailable") expect(JSON.stringify(toolResults)).toContain("sandbox-exec");
    }
    expect(
      await stat(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    if (scenario !== "control") expect(endpoint.networkHits()).toBe(0);
  });
}

const supported = process.platform === "darwin" || process.platform === "linux";
describe("Claude CLI execution policy qualification", () => {
  for (const scenario of ["control", "escape", "network", "unavailable"] as const) {
    (supported ? test : test.skip)(scenario, () => qualify(scenario), QUALIFICATION_TIMEOUT_MS);
  }
});
