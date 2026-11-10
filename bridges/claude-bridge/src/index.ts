// Claude Bridge Server
// Wraps the Claude Agent SDK and exposes HTTP/SSE endpoints for Orkestrator AI

// First, before any module reads the environment: what the bridge launcher
// recorded for the agents this bridge spawns (bridge-launch-environment.ts).
import "@orkestrator/protocol/node/bridge-launch-environment";
import { BRIDGE_LOG_POLICY_ROUTE } from "@orkestrator/protocol/log-policy";
import {
  applyBridgeLogPolicy,
  readBridgeLogPolicyBody,
} from "@orkestrator/protocol/node/bridge-log-policy";
import { Hono } from "hono";
import { compress } from "hono/compress";
import health from "./routes/health.js";
import config from "./routes/config.js";
import session from "./routes/session.js";
import { sessionActivityBatch } from "./routes/session-activity.js";
import changeEvidence from "./routes/change-evidence.js";
import { compressTranscriptReads } from "./routes/session-transcript.js";
import events from "./routes/events.js";
import mcp from "./routes/mcp.js";
import plugins from "./routes/plugins.js";
import { createRequestLogger } from "./services/logger.js";
import { readClaudeAuthStatus, refreshClaudeCatalogs } from "./services/session-manager.js";
import {
  PARENT_PID_ENV,
  parseParentPid,
  startParentWatchdog,
} from "@orkestrator/protocol/parent-watchdog";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { logUnhandledRejection } from "@orkestrator/protocol/node/process-failure-log";
import { serve } from "@hono/node-server";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { configureBridgeLogger } from "@orkestrator/protocol/node/logger-environment";
import {
  bridgeCredentialFromToken,
  loadBridgeCredential,
} from "@orkestrator/protocol/node/bridge-credential";
import { admitFetchBridgeRequest } from "@orkestrator/protocol/node/bridge-authority";

const log = createLogger("bridge.claude");

configureBridgeLogger();

export const app = new Hono();

/**
 * One readable line per uncaught route error.
 *
 * Hono's default handler passes the raw `Error` to the console, which under
 * Bun prints a source-context dump of whichever minified vendor file threw —
 * hundreds of columns of bundled SDK, with the actual message buried in it and
 * no indication of which request produced it. The response is the same 500
 * either way; only the log improves.
 */
app.onError((error, c) => {
  log.error("http.request-failed", {
    method: c.req.method,
    path: c.req.path,
    error: formatLogError(error),
  });
  return c.json({ error: "Internal Server Error" }, 500);
});

const BRIDGE_TOKEN_ENV = "CLAUDE_BRIDGE_TOKEN";
// A missing or blank credential falls back to a token nobody holds, so the bridge
// stays fail-closed, and it is removed from process.env here, before any later
// subprocess can inherit it. Same policy as codex-bridge.
let bridgeCredential = loadBridgeCredential(BRIDGE_TOKEN_ENV);
// Every CLI this bridge spawns — turns and zero-turn probes alike — loads the
// container's user settings, whose hooks feed the terminal-only
// `/tmp/.claude-state` channel. A probe fires UserPromptSubmit and never
// reaches Stop, which left native environments stuck on `working`. The
// container hooks skip their write when this marker is inherited; native
// activity is reported by the bridge itself. See docker/entrypoint.sh.
process.env.ORKESTRATOR_NATIVE_AGENT_BRIDGE = "claude";
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
  return bridgeCredential.matches(candidate);
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * Only the backend calls this bridge, and it sends no `Origin`. A request that
 * carries one came from a browser page; refuse it unless the page is on this
 * machine's loopback, before authentication. No browser client remains, so the
 * bridge answers no CORS preflight and echoes no origin.
 */
function isTrustedBridgeOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
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
// minimal process health probe is public; every data route needs the token,
// and only in a header: a token in a URL ends up in logs and history.
app.use("*", async (c, next) => {
  const origin = c.req.raw.headers.get("origin") ?? undefined;
  if (!isTrustedBridgeOrigin(origin)) {
    return c.json({ error: "Origin is not allowed" }, 403);
  }
  if (isBridgeAuthEnabled() && !isPublicHealthRequest(c.req.method, c.req.path)) {
    const dedicatedHeaderToken = c.req.raw.headers.get("x-orkestrator-claude-token")?.trim();
    const headerToken = bearerToken(c.req.raw.headers.get("authorization") ?? undefined);
    if (!tokenMatches(dedicatedHeaderToken) && !tokenMatches(headerToken)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    // What changes an agent's authority also needs the backend's signature,
    // which a token caught in flight does not carry (bridge-authority.ts).
    const admission = await admitFetchBridgeRequest(bridgeCredential.authority, c.req.raw);
    if ("refusal" in admission) {
      return c.json(admission.refusal.body, admission.refusal.status);
    }
    if (admission.request) c.req.raw = admission.request;
  }
  await next();
});
// Request logging is debug-only, and follows a change to that setting; see
// `createRequestLogger`.
app.use("*", createRequestLogger());
app.use("/session/:id/messages", async (c, next) => {
  await next();
  c.res.headers.append("Vary", "Accept-Encoding");
});
app.use("/session/:id/messages", compress({ encoding: "gzip" }));
app.use("/session/:id/transcript", async (c, next) => {
  await next();
  c.res.headers.append("Vary", "Accept-Encoding");
});
app.use("/session/:id/transcript", compress({ encoding: "gzip" }));
compressTranscriptReads(app);

/**
 * Lightweight authenticated probe used to reject a cached client after token
 * rotation. This bridge has no engine-health dimension the way codex-bridge
 * does, so an authenticated 200 mirrors `/global/health`'s unconditional "ok".
 */
app.get("/global/auth-check", (c) => c.json({ status: "ok" }));
app.get("/global/auth", async (c) => c.json(await readClaudeAuthStatus()));
app.post("/global/auth/login", (c) =>
  c.json(
    { error: "Claude signs in from the sign-in card in its tab or from Settings → Claude." },
    405,
  ),
);
app.post("/global/auth/logout", (c) =>
  c.json({ error: "Claude sign-out is available from a terminal tab." }, 405),
);
app.post("/global/refresh-catalog", async (c) => {
  await refreshClaudeCatalogs();
  return c.json({ ok: true });
});

// The live logging settings. Metadata only; see `applyBridgeLogPolicy`.
app.post(BRIDGE_LOG_POLICY_ROUTE, async (c) => {
  const answer = applyBridgeLogPolicy(await readBridgeLogPolicyBody(c.req.raw));
  return c.json(answer.body, answer.status);
});

// Mount routes
app.route("/global", health);
app.route("/config", config);
app.route("/session", session);
// `POST /sessions/activity`: outside `/session/:id` so no id route can shadow it.
app.route("/", sessionActivityBatch);
// `GET /change-evidence`, `GET /change-evidence/body`, `POST /change-evidence/ack`.
app.route("/", changeEvidence);
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
// A dropped promise must not take this bridge — and every session it is
// serving — down with it.
installFatalRejectionGuard({ label: "[claude-bridge]", onRejection: logUnhandledRejection });

const parentPid = parseParentPid(process.env[PARENT_PID_ENV]);
if (parentPid !== null) {
  startParentWatchdog({
    parentPid,
    onParentExit: () => {
      log.warn("parent.gone", { parentPid });
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
  log.debug("server.starting", { hostname, port });
  const server = start({
    fetch: app.fetch,
    port,
    hostname,
  });
  log.info("server.listening", { hostname, port });
  return server;
}

export const __testing = {
  isTrustedBridgeOriginForTesting: isTrustedBridgeOrigin,
  setBridgeAuthForTesting: (token?: string) => {
    if (token === undefined) {
      bridgeAuthEnabledOverrideForTesting = null;
      return;
    }
    bridgeCredential = bridgeCredentialFromToken(token);
    bridgeAuthEnabledOverrideForTesting = true;
  },
  startBridgeServerForTesting: startBridgeServer,
};

startBridgeServer();
