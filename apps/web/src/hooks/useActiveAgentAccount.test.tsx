import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import type {
  AgentAccountPlatform,
  AgentAccountsSnapshot,
  AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import * as backend from "@/lib/backend";
import * as nativeEvents from "@/lib/native/events";
import { AccountMachineProvider } from "@/components/settings/account-machine";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { agentAccountDisplayName, useActiveAgentAccount } from "./useActiveAgentAccount";

function account(id: string, platform: AgentAccountPlatform = "claude"): AgentAccountSummary {
  return {
    id,
    platform,
    label: id,
    isDefault: false,
    isActive: true,
    signedIn: true,
    identity: {},
  };
}

const first = account("first");
const second = account("second");
function snapshot(active: AgentAccountSummary = first): AgentAccountsSnapshot {
  return {
    // The other platform deliberately has the same id.
    accounts: [account(active.id, "codex"), active, second],
    active: { claude: active.id, codex: active.id },
  };
}

const handlers = new Map<string, (event: { payload: unknown }) => void>();
let read: ReturnType<typeof spyOn<typeof backend, "listAgentAccounts">>;
let listen: ReturnType<typeof spyOn<typeof nativeEvents, "listen">>;

beforeEach(() => {
  handlers.clear();
  read = spyOn(backend, "listAgentAccounts").mockResolvedValue(snapshot());
  listen = spyOn(nativeEvents, "listen").mockImplementation(async (event, callback) => {
    handlers.set(event, callback as (event: { payload: unknown }) => void);
    return () => {
      handlers.delete(event);
    };
  });
});

afterEach(() => {
  cleanup();
  read.mockRestore();
  listen.mockRestore();
});

async function changed() {
  await act(async () => {
    handlers.get("agent-accounts-changed")?.({ payload: { platform: "claude" } });
  });
}

function deferred() {
  let resolve!: (value: AgentAccountsSnapshot) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AgentAccountsSnapshot>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("reads the active account for the requested platform and refreshes on account changes", async () => {
  const { result } = renderHookInAppCommandScope(() => useActiveAgentAccount("claude"));
  expect(result.current === null).toBe(true);
  await waitFor(() => expect(result.current).toEqual(first));
  expect(read).toHaveBeenCalledWith(undefined);
  read.mockResolvedValue(snapshot(second));
  await changed();
  await waitFor(() => expect(result.current).toEqual(second));
  expect(read).toHaveBeenCalledTimes(2);
});

test("uses the selected account machine", async () => {
  const { result } = renderHookInAppCommandScope(() => useActiveAgentAccount("claude"), {
    wrapper: ({ children }) => (
      <AccountMachineProvider value={{ machine: "remote-node", name: "Remote" }}>
        {children}
      </AccountMachineProvider>
    ),
  });
  await waitFor(() => expect(result.current).toEqual(first));
  expect(read).toHaveBeenCalledWith("remote-node");
});

test("clears a previously loaded account when a refresh fails and recovers on the next event", async () => {
  const { result } = renderHookInAppCommandScope(() => useActiveAgentAccount("claude"));
  await waitFor(() => expect(result.current).toEqual(first));
  read.mockRejectedValue(new Error("read unavailable"));
  await changed();
  await waitFor(() => expect(result.current === null).toBe(true));
  read.mockResolvedValue(snapshot(second));
  await changed();
  await waitFor(() => expect(result.current).toEqual(second));
});

test("an initial read failure leaves the account unnamed", async () => {
  read.mockRejectedValue(new Error("read unavailable"));
  const { result } = renderHookInAppCommandScope(() => useActiveAgentAccount("claude"));
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
  expect(result.current === null).toBe(true);
});

test("does not guess an account when the active id has no matching platform entry", async () => {
  read.mockResolvedValue({
    accounts: [account("missing", "codex"), first],
    active: { claude: "missing", codex: "missing" },
  });
  const { result } = renderHookInAppCommandScope(() => useActiveAgentAccount("claude"));
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
  expect(result.current === null).toBe(true);
});

test("disabled reads stay unnamed without subscribing, then load when enabled", async () => {
  const { result, rerender } = renderHookInAppCommandScope(
    ({ enabled }) => useActiveAgentAccount("claude", enabled),
    { initialProps: { enabled: false } },
  );
  await act(async () => {});
  expect(result.current === null).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(handlers.has("agent-accounts-changed")).toBe(false);
  rerender({ enabled: true });
  await waitFor(() => expect(result.current).toEqual(first));
  rerender({ enabled: false });
  await waitFor(() => expect(result.current === null).toBe(true));
});

test.each(["resolve", "reject"] as const)(
  "ignores an older overlapping read that later %ss",
  async (settle) => {
    const stale = deferred();
    read.mockReturnValueOnce(stale.promise);
    const { result } = renderHookInAppCommandScope(() => useActiveAgentAccount("claude"));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    read.mockResolvedValue(snapshot(second));
    await changed();
    await waitFor(() => expect(result.current).toEqual(second));
    await act(async () => {
      if (settle === "resolve") stale.resolve(snapshot());
      else stale.reject(new Error("stale read failed"));
    });
    expect(result.current).toEqual(second);
  },
);

test("disabling invalidates an in-flight read", async () => {
  const pending = deferred();
  read.mockReturnValue(pending.promise);
  const { result, rerender } = renderHookInAppCommandScope(
    ({ enabled }) => useActiveAgentAccount("claude", enabled),
    { initialProps: { enabled: true } },
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  rerender({ enabled: false });
  await act(async () => {
    pending.resolve(snapshot());
  });
  expect(result.current === null).toBe(true);
});

test.each([
  [" Work ", " user@example.test ", "Work (user@example.test)"],
  [" user@example.test ", " user@example.test ", "user@example.test"],
  [" Work ", undefined, "Work"],
  [" Work ", "  ", "Work"],
  ["  ", " user@example.test ", "user@example.test"],
  ["  ", undefined, ""],
  ["  ", "  ", ""],
])("formats label %j and email %j as %j", (label, email, expected) => {
  expect(agentAccountDisplayName({ ...first, label, identity: { email } })).toBe(expected);
});
