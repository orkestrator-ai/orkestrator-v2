import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
  parseBridgeInputHashes,
  prepareProfileBridgeBuilds,
  readBridgeBuildRecord,
  snapshotBridgeBuilds,
  writeBridgeBuildRecord,
  type BridgeBuildRecord,
  type LocalBridge,
  type TurboRunner,
} from "./bridge-builds.js";
import { startDevelopment } from "./lifecycle.js";
import * as profileIo from "./profile-io.js";

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

const allInputs = Object.fromEntries(LOCAL_BRIDGES.map((bridge) => [bridge, `${bridge}-1`]));

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
    expect(parseBridgeInputHashes(`• turbo 2.11.7\n${plan({ "pi-bridge": "abc" })}`)).toEqual({
      "acp-bridge": null,
      "claude-bridge": null,
      "codex-bridge": null,
      "cursor-bridge": null,
      "pi-bridge": "abc",
    });
    expect(() => parseBridgeInputHashes("no plan")).toThrow("printed no plan");
    expect(() => parseBridgeInputHashes("{}")).toThrow("has no tasks");
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
    expect(calls[0]).toEqual([
      "run",
      "build",
      ...LOCAL_BRIDGES.map((bridge) => `--filter=${bridge}`),
      "--output-logs=errors-only",
    ]);
    expect(calls[1]).toContain("--dry=json");
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
