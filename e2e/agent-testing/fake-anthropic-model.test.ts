import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import {
  answerFor,
  fakeModelClaudeSettings,
  holdIdOf,
  imageBlockCount,
  lastUserPrompt,
  MAX_RETRY_FAILURES,
  MAX_STREAM_DELTAS,
  offeredToolNames,
  resolveStepTool,
  retryOf,
  scriptIdOf,
  toolResultsSinceTurnPrompt,
  turnPrompt,
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

  test("a stream the client leaves stops early, is aborted and has no stream end", async () => {
    model = await startFakeAnthropicModel();
    // node:http, not fetch: the test preload's AbortController is happy-dom's.
    const client = http.request(`${model.origin}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    client.on("error", () => undefined);
    let received = 0;
    const firstBytes = new Promise<void>((resolve) => {
      client.on("response", (response) => {
        response.on("error", () => undefined);
        response.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          resolve();
        });
      });
    });
    // 200 deltas 25 ms apart: about five seconds, far longer than this test waits.
    client.end(JSON.stringify(request(["gone [stream:200]"])));
    await firstBytes;
    client.destroy();
    for (let attempt = 0; attempt < 200 && !model.calls()[0]?.aborted; attempt += 1) {
      await Bun.sleep(10);
    }
    const call = model.calls()[0]!;
    expect(call.aborted).toBe(true);
    expect(call.answeredAt).toBeGreaterThan(0);
    expect(call.streamedAt).toBeUndefined();
    expect(received).toBeGreaterThan(0);
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

  test("a script plays one tool call per step, then ends the turn with the prompt's answer", async () => {
    model = await startFakeAnthropicModel(0, {
      toolScripts: {
        probe: [
          { tool: "Write", input: { file_path: "a.txt", content: "x" } },
          { tool: "*__submit_report", input: { text: "done" } },
        ],
      },
    });
    const prompt = "Probe the workspace [script:Probe]";
    expect(scriptIdOf(prompt)).toBe("probe");
    const offered = { tools: [{ name: "Write" }, { name: "mcp__orkestrator__submit_report" }] };
    const step = (results: number) => ({
      ...request([prompt]),
      ...offered,
      messages: [
        ...request([prompt]).messages,
        ...Array.from({ length: results }, (_, index) => [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: `t${index}`, name: "X", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: `t${index}`, content: "ok" }],
          },
        ]).flat(),
      ],
    });
    expect(turnPrompt(step(2))).toBe(prompt);
    expect(toolResultsSinceTurnPrompt(step(2))).toBe(2);
    expect(toolResultsSinceTurnPrompt(step(0))).toBe(0);
    const first = await (await post(model.origin, step(0))).text();
    expect(first).toContain('"name":"Write"');
    const second = await (await post(model.origin, step(1))).text();
    expect(second).toContain('"name":"mcp__orkestrator__submit_report"');
    expect(second).toContain(JSON.stringify(JSON.stringify({ text: "done" })).slice(1, -1));
    const last = await (await post(model.origin, step(2))).text();
    expect(last).toContain(JSON.stringify(answerFor(prompt)).slice(1, -1));
    expect(model.calls().map((call) => call.script)).toEqual([
      { id: "probe", step: 0, tool: "Write" },
      { id: "probe", step: 1, tool: "mcp__orkestrator__submit_report" },
      { id: "probe", step: 2 },
    ]);
    expect(model.calls()[0]!.tools).toEqual(["Write", "mcp__orkestrator__submit_report"]);
  });

  test("a suffix step with no matching tool calls the bare name", () => {
    expect(resolveStepTool({ tool: "*submit_report", input: {} }, ["Read"])).toBe("submit_report");
    expect(resolveStepTool({ tool: "Bash", input: {} }, [])).toBe("Bash");
  });

  test("a retry prompt fails its first n calls with 500, then answers", async () => {
    model = await startFakeAnthropicModel();
    const prompt = "flaky [retry:once:2]";
    expect(retryOf(prompt)).toEqual({ id: "once", failures: 2 });
    expect(retryOf("[retry:many:99]")).toEqual({ id: "many", failures: MAX_RETRY_FAILURES });
    expect((await post(model.origin, request([prompt]))).status).toBe(500);
    expect((await post(model.origin, request([prompt]))).status).toBe(500);
    const answered = await post(model.origin, request([prompt]));
    expect(answered.status).toBe(200);
    expect(await answered.text()).toContain(JSON.stringify(answerFor(prompt)).slice(1, -1));
    expect(model.calls().map((call) => call.failedWith)).toEqual([500, 500, undefined]);
  });

  test("image blocks are counted, including those inside tool results", async () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AA" },
    };
    const body = {
      messages: [
        { role: "user", content: [image, { type: "text", text: "look" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [image] }] },
      ],
    };
    expect(imageBlockCount(body)).toBe(2);
    expect(imageBlockCount(request(["plain"]))).toBe(0);
    expect(offeredToolNames({ tools: [{ name: "Read" }, { nameless: true }] })).toEqual(["Read"]);
    model = await startFakeAnthropicModel();
    await post(model.origin, { ...body, stream: true });
    expect(model.calls()[0]!.images).toBe(2);
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
