import { describe, expect, test } from "bun:test";
import {
  sanitizeHistoryChunk,
  TERMINAL_PARSER_CARRY_MAX_BYTES,
  trackParserCarry,
  type ArchiveScanState,
  type ParserCarryState,
} from "./history-scanners.js";

// The per-character scanners these replaced, kept verbatim as the reference
// the code-unit scanners must agree with on every input.

function referenceTrackParserCarry(session: ParserCarryState, text: string): void {
  for (const character of text) {
    const appendCarry = () => {
      if (session.parserCarryOverflow) return;
      session.parserCarry += character;
      session.parserCarryBytes += Buffer.byteLength(character, "utf8");
    };
    switch (session.parserState) {
      case "normal":
        if (character === "\x1b") {
          session.parserState = "escape";
          session.parserCarry = character;
          session.parserCarryBytes = 1;
        } else if (character === "\x9b") {
          session.parserState = "csi";
          session.parserCarry = character;
          session.parserCarryBytes = Buffer.byteLength(character, "utf8");
        } else if (["\x90", "\x98", "\x9d", "\x9e", "\x9f"].includes(character)) {
          session.parserState = "string";
          session.parserCarry = character;
          session.parserCarryBytes = Buffer.byteLength(character, "utf8");
        }
        break;
      case "escape":
        appendCarry();
        if (character === "[") session.parserState = "csi";
        else if (["]", "P", "X", "^", "_"].includes(character)) session.parserState = "string";
        else if (character < " " || character > "/") {
          session.parserState = "normal";
          session.parserCarry = "";
          session.parserCarryBytes = 0;
        }
        break;
      case "csi":
        appendCarry();
        if (character >= "@" && character <= "~") {
          session.parserState = "normal";
          session.parserCarry = "";
          session.parserCarryBytes = 0;
        }
        break;
      case "string":
        appendCarry();
        if (character === "\x07" || character === "\x9c") {
          session.parserState = "normal";
          session.parserCarry = "";
          session.parserCarryBytes = 0;
        } else if (character === "\x1b") {
          session.parserState = "string-escape";
        }
        break;
      case "string-escape":
        appendCarry();
        if (character === "\\") {
          session.parserState = "normal";
          session.parserCarry = "";
          session.parserCarryBytes = 0;
        } else {
          session.parserState = character === "\x1b" ? "string-escape" : "string";
        }
        break;
    }
    if (session.parserCarryBytes > TERMINAL_PARSER_CARRY_MAX_BYTES) {
      session.parserCarry = "";
      session.parserCarryBytes = 0;
      session.parserCarryOverflow = true;
    }
    if (session.parserState === "normal") session.parserCarryOverflow = false;
  }
}

function referenceSanitizeHistoryChunk(
  session: ArchiveScanState,
  text: string,
  final = false,
): string {
  let input = `${session.archiveHighSurrogate}${text}`;
  session.archiveHighSurrogate = "";
  if (!final && input.length > 0) {
    const last = input.charCodeAt(input.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      session.archiveHighSurrogate = input.at(-1)!;
      input = input.slice(0, -1);
    }
  }
  let output = "";
  const emit = (character: string) => {
    if (session.archivePendingCr) {
      output += "\n";
      session.archivePendingCr = false;
      if (character === "\n") return;
    }
    if (character === "\r") {
      session.archivePendingCr = true;
    } else if (
      character === "\n" ||
      character === "\t" ||
      (character >= " " && (character < "\x7f" || character > "\x9f"))
    ) {
      output += character;
    }
  };
  for (const character of input) {
    switch (session.archiveParserState) {
      case "normal":
        if (character === "\x1b") session.archiveParserState = "escape";
        else if (character === "\x9b") session.archiveParserState = "csi";
        else if (["\x90", "\x98", "\x9d", "\x9e", "\x9f"].includes(character)) {
          session.archiveParserState = "string";
        } else {
          emit(character);
        }
        break;
      case "escape":
        if (character === "[") session.archiveParserState = "csi";
        else if (["]", "P", "X", "^", "_"].includes(character)) {
          session.archiveParserState = "string";
        } else if (character < " " || character > "/") {
          session.archiveParserState = "normal";
        }
        break;
      case "csi":
        if (character >= "@" && character <= "~") session.archiveParserState = "normal";
        break;
      case "string":
        if (character === "\x07" || character === "\x9c") {
          session.archiveParserState = "normal";
        } else if (character === "\x1b") {
          session.archiveParserState = "string-escape";
        }
        break;
      case "string-escape":
        if (character === "\\") session.archiveParserState = "normal";
        else session.archiveParserState = character === "\x1b" ? "string-escape" : "string";
        break;
    }
  }
  if (final) {
    if (session.archiveHighSurrogate) {
      emit("�");
      session.archiveHighSurrogate = "";
    }
    if (session.archivePendingCr) {
      output += "\n";
      session.archivePendingCr = false;
    }
  }
  return output;
}

/** Deterministic PRNG (mulberry32), so a failing seed reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every character class the scanners branch on, weighted towards the
 * sequences that change state: C0 and C1 controls, introducers and finals,
 * intermediates, printable ASCII, Latin-1 and CJK text, surrogate pairs and
 * lone surrogates of both halves.
 */
const ALPHABET = [
  "\x1b",
  "\x1b",
  "\x1b",
  "[",
  "[",
  "]",
  "P",
  "X",
  "^",
  "_",
  "\x07",
  "\x9c",
  "\x9b",
  "\x90",
  "\x98",
  "\x9d",
  "\x9e",
  "\x9f",
  "\\",
  "\r",
  "\r",
  "\n",
  "\n",
  "\t",
  "@",
  "~",
  "m",
  "0",
  "1",
  ";",
  " ",
  "!",
  "/",
  "a",
  "b",
  "z",
  "\x00",
  "\x08",
  "\x7f",
  "\x85",
  "\xa0",
  "\u00e9",
  "\u4e2d",
  "\ud83d\ude00",
  "\ud83d",
  "\ude00",
];

function generate(next: () => number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += ALPHABET[Math.floor(next() * ALPHABET.length)]!;
  }
  return text;
}

/** Random cuts, some of them through a surrogate pair. */
function chunks(next: () => number, text: string): string[] {
  const parts: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const size = 1 + Math.floor(next() * 40);
    parts.push(text.slice(offset, offset + size));
    offset += size;
  }
  return parts;
}

const carryState = (): ParserCarryState => ({
  parserState: "normal",
  parserCarry: "",
  parserCarryBytes: 0,
  parserCarryOverflow: false,
});

const archiveState = (): ArchiveScanState => ({
  archiveParserState: "normal",
  archivePendingCr: false,
  archiveHighSurrogate: "",
});

describe("terminal history scanners", () => {
  test("track the same carried sequence as the per-character original", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = random(seed);
      const expected = carryState();
      const actual = carryState();
      for (const part of chunks(next, generate(next, 200 + Math.floor(next() * 400)))) {
        referenceTrackParserCarry(expected, part);
        trackParserCarry(actual, part);
        expect({ seed, ...actual }).toEqual({ seed, ...expected });
      }
    }
  });

  test("sanitize archive text exactly as the per-character original", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = random(seed);
      const expected = archiveState();
      const actual = archiveState();
      const parts = chunks(next, generate(next, 200 + Math.floor(next() * 400)));
      parts.forEach((part, index) => {
        const final = index === parts.length - 1 && seed % 2 === 0;
        expect({ seed, output: sanitizeHistoryChunk(actual, part, final), ...actual }).toEqual({
          seed,
          output: referenceSanitizeHistoryChunk(expected, part, final),
          ...expected,
        });
      });
    }
  });

  test("gives up on a sequence past the carry bound and recovers at its end", () => {
    const expected = carryState();
    const actual = carryState();
    const longTitle = `\x1b]0;${"t".repeat(TERMINAL_PARSER_CARRY_MAX_BYTES + 10)}`;
    for (const part of [longTitle.slice(0, 5_000), longTitle.slice(5_000), "more\x07", "x\x1b[3"]) {
      referenceTrackParserCarry(expected, part);
      trackParserCarry(actual, part);
      expect(actual).toEqual(expected);
    }
    expect(actual).toMatchObject({
      parserState: "csi",
      parserCarry: "\x1b[3",
      parserCarryOverflow: false,
    });
  });

  test("keeps plain text in one piece and folds CR and CRLF to LF", () => {
    const state = archiveState();
    expect(
      sanitizeHistoryChunk(state, "\x1b[32mok\x1b[0m\tdone\r\nnext\rover\x1b]0;title\x07 end\r"),
    ).toBe("ok\tdone\nnext\nover end");
    expect(state.archivePendingCr).toBe(true);
    expect(sanitizeHistoryChunk(state, "", true)).toBe("\n");
  });
});
