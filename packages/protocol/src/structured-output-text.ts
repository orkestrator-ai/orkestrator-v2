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
/**
 * Caps how many thinking tags are collected. Tag discovery is linear, but the
 * bound keeps the wrapper list itself explicitly sized, so output that is
 * nothing but tags degrades to the untagged scan instead of growing the skip
 * list with the input.
 */
export const STRUCTURED_OUTPUT_RECOVERY_TAGS = 256;

const THINKING_TAGS = "thinking|thought|reasoning|think";

const WHOLE_JSON_FENCE = /^```(?:json[5c]?)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i;
/**
 * Attributes are tolerated and nothing is required in front of the tag:
 * providers wrap it in Markdown emphasis (`**<thinking>**`), run it onto the
 * preceding word, or annotate it (`<thinking type="x">`). A wrapper missed for
 * any of those reasons hands back the trace instead of the payload.
 */
const THINKING_OPEN = new RegExp(`<(${THINKING_TAGS})(?:\\s[^>]*)?>`, "gi");
const THINKING_CLOSE = new RegExp(`</(${THINKING_TAGS})[ \\t]*>`, "gi");

interface IndexRange {
  start: number;
  end: number;
}

interface TagMatch {
  index: number;
  end: number;
  tag: string;
}

/** Outcome of one recovery scan. `exhausted` means the candidate budget stopped it early. */
interface ScanResult {
  value: unknown;
  exhausted: boolean;
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

/**
 * Collect every thinking tag `pattern` matches, in order, up to
 * `STRUCTURED_OUTPUT_RECOVERY_TAGS`. One linear pass: the regex is never
 * re-run over a slice of the remaining text.
 */
function collectThinkingTags(text: string, pattern: RegExp): TagMatch[] {
  const matches: TagMatch[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (matches.length >= STRUCTURED_OUTPUT_RECOVERY_TAGS) break;
    const index = match.index ?? 0;
    matches.push({
      index,
      end: index + match[0].length,
      tag: match[1]?.toLowerCase() ?? "",
    });
  }
  return matches;
}

/**
 * Pair thinking tags dumped into the text channel into ordered, non-overlapping
 * ranges. Both lists are already ordered, so one cursor per tag name pairs every
 * wrapper in a single forward walk. An opening tag whose close never arrived
 * (truncated output) runs to the end of the text — the trailing full-text scan
 * still recovers a payload that turns out to live inside it.
 */
function pairThinkingWrappers(
  opens: readonly TagMatch[],
  closes: readonly TagMatch[],
  length: number,
): IndexRange[] {
  const wrappers: IndexRange[] = [];
  const cursors = new Map<string, number>();
  let coveredThrough = 0;
  for (const open of opens) {
    // Tags nested inside a wrapper already taken are covered by that range.
    if (open.index < coveredThrough) continue;
    let cursor = cursors.get(open.tag) ?? 0;
    while (
      cursor < closes.length
      && (closes[cursor]!.index < open.end || closes[cursor]!.tag !== open.tag)
    ) {
      cursor += 1;
    }
    cursors.set(open.tag, Math.min(cursor + 1, closes.length));
    coveredThrough = cursor < closes.length ? closes[cursor]!.end : length;
    wrappers.push({ start: open.index, end: coveredThrough });
    if (coveredThrough >= length) break;
  }
  return wrappers;
}

/**
 * End of the last close tag that no wrapper explains. A thinking trace whose
 * opening tag never reached the text channel still closes with `</thinking>`
 * before the contract JSON, so that close is the only marker separating the
 * trace from the payload. It is a weak signal — a close tag also appears inside
 * JSON strings and in prose — so callers use it only to retry a scan that the
 * candidate budget already aborted.
 */
function unmatchedCloseEnd(
  closes: readonly TagMatch[],
  wrappers: readonly IndexRange[],
): number {
  let end = 0;
  let cursor = 0;
  for (const close of closes) {
    while (cursor < wrappers.length && wrappers[cursor]!.end <= close.index) cursor += 1;
    const wrapper = wrappers[cursor];
    if (wrapper !== undefined && close.index >= wrapper.start) continue;
    end = close.end;
  }
  return end;
}

/** Merge `[0, prefixEnd)` into `wrappers`, preserving order and disjointness. */
function withPrefixSkipped(prefixEnd: number, wrappers: readonly IndexRange[]): IndexRange[] {
  let end = prefixEnd;
  let index = 0;
  while (index < wrappers.length && wrappers[index]!.start <= end) {
    end = Math.max(end, wrappers[index]!.end);
    index += 1;
  }
  return [{ start: 0, end }, ...wrappers.slice(index)];
}

/**
 * Last well-formed outer document in `text`. `{` / `[` inside `skip` do not
 * start a candidate, so a tagged thinking block cannot replace JSON that
 * already appeared outside it. Successful outer documents are skipped as whole
 * spans so nested objects and arrays cannot replace them.
 */
function lastWellFormedJsonIn(text: string, skip: readonly IndexRange[]): ScanResult {
  let failedCandidates = 0;
  let recovered: unknown;
  let skipCursor = 0;
  for (let i = 0; i < text.length; i++) {
    // `skip` is ordered and non-overlapping, so one forward cursor answers every
    // membership test without rescanning the list per candidate.
    while (skipCursor < skip.length && skip[skipCursor]!.end <= i) skipCursor += 1;
    const range = skip[skipCursor];
    if (range !== undefined && i >= range.start) {
      i = range.end - 1;
      continue;
    }
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const parsed = parseJsonDocumentAt(text, i);
    if (parsed !== undefined) {
      recovered = parsed.value;
      i = parsed.end;
      continue;
    }
    failedCandidates += 1;
    if (failedCandidates >= STRUCTURED_OUTPUT_RECOVERY_CANDIDATES) {
      return { value: recovered, exhausted: true };
    }
  }
  return { value: recovered, exhausted: false };
}

/**
 * Last-resort recovery for a model that wrapped the required JSON document in
 * prose (a thinking prefix, a lead-in sentence, or a trailing summary).
 * Arbitrary prose is never interpreted as JSON. Three tiers, in order:
 *
 * 1. Outside the tagged thinking blocks, so a trace cannot replace a payload
 *    that already appeared outside it.
 * 2. Only when tier 1 spent its candidate budget without recovering anything:
 *    the same scan with everything up to the last unexplained `</thinking>`
 *    skipped. Tier 1 scans a superset of tier 2, so this tier can only ever add
 *    a result the budget denied — the schema sketches of a trace whose opening
 *    tag never reached the text channel.
 * 3. The whole text, for a payload that only exists inside a thinking block.
 */
function lastWellFormedJson(text: string): unknown {
  const scanned = text.slice(0, STRUCTURED_OUTPUT_RECOVERY_CHARS);
  const opens = collectThinkingTags(scanned, THINKING_OPEN);
  const closes = collectThinkingTags(scanned, THINKING_CLOSE);
  const wrappers = pairThinkingWrappers(opens, closes, scanned.length);

  const outside = lastWellFormedJsonIn(scanned, wrappers);
  if (outside.value !== undefined) return outside.value;

  if (outside.exhausted) {
    const prefixEnd = unmatchedCloseEnd(closes, wrappers);
    if (prefixEnd > 0) {
      const afterTrace = lastWellFormedJsonIn(scanned, withPrefixSkipped(prefixEnd, wrappers));
      if (afterTrace.value !== undefined) return afterTrace.value;
    }
  }

  // Tier 1 already covered the whole text when nothing was skipped.
  if (wrappers.length === 0) return undefined;
  return lastWellFormedJsonIn(scanned, []).value;
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
