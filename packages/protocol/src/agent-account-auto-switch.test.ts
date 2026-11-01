import { describe, expect, test } from "bun:test";
import {
  MAX_USAGE_LIMIT_RESENDS,
  decideAutoSwitch,
  generalWeeklyWindow,
  isAgentAccountAutoSwitchedEvent,
  isAutoSwitchAccountIncluded,
  normalizeAgentAccountAutoSwitchSettings,
  parseAgentAccountAutoSwitchStates,
  rankAutoSwitchAccounts,
  usageLimitResendCount,
  usageLimitResendPrompt,
  usageLimitResendRequestId,
  weeklyLimitConfirmedUsedUp,
  weeklyLimitReading,
  withAutoSwitchTicks,
  type AutoSwitchAccount,
  type WeeklyLimitReading,
} from "./agent-account-auto-switch.js";
import {
  parseInheritedGlobalSettings,
  pickInheritedGlobalSettings,
} from "./controller-settings.js";
import { parseAgentAccountsSnapshot } from "./agent-accounts.js";
import type { PlanUsageSnapshot } from "./plan-usage.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

function snapshot(overrides: Partial<PlanUsageSnapshot> = {}): PlanUsageSnapshot {
  return {
    platform: "claude",
    status: "ok",
    windows: [],
    fetchedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function account(
  id: string,
  reading: Partial<WeeklyLimitReading>,
  overrides: Partial<AutoSwitchAccount> = {},
): AutoSwitchAccount {
  return {
    account: { id, signedIn: true },
    included: true,
    reading: { freshness: "fresh", wouldPay: false, ...reading },
    ...overrides,
  };
}

const at = (hours: number) => NOW + hours * 3_600_000;

describe("the general weekly limit", () => {
  test("is Claude's seven_day window, never a model, apps or session limit", () => {
    const windows = [
      { window: "five_hour", usedPercent: 100, windowMinutes: 300 },
      { window: "seven_day_fable", usedPercent: 100, windowMinutes: 10_080 },
      { window: "seven_day_opus", usedPercent: 100, windowMinutes: 10_080 },
      { window: "seven_day_sonnet", usedPercent: 100, windowMinutes: 10_080 },
      { window: "seven_day_oauth_apps", usedPercent: 100, windowMinutes: 10_080 },
    ];
    expect(generalWeeklyWindow("claude", windows)).toBeUndefined();
    const general = { window: "seven_day", usedPercent: 12, windowMinutes: 10_080 };
    expect(generalWeeklyWindow("claude", [...windows, general])).toBe(general);
  });

  test("is whichever Codex slot is a week long, in either slot", () => {
    const fiveHour = { window: "primary", usedPercent: 100, windowMinutes: 300 };
    const week = { window: "secondary", usedPercent: 40, windowMinutes: 10_080 };
    expect(generalWeeklyWindow("codex", [fiveHour, week])).toBe(week);
    const swapped = [
      { window: "primary", usedPercent: 40, windowMinutes: 10_080 },
      { window: "secondary", usedPercent: 100, windowMinutes: 300 },
    ];
    expect(generalWeeklyWindow("codex", swapped)).toBe(swapped[0]);
    expect(generalWeeklyWindow("codex", [fiveHour])).toBeUndefined();
    // A window with another id is not one of the general limit's two slots.
    expect(
      generalWeeklyWindow("codex", [{ window: "codex_spark", windowMinutes: 10_080 }]),
    ).toBeUndefined();
  });
});

describe("reading a snapshot", () => {
  test("a reset in the past is not a known reset, and the window has started over", () => {
    const reading = weeklyLimitReading(
      "claude",
      snapshot({
        stale: true,
        windows: [{ window: "seven_day", usedPercent: 100, resetsAt: inHours(-1) }],
      }),
      NOW,
    );
    expect(reading).toEqual({ freshness: "stale", wouldPay: false, usedPercent: 0 });
    expect(weeklyLimitConfirmedUsedUp(reading)).toBe(false);
  });

  test("a stale reading can never confirm a used-up limit", () => {
    const stale = weeklyLimitReading(
      "claude",
      snapshot({
        stale: true,
        windows: [{ window: "seven_day", usedPercent: 100, resetsAt: inHours(24) }],
      }),
      NOW,
    );
    expect(stale.usedPercent).toBe(100);
    expect(weeklyLimitConfirmedUsedUp(stale)).toBe(false);
    expect(
      weeklyLimitConfirmedUsedUp(
        weeklyLimitReading(
          "claude",
          snapshot({ windows: [{ window: "seven_day", usedPercent: 100 }] }),
          NOW,
        ),
      ),
    ).toBe(true);
  });

  test("an unavailable account is unknown, not out", () => {
    expect(
      weeklyLimitReading(
        "claude",
        snapshot({ status: "unavailable", windows: [], message: "refreshed while in use" }),
        NOW,
      ),
    ).toEqual({ freshness: "none", wouldPay: false });
  });

  test("only the provider saying so, or another limit out with paid usage on, would pay", () => {
    const weekly = { window: "seven_day", usedPercent: 10, resetsAt: inHours(10) };
    const read = (overrides: Partial<PlanUsageSnapshot>) =>
      weeklyLimitReading("claude", snapshot({ windows: [weekly], ...overrides }), NOW).wouldPay;
    expect(read({})).toBe(false);
    expect(read({ paidOverage: { enabled: true } })).toBe(false);
    expect(read({ paidOverage: { enabled: false, inUse: true } })).toBe(true);
    expect(
      read({
        paidOverage: { enabled: true },
        windows: [weekly, { window: "five_hour", usedPercent: 100, resetsAt: inHours(2) }],
      }),
    ).toBe(true);
    // Without paid usage a used-up 5-hour limit just refuses; it costs nothing.
    expect(
      read({
        paidOverage: { enabled: false },
        windows: [weekly, { window: "five_hour", usedPercent: 100, resetsAt: inHours(2) }],
      }),
    ).toBe(false);
  });
});

describe("the order", () => {
  test("soonest reset first, with no known reset after every known one", () => {
    const ranked = rankAutoSwitchAccounts(
      [
        account("unknown", { usedPercent: 0 }),
        account("later", { usedPercent: 50, resetsAt: at(48) }),
        account("soon", { usedPercent: 90, resetsAt: at(2) }),
        account("none", {}, { reading: { freshness: "none", wouldPay: false } }),
      ],
      "later",
    );
    expect(ranked.map(({ account: entry }) => entry.id)).toEqual([
      "soon",
      "later",
      "unknown",
      "none",
    ]);
  });

  test("leaves out an unticked, signed-out, paying or used-up account", () => {
    const ranked = rankAutoSwitchAccounts(
      [
        account("active", { usedPercent: 10, resetsAt: at(90) }),
        account("unticked", { usedPercent: 1, resetsAt: at(1) }, { included: false }),
        account(
          "signed-out",
          { usedPercent: 1, resetsAt: at(1) },
          { account: { id: "signed-out", signedIn: false } },
        ),
        account("paying", { usedPercent: 1, resetsAt: at(1), wouldPay: true }),
        account("full", { usedPercent: 98, resetsAt: at(1) }),
      ],
      "active",
    );
    expect(ranked.map(({ account: entry }) => entry.id)).toEqual(["active"]);
  });

  test("a stale reading past the limit keeps an idle account out only while its reset is ahead", () => {
    const stale = { freshness: "stale" as const, usedPercent: 100 };
    expect(
      rankAutoSwitchAccounts(
        [
          account("active", { usedPercent: 10, resetsAt: at(90) }),
          account("idle", { ...stale, resetsAt: at(5) }),
        ],
        "active",
      ).map(({ account: entry }) => entry.id),
    ).toEqual(["active"]);
    // No reset to go on: too little to rule it out, so it ranks last.
    expect(
      rankAutoSwitchAccounts(
        [account("active", { usedPercent: 10, resetsAt: at(90) }), account("idle", stale)],
        "active",
      ).map(({ account: entry }) => entry.id),
    ).toEqual(["active", "idle"]);
  });
});

describe("the decision", () => {
  test("moves to the account that resets soonest", () => {
    expect(
      decideAutoSwitch(
        [
          account("active", { usedPercent: 20, resetsAt: at(100) }),
          account("soon", { usedPercent: 50, resetsAt: at(3) }),
        ],
        "active",
      ),
    ).toEqual({ action: "switch", accountId: "soon", reason: "soonest-reset" });
  });

  test("moves on at 98% of the limit and not before", () => {
    const others = [account("next", { usedPercent: 10, resetsAt: at(100) })];
    expect(
      decideAutoSwitch(
        [account("active", { usedPercent: 97.9, resetsAt: at(3) }), ...others],
        "active",
      ),
    ).toEqual({ action: "stay" });
    expect(
      decideAutoSwitch(
        [account("active", { usedPercent: 98, resetsAt: at(3) }), ...others],
        "active",
      ),
    ).toEqual({ action: "switch", accountId: "next", reason: "threshold" });
  });

  test("a stale reading of the active account never moves the machine", () => {
    expect(
      decideAutoSwitch(
        [
          account("active", { freshness: "stale", usedPercent: 100, resetsAt: at(3) }),
          account("next", { usedPercent: 10, resetsAt: at(100) }),
        ],
        "active",
      ),
    ).toEqual({ action: "stay" });
  });

  test("a tie stays put, so readings cannot make the machine flap", () => {
    expect(
      decideAutoSwitch(
        [
          account("other", { usedPercent: 0 }),
          account("active", {}, { reading: { freshness: "none", wouldPay: false } }),
        ],
        "active",
      ),
    ).toEqual({ action: "stay" });
  });

  test("with every included account out it stays, and work stops at the limit", () => {
    expect(
      decideAutoSwitch(
        [
          account("active", { usedPercent: 100, resetsAt: at(3) }),
          account("full", { usedPercent: 100, resetsAt: at(9) }),
          account("unticked", { usedPercent: 0, resetsAt: at(1) }, { included: false }),
        ],
        "active",
      ),
    ).toEqual({ action: "stay" });
  });

  test("an active account unticked moves the machine off it", () => {
    expect(
      decideAutoSwitch(
        [
          account("active", { usedPercent: 10, resetsAt: at(1) }, { included: false }),
          account("next", { usedPercent: 10, resetsAt: at(100) }),
        ],
        "active",
      ),
    ).toEqual({ action: "switch", accountId: "next", reason: "not-included" });
  });
});

describe("the ticks", () => {
  test("are off by default and read anything malformed as off", () => {
    expect(normalizeAgentAccountAutoSwitchSettings(undefined)).toEqual({});
    expect(
      normalizeAgentAccountAutoSwitchSettings({
        claude: "on",
        codex: { enabled: "yes", excludedEmails: 3 },
        grok: { enabled: true },
      }),
    ).toEqual({});
  });

  test("match by email, ignoring case", () => {
    const settings = withAutoSwitchTicks({}, "claude", { enabled: true });
    expect(settings).toEqual({ claude: { enabled: true, excludedEmails: [] } });
    const excluded = withAutoSwitchTicks(settings, "claude", {
      email: "Work@Example.com",
      included: false,
    });
    expect(excluded.claude?.excludedEmails).toEqual(["work@example.com"]);
    expect(isAutoSwitchAccountIncluded({ email: "WORK@example.com" }, excluded.claude, false)).toBe(
      false,
    );
    expect(isAutoSwitchAccountIncluded({ email: "home@example.com" }, excluded.claude, false)).toBe(
      true,
    );
    expect(
      withAutoSwitchTicks(excluded, "claude", { email: "work@example.com", included: true }).claude
        ?.excludedEmails,
    ).toEqual([]);
  });

  test("an account with no email stays out until ticked on its own machine", () => {
    const ticks = { enabled: true, excludedEmails: [] };
    expect(isAutoSwitchAccountIncluded({}, ticks, false)).toBe(false);
    expect(isAutoSwitchAccountIncluded({}, ticks, true)).toBe(true);
    expect(isAutoSwitchAccountIncluded({ plan: "plus" }, undefined, false)).toBe(false);
  });

  test("travel as one inherited setting, holding emails and flags only", () => {
    const value = { claude: { enabled: true, excludedEmails: ["a@example.com"] } };
    expect(pickInheritedGlobalSettings({ agentAccountAutoSwitch: value })).toEqual({
      agentAccountAutoSwitch: value,
    });
    expect(parseInheritedGlobalSettings({ agentAccountAutoSwitch: value })).toEqual({
      agentAccountAutoSwitch: value,
    });
    expect(JSON.stringify(value)).not.toMatch(/token|credential|accountId/i);
  });
});

describe("a resend's identity", () => {
  test("is the same for the same stop and counts the chain", () => {
    const first = usageLimitResendRequestId("request-1");
    expect(first).toBe(usageLimitResendRequestId("request-1"));
    expect(usageLimitResendCount("request-1")).toBe(0);
    expect(usageLimitResendCount(first)).toBe(1);
    const second = usageLimitResendRequestId(first);
    expect(second).toBe("usage-limit-resend:2:request-1");
    expect(usageLimitResendCount(second)).toBe(2);
    expect(MAX_USAGE_LIMIT_RESENDS).toBeGreaterThan(0);
  });

  test("continues the conversation rather than repeating the prompt", () => {
    expect(usageLimitResendPrompt()).toContain("Do not repeat work");
    expect(usageLimitResendPrompt()).toContain("not by the user");
  });
});

describe("peer answers", () => {
  test("an older machine has no state, and malformed state is dropped", () => {
    expect(parseAgentAccountAutoSwitchStates(undefined)).toBeUndefined();
    expect(
      parseAgentAccountAutoSwitchStates({
        claude: { mode: "pinned", pinnedAccountId: "a", includedAccountIds: ["a", 3] },
        codex: { mode: "sideways" },
      }),
    ).toEqual({ claude: { mode: "pinned", pinnedAccountId: "a", includedAccountIds: ["a"] } });
  });

  test("the snapshot parser carries the state", () => {
    const parsed = parseAgentAccountsSnapshot({
      accounts: [],
      active: { claude: "default", codex: "default" },
      autoSwitch: { claude: { mode: "automatic", includedAccountIds: ["default"] } },
    });
    expect(parsed?.autoSwitch?.claude?.mode).toBe("automatic");
    expect(
      parseAgentAccountsSnapshot({
        accounts: [],
        active: { claude: "default", codex: "default" },
      })?.autoSwitch,
    ).toBeUndefined();
  });

  test("the coordinator notice event holds names and a reason", () => {
    const event = {
      platform: "claude",
      from: "a@example.com",
      to: "b@example.com",
      reason: "limit",
      at: "2026-11-01T12:00:00.000Z",
    };
    expect(isAgentAccountAutoSwitchedEvent(event)).toBe(true);
    expect(isAgentAccountAutoSwitchedEvent({ ...event, reason: "because" })).toBe(false);
    expect(isAgentAccountAutoSwitchedEvent({ ...event, platform: "grok" })).toBe(false);
  });
});

test("signed-out active accounts yield to signed-in accounts, and signed-out destinations are excluded", () => {
  const a = account("a", { freshness: "none" }, { account: { id: "a", signedIn: false } });
  const b = account("b", { usedPercent: 20 });
  expect(decideAutoSwitch([a, b], "a")).toEqual({
    action: "switch",
    accountId: "b",
    reason: "signed-out",
  });
  expect(decideAutoSwitch([a, b], "b")).toEqual({ action: "stay" });
});
