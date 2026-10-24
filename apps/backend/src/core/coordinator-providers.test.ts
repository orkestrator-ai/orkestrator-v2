import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  coordinatorProviderAllowed,
  coordinatorProviderQualification,
  coordinatorProviderQualifications,
  coordinatorProviderTierSetting,
  CLAUDE_LINUX_SANDBOX_PROGRAMS,
  defaultCoordinatorHostCapabilities,
  executableOnPath,
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
    const everything = () => true;
    const nothing = () => false;
    expect(defaultCoordinatorHostCapabilities("darwin", nothing).claudeSandbox).toBe(true);
    expect(defaultCoordinatorHostCapabilities("linux", everything).claudeSandbox).toBe(true);
    // The pinned CLI's Windows sandbox is behind a vendor flag that is off.
    expect(defaultCoordinatorHostCapabilities("win32", everything).claudeSandbox).toBe(false);
  });

  test("Linux without bubblewrap or socat is not reported as enforced", () => {
    // The CLI refuses to start a required sandbox without either, so an
    // `enforced` Claude there would fail every coordinator turn.
    for (const missing of CLAUDE_LINUX_SANDBOX_PROGRAMS) {
      const host = defaultCoordinatorHostCapabilities("linux", (name) => name !== missing);
      expect(host.claudeSandbox).toBe(false);
      expect(
        coordinatorProviderQualification("claude", { host, tierSetting: "provider-configured" }),
      ).toMatchObject({ tier: "provider-configured", available: true });
      expect(
        coordinatorProviderQualification("claude", { host, tierSetting: "enforced" }).available,
      ).toBe(false);
    }
  });

  test("the PATH lookup finds an executable and ignores a plain file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coordinator-path-"));
    try {
      await writeFile(join(directory, "bwrap"), "#!/bin/sh\n");
      await chmod(join(directory, "bwrap"), 0o755);
      await writeFile(join(directory, "socat"), "");
      await chmod(join(directory, "socat"), 0o644);
      expect(executableOnPath("bwrap", directory)).toBe(true);
      expect(executableOnPath("socat", directory)).toBe(false);
      expect(executableOnPath("bwrap", "")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
