/**
 * Process-wide configuration and bounds for the Pi bridge.
 *
 * Every limit here exists because the bridge holds a transcript in memory for
 * the lifetime of an environment and serves it to a renderer over HTTP. An
 * unbounded field is a way for one long agent turn to exhaust the backend.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";

export const PROVIDER = "pi" as const;

export const port = parsePort(process.env.PORT);
export const hostname = process.env.HOSTNAME?.trim() || "127.0.0.1";
export const workingDirectory = resolve(process.env.CWD?.trim() || process.cwd());
export const authToken =
  process.env.PI_BRIDGE_TOKEN?.trim() || randomBytes(32).toString("base64url");

/**
 * Where durable bridge state lives, or null when this bridge is stateless.
 *
 * Resolved per call rather than frozen at import. Freezing it would make the
 * value depend on which module happened to be imported first, which is a real
 * ordering dependency and not merely a testing inconvenience.
 */
export function stateFilePath(): string | null {
  const directory = process.env.PI_BRIDGE_STATE_DIR?.trim();
  return directory ? resolve(directory, "state.json") : null;
}

/**
 * Pi's own configuration directory, holding `auth.json`, `models.json` and
 * `settings.json`.
 *
 * Left unset means the SDK's default `~/.pi/agent`, which is what a local
 * worktree wants: the environment runs as the user, and the credential it
 * needs is the one `pi` itself was signed in with. Containers are handed an
 * explicit path instead, because their home directory is not the user's.
 */
export function agentDirectory(): string | undefined {
  const directory = process.env.PI_AGENT_DIR?.trim();
  return directory ? resolve(directory) : undefined;
}

/**
 * Where Pi writes its own session transcripts.
 *
 * Pi owns this file format and resumes a conversation from it, so it is the
 * model's memory rather than a cache. It is deliberately separate from
 * `PI_BRIDGE_STATE_DIR`, which holds only what *this* bridge would otherwise
 * lose across a restart.
 */
export function sessionDirectory(): string | undefined {
  const directory = process.env.PI_SESSION_DIR?.trim();
  return directory ? resolve(directory) : undefined;
}

/**
 * Whether the agent's tool calls are routed through the approval flow.
 *
 * Off by default and deliberately so: an Orkestrator Pi tab is an interactive
 * agent session in an already-isolated worktree or container, matching the
 * permissive default every other bridge here uses. The container boundary, not
 * a per-call prompt, is what isolates an agent. When it *is* on, every timeout,
 * disconnect and malformed answer denies — see `interactions.ts`.
 */
export function approvalsEnabled(): boolean {
  return process.env.PI_BRIDGE_REQUIRE_APPROVAL === "1";
}

/**
 * Ambient project-local resources the SDK is allowed to load from the workspace.
 *
 * Pi discovers `.pi/` extensions, skills and prompt templates out of the
 * repository, and an extension is arbitrary TypeScript that runs in this
 * process. Cloning a repository must not be enough to run its code, so the
 * project layer is opt-in and only the container launcher opts in — exactly the
 * boundary `ACP_APPROVE_PROJECT_MCPS` draws for the ACP bridge. Every other
 * value, including unset and a stray ambient one, fails closed.
 */
export const projectResourcesEnabled = process.env.PI_BRIDGE_PROJECT_RESOURCES === "1";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_MESSAGES = 500;
/**
 * The rendered-transcript display budget. Overridable only *downwards* and
 * only within a bounded range, so a test can reach the trim floor without
 * pushing sixteen megabytes through a fixture, and nothing can raise it past
 * the reviewed cap.
 */
export const MAX_TRANSCRIPT_BYTES = parseBoundedInteger(
  process.env.PI_BRIDGE_MAX_TRANSCRIPT_BYTES,
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
export const MAX_MODELS = 2_000;
export const MAX_PROMPT_JOURNAL = 256;
export const MAX_STRUCTURED_RESULTS = 64;
export const MAX_STRUCTURED_RESULT_BYTES = 1024 * 1024;
export const MAX_STATE_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_RESUME_ENTRIES = 200;
export const MAX_SLASH_COMMANDS = 512;
export const MAX_PENDING_APPROVALS = 64;

/** How long a turn may run before the bridge gives up and reports failure. */
export const PROMPT_TIMEOUT_MS = parseBoundedInteger(
  process.env.PI_BRIDGE_PROMPT_TIMEOUT_MS,
  6 * 60 * 60 * 1000,
  60 * 1000,
  24 * 60 * 60 * 1000,
);
/** Bounded budget for catalogue and history reads, which are never on a turn. */
export const CATALOG_TIMEOUT_MS = 30_000;
/**
 * How long a *polled* read may wait for a composer rehydration before it
 * answers with the snapshot it already has.
 *
 * `/session/:id/status` is what the backend polls, and it budgets the whole
 * call at 30s — the same ceiling `CATALOG_TIMEOUT_MS` puts on the catalogue
 * probe behind a hydration. Waiting the full probe out would turn a slow
 * provider into a *failed* status read, so these routes wait only long enough
 * for a warm catalogue and then publish what they have. The hydration carries
 * on in the background and the next poll picks it up, which is the same
 * snapshot-plus-increment contract every other read here follows.
 */
export const COMPOSER_HYDRATION_WAIT_MS = 1_500;
/**
 * How long a tool call may wait for a human before it is denied.
 *
 * Denial, never approval: an unanswered prompt is a prompt nobody saw, and
 * running the command anyway would execute something the user never read.
 */
export function approvalTimeoutMs(): number {
  return parseBoundedInteger(
    process.env.PI_BRIDGE_APPROVAL_TIMEOUT_MS,
    5 * 60 * 1000,
    // Floored at a second rather than at a realistic human budget: the only
    // caller that lowers it is a test proving the timeout denies, and a test
    // that has to wait five minutes to prove that is a test nobody runs.
    1_000,
    60 * 60 * 1000,
  );
}

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
