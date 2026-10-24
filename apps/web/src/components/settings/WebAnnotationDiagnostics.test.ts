import { describe, expect, test } from "bun:test";
import { diagnosticsSummary } from "./WebAnnotationDiagnostics";
import { captureProducerLabel } from "@/components/browser/annotations/format";

describe("web annotation diagnostics summary", () => {
  test("headline lines come from categorical series only", () => {
    const lines = diagnosticsSummary({
      backend: {
        counters: {
          "requests_created|operation=implement": 2,
          "requests_created|operation=discuss": 1,
          "request_turn_outcomes|agent=codex|operation=implement|outcome=completed": 2,
          "request_turn_outcomes|agent=grok|operation=discuss|outcome=unknown": 1,
          "evidence_omitted|section=html": 3,
          annotations_reopened: 1,
        },
        durations: {
          "acceptance_ms|source=request|operation=implement": {
            count: 2,
            totalMs: 240_000,
            maxMs: 180_000,
            buckets: [],
          },
        },
        gauges: {},
        droppedSeries: 0,
      },
      desktop: {
        spool: { pending: 1, imageBytes: 2048, maxPending: 16, maxImageBytes: 64 * 1024 * 1024 },
        anchorResolutions: { "matched|stable-id": 3, "ambiguous|semantic-context": 1 },
      },
    });
    expect(lines).toEqual([
      "Requests sent: 3",
      "Turn outcomes: 2 completed, 0 failed, 1 unknown",
      "Evidence sections omitted by the budget: 3",
      "Notes reopened: 1",
      "Accepted results: 2 · mean 2.0 min",
      expect.stringMatching(/^Pending captures on this desktop: 1 of 16, /),
      "Pins resolved on this desktop: 4 (3 matched)",
    ]);
  });

  test("other clients have no desktop lines", () => {
    const lines = diagnosticsSummary({
      backend: { counters: {}, durations: {}, gauges: {}, droppedSeries: 2 },
      desktop: null,
    });
    expect(lines.some((line) => line.includes("desktop"))).toBe(false);
    expect(lines.at(-1)).toBe("Series dropped at the bound: 2");
  });
});

describe("capture producer label", () => {
  test("a client-declared producer is shown as unverified", () => {
    expect(captureProducerLabel({ producer: "desktop-native" })).toBe(
      "Desktop capture (reported by the client, not verified)",
    );
    expect(captureProducerLabel({ producer: "result-capture", producerSource: "backend" })).toBe(
      "After-capture for review",
    );
    expect(captureProducerLabel({ producer: "legacy-import" })).toBe(
      "Imported from a legacy chat draft",
    );
  });
});
