import { expect, test } from "bun:test";
import { executeAgentAccountSwitch } from "./node-account-switch.js";
import { describeNodeAction, type NodeActionTarget } from "./node-action-requests.js";
import { NodeOutcomeUnknownError } from "./node-link.js";

const target: NodeActionTarget = {
  nodeId: "bk_self",
  nodeName: "Studio",
  platform: "claude",
  accountId: "acct-work",
  accountLabel: "Work",
};

function deps(overrides: Partial<Parameters<typeof executeAgentAccountSwitch>[1]> = {}) {
  const calls: Array<{ via: string; command: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    deps: {
      selfId: () => "bk_self",
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ via: "local", command, args });
        return {};
      },
      invokeOnNode: async (input: {
        nodeId: string;
        command: string;
        args: Record<string, unknown>;
        requestKey: string;
      }) => {
        calls.push({ via: input.nodeId, command: input.command, args: input.args });
        return { outcome: "ok" as const, result: {} };
      },
      ...overrides,
    },
  };
}

test("an approved switch on this machine calls the Settings switch command", async () => {
  const { calls, deps: run } = deps();
  const outcome = await executeAgentAccountSwitch({ requestId: "r1", targets: [target] }, run);
  expect(calls).toEqual([
    {
      via: "local",
      command: "set_active_agent_account",
      args: { platform: "claude", accountId: "acct-work" },
    },
  ]);
  expect(outcome.code).toBe("switched");
  expect(outcome.message).toContain("is now “Work”");
  expect(outcome.message).toContain("Machine-wide");
});

test("another machine is switched through the node link", async () => {
  const { calls, deps: run } = deps();
  await executeAgentAccountSwitch(
    { requestId: "r2", targets: [{ ...target, nodeId: "bk_leaf", nodeName: "Leaf" }] },
    run,
  );
  expect(calls).toEqual([
    {
      via: "bk_leaf",
      command: "set_active_agent_account",
      args: { platform: "claude", accountId: "acct-work" },
    },
  ]);
});

test("a lost node answer is reported as an unknown outcome, never retried", async () => {
  for (const invokeOnNode of [
    async () => ({ outcome: "unknown" as const, requestKey: "k", outcomeId: "o" }),
    async () => {
      throw new NodeOutcomeUnknownError("lost");
    },
  ]) {
    const { deps: run } = deps({ invokeOnNode });
    const outcome = await executeAgentAccountSwitch(
      { requestId: "r3", targets: [{ ...target, nodeId: "bk_leaf", nodeName: "Leaf" }] },
      run,
    );
    expect(outcome).toMatchObject({ code: "outcome-unknown", outcomeUnknown: true });
  }
});

test("a malformed request is refused", async () => {
  const { calls, deps: run } = deps();
  await expect(
    executeAgentAccountSwitch({ requestId: "r4", targets: [{ ...target, platform: "grok" }] }, run),
  ).rejects.toThrow("one provider");
  await expect(
    executeAgentAccountSwitch({ requestId: "r5", targets: [target, target] }, run),
  ).rejects.toThrow("one machine");
  expect(calls).toHaveLength(0);
});

test("the user and the coordinator read one line naming the machine and the account", () => {
  expect(describeNodeAction({ kind: "switch-agent-account", targets: [target] })).toBe(
    "Switch the active Claude account on Studio to “Work”",
  );
});
