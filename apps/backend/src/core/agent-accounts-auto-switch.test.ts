import { describe, expect, mock, spyOn, test } from "bun:test";
import type {
  AgentAccountAutoSwitchLastKept,
  AgentAccountAutoSwitchMode,
} from "@orkestrator/protocol/agent-account-auto-switch";
import type {
  AgentAccountPlatform,
  AgentAccountsSnapshot,
  AgentAccountSummary,
  AgentSessionAccount,
} from "@orkestrator/protocol/agent-accounts";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import type { NativeAgentRuntimeProvider, ProviderStatus } from "./agent-provider-contract.js";
import {
  AgentAccountAutoSwitcher,
  USAGE_LIMIT_BRIDGE_WAIT_MS,
  USAGE_LIMIT_READ_WAIT_MS,
  USAGE_LIMIT_RECHECK_MS,
  type AutoSwitchNotice,
  type UsageLimitStopReport,
} from "./agent-accounts-auto-switch.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const LIMIT_ERROR = "You've hit your limit · resets 3pm";

type Reading = { used?: number; resetsInHours?: number; stale?: boolean };

function usage(reading: Reading | "unavailable", extra: PlanUsageSnapshot["windows"] = []) {
  if (reading === "unavailable") {
    return {
      platform: "claude",
      status: "unavailable",
      windows: [],
      message: "This account's sign-in is refreshed while it is in use.",
      fetchedAt: inHours(0),
    } satisfies PlanUsageSnapshot;
  }
  return {
    platform: "claude",
    status: "ok",
    windows: [
      {
        window: "seven_day",
        usedPercent: reading.used,
        ...(reading.resetsInHours !== undefined
          ? { resetsAt: inHours(reading.resetsInHours) }
          : {}),
      },
      ...extra,
    ],
    ...(reading.stale ? { stale: true } : {}),
    fetchedAt: inHours(0),
  } satisfies PlanUsageSnapshot;
}

function harness(options: {
  active?: string;
  mode?: AgentAccountAutoSwitchMode;
  accounts: Record<string, PlanUsageSnapshot | (() => PlanUsageSnapshot)>;
  excluded?: string[];
  signedOut?: string[];
  session?: AgentSessionAccount | null;
  busy?: boolean;
  enabled?: boolean;
  /** An account's email, where it is not `<id>@example.com`. */
  emails?: Record<string, string>;
}) {
  let clock = NOW;
  const state = {
    active: options.active ?? Object.keys(options.accounts)[0]!,
    mode: options.mode ?? ("automatic" as AgentAccountAutoSwitchMode),
    busy: options.busy ?? false,
    moved: true,
  };
  const reads: Array<{ accountId: string; force: boolean }> = [];
  const notices: AutoSwitchNotice[] = [];
  const reports: UsageLimitStopReport[] = [];
  const kept: AgentAccountAutoSwitchLastKept[] = [];
  const summaries = Object.keys(options.accounts).map((id): AgentAccountSummary => ({
    id,
    platform: "claude",
    label: options.emails?.[id] ?? `${id}@example.com`,
    isDefault: false,
    isActive: false,
    signedIn: !options.signedOut?.includes(id),
    identity: { email: options.emails?.[id] ?? `${id}@example.com` },
  }));
  const switchAccount = mock(
    async (
      _platform: AgentAccountPlatform,
      accountId: string,
      _automatic: { expectedActive: string; reason: string; expectedIdentity?: string },
    ) => {
      if (!state.moved) return false;
      state.active = accountId;
      return true;
    },
  );
  const snapshot = (): AgentAccountsSnapshot => ({
    accounts: summaries,
    active: { claude: state.active, codex: "default" },
    autoSwitch: {
      claude: {
        mode: state.mode,
        includedAccountIds: Object.keys(options.accounts).filter(
          (id) => !options.excluded?.includes(id),
        ),
      },
    },
  });
  const switcher = new AgentAccountAutoSwitcher({
    settings: async () => ({
      claude: { enabled: state.mode !== "off", excludedEmails: [] },
    }),
    snapshot: async () => snapshot(),
    readUsage: async (_platform, accountId, { force }) => {
      reads.push({ accountId, force });
      const reading = options.accounts[accountId]!;
      const result = typeof reading === "function" ? reading() : reading;
      // These fixtures represent a provider read at the harness clock.
      return result.stale ? result : { ...result, fetchedAt: new Date(clock).toISOString() };
    },
    switchAccount,
    sessionAccount: async () =>
      options.session !== undefined
        ? options.session
        : {
            platform: "claude",
            source: "account",
            account: summaries.find((entry) => entry.id === state.active)!,
            running: true,
          },
    bridgeBusy: async () => state.busy,
    notify: (notice) => {
      notices.push(notice);
    },
    noteKept: (_platform, note) => {
      kept.push(note);
    },
    onLimitStop: (report) => {
      reports.push(report);
    },
    now: () => clock,
  });
  const stop = (overrides: Record<string, unknown> = {}) =>
    switcher.handleLimitStop({
      platform: "claude",
      environmentId: "env-1",
      requestId: "request-1",
      error: LIMIT_ERROR,
      resends: 0,
      ...overrides,
    });
  return {
    switcher,
    summaries,
    state,
    reads,
    notices,
    reports,
    kept,
    switchAccount,
    stop,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("between turns", () => {
  test("moves to the included account that resets soonest and says so", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 20, resetsInHours: 100 }),
        b: usage({ used: 50, resetsInHours: 3 }),
        c: usage({ used: 10, resetsInHours: 40 }),
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("b");
    expect(h.switchAccount.mock.calls[0]?.[2]).toEqual({
      expectedActive: "a",
      expectedIdentity: JSON.stringify({ email: "b@example.com" }),
      reason: "soonest-reset",
    });
    expect(h.notices).toEqual([
      {
        platform: "claude",
        from: "a@example.com",
        to: "b@example.com",
        reason: "soonest-reset",
        at: inHours(0),
      },
    ]);
    // Between turns it reads what is cached; only a limit error forces a read.
    expect(h.reads.every((read) => !read.force)).toBe(true);
  });

  test("a limited Host skips the signed-out second account and lands on the third", async () => {
    const h = harness({
      active: "host",
      signedOut: ["signed-out"],
      accounts: {
        host: usage({ used: 100, resetsInHours: 72 }),
        "signed-out": usage({ used: 10, resetsInHours: 1 }),
        third: usage({ used: 20, resetsInHours: 48 }),
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("third");
    expect(h.switchAccount).toHaveBeenCalledTimes(1);
    expect(h.reads.some(({ accountId }) => accountId === "signed-out")).toBe(false);
  });

  test("a target signed out while usage was read is refused before switching", async () => {
    const h = harness({
      active: "host",
      accounts: {
        host: usage({ used: 100, resetsInHours: 72 }),
        candidate: () => {
          h.summaries.find(({ id }) => id === "candidate")!.signedIn = false;
          return usage({ used: 20, resetsInHours: 24 });
        },
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("host");
    expect(h.switchAccount).not.toHaveBeenCalled();
  });

  test("signed-out active accounts move; signed-out destinations are skipped", async () => {
    const h = harness({
      active: "a",
      signedOut: ["a", "c"],
      accounts: {
        a: usage({ used: 20, resetsInHours: 100 }),
        b: usage({ used: 50, resetsInHours: 3 }),
        c: usage({ used: 0, resetsInHours: 1 }),
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("b");
  });

  test("moves at 98% of the general weekly limit", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 98, resetsInHours: 3 }),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("b");
    expect(h.notices[0]?.reason).toBe("threshold");
  });

  test("a Fable limit never moves the machine", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 20, resetsInHours: 3 }, [
          { window: "seven_day_fable", usedPercent: 100, resetsAt: inHours(3) },
        ]),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("a");
    expect(h.switchAccount).not.toHaveBeenCalled();
  });

  test("a stale reading of the active account never moves the machine", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 100, resetsInHours: 3, stale: true }),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("a");
  });

  test("an account with its tick off is never chosen", async () => {
    const h = harness({
      active: "a",
      excluded: ["b"],
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        b: usage({ used: 5, resetsInHours: 1 }),
        c: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("c");
    expect(h.reads.map((read) => read.accountId).sort()).toEqual(["a", "c"]);
  });

  test("off and pinned read nothing and move nothing", async () => {
    for (const mode of ["off", "pinned"] as const) {
      const h = harness({
        active: "a",
        mode,
        accounts: {
          a: usage({ used: 100, resetsInHours: 3 }),
          b: usage({ used: 5, resetsInHours: 1 }),
        },
      });
      await h.switcher.evaluate("claude");
      expect(h.reads).toEqual([]);
      expect(h.state.active).toBe("a");
    }
  });

  test("gives way to a manual switch that got in first, without a notice", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 99, resetsInHours: 3 }),
        b: usage({ used: 5, resetsInHours: 9 }),
      },
    });
    h.state.moved = false;
    await h.switcher.evaluate("claude");
    expect(h.notices).toEqual([]);
  });

  test("turn ends in a burst cost one evaluation", async () => {
    const h = harness({
      active: "a",
      accounts: { a: usage({ used: 5, resetsInHours: 3 }) },
    });
    h.switcher.noteTurnEnded("claude");
    h.switcher.noteTurnEnded("claude");
    h.switcher.noteTurnEnded("claude");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.switcher.evaluate("claude");
    expect(h.reads.length).toBe(2);
  });
});

describe("two entries for one login", () => {
  const SAME = { a: "same@example.com", twin: "same@example.com" };
  const sessionOn = (id: string): AgentSessionAccount =>
    ({
      platform: "claude",
      source: "account",
      account: { id },
      running: true,
    }) as AgentSessionAccount;

  test("replaying the rkmbp readings moves nothing across repeated cycles", async () => {
    // Reset times as read on rkmbp, with the sub-second values trading places.
    const FIRST = "2026-11-07T17:00:00.404Z";
    const SECOND = "2026-11-07T17:00:00.464Z";
    const weekly = (usedPercent: number, resetsAt: string): PlanUsageSnapshot => ({
      platform: "claude",
      status: "ok",
      windows: [{ window: "seven_day", usedPercent, resetsAt }],
      fetchedAt: inHours(0),
    });
    let swapped = false;
    const h = harness({
      active: "a",
      emails: { ...SAME, c: "other@example.com" },
      accounts: {
        a: () => weekly(35, swapped ? SECOND : FIRST),
        twin: () => weekly(35, swapped ? FIRST : SECOND),
        c: weekly(0, "2026-11-09T21:00:00.485Z"),
      },
    });
    // The gaps between the moves seen on rkmbp, repeated.
    const gaps = [2_254_000, 1_200_000, 13_000, 587_000, 559_000];
    for (let cycle = 0; cycle < 30; cycle += 1) {
      swapped = !swapped;
      h.advance(gaps[cycle % gaps.length]!);
      await h.switcher.evaluate("claude");
    }
    expect(h.switchAccount).not.toHaveBeenCalled();
    expect(h.notices).toEqual([]);
    expect(h.state.active).toBe("a");
  });

  test("at the threshold it passes over the twin for a different login", async () => {
    const h = harness({
      active: "a",
      emails: SAME,
      accounts: {
        a: usage({ used: 98, resetsInHours: 3 }),
        twin: usage({ used: 35, resetsInHours: 3 }),
        c: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("c");
    expect(h.notices[0]?.reason).toBe("threshold");
  });

  test("a confirmed-out login moves to a different one and counts the twin as used up", async () => {
    const h = harness({
      active: "a",
      emails: SAME,
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        twin: usage({ used: 35, resetsInHours: 1 }),
        c: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    expect(await h.stop()).toBe("resend");
    expect(h.state.active).toBe("c");
    expect(h.notices[0]?.reason).toBe("limit");
  });

  test("a confirmed-out login with only its twin left stays stopped", async () => {
    const h = harness({
      active: "a",
      emails: SAME,
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        twin: usage({ used: 35, resetsInHours: 1 }),
      },
    });
    expect(await h.stop()).toBe("stop");
    expect(h.switchAccount).not.toHaveBeenCalled();
    expect(h.state.active).toBe("a");
  });

  test("a limit stop from another login never moves the active entry to its twin", async () => {
    const h = harness({
      active: "a",
      emails: SAME,
      session: sessionOn("c"),
      accounts: {
        a: usage({ used: 35, resetsInHours: 3 }),
        twin: usage({ used: 35, resetsInHours: 1 }),
        c: usage({ used: 100, resetsInHours: 90 }),
      },
    });
    expect(await h.stop()).toBe("resend");
    expect(h.switchAccount).not.toHaveBeenCalled();
  });

  test.each([true, false])(
    "a stop on the active login's twin excludes the whole login (alternative=%s)",
    async (hasAlternative) => {
      const h = harness({
        active: "a",
        emails: SAME,
        session: sessionOn("twin"),
        accounts: {
          a: usage({ used: 35, resetsInHours: 1 }),
          twin: usage({ used: 100, resetsInHours: 3 }),
          ...(hasAlternative ? { c: usage({ used: 5, resetsInHours: 90 }) } : {}),
        },
      });
      expect(await h.stop()).toBe(hasAlternative ? "resend" : "stop");
      expect(h.reads[0]).toEqual({ accountId: "twin", force: true });
      expect(h.state.active).toBe(hasAlternative ? "c" : "a");
      if (hasAlternative) {
        expect(h.switchAccount).toHaveBeenCalledTimes(1);
        expect(h.switchAccount.mock.calls[0]?.[1]).toBe("c");
        expect(h.notices[0]?.reason).toBe("limit");
      } else {
        expect(h.switchAccount).not.toHaveBeenCalled();
        expect(h.notices).toEqual([]);
      }
    },
  );

  test("a limit stop from another login can move a signed-out active entry to its twin", async () => {
    const h = harness({
      active: "a",
      emails: SAME,
      signedOut: ["a"],
      session: sessionOn("c"),
      accounts: {
        a: usage({ used: 35, resetsInHours: 3 }),
        twin: usage({ used: 35, resetsInHours: 3 }),
        c: usage({ used: 100, resetsInHours: 90 }),
      },
    });
    expect(await h.stop()).toBe("resend");
    expect(h.reads[0]).toEqual({ accountId: "c", force: true });
    expect(h.state.active).toBe("twin");
    expect(h.switchAccount).toHaveBeenCalledTimes(1);
    expect(h.switchAccount.mock.calls[0]?.[2]).toEqual({
      expectedActive: "a",
      expectedIdentity: JSON.stringify({ email: SAME.twin }),
      reason: "limit",
    });
    expect(h.notices).toEqual([
      {
        platform: "claude",
        from: SAME.a,
        to: SAME.twin,
        reason: "limit",
        at: inHours(0),
      },
    ]);
  });

  test("signed out, the machine can still move to the twin", async () => {
    const h = harness({
      active: "a",
      emails: SAME,
      signedOut: ["a"],
      accounts: {
        a: usage({ used: 35, resetsInHours: 3 }),
        twin: usage({ used: 35, resetsInHours: 3 }),
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("twin");
    expect(h.notices[0]?.reason).toBe("signed-out");
  });

  test("with its tick off, the machine can still move to the twin", async () => {
    const h = harness({
      active: "a",
      emails: SAME,
      excluded: ["a"],
      accounts: {
        a: usage({ used: 35, resetsInHours: 3 }),
        twin: usage({ used: 35, resetsInHours: 3 }),
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("twin");
    expect(h.notices[0]?.reason).toBe("not-included");
  });
});

describe("the reset tolerance between turns", () => {
  test("a different login within the hour stays, and one past it moves", async () => {
    const within = harness({
      active: "a",
      accounts: {
        a: usage({ used: 20, resetsInHours: 10 }),
        b: usage({ used: 50, resetsInHours: 9 }),
      },
    });
    await within.switcher.evaluate("claude");
    expect(within.switchAccount).not.toHaveBeenCalled();

    const past = harness({
      active: "a",
      accounts: {
        a: usage({ used: 20, resetsInHours: 10 }),
        b: usage({ used: 50, resetsInHours: 8.99 }),
      },
    });
    await past.switcher.evaluate("claude");
    expect(past.state.active).toBe("b");
    expect(past.notices[0]?.reason).toBe("soonest-reset");
  });

  test("a limit stop is not held back by it", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 100, resetsInHours: 10 }),
        b: usage({ used: 50, resetsInHours: 10.5 }),
      },
    });
    expect(await h.stop()).toBe("resend");
    expect(h.state.active).toBe("b");
    expect(h.notices[0]?.reason).toBe("limit");
  });
});

describe("a limit error mid-turn", () => {
  test("takes a fresh reading first, then moves and resends", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    expect(await h.stop()).toBe("resend");
    expect(h.state.active).toBe("b");
    expect(h.reads[0]).toEqual({ accountId: "a", force: true });
    expect(h.notices[0]?.reason).toBe("limit");
  });

  test.each([
    ["a Fable limit", { window: "seven_day_fable", usedPercent: 100, resetsAt: inHours(9) }],
    ["an Opus limit", { window: "seven_day_opus", usedPercent: 100, resetsAt: inHours(9) }],
    ["a Sonnet limit", { window: "seven_day_sonnet", usedPercent: 100, resetsAt: inHours(9) }],
    ["an apps limit", { window: "seven_day_oauth_apps", usedPercent: 100, resetsAt: inHours(9) }],
  ])("%s just stays stopped", async (_name, limit) => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 40, resetsInHours: 3 }, [limit]),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    expect(await h.stop()).toBe("stop");
    expect(h.state.active).toBe("a");
    expect(h.notices).toEqual([]);
  });

  test("the bridge's usage-limit code counts whatever the wording", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    expect(await h.stop({ error: "Request refused.", failureKind: "usage-limit" })).toBe("resend");
    expect(h.state.active).toBe("b");
  });

  test("a failure that is not a limit never reads usage", async () => {
    const h = harness({ active: "a", accounts: { a: usage({ used: 100, resetsInHours: 3 }) } });
    expect(await h.stop({ error: "The model is at capacity" })).toBe("stop");
    expect(await h.stop({ error: undefined })).toBe("stop");
    expect(h.reads).toEqual([]);
  });

  test("while the reading is stale it waits, boundedly, and never moves on it", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 100, resetsInHours: 3, stale: true }),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    expect(await h.stop()).toBe("wait");
    expect(h.state.active).toBe("a");
    h.advance(USAGE_LIMIT_READ_WAIT_MS - 1);
    expect(await h.stop()).toBe("wait");
    h.advance(USAGE_LIMIT_RECHECK_MS);
    expect(await h.stop()).toBe("stop");
    expect(h.state.active).toBe("a");
  });

  test("a workflow polling a waiting stop does not read usage on every poll", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 100, resetsInHours: 3, stale: true }),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    expect(await h.stop()).toBe("wait");
    const reads = h.reads.length;
    h.advance(USAGE_LIMIT_RECHECK_MS - 1);
    expect(await h.stop()).toBe("wait");
    expect(h.reads.length).toBe(reads);
    h.advance(1);
    expect(await h.stop()).toBe("wait");
    expect(h.reads.length).toBeGreaterThan(reads);
  });

  test("an unreadable account waits the same way", async () => {
    const h = harness({
      active: "a",
      accounts: { a: usage("unavailable"), b: usage({ used: 5, resetsInHours: 90 }) },
    });
    expect(await h.stop()).toBe("wait");
    h.advance(USAGE_LIMIT_READ_WAIT_MS);
    expect(await h.stop()).toBe("stop");
  });

  test("a reset already past is no used-up limit", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 100, resetsInHours: -1 }),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    expect(await h.stop()).toBe("stop");
  });

  test("with every included account out, work stops and nothing moves", async () => {
    const h = harness({
      active: "a",
      excluded: ["c"],
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        b: usage({ used: 100, resetsInHours: 90 }),
        c: usage({ used: 0, resetsInHours: 1 }),
      },
    });
    expect(await h.stop()).toBe("stop");
    expect(h.state.active).toBe("a");
    expect(h.notices).toEqual([]);
  });

  test("off or pinned leaves it stopped without a reading", async () => {
    for (const mode of ["off", "pinned"] as const) {
      const h = harness({
        active: "a",
        mode,
        accounts: {
          a: usage({ used: 100, resetsInHours: 3 }),
          b: usage({ used: 5, resetsInHours: 90 }),
        },
      });
      expect(await h.stop()).toBe("stop");
      expect(h.reads).toEqual([]);
    }
  });

  test("an isolated container keeps its own login, so nothing here applies", async () => {
    const h = harness({
      active: "a",
      session: { platform: "claude", source: "container", running: true },
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    expect(await h.stop()).toBe("stop");
    expect(h.state.active).toBe("a");
  });

  test("the resend budget ends a chain of refusals", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    expect(await h.stop({ resends: 3 })).toBe("stop");
    expect(h.reads).toEqual([]);
  });

  test("the new account refusing too moves on to the next, then stops", async () => {
    let bUsed = 5;
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        b: () => usage({ used: bUsed, resetsInHours: 50 }),
        c: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    expect(await h.stop({ requestId: "first" })).toBe("resend");
    expect(h.state.active).toBe("b");
    bUsed = 100;
    h.advance(10 * 60_000);
    expect(await h.stop({ requestId: "second", resends: 1 })).toBe("resend");
    expect(h.state.active).toBe("c");
  });

  test("a new account that refuses for another reason does not loop", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        b: usage({ used: 5, resetsInHours: 50 }),
      },
    });
    expect(await h.stop({ requestId: "first" })).toBe("resend");
    // Past the window where a stop still belongs to the account just left.
    h.advance(10 * 60_000);
    expect(await h.stop({ requestId: "second", resends: 1 })).toBe("stop");
    expect(h.state.active).toBe("b");
  });

  describe("a stop seen right after a move, whose session now reads the new account", () => {
    const before = new Date(NOW - 1_000).toISOString();
    const after = new Date(NOW + 1_000).toISOString();
    const movedOff = (used = 100) =>
      harness({
        active: "a",
        accounts: {
          a: usage({ used, resetsInHours: 90 }),
          b: usage({ used: 5, resetsInHours: 3 }),
        },
      });

    test("a turn sent after the move ran there, so its limit is another one and it stays stopped", async () => {
      const h = movedOff();
      expect(await h.stop({ requestId: "first" })).toBe("resend");
      expect(h.state.active).toBe("b");
      expect(await h.stop({ requestId: "fable", turnStartedAt: after })).toBe("stop");
      expect(h.switchAccount).toHaveBeenCalledTimes(1);
    });

    test("nothing known about when the turn ran stays stopped", async () => {
      const h = movedOff();
      expect(await h.stop({ requestId: "first" })).toBe("resend");
      expect(await h.stop({ requestId: "second" })).toBe("stop");
      expect(await h.stop({ requestId: "third", turnStartedAt: "not a date" })).toBe("stop");
    });

    test("a resend was sent after a move, whatever its turn's start says", async () => {
      const h = movedOff();
      expect(await h.stop({ requestId: "first" })).toBe("resend");
      expect(await h.stop({ requestId: "second", resends: 1, turnStartedAt: before })).toBe("stop");
    });

    test("a turn from before the move resends when the account left reads used up", async () => {
      const h = movedOff();
      expect(await h.stop({ requestId: "first" })).toBe("resend");
      expect(await h.stop({ requestId: "sibling", turnStartedAt: before })).toBe("resend");
      expect(h.switchAccount).toHaveBeenCalledTimes(1);
    });

    test("a turn from before the move stays stopped when the account left has room", async () => {
      const h = movedOff(40);
      await h.switcher.evaluate("claude");
      expect(h.state.active).toBe("b");
      expect(await h.stop({ requestId: "five-hour", turnStartedAt: before })).toBe("stop");
      expect(h.reads).toContainEqual({ accountId: "a", force: true });
    });

    test("past the window it says nothing, even for a turn from before", async () => {
      const h = movedOff();
      expect(await h.stop({ requestId: "first" })).toBe("resend");
      h.advance(10 * 60_000);
      expect(await h.stop({ requestId: "late", turnStartedAt: before })).toBe("stop");
    });
  });

  test("two stopped tabs share a move onto a fresh 99% login with a fresh twin", async () => {
    const h = harness({
      active: "out",
      session: {
        platform: "claude",
        source: "account",
        running: true,
        account: {
          id: "out",
          platform: "claude",
          label: "out",
          isDefault: false,
          isActive: false,
          signedIn: true,
          identity: { email: "out@example.com" },
        },
      },
      emails: { moved: "shared@example.com", twin: "shared@example.com" },
      accounts: {
        out: usage({ used: 100, resetsInHours: 72 }),
        moved: usage({ used: 99, resetsInHours: 30 }),
        twin: usage({ used: 99, resetsInHours: 30 }),
      },
    });
    const verdicts = await Promise.all([
      h.stop({ requestId: "first-tab", environmentId: "env-1" }),
      h.stop({ requestId: "second-tab", environmentId: "env-2" }),
    ]);
    expect(verdicts).toEqual(["resend", "resend"]);
    expect(h.state.active).toBe("moved");
    expect(h.switchAccount).toHaveBeenCalledTimes(1);
    expect(h.kept).toEqual([]);
  });

  test("a second tab stopped by the same limit shares the move and its confirmation", async () => {
    const h = harness({
      active: "a",
      session: {
        platform: "claude",
        source: "account",
        account: {
          id: "a",
          platform: "claude",
          label: "a",
          isDefault: false,
          isActive: false,
          signedIn: true,
          identity: {},
        },
        running: true,
      },
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    const [first, second] = await Promise.all([
      h.stop({ requestId: "tab-1" }),
      h.stop({ requestId: "tab-2" }),
    ]);
    expect([first, second]).toEqual(["resend", "resend"]);
    expect(h.switchAccount).toHaveBeenCalledTimes(1);
    expect(h.notices).toHaveLength(1);
    // The stopped account's confirmation and one probe of the other, shared by both.
    expect(h.reads.filter((read) => read.force).map((read) => read.accountId)).toEqual(["a", "b"]);
  });

  test("a bridge held by another turn makes the resend wait, boundedly", async () => {
    const h = harness({
      active: "a",
      busy: true,
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    const turn = { turnStartedAt: new Date(NOW - 1_000).toISOString() };
    expect(await h.stop(turn)).toBe("wait");
    expect(h.state.active).toBe("b");
    h.advance(USAGE_LIMIT_BRIDGE_WAIT_MS);
    expect(await h.stop(turn)).toBe("stop");
  });

  test("a sibling turn only the workflow can see holds the bridge too", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    let running = true;
    const turn = {
      turnStartedAt: new Date(NOW - 1_000).toISOString(),
      siblingTurnRunning: () => running,
    };
    expect(await h.stop(turn)).toBe("wait");
    expect(h.state.active).toBe("b");
    running = false;
    h.advance(USAGE_LIMIT_RECHECK_MS);
    expect(await h.stop(turn)).toBe("resend");
  });

  test("a notice that fails leaves the switch standing", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 100, resetsInHours: 3 }),
        b: usage({ used: 5, resetsInHours: 90 }),
      },
    });
    const failing = new AgentAccountAutoSwitcher({
      settings: async () => ({ claude: { enabled: true, excludedEmails: [] } }),
      snapshot: async () => ({
        accounts: [],
        active: { claude: "a", codex: "default" },
        autoSwitch: { claude: { mode: "automatic", includedAccountIds: [] } },
      }),
      readUsage: async () => usage({ used: 5 }),
      switchAccount: async () => true,
      sessionAccount: async () => null,
      bridgeBusy: async () => false,
      notify: () => {
        throw new Error("mail is off");
      },
    });
    await failing.evaluate("claude");
    expect(await h.stop()).toBe("resend");
  });
});

describe("the provider a workflow holds", () => {
  test("hands a stop to the switcher for its own platform, and only with accounts", async () => {
    const { createNativeAgentProvider } = await import("./native-agent-provider.js");
    const handleLimitStop = mock(async () => "resend" as const);
    const connection = { baseUrl: "http://127.0.0.1:1", authToken: "token" };
    const claude = createNativeAgentProvider(
      { ...connection, agent: "claude" },
      { usageLimitStops: { handleLimitStop } },
    );
    await expect(
      claude.usageLimitStop?.({
        environmentId: "env-1",
        requestId: "request-1",
        error: LIMIT_ERROR,
        resends: 1,
      }),
    ).resolves.toBe("resend");
    expect(handleLimitStop).toHaveBeenCalledWith({
      platform: "claude",
      environmentId: "env-1",
      requestId: "request-1",
      error: LIMIT_ERROR,
      resends: 1,
      siblingTurnRunning: expect.any(Function),
    });
    expect(
      createNativeAgentProvider(
        { ...connection, agent: "grok" },
        { usageLimitStops: { handleLimitStop } },
      ).usageLimitStop,
    ).toBeUndefined();
    expect(
      createNativeAgentProvider({ ...connection, agent: "codex" }).usageLimitStop,
    ).toBeUndefined();
  });

  test("knows which of its turns its polls last saw running", async () => {
    const { trackRunningTurns } = await import("./native-agent-provider.js");
    const statuses: Record<string, ProviderStatus> = { r1: "running", r2: "blocked" };
    const provider = {
      status: async (sessionId: string) => statuses[sessionId]!,
      observeSession: async (sessionId: string) => ({ status: statuses[sessionId]! }),
    } as unknown as NativeAgentRuntimeProvider;
    const running = trackRunningTurns(provider);
    expect(running()).toBe(false);

    await provider.status("r1");
    await provider.observeSession?.("r2");
    expect(running()).toBe(true);

    // Two turns stopped by one limit must not wait on each other.
    statuses.r1 = "error";
    statuses.r2 = "idle";
    await provider.observeSession?.("r1");
    await provider.status("r2");
    expect(running()).toBe(false);

    // A turn nobody polls any more, such as a cancelled workflow's, holds nothing.
    statuses.r1 = "running";
    await provider.status("r1");
    const now = spyOn(Date, "now").mockReturnValue(Date.now() + 3 * 60_000);
    try {
      expect(running()).toBe(false);
    } finally {
      now.mockRestore();
    }
  });
});

describe("weekly evidence lifetime", () => {
  test("session-only active usage with 5-hour room stays unknown and a stop waits", async () => {
    const partial: PlanUsageSnapshot = {
      platform: "claude",
      status: "ok",
      fetchedAt: inHours(0),
      windows: [{ window: "five_hour", usedPercent: 40 }],
    };
    const h = harness({ accounts: { a: partial, b: usage({ used: 20, resetsInHours: 1 }) } });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("a");
    expect(await h.stop()).toBe("wait");
    expect(h.notices).toHaveLength(0);
  });

  test("confirmation expires at reset before its reuse TTL", async () => {
    let reading = usage({ used: 100, resetsInHours: 1 / 120 });
    const h = harness({
      busy: true,
      accounts: { a: () => reading, b: usage({ used: 20, resetsInHours: 2 }) },
      session: {
        platform: "claude",
        source: "account",
        account: { id: "a" },
        running: true,
      } as AgentSessionAccount,
    });
    expect(await h.stop()).toBe("wait");
    h.advance(60_000);
    reading = usage({ used: 10, resetsInHours: 168 });
    expect(await h.stop({ requestId: "another" })).toBe("stop");
  });

  test("confirmed busy stop retains attribution and proof beyond read and move budgets", async () => {
    let reading = usage({ used: 100, resetsInHours: 24 });
    const h = harness({
      busy: true,
      accounts: { a: () => reading, b: usage({ used: 20, resetsInHours: 2 }) },
    });
    expect(await h.stop({ turnStartedAt: inHours(-1) })).toBe("wait");
    h.advance(11 * 60_000);
    reading = usage("unavailable");
    expect(await h.stop({ turnStartedAt: inHours(-1) })).toBe("wait");
    h.advance(USAGE_LIMIT_RECHECK_MS);
    h.state.busy = false;
    expect(await h.stop({ turnStartedAt: inHours(-1) })).toBe("resend");
  });
});

describe("a stop reported for the coordinators", () => {
  test("reports the account the turn ran on, the reset and the verdict, once", async () => {
    const h = harness({
      active: "out",
      accounts: {
        out: usage({ used: 100, resetsInHours: 8 }),
        room: usage({ used: 10, resetsInHours: 40 }),
      },
    });
    expect(await h.stop({ session: { tabId: "tab-1" } })).toBe("resend");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      platform: "claude",
      environmentId: "env-1",
      requestId: "request-1",
      verdict: "resend",
      resetsAt: Date.parse(inHours(8)),
      resetHint: "3pm",
      session: { tabId: "tab-1" },
    });
    expect(h.reports[0]!.account?.id).toBe("out");
    await h.stop();
    expect(h.reports).toHaveLength(1);
  });

  test("a stop that waits is reported as waiting, when the wait starts and not again", async () => {
    const h = harness({
      active: "out",
      accounts: { out: usage("unavailable"), room: usage({ used: 10, resetsInHours: 40 }) },
    });
    expect(await h.stop()).toBe("wait");
    h.advance(USAGE_LIMIT_RECHECK_MS);
    expect(await h.stop()).toBe("wait");
    h.advance(USAGE_LIMIT_READ_WAIT_MS);
    await h.stop();
    expect(h.reports.map((report) => report.verdict)).toEqual(["wait"]);
  });

  test("with switching off it is still reported, as staying stopped", async () => {
    const h = harness({
      active: "out",
      mode: "off",
      accounts: { out: usage({ used: 100, resetsInHours: 8 }) },
    });
    expect(await h.stop()).toBe("stop");
    expect(h.reports.map((report) => report.verdict)).toEqual(["stop"]);
    expect(h.reports[0]!.account?.id).toBe("out");
  });

  test("an error that is not a usage limit, such as a transient 429, reports nothing", async () => {
    const h = harness({ accounts: { out: usage({ used: 100, resetsInHours: 8 }) } });
    expect(await h.stop({ error: "429 Too Many Requests, retrying" })).toBe("stop");
    await h.switcher.noteUnresentStop({
      platform: "claude",
      environmentId: "env-1",
      requestId: "request-2",
      error: "429 Too Many Requests, retrying",
    });
    expect(h.reports).toHaveLength(0);
  });

  test("a stop on a provider with no accounts is reported with no account", async () => {
    const h = harness({ accounts: { out: usage({ used: 10, resetsInHours: 8 }) } });
    await h.switcher.noteUnresentStop({
      platform: "grok",
      environmentId: "env-1",
      requestId: "request-3",
      error: "USAGE_EXHAUSTED",
    });
    expect(h.reports).toEqual([
      {
        platform: "grok",
        environmentId: "env-1",
        requestId: "request-3",
        verdict: "stop",
      },
    ]);
  });

  test("a failed report retries once without changing the stop decision", async () => {
    let attempts = 0;
    const switcher = new AgentAccountAutoSwitcher({
      settings: async () => ({}),
      snapshot: async () => ({}) as never,
      readUsage: async () => usage({ used: 0 }),
      switchAccount: async () => false,
      sessionAccount: async () => null,
      bridgeBusy: async () => false,
      notify: () => undefined,
      onLimitStop: () => {
        if (++attempts === 1) throw new Error("mail is down");
      },
    });
    expect(
      await switcher.handleLimitStop({
        platform: "claude",
        environmentId: "env-1",
        requestId: "request-1",
        error: LIMIT_ERROR,
        resends: 0,
      }),
    ).toBe("stop");
    for (let i = 0; i < 2; i++)
      await switcher.handleLimitStop({
        platform: "claude",
        environmentId: "env-1",
        requestId: "request-1",
        error: LIMIT_ERROR,
        resends: 0,
      });
    expect(attempts).toBe(2);
  });
});

describe("moving off a limited account for a coordinator", () => {
  const byEmail = (email: string) => (account: AgentAccountSummary) =>
    account.identity.email === email;

  test("moves through the automatic path, which never pins, and passes who it was for", async () => {
    const h = harness({
      active: "out",
      accounts: {
        out: usage({ used: 100, resetsInHours: 8 }),
        room: usage({ used: 10, resetsInHours: 40 }),
      },
    });
    expect(
      await h.switcher.moveOffLimitedAccount("claude", byEmail("out@example.com"), {
        quietProjectId: "project-1",
      }),
    ).toEqual({ moved: true, to: "room@example.com" });
    expect(h.switchAccount.mock.calls[0]?.[2]).toMatchObject({
      expectedActive: "out",
      reason: "limit",
    });
    expect(h.notices[0]?.quietProjectId).toBe("project-1");
  });

  test("two entries of one login both count as limited", async () => {
    const h = harness({
      active: "out",
      emails: { out: "same@example.com", copy: "same@example.com" },
      accounts: {
        out: usage({ used: 90, resetsInHours: 8 }),
        copy: usage({ used: 20, resetsInHours: 8 }),
      },
    });
    expect(await h.switcher.moveOffLimitedAccount("claude", byEmail("same@example.com"))).toEqual({
      moved: false,
      reason: "no-account-with-headroom",
    });
    expect(h.switchAccount).not.toHaveBeenCalled();
  });

  test("gives way to a pin", async () => {
    const h = harness({
      active: "out",
      mode: "pinned",
      accounts: { out: usage({ used: 100 }), room: usage({ used: 10 }) },
    });
    expect(await h.switcher.moveOffLimitedAccount("claude", byEmail("out@example.com"))).toEqual({
      moved: false,
      reason: "account-pinned",
    });
    expect(h.switchAccount).not.toHaveBeenCalled();
  });

  test("gives way to automatic switching being off", async () => {
    const h = harness({
      active: "out",
      mode: "off",
      accounts: { out: usage({ used: 100 }), room: usage({ used: 10 }) },
    });
    expect(await h.switcher.moveOffLimitedAccount("claude", byEmail("out@example.com"))).toEqual({
      moved: false,
      reason: "auto-switch-off",
    });
  });

  test("says so when a manual switch got in first", async () => {
    const h = harness({
      active: "out",
      accounts: { out: usage({ used: 100 }), room: usage({ used: 10, resetsInHours: 40 }) },
    });
    h.state.moved = false;
    expect(await h.switcher.moveOffLimitedAccount("claude", byEmail("out@example.com"))).toEqual({
      moved: false,
      reason: "switch-refused",
    });
  });
});

test("expired and identity-mismatched reset proofs are omitted from stop reports", async () => {
  for (const changedIdentity of [false, true]) {
    const h = harness({ accounts: { a: usage({ used: 100 }), b: usage({ used: 0 }) } });
    await h.stop();
    h.state.active = "a";
    if (changedIdentity) {
      h.summaries[0]!.identity.email = "other@example.com";
    } else h.advance(8 * 24 * 60 * 60_000);
    await h.switcher.noteUnresentStop({
      platform: "claude",
      environmentId: "env-1",
      requestId: "later",
      error: LIMIT_ERROR,
    });
    expect(h.reports.at(-1)?.resetsAt).toBeUndefined();
  }
});

describe("coordinator no-room explanations", () => {
  for (const active of ["limited", "elsewhere"]) {
    test(`records the limited login when active is ${active}`, async () => {
      const h = harness({
        active,
        emails: { twin: "limited@example.com" },
        accounts: {
          limited: usage({ used: 20, resetsInHours: 30 }),
          twin: usage({ used: 20, resetsInHours: 30 }),
          elsewhere: usage({ used: 100, resetsInHours: 80 }),
        },
      });
      expect(
        await h.switcher.moveOffLimitedAccount("claude", (entry) => entry.id === "limited"),
      ).toEqual({ moved: false, reason: "no-account-with-headroom" });
      expect(h.kept).toEqual([
        {
          fromAccountId: "limited",
          at: new Date(NOW).toISOString(),
          blocked:
            active === "limited"
              ? [
                  { accountId: "twin", blocker: "same-login" },
                  { accountId: "elsewhere", blocker: "weekly", usedPercent: 100 },
                ]
              : [{ accountId: "twin", blocker: "same-login" }],
        },
      ]);
      expect(h.switchAccount).not.toHaveBeenCalled();
    });
  }
});
