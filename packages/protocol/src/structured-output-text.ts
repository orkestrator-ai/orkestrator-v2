/**
 * Recover a JSON value from a model’s structured-output text.
 *
 * Providers that enforce a schema natively (Claude, Codex app-server) already
 * isolate the contract payload. Cursor/Grok ACP and OpenCode’s text fallback
 * concatenate the assistant’s visible text, which often includes a thinking
 * prefix, a Markdown fence, or a short lead-in/trailing sentence. Domain
 * validation still happens above this layer — this only answers whether the
 * text contains a recoverable JSON document.
 *
 * `undefined` is the sentinel for “not JSON” because `JSON.parse` never
 * produces `undefined`.
 */

/** Caps the recovery scan so pathological output cannot become unbounded work. */
export const STRUCTURED_OUTPUT_RECOVERY_CHARS = 1024 * 1024;
/**
 * Incomplete `{` / `[` fragments in a thinking prefix (schema sketches, truncated
 * examples) each cost a scan. A long reasoning trace discussing JSON Schema
 * routinely exceeds the original 16-candidate budget and would otherwise abort
 * before reaching the real document at the end.
 */
export const STRUCTURED_OUTPUT_RECOVERY_CANDIDATES = 256;

const WHOLE_JSON_FENCE = /^```(?:json[5c]?)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i;
const THINKING_CLOSE = /<\/(?:thinking|thought|reasoning|think)>/gi;

/**
 * Try to parse `candidate` as a JSON value. `undefined` is the sentinel for
 * "not JSON" because `JSON.parse` never produces `undefined`.
 */
function tryParseJson(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Extract the well-formed JSON document that begins at `start` in `text`, if
 * one exists, by tracking bracket balance outside of string literals.
 */
function parseJsonDocumentAt(
  text: string,
  start: number,
): { value: unknown; end: number } | undefined {
  const open = text[start];
  if (open !== "{" && open !== "[") return undefined;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const value = tryParseJson(text.slice(start, i + 1));
        return value === undefined ? undefined : { value, end: i };
      }
    }
  }
  return undefined;
}

/**
 * Index to begin the last-document scan. A thinking block that the model dumped
 * into the text channel (instead of `agent_thought_chunk`) often closes with
 * `</thinking>` before the contract JSON. Scanning after that close avoids
 * spending the candidate budget on schema sketches inside the trace. If the
 * close tag is the end of the message, the JSON was inside the block and the
 * scan starts at 0.
 */
function recoveryScanStart(text: string): number {
  let start = 0;
  THINKING_CLOSE.lastIndex = 0;
  for (const match of text.matchAll(THINKING_CLOSE)) {
    start = (match.index ?? 0) + match[0].length;
  }
  return text.slice(start).trim().length > 0 ? start : 0;
}

/**
 * Last-resort recovery for a model that wrapped the required JSON document in
 * prose (a thinking prefix, a lead-in sentence, or a trailing summary).
 * Successful outer documents are skipped as whole spans so their nested objects
 * and arrays cannot replace them. The last well-formed outer document wins, and
 * arbitrary prose is never interpreted as JSON.
 */
function lastWellFormedJson(text: string): unknown {
  const scanned = text.slice(0, STRUCTURED_OUTPUT_RECOVERY_CHARS);
  let failedCandidates = 0;
  let recovered: unknown;
  for (let i = recoveryScanStart(scanned); i < scanned.length; i++) {
    const ch = scanned[i];
    if (ch !== "{" && ch !== "[") continue;
    const parsed = parseJsonDocumentAt(scanned, i);
    if (parsed !== undefined) {
      recovered = parsed.value;
      i = parsed.end;
      continue;
    }
    failedCandidates += 1;
    if (failedCandidates >= STRUCTURED_OUTPUT_RECOVERY_CANDIDATES) break;
  }
  return recovered;
}

/**
 * Parse a schema-constrained assistant payload from raw text.
 *
 * Accepts a bare JSON value, one outer Markdown fence, or the last well-formed
 * JSON object/array embedded in thinking or commentary. Returns `undefined`
 * when no document can be recovered.
 */
export function tryParseStructuredOutputText(text: string): unknown {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return undefined;

  const exact = tryParseJson(trimmed);
  if (exact !== undefined) return exact;

  const fenced = WHOLE_JSON_FENCE.exec(trimmed)?.[1]?.trim();
  if (fenced !== undefined) {
    const fencedValue = tryParseJson(fenced);
    if (fencedValue !== undefined) return fencedValue;
  }

  return lastWellFormedJson(trimmed);
}
