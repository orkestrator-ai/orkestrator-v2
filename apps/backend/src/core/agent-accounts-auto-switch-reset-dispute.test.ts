import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentAccountPlatform,
  AgentAccountsSnapshot,
  AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import { configureLogger, resetLogger, type LogOutput } from "@orkestrator/protocol/logger";
import type { AutoSwitchAccount } from "@orkestrator/protocol/agent-account-auto-switch";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import {
  AgentAccountAutoSwitcher,
  RESET_CLAIM_MEMORY_MS,
  type AutoSwitchNotice,
} from "./agent-accounts-auto-switch.js";

/**
 * The flap seen on 2.39.3-beta on mbp3 and the machines sharing its readings
 * (docs/architecture/agent-accounts.md, "Disputed resets"): login L's real
 * reading put its week ending sooner than login M's, but a reading filed under
 * L that was another login's to the digit put it later. Whichever was newest
 * won, so the machine moved L → M and back (`soonest-reset` both ways) every
 * time the newest reading changed sides. Neither reading is near a threshold.
 *
 * Fake readings only: no account, login or data directory is touched.
 */

let logs: LogOutput[] = [];
beforeEach(() => {
  logs = [];
  configureLogger({ sink: (output) => void logs.push(output) });
});
afterEach(resetLogger);
const events = (event: string) => logs.filter((output) => output.record?.event === event);

const NOW = Date.parse("2026-11-17T09:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(ms).toISOString();

/** L's own week: ends first. */
const L_REAL_RESET = NOW + 56 * HOUR;
/** The other login's week, filed under L. */
const L_FOREIGN_RESET = NOW + 169 * HOUR;
/** M's week: between the two. */
const M_RESET = NOW + 156 * HOUR;

interface Reading {
  weekly: number;
  weeklyResetsAt: number;
}

const L_REAL: Reading = { weekly: 84, weeklyResetsAt: L_REAL_RESET };
const L_FOREIGN: Reading = { weekly: 0, weeklyResetsAt: L_FOREIGN_RESET };
const M_READING: Reading = { weekly: 2, weeklyResetsAt: M_RESET };

function snapshot(
  platform: AgentAccountPlatform,
  reading: Reading,
  now: number,
): PlanUsageSnapshot {
  const window =
    platform === "claude"
      ? { window: "seven_day", label: "Weekly" }
      : { window: "secondary", label: "Weekly", windowMinutes: 10_080 };
  return {
    platform,
    status: "ok",
    windows: [{ ...window, usedPercent: reading.weekly, resetsAt: at(reading.weeklyResetsAt) }],
    fetchedAt: at(now),
  };
}

/** `usage(id, check)` answers what a read of `id` returns on the `check`th check. */
function harness(
  platform: AgentAccountPlatform,
  ids: readonly string[],
  initial: string,
  usage: (accountId: string, check: number) => Reading,
) {
  let clock = NOW;
  let check = 0;
  const state = { active: initial };
  const notices: AutoSwitchNotice[] = [];
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
    readUsage: async (_platform, accountId) => snapshot(platform, usage(accountId, check), clock),
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
    switcher,
    summaries,
    moves: () => notices.map(({ from, to, reason }) => `${from}→${to} ${reason}`),
    async evaluateEvery(times: number, stepMs = 5 * MINUTE) {
      for (let i = 0; i < times; i++) {
        await switcher.evaluate(platform);
        check++;
        clock += stepMs;
      }
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

/** L's reading changes sides every other check, as own and shared readings take turns. */
const alternating = (id: string, check: number): Reading =>
  id === "l" ? (Math.floor(check / 2) % 2 === 0 ? L_REAL : L_FOREIGN) : M_READING;

describe.each(["claude", "codex"] as const)(
  "a login read with two weekly resets on %s",
  (platform) => {
    test("starting on L, a forward advance can move once before regression disputes it", async () => {
      const h = harness(platform, ["l", "m"], "l", alternating);
      await h.evaluateEvery(24);
      expect(h.state.active).toBe("m");
      expect(h.moves()).toEqual(["l→m soonest-reset"]);
    });

    test("after the initial move from M, alternating claims cause at most one further move", async () => {
      const h = harness(platform, ["l", "m"], "m", alternating);
      await h.evaluateEvery(1);
      expect(h.moves()).toEqual(["m→l soonest-reset"]);
      h.notices.length = 0;
      await h.evaluateEvery(24);
      expect(h.moves()).toEqual(["l→m soonest-reset"]);
      expect(h.state.active).toBe("m");
    });

    test("when the foreign reading comes first, one move away and no move back", async () => {
      const h = harness(platform, ["l", "m"], "l", (id, check) =>
        id === "l" ? (check === 0 || check % 3 === 0 ? L_FOREIGN : L_REAL) : M_READING,
      );
      await h.evaluateEvery(24);
      expect(h.moves()).toEqual(["l→m soonest-reset"]);
      expect(h.state.active).toBe("m");
    });

    test("readings that agree still move the machine to the sooner reset", async () => {
      const h = harness(platform, ["l", "m"], "m", (id) => (id === "l" ? L_REAL : M_READING));
      await h.evaluateEvery(4);
      expect(h.moves()).toEqual(["m→l soonest-reset"]);
    });

    test("a disputed login does not keep the machine from a third that is sooner on every reading", async () => {
      const SOONEST = NOW + 30 * HOUR;
      const h = harness(platform, ["l", "m", "n"], "m", (id, check) =>
        id === "n"
          ? check < 4
            ? { weekly: 99, weeklyResetsAt: SOONEST }
            : { weekly: 10, weeklyResetsAt: SOONEST }
          : alternating(id, check),
      );
      // N starts past the threshold; L is disputed by the time N has room.
      await h.evaluateEvery(4);
      const before = h.moves().length;
      await h.evaluateEvery(4);
      expect(h.state.active).toBe("n");
      expect(h.moves().at(-1)).toBe(`${h.notices.at(-1)?.from}→n soonest-reset`);
      expect(h.moves().length).toBe(before + 1);
    });

    test("the dispute ends a day after the foreign reset was last named", async () => {
      let foreignGone = false;
      const h = harness(platform, ["l", "m"], "l", (id, check) =>
        id === "l" ? (foreignGone || check % 2 === 0 ? L_REAL : L_FOREIGN) : M_READING,
      );
      await h.evaluateEvery(6);
      expect(h.moves()).toEqual(["l→m soonest-reset"]);
      h.notices.length = 0;
      // From here only L's own reading arrives, and M is where the machine was put by hand.
      foreignGone = true;
      h.state.active = "m";
      await h.evaluateEvery(2);
      expect(h.notices).toEqual([]);
      h.advance(RESET_CLAIM_MEMORY_MS);
      await h.evaluateEvery(1);
      expect(h.moves()).toEqual(["m→l soonest-reset"]);
    });

    test("a spent reset grant advances before expiry without a dispute", async () => {
      const h = harness(platform, ["l", "m"], "l", (id, check) =>
        id === "l" ? (check === 0 ? L_REAL : L_FOREIGN) : M_READING,
      );
      await h.evaluateEvery(1);
      expect(h.notices).toEqual([]);
      await h.evaluateEvery(1);
      expect(h.moves()).toEqual(["l→m soonest-reset"]);
      await h.evaluateEvery(12);
      expect(h.moves()).toEqual(["l→m soonest-reset"]);
      expect(events("auto-switch.reset-disputed")).toHaveLength(0);
      const moved = events("auto-switch.moved");
      expect(moved).toHaveLength(1);
      expect(moved[0]?.record?.fields).toEqual({ provider: platform, reason: "soonest-reset" });
    });

    test("regression warns only on transition, and can warn again after expiry", async () => {
      const h = harness(platform, ["l", "m"], "l", alternating);
      await h.evaluateEvery(24);
      expect(h.moves()).toHaveLength(1);
      expect(events("auto-switch.reset-disputed")).toHaveLength(1);
      expect(events("auto-switch.reset-disputed")[0]?.record?.fields).toEqual({
        provider: platform,
        spreadMinutes: 6780,
      });
      h.advance(RESET_CLAIM_MEMORY_MS);
      await h.evaluateEvery(6);
      expect(events("auto-switch.reset-disputed")).toHaveLength(2);
    });

    test.each([false, true])(
      "disagreeing twin entries are disputed in either order (%s)",
      (reverse) => {
        const h = harness(platform, ["l", "twin"], "l", () => L_REAL);
        const entries: AutoSwitchAccount[] = h.summaries.map((account, index) => ({
          account: { ...account, identity: { email: "same@example.com" } },
          included: true,
          reading: {
            freshness: "fresh",
            wouldPay: false,
            usedPercent: 0,
            resetsAt: index ? L_FOREIGN_RESET : L_REAL_RESET,
          },
        }));
        if (reverse) entries.reverse();
        const ranges = h.switcher["disputedResets"](platform, entries, new Set());
        expect([...ranges.values()]).toEqual([{ earliest: L_REAL_RESET, latest: L_FOREIGN_RESET }]);
        h.switcher["disputedResets"](platform, entries, new Set());
        expect(events("auto-switch.reset-disputed")).toHaveLength(1);
      },
    );

    test("keeps only four claims, evicting the least recently observed", () => {
      const h = harness(platform, ["l"], "l", () => L_REAL);
      const read = (hours: number) =>
        h.switcher["disputedResets"](
          platform,
          [
            {
              included: true,
              account: h.summaries[0]!,
              reading: {
                freshness: "fresh",
                wouldPay: false,
                usedPercent: 0,
                resetsAt: NOW + hours * HOUR,
              },
            },
          ],
          new Set(),
        );
      for (const hours of [100, 110, 120, 130, 100, 140]) {
        read(hours);
        h.advance(MINUTE);
      }
      const state = [...h.switcher["resetClaims"].values()][0]!;
      expect(state.claims.map((claim) => claim.resetsAt)).toEqual(
        [140, 100, 130, 120].map((hours) => NOW + hours * HOUR),
      );
      expect(state.disputed).toBe(true);
    });

    test("clears tracked login state at the 256-login bound", () => {
      const h = harness(platform, ["l"], "l", () => L_REAL);
      const read = (id: number) =>
        h.switcher["disputedResets"](
          platform,
          [
            {
              included: true,
              account: {
                ...h.summaries[0]!,
                id: String(id),
                identity: { email: `${id}@example.com` },
              },
              reading: {
                freshness: "fresh",
                wouldPay: false,
                usedPercent: 0,
                resetsAt: L_REAL_RESET,
              },
            },
          ],
          new Set(),
        );
      for (let id = 0; id < 256; id++) read(id);
      expect(h.switcher["resetClaims"].size).toBe(256);
      read(0);
      expect(h.switcher["resetClaims"].size).toBe(256);
      read(256);
      expect(h.switcher["resetClaims"].size).toBe(1);
    });

    test("a week that ends and starts again is not a dispute", async () => {
      const h = harness(platform, ["l", "m"], "m", (id, check) =>
        id === "l"
          ? check < 2
            ? { weekly: 99, weeklyResetsAt: NOW + 2 * HOUR }
            : { weekly: 0, weeklyResetsAt: NOW + 2 * HOUR + 7 * 24 * HOUR }
          : { weekly: 10, weeklyResetsAt: NOW + 200 * HOUR },
      );
      await h.evaluateEvery(2);
      expect(h.notices).toEqual([]);
      // L's week ends; its next reading names the following week, still sooner than M's.
      h.advance(3 * HOUR);
      await h.evaluateEvery(2);
      expect(h.moves()).toEqual(["m→l soonest-reset"]);
    });
  },
);
