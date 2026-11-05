import { describe, expect, test } from "bun:test";
import {
  dropInheritedVendorDebug,
  INHERITED_VENDOR_DEBUG_ENV,
  KEEP_VENDOR_DEBUG_ENV,
} from "./bridge-vendor-debug-env.js";

function launchEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin",
    DEBUG: "*",
    RUST_LOG: "trace",
    DEBUG_CLAUDE_AGENT_SDK: "1",
    DEBUGGER: "kept",
    ORKESTRATOR_BRIDGE_DEBUG: "0",
  };
}

describe("dropInheritedVendorDebug", () => {
  test("removes the named vendor debug variables and nothing else", () => {
    const env = launchEnv();
    dropInheritedVendorDebug(env, {});
    for (const name of INHERITED_VENDOR_DEBUG_ENV) expect(name in env).toBe(false);
    // Orkestrator's own switch and look-alike names are not vendor debug output.
    expect(env).toEqual({ PATH: "/usr/bin", DEBUGGER: "kept", ORKESTRATOR_BRIDGE_DEBUG: "0" });
  });

  test("keeps them when the backend was started with the escape hatch", () => {
    const env = launchEnv();
    dropInheritedVendorDebug(env, { [KEEP_VENDOR_DEBUG_ENV]: "1" });
    expect(env).toEqual(launchEnv());
  });

  test.each(["0", "", "true", "yes"])("treats %p as not asking to keep them", (value) => {
    const env = launchEnv();
    dropInheritedVendorDebug(env, { [KEEP_VENDOR_DEBUG_ENV]: value });
    expect("DEBUG" in env).toBe(false);
  });
});
