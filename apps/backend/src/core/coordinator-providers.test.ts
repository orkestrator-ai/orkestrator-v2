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
    expect(defaultCoordinatorHostCapabilities("darwin").claudeSandbox).toBe(true);
    expect(defaultCoordinatorHostCapabilities("linux").claudeSandbox).toBe(true);
    expect(defaultCoordinatorHostCapabilities("win32").claudeSandbox).toBe(false);
  });
});
