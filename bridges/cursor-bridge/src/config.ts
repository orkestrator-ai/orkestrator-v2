/**
 * Process-wide configuration and bounds for the Cursor SDK bridge.
 *
 * Every limit here exists because the bridge holds a transcript in memory for
 * the lifetime of an environment and serves it to a renderer over HTTP. An
 * unbounded field is a way for one long agent turn to exhaust the backend.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";

export const PROVIDER = "cursor" as const;

export const port = parsePort(process.env.PORT);
export const hostname = process.env.HOSTNAME?.trim() || "127.0.0.1";
export const workingDirectory = resolve(process.env.CWD?.trim() || process.cwd());
export const authToken =
  process.env.CURSOR_BRIDGE_TOKEN?.trim() || randomBytes(32).toString("base64url");
/**
 * Where durable session state lives, or null when this bridge is stateless.
 *
 * Resolved per call rather than frozen at import. Freezing it would make the
 * value depend on which module happened to be imported first, which is a real
 * ordering dependency and not merely a testing inconvenience.
 */
export function stateFilePath(): string | null {
  const directory = process.env.CURSOR_BRIDGE_STATE_DIR?.trim();
  return directory ? resolve(directory, "state.json") : null;
}

/**
 * Where `Cursor.auth.login()` credentials live.
 *
 * The SDK defaults to `~/.cursor/sdk/auth.json`. Orkestrator points it at its
 * own application data directory instead, so an environment authenticated
 * through the app cannot be silently revoked by an unrelated `cursor-agent`
 * logout, and so a container can be handed exactly one credential file.
 */
export const credentialFile = process.env.CURSOR_BRIDGE_AUTH_FILE?.trim() || undefined;

/**
 * Sandbox the agent's own tool calls.
 *
 * Off by default and deliberately so: an Orkestrator Cursor tab is an
 * interactive agent session in an already-isolated worktree or container,
 * matching the permissive default the ACP path uses. The container boundary,
 * not the SDK sandbox, is what isolates an agent.
 */
export const sandboxEnabled = process.env.CURSOR_BRIDGE_SANDBOX === "1";

/**
 * Ambient Cursor settings layers the SDK is allowed to read from disk.
 *
 * `project` reads `.cursor/` out of the workspace, which is repository
 * controlled. Cloning a repository must not be enough to run its code, so the
 * project layer is opt-in and only the container launcher opts in — exactly
 * the boundary `ACP_APPROVE_PROJECT_MCPS` draws for the ACP path. Every other
 * value, including unset and a stray ambient one, fails closed.
 */
export const settingSources: Array<"user" | "project"> =
  process.env.CURSOR_BRIDGE_PROJECT_SETTINGS === "1" ? ["user", "project"] : ["user"];

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_MESSAGES = 500;
/**
 * The rendered-transcript display budget. Overridable only *downwards* and
 * only within a bounded range, so a test can reach the trim floor without
 * pushing sixteen megabytes through a fixture, and nothing can raise it past
 * the reviewed cap.
 */
export const MAX_TRANSCRIPT_BYTES = parseBoundedInteger(
  process.env.CURSOR_BRIDGE_MAX_TRANSCRIPT_BYTES,
  16 * 1024 * 1024 - 128 * 1024,
  256 * 1024,
  16 * 1024 * 1024 - 128 * 1024,
);
export const MAX_MESSAGE_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_PARTS_PER_MESSAGE = 512;
export const MAX_TOOL_ARGUMENT_BYTES = 512 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 512 * 1024;
export const MAX_TOOL_DIFF_BYTES = 1024 * 1024;
export const MAX_TOOL_TITLE_BYTES = 4 * 1024;
export const MAX_MODEL_ID_BYTES = 1_024;
export const MAX_PROMPT_JOURNAL = 256;
export const MAX_STRUCTURED_RESULTS = 64;
export const MAX_STRUCTURED_RESULT_BYTES = 1024 * 1024;
export const MAX_STATE_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_RESUME_ENTRIES = 200;
/**
 * A session that attempts to exceed this is failed explicitly rather than
 * silently dropping a child: an unreported background sub-agent would make
 * `/activity` answer idle while it is still writing to the workspace.
 */
export const MAX_ACTIVE_SUBAGENTS_PER_SESSION = 512;

/** How long a turn may run before the bridge gives up and reports failure. */
export const PROMPT_TIMEOUT_MS = parseBoundedInteger(
  process.env.CURSOR_BRIDGE_PROMPT_TIMEOUT_MS,
  6 * 60 * 60 * 1000,
  60 * 1000,
  24 * 60 * 60 * 1000,
);
/**
 * How long to wait for the SDK to acknowledge a cancellation before the bridge
 * fails the turn anyway. The run's terminal result stays authoritative for as
 * long as this window is open; only when the SDK produces nothing at all does
 * the bridge report an explicit failure rather than holding the session
 * "running" forever.
 */
export const CANCEL_ACK_TIMEOUT_MS = parseBoundedInteger(
  process.env.CURSOR_BRIDGE_CANCEL_ACK_TIMEOUT_MS,
  30 * 1000,
  1_000,
  5 * 60 * 1000,
);
/** Bounded budget for catalogue and account reads, which are never on a turn. */
export const CATALOG_TIMEOUT_MS = 30_000;
/** Interactive browser login is a human-paced flow; give it room but bound it. */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Authenticate a request against the bridge token.
 *
 * `Authorization: Bearer` is what the backend sends for this platform. The
 * dedicated header is accepted as well so a bridge started by hand — or by a
 * test harness — can present the token the same way the other bridges take it.
 */
export function authenticate(headers: {
  authorization?: string | string[];
  token?: string | string[];
}): boolean {
  const bearer = firstHeader(headers.authorization);
  const presented = bearer?.toLowerCase().startsWith("bearer ")
    ? bearer.slice("bearer ".length)
    : firstHeader(headers.token);
  if (presented === undefined) return false;
  const expected = Buffer.from(authToken);
  const actual = Buffer.from(presented.trim());
  // timingSafeEqual throws on a length mismatch, which is itself leak-free,
  // but comparing lengths first keeps the throw out of the hot path.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  return typeof header === "string" ? header : undefined;
}

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value?.trim() || "", 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : 0;
}

export function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value?.trim() || "", 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}
