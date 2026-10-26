import { describe, expect, spyOn, test } from "bun:test";
import path from "node:path";

import * as builds from "../../apps/desktop/scripts/dev/bridge-builds";
import globalSetup from "./bridge-builds-setup";
import browser from "./playwright.browser.config";
import coordinator from "./playwright.coordinator.config";
import warm from "./playwright.claude-warm.config";
import paused from "./playwright.paused-interactions.config";
import electron from "./playwright.electron.config";

describe("agent-test bridge freshness setup", () => {
  test.each<builds.ProfileBridgeCheck>([
    { state: "current" },
    { state: "no-profile" },
    { state: "unrecorded" },
    { state: "allowed", problems: ["pi-bridge: sources changed", "codex-bridge: dist changed"] },
  ])("handles the $state state", async (result) => {
    const previous = process.env.ORKESTRATOR_AGENT_TEST_PROFILE;
    process.env.ORKESTRATOR_AGENT_TEST_PROFILE = "setup-qa";
    const check = spyOn(builds, "checkProfileBridgeBuilds").mockResolvedValue(result);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await globalSetup();
      expect(check).toHaveBeenCalledWith({ profile: "setup-qa" });
      if (result.state === "allowed") {
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(
          "Running against stale bridge builds in profile setup-qa:\n  - pi-bridge: sources changed\n  - codex-bridge: dist changed",
        );
      } else if (result.state === "unrecorded") {
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining("Profile setup-qa has no bridge build record"),
        );
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("mise run dev:test"));
      } else {
        expect(warning).not.toHaveBeenCalled();
      }
    } finally {
      if (previous === undefined) delete process.env.ORKESTRATOR_AGENT_TEST_PROFILE;
      else process.env.ORKESTRATOR_AGENT_TEST_PROFILE = previous;
      check.mockRestore();
      warning.mockRestore();
    }
  });

  test("propagates freshness failures before the suite can start", async () => {
    const check = spyOn(builds, "checkProfileBridgeBuilds").mockRejectedValue(
      new Error("stale profile"),
    );
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(globalSetup()).rejects.toThrow("stale profile");
      expect(warning).not.toHaveBeenCalled();
    } finally {
      check.mockRestore();
      warning.mockRestore();
    }
  });

  test.each([
    ["browser", browser],
    ["coordinator", coordinator],
    ["Claude warm", warm],
    ["paused interactions", paused],
  ] as const)("%s config retains the bridge freshness guard", (_name, config) => {
    expect(config.globalSetup).toBe(path.join(import.meta.dirname, "bridge-builds-setup.ts"));
  });

  test("the Electron config has its documented independent startup", () => {
    expect(electron.globalSetup).toBeUndefined();
  });
});
