import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fakePid } from "@orkestrator/protocol/testing/fake-pids";

import {
  HEADLESS_ELECTRON_SWITCHES,
  resolveRuntimeProfile,
  statusManifestPath,
} from "../../electron/runtime-profile.js";
import * as bridgeBuilds from "./bridge-builds.js";
import * as profileIo from "./profile-io.js";
import { atomicWriteJson, initializeProfile } from "./profile-io.js";
import { parseDevArguments } from "./arguments.js";
import {
  assertElectronReadiness,
  compileElectronForDevelopment,
  AGENT_TEST_CORE_DUMPS_ENV,
  electronCommand,
  electronHeadlessNotice,
  electronDebugSwitches,
  electronLaunch,
  ELECTRON_STOP_GRACE_MS,
  signalsProcessGroup,
  stopLauncherChildren,
  type OwnedChildSignal,
  launcherIsInteractive,
  electronReadinessTimeoutMs,
  outputTail,
  resolveElectronHeadless,
  startDevelopment,
  withOutputTails,
  configuredDevWorktreeRoot,
  profileWorktreeLocation,
} from "./lifecycle.js";

// This file starts a real shell; allow subprocess startup under aggregate load.
setDefaultTimeout(30_000);

const complete = {
  authFile: "/tmp/gateway-auth.json",
  backendPid: 42,
  browserUrl: "http://x/",
  invokeUrl: "http://internal/",
};

describe("Electron readiness", () => {
  test("always requires the backend gateway", () => {
    for (const run of [
      { flavor: "development" as const, fixture: false },
      { flavor: "agent-test" as const, fixture: false },
    ]) {
      expect(() => assertElectronReadiness({ ...complete, authFile: undefined }, run)).toThrow(
        /backend gateway/,
      );
      expect(() => assertElectronReadiness({ ...complete, backendPid: undefined }, run)).toThrow(
        /backend gateway/,
      );
    }
  });

  test("a desktop dev run does not require a reported browser URL", () => {
    // `bun run dev` starts the backend with `--desktop-web-client`, which
    // deliberately omits `browserUrl`: the loopback listener is up, but its
    // authoritative public URL belongs to ManagedWebClient and can arrive after
    // readiness. Requiring it here failed every desktop dev run.
    expect(() =>
      assertElectronReadiness(
        { ...complete, browserUrl: undefined },
        { flavor: "development", fixture: false },
      ),
    ).not.toThrow();
  });

  test("agent-test requires it, because a browser suite has to reach the app", () => {
    expect(() =>
      assertElectronReadiness(
        { ...complete, browserUrl: undefined },
        { flavor: "agent-test", fixture: false },
      ),
    ).toThrow(/loopback browser gateway/);
  });

  test("a desktop fixture can use the authenticated invoke URL", () => {
    expect(() =>
      assertElectronReadiness(
        { ...complete, browserUrl: undefined },
        { flavor: "development", fixture: true },
      ),
    ).not.toThrow();
  });

  test("seeding a fixture still requires one reachable gateway", () => {
    expect(() =>
      assertElectronReadiness(
        { ...complete, browserUrl: undefined, invokeUrl: undefined },
        { flavor: "development", fixture: true },
      ),
    ).toThrow(/fixture seeding/);
  });

  test("accepts a fully populated readiness message in every mode", () => {
    for (const flavor of ["development", "agent-test"] as const) {
      for (const fixture of [false, true]) {
        expect(() => assertElectronReadiness(complete, { flavor, fixture })).not.toThrow();
      }
    }
  });

  test("waits on interactive development startup but times out agent-test runs", () => {
    // A fresh dev profile parks on the first-run platform chooser; killing it
    // after a fixed timeout meant `mise run dev` never reached the app.
    expect(electronReadinessTimeoutMs("development")).toBeNull();
    expect(electronReadinessTimeoutMs("agent-test")).toBe(60_000);
  });

  test.each([
    ["development", "linux", undefined, false, "window", null],
    ["development", "linux", undefined, true, "window", null],
    ["agent-test", "linux", undefined, false, "ozone", null],
    ["agent-test", "linux", undefined, true, "window", null],
    ["agent-test", "linux", true, true, "ozone", null],
    ["agent-test", "linux", false, false, "window", null],
    ["agent-test", "darwin", true, true, "hidden", null],
    ["agent-test", "darwin", undefined, false, "hidden", null],
    ["agent-test", "win32", true, true, "window", "--headless"],
    ["agent-test", "win32", undefined, false, "window", "running without a terminal"],
    ["agent-test", "darwin", undefined, true, "window", null],
    ["agent-test", "win32", undefined, true, "window", null],
    ["agent-test", "darwin", false, false, "window", null],
    ["agent-test", "win32", false, false, "window", null],
    ["development", "darwin", true, false, "window", null],
    ["development", "win32", true, false, "window", null],
  ] as const)(
    "wires Electron spawn settings and keeps readiness during status persistence (%s on %s, requested=%s, interactive=%s)",
    async (flavor, platform, requested, interactive, mode, windowNoticeCause) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "ork-dev-ready-race-"));
      const roots = {
        developmentRoot: path.join(root, "dev"),
        productionDataDir: path.join(root, "production"),
        homeDir: root,
      };
      const args = parseDevArguments(["--profile", "ready-race"]);
      args.headless = requested;
      const profile = resolveRuntimeProfile({
        repositoryRoot: path.resolve(import.meta.dir, "../../../.."),
        requestedId: args.profile,
        flavor,
        roots,
      });
      const child = () =>
        Object.assign(new EventEmitter(), {
          pid: 1_000_000_000,
          exitCode: 0,
          signalCode: null,
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
        }) as unknown as ChildProcess;
      const vite = child();
      const electron = child();
      const frame = JSON.stringify({
        ...complete,
        type: "orkestrator-electron-ready",
        profile: profile.id,
      });
      let postSpawnWritePending = false;
      let reachedReady = false;
      const signals = {
        SIGINT: process.listeners("SIGINT"),
        SIGTERM: process.listeners("SIGTERM"),
      };
      const watchdog = setTimeout(() => electron.emit("exit", 1, null), 2000);
      const launchEnv = {
        DISPLAY: ":test-display",
        WAYLAND_DISPLAY: "test-wayland",
        ELECTRON_RUN_AS_NODE: "1",
        // Inherited from a shell, it must not hide a profile that keeps its window.
        ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS: "1",
      };
      const ambientHeadlessVariables = [
        "ORKESTRATOR_AGENT_TEST_HEADLESS",
        "ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON",
      ];
      const previousEnv = Object.fromEntries(
        [...Object.keys(launchEnv), ...ambientHeadlessVariables].map((key) => [
          key,
          process.env[key],
        ]),
      );
      for (const key of ambientHeadlessVariables) delete process.env[key];
      const cache = spyOn(profileIo, "seedInstalledModelCatalogCaches").mockResolvedValue([]);
      const toolchains = spyOn(profileIo, "seedInstalledAgentToolchains").mockResolvedValue({
        seeded: [],
        failed: [],
      });
      const credentials = spyOn(profileIo, "seedAgentTestProviderCredentials").mockResolvedValue(
        [],
      );
      // The bridge build reads the checkout's real `dist`, which a clean CI
      // checkout does not have yet; this test is about the Electron launch.
      const bridges = spyOn(bridgeBuilds, "prepareProfileBridgeBuilds").mockResolvedValue({
        version: 1,
        repositoryRoot: profile.repositoryRoot,
        recordedAt: new Date(0).toISOString(),
        bridges: {} as bridgeBuilds.BridgeBuildRecord["bridges"],
      });
      Object.assign(process.env, launchEnv);
      const notice = spyOn(console, "log").mockImplementation(() => {});
      let electronCommandName: string | undefined;
      let electronArgs: readonly string[] | undefined;
      let electronOptions: SpawnOptions | undefined;
      try {
        await startDevelopment(args, flavor, {
          platform,
          interactive,
          roots,
          prune: async () => [],
          typecheck: () => ({ status: 0 }),
          bundle: async () =>
            ({ success: true, outputs: [], logs: [] }) as unknown as Bun.BuildOutput,
          spawn: ((command: string, args: readonly string[], options: SpawnOptions) => {
            if (command === "bun") return vite;
            electronCommandName = command;
            electronArgs = args;
            electronOptions = options;
            return electron;
          }) as typeof import("node:child_process").spawn,
          waitForUrl: async () => {},
          writeStatus: async (file, value) => {
            const status = value as { status: string; pids: { electron?: number } };
            if (status.status === "starting" && status.pids.electron) {
              postSpawnWritePending = true;
              // Deliver the entire frame while the asynchronous write is pending.
              await new Promise<void>((resolve) =>
                setImmediate(() => {
                  electron.stdout!.emit("data", Buffer.from(`${frame}\n`));
                  resolve();
                }),
              );
            }
            if (status.status === "ready") {
              reachedReady = true;
              clearTimeout(watchdog);
            }
            await atomicWriteJson(file, value);
            if (status.status === "ready") setImmediate(() => electron.emit("exit", 0, null));
          },
        });
        const offDesktopNotices = notice.mock.calls
          .map((call) => String(call[0]))
          .filter(
            (line) =>
              line.startsWith("Electron is headless") ||
              line.startsWith("Electron's windows are hidden"),
          );
        expect(offDesktopNotices.length).toBe(mode === "window" ? 0 : 1);
        if (mode !== "window") {
          expect(offDesktopNotices[0]!.startsWith("Electron is headless")).toBe(mode === "ozone");
          expect(offDesktopNotices[0]!.includes("Pass --no-headless")).toBe(requested !== true);
        }
        const windowNotices = notice.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.startsWith("Electron opens a window"));
        expect(windowNotices).toEqual(
          windowNoticeCause === null
            ? []
            : [
                `Electron opens a window: headless mode exists only on Linux and macOS, so ${windowNoticeCause} changes nothing on ${platform}.`,
              ],
        );
        const electronMainArgs = [
          ...(mode === "ozone" ? HEADLESS_ELECTRON_SWITCHES : []),
          "apps/desktop/dist/electron/main.js",
        ];
        // An agent-test profile on Linux starts Electron with no core dumps (7554).
        const noCoreDumps = flavor === "agent-test" && platform === "linux";
        expect(electronCommandName).toEqual(
          noCoreDumps ? "/bin/sh" : expect.stringMatching(/node_modules\/\.bin\/electron$/),
        );
        expect(electronArgs).toEqual(
          noCoreDumps
            ? [
                "-c",
                expect.stringContaining("ulimit -c 0"),
                expect.any(String),
                ...electronMainArgs,
              ]
            : electronMainArgs,
        );
        expect(electronOptions?.env).not.toBe(process.env);
        expect(electronOptions?.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(electronOptions?.env?.DISPLAY).toBe(
          mode === "ozone" ? undefined : launchEnv.DISPLAY,
        );
        expect(electronOptions?.env?.WAYLAND_DISPLAY).toBe(
          mode === "ozone" ? undefined : launchEnv.WAYLAND_DISPLAY,
        );
        expect(electronOptions?.env?.ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS).toBe(
          mode === "hidden" ? "1" : undefined,
        );
        expect(electronOptions?.env?.ELECTRON_DEV).toBe("1");
        for (const [key, value] of Object.entries(launchEnv)) expect(process.env[key]).toBe(value);
        expect(bridges).toHaveBeenCalledTimes(flavor === "agent-test" ? 1 : 0);
        expect(postSpawnWritePending).toBe(true);
        expect(reachedReady).toBe(true);
        expect(await readFile(path.join(profile.logDir, "electron.log"), "utf8")).toContain(frame);
      } finally {
        notice.mockRestore();
        cache.mockRestore();
        toolchains.mockRestore();
        credentials.mockRestore();
        bridges.mockRestore();
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        clearTimeout(watchdog);
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
          for (const listener of process.listeners(signal)) {
            if (!signals[signal].includes(listener)) process.removeListener(signal, listener);
          }
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("Electron headless mode", () => {
  test("interactive requires both stdin and stdout to be terminals", () => {
    for (const stdin of [true, false, undefined]) {
      for (const stdout of [true, false, undefined]) {
        expect(launcherIsInteractive({ isTTY: stdin }, { isTTY: stdout })).toBe(
          stdin === true && stdout === true,
        );
      }
    }
  });
  const decide = (
    overrides: Partial<Parameters<typeof resolveElectronHeadless>[0]> = {},
  ): ReturnType<typeof resolveElectronHeadless> =>
    resolveElectronHeadless({
      flavor: "agent-test",
      platform: "linux",
      env: {},
      interactive: true,
      ...overrides,
    });

  test("an interactive terminal keeps its window", () => {
    expect(decide()).toEqual({ headless: false, reason: "interactive terminal" });
  });

  test("a run with no terminal is headless", () => {
    expect(decide({ interactive: false })).toEqual({ headless: true, reason: "no terminal" });
  });

  test("the variable turns it on from a terminal and off without one", () => {
    expect(decide({ env: { ORKESTRATOR_AGENT_TEST_HEADLESS: "1" } }).headless).toBe(true);
    expect(
      decide({ env: { ORKESTRATOR_AGENT_TEST_HEADLESS: "0" }, interactive: false }).headless,
    ).toBe(false);
  });

  test("a value other than 0 or 1 falls through to the terminal check", () => {
    expect(decide({ env: { ORKESTRATOR_AGENT_TEST_HEADLESS: "true" } }).headless).toBe(false);
    expect(
      decide({ env: { ORKESTRATOR_AGENT_TEST_HEADLESS: "true" }, interactive: false }).headless,
    ).toBe(true);
  });

  test("the earlier variable still opts in, but not past the new one", () => {
    const earlier = { ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON: "1" };
    expect(decide({ env: earlier }).headless).toBe(true);
    expect(decide({ env: { ...earlier, ORKESTRATOR_AGENT_TEST_HEADLESS: "0" } }).headless).toBe(
      false,
    );
  });

  test("an explicit flag wins over the variables and the terminal check", () => {
    expect(
      decide({ requested: true, env: { ORKESTRATOR_AGENT_TEST_HEADLESS: "0" } }).headless,
    ).toBe(true);
    expect(
      decide({
        requested: false,
        interactive: false,
        env: {
          ORKESTRATOR_AGENT_TEST_HEADLESS: "1",
          ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON: "1",
        },
      }).headless,
    ).toBe(false);
  });

  test("never applies to mise run dev, or on Windows", () => {
    const pushed = {
      requested: true,
      interactive: false,
      env: { ORKESTRATOR_AGENT_TEST_HEADLESS: "1" },
    };
    expect(decide({ ...pushed, flavor: "development" }).headless).toBe(false);
    expect(decide({ ...pushed, flavor: "development", platform: "darwin" }).headless).toBe(false);
    expect(decide({ ...pushed, platform: "win32" }).headless).toBe(false);
  });

  test("macOS decides exactly as Linux does", () => {
    for (const overrides of [
      {},
      { interactive: false },
      { requested: true },
      { requested: false, interactive: false },
      { env: { ORKESTRATOR_AGENT_TEST_HEADLESS: "1" } },
      { env: { ORKESTRATOR_AGENT_TEST_HEADLESS: "0" }, interactive: false },
      { env: { ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON: "1" } },
    ]) {
      expect(decide({ ...overrides, platform: "darwin" })).toEqual(decide(overrides));
    }
  });

  const notice = (overrides: Partial<Parameters<typeof resolveElectronHeadless>[0]> = {}) =>
    electronHeadlessNotice({
      flavor: "agent-test",
      platform: "linux",
      env: {},
      interactive: true,
      ...overrides,
    });

  test("the launcher says when Linux goes headless, and how to get a window", () => {
    expect(notice({ interactive: false })).toBe(
      "Electron is headless (no terminal); the app is at browserUrl and no window will open. Pass --no-headless for a real window.",
    );
    expect(notice({ requested: true })).toBe(
      "Electron is headless (--headless); the app is at browserUrl and no window will open.",
    );
    expect(notice()).toBeNull();
  });

  test("the launcher says when macOS hides its windows, and how to get one", () => {
    const platform = "darwin";
    expect(notice({ platform, interactive: false })).toBe(
      "Electron's windows are hidden (no terminal); the app is at browserUrl, with no window or Dock icon. Pass --no-headless for a real window.",
    );
    expect(notice({ platform, requested: true })).toBe(
      "Electron's windows are hidden (--headless); the app is at browserUrl, with no window or Dock icon.",
    );
    expect(notice({ platform })).toBeNull();
    expect(notice({ platform, requested: false, interactive: false })).toBeNull();
    expect(notice({ platform, requested: true, flavor: "development" })).toBeNull();
  });

  test("Windows says that a headless request changes nothing", () => {
    const platform = "win32";
    expect(notice({ platform, requested: true })).toBe(
      "Electron opens a window: headless mode exists only on Linux and macOS, so --headless changes nothing on win32.",
    );
    expect(notice({ platform, interactive: false })).toBe(
      "Electron opens a window: headless mode exists only on Linux and macOS, so running without a terminal changes nothing on win32.",
    );
    expect(notice({ platform, env: { ORKESTRATOR_AGENT_TEST_HEADLESS: "1" } })).toContain(
      "ORKESTRATOR_AGENT_TEST_HEADLESS=1 changes nothing",
    );
    expect(notice({ platform })).toBeNull();
    expect(notice({ platform, requested: false, interactive: false })).toBeNull();
    expect(notice({ platform, requested: true, flavor: "development" })).toBeNull();
  });
});

describe("Electron launch", () => {
  const env = {
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-1",
    ELECTRON_OZONE_PLATFORM_HINT: "wayland",
    ELECTRON_RUN_AS_NODE: "1",
    PATH: "/usr/bin",
  };

  test("a normal launch keeps the display and never runs Electron as Node", () => {
    const launch = electronLaunch(false, "linux", env);
    expect(launch.switches).toEqual([]);
    expect(launch.env).toEqual({
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-1",
      ELECTRON_OZONE_PLATFORM_HINT: "wayland",
      PATH: "/usr/bin",
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  test("headless selects the headless Ozone platform with no display to open a window on", () => {
    const launch = electronLaunch(true, "linux", env);
    expect(launch.switches).toEqual([
      "--ozone-platform=headless",
      "--disable-gpu",
      "--password-store=basic",
    ]);
    expect(launch.env).toEqual({ PATH: "/usr/bin" });
    expect(env.DISPLAY).toBe(":0");
  });

  test("headless on macOS asks for hidden windows and keeps the environment otherwise", () => {
    const launch = electronLaunch(true, "darwin", env);
    expect(launch.switches).toEqual([]);
    expect(launch.env).toEqual({
      ...electronLaunch(false, "darwin", env).env,
      ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS: "1",
    });
  });

  test("remote debugging is opt-in, loopback-only and never for a development profile", () => {
    expect(electronDebugSwitches("agent-test", {})).toEqual([]);
    expect(
      electronDebugSwitches("agent-test", { ORKESTRATOR_AGENT_TEST_ELECTRON_DEBUG: "true" }),
    ).toEqual([]);
    expect(
      electronDebugSwitches("agent-test", { ORKESTRATOR_AGENT_TEST_ELECTRON_DEBUG: "1" }),
    ).toEqual(["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"]);
    expect(
      electronDebugSwitches("development", { ORKESTRATOR_AGENT_TEST_ELECTRON_DEBUG: "1" }),
    ).toEqual([]);
  });

  test("only the launcher's own decision hides windows", () => {
    const inherited = { ...env, ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS: "1" };
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(
        electronLaunch(false, platform, inherited).env.ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS,
      ).toBeUndefined();
    }
    expect(
      electronLaunch(true, "linux", inherited).env.ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS,
    ).toBeUndefined();
    expect(
      electronLaunch(true, "win32", inherited).env.ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS,
    ).toBeUndefined();
  });

  test("headless changes nothing on Windows", () => {
    expect(electronLaunch(true, "win32", env)).toEqual(electronLaunch(false, "win32", env));
    expect(electronLaunch(true, "win32", env).env.DISPLAY).toBe(":0");
  });
});

describe("Electron core dumps", () => {
  const executable = "/repo/apps/desktop/node_modules/.bin/electron";
  const args = ["--ozone-platform=headless", "apps/desktop/dist/electron/main.js"];

  test("an agent-test profile on Linux starts Electron with a core limit of 0", () => {
    const command = electronCommand(executable, args, {
      flavor: "agent-test",
      platform: "linux",
      env: {},
    });
    expect(command.command).toBe("/bin/sh");
    expect(command.args).toEqual(["-c", 'ulimit -c 0 && exec "$0" "$@"', executable, ...args]);
  });

  test("the variable keeps core dumps for a diagnosis; only 1 counts", () => {
    expect(
      electronCommand(executable, args, {
        flavor: "agent-test",
        platform: "linux",
        env: { [AGENT_TEST_CORE_DUMPS_ENV]: "1" },
      }),
    ).toEqual({ command: executable, args });
    for (const value of ["0", "true", ""]) {
      expect(
        electronCommand(executable, args, {
          flavor: "agent-test",
          platform: "linux",
          env: { [AGENT_TEST_CORE_DUMPS_ENV]: value },
        }).command,
      ).toBe("/bin/sh");
    }
  });

  test("mise run dev and other platforms start Electron directly", () => {
    expect(
      electronCommand(executable, args, { flavor: "development", platform: "linux", env: {} }),
    ).toEqual({ command: executable, args });
    for (const platform of ["darwin", "win32"] as const) {
      expect(
        electronCommand(executable, args, { flavor: "agent-test", platform, env: {} }),
      ).toEqual({ command: executable, args });
    }
  });

  test.skipIf(process.platform !== "linux")(
    "the wrapper really sets the limit and keeps the PID it was spawned with",
    async () => {
      // `sh -c` as the "Electron" prints its own PID and core limit, so this
      // proves the exec (the launcher tracks the spawned PID) and the limit.
      const command = electronCommand("/bin/sh", ["-c", 'echo "$$ $(ulimit -c)"'], {
        flavor: "agent-test",
        platform: "linux",
        env: {},
      });
      const child = spawn(command.command, command.args, { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
      expect(code).toBe(0);
      expect(output.trim()).toBe(`${child.pid} 0`);
    },
  );
});

describe("stopping the launcher's children", () => {
  type FakeChild = ChildProcess & { exitNow: (signal: NodeJS.Signals | null) => void };
  let nextPid = 0;
  const fakeChild = (): FakeChild => {
    const child = Object.assign(new EventEmitter(), {
      pid: fakePid(++nextPid),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    });
    return Object.assign(child, {
      exitNow(signal: NodeJS.Signals | null) {
        if (signal) child.signalCode = signal;
        else child.exitCode = 0;
        child.emit("exit", child.exitCode, child.signalCode);
      },
    }) as unknown as FakeChild;
  };
  const recorder = () => {
    const sent: Array<{ child: string; signal: NodeJS.Signals; processGroup: boolean }> = [];
    return { sent, names: new Map<ChildProcess, string>() };
  };

  test("SIGTERM goes to Electron's top process alone; only SIGKILL takes its group", () => {
    // A group SIGTERM kills Chromium's GPU process and zygote under a running
    // browser, which then dies on "GPU process isn't usable" with a core dump.
    expect(signalsProcessGroup("electron", "SIGTERM")).toBe(false);
    expect(signalsProcessGroup("electron", "SIGINT")).toBe(false);
    expect(signalsProcessGroup("electron", "SIGKILL")).toBe(true);
    expect(signalsProcessGroup("vite", "SIGTERM")).toBe(true);
    expect(signalsProcessGroup("vite", "SIGKILL")).toBe(true);
    expect(signalsProcessGroup("launcher", "SIGTERM")).toBe(false);
    expect(signalsProcessGroup("backend", "SIGKILL")).toBe(false);
  });

  test("an Electron that quits within the grace period is never killed", async () => {
    const { sent, names } = recorder();
    const electron = fakeChild();
    const vite = fakeChild();
    names.set(electron, "electron").set(vite, "vite");
    const send: OwnedChildSignal = (child, signal, processGroup) => {
      sent.push({ child: names.get(child)!, signal, processGroup });
      // Electron quits on its own a moment later; Vite dies of the signal.
      if (child === electron) setTimeout(() => electron.exitNow(null), 5);
      else vite.exitNow(signal);
    };
    const started = Date.now();
    await stopLauncherChildren({ electron, vite }, { send, graceMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(sent).toEqual([
      { child: "electron", signal: "SIGTERM", processGroup: false },
      { child: "vite", signal: "SIGTERM", processGroup: true },
    ]);
  });

  test("an Electron still running after the grace period has its group killed", async () => {
    const { sent, names } = recorder();
    const electron = fakeChild();
    const vite = fakeChild();
    names.set(electron, "electron").set(vite, "vite");
    const send: OwnedChildSignal = (child, signal, processGroup) => {
      sent.push({ child: names.get(child)!, signal, processGroup });
      if (child === vite || signal === "SIGKILL") child.emit("exit", null, signal);
    };
    await stopLauncherChildren({ electron, vite }, { send, graceMs: 20 });
    expect(sent).toEqual([
      { child: "electron", signal: "SIGTERM", processGroup: false },
      { child: "vite", signal: "SIGTERM", processGroup: true },
      { child: "electron", signal: "SIGKILL", processGroup: true },
      { child: "vite", signal: "SIGKILL", processGroup: true },
    ]);
  });

  test("children that already exited, or never started, get no signal", async () => {
    const { sent } = recorder();
    const electron = fakeChild();
    electron.exitNow("SIGTRAP");
    await stopLauncherChildren(
      { electron, vite: null },
      { send: (_child, signal, processGroup) => sent.push({ child: "?", signal, processGroup }) },
    );
    expect(sent).toEqual([]);
  });

  test("the grace period fits inside dev:stop's 5 s wait for the launcher", () => {
    expect(ELECTRON_STOP_GRACE_MS).toBeLessThan(5_000);
  });
});

describe("startup failure output", () => {
  // The isolated runner resets the profile, deleting electron.log and vite.log,
  // so an Electron that exits before readiness must quote its own output.
  test("quotes the latest output of both streams, bounded", () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    }) as unknown as ChildProcess;
    const tail = outputTail(child, 16);
    child.stdout!.emit("data", Buffer.from("early output\n"));
    child.stderr!.emit("data", Buffer.from("renderer failed\n"));
    // Only the newest characters are kept, whichever stream they came from.
    expect(tail()).toBe("renderer failed");
  });

  test("names each tail that has output and omits empty ones", () => {
    expect(
      withOutputTails("Electron exited before readiness (code 0, signal none)", {
        Electron: () => "No usable Codex toolchain",
        Vite: () => "",
      }),
    ).toBe(
      "Electron exited before readiness (code 0, signal none)\nElectron output tail:\nNo usable Codex toolchain",
    );
  });
});

describe("development Electron compilation", () => {
  test("type-checks before bundling and records successful output", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-dev-build-"));
    const called: string[] = [];
    try {
      await compileElectronForDevelopment(logDir, {
        typecheck: () => {
          called.push("typecheck");
          return { status: 0, stdout: "typecheck output\n" };
        },
        bundle: async () => {
          called.push("bundle");
          return {
            success: true,
            outputs: [{ path: path.join(import.meta.dir, "../../dist/electron/main.js") }],
            logs: [],
          } as unknown as Bun.BuildOutput;
        },
      });
      expect(called).toEqual(["typecheck", "bundle"]);
      expect(await readFile(path.join(logDir, "build.log"), "utf8")).toContain("typecheck output");
      expect(await readFile(path.join(logDir, "build.log"), "utf8")).toContain("main.js");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  test("a type error stops before bundling and is written to build.log", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-dev-type-error-"));
    let bundled = false;
    try {
      await expect(
        compileElectronForDevelopment(logDir, {
          typecheck: () => ({ status: 2, stderr: "electron/main.ts(1,1): error TS2322\n" }),
          bundle: async () => {
            bundled = true;
            throw new Error("bundle should not run");
          },
        }),
      ).rejects.toThrow(/Electron compilation failed/);
      expect(bundled).toBe(false);
      expect(await readFile(path.join(logDir, "build.log"), "utf8")).toContain("error TS2322");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  test("a bundle failure writes build.log and marks the profile failed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-dev-bundle-error-"));
    const roots = {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    };
    const args = parseDevArguments(["--profile", "failed-bundle"]);
    const profile = resolveRuntimeProfile({
      repositoryRoot: path.resolve(import.meta.dir, "../../../.."),
      requestedId: args.profile,
      roots,
    });
    try {
      await expect(
        startDevelopment(args, "development", {
          roots,
          typecheck: () => ({ status: 0 }),
          bundle: async () =>
            ({
              success: false,
              outputs: [],
              logs: [{ level: "error", message: "broken entrypoint", position: null }],
            }) as unknown as Bun.BuildOutput,
        }),
      ).rejects.toThrow(/Electron compilation failed/);
      expect(await readFile(path.join(profile.logDir, "build.log"), "utf8")).toContain(
        "error: broken entrypoint",
      );
      const status = JSON.parse(await readFile(statusManifestPath(profile), "utf8")) as {
        status: string;
        error: string;
      };
      expect(status.status).toBe("failed");
      expect(status.error).toContain("build.log");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("start excludes its own profile and continues when pruning fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-dev-prune-error-"));
    const roots = {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    };
    const args = parseDevArguments(["--profile", "starting"]);
    const exclusions: string[][] = [];
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        startDevelopment(args, "development", {
          roots,
          prune: async (options) => {
            exclusions.push([...(options?.exclude ?? [])]);
            throw new Error("prune unavailable");
          },
          typecheck: () => ({ status: 2, stderr: "intentional compile stop" }),
        }),
      ).rejects.toThrow(/Electron compilation failed/);
      expect(exclusions).toEqual([["starting"]]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("prune unavailable"));
    } finally {
      warning.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("a new agent-test profile uses the configured dev worktree folder only when asked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-dev-location-"));
  const roots = {
    developmentRoot: path.join(root, "dev"),
    productionDataDir: path.join(root, "production"),
    homeDir: root,
  };
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  try {
    const configured = path.join(root, "trees");
    await mkdir(roots.productionDataDir, { recursive: true });
    await writeFile(
      path.join(roots.productionDataDir, "config.json"),
      JSON.stringify({ global: { worktreeLocations: { dev: configured } } }),
    );
    const profile = resolveRuntimeProfile({
      repositoryRoot,
      requestedId: "qa",
      flavor: "agent-test",
      roots,
    });
    expect(await profileWorktreeLocation(profile, roots, false)).toEqual({});
    expect(await profileWorktreeLocation(profile, roots, true)).toEqual({
      worktreeRoot: configured,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dev settings come from production and apply only to new profiles; restarts retain every stored directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-dev-location-"));
  const roots = {
    developmentRoot: path.join(root, "dev"),
    productionDataDir: path.join(root, "production"),
    homeDir: root,
  };
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  try {
    const original = path.join(root, "trees-original");
    const changed = path.join(root, "trees-changed");
    await mkdir(roots.productionDataDir, { recursive: true });
    await writeFile(
      path.join(roots.productionDataDir, "config.json"),
      JSON.stringify({ global: { worktreeLocations: { dev: original } } }),
    );
    expect(await configuredDevWorktreeRoot(roots)).toBe(original);
    for (const kind of ["default", "internal", "external", "new"] as const) {
      const args = parseDevArguments(["--profile", kind]);
      const basic = resolveRuntimeProfile({ repositoryRoot, requestedId: kind, roots });
      const profile = resolveRuntimeProfile({
        repositoryRoot,
        requestedId: kind,
        roots,
        ...(kind === "internal"
          ? { worktreeDir: path.join(basic.profileRoot, "nested", "custom") }
          : {}),
        ...(kind === "external" ? { worktreeRoot: original } : {}),
      });
      if (kind !== "new") {
        await initializeProfile(profile);
        await writeFile(
          path.join(profile.dataDir, "config.json"),
          JSON.stringify({
            global: { worktreeLocations: { dev: path.join(root, "ignored-profile-setting") } },
          }),
        );
      }
      await writeFile(
        path.join(roots.productionDataDir, "config.json"),
        JSON.stringify({ global: { worktreeLocations: { dev: changed } } }),
      );
      await expect(
        startDevelopment(args, "development", {
          roots,
          prune: async () => [],
          typecheck: () => ({ status: 2, stderr: "intentional compile stop" }),
        }),
      ).rejects.toThrow("Electron compilation failed");
      const stored = JSON.parse(
        await readFile(path.join(profile.profileRoot, "profile.json"), "utf8"),
      );
      expect(stored.worktreeDir).toBe(
        kind === "new" ? path.join(changed, kind) : profile.worktreeDir,
      );
    }
    await rm(path.join(roots.productionDataDir, "config.json"));
    expect(await configuredDevWorktreeRoot(roots)).toBeUndefined();
    await writeFile(path.join(roots.productionDataDir, "config.json"), "invalid");
    expect(await configuredDevWorktreeRoot(roots)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
