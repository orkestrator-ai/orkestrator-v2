import { expect, test } from "bun:test";
import {
  MAX_TOOL_CALLS,
  READY_FILE,
  steerResponseContent,
  steerStep,
  type MessagesBody,
} from "./steer-inactive-fake-claude";

const TOOLS = [{ name: "Bash" }, { name: "Read" }];
const FIRST =
  "This is a bounded QA task in a disposable fixture. Create .qa-queued-ready containing ready, then run sleep 45 repeatedly until steered or cancelled.";
const STEER =
  "Append exactly queued-steer-1731456000000 once to .qa-queued-received. Then run sleep 120 and wait for cancellation.";

let toolId = 0;
function call(command: string) {
  toolId += 1;
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${toolId}`, name: "Bash", input: { command } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `toolu_${toolId}`, content: "" }],
    },
  ];
}

function body(messages: unknown[], tools = TOOLS): MessagesBody {
  return { model: "claude-sonnet-4-6", tools, messages: messages as MessagesBody["messages"] };
}

test("the first call writes the ready file, and later calls keep the turn waiting", () => {
  expect(steerStep(body([{ role: "user", content: FIRST }]))).toEqual({
    kind: "shell",
    command: `printf ready > ${READY_FILE} && sleep 3`,
    description: "Write the ready file and wait",
  });
  const waiting = [
    { role: "user", content: FIRST },
    ...call(`printf ready > ${READY_FILE} && sleep 3`),
  ];
  expect(steerStep(body(waiting))).toMatchObject({ kind: "shell", command: "sleep 3" });
});

test("a steer is found wherever the CLI put it, and appended once", () => {
  const before = [{ role: "user", content: FIRST }, ...call(`printf ready > ${READY_FILE}`)];
  const placements = [
    // As its own user message after an interrupted call.
    [...before, { role: "user", content: [{ type: "text", text: STEER }] }],
    // Beside the tool result, inside a reminder block.
    [
      { role: "user", content: FIRST },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "sleep 3" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t", content: "" },
          { type: "text", text: `<system-reminder>The user sent: ${STEER}</system-reminder>` },
        ],
      },
    ],
  ];
  for (const messages of placements) {
    expect(steerStep(body(messages))).toEqual({
      kind: "shell",
      command: "printf '%s' 'queued-steer-1731456000000' >> .qa-queued-received",
      description: "Append the marker",
    });
  }
  const appended = [
    ...placements[0]!,
    ...call("printf '%s' 'queued-steer-1731456000000' >> .qa-queued-received"),
  ];
  expect(steerStep(body(appended))).toMatchObject({ kind: "shell", command: "sleep 3" });
});

test("requests outside the spec's conversation, or without Bash, get text", () => {
  expect(steerStep(body([{ role: "user", content: "Write a title" }]))).toEqual({
    kind: "text",
    text: "Done.",
  });
  expect(steerStep(body([{ role: "user", content: FIRST }], []))).toEqual({
    kind: "text",
    text: "Done.",
  });
});

test("a forgotten turn stops after a bounded number of calls", () => {
  const messages: unknown[] = [{ role: "user", content: FIRST }];
  for (let index = 0; index < MAX_TOOL_CALLS; index += 1) messages.push(...call("sleep 3"));
  expect(steerStep(body(messages))).toEqual({ kind: "text", text: "Stopped waiting." });
});

test("a shell step is one Bash tool call", () => {
  expect(steerResponseContent(body([{ role: "user", content: FIRST }]), 7)).toEqual([
    {
      type: "tool_use",
      id: "toolu_steerqa_7",
      name: "Bash",
      input: {
        command: `printf ready > ${READY_FILE} && sleep 3`,
        description: "Write the ready file and wait",
      },
    },
  ]);
});
