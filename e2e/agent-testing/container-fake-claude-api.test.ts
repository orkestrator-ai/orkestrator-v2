import { describe, expect, test } from "bun:test";
import {
  createFakeClaudeApiStats,
  fakeReply,
  handleFakeClaudeApi,
  messageStream,
  minimalInstance,
  SCRIPTED_COMMANDS,
  scriptedAction,
  type FakeAction,
} from "./container-fake-claude-api";

const PROMPT = "Reply with only the word PONG and then 41 plus 1 as digits. No tools.";

const post = (pathname: string, body: unknown) =>
  handleFakeClaudeApi(
    new Request(`http://127.0.0.1:47123${pathname}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

describe("container fake Claude API", () => {
  test("answers the spec's arithmetic so the echoed prompt cannot match", () => {
    expect(fakeReply({ messages: [{ role: "user", content: PROMPT }] })).toBe("PONG 42");
    const reply = fakeReply({
      messages: [
        { role: "user", content: [{ type: "text", text: PROMPT }] },
        { role: "assistant", content: "PONG 42" },
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>context</system-reminder>" },
            { type: "text", text: PROMPT.replace("41 plus 1", "50 plus 5") },
          ],
        },
      ],
    });
    expect(reply).toBe("PONG 55");
    expect(/PONG\s*55/.test(PROMPT.replace("41 plus 1", "50 plus 5"))).toBe(false);
  });

  test("answers side requests with a plain reply", () => {
    expect(fakeReply({ messages: [{ role: "user", content: "Summarise this" }] })).toBe("PONG");
    expect(fakeReply({})).toBe("PONG");
  });

  test("streams a complete Messages event sequence", async () => {
    const response = await post("/v1/messages", {
      model: "claude-fixture",
      stream: true,
      messages: [{ role: "user", content: PROMPT }],
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frames = (await response.text())
      .trim()
      .split("\n\n")
      .map((frame) => {
        const [event, data] = frame.split("\n");
        return { event: event!.slice(7), data: JSON.parse(data!.slice(6)) };
      });
    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    for (const frame of frames) expect(frame.data.type).toBe(frame.event);
    expect(frames[2]!.data.delta).toEqual({ type: "text_delta", text: "PONG 42" });
    expect(frames[4]!.data.delta.stop_reason).toBe("end_turn");
  });

  test("answers a non-streaming request with one message", async () => {
    const body = await (
      await post("/v1/messages", { messages: [{ role: "user", content: PROMPT }] })
    ).json();
    expect(body.content).toEqual([{ type: "text", text: "PONG 42" }]);
    expect(body.stop_reason).toBe("end_turn");
  });

  test("counts tokens and refuses every other route", async () => {
    expect(await (await post("/v1/messages/count_tokens", {})).json()).toEqual({
      input_tokens: 1,
    });
    expect((await post("/v1/complete", {})).status).toBe(404);
    expect(
      (await handleFakeClaudeApi(new Request("http://127.0.0.1:47123/v1/messages"))).status,
    ).toBe(404);
  });

  test("holds a reply back by the configured delay", async () => {
    const started = performance.now();
    const response = await handleFakeClaudeApi(
      new Request("http://127.0.0.1:47123/v1/messages", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: PROMPT }] }),
      }),
      50,
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
    expect((await response.json()).content[0].text).toBe("PONG 42");
  });

  test("the stream helper frames each event for SSE", () => {
    expect(messageStream("msg_1", "m", "x").endsWith("\n\n")).toBe(true);
  });
});

type Message = { role: string; content: string | Array<Record<string, unknown>> };

/** Plays the CLI's side of a scripted turn: each tool call answered, as the hook would. */
function playTurn(
  prompt: string,
  tools: Array<{ name: string; input_schema?: Record<string, unknown> }>,
  answer: (action: Extract<FakeAction, { kind: "tool" }>) => { isError: boolean; text: string },
  options: {
    loadTools?: typeof tools;
    messages?: Message[];
    stats?: ReturnType<typeof createFakeClaudeApiStats>;
  } = {},
) {
  const stats = options.stats ?? createFakeClaudeApiStats();
  const messages = options.messages ?? [];
  messages.push({ role: "user", content: prompt });
  const actions: FakeAction[] = [];
  let offered = tools;
  for (let index = 0; index < 8; index += 1) {
    const action = scriptedAction({ messages, tools: offered }, stats);
    if (!action) return { actions, stats, messages, unscripted: true };
    actions.push(action);
    if (action.kind === "text") break;
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: action.id, name: action.name, input: action.input }],
    });
    const { isError, text } = answer(action);
    if (action.name === "ToolSearch" && options.loadTools)
      offered = [...tools, ...options.loadTools];
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: action.id, is_error: isError, content: text },
        { type: "text", text: "<system-reminder>Continue this turn.</system-reminder>" },
      ],
    });
  }
  return { actions, stats, messages, unscripted: false };
}

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "issues", "tests"],
  properties: {
    verdict: { type: "string", enum: ["yes", "no"] },
    issues: { type: "array", items: { type: "string" } },
    tests: {
      type: "object",
      required: ["total", "label"],
      properties: { total: { type: "integer" }, label: { type: "string", minLength: 3 } },
    },
    optional: { type: "string" },
  },
};
const PLAN_SCHEMA = {
  type: "object",
  required: ["headRef", "commands", "limitations"],
  properties: {
    headRef: { type: "string" },
    commands: { type: "array", items: { type: "object" } },
    limitations: { type: "array", items: { type: "string" } },
  },
};
const HEAD = "161cbb232de9a50a66639910937ae5eb0508768f";
/** The read-only hook's answers: reads run, writes are refused. */
const readOnlyHook = (action: Extract<FakeAction, { kind: "tool" }>) => {
  const command = (action.input as { command?: string }).command;
  if (command === SCRIPTED_COMMANDS.write) return { isError: true, text: "refused" };
  if (command === SCRIPTED_COMMANDS.head) return { isError: false, text: `${HEAD}\n` };
  return { isError: false, text: "ok" };
};

describe("container fake Claude API, Multi Review steps (todo 0190)", () => {
  test("builds the smallest instance of a result schema", () => {
    expect(minimalInstance(REPORT_SCHEMA)).toEqual({
      verdict: "yes",
      issues: [],
      tests: { total: 0, label: "fixture" },
    });
    expect(
      minimalInstance({
        $defs: { gap: { anyOf: [{ type: "null" }, { type: "integer", minimum: 1 }] } },
        type: "object",
        required: ["gap", "list"],
        properties: {
          gap: { $ref: "#/$defs/gap" },
          list: { type: "array", minItems: 2, items: { type: "string" } },
        },
      }),
    ).toEqual({ gap: 1, list: ["fixture-1", "fixture-2"] });
  });

  test("a structured-output turn reads, tries to write, submits, then closes", () => {
    const { actions, stats } = playTurn(
      "Review this package.",
      [{ name: "Bash" }, { name: "StructuredOutput", input_schema: REPORT_SCHEMA }],
      readOnlyHook,
    );
    expect(actions.map((action) => (action.kind === "tool" ? action.name : "text"))).toEqual([
      "Bash",
      "Bash",
      "StructuredOutput",
      "text",
    ]);
    const [read, write, output] = actions as Array<Extract<FakeAction, { kind: "tool" }>>;
    expect(read!.input).toEqual({ command: SCRIPTED_COMMANDS.read });
    expect(write!.input).toEqual({ command: SCRIPTED_COMMANDS.write });
    expect(output!.input).toEqual(minimalInstance(REPORT_SCHEMA));
    expect(actions.at(-1)).toEqual({ kind: "text", text: "Done." });
    expect(stats.results).toEqual([
      { step: "read", isError: false },
      { step: "write", isError: true },
      { step: "output", isError: false },
    ]);
  });

  test("a validation plan submits the commit it read and a limitation", () => {
    const { actions } = playTurn(
      "Prepare the package.",
      [{ name: "Bash" }, { name: "StructuredOutput", input_schema: PLAN_SCHEMA }],
      readOnlyHook,
    );
    const tools = actions.filter((action) => action.kind === "tool");
    expect(tools[0]!.input).toEqual({ command: SCRIPTED_COMMANDS.head });
    expect(tools[2]!.input).toEqual({
      headRef: HEAD,
      commands: [],
      limitations: ["Fixture plan: no validation commands."],
    });
  });

  test("the tool transport loads the deferred submit tool, then submits with the key", () => {
    const key = "0d6f6f8e-5c1a-4d7e-9a43-9b1f6f3f2a11";
    const prompt = `Review it. <system-instructions>... call \`validate_workflow_result\` with resultKey "${key}" and capability "cap-fixture" ... call the Orkestrator \`submit_review_report\` tool with the same resultKey and capability "cap-fixture" and complete result.</system-instructions> Deferred: mcp__orkestrator__submit_review_report`;
    const submit = {
      name: "mcp__orkestrator__submit_review_report",
      input_schema: {
        type: "object",
        required: ["resultKey", "result"],
        properties: { resultKey: { type: "string" }, result: REPORT_SCHEMA },
      },
    };
    const { actions } = playTurn(prompt, [{ name: "Bash" }, { name: "ToolSearch" }], readOnlyHook, {
      loadTools: [submit],
    });
    const tools = actions.filter((action) => action.kind === "tool");
    expect(tools.map((action) => action.name)).toEqual(["ToolSearch", "Bash", "Bash", submit.name]);
    expect(tools[0]!.input).toEqual({ query: `select:${submit.name}` });
    expect(tools[3]!.input).toEqual({
      resultKey: key,
      capability: "cap-fixture",
      result: minimalInstance(REPORT_SCHEMA),
    });
    expect(actions.at(-1)).toEqual({ kind: "text", text: "Done." });
  });

  for (const transport of ["structured", "deferred"] as const) {
    for (const refused of [false, true]) {
      test(`${transport} starts fresh after a ${refused ? "refused" : "completed"} retained turn`, () => {
        const submit = {
          name: "mcp__orkestrator__submit_review_report",
          input_schema: { properties: { result: REPORT_SCHEMA } },
        };
        const tools =
          transport === "structured"
            ? [{ name: "Bash" }, { name: "StructuredOutput", input_schema: REPORT_SCHEMA }]
            : [{ name: "Bash" }, { name: "ToolSearch" }];
        const prompt = (key: string) =>
          `call the Orkestrator \`submit_review_report\` tool with resultKey "${key}". mcp__orkestrator__submit_review_report`;
        const first = playTurn(
          prompt("0d6f6f8e-5c1a-4d7e-9a43-9b1f6f3f2a11"),
          tools,
          (action) =>
            action.name === submit.name || action.name === "StructuredOutput"
              ? { isError: refused, text: refused ? "refused" : "accepted" }
              : readOnlyHook(action),
          { loadTools: [submit] },
        );
        expect(first.actions.at(-1)).toEqual({
          kind: "text",
          text: refused ? "The result was refused." : "Done.",
        });
        const secondKey = refused
          ? "0d6f6f8e-5c1a-4d7e-9a43-9b1f6f3f2a11"
          : "1d6f6f8e-5c1a-4d7e-9a43-9b1f6f3f2a11";
        const second = playTurn(
          refused ? "Correct the refused result and submit again." : prompt(secondKey),
          tools,
          readOnlyHook,
          {
            loadTools: [submit],
            messages: first.messages,
            stats: first.stats,
          },
        );
        const calls = second.actions.filter((action) => action.kind === "tool");
        expect(calls.map((action) => action.name)).toEqual(
          transport === "structured"
            ? ["Bash", "Bash", "StructuredOutput"]
            : ["ToolSearch", "Bash", "Bash", submit.name],
        );
        expect(calls.at(-3)!.input).toEqual({ command: SCRIPTED_COMMANDS.read });
        expect(calls.at(-2)!.input).toEqual({ command: SCRIPTED_COMMANDS.write });
        expect(calls.at(-1)!.input).toEqual(
          transport === "structured"
            ? minimalInstance(REPORT_SCHEMA)
            : { resultKey: secondKey, result: minimalInstance(REPORT_SCHEMA) },
        );
        expect(second.actions.at(-1)).toEqual({ kind: "text", text: "Done." });
        expect(second.stats.results.filter((result) => result.step === "output")).toEqual([
          { step: "output", isError: refused },
          { step: "output", isError: false },
        ]);
      });
    }
  }

  test("a submit tool that never loads ends the turn instead of looping", () => {
    const prompt = `call \`validate_workflow_result\` with resultKey "0d6f6f8e-5c1a-4d7e-9a43-9b1f6f3f2a11" ... call the Orkestrator \`submit_review_report\` tool. mcp__orkestrator__submit_review_report`;
    const { actions } = playTurn(prompt, [{ name: "ToolSearch" }], () => ({
      isError: false,
      text: "",
    }));
    expect(actions).toHaveLength(2);
    expect(actions.at(-1)).toEqual({ kind: "text", text: "The result tool could not be loaded." });
  });

  test("any other request is not scripted, and stats stay content-free", async () => {
    expect(scriptedAction({ messages: [{ role: "user", content: PROMPT }], tools: [] })).toBeNull();
    const stats = createFakeClaudeApiStats();
    await handleFakeClaudeApi(
      new Request("http://127.0.0.1:47123/v1/messages", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: PROMPT }] }),
      }),
      0,
      stats,
    );
    const served = await (
      await handleFakeClaudeApi(new Request("http://127.0.0.1:47123/fixture/stats"), 0, stats)
    ).json();
    expect(served).toEqual({ requests: 1, results: [] });
  });

  test("a tool call streams as tool_use with its input as one JSON delta", () => {
    const frames = messageStream("msg_1", "m", {
      kind: "tool",
      id: "toolu_fixture_read_1",
      name: "Bash",
      input: { command: "ls -la" },
    })
      .trim()
      .split("\n\n")
      .map((frame) => JSON.parse(frame.split("\n")[1]!.slice(6)));
    expect(frames[1].content_block).toEqual({
      type: "tool_use",
      id: "toolu_fixture_read_1",
      name: "Bash",
      input: {},
    });
    expect(frames[2].delta).toEqual({
      type: "input_json_delta",
      partial_json: JSON.stringify({ command: "ls -la" }),
    });
    expect(frames[4].delta.stop_reason).toBe("tool_use");
  });
});
