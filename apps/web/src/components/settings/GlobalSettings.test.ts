import { describe, expect, test } from "bun:test";
import type { GlobalConfig } from "@/types";
import { globalFormSignature } from "./GlobalSettings";

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
});
