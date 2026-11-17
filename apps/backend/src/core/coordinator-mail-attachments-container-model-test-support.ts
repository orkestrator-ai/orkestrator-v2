/**
 * A scripted Anthropic Messages endpoint that runs inside a container, on its
 * own loopback, so the image's real `claude` CLI can open a mailed image with
 * its `Read` tool without a login or a billed request
 * (`coordinator-mail-attachments-docker-read-live.test.ts`,
 * from to-do 4420 (retired) task 3).
 *
 *   bun coordinator-mail-attachments-container-model-test-support.ts --port 47420 --record /tmp/model.json
 *
 * The test copies this file into the container and starts it with the image's
 * own `bun`. It imports nothing, so it runs there on its own.
 *
 * The script reads each request, not a fixed turn list:
 * - a request carrying the result of the `open_image` call is answered `Seen.`
 *   and the image content that came back is recorded;
 * - otherwise a request whose user text holds an agent-mail carrier naming an
 *   attachment asks for `Read` on that path, which the model took from the
 *   prompt the CLI actually sent it;
 * - anything else gets `No path in the message.`
 *
 * After every model call the record file is rewritten with the call count,
 * the path asked for and the base64 image blocks returned. It holds no prompt
 * text, only a path and a 4x4 test image, and each field is bounded.
 */

type Block = {
  type?: string;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  source?: { type?: string; media_type?: string; data?: string };
};
type MessagesRequest = {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role?: string; content?: string | Block[] }>;
};
type Reply =
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "text"; text: string };

/** The tool call id the script uses, so the result can be found again. */
export const OPEN_IMAGE_CALL = "open_image";
const MAX_RECORDED_IMAGES = 4;
const MAX_IMAGE_BASE64 = 64 * 1024;

export type ModelRecord = {
  /** Model calls the CLI made to `/v1/messages`. */
  calls: number;
  /** The attachment path found in the prompt, if any. */
  asked: string | null;
  /** Base64 image blocks the CLI returned for `open_image`. */
  images: string[];
};

function blocksOf(request: MessagesRequest, role: string): Block[] {
  return (request.messages ?? [])
    .filter((message) => message.role === role)
    .flatMap((message) =>
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content ?? []),
    );
}

/** The first attachment path named in an agent-mail carrier in `text`. */
export function mailedPath(text: string): string | undefined {
  const match = text.match(
    /<orkestrator-peer-payload-json>\n([\s\S]*?)\n<\/orkestrator-peer-payload-json>/,
  );
  if (!match) return undefined;
  try {
    const payload = JSON.parse(match[1]!) as { attachments?: Array<{ path?: unknown }> };
    const found = payload.attachments?.[0]?.path;
    return typeof found === "string" ? found : undefined;
  } catch {
    return undefined;
  }
}

/** Image blocks returned as the result of `open_image`, or undefined when there is none. */
export function returnedImages(request: MessagesRequest): string[] | undefined {
  const result = blocksOf(request, "user").find(
    (block) => block.type === "tool_result" && block.tool_use_id === OPEN_IMAGE_CALL,
  );
  if (!result) return undefined;
  const content = Array.isArray(result.content) ? (result.content as Block[]) : [];
  return content
    .filter((block) => block.type === "image")
    .map((block) => block.source?.data ?? "")
    .slice(0, MAX_RECORDED_IMAGES)
    .map((data) => data.slice(0, MAX_IMAGE_BASE64));
}

/** What the script answers to one request, updating `record`. */
export function scriptedReply(request: MessagesRequest, record: ModelRecord): Reply[] {
  record.calls += 1;
  const images = returnedImages(request);
  if (images) {
    record.images = images;
    return [{ type: "text", text: "Seen." }];
  }
  const text = blocksOf(request, "user")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  const asked = mailedPath(text);
  if (!asked) return [{ type: "text", text: "No path in the message." }];
  record.asked = asked;
  return [{ type: "tool_use", id: OPEN_IMAGE_CALL, name: "Read", input: { file_path: asked } }];
}

/** The Messages API answer, as JSON or as the event stream `stream: true` asks for. */
export function messagesResponse(request: MessagesRequest, content: Reply[], id: string): Response {
  const toolTurn = content.some((block) => block.type === "tool_use");
  const message = {
    id,
    type: "message",
    role: "assistant",
    model: request.model ?? "claude-fixture",
    content,
    stop_reason: toolTurn ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (!request.stream) return Response.json(message);
  const events: Array<{ type: string } & Record<string, unknown>> = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
  ];
  for (const [index, block] of content.entries()) {
    events.push({
      type: "content_block_start",
      index,
      content_block:
        block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta:
        block.type === "tool_use"
          ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          : { type: "text_delta", text: block.text },
    });
    events.push({ type: "content_block_stop", index });
  }
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  );
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
  );
}

if (import.meta.main) {
  const flag = (name: string) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const port = Number(flag("--port"));
  const recordPath = flag("--record");
  if (!Number.isInteger(port) || port <= 0) throw new Error("--port is required");
  if (!recordPath) throw new Error("--record is required");
  const record: ModelRecord = { calls: 0, asked: null, images: [] };
  await Bun.write(recordPath, JSON.stringify(record));
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens")
        return Response.json({ input_tokens: 1 });
      if (request.method !== "POST" || url.pathname !== "/v1/messages")
        return Response.json(
          { type: "error", error: { type: "not_found_error", message: "fixture" } },
          { status: 404 },
        );
      const body = (await request.json().catch(() => ({}))) as MessagesRequest;
      const content = scriptedReply(body, record);
      await Bun.write(recordPath, JSON.stringify(record));
      return messagesResponse(body, content, `msg_fixture_${record.calls}`);
    },
  });
}
