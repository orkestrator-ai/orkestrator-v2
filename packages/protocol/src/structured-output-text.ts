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
const THINKING_OPEN = /<(thinking|thought|reasoning|think)>/gi;

interface IndexRange {
  start: number;
  end: number;
}

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

/** True when `index` falls inside a thinking wrapper that should not start a JSON candidate. */
function indexInRange(index: number, ranges: readonly IndexRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

/**
 * Locate thinking wrappers dumped into the text channel. An opening tag counts
 * only at the start of the text or after whitespace so `</thinking>` inside a
 * JSON string or trailing commentary cannot become a scan boundary.
 */
function findThinkingWrappers(text: string): IndexRange[] {
  const wrappers: IndexRange[] = [];
  THINKING_OPEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = THINKING_OPEN.exec(text)) !== null) {
    const atBoundary = match.index === 0 || /\s/.test(text[match.index - 1] ?? "");
    if (!atBoundary) {
      continue;
    }
    const close = new RegExp(`</${match[1]}>`, "i");
    const closeMatch = close.exec(text.slice(match.index + match[0].length));
    if (closeMatch === null) {
      continue;
    }
    const end = match.index + match[0].length + closeMatch.index + closeMatch[0].length;
    wrappers.push({ start: match.index, end });
    THINKING_OPEN.lastIndex = end;
  }
  return wrappers;
}

/**
 * Last well-formed outer document in `text`. `{` / `[` inside `skip` do not
 * start a candidate, so a tagged thinking block cannot replace JSON that
 * already appeared outside it. Successful outer documents are skipped as whole
 * spans so nested objects and arrays cannot replace them.
 */
function lastWellFormedJsonIn(text: string, skip: readonly IndexRange[]): unknown {
  let failedCandidates = 0;
  let recovered: unknown;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    if (indexInRange(i, skip)) continue;
    const parsed = parseJsonDocumentAt(text, i);
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
 * Last-resort recovery for a model that wrapped the required JSON document in
 * prose (a thinking prefix, a lead-in sentence, or a trailing summary).
 * Documents outside tagged thinking blocks win; the block interior is scanned
 * only when nothing else is recoverable. Arbitrary prose is never interpreted
 * as JSON.
 */
function lastWellFormedJson(text: string): unknown {
  const scanned = text.slice(0, STRUCTURED_OUTPUT_RECOVERY_CHARS);
  const wrappers = findThinkingWrappers(scanned);
  const outside = lastWellFormedJsonIn(scanned, wrappers);
  if (outside !== undefined) return outside;
  return lastWellFormedJsonIn(scanned, []);
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
