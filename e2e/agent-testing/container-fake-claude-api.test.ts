import { describe, expect, test } from "bun:test";
import {
  fakeReply,
  handleFakeClaudeApi,
  messageStream,
  REFUSE_MARKER,
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

  test("refuses a marked prompt as a wrong key, and only while it is the latest", async () => {
    const refused = await post("/v1/messages", {
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: `Say ${REFUSE_MARKER}` }] }],
    });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
    });
    const after = await post("/v1/messages", {
      messages: [
        { role: "user", content: `Say ${REFUSE_MARKER}` },
        { role: "user", content: PROMPT },
      ],
    });
    expect(after.status).toBe(200);
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
