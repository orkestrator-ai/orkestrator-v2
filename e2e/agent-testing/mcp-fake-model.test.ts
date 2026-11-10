import { describe, expect, test } from "bun:test";
import { nativeWebPlatform } from "../../tests/register-dom";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FAKE_OPENCODE_MODEL_REF,
  FAKE_PI_MODEL_REF,
  fakePiModels,
  insideProfile,
  startMcpFakeModel,
} from "./mcp-fake-model-wiring";
import { observeCodexReloads } from "./mcp-codex-reload-observer";
import { PROBE_UNAVAILABLE, probePrompt, probeResult } from "./mcp-apply-live-support";
import {
  anthropicContent,
  anthropicRequest,
  bashTakesDescription,
  chatMessage,
  chatRequest,
  PLAN_MODE_REMINDER,
  responsesOutputItem,
  responsesRequest,
  serveMcpFakeModel,
} from "./mcp-fake-model";
import {
  BUSY_TEXT_DELAY_MS,
  CODE_NO_TOOL,
  codeCell,
  offeredToolName,
  scriptedStep,
} from "./mcp-fake-model-script";

// Keep loopback fetch and server responses on Bun's native Web APIs under the DOM preload.
const { fetch, Response } = nativeWebPlatform;

const LIVE_PROMPT = probePrompt("mqu0_alpha", "MQ1234");
const INACTIVE_PROMPT =
  "Call the MCP tool probe_mcpqa from the mcpqa server exactly once, then reply with exactly the text it returned and nothing else.";
const ABSENT_PROMPT =
  "If a tool named probe_mcpqa is available to you, call it once and reply with exactly " +
  "its result. If it is not available, reply with exactly MCPQNOTOOL-ab12 and nothing else.";

describe("offeredToolName", () => {
  test("finds each provider's spelling and nothing else", () => {
    expect(offeredToolName(["Bash", "mcp__mqu0_alpha__probe"], "mqu0_alpha", "probe")).toBe(
      "mcp__mqu0_alpha__probe",
    );
    expect(offeredToolName(["bash", "mcp_mqu0_alpha_probe"], "mqu0_alpha", "probe")).toBe(
      "mcp_mqu0_alpha_probe",
    );
    // OpenCode 1.19.5: `<server>_<tool>`, both sanitized.
    expect(offeredToolName(["bash", "mqu0_alpha_probe"], "mqu0_alpha", "probe")).toBe(
      "mqu0_alpha_probe",
    );
    // A renamed server's tool does not stand in for the old name.
    expect(offeredToolName(["mcp__mqu0_beta__probe"], "mqu0_alpha", "probe")).toBeUndefined();
    expect(offeredToolName(["mcp__mqu0_alpha2__probe"], "mqu0_alpha", "probe")).toBeUndefined();
    expect(offeredToolName(["mqu0_beta_probe"], "mqu0_alpha", "probe")).toBeUndefined();
    expect(offeredToolName(["mqu0_alpha2_probe"], "mqu0_alpha", "probe")).toBeUndefined();
  });
});

describe("scriptedStep", () => {
  test("a live probe calls an offered tool, then replies with its result line", () => {
    const tools = ["Bash", "mcp__mqu0_alpha__probe"];
    expect(scriptedStep({ prompt: LIVE_PROMPT, tools, results: [] })).toEqual({
      kind: "tool",
      name: "mcp__mqu0_alpha__probe",
      input: { nonce: "MQ1234" },
    });
    const line = probeResult("mqu0_alpha", "v2", "MQ1234");
    expect(
      scriptedStep({
        prompt: LIVE_PROMPT,
        tools,
        results: [{ name: "mcp__mqu0_alpha__probe", text: `{"content":"${line}"}` }],
      }),
    ).toEqual({ kind: "text", text: line });
  });

  test("an absent, failed or refused tool is unavailable, never a guess", () => {
    expect(scriptedStep({ prompt: LIVE_PROMPT, tools: ["Bash"], results: [] })).toEqual({
      kind: "text",
      text: PROBE_UNAVAILABLE,
    });
    const refused = { name: "mcp__mqu0_alpha__probe", text: "refused by hook", isError: true };
    expect(
      scriptedStep({ prompt: LIVE_PROMPT, tools: ["mcp__mqu0_alpha__probe"], results: [refused] }),
    ).toEqual({ kind: "text", text: PROBE_UNAVAILABLE });
    // An error result carrying the line still does not count.
    const line = probeResult("mqu0_alpha", "v1", "MQ1234");
    expect(
      scriptedStep({
        prompt: LIVE_PROMPT,
        tools: [],
        results: [{ text: line, isError: true }],
      }),
    ).toEqual({ kind: "text", text: PROBE_UNAVAILABLE });
  });

  test("Claude's tool search is tried once before answering unavailable", () => {
    const tools = ["Bash", "ToolSearch"];
    expect(scriptedStep({ prompt: LIVE_PROMPT, tools, results: [] })).toEqual({
      kind: "tool",
      name: "ToolSearch",
      input: { query: "select:mcp__mqu0_alpha__probe", max_results: 5 },
    });
    const searched = [{ name: "ToolSearch", text: "No matching deferred tools" }];
    expect(scriptedStep({ prompt: LIVE_PROMPT, tools, results: searched })).toEqual({
      kind: "text",
      text: PROBE_UNAVAILABLE,
    });
    expect(
      scriptedStep({
        prompt: LIVE_PROMPT,
        tools: [...tools, "mcp__mqu0_alpha__probe"],
        results: searched,
      }),
    ).toMatchObject({ kind: "tool", name: "mcp__mqu0_alpha__probe" });
  });

  test("Codex code mode looks the tool up in ALL_TOOLS from a code cell", () => {
    const step = scriptedStep({
      prompt: LIVE_PROMPT,
      tools: ["exec"],
      results: [],
      codeMode: true,
    });
    expect(step).toEqual({
      kind: "code",
      source: codeCell("mqu0_alpha", "probe", { nonce: "MQ1234" }),
    });
    expect((step as { source: string }).source).toContain('"mcp__mqu0_alpha__probe"');
    expect(
      scriptedStep({
        prompt: LIVE_PROMPT,
        tools: ["exec"],
        results: [{ name: "exec", text: CODE_NO_TOOL }],
        codeMode: true,
      }),
    ).toEqual({ kind: "text", text: PROBE_UNAVAILABLE });
  });

  test("the inactive spec's prompts: a pong reply, and the absent token", () => {
    const tools = ["mcp__mcpqa__probe_mcpqa"];
    expect(scriptedStep({ prompt: INACTIVE_PROMPT, tools, results: [] })).toEqual({
      kind: "tool",
      name: "mcp__mcpqa__probe_mcpqa",
      input: {},
    });
    expect(
      scriptedStep({
        prompt: INACTIVE_PROMPT,
        tools,
        results: [{ text: "pong mcpqa v1 MCPQV1-abc" }],
      }),
    ).toEqual({ kind: "text", text: "pong mcpqa v1 MCPQV1-abc" });
    expect(scriptedStep({ prompt: ABSENT_PROMPT, tools: ["Bash"], results: [] })).toEqual({
      kind: "text",
      text: "MCPQNOTOOL-ab12",
    });
  });

  test("busy turns: a held long reply, and one foreground command", () => {
    expect(
      scriptedStep({
        prompt:
          "Write every whole number from 1 to 250 in words, separated by commas. Then on a final " +
          "line write exactly the text MCPQBUSY-1 and nothing else. Do not use any tools.",
        tools: [],
        results: [],
      }),
    ).toEqual({ kind: "text", text: "MCPQBUSY-1", delayMs: BUSY_TEXT_DELAY_MS });
    const prompt =
      "Use your shell tool to run the command `printf started > '/tmp/m'; sleep 45` once, in the foreground (not as a background task), and wait for it to finish. Then reply with exactly BUSY-DONE.";
    expect(scriptedStep({ prompt, tools: ["Bash"], results: [] })).toEqual({
      kind: "shell",
      command: "printf started > '/tmp/m'; sleep 45",
    });
    expect(scriptedStep({ prompt, tools: ["Bash"], results: [{ text: "" }] })).toEqual({
      kind: "text",
      text: "BUSY-DONE",
    });
  });

  test("warm-runtime prompts: the plan-mode marker and one file write", () => {
    const marker = "Report the plan mode marker WRM-ab12 and nothing else.";
    expect(scriptedStep({ prompt: marker, tools: [], results: [], planMode: true })).toEqual({
      kind: "text",
      text: "WRM-ab12 plan-mode=on",
    });
    expect(scriptedStep({ prompt: marker, tools: [], results: [] })).toEqual({
      kind: "text",
      text: "WRM-ab12 plan-mode=off",
    });
    const write =
      "Use your file write tool to create the file `/w/out.txt` containing exactly `WRM-1`, then reply with exactly WRITE-DONE.";
    expect(scriptedStep({ prompt: write, tools: ["Write"], results: [] })).toEqual({
      kind: "write",
      filePath: "/w/out.txt",
      content: "WRM-1",
    });
    expect(scriptedStep({ prompt: write, tools: ["Write"], results: [{ text: "ok" }] })).toEqual({
      kind: "text",
      text: "WRITE-DONE",
    });
    expect(
      scriptedStep({ prompt: write, tools: ["Write"], results: [{ text: "no", isError: true }] }),
    ).toEqual({ kind: "text", text: "WRITE-FAILED" });
  });

  test("plain prompts", () => {
    expect(
      scriptedStep({
        prompt: "Reply with exactly READY. Do not use any tools.",
        tools: [],
        results: [],
      }),
    ).toEqual({ kind: "text", text: "READY" });
    expect(scriptedStep({ prompt: "Write a title", tools: [], results: [] })).toEqual({
      kind: "text",
      text: "Done.",
    });
  });
});

describe("Anthropic Messages adapter", () => {
  test("reads the prompt past reminders, and results by tool-use id", () => {
    const request = anthropicRequest({
      tools: [{ name: "Bash" }, { name: "mcp__mqu0_alpha__probe" }],
      messages: [
        { role: "user", content: "Reply with exactly READY." },
        { role: "assistant", content: [{ type: "text", text: "READY" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>ignore</system-reminder>" },
            { type: "text", text: LIVE_PROMPT },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "mcp__mqu0_alpha__probe" }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "MCPQ-RESULT a v1 MQ1234" }],
            },
          ],
        },
      ],
    });
    expect(request.prompt).toBe(LIVE_PROMPT);
    expect(request.results).toEqual([
      { name: "mcp__mqu0_alpha__probe", text: "MCPQ-RESULT a v1 MQ1234" },
    ]);
    expect(request.tools).toEqual(["Bash", "mcp__mqu0_alpha__probe"]);
  });

  test("sees the CLI's plan-mode notice after the prompt, never in history", () => {
    // The layout CLI 2.1.319 sends after `setPermissionMode("plan")`.
    const notice = `${PLAN_MODE_REMINDER}. The user indicated that they do not want you to execute yet.`;
    const current = anthropicRequest({
      messages: [
        { role: "user", content: "Reply with exactly A." },
        { role: "assistant", content: [{ type: "text", text: "A" }] },
        { role: "user", content: [{ type: "text", text: "Reply with exactly B." }] },
        { role: "system", content: [{ type: "text", text: notice }] },
      ],
    });
    expect(current).toMatchObject({ prompt: "Reply with exactly B.", planMode: true });
    const earlier = anthropicRequest({
      messages: [
        { role: "user", content: "Reply with exactly A." },
        { role: "system", content: [{ type: "text", text: notice }] },
        { role: "assistant", content: [{ type: "text", text: "A" }] },
        { role: "user", content: "Reply with exactly B." },
        { role: "system", content: "## Exited Plan Mode" },
      ],
    });
    expect(earlier.planMode).toBeUndefined();
  });

  test("a write step is one Write call", () => {
    expect(anthropicContent({ kind: "write", filePath: "/w/a", content: "x" }, 4)).toEqual([
      {
        type: "tool_use",
        id: "toolu_mcpq_4",
        name: "Write",
        input: { file_path: "/w/a", content: "x" },
      },
    ]);
  });

  test("a shell step is a Bash call", () => {
    expect(anthropicContent({ kind: "shell", command: "sleep 1" }, 3)).toEqual([
      {
        type: "tool_use",
        id: "toolu_mcpq_3",
        name: "Bash",
        input: { command: "sleep 1", description: "Run the command" },
      },
    ]);
  });
});

describe("chat-completions adapter", () => {
  test("reads tool messages after the last user message", () => {
    const request = chatRequest({
      tools: [{ function: { name: "bash" } }, { function: { name: "mcp_mqu0_alpha_probe" } }],
      messages: [
        { role: "system", content: "You are Pi." },
        { role: "user", content: [{ type: "text", text: LIVE_PROMPT }] },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", function: { name: "mcp_mqu0_alpha_probe" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "MCPQ-RESULT a v1 MQ1234" },
      ],
    });
    expect(request).toEqual({
      prompt: LIVE_PROMPT,
      tools: ["bash", "mcp_mqu0_alpha_probe"],
      results: [{ name: "mcp_mqu0_alpha_probe", text: "MCPQ-RESULT a v1 MQ1234" }],
    });
  });

  test("a tool step is one function call", () => {
    expect(
      chatMessage({ kind: "tool", name: "mcp_mqu0_alpha_probe", input: { nonce: "N" } }, 1),
    ).toEqual({
      content: undefined,
      toolCall: {
        id: "call_mcpq_1",
        type: "function",
        function: { name: "mcp_mqu0_alpha_probe", arguments: '{"nonce":"N"}' },
      },
    });
  });
});

describe("chat-completions shell calls", () => {
  const openCodeBash = {
    function: {
      name: "bash",
      parameters: { properties: { command: {}, description: {}, timeout: {} } },
    },
  };
  const piBash = { function: { name: "bash", parameters: { properties: { command: {} } } } };

  test("OpenCode's bash gets the description its schema requires; Pi's does not", () => {
    expect(bashTakesDescription({ tools: [openCodeBash] })).toBe(true);
    expect(bashTakesDescription({ tools: [piBash] })).toBe(false);
    expect(bashTakesDescription({})).toBe(false);
    const shell = { kind: "shell", command: "sleep 45" } as const;
    expect(
      JSON.parse(chatMessage(shell, 2, { describeShell: true }).toolCall!.function.arguments),
    ).toEqual({ command: "sleep 45", description: "Run the requested command" });
    expect(JSON.parse(chatMessage(shell, 2).toolCall!.function.arguments)).toEqual({
      command: "sleep 45",
    });
  });

  test("the served stream carries the description when OpenCode offers bash", async () => {
    const server = serveMcpFakeModel(Response);
    try {
      const reply = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          stream: true,
          tools: [openCodeBash],
          messages: [
            { role: "user", content: "Please run the command `sleep 1` once, in the foreground." },
          ],
        }),
      });
      const call = sse(await reply.text())[0].choices[0].delta.tool_calls[0];
      expect(call.function.name).toBe("bash");
      expect(JSON.parse(call.function.arguments)).toEqual({
        command: "sleep 1",
        description: "Run the requested command",
      });
    } finally {
      await server.stop(true);
    }
  });
});

describe("Responses adapter", () => {
  const offer = {
    input: [
      {
        type: "additional_tools",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [{ type: "custom", name: "exec" }],
          },
        ],
      },
    ],
  };

  test("remembers the prompt and tools across a continuation, and names results", () => {
    const remembered = { prompt: "", tools: [] as string[], names: new Map<string, string>() };
    const first = responsesRequest(
      { input: [{ role: "user", content: [{ type: "input_text", text: LIVE_PROMPT }] }] },
      remembered,
      offer,
    );
    expect(first).toMatchObject({ prompt: LIVE_PROMPT, results: [], codeMode: true });
    remembered.names.set("call_1", "exec");
    const next = responsesRequest(
      { input: [{ type: "custom_tool_call_output", call_id: "call_1", output: "MCPQ-NO-TOOL" }] },
      remembered,
      offer,
    );
    expect(next).toMatchObject({
      prompt: LIVE_PROMPT,
      results: [{ name: "exec", text: "MCPQ-NO-TOOL" }],
    });
  });

  test("a code step goes out as an exec custom tool call", () => {
    expect(responsesOutputItem({ kind: "code", source: "exit();" }, offer, 2)).toEqual({
      type: "custom_tool_call",
      id: "ctc_mcpq_2",
      call_id: "call_mcpq_2",
      name: "exec",
      input: "exit();",
      status: "completed",
    });
  });
});

// Exercise wire framing over a real loopback socket, not just adapter objects.
describe("streaming wire protocols", () => {
  test("Messages SSE carries tool input, tool-use stop and the final text", async () => {
    const server = serveMcpFakeModel(Response);
    try {
      const post = async (messages: unknown[]) => {
        const response = await fetch(`${server.url}v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stream: true,
            model: "fixture",
            tools: [{ name: "mcp__mqu0_alpha__probe" }],
            messages,
          }),
        });
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        return sse(await response.text());
      };
      const messages = [{ role: "user", content: LIVE_PROMPT }];
      const events = await post(messages);
      const start = events.find((e) => e.type === "content_block_start")!;
      expect(start.content_block).toMatchObject({
        type: "tool_use",
        name: "mcp__mqu0_alpha__probe",
      });
      const input = events
        .filter((e) => e.type === "content_block_delta")
        .map((e) => e.delta.partial_json ?? "")
        .join("");
      expect(JSON.parse(input)).toEqual({ nonce: "MQ1234" });
      expect(events.find((e) => e.type === "message_delta")?.delta.stop_reason).toBe("tool_use");
      expect(events.at(-1)?.type).toBe("message_stop");
      const line = probeResult("mqu0_alpha", "v1", "MQ1234");
      const final = await post([
        ...messages,
        { role: "assistant", content: [{ ...start.content_block, input: JSON.parse(input) }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: start.content_block.id, content: line }],
        },
      ]);
      expect(
        final
          .filter((e) => e.type === "content_block_delta")
          .map((e) => e.delta.text ?? "")
          .join(""),
      ).toBe(line);
      expect(final.find((e) => e.type === "message_delta")?.delta.stop_reason).toBe("end_turn");
    } finally {
      await server.stop(true);
    }
  }, 30_000);

  test("chat SSE carries function arguments, finish reasons, usage and DONE", async () => {
    const server = serveMcpFakeModel(Response);
    try {
      const post = async (messages: unknown[]) => {
        const response = await fetch(`${server.url}v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stream: true,
            model: "fixture",
            tools: [{ function: { name: "mcp_mqu0_alpha_probe" } }],
            messages,
          }),
        });
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        const text = await response.text();
        expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
        return sse(text);
      };
      const messages = [{ role: "user", content: LIVE_PROMPT }];
      const chunks = await post(messages);
      const call = chunks[0]!.choices[0].delta.tool_calls[0];
      expect(call).toMatchObject({
        index: 0,
        type: "function",
        function: { name: "mcp_mqu0_alpha_probe" },
      });
      expect(JSON.parse(call.function.arguments)).toEqual({ nonce: "MQ1234" });
      expect(chunks.at(-1)?.choices[0].finish_reason).toBe("tool_calls");
      expect(chunks.at(-1)?.usage.total_tokens).toBe(2);
      const line = probeResult("mqu0_alpha", "v1", "MQ1234");
      const final = await post([
        ...messages,
        { role: "assistant", tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: line },
      ]);
      expect(final[0]!.choices[0].delta.content).toBe(line);
      expect(final.at(-1)?.choices[0].finish_reason).toBe("stop");
    } finally {
      await server.stop(true);
    }
  }, 30_000);

  test("Responses prewarm remembers namespaced tools across frames and replaces offers", async () => {
    const server = serveMcpFakeModel(Response);
    const socket = new WebSocket(`${server.url.toString().replace("http:", "ws:")}v1/responses`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
      });
      const exchange = (frame: unknown) =>
        new Promise<any[]>((resolve, reject) => {
          const events: any[] = [];
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("no response.completed"));
          }, 5_000);
          const cleanup = () => {
            clearTimeout(timer);
            socket.removeEventListener("message", onMessage);
          };
          const onMessage = (message: MessageEvent) => {
            const event = JSON.parse(String(message.data));
            events.push(event);
            if (event.type === "response.completed") {
              cleanup();
              resolve(events);
            }
          };
          socket.addEventListener("message", onMessage);
          socket.send(JSON.stringify({ type: "response.create", ...(frame as object) }));
        });
      const prewarm = await exchange({
        generate: false,
        tools: [
          {
            type: "namespace",
            name: "mcp__mqu0_alpha__",
            tools: [{ type: "function", name: "probe" }],
          },
        ],
      });
      expect(prewarm.map((e) => e.type)).toEqual(["response.created", "response.completed"]);
      const generated = await exchange({ input: [{ role: "user", content: LIVE_PROMPT }] });
      const item = generated.find((e) => e.type === "response.output_item.done")!.item;
      expect(item).toMatchObject({
        type: "function_call",
        namespace: "mcp__mqu0_alpha__",
        name: "probe",
        arguments: '{"nonce":"MQ1234"}',
      });
      const line = probeResult("mqu0_alpha", "v1", "MQ1234");
      const continuation = await exchange({
        input: [{ type: "function_call_output", call_id: item.call_id, output: line }],
      });
      expect(
        JSON.stringify(continuation.find((e) => e.type === "response.output_item.done")!.item),
      ).toContain(line);
      await exchange({ generate: false, tools: [{ type: "function", name: "unrelated" }] });
      const replaced = await exchange({ input: [{ role: "user", content: LIVE_PROMPT }] });
      expect(
        JSON.stringify(replaced.find((e) => e.type === "response.output_item.done")!.item),
      ).toContain(PROBE_UNAVAILABLE);
    } finally {
      socket.close();
      await server.stop(true);
    }
  }, 30_000);
});

// Only JSON data frames are returned; DONE is checked separately above.
function sse(body: string): any[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
}

describe("isolated profile wiring", () => {
  for (const platform of ["claude", "codex", "pi", "opencode"] as const) {
    for (const existing of [false, true]) {
      test(`${platform}: rewrite and restore ${existing ? "existing bytes and mode" : "an absent file"}`, async () => {
        const root = mkdtempSync(path.join(tmpdir(), "mcp-wiring-"));
        const file = platformFile(root, platform);
        const original =
          platform === "claude"
            ? '{ "env": {"KEPT":"yes"}, "permissions": {"allow": []} }\n'
            : platform === "codex"
              ? 'openai_base_url = "http://old.invalid"\n[projects.fixture]\ntrust_level = "trusted"\n'
              : platform === "opencode"
                ? '{ "mcp": {"kept": {"type": "local", "command": ["true"]}}, "provider": {"other": {"npm": "x"}} }\n'
                : '{ "providers": {"mcpq-fake": {"old": true}} }\n';
        let handle: Awaited<ReturnType<typeof startMcpFakeModel>> | undefined;
        try {
          if (existing) {
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, original, { mode: 0o640 });
          }
          handle = await startMcpFakeModel(platform, root);
          expect(handle.files).toEqual([path.relative(root, file)]);
          const contents = readFileSync(file, "utf8");
          if (!existing) expect(statSync(file).mode & 0o777).toBe(0o600);
          if (platform === "claude") {
            const configured = JSON.parse(contents);
            expect(configured.env.ANTHROPIC_BASE_URL).toBe(handle.origin);
            expect(configured.env.ANTHROPIC_API_KEY).toBe("fixture-only-not-a-key");
            if (existing) {
              expect(configured.env.KEPT).toBe("yes");
              expect(configured.permissions).toEqual({ allow: [] });
            }
          } else if (platform === "codex") {
            expect(contents.split("\n")[0]).toBe(`openai_base_url = "${handle.origin}/v1"`);
            expect(contents.match(/^openai_base_url/gm)).toHaveLength(1);
            if (existing) expect(contents).toContain('[projects.fixture]\ntrust_level = "trusted"');
          } else if (platform === "opencode") {
            expect(handle.model).toBe(FAKE_OPENCODE_MODEL_REF);
            const configured = JSON.parse(contents);
            expect(configured.provider["mcpq-fake"].options.baseURL).toBe(`${handle.origin}/v1`);
            expect(configured.provider["mcpq-fake"].npm).toBe("@ai-sdk/openai-compatible");
            expect(configured.model).toBe(FAKE_OPENCODE_MODEL_REF);
            expect(configured.small_model).toBe(FAKE_OPENCODE_MODEL_REF);
            expect(configured.enabled_providers).toEqual(["mcpq-fake"]);
            if (existing) {
              expect(configured.mcp.kept.command).toEqual(["true"]);
              expect(configured.provider.other).toEqual({ npm: "x" });
            }
          } else {
            expect(handle.model).toBe(FAKE_PI_MODEL_REF);
            expect(JSON.parse(contents)).toEqual(fakePiModels(`${handle.origin}/v1`));
          }
          const origin = handle.origin;
          await handle.stop();
          handle = undefined;
          if (existing) {
            expect(readFileSync(file, "utf8")).toBe(original);
            expect(statSync(file).mode & 0o777).toBe(0o640);
          } else expect(existsSync(file)).toBe(false);
          await expect(fetch(origin)).rejects.toThrow();
        } finally {
          await handle?.stop();
          rmSync(root, { recursive: true, force: true });
        }
      }, 30_000);
    }
  }

  test("inside-profile guard rejects the root, traversal and sibling prefixes", () => {
    const root = path.resolve(tmpdir(), "mcp-profile");
    expect(insideProfile(root, path.join(root, "agent-credentials", "settings.json"))).toBe(
      path.join(root, "agent-credentials", "settings.json"),
    );
    for (const candidate of [root, path.join(root, "..", "outside"), `${root}-sibling/file`]) {
      expect(() => insideProfile(root, candidate)).toThrow("escapes");
    }
  });

  for (const [platform, original, error] of [
    ["pi", '{"providers":{"someone-else":{"apiKey":"placeholder"}}}\n', "other providers"],
    ["claude", "invalid json\n", "JSON"],
    ["opencode", '{ // a JSONC comment\n "mcp": {} }\n', "not plain JSON"],
  ] as const) {
    test(`${platform}: configuration refusal restores bytes and stops its model`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "mcp-refusal-"));
      const file = platformFile(root, platform);
      let child: ChildProcess | undefined;
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, original);
        const spawnModel = ((...args: Parameters<typeof spawn>) => {
          child = spawn(...args);
          return child;
        }) as typeof spawn;
        await expect(startMcpFakeModel(platform, root, { spawnModel })).rejects.toThrow(
          new RegExp(error),
        );
        expect(readFileSync(file, "utf8")).toBe(original);
        expect(child).toBeDefined();
        expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 30_000);
  }
});

function platformFile(root: string, platform: string) {
  return path.join(
    root,
    "agent-credentials",
    ...(platform === "pi"
      ? ["home", ".pi", "agent", "models.json"]
      : platform === "opencode"
        ? ["xdg-config", "opencode", "opencode.json"]
        : [platform, platform === "claude" ? "settings.json" : "config.toml"]),
  );
}

test("Codex reload observer forwards frames, counts only RPC methods and restores activation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mcp-observer-"));
  const bin = path.join(root, "toolchains", "bin", "fixture");
  const binary = path.join(root, "real-codex.ts");
  let observer: ReturnType<typeof observeCodexReloads> | undefined;
  try {
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      binary,
      `#!${process.execPath}\nimport { createInterface } from "node:readline";\ncreateInterface({ input: process.stdin }).on("line", line => console.log(line));\n`,
      { mode: 0o700 },
    );
    const link = path.join(bin, "codex");
    symlinkSync(binary, link);
    observer = observeCodexReloads(root, root);
    const frames =
      [
        { id: 1, method: "config/mcpServer/reload" },
        { id: 2, method: "thread/start", params: { prompt: '"method":"config/mcpServer/reload"' } },
        { id: 3, method: "config/mcpServer/reload" },
      ]
        .map((frame) => JSON.stringify(frame))
        .join("\n") + "\n";
    const child = Bun.spawn([link], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(frames);
    child.stdin.end();
    const output = await new Response(child.stdout).text();
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    expect(output).toBe(frames);
    expect(observer.count(root)).toBe(2);
    expect(readFileSync(path.join(root, "codex-reloads.jsonl"), "utf8")).not.toContain("prompt");
    observer.stop();
    observer = undefined;
    expect(readlinkSync(link)).toBe(binary);
  } finally {
    observer?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
