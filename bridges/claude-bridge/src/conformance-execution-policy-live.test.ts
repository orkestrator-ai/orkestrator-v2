/** Offline qualification of the pinned CLI, with a scripted local model endpoint. */
import { describe, expect, test } from "bun:test";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { withPolicyCliFixture } from "../../../tests/conformance/execution-policy/vendor-cli.js";
import { claudeExecutionSandbox } from "./services/claude-execution-sandbox.js";

type Scenario = "control" | "escape" | "network" | "unavailable";

async function qualify(scenario: Scenario) {
  return withPolicyCliFixture(async (fixture) => {
    // sandbox-exec matches canonical paths; macOS /var is a symlink.
    const cwd = await realpath(fixture.cwd);
    const marker = join(cwd, "marker");
    let modelCalls = 0;
    let networkHits = 0;
    const messages: SDKMessage[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/unlisted") {
          networkHits += 1;
          return new Response("fixture");
        }
        const body = (await request.json()) as { stream?: boolean };
        if (!new URL(request.url).pathname.endsWith("/messages"))
          return Response.json({ input_tokens: 1 });
        modelCalls += 1;
        if (modelCalls > 3) return new Response("Unexpected model retry", { status: 400 });
        const command =
          scenario === "network" || scenario === "control"
            ? `curl --silent --show-error --max-time 2 ${server.url.origin}/unlisted`
            : `printf qualified > '${marker}'`;
        const content =
          modelCalls === 1
            ? [
                {
                  type: "tool_use",
                  id: "policy_probe",
                  name: "Bash",
                  input: {
                    command,
                    description: "Conformance fixture",
                    dangerouslyDisableSandbox: scenario === "escape",
                  },
                },
              ]
            : [{ type: "text", text: "Done." }];
        const message = {
          id: `msg_${modelCalls}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content,
          stop_reason: modelCalls === 1 ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        if (!body.stream) return Response.json(message);
        const events: unknown[] = [
          { type: "message_start", message: { ...message, content: [], stop_reason: null } },
        ];
        for (const [index, block] of content.entries()) {
          events.push({
            type: "content_block_start",
            index,
            content_block:
              block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" },
          });
          events.push({
            type: "content_block_delta",
            index,
            delta:
              "input" in block
                ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
                : { type: "text_delta", text: block.text },
          });
          events.push({ type: "content_block_stop", index });
        }
        events.push(
          {
            type: "message_delta",
            delta: { stop_reason: message.stop_reason, stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        );
        return new Response(
          events
            .map((event) => {
              const frame = event as { type: string };
              return `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
            })
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
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
        // The SDK merges env with its parent; explicitly remove ambient credentials.
        ...Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined])),
        ...fixture.env,
        CLAUDE_CONFIG_DIR: join(fixture.root, "claude"),
        ANTHROPIC_API_KEY: "fixture-key",
        ANTHROPIC_BASE_URL: server.url.origin,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
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
      server.stop(true);
    }
    expect(controller.signal.aborted).toBe(false);
    const toolResults = messages.flatMap((message) =>
      message.type === "user" && Array.isArray(message.message.content)
        ? message.message.content.filter((block) => block.type === "tool_result")
        : [],
    );
    if (scenario === "control") {
      expect(failure).toBeUndefined();
      expect(networkHits).toBe(1);
      expect(toolResults.some((block) => !block.is_error)).toBe(true);
    } else if (scenario === "unavailable" && process.platform === "linux") {
      expect(modelCalls).toBe(0);
      expect(messages.some((message) => message.type === "result" && message.is_error)).toBe(true);
    } else {
      expect(failure).toBeUndefined();
      expect(modelCalls).toBe(2);
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
    if (scenario !== "control") expect(networkHits).toBe(0);
  });
}

const supported = process.platform === "darwin" || process.platform === "linux";
describe("Claude CLI execution policy qualification", () => {
  for (const scenario of ["control", "escape", "network", "unavailable"] as const) {
    (supported ? test : test.skip)(scenario, () => qualify(scenario), 20_000);
  }
});
