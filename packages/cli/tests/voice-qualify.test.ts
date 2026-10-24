import { describe, expect, test } from "bun:test";
import { affirmativeAnswers, percentile, summarize } from "../examples/voice-qualify.js";

describe("voice qualification harness", () => {
  test("percentiles use the nearest rank", () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 0.95)).toBe(100);
    expect(
      summarize([
        { tool: "overview", ms: 2, textBytes: 40, ok: true },
        { tool: "overview", ms: 4, textBytes: 60, ok: false, code: "busy" },
      ]),
    ).toEqual({
      overview: { calls: 2, p50Ms: 2, p95Ms: 4, maxTextBytes: 60, failures: ["busy"] },
    });
  });

  test("answers the way a person saying yes would", () => {
    expect(
      affirmativeAnswers({
        id: "q",
        kind: "question",
        questions: [
          {
            id: "list",
            required: true,
            allowFreeText: false,
            options: [
              { id: "no", label: "No" },
              { id: "yes", label: "Yes" },
            ],
          },
          { id: "note", required: true, allowFreeText: true, options: [] },
          { id: "optional", required: false, allowFreeText: true, options: [] },
        ],
      }),
    ).toEqual([
      { questionId: "list", optionIds: ["yes"] },
      { questionId: "note", freeText: "yes" },
    ]);
  });
});
