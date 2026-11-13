import { describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import * as switches from "./electron-launch-switches";
import displaySetup from "./electron-display-setup";

import {
  HEADLESS_ELECTRON_SWITCHES,
  electronSpecDisplayProblem,
  headlessElectronRequested,
  withoutDisplay,
} from "./electron-launch-switches";
import {
  designChromiumEnvironment,
  packagedAppExecutable,
  packagedLaunchEnvironment,
  packagedLaunchSwitches,
  packagedResourcesPath,
  stopPackagedAppThenRemoveProfile,
} from "./packaged-electron-app";
import packaged from "./playwright.packaged-electron.config";
import electron from "./playwright.electron.config";

const repositoryRoot = "/repo";

describe("packaged Electron app launch", () => {
  test("finds the inspectable unpacked Linux build under release/packaged-test/ unless overridden", () => {
    const unpacked = process.arch === "x64" ? "linux-unpacked" : `linux-${process.arch}-unpacked`;
    // Linux named explicitly: on a macOS host the default is the `.app` bundle.
    expect(packagedAppExecutable(repositoryRoot, {}, "linux")).toBe(
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

  test("finds the inspectable macOS build under release/packaged-test/", () => {
    expect(packagedAppExecutable(repositoryRoot, {}, "darwin", "arm64")).toBe(
      path.join(
        repositoryRoot,
        "release/packaged-test/mac-arm64/OrkestratorV2.app/Contents/MacOS/OrkestratorV2",
      ),
    );
    expect(packagedAppExecutable(repositoryRoot, {}, "darwin", "x64")).toBe(
      path.join(
        repositoryRoot,
        "release/packaged-test/mac/OrkestratorV2.app/Contents/MacOS/OrkestratorV2",
      ),
    );
  });

  test("expects resources beside a Linux executable and in a macOS bundle's Contents/Resources", () => {
    expect(packagedResourcesPath("/r/linux-unpacked/orkestrator-v2", "linux")).toBe(
      "/r/linux-unpacked/resources",
    );
    expect(
      packagedResourcesPath(
        "/r/mac-arm64/OrkestratorV2.app/Contents/MacOS/OrkestratorV2",
        "darwin",
      ),
    ).toBe("/r/mac-arm64/OrkestratorV2.app/Contents/Resources");
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
      ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
    });
  });

  test("forwards only a non-empty design Chromium override", () => {
    expect(
      designChromiumEnvironment({ ORKESTRATOR_DESIGN_CHROMIUM_PATH: "/opt/chromium/chrome" }),
    ).toEqual({ ORKESTRATOR_DESIGN_CHROMIUM_PATH: "/opt/chromium/chrome" });
    expect(designChromiumEnvironment({ ORKESTRATOR_DESIGN_CHROMIUM_PATH: "  " })).toEqual({});
    expect(designChromiumEnvironment({ PATH: "/usr/bin" })).toEqual({});
    // The general allowlist still drops it, with every other ORKESTRATOR_* value.
    expect(
      packagedLaunchEnvironment(
        { ORKESTRATOR_DESIGN_CHROMIUM_PATH: "/opt/chromium/chrome" },
        { home: "/tmp/run/home", profilePath: "/tmp/run/profile.json" },
      ),
    ).not.toHaveProperty("ORKESTRATOR_DESIGN_CHROMIUM_PATH");
  });

  test("always runs headless on Linux", () => {
    expect(packagedLaunchSwitches("linux")).toEqual(HEADLESS_ELECTRON_SWITCHES);
    expect(HEADLESS_ELECTRON_SWITCHES).toContain("--ozone-platform=headless");
    expect(HEADLESS_ELECTRON_SWITCHES).toContain("--password-store=basic");
    expect(packagedLaunchSwitches("darwin")).toEqual([]);
  });

  test("the packaged spec has its own config, outside the default Electron run", () => {
    expect(packaged.testMatch).toEqual([
      "design-canvas-packaged-electron.spec.ts",
      "design-canvas-renderer-pairing-electron.spec.ts",
      "log-controls-packaged-electron.spec.ts",
      "packaged-native-shortcuts-electron.spec.ts",
      "packaged-security-electron.spec.ts",
      "watcher-packaged-electron.spec.ts",
    ]);
    expect(electron.testMatch).not.toContain("packaged-security-electron.spec.ts");
    expect(electron.testMatch).not.toContain("design-canvas-packaged-electron.spec.ts");
    expect(electron.testMatch).not.toContain("design-canvas-renderer-pairing-electron.spec.ts");
    expect(electron.testMatch).not.toContain("log-controls-packaged-electron.spec.ts");
    expect(electron.testMatch).not.toContain("watcher-packaged-electron.spec.ts");
    expect(electron.testMatch).not.toContain("packaged-native-shortcuts-electron.spec.ts");
    expect(electron.testMatch).toContain("design-canvas-electron.spec.ts");
  });
});

describe("display the Electron specs need", () => {
  test("Linux with no display says what to do", () => {
    const problem = electronSpecDisplayProblem("linux", {});
    expect(problem).toContain("neither DISPLAY nor WAYLAND_DISPLAY");
    expect(problem).toContain("xvfb-run -a mise run test:agent:electron");
    expect(electronSpecDisplayProblem("linux", { ORKESTRATOR_AGENT_TEST_HEADLESS: "1" })).toBe(
      problem,
    );
  });

  test("any display is enough; the opt-in requires a headless-only config", () => {
    expect(electronSpecDisplayProblem("linux", { DISPLAY: ":99" })).toBeNull();
    expect(electronSpecDisplayProblem("linux", { WAYLAND_DISPLAY: "wayland-1" })).toBeNull();
    expect(
      electronSpecDisplayProblem("linux", { ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON: "1" }),
    ).toContain("neither DISPLAY nor WAYLAND_DISPLAY");
    expect(
      electronSpecDisplayProblem("linux", { ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON: "1" }, true),
    ).toBeNull();
    expect(electronSpecDisplayProblem("darwin", {})).toBeNull();
    expect(electronSpecDisplayProblem("win32", {})).toBeNull();
  });
});

describe("headless opt-in for the Vite-served Electron specs", () => {
  test("applies only on Linux with its own variable", () => {
    const on = { ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON: "1" };
    expect(headlessElectronRequested("linux", on)).toBe(true);
    expect(headlessElectronRequested("darwin", on)).toBe(false);
    expect(headlessElectronRequested("linux", {})).toBe(false);
    expect(
      headlessElectronRequested("linux", { ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON: "true" }),
    ).toBe(false);
  });

  test("dev:test's variable does not take a spec's window away", () => {
    expect(headlessElectronRequested("linux", { ORKESTRATOR_AGENT_TEST_HEADLESS: "1" })).toBe(
      false,
    );
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

test("display setup refuses startup with the actionable display problem", () => {
  const problem = spyOn(switches, "electronSpecDisplayProblem").mockReturnValue(
    "No disposable display",
  );
  try {
    expect(() => displaySetup()).toThrow("No disposable display");
    expect(problem).toHaveBeenCalledTimes(1);
  } finally {
    problem.mockRestore();
  }
});

test("display setup permits startup when preflight succeeds", () => {
  const problem = spyOn(switches, "electronSpecDisplayProblem").mockReturnValue(null);
  try {
    expect(() => displaySetup()).not.toThrow();
    expect(problem).toHaveBeenCalledTimes(1);
  } finally {
    problem.mockRestore();
  }
});

test("headless config selects only the supported specs", async () => {
  const { default: config } = await import("./playwright.electron-headless.config");
  expect(config.testMatch).toEqual([
    "design-canvas-electron.spec.ts",
    "electron-cleanup.spec.ts",
    "web-annotations-electron.spec.ts",
    "service-preview-seeded-electron.spec.ts",
    "terminal-input-resume-electron.spec.ts",
    "local-gateway-transport-electron.spec.ts",
  ]);
});

test("global setup keeps a mixed Electron suite guarded despite the opt-in", () => {
  const problem = spyOn(switches, "electronSpecDisplayProblem").mockReturnValue(null);
  try {
    const config = (testMatch: string | RegExp | (string | RegExp)[]) =>
      ({ projects: [{ testMatch }] }) as unknown as Parameters<typeof displaySetup>[0];
    displaySetup(config(["design-canvas-electron.spec.ts", "electron-main.spec.ts"]));
    expect(problem).toHaveBeenLastCalledWith(process.platform, process.env, false);
    for (const match of [
      "design-canvas-electron.spec.ts",
      /design-canvas-electron/,
      [/design-canvas-electron/],
    ]) {
      displaySetup(config(match));
      expect(problem).toHaveBeenLastCalledWith(process.platform, process.env, false);
    }
    displaySetup(config(["design-canvas-electron.spec.ts"]));
    expect(problem).toHaveBeenLastCalledWith(process.platform, process.env, true);
    displaySetup(config(["design-canvas-electron.spec.ts", "web-annotations-electron.spec.ts"]));
    expect(problem).toHaveBeenLastCalledWith(process.platform, process.env, true);
    displaySetup(config(["service-preview-seeded-electron.spec.ts"]));
    expect(problem).toHaveBeenLastCalledWith(process.platform, process.env, true);
    displaySetup(config(["service-preview-seeded-electron.spec.ts", "electron-main.spec.ts"]));
    expect(problem).toHaveBeenLastCalledWith(process.platform, process.env, false);
    displaySetup(config(["web-annotations-electron.spec.ts", "electron-main.spec.ts"]));
    expect(problem).toHaveBeenLastCalledWith(process.platform, process.env, false);
    displaySetup(config(["terminal-input-resume-electron.spec.ts"]));
    expect(problem).toHaveBeenLastCalledWith(process.platform, process.env, true);
    displaySetup(config(["local-gateway-transport-electron.spec.ts"]));
    expect(problem).toHaveBeenLastCalledWith(process.platform, process.env, true);
    displaySetup(
      config([
        "terminal-input-resume-electron.spec.ts",
        "local-gateway-transport-electron.spec.ts",
      ]),
    );
    expect(problem).toHaveBeenLastCalledWith(process.platform, process.env, true);
    displaySetup(config(["local-gateway-transport-electron.spec.ts", "electron-main.spec.ts"]));
    expect(problem).toHaveBeenLastCalledWith(process.platform, process.env, false);
    displaySetup(config([]));
    expect(problem).toHaveBeenLastCalledWith(process.platform, process.env, false);
  } finally {
    problem.mockRestore();
  }
});

describe("packaged spec cleanup", () => {
  const steps = (snapshot: (app: string) => number[]) => {
    const calls: string[] = [];
    return {
      calls,
      steps: {
        snapshot: (app: string) => {
          calls.push(`snapshot ${app}`);
          return snapshot(app);
        },
        close: async (app: string, owned: number[]) => {
          calls.push(`close ${app} ${owned.join(",")}`);
        },
        release: async () => {
          calls.push("release");
        },
        waitForStopped: async (owned: number[]) => {
          calls.push(`wait ${owned.join(",")}`);
        },
        removeProfile: async () => {
          calls.push("remove profile");
        },
      },
    };
  };

  test("stops a launched app's snapshotted tree before removing the profile", async () => {
    const run = steps(() => [41, 42]);
    await stopPackagedAppThenRemoveProfile("app", run.steps);
    expect(run.calls).toEqual([
      "snapshot app",
      "close app 41,42",
      "release",
      "wait 41,42",
      "remove profile",
    ]);
  });

  test("keeps the profile when a launched app's process tree cannot be snapshotted", async () => {
    const run = steps(() => {
      throw new Error("ps failed");
    });
    const failure = await stopPackagedAppThenRemoveProfile("app", run.steps).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      "ps failed",
      "Cannot remove profile without an owned-process snapshot",
    ]);
    expect(run.calls).toEqual(["snapshot app", "release"]);
  });

  test("removes the profile of a run that never launched an app", async () => {
    const run = steps(() => [1]);
    await stopPackagedAppThenRemoveProfile<string>(null, run.steps);
    expect(run.calls).toEqual(["release", "wait ", "remove profile"]);
  });
});
