/**
 * A loopback stand-in for OpenAI's Responses WebSocket that walks the trail
 * `transcript-paging-live.spec.ts` lays, so the pinned Codex app-server can
 * run the paging case with no login and no billed turn. Run with Bun (specs
 * run under Node, which has no WebSocket server):
 * `bun transcript-paging-codex-model.ts`.
 *
 * It prints its base URL, then answers each sample from the request alone:
 * the latest trail path in the request (the prompt's start, or the last stop's
 * "Next stop") becomes one `cat` in one code-mode cell, the way GPT-6-Luna
 * walked it in qualification, and the stop that ends the trail is answered
 * with its closing word. Each response reports usage, which is the Codex
 * bridge's row boundary, so one stop is one row. Nothing reaches a model.
 */
const START = /It starts at (trail-[0-9a-f]+\/[0-9a-f]{10}\.txt)/g;
const NEXT = /Next stop: (trail-[0-9a-f]+\/[0-9a-f]{10}\.txt)/g;
const END = /The closing word is (TRAILEND[0-9A-F]+)/g;

/** The match that occurs last in the request, across all three patterns. */
function latest(request: string): { kind: "read" | "end"; value: string } | undefined {
  let found: { index: number; kind: "read" | "end"; value: string } | undefined;
  for (const [pattern, kind] of [
    [START, "read"],
    [NEXT, "read"],
    [END, "end"],
  ] as const) {
    for (const match of request.matchAll(pattern)) {
      if (!found || match.index > found.index) {
        found = { index: match.index, kind, value: match[1]! };
      }
    }
  }
  return found;
}

let sampled = 0;
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
      const text = String(message);
      const frame = JSON.parse(text) as { type?: string; generate?: boolean };
      if (frame.type !== "response.create") return;
      const id = `resp_${crypto.randomUUID()}`;
      const send = (event: unknown) => socket.send(JSON.stringify(event));
      send({ type: "response.created", response: { id } });
      if (frame.generate !== false) {
        sampled += 1;
        const step = latest(text);
        const item =
          step?.kind === "read"
            ? {
                type: "custom_tool_call",
                id: `ctc_trail_${sampled}`,
                call_id: `call_trail_${sampled}`,
                name: "exec",
                input: `text(JSON.stringify(await tools.exec_command(${JSON.stringify({ cmd: `cat ${step.value}` })})));`,
                status: "completed",
              }
            : {
                type: "message",
                id: `msg_trail_${sampled}`,
                role: "assistant",
                content: [{ type: "output_text", text: step?.value ?? "done", annotations: [] }],
                status: "completed",
              };
        send({ type: "response.output_item.done", output_index: 0, item });
      }
      send({
        type: "response.completed",
        response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      });
    },
  },
});
console.log(`http://127.0.0.1:${server.port}/v1`);

// A module, so its top-level names do not collide with the other model scripts.
export {};
