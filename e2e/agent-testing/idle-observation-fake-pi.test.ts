import { describe, expect, test } from "bun:test";
import {
  PI_FAKE_MODEL_REF,
  piAssistantMessage,
  piFakeModelsConfig,
  piRequestState,
  piStreamFrames,
} from "./idle-observation-fake-pi";

const warmup =
  "Run a shell command that sleeps for 5 seconds, then prints IDLEQA-WARM-1. Wait for it to finish, then reply with exactly IDLEQA-WARM-1 and nothing else.";
const bash = [{ type: "function", function: { name: "bash" } }];

describe("scripted fake Pi model", () => {
  test("calls Pi's bash tool for a command, then replies once its result is back", () => {
    const asked = {
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: warmup },
      ],
      tools: bash,
    };
    expect(piRequestState(asked)).toEqual({ prompt: warmup, afterTool: false });
    expect(piAssistantMessage(asked, 1)).toEqual({
      content: null,
      toolCall: {
        id: "call_idleqa_1",
        name: "bash",
        arguments: '{"command":"sleep 5; echo IDLEQA-WARM-1"}',
      },
    });
    const returned = {
      ...asked,
      messages: [
        ...asked.messages,
        { role: "assistant", content: null },
        { role: "tool", content: "IDLEQA-WARM-1" },
      ],
    };
    expect(piRequestState(returned).afterTool).toBe(true);
    expect(piAssistantMessage(returned, 2)).toEqual({ content: "IDLEQA-WARM-1" });
    // Without the tool, or for a case Pi has no tool for, it replies in text.
    expect(piAssistantMessage({ messages: asked.messages }, 3)).toEqual({
      content: "IDLEQA-WARM-1",
    });
    expect(
      piAssistantMessage(
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Use your sub-agent or task delegation tool to start exactly one sub-agent. Give it this task: reply with the text child-1. Then reply with exactly IDLEQA-SUB-2 and nothing else.",
                },
              ],
            },
          ],
          tools: bash,
        },
        4,
      ),
    ).toEqual({ content: "IDLEQA-SUB-2" });
  });

  test("streams a tool call and its finish reason as chat-completion chunks", () => {
    const frames = piStreamFrames("chatcmpl-1", {
      content: null,
      toolCall: { id: "call_1", name: "bash", arguments: '{"command":"ls"}' },
    })
      .split("\n\n")
      .filter(Boolean);
    expect(frames.at(-1)).toBe("data: [DONE]");
    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame.slice("data: ".length)));
    expect(chunks[0].choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "bash", arguments: '{"command":"ls"}' },
    });
    expect(chunks[1].choices[0].finish_reason).toBe("tool_calls");
    const text = piStreamFrames("chatcmpl-2", { content: "W" }).split("\n\n").filter(Boolean);
    expect(JSON.parse(text[1]!.slice("data: ".length)).choices[0].finish_reason).toBe("stop");
  });

  test("declares one provider whose model is the ref the spec pins", () => {
    const config = piFakeModelsConfig("http://127.0.0.1:1/v1");
    const [provider, entry] = Object.entries(config.providers)[0]!;
    expect(`${provider}/${entry.models[0]!.id}`).toBe(PI_FAKE_MODEL_REF);
    expect(entry.baseUrl).toBe("http://127.0.0.1:1/v1");
    expect(entry.api).toBe("openai-completions");
  });
});
