import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import {
  answerFor,
  fakeModelClaudeSettings,
  holdIdOf,
  lastUserPrompt,
  MAX_STREAM_DELTAS,
  bashWordOf,
  endsWithToolResult,
  messageStreamFrames,
  startFakeAnthropicModel,
  streamDeltaCountOf,
  streamedAnswerDeltas,
  userPromptCount,
  type FakeAnthropicModel,
} from "./fake-anthropic-model";

// The test preload replaces the global with happy-dom's, which applies a page's
// same-origin policy to these loopback requests.
const fetch = Bun.fetch;

let model: FakeAnthropicModel | undefined;
afterEach(async () => {
  await model?.stop();
  model = undefined;
});

function request(prompts: string[], stream = true) {
  return {
    model: "claude-haiku-4-5",
    stream,
    messages: prompts.flatMap((prompt, index) => [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>context</system-reminder>" },
          { type: "text", text: prompt },
        ],
      },
      ...(index < prompts.length - 1
        ? [{ role: "assistant", content: [{ type: "text", text: answerFor(prompt) }] }]
        : []),
    ]),
  };
}

function post(origin: string, body: unknown, signal?: AbortSignal) {
  return fetch(`${origin}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

describe("request parsing", () => {
  test("the prompt is the last user text, without system reminders", () => {
    expect(lastUserPrompt(request(["first", "second [hold:abc]"]))).toBe("second [hold:abc]");
    expect(lastUserPrompt({ messages: [{ role: "user", content: "plain" }] })).toBe("plain");
    expect(lastUserPrompt({})).toBe("");
  });

  test("tool results alone are not prompts", () => {
    expect(
      userPromptCount({
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
          { role: "user", content: "two" },
        ],
      }),
    ).toBe(2);
  });

  test("hold ids are bounded tokens, case-insensitive", () => {
    expect(holdIdOf("run [hold:Turn-1]")).toBe("turn-1");
    expect(holdIdOf("run [hold:]")).toBeUndefined();
    expect(holdIdOf("no hold")).toBeUndefined();
  });

  test("the stream is one text block that ends the turn", () => {
    const frames = messageStreamFrames("msg_1", "m", "hello");
    expect(frames).toContain('"text_delta","text":"hello"');
    expect(frames).toContain('"stop_reason":"end_turn"');
    expect(frames.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
  });

  test("a stream marker asks for a bounded number of extra lines", () => {
    expect(streamDeltaCountOf("go [stream:40]")).toBe(40);
    expect(streamDeltaCountOf("go [STREAM:99999]")).toBe(MAX_STREAM_DELTAS);
    expect(streamDeltaCountOf("go")).toBe(0);
    const deltas = streamedAnswerDeltas("go [stream:3]", 3);
    expect(deltas).toHaveLength(4);
    expect(deltas.join("").startsWith(answerFor("go [stream:3]"))).toBe(true);
    expect(deltas.slice(1).every((delta) => delta.startsWith("\n- step "))).toBe(true);
  });

  test("settings carry a fixture key and the endpoint, nothing from the host", () => {
    const settings = fakeModelClaudeSettings("http://127.0.0.1:1") as {
      env: Record<string, string>;
    };
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1");
    expect(settings.env.ANTHROPIC_API_KEY).toStartWith("fixture-only");
  });
});

describe("endpoint", () => {
  test("answers every prompt and counts each call", async () => {
    model = await startFakeAnthropicModel();
    const response = await post(model.origin, request(["one", "two"], false));
    expect(await response.json()).toMatchObject({
      content: [{ type: "text", text: answerFor("two") }],
      stop_reason: "end_turn",
    });
    const streamed = await (await post(model.origin, request(["three"]))).text();
    expect(streamed).toContain(answerFor("three"));
    expect(model.calls().map((call) => [call.prompt, call.userPrompts])).toEqual([
      ["two", 2],
      ["three", 1],
    ]);
    expect(model.callsWith("thr")).toHaveLength(1);
    expect(model.calls()[0]?.context).toEqual(["one", "two"]);
    expect(model.calls()[1]?.context).toEqual(["three"]);
  });

  test("a held prompt waits for its release; a released id passes from then on", async () => {
    model = await startFakeAnthropicModel();
    const pending = post(model.origin, request(["work [hold:h1]"]));
    for (let attempt = 0; attempt < 100 && model.held().length === 0; attempt += 1) {
      await Bun.sleep(10);
    }
    expect(model.held()).toEqual(["h1"]);
    expect(model.calls()[0]?.answeredAt).toBeUndefined();
    model.release("H1");
    expect(await (await pending).text()).toContain(answerFor("work [hold:h1]"));
    expect(model.held()).toEqual([]);
    const again = await (await post(model.origin, request(["again [hold:h1]"]))).text();
    expect(again).toContain("again");
  });

  test("a held call whose client leaves is recorded as aborted", async () => {
    model = await startFakeAnthropicModel();
    // node:http, not fetch: the test preload's AbortController is happy-dom's.
    const client = http.request(`${model.origin}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    client.on("error", () => undefined);
    client.end(JSON.stringify(request(["gone [hold:h2]"])));
    for (let attempt = 0; attempt < 100 && model.held().length === 0; attempt += 1) {
      await Bun.sleep(10);
    }
    client.destroy();
    for (let attempt = 0; attempt < 100 && !model.calls()[0]?.aborted; attempt += 1) {
      await Bun.sleep(10);
    }
    expect(model.calls()[0]).toMatchObject({ hold: "h2", aborted: true });
    expect(model.held()).toEqual([]);
  });

  test("a stream prompt is answered as paced deltas that join to the whole answer", async () => {
    model = await startFakeAnthropicModel();
    const prompt = "build [stream:4]";
    const startedAt = Date.now();
    const streamed = await (await post(model.origin, request([prompt]))).text();
    const texts = [...streamed.matchAll(/"text_delta","text":("(?:[^"\\]|\\.)*")/g)].map(
      (match) => JSON.parse(match[1]!) as string,
    );
    expect(texts).toEqual(streamedAnswerDeltas(prompt, 4));
    expect(streamed.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
    // Four pauses between five deltas.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4 * 20);
    expect(model.calls()[0]?.streamedAt).toBeGreaterThanOrEqual(model.calls()[0]!.answeredAt!);
    // A non-streaming request with the marker still answers at once, whole.
    const whole = await post(model.origin, request([prompt], false));
    expect(await whole.json()).toMatchObject({ content: [{ text: answerFor(prompt) }] });
  });

  test("a bash prompt calls the Bash tool once; its follow-up is answered as text", async () => {
    model = await startFakeAnthropicModel();
    const prompt = "check [bash:Word-1]";
    expect(bashWordOf(prompt)).toBe("Word-1");
    const first = await (await post(model.origin, request([prompt]))).text();
    expect(first).toContain('"name":"Bash"');
    expect(first).toContain('"stop_reason":"tool_use"');
    expect(first).toContain(
      JSON.stringify(
        JSON.stringify({
          command: "printf Word-1 > Word-1.txt",
          description: "Print a fixture word",
        }),
      ).slice(1, -1),
    );
    const followUp = {
      ...request([prompt]),
      messages: [
        ...request([prompt]).messages,
        { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "Word-1" }] },
      ],
    };
    expect(endsWithToolResult(followUp)).toBe(true);
    expect(endsWithToolResult(request([prompt]))).toBe(false);
    const second = await (await post(model.origin, followUp)).text();
    expect(second).toContain('"text_delta"');
    expect(second).not.toContain('"name":"Bash"');
  });

  test("count_tokens and unknown routes answer without counting a call", async () => {
    model = await startFakeAnthropicModel();
    const counted = await fetch(`${model.origin}/v1/messages/count_tokens`, {
      method: "POST",
      body: "{}",
    });
    expect(await counted.json()).toEqual({ input_tokens: 1 });
    expect((await fetch(`${model.origin}/v1/models`)).status).toBe(200);
    expect(model.calls()).toEqual([]);
  });
});
