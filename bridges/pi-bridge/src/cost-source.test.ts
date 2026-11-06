import { describe, expect, test } from "bun:test";
import {
  countPiCostParts,
  piSessionCostSource,
  piTurnCostSource,
  piUsageCostSource,
} from "./cost-source.js";

/** A pi-ai `Usage` with the fields the counter reads. */
function usage(total: number, totalFromProvider?: boolean, tokens = 10) {
  return {
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: tokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total,
      ...(totalFromProvider === undefined ? {} : { totalFromProvider }),
    },
  };
}

function assistant(cost: ReturnType<typeof usage>) {
  return { type: "message", message: { role: "assistant", usage: cost } };
}

describe("countPiCostParts", () => {
  test("counts the entries getSessionStats sums, and the billed ones among them", () => {
    expect(
      countPiCostParts([
        { type: "message", message: { role: "user", content: "hi" } },
        assistant(usage(0.01, true)),
        { type: "message", message: { role: "toolResult", usage: usage(0.002, false) } },
        { type: "usage", kind: "cache_warm", usage: usage(0.003) },
        { type: "compaction", usage: usage(0.004, true) },
        { type: "branch_summary", usage: usage(0.005, true) },
        // No usage, so nothing for the sum to add.
        { type: "compaction" },
        { type: "model_change" },
      ]),
    ).toEqual({ parts: 5, providerParts: 3 });
  });

  test("a response that reported nothing is not a part", () => {
    // An aborted or failed response carries zero tokens and zero cost; it adds
    // nothing to the session sum, so it cannot make a billed turn an estimate.
    expect(
      countPiCostParts([assistant(usage(0.01, true)), assistant(usage(0, undefined, 0))]),
    ).toEqual({ parts: 1, providerParts: 1 });
  });

  test("malformed entries are skipped, never thrown on", () => {
    expect(
      countPiCostParts([
        null,
        "entry",
        { type: "message" },
        { type: "message", message: { role: "assistant" } },
        { type: "usage", usage: "lots" },
      ]),
    ).toEqual({ parts: 0, providerParts: 0 });
  });
});

describe("piTurnCostSource", () => {
  test("a turn is billed only when every part it added says so", () => {
    expect(piTurnCostSource({ parts: 5, providerParts: 3 }, { parts: 3, providerParts: 1 })).toBe(
      "provider",
    );
    expect(piTurnCostSource({ parts: 5, providerParts: 4 }, { parts: 3, providerParts: 3 })).toBe(
      "estimate",
    );
  });

  test("earlier estimates do not make a billed turn an estimate", () => {
    expect(piTurnCostSource({ parts: 3, providerParts: 1 }, { parts: 2, providerParts: 0 })).toBe(
      "provider",
    );
  });

  test("a turn that added no part has no source", () => {
    expect(
      piTurnCostSource({ parts: 3, providerParts: 1 }, { parts: 3, providerParts: 1 }),
    ).toBeUndefined();
  });

  test("without a usable baseline only an all-billed session answers", () => {
    expect(piTurnCostSource({ parts: 4, providerParts: 4 }, undefined)).toBe("provider");
    expect(piTurnCostSource({ parts: 4, providerParts: 3 }, undefined)).toBeUndefined();
    // Counts that went backwards belong to another session's entries.
    expect(
      piTurnCostSource({ parts: 2, providerParts: 1 }, { parts: 6, providerParts: 1 }),
    ).toBeUndefined();
  });
});

describe("session and single-response sources", () => {
  test("the session is billed only when every part is", () => {
    expect(piSessionCostSource({ parts: 2, providerParts: 2 })).toBe("provider");
    expect(piSessionCostSource({ parts: 2, providerParts: 1 })).toBe("estimate");
    expect(piSessionCostSource({ parts: 0, providerParts: 0 })).toBeUndefined();
  });

  test("an absent flag means a catalogue estimate", () => {
    expect(piUsageCostSource(usage(0.02, true))).toBe("provider");
    expect(piUsageCostSource(usage(0.02, false))).toBe("estimate");
    expect(piUsageCostSource(usage(0.02))).toBe("estimate");
    expect(piUsageCostSource(usage(0, undefined, 0))).toBeUndefined();
    expect(piUsageCostSource(undefined)).toBeUndefined();
  });
});
