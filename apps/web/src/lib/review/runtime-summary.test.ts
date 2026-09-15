import { describe, expect, test } from "bun:test";
import { runtimeSummary } from "./runtime-summary";

describe("runtimeSummary", () => {
  const now = Date.parse("2026-08-14T00:01:35.000Z");

  test("matches the Multi Review tile wording for settled and live turns", () => {
    expect(
      runtimeSummary(
        {
          startedAt: "2026-08-14T00:00:00.000Z",
          completedAt: "2026-08-14T00:01:35.000Z",
          tokenCount: 12_345,
        },
        false,
        now,
      ),
    ).toBe("1m 35s · 12k tokens");
    expect(runtimeSummary({ startedAt: "2026-08-14T00:01:28.000Z" }, true, now)).toBe(
      "7s · Tokens pending",
    );
  });

  test("reports only tokens when a settled turn has no honest end time", () => {
    expect(
      runtimeSummary({ startedAt: "2026-08-14T00:00:00.000Z", tokenCount: 500 }, false, now),
    ).toBe("500 tokens");
    expect(runtimeSummary({ startedAt: "2026-08-14T00:00:00.000Z" }, false, now)).toBeNull();
  });

  test("rejects a missing or unparseable start", () => {
    expect(runtimeSummary({}, true, now)).toBeNull();
    expect(runtimeSummary({ startedAt: "soon" }, true, now)).toBeNull();
  });
});
