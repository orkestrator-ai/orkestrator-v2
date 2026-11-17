import { describe, expect, test } from "bun:test";
import type {
  AgentAccountPlatform,
  AgentAccountsSnapshot,
  AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
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
    test("starting on L, the machine is not moved back and forth", async () => {
      const h = harness(platform, ["l", "m"], "l", alternating);
      await h.evaluateEvery(24);
      expect(h.state.active).toBe("l");
      expect(h.notices).toEqual([]);
    });

    test("starting on M, it moves to L at most once and stays", async () => {
      const h = harness(platform, ["l", "m"], "m", alternating);
      await h.evaluateEvery(24);
      expect(h.moves()).toEqual(["m→l soonest-reset"]);
      expect(h.state.active).toBe("l");
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
      expect(h.notices).toEqual([]);
      // From here only L's own reading arrives, and M is where the machine was put by hand.
      foreignGone = true;
      h.state.active = "m";
      await h.evaluateEvery(2);
      expect(h.notices).toEqual([]);
      h.advance(RESET_CLAIM_MEMORY_MS);
      await h.evaluateEvery(1);
      expect(h.moves()).toEqual(["m→l soonest-reset"]);
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
