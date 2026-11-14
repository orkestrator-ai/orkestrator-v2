import { nativeWebPlatform } from "../../tests/register-dom";
import { describe, expect, test } from "bun:test";
import {
  CODEWORD_REPLY_PREFIX,
  MARKER_WATCH_PATH,
  MAX_WATCHED_MARKERS,
  NO_SUBAGENT_REPLY,
  createMarkerWatch,
  finalReply,
  markerWatchResponse,
  requestState,
  responseContent,
  scriptedStep,
  startClaudeFakeModel,
  streamFrames,
  userItemTexts,
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
const approval =
  "Run this exact shell command once: printf idleqa > idleqa-approval-5.txt\nThen reply with exactly IDLEQA-APPROVED-6 and nothing else.";
const subagents =
  "Use your sub-agent or task delegation tool to start exactly one sub-agent. Give it this task: reply with the text child-7. Run it in the background if your tool supports that. Wait for the sub-agent to finish, then reply with exactly IDLEQA-SUB-8 and nothing else. If you have no sub-agent tool, reply with exactly NO-SUBAGENT-TOOL.";
const question =
  'Use your request_user_input_async tool to ask me one question, "Which codeword should I use?", with the options IDLEQA_ALPHA and IDLEQA_BETA. Do not wait for my answer: right after asking, reply with exactly IDLEQA-ASKED-9 and nothing else.';

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

  test("scripts the approval, sub-agent and async-question cases", () => {
    expect(scriptedStep(approval, false)).toEqual({
      kind: "shell",
      command: "printf idleqa > idleqa-approval-5.txt",
      background: false,
    });
    expect(scriptedStep(approval, true)).toEqual({ kind: "text", text: "IDLEQA-APPROVED-6" });
    // The child gets a prompt of its own, which the same script answers.
    const child = scriptedStep(subagents, false);
    expect(child).toEqual({
      kind: "subagent",
      task: "Reply with exactly child-7 and nothing else. Do not use any tools.",
    });
    expect(scriptedStep((child as { task: string }).task, false)).toEqual({
      kind: "text",
      text: "child-7",
    });
    // The parent's reply is its own word, never the fallback named after it.
    expect(scriptedStep(subagents, true)).toEqual({ kind: "text", text: "IDLEQA-SUB-8" });
    expect(scriptedStep(question, false)).toEqual({
      kind: "question",
      title: "Which codeword should I use?",
      options: ["IDLEQA_ALPHA", "IDLEQA_BETA"],
    });
    expect(scriptedStep(question, true)).toEqual({ kind: "text", text: "IDLEQA-ASKED-9" });
    // The web card's answer (`serializeAsyncQuestionAnswers`) names the choice.
    expect(
      scriptedStep(
        "Answers to your questions:\n\n- Which codeword should I use?: IDLEQA_BETA",
        false,
      ),
    ).toEqual({ kind: "text", text: `${CODEWORD_REPLY_PREFIX}IDLEQA_BETA` });
  });

  test("delegates to whichever agent tool the CLI offers, else says it has none", () => {
    const messages = [{ role: "user", content: subagents }];
    expect(responseContent({ messages, tools: [{ name: "Agent" }] }, 3)).toEqual([
      {
        type: "tool_use",
        id: "toolu_idleqa_3",
        name: "Agent",
        input: {
          description: "Child reply",
          prompt: "Reply with exactly child-7 and nothing else. Do not use any tools.",
          subagent_type: "general-purpose",
        },
      },
    ]);
    expect(responseContent({ messages, tools: [{ name: "Task" }] }, 4)[0]).toMatchObject({
      name: "Task",
    });
    expect(responseContent({ messages, tools: [{ name: "Bash" }] }, 5)).toEqual([
      { type: "text", text: NO_SUBAGENT_REPLY },
    ]);
    // Claude has no async question: the script replies in text.
    expect(
      responseContent({ messages: [{ role: "user", content: question }], tools: [] }, 6),
    ).toEqual([{ type: "text", text: "IDLEQA-ASKED-9" }]);
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

describe("marker watch", () => {
  const marker = "JOINED-0A1B2C3D";
  const steer = `Reply with exactly ${marker} and nothing else. Do not use any tools.`;

  test("reads user-role items of every protocol and nothing else", () => {
    // Messages: a steer the CLI puts beside a tool result.
    const messages = {
      system: [{ type: "text", text: `not ${marker}` }],
      messages: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: [{ type: "text", text: marker }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t", content: "LONG-1" },
            { type: "text", text: steer },
          ],
        },
      ],
    };
    const texts = userItemTexts(messages);
    expect(texts).toHaveLength(2);
    expect(texts.join("").split(marker)).toHaveLength(2);
    // Responses input items and chat completions take the same path.
    expect(
      userItemTexts({
        type: "response.create",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: steer }] }],
      }),
    ).toHaveLength(1);
    expect(userItemTexts({ messages: [{ role: "system", content: steer }] })).toEqual([]);
  });

  test("counts per request: once, dropped and doubled read apart", () => {
    const watch = createMarkerWatch();
    watch.observe({ messages: [{ role: "user", content: steer }] });
    expect(watch.report(marker)).toBeUndefined();
    expect(watch.watch(marker)).toBe(true);
    expect(watch.report(marker)).toEqual({ requests: 0, maxUserOccurrences: 0 });
    watch.observe({ messages: [{ role: "user", content: "LONG-1" }] });
    expect(watch.report(marker)).toEqual({ requests: 0, maxUserOccurrences: 0 });
    // The conversation repeats in later requests; one delivery stays one.
    for (let index = 0; index < 3; index += 1) {
      watch.observe({
        messages: [
          { role: "user", content: steer },
          { role: "assistant", content: marker },
        ],
      });
    }
    expect(watch.report(marker)).toEqual({ requests: 3, maxUserOccurrences: 1 });
    watch.observe({
      messages: [
        { role: "user", content: steer },
        { role: "user", content: steer },
      ],
    });
    expect(watch.report(marker)).toEqual({ requests: 4, maxUserOccurrences: 2 });
  });

  test("accepts only marker-shaped words, and forgets the oldest past its bound", () => {
    const watch = createMarkerWatch();
    expect(watch.watch("two words")).toBe(false);
    expect(watch.watch("x")).toBe(false);
    expect(watch.watch(`A${"B".repeat(64)}`)).toBe(false);
    for (let index = 0; index <= MAX_WATCHED_MARKERS; index += 1) {
      expect(watch.watch(`MARK-${index}`)).toBe(true);
    }
    expect(watch.report("MARK-0")).toBeUndefined();
    expect(watch.report(`MARK-${MAX_WATCHED_MARKERS}`)).toBeDefined();
  });

  test("answers watch, report and anything else", () => {
    const watch = createMarkerWatch();
    const query = (value: string) => new URLSearchParams({ marker: value });
    expect(markerWatchResponse(watch, "GET", query(marker)).status).toBe(404);
    expect(markerWatchResponse(watch, "POST", query("not a marker")).status).toBe(400);
    expect(markerWatchResponse(watch, "POST", query(marker))).toEqual({
      status: 200,
      body: { watching: marker },
    });
    expect(markerWatchResponse(watch, "GET", query(marker))).toEqual({
      status: 200,
      body: { requests: 0, maxUserOccurrences: 0 },
    });
    expect(markerWatchResponse(watch, "DELETE", query(marker)).status).toBe(405);
  });

  test("the Messages endpoint counts what it is sent", async () => {
    let listening: (origin: string) => void = () => undefined;
    const ready = new Promise<string>((resolve) => (listening = resolve));
    const server = startClaudeFakeModel(0, 0, (origin) => listening(origin));
    const fetch = nativeWebPlatform.fetch;
    try {
      const origin = await ready;
      const route = `${origin}${MARKER_WATCH_PATH}?marker=${marker}`;
      expect((await fetch(route, { method: "POST" })).status).toBe(200);
      const reply = await fetch(`${origin}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: steer }] }),
      });
      expect((await reply.json()).content).toEqual([{ type: "text", text: marker }]);
      expect(await (await fetch(route)).json()).toEqual({ requests: 1, maxUserOccurrences: 1 });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
