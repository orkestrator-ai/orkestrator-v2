import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { portalStore } from "@/lib/portal/portal-store";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AgentAccountsSnapshot,
  AgentAccountSummary,
  AgentSessionAccount,
} from "@orkestrator/protocol/agent-accounts";

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let snapshot: AgentAccountsSnapshot;
let session: AgentSessionAccount | null;
let readSession: (() => Promise<AgentSessionAccount | null>) | undefined;
let deferredRead:
  | ((command: string, args: Record<string, unknown>) => Promise<unknown> | undefined)
  | undefined;
let loginProgress: Record<string, unknown> = { state: "idle" };

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    const deferred = deferredRead?.(command, args);
    if (deferred) return deferred;
    switch (command) {
      case "get_native_agent_session_account":
        return readSession ? readSession() : Promise.resolve(session);
      case "list_agent_accounts":
        return Promise.resolve(snapshot);
      case "get_agent_account_login":
        return Promise.resolve(loginProgress);
      case "start_agent_account_login":
        return Promise.resolve({
          state: "pending",
          platform: "claude",
          mode: "reauthenticate",
          operationId: "reauth",
          url: "https://example.com/login",
        });
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
  readSession = undefined;
  deferredRead = undefined;
  loginProgress = { state: "idle" };
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

test("opening the persistent panel reloads account and active selection after Settings changes", async () => {
  const view = render(<AgentInfoAccountSection environmentId="env-1" provider="claude" />);
  await screen.findByText("Host login");
  view.rerender(<AgentInfoAccountSection environmentId="env-1" provider="claude" open={false} />);
  const work = snapshot.accounts[1]!;
  snapshot = { ...snapshot, active: { ...snapshot.active, claude: WORK } };
  session = { platform: "claude", source: "account", account: work, running: true };
  view.rerender(<AgentInfoAccountSection environmentId="env-1" provider="claude" open />);
  await screen.findByText("work@example.com · team");
  expect(screen.queryByText("me@example.com · max") === null).toBe(true);
  expect(screen.getByRole("combobox").textContent).toContain("Work");
});

for (const target of [
  { environmentId: "env-2", provider: "claude" },
  { environmentId: "env-1", provider: "codex" },
]) {
  test(`late reads cannot overwrite ${target.environmentId}/${target.provider}`, async () => {
    let resolveOld!: (value: AgentSessionAccount) => void;
    deferredRead = (command, args) =>
      command === "get_native_agent_session_account" &&
      args.environmentId === "env-1" &&
      args.agent === "claude"
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : undefined;
    const oldSession = { ...session!, pendingActive: snapshot.accounts[1] };
    const view = render(<AgentInfoAccountSection environmentId="env-1" provider="claude" />);
    await waitFor(() => expect(resolveOld).toBeDefined());
    session = {
      platform: target.provider as "claude" | "codex",
      source: "account",
      account: account({ label: "Current account" }),
      running: false,
    };
    view.rerender(<AgentInfoAccountSection {...target} />);
    await screen.findByText("Current account");
    await act(async () => resolveOld(oldSession));
    expect(screen.getByText("Current account")).toBeTruthy();
    expect(screen.queryByText("Host login", { selector: "span.truncate" }) === null).toBe(true);
    expect(screen.queryByText(/Moves to/) === null).toBe(true);
  });
}

test("unknown source explains missing attribution", async () => {
  session = { platform: "claude", source: "unknown", running: true };
  render(<AgentInfoAccountSection environmentId="env-1" provider="claude" />);
  expect(
    await screen.findByText("Could not tell which account this session runs on."),
  ).toBeTruthy();
});

test("Claude can reauthenticate its current account while Codex offers account management", async () => {
  const view = render(<AgentInfoAccountSection environmentId="env-1" provider="claude" />);
  const signIn = await screen.findByRole("button", { name: "Sign in again" });
  await act(async () => fireEvent.click(signIn));
  expect(calls).toContainEqual({
    command: "start_agent_account_login",
    args: { platform: "claude", reauthenticate: true },
  });
  expect(screen.queryByRole("button", { name: "Sign in again" }) === null).toBe(true);
  expect(screen.getByRole("button", { name: /Cancel/ })).toBeTruthy();
  view.rerender(<AgentInfoAccountSection environmentId="env-1" provider="codex" />);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Sign in again" }) === null).toBe(true),
  );
  expect(screen.queryByRole("button", { name: /Cancel/ }) === null).toBe(true);
});

test("names the session's bound machine when multiple machines are shown", async () => {
  const previous = portalStore.getState();
  window.orkestratorWorkspaceTarget = { nodeId: "leaf", nodeName: "Leaf", path: "direct" };
  deferredRead = (command) =>
    command === "get_backend_profile"
      ? Promise.resolve({ revision: 1, displayName: "Leaf", colorToken: "blue", updatedAt: "" })
      : undefined;
  try {
    render(
      <FederationProvider>
        <AgentInfoAccountSection environmentId="env-1" provider="claude" />
      </FederationProvider>,
    );
    expect(await screen.findByText("Claude Code account on Leaf")).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Use for every Claude Code agent on Leaf" }),
    ).toBeTruthy();
  } finally {
    cleanup();
    delete window.orkestratorWorkspaceTarget;
    portalStore.store.setState(previous);
  }
});

for (const trigger of ["open", "activity"] as const) {
  test(`refreshes a replaced bridge on ${trigger} while the panel remains mounted`, async () => {
    session = {
      platform: "claude",
      source: "account",
      account: account({}),
      running: true,
      pendingActive: snapshot.accounts[1],
    };
    const view = render(
      <AgentInfoAccountSection
        environmentId="env-1"
        provider="claude"
        open={false}
        refreshKey={0}
      />,
    );
    await screen.findByText(/Moves to Work/);
    expect(screen.queryByRole("button", { name: "Sign in again" }) === null).toBe(true);
    session = {
      platform: "claude",
      source: "account",
      account: snapshot.accounts[1],
      running: true,
    };
    view.rerender(
      <AgentInfoAccountSection
        environmentId="env-1"
        provider="claude"
        open={trigger === "open"}
        refreshKey={trigger === "activity" ? 1 : 0}
      />,
    );
    await screen.findByRole("button", { name: "Sign in again" });
    expect(screen.queryByText(/Moves to Work/) === null).toBe(true);
    expect(screen.getByText("work@example.com · team")).toBeTruthy();
  });
}

for (const change of ["environment", "provider", "activity"] as const) {
  test(`discards an old response after changing ${change}`, async () => {
    let finishOld!: (value: AgentSessionAccount | null) => void;
    readSession = () =>
      new Promise((resolve) => {
        finishOld = resolve;
      });
    const view = render(
      <AgentInfoAccountSection environmentId="old" provider="claude" refreshKey={0} />,
    );
    await waitFor(() => expect(finishOld).toBeTruthy());
    const current = {
      platform: change === "provider" ? ("codex" as const) : ("claude" as const),
      source: "account" as const,
      account: account({ label: "Current" }),
      running: true,
    };
    readSession = async () => current;
    view.rerender(
      <AgentInfoAccountSection
        environmentId={change === "environment" ? "new" : "old"}
        provider={current.platform}
        refreshKey={1}
      />,
    );
    await screen.findByText("Current");
    await act(async () =>
      finishOld({
        platform: "claude",
        source: "account",
        account: account({ label: "Obsolete" }),
        running: true,
        pendingActive: snapshot.accounts[1],
      }),
    );
    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.queryByText("Obsolete") === null).toBe(true);
    expect(screen.queryByText(/Moves to Work/) === null).toBe(true);
    if (change !== "provider")
      expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
  });
}
