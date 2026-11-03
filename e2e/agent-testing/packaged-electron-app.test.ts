import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  HEADLESS_ELECTRON_SWITCHES,
  headlessElectronRequested,
  withoutDisplay,
} from "./electron-launch-switches";
import {
  packagedAppExecutable,
  packagedLaunchEnvironment,
  packagedLaunchSwitches,
} from "./packaged-electron-app";
import packaged from "./playwright.packaged-electron.config";
import electron from "./playwright.electron.config";

const repositoryRoot = "/repo";

describe("packaged Electron app launch", () => {
  test("finds the inspectable unpacked Linux build under release/packaged-test/ unless overridden", () => {
    const unpacked = process.arch === "x64" ? "linux-unpacked" : `linux-${process.arch}-unpacked`;
    expect(packagedAppExecutable(repositoryRoot, {})).toBe(
      path.join(repositoryRoot, "release", "packaged-test", unpacked, "orkestrator-v2"),
    );
    expect(
      packagedAppExecutable(repositoryRoot, {
        ORKESTRATOR_PACKAGED_APP_EXECUTABLE: " other/build/orkestrator-v2 ",
      }),
    ).toBe(path.join(repositoryRoot, "other", "build", "orkestrator-v2"));
    expect(
      packagedAppExecutable(repositoryRoot, { ORKESTRATOR_PACKAGED_APP_EXECUTABLE: "/opt/app/x" }),
    ).toBe("/opt/app/x");
  });

  test("passes on only allowlisted host variables and puts every home under the profile", () => {
    const env = packagedLaunchEnvironment(
      {
        PATH: "/usr/bin",
        LANG: "en_GB.UTF-8",
        LC_ALL: "C",
        HOME: "/home/user",
        XDG_CONFIG_HOME: "/home/user/.config",
        XDG_RUNTIME_DIR: "/run/user/1000",
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-1",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        ELECTRON_OZONE_PLATFORM_HINT: "wayland",
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:1420",
        ORKESTRATOR_AGENT_MCP_TOKEN: "secret",
        ORKESTRATOR_RESOURCE_ROOT: "/production/resources",
        GITHUB_PERSONAL_ACCESS_TOKEN: "secret",
        CLAUDE_CODE_SESSION_ID: "session",
        NODE_ENV: "production",
      },
      { home: "/tmp/run/home", profilePath: "/tmp/run/profile.json" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      LANG: "en_GB.UTF-8",
      LC_ALL: "C",
      HOME: "/tmp/run/home",
      XDG_CONFIG_HOME: "/tmp/run/home/.config",
      XDG_DATA_HOME: "/tmp/run/home/.local/share",
      XDG_CACHE_HOME: "/tmp/run/home/.cache",
      XDG_STATE_HOME: "/tmp/run/home/.local/state",
      ORKESTRATOR_RUNTIME_PROFILE_FILE: "/tmp/run/profile.json",
      ORKESTRATOR_CONTROL_MCP_PORT: "0",
    });
  });

  test("always runs headless on Linux", () => {
    expect(packagedLaunchSwitches("linux")).toEqual(HEADLESS_ELECTRON_SWITCHES);
    expect(HEADLESS_ELECTRON_SWITCHES).toContain("--ozone-platform=headless");
    expect(HEADLESS_ELECTRON_SWITCHES).toContain("--password-store=basic");
    expect(packagedLaunchSwitches("darwin")).toEqual([]);
  });

  test("the packaged spec has its own config, outside the default Electron run", () => {
    expect(packaged.testMatch).toEqual(["design-canvas-packaged-electron.spec.ts"]);
    expect(electron.testMatch).not.toContain("design-canvas-packaged-electron.spec.ts");
    expect(electron.testMatch).toContain("design-canvas-electron.spec.ts");
  });
});

describe("headless opt-in for the Vite-served Electron specs", () => {
  test("applies only on Linux with the dev:test variable", () => {
    const on = { ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON: "1" };
    expect(headlessElectronRequested("linux", on)).toBe(true);
    expect(headlessElectronRequested("darwin", on)).toBe(false);
    expect(headlessElectronRequested("linux", {})).toBe(false);
    expect(
      headlessElectronRequested("linux", { ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON: "true" }),
    ).toBe(false);
  });

  test("drops only the display variables", () => {
    expect(
      withoutDisplay({
        PATH: "/usr/bin",
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-1",
        ELECTRON_OZONE_PLATFORM_HINT: "auto",
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });
});
