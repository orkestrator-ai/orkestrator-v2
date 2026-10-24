import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AgentAccountsSnapshot,
  AgentAccountSummary,
  AgentSessionAccount,
} from "@orkestrator/protocol/agent-accounts";

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let snapshot: AgentAccountsSnapshot;
let session: AgentSessionAccount | null;

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "get_native_agent_session_account":
        return Promise.resolve(session);
      case "list_agent_accounts":
        return Promise.resolve(snapshot);
      case "get_agent_account_login":
        return Promise.resolve({ state: "idle" });
      case "set_active_agent_account":
        snapshot = { ...snapshot, active: { ...snapshot.active, claude: String(args.accountId) } };
        return Promise.resolve(snapshot);
      default:
        return Promise.resolve(undefined);
    }
  }),
}));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
});

const { AgentInfoAccountSection } = await import("./AgentInfoAccountSection");

const WORK = "11111111-2222-4333-8444-555555555555";

function account(overrides: Partial<AgentAccountSummary>): AgentAccountSummary {
  return {
    id: "default",
    platform: "claude",
    label: "Host login",
    isDefault: true,
    isActive: true,
    signedIn: true,
    identity: { email: "me@example.com", plan: "max" },
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  snapshot = {
    active: { claude: "default", codex: "default" },
    accounts: [
      account({}),
      account({
        id: WORK,
        label: "Work",
        isDefault: false,
        isActive: false,
        identity: { email: "work@example.com", plan: "team" },
      }),
    ],
  };
  session = { platform: "claude", source: "account", account: account({}), running: true };
});

afterEach(() => {
  cleanup();
});

describe("AgentInfoAccountSection", () => {
  test("shows nothing for a platform without accounts", async () => {
    await act(async () => {
      render(<AgentInfoAccountSection environmentId="env-1" provider="pi" />);
    });
    expect(screen.queryByTestId("agent-info-account") === null).toBe(true);
    expect(calls).toEqual([]);
  });

  test("names the session's account and switches every agent on the machine", async () => {
    await act(async () => {
      render(<AgentInfoAccountSection environmentId="env-1" provider="claude" />);
    });
    expect(await screen.findByText("Host login")).toBeTruthy();
    expect(screen.getByText("me@example.com · max")).toBeTruthy();
    expect(calls).toContainEqual({
      command: "get_native_agent_session_account",
      args: { environmentId: "env-1", agent: "claude" },
    });

    const picker = screen.getByRole("combobox", { name: "Use for every Claude Code agent" });
    fireEvent.keyDown(picker, { key: "Enter" });
    session = {
      platform: "claude",
      source: "account",
      account: account({}),
      running: true,
      pendingActive: snapshot.accounts[1],
    };
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Work \(work@example\.com\)/ }));
    });
    expect(calls).toContainEqual({
      command: "set_active_agent_account",
      args: { platform: "claude", accountId: WORK },
    });
    await waitFor(() =>
      expect(screen.getByText("Moves to Work the next time this session is idle.")).toBeTruthy(),
    );
    // Renewing the active login would not renew the one this session still runs on.
    expect(screen.queryByRole("button", { name: "Sign in again" }) === null).toBe(true);
  });

  test("an isolated container offers no switch", async () => {
    session = { platform: "claude", source: "container", running: true };
    await act(async () => {
      render(<AgentInfoAccountSection environmentId="env-1" provider="claude" />);
    });
    expect(await screen.findByText(/keeps its own Claude Code login/)).toBeTruthy();
    expect(screen.queryByRole("combobox") === null).toBe(true);
  });
});
