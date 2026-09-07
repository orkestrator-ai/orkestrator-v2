import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  coordinatorProviderAllowed,
  coordinatorProviderQualification,
  coordinatorProviderQualifications,
  coordinatorProviderTierSetting,
  defaultCoordinatorHostCapabilities,
} from "./coordinator-providers.js";

const sandboxed = { claudeSandbox: true };
const unsandboxed = { claudeSandbox: false };
const everyPlatform = [...AGENT_PLATFORMS];

describe("coordinator provider qualification", () => {
  test("only enforced platforms are admitted by default", () => {
    const admitted = everyPlatform.filter((platform) =>
      coordinatorProviderAllowed(platform, {
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

  test("Pi qualifies without delegation, so the caveat travels with it", () => {
    const pi = coordinatorProviderQualification("pi", {
      host: sandboxed,
      enabledPlatforms: everyPlatform,
    });
    expect(pi).toMatchObject({ tier: "enforced", available: true, delegation: false });
    expect(pi.reason).toContain("no MCP client");
  });

  test("delegation follows the round trip, not just the outbound MCP call", () => {
    // Cursor and Grok both ship an MCP client, so `launch_environment` is
    // reachable — but their native mailboxes cannot be injected into, so the
    // worker's reply can never come back. Advertising delegation there produces
    // a coordinator that dispatches work and then waits for good.
    for (const platform of ["cursor", "grok", "pi"] as const) {
      const qualification = coordinatorProviderQualification(platform, {
        tierSetting: "advisory",
        host: sandboxed,
        enabledPlatforms: everyPlatform,
      });
      expect(qualification.delegation).toBe(false);
      expect(qualification.reason).toBeTruthy();
    }
    // The platforms whose mailboxes deliver keep it.
    for (const platform of ["claude", "codex", "opencode"] as const) {
      expect(
        coordinatorProviderQualification(platform, {
          tierSetting: "advisory",
          host: sandboxed,
          enabledPlatforms: everyPlatform,
        }).delegation,
      ).toBe(true);
    }
  });

  test("a platform that can call out but not be replied to says so in its reason", () => {
    const cursor = coordinatorProviderQualification("cursor", {
      tierSetting: "provider-configured",
      host: sandboxed,
      enabledPlatforms: everyPlatform,
    });
    expect(cursor).toMatchObject({ available: true, delegation: false });
    // The tier caveat and the delivery caveat both reach the picker.
    expect(cursor.reason).toContain("no approval callback");
    expect(cursor.reason).toContain("mailbox cannot receive replies");
  });

  test("an unknown tier setting falls back to the strictest, never the loosest", () => {
    expect(coordinatorProviderTierSetting("advisory")).toBe("advisory");
    expect(coordinatorProviderTierSetting("nonsense")).toBe("enforced");
    expect(coordinatorProviderTierSetting(undefined)).toBe("enforced");
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
    expect(defaultCoordinatorHostCapabilities("darwin").claudeSandbox).toBe(true);
    expect(defaultCoordinatorHostCapabilities("linux").claudeSandbox).toBe(true);
    expect(defaultCoordinatorHostCapabilities("win32").claudeSandbox).toBe(false);
  });
});
