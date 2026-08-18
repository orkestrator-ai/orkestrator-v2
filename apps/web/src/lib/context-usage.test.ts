import { describe, expect, test } from "bun:test";
import { extractContextUsage, formatTokenCount } from "./context-usage";

/**
 * `expect.any(String)` accepts `""`, which is exactly the value a broken clock
 * would produce and which `new Date("")` then renders as "Invalid Date" in the
 * UI. Match the shape and prove it round-trips through `Date`.
 */
const ISO_TIMESTAMP = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

function expectParseableIso(value: string | undefined): void {
  expect(typeof value).toBe("string");
  const parsed = Date.parse(value as string);
  expect(Number.isFinite(parsed)).toBe(true);
  expect(new Date(parsed).toISOString()).toBe(value as string);
}

describe("context-usage extractContextUsage", () => {
  test("extracts usage from nested contextUsage payload", () => {
    const payload = {
      type: "session.updated",
      model: "anthropic/claude-sonnet-4",
      contextUsage: {
        usedTokens: 12_500,
        totalContextTokens: 200_000,
      },
    };

    const result = extractContextUsage(payload);

    expect(result).toEqual({
      usedTokens: 12_500,
      totalTokens: 200_000,
      percentUsed: 6.25,
      modelId: "anthropic/claude-sonnet-4",
      estimated: true,
      source: "heuristic",
      updatedAt: ISO_TIMESTAMP,
    });
    expectParseableIso(result?.updatedAt);
  });

  test("parses shorthand token values and falls back to input/output token sums", () => {
    const payload = {
      usage: {
        input_tokens: "2.5k",
        output_tokens: 500,
        max_tokens: "10k",
        model_id: "openai/gpt-5",
      },
    };

    const result = extractContextUsage(payload);

    expect(result).toEqual({
      usedTokens: 3_000,
      totalTokens: 10_000,
      percentUsed: 30,
      modelId: "openai/gpt-5",
      estimated: true,
      source: "heuristic",
      updatedAt: ISO_TIMESTAMP,
    });
    expectParseableIso(result?.updatedAt);
  });

  test("returns null for invalid candidates where used exceeds total", () => {
    const payload = {
      contextUsage: {
        usedTokens: 12_000,
        totalTokens: 10_000,
      },
    };

    expect(extractContextUsage(payload)).toBeNull();
  });

  test("returns null for non-object payloads", () => {
    expect(extractContextUsage(null)).toBeNull();
    expect(extractContextUsage(undefined)).toBeNull();
    expect(extractContextUsage("usedTokens: 5")).toBeNull();
    expect(extractContextUsage(42)).toBeNull();
  });

  describe("best-candidate selection", () => {
    test("prefers the candidate reporting the most used tokens", () => {
      const payload = {
        stale: { usedTokens: 10, maxTokens: 100 },
        fresh: { usedTokens: 90, maxTokens: 100 },
      };

      expect(extractContextUsage(payload)).toMatchObject({
        usedTokens: 90,
        totalTokens: 100,
        percentUsed: 90,
      });
    });

    test("breaks a tie on used tokens in favour of the candidate naming a model", () => {
      const payload = {
        anonymous: { usage: { usedTokens: 100, maxTokens: 1_000 } },
        identified: {
          model: "openai/gpt-5",
          usage: { usedTokens: 100, maxTokens: 1_000 },
        },
      };

      expect(extractContextUsage(payload)).toMatchObject({
        usedTokens: 100,
        modelId: "openai/gpt-5",
      });
    });

    test("keeps the first candidate when a later tie adds no model id", () => {
      const payload = {
        identified: {
          model: "openai/gpt-5",
          usage: { usedTokens: 100, maxTokens: 1_000 },
        },
        anonymous: { usage: { usedTokens: 100, maxTokens: 1_000 } },
      };

      expect(extractContextUsage(payload)?.modelId).toBe("openai/gpt-5");
    });

    test("traverses arrays of objects", () => {
      const payload = {
        turns: [
          null,
          "not-an-object",
          { note: "no usage here" },
          { usedTokens: 50, maxTokens: 100, modelId: "openai/gpt-5" },
        ],
      };

      expect(extractContextUsage(payload)).toMatchObject({
        usedTokens: 50,
        totalTokens: 100,
        modelId: "openai/gpt-5",
      });
    });

    test("terminates on a self-referencing payload", () => {
      // The WeakSet guard is the only thing standing between a cyclic SSE
      // payload and an infinite traversal that hangs the renderer.
      const cyclic: Record<string, unknown> = {
        contextUsage: { usedTokens: 10, totalContextTokens: 100 },
      };
      cyclic.self = cyclic;
      cyclic.nested = { parent: cyclic, siblings: [cyclic] };

      expect(extractContextUsage(cyclic)).toMatchObject({
        usedTokens: 10,
        totalTokens: 100,
        percentUsed: 10,
      });
    });
  });

  describe("candidate rejection", () => {
    test.each([
      ["a non-positive usedTokens", { usedTokens: 0, totalTokens: 100 }],
      ["a negative usedTokens", { usedTokens: -5, totalTokens: 100 }],
      ["a non-positive totalTokens", { usedTokens: 5, maxTokens: 0 }],
      ["a negative totalTokens", { usedTokens: 5, maxTokens: -100 }],
      ["a missing totalTokens", { usedTokens: 5 }],
      ["a missing usedTokens", { maxContextTokens: 100 }],
    ])("rejects %s", (_label, payload) => {
      expect(extractContextUsage(payload)).toBeNull();
    });
  });

  describe("token number parsing", () => {
    test.each([
      ["a plain number", 4_096, 4_096],
      ["a comma-grouped string", "1,500", 1_500],
      ["a k suffix", "2.5k", 2_500],
      ["an m suffix", "1.5m", 1_500_000],
      ["a b suffix", "2b", 2_000_000_000],
      ["an uppercase suffix", "3K", 3_000],
      ["a padded string", "  200 ", 200],
    ])("accepts %s", (_label, raw, expected) => {
      expect(extractContextUsage({ usedTokens: raw, maxTokens: "10b" })?.usedTokens).toBe(
        expected as number,
      );
    });

    test.each([
      ["a non-matching string", "twelve thousand"],
      ["a suffix it does not know", "5t"],
      ["a non-finite number", Number.POSITIVE_INFINITY],
      ["NaN", Number.NaN],
      ["a boolean", true],
      ["an empty string", ""],
    ])("rejects %s", (_label, raw) => {
      expect(extractContextUsage({ usedTokens: raw, maxTokens: 10_000 })).toBeNull();
    });
  });
});

describe("context-usage formatTokenCount", () => {
  test.each([
    ["renders sub-thousand counts verbatim", 0, "0"],
    ["renders sub-thousand counts verbatim", 999, "999"],
    ["renders thousands with one decimal", 1_000, "1.0k"],
    ["renders thousands with one decimal", 9_999, "10.0k"],
    ["drops the decimal from ten thousands", 10_000, "10k"],
    ["drops the decimal from ten thousands", 999_999, "1000k"],
    ["renders millions with one decimal", 1_000_000, "1.0M"],
    ["renders millions with one decimal", 9_500_000, "9.5M"],
    ["drops the decimal from ten millions", 10_000_000, "10M"],
    ["drops the decimal from ten millions", 1_234_000_000, "1234M"],
  ])("%s (%p)", (_label, tokens, expected) => {
    expect(formatTokenCount(tokens as number)).toBe(expected);
  });
});
