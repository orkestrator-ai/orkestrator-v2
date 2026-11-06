import { describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  electronHeadlessNotice,
  electronLaunch,
  launcherIsInteractive,
  electronReadinessTimeoutMs,
  outputTail,
  resolveElectronHeadless,
  startDevelopment,
  withOutputTails,
  configuredDevWorktreeRoot,
  profileWorktreeLocation,
} from "./lifecycle.js";

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
    ["development", "linux", undefined, false, false],
    ["development", "linux", undefined, true, false],
    ["agent-test", "linux", undefined, false, true],
    ["agent-test", "linux", undefined, true, false],
    ["agent-test", "linux", true, true, true],
    ["agent-test", "linux", false, false, false],
    ["agent-test", "darwin", true, false, false],
    ["agent-test", "win32", undefined, false, false],
  ] as const)(
    "wires Electron spawn settings and keeps readiness during status persistence (%s on %s, requested=%s, interactive=%s)",
    async (flavor, platform, requested, interactive, headless) => {
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
        const headlessNotices = notice.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.startsWith("Electron is headless"));
        expect(headlessNotices.length).toBe(headless ? 1 : 0);
        if (headless)
          expect(headlessNotices[0]!.includes("Pass --no-headless")).toBe(requested !== true);
        expect(electronArgs).toEqual([
          ...(headless ? HEADLESS_ELECTRON_SWITCHES : []),
          "apps/desktop/dist/electron/main.js",
        ]);
        expect(electronOptions?.env).not.toBe(process.env);
        expect(electronOptions?.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(electronOptions?.env?.DISPLAY).toBe(headless ? undefined : launchEnv.DISPLAY);
        expect(electronOptions?.env?.WAYLAND_DISPLAY).toBe(
          headless ? undefined : launchEnv.WAYLAND_DISPLAY,
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

  test("never applies to mise run dev, or where Ozone does not exist", () => {
    const pushed = {
      requested: true,
      interactive: false,
      env: { ORKESTRATOR_AGENT_TEST_HEADLESS: "1" },
    };
    expect(decide({ ...pushed, flavor: "development" }).headless).toBe(false);
    for (const platform of ["darwin", "win32"] as const) {
      expect(decide({ ...pushed, platform }).headless).toBe(false);
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

  test("macOS and Windows say that a headless request changes nothing", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(notice({ platform, requested: true })).toBe(
        `Electron opens a window: headless mode exists only on Linux, so --headless changes nothing on ${platform}.`,
      );
      expect(notice({ platform, interactive: false })).toBe(
        `Electron opens a window: headless mode exists only on Linux, so running without a terminal changes nothing on ${platform}.`,
      );
      expect(notice({ platform, env: { ORKESTRATOR_AGENT_TEST_HEADLESS: "1" } })).toContain(
        "ORKESTRATOR_AGENT_TEST_HEADLESS=1 changes nothing",
      );
      expect(notice({ platform })).toBeNull();
      expect(notice({ platform, requested: false, interactive: false })).toBeNull();
      expect(notice({ platform, requested: true, flavor: "development" })).toBeNull();
    }
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

  test("headless changes nothing where Ozone does not exist", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(electronLaunch(true, platform, env)).toEqual(electronLaunch(false, platform, env));
      expect(electronLaunch(true, platform, env).env.DISPLAY).toBe(":0");
    }
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
