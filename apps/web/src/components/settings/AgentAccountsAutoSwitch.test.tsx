import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentAccountAutoSwitchState } from "@orkestrator/protocol/agent-account-auto-switch";
import type { AgentAccountsSnapshot } from "@orkestrator/protocol/agent-accounts";

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
const portalCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
let snapshot: AgentAccountsSnapshot;

function answer(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  calls.push({ command, args });
  switch (command) {
    case "list_agent_accounts":
      return Promise.resolve(snapshot);
    case "get_agent_account_usage":
      return Promise.resolve({
        platform: "codex",
        status: "ok",
        windows: [],
        fetchedAt: new Date(0).toISOString(),
      });
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
    expect(screen.getByText(/A manual switch pinned API key/)).toBeTruthy();
  });

  test("a machine that predates it shows no ticks and keeps working", async () => {
    render(<AgentAccountsSection platform="codex" />);
    await screen.findByText("a@example.com");
    expect(screen.queryByRole("checkbox") === null).toBe(true);
  });
});
