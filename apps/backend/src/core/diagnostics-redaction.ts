import { redactBridgeLogLine, redactBridgeOutput } from "./bridge-output-redaction.js";

/**
 * The pass everything in a diagnostics bundle goes through on its way out.
 *
 * By shape, like the rules it builds on (`redactBridgeOutput`), and a bundle is a
 * file someone may attach to a public issue, so this errs towards removing too
 * much: a long hash goes along with a long token. It is still not a proof. A
 * credential or private text with no recognisable shape survives, and the
 * manifest says so wherever it is shown.
 *
 * {@link containsCredentialShape} is the check after it. A file that still
 * matches is left out of the bundle rather than written.
 */

const REDACTED = "[redacted]";
const HOME = "~";

/** What the machine itself contributes to a line, beyond its shapes. */
export interface RedactionContext {
  homeDir: string;
  dataDir: string;
  userName: string;
  hostName: string;
}

/** Longest line kept, measured after redaction so a cut never halves a token. */
export const MAX_REDACTED_LINE_CHARS = 64 * 1024;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SECRET_KEYS =
  "api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|passphrase|authorization|credential|credentials|private[_-]?key|cookie|session[_-]?key";

/**
 * On top of `redactBridgeOutput`'s rules: the same key shapes without its word
 * boundaries, so `MY_ghp_…` and `task-sk-…` still count; forms a log's JSON
 * escaping hides; and values no shape rule there covers.
 */
const SHAPE_RULES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /gh[pousr]_[A-Za-z0-9]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /glpat-[A-Za-z0-9_-]{8,}/g,
  /npm_[A-Za-z0-9]{16,}/g,
  /(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g,
  /xox[baprse]-[A-Za-z0-9-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{6,})?/g,
  // An escaped header or a short bearer value, which the 8-character rule leaves.
  /\b(?:Bearer|Basic|Token)\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{1,}/gi,
  // Opaque, whatever it is. No slash, so an ordinary path is not one run.
  /(?<![A-Za-z0-9_+=-])(?=[A-Za-z0-9_+=-]*[0-9])(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+=-]{40,}/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
];

/** `token\":\"abc`, `password = abc` and the rest, escaped or not. */
const SECRET_ASSIGNMENT = new RegExp(
  `((?:${SECRET_KEYS})(?:\\\\*")?\\s*[:=]\\s*(?:\\\\*")?)(?!\\[redacted\\])[^\\s"',;)&\\\\]{1,}`,
  "gi",
);

/** `Cookie: a=b; c=d` and `Set-Cookie: …` to the end of the line. */
const COOKIE_HEADER = /\b((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi;

const HOME_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // POSIX homes, and a `file://` or a JSON-escaped form of them.
  { pattern: /(?:\/var|\/export)?\/home\/[^/\s"'`:;,)\]\\]+/g, replacement: HOME },
  { pattern: /\/Users\/[^/\s"'`:;,)\]\\]+/g, replacement: HOME },
  { pattern: /(?<![A-Za-z0-9_.-])\/root(?=[/\s"'`:;,)\]\\]|$)/gm, replacement: HOME },
  // Windows, with one backslash or a JSON-escaped pair.
  { pattern: /\b[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/)[^\\/\s"'`:;,)\]]+/gi, replacement: HOME },
];

export interface RedactedText {
  text: string;
  redactions: number;
}

function countOf(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    count += 1;
  }
  return count;
}

export class DiagnosticsRedactor {
  private readonly literals: ReadonlyArray<{ pattern: RegExp; replacement: string }>;

  constructor(context: RedactionContext) {
    const literal = (value: string, replacement: string) =>
      value.length >= 3 ? [{ pattern: new RegExp(escapeRegExp(value), "gi"), replacement }] : [];
    const word = (value: string, replacement: string) =>
      value.length >= 3
        ? [
            {
              pattern: new RegExp(
                `(?<![A-Za-z0-9_-])${escapeRegExp(value)}(?![A-Za-z0-9_-])`,
                "gi",
              ),
              replacement,
            },
          ]
        : [];
    this.literals = [
      // The data directory first: it usually sits under the home directory.
      ...literal(context.dataDir, "<data-dir>"),
      ...literal(context.homeDir, HOME),
      ...word(context.userName, "<user>"),
      ...word(context.hostName, "<host>"),
    ];
  }

  /** One piece of text. Run the credential rules before the rules that shorten it. */
  text(input: string): RedactedText {
    let redactions = 0;
    const count = () => {
      redactions += 1;
      return REDACTED;
    };
    const before = countOf(input, REDACTED);
    let text = redactBridgeOutput(input);
    redactions += Math.max(0, countOf(text, REDACTED) - before);
    for (const pattern of SHAPE_RULES) text = text.replace(pattern, count);
    text = text.replace(COOKIE_HEADER, (_match, key: string) => {
      redactions += 1;
      return `${key}${REDACTED}`;
    });
    text = text.replace(SECRET_ASSIGNMENT, (_match, key: string) => {
      redactions += 1;
      return `${key}${REDACTED}`;
    });
    for (const { pattern, replacement } of [...this.literals, ...HOME_RULES]) {
      text = text.replace(pattern, () => {
        redactions += 1;
        return replacement;
      });
    }
    return { text, redactions };
  }

  /**
   * One log line. A JSON record is redacted field by field first, so a credential
   * its escaping hides is seen in its decoded form; then as text. A line is cut
   * only afterwards.
   */
  line(input: string): RedactedText {
    const decoded = redactBridgeLogLine(input);
    const { text, redactions } = this.text(decoded);
    const bounded =
      text.length > MAX_REDACTED_LINE_CHARS
        ? `${text.slice(0, MAX_REDACTED_LINE_CHARS)} [line cut]`
        : text;
    return { text: bounded, redactions };
  }

  /** Strings and keys of a JSON-shaped value, so what comes out is still valid JSON. */
  value(input: unknown): { value: unknown; redactions: number } {
    let redactions = 0;
    const walk = (node: unknown, depth: number): unknown => {
      if (typeof node === "string") {
        const redacted = this.text(node);
        redactions += redacted.redactions;
        return redacted.text;
      }
      if (typeof node !== "object" || node === null) return node;
      if (depth > 32) return REDACTED;
      if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) {
        const redactedKey = this.text(key);
        redactions += redactedKey.redactions;
        output[redactedKey.text] = walk(item, depth + 1);
      }
      return output;
    };
    return { value: walk(input, 0), redactions };
  }
}

const RESIDUAL: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{8,}/,
  /github_pat_[A-Za-z0-9_]{8,}/,
  /(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{4,}/i,
  /xox[baprse]-[A-Za-z0-9-]{8,}/,
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/,
  /AKIA[0-9A-Z]{12,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\/home\/[^/\s"'`:;,)\]\\]+/,
  /\/Users\/[^/\s"'`:;,)\]\\]+/,
  /\b[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/)[^\\/\s"'`:;,)\]]+/i,
];

/** Whether text still looks like it holds a credential or a home directory. */
export function containsCredentialShape(text: string): boolean {
  return RESIDUAL.some((pattern) => pattern.test(text));
}
