import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AgentAccountsSnapshot,
  AgentAccountSummary,
  MachineAgentAccounts,
} from "@orkestrator/protocol/agent-accounts";
import * as realNodeEvents from "@/lib/federation/node-events";
import type { NodeEventSubscriber } from "@/lib/federation/node-events";

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let machines: MachineAgentAccounts[];
/** What each machine answers when it is read again after an event. */
let rereads: Record<string, AgentAccountsSnapshot>;

/** A command as one machine answers it, the command node being `node-self`. */
function answer(nodeId: string, command: string, args: Record<string, unknown>): unknown {
  const machine = machines.find((entry) => entry.nodeId === nodeId)!;
  if (command === "set_active_agent_account") {
    const inner = args as { platform: "claude"; accountId: string };
    return {
      ...machine.snapshot!,
      active: { ...machine.snapshot!.active, [inner.platform]: inner.accountId },
    } satisfies AgentAccountsSnapshot;
  }
  if (command === "list_agent_accounts") return rereads[nodeId] ?? machine.snapshot;
  if (command === "read_host_agent_sign_ins") return machine.signIns ?? {};
  if (command === "open_agent_sign_in_terminal") {
    return { environmentId: "env-leaf", projectId: "project-leaf", tabId: "tab-1" };
  }
  return undefined;
}

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "list_machine_agent_accounts") return Promise.resolve({ machines });
    if (command === "invoke_on_node") {
      return Promise.resolve({
        outcome: "ok",
        result: answer(
          String(args.nodeId),
          String(args.command),
          args.args as Record<string, unknown>,
        ),
      });
    }
    return Promise.resolve(answer("node-self", command, args));
  }),
}));

// The relay is stubbed so a test can deliver one machine's event by hand.
const realNodeEventsSnapshot = { ...realNodeEvents };
const subscribers = new Map<string, NodeEventSubscriber>();
mock.module("@/lib/federation/node-events", () => ({
  ...realNodeEventsSnapshot,
  subscribeNodeEvents: (nodeId: string, subscriber: NodeEventSubscriber) => {
    subscribers.set(nodeId, subscriber);
    return () => subscribers.delete(nodeId);
  },
  subscribeCommandNodeEvents: (subscriber: NodeEventSubscriber) => {
    subscribers.set("command-node", subscriber);
    return () => subscribers.delete("command-node");
  },
}));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
  mock.module("@/lib/federation/node-events", () => realNodeEventsSnapshot);
});

const { MachineAgentAccountsSection, groupAccountsByIdentity } =
  await import("./MachineAgentAccountsSection");
const { useRemoteWorkspaceStore } = await import("@/stores/remoteWorkspaceStore");

const WORK = "11111111-2222-4333-8444-555555555555";

function account(overrides: Partial<AgentAccountSummary>): AgentAccountSummary {
  return {
    id: "default",
    platform: "claude",
    label: "Host login",
    isDefault: true,
    isActive: true,
    signedIn: true,
    identity: {},
    ...overrides,
  };
}

const SNAPSHOT: AgentAccountsSnapshot = {
  active: { claude: "default", codex: "default" },
  accounts: [
    account({}),
    account({
      id: WORK,
      label: "Work",
      isDefault: false,
      isActive: false,
      identity: { email: "work@example.com" },
    }),
    account({ platform: "codex" }),
  ],
};

beforeEach(() => {
  calls.length = 0;
  rereads = {};
  subscribers.clear();
  machines = [
    { nodeId: "node-self", name: "Studio", self: true, state: "ok", snapshot: SNAPSHOT },
    { nodeId: "node-leaf", name: "MBP3", self: false, state: "ok", snapshot: SNAPSHOT },
    { nodeId: "node-off", name: "VPS", self: false, state: "unavailable" },
  ];
});

afterEach(() => {
  cleanup();
});

describe("MachineAgentAccountsSection", () => {
  test("lists every machine and sends a choice to that machine only", async () => {
    await act(async () => {
      render(<MachineAgentAccountsSection />);
    });
    expect(await screen.findAllByTestId("machine-agent-accounts-row")).toHaveLength(3);
    expect(screen.getAllByText("Not connected")).toHaveLength(2);

    const cell = screen.getByRole("combobox", { name: "Claude Code account on MBP3" });
    fireEvent.keyDown(cell, { key: "Enter" });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Work \(work@example\.com\)/ }));
    });
    expect(calls).toContainEqual({
      command: "invoke_on_node",
      args: {
        nodeId: "node-leaf",
        command: "set_active_agent_account",
        args: { platform: "claude", accountId: WORK },
        requestKey: expect.any(String),
      },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Claude Code account on MBP3" }).textContent,
      ).toContain("Work"),
    );
    // The command node's own row is unchanged.
    expect(
      screen.getByRole("combobox", { name: "Claude Code account on Studio" }).textContent,
    ).toContain("Host login");
  });

  test("a machine's own dialog shows only that machine", async () => {
    await act(async () => {
      render(<MachineAgentAccountsSection nodeId="node-leaf" />);
    });
    const rows = await screen.findAllByTestId("machine-agent-accounts-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("MBP3");
  });

  test("re-reads only the machine whose accounts changed", async () => {
    await act(async () => {
      render(<MachineAgentAccountsSection />);
    });
    await screen.findAllByTestId("machine-agent-accounts-row");
    await waitFor(() => expect(subscribers.has("node-leaf")).toBe(true));
    // The command node's own events never go through its relay.
    expect([...subscribers.keys()].sort()).toEqual(["command-node", "node-leaf", "node-off"]);
    rereads["node-leaf"] = { ...SNAPSHOT, active: { ...SNAPSHOT.active, claude: WORK } };
    calls.length = 0;
    await act(async () => {
      subscribers.get("node-leaf")!.onEvent("agent-accounts-changed", { platform: "claude" });
    });
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Claude Code account on MBP3" }).textContent,
      ).toContain("Work"),
    );
    const read = calls.filter((call) => call.args.command === "list_agent_accounts");
    expect(read.map((call) => call.args.nodeId)).toEqual(["node-leaf"]);
    expect(calls.some((call) => call.command === "list_machine_agent_accounts")).toBe(false);
  });

  test("groups by account across machines and offers a sign-in where one is missing", async () => {
    machines[1] = {
      ...machines[1]!,
      snapshot: { ...SNAPSHOT, accounts: SNAPSHOT.accounts.filter((a) => a.id !== WORK) },
    };
    const groups = groupAccountsByIdentity(machines, "claude");
    const work = groups.find((group) => group.label === "work@example.com")!;
    expect([...work.on.keys()]).toEqual(["node-self"]);

    await act(async () => {
      render(<MachineAgentAccountsSection />);
    });
    await screen.findAllByTestId("machine-agent-accounts-row");
    fireEvent.click(screen.getByRole("button", { name: "By account" }));
    const identities = screen.getAllByTestId("machine-agent-identity");
    const row = identities.find((entry) => entry.textContent?.includes("work@example.com"))!;
    expect(row.textContent).toContain("Studio");
    expect(row.textContent).toContain("MBP3: sign in");
    expect(row.textContent).toContain("VPS: not connected");
  });

  test("shows Grok and Pi read-only and opens a sign-in terminal on that machine", async () => {
    machines[0] = {
      ...machines[0]!,
      signIns: { grok: { state: "signed-in", source: "XAI_API_KEY" } },
    };
    machines[1] = { ...machines[1]!, signIns: { grok: { state: "signed-out" } } };
    await act(async () => {
      render(<MachineAgentAccountsSection />);
    });
    await screen.findAllByTestId("machine-agent-accounts-row");
    expect(screen.getByText("XAI_API_KEY", { exact: false })).toBeTruthy();
    // Pi is reported by no machine, so it has no column.
    expect(screen.queryByRole("columnheader", { name: "Pi" }) === null).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in to Grok Build on MBP3" }));
    });
    await waitFor(() =>
      expect(calls).toContainEqual({
        command: "invoke_on_node",
        args: {
          nodeId: "node-leaf",
          command: "open_agent_sign_in_terminal",
          args: { platform: "grok" },
          requestKey: expect.any(String),
        },
      }),
    );
    await waitFor(() =>
      expect(useRemoteWorkspaceStore.getState().active).toEqual({
        nodeId: "node-leaf",
        projectId: "project-leaf",
        environmentId: "env-leaf",
      }),
    );
  });
});
