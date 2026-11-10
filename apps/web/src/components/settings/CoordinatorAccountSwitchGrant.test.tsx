import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  CoordinatorAccountSwitchGrantState,
  CoordinatorAccountSwitchRecord,
} from "@orkestrator/protocol/coordinator-account-switch-grant";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let state: CoordinatorAccountSwitchGrantState;
let unknown = false;
let refresh: (() => void) | undefined;
let resync: (() => void) | undefined;
let notice: ((event: { payload: unknown }) => void) | undefined;
let noticeStop = 0;
const nodeSubscribers = new Map<
  string,
  { onEvent: (event: string, payload: unknown) => void; onResync: () => void }
>();
const nodeStops: string[] = [];
const routed: Array<{ nodeId: string; command: string; args: Record<string, unknown> }> = [];
const portalState = createStore(() => ({
  selfId: "bk_command",
  nodes: [] as Array<{ nodeId: string }>,
}));
mock.module("@/lib/portal/portal-store", () => ({
  portalStore: {
    store: portalState,
    getState: portalState.getState,
    invokeOnNode: (nodeId: string, command: string, args: Record<string, unknown>) => {
      routed.push({ nodeId, command, args });
      return answer(command, args);
    },
  },
}));
import { mockToastInfo, mockToastWarning } from "../../../../../tests/mocks/sonner";
mock.module("@/lib/federation/node-events", () => ({
  subscribeCommandNodeEvents: (subscriber: {
    onEvent: (event: string, payload: unknown) => void;
    onResync: () => void;
  }) => {
    refresh = () => subscriber.onEvent("coordinator-account-switched", record);
    notice = ({ payload }) => subscriber.onEvent("coordinator-account-switched", payload);
    resync = subscriber.onResync;
    return () => {
      noticeStop++;
    };
  },
  subscribeNodeEvents: (
    nodeId: string,
    subscriber: { onEvent: (event: string, payload: unknown) => void; onResync: () => void },
  ) => {
    nodeSubscribers.set(nodeId, subscriber);
    return () => {
      nodeSubscribers.delete(nodeId);
      nodeStops.push(nodeId);
    };
  },
}));
mock.module("@/lib/native/authoritative-events", () => ({
  listenAuthoritative: (_event: string, handler: () => void, options: { onResync: () => void }) => {
    refresh = handler;
    resync = options.onResync;
    return Promise.resolve(() => {});
  },
}));
// The portal APIs are command-scope calls (plan item 5004); `portal-transport` re-exports these.
mock.module("@/lib/portal/command-scope", () => ({
  commandScopeListen: (_event: string, handler: (event: { payload: unknown }) => void) => {
    notice = handler;
    return Promise.resolve(() => {
      noticeStop++;
    });
  },
  commandScopeListenAuthoritative: () => Promise.resolve(() => {}),
  commandScopeInvoke: (command: string, args?: Record<string, unknown>) => answer(command, args),
  commandScopeBackendClient: {
    invokeRaw: (command: string, args?: Record<string, unknown>) => answer(command, args),
  },
}));

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
        ? Promise.reject(new Error(unknownBackendCommandMessage(command)))
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
const { describeCoordinatorAccountSwitch, CoordinatorAccountSwitchNotices } =
  await import("@/components/federation/CoordinatorAccountSwitchNotices");

beforeEach(() => {
  calls.length = 0;
  routed.length = 0;
  nodeSubscribers.clear();
  nodeStops.length = 0;
  portalState.setState({ nodes: [] });
  mockToastInfo.mockClear();
  mockToastWarning.mockClear();
  unknown = false;
  state = {
    grants: { claude: false, codex: false },
    limit: { switches: 3, windowMinutes: 60 },
    recentSwitches: [],
  };
});

afterEach(cleanup);

function show(machine: string | null | undefined = undefined) {
  return render(
    <CoordinatorAccountSwitchGrant
      platform="claude"
      platformLabel="Claude"
      machine={machine}
      machineName={null}
      refreshKey="0"
    />,
  );
}

const tick = () =>
  screen.findByRole("checkbox", { name: "Let coordinators switch accounts without asking" });

/** Opens the switch log and answers its dialog. */
async function openLog(entries = 1) {
  const button = await screen.findByRole("button", {
    name: `View switch log, ${entries} ${entries === 1 ? "entry" : "entries"}`,
  });
  button.focus();
  fireEvent.click(button);
  return { button, dialog: await screen.findByRole("dialog", { name: "Claude account switches" }) };
}

describe("coordinator account-switch permission in Settings", () => {
  test("is off by default, and ticking it grants the provider on this machine", async () => {
    show();
    const box = await tick();
    expect(box.getAttribute("aria-checked")).toBe("false");
    const hint = screen.getByRole("button", { name: "About coordinator account switching" });
    fireEvent.click(hint);
    const tip = await screen.findByRole("tooltip");
    expect(
      within(tip).getByText(/ask you before switching the active Claude account/),
    ).toBeTruthy();
    expect(within(tip).getByText(/at most 3 switches per machine in 60 minutes/)).toBeTruthy();
    fireEvent.click(hint);

    fireEvent.click(box);
    await waitFor(() => expect((box as HTMLElement).getAttribute("aria-checked")).toBe("true"));
    expect(
      calls.find((call) => call.command === "set_coordinator_account_switch_grant")?.args,
    ).toEqual({ platform: "claude", enabled: true });
    fireEvent.click(hint);
    expect(
      within(await screen.findByRole("tooltip")).getByText(
        /switch the active Claude account at once/,
      ),
    ).toBeTruthy();
    fireEvent.click(hint);

    fireEvent.click(box);
    await waitFor(() => expect((box as HTMLElement).getAttribute("aria-checked")).toBe("false"));
    expect(
      calls.filter((call) => call.command === "set_coordinator_account_switch_grant").at(-1)?.args,
    ).toEqual({ platform: "claude", enabled: false });
  });

  test("lists each switch with machine, accounts, coordinator and reason", async () => {
    state = { ...state, grants: { claude: true, codex: false }, recentSwitches: [record] };
    show();
    await openLog();
    const row = await screen.findByRole("listitem", { name: "Switch on beelink" });
    expect(row.textContent).toContain("beelink");
    expect(row.textContent).toContain("Host login");
    expect(row.textContent).toContain("Work (work@example.com)");
    expect(row.textContent).toContain("orkestrator-v2 coordinator");
    expect(row.textContent).toContain("Workers are about to hit the 5-hour limit");
    expect(row.textContent).toContain("5m ago");
    // The local date and time, not only the age.
    expect(
      within(row).getByText(
        new Date(record.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
      ),
    ).toBeTruthy();
  });

  test("the log is not shown inline: a button with its count opens it in a dialog", async () => {
    const older = {
      ...record,
      requestId: "older",
      at: new Date(Date.now() - 4 * 24 * 60 * 60_000).toISOString(),
      nodeName: "rkmbp",
      fromAccountLabel: "618BTrading",
      toAccountLabel: "arkaydeusdev",
      reason: "User asked to move off the limited account",
    };
    const middle = {
      ...record,
      requestId: "middle",
      at: new Date(Date.now() - 60 * 60_000).toISOString(),
      nodeName: "mini",
    };
    // Delivered out of order; the dialog still lists newest first.
    state = { ...state, recentSwitches: [older, record, middle] };
    show();
    await tick();
    expect(screen.queryByRole("listitem") === null).toBe(true);
    expect(screen.queryByText(/Workers are about to hit/) === null).toBe(true);

    const { button, dialog } = await openLog(3);
    const rows = within(dialog).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Switch on beelink",
      "Switch on mini",
      "Switch on rkmbp",
    ]);
    expect(rows[2]!.textContent).toContain("618BTrading → arkaydeusdev");
    expect(rows[2]!.textContent).toContain(
      "Asked by orkestrator-v2 coordinator: “User asked to move off the limited account”",
    );
    // The list scrolls inside the dialog rather than growing past the viewport.
    expect(within(dialog).getByTestId("coordinator-switch-log").className).toContain(
      "overflow-y-auto",
    );
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  test("a switch a self-timer's permission allowed says so, with the user's words", async () => {
    const timed = {
      ...record,
      requestId: "timed",
      authorizedBy: "self-timer" as const,
      scheduleId: "schedule-1",
      userInstruction: "check in 2 hours and switch if they are limited",
    };
    state = { ...state, recentSwitches: [timed] };
    show();
    await openLog();
    const row = await screen.findByRole("listitem", { name: "Switch on beelink" });
    expect(row.textContent).toContain(
      "Allowed by a timer you set: you asked “check in 2 hours and switch if they are limited”",
    );
    expect(describeCoordinatorAccountSwitch(timed)).toContain(
      "A timer you set allowed it: you asked “check in 2 hours and switch if they are limited”.",
    );
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

  test("refreshes open history after a leaf switch and a stream resync", async () => {
    show(null);
    await tick();
    state = { ...state, recentSwitches: [record] };
    refresh?.();
    const { dialog } = await openLog();
    await within(dialog).findByRole("listitem", { name: "Switch on beelink" });
    state = {
      ...state,
      recentSwitches: [record, { ...record, requestId: "2", nodeName: "other leaf" }],
    };
    resync?.();
    // An open log follows the history as it changes.
    await within(dialog).findByRole("listitem", { name: "Switch on other leaf" });
    expect(
      await screen.findByRole("button", { name: "View switch log, 2 entries", hidden: true }),
    ).toBeTruthy();
  });

  test("reads and writes a specific leaf grant and refreshes after events and resync", async () => {
    const view = show("bk_leaf");
    const box = await tick();
    expect(routed[0]).toEqual({
      nodeId: "bk_leaf",
      command: "get_coordinator_account_switch_grant",
      args: { platform: "claude" },
    });
    fireEvent.click(box);
    await waitFor(() => expect(box.getAttribute("aria-checked")).toBe("true"));
    expect(routed.at(-1)).toEqual({
      nodeId: "bk_leaf",
      command: "set_coordinator_account_switch_grant",
      args: { platform: "claude", enabled: true },
    });
    state = { ...state, recentSwitches: [record] };
    nodeSubscribers.get("bk_leaf")!.onEvent("coordinator-account-switched", record);
    await screen.findByRole("button", { name: "View switch log, 1 entry" });
    state = { ...state, grants: { claude: false, codex: false }, recentSwitches: [] };
    nodeSubscribers.get("bk_leaf")!.onResync();
    await waitFor(() => expect(box.getAttribute("aria-checked")).toBe("false"));
    expect(screen.queryByRole("button", { name: /View switch log/ }) === null).toBe(true);
    view.unmount();
    expect(nodeStops).toEqual(["bk_leaf"]);
  });

  test("subscribes to leaf notices independently of the selected workspace and releases removed nodes", () => {
    portalState.setState({ nodes: [{ nodeId: "bk_command" }, { nodeId: "bk_leaf" }] });
    const view = render(<CoordinatorAccountSwitchNotices />);
    expect([...nodeSubscribers.keys()]).toEqual(["bk_leaf"]);
    nodeSubscribers.get("bk_leaf")!.onEvent("coordinator-account-switched", record);
    expect(mockToastInfo).toHaveBeenCalledTimes(1);
    expect(mockToastInfo.mock.calls[0]?.[1]).toMatchObject({
      id: `coordinator-account-switch:bk_leaf:${record.requestId}`,
    });
    portalState.setState({ nodes: [{ nodeId: "bk_other" }] });
    expect(nodeStops).toEqual(["bk_leaf"]);
    expect([...nodeSubscribers.keys()]).toEqual(["bk_other"]);
    view.unmount();
    expect(nodeStops).toEqual(["bk_leaf", "bk_other"]);
  });

  test.each(["failed", "outcome-unknown"] as const)(
    "warning description describes %s truthfully",
    (state) => {
      render(<CoordinatorAccountSwitchNotices />);
      notice!({ payload: { ...record, state, message: "Check target" } });
      const description = `The orkestrator-v2 coordinator tried to switch the active Claude account on beelink from “Host login” to “Work (work@example.com)”: “Workers are about to hit the 5-hour limit”${state === "outcome-unknown" ? " The outcome is unknown. Check the active account on the target machine." : ""} Check target`;
      expect(mockToastWarning).toHaveBeenCalledWith(
        "Account switch did not complete",
        expect.objectContaining({ description }),
      );
      expect(mockToastInfo).not.toHaveBeenCalled();
    },
  );

  test("notice listener shows success and warning, ignores malformed data and cleans up", async () => {
    notice = undefined;
    noticeStop = 0;
    const view = render(<CoordinatorAccountSwitchNotices />);
    await waitFor(() => expect(notice).toBeDefined());
    notice!({ payload: null });
    notice!({ payload: {} });
    notice!({ payload: record });
    notice!({ payload: { ...record, state: "outcome-unknown", message: "Check target" } });
    expect(mockToastInfo).toHaveBeenCalledTimes(1);
    expect(mockToastWarning).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    view.unmount();
    expect(noticeStop).toBe(1);
  });

  test("the notice names the machine, both accounts, the coordinator and the reason", () => {
    expect(describeCoordinatorAccountSwitch(record)).toBe(
      "The orkestrator-v2 coordinator switched the active Claude account on beelink from “Host login” to “Work (work@example.com)”: “Workers are about to hit the 5-hour limit”",
    );
  });
});
