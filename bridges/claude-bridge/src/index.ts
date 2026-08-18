// Claude Bridge Server
// Wraps the Claude Agent SDK and exposes HTTP/SSE endpoints for Orkestrator AI

import { Hono } from "hono";
import { compress } from "hono/compress";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
import { serve } from "@hono/node-server";

export const app = new Hono();

const BRIDGE_TOKEN_ENV = "CLAUDE_BRIDGE_TOKEN";
const BRIDGE_ALLOWED_ORIGINS_ENV = "CLAUDE_BRIDGE_ALLOWED_ORIGINS";
// A missing or blank token env var falls back to a random token nobody holds:
// the bridge stays fail-closed instead of fail-open. Same policy as codex-bridge.
const configuredBridgeAuthToken = process.env[BRIDGE_TOKEN_ENV]?.trim();
let bridgeAuthToken = configuredBridgeAuthToken || randomBytes(32).toString("base64url");
// The token is bridge-local authentication material, not configuration for
// SDK/CLI children. Capture it once and remove it before any later subprocess
// can inherit the bridge credential through process.env.
delete process.env[BRIDGE_TOKEN_ENV];
let bridgeAuthEnabledOverrideForTesting: boolean | null = null;

function isBridgeAuthEnabled(): boolean {
  if (bridgeAuthEnabledOverrideForTesting !== null) {
    return bridgeAuthEnabledOverrideForTesting;
  }
  // Route tests explicitly opt out because they exercise route mapping rather
  // than process authentication. This escape hatch is inert for a real server.
  return !(
    process.env.CLAUDE_BRIDGE_NO_SERVER === "1" &&
    process.env.CLAUDE_BRIDGE_AUTH_DISABLED_FOR_TESTING === "1"
  );
}

function tokenMatches(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(bridgeAuthToken);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function isTrustedBridgeOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  // Electron's packaged file renderer can be represented as a null origin.
  // Authentication is still mandatory, so allowing it does not grant access.
  if (origin === "null" || origin === "file://") return true;
  const configured = (process.env[BRIDGE_ALLOWED_ORIGINS_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (configured.includes(origin.replace(/\/$/, ""))) return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1" ||
        parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function isPublicHealthRequest(method: string, path: string): boolean {
  return method === "GET" && path === "/global/health";
}

// Middleware: origin policy + per-process token authentication. Only the
// minimal process health probe is public; every data route needs the token.
app.use("*", async (c, next) => {
  const origin = c.req.raw.headers.get("origin") ?? undefined;
  if (!isTrustedBridgeOrigin(origin)) {
    return c.json({ error: "Origin is not allowed" }, 403);
  }
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
  if (c.req.method === "OPTIONS") {
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    c.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Orkestrator-Claude-Token",
    );
    c.header("Access-Control-Allow-Private-Network", "true");
    return c.body(null, 204);
  }
  if (isBridgeAuthEnabled() && !isPublicHealthRequest(c.req.method, c.req.path)) {
    const dedicatedHeaderToken = c.req.raw.headers.get("x-orkestrator-claude-token")?.trim();
    const headerToken = bearerToken(c.req.raw.headers.get("authorization") ?? undefined);
    const eventToken = c.req.path === "/event/subscribe" ? c.req.query("token")?.trim() : undefined;
    if (
      !tokenMatches(dedicatedHeaderToken) &&
      !tokenMatches(headerToken) &&
      !tokenMatches(eventToken)
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }
  await next();
});
// Request logging is debug-only; see `createRequestLogger`.
const requestLogger = createRequestLogger();
if (requestLogger) {
  app.use("*", requestLogger);
}
app.use("/session/:id/messages", async (c, next) => {
  await next();
  c.res.headers.append("Vary", "Accept-Encoding");
});
app.use("/session/:id/messages", compress({ encoding: "gzip" }));

/**
 * Lightweight authenticated probe used to reject a cached client after token
 * rotation. This bridge has no engine-health dimension the way codex-bridge
 * does, so an authenticated 200 mirrors `/global/health`'s unconditional "ok".
 */
app.get("/global/auth-check", (c) => c.json({ status: "ok" }));

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
      console.error(`[claude-bridge] Backend process ${parentPid} is gone; shutting down`);
      process.exit(0);
    },
  });
}

type BridgeServerOptions = Parameters<typeof serve>[0];

function startBridgeServer(
  env: NodeJS.ProcessEnv = process.env,
  start: (options: BridgeServerOptions) => unknown = serve,
): unknown {
  if (env.CLAUDE_BRIDGE_NO_SERVER === "1") {
    return undefined;
  }

  const port = parseInt(env.PORT || "4097", 10);
  const hostname = env.HOSTNAME || "0.0.0.0";
  console.log(`Claude Bridge Server starting on ${hostname}:${port}`);
  const server = start({
    fetch: app.fetch,
    port,
    hostname,
  });
  console.log(`Claude Bridge Server running at http://${hostname}:${port}`);
  return server;
}

export const __testing = {
  isTrustedBridgeOriginForTesting: isTrustedBridgeOrigin,
  setBridgeAuthForTesting: (token?: string) => {
    if (token === undefined) {
      bridgeAuthEnabledOverrideForTesting = null;
      return;
    }
    bridgeAuthToken = token;
    bridgeAuthEnabledOverrideForTesting = true;
  },
  startBridgeServerForTesting: startBridgeServer,
};

startBridgeServer();
