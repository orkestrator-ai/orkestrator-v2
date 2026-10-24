import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AgentAccountsSnapshot,
  AgentAccountSummary,
  MachineAgentAccounts,
} from "@orkestrator/protocol/agent-accounts";

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let machines: MachineAgentAccounts[];

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "list_machine_agent_accounts") return Promise.resolve({ machines });
    if (command === "invoke_on_node" && args.command === "set_active_agent_account") {
      const inner = args.args as { platform: "claude"; accountId: string };
      const leaf = machines.find((machine) => machine.nodeId === args.nodeId)!;
      const snapshot: AgentAccountsSnapshot = {
        ...leaf.snapshot!,
        active: { ...leaf.snapshot!.active, [inner.platform]: inner.accountId },
      };
      return Promise.resolve({ outcome: "ok", result: snapshot });
    }
    return Promise.resolve(undefined);
  }),
}));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
});

const { MachineAgentAccountsSection } = await import("./MachineAgentAccountsSection");

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
});
