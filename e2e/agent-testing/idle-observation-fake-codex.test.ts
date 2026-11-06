import { describe, expect, test } from "bun:test";
import { codexOutputItem, codexRequestState, offeredTools } from "./idle-observation-fake-codex";

const warmup =
  "Run a shell command that sleeps for 5 seconds, then prints IDLEQA-WARM-1. Wait for it to finish, then reply with exactly IDLEQA-WARM-1 and nothing else.";

describe("scripted fake Codex model", () => {
  test("finds the spec prompt among Codex's own context messages", () => {
    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>" }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: warmup }] },
    ];
    expect(codexRequestState(input, "")).toEqual({ prompt: warmup, afterTool: false });
    // A command's output ends the turn; an incremental request keeps the remembered prompt.
    expect(codexRequestState([...input, { type: "custom_tool_call_output" }], "")).toEqual({
      prompt: warmup,
      afterTool: true,
    });
    expect(codexRequestState([{ type: "function_call_output" }], warmup)).toEqual({
      prompt: warmup,
      afterTool: true,
    });
  });

  test("calls whichever command tool the request offers, else replies", () => {
    const step = { kind: "shell" as const, command: "sleep 5; echo W", background: false };
    expect(codexOutputItem(step, [{ type: "custom", name: "exec" }], 1)).toMatchObject({
      type: "custom_tool_call",
      name: "exec",
      input: 'text(JSON.stringify(await tools.exec_command({"cmd":"sleep 5; echo W"})));',
    });
    expect(codexOutputItem(step, [{ type: "function", name: "exec_command" }], 2)).toMatchObject({
      type: "function_call",
      name: "exec_command",
      arguments: '{"cmd":"sleep 5; echo W"}',
    });
    expect(codexOutputItem({ kind: "text", text: "W" }, [], 3)).toMatchObject({
      type: "message",
      content: [{ type: "output_text", text: "W" }],
    });
  });

  test("reads the tools Codex offers in namespaced additional_tools items", () => {
    const frame = {
      type: "response.create",
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [
                { type: "custom", name: "exec" },
                { type: "function", name: "wait" },
              ],
            },
          ],
        },
      ],
    };
    expect(offeredTools(frame)).toEqual([
      { type: "custom", name: "exec" },
      { type: "function", name: "wait" },
    ]);
    expect(offeredTools({ tools: [{ type: "function", name: "exec_command" }] })).toEqual([
      { type: "function", name: "exec_command" },
    ]);
  });
});
