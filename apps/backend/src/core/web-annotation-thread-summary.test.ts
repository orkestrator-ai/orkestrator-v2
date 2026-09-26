import { describe, expect, test } from "bun:test";
import { fixtureEntry } from "@orkestrator/protocol/web-annotations-fixtures";
import {
  THREAD_SUMMARY_LIMITS,
  buildWebAnnotationThreadSummary,
} from "./web-annotation-thread-summary.js";

function entry(sequence: number, body: string, overrides: Parameters<typeof fixtureEntry>[0] = {}) {
  return fixtureEntry({
    id: `entry-${sequence}`,
    sequence,
    body,
    createdAt: `2026-09-24T10:${String(sequence).padStart(2, "0")}:00.000Z`,
    ...overrides,
  });
}

describe("buildWebAnnotationThreadSummary", () => {
  test("excerpts recent human and agent entries with attribution, oldest first", () => {
    const entries = [
      entry(3, "Agent reply\nwith   lines", {
        provenance: "agent-reference",
        kind: "agent-response",
        transcript: {
          requestId: "req-1",
          agent: "codex",
          tabId: "tab-9",
          logicalSessionKey: "env-a:tab-9",
        },
      }),
      entry(1, "First human note"),
      entry(2, "lifecycle", { provenance: "system", kind: "lifecycle" }),
    ];
    const summary = buildWebAnnotationThreadSummary(entries, () => true, "other-session");
    expect(summary).toEqual({
      text: [
        "- [user note, 2026-09-24T10:01:00.000Z] First human note",
        "- [response from codex tab tab-9, 2026-09-24T10:03:00.000Z] Agent reply with lines",
      ].join("\n"),
      entryIds: ["entry-1", "entry-3"],
      context: "other-session",
    });
    // Deterministic for identical input.
    expect(
      buildWebAnnotationThreadSummary([...entries].reverse(), () => true, "other-session"),
    ).toEqual(summary);
  });

  test("is bounded by entry count, entry length, and total size", () => {
    const entries = Array.from({ length: 30 }, (_, index) =>
      entry(index + 1, `note ${index + 1} ${"x".repeat(1_000)}`),
    );
    const summary = buildWebAnnotationThreadSummary(entries, () => true, "follow-up")!;
    // At most `entries` lines, and the oldest are dropped first to fit the total.
    expect(summary.entryIds.length).toBeLessThanOrEqual(THREAD_SUMMARY_LIMITS.entries);
    expect(summary.entryIds.length).toBeGreaterThan(0);
    expect(summary.entryIds.at(-1)).toBe("entry-30");
    expect(summary.text.length).toBeLessThanOrEqual(THREAD_SUMMARY_LIMITS.totalChars);
    for (const line of summary.text.split("\n")) {
      expect(line.length).toBeLessThan(THREAD_SUMMARY_LIMITS.entryChars + 60);
    }
  });

  test("honors the include filter and returns null when nothing qualifies", () => {
    const entries = [entry(1, "Only note"), entry(2, "  ", {})];
    expect(
      buildWebAnnotationThreadSummary(entries, (item) => item.id !== "entry-1", "follow-up"),
    ).toBeNull();
    const superseded = entry(3, "old", { supersededBy: "entry-4" });
    expect(buildWebAnnotationThreadSummary([superseded], () => true, "follow-up")).toBeNull();
  });
});
