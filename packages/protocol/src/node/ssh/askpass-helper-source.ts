/**
 * Source of the askpass helper OpenSSH runs (through `askpass.sh`) when it
 * needs a passphrase, password or confirmation. It is written into the
 * per-tunnel private directory at runtime and executed by Electron in Node
 * mode, so it may use only Node built-ins and must stay CommonJS.
 *
 * It forwards the prompt to the broker socket with the per-tunnel nonce and
 * prints the answer on stdout. Any failure exits non-zero, which OpenSSH treats
 * as a cancelled prompt. It never writes the answer anywhere else.
 */
export const ASKPASS_HELPER_SOURCE = String.raw`"use strict";
const net = require("node:net");
const socketPath = process.env.ORKESTRATOR_ASKPASS_SOCKET;
const nonce = process.env.ORKESTRATOR_ASKPASS_NONCE;
const prompt = String(process.argv[2] === undefined ? "" : process.argv[2]).slice(0, 1024);
const promptType = String(process.env.SSH_ASKPASS_PROMPT || "").slice(0, 32);
if (!socketPath || !nonce) process.exit(1);
let buffer = "";
let done = false;
const socket = net.createConnection(socketPath);
function finish(code, answer) {
  if (done) return;
  done = true;
  socket.destroy();
  if (typeof answer === "string") {
    process.stdout.write(answer + "\n", () => process.exit(code));
  } else {
    process.exit(code);
  }
}
socket.setEncoding("utf8");
socket.on("connect", () => {
  socket.write(JSON.stringify({ nonce: nonce, prompt: prompt, promptType: promptType }) + "\n");
});
socket.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.length > 16384) return finish(1);
  const end = buffer.indexOf("\n");
  if (end < 0) return;
  let reply;
  try {
    reply = JSON.parse(buffer.slice(0, end));
  } catch (_error) {
    return finish(1);
  }
  if (reply && reply.ok === true && typeof reply.answer === "string") finish(0, reply.answer);
  else finish(1);
});
socket.on("error", () => finish(1));
socket.on("close", () => finish(1));
`;
