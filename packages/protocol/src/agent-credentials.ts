/**
 * Agent credentials: how an agent asks to use a secret, how a person grants
 * it, and the safe records both sides read. See
 * docs/architecture/agent-credentials.md.
 *
 * Nothing in this module carries a secret value except the one approval input
 * (`CredentialApprovalSource` with `kind: "value"`), which travels only on the
 * human approval and connection commands. Every record here is metadata: the
 * backend keeps values in its credential vault and hands an agent a grant
 * reference, never the value.
 *
 * Pure and browser-safe: the renderer uses the same limits and validators to
 * shape its forms, and the backend to enforce them.
 */

/**
 * The tab id of a caller that cannot name its tab: OpenCode's agent tools
 * connection belongs to the whole environment. A request with this tab is
 * shown on every agent tab of the environment.
 */
export const CREDENTIAL_ANY_TAB = "*";

/** How an agent may use a granted credential. */
export const CREDENTIAL_USES = ["command", "http"] as const;
export type CredentialUse = (typeof CREDENTIAL_USES)[number];

/** Where a granted value appears in a `command` run. */
export type CredentialBinding =
  /** The value as the environment variable `name`. */
  | { kind: "env"; name: string }
  /** The value in a private file whose path is the environment variable `name`. */
  | { kind: "file"; name: string };

/** How a trusted `http` request presents the credential. */
export type CredentialHttpAuth =
  | { scheme: "bearer" }
  | { scheme: "header"; header: string }
  | { scheme: "basic"; username: string };

/** What a trusted `http` request may reach and how it authenticates. */
export interface CredentialHttpPolicy {
  auth: CredentialHttpAuth;
  /** Exact host names (lower case, optional `:port`); `https` only. */
  hosts: string[];
  /** Methods allowed; absent means every method in {@link CREDENTIAL_HTTP_METHODS}. */
  methods?: CredentialHttpMethod[];
}

export const CREDENTIAL_HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export type CredentialHttpMethod = (typeof CREDENTIAL_HTTP_METHODS)[number];
/** Methods a read-only (coordinator) session may use. */

export const CREDENTIAL_LIMITS = Object.freeze({
  /** Largest value accepted, in UTF-8 bytes. */
  valueMaxBytes: 64 * 1024,
  /**
   * Shortest value accepted. Output filtering replaces every occurrence of a
   * value; a shorter one would mangle ordinary output and could not be
   * filtered meaningfully.
   */
  valueMinChars: 4,
  labelMaxChars: 120,
  purposeMaxChars: 1_000,
  nameMaxChars: 80,
  descriptionMaxChars: 500,
  hostMaxChars: 253,
  maxHosts: 16,
  commandMaxChars: 8_000,
  bindingNameMaxChars: 64,
  headerNameMaxChars: 64,
  usernameMaxChars: 256,
  idempotencyKeyMaxChars: 200,
  maxConnections: 200,
  /** Pending requests one tab may have open at once. */
  maxPendingRequestsPerTab: 4,
  /** Records (requests, grants, operations) kept per environment; oldest settled go first. */
  maxRecordsPerEnvironment: 400,
  /** Captured output per stream of a command run, after filtering. */
  outputMaxBytes: 64 * 1024,
  httpRequestBodyMaxBytes: 256 * 1024,
  httpResponseBodyMaxBytes: 128 * 1024,
  maxUses: 10_000,
});

export const CREDENTIAL_TIMING = Object.freeze({
  /** How long a request waits for a person before it expires. */
  requestWaitMs: 10 * 60_000,
  /** Grant lifetimes the card offers; the first is the default. */
  grantLifetimeChoicesMs: [60 * 60_000, 15 * 60_000, 4 * 60 * 60_000, 8 * 60 * 60_000] as const,
  /** Longest lifetime a grant may have. */
  grantMaxLifetimeMs: 8 * 60 * 60_000,
  /** A command run's deadline unless the agent asks for less. */
  runDefaultTimeoutMs: 10 * 60_000,
  runMaxTimeoutMs: 60 * 60_000,
  /** How long one tool call waits before answering `running`. */
  waitDefaultMs: 45_000,
  waitMaxMs: 110_000,
  httpTimeoutMs: 60_000,
});

/** Where durable values are kept on this backend. */
export type CredentialVaultKind = "keychain" | "file" | "memory";

export interface CredentialVaultStatus {
  /** Where a saved connection's value goes. `memory` means saving is unavailable. */
  durable: CredentialVaultKind;
  /** True when connections can be saved. */
  canSave: boolean;
  /** A short, content-free explanation shown in Settings. */
  detail: string;
}

/** A saved credential, as every client sees it. Never carries the value. */
export interface CredentialConnection {
  id: string;
  name: string;
  description?: string;
  /** Projects allowed to request it; `null` means every project on this machine. */
  projectIds: string[] | null;
  /** Hosts a trusted HTTP request may reach with it; empty forbids HTTP use. */
  httpHosts: string[];
  /** Where the value is stored. */
  storage: CredentialVaultKind;
  /** Bumped on every change to the record; a grant pins it. */
  revision: number;
  /** Bumped when the value is replaced; a grant pins it. */
  valueVersion: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  /** A retired value is awaiting removal from its vault. */
  cleanupPending?: boolean;
  /** `unavailable`: the vault no longer holds the value (locked, deleted outside Orkestrator). */
  status: "ready" | "unavailable";
}

export const CREDENTIAL_REQUEST_STATES = [
  "pending",
  "granted",
  "declined",
  "expired",
  "cancelled",
] as const;
export type CredentialRequestState = (typeof CREDENTIAL_REQUEST_STATES)[number];

/** What an agent asked for. Text fields are the agent's words: untrusted. */
export interface CredentialRequestRecord {
  id: string;
  /** Compare-and-set revision; an approval names the one it saw. */
  revision: number;
  environmentId: string;
  projectId: string;
  tabId: string;
  label: string;
  purpose: string;
  use: CredentialUse;
  /** `command` use: where the value goes. */
  binding?: CredentialBinding;
  /** `command` use: when set, the grant runs exactly this command and nothing else. */
  command?: string;
  /** `http` use: the destination and authentication the agent proposed. */
  http?: CredentialHttpPolicy;
  /** The connection name the agent suggested, if any. A hint, never a selection. */
  suggestedConnection?: string;
  state: CredentialRequestState;
  createdAt: number;
  /** When a pending request expires. */
  expiresAt: number;
  decidedAt?: number;
  grantId?: string;
  /** Content-free reason for `cancelled`. */
  reason?: string;
}

export const CREDENTIAL_GRANT_STATES = ["active", "revoked", "expired", "invalidated"] as const;
export type CredentialGrantState = (typeof CREDENTIAL_GRANT_STATES)[number];

export type CredentialGrantSource =
  { kind: "connection"; connectionId: string; connectionName: string } | { kind: "temporary" };

/** An execution-bound permission to use one credential. */
export interface CredentialGrantRecord {
  id: string;
  requestId: string;
  environmentId: string;
  projectId: string;
  tabId: string;
  label: string;
  source: CredentialGrantSource;
  use: CredentialUse;
  binding?: CredentialBinding;
  command?: string;
  http?: CredentialHttpPolicy;
  /** Where the agent runs: commands run there, and a change there ends the grant. */
  runtime: CredentialRuntime;
  issuedAt: number;
  expiresAt: number;
  maxUses: number | null;
  uses: number;
  state: CredentialGrantState;
  endedAt?: number;
  /** Content-free reason for a grant that is no longer active. */
  endReason?: string;
}

/** The execution context a grant is bound to. */
export type CredentialRuntime =
  | { kind: "worktree"; isolation: "trusted-local" }
  | { kind: "container"; isolation: "shared-container" }
  | { kind: "coordinator"; isolation: "read-only" };

export const CREDENTIAL_OPERATION_STATES = [
  "reserved",
  "running",
  "succeeded",
  "failed",
  "failed_no_effect",
  "outcome_unknown",
  "cancelled_before_start",
] as const;
export type CredentialOperationState = (typeof CREDENTIAL_OPERATION_STATES)[number];

/** One use of a grant. */
export interface CredentialOperationRecord {
  id: string;
  grantId: string;
  environmentId: string;
  tabId: string;
  kind: CredentialUse;
  state: CredentialOperationState;
  /** Short description: the command's first line, or `METHOD host/path`. */
  summary: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  httpStatus?: number;
  /** Whether materialized copies (files, processes) were confirmed removed. */
  cleanup: "none" | "confirmed" | "unconfirmed";
  /** Content-free failure reason. */
  error?: string;
}

/** What a tab's card needs: its requests and grants, and connections it may pick. */
export interface CredentialTabSnapshot {
  requests: CredentialRequestRecord[];
  grants: CredentialGrantRecord[];
  /** Connections the tab's project may use, ready ones first. */
  connections: CredentialConnection[];
  vault: CredentialVaultStatus;
}

/** What Settings shows. */
export interface CredentialOverview {
  vault: CredentialVaultStatus;
  connections: CredentialConnection[];
  /** Active grants on this machine, newest first. */
  grants: CredentialGrantRecord[];
  /** Recent operations, newest first. */
  operations: CredentialOperationRecord[];
}

/**
 * Where an approved value comes from. The only shape here that carries a
 * secret; it is accepted by the approval command alone.
 */
export type CredentialApprovalSource =
  | { kind: "connection"; connectionId: string }
  | {
      kind: "value";
      value: string;
      /** Also save it as a connection with this name. Off by default. */
      saveAs?: { name: string; description?: string };
    };

/** Agent-facing error codes. Stable: tools and the docs name them. */
export const CREDENTIAL_ERROR_CODES = [
  "UNSUPPORTED_CALLER",
  "REQUEST_LIMIT",
  "REQUEST_NOT_FOUND",
  "REQUEST_STALE",
  "GRANT_NOT_FOUND",
  "ACCESS_EXPIRED",
  "ACCESS_REVOKED",
  "SCOPE_MISMATCH",
  "USE_LIMIT",
  "POLICY_DENIED",
  "UNSUPPORTED_RUNTIME",
  "VALUE_UNAVAILABLE",
  "STORE_UNAVAILABLE",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_INPUT",
  "OUTCOME_UNKNOWN",
] as const;
export type CredentialErrorCode = (typeof CREDENTIAL_ERROR_CODES)[number];

/** Content-free error with a stable code; its message never includes a value. */
export class CredentialError extends Error {
  constructor(
    readonly code: CredentialErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "CredentialError";
  }
}

// --- Validation ---------------------------------------------------------------

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const HOST =
  /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/u;

/**
 * Environment variable names a binding may not take: each changes how
 * programs load, find executables or start, so they are not credential slots.
 */
const RESERVED_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "OLDPWD",
  "IFS",
  "ENV",
  "BASH_ENV",
  "PS4",
  "PROMPT_COMMAND",
  "CDPATH",
  "TMPDIR",
  "LANG",
  "TERM",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BUN_OPTIONS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
  "RUBYLIB",
  "GIT_SSH_COMMAND",
  "GIT_EXEC_PATH",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "SSH_AUTH_SOCK",
  "EDITOR",
  "VISUAL",
  "PAGER",
]);
const RESERVED_ENV_PREFIXES = ["LD_", "DYLD_", "ORKESTRATOR_", "BASH_FUNC_", "MISE_"];

/** Headers a trusted request may not set itself, or name as its credential header. */
export const CREDENTIAL_FORBIDDEN_HEADERS = new Set([
  "host",
  "authorization",
  "proxy-authorization",
  "cookie",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "expect",
]);

export function credentialBindingNameProblem(name: string): string | null {
  if (!name || name.length > CREDENTIAL_LIMITS.bindingNameMaxChars) {
    return "Binding names are 1 to 64 characters.";
  }
  if (!ENV_NAME.test(name)) {
    return "Binding names use upper-case letters, digits and underscores, and do not start with a digit.";
  }
  if (
    RESERVED_ENV_NAMES.has(name) ||
    RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) {
    return `${name} changes how programs start, so it cannot hold a credential.`;
  }
  return null;
}

export function credentialHeaderNameProblem(header: string): string | null {
  if (
    !header ||
    header.length > CREDENTIAL_LIMITS.headerNameMaxChars ||
    !HEADER_NAME.test(header)
  ) {
    return "Header names are 1 to 64 token characters.";
  }
  if (CREDENTIAL_FORBIDDEN_HEADERS.has(header.toLowerCase())) {
    return `${header} cannot carry a credential; use the bearer scheme for Authorization.`;
  }
  return null;
}

/** A host as stored: lower case, no scheme or path. Null when it is not a host name. */
export function normalizeCredentialHost(value: string): string | null {
  const input = value
    .trim()
    .toLowerCase()
    .replace(/\.(?=:|$)/u, "");
  if (!input || input.length > CREDENTIAL_LIMITS.hostMaxChars + 6 || !HOST.test(input)) return null;
  const [name, port] = input.split(":");
  if (!name?.includes(".") || (port !== undefined && Number(port) < 1)) return null;
  try {
    const url = new URL(`https://${input}`);
    // WHATWG URL also canonicalizes abbreviated and non-decimal IPv4 literals.
    return /^\d+(?:\.\d+){3}$/u.test(url.hostname) ? null : url.host;
  } catch {
    return null;
  }
}

export function normalizeCredentialHosts(values: readonly string[]): string[] | null {
  if (values.length > CREDENTIAL_LIMITS.maxHosts) return null;
  const hosts = new Set<string>();
  for (const value of values) {
    const host = normalizeCredentialHost(value);
    if (!host) return null;
    hosts.add(host);
  }
  return [...hosts].sort();
}

const encoder = new TextEncoder();

/** Why a value cannot be stored or used, or null. Exact bytes: nothing is trimmed. */
export function credentialValueProblem(value: unknown): string | null {
  if (typeof value !== "string") return "The value must be text.";
  if (/[\uD800-\uDFFF]/u.test(value)) return "The value must contain well-formed Unicode.";
  if ([...value].length < CREDENTIAL_LIMITS.valueMinChars) {
    return `Values shorter than ${CREDENTIAL_LIMITS.valueMinChars} characters cannot be filtered from output.`;
  }
  if (encoder.encode(value).byteLength > CREDENTIAL_LIMITS.valueMaxBytes) {
    return "Values are at most 64 KiB.";
  }
  if (value.includes("\0")) return "Values cannot contain NUL characters.";
  if (value.trim().length === 0) return "The value is only whitespace.";
  return null;
}

/** Display text from an agent: control characters removed, bounded. */
export function sanitizeCredentialText(value: string, max: number): string {
  let text = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 0x20 && character !== "\n" && character !== "\t") || code === 0x7f) continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    text += character;
  }
  text = text.trim();
  return [...text].slice(0, max).join("");
}

/** The default grant lifetime (the first card choice). */
export const CREDENTIAL_DEFAULT_GRANT_LIFETIME_MS = CREDENTIAL_TIMING.grantLifetimeChoicesMs[0];

/** A lifetime a person may choose: bounded by the backend maximum. */
export function clampCredentialGrantLifetime(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return CREDENTIAL_DEFAULT_GRANT_LIFETIME_MS;
  }
  return Math.min(Math.max(Math.round(value), 60_000), CREDENTIAL_TIMING.grantMaxLifetimeMs);
}

/** Whether a request or grant record is still open. */
export function isCredentialGrantUsable(grant: CredentialGrantRecord, now: number): boolean {
  return (
    grant.state === "active" &&
    grant.expiresAt > now &&
    (grant.maxUses === null || grant.uses < grant.maxUses)
  );
}

/** One line describing how a grant may be used, for cards and lists. */
export function describeCredentialUse(
  record: Pick<CredentialGrantRecord, "use" | "binding" | "command" | "http">,
): string {
  if (record.use === "http") {
    const hosts = record.http?.hosts.join(", ") ?? "";
    return `Trusted HTTPS requests to ${hosts || "no hosts"}`;
  }
  const binding = record.binding
    ? record.binding.kind === "env"
      ? `as $${record.binding.name}`
      : `in a private file at $${record.binding.name}`
    : "";
  return record.command
    ? `Only the command shown, ${binding}`.trim()
    : `Commands agents run in this environment, ${binding}`.trim();
}
