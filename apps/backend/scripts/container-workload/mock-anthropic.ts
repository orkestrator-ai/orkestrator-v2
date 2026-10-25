/**
 * A local stand-in for the Anthropic Messages API, so a real Claude Code CLI
 * can run a full agent turn inside the container without credentials: each
 * conversation gets TOOL_STEPS tool calls (Bash and Read, run for real by the
 * CLI) and then a short text answer. Responses are synthetic; the process
 * cost of the CLI, its tools and its streaming is real. Listens on loopback
 * only and logs nothing but a request count on exit.
 */
const PORT = Number(process.env.MOCK_PORT || 8787);
const TOOL_STEPS = Number(process.env.TOOL_STEPS || 4);
/** Model latency per response, so concurrent CLIs overlap as real turns do. */
const LATENCY_MS = Number(process.env.MOCK_LATENCY_MS || 1000);
let requests = 0;

type Block = { type: string };
type Message = { role: string; content: string | Block[] };

const STEPS = [
  { name: "Bash", input: { command: "ls -la /tmp/w && uname -a", description: "List files" } },
  { name: "Read", input: { file_path: "/tmp/w/sampler.sh" } },
  {
    name: "Bash",
    input: {
      command:
        "find /usr/local/share/npm-global/lib/node_modules -name '*.json' | head -2000 | wc -l",
      description: "Count files",
    },
  },
  { name: "Read", input: { file_path: "/tmp/w/browser.cjs" } },
];

function toolResults(messages: Message[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    count += message.content.filter((block) => block.type === "tool_result").length;
  }
  return count;
}

function sse(events: Array<[string, unknown]>): string {
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

function respond(model: string, step: number, hasTools: boolean, stream: boolean): Response {
  const id = `msg_${requests}`;
  const tool = hasTools && step < Math.min(TOOL_STEPS, STEPS.length) ? STEPS[step]! : null;
  const text = "Done. ".repeat(40);
  const usage = { input_tokens: 1200, output_tokens: 80 };
  if (!stream) {
    return Response.json({
      id,
      type: "message",
      role: "assistant",
      model,
      content: tool
        ? [{ type: "tool_use", id: `toolu_${requests}`, name: tool.name, input: tool.input }]
        : [{ type: "text", text }],
      stop_reason: tool ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage,
    });
  }
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...usage, output_tokens: 1 },
        },
      },
    ],
  ];
  if (tool) {
    events.push(
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: `toolu_${requests}`, name: tool.name, input: {} },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
        },
      ],
    );
  } else {
    events.push([
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ]);
    for (let index = 0; index < 20; index += 1) {
      events.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: text.slice(index * 12, index * 12 + 12) },
        },
      ]);
    }
  }
  events.push(
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 80 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  );
  return new Response(sse(events), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST") return Response.json({});
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 1200 });
    if (!url.pathname.endsWith("/v1/messages")) return Response.json({});
    requests += 1;
    await Bun.sleep(LATENCY_MS);
    const body = (await request.json()) as {
      model?: string;
      stream?: boolean;
      tools?: unknown[];
      messages?: Message[];
    };
    return respond(
      body.model ?? "claude-sonnet-5-5",
      toolResults(body.messages ?? []),
      Array.isArray(body.tools) && body.tools.length > 0,
      body.stream === true,
    );
  },
});

process.on("SIGTERM", () => {
  process.stdout.write(`${JSON.stringify({ mockRequests: requests })}\n`);
  process.exit(0);
});
