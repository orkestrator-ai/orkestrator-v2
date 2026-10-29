import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "./agent-platforms.js";
import {
  isNativeAgentCapability,
  isNativeAgentExecutionPolicy,
  LEGACY_NATIVE_AGENT_CAPABILITIES,
  NATIVE_AGENT_CAPABILITIES,
  nativeAgentCapabilityHold,
  nativeAgentDeniedCapabilities,
  nativeAgentDenialsAreReadOnly,
  nativeAgentPolicyDeniesNetwork,
  nativeAgentPolicyDeniesWebSearch,
  nativeAgentPolicyForBridge,
  type NativeAgentExecutionPolicy,
} from "./native-agent.js";

/**
 * The validator every bridge released before the extended vocabulary runs:
 * `deny` and `allow` may hold only the six legacy names, and any other key in
 * `capabilityPolicy` is ignored.
 */
function legacyBridgeAccepts(policy: NativeAgentExecutionPolicy): boolean {
  const capabilities = policy.capabilityPolicy;
  if (!capabilities) return true;
  const legacy = (value: unknown) =>
    (LEGACY_NATIVE_AGENT_CAPABILITIES as readonly unknown[]).includes(value);
  return capabilities.deny.every(legacy) && (capabilities.allow ?? []).every(legacy);
}

const base: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
};

describe("native agent capability vocabulary", () => {
  test("extends the legacy six with git, GitHub, sub-agents and the two families", () => {
    expect(NATIVE_AGENT_CAPABILITIES.slice(0, 6)).toEqual([...LEGACY_NATIVE_AGENT_CAPABILITIES]);
    for (const name of ["git.commit", "git.push", "github.write", "subagents"]) {
      expect(isNativeAgentCapability(name)).toBe(true);
    }
    expect(isNativeAgentCapability("mcp:context7")).toBe(true);
    expect(isNativeAgentCapability("mcp:docs.search-v2")).toBe(true);
    expect(isNativeAgentCapability("orkestrator:tickets.write")).toBe(true);
    for (const name of ["mcp:", "mcp:-x", "mcp:a b", `mcp:${"x".repeat(65)}`, "orkestrator:all"]) {
      expect(isNativeAgentCapability(name)).toBe(false);
    }
  });

  test("the policy guard accepts both forms and bounds extendedDeny", () => {
    const canonical = { ...base, capabilityPolicy: { deny: ["git.push", "mcp:docs"] } };
    expect(isNativeAgentExecutionPolicy(canonical)).toBe(true);
    // A newer sender's names are tolerated in extendedDeny, not in deny.
    expect(
      isNativeAgentExecutionPolicy({
        ...base,
        capabilityPolicy: { deny: [], extendedDeny: ["git.push", "future.capability"] },
      }),
    ).toBe(true);
    expect(
      isNativeAgentExecutionPolicy({ ...base, capabilityPolicy: { deny: ["future.capability"] } }),
    ).toBe(false);
    for (const extendedDeny of [
      [1],
      [""],
      "git.push",
      Array(65).fill("git.push"),
      ["x".repeat(129)],
    ]) {
      expect(
        isNativeAgentExecutionPolicy({ ...base, capabilityPolicy: { deny: [], extendedDeny } }),
      ).toBe(false);
    }
  });

  test("denied capabilities are read from either form, skipping unknown names", () => {
    expect(
      nativeAgentDeniedCapabilities({
        capabilityPolicy: {
          deny: ["network"],
          extendedDeny: ["git.push", "future.capability", "git.push"],
        },
      }),
    ).toEqual(["network", "git.push"]);
    expect(nativeAgentDeniedCapabilities(undefined)).toEqual([]);
  });

  test("read-only means no file tool writes and the shell cannot mutate", () => {
    expect(nativeAgentDenialsAreReadOnly(["file.write", "file.patch", "shell.mutate"])).toBe(true);
    expect(nativeAgentDenialsAreReadOnly(["file.write", "file.patch", "shell"])).toBe(true);
    expect(nativeAgentDenialsAreReadOnly(["file.write", "file.patch"])).toBe(false);
    expect(nativeAgentDenialsAreReadOnly(["file.write", "shell.mutate"])).toBe(false);
  });
});

describe("the wire form for bridges", () => {
  const graphPolicy: NativeAgentExecutionPolicy = {
    ...base,
    capabilityPolicy: {
      deny: [
        "file.write",
        "file.patch",
        "network",
        "git.commit",
        "git.push",
        "github.write",
        "subagents",
        "mcp:docs",
        "orkestrator:mail",
      ],
      allow: ["web.search"],
    },
  };

  test("every released bridge still validates it on every platform", () => {
    for (const platform of AGENT_PLATFORMS) {
      const wire = nativeAgentPolicyForBridge(graphPolicy, platform);
      expect(legacyBridgeAccepts(wire)).toBe(true);
      expect(isNativeAgentExecutionPolicy(wire)).toBe(true);
      expect(wire.capabilityPolicy?.deny).toEqual(["file.write", "file.patch", "network"]);
      expect(wire.capabilityPolicy?.allow).toEqual(["web.search"]);
      // Orkestrator groups are the backend's; they never reach a bridge.
      expect(wire.capabilityPolicy?.extendedDeny).toEqual([
        "git.commit",
        "git.push",
        "github.write",
        "subagents",
        "mcp:docs",
      ]);
      // A newer bridge reads the same denials back (minus the backend's).
      expect(nativeAgentDeniedCapabilities(wire).toSorted()).toEqual(
        nativeAgentDeniedCapabilities(graphPolicy)
          .filter((capability) => !capability.startsWith("orkestrator:"))
          .toSorted(),
      );
      // Network and search semantics are untouched.
      expect(nativeAgentPolicyDeniesNetwork(wire)).toBe(true);
      expect(nativeAgentPolicyDeniesWebSearch(wire)).toBe(false);
    }
  });

  test("an MCP denial falls back to project resources off where the bridge cannot name it", () => {
    const resources = Object.fromEntries(
      AGENT_PLATFORMS.map((platform) => [
        platform,
        nativeAgentPolicyForBridge(graphPolicy, platform).projectResources,
      ]),
    );
    expect(resources).toEqual({
      claude: true,
      codex: false,
      cursor: false,
      grok: false,
      opencode: true,
      pi: false,
    });
  });

  test("is the identity for legacy policies and idempotent for the rest", () => {
    const coordinator: NativeAgentExecutionPolicy = {
      ...base,
      capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
    };
    expect(nativeAgentPolicyForBridge(coordinator, "codex")).toBe(coordinator);
    expect(nativeAgentPolicyForBridge(base, "codex")).toBe(base);
    for (const platform of AGENT_PLATFORMS) {
      const once = nativeAgentPolicyForBridge(graphPolicy, platform);
      expect(nativeAgentPolicyForBridge(once, platform)).toEqual(once);
    }
  });

  test("names how each denial is held on each platform", () => {
    const readOnly = ["file.write", "file.patch", "shell.mutate", "git.push"];
    const writer = ["git.commit", "git.push", "github.write", "subagents", "mcp:docs"];
    expect(nativeAgentCapabilityHold("codex", "git.push", readOnly)).toBe("shell-denial");
    expect(nativeAgentCapabilityHold("codex", "git.push", writer)).toBe("guard");
    expect(nativeAgentCapabilityHold("claude", "git.push", writer)).toBe("bridge");
    expect(nativeAgentCapabilityHold("codex", "mcp:docs", writer)).toBe("project-resources");
    expect(nativeAgentCapabilityHold("opencode", "mcp:docs", writer)).toBe("bridge");
    expect(nativeAgentCapabilityHold("pi", "subagents", writer)).toBe("advisory");
    expect(nativeAgentCapabilityHold("cursor", "subagents", writer)).toBe("bridge");
    expect(nativeAgentCapabilityHold("grok", "orkestrator:mail", writer)).toBe("backend");
    expect(nativeAgentCapabilityHold("grok", "network", writer)).toBe("bridge");
  });
});
