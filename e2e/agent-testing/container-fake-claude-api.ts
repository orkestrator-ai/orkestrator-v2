/**
 * QA stand-in for the Anthropic Messages API, run inside a disposable fixture
 * container on its loopback so the image's real `claude` CLI can take a turn
 * with no login and no billed request (todo 0020, task 2). The spec copies
 * this file into the container, starts it with the container's own `bun`, and
 * points Claude Code at it through `~/.claude/settings.json` `env`
 * (`ANTHROPIC_BASE_URL`, a fixture `ANTHROPIC_AUTH_TOKEN`).
 *
 *   bun container-fake-claude-api.ts --port 47123 [--reply-delay-ms 3000]
 *
 * `--reply-delay-ms` holds each reply back, so a turn lasts long enough for
 * its `working` state to be seen, as a real model's would. Without it the
 * whole turn can fit between two reads of a 1 s poll.
 * Every `POST /v1/messages` gets one text reply. A prompt asking for "the word
 * PONG and then A plus B" is answered `PONG <A+B>`, so the spec's answer check
 * still cannot match its own echoed input; anything else (title or topic
 * requests the CLI makes on the side) gets `PONG`. A request whose last user
 * message carries `REFUSE_QA_401` is refused with the 401 a wrong key gets,
 * so a turn can end on an API error (to-do 5160 task 4). It keeps no request
 * body and logs nothing. No imports: the file runs on its own inside the image.
 */

/** A prompt carrying this is refused as a wrong key would be. */
export const REFUSE_MARKER = "REFUSE_QA_401";

type ContentBlock = { type?: string; text?: string };
type MessageBody = {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role?: string; content?: string | ContentBlock[] }>;
};

/** The text of the last user message, or "" if there is none. */
function lastUserText(body: MessageBody): string {
  const user = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return (user.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** The fixture's reply to a Messages request. */
export function fakeReply(body: MessageBody): string {
  const sums = [...lastUserText(body).matchAll(/PONG and then (\d+) plus (\d+)/g)];
  const sum = sums.at(-1);
  return sum ? `PONG ${Number(sum[1]) + Number(sum[2])}` : "PONG";
}

function message(id: string, model: string, text: string) {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: text ? [{ type: "text", text }] : [],
    stop_reason: text ? "end_turn" : null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: text ? 2 : 1 },
  };
}

/** The server-sent event stream the API answers `stream: true` with. */
export function messageStream(id: string, model: string, text: string): string {
  const frames: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: message(id, model, "") }],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

export async function handleFakeClaudeApi(request: Request, replyDelayMs = 0): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    return Response.json({ input_tokens: 1 });
  }
  if (request.method !== "POST" || url.pathname !== "/v1/messages") {
    return Response.json(
      { type: "error", error: { type: "not_found_error", message: "fixture" } },
      { status: 404 },
    );
  }
  const body = (await request.json().catch(() => ({}))) as MessageBody;
  if (lastUserText(body).includes(REFUSE_MARKER)) {
    return Response.json(
      { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
      { status: 401 },
    );
  }
  const model = body.model ?? "claude-fixture";
  const id = `msg_fixture_${crypto.randomUUID().replaceAll("-", "")}`;
  const text = fakeReply(body);
  if (replyDelayMs > 0) await Bun.sleep(replyDelayMs);
  if (!body.stream) return Response.json(message(id, model, text));
  return new Response(messageStream(id, model, text), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

if (import.meta.main) {
  const index = process.argv.indexOf("--port");
  const port = Number(index === -1 ? NaN : process.argv[index + 1]);
  if (!Number.isInteger(port) || port <= 0) throw new Error("--port is required");
  const delayIndex = process.argv.indexOf("--reply-delay-ms");
  const replyDelayMs = delayIndex === -1 ? 0 : Number(process.argv[delayIndex + 1]);
  if (!Number.isFinite(replyDelayMs) || replyDelayMs < 0) {
    throw new Error("--reply-delay-ms must be a non-negative number");
  }
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    fetch: (request) => handleFakeClaudeApi(request, replyDelayMs),
  });
}
