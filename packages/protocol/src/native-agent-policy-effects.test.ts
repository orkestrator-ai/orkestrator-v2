import { describe, expect, test } from "bun:test";
import {
  appendNativeAgentPolicyNote,
  describeNativeAgentExecutionPolicy,
  describeNativeAgentPolicyEffects,
  nativeAgentPolicyEffects,
  READ_ONLY_TURN_POLICY_NOTE,
  readOnlyCommandSandboxOffNote,
  readOnlyTurnReportedPolicy,
  withoutProviderSandbox,
  SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE,
  type NativeAgentExecutionPolicy,
} from "./native-agent.js";

const host: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};

describe("nativeAgentPolicyEffects", () => {
  test("distinguishes a hosted search exception from a complete network denial", () => {
    const denied: NativeAgentExecutionPolicy = {
      ...host,
      capabilityPolicy: { deny: ["network"] },
    };
    expect(nativeAgentPolicyEffects(denied).networkDenial).toBe("all");
    expect(
      nativeAgentPolicyEffects({
        ...denied,
        capabilityPolicy: { deny: ["network"], allow: ["web.search"] },
      }).networkDenial,
    ).toBe("except-hosted-search");
    expect(
      nativeAgentPolicyEffects({
        ...denied,
        capabilityPolicy: { deny: ["network", "web.search"], allow: ["web.search"] },
      }).networkDenial,
    ).toBe("all");
    expect(nativeAgentPolicyEffects(host)).not.toHaveProperty("networkDenial");
  });

  test("names what holds a network restriction", () => {
    expect(
      nativeAgentPolicyEffects({ ...host, sandbox: "provider", networkAccess: "restricted" }),
    ).toEqual({
      isolation: "provider-sandbox",
      approvals: "auto-approve",
      projectResources: false,
      network: "restricted",
      networkHeldBy: "provider-sandbox",
    });
    expect(
      nativeAgentPolicyEffects({ ...host, sandbox: "container", networkAccess: "restricted" })
        .networkHeldBy,
    ).toBe("container");
    expect(nativeAgentPolicyEffects({ ...host, networkAccess: "restricted" }).networkHeldBy).toBe(
      "toolset",
    );
    expect(nativeAgentPolicyEffects(host)).not.toHaveProperty("networkHeldBy");
  });

  test("the Agent Info summary is a function of the effects alone", () => {
    expect(describeNativeAgentExecutionPolicy(host)).toBe(
      "No sandbox, approvals off, project resources off, full network",
    );
    // A note, an id or a tool list changes no effect, so it changes no summary.
    expect(
      describeNativeAgentExecutionPolicy({
        ...host,
        id: "pipeline",
        note: "caveat",
        toolPolicy: { deny: ["shell"] },
      }),
    ).toBe(describeNativeAgentExecutionPolicy(host));
    expect(
      describeNativeAgentExecutionPolicy({
        id: "interactive-container",
        sandbox: "container",
        approvals: "ask",
        projectResources: true,
        networkAccess: "restricted",
      }),
    ).toBe("Container sandbox, approvals on request, project resources on, restricted network");
  });
});

describe("withoutProviderSandbox", () => {
  test("reports an unsandboxed session and the network it really has", () => {
    const applied = withoutProviderSandbox(
      { ...host, sandbox: "provider", networkAccess: "restricted", note: "Backend note." },
      { agent: "Pi", toolsetBlocksNetwork: false },
    );
    expect(applied).toMatchObject({ sandbox: "none", networkAccess: "full" });
    expect(applied.note).toBe(
      "Backend note. Pi has no sandbox of its own, so this session runs unsandboxed with full network access.",
    );
  });

  test.each([false, true])(
    "removes obsolete sandbox notes (toolset blocks: %s)",
    (toolsetBlocksNetwork) => {
      const applied = withoutProviderSandbox(
        {
          ...host,
          sandbox: "provider",
          networkAccess: "restricted",
          note: `Other caveat. ${SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE}`,
        },
        { agent: "Pi", toolsetBlocksNetwork },
      );
      expect(applied.note).not.toContain(SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE);
      expect(applied.note).toContain("Other caveat.");
    },
  );

  test.each(["full", "restricted"] as const)(
    "keeps an outer %s container firewall",
    (containerNetworkAccess) => {
      const applied = withoutProviderSandbox(
        { ...host, sandbox: "provider", networkAccess: "restricted", containerNetworkAccess },
        { agent: "Pi", toolsetBlocksNetwork: false },
      );
      expect(nativeAgentPolicyEffects(applied)).toMatchObject({
        isolation: "container",
        network: containerNetworkAccess,
      });
      expect(nativeAgentPolicyEffects(applied).networkHeldBy).toBe(
        containerNetworkAccess === "restricted" ? "container" : undefined,
      );
      expect(applied.note).not.toContain("runs unsandboxed");
    },
  );

  test("tool denials can narrow a full-network container after removing its provider sandbox", () => {
    const applied = withoutProviderSandbox(
      {
        ...host,
        sandbox: "provider",
        networkAccess: "restricted",
        containerNetworkAccess: "full",
        approvals: "deny",
      },
      { agent: "Pi", toolsetBlocksNetwork: true },
    );
    expect(nativeAgentPolicyEffects(applied)).toMatchObject({
      isolation: "container",
      network: "restricted",
      networkHeldBy: "toolset",
    });
    expect(applied.note).toContain("Tool denials restrict network access.");
  });

  test("keeps a restriction the toolset holds", () => {
    const applied = withoutProviderSandbox(
      { ...host, sandbox: "provider", approvals: "deny", networkAccess: "restricted" },
      { agent: "OpenCode", toolsetBlocksNetwork: true },
    );
    expect(nativeAgentPolicyEffects(applied)).toMatchObject({
      isolation: "none",
      network: "restricted",
      networkHeldBy: "toolset",
    });
  });

  test("leaves a container and an already unsandboxed full-network session alone", () => {
    const container: NativeAgentExecutionPolicy = {
      ...host,
      sandbox: "container",
      networkAccess: "restricted",
    };
    expect(withoutProviderSandbox(container, { agent: "Pi", toolsetBlocksNetwork: false })).toBe(
      container,
    );
    expect(withoutProviderSandbox(host, { agent: "Pi", toolsetBlocksNetwork: false })).toBe(host);
  });

  test("appending a note keeps the one already there", () => {
    expect(appendNativeAgentPolicyNote({ ...host, note: "First." }, "Second.").note).toBe(
      "First. Second.",
    );
    expect(appendNativeAgentPolicyNote(host, "Only.").note).toBe("Only.");
  });
});

describe("readOnlyTurnReportedPolicy", () => {
  const turnPolicy: NativeAgentExecutionPolicy = {
    id: "coordinator-read-only",
    sandbox: "provider",
    approvals: "deny",
    projectResources: false,
    networkAccess: "restricted",
  };

  test("says why it differs from the session's policy", () => {
    expect(readOnlyTurnReportedPolicy(turnPolicy)).toEqual({
      ...turnPolicy,
      note: READ_ONLY_TURN_POLICY_NOTE,
    });
  });

  test("without the command sandbox, reports none and names the boundary that held", () => {
    const reason = "Claude's command sandbox cannot run commands on this host: bwrap is missing.";
    const reported = readOnlyTurnReportedPolicy(turnPolicy, { commandSandboxOff: reason });
    expect(reported).toEqual({
      ...turnPolicy,
      sandbox: "none",
      note: `${READ_ONLY_TURN_POLICY_NOTE} ${readOnlyCommandSandboxOffNote(reason)}`,
    });
    expect(describeNativeAgentPolicyEffects(nativeAgentPolicyEffects(reported))).toStartWith(
      "No sandbox, approvals denied",
    );
    expect(readOnlyCommandSandboxOffNote(reason)).toContain("read-only command filter");
    expect(readOnlyCommandSandboxOffNote(reason)).toEndWith(reason);
  });
});
