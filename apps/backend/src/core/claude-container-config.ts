import { ORKESTRATOR_MCP_SERVER_NAME } from "@orkestrator/protocol/agent-mail";
import type { LoadedSource } from "./mcp-management/catalog.js";

/**
 * What a container may see of the host's `~/.claude.json` (security report
 * M8). The host file also holds every project path the user opened, per-project
 * MCP servers, history, caches and, for a console login, the API key itself.
 * Staging copies only an allowlist: the login's identity, the onboarding flags
 * that keep first-run screens away, and the user's MCP servers that are safe to
 * run inside a container. Everything else is dropped, never redacted in place.
 *
 * `docker/entrypoint.sh` repeats the top-level allowlist when it writes the
 * container's own `~/.claude.json`; keep {@link CLAUDE_CONTAINER_CONFIG_KEYS}
 * and its `CLAUDE_JSON_ALLOWED_KEYS` in step.
 */

/** Booleans Claude Code records once a first-run screen has been seen. */
export const CLAUDE_CONTAINER_ONBOARDING_FLAGS = [
  "hasCompletedOnboarding",
  "hasAcknowledgedCostThreshold",
  "hasSeenTasksHint",
  "hasUsedBackslashReturn",
  "hasIdeOnboardingBeenShown",
  "bypassPermissionsModeAccepted",
] as const;

/** Versions Claude Code compares to decide whether to show onboarding or release notes. */
export const CLAUDE_CONTAINER_ONBOARDING_VERSIONS = [
  "lastOnboardingVersion",
  "lastReleaseNotesSeen",
] as const;

/** Every top-level key a staged `.claude.json` can contain. */
export const CLAUDE_CONTAINER_CONFIG_KEYS = [
  "oauthAccount",
  ...CLAUDE_CONTAINER_ONBOARDING_FLAGS,
  ...CLAUDE_CONTAINER_ONBOARDING_VERSIONS,
  "mcpServers",
] as const;

const VERSION_MAX_LENGTH = 64;
const REMOTE_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;

export interface ClaudeContainerConfigOptions {
  /**
   * The host home directories the file came from. A server whose command,
   * arguments, working directory, environment or headers name a path inside
   * one exists only on the host and would expose that path.
   */
  hostHomes?: readonly string[];
}

/**
 * The container's view of a host `.claude.json`, or undefined when the text is
 * not a JSON object. A parseable file always yields an object (possibly `{}`),
 * so the staged mount exists for an account switch to rewrite in place.
 */
export function claudeContainerConfig(
  text: string,
  options: ClaudeContainerConfigOptions = {},
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const homes = (options.hostHomes ?? [])
    .map((home) => home.replace(/\/+$/, ""))
    .filter((home) => home.startsWith("/") && home.length > 1);
  // No prototype, so a key such as `__proto__` stays an ordinary key.
  const kept: Record<string, unknown> = Object.create(null);
  if (isRecord(parsed.oauthAccount)) kept.oauthAccount = parsed.oauthAccount;
  for (const flag of CLAUDE_CONTAINER_ONBOARDING_FLAGS) {
    if (typeof parsed[flag] === "boolean") kept[flag] = parsed[flag];
  }
  for (const key of CLAUDE_CONTAINER_ONBOARDING_VERSIONS) {
    const value = parsed[key];
    if (typeof value === "string" && value.length <= VERSION_MAX_LENGTH) kept[key] = value;
  }
  if (isRecord(parsed.mcpServers)) {
    const servers: Record<string, unknown> = Object.create(null);
    for (const [name, entry] of Object.entries(parsed.mcpServers)) {
      if (containerSafeMcpServer(name, entry, homes)) servers[name] = entry;
    }
    kept.mcpServers = servers;
  }
  return JSON.stringify(kept);
}

/**
 * Whether a user-scope MCP server may be handed to a container:
 * - not named `orkestrator`, the per-tab Orkestrator server inside a container
 *   and the name the Control MCP setup gives the operator connection on the
 *   host, with its bearer token;
 * - a remote server's URL does not address loopback, which on the host is a
 *   host service (the Control MCP's documented address) and inside the
 *   container is the container itself;
 * - a local server's command and working directory are not Windows paths;
 * - no string anywhere in the entry names a path inside a host home.
 * Anything not recognisable as a stdio or remote server is dropped.
 */
export function containerSafeMcpServer(
  name: string,
  entry: unknown,
  hostHomes: readonly string[] = [],
): boolean {
  if (!name || name.toLowerCase() === ORKESTRATOR_MCP_SERVER_NAME) return false;
  if (!isRecord(entry)) return false;
  const type = entry.type;
  // Claude Code treats an untyped entry with a URL and no command as remote.
  const remote =
    type === "http" ||
    type === "sse" ||
    type === "ws" ||
    (type === undefined && entry.command === undefined && entry.url !== undefined);
  if (remote) {
    if (!remoteUrlIsSafe(entry.url)) return false;
  } else if (type === undefined || type === "stdio") {
    if (typeof entry.command !== "string" || !entry.command.trim()) return false;
    if (WINDOWS_PATH.test(entry.command)) return false;
    if (typeof entry.cwd === "string" && WINDOWS_PATH.test(entry.cwd)) return false;
  } else {
    return false;
  }
  return !namesHostHome(entry, hostHomes, 0);
}

/**
 * The backend user's Claude `mcpServers` as a container inherits them, for
 * MCP management's defaults preview, refresh and reset. Those copy servers
 * straight into the container's `~/.claude.json`, so they apply the staging
 * allowlist too. The file snapshot is kept as read, so preview tokens still
 * name the host file.
 */
export function containerSafeClaudeDefaults(
  source: LoadedSource,
  hostHomes: readonly string[],
): LoadedSource {
  if (!source.parsed) return source;
  const entries = new Map(
    [...source.parsed.entries].filter(([name, entry]) =>
      containerSafeMcpServer(name, entry, hostHomes),
    ),
  );
  return { ...source, parsed: { ...source.parsed, entries } };
}

function remoteUrlIsSafe(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return REMOTE_PROTOCOLS.has(url.protocol) && !isLoopbackHost(url.hostname);
}

/** `URL` has already normalised IPv4 forms (`127.1`, `0x7f.0.0.1`) and IPv6 compression. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("127.") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    /^::ffff:(7f[0-9a-f]{2}:|127\.)/.test(host) ||
    host === "::ffff:0:0"
  );
}

const MAX_DEPTH = 16;

function namesHostHome(value: unknown, homes: readonly string[], depth: number): boolean {
  if (!homes.length) return false;
  // Deeper than any real MCP entry: treat as unsafe rather than recurse further.
  if (depth > MAX_DEPTH) return true;
  if (typeof value === "string") return homes.some((home) => containsPath(value, home));
  if (Array.isArray(value)) return value.some((item) => namesHostHome(item, homes, depth + 1));
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([key, item]) =>
        homes.some((home) => containsPath(key, home)) || namesHostHome(item, homes, depth + 1),
    );
  }
  return false;
}

/** `home` itself or a path below it, not a sibling that shares its prefix. */
function containsPath(text: string, home: string): boolean {
  let index = text.indexOf(home);
  while (index !== -1) {
    const next = text[index + home.length];
    if (next === undefined || !/[A-Za-z0-9._-]/.test(next)) return true;
    index = text.indexOf(home, index + 1);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
