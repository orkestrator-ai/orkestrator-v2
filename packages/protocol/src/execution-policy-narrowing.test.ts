import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "./native-agent.js";

import {
  assertExecutionPolicyNotWidened,
  executionPolicyWidenings,
  policyWideningRefusal,
  PolicyWideningRefusedError,
} from "./execution-policy-narrowing.js";

const ask: NativeAgentExecutionPolicy = {
  id: "interactive-container",
  sandbox: "provider",
  approvals: "ask",
  projectResources: false,
  networkAccess: "restricted",
  containerNetworkAccess: "restricted",
  toolPolicy: { allow: ["Read", "Grep"], deny: ["WebFetch"] },
  capabilityPolicy: {
    deny: ["network", "subagents"],
    allow: ["web.search"],
    userMcpServers: ["docs", "issues"],
  },
};

function variant(
  patch: Partial<NativeAgentExecutionPolicy>,
  base: NativeAgentExecutionPolicy = ask,
): NativeAgentExecutionPolicy {
  return { ...structuredClone(base), ...patch };
}

describe("executionPolicyWidenings", () => {
  test("an identical policy is not a widening", () => {
    expect(executionPolicyWidenings(ask, structuredClone(ask))).toEqual([]);
  });

  test("any policy narrows a session that has none (host default)", () => {
    expect(executionPolicyWidenings(undefined, ask)).toEqual([]);
  });

  test.each([
    ["approvals", variant({ approvals: "auto-approve" })],
    ["sandbox", variant({ sandbox: "none" })],
    ["sandbox", variant({ sandbox: "container" })],
    ["projectResources", variant({ projectResources: true })],
    ["networkAccess", variant({ networkAccess: "full" })],
    ["containerNetworkAccess", variant({ containerNetworkAccess: "full" })],
    ["containerNetworkAccess", variant({ containerNetworkAccess: undefined })],
    ["id", variant({ id: "interactive-host" })],
    ["toolPolicy.allow", variant({ toolPolicy: { allow: ["Read", "Grep", "Bash"] } })],
    ["toolPolicy.allow", variant({ toolPolicy: { deny: ["WebFetch"] } })],
    ["toolPolicy.deny", variant({ toolPolicy: { allow: ["Read"], deny: [] } })],
    [
      "capabilityPolicy.deny",
      variant({ capabilityPolicy: { deny: ["network"], allow: [], userMcpServers: [] } }),
    ],
    [
      "capabilityPolicy.allow",
      variant({
        capabilityPolicy: {
          deny: ["network", "subagents"],
          allow: ["web.search", "shell"],
          userMcpServers: [],
        },
      }),
    ],
    [
      "capabilityPolicy.userMcpServers",
      variant({
        capabilityPolicy: { deny: ["network", "subagents"], allow: ["web.search"] },
      }),
    ],
    [
      "capabilityPolicy.userMcpServers",
      variant({
        capabilityPolicy: {
          deny: ["network", "subagents"],
          allow: ["web.search"],
          userMcpServers: ["docs", "issues", "shell"],
        },
      }),
    ],
  ] as const)("refuses widening %s", (axis, next) => {
    expect(executionPolicyWidenings(ask, next)).toContain(axis);
  });

  test("the self-approval attack from the report is refused on every axis it widens", () => {
    const open = variant({
      approvals: "auto-approve",
      sandbox: "none",
      networkAccess: "full",
      projectResources: true,
    });
    expect(executionPolicyWidenings(ask, open)).toEqual(
      expect.arrayContaining(["approvals", "sandbox", "networkAccess", "projectResources"]),
    );
  });

  test("a denial only listed in extendedDeny still counts as held", () => {
    const current = variant({
      capabilityPolicy: { deny: [], extendedDeny: ["future:capability"] },
    });
    expect(
      executionPolicyWidenings(current, variant({ capabilityPolicy: { deny: [] } })),
    ).toContain("capabilityPolicy.deny");
    expect(
      executionPolicyWidenings(
        current,
        variant({ capabilityPolicy: { deny: [], extendedDeny: ["future:capability"] } }),
      ),
    ).not.toContain("capabilityPolicy.deny");
  });

  test("accepts a change that narrows every axis", () => {
    const auto = variant({
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "full",
      containerNetworkAccess: "full",
      toolPolicy: undefined,
      capabilityPolicy: undefined,
    });
    const strict = variant({
      sandbox: "provider",
      approvals: "deny",
      projectResources: false,
      networkAccess: "restricted",
      containerNetworkAccess: "restricted",
      toolPolicy: { allow: [], deny: ["Bash"] },
      capabilityPolicy: { deny: ["network"], userMcpServers: [] },
    });
    expect(executionPolicyWidenings(auto, strict)).toEqual([]);
    expect(executionPolicyWidenings(auto, variant({ approvals: "ask" }, auto))).toEqual([]);
    expect(executionPolicyWidenings(ask, variant({ approvals: "deny" }))).toEqual([]);
    expect(
      executionPolicyWidenings(
        ask,
        variant({
          toolPolicy: { allow: ["Read"], deny: ["WebFetch", "Bash"] },
          capabilityPolicy: {
            deny: ["network", "subagents", "shell"],
            allow: [],
            userMcpServers: ["docs"],
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe("assertExecutionPolicyNotWidened", () => {
  test("passes a same or narrower policy, and any policy on a session with none", () => {
    expect(() => assertExecutionPolicyNotWidened(ask, structuredClone(ask))).not.toThrow();
    expect(() =>
      assertExecutionPolicyNotWidened(ask, variant({ approvals: "deny" })),
    ).not.toThrow();
    expect(() => assertExecutionPolicyNotWidened(undefined, ask)).not.toThrow();
  });

  test("throws the refusal naming the widened axes", () => {
    let thrown: unknown;
    try {
      assertExecutionPolicyNotWidened(ask, variant({ approvals: "auto-approve", sandbox: "none" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PolicyWideningRefusedError);
    expect((thrown as PolicyWideningRefusedError).refusal()).toEqual(
      policyWideningRefusal(["approvals", "sandbox"]),
    );
    expect(policyWideningRefusal(["sandbox"])).toMatchObject({
      code: "policy-widening-refused",
      widened: ["sandbox"],
    });
  });
});
