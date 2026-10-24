/**
 * Scrubbing a local bridge's stdout and stderr before the backend logs it.
 *
 * The backend forwards that output to `console.debug`/`console.error`, and with
 * Debug logging on `application-logging.ts` writes it to `<dataDir>/logs`. No
 * bridge prints auth data today, and the auth canary tests hold each auth path
 * to that; this covers a log line nobody has written yet.
 *
 * By shape, like `redactSecrets`, plus the key shapes only a bridge's provider
 * would print (xAI, Cursor, OpenAI refresh tokens). Best-effort: a bare OAuth
 * code or device code has no shape to recognise, so the guard for those stays
 * the rule that bridges never log them.
 *
 * Output arrives in arbitrary chunks, so a token can straddle two of them.
 * Lines are reassembled before redaction, bounded so a bridge that never
 * prints a newline cannot grow the buffer.
 */
import { redactSecrets } from "@orkestrator/protocol/secret-redaction";

const EXTRA_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bxai-[A-Za-z0-9_-]{16,}/g, replacement: "[redacted]" },
  // Cursor API keys and OpenAI refresh tokens.
  { pattern: /\bkey_[A-Za-z0-9_]{24,}/g, replacement: "[redacted]" },
  { pattern: /\brt_[A-Za-z0-9_.-]{24,}/g, replacement: "[redacted]" },
];

/** Longest partial line held back waiting for its newline. */
export const BRIDGE_OUTPUT_LINE_LIMIT = 64 * 1024;

export function redactBridgeOutput(text: string): string {
  let result = redactSecrets(text);
  for (const rule of EXTRA_RULES) {
    result = result.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replacement);
  }
  return result;
}

/**
 * Turn a byte stream into redacted whole lines for `write`. Call `flush` when
 * the stream ends so a final line without a newline is not lost.
 */
export function createBridgeOutputForwarder(
  write: (text: string) => void,
  limit = BRIDGE_OUTPUT_LINE_LIMIT,
): { push: (chunk: Buffer | string) => void; flush: () => void } {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk.toString();
      const end = pending.lastIndexOf("\n");
      if (end >= 0) {
        const complete = pending.slice(0, end);
        pending = pending.slice(end + 1);
        write(redactBridgeOutput(complete));
      }
      if (pending.length > limit) {
        // Cut at the limit rather than lose output; a token split here is the
        // accepted cost of keeping the buffer bounded.
        const head = pending;
        pending = "";
        write(redactBridgeOutput(head));
      }
    },
    flush() {
      if (!pending) return;
      const rest = pending;
      pending = "";
      write(redactBridgeOutput(rest));
    },
  };
}
