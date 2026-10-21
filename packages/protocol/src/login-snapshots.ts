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
 * Both functions only read JSON and return a replacement text, or a reason to
 * copy nothing. A reason never contains credential material.
 */

export type LoginSnapshot = { text: string } | { withheld: string };

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
