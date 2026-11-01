import { describe, expect, mock, test } from "bun:test";
import type { AgentAccountAutoSwitchMode } from "@orkestrator/protocol/agent-account-auto-switch";
import type {
  AgentAccountPlatform,
  AgentAccountsSnapshot,
  AgentAccountSummary,
  AgentSessionAccount,
} from "@orkestrator/protocol/agent-accounts";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import {
  AgentAccountAutoSwitcher,
  USAGE_LIMIT_BRIDGE_WAIT_MS,
  USAGE_LIMIT_READ_WAIT_MS,
  type AutoSwitchNotice,
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
  const summaries = Object.keys(options.accounts).map((id): AgentAccountSummary => ({
    id,
    platform: "claude",
    label: `${id}@example.com`,
    isDefault: false,
    isActive: false,
    signedIn: !options.signedOut?.includes(id),
    identity: { email: `${id}@example.com` },
  }));
  const switchAccount = mock(
    async (
      _platform: AgentAccountPlatform,
      accountId: string,
      _automatic: { expectedActive: string; reason: string },
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
      return typeof reading === "function" ? reading() : reading;
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
    state,
    reads,
    notices,
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

  test("a Fable or 5-hour limit never moves the machine", async () => {
    const h = harness({
      active: "a",
      accounts: {
        a: usage({ used: 20, resetsInHours: 3 }, [
          { window: "seven_day_fable", usedPercent: 100, resetsAt: inHours(3) },
          { window: "five_hour", usedPercent: 100, resetsAt: inHours(2) },
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
    ["a 5-hour limit", { window: "five_hour", usedPercent: 100, resetsAt: inHours(2) }],
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
    h.advance(1);
    expect(await h.stop()).toBe("stop");
    expect(h.state.active).toBe("a");
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
    expect(h.reads.filter((read) => read.force)).toHaveLength(1);
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
    expect(await h.stop()).toBe("wait");
    expect(h.state.active).toBe("b");
    h.advance(USAGE_LIMIT_BRIDGE_WAIT_MS);
    expect(await h.stop()).toBe("stop");
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
});
