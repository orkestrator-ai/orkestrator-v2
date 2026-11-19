#!/usr/bin/env bun
/**
 * An ACP agent whose turn traffic comes from a replay fixture.
 *
 * Used by `conformance-provider-replay.test.ts`. The session handshake
 * (`initialize`, `session/new`, configuration) is answered by the ordinary
 * fake agent, so every fixture starts from the same session (`fake-session`).
 * Everything else the bridge sends — `session/prompt`, `session/cancel`,
 * `session/load`, and its answers to the agent's own requests — is forwarded
 * to the test over the Unix socket named by `FAKE_ACP_REPLAY_SOCKET`, and
 * every line the test sends back is written to stdout verbatim, malformed
 * ones included. The bridge's real stdout parser is what reads them.
 *
 * Socket protocol, one JSON object per line:
 *   agent → test  {"in": <message the bridge wrote to this agent's stdin>}
 *   test → agent  {"out": "<raw line for this agent's stdout>"}
 */
import { connect } from "node:net";
import { lines, type JsonObject } from "./fake-agent-context.js";
import { handleSessionMessage } from "./fake-agent-session.js";

const socketPath = process.env.FAKE_ACP_REPLAY_SOCKET;
if (!socketPath) {
  process.stderr.write("FAKE_ACP_REPLAY_SOCKET is required\n");
  process.exit(2);
}

/** Bridge messages that belong to the turn, and so to the fixture. */
const FORWARDED_METHODS = new Set(["session/prompt", "session/cancel", "session/load"]);

const socket = connect(socketPath);
let buffered = "";
socket.setEncoding("utf8");
socket.on("data", (chunk: string) => {
  buffered += chunk;
  let newline = buffered.indexOf("\n");
  while (newline >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.trim()) {
      const message = JSON.parse(line) as { out?: unknown };
      if (typeof message.out === "string") process.stdout.write(`${message.out}\n`);
    }
    newline = buffered.indexOf("\n");
  }
});
// The test owns this agent's lifetime: its socket closing means the replay is over.
socket.on("close", () => process.exit(0));
socket.on("error", () => process.exit(3));

lines.on("line", (line) => {
  const message = JSON.parse(line) as JsonObject;
  const method = typeof message.method === "string" ? message.method : undefined;
  if (method && !FORWARDED_METHODS.has(method) && handleSessionMessage(message)) return;
  socket.write(`${JSON.stringify({ in: message })}\n`);
});
