import { describe, expect, test } from "bun:test";
import type {
  AgentAccountPlatform,
  AgentAccountsSnapshot,
  AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import { AgentAccountAutoSwitcher, type AutoSwitchNotice } from "./agent-accounts-auto-switch.js";

/**
 * The flap seen on 2.39.2-beta (0265e78, with the hold from #2350) on beelink2
 * and omarchy-hp (docs/architecture/agent-accounts.md, "One threshold"): A at
 * 98% weekly moved the machine to B (`threshold`), then the next check moved it
 * back because A's week resets sooner (`soonest-reset`), over and over. On
 * omarchy-hp B is the host login.
 *
 * What let A back in: a fresh reading of A that names its weekly window and
 * reset but no percentage. A Claude `rate_limit_event` may carry a reset time
 * without utilization, and the windows a session reports are kept, stamped
 * fresh, and shared with every machine on the login. The hold skipped every
 * idle entry with a fresh reading, and a weekly level with no percentage
 * counts as room, so A ranked first again. A fresh reading below 98% taken
 * before the one that held A released it too, though it said nothing new.
 *
 * Fake readings only: no account, login or data directory is touched.
 */

const NOW = Date.parse("2026-11-17T09:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(ms).toISOString();

const A_WEEK_RESET = NOW + 3 * HOUR;
const B_WEEK_RESET = NOW + 90 * HOUR;

interface Reading {
  /** Absent: the weekly window is reported with a reset time and no percentage. */
  weekly?: number;
  weeklyResetsAt?: number;
  /** Absolute epoch ms the reading was taken; defaults to the read itself. */
  fetchedAt?: number;
  /** How long before the read it was taken; past five minutes it is stale. */
  minutesOld?: number;
  /** The usage endpoint would not answer. */
  fail?: boolean;
}

function snapshot(
  platform: AgentAccountPlatform,
  reading: Reading,
  now: number,
): PlanUsageSnapshot {
  const resetsAt = reading.weeklyResetsAt === undefined ? undefined : at(reading.weeklyResetsAt);
  const percent = reading.weekly === undefined ? {} : { usedPercent: reading.weekly };
  const windows =
    platform === "claude"
      ? [{ window: "seven_day", label: "Weekly", ...percent, resetsAt }]
      : [{ window: "secondary", label: "Weekly", ...percent, resetsAt, windowMinutes: 10_080 }];
  return {
    platform,
    status: "ok",
    windows,
    fetchedAt: at(reading.fetchedAt ?? now - (reading.minutesOld ?? 0) * MINUTE),
  };
}

interface Entry {
  id: string;
  email: string;
  host?: boolean;
}

/** `usage(id, active, now)` answers what a read of `id` returns while `active` is in use. */
function harness(
  platform: AgentAccountPlatform,
  entries: Entry[],
  initial: string,
  usage: (accountId: string, active: string, now: number) => Reading,
) {
  let clock = NOW;
  const state = { active: initial };
  const notices: AutoSwitchNotice[] = [];
  const summaries = entries.map(({ id, email, host }): AgentAccountSummary => ({
    id,
    platform,
    label: host ? "Host login" : id,
    isDefault: host === true,
    isActive: false,
    signedIn: true,
    identity: { email },
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
    readUsage: async (_platform, accountId) => {
      const reading = usage(accountId, state.active, clock);
      if (reading.fail) throw new Error("fake usage endpoint unavailable");
      return snapshot(platform, reading, clock);
    },
    switchAccount: async (_platform, accountId) => {
      state.active = accountId;
      return true;
    },
    sessionAccount: async () => null,
    bridgeBusy: async () => false,
    notify: (notice) => {
      notices.push(notice);
    },
    now: () => clock,
  });
  return {
    state,
    notices,
    reasons: () => notices.map(({ reason }) => reason),
    /** One between-turns check per step, as turn ends and the backstop timer run them. */
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

/** A's reading in use: fresh, at 98%, its week ending first. */
const A_IN_USE: Reading = { weekly: 98, weeklyResetsAt: A_WEEK_RESET };
/** What a session's rate-limit event left as A's newest reading: its reset, no percentage. */
const A_RESET_ONLY: Reading = { weeklyResetsAt: A_WEEK_RESET };

const MACHINES = [
  {
    name: "beelink2",
    entries: [
      { id: "acct-a", email: "a@example.com" },
      { id: "acct-b", email: "b@example.com" },
    ],
    a: "acct-a",
    b: "acct-b",
  },
  {
    name: "omarchy-hp (B is the host login)",
    entries: [
      { id: "default", email: "b@example.com", host: true },
      { id: "acct-a", email: "a@example.com" },
    ],
    a: "acct-a",
    b: "default",
  },
] as const;

describe.each(["claude", "codex"] as const)("the 2.39.2-beta flap on %s", (platform) => {
  for (const machine of MACHINES) {
    describe(machine.name, () => {
      const make = (idleA: (now: number) => Reading, bReading?: (active: string) => Reading) =>
        harness(platform, [...machine.entries], machine.a, (id, active, now) => {
          if (id === machine.a) return active === machine.a ? A_IN_USE : idleA(now);
          return (
            bReading?.(active) ?? {
              weekly: 40,
              weeklyResetsAt: B_WEEK_RESET,
              minutesOld: active === machine.b ? 0 : 40,
            }
          );
        });

      test("a fresh reading of A with no percentage does not bring it back", async () => {
        const h = make(() => A_RESET_ONLY);
        await h.evaluateEvery(8);
        expect(h.state.active).toBe(machine.b);
        // On 0265e78: threshold, soonest-reset, threshold, soonest-reset, …
        expect(h.reasons()).toEqual(["threshold"]);
      });

      test("the observed mix of idle answers never brings A back before it resets", async () => {
        // In turn: the reset-only reading, a failed read, an older reading below
        // 98% (taken before the 98% one), and a stale lower last known reading.
        const answers: Reading[] = [
          A_RESET_ONLY,
          { fail: true },
          { weekly: 96, weeklyResetsAt: A_WEEK_RESET, fetchedAt: NOW - 2 * MINUTE },
          { weekly: 90, weeklyResetsAt: A_WEEK_RESET, minutesOld: 40 },
        ];
        let check = 0;
        const h = make(() => answers[check++ % answers.length]!);
        await h.evaluateEvery(12, MINUTE);
        expect(h.state.active).toBe(machine.b);
        expect(h.reasons()).toEqual(["threshold"]);
      });

      test("a later fresh reading below 98% makes A a place to go again", async () => {
        const idle = { reading: A_RESET_ONLY };
        const h = make(() => idle.reading);
        await h.evaluateEvery(4);
        expect(h.state.active).toBe(machine.b);
        idle.reading = { weekly: 60, weeklyResetsAt: A_WEEK_RESET };
        await h.evaluateEvery(1);
        expect(h.state.active).toBe(machine.a);
        expect(h.reasons()).toEqual(["threshold", "soonest-reset"]);
      });

      test("A's weekly reset makes it a place to go again", async () => {
        // B's week ends after A's next one, so a reset A is the sooner again.
        // Both readings after the reset are stale: the reset alone lets A back.
        const bReset = NOW + 200 * HOUR;
        const h = make(
          (now) =>
            now >= A_WEEK_RESET
              ? { weekly: 1, weeklyResetsAt: A_WEEK_RESET + 168 * HOUR, minutesOld: 10 }
              : A_RESET_ONLY,
          (active) => ({
            weekly: 40,
            weeklyResetsAt: bReset,
            minutesOld: active === machine.b ? 10 : 40,
          }),
        );
        await h.evaluateEvery(6);
        expect(h.state.active).toBe(machine.b);
        h.advance(A_WEEK_RESET - h.now() + MINUTE);
        await h.evaluateEvery(1);
        expect(h.state.active).toBe(machine.a);
        expect(h.reasons()).toEqual(["threshold", "soonest-reset"]);
      });
    });
  }

  test("a twin's older reading below 98% does not release the login", async () => {
    // Two entries of login A: the one in use reads 98% now; its twin's cached
    // reading, still under five minutes old, was taken two minutes before that.
    let initial = true;
    const h = harness(
      platform,
      [
        { id: "acct-a", email: "a@example.com" },
        { id: "acct-a2", email: "A@example.com" },
        { id: "acct-b", email: "b@example.com" },
      ],
      "acct-a",
      (id, active) => {
        if (id === "acct-a") {
          return active === "acct-a" && initial
            ? A_IN_USE
            : { weekly: 90, weeklyResetsAt: A_WEEK_RESET, minutesOld: 40 };
        }
        if (id === "acct-a2") {
          return { weekly: 96, weeklyResetsAt: A_WEEK_RESET, fetchedAt: NOW - 2 * MINUTE };
        }
        return { weekly: 40, weeklyResetsAt: B_WEEK_RESET, minutesOld: active === id ? 0 : 40 };
      },
    );
    await h.evaluateEvery(1, MINUTE);
    initial = false;
    expect(h.state.active).toBe("acct-b");
    await h.evaluateEvery(2, MINUTE);
    expect(h.state.active).toBe("acct-b");
    expect(h.reasons()).toEqual(["threshold"]);
  });
});
