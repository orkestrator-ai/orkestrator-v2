// Proves on the real pinned Claude CLI what the backend's workflow-result
// tools rely on: with tool search on, an MCP tool that lists
// `_meta["anthropic/alwaysLoad"]: true` is offered to the model on the first
// request, while an ordinary MCP tool from the same server stays deferred
// behind ToolSearch. Run by `claude-mcp-always-load.live.test.ts` in its own
// process, because the session-manager suites replace the SDK with a mock.
//
// Credential-free: the CLI runs in a temporary home and configuration
// directory with non-essential traffic off, against a deterministic loopback
// model that answers with text only, so no tool runs. The server is
// `claude-mcp-always-load.live-fixture.ts`.
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeExecutableOptions } from "./session-manager-core.js";

export const ALWAYS_LOAD_RESULT_SENTINEL = "__CLAUDE_MCP_ALWAYS_LOAD_RESULT__";
export const ALWAYS_LOAD_SERVER_NAME = "fixture";

/** Minimal Anthropic streaming response holding one text block. */
function textResponse(model: string): Response {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage,
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return new Response(
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

type OfferedTool = { name: string; deferred: boolean };

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "claude-mcp-always-load-"));
  const configDir = join(root, "config");
  const cwd = join(root, "project");
  await mkdir(configDir);
  await mkdir(cwd);
  await writeFile(
    join(configDir, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true }),
  );
  const offered: OfferedTool[][] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 4 * 1024 * 1024,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/count_tokens"))
        return Response.json({ input_tokens: 1 });
      const body = (await request.json()) as {
        model: string;
        tools?: Array<{ name?: string; type?: string; defer_loading?: boolean }>;
      };
      offered.push(
        (body.tools ?? [])
          .filter((tool) => typeof tool.name === "string")
          .filter((tool) => tool.name!.startsWith("mcp__") || tool.name === "ToolSearch")
          .map((tool) => ({ name: tool.name!, deferred: tool.defer_loading === true })),
      );
      return textResponse(body.model);
    },
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompt: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "user",
        message: { role: "user", content: "Say done." },
        parent_tool_use_id: null,
        session_id: "",
      };
      await held;
    },
  };
  // The CLI writes its MCP logs under `HOME` while it shuts down, so the root
  // is removed only once the process has exited (0247).
  let exited: Promise<void> = Promise.resolve();
  const control = query({
    prompt,
    options: {
      cwd,
      ...claudeExecutableOptions(),
      spawnClaudeCodeProcess: (options) => {
        const child = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ["pipe", "pipe", "ignore"],
        });
        exited = new Promise((resolve) => {
          child.once("exit", () => resolve());
          child.once("error", () => resolve());
        });
        return child;
      },
      settingSources: [],
      model: "claude-sonnet-4-6",
      maxTurns: 2,
      permissionMode: "default",
      mcpServers: {
        [ALWAYS_LOAD_SERVER_NAME]: {
          type: "stdio",
          command: process.execPath,
          args: [join(import.meta.dir, "claude-mcp-always-load.live-fixture.ts")],
        },
      },
      canUseTool: async () => ({ behavior: "deny", message: "Fixture: denied." }),
      env: {
        PATH: process.env.PATH,
        HOME: root,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: server.url.origin,
        ANTHROPIC_API_KEY: "fixture-only",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_AUTOUPDATER: "1",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        ENABLE_TOOL_SEARCH: "true",
      },
    },
  });
  const stop = () => {
    release();
    control.close();
  };
  process.once("SIGTERM", () => {
    stop();
    process.exit(143);
  });
  try {
    const deadline = Date.now() + 30_000;
    let statuses = await control.mcpServerStatus();
    while (statuses.some((status) => status.status === "pending")) {
      if (Date.now() > deadline) throw new Error("MCP server did not finish connecting");
      await Bun.sleep(50);
      statuses = await control.mcpServerStatus();
    }
    for await (const message of control) if (message.type === "result") break;
    const result = {
      status: statuses.find((candidate) => candidate.name === ALWAYS_LOAD_SERVER_NAME)?.status,
      offered: offered[0] ?? [],
    };
    process.stdout.write(`${ALWAYS_LOAD_RESULT_SENTINEL}${JSON.stringify(result)}\n`);
  } finally {
    stop();
    await exited;
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

// Only as a script: the test imports the sentinel from this module.
if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
