/**
 * Redaction for text the bridge captures from the engine and serves over HTTP.
 *
 * The bridge requires a per-process bearer token and restricts browser origins.
 * Redaction remains a second layer of defence: authenticated snapshot consumers
 * still should not receive credentials embedded in provider diagnostics.
 *
 * One pass, by *shape*: a bearer token, an `sk-`/`ghp_` style key, URL userinfo
 * or a query-string credential embedded in free text — typically an MCP server's
 * startup error, which is the single most likely place for a real token to
 * surface. Structured engine payloads never leave the process raw: they go
 * through the allowlists in `app-server-engine.ts`, which drop unknown fields
 * instead of trying to redact them.
 *
 * Best-effort. It exists to stop the common cases leaving the process, not to
 * make an untrusted reader safe.
 */

/** Applied in order; earlier rules consume the text later ones would match. */
const TEXT_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  // scheme://user:password@host — the password is the point, but the username is
  // identity, so both go.
  {
    pattern: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi,
    replacement: "$1[redacted]@",
  },
  // ?token=… / &api_key=… in a URL or a log line that contains one.
  {
    pattern:
      /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|auth|authorization|token|secret|password|passwd|signature|sig|key)=)[^&\s"'`]+/gi,
    replacement: "$1[redacted]",
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "Bearer [redacted]" },
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
