import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "../agent-platforms.js";
import type { NativeAgentExecutionPolicy } from "../native-agent.js";
import {
  agentEnforcementHostForOs,
  agentEnforcementTierSatisfies,
  agentPlatformsMeetingFloor,
  agentPolicyEnforcement,
  agentPolicyEnforcementMatrix,
  compileGraphCapabilities,
  coordinatorEnforcementPolicy,
  weakestAgentEnforcementTier,
} from "./capability-profiles.js";
import { GRAPH_CAPABILITY_PROFILES, type GraphCapabilityProfileId } from "./template-model.js";

const sandboxed = { claudeSandbox: true };
const unsandboxed = { claudeSandbox: false };
const host: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};

const tiers = (policy: Parameters<typeof agentPolicyEnforcement>[0], hostCaps = sandboxed) =>
  Object.fromEntries(
    AGENT_PLATFORMS.map((platform) => [
      platform,
      agentPolicyEnforcement(policy, platform, hostCaps).tier,
    ]),
  );

const profilePolicy = (profile: GraphCapabilityProfileId, environment = host) =>
  compileGraphCapabilities({ spec: { profile }, environment }).policy;

describe("enforcement tiers", () => {
  test("order and floors", () => {
    expect(agentEnforcementTierSatisfies("enforced", "provider-configured")).toBe(true);
    expect(agentEnforcementTierSatisfies("advisory", "provider-configured")).toBe(false);
    expect(agentEnforcementTierSatisfies("advisory", "advisory")).toBe(true);
    expect(weakestAgentEnforcementTier([])).toBe("enforced");
    expect(weakestAgentEnforcementTier(["enforced", "advisory", "provider-configured"])).toBe(
      "advisory",
    );
  });

  test("reproduces the coordinator's tiers for the coordinator policy", () => {
    expect(tiers(coordinatorEnforcementPolicy(), sandboxed)).toEqual({
      claude: "enforced",
      codex: "enforced",
      cursor: "provider-configured",
      grok: "advisory",
      opencode: "provider-configured",
      pi: "enforced",
    });
    expect(tiers(coordinatorEnforcementPolicy(), unsandboxed).claude).toBe("provider-configured");
    const claude = agentPolicyEnforcement(coordinatorEnforcementPolicy(), "claude", {
      claudeSandbox: false,
      claudeSandboxReason: "bwrap cannot nest a user namespace.",
    });
    expect(claude.reason).toBe(
      "bwrap cannot nest a user namespace. File tools are removed and the bridge admits only reading commands, but nothing outside the agent enforces it.",
    );
    expect(agentPolicyEnforcement(coordinatorEnforcementPolicy(), "codex", sandboxed).reason).toBe(
      undefined,
    );
    // Research mode changes no tier.
    const research = {
      ...coordinatorEnforcementPolicy(),
      capabilityPolicy: {
        ...coordinatorEnforcementPolicy().capabilityPolicy!,
        allow: ["web.search" as const],
      },
    };
    expect(tiers(research)).toEqual(tiers(coordinatorEnforcementPolicy()));
  });

  test("read-only profiles are judged like the coordinator (report §6.4)", () => {
    for (const profile of ["observer", "reviewer", "researcher"] as const) {
      expect(tiers(profilePolicy(profile))).toEqual(tiers(coordinatorEnforcementPolicy()));
      expect(tiers(profilePolicy(profile), unsandboxed)).toEqual(
        tiers(coordinatorEnforcementPolicy(), unsandboxed),
      );
    }
    const reviewer = agentPolicyEnforcement(profilePolicy("reviewer"), "codex", sandboxed);
    expect(reviewer.readOnly).toBe(true);
    expect(reviewer.axes.map((axis) => [axis.axis, axis.tier, axis.boundary])).toEqual([
      ["workspace", "enforced", true],
      ["network", "enforced", true],
      ["commit", "enforced", true],
      ["remote", "enforced", true],
    ]);
  });

  test("writing profiles hold push and commits by guards, not providers", () => {
    for (const profile of ["builder", "custom", "verifier"] as const) {
      const judged = agentPolicyEnforcement(profilePolicy(profile), "claude", sandboxed);
      expect(judged.tier).toBe("advisory");
      expect(judged.readOnly).toBe(false);
    }
    const builder = agentPolicyEnforcement(profilePolicy("builder"), "codex", sandboxed);
    expect(builder.axes).toEqual([
      {
        axis: "remote",
        tier: "advisory",
        boundary: true,
        reason:
          "Push and GitHub writes are held by Orkestrator's guards (remote-ref check, withheld GitHub credential), not by the provider.",
      },
    ]);
    const verifier = agentPolicyEnforcement(profilePolicy("verifier"), "cursor", sandboxed);
    expect(verifier.axes.map((axis) => [axis.axis, axis.tier])).toEqual([
      ["workspace", "provider-configured"],
      ["commit", "advisory"],
      ["remote", "advisory"],
    ]);
  });

  test("a network denial holds remote writes when commands are sandboxed without the network", () => {
    const offline = {
      ...profilePolicy("builder"),
      sandbox: "container" as const,
      networkAccess: "restricted" as const,
      capabilityPolicy: {
        deny: ["network" as const, "git.push" as const, "github.write" as const],
      },
    };
    expect(tiers(offline)).toEqual({
      claude: "provider-configured",
      codex: "provider-configured",
      cursor: "provider-configured",
      grok: "advisory",
      opencode: "provider-configured",
      pi: "provider-configured",
    });
    // Without a sandbox the commands reach the network, and so can a push.
    expect(tiers({ ...offline, sandbox: "none", networkAccess: "full" }).codex).toBe("advisory");
  });

  test("secondary axes are reported without lowering the tier", () => {
    const policy = compileGraphCapabilities({
      spec: { profile: "reviewer", deny: ["subagents", "mcp:docs"] },
      environment: host,
    }).policy;
    const codex = agentPolicyEnforcement(policy, "codex", sandboxed);
    expect(codex.tier).toBe("enforced");
    expect(
      codex.axes.filter((axis) => !axis.boundary).map((axis) => [axis.axis, axis.tier]),
    ).toEqual([
      ["subagents", "advisory"],
      ["mcp", "provider-configured"],
    ]);
    const grok = agentPolicyEnforcement(
      { ...host, capabilityPolicy: { deny: ["web.search"] } },
      "grok",
      sandboxed,
    );
    expect(grok.tier).toBe("enforced");
    expect(grok.axes).toEqual([
      expect.objectContaining({ axis: "web-search", tier: "advisory", boundary: false }),
    ]);
  });

  test("the matrix and the floor filter agree, and the default floor hides Grok (D4)", () => {
    const policy = profilePolicy("reviewer");
    const matrix = agentPolicyEnforcementMatrix(policy, sandboxed);
    expect(Object.keys(matrix)).toEqual([...AGENT_PLATFORMS]);
    expect(agentPlatformsMeetingFloor(policy, "provider-configured", sandboxed)).toEqual(
      AGENT_PLATFORMS.filter((platform) => platform !== "grok"),
    );
    expect(agentPlatformsMeetingFloor(policy, "enforced", unsandboxed)).toEqual(["codex", "pi"]);
    for (const profile of GRAPH_CAPABILITY_PROFILES) {
      expect(agentPlatformsMeetingFloor(profilePolicy(profile), "advisory", sandboxed)).toEqual([
        ...AGENT_PLATFORMS,
      ]);
    }
  });

  test("hosts the designer cannot probe", () => {
    expect(agentEnforcementHostForOs("darwin")).toEqual({ claudeSandbox: true });
    expect(agentEnforcementHostForOs("win32")).toEqual({ claudeSandbox: false });
    expect(agentEnforcementHostForOs("linux").claudeSandbox).toBe(false);
    expect(agentEnforcementHostForOs("linux", true)).toEqual({ claudeSandbox: true });
    expect(
      agentPolicyEnforcement(
        coordinatorEnforcementPolicy(),
        "claude",
        agentEnforcementHostForOs("linux"),
      ).reason,
    ).toContain("has not shown");
  });
});
