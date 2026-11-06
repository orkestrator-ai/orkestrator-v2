import { describe, expect, test } from "bun:test";
import {
  callFor,
  FAKE_TOOL_NAME,
  FAKE_WORKFLOW_RESULTS,
  scriptOf,
  startFakeModelServer,
} from "../../scripts/recurring-live-ab-fake-model";
import { nativeWebPlatform } from "../register-dom";

// The root preload installs Happy DOM's fetch and Response; a loopback server
// needs Bun's own.
const fetch = nativeWebPlatform.fetch;

const user = (content: unknown) => ({ role: "user", content });

describe("fake model scripts", () => {
  test("reads markers from the latest user prompt only, in string or part form", () => {
    expect(scriptOf([user("[hold:a1] earlier"), user("now [tool:b2]")])).toMatchObject({
      hold: null,
      tool: "b2",
      afterToolResult: false,
      workflow: null,
      toolResults: 0,
    });
    expect(scriptOf([user([{ type: "text", text: "x [hold:h-1]" }])]).hold).toBe("h-1");
    expect(
      scriptOf([user("[tool:t1]"), { role: "assistant", content: null }, { role: "tool" }]),
    ).toMatchObject({ hold: null, tool: "t1", afterToolResult: true, toolResults: 1 });
    // Upper case, long or punctuated ids are not driver tokens.
    expect(scriptOf([user("[hold:ABC] [tool:a;b]")])).toMatchObject({
      hold: null,
      tool: null,
      afterToolResult: false,
    });
    expect(scriptOf("not a list").hold).toBeNull();
  });

  test("holds a marked request until it is released, and counts it by id", async () => {
    const server = startFakeModelServer({ Response: nativeWebPlatform.Response });
    try {
      let answered = false;
      const held = fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ stream: true, messages: [user("go [hold:q1]")] }),
      }).then(async (response) => {
        answered = true;
        return response.text();
      });
      for (let tries = 0; !server.marker("q1") && tries < 100; tries += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(answered).toBe(false);
      expect(server.marker("q1")).toMatchObject({ requests: 1, toolResults: 0 });
      server.release("q1");
      expect(await held).toContain('"finish_reason":"stop"');
      // A released id answers later requests at once.
      const again = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ messages: [user("again [hold:q1]")] }),
      });
      expect(again.status).toBe(200);
      expect(server.marker("q1")?.requests).toBe(2);
      expect(server.marker("other")).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test("stopping the server answers every parked request", async () => {
    const server = startFakeModelServer({ Response: nativeWebPlatform.Response });
    const held = fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [user("[hold:never]")] }),
    }).catch(() => null);
    for (let tries = 0; !server.marker("never") && tries < 100; tries += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await server.stop();
    await held;
    expect(server.marker("never")?.requests).toBe(1);
  });

  test("answers a tool marker with one bash call, then replies after its result", async () => {
    const server = startFakeModelServer({ Response: nativeWebPlatform.Response });
    try {
      const first = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ stream: true, messages: [user("[tool:ap1]")] }),
      });
      const streamed = await first.text();
      expect(streamed).toContain(`"name":"${FAKE_TOOL_NAME}"`);
      expect(streamed).toContain(String.raw`\"command\":\"printf ap1\"`);
      expect(streamed).toContain('"finish_reason":"tool_calls"');
      const second = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          messages: [user("[tool:ap1]"), { role: "assistant" }, { role: "tool", content: "ap1" }],
        }),
      });
      const reply = (await second.json()) as {
        choices: Array<{ message: { content: string }; finish_reason: string }>;
      };
      expect(reply.choices[0]).toMatchObject({
        message: { content: "Soak reply." },
        finish_reason: "stop",
      });
      expect(server.marker("ap1")).toMatchObject({ requests: 2, toolResults: 1 });
    } finally {
      await server.stop();
    }
  });

  test("scripts a Multi Review slot: reads HEAD for a plan, submits, then replies", () => {
    const key = "bd4b4da6-1298-4227-b522-b897c6796961";
    const prompt = user(`Submit it: call \`submit_validation_plan\` with resultKey "${key}".`);
    const tools = [
      { type: "function", function: { name: "bash" } },
      { type: "function", function: { name: "submit_validation_plan" } },
    ];
    const first = scriptOf([prompt], tools);
    expect(first.workflow).toEqual({ tool: "submit_validation_plan", resultKey: key });
    expect(callFor(first, "c1")?.function).toEqual({
      name: FAKE_TOOL_NAME,
      arguments: JSON.stringify({ command: "git rev-parse HEAD" }),
    });
    const head = "a".repeat(40);
    const second = scriptOf(
      [prompt, { role: "assistant" }, { role: "tool", content: `${head}\n` }],
      tools,
    );
    expect(second.sha).toBe(head);
    const submitted = callFor(second, "c2")!;
    expect(submitted.function.name).toBe("submit_validation_plan");
    const input = JSON.parse(submitted.function.arguments) as {
      resultKey: string;
      result: { headRef: string; commands: unknown[] };
    };
    expect(input.resultKey).toBe(key);
    expect(input.result.headRef).toBe(head);
    expect(input.result.commands).toHaveLength(1);
    const third = scriptOf(
      [
        prompt,
        { role: "assistant" },
        { role: "tool", content: head },
        { role: "assistant" },
        { role: "tool", content: "accepted" },
      ],
      tools,
    );
    expect(callFor(third, "c3")).toBeNull();
    // A report submits at once; a prompt with no result key or no offered tool is not a workflow.
    const report = scriptOf(
      [user(`resultKey "${key}"`)],
      [{ function: { name: "submit_review_report" } }],
    );
    expect(JSON.parse(callFor(report, "c4")!.function.arguments)).toEqual({
      resultKey: key,
      result: FAKE_WORKFLOW_RESULTS.submit_review_report,
    });
    expect(scriptOf([user("no key here")], tools).workflow).toBeNull();
    expect(
      scriptOf([user(`resultKey "${key}"`)], [{ function: { name: "bash" } }]).workflow,
    ).toBeNull();
  });

  test("counts a workflow call and the result that came back, by tool", async () => {
    const server = startFakeModelServer({ Response: nativeWebPlatform.Response });
    try {
      const key = "bd4b4da6-1298-4227-b522-b897c6796961";
      const body = (messages: unknown[]) =>
        JSON.stringify({ messages, tools: [{ function: { name: "submit_review_report" } }] });
      const prompt = user(`resultKey "${key}"`);
      const call = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        body: body([prompt]),
      });
      expect(
        ((await call.json()) as { choices: Array<{ finish_reason: string }> }).choices[0]
          ?.finish_reason,
      ).toBe("tool_calls");
      await (
        await fetch(`${server.baseUrl}/chat/completions`, {
          method: "POST",
          body: body([prompt, { role: "assistant" }, { role: "tool", content: "ok" }]),
        })
      ).text();
      const counted = server.workflow().submit_review_report;
      expect(counted?.calls).toBe(1);
      expect(counted?.resultsAt).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});
