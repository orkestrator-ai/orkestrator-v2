import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  coordinatorProviderAllowed,
  coordinatorProviderQualification,
  coordinatorProviderQualifications,
  coordinatorProviderTierSetting,
  defaultCoordinatorHostCapabilities,
} from "./coordinator-providers.js";
import {
  agentPolicyEnforcement,
  compileGraphCapabilities,
  coordinatorEnforcementPolicy,
} from "@orkestrator/protocol/graphs/capability-profiles";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import {
  CLAUDE_LINUX_SANDBOX_PROGRAMS,
  probeClaudeLinuxSandbox,
} from "@orkestrator/protocol/node/claude-linux-sandbox";

const sandboxed = { claudeSandbox: true };
const unsandboxed = { claudeSandbox: false };
const everyPlatform = [...AGENT_PLATFORMS];

describe("coordinator provider qualification", () => {
  test("the default admits enforced and provider-configured platforms, not advisory", () => {
    const admitted = everyPlatform.filter((platform) =>
      coordinatorProviderAllowed(platform, {
        host: sandboxed,
        enabledPlatforms: everyPlatform,
      }),
    );
    expect(admitted).toEqual(["claude", "codex", "cursor", "opencode", "pi"]);
  });

  test("the strictest setting admits only enforced platforms", () => {
    const admitted = everyPlatform.filter((platform) =>
      coordinatorProviderAllowed(platform, {
        tierSetting: "enforced",
        host: sandboxed,
        enabledPlatforms: everyPlatform,
      }),
    );
    expect(admitted).toEqual(["claude", "codex", "pi"]);
  });

  test("a weaker setting admits the weaker tiers and nothing stronger than asked", () => {
    const providerConfigured = everyPlatform.filter((platform) =>
      coordinatorProviderAllowed(platform, {
        tierSetting: "provider-configured",
        host: sandboxed,
        enabledPlatforms: everyPlatform,
      }),
    );
    expect(providerConfigured).toEqual(["claude", "codex", "cursor", "opencode", "pi"]);
    expect(
      coordinatorProviderAllowed("grok", {
        tierSetting: "provider-configured",
        host: sandboxed,
        enabledPlatforms: everyPlatform,
      }),
    ).toBe(false);
    expect(
      coordinatorProviderAllowed("grok", {
        tierSetting: "advisory",
        host: sandboxed,
        enabledPlatforms: everyPlatform,
      }),
    ).toBe(true);
  });

  test("a host without Claude's sandbox demotes Claude rather than claiming enforcement", () => {
    const claude = coordinatorProviderQualification("claude", {
      tierSetting: "enforced",
      host: unsandboxed,
      enabledPlatforms: everyPlatform,
    });
    expect(claude.tier).toBe("provider-configured");
    expect(claude.available).toBe(false);
    expect(claude.reason).toContain("sandbox is unavailable");
    expect(
      coordinatorProviderQualification("claude", {
        tierSetting: "provider-configured",
        host: unsandboxed,
        enabledPlatforms: everyPlatform,
      }).available,
    ).toBe(true);
  });

  test("a disabled platform is unavailable whatever its tier", () => {
    const codex = coordinatorProviderQualification("codex", {
      host: sandboxed,
      enabledPlatforms: ["claude"],
    });
    expect(codex.tier).toBe("enforced");
    expect(codex.available).toBe(false);
    expect(codex.reason).toContain("turned off in settings");
  });

  test("Pi qualifies with delegation once the bridge owns an MCP client", () => {
    const pi = coordinatorProviderQualification("pi", {
      host: sandboxed,
      enabledPlatforms: everyPlatform,
    });
    expect(pi).toMatchObject({ tier: "enforced", available: true, delegation: true });
    expect(pi.reason).toBeUndefined();
  });

  test("delegation follows the round trip, not just the outbound MCP call", () => {
    for (const platform of AGENT_PLATFORMS) {
      expect(
        coordinatorProviderQualification(platform, {
          tierSetting: "advisory",
          host: sandboxed,
          enabledPlatforms: everyPlatform,
        }).delegation,
      ).toBe(true);
    }
  });

  test("Cursor still reports its weaker sandbox tier after mail delivery is on", () => {
    const cursor = coordinatorProviderQualification("cursor", {
      tierSetting: "provider-configured",
      host: sandboxed,
      enabledPlatforms: everyPlatform,
    });
    expect(cursor).toMatchObject({ available: true, delegation: true });
    expect(cursor.reason).toContain("no approval callback");
    expect(cursor.reason).not.toContain("mailbox cannot receive replies");
  });

  test("only an absent tier uses the default while malformed values fail closed", () => {
    expect(coordinatorProviderTierSetting("advisory")).toBe("advisory");
    expect(coordinatorProviderTierSetting("enforced")).toBe("enforced");
    expect(coordinatorProviderTierSetting("nonsense")).toBe("enforced");
    expect(coordinatorProviderTierSetting(undefined)).toBe("provider-configured");
    expect(coordinatorProviderTierSetting(null)).toBe("enforced");
  });

  test("every platform is answered, so a picker cannot silently omit one", () => {
    const qualifications = coordinatorProviderQualifications({
      host: sandboxed,
      enabledPlatforms: everyPlatform,
    });
    expect(Object.keys(qualifications).toSorted()).toEqual([...everyPlatform].toSorted());
  });

  test("the host probe follows the OS sandboxes that actually exist", () => {
    const works = () => ({ available: true }) as const;
    const refused = () =>
      ({ available: false, failure: "nested-user-namespace", reason: "Refused." }) as const;
    expect(defaultCoordinatorHostCapabilities("darwin", refused).claudeSandbox).toBe(true);
    expect(defaultCoordinatorHostCapabilities("linux", works)).toEqual({ claudeSandbox: true });
    // The pinned CLI's Windows sandbox is behind a vendor flag that is off.
    expect(defaultCoordinatorHostCapabilities("win32", works).claudeSandbox).toBe(false);
  });

  test("Linux without bubblewrap or socat is not reported as enforced", () => {
    // The CLI refuses to start a required sandbox without either, so an
    // `enforced` Claude there would fail every coordinator turn.
    for (const missing of CLAUDE_LINUX_SANDBOX_PROGRAMS) {
      const host = defaultCoordinatorHostCapabilities("linux", () =>
        probeClaudeLinuxSandbox({ onPath: (name) => name !== missing }),
      );
      expect(host.claudeSandbox).toBe(false);
      expect(
        coordinatorProviderQualification("claude", { host, tierSetting: "provider-configured" }),
      ).toMatchObject({ tier: "provider-configured", available: true });
      expect(
        coordinatorProviderQualification("claude", { host, tierSetting: "enforced" }).available,
      ).toBe(false);
    }
  });

  test("a host whose AppArmor refuses the nested namespace is not reported as enforced", () => {
    // Ubuntu 26.04 with bwrap and socat installed: the CLI's sandbox starts,
    // then every command fails in its seccomp helper (todo 0145).
    const host = defaultCoordinatorHostCapabilities("linux", () =>
      probeClaudeLinuxSandbox({
        onPath: () => true,
        run: (_command, args) =>
          args.includes("unshare")
            ? { ok: false, stderr: "unshare: write failed /proc/self/setgroups: Permission denied" }
            : { ok: true, stderr: "" },
        appArmorBwrapProfile: () => true,
      }),
    );
    expect(host.claudeSandbox).toBe(false);
    const claude = coordinatorProviderQualification("claude", {
      host,
      tierSetting: "provider-configured",
      enabledPlatforms: everyPlatform,
    });
    expect(claude).toMatchObject({ tier: "provider-configured", available: true });
    expect(claude.reason).toContain("bwrap-userns-restrict");
    expect(claude.reason).toContain("the bridge admits only reading commands");
    const strict = coordinatorProviderQualification("claude", {
      host,
      tierSetting: "enforced",
      enabledPlatforms: everyPlatform,
    });
    expect(strict.available).toBe(false);
    expect(strict.reason).toContain("bwrap-userns-restrict");
  });

  test("a host whose bubblewrap nests a namespace keeps Claude enforced", () => {
    const host = defaultCoordinatorHostCapabilities("linux", () =>
      probeClaudeLinuxSandbox({ onPath: () => true, run: () => ({ ok: true, stderr: "" }) }),
    );
    expect(
      coordinatorProviderQualification("claude", {
        host,
        tierSetting: "enforced",
        enabledPlatforms: everyPlatform,
      }),
    ).toMatchObject({ tier: "enforced", available: true });
  });

  test("the tier is the shared enforcement matrix's, for the coordinator and read-only profiles", () => {
    for (const host of [
      sandboxed,
      unsandboxed,
      { claudeSandbox: false, claudeSandboxReason: "x." },
    ]) {
      for (const platform of everyPlatform) {
        const qualification = coordinatorProviderQualification(platform, {
          host,
          tierSetting: "advisory",
          enabledPlatforms: everyPlatform,
        });
        const judged = agentPolicyEnforcement(coordinatorEnforcementPolicy(), platform, host);
        expect(qualification.tier).toBe(judged.tier);
        if (judged.reason) expect(qualification.reason).toStartWith(judged.reason);
        // A reviewer node is held exactly as strongly as a coordinator.
        const reviewer = compileGraphCapabilities({
          spec: { profile: "reviewer" },
          environment: resolveNativeAgentExecutionPolicy(
            { environmentType: "local", networkAccessMode: "full" },
            "build-pipeline",
          ),
        });
        expect(agentPolicyEnforcement(reviewer.policy, platform, host).tier as string).toBe(
          qualification.tier,
        );
      }
    }
  });
});
