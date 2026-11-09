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
const onAccountsChanged = mock(() => undefined);
let startResult: AgentAccountLoginProgress = { state: "idle" };

const usage: PlanUsageSnapshot = {
  platform: "codex",
  status: "ok",
  windows: [{ window: "primary", label: "5-hour limit", usedPercent: 40 }],
  fetchedAt: new Date(0).toISOString(),
};
let usageResult: PlanUsageSnapshot = usage;
let usageRead: (() => Promise<PlanUsageSnapshot>) | undefined;

function answer(command: string, args: Record<string, unknown>): Promise<unknown> {
  calls.push({ command, args });
  {
    switch (command) {
      case "list_agent_accounts":
        return Promise.resolve(snapshot);
      case "get_agent_account_usage":
        return usageRead ? usageRead() : Promise.resolve(usageResult);
      case "get_agent_account_login":
        return Promise.resolve(login);
      case "start_agent_account_login":
        login = startResult;
        return Promise.resolve(startResult);
      case "reauthenticate_agent_account":
        login = {
          state: "pending",
          operationId: "renew-one",
          platform: "claude",
          mode: "reauthenticate",
          accountId: String(args.accountId),
          url: "https://claude.com/cai/oauth/authorize?code=true",
          needsCode: true,
        };
        return Promise.resolve(login);
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
      case "rename_agent_account":
        snapshot = {
          ...snapshot,
          accounts: snapshot.accounts.map((a) =>
            a.id === args.accountId ? { ...a, label: String(args.label) } : a,
          ),
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
  }
}

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string, args: Record<string, unknown> = {}) => {
    // Another machine's accounts are asked through the command node.
    if (command === "invoke_on_node") {
      calls.push({ command, args: { nodeId: args.nodeId, command: args.command } });
      return answer(String(args.command), (args.args ?? {}) as Record<string, unknown>).then(
        (result) => ({ outcome: "ok", result }),
      );
    }
    return answer(command, args);
  }),
}));

mock.module("@/lib/native/clipboard", () => ({ writeText: mock(async () => undefined) }));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
});

const { AgentAccountsSection } = await import("./AgentAccountsSection");
const { AccountMachineProvider } = await import("./account-machine");

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
  onAccountsChanged.mockClear();
  usageResult = usage;
  usageRead = undefined;
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
    render(<AgentAccountsSection platform="codex" onAccountsChanged={onAccountsChanged} />);
  });
}

function accountOrder(): string[] {
  return screen.getAllByRole("listitem").map((item) => item.getAttribute("aria-label") ?? "");
}

describe("AgentAccountsSection", () => {
  test("removes an inactive saved twin while the host login stays active", async () => {
    snapshot.accounts[2] = { ...snapshot.accounts[2]!, identity: { email: "HOST@example.com" } };
    await mount();
    const row = await screen.findByRole("listitem", { name: "second@example.com" });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(within(row).getByText("Active")).toBeTruthy();
    expect(within(row).getByText("Also the host login")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Use" }) === null).toBe(true);
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(row).getByRole("button", { name: "Confirm remove" }));
    const host = await screen.findByRole("listitem", { name: "Host login" });
    expect(within(host).getByText("Active")).toBeTruthy();
    expect(snapshot.active.codex).toBe("default");
    expect(calls).toContainEqual({
      command: "remove_agent_account",
      args: { platform: "codex", accountId: ADDED_ID },
    });
  });

  test("an active saved twin remains protected from removal", async () => {
    snapshot.active.codex = ADDED_ID;
    snapshot.accounts[1] = { ...snapshot.accounts[1]!, isActive: false };
    snapshot.accounts[2] = {
      ...snapshot.accounts[2]!,
      isActive: true,
      identity: { email: "host@example.com" },
    };
    await mount();
    const row = await screen.findByRole("listitem", { name: "second@example.com" });
    expect(within(row).getByText("Active")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Remove" }) === null).toBe(true);
    expect(within(row).queryByRole("button", { name: "Use" }) === null).toBe(true);
  });

  test("rename and removal notify the adjacent status reader", async () => {
    await mount();
    const added = await screen.findByRole("listitem", { name: "second@example.com" });
    fireEvent.click(within(added).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(added).getByRole("textbox", { name: "Account name" }), {
      target: { value: "Renamed account" },
    });
    fireEvent.click(within(added).getByRole("button", { name: "Save" }));
    const renamed = await screen.findByRole("listitem", { name: "Renamed account" });
    await waitFor(() => expect(onAccountsChanged).toHaveBeenCalledTimes(1));
    fireEvent.click(within(renamed).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(renamed).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(onAccountsChanged).toHaveBeenCalledTimes(2));
  });

  test("acts on the chosen machine through the command node", async () => {
    await act(async () => {
      render(
        <AccountMachineProvider value={{ machine: "node-leaf", name: "MBP3" }}>
          <AgentAccountsSection platform="codex" />
        </AccountMachineProvider>,
      );
    });
    expect(await screen.findByText("Accounts on MBP3")).toBeTruthy();
    expect(calls).toContainEqual({
      command: "invoke_on_node",
      args: { nodeId: "node-leaf", command: "list_agent_accounts" },
    });
    expect(calls.some((call) => call.command === "list_agent_accounts" && !call.args.nodeId)).toBe(
      true,
    );
    const second = await screen.findByRole("listitem", { name: "second@example.com" });
    await act(async () => {
      fireEvent.click(within(second).getByRole("button", { name: "Use" }));
    });
    expect(calls).toContainEqual({
      command: "invoke_on_node",
      args: { nodeId: "node-leaf", command: "set_active_agent_account" },
    });
    // Nothing went to this window's own backend directly.
    expect(
      calls.filter(
        (call, index) =>
          call.command === "set_active_agent_account" &&
          calls[index - 1]?.command !== "invoke_on_node",
      ),
    ).toEqual([]);
  });

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
  test("both active and inactive rows retain stale quotas with their timestamp and failure", async () => {
    usageResult = {
      ...usage,
      stale: true,
      fetchedAt: new Date(Date.now() - 3_600_000).toISOString(),
      message: "Sign-in expired. Switch to this account to refresh usage.",
    };
    await mount();
    for (const name of ["Host login", "second@example.com"]) {
      const row = await screen.findByRole("listitem", { name });
      expect(await within(row).findByText("40% used")).toBeTruthy();
      const age = within(row).getByTestId("usage-reading-age");
      expect(age.textContent).toMatch(/Updated .+ \(1h ago\)/);
      expect(within(age).getByText("Stale")).toBeTruthy();
      expect(within(row).getByText(/Sign-in expired/)).toBeTruthy();
      expect(within(row).getByTestId("usage-reading-bars").getAttribute("data-stale")).toBe("true");
    }
  });

  test("a row shows a reading another machine took of the same login, and when", async () => {
    usageResult = {
      ...usage,
      fetchedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      readOn: { nodeId: "bk_beelink", nodeName: "beelink" },
    };
    await mount();
    const row = await screen.findByRole("listitem", { name: "second@example.com" });
    const age = await within(row).findByTestId("usage-reading-age");
    expect(age.textContent).toMatch(/^Updated .+ \(2m ago\) on beelink$/);
    expect(age.getAttribute("data-stale")).toBe("false");
  });

  test("a row whose usage was never read says so", async () => {
    usageResult = {
      platform: "codex",
      status: "unavailable",
      windows: [],
      message: "This account's sign-in is refreshed while it is in use.",
      fetchedAt: new Date().toISOString(),
    };
    await mount();
    const row = await screen.findByRole("listitem", { name: "second@example.com" });
    expect(await within(row).findByText("Usage has not been read yet.")).toBeTruthy();
    expect(within(row).getByText(/refreshed while it is in use/)).toBeTruthy();
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

  test("warns about entries an account keeps as its own copy", async () => {
    snapshot.accounts[2] = { ...snapshot.accounts[2]!, privateEntries: ["config.toml", "rules"] };
    await mount();
    const added = await screen.findByRole("listitem", { name: "second@example.com" });
    expect(
      within(added).getByText("Not shared with your other accounts: config.toml, rules"),
    ).toBeTruthy();
    // The explanation stays behind the info icon until asked for.
    expect(screen.queryByText(/Codex saved its own copy/) === null).toBe(true);
    fireEvent.click(
      within(added).getByRole("button", { name: "About config.toml, rules not being shared" }),
    );
    const tip = await screen.findByRole("tooltip");
    expect(within(tip).getByText(/Codex saved its own copy of these/)).toBeTruthy();
    expect(tip.textContent).toContain("To share them again");
    expect(tip.textContent).toContain("CODEX_HOME if set, otherwise ~/.codex");
    expect(within(tip).getByText(`agent-accounts/codex/${ADDED_ID}`)).toBeTruthy();
    const host = screen.getByRole("listitem", { name: "Host login" });
    expect(within(host).queryByText(/Not shared/) === null).toBe(true);
  });

  test.each([
    ["claude", "Claude", "CLAUDE_CONFIG_DIR", "~/.claude"],
    ["codex", "Codex", "CODEX_HOME", "~/.codex"],
  ] as const)(
    "%s recovery explains both configured and default homes for a single entry",
    async (platform, cli, setting, fallback) => {
      snapshot.accounts[2] = { ...snapshot.accounts[2]!, platform, privateEntries: ["rules"] };
      render(<AgentAccountsSection platform={platform} />);
      const added = await screen.findByRole("listitem", { name: "second@example.com" });
      fireEvent.click(within(added).getByRole("button", { name: "About rules not being shared" }));
      const tip = await screen.findByRole("tooltip");
      expect(tip.textContent).toContain(`${cli} saved its own copy of this`);
      expect(tip.textContent).toContain("To share it again");
      expect(tip.textContent).toContain(
        `configured ${cli} host directory on the machine that owns this account`,
      );
      expect(tip.textContent).toContain(`${setting} if set, otherwise ${fallback}`);
      expect(tip.textContent).toContain("Verify the saved content is there before deleting rules");
      expect(tip.textContent).toContain(`agent-accounts/${platform}/${ADDED_ID}`);
    },
  );

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
    expect(onAccountsChanged).toHaveBeenCalledTimes(1);
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
    expect(onAccountsChanged).toHaveBeenCalledTimes(1);
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
        render(<AgentAccountsSection platform="claude" onAccountsChanged={onAccountsChanged} />);
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
      expect(onAccountsChanged).toHaveBeenCalledTimes(1);
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

  test("a signed-out Claude account is signed in again from its own row, without a switch", async () => {
    const { clock } = installFakeReadCoordinator();
    snapshot.accounts[0] = { ...snapshot.accounts[0]!, label: "Claude host" };
    snapshot.accounts.push(
      account({
        id: ADDED_ID,
        platform: "claude",
        label: "lapsed@example.com",
        isDefault: false,
        isActive: false,
        signedIn: false,
        identity: { email: "lapsed@example.com", plan: "max" },
      }),
    );
    await act(async () => {
      render(<AgentAccountsSection platform="claude" onAccountsChanged={onAccountsChanged} />);
      await clock.advance(0);
    });
    const host = await screen.findByRole("listitem", { name: "Claude host" });
    expect(within(host).queryByRole("button", { name: /Sign in/ }) === null).toBe(true);
    const lapsed = screen.getByRole("listitem", { name: "lapsed@example.com" });
    expect(within(lapsed).getByText("Signed out")).toBeTruthy();
    // A signed-out account has no usage to refresh.
    expect(within(lapsed).queryByRole("button", { name: /Refresh usage/ }) === null).toBe(true);

    await act(async () => {
      fireEvent.click(within(lapsed).getByRole("button", { name: /Sign in/ }));
    });
    expect(calls).toContainEqual({
      command: "reauthenticate_agent_account",
      args: { platform: "claude", accountId: ADDED_ID },
    });
    const panel = await within(lapsed).findByLabelText("Account sign-in");
    expect(within(panel).getByLabelText("Sign-in code")).toBeTruthy();
    expect(within(lapsed).queryByRole("button", { name: /Sign in/ }) === null).toBe(true);
    expect(
      (screen.getByRole("button", { name: /Add account/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByText(/Another account sign-in is in progress/) === null).toBe(true);
    expect(calls.some((call) => call.command === "set_active_agent_account")).toBe(false);

    snapshot = {
      ...snapshot,
      accounts: snapshot.accounts.map((a) => (a.id === ADDED_ID ? { ...a, signedIn: true } : a)),
    };
    login = { ...login, state: "succeeded" };
    await act(async () => {
      await clock.advance(2_000);
    });
    await waitFor(() => expect(screen.queryByLabelText("Account sign-in") === null).toBe(true));
    expect(onAccountsChanged).toHaveBeenCalledTimes(1);
    const renewed = screen.getByRole("listitem", { name: "lapsed@example.com" });
    expect(within(renewed).queryByText("Signed out") === null).toBe(true);
    await within(renewed).findByText("5-hour limit");
  });

  test("a signed-out Codex account offers no sign-in in place", async () => {
    snapshot.accounts[2] = { ...snapshot.accounts[2]!, signedIn: false };
    await mount();
    const row = await screen.findByRole("listitem", { name: "second@example.com" });
    expect(within(row).getByText("Signed out")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /Sign in/ }) === null).toBe(true);
  });

  test("row refresh suppresses duplicate probes and recovers after a rejection", async () => {
    await mount();
    const row = await screen.findByRole("listitem", { name: "second@example.com" });
    await within(row).findByText("5-hour limit");
    const refresh = within(row).getByRole("button", {
      name: "Refresh usage for second@example.com",
    }) as HTMLButtonElement;
    let reject!: (cause: Error) => void;
    usageRead = () =>
      new Promise((_, fail) => {
        reject = fail;
      });
    const count = () => calls.filter((c) => c.command === "get_agent_account_usage").length;
    const before = count();
    await act(async () => {
      fireEvent.click(refresh);
    });
    expect(refresh.disabled).toBe(true);
    fireEvent.click(refresh);
    expect(count()).toBe(before + 1);
    await act(async () => {
      reject(new Error("Probe unavailable"));
    });
    await within(row).findByText("Probe unavailable");
    expect(refresh.disabled).toBe(false);
    usageRead = undefined;
    await act(async () => {
      fireEvent.click(refresh);
    });
    await within(row).findByText("5-hour limit");
    expect(refresh.disabled).toBe(false);
    expect(count()).toBe(before + 2);
  });

  test("row refresh shows provider cooldown and allows a later retry", async () => {
    await mount();
    const row = await screen.findByRole("listitem", { name: "second@example.com" });
    await within(row).findByText("5-hour limit");
    const refresh = within(row).getByRole("button", {
      name: "Refresh usage for second@example.com",
    }) as HTMLButtonElement;
    usageResult = {
      ...usage,
      status: "error",
      windows: [],
      message: "HTTP 429: usage is cooling down",
    };
    await act(async () => {
      fireEvent.click(refresh);
    });
    await within(row).findByText("HTTP 429: usage is cooling down");
    expect(refresh.disabled).toBe(false);
    usageResult = usage;
    await act(async () => {
      fireEvent.click(refresh);
    });
    await within(row).findByText("5-hour limit");
    expect(refresh.disabled).toBe(false);
  });

  test("an account's refresh button reads its usage afresh, and only its own", async () => {
    await mount();
    const added = await screen.findByRole("listitem", { name: "second@example.com" });
    await waitFor(() =>
      expect(calls.filter((call) => call.command === "get_agent_account_usage")).toHaveLength(2),
    );
    const refresh = within(added).getByRole("button", {
      name: "Refresh usage for second@example.com",
    });
    await act(async () => {
      fireEvent.click(refresh);
    });
    await waitFor(() =>
      expect(calls.filter((call) => call.command === "get_agent_account_usage")).toHaveLength(3),
    );
    expect(calls.filter((call) => call.command === "get_agent_account_usage").at(-1)?.args).toEqual(
      { platform: "codex", accountId: ADDED_ID, force: true },
    );
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
  });
});
