import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type {
  AgentAccountPlatform,
  AgentAccountsSnapshot,
  AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import {
  AUTO_SWITCH_EVALUATE_INTERVAL_MS,
  AgentAccountAutoSwitcher,
  USAGE_LIMIT_READ_WAIT_MS,
  USAGE_LIMIT_BRIDGE_WAIT_MS,
  type AutoSwitchNotice,
  type UsageLimitStopReport,
} from "./agent-accounts-auto-switch.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(NOW + hours * HOUR).toISOString();
const LIMIT_ERROR = "You've hit your 5-hour limit · resets 3pm";

interface Limits {
  weekly?: number;
  weeklyResetHours: number;
  /** Absent: the snapshot reports no 5-hour window. */
  fiveHour?: number;
  fiveHourResetHours?: number;
  stale?: boolean;
}

/** Each provider's own shape: Claude's named windows, Codex's two general slots. */
function reading(platform: AgentAccountPlatform, limits: Limits): PlanUsageSnapshot {
  const weeklyReset = inHours(limits.weeklyResetHours);
  const fiveHourReset =
    limits.fiveHourResetHours !== undefined ? inHours(limits.fiveHourResetHours) : undefined;
  const fiveHour = limits.fiveHour !== undefined;
  const windows =
    platform === "claude"
      ? [
          { window: "seven_day", usedPercent: limits.weekly ?? 20, resetsAt: weeklyReset },
          ...(fiveHour
            ? [
                {
                  window: "five_hour",
                  usedPercent: limits.fiveHour,
                  ...(fiveHourReset ? { resetsAt: fiveHourReset } : {}),
                },
              ]
            : []),
        ]
      : [
          {
            window: "secondary",
            usedPercent: limits.weekly ?? 20,
            resetsAt: weeklyReset,
            windowMinutes: 10_080,
          },
          ...(fiveHour
            ? [
                {
                  window: "primary",
                  usedPercent: limits.fiveHour,
                  windowMinutes: 300,
                  ...(fiveHourReset ? { resetsAt: fiveHourReset } : {}),
                },
              ]
            : []),
        ];
  return {
    platform,
    status: "ok",
    windows,
    ...(limits.stale ? { stale: true } : {}),
    fetchedAt: inHours(0),
  };
}

function harness(platform: AgentAccountPlatform, limits: Record<string, Limits>, active: string) {
  let clock = NOW;
  const state = { active, limits, busy: false };
  const notices: AutoSwitchNotice[] = [];
  const reports: UsageLimitStopReport[] = [];
  const summaries = Object.keys(limits).map((id): AgentAccountSummary => ({
    id,
    platform,
    label: id,
    isDefault: false,
    isActive: false,
    signedIn: true,
    identity: { email: `${id}@example.com` },
  }));
  const switchAccount = mock(async (_platform: AgentAccountPlatform, accountId: string) => {
    state.active = accountId;
    return true;
  });
  const switcher = new AgentAccountAutoSwitcher({
    settings: async () => ({ [platform]: { enabled: true, excludedEmails: [] } }),
    snapshot: async (): Promise<AgentAccountsSnapshot> => ({
      accounts: summaries,
      active: {
        claude: platform === "claude" ? state.active : "default",
        codex: platform === "codex" ? state.active : "default",
      },
      autoSwitch: {
        [platform]: { mode: "automatic", includedAccountIds: Object.keys(limits) },
      },
    }),
    readUsage: async (_platform, accountId) => {
      const result = reading(platform, state.limits[accountId]!);
      return result.stale ? result : { ...result, fetchedAt: new Date(clock).toISOString() };
    },
    switchAccount,
    sessionAccount: async () => ({
      platform,
      source: "account",
      account: summaries.find((entry) => entry.id === state.active)!,
      running: true,
    }),
    bridgeBusy: async () => state.busy,
    notify: (notice) => {
      notices.push(notice);
    },
    onLimitStop: (report) => {
      reports.push(report);
    },
    now: () => clock,
  });
  const stop = (requestId = "request-1") =>
    switcher.handleLimitStop({
      platform,
      environmentId: "env-1",
      requestId,
      error: LIMIT_ERROR,
      resends: 0,
    });
  return {
    switcher,
    state,
    notices,
    reports,
    switchAccount,
    stop,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe.each(["claude", "codex"] as const)("the 5-hour limit on %s", (platform) => {
  const three = (): Record<string, Limits> => ({
    first: { weeklyResetHours: 24, fiveHour: 10, fiveHourResetHours: 3 },
    second: { weeklyResetHours: 48, fiveHour: 10, fiveHourResetHours: 4 },
    third: { weeklyResetHours: 96, fiveHour: 10, fiveHourResetHours: 5 },
  });

  test("at 98% between turns it moves to the next soonest weekly, and back when it resets", async () => {
    const limits = three();
    const h = harness(platform, limits, "first");
    await h.switcher.evaluate(platform);
    expect(h.switchAccount).not.toHaveBeenCalled();

    limits.first!.fiveHour = 98;
    await h.switcher.evaluate(platform);
    expect(h.state.active).toBe("second");
    expect(h.notices.at(-1)).toMatchObject({ from: "first", to: "second", reason: "five-hour" });

    // Still out: it stays on the second, whatever the first's weekly reset says.
    h.advance(HOUR);
    await h.switcher.evaluate(platform);
    expect(h.state.active).toBe("second");

    limits.second!.fiveHour = 100;
    await h.switcher.evaluate(platform);
    expect(h.state.active).toBe("third");

    h.advance(2 * HOUR + 1);
    await h.switcher.evaluate(platform);
    expect(h.state.active).toBe("first");
    expect(h.notices.at(-1)).toMatchObject({
      from: "third",
      to: "first",
      reason: "soonest-reset",
    });
    expect(h.switchAccount).toHaveBeenCalledTimes(3);
  });

  test("a refusal it confirms moves the machine and resends", async () => {
    const limits = three();
    limits.first!.fiveHour = 100;
    const h = harness(platform, limits, "first");
    expect(await h.stop()).toBe("resend");
    expect(h.state.active).toBe("second");
    expect(h.notices[0]?.reason).toBe("limit");
    // The coordinator hears when this limit lifts, not when the week does.
    expect(h.reports[0]).toMatchObject({
      verdict: "resend",
      resetsAt: Date.parse(inHours(3)),
      resetHint: "3pm",
    });
  });

  test("a confirmed stopped request survives a five-hour reset during a bridge wait", async () => {
    const limits = three();
    limits.first = { weeklyResetHours: 24, fiveHour: 100, fiveHourResetHours: 1 / 6 };
    const h = harness(platform, limits, "first");
    h.state.busy = true;
    expect(await h.stop()).toBe("wait");
    expect(h.state.active).toBe("second");
    h.advance(11 * 60_000);
    limits.first!.fiveHour = 0;
    expect(await h.stop()).toBe("wait");
    h.advance(60_000);
    h.state.busy = false;
    expect(await h.stop()).toBe("resend");
    expect(h.switchAccount).toHaveBeenCalledTimes(1);
    // A different request cannot borrow the first request's attribution.
    expect(await h.stop("different-request")).toBe("stop");
  });

  test("confirmed attribution still expires at the bridge wait budget", async () => {
    const limits = three();
    limits.first = { weeklyResetHours: 24, fiveHour: 100, fiveHourResetHours: 1 / 6 };
    const h = harness(platform, limits, "first");
    h.state.busy = true;
    expect(await h.stop()).toBe("wait");
    h.advance(USAGE_LIMIT_BRIDGE_WAIT_MS);
    limits.first!.fiveHour = 0;
    h.state.busy = false;
    expect(await h.stop()).toBe("stop");
  });

  test("a refusal reading just under 100% still counts from the threshold", async () => {
    const limits = three();
    limits.first!.fiveHour = 98.5;
    const h = harness(platform, limits, "first");
    expect(await h.stop()).toBe("resend");
    expect(h.state.active).toBe("second");
  });

  test("a refusal with 5-hour room reads as another limit and stays stopped", async () => {
    const limits = three();
    limits.first!.fiveHour = 97;
    const h = harness(platform, limits, "first");
    expect(await h.stop()).toBe("stop");
    expect(h.state.active).toBe("first");
    expect(h.notices).toEqual([]);
  });

  test("a stale reading confirms nothing, so the stop waits", async () => {
    const limits = three();
    limits.first = { weeklyResetHours: 24, fiveHour: 100, fiveHourResetHours: 3, stale: true };
    const h = harness(platform, limits, "first");
    expect(await h.stop()).toBe("wait");
    expect(h.state.active).toBe("first");
    h.advance(USAGE_LIMIT_READ_WAIT_MS);
    expect(await h.stop()).toBe("stop");
  });

  test("with every other account out too, the stop stays where it is", async () => {
    const limits = three();
    limits.first!.fiveHour = 100;
    limits.second!.fiveHour = 100;
    limits.third!.weekly = 100;
    const h = harness(platform, limits, "first");
    expect(await h.stop()).toBe("stop");
    expect(h.state.active).toBe("first");
  });

  test("a snapshot with no 5-hour window keeps the weekly rule", async () => {
    const h = harness(
      platform,
      { first: { weeklyResetHours: 24 }, second: { weeklyResetHours: 48 } },
      "first",
    );
    await h.switcher.evaluate(platform);
    expect(h.state.active).toBe("first");
    expect(await h.stop()).toBe("stop");
  });
});

describe("the check when a 5-hour limit resets", () => {
  afterEach(() => {
    mock.restore();
  });

  function capture() {
    const armed: Array<{ run: () => void; delay: number }> = [];
    const real = globalThis.setTimeout;
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
      run: () => void,
      delay?: number,
    ) => {
      armed.push({ run, delay: delay ?? 0 });
      return real(() => undefined, 0);
    }) as unknown as typeof setTimeout);
    return { armed, spy };
  }

  const limits = (): Record<string, Limits> => ({
    first: { weeklyResetHours: 24, fiveHour: 100, fiveHourResetHours: 3 },
    second: { weeklyResetHours: 48, fiveHour: 10, fiveHourResetHours: 4 },
  });

  test("is armed for the account left behind, and moves back when it fires", async () => {
    const h = harness("claude", limits(), "first");
    h.switcher.start();
    try {
      const { armed, spy } = capture();
      await h.switcher.evaluate("claude");
      spy.mockRestore();
      expect(h.state.active).toBe("second");
      const wake = armed.find(({ delay }) => delay >= 3 * HOUR);
      expect(wake?.delay).toBeGreaterThanOrEqual(3 * HOUR);
      expect(wake?.delay).toBeLessThanOrEqual(3 * HOUR + 60_000);

      h.advance(wake!.delay);
      wake!.run();
      for (let attempt = 0; attempt < 100 && h.state.active !== "first"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(h.state.active).toBe("first");
      expect(h.notices.at(-1)?.reason).toBe("soonest-reset");
    } finally {
      h.switcher.stop();
    }
  });

  test.each(["stop", "coordinator"] as const)(
    "returns after a %s move when the next turn edge arms the reset wake",
    async (path) => {
      const h = harness("codex", limits(), "first");
      h.switcher.start();
      try {
        if (path === "stop") expect(await h.stop()).toBe("resend");
        else
          expect(
            await h.switcher.moveOffLimitedAccount("codex", (a) => a.id === "first"),
          ).toMatchObject({ moved: true });
        expect(h.state.active).toBe("second");
        const { armed, spy } = capture();
        h.switcher.noteTurnEnded("codex");
        // Drain the asynchronous nudge without calling evaluate ourselves.
        for (let attempt = 0; attempt < 100 && !armed.some((w) => w.delay >= HOUR); attempt++) {
          await Promise.resolve();
        }
        spy.mockRestore();
        const wake = armed.find((w) => w.delay >= HOUR);
        expect(wake).toBeDefined();
        h.advance(wake!.delay);
        wake!.run();
        for (let attempt = 0; attempt < 100 && h.state.active !== "first"; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(h.state.active).toBe("first");
      } finally {
        h.switcher.stop();
      }
    },
  );

  test("is not armed before the switcher runs, or with nothing to wait for", async () => {
    const idle = harness("claude", limits(), "first");
    const before = capture();
    await idle.switcher.evaluate("claude");
    before.spy.mockRestore();
    expect(before.armed.filter(({ delay }) => delay >= HOUR)).toEqual([]);

    const quiet = harness(
      "claude",
      {
        first: { weeklyResetHours: 24, fiveHour: 10, fiveHourResetHours: 3 },
        second: { weeklyResetHours: 48, fiveHour: 10, fiveHourResetHours: 4 },
      },
      "first",
    );
    quiet.switcher.start();
    try {
      const during = capture();
      await quiet.switcher.evaluate("claude");
      during.spy.mockRestore();
      expect(during.armed.filter(({ delay }) => delay >= HOUR)).toEqual([]);
    } finally {
      quiet.switcher.stop();
    }
  });

  test("a reset far ahead is capped, so the delay cannot overflow the timer", async () => {
    const h = harness(
      "claude",
      {
        first: { weeklyResetHours: 24, fiveHour: 100, fiveHourResetHours: 24 * 90 },
        second: { weeklyResetHours: 48, fiveHour: 10, fiveHourResetHours: 4 },
      },
      "first",
    );
    h.switcher.start();
    try {
      const { armed, spy } = capture();
      await h.switcher.evaluate("claude");
      spy.mockRestore();
      expect(Math.max(...armed.map(({ delay }) => delay))).toBe(6 * HOUR);
    } finally {
      h.switcher.stop();
    }
  });

  test("the backstop is short enough to catch a filling window", () => {
    expect(AUTO_SWITCH_EVALUATE_INTERVAL_MS).toBe(5 * 60_000);
  });
});
