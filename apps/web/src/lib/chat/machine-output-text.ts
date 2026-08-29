/**
 * Recognizes agent text that is a machine-readable document rather than prose.
 *
 * A schema-constrained turn asks the provider for one JSON document as its
 * final answer. Providers differ in how they get there: Claude calls a tool,
 * while Codex, Cursor, and Grok write the document into the ordinary text
 * channel — and re-write a longer draft of it on every progress update. Those
 * drafts stream in character by character, so for most of their life they are
 * neither valid JSON (nothing downstream can fold them into a report view) nor
 * prose (rendering them shows the reader a wall of raw JSON).
 *
 * This module answers the only question that separates the two cases: has the
 * document finished, and is it JSON at all. It reads delimiters rather than
 * parsing, so a multi-megabyte draft costs one linear scan and no allocation —
 * `JSON.parse` on every streamed frame of a growing report is precisely the
 * cost this view cannot pay.
 */

/**
 * `not-json`: does not open as a JSON document, so it is prose.
 * `incomplete`: opens as one and its delimiters never close — still streaming.
 * `complete`: one or more same-line adjacent root documents all close, with no prose.
 */
export type JsonDocumentState = "not-json" | "incomplete" | "complete";

interface JsonDocumentScan {
  state: JsonDocumentState;
  /** Last root document, only when the entire machine-output sequence closed. */
  lastDocument?: string;
}

/** Opening fence of a JSON code block, which providers sometimes wrap around it. */
const OPENING_JSON_FENCE = /^```(?:json[5c]?)?[ \t]*\r?\n/i;
const CLOSING_FENCE = /\r?\n?```$/;

/**
 * Classify `text` as prose, an unfinished JSON document, or a finished one.
 *
 * Delimiter-accurate rather than grammar-accurate: string literals and their
 * escapes are tracked so a brace inside a string cannot close the document,
 * but `{"a": bad}` reads as `complete` because its braces balance. That is the
 * right bias here — the caller uses this to decide whether text is the
 * provider's machine output, and a malformed document is still machine output.
 */
function scanJsonDocuments(text: string): JsonDocumentScan {
  let candidate = text.trim();
  const fenced = OPENING_JSON_FENCE.test(candidate);
  if (fenced) {
    candidate = candidate.replace(OPENING_JSON_FENCE, "").replace(CLOSING_FENCE, "").trim();
  }
  const opening = candidate[0];
  if (opening !== "{" && opening !== "[") return { state: "not-json" };

  let depth = 0;
  let inString = false;
  let escaped = false;
  let documentStart = 0;

  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      depth -= 1;
      // Closed below its opening delimiter: this is not a single JSON document,
      // so it is not the provider's machine output.
      if (depth < 0) return { state: "not-json" };
      if (depth === 0) {
        const lastDocument = candidate.slice(documentStart, index + 1);
        let next = index + 1;
        while (candidate[next] !== undefined && /\s/.test(candidate[next]!)) next += 1;
        if (next >= candidate.length) return { state: "complete", lastDocument };
        // Codex can append each schema-constrained progress response to the
        // same text item. That is still machine output, not prose following a
        // JSON snippet. Keep scanning so an unfinished final document remains
        // classified as incomplete and a closed sequence can expose its last
        // document to the accepted-result filter.
        if (candidate[next] === "{" || candidate[next] === "[") {
          const separator = candidate.slice(index + 1, next);
          // A newline-separated sequence is JSONL, and a fenced sequence was
          // deliberately presented as source. Keep both visible rather than
          // silently treating them as provider verdict revisions. Codex's
          // appended schema responses arrive unfenced on the same line.
          if (fenced || /[\r\n]/.test(separator)) return { state: "not-json" };
          documentStart = next;
          index = next - 1;
          continue;
        }
        // Anything else is prose wrapped around a JSON snippet. Markdown
        // renders that correctly and it stays visible.
        return { state: "not-json" };
      }
    }
  }

  // Ran out of text inside the document (or inside one of its strings).
  return { state: "incomplete" };
}

export function jsonDocumentState(text: string): JsonDocumentState {
  return scanJsonDocuments(text).state;
}

/**
 * Last document from text made entirely of one or more closed JSON roots.
 *
 * The caller still parses and validates this source against its own contract;
 * delimiter balance here only identifies the boundary without repeatedly
 * parsing a growing streamed response.
 */
export function lastMachineJsonDocument(text: string): string | null {
  const scan = scanJsonDocuments(text);
  return scan.state === "complete" ? (scan.lastDocument ?? null) : null;
}

/**
 * Whether this text should be withheld from a transcript that renders prose.
 *
 * Both non-prose states are withheld, for different reasons: a `complete`
 * document is the machine result, which the surrounding view already renders
 * authoritatively (as a validated report or a folded payload), and an
 * `incomplete` one is a document still being written, which nothing can render
 * meaningfully yet. Text that is proven prose is always shown — including text
 * that merely contains JSON, and text that opened like a document but turned
 * out not to be one.
 */
export function isWithheldMachineOutput(text: string): boolean {
  return jsonDocumentState(text) !== "not-json";
}
