// Proves on the real pinned Claude CLI what `claude-mcp-tool-hints.ts` relies
// on: the names `canUseTool` and `mcpServerStatus()` use for one MCP tool, the
// annotations the status keeps, and that the status read answers while the
// CLI waits on `canUseTool`. Run by `claude-mcp-tool-hints.live.test.ts` in its
// own process, because the session-manager suites replace the SDK with a mock.
//
// Credential-free: the CLI runs in a temporary home and configuration
// directory with non-essential traffic off, against a deterministic loopback
// model that asks for the fixture's tools once. Every call is denied, so no
// tool runs. The server is `claude-mcp-tool-hints.live-fixture.ts`.
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeMcpToolHints } from "./claude-mcp-tool-hints.js";
import { claudeExecutableOptions } from "./session-manager-core.js";

export const HINTS_RESULT_SENTINEL = "__CLAUDE_MCP_TOOL_HINTS_RESULT__";
/** Configured with characters the CLI rewrites in a call name. */
export const HINTS_SERVER_NAME = "hint.srv x";
const CALLS = ["mcp__hint_srv_x__wipe_disk_tool", "mcp__hint_srv_x__read_thing"];

type Block = { type: "text" } | { type: "tool_use"; name: string };

/** Minimal Anthropic streaming response, consumed by the CLI's real agent loop. */
function modelResponse(blocks: Block[], model: string): Response {
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
  ];
  for (const [index, block] of blocks.entries()) {
    const tool = block.type === "tool_use";
    events.push(
      [
        "content_block_start",
        {
          type: "content_block_start",
          index,
          content_block: tool
            ? { type: "tool_use", id: `toolu_fixture_${index}`, name: block.name, input: {} }
            : { type: "text", text: "" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: tool
            ? { type: "input_json_delta", partial_json: "{}" }
            : { type: "text_delta", text: "done" },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index }],
    );
  }
  events.push(
    [
      "message_delta",
      {
        type: "message_delta",
        delta: {
          stop_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage,
      },
    ],
    ["message_stop", { type: "message_stop" }],
  );
  return new Response(
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "claude-mcp-tool-hints-"));
  const configDir = join(root, "config");
  const cwd = join(root, "project");
  await mkdir(configDir);
  await mkdir(cwd);
  await writeFile(
    join(configDir, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true }),
  );
  const offered: string[][] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/count_tokens"))
        return Response.json({ input_tokens: 1 });
      const body = (await request.json()) as {
        model: string;
        messages: Array<{ role: string; content: unknown }>;
        tools?: Array<{ name: string }>;
      };
      const asked = body.messages.some(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.content) &&
          message.content.some((block: { type?: string }) => block.type === "tool_use"),
      );
      if (asked) return modelResponse([{ type: "text" }], body.model);
      offered.push(
        (body.tools ?? []).map((tool) => tool.name).filter((name) => name.startsWith("mcp__")),
      );
      return modelResponse(
        CALLS.map((name) => ({ type: "tool_use", name })),
        body.model,
      );
    },
  });
  const decisions: Array<{
    toolName: string;
    serverName?: string;
    hints?: unknown;
    readMs: number;
  }> = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompt: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "user",
        message: { role: "user", content: "Use the fixture tools." },
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
      maxTurns: 4,
      permissionMode: "default",
      mcpServers: {
        [HINTS_SERVER_NAME]: {
          type: "stdio",
          command: process.execPath,
          args: [join(import.meta.dir, "claude-mcp-tool-hints.live-fixture.ts")],
        },
      },
      // What the bridge does when it parks the call, against this live CLI.
      canUseTool: async (toolName, _input, options) => {
        const started = Date.now();
        const hints = await readClaudeMcpToolHints(control, options.mcpServer?.name, toolName);
        decisions.push({
          toolName,
          ...(options.mcpServer ? { serverName: options.mcpServer.name } : {}),
          ...(hints ? { hints } : {}),
          readMs: Date.now() - started,
        });
        return { behavior: "deny", message: "Fixture: denied." };
      },
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
        ENABLE_TOOL_SEARCH: "false",
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
    const status = statuses.find((candidate) => candidate.name === HINTS_SERVER_NAME);
    const result = {
      status: {
        name: status?.name,
        status: status?.status,
        tools: (status?.tools ?? []).map((tool) => ({
          name: tool.name,
          annotations: tool.annotations,
        })),
      },
      offered: offered[0] ?? [],
      decisions: decisions.map(({ readMs, ...decision }) => ({
        ...decision,
        readWithinTimeout: readMs < 2_000,
      })),
    };
    process.stdout.write(`${HINTS_RESULT_SENTINEL}${JSON.stringify(result)}\n`);
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
