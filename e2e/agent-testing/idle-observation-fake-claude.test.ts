import { describe, expect, test } from "bun:test";
import {
  finalReply,
  requestState,
  responseContent,
  scriptedStep,
  streamFrames,
} from "./idle-observation-fake-claude";

// The spec's own prompt shapes (`idle-observation-live.spec.ts`).
const replyPrompt =
  "Reply with exactly the uppercase form of this text and nothing else: idleqa-missed-123456. Do not use any tools.";
const warmup =
  "Run a shell command that sleeps for 5 seconds, then prints IDLEQA-WARM-1. Wait for it to finish, then reply with exactly IDLEQA-WARM-1 and nothing else.";
const background =
  "Start this shell command as a background task and do not wait for it: sleep 20; echo IDLEQA-BGOUT-2 Right after starting it, reply with exactly IDLEQA-BG-3 and nothing else. Do not run any other command.";
const waitFor =
  "Run this shell command and wait for it: sleep 8\nThen reply with exactly IDLEQA-RECONNECT-4 and nothing else.";

describe("scripted fake Claude model", () => {
  test("answers each spec prompt the way a compliant model would", () => {
    expect(scriptedStep(replyPrompt, false)).toEqual({
      kind: "text",
      text: "IDLEQA-MISSED-123456",
    });
    expect(scriptedStep(warmup, false)).toEqual({
      kind: "shell",
      command: "sleep 5; echo IDLEQA-WARM-1",
      background: false,
    });
    expect(scriptedStep(background, false)).toEqual({
      kind: "shell",
      command: "sleep 20; echo IDLEQA-BGOUT-2",
      background: true,
    });
    expect(scriptedStep(waitFor, false)).toEqual({
      kind: "shell",
      command: "sleep 8",
      background: false,
    });
    // A command's result always ends the turn with the reply.
    expect(scriptedStep(warmup, true)).toEqual({ kind: "text", text: "IDLEQA-WARM-1" });
    expect(scriptedStep(background, true)).toEqual({ kind: "text", text: "IDLEQA-BG-3" });
    expect(scriptedStep("<task-notification>done</task-notification>", false)).toEqual({
      kind: "text",
      text: "Noted.",
    });
    expect(finalReply("Generate a title")).toBe("Done.");
  });

  test("reads the prompt past tool results and system reminders", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>context</system-reminder>" },
            { type: "text", text: warmup },
          ],
        },
        { role: "assistant", content: [{ type: "tool_use" }] },
        { role: "user", content: [{ type: "tool_result" }] },
      ],
    };
    expect(requestState(body)).toEqual({ prompt: warmup, afterTool: true });
    // A notification the CLI sends on its own answers itself; it never
    // re-runs the earlier prompt (which would start the task again).
    const notification = {
      messages: [
        { role: "user", content: background },
        { role: "assistant", content: [{ type: "text", text: "IDLEQA-BG-3" }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder><task-notification>done</task-notification></system-reminder>",
            },
          ],
        },
      ],
    };
    expect(requestState(notification).afterTool).toBe(false);
    expect(responseContent({ ...notification, tools: [{ name: "Bash" }] }, 9)).toEqual([
      { type: "text", text: "Noted." },
    ]);
    expect(requestState({ messages: [{ role: "user", content: replyPrompt }] })).toEqual({
      prompt: replyPrompt,
      afterTool: false,
    });
  });

  test("calls Bash only when the request offers it", () => {
    const messages = [{ role: "user", content: background }];
    expect(responseContent({ messages, tools: [{ name: "Bash" }] }, 7)).toEqual([
      {
        type: "tool_use",
        id: "toolu_idleqa_7",
        name: "Bash",
        input: {
          command: "sleep 20; echo IDLEQA-BGOUT-2",
          description: "Start the background command",
          run_in_background: true,
        },
      },
    ]);
    // A side request (a title) has no tools: it gets text, never a tool call.
    expect(responseContent({ messages }, 8)).toEqual([{ type: "text", text: "IDLEQA-BG-3" }]);
  });

  test("streams a tool call as input JSON and stops for the tool", () => {
    const frames = streamFrames("msg_1", "model", [
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "sleep 1" } },
    ]);
    const events = frames
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.split("\ndata: ")[1]!) as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[1]).toMatchObject({ content_block: { type: "tool_use", input: {} } });
    expect(events[2]).toMatchObject({
      delta: { type: "input_json_delta", partial_json: '{"command":"sleep 1"}' },
    });
    expect(events[4]).toMatchObject({ delta: { stop_reason: "tool_use" } });
  });
});
