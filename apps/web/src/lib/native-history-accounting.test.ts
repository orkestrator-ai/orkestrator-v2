import { afterEach, describe, expect, test } from "bun:test";
import {
  encodedArrayBytes,
  encodedValueBytes,
  measureEncodedValue,
  retainedHistoryBytes,
  setEncodedValueMeasureForTests,
  slowEncodedBytes,
  utf8ByteLength,
} from "./native-history-accounting";

interface Message {
  id: string;
  text: string;
  parts?: Array<{ type: string; content: string }>;
}

/** Deterministic PRNG so a failing sequence reproduces exactly. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ALPHABET = ["a", "Z", "\n", '"', "\\", "é", "ß", "中", "€", "😀", "\u0000", " ", "\ud800"];

function randomText(random: () => number, maxLength: number): string {
  const length = Math.floor(random() * maxLength);
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return text;
}

function randomMessage(random: () => number, id: string): Message {
  const partCount = Math.floor(random() * 3);
  return {
    id,
    text: randomText(random, 40),
    ...(partCount > 0
      ? {
          parts: Array.from({ length: partCount }, () => ({
            type: "text",
            content: randomText(random, 20),
          })),
        }
      : {}),
  };
}

function countingMeasure(): { measured: unknown[] } {
  const measured: unknown[] = [];
  setEncodedValueMeasureForTests((value) => {
    if (value !== null && typeof value === "object") measured.push(value);
    return measureEncodedValue(value);
  });
  return { measured };
}

afterEach(() => setEncodedValueMeasureForTests());

describe("utf8ByteLength", () => {
  test("matches TextEncoder, including astral characters and lone surrogates", () => {
    const random = prng(1);
    const encoder = new TextEncoder();
    const fixed = ["", "abc", "é", "😀", "\ud800", "\udc00", "\ud800a", "a\udfff", "😀\ud83d"];
    for (const text of fixed) expect(utf8ByteLength(text)).toBe(encoder.encode(text).byteLength);
    for (let round = 0; round < 500; round += 1) {
      const text = randomText(random, 64);
      expect(utf8ByteLength(text)).toBe(encoder.encode(text).byteLength);
    }
  });
});

describe("encodedArrayBytes", () => {
  test("equals encoding the whole array for random message arrays", () => {
    const random = prng(2);
    expect(encodedArrayBytes([])).toBe(slowEncodedBytes([]));
    for (let round = 0; round < 200; round += 1) {
      const messages = Array.from({ length: Math.floor(random() * 12) }, (_, index) =>
        randomMessage(random, `m${round}-${index}`),
      );
      expect(encodedArrayBytes(messages)).toBe(slowEncodedBytes(messages));
    }
  });

  test("encodes values JSON cannot represent alone as null, like JSON.stringify", () => {
    const values: unknown[] = [undefined, () => 1, Symbol("x"), 1, "s", null, true];
    // Trailing holes, which JSON.stringify also writes as null.
    values.length = 9;
    expect(encodedArrayBytes(values)).toBe(slowEncodedBytes(values));
  });

  test("measures each message once per object identity", () => {
    const { measured } = countingMeasure();
    const history = Array.from({ length: 50 }, (_, index) => ({ id: `m${index}`, text: "x" }));
    encodedArrayBytes(history);
    expect(measured).toHaveLength(50);

    // A new joined array around the same objects plus one changed tail message
    // serializes only the changed message.
    const changed = { id: "m49", text: "changed" };
    const next = [...history.slice(0, 49), changed];
    measured.length = 0;
    expect(encodedArrayBytes(next)).toBe(slowEncodedBytes(next));
    expect(measured).toEqual([changed]);

    measured.length = 0;
    encodedValueBytes(changed);
    encodedArrayBytes(next.slice(10));
    expect(measured).toEqual([]);
  });

  test("never caches primitives", () => {
    const { measured } = countingMeasure();
    expect(encodedValueBytes("abc")).toBe(5);
    expect(encodedValueBytes(null)).toBe(4);
    expect(measured).toEqual([]);
  });
});

describe("retainedHistoryBytes", () => {
  test("counts an empty history as nothing retained", () => {
    expect(retainedHistoryBytes([])).toBe(0);
    const history = [{ id: "m1", text: "a" }];
    expect(retainedHistoryBytes(history)).toBe(slowEncodedBytes(history));
  });

  test("stays exact across random retention operation sequences", () => {
    const random = prng(3);
    let nextId = 0;
    const fresh = () => randomMessage(random, `m${nextId++}`);
    let history: Message[] = Array.from({ length: 20 }, fresh);
    const check = () => {
      expect(retainedHistoryBytes(history)).toBe(history.length ? slowEncodedBytes(history) : 0);
      expect(encodedArrayBytes(history)).toBe(slowEncodedBytes(history));
    };
    check();
    for (let step = 0; step < 400; step += 1) {
      const operation = Math.floor(random() * 7);
      if (operation === 0) {
        // Page load: prepend older messages.
        history = [...Array.from({ length: 1 + Math.floor(random() * 5) }, fresh), ...history];
      } else if (operation === 1 && history.length > 0) {
        // Delta delete.
        const index = Math.floor(random() * history.length);
        history = history.filter((_, position) => position !== index);
      } else if (operation === 2 && history.length > 0) {
        // Delta upsert: the changed message arrives as a new object.
        const index = Math.floor(random() * history.length);
        const replacement = { ...randomMessage(random, history[index]!.id) };
        history = history.map((message, position) => (position === index ? replacement : message));
      } else if (operation === 3) {
        // Overlapping or duplicate page: already-held objects are deduplicated.
        const ids = new Set(history.map(({ id }) => id));
        const page = [...history.slice(0, 3), fresh()];
        history = [...page.filter(({ id }) => !ids.has(id)), ...history];
      } else if (operation === 4) {
        // Rewind to a prefix.
        history = history.slice(0, Math.floor(random() * (history.length + 1)));
      } else if (operation === 5) {
        // Eviction or identity replacement drops everything.
        history = random() < 0.5 ? [] : Array.from({ length: 3 }, fresh);
      } else {
        // Live messages ageing out into retained history.
        history = [...history, fresh(), fresh()];
      }
      check();
    }
  });
});
