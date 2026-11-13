/**
 * A scripted loopback Anthropic Messages endpoint for the inactive-path steer
 * spec's Claude case (`browser-gateway.spec.ts`, "queued native steering
 * survives a lost gateway response, inactive environment and reload"; todo
 * 0005 task 7). The profile's real Claude CLI, bridge and backend take the
 * turn; only the model is this file. No login, nothing billed.
 *
 * It plays the spec's two prompts the way a compliant model would:
 *
 * 1. The first prompt asks for `.qa-queued-ready` and then a wait until
 *    steered. Its first call writes the file and sleeps briefly; every later
 *    call sleeps again, so the turn keeps running (and the spec's second
 *    queued prompt stays queued) for as long as the spec needs.
 * 2. The steered prompt ("Append exactly <marker> once to
 *    .qa-queued-received") may reach the model anywhere in the conversation:
 *    the bridge sends it with `priority: "now"`, and the CLI places it where
 *    its own version puts mid-turn input. So every user text in the request
 *    is searched, and the append is made once: once a call in the
 *    conversation has appended, the model goes back to sleeping.
 *
 * A request that offers no `Bash` tool (a title or summary request), or does
 * not belong to the spec's conversation, gets a short text reply. A
 * conversation that has made {@link MAX_TOOL_CALLS} calls ends with text, so
 * a forgotten turn cannot loop forever.
 *
 *   bun steer-inactive-fake-claude.ts [--port 0]
 *
 * prints its origin (`http://127.0.0.1:<port>`) as the first stdout line. It
 * keeps no request body and logs nothing else.
 */
import { createServer, type IncomingMessage } from "node:http";
import { streamFrames } from "./idle-observation-fake-claude";

/** What the spec's first prompt names, and only it does. */
export const READY_FILE = ".qa-queued-ready";
/** Where the steered prompt asks for its marker. */
export const RECEIVED_FILE = ".qa-queued-received";
/** Seconds each waiting call sleeps: short, so a steer is taken up quickly. */
export const SLEEP_SECONDS = 3;
/** About ten minutes of waiting calls, well past the spec's own budget. */
export const MAX_TOOL_CALLS = 200;

const STEER_PATTERN = /Append exactly ([A-Za-z0-9-]{1,80}) once to \.qa-queued-received/;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

type Block = {
  type?: string;
  text?: string;
  name?: string;
  input?: { command?: unknown };
  content?: unknown;
};
type Message = { role?: string; content?: string | Block[] };
export type MessagesBody = {
  model?: string;
  stream?: boolean;
  messages?: Message[];
  tools?: Array<{ name?: string }>;
};

export type SteerStep =
  { kind: "text"; text: string } | { kind: "shell"; command: string; description: string };

/** Every text a user message carries, tool results and reminders included. */
function userTexts(messages: Message[]): string[] {
  const texts: string[] = [];
  const collect = (content: unknown) => {
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content as Block[]) {
        if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
        else if (block?.type === "tool_result") collect(block.content);
      }
    }
  };
  for (const message of messages) if (message.role === "user") collect(message.content);
  return texts;
}

/** The shell commands the model already asked for in this conversation. */
function commandsSoFar(messages: Message[]): string[] {
  return messages
    .filter((message) => message.role === "assistant" && Array.isArray(message.content))
    .flatMap((message) => message.content as Block[])
    .filter((block) => block?.type === "tool_use" && block.name === "Bash")
    .map((block) => (typeof block.input?.command === "string" ? block.input.command : ""));
}

/** The next step for one Messages request. */
export function steerStep(body: MessagesBody): SteerStep {
  const messages = body.messages ?? [];
  const offered = new Set((body.tools ?? []).map((tool) => tool.name));
  const texts = userTexts(messages);
  if (!offered.has("Bash") || !texts.some((text) => text.includes(READY_FILE))) {
    return { kind: "text", text: "Done." };
  }
  const commands = commandsSoFar(messages);
  if (commands.length >= MAX_TOOL_CALLS) return { kind: "text", text: "Stopped waiting." };
  const marker = texts.map((text) => STEER_PATTERN.exec(text)?.[1]).find(Boolean);
  if (marker && !commands.some((command) => command.includes(RECEIVED_FILE))) {
    return {
      kind: "shell",
      command: `printf '%s' '${marker}' >> ${RECEIVED_FILE}`,
      description: "Append the marker",
    };
  }
  if (!commands.some((command) => command.includes(READY_FILE))) {
    return {
      kind: "shell",
      command: `printf ready > ${READY_FILE} && sleep ${SLEEP_SECONDS}`,
      description: "Write the ready file and wait",
    };
  }
  return { kind: "shell", command: `sleep ${SLEEP_SECONDS}`, description: "Wait" };
}

/** The response content for one request. */
export function steerResponseContent(
  body: MessagesBody,
  id: number,
): Array<Record<string, unknown>> {
  const step = steerStep(body);
  if (step.kind === "text") return [{ type: "text", text: step.text }];
  return [
    {
      type: "tool_use",
      id: `toolu_steerqa_${id}`,
      name: "Bash",
      input: { command: step.command, description: step.description },
    },
  ];
}

async function readBody(request: IncomingMessage): Promise<MessagesBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as MessagesBody) : {};
}

function serve(port: number): void {
  let counter = 0;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fake").pathname;
    try {
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      const body = await readBody(request);
      if (pathname.endsWith("/count_tokens")) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      if (!pathname.endsWith("/messages")) {
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      counter += 1;
      const id = `msg_steerqa_${counter}`;
      const model = String(body.model ?? "claude-haiku-4-5");
      const content = steerResponseContent(body, counter);
      if (body.stream === true) {
        response
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(streamFrames(id, model, content));
        return;
      }
      const toolCall = content.some((block) => block.type === "tool_use");
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id,
          type: "message",
          role: "assistant",
          model,
          content,
          stop_reason: toolCall ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    } catch {
      if (!response.headersSent) response.writeHead(400).end();
      else response.end();
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const bound = typeof address === "object" && address ? address.port : port;
    console.log(`http://127.0.0.1:${bound}`);
  });
}

if ((import.meta as { main?: boolean }).main) {
  const index = process.argv.indexOf("--port");
  const port = index >= 0 ? Number(process.argv[index + 1]) : 0;
  serve(Number.isSafeInteger(port) && port >= 0 ? port : 0);
}
