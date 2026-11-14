import { nativeWebPlatform } from "../../tests/register-dom";
import { describe, expect, test } from "bun:test";
import { MARKER_WATCH_PATH, NO_SUBAGENT_REPLY } from "./idle-observation-fake-claude";
import {
  startCodexFakeModel,
  codexFollowUp,
  codexOutputItem,
  codexRequestState,
  offeredTools,
} from "./idle-observation-fake-codex";

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
      { type: "custom", name: "exec", namespace: "functions" },
      { type: "function", name: "wait", namespace: "functions" },
    ]);
    expect(offeredTools({ tools: [{ type: "function", name: "exec_command" }] })).toEqual([
      { type: "function", name: "exec_command" },
    ]);
  });

  // What Codex 0.166 offers through the bridge (seen with IDLEQA_FAKE_CODEX_SHAPES=schemas).
  const tools = [
    { type: "custom", name: "exec", namespace: "functions" },
    { type: "function", name: "request_user_input_async", namespace: "functions" },
    { type: "function", name: "spawn_agent", namespace: "collaboration" },
    { type: "function", name: "wait_agent", namespace: "collaboration" },
  ];

  test("names a call's namespace unless it is functions", () => {
    const question = codexOutputItem(
      { kind: "question", title: "Which?", options: ["A", "B"] },
      tools,
      4,
    );
    expect(question).toMatchObject({
      type: "function_call",
      name: "request_user_input_async",
      arguments: '{"questions":[{"title":"Which?","options":["A","B"]}]}',
    });
    expect(question).not.toHaveProperty("namespace");
    // Codex answers "unsupported call" to a collaboration tool named bare.
    expect(codexOutputItem({ kind: "subagent", task: "Reply with exactly c." }, tools, 5)).toEqual({
      type: "function_call",
      id: "fc_idleqa_5",
      call_id: "call_idleqa_5",
      name: "spawn_agent",
      namespace: "collaboration",
      arguments:
        '{"task_name":"idleqa_child_5","message":"Reply with exactly c.","fork_turns":"none"}',
      status: "completed",
    });
    expect(codexOutputItem("wait", tools, 6)).toMatchObject({
      name: "wait_agent",
      namespace: "collaboration",
    });
    expect(codexOutputItem({ kind: "subagent", task: "t" }, [], 7)).toMatchObject({
      type: "message",
      content: [{ text: NO_SUBAGENT_REPLY }],
    });
  });

  test("yields a background command so it outlives the turn", () => {
    const item = codexOutputItem(
      { kind: "shell", command: "sleep 20; echo M", background: true },
      tools,
      8,
    );
    expect(item.input).toBe(
      'text(JSON.stringify(await tools.exec_command({"cmd":"sleep 20; echo M","yield_time_ms":1000})));',
    );
  });

  test("follows multi-agent mail: a child's task, then the parent's wait and reply", () => {
    const parent =
      "Use your sub-agent or task delegation tool to start exactly one sub-agent. Give it this task: reply with the text child-1. Wait for the sub-agent to finish, then reply with exactly IDLEQA-SUB-2 and nothing else.";
    // The child's first request: its task is a NEW_TASK agent message.
    const childInput = [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "<environment>" }] },
      {
        type: "agent_message",
        content: [
          {
            type: "input_text",
            text: "Message Type: NEW_TASK\nTask name: /root/idleqa_child_5\nSender: /root\nPayload:\n",
          },
          {
            type: "encrypted_content",
            encrypted_content: "Reply with exactly child-1 and nothing else.",
          },
        ],
      },
    ];
    expect(codexRequestState(childInput, "")).toEqual({
      prompt: "Reply with exactly child-1 and nothing else.",
      afterTool: false,
    });
    // spawn_agent's output is waited for; the wait and the child's answer end the turn.
    expect(codexFollowUp(parent, "spawn_agent")).toBe("wait");
    const answered = [
      { type: "function_call_output", call_id: "call_idleqa_6" },
      {
        type: "agent_message",
        content: [
          {
            type: "input_text",
            text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/idleqa_child_5\nPayload:\nchild-1",
          },
        ],
      },
    ];
    // A child's answer is never mistaken for the parent's prompt.
    expect(codexRequestState(answered, parent)).toEqual({ prompt: parent, afterTool: true });
    expect(codexFollowUp(parent, undefined)).toEqual({ kind: "text", text: "IDLEQA-SUB-2" });
  });

  test("recognises an async question's answer as the prompt", () => {
    const answer = "Answers to your questions:\n\n- Which?: IDLEQA_BETA";
    expect(
      codexRequestState(
        [{ type: "message", role: "user", content: [{ type: "input_text", text: answer }] }],
        "earlier",
      ),
    ).toEqual({ prompt: answer, afterTool: false });
  });
});

test("websocket wiring remembers calls, waits once, caps spawns per connection and evicts old calls", async () => {
  let calls = new Map<string, string>();
  const server = startCodexFakeModel((current) => {
    calls = new Map(current);
  }, nativeWebPlatform);
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/v1`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("websocket open failed"));
    });
    const exchange = (input: object[], tools?: object[]) =>
      new Promise<Record<string, any>>((resolve) => {
        let item: Record<string, any> = {};
        socket.onmessage = (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "response.output_item.done") item = frame.item;
          if (frame.type === "response.completed") resolve(item);
        };
        socket.send(
          JSON.stringify({ type: "response.create", input, ...(tools ? { tools } : {}) }),
        );
      });
    const prompt =
      "Use your sub-agent or task delegation tool to start exactly one sub-agent. Give it this task: reply with the text child-1. Then reply with exactly IDLEQA-SUB-2 and nothing else.";
    const first = await exchange(
      [{ role: "user", content: prompt }],
      [
        {
          type: "namespace",
          name: "collaboration",
          tools: [
            { type: "function", name: "spawn_agent" },
            { type: "function", name: "wait_agent" },
          ],
        },
      ],
    );
    expect(first.name).toBe("spawn_agent");
    expect(first.namespace).toBe("collaboration");
    expect(calls.get(first.call_id)).toBe("spawn_agent");
    const wait = await exchange([{ type: "function_call_output", call_id: first.call_id }]);
    expect(wait.name).toBe("wait_agent");
    const done = await exchange([{ type: "function_call_output", call_id: wait.call_id }]);
    expect(done.content[0].text).toBe("IDLEQA-SUB-2");
    expect((await exchange([{ role: "user", content: prompt }])).name).toBe("spawn_agent");
    expect((await exchange([{ role: "user", content: prompt }])).content[0].text).toBe(
      NO_SUBAGENT_REPLY,
    );
    // Fresh commands still work after the spawn cap, using newly offered tools.
    for (let index = 0; index < 65; index += 1) {
      await exchange(
        [{ role: "user", content: warmup }],
        [{ type: "function", name: "exec_command" }],
      );
    }
    expect(calls.size).toBe(64);
    expect(calls.has(first.call_id)).toBe(false);
    expect([...calls.values()].every((name) => name === "exec_command")).toBe(true);
    // The marker watch answers over plain HTTP and counts each request frame.
    const fetch = nativeWebPlatform.fetch;
    const watch = `http://127.0.0.1:${server.port}${MARKER_WATCH_PATH}?marker=IDLEQA-SUB-2`;
    expect((await fetch(watch)).status).toBe(404);
    expect((await fetch(watch, { method: "POST" })).status).toBe(200);
    await exchange([
      { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
    ]);
    await exchange([{ type: "function_call_output", call_id: "unrelated" }]);
    expect(await (await fetch(watch)).json()).toEqual({ requests: 1, maxUserOccurrences: 1 });
  } finally {
    socket.close();
    await server.stop(true);
  }
}, 15000);
