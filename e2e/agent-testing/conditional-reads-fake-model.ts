/**
 * A loopback Anthropic Messages endpoint for the E10 baseline
 * (`conditional-reads-live.spec.ts`). The profile's real Claude CLI is pointed
 * at it, so a real turn streams through the real bridge with no provider and
 * nothing billed.
 *
 * A conversation turn (a request with tools whose user text holds the marker)
 * streams filler text for `responseMs` and then calls a read-only tool, so the
 * CLI answers with the tool result and asks again: each round is a new model
 * response, a new transcript row. After `rounds` rounds the turn ends. Any
 * other call (a title, a token count, a warm-up) is answered at once.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface FakeModelOptions {
  marker: string;
  rounds: number;
  responseMs: number;
  deltaMs: number;
  deltaChars: number;
}

export interface FakeModel {
  origin: string;
  conversationCalls(): number;
  /** Characters streamed so far in conversation responses. */
  streamedChars(): number;
  stop(): Promise<void>;
}

type Block = { type?: string; text?: string };
type Message = { role?: string; content?: string | Block[] };
type MessagesBody = { messages?: Message[]; tools?: Array<{ name?: string }>; stream?: boolean };

const FILLER =
  "The quick brown fox jumps over the lazy dog while the baseline streams steadily onward. ";

function userTexts(body: MessagesBody): string[] {
  const texts: string[] = [];
  for (const message of body.messages ?? []) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") texts.push(message.content);
    else for (const block of message.content ?? []) if (block.text) texts.push(block.text);
  }
  return texts;
}

function toolResults(body: MessagesBody): number {
  let count = 0;
  for (const message of body.messages ?? []) {
    if (Array.isArray(message.content))
      count += message.content.filter((block) => block.type === "tool_result").length;
  }
  return count;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function event(response: ServerResponse, value: { type: string } & Record<string, unknown>) {
  response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}

async function readBody(request: IncomingMessage): Promise<MessagesBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as MessagesBody;
  } catch {
    return {};
  }
}

function quickReply(response: ServerResponse, stream: boolean, id: number) {
  const message = {
    id: `msg_quick_${id}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "Baseline." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  event(response, {
    type: "message_start",
    message: { ...message, content: [], stop_reason: null },
  });
  event(response, {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  event(response, {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Baseline." },
  });
  event(response, { type: "content_block_stop", index: 0 });
  event(response, {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  event(response, { type: "message_stop" });
  response.end();
}

async function streamRound(
  response: ServerResponse,
  options: FakeModelOptions,
  body: MessagesBody,
  id: number,
  onStreamed: (chars: number) => void,
) {
  const round = toolResults(body);
  const tool = (body.tools ?? []).map((entry) => entry.name).find((name) => name === "Glob");
  const callTool = round < options.rounds - 1 && tool !== undefined;
  response.writeHead(200, { "content-type": "text/event-stream" });
  event(response, {
    type: "message_start",
    message: {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  event(response, {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  const deadline = Date.now() + options.responseMs;
  let offset = 0;
  while (Date.now() < deadline && !response.destroyed) {
    let text = "";
    while (text.length < options.deltaChars) {
      text += FILLER.slice(offset % FILLER.length, (offset % FILLER.length) + options.deltaChars);
      offset += options.deltaChars;
    }
    event(response, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(0, options.deltaChars) },
    });
    onStreamed(options.deltaChars);
    await sleep(options.deltaMs);
  }
  event(response, { type: "content_block_stop", index: 0 });
  if (callTool) {
    event(response, {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: `toolu_${id}`, name: tool, input: {} },
    });
    event(response, {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ pattern: "*.md" }) },
    });
    event(response, { type: "content_block_stop", index: 1 });
  }
  event(response, {
    type: "message_delta",
    delta: { stop_reason: callTool ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 100 },
  });
  event(response, { type: "message_stop" });
  response.end();
}

export async function startFakeModel(options: FakeModelOptions): Promise<FakeModel> {
  let sequence = 0;
  let conversation = 0;
  let streamed = 0;
  const server = createServer((request, response) => {
    void (async () => {
      sequence += 1;
      const url = new URL(request.url ?? "/", "http://fake.invalid");
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [], models: [] }));
        return;
      }
      const body = await readBody(request);
      if (!url.pathname.endsWith("/messages")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const isConversation =
        (body.tools?.length ?? 0) > 0 &&
        userTexts(body).some((text) => text.includes(options.marker));
      if (!isConversation) {
        quickReply(response, body.stream === true, sequence);
        return;
      }
      conversation += 1;
      await streamRound(response, options, body, sequence, (chars) => (streamed += chars));
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake model has no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    conversationCalls: () => conversation,
    streamedChars: () => streamed,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
