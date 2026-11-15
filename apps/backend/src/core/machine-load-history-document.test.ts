import { describe, expect, test } from "bun:test";
import {
  decodeMachineLoadHistory,
  encodeMachineLoadHistory,
  MACHINE_LOAD_HISTORY_DOCUMENT_VERSION,
} from "./machine-load-history-document.js";
import { MACHINE_LOAD_HISTORY_LIMITS } from "./machine-load.js";

const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 31, 12);

/** A minute bucket at `minute` past START, at `cpu`% and `ram`%. */
function minute(index: number, cpu = 50, ram = 40): [number, number, number, number, number] {
  const startMs = START + index * MINUTE;
  return [startMs, startMs + MINUTE, MINUTE, cpu * MINUTE, ram * MINUTE];
}

function document(overrides: Record<string, unknown> = {}) {
  return {
    version: MACHINE_LOAD_HISTORY_DOCUMENT_VERSION,
    coarse: [[START - 15 * MINUTE, START, 15 * MINUTE, 20 * 15 * MINUTE, 30 * 15 * MINUTE]],
    fine: [minute(0), minute(1)],
    ...overrides,
  };
}

describe("the stored machine-load document", () => {
  test("round-trips buckets as whole-number tuples", () => {
    const encoded = encodeMachineLoadHistory({
      fine: [
        {
          startMs: START,
          endMs: START + MINUTE,
          coveredMs: MINUTE,
          cpuWeighted: 12.34 * MINUTE + 0.4,
          ramWeighted: 50 * MINUTE,
        },
      ],
      coarse: [],
    });
    expect(encoded).toEqual({
      version: 1,
      fine: [[START, START + MINUTE, MINUTE, Math.round(12.34 * MINUTE + 0.4), 50 * MINUTE]],
      coarse: [],
    });
    const decoded = decodeMachineLoadHistory(
      JSON.parse(JSON.stringify(encoded)),
      MACHINE_LOAD_HISTORY_LIMITS,
    );
    expect(decoded).toMatchObject({ ok: true, coarse: [], fine: [{ startMs: START }] });
  });

  test("accepts a well-formed document", () => {
    const decoded = decodeMachineLoadHistory(document(), MACHINE_LOAD_HISTORY_LIMITS);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.coarse).toHaveLength(1);
      expect(decoded.fine.map((bucket) => bucket.startMs)).toEqual([START, START + MINUTE]);
    }
  });

  test("a newer format is discarded, not trusted", () => {
    expect(decodeMachineLoadHistory(document({ version: 2 }), MACHINE_LOAD_HISTORY_LIMITS)).toEqual(
      { ok: false, reason: "newer-version" },
    );
  });

  test("more buckets than the history can hold is discarded as too large", () => {
    const fine = Array.from({ length: MACHINE_LOAD_HISTORY_LIMITS.maxFineBuckets + 1 }, (_, i) =>
      minute(i),
    );
    expect(decodeMachineLoadHistory(document({ fine }), MACHINE_LOAD_HISTORY_LIMITS)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  const malformed: Array<[string, unknown]> = [
    ["not an object", "history"],
    ["an array", []],
    ["no version", { fine: [], coarse: [] }],
    ["an older or odd version", document({ version: 0 })],
    ["missing lists", { version: 1 }],
    ["a short tuple", document({ fine: [[START, START + MINUTE, MINUTE, 0]] })],
    ["a fractional number", document({ fine: [[START, START + MINUTE, 1.5, 0, 0]] })],
    ["a negative number", document({ fine: [[START, START + MINUTE, MINUTE, -1, 0]] })],
    ["a text number", document({ fine: [[START, START + MINUTE, MINUTE, "1", 0]] })],
    ["an empty span", document({ fine: [[START, START, 0, 0, 0]] })],
    ["coverage beyond its span", document({ fine: [[START, START + MINUTE, 2 * MINUTE, 0, 0]] })],
    ["over 100 percent", document({ fine: [[START, START + MINUTE, MINUTE, 101 * MINUTE, 0]] })],
    [
      "a minute bucket spanning hours",
      document({ fine: [[START, START + 3 * 60 * MINUTE, MINUTE, 0, 0]] }),
    ],
    [
      "two buckets for one minute",
      document({ fine: [minute(0), [START + 30_000, START + 50_000, 20_000, 0, 0]] }),
    ],
    ["buckets out of order", document({ fine: [minute(1), minute(0)] })],
    ["coarse history after the minutes", document({ coarse: [minute(5)], fine: [minute(0)] })],
  ];
  for (const [name, value] of malformed) {
    test(`${name} is discarded as malformed`, () => {
      expect(decodeMachineLoadHistory(value, MACHINE_LOAD_HISTORY_LIMITS)).toEqual({
        ok: false,
        reason: "malformed",
      });
    });
  }
});
