import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runtimeProfileStatusPath } from "@orkestrator/protocol/node/runtime-profile-status";

import { resolveRuntimeProfile, statusManifestPath } from "../../electron/runtime-profile.js";
import { parseAgentTestArguments } from "./arguments.js";
import {
  ALLOW_STALE_BRIDGES_ENV,
  BRIDGE_BUILDS_FILE,
  LOCAL_BRIDGES,
  checkProfileBridgeBuilds,
  compareBridgeBuilds,
  bridgeInputHashes,
  parseBridgeInputHashes,
  prepareProfileBridgeBuilds,
  readBridgeBuildRecord,
  runTurbo,
  snapshotBridgeBuilds,
  writeBridgeBuildRecord,
  type BridgeBuildRecord,
  type LocalBridge,
  type TurboRunner,
} from "./bridge-builds.js";
import { startDevelopment } from "./lifecycle.js";
import * as profileIo from "./profile-io.js";
import * as bridgeBuilds from "./bridge-builds.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function plan(hashes: Partial<Record<LocalBridge, string>>): string {
  return JSON.stringify({
    tasks: [
      { taskId: "@orkestrator/protocol#build", hash: "protocol" },
      ...Object.entries(hashes).map(([bridge, hash]) => ({ taskId: `${bridge}#build`, hash })),
    ],
  });
}

const allInputs = Object.fromEntries(
  LOCAL_BRIDGES.map((bridge) => [bridge, `${bridge}-1`]),
) as Record<LocalBridge, string>;

/** A Turbo stand-in: `build` writes each bundle from `bundles`, `--dry` prints `inputs`. */
function fakeTurbo(
  root: string,
  state: {
    inputs: Partial<Record<LocalBridge, string>>;
    bundles: Partial<Record<LocalBridge, string>>;
  },
  calls: string[][] = [],
  buildStatus = 0,
): TurboRunner {
  return (args, cwd) => {
    calls.push(args);
    expect(cwd).toBe(root);
    if (args.includes("--dry=json")) {
      return { status: 0, stdout: `turbo 2.11.7\n${plan(state.inputs)}` };
    }
    if (buildStatus !== 0) return { status: buildStatus, stderr: "pi-bridge#build: error TS1005" };
    for (const [bridge, content] of Object.entries(state.bundles)) {
      const dist = path.join(root, "bridges", bridge, "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(path.join(dist, "index.js"), content);
    }
    return { status: 0, stdout: "Tasks: 6 successful, 6 total\n" };
  };
}

function record(
  bridges: Partial<Record<LocalBridge, { inputs: string | null; bundle: string | null }>>,
) {
  return {
    version: 1,
    repositoryRoot: "/repo",
    recordedAt: "2026-10-26T00:00:00.000Z",
    bridges: Object.fromEntries(
      LOCAL_BRIDGES.map((bridge) => [bridge, bridges[bridge] ?? { inputs: "i", bundle: "b" }]),
    ),
  } as BridgeBuildRecord;
}

describe("bridge build freshness", () => {
  test("reads each bridge's build hash from a dry-run plan, after any banner", () => {
    expect(parseBridgeInputHashes(`• turbo 2.11.7\n${plan(allInputs)}`)).toEqual(allInputs);
    expect(() => parseBridgeInputHashes("no plan")).toThrow("printed no plan");
    expect(() => parseBridgeInputHashes("{}")).toThrow("has no tasks");
  });

  test("reads all bridge hashes from the installed Turbo's actual dry-run output", () => {
    const root = path.resolve(import.meta.dir, "../../../..");
    const hashes = bridgeInputHashes(root, runTurbo);
    expect(Object.keys(hashes).sort()).toEqual([...LOCAL_BRIDGES].sort());
    for (const bridge of LOCAL_BRIDGES) expect(hashes[bridge]).toMatch(/^[0-9a-f]+$/);
  });

  test.each([undefined, null, 42, ""])("rejects an absent or invalid task hash (%s)", (hash) => {
    const tasks = LOCAL_BRIDGES.map((bridge) => ({
      taskId: `${bridge}#build`,
      hash: bridge === "pi-bridge" ? hash : "valid",
    }));
    expect(() => parseBridgeInputHashes(JSON.stringify({ tasks }))).toThrow(
      "missing build input hashes for pi-bridge",
    );
  });

  test("legacy records with missing input hashes cannot compare as current", () => {
    const legacy = record({ "pi-bridge": { inputs: null, bundle: "b" } });
    expect(compareBridgeBuilds(legacy, legacy)).toEqual([
      "pi-bridge: its build input hash is missing",
    ]);
  });

  test("names every bridge whose source or bundle moved on", () => {
    const before = record({});
    expect(compareBridgeBuilds(before, record({}))).toEqual([]);
    expect(
      compareBridgeBuilds(
        record({ "codex-bridge": { inputs: "i", bundle: null } }),
        record({
          "pi-bridge": { inputs: "changed", bundle: "b" },
          "claude-bridge": { inputs: "i", bundle: "rebuilt" },
          "acp-bridge": { inputs: "i", bundle: null },
        }),
      ),
    ).toEqual([
      "acp-bridge: dist/index.js is missing",
      "claude-bridge: dist/index.js changed since the profile started",
      "codex-bridge: the profile started without a build",
      "pi-bridge: its sources changed since the profile started",
    ]);
  });

  test("a profile start builds every bridge and records what it launched with", async () => {
    const root = await temporaryDirectory("ork-bridge-builds-");
    const statusPath = path.join(root, "profile", "runtime", "status.json");
    const calls: string[][] = [];
    const bundles = Object.fromEntries(LOCAL_BRIDGES.map((bridge) => [bridge, `// ${bridge}`]));
    const run = fakeTurbo(root, { inputs: allInputs, bundles }, calls);
    const logged: string[] = [];
    const written = await prepareProfileBridgeBuilds({
      repositoryRoot: root,
      statusPath,
      logPath: "bridge-build.log",
      writeLog: async (text) => void logged.push(text),
      run,
    });
    expect(calls[0]).toContain("--dry=json");
    expect(calls[1]).toEqual([
      "run",
      "build",
      ...LOCAL_BRIDGES.map((bridge) => `--filter=${bridge}`),
      "--output-logs=errors-only",
    ]);
    expect(calls[2]).toContain("--dry=json");
    expect(logged.join("")).toContain("6 successful");
    expect(written.bridges["pi-bridge"].inputs).toBe("pi-bridge-1");
    expect(written.bridges["pi-bridge"].bundle).toMatch(/^[0-9a-f]{64}$/);
    expect(await readBridgeBuildRecord(statusPath)).toEqual(written);
    expect(path.basename(path.dirname(statusPath))).toBe("runtime");
    expect(
      await readFile(path.join(path.dirname(statusPath), BRIDGE_BUILDS_FILE), "utf8"),
    ).toContain('"version": 1');
    // The same build again is the same record, so a restart is not flagged.
    expect(compareBridgeBuilds(written, snapshotBridgeBuilds(root, { run }))).toEqual([]);
  });

  test.each(["build", "log write"])("rejects inputs changed during the %s", async (stage) => {
    const root = await temporaryDirectory("ork-bridge-build-race-");
    const statusPath = path.join(root, "runtime", "status.json");
    const state = {
      inputs: { ...allInputs },
      bundles: Object.fromEntries(LOCAL_BRIDGES.map((bridge) => [bridge, "// built for A"])),
    };
    const build = fakeTurbo(root, state);
    const changeInputs = () => {
      state.inputs["pi-bridge"] = "input-B";
    };
    // Retain an earlier record unchanged when preparation of a restart fails.
    const previous = record({});
    await writeBridgeBuildRecord(statusPath, previous);
    await expect(
      prepareProfileBridgeBuilds({
        repositoryRoot: root,
        statusPath,
        logPath: "bridge-build.log",
        run: (args, cwd) => {
          const result = build(args, cwd);
          if (stage === "build" && !args.includes("--dry=json")) changeInputs();
          return result;
        },
        writeLog: async () => {
          if (stage === "log write") changeInputs();
        },
      }),
    ).rejects.toThrow("Bridge inputs changed during the build for pi-bridge");
    expect(await readBridgeBuildRecord(statusPath)).toEqual(previous);
    expect(await readFile(path.join(root, "bridges/pi-bridge/dist/index.js"), "utf8")).toBe(
      "// built for A",
    );
  });

  test.each([
    { label: "missing bridge", stdout: plan({ ...allInputs, "pi-bridge": undefined }) },
    {
      label: "renamed task",
      stdout: plan(allInputs).replace("pi-bridge#build", "pi-bridge#bundle"),
    },
    { label: "no JSON", stdout: "Turbo produced no plan" },
    { label: "invalid JSON", stdout: "{bad json" },
    { label: "no tasks", stdout: "{}" },
    { label: "failed command", status: 1, stdout: "", stderr: "plan failed" },
  ])(
    "fails closed on $label in preparation and the guard, even with the override",
    async (failure) => {
      const root = await temporaryDirectory("ork-bridge-plan-fail-");
      const { statusPath } = runtimeProfileStatusPath(root, "qa");
      const run: TurboRunner = () => ({ status: 0, ...failure });
      await expect(
        prepareProfileBridgeBuilds({
          repositoryRoot: root,
          statusPath,
          run,
          logPath: "log",
          writeLog: async () => {},
        }),
      ).rejects.toThrow("Turbo could not plan the bridge builds");
      expect(await readBridgeBuildRecord(statusPath)).toBeNull();
      await mkdir(path.dirname(statusPath), { recursive: true });
      await writeFile(statusPath, "{}");
      await writeBridgeBuildRecord(statusPath, { ...record({}), repositoryRoot: root });
      for (const env of [{}, { [ALLOW_STALE_BRIDGES_ENV]: "1" }]) {
        await expect(
          checkProfileBridgeBuilds({ profile: "qa", developmentRoot: root, env, run }),
        ).rejects.toThrow("Turbo could not plan the bridge builds");
      }
    },
  );

  test("reports missing hashes with Turbo's diagnostic output", () => {
    expect(() =>
      bridgeInputHashes("/repo", () => ({
        status: 0,
        stdout: plan({ "pi-bridge": "only-pi" }),
        stderr: "diagnostic from Turbo",
      })),
    ).toThrow("diagnostic from Turbo");
  });

  test("a failed or empty bridge build stops the profile and keeps no new record", async () => {
    const root = await temporaryDirectory("ork-bridge-builds-fail-");
    const statusPath = path.join(root, "runtime", "status.json");
    const logged: string[] = [];
    await expect(
      prepareProfileBridgeBuilds({
        repositoryRoot: root,
        statusPath,
        logPath: "/logs/bridge-build.log",
        writeLog: async (text) => void logged.push(text),
        run: fakeTurbo(root, { inputs: allInputs, bundles: {} }, [], 1),
      }),
    ).rejects.toThrow("Bridge build failed; see /logs/bridge-build.log");
    expect(logged.join("")).toContain("error TS1005");
    await expect(
      prepareProfileBridgeBuilds({
        repositoryRoot: root,
        statusPath,
        logPath: "/logs/bridge-build.log",
        writeLog: async () => {},
        run: fakeTurbo(root, { inputs: allInputs, bundles: { "pi-bridge": "// pi" } }),
      }),
    ).rejects.toThrow(
      "Bridge build left no dist/index.js for acp-bridge, claude-bridge, codex-bridge, cursor-bridge",
    );
    expect(await readBridgeBuildRecord(statusPath)).toBeNull();
  });

  test("the live-suite guard fails on a stale profile unless explicitly allowed", async () => {
    const root = await temporaryDirectory("ork-bridge-guard-");
    const developmentRoot = path.join(root, "dev");
    const repository = path.join(root, "repo");
    const state = {
      inputs: { ...allInputs },
      bundles: Object.fromEntries(LOCAL_BRIDGES.map((bridge) => [bridge, `// ${bridge}`])),
    };
    const run = fakeTurbo(repository, state);
    const check = (env: NodeJS.ProcessEnv = {}) =>
      checkProfileBridgeBuilds({ profile: "QA Live", env, developmentRoot, run });

    expect(await check()).toEqual({ state: "no-profile" });
    const { statusPath } = runtimeProfileStatusPath(developmentRoot, "qa-live");
    await mkdir(path.dirname(statusPath), { recursive: true });
    await writeFile(statusPath, "{}");
    expect(await check()).toEqual({ state: "unrecorded" });

    await prepareProfileBridgeBuilds({
      repositoryRoot: repository,
      statusPath,
      logPath: "log",
      writeLog: async () => {},
      run,
    });
    expect(await check()).toEqual({ state: "current" });

    // A bridge edited after the profile started, without a rebuild.
    state.inputs["pi-bridge"] = "pi-bridge-2";
    const failure = await check().catch((error: Error) => error.message);
    expect(failure).toContain(
      `Profile qa-live is running bridge builds that no longer match ${repository}`,
    );
    expect(failure).toContain("pi-bridge: its sources changed since the profile started");
    expect(failure).toContain("mise run dev:stop --profile qa-live");
    expect(failure).toContain(`${ALLOW_STALE_BRIDGES_ENV}=1`);
    expect(await check({ [ALLOW_STALE_BRIDGES_ENV]: "1" })).toEqual({
      state: "allowed",
      problems: ["pi-bridge: its sources changed since the profile started"],
    });

    // Rebuilt by hand under the running profile: its processes may be older.
    state.inputs["pi-bridge"] = "pi-bridge-1";
    await writeFile(
      path.join(repository, "bridges", "claude-bridge", "dist", "index.js"),
      "// other",
    );
    await expect(check()).rejects.toThrow(
      "claude-bridge: dist/index.js changed since the profile started",
    );
  });

  test("a stored record survives a round trip and garbage reads as none", async () => {
    const root = await temporaryDirectory("ork-bridge-record-");
    const statusPath = path.join(root, "runtime", "status.json");
    await writeBridgeBuildRecord(statusPath, record({}));
    expect(await readBridgeBuildRecord(statusPath)).toEqual(record({}));
    await writeFile(path.join(root, "runtime", BRIDGE_BUILDS_FILE), "not json");
    expect(await readBridgeBuildRecord(statusPath)).toBeNull();
    await writeFile(path.join(root, "runtime", BRIDGE_BUILDS_FILE), '{"version":2}');
    expect(await readBridgeBuildRecord(statusPath)).toBeNull();
  });
});

describe("dev:test bridge builds", () => {
  async function profileRoots(prefix: string) {
    const root = await temporaryDirectory(prefix);
    return {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    };
  }

  test("a successful start records bridges before launching the runtime and accepts backend readiness", async () => {
    const roots = await profileRoots("ork-dev-bridge-success-");
    const repository = await temporaryDirectory("ork-dev-bridge-repo-");
    const args = parseAgentTestArguments(["--profile", "bridge-success"]);
    const profile = resolveRuntimeProfile({
      repositoryRoot: path.resolve(import.meta.dir, "../../../.."),
      requestedId: args.profile,
      flavor: "agent-test",
      roots,
    });
    const statusPath = statusManifestPath(profile);
    const order: string[] = [];
    const prepare = prepareProfileBridgeBuilds;
    // Keep real build/record behavior, with bundles confined to a temporary checkout.
    const preparation = spyOn(bridgeBuilds, "prepareProfileBridgeBuilds").mockImplementation(
      async (options) => {
        const result = await prepare({ ...options, repositoryRoot: repository });
        order.push("record");
        return result;
      },
    );
    const cache = spyOn(profileIo, "seedInstalledModelCatalogCaches").mockResolvedValue([]);
    const toolchains = spyOn(profileIo, "seedInstalledAgentToolchains").mockResolvedValue({
      seeded: [],
      failed: [],
    });
    const credentials = spyOn(profileIo, "seedAgentTestProviderCredentials").mockResolvedValue([]);
    const log = spyOn(console, "log").mockImplementation(() => {});
    // Root runs preload Happy DOM; package runs use Bun's native fetch already.
    const nativePlatform = Reflect.get(
      globalThis,
      Symbol.for("orkestrator.tests.native-web-platform"),
    ) as { fetch: typeof fetch } | undefined;
    const fetchRuntime = nativePlatform?.fetch ?? globalThis.fetch;
    const request = spyOn(globalThis, "fetch").mockImplementation(fetchRuntime);
    const signals = new Map(
      (["SIGINT", "SIGTERM"] as const).map((signal) => [signal, process.listeners(signal)]),
    );
    const children: childProcess.ChildProcess[] = [];
    const spawn = childProcess.spawn;
    // Exercise real child readiness, status writes and shutdown without starting
    // the desktop app or reading provider credentials. The Electron stand-in
    // reports its backend then exits only after the launcher persisted "ready".
    const launchStandIn = (
      command: string,
      _args?: readonly string[],
      options?: childProcess.SpawnOptions,
    ) => {
      expect(order).toContain("record");
      const vite = command === "bun";
      order.push(vite ? "vite" : "electron/backend");
      const script = vite
        ? `Bun.serve({hostname: process.env.VITE_DEV_HOST, port: Number(process.env.VITE_DEV_PORT), fetch: () => new Response("ready")});`
        : `
          console.log(JSON.stringify({
            type: "orkestrator-electron-ready", profile: "bridge-success",
            electronPid: process.pid, backendPid: process.pid,
            authFile: "/fixture/gateway-auth.json", browserUrl: "http://fixture/"
          }));
          setInterval(async () => {
            const status = await Bun.file(${JSON.stringify(statusPath)}).json();
            if (status.status === "ready") process.exit(0);
          }, 10);
        `;
      const child = spawn(process.execPath, ["-e", script], options ?? {});
      children.push(child);
      return child;
    };
    const launch = spyOn(childProcess, "spawn").mockImplementation(
      launchStandIn as typeof childProcess.spawn,
    );
    try {
      await startDevelopment(args, "agent-test", {
        roots,
        prune: async () => [],
        typecheck: () => {
          order.push("typecheck");
          return { status: 0 };
        },
        bundle: async () => {
          order.push("bundle");
          return { success: true, outputs: [], logs: [] } as unknown as Bun.BuildOutput;
        },
        turbo: fakeTurbo(repository, {
          inputs: allInputs,
          bundles: Object.fromEntries(LOCAL_BRIDGES.map((bridge) => [bridge, `// ${bridge}`])),
        }),
      });
      expect(order).toEqual(["typecheck", "bundle", "record", "vite", "electron/backend"]);
      const status = await profileIo.readStatus(statusPath);
      expect(status?.status).toBe("stopped");
      expect(status?.browserUrl).toBe("http://fixture/");
      expect(status?.pids.backend).toBe(children[1]?.pid);
      const built = await readBridgeBuildRecord(statusPath);
      expect(built).not.toBeNull();
      expect(
        compareBridgeBuilds(
          built!,
          snapshotBridgeBuilds(repository, {
            run: fakeTurbo(repository, { inputs: allInputs, bundles: {} }),
          }),
        ),
      ).toEqual([]);
      expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
        true,
      );
    } finally {
      launch.mockRestore();
      preparation.mockRestore();
      cache.mockRestore();
      toolchains.mockRestore();
      credentials.mockRestore();
      log.mockRestore();
      request.mockRestore();
      for (const [signal, before] of signals) {
        for (const listener of process.listeners(signal)) {
          if (!before.includes(listener)) process.removeListener(signal, listener);
        }
      }
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          child.kill("SIGKILL");
          await exited;
        }),
      );
    }
  }, 15_000);

  test("an agent-test start builds the bridges after Electron compiles, and a failure stops it", async () => {
    const roots = await profileRoots("ork-dev-bridge-build-");
    const args = parseAgentTestArguments(["--profile", "bridge-build"]);
    const profile = resolveRuntimeProfile({
      repositoryRoot: path.resolve(import.meta.dir, "../../../.."),
      requestedId: args.profile,
      flavor: "agent-test",
      roots,
    });
    const order: string[] = [];
    const cache = spyOn(profileIo, "seedInstalledModelCatalogCaches").mockResolvedValue([]);
    const toolchains = spyOn(profileIo, "seedInstalledAgentToolchains").mockResolvedValue({
      seeded: [],
      failed: [],
    });
    // Keeps the start off the host's own provider logins.
    const credentials = spyOn(profileIo, "seedAgentTestProviderCredentials").mockResolvedValue([]);
    try {
      await expect(
        startDevelopment(args, "agent-test", {
          roots,
          prune: async () => [],
          typecheck: () => {
            order.push("typecheck");
            return { status: 0 };
          },
          bundle: async () => {
            order.push("bundle");
            return { success: true, outputs: [], logs: [] } as unknown as Bun.BuildOutput;
          },
          turbo: (turboArgs) => {
            if (turboArgs.includes("--dry=json")) return { status: 0, stdout: plan(allInputs) };
            order.push(`turbo ${turboArgs.slice(0, 2).join(" ")}`);
            return { status: 1, stderr: "codex-bridge#build: Could not resolve" };
          },
        }),
      ).rejects.toThrow(/Bridge build failed; see .*bridge-build\.log/);
      expect(order).toEqual(["typecheck", "bundle", "turbo run build"]);
      expect(await readFile(path.join(profile.logDir, "bridge-build.log"), "utf8")).toContain(
        "Could not resolve",
      );
      const status = JSON.parse(await readFile(statusManifestPath(profile), "utf8")) as {
        status: string;
        error: string;
      };
      expect(status.status).toBe("failed");
      expect(status.error).toContain("bridge-build.log");
    } finally {
      cache.mockRestore();
      toolchains.mockRestore();
      credentials.mockRestore();
    }
  });
});
