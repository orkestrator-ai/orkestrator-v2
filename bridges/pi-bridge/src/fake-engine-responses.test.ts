import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { fakePiResponse } from "./testing/fake-engine-responses.js";

const faux = { fauxAssistantMessage, fauxToolCall };
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

test("an ordinary prompt is answered with its text", () => {
  const reply = fakePiResponse({ messages: [user("hello")] }, faux);
  expect(reply.stopReason).toBe("stop");
  expect(reply.content).toEqual([{ type: "text", text: "Answer to: hello" }]);
});

test("a BASH line becomes a call to Pi's bash tool", () => {
  const reply = fakePiResponse(
    { messages: [user("Probe the network\nBASH: curl -sS https://example.com; echo exit=$?")] },
    faux,
  );
  expect(reply.stopReason).toBe("toolUse");
  expect(reply.content).toEqual([
    expect.objectContaining({
      type: "toolCall",
      name: "bash",
      arguments: { command: "curl -sS https://example.com; echo exit=$?" },
    }),
  ]);
});

test("the call after a tool result reports the result and ends the turn", () => {
  const reply = fakePiResponse(
    {
      messages: [
        user("BASH: echo hi"),
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "hi\n" }],
          isError: false,
          timestamp: 0,
        },
      ],
    },
    faux,
  );
  expect(reply.stopReason).toBe("stop");
  expect(reply.content).toEqual([{ type: "text", text: "Tool result: hi\n" }]);
});
