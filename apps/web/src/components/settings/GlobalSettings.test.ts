import { describe, expect, test } from "bun:test";
import type { GlobalConfig } from "@/types";
import { getSshAgentSocketPathValidationError, globalFormSignature } from "./GlobalSettings";

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

  test("accepts auto-detection or an absolute SSH agent socket path", () => {
    expect(getSshAgentSocketPathValidationError("  ")).toBeNull();
    expect(getSshAgentSocketPathValidationError("/run/user/1000/agent.sock")).toBeNull();
    expect(getSshAgentSocketPathValidationError("relative/agent.sock")).toBe(
      "SSH agent socket path must be an absolute path.",
    );
  });
});
