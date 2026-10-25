import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AgentAccountsSnapshot,
  AgentAccountSummary,
  MachineAgentAccounts,
  MachineAgentAccountsResult,
  PreferredAgentIdentities,
} from "@orkestrator/protocol/agent-accounts";
import * as realNodeEvents from "@/lib/federation/node-events";
import type { NodeEventSubscriber } from "@/lib/federation/node-events";
import { expectDomAbsent } from "../../../../../../tests/bounded-test-diagnostics";

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let machines: MachineAgentAccounts[];
/** What each machine answers when it is read again after an event. */
let rereads: Record<string, AgentAccountsSnapshot>;
/** The command node's preferred logins, as the overview reads them. */
let preferred: PreferredAgentIdentities | undefined;
let overview: (() => Promise<MachineAgentAccountsResult>) | undefined;
let intercept:
  | ((
      nodeId: string,
      command: string,
      args: Record<string, unknown>,
    ) => Promise<unknown> | undefined)
  | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function request(nodeId: string, command: string, args: Record<string, unknown>) {
  return intercept?.(nodeId, command, args) ?? answer(nodeId, command, args);
}

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
  if (command === "set_preferred_agent_identity") {
    const inner = args as { platform: "claude" | "codex"; email: string | null };
    const next = { ...preferred };
    if (inner.email) next[inner.platform] = inner.email;
    else delete next[inner.platform];
    preferred = next;
    return next;
  }
  if (command === "read_host_agent_sign_ins") return machine.signIns ?? {};
  if (command === "open_agent_sign_in_terminal") {
    return { environmentId: "env-leaf", projectId: "project-leaf", tabId: "tab-1" };
  }
  return undefined;
}

mock.module("@/lib/native/backend", () => ({
  invoke: mock(async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "list_machine_agent_accounts") {
      return overview ? overview() : { machines, ...(preferred ? { preferred } : {}) };
    }
    if (command === "invoke_on_node") {
      return {
        outcome: "ok",
        result: await request(
          String(args.nodeId),
          String(args.command),
          args.args as Record<string, unknown>,
        ),
      };
    }
    return request("node-self", command, args);
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

const { MachineAgentAccountsSection, groupAccountsByIdentity, preferredStatus } =
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
  preferred = undefined;
  overview = undefined;
  intercept = undefined;
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

test("live sign-in rereads strip secrets and clamp sources before display", async () => {
  render(<MachineAgentAccountsSection />);
  await waitFor(() => expect(subscribers.has("node-leaf")).toBe(true));
  machines[1] = {
    ...machines[1]!,
    signIns: { grok: { state: "signed-in", source: "s".repeat(300), token: "secret" } } as never,
  };
  await act(async () =>
    subscribers.get("node-leaf")!.onEvent("agent-accounts-changed", { platform: "claude" }),
  );
  await screen.findByText((text) => text.includes("s".repeat(120)));
  expect(screen.queryByText("s".repeat(300)) === null).toBe(true);
  expect(document.body.textContent).not.toContain("secret");
});

test("a malformed live account snapshot shows an error in By account", async () => {
  render(<MachineAgentAccountsSection />);
  await waitFor(() => expect(subscribers.has("node-leaf")).toBe(true));
  rereads["node-leaf"] = {
    ...SNAPSHOT,
    accounts: [{ id: "default", platform: "claude", label: "Bad" } as never],
  };
  await act(async () =>
    subscribers.get("node-leaf")!.onEvent("agent-accounts-changed", { platform: "claude" }),
  );
  await screen.findAllByText("Could not read accounts");
  fireEvent.click(screen.getByRole("button", { name: "By account" }));
  expect(document.body.textContent).toContain("MBP3");
});

describe("preferred login", () => {
  test("says where each machine stands against the preferred email", () => {
    const [studio, leaf, off] = machines;
    expect(preferredStatus(studio!, "claude", undefined)).toBeUndefined();
    expect(preferredStatus(off!, "claude", "work@example.com")).toBeUndefined();
    expect(preferredStatus(leaf!, "claude", "WORK@example.com")).toEqual({
      kind: "available",
      accountId: WORK,
    });
    expect(preferredStatus(leaf!, "codex", "work@example.com")).toEqual({ kind: "missing" });
    const onWork = {
      ...leaf!,
      snapshot: { ...SNAPSHOT, active: { ...SNAPSHOT.active, claude: WORK } },
    };
    expect(preferredStatus(onWork, "claude", "work@example.com")).toEqual({ kind: "active" });
    // The preferred group sorts first.
    expect(groupAccountsByIdentity(machines, "claude", "work@example.com")[0]?.label).toBe(
      "work@example.com",
    );
  });

  test("is chosen under By account and kept by the machine answering", async () => {
    await act(async () => {
      render(<MachineAgentAccountsSection />);
    });
    await screen.findAllByTestId("machine-agent-accounts-row");
    fireEvent.click(screen.getByRole("button", { name: "By account" }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Prefer work@example.com for Claude Code on every machine",
        }),
      );
    });
    expect(calls).toContainEqual({
      command: "set_preferred_agent_identity",
      args: { platform: "claude", email: "work@example.com" },
    });
    // Choosing it switches nothing.
    expect(
      calls.some(
        (call) =>
          call.command === "set_active_agent_account" ||
          call.args.command === "set_active_agent_account",
      ),
    ).toBe(false);
    expect((await screen.findByTestId("machine-agent-preferred")).textContent).toContain(
      "0 of 2 machines on it",
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Stop preferring work@example.com for Claude Code" }),
      );
    });
    expect(calls).toContainEqual({
      command: "set_preferred_agent_identity",
      args: { platform: "claude", email: null },
    });
    await waitFor(() =>
      expectDomAbsent(screen.queryByTestId("machine-agent-preferred"), "preferred summary"),
    );
  });

  test("flags machines off it and switches the ones that have it", async () => {
    preferred = { claude: "work@example.com" };
    machines[1] = {
      ...machines[1]!,
      snapshot: { ...SNAPSHOT, accounts: SNAPSHOT.accounts.filter((a) => a.id !== WORK) },
    };
    machines.push({
      nodeId: "node-mini",
      name: "Mini",
      self: false,
      state: "ok",
      snapshot: SNAPSHOT,
    });
    await act(async () => {
      render(<MachineAgentAccountsSection />);
    });
    await screen.findAllByTestId("machine-agent-accounts-row");
    const summary = screen.getByTestId("machine-agent-preferred");
    expect(summary.textContent).toContain("work@example.com");
    expect(summary.textContent).toContain("0 of 3 machines on it · 1 without it");
    expect(screen.getAllByText("No preferred login")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Use preferred" })).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use on 2 more machines" }));
    });
    const switched = calls.flatMap((call) =>
      call.command === "set_active_agent_account"
        ? [`node-self:${String(call.args.accountId)}`]
        : call.args.command === "set_active_agent_account"
          ? [
              `${String(call.args.nodeId)}:${String((call.args.args as { accountId: string }).accountId)}`,
            ]
          : [],
    );
    expect(switched.sort()).toEqual([`node-mini:${WORK}`, `node-self:${WORK}`]);
    await waitFor(() =>
      expect(screen.getByTestId("machine-agent-preferred").textContent).toContain(
        "2 of 3 machines on it",
      ),
    );
    expectDomAbsent(screen.queryByRole("button", { name: "Use preferred" }), "Use preferred");
  });

  test("a machine's own dialog does not flag it", async () => {
    preferred = { claude: "work@example.com" };
    await act(async () => {
      render(<MachineAgentAccountsSection nodeId="node-leaf" />);
    });
    await screen.findAllByTestId("machine-agent-accounts-row");
    expectDomAbsent(screen.queryByTestId("machine-agent-preferred"), "preferred summary");
    expectDomAbsent(screen.queryByRole("button", { name: "Use preferred" }), "Use preferred");
  });
});

test("signed-in duplicates are preferred and signed-out matches cannot be bulk switched", async () => {
  preferred = { claude: "work@example.com" };
  const signedOut = { ...SNAPSHOT.accounts[1]!, signedIn: false };
  const signedIn = { ...signedOut, id: "signed-in-copy", signedIn: true };
  machines[0] = {
    ...machines[0]!,
    snapshot: { ...SNAPSHOT, accounts: [SNAPSHOT.accounts[0]!, signedOut, signedIn] },
  };
  machines[1] = {
    ...machines[1]!,
    snapshot: { ...SNAPSHOT, accounts: [SNAPSHOT.accounts[0]!, signedOut] },
  };
  expect(preferredStatus(machines[0]!, "claude", preferred.claude)).toEqual({
    kind: "available",
    accountId: "signed-in-copy",
  });
  expect(preferredStatus(machines[1]!, "claude", preferred.claude)).toEqual({ kind: "signed-out" });
  expect(
    preferredStatus(
      {
        ...machines[1]!,
        snapshot: { ...machines[1]!.snapshot!, active: { ...SNAPSHOT.active, claude: WORK } },
      },
      "claude",
      preferred.claude,
    ),
  ).toEqual({ kind: "signed-out" });
  render(<MachineAgentAccountsSection />);
  expect((await screen.findByTestId("machine-agent-preferred")).textContent).toContain(
    "1 signed out",
  );
  expect(screen.getByText("Preferred login signed out")).toBeTruthy();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Use on 1 more machine" })),
  );
  const writes = calls.filter(
    (call) =>
      call.command === "set_active_agent_account" ||
      call.args.command === "set_active_agent_account",
  );
  expect(writes).toEqual([
    {
      command: "set_active_agent_account",
      args: { platform: "claude", accountId: "signed-in-copy" },
    },
  ]);
});

for (const onlyOne of [false, true]) {
  test(`clears an absent preferred account from the summary with one machine: ${onlyOne}`, async () => {
    preferred = { claude: "gone@example.com" };
    if (onlyOne) machines = [machines[0]!];
    render(<MachineAgentAccountsSection />);
    await screen.findByTestId("machine-agent-preferred");
    if (onlyOne)
      expectDomAbsent(screen.queryByRole("button", { name: "By account" }), "By account");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Clear preferred Claude Code login" })),
    );
    expect(calls).toContainEqual({
      command: "set_preferred_agent_identity",
      args: { platform: "claude", email: null },
    });
    await waitFor(() =>
      expectDomAbsent(screen.queryByTestId("machine-agent-preferred"), "preferred summary"),
    );
  });
}

test("an overview started before a preference write cannot restore the old bulk-switch target", async () => {
  preferred = { claude: "old@example.com" };
  render(<MachineAgentAccountsSection />);
  await screen.findByTestId("machine-agent-preferred");
  const refresh = deferred<MachineAgentAccountsResult>();
  overview = () => refresh.promise;
  fireEvent.click(screen.getByRole("button", { name: "Refresh agent accounts" }));
  fireEvent.click(screen.getByRole("button", { name: "By account" }));
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", {
        name: "Prefer work@example.com for Claude Code on every machine",
      }),
    ),
  );
  await act(async () => refresh.resolve({ machines, preferred: { claude: "old@example.com" } }));
  expect(screen.getByTestId("machine-agent-preferred").textContent).toContain("work@example.com");
  expect(screen.getByTestId("machine-agent-preferred").textContent).not.toContain(
    "old@example.com",
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Use on 2 more machines" })),
  );
  const writes = calls.filter(
    (call) =>
      call.command === "set_active_agent_account" ||
      call.args.command === "set_active_agent_account",
  );
  expect(writes).toHaveLength(2);
  for (const write of writes)
    expect(
      write.command === "set_active_agent_account"
        ? write.args.accountId
        : (write.args.args as { accountId: string }).accountId,
    ).toBe(WORK);
});

for (const claudeFirst of [false, true]) {
  test(`overlapping preference writes merge per platform and retain busy state, Claude settles first: ${claudeFirst}`, async () => {
    const claude = deferred<PreferredAgentIdentities>();
    const codex = deferred<PreferredAgentIdentities>();
    intercept = (_node, command, args) =>
      command === "set_preferred_agent_identity"
        ? args.platform === "claude"
          ? claude.promise
          : codex.promise
        : undefined;
    machines[0] = {
      ...machines[0]!,
      snapshot: {
        ...SNAPSHOT,
        accounts: [
          ...SNAPSHOT.accounts,
          account({ platform: "codex", id: WORK, identity: { email: "code@example.com" } }),
        ],
      },
    };
    render(<MachineAgentAccountsSection />);
    await screen.findAllByTestId("machine-agent-accounts-row");
    fireEvent.click(screen.getByRole("button", { name: "By account" }));
    const claudeButton = screen.getByRole("button", {
      name: "Prefer work@example.com for Claude Code on every machine",
    });
    const codexButton = screen.getByRole("button", {
      name: "Prefer code@example.com for Codex on every machine",
    });
    fireEvent.click(claudeButton);
    fireEvent.click(codexButton);
    expect(claudeButton.hasAttribute("disabled")).toBe(true);
    expect(codexButton.hasAttribute("disabled")).toBe(true);
    // A list begun during a write may have read storage before either write.
    const refresh = deferred<MachineAgentAccountsResult>();
    overview = () => refresh.promise;
    fireEvent.click(screen.getByRole("button", { name: "Refresh agent accounts" }));
    await act(async () => {
      if (claudeFirst) claude.resolve({ claude: "work@example.com" });
      else codex.resolve({ codex: "code@example.com" });
    });
    expect((claudeFirst ? codexButton : claudeButton).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      if (claudeFirst) codex.resolve({ codex: "code@example.com" });
      else claude.resolve({ claude: "work@example.com" });
    });
    await act(async () => refresh.resolve({ machines, preferred: {} }));
    const summary = screen.getByTestId("machine-agent-preferred");
    expect(summary.textContent).toContain("work@example.com");
    expect(summary.textContent).toContain("code@example.com");
    expect(
      screen
        .getByRole("button", { name: "Clear preferred Claude Code login" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "Clear preferred Codex login" }).hasAttribute("disabled"),
    ).toBe(false);
  });
}

test("an independent account choice cannot clear an in-flight preference's busy state", async () => {
  preferred = { claude: "work@example.com" };
  machines[0] = {
    ...machines[0]!,
    snapshot: {
      ...SNAPSHOT,
      accounts: [...SNAPSHOT.accounts, account({ platform: "codex", id: WORK, label: "Code" })],
    },
  };
  const write = deferred<PreferredAgentIdentities>();
  intercept = (_node, command) =>
    command === "set_preferred_agent_identity" ? write.promise : undefined;
  render(<MachineAgentAccountsSection />);
  await screen.findByTestId("machine-agent-preferred");
  const clear = screen.getByRole("button", { name: "Clear preferred Claude Code login" });
  fireEvent.click(clear);
  const cell = screen.getByRole("combobox", { name: "Codex account on Studio" });
  fireEvent.keyDown(cell, { key: "Enter" });
  await act(async () => fireEvent.click(screen.getByRole("option", { name: "Code" })));
  expect(calls).toContainEqual({
    command: "set_active_agent_account",
    args: { platform: "codex", accountId: WORK },
  });
  expect(clear.hasAttribute("disabled")).toBe(true);
  await act(async () => write.resolve({}));
  await waitFor(() =>
    expectDomAbsent(screen.queryByTestId("machine-agent-preferred"), "preferred summary"),
  );
});

test("bulk switching joins partial failures, rereads failed machines and recovers pending controls", async () => {
  preferred = { claude: "work@example.com" };
  machines.push({
    nodeId: "node-mini",
    name: "Mini",
    self: false,
    state: "ok",
    snapshot: SNAPSHOT,
  });
  const failed = deferred<unknown>();
  const malformed = deferred<unknown>();
  const fallback = deferred<unknown>();
  intercept = (node, command) => {
    if (command === "set_active_agent_account") {
      if (node === "node-leaf") return failed.promise;
      if (node === "node-mini") return malformed.promise;
    }
    if (command === "list_agent_accounts" && node !== "node-self") return fallback.promise;
    return undefined;
  };
  render(<MachineAgentAccountsSection />);
  await screen.findByTestId("machine-agent-preferred");
  const bulk = screen.getByRole("button", { name: "Use on 3 more machines" });
  fireEvent.click(bulk);
  await act(async () => failed.reject(new Error("offline")));
  expect(bulk.hasAttribute("disabled")).toBe(true);
  await act(async () => malformed.resolve({ accounts: "invalid" }));
  expect(await screen.findByText("MBP3: offline; Mini: Invalid account snapshot")).toBeTruthy();
  const recovered = screen.getByRole("button", { name: "Use on 2 more machines" });
  expect(recovered.hasAttribute("disabled")).toBe(false);
  expect(
    calls
      .filter((call) => call.args.command === "list_agent_accounts")
      .map((call) => call.args.nodeId)
      .sort(),
  ).toEqual(["node-leaf", "node-mini"]);
  expect(screen.getByTestId("machine-agent-preferred").textContent).toContain(
    "1 of 3 machines on it",
  );
  await act(async () =>
    fallback.resolve({ ...SNAPSHOT, active: { ...SNAPSHOT.active, claude: WORK } }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("machine-agent-preferred").textContent).toContain(
      "3 of 3 machines on it",
    ),
  );
  expectDomAbsent(screen.queryByRole("button", { name: /Use on/ }), "bulk preferred switch");
});
