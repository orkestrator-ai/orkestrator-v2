/**
 * Access-only copies of a provider login, for runtimes that must never refresh
 * it: Docker containers and isolated agent-test profiles.
 *
 * xAI and OpenAI refresh tokens are single-use. A copy that refreshes spends
 * the token the host still holds, so the host's own CLI fails its next refresh
 * and signs out, and so does every other copy (observed with Grok 1.0.52 on
 * 2026-10-18; Codex reports the same as "refresh token was already used").
 * Each copy therefore keeps the access token and loses the refresh token. It
 * works until that access token expires and is then signed out on its own,
 * never touching the host. The owner re-copies from the host, which refreshes
 * its own login, on each start.
 *
 * OpenCode and Pi keep one login per model provider in one file, and several
 * of those providers rotate their refresh tokens too (see
 * `restrictProviderAuthEntries`).
 *
 * Every function only reads JSON and returns a replacement text, or a reason
 * to copy nothing. A reason never contains credential material.
 */

/**
 * `dropped` counts provider logins left out of a file that still holds others
 * (OpenCode and Pi only).
 */
export type LoginSnapshot = { text: string; dropped?: number } | { withheld: string };

/** An access token this close to expiry is not worth handing over. */
export const LOGIN_SNAPSHOT_MIN_VALIDITY_MS = 60_000;

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reduce a copy of the host's Grok `auth.json` to each login's access token,
 * with its refresh token blanked. Logins that have already expired, or are
 * about to, are dropped.
 */
export function restrictGrokAuthSnapshot(text: string, nowMs = Date.now()): LoginSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { withheld: "the host Grok auth.json is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { withheld: "the host Grok auth.json has an unknown shape" };
  }
  const kept: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const login = { ...(entry as Record<string, unknown>) };
    if ("expires_at" in login) {
      const expiresAt = typeof login.expires_at === "string" ? Date.parse(login.expires_at) : NaN;
      if (!(expiresAt - nowMs >= LOGIN_SNAPSHOT_MIN_VALIDITY_MS)) continue;
    }
    if ("refresh_token" in login) login.refresh_token = "";
    kept[key] = login;
  }
  if (Object.keys(kept).length === 0) {
    return {
      withheld:
        "the host Grok login has expired and a copy may not refresh it; run grok on the host (grok login if it is signed out there), then restart",
    };
  }
  return { text: JSON.stringify(kept) };
}

/** The `exp` claim of a JWT, in milliseconds, or undefined when it has none. */
export function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims: unknown = JSON.parse(
      atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")),
    );
    const exp = (claims as { exp?: unknown } | null)?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reduce a copy of a Codex `auth.json` to what may not rotate the original.
 *
 * A ChatGPT login keeps its access and id tokens with the refresh token
 * blanked, and `last_refresh` is set to now: Codex refreshes proactively once
 * that stamp is about eight days old, and a copy that cannot refresh should
 * use its access token until it actually expires instead. An expired access
 * token drops the ChatGPT login. An API key cannot rotate and is kept as is.
 */
export function restrictCodexAuthSnapshot(text: string, nowMs = Date.now()): LoginSnapshot {
  const parsed = parseObject(text);
  if (!parsed) return { withheld: "the Codex auth.json is not a JSON object" };
  const apiKey =
    typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim()
      ? parsed.OPENAI_API_KEY
      : undefined;
  const tokens = parsed.tokens;
  if (tokens === undefined || tokens === null) {
    return apiKey
      ? { text: JSON.stringify(parsed) }
      : { withheld: "the Codex auth.json holds no login" };
  }
  if (typeof tokens !== "object" || Array.isArray(tokens)) {
    return { withheld: "the Codex auth.json has an unknown shape" };
  }
  const login = { ...(tokens as Record<string, unknown>) };
  const accessToken = typeof login.access_token === "string" ? login.access_token : "";
  const expiresAt = accessToken ? jwtExpiryMs(accessToken) : undefined;
  const usable =
    accessToken !== "" &&
    (expiresAt === undefined || expiresAt - nowMs >= LOGIN_SNAPSHOT_MIN_VALIDITY_MS);
  if (!usable) {
    if (!apiKey) {
      return {
        withheld:
          "the Codex login has expired and a copy may not refresh it; run codex on the host (codex login if it is signed out there), then restart",
      };
    }
    const { tokens: _tokens, last_refresh: _lastRefresh, auth_mode: _authMode, ...rest } = parsed;
    return { text: JSON.stringify(rest) };
  }
  if ("refresh_token" in login) login.refresh_token = "";
  return {
    text: JSON.stringify({
      ...parsed,
      tokens: login,
      last_refresh: new Date(nowMs).toISOString(),
    }),
  };
}

/**
 * Reduce a copy of a Claude Code `.credentials.json` to what may not rotate the
 * original.
 *
 * Anthropic rotates the Claude.ai refresh token on every refresh, and a
 * refresh with a token another copy already spent fails with `invalid_grant`
 * and signs that copy out (anthropics/claude-code#24317, #25609, #54443). The
 * subscription login (`claudeAiOauth`) therefore keeps its access token, about
 * eight hours at issue, and loses its refresh token; an expired one is
 * dropped. The owner keeps such a copy signed in by handing it the original's
 * current access token again, never by refreshing the copy.
 *
 * MCP server logins (`mcpOAuth`) lose their refresh tokens too: Claude Code is
 * a public OAuth client for them, and OAuth 2.1 requires a public client's
 * refresh tokens to rotate. Their access tokens are kept, expired or not, as
 * the server decides whether they still work. Other top-level keys are kept.
 * A file with neither a usable subscription login nor an MCP login is withheld.
 */
export function restrictClaudeCredentialsSnapshot(text: string, nowMs = Date.now()): LoginSnapshot {
  const parsed = parseObject(text);
  if (!parsed) return { withheld: "the Claude credential is not a JSON object" };
  const { claudeAiOauth, mcpOAuth, ...rest } = parsed;
  const restricted: Record<string, unknown> = { ...rest };
  if (claudeAiOauth && typeof claudeAiOauth === "object" && !Array.isArray(claudeAiOauth)) {
    const login = { ...(claudeAiOauth as Record<string, unknown>) };
    const accessToken = typeof login.accessToken === "string" ? login.accessToken.trim() : "";
    const expiresAt = login.expiresAt;
    const usable =
      accessToken !== "" &&
      !(
        typeof expiresAt === "number" &&
        Number.isFinite(expiresAt) &&
        expiresAt - nowMs < LOGIN_SNAPSHOT_MIN_VALIDITY_MS
      );
    if (usable) {
      delete login.refreshToken;
      restricted.claudeAiOauth = login;
    }
  }
  if (mcpOAuth && typeof mcpOAuth === "object" && !Array.isArray(mcpOAuth)) {
    const servers: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(mcpOAuth)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const server = { ...(entry as Record<string, unknown>) };
      delete server.refreshToken;
      servers[key] = server;
    }
    restricted.mcpOAuth = servers;
  }
  const hasMcpLogins = Object.keys((restricted.mcpOAuth as object | undefined) ?? {}).length > 0;
  if (!("claudeAiOauth" in restricted) && !hasMcpLogins) {
    return {
      withheld:
        "the Claude login has expired and a copy may not refresh it; run claude on the host (claude /login if it is signed out there), then restart",
    };
  }
  return { text: JSON.stringify(restricted) };
}

/** The per-provider login files: OpenCode's `auth.json` and Pi's `agent/auth.json`. */
export type ProviderAuthFormat = "opencode" | "pi";

/**
 * OAuth providers whose stored `refresh` is a long-lived token that refreshing
 * reuses rather than rotates, so a copy that refreshes cannot spend the host's.
 * Checked against OpenCode 1.19.0 and Pi 1.4.0 (2026-10-21):
 *
 * - `github-copilot`: `refresh` is the GitHub OAuth token. OpenCode sends it
 *   directly (`access` is the same token, `expires` 0); Pi exchanges it for a
 *   Copilot token that lasts about 30 minutes and keeps it unchanged.
 * - `meta` (Pi): `refresh` is the Meta identity token, which mints a day-long
 *   API key and cannot itself be renewed.
 *
 * Every other OAuth provider is treated as rotating. Anthropic, OpenAI (Codex
 * and ChatGPT), xAI, Kimi and Radius all return a new refresh token on
 * refresh, and the OpenAI and xAI ones are known to be single-use. Pi's
 * OpenRouter login stores an empty `refresh` that never expires, so blanking it
 * changes nothing.
 */
const NON_ROTATING_OAUTH_PROVIDERS: Record<ProviderAuthFormat, ReadonlySet<string>> = {
  opencode: new Set(["github-copilot"]),
  pi: new Set(["github-copilot", "meta"]),
};

/** Entry types that hold a static key and are copied as they are. */
const STATIC_KEY_TYPES: Record<ProviderAuthFormat, ReadonlySet<string>> = {
  opencode: new Set(["api", "wellknown"]),
  pi: new Set(["api_key"]),
};

/**
 * Pi refreshes an OAuth login with less than five minutes left, and OpenCode's
 * xAI login with less than two, so a copy needs more than that to be any use.
 */
export const PROVIDER_AUTH_MIN_VALIDITY_MS = 6 * 60_000;

export interface ProviderAuthEntries {
  /** The entries a copy may hold, keyed by provider. */
  entries: Record<string, unknown>;
  /**
   * Every provider the source holds as an OAuth login with a rotating refresh
   * token, kept or dropped. A copy must not keep a refresh token for any of
   * them, whoever wrote it.
   */
  accessOnly: string[];
  /** Entries left out: expired OAuth logins and entries of an unknown type. */
  dropped: number;
}

const PROVIDER_AUTH_LABEL: Record<ProviderAuthFormat, { name: string; command: string }> = {
  opencode: { name: "OpenCode", command: "opencode" },
  pi: { name: "Pi", command: "pi" },
};

/**
 * Reduce a copy of an OpenCode or Pi login file to what may not rotate the
 * original. Both store `{ type: "oauth", access, refresh, expires }` (expiry
 * in milliseconds) per provider and re-read the file before each request, so
 * a refreshed copy reaches a running agent without a restart.
 *
 * - Static keys (OpenCode `api` and `wellknown`, Pi `api_key`) are kept.
 * - Non-rotating OAuth logins (`NON_ROTATING_OAUTH_PROVIDERS`) are kept whole.
 * - Other OAuth logins keep their access token with `refresh` blanked (still a
 *   string, which both schemas require). One whose access token expires within
 *   `PROVIDER_AUTH_MIN_VALIDITY_MS`, by the earlier of `expires` and a JWT
 *   `exp` (either alone when only one can be read), is dropped.
 * - Entries of any other type are dropped: OpenCode ignores them anyway, and
 *   Pi rejects the whole file over one.
 *
 * A withheld result still carries `accessOnly`, so a copy that already holds
 * one of those logins in full can be blanked even when the host has nothing
 * usable to hand over.
 */
export function restrictProviderAuthEntries(
  format: ProviderAuthFormat,
  text: string,
  nowMs = Date.now(),
): ProviderAuthEntries | { withheld: string; accessOnly: string[] } {
  const label = PROVIDER_AUTH_LABEL[format];
  const parsed = parseObject(text);
  if (!parsed) {
    return { withheld: `the ${label.name} auth.json is not a JSON object`, accessOnly: [] };
  }
  const entries: Record<string, unknown> = {};
  const accessOnly: string[] = [];
  let dropped = 0;
  for (const [provider, value] of Object.entries(parsed)) {
    const entry =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const type = typeof entry?.type === "string" ? entry.type : undefined;
    if (entry && type && STATIC_KEY_TYPES[format].has(type)) {
      entries[provider] = entry;
      continue;
    }
    if (!entry || type !== "oauth") {
      dropped += 1;
      continue;
    }
    if (NON_ROTATING_OAUTH_PROVIDERS[format].has(provider)) {
      entries[provider] = entry;
      continue;
    }
    accessOnly.push(provider);
    const access = typeof entry.access === "string" ? entry.access : "";
    const stored =
      typeof entry.expires === "number" && Number.isFinite(entry.expires) ? entry.expires : NaN;
    const claimed = access ? jwtExpiryMs(access) : undefined;
    const expiresAt =
      claimed !== undefined && Number.isFinite(stored)
        ? Math.min(stored, claimed)
        : (claimed ?? stored);
    if (!access || !(expiresAt - nowMs >= PROVIDER_AUTH_MIN_VALIDITY_MS)) {
      dropped += 1;
      continue;
    }
    entries[provider] = { ...entry, refresh: "" };
  }
  if (Object.keys(entries).length === 0 && dropped > 0) {
    return {
      accessOnly,
      withheld: `the host ${label.name} logins have expired and a copy may not refresh them; run ${label.command} on the host (and sign in again there if it is signed out), then restart`,
    };
  }
  return { entries, accessOnly, dropped };
}

function restrictProviderAuthSnapshot(
  format: ProviderAuthFormat,
  text: string,
  nowMs: number,
): LoginSnapshot {
  const restricted = restrictProviderAuthEntries(format, text, nowMs);
  if ("withheld" in restricted) return { withheld: restricted.withheld };
  return {
    text: JSON.stringify(restricted.entries),
    ...(restricted.dropped > 0 ? { dropped: restricted.dropped } : {}),
  };
}

/** `restrictProviderAuthEntries` for OpenCode's `auth.json`, as file text. */
export function restrictOpenCodeAuthSnapshot(text: string, nowMs = Date.now()): LoginSnapshot {
  return restrictProviderAuthSnapshot("opencode", text, nowMs);
}

/** `restrictProviderAuthEntries` for Pi's `agent/auth.json`, as file text. */
export function restrictPiAuthSnapshot(text: string, nowMs = Date.now()): LoginSnapshot {
  return restrictProviderAuthSnapshot("pi", text, nowMs);
}

/** Names the entrypoint needs to blank a container copy the same way. */
export function nonRotatingOAuthProviders(format: ProviderAuthFormat): readonly string[] {
  return [...NON_ROTATING_OAUTH_PROVIDERS[format]];
}
