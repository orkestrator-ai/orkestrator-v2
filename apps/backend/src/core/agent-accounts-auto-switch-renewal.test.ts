import { describe, expect, mock, test } from "bun:test";
import type {
  AgentAccountPlatform,
  AgentAccountsSnapshot,
  AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import {
  AgentAccountAutoSwitcher,
  LOGIN_RENEWAL_MAX_RETRY_MS,
  LOGIN_RENEWAL_RETRY_MS,
} from "./agent-accounts-auto-switch.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

function usage(used: number, resetsInHours: number, stale = false): PlanUsageSnapshot {
  return {
    platform: "claude",
    status: "ok",
    windows: [{ window: "seven_day", usedPercent: used, resetsAt: inHours(resetsInHours) }],
    ...(stale ? { stale: true } : {}),
    fetchedAt: inHours(stale ? -96 : 0),
  };
}

const NEVER_READ: PlanUsageSnapshot = {
  platform: "claude",
  status: "unavailable",
  windows: [],
  message: "Sign in to Claude with a paid plan to see plan usage.",
  fetchedAt: inHours(0),
};

/**
 * Accounts whose reading changes once their sign-in is renewed: `before` is what
 * an idle account's lapsed token leaves (its last reading, marked stale), and
 * `after` is the fresh reading a live token gets.
 */
function harness(options: {
  active: string;
  accounts: Record<string, { before: PlanUsageSnapshot; after?: PlanUsageSnapshot }>;
  excluded?: string[];
  renewLogin?: (accountId: string) => Promise<boolean>;
  withoutRenewal?: boolean;
}) {
  let clock = NOW;
  const state = { active: options.active };
  const renewed = new Set<string>();
  const reads: Array<{ accountId: string; force: boolean }> = [];
  const summaries = Object.keys(options.accounts).map((id): AgentAccountSummary => ({
    id,
    platform: "claude",
    label: `${id}@example.com`,
    isDefault: false,
    isActive: false,
    signedIn: true,
    identity: { email: `${id}@example.com` },
  }));
  const renewLogin = mock(async (_platform: AgentAccountPlatform, accountId: string) => {
    const result = options.renewLogin ? await options.renewLogin(accountId) : true;
    if (result) renewed.add(accountId);
    return result;
  });
  const snapshot = (): AgentAccountsSnapshot => ({
    accounts: summaries,
    active: { claude: state.active, codex: "default" },
    autoSwitch: {
      claude: {
        mode: "automatic",
        includedAccountIds: Object.keys(options.accounts).filter(
          (id) => !options.excluded?.includes(id),
        ),
      },
    },
  });
  const switcher = new AgentAccountAutoSwitcher({
    settings: async () => ({ claude: { enabled: true, excludedEmails: [] } }),
    snapshot: async () => snapshot(),
    readUsage: async (_platform, accountId, { force }) => {
      reads.push({ accountId, force });
      const account = options.accounts[accountId]!;
      return renewed.has(accountId) ? (account.after ?? account.before) : account.before;
    },
    ...(options.withoutRenewal ? {} : { renewLogin }),
    switchAccount: async (_platform, accountId) => {
      state.active = accountId;
      return true;
    },
    sessionAccount: async () => ({
      platform: "claude",
      source: "account",
      account: summaries.find((account) => account.id === options.active)!,
      running: true,
    }),
    bridgeBusy: async () => false,
    notify: () => undefined,
    now: () => clock,
  });
  return {
    switcher,
    state,
    reads,
    renewLogin,
    renewedIds: () => renewLogin.mock.calls.map(([, accountId]) => accountId),
    advance: (ms: number) => {
      clock += ms;
    },
    lapse: (accountId: string) => renewed.delete(accountId),
  };
}

describe("renewing candidates after a weekly limit stop", () => {
  const stop = (switcher: AgentAccountAutoSwitcher, requestId = "limited-turn") =>
    switcher.handleLimitStop({
      platform: "claude",
      environmentId: "env-1",
      requestId,
      error: "You've hit your limit · resets 3pm",
      resends: 0,
    });

  test("renews an idle candidate, forces a reread and resends on the renewed account", async () => {
    const h = harness({
      active: "host",
      accounts: {
        host: { before: usage(100, 160) },
        idle: { before: NEVER_READ, after: usage(5, 30) },
      },
    });
    expect(await stop(h.switcher)).toBe("resend");
    expect(h.renewLogin).toHaveBeenCalledWith("claude", "idle");
    expect(h.reads).toEqual([
      { accountId: "host", force: true },
      { accountId: "idle", force: false },
      { accountId: "idle", force: true },
    ]);
    expect(h.state.active).toBe("idle");
  });

  test("failed renewals leave known candidates usable and share backoff with evaluation", async () => {
    const h = harness({
      active: "host",
      renewLogin: async () => false,
      accounts: {
        host: { before: usage(100, 160) },
        idle: { before: NEVER_READ, after: usage(5, 30) },
        other: { before: usage(10, 90) },
      },
    });
    expect(await stop(h.switcher)).toBe("resend");
    await h.switcher.evaluate("claude");
    expect(await stop(h.switcher, "another-turn")).toBe("resend");
    expect(h.renewLogin).toHaveBeenCalledTimes(1);
    expect(h.reads.filter((read) => read.accountId === "idle")).toEqual([
      { accountId: "idle", force: false },
      { accountId: "idle", force: false },
      { accountId: "idle", force: false },
    ]);
    expect(h.state.active).toBe("other");
  });

  test("a renewed candidate whose forced reading proves it full cannot trigger a resend", async () => {
    const h = harness({
      active: "host",
      accounts: {
        host: { before: usage(100, 160) },
        idle: { before: NEVER_READ, after: usage(100, 30) },
      },
    });
    expect(await stop(h.switcher)).toBe("stop");
    expect(h.renewedIds()).toEqual(["idle"]);
    expect(h.reads.filter((read) => read.accountId === "idle")).toEqual([
      { accountId: "idle", force: false },
      { accountId: "idle", force: true },
    ]);
    expect(h.state.active).toBe("host");
  });
});

describe("renewing idle accounts so they can be ranked", () => {
  test("an idle account whose old reading's reset has passed is renewed, read and chosen", async () => {
    const h = harness({
      active: "host",
      accounts: {
        host: { before: usage(2, 160) },
        // Last read four days ago, before its week reset: no reset to go on.
        idle: { before: usage(40, -10, true), after: usage(5, 30) },
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.renewedIds()).toEqual(["idle"]);
    expect(h.reads.filter((read) => read.accountId === "idle")).toEqual([
      { accountId: "idle", force: false },
      { accountId: "idle", force: true },
    ]);
    expect(h.state.active).toBe("idle");
  });

  test("without a renewal the same account is never chosen", async () => {
    const h = harness({
      active: "host",
      withoutRenewal: true,
      accounts: {
        host: { before: usage(2, 160) },
        idle: { before: usage(40, -10, true), after: usage(5, 30) },
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("host");
  });

  test("the active account is renewed too, so the machine is not stuck on no reading", async () => {
    const h = harness({
      active: "dev",
      accounts: {
        dev: { before: NEVER_READ, after: usage(10, 120) },
        host: { before: usage(2, 160) },
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.renewedIds()).toEqual(["dev"]);
    expect(h.state.active).toBe("dev");
  });

  test("readings that can already be ranked are never renewed", async () => {
    const h = harness({
      active: "host",
      accounts: {
        host: { before: usage(2, 160) },
        // Stale, but its reset is still ahead, so it ranks as it is.
        known: { before: usage(30, 50, true) },
        // Stale and past the threshold with its reset ahead: out until then.
        full: { before: usage(99, 20, true) },
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.renewLogin).not.toHaveBeenCalled();
    expect(h.state.active).toBe("known");
  });

  test("an account with its tick off is neither read nor renewed", async () => {
    const h = harness({
      active: "host",
      excluded: ["idle"],
      accounts: {
        host: { before: usage(2, 160) },
        idle: { before: usage(40, -10, true), after: usage(5, 30) },
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.renewLogin).not.toHaveBeenCalled();
    expect(h.state.active).toBe("host");
  });

  test("a failing renewal backs off, doubling up to its cap", async () => {
    const h = harness({
      active: "host",
      renewLogin: async () => false,
      accounts: {
        host: { before: usage(2, 160) },
        idle: { before: usage(40, -10, true) },
      },
    });
    const attemptsAfter = async (ms: number) => {
      h.advance(ms);
      await h.switcher.evaluate("claude");
      return h.renewLogin.mock.calls.length;
    };
    expect(await attemptsAfter(0)).toBe(1);
    expect(await attemptsAfter(LOGIN_RENEWAL_RETRY_MS - 1)).toBe(1);
    expect(await attemptsAfter(1)).toBe(2);
    expect(await attemptsAfter(2 * LOGIN_RENEWAL_RETRY_MS - 1)).toBe(2);
    expect(await attemptsAfter(1)).toBe(3);
    for (let attempt = 0; attempt < 6; attempt += 1)
      await attemptsAfter(LOGIN_RENEWAL_MAX_RETRY_MS);
    const before = h.renewLogin.mock.calls.length;
    expect(await attemptsAfter(LOGIN_RENEWAL_MAX_RETRY_MS)).toBe(before + 1);
    expect(h.state.active).toBe("host");
  });

  test("a renewal that throws counts as a failure and the check carries on", async () => {
    const h = harness({
      active: "host",
      renewLogin: async () => {
        throw new Error("claude exited");
      },
      accounts: {
        host: { before: usage(2, 160) },
        idle: { before: usage(40, -10, true) },
        other: { before: usage(10, 100) },
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.state.active).toBe("other");
  });

  test("a renewed account is not renewed again within the retry window", async () => {
    const h = harness({
      active: "host",
      accounts: {
        host: { before: usage(2, 1) },
        idle: { before: NEVER_READ, after: usage(5, 30) },
      },
    });
    await h.switcher.evaluate("claude");
    expect(h.renewedIds()).toEqual(["idle"]);
    // Its token lapses again before the window is out; the evaluation leaves it.
    h.lapse("idle");
    h.advance(LOGIN_RENEWAL_RETRY_MS - 1);
    await h.switcher.evaluate("claude");
    expect(h.renewLogin).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.switcher.evaluate("claude");
    expect(h.renewLogin).toHaveBeenCalledTimes(2);
  });
});
