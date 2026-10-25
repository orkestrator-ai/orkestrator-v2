/** Serves the real bridge routes over an ephemeral loopback port. */
import { app } from "../index.js";

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);
