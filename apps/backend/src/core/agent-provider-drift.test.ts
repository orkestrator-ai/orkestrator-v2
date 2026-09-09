/**
 * How the backend reads drift and notices off a bridge.
 *
 * The bridge already bounds both, but the bridge is a separate process serving
 * a JSON body: nothing here may take a count, a list or a severity on trust.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_PROJECTION_ADVISORIES,
  normalizeProviderContextUsage,
  normalizeProviderDrift,
  normalizeProviderRuntimeNotices,
  normalizeProviderRuntimeSummary,
  providerAdvisoryNotices,
} from "./agent-provider-runtime.js";
import { MAX_NATIVE_AGENT_DRIFT_KINDS } from "@orkestrator/protocol/native-agent";

describe("normalizeProviderContextUsage", () => {
  test("preserves a bounded provider-formatted credit balance", () => {
    expect(
      normalizeProviderContextUsage({
        usedTokens: 1,
        account: [
          { window: "credits", label: "Credits", creditBalance: "12.50" },
          { window: "ignored", creditBalance: 12.5 },
        ],
      })?.account,
    ).toEqual([
      { window: "credits", label: "Credits", creditBalance: "12.50" },
      { window: "ignored" },
    ]);
  });

  test("preserves a positive account-window duration for the elapsed-time marker", () => {
    expect(
      normalizeProviderContextUsage({
        usedTokens: 1,
        account: [
          { window: "billing", windowMinutes: 44_640 },
          { window: "zero", windowMinutes: 0 },
          { window: "invalid", windowMinutes: Number.NaN },
        ],
      })?.account,
    ).toEqual([
      { window: "billing", windowMinutes: 44_640 },
      { window: "zero" },
      { window: "invalid" },
    ]);
  });
});

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

  test("preserves bounded stable identity and subject fields", () => {
    expect(
      normalizeProviderRuntimeNotices([
        {
          id: `mcp:${"x".repeat(300)}`,
          subject: "github",
          message: "github MCP failed to start",
          severity: "error",
        },
      ]),
    ).toEqual([
      {
        id: `mcp:${"x".repeat(252)}`,
        subject: "github",
        message: "github MCP failed to start",
        severity: "error",
        source: "bridge",
      },
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
  test("promotes only error notices into the tab", () => {
    expect(
      providerAdvisoryNotices([
        { message: "inventory", severity: "info" },
        { message: "deprecated", severity: "warning" },
        { message: "broken", severity: "error" },
      ]),
    ).toEqual([{ kind: "advisory", message: "broken", severity: "error" }]);
  });

  test("a legacy notice normalized to warning stays in the health panel", () => {
    const normalized = normalizeProviderRuntimeNotices([{ message: "legacy" }]);
    expect(normalized).toEqual([{ message: "legacy", severity: "warning", source: "bridge" }]);
    expect(providerAdvisoryNotices(normalized)).toEqual([]);
  });

  test("deduplicates by message", () => {
    expect(
      providerAdvisoryNotices([
        { message: "same", severity: "error", method: "a" },
        { message: "same", severity: "error", method: "b" },
      ]),
    ).toEqual([{ kind: "advisory", message: "same", severity: "error" }]);
  });

  test("carries the latest occurrence identity into the tab notice", () => {
    expect(
      providerAdvisoryNotices([
        {
          message: "same",
          method: "failed",
          severity: "error",
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
        severity: "error",
        occurrenceId: "provider\u0000failed\u00002026-09-07T10:01:00.000Z\u00002",
      },
    ]);
  });

  test("uses a stable condition identity instead of repeat timestamps when available", () => {
    expect(
      providerAdvisoryNotices([
        {
          id: "mcp:t1:github",
          message: "github MCP failed to start",
          severity: "error",
          count: 9,
          occurrences: [{ receivedAt: "2026-09-08T10:00:00.000Z" }],
        },
      ]),
    ).toEqual([
      {
        kind: "advisory",
        message: "github MCP failed to start",
        severity: "error",
        occurrenceId: "mcp:t1:github",
      },
    ]);
  });

  test("prefers a stable condition over its mixed-version message-only duplicate", () => {
    expect(
      providerAdvisoryNotices([
        {
          message: "github MCP failed to start",
          severity: "error",
        },
        {
          id: "mcp:t1:github",
          message: "github MCP failed to start",
          severity: "error",
        },
      ]),
    ).toEqual([
      {
        kind: "advisory",
        message: "github MCP failed to start",
        severity: "error",
        occurrenceId: "mcp:t1:github",
      },
    ]);

    expect(
      providerAdvisoryNotices([
        { id: "mcp:t1:a", message: "same", severity: "error" },
        { id: "mcp:t1:b", message: "same", severity: "error" },
      ]),
    ).toHaveLength(2);
  });

  test("is bounded, keeping the most recent", () => {
    const advisories = providerAdvisoryNotices(
      Array.from({ length: 9 }, (_, index) => ({
        message: `advisory-${index}`,
        severity: "error" as const,
      })),
    );
    expect(advisories).toHaveLength(MAX_PROJECTION_ADVISORIES);
    expect(advisories.at(-1)?.message).toBe("advisory-8");
  });

  test("a repeated error moves to the newest position before bounding", () => {
    const advisories = providerAdvisoryNotices([
      ...Array.from({ length: MAX_PROJECTION_ADVISORIES + 1 }, (_, index) => ({
        message: `advisory-${index}`,
        severity: "error" as const,
      })),
      { message: "advisory-0", severity: "error" },
    ]);

    expect(advisories.map((notice) => notice.message)).toEqual([
      "advisory-2",
      "advisory-3",
      "advisory-4",
      "advisory-5",
      "advisory-0",
    ]);
  });

  test("no qualifying notices means no advisories, not an empty row", () => {
    expect(
      providerAdvisoryNotices([
        { message: "quiet", severity: "info" },
        { message: "reported", severity: "warning" },
      ]),
    ).toEqual([]);
  });
});
