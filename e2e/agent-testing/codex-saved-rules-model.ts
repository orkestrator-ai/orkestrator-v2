/**
 * A loopback stand-in for OpenAI's Responses WebSocket, for
 * `codex-saved-rules-live.spec.ts`. Run with Bun (specs run under Node, which
 * has no WebSocket server): `bun codex-saved-rules-model.ts <command>`.
 *
 * It prints its base URL, then answers every turn the same way: the first
 * sample runs `<command>` in one code-mode cell, and the second ends the turn.
 * Nothing reaches a model, so no credits are spent.
 */
const [command] = process.argv.slice(2);
if (!command) throw new Error("usage: codex-saved-rules-model.ts <command>");
// Inside the workspace an Ask session's sandbox would run it unasked, so the
// command asks to leave the sandbox, which is what puts it in front of a person.
const args = {
  cmd: command,
  sandbox_permissions: "require_escalated",
  justification: "Run the saved rules probe.",
};
const cell = `text(JSON.stringify(await tools.exec_command(${JSON.stringify(args)})));`;

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
      const frame = JSON.parse(String(message)) as { type?: string; generate?: boolean };
      if (frame.type !== "response.create") return;
      const id = `resp_${crypto.randomUUID()}`;
      const send = (event: unknown) => socket.send(JSON.stringify(event));
      send({ type: "response.created", response: { id } });
      if (frame.generate !== false) {
        sampled += 1;
        const item =
          sampled % 2 === 1
            ? {
                type: "custom_tool_call",
                id: `ctc_probe_${sampled}`,
                call_id: `call_probe_${sampled}`,
                name: "exec",
                input: cell,
                status: "completed",
              }
            : {
                type: "message",
                id: `msg_probe_${sampled}`,
                role: "assistant",
                content: [{ type: "output_text", text: "done", annotations: [] }],
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
