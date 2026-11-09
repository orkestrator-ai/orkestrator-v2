import { describe, expect, test } from "bun:test";

import {
  newestPlanUsage,
  newestSharedUsageReadings,
  normalizeUsageIdentity,
  parseSharedUsageReading,
  planUsageSnapshotFromSharedReading,
  SHARED_USAGE_CLOCK_SKEW_MS,
  sharedUsageReadingFromSnapshot,
  usageIdentityKey,
  type SharedUsageReading,
} from "./agent-account-shared-usage.js";
import {
  isPlanUsageReadingStale,
  PLAN_USAGE_DISPLAY_STALE_MS,
  type PlanUsageSnapshot,
} from "./plan-usage.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const source = { nodeId: "node-beelink", nodeName: "beelink" };
const identity = normalizeUsageIdentity("claude", " 618BTrading@Gmail.com ", "org-1")!;

function reading(minutesAgo: number, usedPercent = 40): SharedUsageReading {
  return {
    identity,
    windows: [
      {
        window: "five_hour",
        label: "5-hour limit",
        usedPercent,
        resetsAt: new Date(NOW + 60 * 60_000).toISOString(),
      },
    ],
    plan: "max",
    fetchedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    source,
  };
}

describe("usage identity", () => {
  test("normalises the email and keeps the organisation", () => {
    expect(identity).toEqual({
      platform: "claude",
      email: "618btrading@gmail.com",
      organizationId: "org-1",
    });
  });

  test("matches only on provider, email and organisation together", () => {
    const key = usageIdentityKey(identity);
    expect(usageIdentityKey(normalizeUsageIdentity("claude", "618btrading@GMAIL.com", "org-1")!)).toBe(
      key,
    );
    expect(usageIdentityKey(normalizeUsageIdentity("codex", "618btrading@gmail.com", "org-1")!)).not.toBe(
      key,
    );
    expect(usageIdentityKey(normalizeUsageIdentity("claude", "other@gmail.com", "org-1")!)).not.toBe(
      key,
    );
    expect(usageIdentityKey(normalizeUsageIdentity("claude", "618btrading@gmail.com", "org-2")!)).not.toBe(
      key,
    );
    expect(usageIdentityKey(normalizeUsageIdentity("claude", "618btrading@gmail.com")!)).not.toBe(key);
  });

  test("a login without an email, or on a platform without accounts, has none", () => {
    expect(normalizeUsageIdentity("claude", undefined)).toBeUndefined();
    expect(normalizeUsageIdentity("claude", "  ")).toBeUndefined();
    expect(normalizeUsageIdentity("cursor", "a@example.com")).toBeUndefined();
  });
});

describe("parseSharedUsageReading", () => {
  test("rebuilds usage fields only and drops everything else", () => {
    const parsed = parseSharedUsageReading(
      {
        ...reading(1),
        accessToken: "sk-secret",
        identity: { ...identity, refreshToken: "secret", cookie: "session=1" },
        windows: [{ ...reading(1).windows[0], token: "secret", raw: { a: 1 } }],
        paidOverage: { enabled: true, inUse: false, apiKey: "secret" },
        message: "a failure text",
        source: { ...source, password: "secret" },
      },
      NOW,
    );
    expect(parsed).toEqual({
      identity,
      windows: [reading(1).windows[0]!],
      plan: "max",
      paidOverage: { enabled: true, inUse: false },
      fetchedAt: reading(1).fetchedAt,
      source,
    });
    expect(JSON.stringify(parsed)).not.toContain("secret");
    expect(Object.keys(parsed!).sort()).toEqual(
      ["fetchedAt", "identity", "paidOverage", "plan", "source", "windows"].sort(),
    );
  });

  test("a fetch time a little ahead is dated now; one far ahead is refused", () => {
    const slightlyAhead = { ...reading(0), fetchedAt: new Date(NOW + 60_000).toISOString() };
    expect(parseSharedUsageReading(slightlyAhead, NOW)?.fetchedAt).toBe(new Date(NOW).toISOString());
    const farAhead = {
      ...reading(0),
      fetchedAt: new Date(NOW + SHARED_USAGE_CLOCK_SKEW_MS + 1_000).toISOString(),
    };
    expect(parseSharedUsageReading(farAhead, NOW)).toBeNull();
  });

  test("refuses a reading with no identity, machine or fetch time", () => {
    expect(parseSharedUsageReading({ ...reading(1), identity: { platform: "claude" } }, NOW)).toBeNull();
    expect(parseSharedUsageReading({ ...reading(1), source: { nodeId: "x" } }, NOW)).toBeNull();
    expect(parseSharedUsageReading({ ...reading(1), fetchedAt: "yesterday" }, NOW)).toBeNull();
  });
});

describe("newest reading", () => {
  test("newest per identity wins across lists", () => {
    const other = { ...reading(1), identity: normalizeUsageIdentity("claude", "x@example.com")! };
    const newest = newestSharedUsageReadings([reading(30)], [reading(2, 90), other], [reading(10)]);
    expect(newest.get(usageIdentityKey(identity))?.windows[0]?.usedPercent).toBe(90);
    expect(newest.size).toBe(2);
  });

  test("a fresh local reading is shared without its message; a stale one is not", () => {
    const local: PlanUsageSnapshot = {
      platform: "claude",
      status: "ok",
      windows: reading(0).windows,
      plan: "max",
      message: "not shared",
      fetchedAt: new Date(NOW).toISOString(),
    };
    expect(sharedUsageReadingFromSnapshot(identity, local, source, NOW)).toEqual({
      identity,
      windows: local.windows,
      plan: "max",
      fetchedAt: local.fetchedAt,
      source,
    });
    expect(
      sharedUsageReadingFromSnapshot(identity, { ...local, stale: true }, source, NOW),
    ).toBeNull();
    expect(
      sharedUsageReadingFromSnapshot(identity, { ...local, status: "error" }, source, NOW),
    ).toBeNull();
  });

  test("the newer of local and shared is shown, naming another machine", () => {
    const shared = planUsageSnapshotFromSharedReading(reading(1, 100), "node-mini", NOW);
    expect(shared.readOn).toEqual(source);
    const local: PlanUsageSnapshot = {
      platform: "claude",
      status: "ok",
      windows: [{ window: "five_hour", usedPercent: 31 }],
      stale: true,
      fetchedAt: new Date(NOW - 2.5 * 24 * 60 * 60_000).toISOString(),
    };
    expect(newestPlanUsage(local, shared)).toBe(shared);
    expect(newestPlanUsage({ ...local, stale: false, fetchedAt: new Date(NOW).toISOString() }, shared).readOn).toBeUndefined();
    expect(newestPlanUsage({ ...local, status: "unavailable" }, shared)).toBe(shared);
    expect(planUsageSnapshotFromSharedReading(reading(1), "node-beelink", NOW).readOn).toBeUndefined();
  });

  test("a shared window whose reset has passed is shown started over", () => {
    const passed = {
      ...reading(90),
      windows: [{ window: "five_hour", usedPercent: 80, resetsAt: new Date(NOW - 1).toISOString() }],
    };
    expect(planUsageSnapshotFromSharedReading(passed, "node-mini", NOW).windows).toEqual([
      { window: "five_hour", usedPercent: 0 },
    ]);
  });
});

describe("display freshness", () => {
  test("stale past the display bound, when marked stale, or with an unreadable time", () => {
    const at = (ms: number) => ({ fetchedAt: new Date(NOW - ms).toISOString() });
    expect(isPlanUsageReadingStale(at(60_000), NOW)).toBe(false);
    expect(isPlanUsageReadingStale(at(PLAN_USAGE_DISPLAY_STALE_MS), NOW)).toBe(false);
    expect(isPlanUsageReadingStale(at(PLAN_USAGE_DISPLAY_STALE_MS + 1), NOW)).toBe(true);
    expect(isPlanUsageReadingStale({ ...at(0), stale: true }, NOW)).toBe(true);
    expect(isPlanUsageReadingStale({ fetchedAt: "never" }, NOW)).toBe(true);
  });
});
