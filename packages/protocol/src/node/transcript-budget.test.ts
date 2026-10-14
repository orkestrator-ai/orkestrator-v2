import { describe, expect, test } from "bun:test";
import {
  boundTranscriptInPlace,
  encodedJsonBytes,
  jsonStringContentBytes,
  planOldestFirstTrim,
  type BoundableTranscriptState,
} from "./transcript-budget";

interface Part {
  id: string;
  text: string;
}
interface Message {
  id: string;
  content: string;
  parts: Part[];
}

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Deterministic PRNG so failures reproduce. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

// Multibyte, astral, quote, backslash and control characters: every one of
// these encodes to more bytes than its UTF-16 length.
const ALPHABET = ["a", "é", "中", "😀", '"', "\\", "\n", "\u0001", " "];

function text(next: () => number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += ALPHABET[Math.floor(next() * ALPHABET.length)];
  }
  return value;
}

function transcript(seed: number, messages: number, maxParts: number): Message[] {
  const next = random(seed);
  return Array.from({ length: messages }, (_, index) => ({
    id: `m${index}`,
    content: text(next, Math.floor(next() * 40)),
    parts: Array.from({ length: 1 + Math.floor(next() * maxParts) }, (_, part) => ({
      id: `m${index}:${part}`,
      text: text(next, Math.floor(next() * 200)),
    })),
  }));
}

/** The loop Cursor and Pi used to run: re-measure the whole array per drop. */
function referenceTrim(messages: Message[], maximum: number): Message[] {
  const copy = messages.map((message) => ({ ...message, parts: [...message.parts] }));
  while (copy.length > 1 && bytesOf(copy) > maximum) copy.shift();
  const only = copy[0];
  if (only && copy.length === 1) {
    while (only.parts.length > 1 && bytesOf(copy) > maximum) only.parts.shift();
  }
  return copy;
}

const NOTICE = (message: Message): Part => ({
  id: `${message.id}:notice`,
  text: "[earlier output trimmed]",
});

/** ACP's loop: a notice takes the front slot and each pass shortens `parts`. */
function referenceNoticeTrim(messages: Message[], maximum: number): Message[] {
  const copy = messages.map((message) => ({ ...message, parts: [...message.parts] }));
  while (copy.length > 1 && bytesOf(copy) > maximum) copy.shift();
  const only = copy[0];
  while (only && bytesOf(copy) > maximum && only.parts.length > 1) {
    const target = only.parts.length - 1;
    if (only.parts[0]?.id === NOTICE(only).id) only.parts.shift();
    const keep = Math.max(0, target - 1);
    only.parts.splice(0, Math.max(1, only.parts.length - keep));
    only.parts.unshift(NOTICE(only));
  }
  return copy;
}

function applyPlan(messages: Message[], maximum: number, withNotice: boolean): Message[] {
  const plan = planOldestFirstTrim(
    messages,
    maximum,
    withNotice
      ? {
          leadingReplacement: (message: Message) => ({
            bytes: encodedJsonBytes(NOTICE(message)),
            present: message.parts[0]?.id === NOTICE(message).id,
          }),
        }
      : {},
  );
  const retained = messages
    .slice(plan.droppedMessages)
    .map((message) => ({ ...message, parts: [...message.parts] }));
  if (plan.droppedParts > 0) {
    const only = retained[0]!;
    const hadNotice = only.parts[0]?.id === NOTICE(only).id;
    only.parts.splice(0, plan.droppedParts + (hadNotice ? 1 : 0));
    if (withNotice) only.parts.unshift(NOTICE(only));
  }
  expect(plan.bytes).toBe(bytesOf(retained));
  expect(plan.overflowed).toBe(plan.bytes > maximum);
  return retained;
}

describe("planOldestFirstTrim", () => {
  test("matches the quadratic reference exactly, including multibyte and escaped text", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const messages = transcript(seed, 1 + (seed % 12), 1 + (seed % 30));
      const total = bytesOf(messages);
      for (const fraction of [1.5, 1, 0.99, 0.6, 0.3, 0.05, 0]) {
        const maximum = Math.floor(total * fraction);
        expect(applyPlan(messages, maximum, false)).toEqual(referenceTrim(messages, maximum));
        expect(applyPlan(messages, maximum, true)).toEqual(referenceNoticeTrim(messages, maximum));
      }
    }
  });

  test("continues an existing notice rather than paying for a second slot", () => {
    const base = transcript(7, 1, 40);
    const once = referenceNoticeTrim(base, Math.floor(bytesOf(base) * 0.7));
    expect(once[0]!.parts[0]!.id).toBe("m0:notice");
    const maximum = Math.floor(bytesOf(once) * 0.5);
    expect(applyPlan(once, maximum, true)).toEqual(referenceNoticeTrim(once, maximum));
  });

  test("handles empty input, an exact fit and a one-byte excess", () => {
    expect(planOldestFirstTrim([], 0)).toMatchObject({ droppedMessages: 0, bytes: 2 });
    const messages = transcript(3, 4, 3);
    const exact = bytesOf(messages);
    expect(planOldestFirstTrim(messages, exact)).toMatchObject({
      droppedMessages: 0,
      droppedParts: 0,
      overflowed: false,
    });
    expect(planOldestFirstTrim(messages, exact - 1).droppedMessages).toBe(1);
  });

  test("keeps the last part and reports overflow when one part alone is too large", () => {
    const messages: Message[] = [
      {
        id: "m",
        content: "",
        parts: [
          { id: "a", text: "x".repeat(50) },
          { id: "b", text: "y" },
        ],
      },
    ];
    const plan = planOldestFirstTrim(messages, 10);
    expect(plan).toMatchObject({ droppedMessages: 0, droppedParts: 1, overflowed: true });
  });

  test("serializes each message once however many it sheds", () => {
    // The validation probe: 100 messages of 8 KiB against a 256 KiB ceiling
    // cost 4,585 message serializations with the old loop.
    let visits = 0;
    const messages = Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      content: "x".repeat(8192),
      parts: [] as unknown[],
      toJSON() {
        visits += 1;
        return { id: this.id, content: this.content, parts: this.parts };
      },
    }));
    const plan = planOldestFirstTrim(messages, 262_144);
    expect(100 - plan.droppedMessages).toBe(31);
    expect(visits).toBe(100);
    expect(plan.measuredValues).toBe(100);
  });

  test("measures each part of an oversized message once", () => {
    let visits = 0;
    const parts = Array.from({ length: 5_000 }, (_, index) => ({
      index,
      toJSON() {
        visits += 1;
        return { index: this.index, text: "z".repeat(64) };
      },
    }));
    const message = { id: "m", parts };
    visits = 0;
    const plan = planOldestFirstTrim([message], 32 * 1024);
    // One visit for the message (which serializes every part) and one per part.
    expect(visits).toBe(10_000);
    expect(plan.droppedParts).toBeGreaterThan(4_000);
  });
});

describe("jsonStringContentBytes", () => {
  test("counts escaped UTF-8 bytes exactly", () => {
    for (const value of [
      "",
      "plain",
      'q"uote',
      "back\\slash",
      "nl\n",
      "\u0001",
      "é中😀",
      "\ud800",
    ]) {
      expect(jsonStringContentBytes(value)).toBe(bytesOf(value) - 2);
    }
  });

  test("summed appends never undercount the concatenation", () => {
    const next = random(11);
    for (let run = 0; run < 200; run += 1) {
      const pieces = Array.from({ length: 5 }, () => text(next, Math.floor(next() * 10)));
      const summed = pieces.reduce((total, piece) => total + jsonStringContentBytes(piece), 0);
      expect(summed).toBeGreaterThanOrEqual(jsonStringContentBytes(pieces.join("")));
    }
  });
});

describe("boundTranscriptInPlace", () => {
  function state(messages: Message[]): BoundableTranscriptState & { messages: Message[] } {
    return {
      messages,
      droppedMessages: 0,
      droppedParts: 0,
      transcriptTruncated: false,
      uncheckedTranscriptBytes: 1,
    };
  }

  test("applies structural and byte bounds with exact accounting", () => {
    const messages = transcript(5, 20, 12);
    const expected = referenceTrim(
      messages.slice(-10).map((message) => ({ ...message, parts: message.parts.slice(-4) })),
      Math.floor(bytesOf(messages) * 0.2),
    );
    const bounded = state(messages.map((message) => ({ ...message, parts: [...message.parts] })));
    const changed = boundTranscriptInPlace(bounded, {
      maxMessages: 10,
      maxPartsPerMessage: 4,
      maxTranscriptBytes: Math.floor(bytesOf(messages) * 0.2),
    });
    expect(changed).toBe(true);
    expect(bounded.messages).toEqual(expected);
    expect(bounded.uncheckedTranscriptBytes).toBe(0);
    expect(bounded.transcriptTruncated).toBe(true);
    const totalParts = (list: Message[]) => list.reduce((sum, m) => sum + m.parts.length, 0);
    expect(bounded.droppedMessages).toBe(messages.length - expected.length);
    expect(bounded.droppedParts).toBe(totalParts(messages) - totalParts(expected));
  });

  test("reports no change for a transcript already inside its budget", () => {
    const bounded = state(transcript(9, 3, 3));
    expect(
      boundTranscriptInPlace(bounded, {
        maxMessages: 10,
        maxPartsPerMessage: 10,
        maxTranscriptBytes: 1 << 30,
      }),
    ).toBe(false);
    expect(bounded.transcriptTruncated).toBe(false);
  });
});
