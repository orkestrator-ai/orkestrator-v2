import { describe, expect, test } from "bun:test";
import { PROBE_UNAVAILABLE, probePrompt, probeResult } from "./mcp-apply-live-support";
import {
  anthropicContent,
  anthropicRequest,
  chatMessage,
  chatRequest,
  responsesOutputItem,
  responsesRequest,
} from "./mcp-fake-model";
import {
  BUSY_TEXT_DELAY_MS,
  CODE_NO_TOOL,
  codeCell,
  offeredToolName,
  scriptedStep,
} from "./mcp-fake-model-script";

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
    // A renamed server's tool does not stand in for the old name.
    expect(offeredToolName(["mcp__mqu0_beta__probe"], "mqu0_alpha", "probe")).toBeUndefined();
    expect(offeredToolName(["mcp__mqu0_alpha2__probe"], "mqu0_alpha", "probe")).toBeUndefined();
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
