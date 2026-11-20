import { describe, expect, test } from "bun:test";
import type {
  AgentAccountPlatform,
  AgentAccountsSnapshot,
  AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import { AgentAccountAutoSwitcher, type AutoSwitchNotice } from "./auto-switch.js";

/**
 * One threshold for leaving an account and for choosing it again
 * (docs/architecture/agent-accounts.md, "One threshold"). On 2026-11-16 two
 * machines flapped between two logins every few minutes: a fresh reading moved
 * the machine off one at 98% weekly, then the next check read it from an earlier,
 * lower reading and moved back because its week resets sooner.
 */

const NOW = Date.parse("2026-11-16T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(ms).toISOString();

interface Limits {
  weekly: number;
  /** Absolute epoch ms. */
  weeklyResetsAt?: number;
  fiveHour?: number;
  fiveHourResetsAt?: number;
  /** How long before the read it was taken; past five minutes it is stale. */
  minutesOld?: number;
}

function snapshot(platform: AgentAccountPlatform, limits: Limits, now: number): PlanUsageSnapshot {
  const fiveHour = limits.fiveHour !== undefined;
  const windows =
    platform === "claude"
      ? [
          {
            window: "seven_day",
            usedPercent: limits.weekly,
            resetsAt: limits.weeklyResetsAt === undefined ? undefined : at(limits.weeklyResetsAt),
          },
          ...(fiveHour
            ? [
                {
                  window: "five_hour",
                  usedPercent: limits.fiveHour,
                  resetsAt:
                    limits.fiveHourResetsAt === undefined ? undefined : at(limits.fiveHourResetsAt),
                },
              ]
            : []),
        ]
      : [
          {
            window: "secondary",
            usedPercent: limits.weekly,
            resetsAt: limits.weeklyResetsAt === undefined ? undefined : at(limits.weeklyResetsAt),
            windowMinutes: 10_080,
          },
          ...(fiveHour
            ? [
                {
                  window: "primary",
                  usedPercent: limits.fiveHour,
                  resetsAt:
                    limits.fiveHourResetsAt === undefined ? undefined : at(limits.fiveHourResetsAt),
                  windowMinutes: 300,
                },
              ]
            : []),
        ];
  return {
    platform,
    status: "ok",
    windows,
    fetchedAt: at(now - (limits.minutesOld ?? 0) * MINUTE),
  };
}

/** `usage(id, active)` answers what a read of `id` returns while `active` is in use. */
function harness(
  platform: AgentAccountPlatform,
  usage: (accountId: string, active: string, now: number) => Limits,
  ids = ["a", "b"],
) {
  let clock = NOW;
  const state = { active: "a" };
  const notices: AutoSwitchNotice[] = [];
  const reads: { accountId: string; force: boolean }[] = [];
  const summaries = ids.map((id): AgentAccountSummary => ({
    id,
    platform,
    label: id,
    isDefault: false,
    isActive: false,
    signedIn: true,
    identity: { email: `${id}@example.com` },
  }));
  const switcher = new AgentAccountAutoSwitcher({
    settings: async () => ({ [platform]: { enabled: true, excludedEmails: [] } }),
    snapshot: async (): Promise<AgentAccountsSnapshot> => ({
      accounts: summaries,
      active: {
        claude: platform === "claude" ? state.active : "default",
        codex: platform === "codex" ? state.active : "default",
      },
      autoSwitch: {
        [platform]: { mode: "automatic", includedAccountIds: summaries.map(({ id }) => id) },
      },
    }),
    readUsage: async (_platform, accountId, { force }) => {
      reads.push({ accountId, force });
      return snapshot(platform, usage(accountId, state.active, clock), clock);
    },
    switchAccount: async (_platform, accountId) => {
      state.active = accountId;
      return true;
    },
    sessionAccount: async () => ({
      platform,
      source: "account",
      account: summaries.find(({ id }) => id === state.active)!,
      running: true,
    }),
    bridgeBusy: async () => false,
    notify: (notice) => {
      notices.push(notice);
    },
    now: () => clock,
  });
  return {
    switcher,
    state,
    notices,
    summaries,
    reads,
    /** One between-turns check per five-minute tick, as the backstop timer runs them. */
    async evaluateEvery(times: number, stepMs = 5 * MINUTE) {
      for (let i = 0; i < times; i++) {
        await switcher.evaluate(platform);
        clock += stepMs;
      }
    },
    advance(ms: number) {
      clock += ms;
    },
    now: () => clock,
  };
}

const A_WEEK_RESET = NOW + 3 * HOUR;
const B_WEEK_RESET = NOW + 90 * HOUR;

describe.each(["claude", "codex"] as const)("one threshold on %s", (platform) => {
  test("weekly: a login left at 98% is not chosen again by the soonest reset", async () => {
    // A resets sooner. Read in use it is fresh at 98%; read idle, the answer is
    // an earlier 90% reading, old enough to be stale, as is B's idle reading.
    const h = harness(platform, (id, active) =>
      id === "a"
        ? active === "a"
          ? { weekly: 98, weeklyResetsAt: A_WEEK_RESET }
          : { weekly: 90, weeklyResetsAt: A_WEEK_RESET, minutesOld: 40 }
        : { weekly: 40, weeklyResetsAt: B_WEEK_RESET, minutesOld: active === "b" ? 10 : 40 },
    );
    await h.evaluateEvery(8);
    expect(h.state.active).toBe("b");
    expect(h.notices.map((notice) => notice.reason)).toEqual(["threshold"]);
  });

  test("5-hour: a login left at 98% is not chosen again before that limit resets", async () => {
    const fiveHourResetsAt = NOW + 2 * HOUR;
    const h = harness(platform, (id, active, now) =>
      id === "a"
        ? active === "a" || now >= fiveHourResetsAt
          ? {
              weekly: 50,
              weeklyResetsAt: NOW + 30 * HOUR,
              fiveHour: now >= fiveHourResetsAt ? 0 : 98,
              fiveHourResetsAt: now >= fiveHourResetsAt ? now + 5 * HOUR : fiveHourResetsAt,
            }
          : {
              weekly: 50,
              weeklyResetsAt: NOW + 30 * HOUR,
              fiveHour: 60,
              fiveHourResetsAt,
              minutesOld: 40,
            }
        : {
            weekly: 40,
            weeklyResetsAt: B_WEEK_RESET,
            fiveHour: 10,
            fiveHourResetsAt: NOW + 4 * HOUR,
            minutesOld: active === "b" ? 10 : 40,
          },
    );
    await h.evaluateEvery(8);
    expect(h.state.active).toBe("b");
    expect(h.notices.map((notice) => notice.reason)).toEqual(["five-hour"]);

    // Its 5-hour limit resets: back to the soonest weekly reset, once.
    h.advance(fiveHourResetsAt - h.now() + MINUTE);
    await h.evaluateEvery(3);
    expect(h.state.active).toBe("a");
    expect(h.notices.map((notice) => notice.reason)).toEqual(["five-hour", "soonest-reset"]);
  });

  test("a fresh reading below the threshold makes it a place to go again", async () => {
    const reading = {
      idleA: { weekly: 90, weeklyResetsAt: A_WEEK_RESET, minutesOld: 40 } as Limits,
    };
    const h = harness(platform, (id, active) =>
      id === "a"
        ? active === "a"
          ? { weekly: 98, weeklyResetsAt: A_WEEK_RESET }
          : reading.idleA
        : { weekly: 40, weeklyResetsAt: B_WEEK_RESET, minutesOld: active === "b" ? 10 : 40 },
    );
    await h.evaluateEvery(3);
    expect(h.state.active).toBe("b");

    // The provider now answers for A freshly, below the threshold.
    reading.idleA = { weekly: 60, weeklyResetsAt: A_WEEK_RESET };
    await h.evaluateEvery(1);
    expect(h.state.active).toBe("a");
    expect(h.notices.map((notice) => notice.reason)).toEqual(["threshold", "soonest-reset"]);
  });

  test("a weekly reset makes it a place to go again", async () => {
    // B's week ends after A's next one, so a reset A is the sooner again.
    const bReset = NOW + 200 * HOUR;
    const h = harness(platform, (id, active, now) =>
      id === "a"
        ? now >= A_WEEK_RESET
          ? { weekly: 1, weeklyResetsAt: A_WEEK_RESET + 168 * HOUR, minutesOld: 10 }
          : active === "a"
            ? { weekly: 98, weeklyResetsAt: A_WEEK_RESET }
            : { weekly: 90, weeklyResetsAt: A_WEEK_RESET, minutesOld: 40 }
        : { weekly: 40, weeklyResetsAt: bReset, minutesOld: active === "b" ? 10 : 40 },
    );
    await h.evaluateEvery(6);
    expect(h.state.active).toBe("b");

    h.advance(A_WEEK_RESET - h.now() + MINUTE);
    await h.evaluateEvery(1);
    expect(h.state.active).toBe("a");
    expect(h.notices.map((notice) => notice.reason)).toEqual(["threshold", "soonest-reset"]);
  });

  test("a fresh twin holds and releases the other entries of its login", async () => {
    let release = false;
    const h = harness(
      platform,
      (id) => {
        if (id === "a") return { weekly: release ? 60 : 98, weeklyResetsAt: A_WEEK_RESET };
        return {
          weekly: 40,
          weeklyResetsAt: id === "twin" ? A_WEEK_RESET : B_WEEK_RESET,
          minutesOld: 40,
        };
      },
      ["a", "twin", "b"],
    );
    h.summaries[1]!.identity = { email: " A@EXAMPLE.COM " };
    await h.evaluateEvery(1);
    expect(h.state.active).toBe("b");
    // Remove the fresh source from the catalogue: the stale twin must retain
    // the login's hold even when it is the only remaining entry.
    const source = h.summaries.shift()!;
    await h.evaluateEvery(1);
    expect(h.state.active).toBe("b");
    // A fresh lower reading on that same source releases the stale twin too.
    release = true;
    h.summaries.push(source);
    await h.evaluateEvery(1);
    expect(h.state.active).toBe("a");
    h.summaries.pop();
    h.state.active = "b";
    await h.evaluateEvery(1);
    expect(h.state.active).toBe("twin");
    expect(h.notices.map(({ reason }) => reason)).toEqual([
      "threshold",
      "soonest-reset",
      "soonest-reset",
    ]);
  });

  for (const path of ["stop", "move"] as const) {
    test(`${path}: a failed forced probe cannot choose a held login after refusal`, async () => {
      let refusing = false;
      const h = harness(platform, (id, active) => {
        if (id === "a") {
          if (refusing) throw new Error("fake usage endpoint unavailable");
          return {
            weekly: active === "a" ? 98 : 90,
            weeklyResetsAt: A_WEEK_RESET,
            minutesOld: active === "a" ? 0 : 40,
          };
        }
        return { weekly: refusing ? 100 : 40, weeklyResetsAt: B_WEEK_RESET };
      });
      await h.evaluateEvery(1);
      expect(h.state.active).toBe("b");
      refusing = true;
      h.reads.length = 0;
      if (path === "stop") {
        expect(
          await h.switcher.handleLimitStop({
            platform,
            environmentId: "fake-env",
            requestId: "fake-stop",
            error: undefined,
            failureKind: "usage-limit",
            resends: 0,
          }),
        ).toBe("stop");
      } else {
        expect(await h.switcher.moveOffLimitedAccount(platform, ({ id }) => id === "b")).toEqual({
          moved: false,
          reason: "no-account-with-headroom",
        });
      }
      expect(h.reads).toContainEqual({ accountId: "a", force: true });
      expect(h.state.active).toBe("b");
      expect(h.notices).toHaveLength(1);
    });
  }

  for (const limit of ["weekly", "fiveHour"] as const) {
    test(`${limit}: a missing reset holds for exactly the fallback window`, async () => {
      let initial = true;
      const duration = limit === "weekly" ? 168 * HOUR : 5 * HOUR;
      const h = harness(platform, (id) =>
        id === "a"
          ? {
              weekly: limit === "weekly" ? (initial ? 98 : 90) : 50,
              ...(!initial && limit === "weekly" ? { weeklyResetsAt: NOW + 180 * HOUR } : {}),
              ...(limit === "fiveHour"
                ? { weeklyResetsAt: NOW + 180 * HOUR, fiveHour: initial ? 98 : 60 }
                : {}),
              minutesOld: initial ? 0 : 40,
            }
          : { weekly: 40, weeklyResetsAt: NOW + 200 * HOUR, minutesOld: 40 },
      );
      await h.evaluateEvery(1);
      initial = false;
      expect(h.state.active).toBe("b");
      h.advance(NOW + duration - MINUTE - h.now());
      await h.evaluateEvery(1, MINUTE);
      expect(h.state.active).toBe("b");
      await h.evaluateEvery(1);
      expect(h.state.active).toBe("a");
      expect(h.notices.map(({ reason }) => reason)).toEqual([
        limit === "weekly" ? "threshold" : "five-hour",
        "soonest-reset",
      ]);
    });
  }

  for (const size of [256, 257]) {
    test(`hold memory at ${size} logins stays bounded and accepts the newest login`, async () => {
      let initial = true;
      const ids = ["a", ...Array.from({ length: size - 1 }, (_, i) => `idle-${i}`)];
      const newest = ids.at(-1)!;
      const h = harness(
        platform,
        (id) => ({
          weekly: initial ? 98 : 90,
          weeklyResetsAt: id === newest ? NOW + HOUR : id === "a" ? B_WEEK_RESET : A_WEEK_RESET,
          minutesOld: initial ? 0 : 40,
        }),
        ids,
      );
      await h.evaluateEvery(1);
      expect(h.state.active).toBe("a");
      initial = false;
      await h.evaluateEvery(1);
      // At capacity all idle logins remain held. The next distinct login
      // clears the bounded map; the newest is still held despite resetting first.
      expect(h.state.active).toBe(size === 256 ? "a" : "idle-0");
      expect(h.notices).toHaveLength(size === 256 ? 0 : 1);
    });
  }
});
