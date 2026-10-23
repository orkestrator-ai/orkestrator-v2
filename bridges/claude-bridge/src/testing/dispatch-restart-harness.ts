/** Real bridge routes with a read-only test seam proving metadata reads stay cold. */
import { app } from "../index.js";
import { peekSession } from "../services/session-manager.js";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/registered") {
      return Response.json({
        registered: peekSession(url.searchParams.get("id") ?? "") !== undefined,
      });
    }
    return app.fetch(request);
  },
});
process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);
