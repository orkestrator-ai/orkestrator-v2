import { describe, expect, test } from "bun:test";
import {
  AUTO_SWITCH_RESET_TOLERANCE_MS,
  MAX_USAGE_LIMIT_RESENDS,
  autoSwitchNoticeText,
  legacyAutoSwitchEvent,
  confirmedLimitResetsAt,
  decideAutoSwitch,
  explainNoRoom,
  fiveHourWindow,
  generalWeeklyWindow,
  isAgentAccountAutoSwitchedEvent,
  isAutoSwitchAccountIncluded,
  nextFiveHourRefresh,
  normalizeAgentAccountAutoSwitchSettings,
  parseAgentAccountAutoSwitchLastKept,
  parseAgentAccountAutoSwitchStates,
  rankAutoSwitchAccounts,
  usageLimitResendCount,
  usageLimitResendPrompt,
  usageLimitResendRequestId,
  limitConfirmedUsedUp,
  usageLimitReading,
  withAutoSwitchTicks,
  type AutoSwitchAccount,
  type UsageLimitReading,
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
  reading: Partial<UsageLimitReading>,
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

function login(
  id: string,
  email: string | undefined,
  reading: Partial<UsageLimitReading>,
  overrides: { included?: boolean; signedIn?: boolean } = {},
): AutoSwitchAccount {
  return account(id, reading, {
    account: {
      id,
      signedIn: overrides.signedIn ?? true,
      identity: email === undefined ? {} : { email },
    },
    included: overrides.included ?? true,
  });
}

const STAY = { action: "stay" } as const;

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
    const reading = usageLimitReading(
      "claude",
      snapshot({
        stale: true,
        windows: [{ window: "seven_day", usedPercent: 100, resetsAt: inHours(-1) }],
      }),
      NOW,
    );
    expect(reading).toEqual({ freshness: "stale", wouldPay: false, usedPercent: 0 });
    expect(limitConfirmedUsedUp(reading)).toBe(false);
  });

  test("a stale reading can never confirm a used-up limit", () => {
    const stale = usageLimitReading(
      "claude",
      snapshot({
        stale: true,
        windows: [{ window: "seven_day", usedPercent: 100, resetsAt: inHours(24) }],
      }),
      NOW,
    );
    expect(stale.usedPercent).toBe(100);
    expect(limitConfirmedUsedUp(stale)).toBe(false);
    expect(
      limitConfirmedUsedUp(
        usageLimitReading(
          "claude",
          snapshot({ windows: [{ window: "seven_day", usedPercent: 100 }] }),
          NOW,
        ),
      ),
    ).toBe(true);
  });

  test("an unavailable account is unknown, not out", () => {
    expect(
      usageLimitReading(
        "claude",
        snapshot({ status: "unavailable", windows: [], message: "refreshed while in use" }),
        NOW,
      ),
    ).toEqual({ freshness: "none", wouldPay: false });
  });

  test("only the provider saying so, or another limit out with paid usage on, would pay", () => {
    const weekly = { window: "seven_day", usedPercent: 10, resetsAt: inHours(10) };
    const read = (overrides: Partial<PlanUsageSnapshot>) =>
      usageLimitReading("claude", snapshot({ windows: [weekly], ...overrides }), NOW).wouldPay;
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

describe("the reset tolerance", () => {
  const decide = (soonerBy: number) =>
    decideAutoSwitch(
      [
        login("active", "a@example.com", { usedPercent: 20, resetsAt: at(100) }),
        login("other", "b@example.com", { usedPercent: 50, resetsAt: at(100) - soonerBy }),
      ],
      "active",
    );

  test("is one hour", () => {
    expect(AUTO_SWITCH_RESET_TOLERANCE_MS).toBe(3_600_000);
  });

  test("a different login resetting within it stays put, whichever way the gap runs", () => {
    expect(decide(1)).toEqual(STAY);
    expect(decide(30 * 60_000)).toEqual(STAY);
    expect(decide(-30 * 60_000)).toEqual(STAY);
  });

  test("exactly the tolerance stays, and anything past it moves", () => {
    expect(decide(AUTO_SWITCH_RESET_TOLERANCE_MS)).toEqual(STAY);
    expect(decide(AUTO_SWITCH_RESET_TOLERANCE_MS + 1)).toEqual({
      action: "switch",
      accountId: "other",
      reason: "soonest-reset",
    });
  });

  test("it does not change the ranking, which stays strict to the millisecond", () => {
    const ranked = rankAutoSwitchAccounts(
      [
        login("active", "a@example.com", { resetsAt: at(10) + 2 }),
        login("middle", "b@example.com", { resetsAt: at(10) + 1 }),
        login("first", "c@example.com", { resetsAt: at(10) }),
      ],
      "active",
    );
    expect(ranked.map(({ account: entry }) => entry.id)).toEqual(["first", "middle", "active"]);
  });

  test("an active account with no known reset still gives way to one with a reset", () => {
    expect(
      decideAutoSwitch(
        [
          login("active", "a@example.com", { usedPercent: 20 }),
          login("other", "b@example.com", { usedPercent: 50, resetsAt: at(100) }),
        ],
        "active",
      ),
    ).toEqual({ action: "switch", accountId: "other", reason: "soonest-reset" });
  });

  test("a paying account is no destination however much sooner it resets", () => {
    expect(
      decideAutoSwitch(
        [
          login("active", "a@example.com", { usedPercent: 20, resetsAt: at(100) }),
          login("paying", "b@example.com", { usedPercent: 5, resetsAt: at(1), wouldPay: true }),
        ],
        "active",
      ),
    ).toEqual(STAY);
  });

  test.each([
    ["threshold", { usedPercent: 98, resetsAt: at(10) }, {}],
    ["not-included", { usedPercent: 20, resetsAt: at(10) }, { included: false }],
    ["signed-out", { usedPercent: 20, resetsAt: at(10) }, { signedIn: false }],
  ] as const)("does not hold back a %s move", (reason, reading, overrides) => {
    for (const reset of [at(10) + 1, at(10) - 1, at(200)]) {
      expect(
        decideAutoSwitch(
          [
            login("active", "a@example.com", reading, overrides),
            login("other", "b@example.com", { usedPercent: 50, resetsAt: reset }),
          ],
          "active",
        ),
      ).toEqual({ action: "switch", accountId: "other", reason });
    }
  });
});

describe("the same login", () => {
  test("is one account, so resets milliseconds apart stay put in either order", () => {
    for (const [first, second] of [
      [at(10), at(10) + 60],
      [at(10) + 60, at(10)],
    ]) {
      const host = login("host", "same@example.com", { usedPercent: 35, resetsAt: first });
      const added = login("added", "same@example.com", { usedPercent: 35, resetsAt: second });
      for (const active of ["host", "added"]) {
        expect(decideAutoSwitch([host, added], active)).toEqual(STAY);
        expect(decideAutoSwitch([added, host], active)).toEqual(STAY);
      }
    }
  });

  test("never moves onto a twin that resets far sooner, as no allowance is gained", () => {
    expect(
      decideAutoSwitch(
        [
          login("host", "same@example.com", { usedPercent: 35, resetsAt: at(100) }),
          login("added", "same@example.com", { usedPercent: 35, resetsAt: at(1) }),
        ],
        "host",
      ),
    ).toEqual(STAY);
  });

  test("matches email ignoring case and surrounding space", () => {
    expect(
      decideAutoSwitch(
        [
          login("host", "Same@Example.com", { usedPercent: 98, resetsAt: at(10) }),
          login("added", "  same@example.COM ", { usedPercent: 35, resetsAt: at(11) }),
        ],
        "host",
      ),
    ).toEqual(STAY);
  });

  test("a move into a login picks its soonest entry and then stays there", () => {
    const entries = [
      login("active", "a@example.com", { usedPercent: 20, resetsAt: at(100) }),
      login("later-twin", "same@example.com", { usedPercent: 35, resetsAt: at(10) + 60 }),
      login("soon-twin", "same@example.com", { usedPercent: 35, resetsAt: at(10) }),
    ];
    expect(decideAutoSwitch(entries, "active")).toEqual({
      action: "switch",
      accountId: "soon-twin",
      reason: "soonest-reset",
    });
    expect(decideAutoSwitch(entries, "soon-twin")).toEqual(STAY);
    expect(decideAutoSwitch(entries, "later-twin")).toEqual(STAY);
  });

  test("at the threshold it moves to a different login with room, never the twin", () => {
    expect(
      decideAutoSwitch(
        [
          login("host", "same@example.com", { usedPercent: 98, resetsAt: at(3) }),
          login("added", "same@example.com", { usedPercent: 35, resetsAt: at(3) }),
          login("other", "b@example.com", { usedPercent: 5, resetsAt: at(90) }),
        ],
        "host",
      ),
    ).toEqual({ action: "switch", accountId: "other", reason: "threshold" });
  });

  test("at the threshold with only a twin left, it stays", () => {
    expect(
      decideAutoSwitch(
        [
          login("host", "same@example.com", { usedPercent: 100, resetsAt: at(3) }),
          login("added", "same@example.com", { usedPercent: 35, resetsAt: at(3) }),
        ],
        "host",
      ),
    ).toEqual(STAY);
  });

  test("a twin's fresh reading at the threshold speaks for the active entry", () => {
    const out = login("added", "same@example.com", { usedPercent: 98, resetsAt: at(3) });
    const other = login("other", "b@example.com", { usedPercent: 5, resetsAt: at(90) });
    const moved = { action: "switch", accountId: "other", reason: "threshold" } as const;
    for (const reading of [
      { usedPercent: 35, resetsAt: at(3) },
      { freshness: "stale" as const, usedPercent: 35, resetsAt: at(3) },
      { freshness: "none" as const },
    ]) {
      expect(
        decideAutoSwitch([login("host", "same@example.com", reading), out, other], "host"),
      ).toEqual(moved);
    }
  });

  test("a twin's stale reading never moves the active entry, and never overrules a fresher twin", () => {
    const stale = login("old", "same@example.com", {
      freshness: "stale",
      usedPercent: 100,
      resetsAt: at(5),
    });
    expect(
      decideAutoSwitch(
        [
          login("host", "same@example.com", { usedPercent: 35, resetsAt: at(90) }),
          stale,
          login("other", "b@example.com", { usedPercent: 5, resetsAt: at(1) }),
        ],
        "host",
      ),
    ).toEqual({ action: "switch", accountId: "other", reason: "soonest-reset" });
    expect(
      decideAutoSwitch(
        [
          login("host", "same@example.com", { usedPercent: 35, resetsAt: at(5) }),
          stale,
          login("other", "b@example.com", { usedPercent: 5, resetsAt: at(90) }),
        ],
        "host",
      ),
    ).toEqual(STAY);
    // The idle twin was read just now; the old reading of the same login says nothing.
    expect(
      decideAutoSwitch(
        [
          login("active", "a@example.com", { usedPercent: 20, resetsAt: at(100) }),
          login("idle", "same@example.com", { usedPercent: 35, resetsAt: at(1) }),
          stale,
        ],
        "active",
      ),
    ).toEqual({ action: "switch", accountId: "idle", reason: "soonest-reset" });
  });

  test("a stale twin past the threshold still rules out an equally stale one", () => {
    expect(
      decideAutoSwitch(
        [
          login("active", "a@example.com", { usedPercent: 20, resetsAt: at(100) }),
          login("idle", "same@example.com", {
            freshness: "stale",
            usedPercent: 35,
            resetsAt: at(1),
          }),
          login("old", "same@example.com", {
            freshness: "stale",
            usedPercent: 100,
            resetsAt: at(5),
          }),
        ],
        "active",
      ),
    ).toEqual(STAY);
  });

  test("a confirmed-out entry takes its twins out of the order for a limit stop", () => {
    const ranked = rankAutoSwitchAccounts(
      [
        login("host", "same@example.com", { usedPercent: 100 }),
        login("added", "same@example.com", { usedPercent: 35, resetsAt: at(1) }),
        login("other", "b@example.com", { usedPercent: 5, resetsAt: at(90) }),
      ],
      "host",
    );
    expect(ranked.map(({ account: entry }) => entry.id)).toEqual(["other"]);
  });

  test("the order never offers a twin of a usable active entry", () => {
    const ranked = rankAutoSwitchAccounts(
      [
        login("host", "same@example.com", { usedPercent: 35, resetsAt: at(10) + 60 }),
        login("added", "same@example.com", { usedPercent: 35, resetsAt: at(10) }),
      ],
      "host",
    );
    expect(ranked.map(({ account: entry }) => entry.id)).toEqual(["host"]);
  });

  test("signed out, it can still move to a twin, without any tolerance", () => {
    expect(
      decideAutoSwitch(
        [
          login("host", "same@example.com", { freshness: "none" }, { signedIn: false }),
          login("added", "same@example.com", { usedPercent: 35, resetsAt: at(10) }),
        ],
        "host",
      ),
    ).toEqual({ action: "switch", accountId: "added", reason: "signed-out" });
  });

  test("with its tick off, it can still move to a twin, without any tolerance", () => {
    expect(
      decideAutoSwitch(
        [
          login(
            "host",
            "same@example.com",
            { usedPercent: 35, resetsAt: at(10) },
            { included: false },
          ),
          login("added", "same@example.com", { usedPercent: 35, resetsAt: at(10) + 60 }),
        ],
        "host",
      ),
    ).toEqual({ action: "switch", accountId: "added", reason: "not-included" });
  });

  test("a used-up entry with its tick off still counts its twin as used up", () => {
    const host = login("host", "same@example.com", { usedPercent: 100 }, { included: false });
    const added = login("added", "same@example.com", { usedPercent: 35, resetsAt: at(10) });
    expect(decideAutoSwitch([host, added], "host")).toEqual(STAY);
    expect(
      decideAutoSwitch(
        [host, added, login("other", "b@example.com", { usedPercent: 5, resetsAt: at(90) })],
        "host",
      ),
    ).toEqual({ action: "switch", accountId: "other", reason: "not-included" });
  });

  test("a signed-out or unticked twin is still no destination", () => {
    expect(
      decideAutoSwitch(
        [
          login("host", "same@example.com", { freshness: "none" }, { signedIn: false }),
          login("added", "same@example.com", { usedPercent: 35 }, { signedIn: false }),
          login("unticked", "same@example.com", { usedPercent: 35 }, { included: false }),
        ],
        "host",
      ),
    ).toEqual(STAY);
  });
});

describe("entries with no email", () => {
  test("are distinct, for the tolerance and for the threshold", () => {
    const keys = [undefined, "   "] as const;
    for (const first of keys) {
      for (const second of keys) {
        expect(
          decideAutoSwitch(
            [
              login("left", first, { usedPercent: 20, resetsAt: at(100) }),
              login("right", second, { usedPercent: 50, resetsAt: at(1) }),
            ],
            "left",
          ),
        ).toEqual({ action: "switch", accountId: "right", reason: "soonest-reset" });
        expect(
          decideAutoSwitch(
            [
              login("left", first, { usedPercent: 98, resetsAt: at(1) }),
              login("right", second, { usedPercent: 50, resetsAt: at(1) }),
            ],
            "left",
          ),
        ).toEqual({ action: "switch", accountId: "right", reason: "threshold" });
      }
    }
  });

  test("one used up says nothing about another", () => {
    const ranked = rankAutoSwitchAccounts(
      [
        account("left", { usedPercent: 100 }),
        account("right", { usedPercent: 50, resetsAt: at(1) }),
      ],
      "left",
    );
    expect(ranked.map(({ account: entry }) => entry.id)).toEqual(["right"]);
  });

  test("still fall under the tolerance like any other login", () => {
    expect(
      decideAutoSwitch(
        [
          login("left", undefined, { usedPercent: 20, resetsAt: at(10) + 60 }),
          login("right", undefined, { usedPercent: 50, resetsAt: at(10) }),
        ],
        "left",
      ),
    ).toEqual(STAY);
  });
});

describe("the rkmbp readings of 2026-11-04", () => {
  // Host login and an added entry for one login, plus a different login. The
  // moves on rkmbp happened at these times, all for `soonest-reset`.
  const CYCLES = [
    "2026-11-04T01:29:49Z",
    "2026-11-04T02:07:23Z",
    "2026-11-04T02:27:23Z",
    "2026-11-04T02:27:36Z",
    "2026-11-04T02:37:23Z",
    "2026-11-04T02:46:42Z",
  ].map((time) => Date.parse(time));
  const FIRST_RESET = "2026-11-07T17:00:00.404Z";
  const SECOND_RESET = "2026-11-07T17:00:00.464Z";

  const entries = (host: string, added: string, now: number): AutoSwitchAccount[] => {
    const read = (usedPercent: number, resetsAt: string) =>
      usageLimitReading(
        "claude",
        snapshot({ windows: [{ window: "seven_day", usedPercent, resetsAt }] }),
        now,
      );
    return [
      login("host", "same@example.com", read(35, host)),
      login("added", "same@example.com", read(35, added)),
      login("other", "other@example.com", read(0, "2026-11-09T21:00:00.485Z")),
    ];
  };

  test("a reading keeps the sub-second part of a reset, so the two entries can trade places", () => {
    const first = entries(FIRST_RESET, SECOND_RESET, CYCLES[0]!);
    const second = entries(SECOND_RESET, FIRST_RESET, CYCLES[0]!);
    expect(first[0]!.reading.resetsAt).toBeLessThan(first[1]!.reading.resetsAt!);
    expect(second[0]!.reading.resetsAt).toBeGreaterThan(second[1]!.reading.resetsAt!);
  });

  test("replaying them with the sub-second values swapping moves nothing", () => {
    for (const start of ["host", "added"]) {
      let active = start;
      for (let round = 0; round < 10; round += 1) {
        CYCLES.forEach((now, cycle) => {
          const swapped = (round + cycle) % 2 === 1;
          const decision = decideAutoSwitch(
            entries(
              swapped ? SECOND_RESET : FIRST_RESET,
              swapped ? FIRST_RESET : SECOND_RESET,
              now,
            ),
            active,
          );
          if (decision.action === "switch") active = decision.accountId;
          expect(decision).toEqual(STAY);
        });
      }
      expect(active).toBe(start);
    }
  });
});

test("fresh unknown-reset usage ranks ahead of stale or unread usage with an earlier reset", () => {
  const ranked = rankAutoSwitchAccounts(
    [
      account("stale", { freshness: "stale", usedPercent: 31, resetsAt: at(1) }),
      account("unknown", { freshness: "none", resetsAt: at(2) }),
      account("fresh", { freshness: "fresh", usedPercent: 20 }),
    ],
    "limited",
  );
  expect(ranked.map(({ account: entry }) => entry.id)).toEqual(["fresh", "stale", "unknown"]);
});

describe("the 5-hour limit", () => {
  const out = (hours: number) => ({
    freshness: "fresh" as const,
    usedPercent: 100,
    resetsAt: at(hours),
  });
  const ids = (ranked: AutoSwitchAccount[]) => ranked.map(({ account: entry }) => entry.id);

  test.each(["claude", "codex"] as const)(
    "%s inferred expiry also clears inferred paid usage, preserving explicit and other limits",
    (platform) => {
      const base = snapshot({
        platform,
        stale: true,
        fetchedAt: inHours(-6),
        paidOverage: { enabled: true },
        windows: [
          {
            window: platform === "claude" ? "seven_day" : "secondary",
            usedPercent: 20,
            resetsAt: inHours(24),
            windowMinutes: 10_080,
          },
          {
            window: platform === "claude" ? "five_hour" : "primary",
            usedPercent: 100,
            windowMinutes: 300,
          },
        ],
      });
      const read = (value: PlanUsageSnapshot) => usageLimitReading(platform, value, NOW);
      const recovered = read(base);
      expect(recovered.fiveHour?.usedPercent).toBe(0);
      expect(recovered.wouldPay).toBe(false);
      const ranked = (value: UsageLimitReading) =>
        ids(
          rankAutoSwitchAccounts(
            [account("active", { usedPercent: 20, resetsAt: at(48) }), account("return", value)],
            "active",
          ),
        );
      // Recovery makes the account eligible again; fresh usage still ranks first.
      expect(ranked(recovered)).toEqual(["active", "return"]);
      for (const stale of [false, true]) {
        // Explicit provider credit/overage use stays authoritative even after reset.
        const explicit = read({
          ...base,
          stale,
          paidOverage: { enabled: true, inUse: true },
          windows: base.windows.map((window) => ({
            ...window,
            ...(window.windowMinutes === 300 ? { resetsAt: inHours(-1) } : {}),
          })),
        });
        expect(explicit.fiveHour?.usedPercent).toBe(0);
        expect(explicit.wouldPay).toBe(true);
        expect(ranked(explicit)).toEqual(["active"]);
      }
      const modelOut = read({
        ...base,
        windows: [
          ...base.windows,
          { window: "model_limit", usedPercent: 100, resetsAt: inHours(1) },
        ],
      });
      expect(modelOut.wouldPay).toBe(true);
      expect(ranked(modelOut)).toEqual(["active"]);
    },
  );

  test("is Claude's five_hour window and whichever Codex general slot is under a week", () => {
    const fiveHour = { window: "five_hour", usedPercent: 10, windowMinutes: 300 };
    const week = { window: "seven_day", usedPercent: 10, windowMinutes: 10_080 };
    expect(fiveHourWindow("claude", [week, fiveHour])).toBe(fiveHour);
    expect(fiveHourWindow("claude", [week])).toBeUndefined();

    const short = { window: "primary", usedPercent: 10, windowMinutes: 300 };
    const long = { window: "secondary", usedPercent: 10, windowMinutes: 10_080 };
    expect(fiveHourWindow("codex", [short, long])).toBe(short);
    const swappedShort = { ...short, window: "secondary" };
    expect(fiveHourWindow("codex", [{ ...long, window: "primary" }, swappedShort])).toBe(
      swappedShort,
    );
    expect(fiveHourWindow("codex", [long])).toBeUndefined();
    // No length, or a window that is not one of the general limit's slots, says nothing.
    expect(fiveHourWindow("codex", [{ window: "primary", usedPercent: 10 }])).toBeUndefined();
    expect(
      fiveHourWindow("codex", [{ window: "codex_spark", usedPercent: 100, windowMinutes: 300 }]),
    ).toBeUndefined();
  });

  describe("reading a snapshot", () => {
    const weekly = { window: "seven_day", usedPercent: 10, resetsAt: inHours(40) };
    const read = (window: PlanUsageSnapshot["windows"][number], stale = false) =>
      usageLimitReading(
        "claude",
        snapshot({ windows: [weekly, window], ...(stale ? { stale: true } : {}) }),
        NOW,
      ).fiveHour;

    test("carries its level and reset beside the weekly limit", () => {
      expect(read({ window: "five_hour", usedPercent: 98, resetsAt: inHours(2) })).toEqual({
        freshness: "fresh",
        usedPercent: 98,
        resetsAt: at(2),
      });
      expect(read({ window: "five_hour", usedPercent: 98, resetsAt: inHours(2) }, true)).toEqual({
        freshness: "stale",
        usedPercent: 98,
        resetsAt: at(2),
      });
    });

    test("a reset in the past has started the window over", () => {
      expect(read({ window: "five_hour", usedPercent: 100, resetsAt: inHours(-1) })).toEqual({
        freshness: "fresh",
        usedPercent: 0,
      });
    });

    test("with no reset it cannot outlast its own length from when it was read", () => {
      const window = { window: "five_hour", usedPercent: 100, windowMinutes: 300 };
      expect(read(window)?.resetsAt).toBe(at(5));
      expect(
        usageLimitReading("claude", snapshot({ windows: [window], fetchedAt: inHours(-6) }), NOW)
          .fiveHour,
      ).toEqual({ freshness: "fresh", usedPercent: 0 });
    });

    test("is left out when the snapshot has none, or no level for it", () => {
      expect(usageLimitReading("claude", snapshot({ windows: [weekly] }), NOW)).not.toHaveProperty(
        "fiveHour",
      );
      expect(read({ window: "five_hour", resetsAt: inHours(2) })).toBeUndefined();
    });

    test("is read on Codex too, in whichever slot holds it", () => {
      const reading = usageLimitReading(
        "codex",
        snapshot({
          platform: "codex",
          windows: [
            { window: "primary", usedPercent: 12, windowMinutes: 10_080, resetsAt: inHours(40) },
            { window: "secondary", usedPercent: 99, windowMinutes: 300, resetsAt: inHours(1) },
          ],
        }),
        NOW,
      );
      expect(reading).toMatchObject({
        usedPercent: 12,
        resetsAt: at(40),
        fiveHour: { usedPercent: 99, resetsAt: at(1) },
      });
    });
  });

  test("moves the machine at 98% and not before", () => {
    const next = account("next", { usedPercent: 10, resetsAt: at(100) });
    const active = (usedPercent: number) =>
      account("active", {
        usedPercent: 20,
        resetsAt: at(3),
        fiveHour: { freshness: "fresh", usedPercent, resetsAt: at(1) },
      });
    expect(decideAutoSwitch([active(97.9), next], "active")).toEqual(STAY);
    expect(decideAutoSwitch([active(98), next], "active")).toEqual({
      action: "switch",
      accountId: "next",
      reason: "five-hour",
    });
  });

  test("with both limits past the threshold the weekly one is the reason", () => {
    expect(
      decideAutoSwitch(
        [
          account("active", { usedPercent: 98, resetsAt: at(3), fiveHour: out(1) }),
          account("next", { usedPercent: 10, resetsAt: at(100) }),
        ],
        "active",
      ),
    ).toEqual({ action: "switch", accountId: "next", reason: "threshold" });
  });

  test("never changes the order: a nearly full window still ranks by its weekly reset", () => {
    const ranked = rankAutoSwitchAccounts(
      [
        account("later", {
          usedPercent: 1,
          resetsAt: at(90),
          fiveHour: { freshness: "fresh", usedPercent: 0 },
        }),
        account("soon", {
          usedPercent: 90,
          resetsAt: at(9),
          fiveHour: { freshness: "fresh", usedPercent: 97, resetsAt: at(1) },
        }),
        account("out", { usedPercent: 1, resetsAt: at(2), fiveHour: out(4) }),
      ],
      "later",
    );
    expect(ids(ranked)).toEqual(["soon", "later"]);
  });

  test("a stale reading never moves the active account, but keeps an idle one out", () => {
    const stale = { freshness: "stale" as const, usedPercent: 100, resetsAt: at(2) };
    expect(
      decideAutoSwitch(
        [
          account("active", { usedPercent: 20, resetsAt: at(3), fiveHour: stale }),
          account("next", { usedPercent: 10, resetsAt: at(100) }),
        ],
        "active",
      ),
    ).toEqual(STAY);
    expect(
      ids(
        rankAutoSwitchAccounts(
          [
            account("active", { usedPercent: 20, resetsAt: at(90) }),
            account("idle", { usedPercent: 10, resetsAt: at(3), fiveHour: stale }),
          ],
          "active",
        ),
      ),
    ).toEqual(["active"]);
  });

  test("a fresh 5-hour reading speaks even when the week is not known", () => {
    expect(
      decideAutoSwitch(
        [
          account("active", { freshness: "none", fiveHour: out(1) }),
          account("next", { usedPercent: 10, resetsAt: at(100) }),
        ],
        "active",
      ),
    ).toEqual({ action: "switch", accountId: "next", reason: "five-hour" });
    expect(
      decideAutoSwitch(
        [
          account("active", {
            freshness: "none",
            fiveHour: { freshness: "fresh", usedPercent: 40 },
          }),
          account("next", { usedPercent: 10, resetsAt: at(100) }),
        ],
        "active",
      ),
    ).toEqual(STAY);
  });

  test("with every account out on one limit or the other, it stays", () => {
    expect(
      decideAutoSwitch(
        [
          account("active", { usedPercent: 20, resetsAt: at(3), fiveHour: out(1) }),
          account("week-out", { usedPercent: 100, resetsAt: at(9) }),
          account("window-out", { usedPercent: 10, resetsAt: at(20), fiveHour: out(2) }),
        ],
        "active",
      ),
    ).toEqual(STAY);
  });

  test("one login shares it: a twin is no way off, and a twin's reading speaks for the login", () => {
    const fiveHour = out(1);
    expect(
      decideAutoSwitch(
        [
          login("host", "same@example.com", { usedPercent: 20, resetsAt: at(3), fiveHour }),
          login("added", "same@example.com", { usedPercent: 20, resetsAt: at(3) }),
        ],
        "host",
      ),
    ).toEqual(STAY);
    expect(
      decideAutoSwitch(
        [
          login("host", "same@example.com", { usedPercent: 20, resetsAt: at(3) }),
          login("added", "same@example.com", { usedPercent: 20, resetsAt: at(3), fiveHour }),
          login("other", "b@example.com", { usedPercent: 5, resetsAt: at(90) }),
        ],
        "host",
      ),
    ).toEqual({ action: "switch", accountId: "other", reason: "five-hour" });
  });

  test("a move back is held by the reset tolerance like any other soonest-reset move", () => {
    const refreshed = (soonerBy: number) =>
      decideAutoSwitch(
        [
          login("first", "a@example.com", {
            usedPercent: 20,
            resetsAt: at(10) - soonerBy,
            fiveHour: { freshness: "fresh", usedPercent: 0 },
          }),
          login("second", "b@example.com", { usedPercent: 20, resetsAt: at(10) }),
        ],
        "second",
      );
    expect(refreshed(30 * 60_000)).toEqual(STAY);
    expect(refreshed(AUTO_SWITCH_RESET_TOLERANCE_MS + 1)).toEqual({
      action: "switch",
      accountId: "first",
      reason: "soonest-reset",
    });
  });

  describe("across a week on each provider", () => {
    // Weekly resets: first in 24 hours, second in 48, third in 96.
    const fiveHourResetIn = { first: 3, second: 4, third: 5 };
    const week = { first: at(24), second: at(48), third: at(96) };

    const entries = (platform: "claude" | "codex", used: Record<string, number>, now: number) =>
      Object.entries(week).map(([id, weeklyReset]) => {
        const fiveHourReset = new Date(
          NOW + fiveHourResetIn[id as keyof typeof fiveHourResetIn] * 3_600_000,
        ).toISOString();
        const resetsAt = new Date(weeklyReset).toISOString();
        const windows =
          platform === "claude"
            ? [
                { window: "seven_day", usedPercent: 40, resetsAt },
                { window: "five_hour", usedPercent: used[id] ?? 0, resetsAt: fiveHourReset },
              ]
            : [
                { window: "secondary", usedPercent: 40, resetsAt, windowMinutes: 10_080 },
                {
                  window: "primary",
                  usedPercent: used[id] ?? 0,
                  resetsAt: fiveHourReset,
                  windowMinutes: 300,
                },
              ];
        return login(
          id,
          `${id}@example.com`,
          usageLimitReading(platform, snapshot({ platform, windows }), now),
        );
      });

    test.each(["claude", "codex"] as const)(
      "%s burns the soonest weekly first, moves down the list, and comes back",
      (platform) => {
        // Nothing used yet: on the soonest weekly reset.
        expect(decideAutoSwitch(entries(platform, {}, NOW), "third")).toEqual({
          action: "switch",
          accountId: "first",
          reason: "soonest-reset",
        });
        expect(decideAutoSwitch(entries(platform, {}, NOW), "first")).toEqual(STAY);

        // The first 5-hour window fills: the next soonest weekly takes over.
        expect(decideAutoSwitch(entries(platform, { first: 98 }, NOW), "first")).toEqual({
          action: "switch",
          accountId: "second",
          reason: "five-hour",
        });
        expect(decideAutoSwitch(entries(platform, { first: 98 }, NOW), "second")).toEqual(STAY);

        // That fills too, with the first still out: down the list.
        const bothOut = { first: 100, second: 98 };
        expect(decideAutoSwitch(entries(platform, bothOut, NOW), "second")).toEqual({
          action: "switch",
          accountId: "third",
          reason: "five-hour",
        });

        // The first window resets: straight back, past the second, still out.
        const firstReset = NOW + 3 * 3_600_000 + 1;
        expect(decideAutoSwitch(entries(platform, bothOut, firstReset), "third")).toEqual({
          action: "switch",
          accountId: "first",
          reason: "soonest-reset",
        });
        expect(decideAutoSwitch(entries(platform, bothOut, firstReset), "first")).toEqual(STAY);
      },
    );

    test("every window out stays where it is until one resets", () => {
      const allOut = { first: 100, second: 100, third: 100 };
      expect(decideAutoSwitch(entries("claude", allOut, NOW), "third")).toEqual(STAY);
      // Its own window is still out, so that is why it leaves.
      expect(decideAutoSwitch(entries("claude", allOut, NOW + 4.5 * 3_600_000), "third")).toEqual({
        action: "switch",
        accountId: "first",
        reason: "five-hour",
      });
    });
  });

  describe("confirming a limit error", () => {
    const reading = (fiveHour: number, weekly = 40) =>
      usageLimitReading(
        "claude",
        snapshot({
          windows: [
            { window: "seven_day", usedPercent: weekly, resetsAt: inHours(40) },
            { window: "five_hour", usedPercent: fiveHour, resetsAt: inHours(2) },
          ],
        }),
        NOW,
      );

    test("the 5-hour limit counts from the threshold, the weekly limit only at 100%", () => {
      expect(limitConfirmedUsedUp(reading(97.9))).toBe(false);
      expect(limitConfirmedUsedUp(reading(98))).toBe(true);
      expect(limitConfirmedUsedUp(reading(10, 99))).toBe(false);
      expect(limitConfirmedUsedUp(reading(10, 100))).toBe(true);
    });

    test("a stale reading confirms neither", () => {
      expect(
        limitConfirmedUsedUp(
          usageLimitReading(
            "claude",
            snapshot({
              stale: true,
              windows: [
                { window: "seven_day", usedPercent: 100, resetsAt: inHours(40) },
                { window: "five_hour", usedPercent: 100, resetsAt: inHours(2) },
              ],
            }),
            NOW,
          ),
        ),
      ).toBe(false);
    });

    test("the reset is the used-up limit's, and the week outlasts the 5 hours", () => {
      expect(confirmedLimitResetsAt(reading(100))).toBe(at(2));
      expect(confirmedLimitResetsAt(reading(100, 100))).toBe(at(40));
    });
  });

  describe("the next refresh worth looking at", () => {
    test("is the soonest other included account the 5-hour limit alone keeps out", () => {
      expect(
        nextFiveHourRefresh(
          [
            account("active", { usedPercent: 20, resetsAt: at(90), fiveHour: out(1) }),
            account("later", { usedPercent: 20, resetsAt: at(50), fiveHour: out(4) }),
            account("sooner", { usedPercent: 20, resetsAt: at(9), fiveHour: out(2) }),
            account("unticked", { usedPercent: 20, fiveHour: out(0.5) }, { included: false }),
            account("week-out", { usedPercent: 100, resetsAt: at(9), fiveHour: out(0.5) }),
            account("room", {
              usedPercent: 20,
              fiveHour: { freshness: "fresh", usedPercent: 50, resetsAt: at(0.5) },
            }),
          ],
          "active",
        ),
      ).toBe(at(2));
    });

    test("is nothing when no other account is waiting on one", () => {
      expect(
        nextFiveHourRefresh(
          [
            account("active", { usedPercent: 20, resetsAt: at(90), fiveHour: out(1) }),
            account("next", { usedPercent: 20, resetsAt: at(9) }),
          ],
          "active",
        ),
      ).toBeUndefined();
    });
  });

  test("a coordinator's notice says which limit moved the machine", () => {
    const notice = (reason: "five-hour" | "limit") =>
      autoSwitchNoticeText({
        platformLabel: "Codex",
        machineName: "mini",
        from: "a",
        to: "b",
        reason,
      }).body;
    expect(notice("five-hour")).toContain("its 5-hour limit reached 98%");
    expect(notice("limit")).toContain("5-hour or general weekly limit is used up");
    expect(notice("limit")).toContain("work a 5-hour or weekly limit stopped resends itself");
  });

  test("the reason travels between machines", () => {
    expect(
      isAgentAccountAutoSwitchedEvent({
        platform: "codex",
        from: "a",
        to: "b",
        reason: "five-hour",
        at: "2026-11-01T12:00:00.000Z",
      }),
    ).toBe(true);
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

describe("after a limit refused a turn", () => {
  const out = login("out", "a@example.com", { usedPercent: 100, resetsAt: at(80) });

  test("a fresh reading under 100% is somewhere to go; between turns it is not", () => {
    const nearlyFull = login("near", "b@example.com", { usedPercent: 98, resetsAt: at(30) });
    expect(rankAutoSwitchAccounts([out, nearlyFull], "out")).toEqual([]);
    expect(
      rankAutoSwitchAccounts([out, nearlyFull], "out", "after-refusal").map((e) => e.account.id),
    ).toEqual(["near"]);
  });

  test("the 5-hour limit is held to the same bar", () => {
    const fiveHour = login("near", "b@example.com", {
      usedPercent: 10,
      resetsAt: at(30),
      fiveHour: { freshness: "fresh", usedPercent: 99, resetsAt: at(2) },
    });
    expect(
      rankAutoSwitchAccounts([out, fiveHour], "out", "after-refusal").map((e) => e.account.id),
    ).toEqual(["near"]);
    const full = login("full", "c@example.com", {
      usedPercent: 10,
      resetsAt: at(30),
      fiveHour: { freshness: "fresh", usedPercent: 100, resetsAt: at(2) },
    });
    expect(rankAutoSwitchAccounts([out, full], "out", "after-refusal")).toEqual([]);
  });

  test("only a fresh reading is trusted that close: a stale 98% with its reset ahead stays out", () => {
    const stale = login("stale", "b@example.com", {
      freshness: "stale",
      usedPercent: 98,
      resetsAt: at(30),
    });
    expect(rankAutoSwitchAccounts([out, stale], "out", "after-refusal")).toEqual([]);
  });

  for (const usedPercent of [98, 99, 100]) {
    test(`an active ${usedPercent}% login and its fresh twin use the refusal rule`, () => {
      const moved = login("moved", "b@example.com", { usedPercent, resetsAt: at(30) });
      const twin = login("twin", "b@example.com", { usedPercent, resetsAt: at(30) });
      expect(
        rankAutoSwitchAccounts([out, moved, twin], "moved", "after-refusal").map(
          (entry) => entry.account.id,
        ),
      ).toEqual(usedPercent < 100 ? ["moved"] : []);
      expect(rankAutoSwitchAccounts([out, moved, twin], "moved")).toEqual([]);
    });
  }

  for (const rule of ["between-turns", "after-refusal"] as const) {
    test(`a fresh five-hour twin without a weekly reading blocks under ${rule}`, () => {
      const candidate = login("candidate", "b@example.com", { usedPercent: 20, resetsAt: at(30) });
      const twin = login("twin", "b@example.com", {
        freshness: "none",
        fiveHour: { freshness: "fresh", usedPercent: 100, resetsAt: at(2) },
      });
      expect(rankAutoSwitchAccounts([out, candidate, twin], "out", rule)).toEqual([]);
      expect(rankAutoSwitchAccounts([out, candidate, twin], "candidate", rule)).toEqual([]);
    });
  }

  test("a stale five-hour twin cannot veto a fresh five-hour reading", () => {
    const candidate = login("candidate", "b@example.com", {
      freshness: "none",
      fiveHour: { freshness: "fresh", usedPercent: 20, resetsAt: at(2) },
    });
    const twin = login("twin", "b@example.com", {
      usedPercent: 20,
      fiveHour: { freshness: "stale", usedPercent: 100, resetsAt: at(2) },
    });
    expect(
      rankAutoSwitchAccounts([out, candidate, twin], "out", "after-refusal").map(
        (entry) => entry.account.id,
      ),
    ).toEqual(["candidate"]);
  });

  test("the account just moved onto at 99% still has room for the next stopped turn", () => {
    const moved = login("moved", "b@example.com", { usedPercent: 99, resetsAt: at(30) });
    expect(
      rankAutoSwitchAccounts([out, moved], "moved", "after-refusal").map((e) => e.account.id),
    ).toEqual(["moved"]);
  });
});

describe("why the machine stayed", () => {
  test("names what kept each other included, signed-in account out", () => {
    const entries = [
      login("out", "a@example.com", { usedPercent: 100, resetsAt: at(80) }),
      login("twin", "a@example.com", { usedPercent: 10, resetsAt: at(80) }),
      login("weekly", "b@example.com", { freshness: "stale", usedPercent: 98, resetsAt: at(30) }),
      login("five", "c@example.com", {
        usedPercent: 20,
        resetsAt: at(30),
        fiveHour: { freshness: "fresh", usedPercent: 100, resetsAt: at(1) },
      }),
      login("pays", "d@example.com", { usedPercent: 20, resetsAt: at(30), wouldPay: true }),
      login("unticked", "e@example.com", { usedPercent: 0 }, { included: false }),
      login("signed-out", "f@example.com", { usedPercent: 0 }, { signedIn: false }),
    ];
    expect(rankAutoSwitchAccounts(entries, "out", "after-refusal")).toEqual([]);
    expect(explainNoRoom(entries, "out", "after-refusal")).toEqual([
      { accountId: "twin", blocker: "same-login" },
      { accountId: "weekly", blocker: "weekly", usedPercent: 98, stale: true },
      { accountId: "five", blocker: "five-hour", usedPercent: 100 },
      { accountId: "pays", blocker: "would-pay" },
    ]);
  });

  test("a five-hour blocker uses its own stale flag when no weekly window exists", () => {
    const reading = usageLimitReading(
      "claude",
      snapshot({
        stale: true,
        windows: [{ window: "five_hour", usedPercent: 100, resetsAt: inHours(2) }],
      }),
      NOW,
    );
    expect(reading.freshness).toBe("none");
    expect(
      explainNoRoom(
        [
          login("out", "a@example.com", { usedPercent: 100 }),
          login("five", "b@example.com", reading),
        ],
        "out",
        "after-refusal",
      ),
    ).toEqual([{ accountId: "five", blocker: "five-hour", usedPercent: 100, stale: true }]);
  });

  test("an unreadable record reads as absent, and its entries are bounded", () => {
    expect(parseAgentAccountAutoSwitchLastKept({ at: "x" })).toBeUndefined();
    const parsed = parseAgentAccountAutoSwitchLastKept({
      fromAccountId: "out",
      at: "2026-11-06T04:07:56.000Z",
      blocked: [
        { accountId: "b", blocker: "weekly", usedPercent: 140, stale: true },
        { accountId: "c", blocker: "because" },
        ...Array.from({ length: 40 }, (_, index) => ({
          accountId: `x${index}`,
          blocker: "would-pay",
        })),
      ],
    });
    expect(parsed?.blocked[0]).toEqual({
      accountId: "b",
      blocker: "weekly",
      usedPercent: 100,
      stale: true,
    });
    expect(parsed?.blocked.some((entry) => entry.accountId === "c")).toBe(false);
    expect(parsed!.blocked.length).toBeLessThanOrEqual(32);
  });

  test("peer state carries it", () => {
    const lastKept = { fromAccountId: "out", at: "2026-11-06T04:07:56.000Z", blocked: [] };
    expect(
      parseAgentAccountAutoSwitchStates({
        claude: { mode: "automatic", includedAccountIds: ["out"], lastKept },
      })?.claude?.lastKept,
    ).toEqual(lastKept);
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

test("legacy events use an older reason while the outbox notice keeps five-hour", () => {
  const notice = {
    platform: "claude" as const,
    from: "first",
    to: "second",
    reason: "five-hour" as const,
    at: "2026-11-01T12:00:00Z",
  };
  const legacy = legacyAutoSwitchEvent(notice);
  const oldReasons = ["threshold", "limit", "soonest-reset", "not-included", "signed-out"];
  expect(oldReasons.includes(legacy.reason)).toBe(true);
  expect(legacy).toEqual({ ...notice, reason: "limit" });
  expect(notice.reason).toBe("five-hour");
  expect(legacyAutoSwitchEvent({ ...notice, reason: "limit" })).toEqual(legacy);
});
