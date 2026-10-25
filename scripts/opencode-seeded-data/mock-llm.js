// OpenAI-compatible chat completions server for the seeded-data probe. A
// request that offers the `write` tool and has no tool result yet gets one
// `write` call for MOCK_WRITE_PATH; every other request (the follow-up, title
// generation) gets the text "done". No network, no credentials.
const port = Number(process.env.MOCK_PORT ?? 4010);
const target = process.env.MOCK_WRITE_PATH;

const frame = (choices, extra = {}) =>
  `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "m", choices, ...extra })}\n\n`;
const delta = (value, finish = null) => frame([{ index: 0, delta: value, finish_reason: finish }]);
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

let calls = 0;
Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
      // Synthetic console account: exercise the real account/config lookup,
      // including its bearer token and selected organization, without billing.
      if (request.headers.get("authorization") !== "Bearer probe-access")
        return new Response("unauthorized", { status: 401 });
      if (path === "/api/orgs") return Response.json([{ id: "org_probe", name: "Probe" }]);
      if (path === "/api/config" && request.headers.get("x-org-id") === "org_probe") {
        await Bun.write(process.env.MOCK_CONSOLE_MARKER, "authenticated\n");
        return Response.json({
          config: JSON.parse(await Bun.file(process.env.MOCK_CONSOLE_CONFIG).text()),
        });
      }
      return new Response("not found", { status: 404 });
    }
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    const body = await request.json();
    calls += 1;
    const offersWrite = (body.tools ?? []).some((tool) => tool.function?.name === "write");
    const answered = (body.messages ?? []).some((message) => message.role === "tool");
    if (body.stream === false) {
      return Response.json({
        id: "mock",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [
          { index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" },
        ],
        usage,
      });
    }
    let events;
    if (offersWrite && !answered) {
      const call = {
        index: 0,
        id: `call_${calls}`,
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({ filePath: target, content: "written by the mock model\n" }),
        },
      };
      events = delta({ role: "assistant", tool_calls: [call] }) + delta({}, "tool_calls");
    } else {
      events = delta({ role: "assistant", content: "done" }) + delta({}, "stop");
    }
    events += frame([], { usage }) + "data: [DONE]\n\n";
    return new Response(events, { headers: { "content-type": "text/event-stream" } });
  },
});
