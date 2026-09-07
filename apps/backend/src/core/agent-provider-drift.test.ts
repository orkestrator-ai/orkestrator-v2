/**
 * How the backend reads drift and notices off a bridge.
 *
 * The bridge already bounds both, but the bridge is a separate process serving
 * a JSON body: nothing here may take a count, a list or a severity on trust.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_PROJECTION_ADVISORIES,
  normalizeProviderDrift,
  normalizeProviderRuntimeNotices,
  normalizeProviderRuntimeSummary,
  providerAdvisoryNotices,
} from "./agent-provider-runtime.js";
import { MAX_NATIVE_AGENT_DRIFT_KINDS } from "@orkestrator/protocol/native-agent";

describe("normalizeProviderDrift", () => {
  test("accepts a well-formed count and kind list", () => {
    expect(normalizeProviderDrift({ unknownEvents: 3, unknownKinds: ["a", "b"] })).toEqual({
      unknownEvents: 3,
      unknownKinds: ["a", "b"],
    });
  });

  test("a zero or negative count is no drift at all", () => {
    expect(normalizeProviderDrift({ unknownEvents: 0, unknownKinds: [] })).toBeUndefined();
    expect(normalizeProviderDrift({ unknownEvents: -4, unknownKinds: [] })).toBeUndefined();
  });

  test("a non-integer or missing count is rejected outright", () => {
    for (const unknownEvents of [undefined, null, "3", 1.5, Number.NaN, {}]) {
      expect(normalizeProviderDrift({ unknownEvents, unknownKinds: [] })).toBeUndefined();
    }
  });

  test("bounds the kind list and truncates each name", () => {
    const kinds = Array.from({ length: MAX_NATIVE_AGENT_DRIFT_KINDS + 6 }, (_, i) => `kind-${i}`);
    const drift = normalizeProviderDrift({
      unknownEvents: 99,
      unknownKinds: [...kinds, "x".repeat(400)],
    })!;
    expect(drift.unknownKinds).toHaveLength(MAX_NATIVE_AGENT_DRIFT_KINDS);
    // The newest end is retained, which is where the long name is.
    expect(drift.unknownKinds.at(-1)).toHaveLength(128);
  });

  test("drops non-string and empty kinds without dropping the count", () => {
    expect(
      normalizeProviderDrift({ unknownEvents: 2, unknownKinds: [1, "", null, "real"] }),
    ).toEqual({ unknownEvents: 2, unknownKinds: ["real"] });
  });

  test("caps an absurd count rather than trusting it", () => {
    expect(normalizeProviderDrift({ unknownEvents: 10_000_000, unknownKinds: [] })).toEqual({
      unknownEvents: 1_000_000,
      unknownKinds: [],
    });
  });

  test("a missing or non-object value is not drift", () => {
    expect(normalizeProviderDrift(undefined)).toBeUndefined();
    expect(normalizeProviderDrift([])).toBeUndefined();
    expect(normalizeProviderDrift("drift")).toBeUndefined();
  });
});

describe("normalizeProviderRuntimeNotices", () => {
  test("defaults a missing severity and source to the pre-field behaviour", () => {
    expect(normalizeProviderRuntimeNotices([{ message: "something" }])).toEqual([
      { message: "something", severity: "warning", source: "bridge" },
    ]);
  });

  test("keeps a valid severity and source and rejects invented ones", () => {
    expect(
      normalizeProviderRuntimeNotices([
        { message: "a", severity: "error", source: "provider" },
        { message: "b", severity: "catastrophe", source: "vendor" },
      ]),
    ).toEqual([
      { message: "a", severity: "error", source: "provider" },
      { message: "b", severity: "warning", source: "bridge" },
    ]);
  });

  test("drops a notice with no usable message", () => {
    expect(normalizeProviderRuntimeNotices([{ method: "m" }, { message: "" }, null, 7])).toEqual(
      [],
    );
  });

  test("keeps a repeat count only when it is a real repeat", () => {
    const notices = normalizeProviderRuntimeNotices([
      { message: "a", count: 1 },
      { message: "b", count: 4 },
      { message: "c", count: "many" },
    ]);
    expect(notices[0]?.count).toBeUndefined();
    expect(notices[1]?.count).toBe(4);
    expect(notices[2]?.count).toBeUndefined();
  });

  test("truncates the message, method and occurrence detail", () => {
    const notice = normalizeProviderRuntimeNotices([
      {
        message: "m".repeat(4_000),
        method: "x".repeat(400),
        occurrences: [{ detail: "d".repeat(4_000), receivedAt: "r".repeat(400) }],
      },
    ])[0]!;
    expect(notice.message).toHaveLength(1_000);
    expect(notice.method).toHaveLength(128);
    expect(notice.occurrences?.[0]?.detail).toHaveLength(1_000);
    expect(notice.occurrences?.[0]?.receivedAt).toHaveLength(64);
  });

  test("bounds occurrences and drops empty ones", () => {
    const notice = normalizeProviderRuntimeNotices([
      {
        message: "m",
        occurrences: [{}, ...Array.from({ length: 9 }, (_, i) => ({ detail: `d${i}` }))],
      },
    ])[0]!;
    expect(notice.occurrences).toHaveLength(5);
    expect(notice.occurrences?.every((entry) => entry.detail !== undefined)).toBe(true);
  });

  test("a non-array answers empty rather than throwing", () => {
    expect(normalizeProviderRuntimeNotices(undefined)).toEqual([]);
    expect(normalizeProviderRuntimeNotices({ message: "not a list" })).toEqual([]);
  });
});

describe("normalizeProviderRuntimeSummary", () => {
  test("carries drift and notices alongside the counts", () => {
    const summary = normalizeProviderRuntimeSummary({
      mcpServers: 2,
      state: "attached",
      drift: { unknownEvents: 1, unknownKinds: ["odd"] },
      notices: [{ message: "hi", severity: "info", source: "provider" }],
    })!;
    expect(summary).toMatchObject({
      mcpServers: 2,
      state: "attached",
      drift: { unknownEvents: 1, unknownKinds: ["odd"] },
    });
    expect(summary.notices).toEqual([{ message: "hi", severity: "info", source: "provider" }]);
  });

  test("a summary carrying only drift is still a summary", () => {
    expect(
      normalizeProviderRuntimeSummary({ drift: { unknownEvents: 5, unknownKinds: [] } }),
    ).toEqual({ drift: { unknownEvents: 5, unknownKinds: [] } });
  });

  test("an empty payload is no summary at all", () => {
    expect(normalizeProviderRuntimeSummary({})).toBeUndefined();
    expect(normalizeProviderRuntimeSummary(null)).toBeUndefined();
  });
});

describe("providerAdvisoryNotices", () => {
  test("promotes only warning and error notices into the tab", () => {
    expect(
      providerAdvisoryNotices([
        { message: "inventory", severity: "info" },
        { message: "deprecated", severity: "warning" },
        { message: "broken", severity: "error" },
      ]),
    ).toEqual([
      { kind: "advisory", message: "deprecated", severity: "warning" },
      { kind: "advisory", message: "broken", severity: "error" },
    ]);
  });

  test("a notice with no severity is treated as the warning it used to be", () => {
    expect(providerAdvisoryNotices([{ message: "legacy" }])).toEqual([
      { kind: "advisory", message: "legacy", severity: "warning" },
    ]);
  });

  test("deduplicates by message while preserving the highest severity", () => {
    expect(
      providerAdvisoryNotices([
        { message: "same", severity: "warning", method: "a" },
        { message: "same", severity: "error", method: "b" },
      ]),
    ).toEqual([{ kind: "advisory", message: "same", severity: "error" }]);
  });

  test("carries the latest occurrence identity into the tab notice", () => {
    expect(
      providerAdvisoryNotices([
        {
          message: "same",
          method: "warning",
          severity: "warning",
          source: "provider",
          count: 2,
          occurrences: [
            { receivedAt: "2026-09-07T10:00:00.000Z" },
            { receivedAt: "2026-09-07T10:01:00.000Z" },
          ],
        },
      ]),
    ).toEqual([
      {
        kind: "advisory",
        message: "same",
        severity: "warning",
        occurrenceId: "provider\u0000warning\u00002026-09-07T10:01:00.000Z\u00002",
      },
    ]);
  });

  test("is bounded, keeping the most recent", () => {
    const advisories = providerAdvisoryNotices(
      Array.from({ length: 9 }, (_, index) => ({
        message: `advisory-${index}`,
        severity: "warning" as const,
      })),
    );
    expect(advisories).toHaveLength(MAX_PROJECTION_ADVISORIES);
    expect(advisories.at(-1)?.message).toBe("advisory-8");
  });

  test("no qualifying notices means no advisories, not an empty row", () => {
    expect(providerAdvisoryNotices([{ message: "quiet", severity: "info" }])).toEqual([]);
  });
});
