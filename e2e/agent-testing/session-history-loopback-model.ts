/**
 * A loopback model for `session-history-live.spec.ts`, so the profile's real
 * Codex app-server and real Pi SDK can run fork and rewind turns with no login
 * and no billed turn. Run with Bun (specs run under Node, which has no
 * WebSocket server): `bun session-history-loopback-model.ts`.
 *
 * It serves two wire formats on one loopback port:
 *
 * - OpenAI's Responses WebSocket (`response.create` frames), which Codex uses
 *   when its `openai_base_url` points here. A frame may continue an earlier
 *   response by `previous_response_id`; the context is then that response's
 *   context plus the new input.
 * - OpenAI chat completions (`POST …/chat/completions`), which Pi uses for a
 *   provider declared with `api: "openai-completions"` in its `models.json`.
 *
 * Prompts carry markers (`HX<digits>`). Each sampled call answers
 * `Acknowledged <last marker>.` and records only the markers its user messages
 * held, in order. That is the vendor's view of the conversation after a fork or
 * a rewind: the call after a rewind must not see a dropped turn's marker.
 * `GET /__calls` returns the records; nothing else (no prompt, header or body)
 * is kept or printed. It prints its base URL on the first stdout line.
 */
const MARKER = /\bHX\d+\b/g;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_CALLS = 1_000;
const MAX_RESPONSES = 1_000;

type Call = { api: "responses" | "chat"; markers: string[] };
const calls: Call[] = [];
/** Context (user markers so far) by Responses id, for `previous_response_id`. */
const contexts = new Map<string, string[]>();

function record(call: Call): void {
  calls.push(call);
  if (calls.length > MAX_CALLS) calls.shift();
}

function markersOf(text: string): string[] {
  return [...text.matchAll(MARKER)].map((match) => match[0]);
}

/** Text of one message's content, string or block list, of any block type that holds text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("\n");
}

/** Markers in the user messages of a Responses `input` or a chat `messages` list. */
function userMarkers(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const markers: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role === "user") markers.push(...markersOf(contentText(content)));
  }
  return markers;
}

function reply(markers: string[]): string {
  const last = markers.at(-1);
  return last ? `Acknowledged ${last}.` : "Acknowledged.";
}

function chatChunk(
  id: string,
  delta: Record<string, unknown>,
  finish: string | null,
  usage?: object,
) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "loop-1",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

async function chatCompletion(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_REQUEST_BYTES) return new Response("too large", { status: 413 });
  let body: { stream?: unknown; messages?: unknown };
  try {
    const text = await request.text();
    if (text.length > MAX_REQUEST_BYTES) return new Response("too large", { status: 413 });
    body = JSON.parse(text) as typeof body;
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const markers = userMarkers(body.messages);
  record({ api: "chat", markers });
  const id = `chat-${crypto.randomUUID()}`;
  const text = reply(markers);
  const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
  if (body.stream !== true) {
    return Response.json({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "loop-1",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage,
    });
  }
  return new Response(
    chatChunk(id, { role: "assistant", content: text }, null) +
      chatChunk(id, {}, "stop", usage) +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
  );
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, bun) {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && bun.upgrade(request)) {
      return undefined;
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/__calls") return Response.json(calls);
    if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      return chatCompletion(request);
    }
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "loop-1", object: "model" }] });
    }
    return new Response("not served", { status: 404 });
  },
  websocket: {
    maxPayloadLength: MAX_REQUEST_BYTES,
    message(socket, message) {
      let frame: {
        type?: string;
        generate?: boolean;
        input?: unknown;
        previous_response_id?: unknown;
      };
      try {
        frame = JSON.parse(String(message)) as typeof frame;
      } catch {
        return;
      }
      if (frame.type !== "response.create") return;
      const id = `resp_${crypto.randomUUID()}`;
      const send = (event: unknown) => socket.send(JSON.stringify(event));
      const earlier =
        typeof frame.previous_response_id === "string"
          ? (contexts.get(frame.previous_response_id) ?? [])
          : [];
      const markers = [...earlier, ...userMarkers(frame.input)];
      contexts.set(id, markers);
      if (contexts.size > MAX_RESPONSES) contexts.delete(contexts.keys().next().value!);
      send({ type: "response.created", response: { id } });
      if (frame.generate !== false) {
        record({ api: "responses", markers });
        send({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            id: `msg_${id}`,
            role: "assistant",
            content: [{ type: "output_text", text: reply(markers), annotations: [] }],
            status: "completed",
          },
        });
      }
      send({
        type: "response.completed",
        response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      });
    },
  },
});
console.log(`http://127.0.0.1:${server.port}`);

// A module, so its top-level names do not collide with the other model scripts.
export {};
