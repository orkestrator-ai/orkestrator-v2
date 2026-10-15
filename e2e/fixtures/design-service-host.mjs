import { createInterface } from "node:readline";

const mode = process.argv[2];
const prefix = "@@design-host ";
const reply = (id, result) =>
  process.stdout.write(`${prefix}${JSON.stringify({ id, ok: true, result })}\n`);

// The client can fill its stdin buffer before this fixture begins reading.
if (mode === "backpressure") {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.kind === "close") {
    if (mode === "hang-close") return;
    reply(request.id, null);
    if (mode === "hang-exit") return;
    process.exit(0);
  }
  if (request.name === "ready") return reply(request.id, "ready");
  if (mode === "crash") process.exit(23);
  if (mode === "malformed") return process.stdout.write(`${prefix}{invalid\n`);
  if (mode === "invalid-shape") return process.stdout.write(`${prefix}null\n`);
  if (mode === "noise") {
    process.stdout.write('ordinary log\n{"id":1,"ok":true,"result":"wrong"}\n');
    reply(999999, "unknown request");
  }
  reply(request.id, request.args);
});
// Deliberately stay alive after EOF, including after a successful close reply.
if (mode === "hang-close" || mode === "hang-exit") setInterval(() => {}, 1000);
