// Claude Bridge Server
// Wraps the Claude Agent SDK and exposes HTTP/SSE endpoints for Orkestrator AI

import { Hono } from "hono";
import { cors } from "hono/cors";
import health from "./routes/health.js";
import config from "./routes/config.js";
import session from "./routes/session.js";
import events from "./routes/events.js";
import mcp from "./routes/mcp.js";
import plugins from "./routes/plugins.js";
import { createRequestLogger } from "./services/logger.js";
import {
  PARENT_PID_ENV,
  parseParentPid,
  startParentWatchdog,
} from "@orkestrator/protocol/parent-watchdog";

const app = new Hono();

// Middleware
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);
// Request logging is debug-only; see `createRequestLogger`.
const requestLogger = createRequestLogger();
if (requestLogger) {
  app.use("*", requestLogger);
}
app.use("*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Private-Network", "true");
});
app.options("*", (c) => c.body(null, 204));

// Mount routes
app.route("/global", health);
app.route("/config", config);
app.route("/session", session);
app.route("/event", events);
app.route("/mcp", mcp);
app.route("/plugins", plugins);

// Root endpoint
app.get("/", (c) => {
  return c.json({
    name: "Claude Bridge Server",
    version: "1.0.0",
    endpoints: {
      health: "/global/health",
      models: "/config/models",
      sessions: "/session/list",
      events: "/event/subscribe",
      mcp: "/mcp/servers",
      plugins: "/plugins",
    },
  });
});

// A dead backend can no longer terminate this process tree. Exiting is enough
// cleanup here: SDK-spawned Claude CLI children read stdio pipes from this
// process and exit on EOF when it goes away.
const parentPid = parseParentPid(process.env[PARENT_PID_ENV]);
if (parentPid !== null) {
  startParentWatchdog({
    parentPid,
    onParentExit: () => {
      console.error(
        `[claude-bridge] Backend process ${parentPid} is gone; shutting down`,
      );
      process.exit(0);
    },
  });
}

// Get port from environment or use default
const port = parseInt(process.env.PORT || "4097", 10);
const hostname = process.env.HOSTNAME || "0.0.0.0";

console.log(`Claude Bridge Server starting on ${hostname}:${port}`);

// Start the server using Node.js built-in serve
import { serve } from "@hono/node-server";

serve({
  fetch: app.fetch,
  port,
  hostname,
});

console.log(`Claude Bridge Server running at http://${hostname}:${port}`);
