/**
 * A scripted loopback Anthropic Messages endpoint for
 * `idle-observation-live.spec.ts` (todo 0049 tasks 1, 2, 9 and 10), so the
 * real pinned Claude CLI and bridge take real turns with no login and nothing
 * billed.
 *
 * It answers the spec's own prompts the way a compliant model would
 * (`scriptedStep`): "reply with exactly W" replies W, "the uppercase form of
 * this text: w" replies W, "run this shell command and wait" (or "run this
 * exact shell command once", the approval case) calls `Bash` and replies once
 * the result is back, "start this shell command as a background task" calls
 * `Bash` with `run_in_background`, and "use your sub-agent" delegates a child
 * reply to the `Agent` tool. Anything else (a title request, a task
 * notification) gets a short reply.
 *
 *   bun idle-observation-fake-claude.ts [--port 0] [--reply-delay-ms 0]
 *
 * prints its origin (`http://127.0.0.1:<port>`) as the first stdout line.
 * Self-contained, `node:http` only, so the spec can copy this one file into a
 * container and start it with the image's own `bun`. It keeps no request
 * body and logs nothing else.
 */
import { createServer, type IncomingMessage } from "node:http";

export type ScriptedStep =
  | { kind: "text"; text: string }
  | { kind: "shell"; command: string; background: boolean }
  /** Delegate `task` (a whole prompt for the child) to a sub-agent. */
  | { kind: "subagent"; task: string }
  /** Ask one question without waiting for the answer (Codex's async question). */
  | { kind: "question"; title: string; options: string[] };

/** The reply to an answered async question (`serializeAsyncQuestionAnswers`). */
export const CODEWORD_REPLY_PREFIX = "CODEWORD_CHOSEN=";
/** Without a sub-agent tool the spec's prompt asks for this reply. */
export const NO_SUBAGENT_REPLY = "NO-SUBAGENT-TOOL";

type Block = { type?: string; text?: string };
type Message = { role?: string; content?: string | Block[] };
type MessagesBody = {
  model?: string;
  stream?: boolean;
  messages?: Message[];
  tools?: Array<{ name?: string }>;
};

const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** What the reply of a prompt is, once any command it asked for has run. */
export function finalReply(prompt: string): string {
  // The web card sends "Answers to your questions:" then "- <title>: <answer>".
  const answered = /^Answers to your questions:[\s\S]*?\?: (\S+)\s*$/m.exec(prompt)?.[1];
  if (answered) return `${CODEWORD_REPLY_PREFIX}${answered}`;
  const exact = /reply with exactly (\S+?) and nothing else/i.exec(prompt)?.[1];
  if (exact) return exact;
  const upper = /uppercase form of this text and nothing else: (\S+?)\.(?:\s|$)/i.exec(prompt)?.[1];
  if (upper) return upper.toUpperCase();
  return "Done.";
}

/**
 * The next step for the spec's prompt. `afterTool` is true once a command it
 * asked for has returned, which always ends the turn with the final reply.
 */
export function scriptedStep(prompt: string, afterTool: boolean): ScriptedStep {
  if (afterTool) return { kind: "text", text: finalReply(prompt) };
  const child =
    /use your sub-agent or task delegation tool[\s\S]*?give it this task: reply with the text (\S+?)\./i.exec(
      prompt,
    )?.[1];
  if (child) {
    return {
      kind: "subagent",
      task: `Reply with exactly ${child} and nothing else. Do not use any tools.`,
    };
  }
  const question = /ask me one question, "([^"]+)", with the options (\S+) and (\S+?)\./i.exec(
    prompt,
  );
  if (question) {
    return { kind: "question", title: question[1]!, options: [question[2]!, question[3]!] };
  }
  const approval = /run this exact shell command once: ([^\n]+)/i.exec(prompt)?.[1];
  if (approval) return { kind: "shell", command: approval.trim(), background: false };
  const background = /as a background task and do not wait for it: ([\s\S]+?) Right after/i.exec(
    prompt,
  )?.[1];
  if (background) return { kind: "shell", command: background.trim(), background: true };
  const sleepThenPrint = /sleeps for (\d+) seconds, then prints (\S+?)\.(?:\s|$)/i.exec(prompt);
  if (sleepThenPrint) {
    return {
      kind: "shell",
      command: `sleep ${sleepThenPrint[1]}; echo ${sleepThenPrint[2]}`,
      background: false,
    };
  }
  const waitFor = /run this shell command and wait for it: ([^\n]+)/i.exec(prompt)?.[1];
  if (waitFor) return { kind: "shell", command: waitFor.trim(), background: false };
  if (/<task-notification>/i.test(prompt)) return { kind: "text", text: "Noted." };
  return { kind: "text", text: finalReply(prompt) };
}

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function withoutReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

/**
 * The prompt a Messages request is answering and whether its last user
 * message returns a tool result. Only a tool result looks back past the last
 * user message, to the prompt that asked for the command. Anything else
 * answers that last message alone: a task notification the CLI sends on its
 * own (often inside a reminder block) must never re-run an earlier prompt.
 */
export function requestState(body: MessagesBody): { prompt: string; afterTool: boolean } {
  const users = (body.messages ?? []).filter((message) => message.role === "user");
  const last = users.at(-1);
  const afterTool =
    Array.isArray(last?.content) && last.content.some((block) => block.type === "tool_result");
  if (!afterTool) {
    const raw = textOf(last?.content);
    return { prompt: withoutReminders(raw) || raw.trim(), afterTool };
  }
  for (let index = users.length - 1; index >= 0; index -= 1) {
    const content = users[index]!.content;
    if (Array.isArray(content) && content.some((block) => block.type === "tool_result")) continue;
    const text = withoutReminders(textOf(content));
    if (text) return { prompt: text, afterTool };
  }
  return { prompt: "", afterTool };
}

/** The response content for one request: a tool call only when `Bash` is offered. */
export function responseContent(body: MessagesBody, id: number): Array<Record<string, unknown>> {
  const { prompt, afterTool } = requestState(body);
  let step = scriptedStep(prompt, afterTool);
  const offered = new Set((body.tools ?? []).map((tool) => tool.name));
  if (step.kind === "shell" && !offered.has("Bash")) {
    step = { kind: "text", text: finalReply(prompt) };
  }
  // The CLI names its delegation tool `Agent` (formerly `Task`).
  const agentTool = offered.has("Agent") ? "Agent" : offered.has("Task") ? "Task" : null;
  if (step.kind === "subagent" && !agentTool) step = { kind: "text", text: NO_SUBAGENT_REPLY };
  // Claude has no async question; this script asks one only of Codex.
  if (step.kind === "question") step = { kind: "text", text: finalReply(prompt) };
  if (step.kind === "text") return [{ type: "text", text: step.text }];
  if (step.kind === "subagent") {
    return [
      {
        type: "tool_use",
        id: `toolu_idleqa_${id}`,
        name: agentTool,
        input: {
          description: "Child reply",
          prompt: step.task,
          subagent_type: "general-purpose",
        },
      },
    ];
  }
  return [
    {
      type: "tool_use",
      id: `toolu_idleqa_${id}`,
      name: "Bash",
      input: {
        command: step.command,
        description: step.background ? "Start the background command" : "Run the command",
        ...(step.background ? { run_in_background: true } : {}),
      },
    },
  ];
}

/** The server-sent events the Messages API streams for `content`. */
export function streamFrames(
  id: string,
  model: string,
  content: Array<Record<string, unknown>>,
): string {
  const toolCall = content.some((block) => block.type === "tool_use");
  const events: Array<{ type: string } & Record<string, unknown>> = [
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
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
  content.forEach((block, index) => {
    if (block.type === "tool_use") {
      events.push(
        { type: "content_block_start", index, content_block: { ...block, input: {} } },
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        },
      );
    } else {
      events.push(
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
      );
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: toolCall ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  );
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
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

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function serve(port: number, replyDelayMs: number): void {
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
      const id = `msg_idleqa_${counter}`;
      const model = String(body.model ?? "claude-haiku-4-5");
      const content = responseContent(body, counter);
      if (replyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, replyDelayMs));
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
  serve(argument("--port", 0), argument("--reply-delay-ms", 0));
}
