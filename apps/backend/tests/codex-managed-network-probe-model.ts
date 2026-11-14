/**
 * A loopback stand-in for OpenAI's Responses WebSocket, for
 * `codex-managed-network-card-live.test.ts`. Run with Bun:
 * `bun codex-managed-network-probe-model.ts <probe host>`.
 *
 * It prints `{"baseUrl": …}` once listening, then answers every turn the same
 * way: the first sample runs `curl http://<probe host>:<its port>/probe` in
 * one code-mode cell, and the second ends the turn. The same server answers
 * that request, so on a host whose `/etc/hosts` points the probe host at
 * loopback an approved request is seen arriving. Each arrival prints a
 * `{"probeHit": …}` line and each tool output Codex sends back a
 * `{"toolOutput": …}` line. Nothing reaches a model, so no credits are spent.
 */
const [probeHost] = process.argv.slice(2);
if (!probeHost) throw new Error("usage: codex-managed-network-probe-model.ts <probe host>");
const PROBE_BODY = "orkestrator-network-probe-ok";
const cell = () =>
  `text(JSON.stringify(await tools.exec_command(${JSON.stringify({
    cmd: `curl -sS --max-time 10 http://${probeHost}:${server.port}/probe`,
  })})));`;

let sampled = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, bun) {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && bun.upgrade(request)) {
      return undefined;
    }
    if (new URL(request.url).pathname === "/probe") {
      console.log(JSON.stringify({ probeHit: request.headers.get("host") }));
      return new Response(PROBE_BODY);
    }
    return new Response("not served", { status: 404 });
  },
  websocket: {
    message(socket, message) {
      const frame = JSON.parse(String(message)) as {
        type?: string;
        generate?: boolean;
        input?: Array<{ type?: string; output?: unknown }>;
      };
      if (frame.type !== "response.create") return;
      for (const item of frame.input ?? []) {
        if (item.type === "custom_tool_call_output" || item.type === "function_call_output") {
          console.log(JSON.stringify({ toolOutput: item.output }));
        }
      }
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
                input: cell(),
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
console.log(JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}/v1` }));
