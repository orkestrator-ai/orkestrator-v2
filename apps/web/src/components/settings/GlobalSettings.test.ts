import { describe, expect, test } from "bun:test";
import type { GlobalConfig } from "@/types";
import {
  getSshAgentSocketPathValidationError,
  globalFormSignature,
  sshAgentSocketPathForSave,
  storedCoreFields,
} from "./GlobalSettings";
import {
  claudeBackgroundCommandLimitOptions,
  formatClaudeBackgroundCommandLimit,
} from "./GlobalSettings.sections";

function globalConfig(): GlobalConfig {
  return {
    containerResources: { cpuCores: 4, memoryGb: 8 },
    envFilePatterns: [],
    allowedDomains: [],
    terminalAppearance: { fontFamily: "Fira Code", fontSize: 14, backgroundColor: "#0e1014" },
    terminalScrollback: 1_000,
  };
}

describe("global settings synchronization", () => {
  test("ignores the removed legacy Cursor engine toggle", () => {
    const current = globalConfig();
    const legacy = { ...current, experimentalCursorSdkBridge: false } as GlobalConfig;
    expect(globalFormSignature(legacy)).toBe(globalFormSignature(current));
  });

  test("tracks the configured SSH agent socket", () => {
    const current = globalConfig();
    const configured = { ...current, sshAgentSocketPath: "/run/user/1000/agent.sock" };
    expect(globalFormSignature(configured)).not.toBe(globalFormSignature(current));
  });

  test("tracks the coordinator safety level", () => {
    const current = globalConfig();
    expect(globalFormSignature({ ...current, coordinatorProviderTiers: "enforced" })).not.toBe(
      globalFormSignature(current),
    );
    // Absent and the default spelled out are the same choice.
    expect(
      globalFormSignature({ ...current, coordinatorProviderTiers: "provider-configured" }),
    ).toBe(globalFormSignature(current));
  });

  test("tracks and normalizes coordinator research mode and server configuration", () => {
    const current = globalConfig();
    const defaults = [{ name: "context7", url: "https://mcp.context7.com/mcp" }];
    expect(storedCoreFields(current)).toMatchObject({
      coordinatorWebResearch: "search-and-mcp",
      coordinatorResearchMcpServers: defaults,
    });
    expect(
      globalFormSignature({
        ...current,
        coordinatorWebResearch: "search-and-mcp",
        coordinatorResearchMcpServers: defaults,
      }),
    ).toBe(globalFormSignature(current));
    for (const mode of ["off", "search"] as const) {
      expect(
        storedCoreFields({ ...current, coordinatorWebResearch: mode }).coordinatorWebResearch,
      ).toBe(mode);
      expect(globalFormSignature({ ...current, coordinatorWebResearch: mode })).not.toBe(
        globalFormSignature(current),
      );
    }
    const servers = [{ name: "docs", url: "https://docs.example/mcp" }];
    expect(
      storedCoreFields({ ...current, coordinatorResearchMcpServers: servers })
        .coordinatorResearchMcpServers,
    ).toEqual(servers);
    expect(globalFormSignature({ ...current, coordinatorResearchMcpServers: servers })).not.toBe(
      globalFormSignature(current),
    );
  });

  test("tracks the Claude background task time limit", () => {
    const current = globalConfig();
    expect(globalFormSignature({ ...current, claudeBackgroundCommandLimitHours: 12 })).not.toBe(
      globalFormSignature(current),
    );
    // Absent and the CLI's own 2-hour ceiling are the same choice.
    expect(globalFormSignature({ ...current, claudeBackgroundCommandLimitHours: 2 })).toBe(
      globalFormSignature(current),
    );
    expect(storedCoreFields(current).claudeBackgroundCommandLimitHours).toBe(2);
    expect(storedCoreFields(current).sessionTitleGeneration).toBe("any-signed-in");
    expect(
      storedCoreFields({ ...current, sessionTitleGeneration: "off" }).sessionTitleGeneration,
    ).toBe("off");
    expect(globalFormSignature({ ...current, sessionTitleGeneration: "own-platform" })).not.toBe(
      globalFormSignature(current),
    );
    expect(
      storedCoreFields({ ...current, claudeBackgroundCommandLimitHours: 24 })
        .claudeBackgroundCommandLimitHours,
    ).toBe(24);
  });

  test("tracks the durable terminal-history opt-out", () => {
    const current = globalConfig();
    expect(globalFormSignature({ ...current, terminalHistoryEnabled: false })).not.toBe(
      globalFormSignature(current),
    );
  });

  test("accepts auto-detection or an absolute SSH agent socket path", () => {
    expect(getSshAgentSocketPathValidationError("  ")).toBeNull();
    expect(getSshAgentSocketPathValidationError("/run/user/1000/agent.sock")).toBeNull();
    expect(getSshAgentSocketPathValidationError("relative/agent.sock")).toBe(
      "SSH agent socket path must be an absolute path.",
    );
    expect(getSshAgentSocketPathValidationError(`/${"a".repeat(5_000)}`)).toBe(
      "SSH agent socket path is too long.",
    );
    expect(getSshAgentSocketPathValidationError("/run/user/1000/agent\0.sock")).toBe(
      "SSH agent socket path must not contain NUL characters.",
    );
  });

  test("trims configured sockets and omits the field when returning to auto-detection", () => {
    expect(sshAgentSocketPathForSave("  /run/user/1000/agent.sock  ")).toBe(
      "/run/user/1000/agent.sock",
    );
    expect(sshAgentSocketPathForSave("   ")).toBeUndefined();
  });
});

describe("Claude background task time limit options", () => {
  test("offers presets and keeps a stored value outside them selectable", () => {
    expect(claudeBackgroundCommandLimitOptions(2)).toEqual([2, 4, 6, 8, 12, 24, 48, 72, 168]);
    expect(claudeBackgroundCommandLimitOptions(10)).toEqual([2, 4, 6, 8, 10, 12, 24, 48, 72, 168]);
  });

  test("labels hours and whole days", () => {
    expect(formatClaudeBackgroundCommandLimit(2)).toBe("2 hours (default)");
    expect(formatClaudeBackgroundCommandLimit(12)).toBe("12 hours");
    expect(formatClaudeBackgroundCommandLimit(24)).toBe("1 day");
    expect(formatClaudeBackgroundCommandLimit(168)).toBe("7 days");
    expect(formatClaudeBackgroundCommandLimit(36)).toBe("36 hours");
  });
});
