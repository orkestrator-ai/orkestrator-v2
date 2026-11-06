import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentAccountAutoSwitchState } from "@orkestrator/protocol/agent-account-auto-switch";
import type { AgentAccountsSnapshot } from "@orkestrator/protocol/agent-accounts";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
const portalCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
let snapshot: AgentAccountsSnapshot;
let usageById: Record<string, PlanUsageSnapshot> = {};

function answer(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  calls.push({ command, args });
  switch (command) {
    case "list_agent_accounts":
      return Promise.resolve(snapshot);
    case "get_agent_account_usage":
      return Promise.resolve(
        usageById[String(args.accountId)] ?? {
          platform: "codex",
          status: "ok",
          windows: [],
          fetchedAt: new Date(0).toISOString(),
        },
      );
    case "get_agent_account_login":
      return Promise.resolve({ state: "idle" });
    case "set_active_agent_account":
      setAutoSwitch({
        mode: "pinned",
        pinnedAccountId: String(args.accountId),
        includedAccountIds: ["a", "b"],
      });
      snapshot = {
        ...snapshot,
        active: { ...snapshot.active, codex: String(args.accountId) },
      };
      return Promise.resolve(snapshot);
    case "set_agent_account_auto_switch":
      return Promise.resolve(snapshot);
    default:
      return Promise.resolve(undefined);
  }
}

function setAutoSwitch(state: AgentAccountAutoSwitchState | undefined): void {
  const { autoSwitch: _previous, ...rest } = snapshot;
  snapshot = state ? { ...rest, autoSwitch: { codex: state } } : rest;
}

mock.module("@/lib/native/backend", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => answer(command, args),
}));

const { AgentAccountsSection } = await import("./AgentAccountsSection");

beforeEach(() => {
  usageById = {};
  calls.length = 0;
  portalCalls.length = 0;
  snapshot = {
    active: { claude: "default", codex: "a" },
    accounts: [
      {
        id: "a",
        platform: "codex",
        label: "a@example.com",
        isDefault: false,
        isActive: true,
        signedIn: true,
        identity: { email: "a@example.com" },
      },
      {
        id: "b",
        platform: "codex",
        label: "API key",
        isDefault: false,
        isActive: false,
        signedIn: true,
        identity: {},
      },
    ],
  };
});

afterEach(cleanup);

const mainTick = () => screen.findByRole("checkbox", { name: /weekly limit resets soonest/i });

describe("automatic account switching in Settings", () => {
  test("is offered ticked off, and ticking it asks the backend", async () => {
    setAutoSwitch({ mode: "off", includedAccountIds: ["a"] });
    render(<AgentAccountsSection platform="codex" />);
    const tick = await mainTick();
    expect(tick.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Off")).toBeTruthy();
    fireEvent.click(tick);
    await waitFor(() =>
      expect(calls.find((call) => call.command === "set_agent_account_auto_switch")?.args).toEqual({
        platform: "codex",
        enabled: true,
      }),
    );
  });

  test("shows automatic while it is on, with each account's own tick", async () => {
    setAutoSwitch({ mode: "automatic", includedAccountIds: ["a"] });
    render(<AgentAccountsSection platform="codex" />);
    const tick = await mainTick();
    expect(tick.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Automatic")).toBeTruthy();
    expect(
      screen
        .getByRole("checkbox", { name: "Include a@example.com in automatic switching" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: "Include API key in automatic switching" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    // An account with no email says why its tick is only here.
    expect(screen.getByText(/no email to match elsewhere/)).toBeTruthy();
  });

  test("an account's tick goes by email, or by id when it has none", async () => {
    setAutoSwitch({ mode: "automatic", includedAccountIds: ["a"] });
    render(<AgentAccountsSection platform="codex" />);
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Include a@example.com in automatic switching",
      }),
    );
    await waitFor(() =>
      expect(
        calls.filter((call) => call.command === "set_agent_account_auto_switch").at(-1)?.args,
      ).toEqual({ platform: "codex", email: "a@example.com", included: false }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Include API key in automatic switching" }),
    );
    await waitFor(() =>
      expect(
        calls.filter((call) => call.command === "set_agent_account_auto_switch").at(-1)?.args,
      ).toEqual({ platform: "codex", accountId: "b", included: true }),
    );
  });

  test("a manual switch shows as pinned, unticked, until ticked again", async () => {
    setAutoSwitch({ mode: "automatic", includedAccountIds: ["a", "b"] });
    render(<AgentAccountsSection platform="codex" />);
    await mainTick();
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(await screen.findByText("Pinned to API key")).toBeTruthy();
    expect((await mainTick()).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "About automatic switching" }));
    expect(
      within(await screen.findByRole("tooltip")).getByText(/A manual switch pinned API key/),
    ).toBeTruthy();
  });

  test("a machine that predates it shows no ticks and keeps working", async () => {
    render(<AgentAccountsSection platform="codex" />);
    await screen.findByText("a@example.com");
    expect(screen.queryByRole("checkbox") === null).toBe(true);
  });
});

function weekly(used: number, fetchedAt: string, stale = false): PlanUsageSnapshot {
  return {
    platform: "codex",
    status: "ok",
    windows: [{ window: "primary", label: "Weekly limit", usedPercent: used }],
    fetchedAt,
    ...(stale ? { stale: true } : {}),
  };
}

describe("one login listed twice", () => {
  beforeEach(() => {
    // The host login was signed in to b@example.com after it was added.
    snapshot = {
      ...snapshot,
      accounts: [
        ...snapshot.accounts.slice(0, 1),
        {
          id: "b",
          platform: "codex",
          label: "b@example.com",
          isDefault: false,
          isActive: false,
          signedIn: true,
          identity: { email: "b@example.com" },
        },
        {
          id: "default",
          platform: "codex",
          label: "Host login",
          isDefault: true,
          isActive: false,
          signedIn: true,
          identity: { email: "B@example.com" },
        },
      ],
    };
  });

  test("is shown once, under the added account, with the freshest reading", async () => {
    usageById = {
      b: weekly(96, "2026-11-05T21:45:00.000Z", true),
      default: weekly(98, "2026-11-06T13:05:00.000Z"),
    };
    render(<AgentAccountsSection platform="codex" />);
    expect(await screen.findByRole("listitem", { name: "b@example.com" })).toBeTruthy();
    expect(screen.queryByRole("listitem", { name: "Host login" }) === null).toBe(true);
    const card = screen.getByRole("listitem", { name: "b@example.com" });
    expect(within(card).getByText("Also the host login")).toBeTruthy();
    expect(await within(card).findByText("98% used")).toBeTruthy();
    expect(within(card).queryByText(/Last known usage/) === null).toBe(true);
    const asked = calls
      .filter((call) => call.command === "get_agent_account_usage")
      .map((call) => call.args.accountId);
    expect(new Set(asked)).toEqual(new Set(["a", "b", "default"]));
  });

  test("using it switches to the added entry", async () => {
    render(<AgentAccountsSection platform="codex" />);
    const card = await screen.findByRole("listitem", { name: "b@example.com" });
    fireEvent.click(within(card).getByRole("button", { name: "Use" }));
    await waitFor(() =>
      expect(calls.find((call) => call.command === "set_active_agent_account")?.args).toMatchObject(
        { platform: "codex", accountId: "b" },
      ),
    );
  });

  test("while the host entry is active the one card is active", async () => {
    snapshot = {
      ...snapshot,
      active: { ...snapshot.active, codex: "default" },
      accounts: snapshot.accounts.map((account) => ({
        ...account,
        isActive: account.id === "default",
      })),
    };
    render(<AgentAccountsSection platform="codex" />);
    const card = await screen.findByRole("listitem", { name: "b@example.com" });
    expect(within(card).getByText("Active")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Use" }) === null).toBe(true);
  });
});

describe("a limit stop with nowhere to go", () => {
  test("says which account stopped and what kept each other login out", async () => {
    setAutoSwitch({
      mode: "automatic",
      includedAccountIds: ["a", "b"],
      lastSwitch: {
        fromAccountId: "b",
        toAccountId: "a",
        reason: "soonest-reset",
        at: "2026-11-05T20:00:00.000Z",
      },
      lastKept: {
        fromAccountId: "a",
        at: "2026-11-06T04:07:56.000Z",
        blocked: [{ accountId: "b", blocker: "weekly", usedPercent: 98 }],
      },
    });
    render(<AgentAccountsSection platform="codex" />);
    const note = await screen.findByTestId("auto-switch-kept");
    expect(within(note).getByText(/Stayed on a@example.com/)).toBeTruthy();
    expect(within(note).getByText("API key: weekly limit 98% used")).toBeTruthy();
    expect(screen.queryByText(/Last moved to/) === null).toBe(true);
  });

  test("a later switch replaces it", async () => {
    setAutoSwitch({
      mode: "automatic",
      includedAccountIds: ["a", "b"],
      lastSwitch: {
        fromAccountId: "a",
        toAccountId: "b",
        reason: "five-hour",
        at: "2026-11-06T05:30:00.000Z",
      },
      lastKept: { fromAccountId: "a", at: "2026-11-06T04:07:56.000Z", blocked: [] },
    });
    render(<AgentAccountsSection platform="codex" />);
    expect(await screen.findByText("Last moved to API key.")).toBeTruthy();
    expect(screen.queryByTestId("auto-switch-kept") === null).toBe(true);
  });
});
