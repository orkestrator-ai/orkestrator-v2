import { describe, expect, test } from "bun:test";

import { restorePersistedUsage } from "./acp-persistence.js";

/**
 * Restoring the per-turn rows, which is the half that outlives the process.
 * The parser names every field it keeps, so a new one has to be added here or
 * it silently does not survive a restart.
 */
describe("restorePersistedUsage turn rows", () => {
  const base = { turn: { inputTokens: 10 }, updatedAt: "2026-10-20T09:00:00.000Z" };

  test("keeps the time a turn was finalized", () => {
    // `at` is what dates recorded usage. A turn that came back undated would
    // be counted on the day the reattached session republished it.
    const restored = restorePersistedUsage({
      ...base,
      turns: [{ turnId: "turn-1", at: "2026-08-03T22:30:00.000Z", inputTokens: 7 }],
    });
    expect(restored?.turns).toEqual([
      { turnId: "turn-1", at: "2026-08-03T22:30:00.000Z", inputTokens: 7 },
    ]);
  });

  test("leaves an absent or unusable time off rather than inventing one", () => {
    const restored = restorePersistedUsage({
      ...base,
      turns: [
        { turnId: "no-time", inputTokens: 7 },
        { turnId: "blank", at: "", inputTokens: 7 },
        { turnId: "wrong-type", at: 1_760_000_000_000, inputTokens: 7 },
      ],
    });
    for (const entry of restored?.turns ?? []) expect(entry.at).toBeUndefined();
    expect(restored?.turns?.map((entry) => entry.turnId)).toEqual([
      "no-time",
      "blank",
      "wrong-type",
    ]);
  });
});
