import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  AgentAccountLoginProgress,
  AgentAccountsSnapshot,
  AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let snapshot: AgentAccountsSnapshot;
let login: AgentAccountLoginProgress = { state: "idle" };
let startResult: AgentAccountLoginProgress = { state: "idle" };

const usage: PlanUsageSnapshot = {
  platform: "codex",
  status: "ok",
  windows: [{ window: "primary", label: "5-hour limit", usedPercent: 40 }],
  fetchedAt: new Date(0).toISOString(),
};
let usageResult: PlanUsageSnapshot = usage;

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "list_agent_accounts":
        return Promise.resolve(snapshot);
      case "get_agent_account_usage":
        return Promise.resolve(usageResult);
      case "get_agent_account_login":
        return Promise.resolve(login);
      case "start_agent_account_login":
        login = startResult;
        return Promise.resolve(startResult);
      case "set_active_agent_account":
        snapshot = {
          active: { ...snapshot.active, codex: String(args.accountId) },
          accounts: snapshot.accounts.map((account) => ({
            ...account,
            isActive:
              account.platform === "codex" ? account.id === args.accountId : account.isActive,
          })),
        };
        return Promise.resolve(snapshot);
      case "remove_agent_account":
        snapshot = {
          ...snapshot,
          accounts: snapshot.accounts.filter((account) => account.id !== args.accountId),
        };
        return Promise.resolve(snapshot);
      case "submit_agent_account_login_code":
        login = { ...login, codeSubmitted: true };
        return Promise.resolve(login);
      case "cancel_agent_account_login":
        login = { state: "idle" };
        return Promise.resolve(login);
      default:
        return Promise.resolve(undefined);
    }
  }),
}));

mock.module("@/lib/native/clipboard", () => ({ writeText: mock(async () => undefined) }));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
});

const { AgentAccountsSection } = await import("./AgentAccountsSection");

function account(overrides: Partial<AgentAccountSummary>): AgentAccountSummary {
  return {
    id: "default",
    platform: "codex",
    label: "Host login",
    isDefault: true,
    isActive: true,
    signedIn: true,
    identity: {},
    ...overrides,
  };
}

const ADDED_ID = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  calls.length = 0;
  usageResult = usage;
  login = { state: "idle" };
  snapshot = {
    active: { claude: "default", codex: "default" },
    accounts: [
      account({ platform: "claude" }),
      account({ identity: { email: "host@example.com", plan: "pro" } }),
      account({
        id: ADDED_ID,
        label: "second@example.com",
        isDefault: false,
        isActive: false,
        identity: { email: "second@example.com", plan: "plus" },
      }),
    ],
  };
});

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
});

async function mount() {
  await act(async () => {
    render(<AgentAccountsSection platform="codex" />);
  });
}

function accountOrder(): string[] {
  return screen.getAllByRole("listitem").map((item) => item.getAttribute("aria-label") ?? "");
}

describe("AgentAccountsSection", () => {
  test("forces a Claude usage reread when the credential refresh token changes", async () => {
    const view = render(<AgentAccountsSection platform="claude" reloadToken={0} />);
    await screen.findByText("5-hour limit");
    expect(calls.filter((call) => call.command === "get_agent_account_usage")).toEqual([
      { command: "get_agent_account_usage", args: { platform: "claude", accountId: "default" } },
    ]);
    usageResult = {
      ...usage,
      platform: "claude",
      status: "unavailable",
      windows: [],
      message: "Host Claude credentials are disabled.",
    };
    view.rerender(<AgentAccountsSection platform="claude" reloadToken={1} />);
    await screen.findByText("Host Claude credentials are disabled.");
    expect(calls.filter((call) => call.command === "get_agent_account_usage").at(-1)?.args).toEqual(
      {
        platform: "claude",
        accountId: "default",
        force: true,
      },
    );
    expect(screen.queryByText("5-hour limit") === null).toBe(true);
    view.rerender(<AgentAccountsSection platform="claude" reloadToken={1} />);
    expect(calls.filter((call) => call.command === "get_agent_account_usage")).toHaveLength(2);
  });
  test("lists only this platform's accounts with their identity and usage", async () => {
    await mount();
    const host = await screen.findByRole("listitem", { name: "Host login" });
    expect(within(host).getByText("Active")).toBeTruthy();
    expect(within(host).getByText("host@example.com · pro")).toBeTruthy();
    const added = screen.getByRole("listitem", { name: "second@example.com" });
    // The label already is the email, so only the plan is repeated.
    expect(within(added).getByText("plus")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("5-hour limit")).toHaveLength(2));
    expect(screen.queryAllByRole("listitem")).toHaveLength(2);
  });

  test("lists the active account first, then the rest alphabetically", async () => {
    snapshot.accounts.push(
      account({ id: "b", label: "bravo", isDefault: false, isActive: false }),
      account({ id: "a", label: "Alpha", isDefault: false, isActive: false }),
    );
    await mount();
    await screen.findByRole("listitem", { name: "Host login" });
    expect(accountOrder()).toEqual(["Host login", "Alpha", "bravo", "second@example.com"]);
  });

  test("switching asks the backend, moves the account to the top and re-reads usage", async () => {
    await mount();
    const added = await screen.findByRole("listitem", { name: "second@example.com" });
    await waitFor(() => expect(screen.getAllByText("5-hour limit")).toHaveLength(2));
    const usageReads = () => calls.filter((c) => c.command === "get_agent_account_usage").length;
    const readsBefore = usageReads();

    fireEvent.click(within(added).getByRole("button", { name: "Use" }));

    await waitFor(() => expect(within(added).getByText("Active")).toBeTruthy());
    expect(calls.find((c) => c.command === "set_active_agent_account")?.args).toEqual({
      platform: "codex",
      accountId: ADDED_ID,
    });
    expect(accountOrder()).toEqual(["second@example.com", "Host login"]);
    await waitFor(() => expect(usageReads()).toBeGreaterThan(readsBefore));
    // The host login is no longer active, so it can be switched back to.
    const host = screen.getByRole("listitem", { name: "Host login" });
    expect(within(host).getByRole("button", { name: "Use" })).toBeTruthy();
  });

  test("removing an account needs a second click", async () => {
    await mount();
    const added = await screen.findByRole("listitem", { name: "second@example.com" });
    fireEvent.click(within(added).getByRole("button", { name: "Remove" }));
    expect(calls.some((c) => c.command === "remove_agent_account")).toBe(false);

    fireEvent.click(within(added).getByRole("button", { name: "Confirm remove" }));

    await waitFor(() =>
      expect(screen.queryByRole("listitem", { name: "second@example.com" }) === null).toBe(true),
    );
  });

  test("a Codex sign-in shows the one-time code and reloads the list when it finishes", async () => {
    const { clock } = installFakeReadCoordinator();
    startResult = {
      state: "pending",
      platform: "codex",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH1",
      needsCode: false,
    };
    await mount();
    await act(async () => {
      await clock.advance(0);
    });

    fireEvent.click(screen.getByRole("button", { name: /Add account/ }));
    const panel = await screen.findByLabelText("Account sign-in");
    expect(within(panel).getByText("ABCD-EFGH1")).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: /Open sign-in page/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.command === "open_in_browser")?.args).toEqual({
        url: "https://auth.openai.com/codex/device",
      }),
    );

    const listsBefore = calls.filter((c) => c.command === "list_agent_accounts").length;
    login = { state: "succeeded", platform: "codex", accountId: ADDED_ID };
    await act(async () => {
      await clock.advance(2_000);
    });

    await waitFor(() => expect(screen.queryByLabelText("Account sign-in") === null).toBe(true));
    expect(calls.filter((c) => c.command === "list_agent_accounts").length).toBeGreaterThan(
      listsBefore,
    );
  });

  test.each(["succeeded", "failed", "idle"] as const)(
    "observes reauthentication ending as %s without remount",
    async (state) => {
      const { clock } = installFakeReadCoordinator();
      login = {
        state: "pending",
        platform: "claude",
        mode: "reauthenticate",
        operationId: "reauth-one",
      };
      await act(async () => {
        render(<AgentAccountsSection platform="claude" />);
        await clock.advance(0);
      });
      const add = await screen.findByRole("button", { name: /Add account/ });
      expect((add as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByLabelText("Account sign-in") === null).toBe(true);
      login = { ...login, state, ...(state === "failed" ? { error: "Sign-in rejected" } : {}) };
      await act(async () => {
        await clock.advance(2_000);
      });
      expect((add as HTMLButtonElement).disabled).toBe(false);
      if (state === "failed") expect(screen.getByText("Sign-in rejected")).toBeTruthy();
    },
  );

  test("a Claude sign-in forwards the pasted code", async () => {
    login = {
      state: "pending",
      platform: "codex",
      url: "https://claude.com/cai/oauth/authorize?code=true",
      needsCode: true,
    };
    await mount();
    const input = await screen.findByLabelText("Sign-in code");

    fireEvent.change(input, { target: { value: "code#state" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(calls.find((c) => c.command === "submit_agent_account_login_code")?.args).toEqual({
        code: "code#state",
      }),
    );
  });
});
