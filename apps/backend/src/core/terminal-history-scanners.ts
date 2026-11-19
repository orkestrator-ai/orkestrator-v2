/**
 * The two control-sequence scanners every byte of terminal output passes
 * through on its way into durable history (`terminal-history.ts`):
 *
 * - {@link trackParserCarry} keeps the unfinished escape sequence at the end
 *   of the output, which a checkpoint stores as `pendingOutput` so a restored
 *   terminal resumes mid-sequence exactly;
 * - {@link sanitizeHistoryChunk} turns output into the plain text the archive
 *   pages hold: escape sequences removed, CR and CRLF folded to LF.
 *
 * Both run on the backend's event loop, once for every chunk of every
 * terminal, so they scan UTF-16 code units and copy unchanged runs with one
 * `slice` instead of allocating a string (and, before, a closure) per
 * character. The terminal latency benchmark
 * (`apps/backend/scripts/terminal-latency.ts`, docs/development/terminal-latency.md)
 * found the per-character versions to be the largest single cost of the
 * backend's share of key-to-echo latency under build output.
 *
 * State transitions are decided on a whole code point, as the `for…of`
 * originals did: a surrogate pair is one step, and it compares by its high
 * surrogate. `terminal-history-scanners.test.ts` checks both against those
 * originals on generated input.
 */

export type ParserState = "normal" | "escape" | "csi" | "string" | "string-escape";

/** A session's carried escape sequence; the fields `trackParserCarry` maintains. */
export type ParserCarryState = {
  parserState: ParserState;
  parserCarry: string;
  parserCarryBytes: number;
  parserCarryOverflow: boolean;
};

/** A session's archive sanitizer state; the fields `sanitizeHistoryChunk` maintains. */
export type ArchiveScanState = {
  archiveParserState: ParserState;
  archivePendingCr: boolean;
  archiveHighSurrogate: string;
};

/** The longest escape sequence a checkpoint carries before giving up on it. */
export const TERMINAL_PARSER_CARRY_MAX_BYTES = 64 * 1024;

const ESC = 0x1b;
const BEL = 0x07;
const CSI_C1 = 0x9b;
const ST_C1 = 0x9c;
const LF = 0x0a;
const CR = 0x0d;
const TAB = 0x09;

/** ESC, CSI and the C1 control-string introducers: where a sequence can start. */
const SEQUENCE_INTRODUCER = /[\x1b\x90\x98\x9b\x9d-\x9f]/g;
/** Anything {@link isPlainArchiveCode} rejects, by code unit. */
const ARCHIVE_NOT_PLAIN = /[^\t\x20-\x7e\u00a0-\uffff]/g;

/** C1 introducers of a control string: DCS, SOS, OSC, PM, APC. */
function isC1StringIntroducer(code: number): boolean {
  return code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f;
}

/** `]`, `P`, `X`, `^`, `_` after ESC: OSC, DCS, SOS, PM, APC. */
function isStringIntroducerFinal(code: number): boolean {
  return code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Code units in the code point at `index`: 2 for a surrogate pair, else 1. */
function codePointUnits(text: string, index: number, code: number): 1 | 2 {
  return isHighSurrogate(code) &&
    index + 1 < text.length &&
    isLowSurrogate(text.charCodeAt(index + 1))
    ? 2
    : 1;
}

/** UTF-8 bytes of the code point at `index`, as `Buffer.byteLength` counts it. */
function codePointBytes(code: number, units: 1 | 2): number {
  if (units === 2) return 4;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  // Everything else, a lone surrogate included (encoded as U+FFFD), is three.
  return 3;
}

/**
 * The state after one code point of an escape sequence, decided by its first
 * code unit. `normal` is handled by the callers, which differ there.
 */
function nextSequenceState(state: Exclude<ParserState, "normal">, code: number): ParserState {
  switch (state) {
    case "escape":
      if (code === 0x5b) return "csi";
      if (isStringIntroducerFinal(code)) return "string";
      return code < 0x20 || code > 0x2f ? "normal" : "escape";
    case "csi":
      return code >= 0x40 && code <= 0x7e ? "normal" : "csi";
    case "string":
      if (code === BEL || code === ST_C1) return "normal";
      return code === ESC ? "string-escape" : "string";
    case "string-escape":
      if (code === 0x5c) return "normal";
      return code === ESC ? "string-escape" : "string";
  }
}

/** Follows `text` and keeps the unfinished escape sequence it ends in. */
export function trackParserCarry(session: ParserCarryState, text: string): void {
  let state = session.parserState;
  let carry = session.parserCarry;
  let carryBytes = session.parserCarryBytes;
  let overflow = session.parserCarryOverflow;
  // Where the part of `text` that still belongs to the carry starts, or -1.
  // Characters are appended to the carry by extending this run, and the run
  // is copied once, when it ends or the text does.
  let runStart = state !== "normal" && !overflow ? 0 : -1;
  const length = text.length;
  let index = 0;
  while (index < length) {
    if (state === "normal") {
      // Ordinary output, the overwhelming majority, is skipped in one search.
      overflow = false;
      SEQUENCE_INTRODUCER.lastIndex = index;
      const found = SEQUENCE_INTRODUCER.exec(text);
      if (!found) break;
      const introducer = text.charCodeAt(found.index);
      state = introducer === ESC ? "escape" : introducer === CSI_C1 ? "csi" : "string";
      carry = "";
      carryBytes = introducer === ESC ? 1 : 2;
      runStart = found.index;
      index = found.index + 1;
      continue;
    }
    const code = text.charCodeAt(index);
    const units = codePointUnits(text, index, code);
    if (!overflow) carryBytes += codePointBytes(code, units);
    state = nextSequenceState(state, code);
    index += units;
    if (state === "normal") {
      carry = "";
      carryBytes = 0;
      runStart = -1;
    }
    if (carryBytes > TERMINAL_PARSER_CARRY_MAX_BYTES) {
      carry = "";
      carryBytes = 0;
      runStart = -1;
      overflow = true;
    }
    if (state === "normal") overflow = false;
  }
  if (runStart >= 0) carry += runStart === 0 ? text : text.slice(runStart);
  session.parserState = state;
  session.parserCarry = carry;
  session.parserCarryBytes = carryBytes;
  session.parserCarryOverflow = overflow;
}

/** Printable characters the archive keeps unchanged: tab, ASCII text, and U+00A0 up. */
function isPlainArchiveCode(code: number): boolean {
  return (code >= 0x20 && code < 0x7f) || code > 0x9f || code === TAB;
}

/**
 * The archive's plain text for `text`: escape sequences and other controls
 * removed, CR and CRLF folded to LF. A high surrogate at the end waits for the
 * next chunk unless `final`.
 */
export function sanitizeHistoryChunk(
  session: ArchiveScanState,
  text: string,
  final = false,
): string {
  let input = `${session.archiveHighSurrogate}${text}`;
  session.archiveHighSurrogate = "";
  if (!final && input.length > 0) {
    const last = input.charCodeAt(input.length - 1);
    if (isHighSurrogate(last)) {
      session.archiveHighSurrogate = input.at(-1)!;
      input = input.slice(0, -1);
    }
  }
  let state = session.archiveParserState;
  let pendingCr = session.archivePendingCr;
  let output = "";
  const length = input.length;
  let index = 0;
  while (index < length) {
    const code = input.charCodeAt(index);
    if (state === "normal") {
      if (isPlainArchiveCode(code)) {
        if (pendingCr) {
          output += "\n";
          pendingCr = false;
        }
        ARCHIVE_NOT_PLAIN.lastIndex = index + 1;
        const end = ARCHIVE_NOT_PLAIN.exec(input)?.index ?? length;
        output += input.slice(index, end);
        index = end;
        continue;
      }
      index += 1;
      if (code === ESC) state = "escape";
      else if (code === CSI_C1) state = "csi";
      else if (isC1StringIntroducer(code)) state = "string";
      else {
        // Every other control: a pending CR becomes a line break first.
        if (pendingCr) {
          output += "\n";
          pendingCr = false;
          if (code === LF) continue;
        }
        if (code === CR) pendingCr = true;
        else if (code === LF) output += "\n";
      }
      continue;
    }
    state = nextSequenceState(state, code);
    index += codePointUnits(input, index, code);
  }
  if (final) {
    if (session.archiveHighSurrogate) {
      if (pendingCr) output += "\n";
      pendingCr = false;
      output += "�";
      session.archiveHighSurrogate = "";
    }
    if (pendingCr) {
      output += "\n";
      pendingCr = false;
    }
  }
  session.archiveParserState = state;
  session.archivePendingCr = pendingCr;
  return output;
}
