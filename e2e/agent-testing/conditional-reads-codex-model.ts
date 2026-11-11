/**
 * A loopback stand-in for OpenAI's Responses WebSocket for the E10 baseline
 * (`conditional-reads-live.spec.ts` with `E10_PLATFORM=codex`), so the
 * profile's pinned Codex streams a scripted turn through the real Codex bridge
 * with no login and nothing billed. Run with Bun (specs run under Node, which
 * has no WebSocket server):
 *
 *   bun conditional-reads-codex-model.ts <rounds> <responseMs> <deltaMs> <deltaChars>
 *
 * It prints its base URL on the first line. Every sampled request (one that is
 * not a `generate: false` warm-up) is a round: it streams filler text for
 * `responseMs`, then, until the last round, calls `exec` with a read-only
 * `ls`, so Codex runs it and samples again. Each response reports usage, which
 * is the Codex bridge's row boundary, so each round is a new transcript row.
 * Rounds are counted here rather than read from the request, because Codex may
 * send only the new input after the first sample. Each streamed chunk prints a
 * `streamed <characters>` line, and each round a `round <n>` line, so the
 * spec can follow progress.
 */
const [rounds, responseMs, deltaMs, deltaChars] = process.argv.slice(2).map(Number);
if (![rounds, responseMs, deltaMs, deltaChars].every((value) => Number.isFinite(value))) {
  throw new Error("usage: <rounds> <responseMs> <deltaMs> <deltaChars>");
}

const FILLER =
  "The quick brown fox jumps over the lazy dog while the baseline streams steadily onward. ";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function filler(offset: number, length: number): string {
  let text = "";
  while (text.length < length) {
    const at = (offset + text.length) % FILLER.length;
    text += FILLER.slice(at, at + length - text.length);
  }
  return text;
}

let sampled = 0;
let streamed = 0;

async function respond(send: (event: unknown) => void, isOpen: () => boolean): Promise<void> {
  const round = sampled;
  sampled += 1;
  console.log(`round ${sampled}`);
  const id = `resp_e10_${round}`;
  const messageId = `msg_e10_${round}`;
  send({ type: "response.created", response: { id } });
  send({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", id: messageId, role: "assistant", content: [], status: "in_progress" },
  });
  send({
    type: "response.content_part.added",
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  let text = "";
  const deadline = Date.now() + responseMs!;
  while (Date.now() < deadline && isOpen()) {
    const delta = filler(text.length, deltaChars!);
    text += delta;
    send({
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta,
    });
    streamed += delta.length;
    console.log(`streamed ${streamed}`);
    await sleep(deltaMs!);
  }
  send({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      id: messageId,
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
      status: "completed",
    },
  });
  if (round < rounds! - 1) {
    send({
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "custom_tool_call",
        id: `ctc_e10_${round}`,
        call_id: `call_e10_${round}`,
        name: "exec",
        input: `text(JSON.stringify(await tools.exec_command(${JSON.stringify({ cmd: "ls" })})));`,
        status: "completed",
      },
    });
  }
  send({
    type: "response.completed",
    response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, bun) {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && bun.upgrade(request)) {
      return undefined;
    }
    return new Response("not served", { status: 404 });
  },
  websocket: {
    message(socket, message) {
      const frame = JSON.parse(String(message)) as { type?: string; generate?: boolean };
      if (frame.type !== "response.create") return;
      const send = (event: unknown) => socket.send(JSON.stringify(event));
      if (frame.generate === false) {
        const id = `resp_e10_warmup_${crypto.randomUUID()}`;
        send({ type: "response.created", response: { id } });
        send({
          type: "response.completed",
          response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        });
        return;
      }
      void respond(send, () => socket.readyState === 1).catch(() => socket.close());
    },
  },
});
console.log(`http://127.0.0.1:${server.port}/v1`);

// A module, so its top-level names do not collide with the other model scripts.
export {};
