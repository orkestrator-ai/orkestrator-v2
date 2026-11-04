import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  CoordinatorAccountSwitchGrantState,
  CoordinatorAccountSwitchRecord,
} from "@orkestrator/protocol/coordinator-account-switch-grant";

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let state: CoordinatorAccountSwitchGrantState;
let unknown = false;

const record: CoordinatorAccountSwitchRecord = {
  requestId: "switch-account:c:1",
  at: new Date(Date.now() - 5 * 60_000).toISOString(),
  platform: "claude",
  nodeId: "bk_beelink",
  nodeName: "beelink",
  fromAccountLabel: "Host login",
  toAccountId: "acct-work",
  toAccountLabel: "Work (work@example.com)",
  coordinatorName: "orkestrator-v2 coordinator",
  reason: "Workers are about to hit the 5-hour limit",
  state: "executed",
};

function answer(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  calls.push({ command, args });
  switch (command) {
    case "get_coordinator_account_switch_grant":
      return unknown
        ? Promise.reject(new Error(`Unknown command: ${command}`))
        : Promise.resolve(state);
    case "set_coordinator_account_switch_grant":
      state = { ...state, grants: { ...state.grants, claude: args.enabled === true } };
      return Promise.resolve(state);
    default:
      return Promise.resolve(undefined);
  }
}

mock.module("@/lib/native/backend", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => answer(command, args),
}));

const { CoordinatorAccountSwitchGrant } = await import("./CoordinatorAccountSwitchGrant");
const { describeCoordinatorAccountSwitch } =
  await import("@/components/federation/CoordinatorAccountSwitchNotices");

beforeEach(() => {
  calls.length = 0;
  unknown = false;
  state = {
    grants: { claude: false, codex: false },
    limit: { switches: 3, windowMinutes: 60 },
    recentSwitches: [],
  };
});

afterEach(cleanup);

function show() {
  return render(
    <CoordinatorAccountSwitchGrant
      platform="claude"
      platformLabel="Claude"
      machine={undefined}
      machineName={null}
      refreshKey="0"
    />,
  );
}

const tick = () =>
  screen.findByRole("checkbox", { name: "Let coordinators switch accounts without asking" });

describe("coordinator account-switch permission in Settings", () => {
  test("is off by default, and ticking it grants the provider on this machine", async () => {
    show();
    const box = await tick();
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/ask you before switching the active Claude account/)).toBeTruthy();
    expect(screen.getByText(/at most 3 switches per machine in 60 minutes/)).toBeTruthy();

    fireEvent.click(box);
    await waitFor(() => expect((box as HTMLElement).getAttribute("aria-checked")).toBe("true"));
    expect(
      calls.find((call) => call.command === "set_coordinator_account_switch_grant")?.args,
    ).toEqual({ platform: "claude", enabled: true });
    expect(screen.getByText(/switch the active Claude account at once/)).toBeTruthy();

    fireEvent.click(box);
    await waitFor(() => expect((box as HTMLElement).getAttribute("aria-checked")).toBe("false"));
    expect(
      calls.filter((call) => call.command === "set_coordinator_account_switch_grant").at(-1)?.args,
    ).toEqual({ platform: "claude", enabled: false });
  });

  test("lists each switch with machine, accounts, coordinator and reason", async () => {
    state = { ...state, grants: { claude: true, codex: false }, recentSwitches: [record] };
    show();
    const row = await screen.findByRole("listitem", { name: "Switch on beelink" });
    expect(row.textContent).toContain("beelink");
    expect(row.textContent).toContain("Host login");
    expect(row.textContent).toContain("Work (work@example.com)");
    expect(row.textContent).toContain("orkestrator-v2 coordinator");
    expect(row.textContent).toContain("Workers are about to hit the 5-hour limit");
    expect(row.textContent).toContain("5m ago");
  });

  test("a machine that predates the permission shows nothing", async () => {
    unknown = true;
    const { container } = show();
    await waitFor(() =>
      expect(calls.some((call) => call.command === "get_coordinator_account_switch_grant")).toBe(
        true,
      ),
    );
    expect(container.textContent).toBe("");
  });

  test("the notice names the machine, both accounts, the coordinator and the reason", () => {
    expect(describeCoordinatorAccountSwitch(record)).toBe(
      "The orkestrator-v2 coordinator switched the active Claude account on beelink from “Host login” to “Work (work@example.com)”: “Workers are about to hit the 5-hour limit”",
    );
  });
});
