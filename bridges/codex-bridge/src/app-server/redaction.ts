/**
 * Redaction for payloads the bridge serves over HTTP.
 *
 * The bridge listens on localhost with `cors({ origin: "*" })`, an
 * `Access-Control-Allow-Private-Network` opt-in and no authentication, so any
 * page the user happens to have open can read a snapshot endpoint. Changing that
 * model is a separate decision; what this file guarantees is that the *content*
 * of those snapshots does not carry credentials.
 *
 * Two independent passes, because secrets appear in two different shapes:
 *
 *   - by *name*: a field literally called `authorization`, `apiKey`, `headers`
 *     or `env`, whose value is a credential whatever it looks like;
 *   - by *shape*: a bearer token, an `sk-`/`ghp_` style key, URL userinfo or a
 *     query-string credential embedded in free text — typically an MCP server's
 *     startup error, which is the single most likely place for a real token to
 *     surface.
 *
 * Both are best-effort. They exist to stop the common cases leaving the process,
 * not to make an untrusted reader safe.
 */

/** Applied in order; earlier rules consume the text later ones would match. */
const TEXT_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  // scheme://user:password@host — the password is the point, but the username is
  // identity, so both go.
  {
    pattern: /([a-z][a-z0-9+.\-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi,
    replacement: "$1[redacted]@",
  },
  // ?token=… / &api_key=… in a URL or a log line that contains one.
  {
    pattern:
      /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|auth|authorization|token|secret|password|passwd|signature|sig|key)=)[^&\s"'`]+/gi,
    replacement: "$1[redacted]",
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=\-]{8,}/gi, replacement: "Bearer [redacted]" },
  { pattern: /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, replacement: "Basic [redacted]" },
  // JWTs: three base64url segments. Matched before the generic key rules so a
  // token in an `Authorization:` header line is not partially replaced.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    replacement: "[redacted]",
  },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: "[redacted]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: "[redacted]" },
  { pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, replacement: "[redacted]" },
  { pattern: /\bxox[baprse]-[A-Za-z0-9-]{8,}/g, replacement: "[redacted]" },
  { pattern: /\bAKIA[0-9A-Z]{12,}/g, replacement: "[redacted]" },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}/g, replacement: "[redacted]" },
  /**
   * `api_key: "…"`, `OPENAI_API_KEY=…`, `password: …` in prose or a config dump.
   *
   * The leading `(?:[A-Za-z0-9]+[_-])*` matters: `\bAPI_KEY` never matches inside
   * `OPENAI_API_KEY`, because `_` is a word character and there is no boundary
   * before `API`. The lookahead keeps this from swallowing an auth *scheme* whose
   * token an earlier rule has already replaced, and `&` is excluded from the
   * value so it stops at the end of one query parameter.
   */
  {
    pattern:
      /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|passphrase|authorization))("?\s*[:=]\s*)("?)(?!Bearer\b|Basic\b|\[redacted\])[^\s"',;)&]{6,}\3/gi,
    replacement: "$1$2[redacted]",
  },
];

/** Redacts credential-shaped substrings from one string. */
export function redactSecrets(value: string): string {
  let result = value;
  for (const rule of TEXT_RULES) {
    // A fresh RegExp per call: the module-level literals carry /g state.
    result = result.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replacement);
  }
  return result;
}

/**
 * Field names whose *value* is a credential regardless of its shape.
 *
 * `env` and `headers` are here because an MCP server or hook definition carries
 * its whole environment and header map, which is where a real API key lives.
 */
const SECRET_KEY_PATTERN =
  /^(?:authorization|auth|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|passphrase|credential|credentials|cookie|cookies|bearer|env|environment|headers|private[_-]?key)$/i;

/** Fields that describe *how* a server authenticates. Not credentials, but not ours to publish. */
const AUTH_STATUS_KEY_PATTERN = /^(?:authStatus|auth_status|authMethod|auth_mode)$/i;

/** Bounds the walk so a hostile or pathological payload cannot pin the event loop. */
const MAX_DEPTH = 12;
const MAX_NODES = 20_000;

/**
 * Deep-redacts a JSON-ish value.
 *
 * Returns a *copy*: the caller's retained state (the notice ring, an engine
 * response) must not be mutated by serving it.
 */
export function redactSecretsDeep<T>(
  value: T,
  options: { dropAuthStatus?: boolean } = {},
): T {
  let nodes = 0;

  const walk = (input: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) return "[redacted: truncated]";
    if (typeof input === "string") return redactSecrets(input);
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map((entry) => walk(entry, depth + 1));

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      if (options.dropAuthStatus && AUTH_STATUS_KEY_PATTERN.test(key)) continue;
      if (SECRET_KEY_PATTERN.test(key)) {
        output[key] = entry === null || entry === undefined ? entry : "[redacted]";
        continue;
      }
      output[key] = walk(entry, depth + 1);
    }
    return output;
  };

  return walk(value, 0) as T;
}
