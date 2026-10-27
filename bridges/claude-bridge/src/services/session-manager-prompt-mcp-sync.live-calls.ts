// A real CLI and real MCP processes, with a deterministic loopback model.
// No external requests or credentials: the model only asks for fixture tools.
import {
  query,
  type HookCallback,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeExecutableOptions } from "./session-manager-core.js";
import type { ClaudeQueryControl } from "../types/index.js";
import {
  createClaudeRuntimeMcp,
  createStaleMcpServerHook,
  reportedStaleServers,
  syncClaudeRuntimeMcp,
} from "./session-manager-prompt-mcp-sync.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

type Block = { type: string; name?: string; text?: string; input?: unknown };

/** Minimal Anthropic streaming response, consumed by the pinned CLI's real agent loop. */
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
    events.push([
      "content_block_start",
      {
        type: "content_block_start",
        index,
        content_block: tool
          ? { type: "tool_use", id: `tool_${index}_${block.name}`, name: block.name, input: {} }
          : { type: "text", text: "" },
      },
    ]);
    events.push([
      "content_block_delta",
      {
        type: "content_block_delta",
        index,
        delta: tool
          ? { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) }
          : { type: "text_delta", text: block.text ?? "done" },
      },
    ]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
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

export async function runMcpCallProbe(open: Set<Query>) {
  const root = await mkdtemp(join(tmpdir(), "claude-mcp-calls-"));
  const configDir = join(root, "config");
  const cwd = join(root, "project");
  const markers = join(root, "markers.log");
  await mkdir(configDir);
  await mkdir(cwd);
  await writeFile(markers, "");
  const fixture = (name: string) => ({
    type: "stdio" as const,
    command: process.execPath,
    args: [
      join(import.meta.dir, "session-manager-prompt-mcp-sync.live-fixture.ts"),
      name,
      "1",
      markers,
    ],
  });
  const keep = { keep: fixture("keep") };
  const writeConfig = (servers: unknown) =>
    writeFile(
      join(configDir, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, mcpServers: servers }),
    );
  // remote is intentionally file-only: setMcpServers never owns it.
  await writeConfig({ ...keep, remote: fixture("remote") });
  const mcp = createClaudeRuntimeMcp(keep, ["keep", "remote"]);
  const staleHook = createStaleMcpServerHook(mcp);
  let backgroundStarted = false;
  const backgroundMayRun = deferred();
  let rootDenied = 0;
  let backgroundDenied = 0;
  let liveAllowed = 0;
  let results = 0;
  let streamError: unknown;
  const hook: HookCallback = async (input, id, options) => {
    const answer = await staleHook(input, id, options);
    if (input.hook_event_name === "PreToolUse" && "hookSpecificOutput" in answer) {
      if (input.agent_id) backgroundDenied += 1;
      else rootDenied += 1;
    }
    if (input.hook_event_name === "PreToolUse" && input.tool_name === "mcp__keep__probe_keep")
      liveAllowed += 1;
    return answer;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/count_tokens"))
        return Response.json({ input_tokens: 1 });
      const body = (await request.json()) as {
        model: string;
        system?: unknown;
        messages: Array<{ role: string; content: string | Block[] }>;
        tools?: Array<{ name: string }>;
      };
      const background = JSON.stringify(body.system).includes("MCP_SUBAGENT_SYSTEM");
      const toolUses = body.messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((block) => block.type === "tool_use");
      if (background) {
        backgroundStarted = true;
        await backgroundMayRun.promise;
        return modelResponse(
          toolUses.some((block) => block.name === "mcp__remote__probe_remote")
            ? [{ type: "text", text: "background finished" }]
            : [{ type: "tool_use", name: "mcp__remote__probe_remote", input: {} }],
          body.model,
        );
      }
      const after = body.messages.some(
        (message) =>
          message.role === "user" &&
          (typeof message.content === "string"
            ? message.content
            : message.content.map((block) => block.text ?? "").join(" ")
          ).includes("MCP_ROOT_AFTER"),
      );
      if (after && !toolUses.some((block) => block.name === "mcp__remote__probe_remote")) {
        return modelResponse(
          [
            { type: "tool_use", name: "mcp__remote__probe_remote", input: {} },
            { type: "tool_use", name: "mcp__keep__probe_keep", input: {} },
          ],
          body.model,
        );
      }
      if (!toolUses.length) {
        const agent = body.tools?.find(
          (tool) => tool.name === "Agent" || tool.name === "Task",
        )?.name;
        if (!agent) throw new Error("CLI did not offer a subagent tool");
        return modelResponse(
          [
            {
              type: "tool_use",
              name: agent,
              input: {
                description: "MCP background fixture",
                prompt: "Run the fixture probe.",
                subagent_type: "mcp-probe",
                run_in_background: true,
              },
            },
          ],
          body.model,
        );
      }
      return modelResponse([{ type: "text", text: "root finished" }], body.model);
    },
  });
  const input: SDKUserMessage[] = [];
  let wake = deferred();
  let closed = false;
  const submit = (text: string) => {
    input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    });
    wake.resolve();
  };
  const prompt: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (!input.length) {
          await wake.promise;
          wake = deferred();
        }
        const message = input.shift();
        if (message) yield message;
      }
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
      settingSources: ["user"],
      mcpServers: keep,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      model: "claude-sonnet-4-6",
      maxTurns: 8,
      agents: {
        "mcp-probe": {
          description: "MCP fixture",
          prompt: "MCP_SUBAGENT_SYSTEM",
          tools: ["mcp__remote__probe_remote"],
        },
      },
      hooks: { PreToolUse: [{ hooks: [hook] }] },
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
  open.add(control);
  // This is the backend consumer. It stays alive while no view is subscribed.
  const consuming = (async () => {
    try {
      for await (const message of control) if (message.type === "result") results += 1;
    } catch (error) {
      streamError = error;
    }
  })();
  try {
    const deadline = Date.now() + 20_000;
    let statuses = await control.mcpServerStatus();
    while (statuses.some((status) => status.status === "pending") && Date.now() < deadline) {
      await Bun.sleep(50);
      statuses = await control.mcpServerStatus();
    }
    if (!statuses.some((status) => status.name === "remote" && status.status === "connected")) {
      throw new Error("File-only fixture was not connected");
    }
    submit("MCP_ROOT_START");
    await until(() => backgroundStarted || !!streamError, "background startup");
    if (streamError) throw streamError;
    await until(() => results >= 1 || !!streamError, "root result with background retained");
    if (streamError) throw streamError;
    await writeConfig(keep);
    await syncClaudeRuntimeMcp(
      { control: control as unknown as ClaudeQueryControl, mcpServers: "launch", mcp },
      { servers: keep, key: "launch", names: new Set(["keep"]), required: [] },
    );
    const connected = (await control.mcpServerStatus()).some(
      (status) => status.name === "remote" && status.status === "connected",
    );
    // No foreground observer during the background call. Rehydrate from the
    // same authoritative state a remounted session uses, then send another turn.
    backgroundMayRun.resolve();
    await until(() => backgroundDenied > 0 || !!streamError, "background denial while inactive");
    if (streamError) throw streamError;
    const rehydratedStale = reportedStaleServers(mcp);
    submit("MCP_ROOT_AFTER");
    await until(
      () => (rootDenied > 0 && liveAllowed > 0 && results >= 2) || !!streamError,
      "root denial after rehydration",
    );
    if (streamError) throw streamError;
    await until(
      async () => (await readFile(markers, "utf8")).includes("call keep\n"),
      "live fixture execution",
    );
    const calls = (await readFile(markers, "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("call "));
    return {
      connected,
      rehydratedStale,
      rootDenied,
      backgroundDenied,
      liveAllowed,
      remoteCalls: calls.filter((line) => line === "call remote").length,
      keepCalls: calls.filter((line) => line === "call keep").length,
    };
  } finally {
    closed = true;
    wake.resolve();
    backgroundMayRun.resolve();
    control.close();
    open.delete(control);
    await consuming;
    await exited;
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
