/**
 * The `accounts` domain client over a `lib/backend` factory client (plan
 * item 7008), against fake nodes: the client's own node takes version 1 when
 * it advertises the domain (envelope, critical keys, decoded results) and
 * version 0 otherwise (today's call, with the arguments object
 * `machineInvoke` always sent); another machine is always version 0.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";
import type { BackendClient } from "@/lib/backend/client";
import { invoke } from "@/lib/native/backend";
import { createSignal } from "@/lib/node-scope/signal";
import { accountsOn } from "./accounts";

const progress = { state: "pending", operationId: "op-1", platform: "claude", newer: true };

function fakeClient(answer: unknown, domains?: NegotiatedDomains | null) {
  const invokeRaw = mock(async (_command: string, _args?: unknown, _options?: unknown) => answer);
  const client: BackendClient = {
    invokeRaw: invokeRaw as unknown as BackendClient["invokeRaw"],
    ...(domains === undefined
      ? {}
      : {
          domains: createSignal<NegotiatedDomains | null>(domains),
          capabilities: createSignal<ReadonlySet<string> | null>(null),
        }),
  };
  return { client, invokeRaw };
}

/** The window's command node: its own transport, which suites mock. */
const portal = invoke as unknown as ReturnType<typeof mock>;
beforeEach(() => {
  portal.mockReset();
  portal.mockImplementation(async () => ({ outcome: "ok", result: progress }));
});
afterEach(() => {
  portal.mockReset();
  portal.mockResolvedValue(undefined);
});

describe("accounts domain client", () => {
  test("a node with the domain gets the envelope, its critical keys and a decoded result", async () => {
    const { client, invokeRaw } = fakeClient(progress, { accounts: { min: 1, max: 1 } });
    const login = await accountsOn(client)().start_agent_account_login({
      platform: "claude",
      reauthenticate: true,
    });
    expect(login).toEqual(progress as never);
    expect(invokeRaw.mock.calls).toEqual([
      [
        "start_agent_account_login",
        { platform: "claude", reauthenticate: true },
        { envelope: { domain: "accounts", version: 1, critical: ["reauthenticate"] } },
      ],
    ] as never);
  });

  test("version 1 refuses a result that does not match its schema", async () => {
    const { client } = fakeClient({ state: 7 }, { accounts: { min: 1, max: 1 } });
    await expect(accountsOn(client)().get_agent_account_login({})).rejects.toThrow();
  });

  test("a pre-contract node, or a client without negotiation, gets today's call", async () => {
    for (const domains of [null, undefined]) {
      const { client, invokeRaw } = fakeClient({ older: "shape" }, domains);
      expect(await accountsOn(client)().list_agent_accounts({})).toEqual({
        older: "shape",
      } as never);
      expect(invokeRaw.mock.calls).toEqual([["list_agent_accounts", {}]] as never);
    }
  });

  test("another machine goes through the command node, version 0, whatever this node speaks", async () => {
    const { client, invokeRaw } = fakeClient(progress, { accounts: { min: 1, max: 1 } });
    await accountsOn(client)("leaf").get_agent_account_login({});
    await accountsOn(client)(null).cancel_agent_account_login({ operationId: "op-1" });
    expect(invokeRaw).not.toHaveBeenCalled();
    expect(portal.mock.calls.map(([command, args]) => [command, args])).toEqual([
      [
        "invoke_on_node",
        expect.objectContaining({ nodeId: "leaf", command: "get_agent_account_login", args: {} }),
      ],
      ["cancel_agent_account_login", { operationId: "op-1" }],
    ]);
  });
});
