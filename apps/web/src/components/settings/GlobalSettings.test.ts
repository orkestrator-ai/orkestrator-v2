import { describe, expect, test } from "bun:test";
import type { GlobalConfig } from "@/types";
import { globalFormSignature } from "./GlobalSettings";

function globalConfig(experimentalCursorSdkBridge: boolean): GlobalConfig {
  return {
    containerResources: { cpuCores: 4, memoryGb: 8 },
    envFilePatterns: [],
    allowedDomains: [],
    terminalAppearance: { fontFamily: "Fira Code", fontSize: 14, backgroundColor: "#141414" },
    terminalScrollback: 1_000,
    experimentalCursorSdkBridge,
  };
}

describe("global settings synchronization", () => {
  test("treats the Cursor SDK engine selection as form-owned state", () => {
    expect(globalFormSignature(globalConfig(false))).not.toBe(
      globalFormSignature(globalConfig(true)),
    );
  });
});
