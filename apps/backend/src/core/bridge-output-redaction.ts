/**
 * Scrubbing a local bridge's stdout and stderr before the backend logs it.
 *
 * The backend re-emits that output through its own logger, and with
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
 * Lines are reassembled before redaction by the splitter the desktop's relay
 * uses too, bounded so a bridge that never prints a newline cannot grow the
 * buffer.
 */
import {
  PROCESS_OUTPUT_LINE_LIMIT,
  createBoundedLineSplitter,
} from "@orkestrator/protocol/node/bounded-line-splitter";
import {
  emitLogRecord,
  parseLogRecordLine,
  writeProcessOutputLine,
  type LogRecord,
} from "@orkestrator/protocol/logger";
import { redactSecrets } from "@orkestrator/protocol/secret-redaction";

const EXTRA_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bxai-[A-Za-z0-9_-]{16,}/g, replacement: "[redacted]" },
  // Cursor API keys and OpenAI refresh tokens.
  { pattern: /\bkey_[A-Za-z0-9_]{24,}/g, replacement: "[redacted]" },
  { pattern: /\brt_[A-Za-z0-9_.-]{24,}/g, replacement: "[redacted]" },
];

/** Longest partial line held back waiting for its newline. */
export const BRIDGE_OUTPUT_LINE_LIMIT = PROCESS_OUTPUT_LINE_LIMIT;

export function redactBridgeOutput(text: string): string {
  let result = redactSecrets(text);
  for (const rule of EXTRA_RULES) {
    result = result.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replacement);
  }
  return result;
}

/** Redact decoded strings, including nested fields and escaped credential syntax. */
function redactBridgeLogRecord(record: LogRecord): LogRecord {
  return JSON.parse(
    JSON.stringify(record, (_key, value: unknown) =>
      typeof value === "string" ? redactBridgeOutput(value) : value,
    ),
  ) as LogRecord;
}

/** Same decoded-record protection as the local relay, with raw fallback. */
export function redactBridgeLogLine(line: string): string {
  const record = parseLogRecordLine(line);
  return record ? JSON.stringify(redactBridgeLogRecord(record)) : redactBridgeOutput(line);
}

/**
 * Turn a byte stream into redacted whole lines for `write`, one line per call.
 * Call `flush` when the stream ends so a final line without a newline is not
 * lost.
 */
export function createBridgeOutputForwarder(
  write: (text: string) => void,
  limit = BRIDGE_OUTPUT_LINE_LIMIT,
): { push: (chunk: Buffer | string) => void; flush: () => void } {
  // A line cut at the limit can split a token; that is the accepted cost of
  // keeping the buffer bounded.
  return createBoundedLineSplitter((line) => write(redactBridgeOutput(line)), limit);
}

/**
 * One forwarded chunk of already redacted output, which may hold several lines.
 * Each is its own entry, because a bridge's multi-line chunk can mix records with
 * unstructured output. The forwarder's raw pass protects unstructured output;
 * recognized records also need a decoded pass because JSON escapes can hide
 * credential syntax. The parser bounds fields, error causes and stack frames.
 */
export function relayBridgeOutput(stream: "stdout" | "stderr", source: string, text: string): void {
  for (const line of text.split("\n")) {
    if (!line) continue;
    const record = parseLogRecordLine(line);
    if (record) {
      const redacted = redactBridgeLogRecord(record);
      // First, so a record already at the field limit keeps it through the next relay.
      const { source: _claimed, ...fields } = redacted.fields ?? {};
      emitLogRecord({ ...redacted, fields: { source, ...fields } });
    } else {
      writeProcessOutputLine(stream, `[${source}] ${line}`);
    }
  }
}
